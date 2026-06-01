import type { MiraSpec } from './dsl/validate'

export interface DatasetResult {
  rows: Record<string, unknown>[]
}

/** Agregación declarada de un KPI sobre un dataset (recomputable bajo filtro). */
export interface Aggregation {
  dataset?: string
  op: 'sum' | 'ratio'
  field?: string
  num?: string
  den?: string
}

/** Calcula el valor de una agregación sobre un conjunto de filas. */
export function aggregate(rows: Record<string, unknown>[], agg: Aggregation): number {
  const sum = (f?: string): number => (f ? rows.reduce((s, r) => s + (Number(r[f]) || 0), 0) : 0)
  if (agg.op === 'ratio') {
    const den = sum(agg.den)
    return den ? sum(agg.num) / den : 0
  }
  return sum(agg.field)
}

/** Spec de columna de tabla (pasa tal cual al renderer; tipado estructural). */
export interface TableColumn {
  field: string
  label?: string
  format?: string
  align?: string
  colorscale?: boolean
}

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
  orientation?: string
  title?: string
  columnsSpec?: TableColumn[]
  labelField?: string
  presentField?: string
  totalField?: string
  pctField?: string
  thresholds?: { green?: number; yellow?: number }
  dataset?: string
  summary?: { value?: unknown; label?: string; format?: string; accent?: string; agg?: Aggregation; dataset?: string }
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

/** Compone la pieza resolviendo referencias e interpolaciones; el render hace la presentación. */
export function composePiece(
  node: Record<string, unknown>,
  results: Record<string, DatasetResult>,
  spec: MiraSpec,
): ResolvedNode {
  if (node['layout']) {
    const elements = (node['elements'] as Record<string, unknown>[] | undefined) ?? []
    return {
      layout: String(node['layout']),
      columns: node['columns'] as number | undefined,
      span: node['span'] as number | undefined,
      elements: elements.map((e) => composePiece(e, results, spec)),
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
  if (node['semaforo']) {
    const s = node['semaforo'] as {
      data?: string
      label?: string
      present?: string
      total?: string
      pct?: string
      thresholds?: { green?: number; yellow?: number }
      title?: string
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
      summary,
    }
  }
  if (node['distribution']) {
    const d = node['distribution'] as {
      dimension?: string
      metric?: string
      orientation?: string
      sort?: string
      title?: string
    }
    const dataset = stripData(String(d.dimension ?? '')).split('.')[0]
    const dimensionField = stripData(String(d.dimension ?? '')).split('.')[1]
    const metricField = stripData(String(d.metric ?? '')).split('.')[1]
    let rows = [...(results[dataset]?.rows ?? [])]
    rows = sortRows(rows, d.sort, metricField)
    return { type: 'distribution', rows, dimensionField, metricField, orientation: d.orientation, title: d.title }
  }
  if (node['table']) {
    const t = node['table'] as {
      data?: string
      columns?: TableColumn[]
      sort?: string
      limit?: number
      title?: string
    }
    const dataset = stripData(String(t.data ?? '')).split('.')[0]
    let rows = [...(results[dataset]?.rows ?? [])]
    rows = sortRows(rows, t.sort)
    if (typeof t.limit === 'number') rows = rows.slice(0, t.limit)
    return { type: 'table', rows, columnsSpec: t.columns ?? [], title: t.title }
  }
  const key = Object.keys(node)[0] ?? 'unknown'
  return { type: key }
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
