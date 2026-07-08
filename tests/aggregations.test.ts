// Agregaciones de KPI ampliadas (work/052 R3-2): avg, count, min, max, count_distinct — además de
// sum/ratio. Server-side en compose.aggregate; espejo client-side en el agg() embebido del dashboard
// (renderInteractiveScript). Op desconocido → fail-loud (VergisError), no 0 silencioso.
import { describe, expect, it } from 'vitest'
import { aggregate, type Aggregation } from '@vergis/mira'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

const rows = [
  { area: 'A', v: 10, n: 'x' },
  { area: 'A', v: 30, n: 'y' },
  { area: 'B', v: 20, n: null },
  { area: 'B', v: 'nn', n: 'x' }, // no-numérico
]

describe('aggregate · ops nuevas', () => {
  it('sum / ratio siguen igual', () => {
    expect(aggregate(rows, { op: 'sum', field: 'v' })).toBe(60)
    expect(aggregate(rows, { op: 'ratio', num: 'v', den: 'v' })).toBe(1)
  })
  it('avg = sum/filas (no-numérico cuenta 0; sin filas → 0)', () => {
    expect(aggregate(rows, { op: 'avg', field: 'v' })).toBe(15)
    expect(aggregate([], { op: 'avg', field: 'v' })).toBe(0)
  })
  it('count sin field = número de filas; con field = no-nulos/no-vacíos', () => {
    expect(aggregate(rows, { op: 'count' })).toBe(4)
    expect(aggregate(rows, { op: 'count', field: 'n' })).toBe(3)
  })
  it('min / max sobre los numéricos (los no-numéricos se ignoran; sin numéricos → 0)', () => {
    expect(aggregate(rows, { op: 'min', field: 'v' })).toBe(10)
    expect(aggregate(rows, { op: 'max', field: 'v' })).toBe(30)
    expect(aggregate(rows, { op: 'max', field: 'n' })).toBe(0)
  })
  it('count_distinct = valores distintos del field', () => {
    expect(aggregate(rows, { op: 'count_distinct', field: 'area' })).toBe(2)
    expect(aggregate(rows, { op: 'count_distinct', field: 'n' })).toBe(3) // x, y, '' (null → '')
  })
  it('count_distinct sin field → fail-loud', () => {
    expect(() => aggregate(rows, { op: 'count_distinct' })).toThrow(/count_distinct/)
  })
  it('op desconocida → fail-loud (VergisError, no 0 silencioso)', () => {
    expect(() => aggregate(rows, { op: 'median' } as unknown as Aggregation)).toThrow(/median/)
  })
})

describe('render · KPI con avg recomputable (dashboard interactivo)', () => {
  it('data-agg presente con op avg + el agg() embebido soporta las ops nuevas', async () => {
    const piece: ResolvedNode = {
      type: 'kpi',
      value: 15,
      label: 'Promedio',
      format: 'int_0',
      agg: { op: 'avg', field: 'v', dataset: 'd' },
    }
    const interactive = { datasets: { d: rows }, filters: [{ dataset: 'd', field: 'area' }] }
    const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', interactive }, { agent: 'test' })) as { html: string }
    expect(html).toContain('data-agg=') // el KPI es recomputable client-side
    expect(html).toContain('&quot;op&quot;:&quot;avg&quot;')
    // El espejo client-side (agg() embebido) trae las ops nuevas — mantener en sincronía con compose.aggregate.
    for (const op of ['avg', 'count', 'min', 'max', 'count_distinct']) {
      expect(html).toContain(`a.op === '${op}'`)
    }
  })
})
