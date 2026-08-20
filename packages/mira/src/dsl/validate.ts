import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { VergisError } from '@vergis/botler'
import { normalizeDrills } from '../compose'
import { parseIsoDuration } from '../freshness'

/**
 * Identidad de NEGOCIO de las filas de un dataset (D16): a qué entidad gobernada corresponden y qué
 * columnas componen su llave. Habilita el gesto de comentar un registro — un comentario se clava en
 * la entidad + la llave, no en el PI, y por eso lo dicho sobre la empleada 4021 es lo mismo se mire
 * desde el PI que se mire.
 *
 * Es DESCRIPTIVA, jamás autorizadora: no concede ni niega acceso (el spec sigue authz-blind). La
 * autorización de escribir un comentario se verifica contra el DATO, al escribir.
 */
export interface MiraAnchor {
  /** La entidad gobernada, calificada por esquema (`schema.tabla`). */
  entity: string
  /** Columnas del dataset que componen la llave de negocio. */
  key: string[]
  /** Columna legible que nombra el registro en el índice por llave. */
  display?: string
}

export interface MiraDataset {
  capability: string
  params?: Record<string, unknown>
  shape?: { type?: string; fields?: Record<string, string> }
  /** Llave de negocio declarada (D16). Ausente ⇒ el gesto de comentar no se ofrece (fail-closed). */
  anchor?: MiraAnchor
  /** Frescura POR-DATASET (además de la global de quality.freshness): `watermark_field` es un
   *  CAMPO del propio dataset; `max_age` una duración ISO 8601 soportada. Ver freshness.ts. */
  freshness?: { watermark_field?: string; max_age?: string; timezone?: string }
}

/** Una vista (página) de un PI multi-vista. Cada página es una pieza con su propio contexto. */
export interface MiraPage {
  id: string
  title: string
  piece: Record<string, unknown>
  /** Parámetros de contexto que esta vista recibe del drill-through (`:ctx.<param>` en su data). */
  context?: string[]
}

export interface MiraSpec {
  mira_version: string
  identity: {
    id: string
    display_name: string
    classification: string
    code?: string
    [k: string]: unknown
  }
  /** PI de una sola vista. Exactamente uno de `piece` | `pages`. */
  piece?: Record<string, unknown>
  /** PI multi-vista (páginas navegables + drill-through). Exactamente uno de `piece` | `pages`. */
  pages?: MiraPage[]
  interactions?: {
    /** Los filtros disponibles que viven en la bandeja de filtros. */
    filters?: { dataset: string; field: string; label?: string; multi?: boolean }[]
  }
  /**
   * Controles de cabecera (server-side): cada uno fija UN valor que se inyecta como `:ctx.<id>` en
   * las queries de las páginas (a diferencia de `interactions.filters`, que son client-side sobre el
   * dato ya recuperado). Pensados para parámetros que CAMBIAN la consulta — p.ej. la semana a analizar.
   */
  controls?: MiraControl[]
  /**
   * Filtros de BANDEJA (server-side): sustracción OPCIONAL que re-ancla el documento entero. Hermano
   * de `controls`, no parte de `interactions` (ese namespace es client-side y queda intacto).
   * Se integran al SQL por el placeholder de predicado `:flt.<id>`.
   */
  filters?: MiraFilter[]
  data: Record<string, MiraDataset>
  quality: Record<string, unknown>
  delivery: {
    render?: { format: string; target?: string; theme?: string; bom?: boolean }[]
    channels?: { type: string; capability: string; params?: Record<string, unknown>; schedule?: string }[]
    [k: string]: unknown
  }
}

/**
 * Un filtro de bandeja. `source` es `data.<dataset>.<campo>` (el catálogo de opciones); `column` es
 * la columna que el predicado `:flt.<id>` filtra en las queries (default: el campo de `source`);
 * `depends_on` encadena la cascada de opciones.
 */
export interface MiraFilter {
  id: string
  label?: string
  source: string
  column?: string
  multi?: boolean
  depends_on?: string
}

// Caché por-OBJETO de schema (no un único singleton): la compilación AJV es cara, pero un caché de un
// solo slot ignoraría el argumento `schema` a partir de la 2ª llamada — benigno con un schema, bug
// latente si conviven dos (versiones del DSL, hot-reload del schema): el 2º usaría el validador del 1º.
// El WeakMap indexa por identidad del objeto → mismo schema parseado una vez ⇒ mismo validador.
const validatorCache = new WeakMap<object, ValidateFunction>()

function getValidator(schema: object): ValidateFunction {
  const hit = validatorCache.get(schema)
  if (hit) return hit
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  const compiled = ajv.compile(schema)
  validatorCache.set(schema, compiled)
  return compiled
}

/**
 * Validación en orden (doc 3 §9): schema → referencias → capabilities → shape → policy.
 * Cualquier fallo lanza un VergisError estructurado y accionable.
 */
export function validateSpec(spec: unknown, ctx: { capabilities: string[]; schema: object }): MiraSpec {
  // 1 · Schema
  const validate = getValidator(ctx.schema)
  if (!validate(spec)) {
    const e = validate.errors?.[0]
    throw new VergisError({
      error: 'mira/spec-invalid',
      code: 'schema-violation',
      path: e?.instancePath || '/',
      value: (e as { data?: unknown } | undefined)?.data,
      message: `Spec no conforme al schema: ${e?.instancePath ?? ''} ${e?.message ?? ''}`.trim(),
      remediation: 'Corregir la estructura de la spec según mira-spec.schema.json.',
    })
  }
  const s = spec as MiraSpec

  // 1·bis · Exactamente uno de `piece` | `pages` (PI de una vista vs multi-vista).
  const hasPiece = s.piece != null
  const hasPages = Array.isArray(s.pages) && s.pages.length > 0
  if (hasPiece === hasPages) {
    throw new VergisError({
      error: 'mira/spec-invalid',
      code: 'piece-pages-xor',
      path: '/',
      message: hasPiece
        ? 'El spec declara `piece` y `pages` a la vez. Un PI es de una vista (`piece`) o multi-vista (`pages`), no ambos.'
        : 'El spec no declara ni `piece` ni `pages`. Declara uno: `piece` (una vista) o `pages` (multi-vista).',
      remediation: 'Dejar solo `piece` (PI simple) o solo `pages` (PI multi-vista con navegación/drill-through).',
    })
  }

  // Páginas (multi-vista): validar ids únicos y aristas de drill-through.
  if (hasPages) validatePages(s.pages!)

  // Controles de cabecera: id único, source existente, default conocido (single o multi-select).
  validateControls(s)

  // Llaves de negocio (`data.<ds>.anchor`): entidad calificada, llave no vacía y columnas existentes.
  validateAnchors(s)
  // Filtros de bandeja (#82): vocabulario, cascada sin ciclos y correspondencia con los `:flt.` del SQL.
  validateFilters(s)

  // 2 · Referencias colgantes: cada data.<path> usada en alguna pieza existe en data.
  const pieces = hasPages ? s.pages!.map((p) => p.piece) : [s.piece as Record<string, unknown>]
  // Incluye los datasets pelados de `agg.dataset` y `table.data`/`semaforo.data` (que no llevan el
  // prefijo `data.`): sin esto, un typo ahí pasaba la validación y el widget salía en 0/vacío en
  // silencio, y `uniqueDatasets` (mismo par de recolectores) tampoco lo recuperaba.
  const refs = [...new Set(pieces.flatMap((pc) => [...collectDataRefs(pc), ...collectDatasetKeys(pc)]))]
  for (const ref of refs) {
    const dataset = ref.split('.')[0]
    if (!(dataset in s.data)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'dangling-data-reference',
        path: `piece -> data.${ref}`,
        value: ref,
        message: `La pieza referencia el dataset '${dataset}', que no existe en el bloque data.`,
        remediation: `Declarar el dataset '${dataset}' en data, o corregir la referencia.`,
      })
    }
  }

  // 2·bis · Ejes de `distribution`: el gráfico lee su dataset desde dimension/metric (ruta
  // completa data.<dataset>.<campo>, como un kpi) e IGNORA cualquier clave `data:`. Un eje pelado
  // (`dimension: local`) resuelve un dataset inexistente y el gráfico sale VACÍO sin error — el
  // render no falla, solo no dibuja barras. Lo atajamos acá: exigir ruta completa y rechazar la
  // clave `data:` colgante, que delata que la fuente quedó sin cablear. (La existencia del dataset
  // y del campo la cubren los pasos 2 y 4 una vez que el eje es un data.<...> recolectable.)
  for (const d of pieces.flatMap((pc) => collectDistributions(pc))) {
    const hasMetrics = Array.isArray(d['metrics']) && (d['metrics'] as unknown[]).length > 0
    const hasMetric = d['metric'] != null
    // #203 · modo LONG: `series: <campo>` deriva las series de una COLUMNA, así que la métrica es
    // UNA sola (`metric`) y las etiquetas salen del dato. Es el complemento del modo wide, no una
    // variante suya: declarar los dos es pedir dos orígenes de series a la vez.
    const hasSeriesCol = typeof d['series'] === 'string' && d['series'] !== ''
    if (hasSeriesCol && hasMetrics) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'distribution-series-metrics-collision',
        path: 'piece -> distribution.series',
        value: d['series'] as never,
        message: `Un gráfico distribution declara 'series' (las series salen de una columna) y 'metrics' (las series son columnas del YAML) a la vez; son mutuamente excluyentes.`,
        remediation: `Dejar solo 'series: <campo>' con 'metric: data.<dataset>.<campo>' (formato largo), o solo 'metrics: [{ field, label }, ...]' (formato ancho).`,
      })
    }
    if ('series' in d && !hasSeriesCol) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'distribution-series-not-field',
        path: 'piece -> distribution.series',
        value: (d['series'] ?? null) as never,
        message: `El 'series' de un gráfico distribution debe ser el NOMBRE de una columna del dataset; recibió ${JSON.stringify(d['series'] ?? null)}.`,
        remediation: `Escribir 'series: <campo>' (campo pelado del dataset de dimension, no una ruta data.*).`,
      })
    }
    // `metric` (una serie) y `metrics` (varias, agrupadas) son mutuamente excluyentes.
    if (hasMetric && hasMetrics) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'distribution-metric-metrics-collision',
        path: 'piece -> distribution',
        message: `Un gráfico distribution declara 'metric' (una serie) y 'metrics' (varias) a la vez; son mutuamente excluyentes.`,
        remediation: `Dejar solo 'metric: data.<dataset>.<campo>' (una barra por categoría) o solo 'metrics: [{ field, label }, ...]' (barras agrupadas).`,
      })
    }
    // `dimension` SIEMPRE es una ruta completa data.<dataset>.<campo>; en modo singular, `metric`
    // también. En modo agrupado, `metric` no aplica y las series viven en `metrics`.
    const axes: ('dimension' | 'metric')[] = hasMetrics ? ['dimension'] : ['dimension', 'metric']
    for (const axis of axes) {
      const v = d[axis]
      if (typeof v !== 'string' || !v.startsWith('data.') || stripDataRef(v).split('.').length < 2) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'distribution-axis-not-qualified',
          path: `piece -> distribution.${axis}`,
          value: (v ?? null) as never,
          message: `El eje '${axis}' de un gráfico distribution debe ser una ruta completa data.<dataset>.<campo> (como un kpi); recibió ${JSON.stringify(v ?? null)}.`,
          remediation: `Escribir '${axis}: data.<dataset>.<campo>'. El gráfico NO lee una clave 'data:' separada; su fuente sale de dimension/metric.`,
        })
      }
    }
    // Modo agrupado: cada serie de `metrics` es un CAMPO pelado del dataset de `dimension` (no una
    // ruta data.*, por eso el barrido de refs no lo alcanza). Exigir `field` y, si el dataset declara
    // shape, que el campo exista — un typo dejaría la serie en 0/vacía en silencio.
    if (hasMetrics) {
      const dsName = stripDataRef(String(d['dimension'])).split('.')[0]
      const cds = dsName ? s.data[dsName] : undefined
      for (const [i, m] of (d['metrics'] as { field?: unknown; label?: unknown }[]).entries()) {
        const field = m && typeof m.field === 'string' ? m.field : ''
        if (!field) {
          throw new VergisError({
            error: 'mira/spec-invalid',
            code: 'distribution-metrics-field-missing',
            path: `piece -> distribution.metrics[${i}].field`,
            value: (m?.field ?? null) as never,
            message: `Cada serie de un distribution agrupado requiere 'field' (un campo del dataset de dimension).`,
            remediation: `Declarar 'field' en cada entrada de metrics, p.ej. metrics: [{ field: plantas_base, label: "Base" }].`,
          })
        }
        if (cds?.shape?.fields && !(field in cds.shape.fields)) {
          throw new VergisError({
            error: 'mira/spec-invalid',
            code: 'distribution-metrics-field-dangling',
            path: `piece -> distribution.metrics[${i}].field`,
            value: field,
            message: `La serie '${field}' del distribution agrupado no está declarada en data.${dsName}.shape.fields.`,
            remediation: `Declarar '${field}' en shape.fields de '${dsName}' o corregir el campo de la serie.`,
          })
        }
      }
    }
    // Modo LONG: `series` es un campo pelado del dataset de `dimension`, igual que las entradas de
    // `metrics`, y el barrido de refs tampoco lo alcanza. Un typo acá no falla: produce UNA serie
    // llamada 'undefined' con todo el total adentro — un gráfico que se ve bien y miente.
    if (hasSeriesCol) {
      const dsName = stripDataRef(String(d['dimension'])).split('.')[0]
      const cds = dsName ? s.data[dsName] : undefined
      const field = String(d['series'])
      if (cds?.shape?.fields && !(field in cds.shape.fields)) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'distribution-series-field-dangling',
          path: 'piece -> distribution.series',
          value: field,
          message: `La columna de series '${field}' no está declarada en data.${dsName}.shape.fields.`,
          remediation: `Declarar '${field}' en shape.fields de '${dsName}' o corregir la columna de series.`,
        })
      }
    }
    // `sort` (#81): vocabulario CERRADO — `magnitude` (default e implícito) · `chrono` (manda el
    // ORDER BY del SQL) · `value:<serie>` (una serie declarada, por label o por field). En modo mono
    // se acepta además el token legacy `-campo`/`campo`. Un `value:` colgante ordenaría por un campo
    // fantasma (todo NaN) y saldría en orden arbitrario SIN error: se ataja acá.
    if ('sort' in d) {
      const raw = d['sort']
      if (typeof raw !== 'string' || raw === '') {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'distribution-sort-not-string',
          path: 'piece -> distribution.sort',
          value: (raw ?? null) as never,
          message: `El 'sort' de un gráfico distribution debe ser una cadena del vocabulario cerrado; recibió ${JSON.stringify(raw ?? null)}.`,
          remediation: `Usar 'sort: magnitude' (default), 'sort: chrono' o 'sort: value:<serie>'.`,
        })
      }
      const known = raw === 'magnitude' || raw === 'chrono' || raw.startsWith('value:')
      if ((hasMetrics || hasSeriesCol) && !known) {
        // El token legacy `-campo` NUNCA tuvo efecto en el modo agrupado (el encoding ordenaba por
        // la suma de series): aceptarlo en silencio sería prometer un orden que no ocurre.
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'distribution-sort-unknown',
          path: 'piece -> distribution.sort',
          value: raw,
          message: `El 'sort' '${raw}' no pertenece al vocabulario de un distribution multi-serie (${hasSeriesCol ? 'series' : 'metrics'}).`,
          remediation: `Usar 'magnitude' (por la suma de las series, default), 'chrono' (el orden del SQL) o 'value:<serie>' con el label o el field de una de las series declaradas.`,
        })
      }
      // En modo LONG las series NO se conocen sin los datos: validar `value:<serie>` acá exigiría
      // adivinar qué valores traerá la columna. Se acepta, y si no matchea ninguna serie derivada
      // `parseChartSort` cae a `magnitude` — el mismo default que un spec sin `sort`.
      if (raw.startsWith('value:') && !hasSeriesCol) {
        const name = raw.slice('value:'.length)
        const candidates = hasMetrics
          ? (d['metrics'] as { field?: unknown; label?: unknown }[]).flatMap((m) =>
              [m.label, m.field].filter((x): x is string => typeof x === 'string' && x !== ''),
            )
          : [stripDataRef(String(d['metric'] ?? '')).split('.')[1] ?? ''].filter((x) => x !== '')
        if (!candidates.includes(name)) {
          throw new VergisError({
            error: 'mira/spec-invalid',
            code: 'distribution-sort-value-dangling',
            path: 'piece -> distribution.sort',
            value: raw,
            message: `El orden 'value:${name}' no corresponde a ninguna serie del gráfico distribution.`,
            remediation: `Usar el label o el field de una serie declarada (${candidates.map((c) => `'${c}'`).join(', ') || 'ninguna declarada'}), o cambiar a 'magnitude'/'chrono'.`,
          })
        }
      }
    }
    if ('data' in d) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'distribution-stray-data-key',
        path: `piece -> distribution.data`,
        value: (d['data'] ?? null) as never,
        message: `Un gráfico distribution no lee la clave 'data:'; su dataset sale de dimension/metric. Su presencia indica que la fuente no quedó cableada y el gráfico saldría vacío.`,
        remediation: `Quitar 'data:' y dejar dimension/metric como rutas completas data.<dataset>.<campo>.`,
      })
    }
  }

  // 2·ter · Elemento `series` (líneas de N series): `data` es un dataset (data.<dataset>), `x` y las
  // series de `metrics` son CAMPOS pelados del dataset (no rutas data.*), por eso el barrido de refs
  // no valida esos campos. Exigir `data`/`x`/`metrics[≥1]` y que los campos existan en shape (un typo
  // dejaría el eje o una serie vacía en silencio — mismo criterio dangling que controles/filtros).
  for (const se of pieces.flatMap((pc) => collectSeries(pc))) {
    const dataRef = se['data']
    if (typeof dataRef !== 'string' || !dataRef.startsWith('data.') || !stripDataRef(dataRef).split('.')[0]) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'series-data-not-qualified',
        path: 'piece -> series.data',
        value: (dataRef ?? null) as never,
        message: `Un elemento series debe declarar 'data: data.<dataset>' (el dataset cuyas filas son los puntos del eje); recibió ${JSON.stringify(dataRef ?? null)}.`,
        remediation: `Escribir 'data: data.<dataset>'.`,
      })
    }
    const dsName = stripDataRef(dataRef).split('.')[0]
    const sds = s.data[dsName]
    const x = se['x']
    if (typeof x !== 'string' || !x) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'series-x-missing',
        path: 'piece -> series.x',
        value: (x ?? null) as never,
        message: `Un elemento series requiere 'x' (el campo del eje; cada fila del dataset es un punto).`,
        remediation: `Declarar 'x: <campo>' (un campo del dataset de 'data').`,
      })
    }
    if (sds?.shape?.fields && !(x in sds.shape.fields)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'series-x-dangling',
        path: 'piece -> series.x',
        value: x,
        message: `El eje 'x' de series usa el campo '${x}', que no está declarado en data.${dsName}.shape.fields.`,
        remediation: `Declarar '${x}' en shape.fields de '${dsName}' o corregir x.`,
      })
    }
    const metrics = se['metrics']
    if (!Array.isArray(metrics) || metrics.length === 0) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'series-metrics-missing',
        path: 'piece -> series.metrics',
        value: (metrics ?? null) as never,
        message: `Un elemento series requiere 'metrics' con al menos una serie ({ field, label }).`,
        remediation: `Declarar metrics: [{ field: <campo>, label: "..." }, ...] (una columna por serie).`,
      })
    }
    for (const [i, m] of (metrics as { field?: unknown; label?: unknown }[]).entries()) {
      const field = m && typeof m.field === 'string' ? m.field : ''
      if (!field) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'series-metrics-field-missing',
          path: `piece -> series.metrics[${i}].field`,
          value: (m?.field ?? null) as never,
          message: `Cada serie requiere 'field' (una columna del dataset de 'data').`,
          remediation: `Declarar 'field' en cada entrada de metrics.`,
        })
      }
      if (sds?.shape?.fields && !(field in sds.shape.fields)) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'series-metrics-field-dangling',
          path: `piece -> series.metrics[${i}].field`,
          value: field,
          message: `La serie '${field}' no está declarada en data.${dsName}.shape.fields.`,
          remediation: `Declarar '${field}' en shape.fields de '${dsName}' o corregir el campo de la serie.`,
        })
      }
    }
  }

  // 3 · Capabilities catalogadas
  for (const [name, ds] of Object.entries(s.data)) {
    if (!ctx.capabilities.includes(ds.capability)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'capability-not-catalogued',
        path: `data.${name}.capability`,
        value: ds.capability,
        message: `Capability '${ds.capability}' no existe en el catálogo del AgencyDomain. Catalogadas: ${ctx.capabilities.join(', ')}.`,
        remediation: `Corregir el nombre o catalogar '${ds.capability}' como Capability nueva.`,
      })
    }
  }

  // 3·bis · Capabilities de los CHANNELS de distribución (el paso 3 solo cubría las de `data`): un
  // typo en la capability de un canal explotaba tarde en request-time con `capability-not-found`.
  // (Nota: `channels[].schedule` sigue declarable pero es INERTE — no hay scheduler; rechazarlo
  // rompería specs existentes, así que su deprecación queda para un cambio de contrato coordinado.)
  for (const [i, ch] of (s.delivery?.channels ?? []).entries()) {
    if (ch?.capability && !ctx.capabilities.includes(ch.capability)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'channel-capability-not-catalogued',
        path: `delivery.channels[${i}].capability`,
        value: ch.capability,
        message: `La capability del canal '${ch.capability}' no existe en el catálogo. Catalogadas: ${ctx.capabilities.join(', ')}.`,
        remediation: `Corregir el nombre o catalogar '${ch.capability}'.`,
      })
    }
  }

  // 4 · Consistencia de shape: los campos referenciados están declarados
  for (const ref of refs) {
    const [dataset, field] = ref.split('.')
    const ds = s.data[dataset]
    if (ds?.shape?.fields && field && !(field in ds.shape.fields)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'shape-mismatch',
        path: `data.${dataset}.shape.fields`,
        value: field,
        message: `La pieza referencia 'data.${ref}' pero el campo '${field}' no está declarado en data.${dataset}.shape.fields.`,
        remediation: `Declarar '${field}' en shape.fields o corregir la referencia.`,
      })
    }
  }

  // 4·bis · Tipos de elemento de la pieza: cada nodo es un layout (`layout` + `elements`) o tiene
  // EXACTAMENTE una clave de la lista blanca. Un typo (`markdwon_block:`) compondría `{type: key}` y el
  // render emitiría un comentario HTML invisible → un rincón del PI desaparece sin error. Fail-loud.
  for (const [i, pc] of pieces.entries()) {
    validatePieceNode(pc, hasPages ? `pages[${s.pages![i].id}].piece` : 'piece')
  }

  // 4·ter · Frescura: si `quality.freshness` se declara con source_watermark != ignore y trae max_age,
  // DEBE parsear a > 0 ms. `parseIsoDuration` devuelve 0 para formas no soportadas (P1W, P1M) → toda
  // fila de ayer queda stale en silencio, y con refuse_render el PI deja de servirse por un typo.
  const freshness = (s.quality as { freshness?: Record<string, unknown> } | undefined)?.freshness
  if (freshness && freshness['source_watermark'] !== 'ignore' && freshness['max_age'] != null) {
    validateMaxAge(String(freshness['max_age']), 'quality.freshness.max_age')
    // watermark_field global (`data.<ds>.<campo>` o `<ds>.<campo>`): mismo par de checks que la
    // frescura por-dataset (4·ter·bis). Un typo de dataset la deshabilitaba en silencio; uno de campo
    // resolvía a undefined → toDate null → «fresco» en silencio, lo contrario de lo declarado.
    if (freshness['watermark_field'] != null) {
      const [wds, wfield] = stripDataRef(String(freshness['watermark_field'])).split('.')
      if (!wds || !(wds in s.data)) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'freshness-watermark-dataset-dangling',
          path: 'quality.freshness.watermark_field',
          value: freshness['watermark_field'] as never,
          message: `El watermark_field global referencia el dataset '${wds}', que no existe en data.`,
          remediation: 'Declarar el dataset o corregir watermark_field (forma data.<dataset>.<campo>).',
        })
      }
      const wdsDecl = s.data[wds]
      if (wfield && wdsDecl?.shape?.fields && !(wfield in wdsDecl.shape.fields)) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'freshness-watermark-field-dangling',
          path: 'quality.freshness.watermark_field',
          value: freshness['watermark_field'] as never,
          message: `El watermark_field global usa el campo '${wfield}', que no está en data.${wds}.shape.fields — el watermark sería irresoluble.`,
          remediation: `Declarar '${wfield}' en shape.fields o corregir watermark_field.`,
        })
      }
    }
  }

  // 4·ter·bis · Frescura POR-DATASET (`data.<ds>.freshness`): max_age parseable > 0 (mismo check que
  // el global) y watermark_field declarado en shape.fields cuando el shape existe — un campo colgante
  // haría el watermark irresoluble → «fresco» en silencio, lo contrario de lo declarado.
  for (const [name, ds] of Object.entries(s.data)) {
    const f = ds.freshness
    if (!f) continue
    if (f.max_age == null || f.watermark_field == null) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'freshness-dataset-incomplete',
        path: `data.${name}.freshness`,
        message: `La frescura por-dataset de '${name}' requiere 'watermark_field' (un campo del dataset) y 'max_age'.`,
        remediation: `Declarar ambos, p.ej. freshness: { watermark_field: fecha_dato, max_age: P1D }.`,
      })
    }
    validateMaxAge(String(f.max_age), `data.${name}.freshness.max_age`)
    const field = String(f.watermark_field)
    if (ds.shape?.fields && !(field in ds.shape.fields)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'freshness-watermark-not-declared',
        path: `data.${name}.freshness.watermark_field`,
        value: field,
        message: `El watermark_field '${field}' no está declarado en data.${name}.shape.fields — el watermark sería irresoluble y la frescura pasaría en silencio.`,
        remediation: `Declarar '${field}' en shape.fields o corregir watermark_field (es un campo del PROPIO dataset).`,
      })
    }
  }

  // 4·quater · Render: si `delivery.render` se declara, DEBE incluir al menos un render html (el único
  // formato soportado hoy). Sin esto, `render: [{format: pdf}]` — o un typo `htlm` — sirve una página
  // en blanco con HTTP 200. (Omitir `render` es válido: Mira usa html por defecto.)
  // Lista vacía explícita (`render: []`): en Mira `[] ?? default` NO aplica el default (no es nullish),
  // el loop de render no corre y sale página en blanco con 200. Omitir `render` es lo válido.
  if (Array.isArray(s.delivery?.render) && s.delivery.render.length === 0) {
    throw new VergisError({
      error: 'mira/spec-invalid',
      code: 'render-empty',
      path: 'delivery.render',
      message: 'delivery.render es una lista vacía → página en blanco. Omití `render` (Mira usa html por defecto) o incluí { format: html, target: web }.',
      remediation: 'Quitar `render` o declarar al menos { format: html, target: web }.',
    })
  }
  const renders = (s.delivery?.render ?? []) as { format?: string }[]
  if (renders.length > 0 && !renders.some((r) => r.format === 'html')) {
    throw new VergisError({
      error: 'mira/spec-invalid',
      code: 'render-no-html',
      path: 'delivery.render',
      value: renders.map((r) => r.format).join(', '),
      message: `delivery.render no declara ningún render con format: html (declara: ${renders.map((r) => r.format).join(', ')}).`,
      remediation:
        'Incluir { format: html, target: web }. Los formatos de DELIVERY son html y csv; el PDF no se declara ' +
        'en el spec — la plataforma ofrece «Descargar PDF» server-side cuando la instancia monta el sidecar de conversión.',
    })
  }

  // 4·quinquies · Filtros de interacción (client-side): cada filtro referencia un dataset existente y,
  // si el dataset declara shape.fields, un campo existente. Un filtro colgante produce una faceta vacía
  // en silencio (render-html-piece: `it.datasets[f.dataset] ?? []`).
  for (const [i, f] of (s.interactions?.filters ?? []).entries()) {
    if (!f || typeof f.dataset !== 'string' || !(f.dataset in s.data)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'filter-dataset-dangling',
        path: `interactions.filters[${i}].dataset`,
        value: f?.dataset ?? null,
        message: `El filtro '${f?.field ?? i}' referencia el dataset '${f?.dataset}', que no existe en data.`,
        remediation: 'Declarar el dataset en data o corregir interactions.filters[].dataset.',
      })
    }
    const ds = s.data[f.dataset]
    if (ds?.shape?.fields && f.field && !(f.field in ds.shape.fields)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'filter-field-dangling',
        path: `interactions.filters[${i}].field`,
        value: f.field,
        message: `El filtro sobre '${f.dataset}' usa el campo '${f.field}', que no está declarado en data.${f.dataset}.shape.fields.`,
        remediation: `Declarar '${f.field}' en shape.fields o corregir interactions.filters[].field.`,
      })
    }
  }

  // 5 · El spec es AUTHZ-BLIND (charter §2a): NO declara autorización. La política de quién ve
  // qué fila vive ATADA AL DATO (policy store), y se hace cumplir en el dato (ClickHouse row
  // policy + consumidor de bajo privilegio + solo tablas con política reciben acceso). El reporte
  // no decide acceso — no hay nada de gobernanza que validar acá.
  return s
}

/** max_age DEBE parsear a > 0 ms — `parseIsoDuration` devuelve 0 para formas no soportadas (P1W,
 *  P1M) → toda fila de ayer quedaría stale en silencio, y con refuse_render el PI dejaría de servirse. */
function validateMaxAge(raw: string, path: string): void {
  if (parseIsoDuration(raw) <= 0) {
    throw new VergisError({
      error: 'mira/spec-invalid',
      code: 'freshness-max-age-unsupported',
      path,
      value: raw,
      message: `max_age '${raw}' no es una duración ISO 8601 soportada (parsea a 0 ms → staleness silenciosa: todo dato de ayer quedaría stale).`,
      remediation: 'Usar P#D, PT#H, PT#M, PT#S o sus combinaciones (p.ej. P1D, PT6H, P1DT12H). Semanas/meses: expresarlos en días (P1W → P7D, P1M → P30D).',
    })
  }
}

/** Arista de drill-through declarada en una tabla: ir a la vista `to` pasando una o más claves `by`. */
export interface Drillthrough {
  to: string
  by: string[]
}

/** Recolecta las aristas de drill-through (tablas con `drillthrough`) en el subárbol de una pieza. */
export function collectDrills(node: unknown, acc: Drillthrough[] = []): Drillthrough[] {
  if (node == null || typeof node !== 'object') return acc
  if (Array.isArray(node)) {
    for (const c of node) collectDrills(c, acc)
    return acc
  }
  const obj = node as Record<string, unknown>
  const table = obj['table'] as { drillthrough?: unknown } | undefined
  if (table?.drillthrough != null) for (const d of normalizeDrills(table.drillthrough)) acc.push({ to: d.to, by: d.by })
  for (const v of Object.values(obj)) collectDrills(v, acc)
  return acc
}

/** Un control de cabecera del PI. `source` provee las opciones; `default` el valor inicial. */
export interface MiraControl {
  /** Clave del contexto que fija: se inyecta como `:ctx.<id>` en las queries. */
  id: string
  label?: string
  /** Origen de las opciones: `data.<dataset>.<field>`. Sus valores distintos pueblan el selector. */
  source: string
  /**
   * A qué parámetro de contexto ESCRIBE el control (default = `id`). Dos controles con el mismo `param`
   * son LLAVES ALTERNATIVAS del mismo alcance: eligen por campos distintos, fijan el mismo `ctx.<param>`
   * (deben compartir dataset y ser `single`). Deja `:ctx.<param>` intacto en las queries.
   */
  param?: string
  /**
   * Campo del MISMO dataset de `source` que se muestra como ETIQUETA de las opciones (default = el campo
   * de `source`). El valor escrito sigue siendo el de `source`; solo cambia el texto visible.
   */
  display?: string
  /**
   * Valor inicial cuando no llega `ctx.<id>` en la URL: `max` (mayor/más reciente) · `min` · `first`
   * (primera de aparición) — o un VALOR LITERAL del dominio (#92). El literal se valida contra las
   * opciones resueltas al render; si ese día no está en el dominio, cae al comportamiento sin
   * default (fail-safe). Los keywords ganan sobre un valor homónimo del dominio.
   */
  default?: 'max' | 'min' | 'first' | (string & {})
  /**
   * Campo del MISMO dataset de `source` cuya celda designa la opción por DEFECTO (#235): el DATO elige
   * el default, no el spec. Resuelve el caso del default MÓVIL —«la semana siguiente a hoy», «la campaña
   * vigente»— que ni los keywords ni el literal de #92 pueden expresar: el literal caduca y `first` no
   * da acceso al orden del SQL.
   *
   * Cuenta como VERDADERO exactamente: `true`, `1`, `'1'`, `'true'`, `'t'`, `'s'`, `'si'`, `'sí'`, `'y'`,
   * `'yes'` (en minúsculas, con `trim`). Todo lo demás —incluidos `false`, `0`, `'0'`, `'false'`, `'N'`,
   * `null` y la cadena vacía— es FALSO. No es truthiness de JS.
   *
   * Semántica: si EXACTAMENTE UNA de las opciones resueltas lo trae verdadero, esa opción es el default
   * y gana sobre `default`. Si ninguna o más de una lo traen, `defaultField` no resuelve y se evalúa
   * `default`; si tampoco resuelve, cae al comportamiento sin default (`max`) — fail-safe, no
   * fail-closed, porque el conteo depende del dato y un SQL que un día marca dos filas no debe dejar el
   * PI caído. El caso que no resuelve se LOGUEA (`mira-control-default-field`).
   * El conteo es sobre OPCIONES (después del dedup por value y del descarte del value vacío), no sobre
   * filas. Y como todo default, lo aplica SOLO el dueño del `param`, y la URL le gana siempre.
   */
  defaultField?: string
  /**
   * Selección única (default true). Con `single: false` el control es MULTI-SELECT: los valores viajan
   * como parámetro repetido (`?ctx.<id>=a&ctx.<id>=b`) y en la query el placeholder `:ctx.<id>` DEBE
   * vivir dentro de paréntesis de IN (`WHERE semana IN (:ctx.<id>)`) — Mira lo expande a N binds.
   */
  single?: boolean
}

/** Valida páginas: ids únicos + aristas de drill-through (destino existe, recibe el contexto). */
function validatePages(pages: MiraPage[]): void {
  const ids = new Set<string>()
  for (const p of pages) {
    if (ids.has(p.id)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'duplicate-page-id',
        path: `pages[].id`,
        value: p.id,
        message: `Id de página duplicado: '${p.id}'.`,
        remediation: 'Cada página debe tener un id único.',
      })
    }
    ids.add(p.id)
  }
  const byId = new Map(pages.map((p) => [p.id, p]))
  for (const p of pages) {
    for (const d of collectDrills(p.piece)) {
      const target = byId.get(d.to)
      if (!target) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'drill-target-missing',
          path: `pages[${p.id}] -> drillthrough.to`,
          value: d.to,
          message: `La vista '${p.id}' dríllea a '${d.to}', que no es una página declarada.`,
          remediation: `Crear la página '${d.to}' o corregir drillthrough.to.`,
        })
      }
      const ctx = target.context ?? []
      const missing = d.by.filter((k) => !ctx.includes(k))
      if (missing.length > 0) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'drill-context-mismatch',
          path: `pages[${d.to}].context`,
          value: missing.join(', '),
          message: `La vista '${p.id}' dríllea a '${d.to}' pasando [${d.by.join(', ')}], pero '${d.to}' no declara [${missing.join(', ')}] en su context.`,
          remediation: `Agregar [${missing.join(', ')}] a context de la página '${d.to}' (y usar :ctx.<clave> en su data).`,
        })
      }
    }
  }
}

/**
 * Valida los controles de cabecera: id único, `source` apunta a un dataset existente y `default`
 * conocido. `single: false` (multi-select) es una forma válida del control.
 */
function validateControls(spec: MiraSpec): void {
  const controls = spec.controls ?? []
  const ids = new Set<string>()
  for (const c of controls) {
    if (!c.id || typeof c.id !== 'string') {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-id-missing',
        path: 'controls[].id',
        message: 'Cada control de cabecera requiere un `id` (la clave de contexto que fija).',
        remediation: 'Declarar `id` en cada entrada de `controls`.',
      })
    }
    if (ids.has(c.id)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-id-duplicate',
        path: 'controls[].id',
        value: c.id,
        message: `Control de cabecera duplicado: '${c.id}'.`,
        remediation: 'Cada control debe tener un id único.',
      })
    }
    ids.add(c.id)
    const dataset = stripDataRef(c.source).split('.')[0]
    if (!dataset || !(dataset in spec.data)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-source-dangling',
        path: `controls[${c.id}].source`,
        value: c.source,
        message: `El control '${c.id}' toma opciones de '${c.source}' pero el dataset '${dataset}' no existe en data.`,
        remediation: `Declarar el dataset fuente en data (p.ej. una query de valores distintos), o corregir source.`,
      })
    }
    // El CAMPO del source (no solo el dataset): un typo deja el control sin opciones → ctx sin fijar
    // → páginas con 0 filas en silencio. Mismo criterio que los filtros (4·quinquies).
    const srcField = stripDataRef(c.source).split('.')[1]
    const cds = spec.data[dataset]
    if (cds?.shape?.fields && srcField && !(srcField in cds.shape.fields)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-source-field-dangling',
        path: `controls[${c.id}].source`,
        value: c.source,
        message: `El control '${c.id}' usa el campo '${srcField}' de '${dataset}', que no está declarado en data.${dataset}.shape.fields.`,
        remediation: `Declarar '${srcField}' en shape.fields o corregir source.`,
      })
    }
    // El campo de `display` (la etiqueta) debe existir en el MISMO dataset: un typo dejaría la etiqueta
    // cayendo al value en silencio. Mismo criterio que el campo de source.
    if (c.display && cds?.shape?.fields && !(c.display in cds.shape.fields)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-display-field-dangling',
        path: `controls[${c.id}].display`,
        value: c.display,
        message: `El control '${c.id}' muestra el campo '${c.display}' de '${dataset}', que no está declarado en data.${dataset}.shape.fields.`,
        remediation: `Declarar '${c.display}' en shape.fields o corregir display.`,
      })
    }
    // El campo de `defaultField` (#235) debe existir en el MISMO dataset. Sin este check un TYPO en el
    // nombre sería MUDO: `controls.items` tiene `additionalProperties: true` y el control caería a `max`
    // sin decir nada — el PI abriría en la semana equivocada y nadie sabría por qué. El campo colgante
    // es error de SPEC (estático, ruidoso); que el DATO no marque ninguna fila es fail-safe (dinámico).
    if (c.defaultField && cds?.shape?.fields && !(c.defaultField in cds.shape.fields)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-default-field-dangling',
        path: `controls[${c.id}].defaultField`,
        value: c.defaultField,
        message: `El control '${c.id}' toma su default del campo '${c.defaultField}' de '${dataset}', que no está declarado en data.${dataset}.shape.fields.`,
        remediation: `Declarar '${c.defaultField}' en shape.fields o corregir defaultField.`,
      })
    }
    // `default` (#92): keywords `max|min|first` con su semántica de siempre, o un LITERAL — cualquier
    // otro string no vacío. El literal NO se valida aquí contra el dominio (las opciones se resuelven
    // por SQL al render); allá es fail-safe: fuera del dominio cae al comportamiento sin default.
    if (c.default != null && (typeof c.default !== 'string' || c.default === '')) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-default-invalid',
        path: `controls[${c.id}].default`,
        value: c.default,
        message: `default inválido para el control '${c.id}': debe ser un string no vacío.`,
        remediation: 'Usar max (más reciente), min, first, o un valor literal del dominio; u omitir default.',
      })
    }
    // `single: false` (multi-select) es válido: el control se renderiza como grupo de checkboxes,
    // los valores viajan repetidos en la URL y Mira expande `:ctx.<id>` a N binds (ver MiraControl).
  }
  // Params COMPARTIDOS (llaves alternativas del mismo alcance): mismo dataset + single obligatorio.
  const byParam = new Map<string, MiraControl[]>()
  for (const c of controls) {
    const p = c.param ?? c.id
    const g = byParam.get(p)
    if (g) g.push(c)
    else byParam.set(p, [c])
  }
  for (const [param, group] of byParam) {
    if (group.length < 2) continue
    const datasets = new Set(group.map((c) => stripDataRef(c.source).split('.')[0]))
    if (datasets.size > 1) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-param-dataset-mismatch',
        path: `controls[param=${param}].source`,
        value: [...datasets].join(', '),
        message: `Los controles que comparten param '${param}' (${group.map((c) => c.id).join(', ')}) apuntan a datasets distintos (${[...datasets].join(', ')}); las llaves alternativas deben leer del MISMO dataset.`,
        remediation: 'Unificar el dataset de source de todos los controles del mismo param.',
      })
    }
    const multi = group.find((c) => c.single === false)
    if (multi) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-param-multi',
        path: `controls[${multi.id}].single`,
        value: 'false',
        message: `El control '${multi.id}' es multi-select (single: false) pero comparte el param '${param}'; las llaves alternativas requieren single: true en esta fase.`,
        remediation: 'Declarar single: true (u omitirlo) en todos los controles que comparten un param.',
      })
    }
  }
}

/** Tipos de elemento de contenido válidos en una pieza (los que `composePiece`/el render reconocen). */
const ELEMENT_TYPES = new Set(['markdown_block', 'kpi', 'dato', 'semaforo', 'distribution', 'series', 'table'])

/**
 * Valida recursivamente un nodo de pieza: o es un layout (`layout` + `elements`) o declara EXACTAMENTE
 * una clave de la lista blanca de elementos. Rechaza el typo silencioso (`markdwon_block:`) que hoy
 * pasa como `{type: key}` y se renderiza como comentario HTML invisible.
 */
function validatePieceNode(node: unknown, path: string): void {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) {
    throw new VergisError({
      error: 'mira/spec-invalid',
      code: 'piece-node-invalid',
      path,
      value: (node ?? null) as never,
      message: `El nodo de pieza en ${path} no es un objeto (layout o elemento).`,
      remediation: `Un nodo es un layout (layout + elements) o exactamente uno de: ${[...ELEMENT_TYPES].join(', ')}.`,
    })
  }
  const obj = node as Record<string, unknown>
  if ('layout' in obj) {
    const elements = obj['elements']
    for (const [i, child] of (Array.isArray(elements) ? elements : []).entries()) {
      validatePieceNode(child, `${path}.elements[${i}]`)
    }
    return
  }
  const typeKeys = Object.keys(obj).filter((k) => ELEMENT_TYPES.has(k))
  if (typeKeys.length !== 1) {
    throw new VergisError({
      error: 'mira/spec-invalid',
      code: 'unknown-element-type',
      path,
      value: Object.keys(obj).join(', ') || null,
      message:
        typeKeys.length === 0
          ? `Nodo de pieza sin tipo de elemento reconocido en ${path} (claves: ${Object.keys(obj).join(', ') || '∅'}). Un typo (p.ej. 'markdwon_block') se compondría como comentario HTML invisible.`
          : `Nodo de pieza con varios tipos de elemento en ${path}: ${typeKeys.join(', ')}. Un nodo declara exactamente uno.`,
      remediation: `Cada nodo es un layout (layout + elements) o exactamente uno de: ${[...ELEMENT_TYPES].join(', ')}.`,
    })
  }
}

/** `data.<dataset>.<field>` → `<dataset>.<field>` (quita el prefijo data.). */
function stripDataRef(ref: string): string {
  return typeof ref === 'string' && ref.startsWith('data.') ? ref.slice('data.'.length) : String(ref ?? '')
}

/** Recolecta toda referencia data.<dataset>[.<field>...] presente en el subárbol de piece. */
export function collectDataRefs(node: unknown, acc: Set<string> = new Set()): string[] {
  if (node == null) return [...acc]
  if (typeof node === 'string') {
    const matches = node.match(/data\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*/g)
    if (matches) for (const m of matches) acc.add(m.slice('data.'.length))
  } else if (Array.isArray(node)) {
    for (const child of node) collectDataRefs(child, acc)
  } else if (typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) collectDataRefs(v, acc)
  }
  return [...acc]
}

/**
 * Recolecta nombres de dataset referenciados por campos que NO llevan el prefijo `data.` y por eso
 * escapan a `collectDataRefs`: `dataset` (dentro de `agg`/`comparison_agg`/`summary.agg`) y `data`
 * (en `table`/`semaforo`). Devuelve el primer segmento (el dataset), tolerando ambas formas
 * (`areas` o `data.areas.campo`). Corre SOLO sobre subárboles de piece (nunca sobre el bloque `data`
 * del spec), así que no confunde la declaración de datasets con una referencia.
 */
export function collectDatasetKeys(node: unknown, acc: Set<string> = new Set()): string[] {
  if (node == null) return [...acc]
  if (Array.isArray(node)) {
    for (const child of node) collectDatasetKeys(child, acc)
  } else if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const key of ['dataset', 'data'] as const) {
      const v = obj[key]
      if (typeof v === 'string' && v.length > 0) acc.add(stripDataRef(v).split('.')[0])
    }
    for (const v of Object.values(obj)) collectDatasetKeys(v, acc)
  }
  return [...acc]
}

/** Recolecta todos los nodos `series` (su objeto de config) presentes en el subárbol de piece. */
export function collectSeries(node: unknown, acc: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node == null) return acc
  if (Array.isArray(node)) {
    for (const child of node) collectSeries(child, acc)
  } else if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (obj['series'] && typeof obj['series'] === 'object') {
      acc.push(obj['series'] as Record<string, unknown>)
    }
    for (const v of Object.values(obj)) collectSeries(v, acc)
  }
  return acc
}

/** Recolecta todos los nodos `distribution` (su objeto de config) presentes en el subárbol de piece. */
export function collectDistributions(
  node: unknown,
  acc: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (node == null) return acc
  if (Array.isArray(node)) {
    for (const child of node) collectDistributions(child, acc)
  } else if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (obj['distribution'] && typeof obj['distribution'] === 'object') {
      acc.push(obj['distribution'] as Record<string, unknown>)
    }
    for (const v of Object.values(obj)) collectDistributions(v, acc)
  }
  return acc
}

/**
 * Valida las declaraciones `data.<dataset>.anchor` (D16). El `anchor` describe la identidad de
 * negocio de las filas — es lo que permite clavar un comentario en un REGISTRO y no en un PI.
 *
 * Se exige: `entity` calificada por esquema (`schema.tabla` — es la clave que unifica el comentario
 * entre PIs, y una referencia de una sola parte no es resoluble), `key` no vacía, y —cuando el
 * dataset declara `shape.fields`— que cada columna de la llave y el `display` existan. Una llave que
 * apunta a un campo inexistente produciría comentarios anclados a `undefined`: silencioso y venenoso.
 *
 * Lo que este validador NO hace, a propósito: leer autorización. `anchor` es identidad, no permiso.
 */
export function validateAnchors(spec: MiraSpec): void {
  for (const [name, ds] of Object.entries(spec.data ?? {})) {
    const anchor = ds?.anchor
    if (!anchor) continue
    const entity = String(anchor.entity ?? '').trim()
    if (!/^[^.\s]+\.[^.\s]+$/.test(entity)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'anchor-entity-unqualified',
        path: `data.${name}.anchor.entity`,
        value: anchor.entity,
        message: `El anchor de '${name}' declara la entidad '${anchor.entity}', que no está calificada por esquema.`,
        remediation: 'Declarar la entidad gobernada como `schema.tabla` (p.ej. `dbo.dim_empleado`): es la referencia que unifica el comentario entre PIs.',
      })
    }
    const key = anchor.key ?? []
    if (!Array.isArray(key) || key.length === 0) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'anchor-key-empty',
        path: `data.${name}.anchor.key`,
        value: anchor.key,
        message: `El anchor de '${name}' no declara llave: sin llave no hay registro al que clavar un comentario.`,
        remediation: 'Declarar en `key` las columnas del dataset que identifican unívocamente una fila.',
      })
    }
    const fields = ds.shape?.fields
    if (!fields) continue
    for (const col of key) {
      if (!(col in fields)) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'anchor-key-field-dangling',
          path: `data.${name}.anchor.key`,
          value: col,
          message: `La llave del anchor de '${name}' usa la columna '${col}', que no está declarada en data.${name}.shape.fields.`,
          remediation: `Declarar '${col}' en shape.fields o corregir la llave (un comentario anclado a una columna inexistente queda colgando en silencio).`,
        })
      }
    }
    if (anchor.display && !(anchor.display in fields)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'anchor-display-field-dangling',
        path: `data.${name}.anchor.display`,
        value: anchor.display,
        message: `El anchor de '${name}' muestra la columna '${anchor.display}', que no está declarada en data.${name}.shape.fields.`,
        remediation: `Declarar '${anchor.display}' en shape.fields o corregir display.`,
      })
    }
  }
}

/** Identificador SQL admisible como columna de un filtro (`dbo.tabla.[col]`) — nunca algo del usuario. */
const SQL_IDENT = /^[A-Za-z0-9_[\]]+(\.[A-Za-z0-9_[\]]+)*$/

/**
 * Filtros de bandeja (#82). Lo que se ataja acá, y por qué:
 *  - `id` único y sin colisión con ningún `param` de `controls` — comparten la superficie de
 *    navegación; dos cosas distintas escribiendo la misma llave es un bug silencioso.
 *  - `source` = `data.<dataset>.<campo>` existente: un catálogo colgante deja el filtro sin opciones,
 *    y un filtro sin opciones descarta TODA selección — el filtro se vuelve un no-op invisible.
 *  - `column` = identificador SQL (jamás se bindea: se interpola en el predicado). Un valor libre acá
 *    sería una vía de inyección por el spec.
 *  - `depends_on` apunta a un filtro declarado ANTES (cadena simple, sin ciclos) y el dataset del
 *    dependiente contiene TAMBIÉN el campo del padre — sin eso la cascada no puede condicionar nada.
 *  - Correspondencia con el SQL: todo `:flt.<id>` del spec tiene su filtro declarado y todo filtro
 *    declarado se usa en alguna query. Un huérfano en cualquiera de las dos direcciones es error, no
 *    silencio: un `:flt.` sin filtro degradaría a `1=1` (filtro que no filtra) y un filtro sin
 *    `:flt.` sería un control en la bandeja que no mueve el documento.
 */
function validateFilters(spec: MiraSpec): void {
  const filters = spec.filters ?? []
  if (filters.length === 0) {
    assertNoStrayFltPlaceholders(spec, new Set())
    return
  }
  const seen = new Set<string>()
  const ctrlParams = new Set((spec.controls ?? []).map((c) => c.param ?? c.id))
  for (const f of filters) {
    const fail = (code: string, message: string, remediation: string, path = `filters[${f.id ?? '?'}]`): never => {
      throw new VergisError({ error: 'mira/spec-invalid', code, path, value: (f.id ?? null) as never, message, remediation })
    }
    if (!f.id || typeof f.id !== 'string') {
      fail('filter-id-missing', 'Cada filtro de bandeja requiere un `id` (la llave de su predicado `:flt.<id>`).', 'Declarar `id` en cada entrada de `filters`.', 'filters[].id')
    }
    if (seen.has(f.id)) {
      fail('filter-id-duplicate', `Filtro de bandeja duplicado: '${f.id}'.`, 'Cada filtro debe tener un id único.')
    }
    if (ctrlParams.has(f.id)) {
      fail(
        'filter-id-collides-control',
        `El filtro '${f.id}' usa la misma llave que un control de cabecera.`,
        `Renombrar el filtro o el \`param\` del control: un control es ALCANCE (siempre acota) y un filtro es SUSTRACCIÓN opcional; no pueden compartir llave.`,
      )
    }
    seen.add(f.id)
    const [dsName, field] = [stripDataRef(String(f.source ?? '')).split('.')[0], stripDataRef(String(f.source ?? '')).split('.')[1]]
    if (!dsName || !field || !(dsName in spec.data)) {
      fail(
        'filter-source-dangling',
        `El filtro '${f.id}' toma sus opciones de '${f.source}', que no resuelve a un data.<dataset>.<campo> existente.`,
        'Declarar el dataset catálogo en `data` (una query de valores distintos) y apuntar `source` a data.<dataset>.<campo>.',
        `filters[${f.id}].source`,
      )
    }
    const ds = spec.data[dsName]
    if (ds?.shape?.fields && !(field in ds.shape.fields)) {
      fail(
        'filter-source-field-dangling',
        `El filtro '${f.id}' usa el campo '${field}' de '${dsName}', que no está declarado en data.${dsName}.shape.fields.`,
        `Declarar '${field}' en shape.fields o corregir source.`,
        `filters[${f.id}].source`,
      )
    }
    const column = f.column && f.column !== '' ? f.column : field
    if (!SQL_IDENT.test(column)) {
      fail(
        'filter-column-invalid',
        `La columna '${column}' del filtro '${f.id}' no es un identificador SQL admisible.`,
        'Usar solo letras, dígitos, guion bajo, punto y corchetes (p.ej. `dbo.hechos.[categoria]`). La columna se interpola en el predicado, así que no admite expresiones.',
        `filters[${f.id}].column`,
      )
    }
    if (f.depends_on != null) {
      if (!seen.has(f.depends_on) || f.depends_on === f.id) {
        fail(
          'filter-depends-on-unknown',
          `El filtro '${f.id}' declara depends_on '${f.depends_on}', que no es un filtro declarado ANTES que él.`,
          'La cascada es una cadena simple: el padre se declara primero. Reordenar `filters` o corregir depends_on (un ciclo o una autorreferencia no es resoluble).',
          `filters[${f.id}].depends_on`,
        )
      }
      const parent = filters.find((x) => x.id === f.depends_on)!
      const parentField = stripDataRef(String(parent.source ?? '')).split('.')[1]
      if (ds?.shape?.fields && parentField && !(parentField in ds.shape.fields)) {
        fail(
          'filter-cascade-field-missing',
          `El filtro '${f.id}' depende de '${parent.id}', pero su catálogo '${dsName}' no declara el campo '${parentField}' del padre.`,
          `La cascada condiciona las opciones del hijo por el valor del padre EN EL MISMO catálogo: declarar '${parentField}' en data.${dsName}.shape.fields (p.ej. un SELECT DISTINCT de ambos campos).`,
          `filters[${f.id}].depends_on`,
        )
      }
    }
  }
  assertNoStrayFltPlaceholders(spec, seen)
  // Filtro declarado que ningún SQL usa: un control en la bandeja que no movería nada.
  const used = new Set<string>()
  for (const ds of Object.values(spec.data)) {
    const sql = ds.params?.['sql']
    if (typeof sql !== 'string') continue
    for (const m of sql.matchAll(/:flt\.([a-zA-Z0-9_]+)/g)) used.add(m[1])
  }
  for (const f of filters) {
    if (!used.has(f.id)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'filter-unused',
        path: `filters[${f.id}]`,
        value: f.id,
        message: `El filtro '${f.id}' no se usa en ninguna query: ningún SQL contiene ':flt.${f.id}'.`,
        remediation: `Agregar el predicado a las queries que deba re-anclar (\`WHERE … AND :flt.${f.id}\`), o quitar el filtro. La granularidad la decide el spec: los datasets sin \`:flt.\` no se re-anclan.`,
      })
    }
  }
}

/** Un `:flt.<id>` en el SQL sin su filtro declarado: degradaría a `1=1` — filtro que no filtra. */
function assertNoStrayFltPlaceholders(spec: MiraSpec, declared: Set<string>): void {
  for (const [name, ds] of Object.entries(spec.data)) {
    const sql = ds.params?.['sql']
    if (typeof sql !== 'string') continue
    for (const m of sql.matchAll(/:flt\.([a-zA-Z0-9_]+)/g)) {
      if (declared.has(m[1])) continue
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'filter-placeholder-dangling',
        path: `data.${name}.params.sql`,
        value: m[0],
        message: `La query de '${name}' usa ':flt.${m[1]}' pero no hay un filtro '${m[1]}' declarado en el bloque filters.`,
        remediation: `Declarar el filtro en \`filters\` (id, label, source) o quitar el placeholder de la query.`,
      })
    }
  }
}
