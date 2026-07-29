// #78 · spike de viabilidad: abrir los colores HORNEADOS del SVG al conmutador de Apariencia.
//
// El riesgo declarado era la fragilidad del post-proceso ante la serialización de Vega. El criterio
// de robustez es el de este archivo: para TODOS los tipos de chart y ambas orientaciones, cada hex de
// token del SVG final aparece dentro de un `var(--chart-…, #hex)` — CERO hex huérfanos — y ninguna
// etiqueta queda con dos atributos `style`.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, themeChartSvg, arbolTheme, chartVarMap, resolveChartTokens, type ResolvedNode } from '@vergis/capabilities'

const TOKENS = arbolTheme.tokens
const TOKEN_HEXES = [...new Set(
  [TOKENS.chartBar, TOKENS.chartText, TOKENS.chartAxis, ...(TOKENS.chartSeries ?? [])]
    .filter((x): x is string => !!x)
    .map((x) => x.toLowerCase()),
)]

/** El SVG del chart dentro del HTML servido (el shell trae además SVGs de iconografía). */
function chartSvg(html: string): string {
  const i = html.indexOf('<svg xmlns')
  expect(i).toBeGreaterThan(-1)
  return html.slice(i, html.indexOf('</svg>', i) + 6)
}

/** Hex de token que NO quedaron envueltos en un `var(--chart-…, …)`. */
function orphanTokenHexes(svg: string): string[] {
  const out: string[] = []
  for (const m of svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    if (!TOKEN_HEXES.includes(m[0].toLowerCase())) continue
    const before = svg.slice(Math.max(0, m.index - 60), m.index)
    if (!/var\(--chart-[\w-]+,$/.test(before)) out.push(svg.slice(Math.max(0, m.index - 70), m.index + 10))
  }
  return out
}

const PIECES: Record<string, ResolvedNode> = {
  'mono horizontal': { type: 'distribution', dimensionField: 'p', metricField: 'v', rows: [{ p: 'a', v: 5 }, { p: 'b', v: 3 }] },
  'mono vertical': { type: 'distribution', orientation: 'vertical', dimensionField: 'p', metricField: 'v', rows: [{ p: 'a', v: 5 }, { p: 'b', v: 3 }] },
  'agrupado horizontal': {
    type: 'distribution',
    dimensionField: 'p',
    metricsSpec: [{ field: 'a', label: 'A' }, { field: 'b', label: 'B' }],
    rows: [{ p: 'x', a: 1, b: 2 }, { p: 'y', a: 3, b: 4 }],
  },
  'agrupado vertical': {
    type: 'distribution',
    orientation: 'vertical',
    dimensionField: 'p',
    metricsSpec: [{ field: 'a', label: 'A' }, { field: 'b', label: 'B' }],
    rows: [{ p: 'x', a: 1, b: 2 }, { p: 'y', a: 3, b: 4 }],
  },
  series: {
    type: 'series',
    xField: 'm',
    seriesSpec: [{ field: 'a', label: 'A' }, { field: 'b', label: 'B' }],
    rows: [{ m: 'e', a: 1, b: 2 }, { m: 'f', a: 3, b: 4 }],
  },
}

async function render(piece: ResolvedNode, palette?: string): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol', palette }, { agent: 't' })) as {
    html: string
  }
  return html
}

describe('#78 · post-proceso del SVG: criterio de robustez', () => {
  for (const [name, piece] of Object.entries(PIECES)) {
    it(`${name}: cero hex de token huérfanos`, async () => {
      expect(orphanTokenHexes(chartSvg(await render(piece)))).toEqual([])
    })
  }

  it('cada chart emite al menos un var(--chart-…) (el post-proceso corrió de verdad)', async () => {
    for (const [name, piece] of Object.entries(PIECES)) {
      const svg = chartSvg(await render(piece))
      expect((svg.match(/var\(--chart-[\w-]+,#[0-9a-fA-F]{3,8}\)/g) ?? []).length, name).toBeGreaterThan(0)
    }
  })

  it('ninguna etiqueta queda con dos atributos `style` (los símbolos de leyenda traen fill Y stroke)', async () => {
    for (const [name, piece] of Object.entries(PIECES)) {
      const svg = chartSvg(await render(piece))
      expect((svg.match(/<[^>]*style="[^"]*"[^>]*style="/g) ?? []).length, name).toBe(0)
    }
  })

  it('el símbolo de leyenda funde fill y stroke en UN solo style', async () => {
    const svg = chartSvg(await render(PIECES['series']))
    expect(svg).toMatch(/style="fill:var\(--chart-[\w-]+,#[0-9a-fA-F]{3,8}\);stroke:var\(--chart-[\w-]+,#[0-9a-fA-F]{3,8}\)"/)
  })
})

describe('#78 · themeChartSvg (unidad)', () => {
  const vars = { '#b8bb26': '--chart-bar', '#ebdbb2': '--chart-text' }

  it('reescribe el atributo de presentación a una declaración de estilo', () => {
    expect(themeChartSvg('<path fill="#b8bb26"/>', vars)).toBe('<path style="fill:var(--chart-bar,#b8bb26)"/>')
  })
  it('no toca colores ajenos al mapa (el #000 de los símbolos de leyenda, `none`, …)', () => {
    expect(themeChartSvg('<path fill="#000" stroke="none"/>', vars)).toBe('<path fill="#000" stroke="none"/>')
  })
  it('sin mapa devuelve el SVG intacto (contención: el paso se apaga y quedan los tokens server-side)', () => {
    const svg = '<path fill="#b8bb26"/>'
    expect(themeChartSvg(svg, {})).toBe(svg)
  })
  it('es insensible a mayúsculas en el hex del SVG', () => {
    expect(themeChartSvg('<path fill="#B8BB26"/>', vars)).toContain('var(--chart-bar,#B8BB26)')
  })
  it('conserva el resto de los atributos de la etiqueta', () => {
    const out = themeChartSvg('<path d="M0,0" fill="#b8bb26" opacity="1"/>', vars)
    expect(out).toContain('d="M0,0"')
    expect(out).toContain('opacity="1"')
  })
})

describe('#78 · mapa de vars', () => {
  it('un hex compartido por dos roles se resuelve al primero (barra antes que serie 1)', () => {
    // En `arbol`, chartBar ES el color de la primera serie.
    const map = chartVarMap(TOKENS)
    expect(map[TOKENS.chartBar.toLowerCase()]).toBe('--chart-bar')
  })
  it('cada hex de token tiene una var asignada', () => {
    const map = chartVarMap(TOKENS)
    for (const hex of TOKEN_HEXES) expect(map[hex], hex).toBeTruthy()
  })
  it('resolveChartTokens cae al juego del theme si la paleta no declara el suyo', () => {
    expect(resolveChartTokens(arbolTheme, 'paleta-inexistente')).toBe(arbolTheme.tokens)
  })
})
