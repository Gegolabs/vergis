import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { VergisError } from '@vergis/botler'
import { normalizeDrills } from '../compose'
import { parseIsoDuration } from '../freshness'

export interface MiraDataset {
  capability: string
  params?: Record<string, unknown>
  shape?: { type?: string; fields?: Record<string, string> }
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
  data: Record<string, MiraDataset>
  quality: Record<string, unknown>
  delivery: {
    render?: { format: string; target?: string; theme?: string; bom?: boolean }[]
    channels?: { type: string; capability: string; params?: Record<string, unknown>; schedule?: string }[]
    [k: string]: unknown
  }
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
      remediation: 'Incluir { format: html, target: web }. HTML es el único formato de render soportado hoy.',
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
  /** Valor inicial cuando no llega `ctx.<id>` en la URL: el mayor / menor / primero de las opciones. */
  default?: 'max' | 'min' | 'first'
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
    if (c.default != null && !['max', 'min', 'first'].includes(c.default)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-default-invalid',
        path: `controls[${c.id}].default`,
        value: c.default,
        message: `default '${c.default}' inválido para el control '${c.id}'. Valores: max | min | first.`,
        remediation: 'Usar max (más reciente), min o first, u omitir default.',
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
const ELEMENT_TYPES = new Set(['markdown_block', 'kpi', 'dato', 'semaforo', 'distribution', 'table'])

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
