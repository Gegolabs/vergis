/**
 * Themes pluggables para render-html-piece. El render emite HTML semántico
 * (clases por tipo de elemento); el theme aporta CSS + cromo (header, logo, paleta)
 * y los tokens de color para los charts. Cambiar de theme = otro look, mismo contenido.
 */

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
  /** Fecha/timestamp del dato (watermark) — se muestra como "Datos al ...". */
  date?: string | Date
  /** Momento de generación del artefacto — se muestra como "Generado ...". */
  generatedAt?: string | Date
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
  /** Paletas que el theme ofrece para conmutar en vivo (selector de apariencia en la bandeja). */
  palettes?: Palette[]
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

export { defaultTheme } from './default'
export { arbolTheme } from './arbol'
