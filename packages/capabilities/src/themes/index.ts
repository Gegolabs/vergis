/**
 * Themes pluggables para render-html-piece. El render emite HTML semántico
 * (clases por tipo de elemento); el theme aporta CSS + cromo (header, logo, paleta)
 * y los tokens de color para los charts. Cambiar de theme = otro look, mismo contenido.
 */

import type { AsOfMeta } from './as-of'

export interface ThemeTokens {
  /** Color de las barras de los charts (Vega). */
  chartBar: string
  /** Color del texto de ejes/labels de los charts. */
  chartText: string
  /** Color de grilla/ejes suaves (opcional). */
  chartAxis?: string
  /** Paleta categórica para charts multi-serie (líneas de `series`, barras agrupadas de
   *  `distribution` multi-métrica). Se cicla si hay más series que colores. Fallback en render-chart. */
  chartSeries?: string[]
}

export interface DashboardMeta {
  /** Corte as-of del dato (issue #108): la convención de plataforma del header. Ver `./as-of`. */
  asOf?: AsOfMeta
  /** Organización dueña del dato — se muestra en el footer. */
  org?: string
  /** Clasificación de sensibilidad (public · internal · confidential · regulated). */
  classification?: string
  /** Código del reporte (se muestra discreto en el pie). */
  code?: string
  /** Versión del PI (instancia/spec) — distinta de la versión de Mira (motor). Se muestra en el inspector. */
  version?: string
  subtitle?: string
}

/** Variante de apariencia (paleta) conmutable client-side dentro de un theme. */
export interface Palette {
  id: string
  label: string
}

export interface Theme {
  name: string
  tokens: ThemeTokens
  /**
   * Tokens de chart POR PALETA. Los colores del chart se hornean en el SVG server-side, así que un
   * theme con paletas conmutables necesita un juego calibrado por cada una: los tonos que contrastan
   * sobre fondo oscuro se lavan sobre fondo blanco. La paleta activa se resuelve con
   * `resolveChartTokens`; una paleta sin entrada cae a `tokens`.
   */
  chartTokensByPalette?: Record<string, ThemeTokens>
  /** Paletas que el theme ofrece para conmutar en vivo (selector de apariencia en la bandeja). */
  palettes?: Palette[]
  /**
   * Paleta de PAPEL (issue #65 · D6): en modo print MANDA sobre la paleta activa. Los colores del
   * chart se hornean en el SVG server-side, así que un documento renderizado en una paleta oscura
   * produce charts con texto claro que se lava sobre blanco — el `@media print` repinta fondo y texto
   * pero no los hex ya horneados. Un theme sin `printPalette` cae a la paleta activa (si sus tokens
   * son únicos, como en `default`, no hay nada que corregir).
   */
  printPalette?: string
  /** Envuelve el body semántico en el documento HTML completo (head, css, cromo).
   *  `controls` (opcional) es el disparador de interacción (Faceta), ubicado en el header.
   *  `palette` (opcional) fija la paleta inicial del theme (default-theme por tipo de PI). */
  wrap(args: { title: string; body: string; meta?: DashboardMeta; controls?: string; palette?: string }): string
}

import { defaultTheme } from './default'
import { arbolTheme } from './arbol'

const THEMES: Record<string, Theme> = {
  default: defaultTheme,
  arbol: arbolTheme,
}

export function getTheme(name?: string): Theme {
  return (name && THEMES[name]) || defaultTheme
}

export function registerTheme(theme: Theme): void {
  THEMES[theme.name] = theme
}

/** Tokens de chart de la paleta ACTIVA (server-side): los del theme si la paleta no declara los suyos. */
export function resolveChartTokens(theme: Theme, palette?: string): ThemeTokens {
  return (palette && theme.chartTokensByPalette?.[palette]) || theme.tokens
}

/**
 * Nombres de las CSS custom properties de chart, por rol. El post-proceso del SVG reemplaza cada
 * color horneado por `var(--chart-<rol>, #hex)`, y cada paleta del theme declara sus `--chart-*`:
 * así el selector de Apariencia re-colorea también los gráficos, sin re-compilar Vega en el browser.
 */
export const CHART_VAR_BAR = '--chart-bar'
export const CHART_VAR_TEXT = '--chart-text'
export const CHART_VAR_AXIS = '--chart-axis'
export const chartVarSeries = (i: number): string => `--chart-s${i + 1}`

/**
 * Mapa `hex en minúsculas → nombre de la CSS var` para los tokens de un juego.
 *
 * Un mismo hex puede servir a dos roles (en `arbol`, `chartBar` ES la primera serie): gana el
 * PRIMERO en el orden barra → texto → eje → series. La ambigüedad es inofensiva porque los roles que
 * comparten hex lo comparten por diseño del theme, y cada paleta define ambas vars al mismo valor.
 */
export function chartVarMap(tokens: ThemeTokens): Record<string, string> {
  const map: Record<string, string> = {}
  const put = (hex: string | undefined, name: string): void => {
    if (!hex) return
    const k = hex.toLowerCase()
    if (!(k in map)) map[k] = name
  }
  put(tokens.chartBar, CHART_VAR_BAR)
  put(tokens.chartText, CHART_VAR_TEXT)
  put(tokens.chartAxis, CHART_VAR_AXIS)
  ;(tokens.chartSeries ?? []).forEach((c, i) => put(c, chartVarSeries(i)))
  return map
}

/**
 * Bloque de declaraciones `--chart-*: <hex>;` de un juego de tokens, para inyectar en el CSS de una
 * paleta. Se declaran TODAS las vars (incluidas las que comparten hex), para que el fallback del
 * `var()` nunca sea el que manda.
 */
export function chartVarDeclarations(tokens: ThemeTokens): string {
  const out = [`${CHART_VAR_BAR}: ${tokens.chartBar};`, `${CHART_VAR_TEXT}: ${tokens.chartText};`]
  if (tokens.chartAxis) out.push(`${CHART_VAR_AXIS}: ${tokens.chartAxis};`)
  ;(tokens.chartSeries ?? []).forEach((c, i) => out.push(`${chartVarSeries(i)}: ${c};`))
  return out.join(' ')
}

export { defaultTheme } from './default'
export { arbolTheme } from './arbol'
export { asOfBlock, asOfTooltip, formatCutoff, formatDate, formatDateTime } from './as-of'
export type { AsOfMeta } from './as-of'
