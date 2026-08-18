import { VergisError } from '@vergis/botler'
import type { MiraSpec } from './dsl/validate'

export interface DatasetResult {
  rows: Record<string, unknown>[]
}

/** Agregación declarada de un KPI sobre un dataset (recomputable bajo filtro). */
export interface Aggregation {
  dataset?: string
  op: 'sum' | 'ratio' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct'
  field?: string
  num?: string
  den?: string
}

/**
 * Calcula el valor de una agregación sobre un conjunto de filas.
 * Semántica: `sum`/`avg`/`min`/`max` sobre la coerción numérica de `field` (no-numérico cuenta 0 en
 * sum/avg y se ignora en min/max; sin filas → 0); `count` sin `field` = número de filas, con `field`
 * = filas con valor no-nulo/no-vacío; `count_distinct` = valores distintos de `field` (requerido);
 * `ratio` = sum(num)/sum(den) (den 0 → 0). Op desconocido → fail-loud.
 * ESPEJO: el `agg()` embebido en renderInteractiveScript (render-html-piece.ts) replica esta
 * semántica client-side para el recompute bajo filtro — MANTENER EN SINCRONÍA.
 */
export function aggregate(rows: Record<string, unknown>[], agg: Aggregation): number {
  const sum = (f?: string): number => (f ? rows.reduce((s, r) => s + (Number(r[f]) || 0), 0) : 0)
  switch (agg.op) {
    case 'ratio': {
      const den = sum(agg.den)
      return den ? sum(agg.num) / den : 0
    }
    case 'sum':
      return sum(agg.field)
    case 'avg':
      return rows.length ? sum(agg.field) / rows.length : 0
    case 'count':
      if (!agg.field) return rows.length
      return rows.filter((r) => r[agg.field!] != null && r[agg.field!] !== '').length
    case 'min':
    case 'max': {
      let best = NaN
      for (const r of rows) {
        const n = Number(r[agg.field ?? ''])
        if (Number.isNaN(n)) continue
        if (Number.isNaN(best) || (agg.op === 'min' ? n < best : n > best)) best = n
      }
      return Number.isNaN(best) ? 0 : best
    }
    case 'count_distinct': {
      if (!agg.field) {
        throw new VergisError({
          error: 'mira/compose',
          code: 'agg-field-missing',
          path: 'agg.field',
          message: `La agregación count_distinct requiere 'field' (la columna cuyos valores distintos se cuentan).`,
          remediation: 'Declarar field en el agg del KPI, p.ej. agg: { op: count_distinct, field: empresa, dataset: ... }.',
        })
      }
      return new Set(rows.map((r) => String(r[agg.field!] ?? ''))).size
    }
    default:
      throw new VergisError({
        error: 'mira/compose',
        code: 'agg-op-unknown',
        path: 'agg.op',
        value: agg.op,
        message: `Operación de agregación desconocida: '${agg.op as string}'.`,
        remediation: 'Usar una de: sum, ratio, avg, count, min, max, count_distinct.',
      })
  }
}

/** Spec de columna de tabla (pasa tal cual al renderer; tipado estructural). */
export interface TableColumn {
  field: string
  label?: string
  format?: string
  align?: string
  colorscale?: boolean
  sortable?: boolean
  searchable?: boolean
  filter?: boolean
  groupBy?: boolean
}

/**
 * Criterio de orden de las categorías de un `distribution`, normalizado desde el DSL (#81).
 * ESPEJO del `ChartSort` de `@vergis/capabilities/piece-types` (tipado estructural, como el resto de
 * `ResolvedNode`) — MANTENER EN SINCRONÍA.
 */
export type ChartSort =
  | { kind: 'magnitude' }
  | { kind: 'chrono' }
  | { kind: 'value'; field: string; label: string }
  | { kind: 'field'; field: string; desc: boolean }

export interface ResolvedNode {
  layout?: string
  columns?: number
  elements?: ResolvedNode[]
  type?: string
  content?: string
  value?: unknown
  label?: string
  format?: string
  accent?: string
  comparison?: unknown
  comparisonLabel?: string
  agg?: Aggregation
  comparisonAgg?: Aggregation
  size?: string
  span?: number
  rows?: Record<string, unknown>[]
  dimensionField?: string
  metricField?: string
  /** `distribution` multi-métrica: 2+ series agrupadas. Presente ⇒ modo agrupado. */
  metricsSpec?: { field: string; label: string }[]
  /** `distribution` agrupado: apila las series en vez de yuxtaponerlas (#203). */
  stacked?: boolean
  /** `distribution`: criterio de orden de las categorías, ya normalizado (#81). */
  sortSpec?: ChartSort
  orientation?: string
  title?: string
  /** `series`: campo del eje x (el SQL manda el orden de las filas). */
  xField?: string
  /** `series`: 1..N series (formato wide, una columna por serie). */
  seriesSpec?: { field: string; label: string }[]
  columnsSpec?: TableColumn[]
  labelField?: string
  presentField?: string
  totalField?: string
  pctField?: string
  thresholds?: { green?: number; yellow?: number }
  dataset?: string
  summary?: { value?: unknown; label?: string; format?: string; accent?: string; agg?: Aggregation; dataset?: string }
  interactive?: boolean
  /**
   * Drill-through: acciones de navegación por fila hoja. Cada acción lleva a la vista `to` pasando
   * una o más claves `by` (multi-clave: p.ej. empresa+socio). Una tabla puede ofrecer VARIOS drills
   * (p.ej. "ver el socio" y "ver la empresa"); con uno solo, además se habilita el doble-clic de fila.
   */
  drills?: Drill[]
  /**
   * Llave de negocio declarada por el dataset de la tabla (`data.<ds>.anchor`, D16). Es lo que
   * permite clavar un comentario en un REGISTRO. Mira la copia del spec tal cual — es DESCRIPTIVA,
   * no autoriza nada; `comentarios` lo puebla el server tras el render (Mira jamás lee una nota).
   */
  ancla?: { dataset: string; entity: string; key: string[]; display?: string; comentarios: Record<string, { count: number; porCampo: Record<string, number> }> }
}

/** Una acción de drill-through declarada en una tabla. `by` = claves de contexto que viajan al destino. */
export interface Drill {
  to: string
  by: string[]
  label?: string
}

/**
 * Normaliza `drillthrough` (objeto único o arreglo; `by` string o string[]) a `Drill[]`.
 * Filtra entradas sin `to` o sin `by`. Devuelve `[]` si no hay drills válidos.
 */
export function normalizeDrills(raw: unknown): Drill[] {
  if (raw == null) return []
  const items = Array.isArray(raw) ? raw : [raw]
  const out: Drill[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const d = it as { to?: unknown; by?: unknown; label?: unknown }
    if (typeof d.to !== 'string' || !d.to) continue
    const by = (Array.isArray(d.by) ? d.by : [d.by]).filter((x): x is string => typeof x === 'string' && x.length > 0)
    if (by.length === 0) continue
    out.push({ to: d.to, by, label: typeof d.label === 'string' ? d.label : undefined })
  }
  return out
}

/** Resuelve data.<dataset>.<field> a un valor (single_row → fila[0]; rows → columna o filas). */
export function resolvePath(path: string, results: Record<string, DatasetResult>, spec: MiraSpec): unknown {
  const [dataset, field] = stripData(path).split('.')
  const res = results[dataset]
  if (!res) return undefined
  const shape = spec.data[dataset]?.shape
  if (shape?.type === 'single_row') {
    const row = res.rows[0] ?? {}
    return field ? row[field] : row
  }
  if (!field) return res.rows
  return res.rows.map((r) => r[field])
}

/** Profundidad máxima del árbol de pieza — guard contra specs patológicas (stack overflow). */
const MAX_PIECE_DEPTH = 32

/** Compone la pieza resolviendo referencias e interpolaciones; el render hace la presentación. */
export function composePiece(
  node: Record<string, unknown>,
  results: Record<string, DatasetResult>,
  spec: MiraSpec,
  depth = 0,
): ResolvedNode {
  if (depth > MAX_PIECE_DEPTH) {
    throw new VergisError({
      error: 'mira/compose',
      code: 'piece-depth-exceeded',
      message: `La pieza supera la profundidad máxima de anidamiento (${MAX_PIECE_DEPTH}).`,
      remediation: 'Aplanar el árbol de layouts del spec.',
    })
  }
  if (node['layout']) {
    const elements = (node['elements'] as Record<string, unknown>[] | undefined) ?? []
    return {
      layout: String(node['layout']),
      columns: node['columns'] as number | undefined,
      span: node['span'] as number | undefined,
      elements: elements.map((e) => composePiece(e, results, spec, depth + 1)),
    }
  }
  if (node['markdown_block']) {
    const mb = node['markdown_block'] as { content?: unknown }
    return { type: 'markdown_block', content: interpolate(String(mb.content ?? ''), results, spec) }
  }
  if (node['kpi']) {
    const kpi = node['kpi'] as {
      metric?: string
      label?: string
      format?: string
      accent?: string
      comparison?: string
      comparison_label?: string
      agg?: Aggregation
      comparison_agg?: Aggregation
      size?: string
    }
    // Valor inicial: por agregación sobre un dataset, o por path directo.
    let value: unknown
    let comparison: unknown
    if (kpi.agg) {
      const ds = results[kpi.agg.dataset ?? '']?.rows ?? []
      value = aggregate(ds, kpi.agg)
      if (kpi.comparison_agg) comparison = aggregate(ds, kpi.comparison_agg)
    } else {
      value = resolvePath(String(kpi.metric ?? ''), results, spec)
      if (kpi.comparison) comparison = resolvePath(kpi.comparison, results, spec)
    }
    return {
      type: 'kpi',
      value,
      label: kpi.label,
      format: kpi.format,
      accent: kpi.accent,
      comparison,
      comparisonLabel: kpi.comparison_label,
      agg: kpi.agg ? { ...kpi.agg, dataset: kpi.agg.dataset } : undefined,
      comparisonAgg: kpi.comparison_agg,
      size: kpi.size,
    }
  }
  if (node['dato']) {
    // `dato` (TX-12): atributo rotulado (etiqueta + valor). El valor se resuelve por el MISMO
    // mecanismo de path que `kpi.metric` (resolvePath sobre data.<dataset>.<campo>). NO es una
    // medida (tarjeta grande): es contenido/estado, se imprime tal cual y jamás es interactivo.
    const dt = node['dato'] as { label?: string; value?: string; format?: string }
    return {
      type: 'dato',
      label: dt.label,
      value: resolvePath(String(dt.value ?? ''), results, spec),
      format: dt.format,
    }
  }
  if (node['semaforo']) {
    const s = node['semaforo'] as {
      data?: string
      label?: string
      present?: string
      total?: string
      pct?: string
      thresholds?: { green?: number; yellow?: number }
      title?: string
      columns?: number
      summary?: { agg?: Aggregation; label?: string; format?: string; accent?: string }
    }
    const dataset = stripData(String(s.data ?? '')).split('.')[0]
    const rows = [...(results[dataset]?.rows ?? [])]
    let summary: ResolvedNode['summary']
    if (s.summary?.agg) {
      summary = {
        value: aggregate(rows, s.summary.agg),
        label: s.summary.label,
        format: s.summary.format,
        accent: s.summary.accent,
        agg: { ...s.summary.agg, dataset },
        dataset,
      }
    }
    return {
      type: 'semaforo',
      dataset,
      rows,
      labelField: s.label,
      presentField: s.present,
      totalField: s.total,
      pctField: s.pct,
      thresholds: s.thresholds,
      title: s.title,
      columns: s.columns,
      summary,
    }
  }
  if (node['distribution']) {
    const d = node['distribution'] as {
      dimension?: string
      metric?: string
      metrics?: { field?: string; label?: string }[]
      /** #203 · modo LONG: las series salen de los valores de ESTA columna, no del YAML. */
      series?: string
      /** #203 · apila las series en vez de yuxtaponerlas (solo modo agrupado). */
      stacked?: boolean
      orientation?: string
      sort?: string
      format?: string
      title?: string
    }
    const dataset = stripData(String(d.dimension ?? '')).split('.')[0]
    const dimensionField = stripData(String(d.dimension ?? '')).split('.')[1]
    // Modo AGRUPADO (multi-métrica): `metrics` (≥1) reemplaza a `metric`. Las series son columnas del
    // MISMO dataset (campos pelados, no rutas data.*). El orden de las categorías y la cota top-N los
    // resuelve el render (por la suma de las series). No se pre-ordena acá (la validación exige que
    // metric y metrics no coexistan).
    // #203 · modo LONG: las series salen de una COLUMNA (`series`), no de etiquetas estáticas del
    // YAML. Es el caso de las series que solo se conocen en runtime (un año que elige el usuario,
    // un tipo que aparece en los datos). Se pliega ACÁ a formato wide y el render agrupado se
    // reutiliza ENTERO: mismo apilado, mismos rótulos, misma cota top-N, mismo `sort`. Un segundo
    // renderer para el mismo dibujo sería drift garantizado.
    if (typeof d.series === 'string' && d.series !== '') {
      const valueField = stripData(String(d.metric ?? '')).split('.')[1] ?? ''
      const folded = foldSeriesColumn(results[dataset]?.rows ?? [], dimensionField, d.series, valueField)
      const sortSpec = parseChartSort(d.sort, folded.metricsSpec)
      return {
        type: 'distribution',
        rows: folded.rows,
        dimensionField,
        metricsSpec: folded.metricsSpec,
        sortSpec,
        stacked: d.stacked === true,
        orientation: d.orientation,
        format: d.format,
        title: d.title,
      }
    }
    if (Array.isArray(d.metrics) && d.metrics.length > 0) {
      const metricsSpec = d.metrics.map((m) => ({ field: String(m.field ?? ''), label: m.label ?? String(m.field ?? '') }))
      const rows = [...(results[dataset]?.rows ?? [])]
      const sortSpec = parseChartSort(d.sort, metricsSpec)
      return {
        type: 'distribution',
        rows,
        dimensionField,
        metricsSpec,
        sortSpec,
        stacked: d.stacked === true,
        orientation: d.orientation,
        format: d.format,
        title: d.title,
      }
    }
    const metricField = stripData(String(d.metric ?? '')).split('.')[1]
    let rows = [...(results[dataset]?.rows ?? [])]
    // Modo mono: la única «serie» es la métrica. El token legacy (`-campo`) pre-ordena las filas acá
    // y el render respeta ese orden (`sort: null` en el encoding) — antes el encoding lo pisaba con
    // `-x`/`-y` y el orden declarado quedaba MUERTO (bug (a) de #81).
    const sortSpec = parseChartSort(d.sort, metricField ? [{ field: metricField, label: metricField }] : [])
    if (sortSpec?.kind === 'field') rows = sortRows(rows, d.sort, metricField)
    return {
      type: 'distribution',
      rows,
      dimensionField,
      metricField,
      sortSpec,
      orientation: d.orientation,
      format: d.format,
      title: d.title,
    }
  }
  if (node['series']) {
    // `series` — líneas de N series sobre un eje. El dataset sale de `data` (data.<dataset>); cada
    // fila es un punto del eje x. El SQL manda el ORDEN de las filas (no se re-ordena acá ni en el
    // render). Las series (`metrics`) son columnas del dataset (formato wide).
    const se = node['series'] as {
      data?: string
      x?: string
      metrics?: { field?: string; label?: string }[]
      format?: string
      title?: string
    }
    const dataset = stripData(String(se.data ?? '')).split('.')[0]
    const rows = [...(results[dataset]?.rows ?? [])]
    const seriesSpec = (se.metrics ?? []).map((m) => ({ field: String(m.field ?? ''), label: m.label ?? String(m.field ?? '') }))
    return { type: 'series', rows, xField: se.x, seriesSpec, format: se.format, title: se.title }
  }
  if (node['table']) {
    const t = node['table'] as {
      data?: string
      columns?: TableColumn[]
      sort?: string
      limit?: number
      title?: string
      interactive?: boolean
      drillthrough?: unknown
    }
    const dataset = stripData(String(t.data ?? '')).split('.')[0]
    let rows = [...(results[dataset]?.rows ?? [])]
    rows = sortRows(rows, t.sort)
    if (typeof t.limit === 'number') rows = rows.slice(0, t.limit)
    const drills = normalizeDrills(t.drillthrough)
    const anchor = spec.data?.[dataset]?.anchor
    return {
      type: 'table',
      dataset, // permite direccionar la tabla por su dataset (p.ej. el ancla de comentarios)
      rows,
      // COPIA del arreglo de columnas (no la referencia al spec): el spec está MEMOIZADO por mtime
      // (run.ts) y cualquier enriquecimiento posterior sobre la referencia mutaría el spec cacheado.
      columnsSpec: [...(t.columns ?? [])],
      title: t.title,
      interactive: t.interactive,
      drills: drills.length ? drills : undefined,
      // La llave de negocio del dataset viaja con la tabla (fail-closed: sin `anchor` declarado, no
      // hay ancla y el gesto de comentar no se ofrece). `comentarios` nace vacío: quien lee el store
      // de notas es el server, jamás Mira (D7 — el motor no lee una nota).
      ancla: anchor ? { dataset, entity: anchor.entity, key: anchor.key, display: anchor.display, comentarios: {} } : undefined,
    }
  }
  const key = Object.keys(node)[0] ?? 'unknown'
  return { type: key }
}

/**
 * Normaliza el `sort` declarado de un `distribution` al vocabulario cerrado de #81.
 *
 * `magnitude` (default, contrato histórico) · `chrono` (manda el orden del SQL) ·
 * `value:<serie>` (una serie declarada, por label o por field) · cualquier otro token se lee como el
 * legacy `-campo`/`campo` del modo mono.
 *
 * `value:<x>` con `<x>` desconocido lo rechaza `validateSpec` ANTES de llegar acá; si aun así
 * llegara (compose se puede invocar suelto), degrada a `magnitude` — nunca a un campo fantasma que
 * dejaría el chart ordenado por NaN en silencio.
 */
export function parseChartSort(
  token: string | undefined,
  metrics: { field: string; label: string }[],
): ChartSort | undefined {
  if (!token) return undefined
  if (token === 'magnitude') return { kind: 'magnitude' }
  if (token === 'chrono') return { kind: 'chrono' }
  if (token.startsWith('value:')) {
    const name = token.slice('value:'.length)
    const m = metrics.find((x) => x.label === name) ?? metrics.find((x) => x.field === name)
    return m ? { kind: 'value', field: m.field, label: m.label } : { kind: 'magnitude' }
  }
  const desc = token.startsWith('-')
  return { kind: 'field', field: desc ? token.slice(1) : token, desc }
}

/**
 * Cota de series del modo LONG (#203): sobre este nº de valores distintos en la columna de series,
 * el resto se colapsa en una serie «(otras)» que suma. Sin cota, una columna con 200 valores
 * distintos produce 200 series de colores ciclados — ilegible, y en apilado además indistinguible.
 * El techo es 8 porque es el tamaño de la paleta categórica: sobre eso los colores se repiten y dos
 * series distintas se dibujan iguales, que es peor que agregarlas explícitamente.
 */
export const CHART_MAX_SERIES = 8

/** Etiqueta de la serie agregada cuando la columna excede `CHART_MAX_SERIES`. */
export const OTHER_SERIES_LABEL = '(otras)'

/**
 * Pliega formato LARGO → ANCHO para el `distribution` en modo `series: <campo>` (#203).
 *
 * Cada fila de entrada es `(categoría, serie, valor)`; la salida es una fila por categoría con una
 * columna por serie, que es exactamente lo que consume el render agrupado. Decisiones selladas:
 *
 * - **El orden manda el SQL**, en las dos dimensiones: las categorías salen en orden de aparición y
 *   las series también. No se ordena alfabéticamente — el `ORDER BY` es quien conoce el calendario,
 *   misma tesis que `chrono`.
 * - **Las claves de salida son sintéticas** (`__s0`, `__s1`, …) y el valor de la columna viaja como
 *   `label`. Un valor de serie usado como nombre de campo podría colisionar con el campo de
 *   dimensión o con el de la métrica y pisar el dato en silencio.
 * - **Los pares repetidos se SUMAN.** Un `(categoría, serie)` que aparece dos veces es una
 *   agregación incompleta en el SQL; quedarse con el último valor perdería filas sin decirlo.
 * - **La celda ausente es 0**, no vacía: en un apilado, un hueco y un cero se dibujan igual, y el
 *   0 es lo que hace cuadrar el total de la barra.
 */
export function foldSeriesColumn(
  rows: Record<string, unknown>[],
  dimField: string,
  seriesField: string,
  valueField: string,
  maxSeries: number = CHART_MAX_SERIES,
): { rows: Record<string, unknown>[]; metricsSpec: { field: string; label: string }[]; capped: boolean } {
  // Series y categorías en orden de aparición (el SQL manda).
  const seriesOrder: string[] = []
  const catOrder: string[] = []
  for (const r of rows) {
    const sv = String(r[seriesField] ?? '')
    if (!seriesOrder.includes(sv)) seriesOrder.push(sv)
    const cv = String(r[dimField] ?? '')
    if (!catOrder.includes(cv)) catOrder.push(cv)
  }
  const capped = seriesOrder.length > maxSeries
  const kept = capped ? seriesOrder.slice(0, maxSeries) : seriesOrder
  const labels = capped ? [...kept, OTHER_SERIES_LABEL] : kept
  const metricsSpec = labels.map((label, i) => ({ field: `__s${i}`, label }))
  const keyOf = new Map<string, string>(kept.map((label, i) => [label, `__s${i}`]))
  const otherKey = `__s${kept.length}`

  const byCat = new Map<string, Record<string, unknown>>()
  for (const cat of catOrder) {
    const row: Record<string, unknown> = { [dimField]: cat }
    for (const m of metricsSpec) row[m.field] = 0
    byCat.set(cat, row)
  }
  for (const r of rows) {
    const row = byCat.get(String(r[dimField] ?? ''))
    if (!row) continue
    const key = keyOf.get(String(r[seriesField] ?? '')) ?? (capped ? otherKey : undefined)
    if (key === undefined) continue
    row[key] = (Number(row[key]) || 0) + (Number(r[valueField]) || 0)
  }
  return { rows: [...byCat.values()], metricsSpec, capped }
}

/** sort token: "-campo" (desc), "campo" (asc); "metric"/"-metric" → campo de métrica. */
function sortRows(rows: Record<string, unknown>[], token?: string, metricField?: string): Record<string, unknown>[] {
  if (!token) return rows
  const desc = token.startsWith('-')
  let field = desc ? token.slice(1) : token
  if (field === 'metric' && metricField) field = metricField
  return rows.sort((a, b) => {
    const av = Number(a[field])
    const bv = Number(b[field])
    const cmp = Number.isNaN(av) || Number.isNaN(bv) ? String(a[field]).localeCompare(String(b[field])) : av - bv
    return desc ? -cmp : cmp
  })
}

function stripData(ref: string): string {
  return ref.startsWith('data.') ? ref.slice('data.'.length) : ref
}

function interpolate(text: string, results: Record<string, DatasetResult>, spec: MiraSpec): string {
  return text.replace(/\{\{\s*data\.([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, p: string) => {
    const v = resolvePath(p, results, spec)
    if (v == null) return ''
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    return String(v)
  })
}
