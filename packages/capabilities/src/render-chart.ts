// Render de CHARTS (distribution) — extraído de render-html-piece.ts (NEXT · Ola 3·B).
// Vega-Lite → Vega → SVG server-side, con cota top-N de barras y un LRU de SVG por hash del spec
// (compile determinista y caro → dos requests con los mismos datos no lo pagan dos veces).
import { createHash } from 'node:crypto'
import * as vega from 'vega'
import { compile, type TopLevelSpec } from 'vega-lite'
import { canonical } from '@vergis/botler'
import { escapeHtml } from './markdown'
import { vtFormat } from './table-runtime'
import type { ChartSort, ResolvedNode } from './piece-types'
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
 * Config de la leyenda de los charts multi-serie — CONVENCIÓN DE PLATAFORMA, no declarable por spec
 * (el spec declara QUÉ se grafica; la plataforma decide CÓMO se ve). Horizontal, sin título y ARRIBA.
 *
 * `orient: 'top'` y no `'top-right'` (#96): los orient de ESQUINA (`top-right`, `top-left`, …) son
 * posicionamiento DENTRO del rectángulo de datos — Vega no les reserva espacio y la leyenda se dibuja
 * encima de las marcas (medido: con `top-right` el grupo de leyenda caía 100% dentro del área de plot
 * en los tres tipos de chart, pisando la barra más alta y el cruce de curvas). Solo los orient de
 * BORDE (`top`, `bottom`, `left`, `right`) entran en el layout del lienzo: Vega les reserva una banda
 * propia y el área de plot se desplaza, así que la leyenda queda FUERA. El título del chart es un
 * `<h3>` HTML fuera del SVG, así que la banda superior tampoco colisiona con él.
 */
function chartLegendConfig() {
  return { orient: 'top', title: null, direction: 'horizontal' } as const
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
  rank: TopNRank = { by: 'sum' },
): { rows: Record<string, unknown>[]; grouped: boolean } {
  if (rows.length <= maxBars) return { rows, grouped: false }
  const rowSum = (r: Record<string, unknown>): number => fields.reduce((s, f) => s + (Number(r[f]) || 0), 0)
  // `arrival` NO re-ordena (criterio `chrono`: manda el SQL): se conservan las primeras `maxBars`
  // filas tal como llegaron y el resto colapsa en «(otros)». `field` rankea por UNA serie declarada.
  const sorted =
    rank.by === 'arrival'
      ? rows
      : rank.by === 'field'
        ? [...rows].sort((a, b) => (Number(b[rank.field]) || 0) - (Number(a[rank.field]) || 0))
        : [...rows].sort((a, b) => rowSum(b) - rowSum(a))
  const rest = sorted.slice(maxBars)
  const otros: Record<string, unknown> = { [dimField]: '(otros)' }
  for (const f of fields) otros[f] = rest.reduce((s, r) => s + (Number(r[f]) || 0), 0)
  return { rows: [...sorted.slice(0, maxBars), otros], grouped: true }
}

/** Criterio de ranking de la cota top-N: por suma de series, por una serie, o sin re-ordenar. */
export type TopNRank = { by: 'sum' } | { by: 'field'; field: string } | { by: 'arrival' }

/**
 * Aplica el `ChartSort` normalizado por compose: devuelve las filas EN EL ORDEN FINAL de las
 * categorías. El orden se resuelve siempre acá, en JS, y el encoding declara `sort: null` — no se
 * delega a Vega. Dos razones: (1) con la capa de rótulos (#80) el spec es `layer`, y un `sort` en el
 * canal categórico compartido entre capas dispara el «conflicting sort properties» de Vega-Lite, que
 * degrada a orden ALFABÉTICO en silencio; (2) el criterio del top-N y el del eje quedan garantizados
 * idénticos por construcción, en vez de por dos mecanismos que hay que mantener de acuerdo.
 *
 * `magnitude` (default) reproduce el contrato histórico: en mono, por la métrica descendente; en
 * agrupado, por la SUMA de las series descendente.
 */
function applyChartSort(
  rows: Record<string, unknown>[],
  sort: ChartSort | undefined,
  opts: { metricField?: string; fields?: string[] } = {},
): Record<string, unknown>[] {
  const desc = (field: string) => [...rows].sort((a, b) => (Number(b[field]) || 0) - (Number(a[field]) || 0))
  switch (sort?.kind) {
    // `chrono` manda el orden de llegada (el ORDER BY del SQL); el legacy `-campo` del modo mono ya
    // viene pre-ordenado por compose. En ambos casos no se re-ordena acá.
    case 'chrono':
    case 'field':
      return rows
    case 'value':
      return desc(sort.field)
    default: {
      if (opts.metricField) return desc(opts.metricField)
      const fields = opts.fields ?? []
      const rowSum = (r: Record<string, unknown>): number => fields.reduce((s, f) => s + (Number(r[f]) || 0), 0)
      return [...rows].sort((a, b) => rowSum(b) - rowSum(a))
    }
  }
}

/**
 * Post-proceso del SVG que abre los colores horneados al conmutador de Apariencia (#78).
 *
 * Vega serializa el color como ATRIBUTO de presentación (`fill="#b8bb26"`), y un atributo no admite
 * `var()`. Se reescribe a `style="fill:var(--chart-bar,#b8bb26)"`: la declaración CSS gana sobre el
 * atributo de presentación, así que la paleta activa manda y el hex queda solo como respaldo.
 *
 * Determinista y acotado: reescribe SOLO `fill`/`stroke` cuyo valor sea EXACTAMENTE un hex de token
 * (los ~11 colores que emitimos nosotros); cualquier otro color de Vega —el `#000` de los símbolos
 * de leyenda, `none`, `transparent`— queda intacto. Opera por etiqueta y funde ambas propiedades en
 * UN solo atributo `style`: hay elementos (los símbolos de leyenda de `series`) con fill Y stroke de
 * token, y dos atributos `style` en la misma etiqueta serían HTML inválido.
 */
export function themeChartSvg(svg: string, varMap: Record<string, string>): string {
  if (Object.keys(varMap).length === 0) return svg
  return svg.replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    const decls: string[] = []
    let out = tag
    for (const prop of ['fill', 'stroke'] as const) {
      const m = out.match(new RegExp(`\\s${prop}="(#[0-9a-fA-F]{3,8})"`))
      if (!m) continue
      const name = varMap[m[1].toLowerCase()]
      if (!name) continue
      out = out.replace(m[0], '')
      decls.push(`${prop}:var(${name},${m[1]})`)
    }
    if (decls.length === 0) return tag
    // `style` al final de la etiqueta, antes del cierre (`>` o `/>`).
    return out.replace(/\s*(\/?)>$/, ` style="${decls.join(';')}"$1>`)
  })
}

/** Campo sintético que lleva el rótulo YA formateado server-side (#80). Vega solo lo pinta. */
const LABEL_FIELD = '__label'

/**
 * Formato del rótulo de una marca: el `format` declarado de la métrica si lo hay; sin él, `abbr`.
 * Decisión de plataforma — un chart sin formato explícito rotula abreviado, que es lo legible sobre
 * una barra (`1,2M` cabe donde `1.234.567` no).
 */
function labelFormat(declared?: string): string {
  return declared && declared !== '' ? declared : 'abbr'
}

/**
 * Holgura del dominio cuantitativo para que el rótulo de la marca más larga NO se corte contra el
 * borde del lienzo. El texto vive fuera de la barra (al final en horizontal, encima en vertical), y
 * Vega dimensiona la escala solo por los DATOS: sin este margen el rótulo del máximo queda mochado.
 * Se expande ~10% del rango, y se conserva el 0 como base cuando todos los valores son del mismo signo.
 */
export function labelledDomain(values: number[]): [number, number] | undefined {
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0) return undefined
  const lo = Math.min(0, ...finite)
  const hi = Math.max(0, ...finite)
  const span = hi - lo
  // Dato degenerado (todo cero): un dominio [0,0] no es escala válida.
  if (span === 0) return [lo, hi + 1]
  const pad = span * 0.1
  return [lo < 0 ? lo - pad : lo, hi + pad]
}

/**
 * Capa de rótulos (#80): mismo encoding posicional que las barras (se hereda del top-level), texto
 * pre-computado en los datos. El color sale del theme; la anti-colisión fina (rotar/omitir) es
 * decisión del motor y NO se declara por spec.
 */
function labelLayer(horizontal: boolean, tokens: ThemeTokens) {
  return {
    mark: horizontal
      ? ({ type: 'text', align: 'left', baseline: 'middle', dx: 4, fontSize: 11, color: tokens.chartText } as const)
      : ({ type: 'text', align: 'center', baseline: 'bottom', dy: -4, fontSize: 11, color: tokens.chartText } as const),
    encoding: { text: { field: LABEL_FIELD, type: 'nominal' as const } },
  }
}

export async function renderDistribution(
  node: ResolvedNode,
  tokens: ThemeTokens,
  vars: Record<string, string> = {},
): Promise<string> {
  // Modo AGRUPADO (multi-métrica): 2+ series de barras por categoría.
  if (node.metricsSpec && node.metricsSpec.length > 0) return renderDistributionGrouped(node, tokens, vars)
  const dim = node.dimensionField ?? 'dimension'
  const metric = node.metricField ?? 'metric'
  const horizontal = (node.orientation ?? 'horizontal') === 'horizontal'
  // Orden de las categorías (#81): `magnitude` (default, contrato histórico) deja que Vega ordene el
  // eje por la métrica; `chrono` y el legacy `-campo` respetan el orden de llegada de las filas.
  let rows = applyChartSort(node.rows ?? [], node.sortSpec, { metricField: metric })
  // Cota top-N: se dibujan las CHART_MAX_BARS primeras según el criterio de orden y el resto se
  // agrupa en una barra «(otros)» (suma de la métrica), con nota al pie — el total sigue cuadrando.
  let note = ''
  if (rows.length > CHART_MAX_BARS) {
    const total = rows.length
    rows = groupedTopN(rows, dim, [metric], CHART_MAX_BARS, { by: 'arrival' }).rows
    note = `<div class="chart-note" style="font-size:11px;color:var(--fg-dim,#94a3b8);margin-top:4px">Top ${CHART_MAX_BARS} de ${total} valores — el resto agrupado en «(otros)»</div>`
  }
  // Rótulo de cada marca (#80), pre-computado server-side: Vega solo lo pinta, y así el formato NO
  // se duplica en expresiones Vega (el formateador único es `vtFormat`, que ya viaja al browser).
  const fmt = labelFormat(node.format)
  const values = rows.map((r) => ({ ...r, [LABEL_FIELD]: vtFormat(r[metric], fmt) }))
  const domain = labelledDomain(rows.map((r) => Number(r[metric])))
  const quant = { field: metric, type: 'quantitative' as const, title: null, ...(domain ? { scale: { domain } } : {}) }
  // `sort: null` ⇒ manda el orden de las filas, ya resuelto por applyChartSort.
  const cat = { field: dim, type: 'nominal' as const, sort: null, title: null }
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    background: 'transparent',
    width: 320,
    height: Math.max(120, rows.length * 34),
    data: { values },
    encoding: horizontal ? { y: cat, x: quant } : { x: cat, y: quant },
    layer: [{ mark: { type: 'bar', cornerRadiusEnd: 2, color: tokens.chartBar } }, labelLayer(horizontal, tokens)],
    config: chartAxisConfig(tokens),
  }
  // El LRU cachea el SVG crudo (su clave ya incluye los tokens); la apertura a CSS vars es un paso
  // puro posterior, así que no contamina el caché ni lo invalida.
  const svg = themeChartSvg(await cachedSvg(spec), vars)
  return `<section class="chart">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''}${svg}${note}</section>`
}

/**
 * `distribution` multi-métrica — barras AGRUPADAS: por cada categoría (dimension) se dibuja una barra
 * por serie (metricsSpec), diferenciadas por color. Vega-Lite lo modela con `fold` (wide→long) +
 * `color` por serie + `xOffset`/`yOffset` para agrupar. La cota top-N ordena las categorías por la
 * SUMA de las series y agrega el resto en «(otros)» sumando CADA serie por separado (el total de cada
 * serie sigue cuadrando). Mismo LRU (la clave ya es hash del spec+datos).
 */
async function renderDistributionGrouped(
  node: ResolvedNode,
  tokens: ThemeTokens,
  vars: Record<string, string> = {},
): Promise<string> {
  const dim = node.dimensionField ?? 'dimension'
  const metrics = node.metricsSpec ?? []
  const fields = metrics.map((m) => m.field)
  const horizontal = (node.orientation ?? 'horizontal') === 'horizontal'
  const original = node.rows ?? []
  // Orden de las categorías (#81): `magnitude` (default) = suma de las series, y lo ordena Vega;
  // `chrono` = orden de llegada del SQL; `value:<serie>` = por ESA serie (y el top-N usa la misma).
  const ordered = applyChartSort(original, node.sortSpec, { fields })
  const capped = groupedTopN(ordered, dim, fields, CHART_MAX_BARS, { by: 'arrival' })
  const rows = capped.rows
  const note = capped.grouped
    ? `<div class="chart-note" style="font-size:11px;color:var(--fg-dim,#94a3b8);margin-top:4px">Top ${CHART_MAX_BARS} de ${original.length} valores — el resto agrupado en «(otros)»</div>`
    : ''
  // Datos en formato LARGO, plegados acá y no por el `fold` de Vega: el rótulo de #80 es por
  // (categoría × serie), y un campo pre-computado no sobrevive a un fold de Vega. Plegar en JS lo
  // hace trivial y de paso deja el spec sin transform. `serie` = label (lo que ve la leyenda).
  const labels = metrics.map((m) => m.label)
  const fmt = labelFormat(node.format)
  const values = rows.flatMap((r) =>
    metrics.map((m) => {
      const valor = Number(r[m.field]) || 0
      return { [dim]: r[dim], serie: m.label, valor, [LABEL_FIELD]: vtFormat(valor, fmt) }
    }),
  )
  const colors = seriesColors(tokens, metrics.length)
  const nSeries = Math.max(1, metrics.length)
  const domain = labelledDomain(values.map((v) => v.valor))
  const quant = { field: 'valor', type: 'quantitative' as const, title: null, ...(domain ? { scale: { domain } } : {}) }
  // `sort: null` ⇒ manda el orden de las filas, ya resuelto por applyChartSort.
  const cat = { field: dim, type: 'nominal' as const, sort: null, title: null }
  const offset = { field: 'serie', type: 'nominal' as const }
  const color = {
    field: 'serie',
    type: 'nominal' as const,
    scale: { domain: labels, range: colors },
    legend: chartLegendConfig(),
  }
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    background: 'transparent',
    width: horizontal ? 360 : Math.max(320, rows.length * 26 * nSeries),
    // Barras agrupadas ocupan más: el alto (horizontal) escala con categorías × series, acotado.
    height: horizontal ? Math.min(1200, Math.max(120, rows.length * 22 * nSeries)) : 260,
    data: { values },
    encoding: horizontal ? { y: cat, x: quant, yOffset: offset, color } : { x: cat, y: quant, xOffset: offset, color },
    // Un rótulo POR SUB-BARRA: la capa de texto hereda el encoding posicional y el offset de serie.
    layer: [{ mark: { type: 'bar', cornerRadiusEnd: 2 } }, labelLayer(horizontal, tokens)],
    config: chartAxisConfig(tokens),
  }
  // El LRU cachea el SVG crudo (su clave ya incluye los tokens); la apertura a CSS vars es un paso
  // puro posterior, así que no contamina el caché ni lo invalida.
  const svg = themeChartSvg(await cachedSvg(spec), vars)
  return `<section class="chart">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''}${svg}${note}</section>`
}


/**
 * `series` — líneas de N series sobre un eje. Vega-Lite con `fold` (wide→long) + `color` por serie;
 * el eje x es ORDINAL en el orden de llegada de las filas (`sort: null` — el SQL manda, NO se
 * re-ordena alfabético). Marca de línea con puntos, leyenda abajo, paleta del theme. Mismo LRU.
 */
export async function renderSeries(
  node: ResolvedNode,
  tokens: ThemeTokens,
  vars: Record<string, string> = {},
): Promise<string> {
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
      color: { field: 'serie', type: 'nominal', scale: { domain: labels, range: colors }, legend: chartLegendConfig() },
    },
    config: chartAxisConfig(tokens),
  }
  // El LRU cachea el SVG crudo (su clave ya incluye los tokens); la apertura a CSS vars es un paso
  // puro posterior, así que no contamina el caché ni lo invalida.
  const svg = themeChartSvg(await cachedSvg(spec), vars)
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
