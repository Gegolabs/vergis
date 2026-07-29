// #80 · Rótulo del valor sobre cada marca de barra.
// Dos piezas: el formato `abbr` de `vtFormat` (magnitud abreviada es-CL) y la capa `text` del spec
// Vega-Lite, con el rótulo PRE-COMPUTADO server-side (Vega solo lo pinta — el formato no se duplica
// en expresiones Vega). El rótulo vive dentro del SVG, así que se imprime gratis.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, vtFormat, labelledDomain, type ResolvedNode } from '@vergis/capabilities'

/** Contenidos de los `<text>` de la CAPA DE RÓTULOS (no los del eje ni los de la leyenda). */
function dataLabels(html: string): string[] {
  const i = html.indexOf('mark-text role-mark')
  if (i < 0) return []
  const seg = html.slice(i, html.indexOf('</g>', i))
  return [...seg.matchAll(/>([^<>]*)<\/text>/g)].map((m) => m[1])
}

/** Anchos de las barras dibujadas (`d="M0,0h<W>v…"`), en px del área de plot. */
function barWidths(html: string): number[] {
  return [...html.matchAll(/aria-roledescription="bar"[^>]*d="M0,0h(-?[\d.]+)/g)].map((m) => Math.abs(Number(m[1])))
}

async function render(piece: ResolvedNode): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol' }, { agent: 't' })) as {
    html: string
  }
  return html
}

describe('#80 · formato `abbr` (es-CL)', () => {
  it('millones y miles con coma decimal', () => {
    expect(vtFormat(1234567, 'abbr')).toBe('1,2M')
    expect(vtFormat(340000, 'abbr')).toBe('340K')
    expect(vtFormat(12345, 'abbr')).toBe('12,3K')
  })
  it('poda el decimal cero', () => {
    expect(vtFormat(2000000, 'abbr')).toBe('2M')
    expect(vtFormat(1000, 'abbr')).toBe('1K')
  })
  it('bajo mil no abrevia', () => {
    expect(vtFormat(999, 'abbr')).toBe('999')
    expect(vtFormat(0, 'abbr')).toBe('0')
  })
  it('negativos conservan el signo; el `-0` de redondeo se rotula 0', () => {
    expect(vtFormat(-1234567, 'abbr')).toBe('-1,2M')
    expect(vtFormat(-340000, 'abbr')).toBe('-340K')
    expect(vtFormat(-0.4, 'abbr')).toBe('0')
  })
  it('sobre mil millones sigue en MILLONES (en español «billón» es 10^12, no 10^9)', () => {
    expect(vtFormat(2.5e9, 'abbr')).toBe('2.500M')
    expect(vtFormat(1e12, 'abbr')).toBe('1.000.000M')
  })
  it('acepta el entero-como-string de los drivers SQL', () => {
    expect(vtFormat('1234567', 'abbr')).toBe('1,2M')
  })
  it('no altera los formatos existentes', () => {
    expect(vtFormat(1234567, 'int_0')).toBe('1.234.567')
    expect(vtFormat(0.125, 'percent_1')).toBe('12.5%')
  })
})

describe('#80 · holgura del dominio (el rótulo de la barra más larga no se corta)', () => {
  it('expande el máximo ~10% conservando el cero como base', () => {
    expect(labelledDomain([0, 50, 100])).toEqual([0, 110])
  })
  it('con negativos expande por ambos lados', () => {
    const [lo, hi] = labelledDomain([-100, 100]) as [number, number]
    expect(lo).toBeLessThan(-100)
    expect(hi).toBeGreaterThan(100)
  })
  it('dato degenerado (todo cero) no produce un dominio vacío', () => {
    expect(labelledDomain([0, 0])).toEqual([0, 1])
  })
  it('sin datos finitos no impone dominio', () => {
    expect(labelledDomain([])).toBeUndefined()
  })
  it('en el render, la barra máxima deja headroom dentro del área de plot', async () => {
    const html = await render({
      type: 'distribution',
      dimensionField: 'p',
      metricField: 'v',
      rows: [
        { p: 'a', v: 1000 },
        { p: 'b', v: 500 },
      ],
    })
    // El ancho declarado del área de plot en el modo mono horizontal es 320 px.
    const max = Math.max(...barWidths(html))
    expect(max).toBeGreaterThan(0)
    expect(max).toBeLessThanOrEqual(320 * 0.95)
  })
})

describe('#80 · rótulo por marca', () => {
  const MONO: ResolvedNode = {
    type: 'distribution',
    dimensionField: 'p',
    metricField: 'v',
    rows: [
      { p: 'a', v: 1234567 },
      { p: 'b', v: 340000 },
    ],
  }
  const GROUPED: ResolvedNode = {
    type: 'distribution',
    dimensionField: 'p',
    metricsSpec: [
      { field: 'a', label: 'Alfa' },
      { field: 'b', label: 'Beta' },
    ],
    rows: [
      { p: 'x', a: 1200000, b: 2400 },
      { p: 'y', a: 3, b: 4 },
    ],
  }

  it('mono horizontal: un rótulo abreviado por barra', async () => {
    expect(dataLabels(await render(MONO)).sort()).toEqual(['1,2M', '340K'])
  })
  it('mono vertical: mismos rótulos', async () => {
    expect(dataLabels(await render({ ...MONO, orientation: 'vertical' })).sort()).toEqual(['1,2M', '340K'])
  })
  it('agrupado: un rótulo por SUB-barra (categoría × serie)', async () => {
    const labels = dataLabels(await render(GROUPED))
    expect(labels.length).toBe(4)
    expect(labels.sort()).toEqual(['1,2M', '2,4K', '3', '4'])
  })
  it('agrupado vertical: mismo conteo', async () => {
    expect(dataLabels(await render({ ...GROUPED, orientation: 'vertical' })).length).toBe(4)
  })

  it('usa el `format` declarado de la métrica cuando el spec lo trae', async () => {
    const labels = dataLabels(await render({ ...MONO, format: 'int_0' }))
    expect(labels.sort()).toEqual(['1.234.567', '340.000'])
  })

  it('sin `format` declarado abrevia (decisión de plataforma: lo legible sobre una barra)', async () => {
    expect(dataLabels(await render(MONO))).not.toContain('1.234.567')
  })

  it('el rótulo vive DENTRO del SVG del chart, así que se imprime con él', async () => {
    const html = await render(MONO)
    const chart = html.slice(html.indexOf('<section class="chart">'))
    const svgEnd = chart.indexOf('</svg>')
    expect(chart.slice(0, svgEnd)).toContain('>1,2M</text>')
  })

  it('la barra «(otros)» de la cota top-N también se rotula', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ p: `p${i}`, v: (i + 1) * 1000 }))
    const labels = dataLabels(await render({ ...MONO, rows }))
    // 30 barras del top + «(otros)» = 31 rótulos.
    expect(labels.length).toBe(31)
  })
})
