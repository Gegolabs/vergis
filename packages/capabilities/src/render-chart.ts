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
 * Campo sintético con el texto del TOOLTIP (#208), compuesto server-side.
 *
 * El rótulo de valor **no siempre cabe**: `labelMode` y `assignLanes` existen porque en un gráfico
 * denso hay que ocultar rótulos para que no se fundan, y el resultado es un dato que se dibuja y no
 * se puede leer — que fue justo lo que reportó el usuario. El tooltip lo hace legible sin competir
 * por espacio ni cambiar la composición.
 *
 * **Se compone acá, no en Vega, y el valor que muestra es el MISMO `vtFormat` del rótulo impreso**:
 * así el hover y la etiqueta no pueden discrepar, que es la contradicción que introduce un tooltip
 * cableado por su cuenta.
 */
const TOOLTIP_FIELD = '__tip'

/**
 * Espeja a `<title>` el `aria-label` de las marcas de dato.
 *
 * MEDIDO, no supuesto: el canal `description` de vega-lite hace que el renderer SVG emita
 * `aria-label="<texto>"` en el `<path>` de la marca — pero **el navegador no muestra `aria-label` al
 * pasar el mouse**; el tooltip nativo lo da un hijo `<title>`. Se emite entonces el `<title>` y se
 * CONSERVA el `aria-label`, que es lo que lee un lector de pantalla: la misma frase sirve a los dos.
 *
 * Nativo a propósito: sin JS, sin runtime de Vega en el cliente y sin estado que sincronizar.
 * Acotado a `<path>` con `aria-roledescription` de marca, para no tocar los `<title>` de la página
 * ni los elementos de eje y leyenda.
 */
export function svgTitlesDesdeAria(svg: string): string {
  return svg.replace(
    /<path([^>]*?)aria-label="([^"]*)"([^>]*?)\/>/g,
    (tag, pre: string, texto: string, post: string) =>
      /aria-roledescription="(bar|symbol|point|line)"/.test(tag)
        ? `<path${pre}aria-label="${texto}"${post}><title>${texto}</title></path>`
        : tag,
  )
}

/** Campo sintético con el CARRIL del rótulo (0 = bajo, 1 = alto) en el modo `lanes` (#97). */
const LABEL_LANE_FIELD = '__lane'

/** Tamaño de fuente de los rótulos de valor; lo comparten la marca y la métrica de ancho. */
const LABEL_FONT_PX = 11

/**
 * Ancho por carácter de un rótulo de valor a `LABEL_FONT_PX`, en px — CALIBRADO, no adivinado.
 * Medido con `getComputedTextLength()` en Chrome sobre `<text font-family="sans-serif"
 * font-size="11px">` (el mismo markup que emite Vega; el `textMetrics` server-side de Vega no sirve
 * de referencia porque sin `canvas` cae a una estimación de ~8,8 px/char, 40% sobre lo real):
 *
 *   `204K` → 25,70 px (6,43/char) · `88,9K` → 28,75 px (5,75/char) · `1.234.567` → 48,94 px (5,44/char)
 *
 * Se toma el MÁXIMO observado por carácter (6,5) porque el rótulo más ancho es el que decide la
 * colisión: sobrestimar degrada a `lanes` de más (legible), subestimar deja rótulos fundidos.
 */
const LABEL_CHAR_PX = 6.5

/** Aire mínimo entre dos rótulos vecinos para que se lean como dos (no basta con que no se toquen). */
const LABEL_GAP_PX = 2

/** Separación del rótulo respecto de la marca que rotula, en px (el `dy` del carril bajo). */
const LABEL_DY_PX = 4

/**
 * Altura de la MANCHA de tinta de un rótulo, en px — también CALIBRADA en Chrome, con
 * `measureText().actualBoundingBoxAscent + actualBoundingBoxDescent` a `11px sans-serif`:
 *
 *   `204K` → 8,10 · `88,9K` → 9,52 · `1.234.567` → 7,93 · `(otros)` → 10,26 (el paréntesis baja)
 *
 * Se toma 10,5 (sobre el máximo observado). Dos rótulos con las cajas cruzadas en x se leen como uno
 * solo si sus líneas base distan MENOS que esto; a partir de acá se leen como dos renglones.
 */
const LABEL_INK_H_PX = 10.5

/**
 * Cuánto sube el carril alto respecto del bajo, en px: `dy: -4` (bajo, el de siempre) vs
 * `dy: -(LABEL_DY_PX + LABEL_LANE_RISE_PX)`.
 *
 * Es DOS veces la altura de tinta, y ese factor 2 es lo que hace demostrable la anti-colisión. La
 * línea base de un rótulo es `techo de su barra + dy`, así que la alzada del carril se CANCELA cuando
 * la barra vecina es más baja justo en esa medida — con una alzada de 12 px, dos barras que difieren
 * ~12 px dejan sus rótulos a 0 px de distancia y fundidos. Con `alzada = 2 · tinta`: si el carril bajo
 * colisiona (diferencia de techos < tinta), el alto queda a `|Δ − alzada| > tinta`, o sea SIEMPRE
 * libre. Un carril de repuesto solo sirve si se demuestra que nunca queda igual de ocupado.
 */
const LABEL_LANE_RISE_PX = 2 * LABEL_INK_H_PX

/** Ancho estimado en px de un rótulo de valor ya formateado. */
export function labelWidthPx(text: string): number {
  return text.length * LABEL_CHAR_PX
}

/**
 * Modo de la capa de rótulos de un chart VERTICAL (#97):
 * - `single`: los rótulos caben uno al lado del otro — comportamiento histórico.
 * - `lanes`: no caben en un carril pero sí en dos, subiendo al de repuesto los que estorban.
 * - `none`: ni en dos carriles caben — el chart no rotula. La legibilidad manda: dos rótulos fundidos
 *   no informan menos que ninguno, informan MAL (se leen como un número que no existe).
 */
export type LabelMode = 'single' | 'lanes' | 'none'

/**
 * Decide el modo de rótulos a partir del rótulo MÁS ANCHO y del paso en px entre marcas vecinas.
 * Puro y testeable: es la única regla de anti-colisión, y no se declara por spec (decisión del motor).
 */
export function labelMode(labels: string[], stepPx: number): LabelMode {
  if (labels.length === 0) return 'single'
  const widest = Math.max(...labels.map(labelWidthPx)) + LABEL_GAP_PX
  if (widest <= stepPx) return 'single'
  if (widest <= stepPx * 2) return 'lanes'
  return 'none'
}

/**
 * Paso en px entre los CENTROS de dos marcas vecinas — el denominador de la anti-colisión. MEDIDO
 * sobre el SVG emitido (posiciones reales de los `<text>` de la capa de rótulos), no derivado del
 * álgebra de bandas de Vega:
 *
 * - Mono (1 serie): el paso es exactamente `ancho / nBarras` (medido en n = 2, 3, 6, 9, 12 → 160,00 ·
 *   106,67 · 53,33 · 35,56 · 26,67 px, idénticos a `320/n`).
 * - Agrupado (N series): las sub-barras de una categoría quedan MÁS juntas que el reparto uniforme
 *   porque el padding entre categorías se cobra aparte. Medido: 3×2 → 0,750 · 2×2 → 0,727 · 6×3 →
 *   0,774 · 9×2 → 0,783 · 12×2 → 0,787 del reparto uniforme. Se usa el mínimo observado (0,72), que
 *   es el caso peor.
 */
export function barStepPx(plotWidthPx: number, nBars: number, nSeries: number): number {
  const uniform = plotWidthPx / Math.max(1, nBars * Math.max(1, nSeries))
  return nSeries > 1 ? uniform * 0.72 : uniform
}

/**
 * Holgura del dominio que necesita el carril ALTO del modo `lanes` para no cortarse contra el techo
 * del lienzo. El pad se expresa como fracción del rango de datos, y una fracción `f` deja
 * `f/(1+f) · alto` px sobre la marca máxima: se despeja la `f` que garantiza los px de un rótulo del
 * carril alto (su separación de la marca, su alzada y su mancha de tinta).
 */
export function lanesPadFraction(plotHeightPx: number): number {
  const need = LABEL_DY_PX + LABEL_LANE_RISE_PX + LABEL_INK_H_PX
  if (plotHeightPx <= need * 2) return 1
  return Math.max(0.1, need / (plotHeightPx - need))
}

/**
 * Posición vertical (px desde el techo del área de plot) del techo de la marca de valor `v` — o sea,
 * dónde va la línea base de su rótulo antes de aplicar el `dy` del carril. La escala cuantitativa es
 * LINEAL y su dominio lo fijamos nosotros (`labelledDomain`), así que la posición es predecible
 * server-side con exactitud, y no hay que rendear para saber qué rótulos se van a estorbar.
 */
export function markTopPx(value: number, domain: [number, number], plotHeightPx: number): number {
  const [lo, hi] = domain
  if (hi === lo) return plotHeightPx
  return (plotHeightPx * (hi - value)) / (hi - lo)
}

/**
 * Reparte los rótulos entre los dos carriles del modo `lanes` (0 = bajo, 1 = alto), recorriendo las
 * marcas EN ORDEN DE IZQUIERDA A DERECHA con la posición de cada techo ya predicha.
 *
 * Solo hay que mirar al vecino INMEDIATO: en modo `lanes` el rótulo más ancho mide a lo más dos pasos
 * (`labelMode`), así que dos cajas separadas por dos pasos o más no pueden cruzarse en x. Regla: se
 * usa el carril bajo salvo que su línea base quede a menos de una mancha de tinta de la del vecino ya
 * colocado; en ese caso sube al alto, que por la elección de la alzada (2 × tinta) está garantizado
 * libre. Puro y testeable — la alternancia NO es por paridad del índice: la paridad ciega sube
 * rótulos que ya estaban separados y, peor, deja fundidos los pares cuyo desnivel de barras cancela
 * justo la alzada del carril.
 */
export function assignLanes(topsPx: number[]): number[] {
  const lanes: number[] = []
  let prevBaseline: number | undefined
  for (const top of topsPx) {
    const lane = prevBaseline !== undefined && Math.abs(top - prevBaseline) < LABEL_INK_H_PX ? 1 : 0
    lanes.push(lane)
    prevBaseline = top - lane * LABEL_LANE_RISE_PX
  }
  return lanes
}

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
 * `padFrac` sube esa holgura cuando el rótulo vive más arriba de lo normal (carril alto de #97).
 */
export function labelledDomain(values: number[], padFrac = 0.1): [number, number] | undefined {
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0) return undefined
  const lo = Math.min(0, ...finite)
  const hi = Math.max(0, ...finite)
  const span = hi - lo
  // Dato degenerado (todo cero): un dominio [0,0] no es escala válida.
  if (span === 0) return [lo, hi + 1]
  const pad = span * padFrac
  return [lo < 0 ? lo - pad : lo, hi + pad]
}

/**
 * Capas de rótulos (#80 · #97): mismo encoding posicional que las barras (se hereda del top-level),
 * texto pre-computado en los datos. El color sale del theme; la anti-colisión es decisión del motor y
 * NO se declara por spec.
 *
 * En horizontal el rótulo va al final de la barra y el paso vertical entre barras (≥22 px) siempre
 * alcanza: una sola capa. En vertical el modo lo decide `labelMode()`: `single` emite la misma capa
 * histórica; `lanes` emite DOS capas filtradas por el carril pre-computado (`__lane`, patrón #80: el
 * dato viaja resuelto y Vega solo pinta); `none` no emite ninguna.
 */
function labelLayers(horizontal: boolean, tokens: ThemeTokens, mode: LabelMode) {
  const encoding = { text: { field: LABEL_FIELD, type: 'nominal' as const } }
  if (horizontal) {
    return [
      {
        mark: {
          type: 'text',
          align: 'left',
          baseline: 'middle',
          dx: 4,
          fontSize: LABEL_FONT_PX,
          color: tokens.chartText,
        } as const,
        encoding,
      },
    ]
  }
  if (mode === 'none') return []
  const vertical = (dy: number) =>
    ({ type: 'text', align: 'center', baseline: 'bottom', dy, fontSize: LABEL_FONT_PX, color: tokens.chartText }) as const
  if (mode === 'single') return [{ mark: vertical(-LABEL_DY_PX), encoding }]
  return [0, 1].map((lane) => ({
    transform: [{ filter: `datum.${LABEL_LANE_FIELD} === ${lane}` }],
    mark: vertical(lane === 0 ? -LABEL_DY_PX : -(LABEL_DY_PX + LABEL_LANE_RISE_PX)),
    encoding,
  }))
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
  const texts = rows.map((r) => vtFormat(r[metric], fmt))
  const width = 320
  const height = Math.max(120, rows.length * 34)
  // Anti-colisión (#97): en vertical el paso horizontal por barra es `320 / nBarras`, y un rótulo de
  // 5 caracteres ya no cabe pasadas ~11 barras. En horizontal no hay colisión que resolver.
  const nums = rows.map((r) => Number(r[metric]))
  const wanted: LabelMode = horizontal ? 'single' : labelMode(texts, barStepPx(width, rows.length, 1))
  // El carril alto necesita más techo que el rótulo de siempre: se le da el pad que lo garantiza. El
  // dominio se fija ANTES de repartir carriles porque es lo que traduce valores a px.
  const domain = labelledDomain(nums, wanted === 'lanes' ? lanesPadFraction(height) : undefined)
  // Sin dominio (ningún valor finito) no hay px que predecir: el reparto de carriles no aplica.
  const mode: LabelMode = wanted === 'lanes' && !domain ? 'single' : wanted
  const lanes = mode === 'lanes' && domain ? assignLanes(nums.map((v) => markTopPx(v, domain, height))) : []
  const values = rows.map((r, i) =>
    mode === 'lanes'
      ? { ...r, [LABEL_FIELD]: texts[i], [LABEL_LANE_FIELD]: lanes[i], [TOOLTIP_FIELD]: `${String(r[dim] ?? '')} — ${texts[i]}` }
      : { ...r, [LABEL_FIELD]: texts[i], [TOOLTIP_FIELD]: `${String(r[dim] ?? '')} — ${texts[i]}` },
  )
  const quant = { field: metric, type: 'quantitative' as const, title: null, ...(domain ? { scale: { domain } } : {}) }
  // `sort: null` ⇒ manda el orden de las filas, ya resuelto por applyChartSort.
  const cat = { field: dim, type: 'nominal' as const, sort: null, title: null }
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    background: 'transparent',
    width,
    height,
    data: { values },
    encoding: horizontal ? { y: cat, x: quant } : { x: cat, y: quant },
    layer: [
      { mark: { type: 'bar', cornerRadiusEnd: 2, color: tokens.chartBar }, encoding: { description: { field: TOOLTIP_FIELD, type: 'nominal' as const } } },
      ...labelLayers(horizontal, tokens, mode),
    ],
    config: chartAxisConfig(tokens),
  }
  // El LRU cachea el SVG crudo (su clave ya incluye los tokens); la apertura a CSS vars es un paso
  // puro posterior, así que no contamina el caché ni lo invalida.
  const svg = svgTitlesDesdeAria(themeChartSvg(await cachedSvg(spec), vars))
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
  const colors = seriesColors(tokens, metrics.length)
  const nSeries = Math.max(1, metrics.length)
  const width = horizontal ? 360 : Math.max(320, rows.length * 26 * nSeries)
  // Barras agrupadas ocupan más: el alto (horizontal) escala con categorías × series, acotado.
  const height = horizontal ? Math.min(1200, Math.max(120, rows.length * 22 * nSeries)) : 260
  // Anti-colisión (#97): acá el paso lo marca la SUB-barra (categoría × serie), no la categoría, y el
  // orden de `nums` es CORRELATIVO de izquierda a derecha (categoría × serie) — el que pide `assignLanes`.
  const nums = rows.flatMap((r) => metrics.map((m) => Number(r[m.field]) || 0))
  const texts = nums.map((v) => vtFormat(v, fmt))
  const wanted: LabelMode = horizontal ? 'single' : labelMode(texts, barStepPx(width, rows.length, nSeries))
  const domain = labelledDomain(nums, wanted === 'lanes' ? lanesPadFraction(height) : undefined)
  const mode: LabelMode = wanted === 'lanes' && !domain ? 'single' : wanted
  const lanes = mode === 'lanes' && domain ? assignLanes(nums.map((v) => markTopPx(v, domain, height))) : []
  const values = rows.flatMap((r, ri) =>
    metrics.map((m, si) => {
      const k = ri * nSeries + si
      // #208 · el tooltip nombra la SERIE además de la categoría: en agrupado, saber «cuál barra»
      // es justo lo que el rótulo no alcanza a decir cuando se ocultan por colisión.
      const base = {
        [dim]: r[dim], serie: m.label, valor: nums[k], [LABEL_FIELD]: texts[k],
        [TOOLTIP_FIELD]: `${String(r[dim] ?? '')} · ${m.label} — ${texts[k]}`,
      }
      return mode === 'lanes' ? { ...base, [LABEL_LANE_FIELD]: lanes[k] } : base
    }),
  )
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
    width,
    height,
    data: { values },
    encoding: horizontal ? { y: cat, x: quant, yOffset: offset, color } : { x: cat, y: quant, xOffset: offset, color },
    // Un rótulo POR SUB-BARRA: la capa de texto hereda el encoding posicional y el offset de serie.
    layer: [
      { mark: { type: 'bar', cornerRadiusEnd: 2 }, encoding: { description: { field: TOOLTIP_FIELD, type: 'nominal' as const } } },
      ...labelLayers(horizontal, tokens, mode),
    ],
    config: chartAxisConfig(tokens),
  }
  // El LRU cachea el SVG crudo (su clave ya incluye los tokens); la apertura a CSS vars es un paso
  // puro posterior, así que no contamina el caché ni lo invalida.
  const svg = svgTitlesDesdeAria(themeChartSvg(await cachedSvg(spec), vars))
  return `<section class="chart">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''}${svg}${note}</section>`
}


/**
 * Cada cuántos puntos se rotula una línea (#94): 1 = todos. El paso horizontal entre puntos
 * (`plotWidthPx / nPoints`) se compara contra el rótulo MÁS ANCHO (misma calibración que las barras:
 * `labelWidthPx`); si no caben todos, se rotula cada k-ésimo con `k` mínimo tal que los rotulados
 * queden a ≥ un ancho de rótulo entre sí. El ÚLTIMO punto de cada serie se rotula siempre (es el
 * valor que el lector busca en una línea acumulada), salvo stride degenerado (k > nPoints: ni uno).
 */
export function seriesLabelStride(nPoints: number, texts: string[], plotWidthPx: number): number {
  if (nPoints <= 1) return 1
  const step = plotWidthPx / nPoints
  const widest = Math.max(...texts.map(labelWidthPx), 0) + LABEL_GAP_PX
  return Math.max(1, Math.ceil(widest / step))
}

/**
 * Qué puntos de una línea llevan rótulo. Parte del paso `stride` (cada k-ésimo, `seriesLabelStride`)
 * y AGREGA siempre el último, que es el valor que el lector busca en un acumulado. Ese agregado es el
 * que hay que cuidar: el último punto no cae en la grilla del paso, así que puede quedar a UN paso
 * del anterior rotulado —la mitad del aire que el paso garantiza— y fundirse con él. Cuando eso pasa
 * gana el último y se retira el vecino: es preferible perder un rótulo intermedio a publicar dos
 * ilegibles, y el retirado se lee igual en la tabla de detalle.
 */
export function seriesLabelIndices(nPoints: number, texts: string[], plotWidthPx: number): number[] {
  if (nPoints <= 0) return []
  const stride = seriesLabelStride(nPoints, texts, plotWidthPx)
  const step = plotWidthPx / nPoints
  const widest = Math.max(...texts.map(labelWidthPx), 0) + LABEL_GAP_PX
  const last = nPoints - 1
  const idx = new Set<number>()
  for (let i = 0; i < nPoints; i += stride) idx.add(i)
  idx.add(last)
  for (const i of [...idx]) if (i !== last && (last - i) * step < widest) idx.delete(i)
  return [...idx].sort((a, b) => a - b)
}

/**
 * Separación del rótulo de un punto de línea respecto de su punto, en px. Es mayor que la de las
 * barras (`LABEL_DY_PX`) porque el punto tiene radio y la línea lo cruza: el rótulo pegado quedaría
 * sobre el trazo.
 */
const SERIES_LABEL_DY_PX = LABEL_DY_PX + 3

/**
 * Cuánto baja cada carril inferior respecto del anterior, en px. Una mancha de tinta más su aire:
 * es lo que hace DEMOSTRABLE la separación entre dos rótulos consecutivos hacia abajo (ver
 * `seriesLanes`).
 */
const SERIES_LANE_DROP_PX = LABEL_INK_H_PX + LABEL_GAP_PX

/**
 * Reparte entre carriles los rótulos de las N series que caen sobre el MISMO punto del eje x
 * (#94 bis). Recibe la posición vertical predicha de cada punto (px desde el techo del plot, la que
 * da `markTopPx`) en el orden de las series, y devuelve el carril de cada una: `0` = el rótulo va
 * ARRIBA de su punto; `k ≥ 1` = va ABAJO, `k − 1` escalones más abajo.
 *
 * La regla es ordenar por posición y repartir de arriba hacia abajo: al punto MÁS ALTO se le pone el
 * rótulo encima y a todos los demás debajo, en el orden en que aparecen. Y esa ordenación es
 * justamente lo que vuelve demostrable la anti-colisión, porque hace no-negativas las diferencias:
 *
 * - carril 0 contra carril 1 — sus líneas base distan `(y₁ − y₀) + 2·dy`, y como `y₁ ≥ y₀` por el
 *   orden, la distancia es al menos `2·dy = 14 px > 10,5` de tinta: nunca se funden.
 * - carril k contra k+1 — distan `(y_{k+1} − y_k) + salto ≥ salto`, y el salto es tinta + aire.
 *
 * Es el mismo hallazgo que obligó a descartar la paridad en las barras (#97): un desplazamiento fijo
 * se CANCELA contra el desnivel de las marcas. Repartir por índice de serie —lo que hacía este chart
 * hasta ahora— es el peor caso de eso: con dos series manda el rótulo de la serie 0 hacia arriba y el
 * de la serie 1 hacia abajo *sin mirar cuál va por encima*, así que cuando la serie 1 es la de arriba
 * —el caso corriente de un acumulado «Base vs Actual», donde Actual supera a Base— los dos rótulos
 * caminan uno HACIA el otro y se funden en cuanto las curvas se acercan a menos de 35 px.
 */
export function seriesLanes(topsPx: number[]): number[] {
  const orden = topsPx.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i)
  const lanes = new Array<number>(topsPx.length).fill(0)
  orden.forEach((p, rank) => { lanes[p.i] = rank })
  return lanes
}

/**
 * `series` — líneas de N series sobre un eje. Vega-Lite con datos LARGOS pre-computados server-side
 * (una fila por punto y serie) + `color` por serie; el eje x es ORDINAL en el orden de llegada de las
 * filas (`sort: null` — el SQL manda, NO se re-ordena alfabético). Marca de línea con puntos, leyenda
 * abajo, paleta del theme. Mismo LRU.
 *
 * Rótulos de valor sobre los puntos (#94, contraparte de #80): texto pre-computado (`__label`, Vega
 * solo pinta), adelgazado por `seriesLabelStride` cuando los puntos no dan el ancho, y repartido en
 * carriles verticales por `seriesLanes` — al punto más alto de cada mes le va el rótulo encima y a
 * los de abajo debajo, en escalones — para que dos líneas cercanas (el caso Base vs Actual) no fundan
 * sus rótulos. La anti-colisión es decisión del motor y NO se declara por spec. El dominio Y gana
 * holgura arriba y abajo para que ningún rótulo se corte contra el borde del plot.
 */
export async function renderSeries(
  node: ResolvedNode,
  tokens: ThemeTokens,
  vars: Record<string, string> = {},
): Promise<string> {
  const rows = node.rows ?? []
  const x = node.xField ?? 'x'
  const series = node.seriesSpec ?? []
  const labels = series.map((s) => s.label)
  const fmt = labelFormat(node.format)
  // Datos LARGOS server-side (patrón del agrupado #80): una fila por (punto × serie), con el rótulo
  // ya formateado, su carril (paridad de la serie) y si se muestra (stride).
  const nums: number[] = []
  const texts: string[] = []
  for (const r of rows) for (const s of series) { const v = Number(r[s.field]); nums.push(v); texts.push(Number.isFinite(v) ? vtFormat(v, fmt) : '') }
  const shown = new Set(seriesLabelIndices(rows.length, texts, 640))
  const colors = seriesColors(tokens, Math.max(1, series.length))
  const domain = labelledDomain(nums, 0.12)
  const values: Record<string, unknown>[] = []
  rows.forEach((r, i) => {
    // El carril NO sale del índice de la serie: sale de qué punto va por encima de cuál en ESTE mes
    // (`seriesLanes`). Sin dominio no hay posición predecible → se conserva el reparto por índice.
    const tops = series.map((s) => (domain ? markTopPx(Number(r[s.field]), domain, 240) : 0))
    const lanes = domain ? seriesLanes(tops) : series.map((_, si) => si)
    series.forEach((s, si) => {
      const v = Number(r[s.field])
      values.push({
        [x]: r[x],
        serie: s.label,
        valor: v,
        [LABEL_FIELD]: Number.isFinite(v) ? vtFormat(v, fmt) : '',
        // #208 · en una curva el rótulo se muestra SOLO en los puntos que `shown` deja pasar
        // (`__show`), así que la mayoría de los puntos no dice su valor por ningún otro medio: acá
        // el tooltip no es comodidad, es la única lectura del punto.
        [TOOLTIP_FIELD]: `${String(r[x] ?? '')} · ${s.label} — ${Number.isFinite(v) ? vtFormat(v, fmt) : 's/d'}`,
        [LABEL_LANE_FIELD]: lanes[si],
        __show: shown.has(i) ? 1 : 0,
      })
    })
  })
  const pointLabel = (lane: number) => ({
    transform: [{ filter: `datum.__show === 1 && datum.${LABEL_LANE_FIELD} === ${lane}` }],
    mark: {
      type: 'text',
      align: 'center',
      baseline: lane === 0 ? 'bottom' : 'top',
      dy: lane === 0 ? -SERIES_LABEL_DY_PX : SERIES_LABEL_DY_PX + (lane - 1) * SERIES_LANE_DROP_PX,
      fontSize: LABEL_FONT_PX,
      color: tokens.chartText,
    } as const,
    encoding: { text: { field: LABEL_FIELD, type: 'nominal' as const } },
  })
  const labelLayersSeries = Array.from({ length: Math.max(1, series.length) }, (_, k) => pointLabel(k))
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    background: 'transparent',
    width: 640,
    height: 240,
    data: { values },
    layer: [
      { mark: { type: 'line', point: true }, encoding: { description: { field: TOOLTIP_FIELD, type: 'nominal' as const } } },
      ...labelLayersSeries,
    ],
    encoding: {
      // `sort: null` → orden de llegada de las filas (el SQL ordena/agrega el eje).
      x: { field: x, type: 'ordinal', sort: null, title: null },
      y: { field: 'valor', type: 'quantitative', title: null, ...(domain ? { scale: { domain, zero: false } } : {}) },
      color: { field: 'serie', type: 'nominal', scale: { domain: labels, range: colors }, legend: chartLegendConfig() },
    },
    config: chartAxisConfig(tokens),
  }
  // El LRU cachea el SVG crudo (su clave ya incluye los tokens); la apertura a CSS vars es un paso
  // puro posterior, así que no contamina el caché ni lo invalida.
  const svg = svgTitlesDesdeAria(themeChartSvg(await cachedSvg(spec), vars))
  return `<section class="chart">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''}${svg}</section>`
}

/**
 * E/S del render de gráficos: NINGUNA. Dos capas, y son dos porque fallan distinto.
 *
 * El vector: Vega sabe cargar datos por sí mismo (`data.url`) — por red o por `file://`— usando su
 * *loader*. Los specs de Vergis traen los datos YA resueltos por la capability, así que ese camino
 * no debería usarse jamás; que exista y esté abierto es lo que lo vuelve superficie de ataque.
 *
 * · **Capa 1 — el gate declarativo (`assertNoRemoteData`)**: un spec con `url` se RECHAZA antes de
 *   llegar a Vega. Falla fuerte y nombra el sitio. Es la capa que importa para el operador, porque
 *   un spec así es un error de autoría o una inyección, y en los dos casos hay que enterarse.
 * · **Capa 2 — el loader que niega**: por si algún camino de Vega no pasara por el gate. Es la red
 *   de seguridad, no la defensa principal.
 *
 * POR QUÉ LAS DOS Y NO SOLO EL LOADER — medido, no supuesto (2026-08-13, control con servidor HTTP
 * local contando hits): con el loader por defecto el fetch OCURRE (`hits=1`); con el loader que
 * niega **no ocurre** (`hits=0`) pero Vega **se traga el error y rinde un gráfico vacío**, sin
 * excepción. O sea el loader solo protege en silencio, y un PI degradado calladamente es
 * exactamente lo que esta plataforma trata como defecto en todas las demás capas.
 */
function assertNoRemoteData(node: unknown, path = 'spec'): void {
  if (Array.isArray(node)) return node.forEach((n, i) => assertNoRemoteData(n, `${path}[${i}]`))
  if (!node || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'url' && typeof v === 'string') {
      throw new Error(
        `Gráfico rechazado: el spec pide cargar datos externos en '${path}.url'. El render no hace E/S — ` +
          'los datos los resuelve la capability y viajan en el spec.',
      )
    }
    assertNoRemoteData(v, `${path}.${k}`)
  }
}

/** Loader que niega toda E/S. Capa 2: red de seguridad del gate declarativo, no su reemplazo. */
const DENY_IO_LOADER = {
  load: async (uri: string): Promise<string> => {
    throw new Error(`E/S denegada en el render de gráficos: ${uri}`)
  },
  sanitize: async (uri: string): Promise<{ href: string }> => {
    throw new Error(`E/S denegada en el render de gráficos: ${uri}`)
  },
  http: async (): Promise<string> => {
    throw new Error('E/S denegada en el render de gráficos (http)')
  },
  file: async (): Promise<string> => {
    throw new Error('E/S denegada en el render de gráficos (file)')
  },
}

export async function vegaLiteToSvg(spec: TopLevelSpec): Promise<string> {
  assertNoRemoteData(spec)
  const vgSpec = compile(spec).spec
  // El compilado también se revisa: `compile()` es de vega-lite y puede materializar `url` propios
  // (p. ej. de un `lookup`). Revisar solo la entrada sería confiar en un tercero para un gate.
  assertNoRemoteData(vgSpec, 'spec(compilado)')
  const view = new vega.View(vega.parse(vgSpec as vega.Spec), {
    renderer: 'none',
    loader: DENY_IO_LOADER as unknown as vega.Loader,
  })
  await view.runAsync()
  const svg = await view.toSVG()
  view.finalize()
  return svg
}
