// Render de CHARTS (distribution) — extraído de render-html-piece.ts (NEXT · Ola 3·B).
// Vega-Lite → Vega → SVG server-side, con cota top-N de barras y un LRU de SVG por hash del spec
// (compile determinista y caro → dos requests con los mismos datos no lo pagan dos veces).
import { createHash } from 'node:crypto'
import * as vega from 'vega'
import { compile, type TopLevelSpec } from 'vega-lite'
import { canonical } from '@vergis/botler'
import { escapeHtml } from './markdown'
import type { ResolvedNode } from './piece-types'
import type { ThemeTokens } from './themes'

/** Cota de cardinalidad de un `distribution`: sobre este nº de barras, el resto se agrupa en
 *  «(otros)». Sin la cota, la altura `rows.length * 34` no tiene techo: una dimensión con 500
 *  valores distintos produce un SVG de ~17.000 px (ilegible y caro de compilar). */
export const CHART_MAX_BARS = 30

// Caché module-level de SVG por hash de (spec del chart + datos): el compile Vega-Lite → Vega →
// SVG es CARO y DETERMINISTA (mismos datos + misma config ⇒ mismo SVG), así que dos requests con
// los mismos datos no deben pagar el compile dos veces. LRU pequeño (tope fijo) — los datos varían
// por consumidor (RLS), pero cachear el SVG es seguro: la clave incluye las filas exactas.
const CHART_SVG_CACHE = new Map<string, string>()
const CHART_SVG_CACHE_MAX = 100
/** Contadores observables del caché de charts (tests/diagnóstico). */
export const chartCacheStats = { hits: 0, misses: 0 }

export async function renderDistribution(node: ResolvedNode, tokens: ThemeTokens): Promise<string> {
  let rows = node.rows ?? []
  const dim = node.dimensionField ?? 'dimension'
  const metric = node.metricField ?? 'metric'
  const horizontal = (node.orientation ?? 'horizontal') === 'horizontal'
  // Cota top-N: se dibujan las CHART_MAX_BARS mayores por métrica y el resto se agrupa en una
  // barra «(otros)» (suma de la métrica), con nota discreta al pie — el total sigue cuadrando.
  let note = ''
  if (rows.length > CHART_MAX_BARS) {
    const sorted = [...rows].sort((a, b) => (Number(b[metric]) || 0) - (Number(a[metric]) || 0))
    const rest = sorted.slice(CHART_MAX_BARS)
    const restSum = rest.reduce((s, r) => s + (Number(r[metric]) || 0), 0)
    note = `<div class="chart-note" style="font-size:11px;color:var(--fg-dim,#94a3b8);margin-top:4px">Top ${CHART_MAX_BARS} de ${rows.length} valores — el resto agrupado en «(otros)»</div>`
    rows = [...sorted.slice(0, CHART_MAX_BARS), { [dim]: '(otros)', [metric]: restSum }]
  }
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    background: 'transparent',
    width: 320,
    height: Math.max(120, rows.length * 34),
    data: { values: rows },
    mark: { type: 'bar', cornerRadiusEnd: 2, color: tokens.chartBar },
    encoding: horizontal
      ? { y: { field: dim, type: 'nominal', sort: '-x', title: null }, x: { field: metric, type: 'quantitative', title: null } }
      : { x: { field: dim, type: 'nominal', sort: '-y', title: null }, y: { field: metric, type: 'quantitative', title: null } },
    config: {
      view: { stroke: null },
      axis: {
        labelFontSize: 12,
        grid: false,
        labelColor: tokens.chartText,
        titleColor: tokens.chartText,
        domainColor: tokens.chartAxis ?? tokens.chartText,
        tickColor: tokens.chartAxis ?? tokens.chartText,
      },
    },
  }
  // Clave = hash de la serialización canónica del spec Vega-Lite completo (incluye datos, ejes,
  // orientación y tokens del theme ya resueltos) → cualquier variación produce clave distinta.
  const key = createHash('sha256').update(canonical(spec)).digest('hex')
  let svg = CHART_SVG_CACHE.get(key)
  if (svg !== undefined) {
    chartCacheStats.hits += 1
    // LRU: re-insertar al usar; el Map preserva orden de inserción → el primero es el menos usado.
    CHART_SVG_CACHE.delete(key)
    CHART_SVG_CACHE.set(key, svg)
  } else {
    chartCacheStats.misses += 1
    svg = await vegaLiteToSvg(spec)
    CHART_SVG_CACHE.set(key, svg)
    if (CHART_SVG_CACHE.size > CHART_SVG_CACHE_MAX) {
      const oldest = CHART_SVG_CACHE.keys().next().value
      if (oldest !== undefined) CHART_SVG_CACHE.delete(oldest)
    }
  }
  return `<section class="chart">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''}${svg}${note}</section>`
}


async function vegaLiteToSvg(spec: TopLevelSpec): Promise<string> {
  const vgSpec = compile(spec).spec
  const view = new vega.View(vega.parse(vgSpec as vega.Spec), { renderer: 'none' })
  await view.runAsync()
  const svg = await view.toSVG()
  view.finalize()
  return svg
}
