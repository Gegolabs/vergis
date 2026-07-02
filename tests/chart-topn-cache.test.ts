// Charts `distribution` (work/052 §2.6): (a) cota de cardinalidad — sobre CHART_MAX_BARS se dibuja
// el top-N y el resto se agrupa en «(otros)» (sin cota, 500 valores → SVG de ~17.000 px); (b) caché
// module-level de SVG por hash de (spec del chart + datos): el compile de Vega es caro y determinista.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, CHART_MAX_BARS, chartCacheStats, type ResolvedNode } from '@vergis/capabilities'

function distPiece(n: number, offset = 0): ResolvedNode {
  return {
    type: 'distribution',
    title: 'Cardinalidad',
    dimensionField: 'dim',
    metricField: 'm',
    // métrica decreciente → el top-N es determinista (dim-1 la mayor)
    rows: Array.from({ length: n }, (_, i) => ({ dim: `dim-${i + 1}`, m: n - i + offset })),
  }
}

async function render(piece: ResolvedNode): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol' }, { agent: 'test' })) as { html: string }
  return html
}

describe('distribution · cota de cardinalidad (top-N + otros)', () => {
  it(`> ${CHART_MAX_BARS} valores → top-${CHART_MAX_BARS} + barra «(otros)» + nota al pie`, async () => {
    const html = await render(distPiece(CHART_MAX_BARS + 20))
    expect(html).toContain('(otros)') // la barra agregada
    expect(html).toContain(`Top ${CHART_MAX_BARS} de ${CHART_MAX_BARS + 20} valores`) // nota discreta
    expect(html).toContain('dim-1') // el mayor sí se dibuja
    expect(html).toContain(`dim-${CHART_MAX_BARS}`) // el N-ésimo también
    expect(html).not.toContain(`dim-${CHART_MAX_BARS + 1}`) // el N+1 quedó agrupado en (otros)
  })

  it(`≤ ${CHART_MAX_BARS} valores → sin (otros) ni nota`, async () => {
    const html = await render(distPiece(5, 1000)) // offset: datos distintos a otros tests (no comparte caché)
    expect(html).not.toContain('(otros)')
    expect(html).not.toContain('chart-note')
    expect(html).toContain('dim-5')
  })
})

describe('distribution · caché de SVG', () => {
  it('segunda llamada con el mismo chart+datos → HIT (no recompila Vega); datos distintos → MISS', async () => {
    const piece = distPiece(8, 77) // datos únicos de este test
    const first = await render(piece)
    const h0 = chartCacheStats.hits
    const second = await render(distPiece(8, 77)) // objeto nuevo, mismos datos → misma clave canónica
    expect(chartCacheStats.hits).toBe(h0 + 1)
    // el SVG cacheado es idéntico al compilado
    expect(second).toBe(first)
    const m0 = chartCacheStats.misses
    await render(distPiece(8, 78)) // datos distintos → clave distinta → miss
    expect(chartCacheStats.misses).toBe(m0 + 1)
  })
})
