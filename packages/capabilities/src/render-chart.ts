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

/** Paleta categórica de fallback para charts multi-serie (cuando el theme no declara `chartSeries`). */
const DEFAULT_SERIES_COLORS = ['#2563eb', '#f59e0b', '#16a34a', '#dc2626', '#9333ea', '#0891b2', '#ea580c', '#65a30d']

/** N colores para N series, del theme (`chartSeries`) o del fallback; se cicla si faltan. */
function seriesColors(tokens: ThemeTokens, n: number): string[] {
  const pal = tokens.chartSeries && tokens.chartSeries.length ? tokens.chartSeries : DEFAULT_SERIES_COLORS
  return Array.from({ length: n }, (_, i) => pal[i % pal.length])
}

/** Config común de ejes de los charts (mismos tokens del theme para todos los tipos). */
function chartAxisConfig(tokens: ThemeTokens) {
  return {
    view: { stroke: null },
    axis: {
      labelFontSize: 12,
      grid: false,
      labelColor: tokens.chartText,
      titleColor: tokens.chartText,
      domainColor: tokens.chartAxis ?? tokens.chartText,
      tickColor: tokens.chartAxis ?? tokens.chartText,
    },
  }
}

/**
 * Compila un spec Vega-Lite a SVG pasando por el LRU (clave = hash canónico del spec completo —
 * incluye datos, ejes y tokens del theme ya resueltos). Compartido por distribution (singular y
 * agrupado) y series: el compile es caro y determinista.
 */
async function cachedSvg(spec: TopLevelSpec): Promise<string> {
  const key = createHash('sha256').update(canonical(spec)).digest('hex')
  const hit = CHART_SVG_CACHE.get(key)
  if (hit !== undefined) {
    chartCacheStats.hits += 1
    // LRU: re-insertar al usar; el Map preserva orden de inserción → el primero es el menos usado.
    CHART_SVG_CACHE.delete(key)
    CHART_SVG_CACHE.set(key, hit)
    return hit
  }
  chartCacheStats.misses += 1
  const svg = await vegaLiteToSvg(spec)
  CHART_SVG_CACHE.set(key, svg)
  if (CHART_SVG_CACHE.size > CHART_SVG_CACHE_MAX) {
    const oldest = CHART_SVG_CACHE.keys().next().value
    if (oldest !== undefined) CHART_SVG_CACHE.delete(oldest)
  }
  return svg
}

/**
 * Cota top-N para barras agrupadas: si hay más categorías que `maxBars`, deja las `maxBars` de mayor
 * SUMA de series y colapsa el resto en una fila «(otros)» que suma CADA serie por separado — así el
 * total de cada serie se conserva (criterio de aceptación: «(otros)» cuadra por serie). Pura y testeable.
 */
export function groupedTopN(
  rows: Record<string, unknown>[],
  dimField: string,
  fields: string[],
  maxBars: number,
): { rows: Record<string, unknown>[]; grouped: boolean } {
  if (rows.length <= maxBars) return { rows, grouped: false }
  const rowSum = (r: Record<string, unknown>): number => fields.reduce((s, f) => s + (Number(r[f]) || 0), 0)
  const sorted = [...rows].sort((a, b) => rowSum(b) - rowSum(a))
  const rest = sorted.slice(maxBars)
  const otros: Record<string, unknown> = { [dimField]: '(otros)' }
  for (const f of fields) otros[f] = rest.reduce((s, r) => s + (Number(r[f]) || 0), 0)
  return { rows: [...sorted.slice(0, maxBars), otros], grouped: true }
}

export async function renderDistribution(node: ResolvedNode, tokens: ThemeTokens): Promise<string> {
  // Modo AGRUPADO (multi-métrica): 2+ series de barras por categoría.
  if (node.metricsSpec && node.metricsSpec.length > 0) return renderDistributionGrouped(node, tokens)
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
    config: chartAxisConfig(tokens),
  }
  const svg = await cachedSvg(spec)
  return `<section class="chart">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''}${svg}${note}</section>`
}

/**
 * `distribution` multi-métrica — barras AGRUPADAS: por cada categoría (dimension) se dibuja una barra
 * por serie (metricsSpec), diferenciadas por color. Vega-Lite lo modela con `fold` (wide→long) +
 * `color` por serie + `xOffset`/`yOffset` para agrupar. La cota top-N ordena las categorías por la
 * SUMA de las series y agrega el resto en «(otros)» sumando CADA serie por separado (el total de cada
 * serie sigue cuadrando). Mismo LRU (la clave ya es hash del spec+datos).
 */
async function renderDistributionGrouped(node: ResolvedNode, tokens: ThemeTokens): Promise<string> {
  const dim = node.dimensionField ?? 'dimension'
  const metrics = node.metricsSpec ?? []
  const fields = metrics.map((m) => m.field)
  const horizontal = (node.orientation ?? 'horizontal') === 'horizontal'
  const original = node.rows ?? []
  const capped = groupedTopN(original, dim, fields, CHART_MAX_BARS)
  const rows = capped.rows
  const note = capped.grouped
    ? `<div class="chart-note" style="font-size:11px;color:var(--fg-dim,#94a3b8);margin-top:4px">Top ${CHART_MAX_BARS} de ${original.length} valores — el resto agrupado en «(otros)»</div>`
    : ''
  // Datos re-etiquetados: la clave de cada serie es su LABEL (lo que verá la leyenda), el valor su
  // coerción numérica. El fold opera sobre los labels → `serie` = label, `valor` = número.
  const labels = metrics.map((m) => m.label)
  const values = rows.map((r) => {
    const o: Record<string, unknown> = { [dim]: r[dim] }
    for (const m of metrics) o[m.label] = Number(r[m.field]) || 0
    return o
  })
  const colors = seriesColors(tokens, metrics.length)
  const catSort = { field: 'valor', op: 'sum', order: 'descending' } as const
  const nSeries = Math.max(1, metrics.length)
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    background: 'transparent',
    width: horizontal ? 360 : Math.max(320, rows.length * 26 * nSeries),
    // Barras agrupadas ocupan más: el alto (horizontal) escala con categorías × series, acotado.
    height: horizontal ? Math.min(1200, Math.max(120, rows.length * 22 * nSeries)) : 260,
    data: { values },
    transform: [{ fold: labels, as: ['serie', 'valor'] }],
    mark: { type: 'bar', cornerRadiusEnd: 2 },
    encoding: horizontal
      ? {
          y: { field: dim, type: 'nominal', sort: catSort, title: null },
          x: { field: 'valor', type: 'quantitative', title: null },
          yOffset: { field: 'serie', type: 'nominal' },
          color: { field: 'serie', type: 'nominal', scale: { domain: labels, range: colors }, legend: { orient: 'bottom', title: null } },
        }
      : {
          x: { field: dim, type: 'nominal', sort: catSort, title: null },
          y: { field: 'valor', type: 'quantitative', title: null },
          xOffset: { field: 'serie', type: 'nominal' },
          color: { field: 'serie', type: 'nominal', scale: { domain: labels, range: colors }, legend: { orient: 'bottom', title: null } },
        },
    config: chartAxisConfig(tokens),
  }
  const svg = await cachedSvg(spec)
  return `<section class="chart">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''}${svg}${note}</section>`
}


/**
 * `series` — líneas de N series sobre un eje. Vega-Lite con `fold` (wide→long) + `color` por serie;
 * el eje x es ORDINAL en el orden de llegada de las filas (`sort: null` — el SQL manda, NO se
 * re-ordena alfabético). Marca de línea con puntos, leyenda abajo, paleta del theme. Mismo LRU.
 */
export async function renderSeries(node: ResolvedNode, tokens: ThemeTokens): Promise<string> {
  const rows = node.rows ?? []
  const x = node.xField ?? 'x'
  const series = node.seriesSpec ?? []
  // Datos re-etiquetados por LABEL (clave = etiqueta de la serie); el fold opera sobre los labels.
  const labels = series.map((s) => s.label)
  const values = rows.map((r) => {
    const o: Record<string, unknown> = { [x]: r[x] }
    for (const s of series) o[s.label] = Number(r[s.field])
    return o
  })
  const colors = seriesColors(tokens, Math.max(1, series.length))
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    background: 'transparent',
    width: 640,
    height: 240,
    data: { values },
    transform: [{ fold: labels, as: ['serie', 'valor'] }],
    mark: { type: 'line', point: true },
    encoding: {
      // `sort: null` → orden de llegada de las filas (el SQL ordena/agrega el eje).
      x: { field: x, type: 'ordinal', sort: null, title: null },
      y: { field: 'valor', type: 'quantitative', title: null },
      color: { field: 'serie', type: 'nominal', scale: { domain: labels, range: colors }, legend: { orient: 'bottom', title: null } },
    },
    config: chartAxisConfig(tokens),
  }
  const svg = await cachedSvg(spec)
  return `<section class="chart">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''}${svg}</section>`
}

async function vegaLiteToSvg(spec: TopLevelSpec): Promise<string> {
  const vgSpec = compile(spec).spec
  const view = new vega.View(vega.parse(vgSpec as vega.Spec), { renderer: 'none' })
  await view.runAsync()
  const svg = await view.toSVG()
  view.finalize()
  return svg
}
