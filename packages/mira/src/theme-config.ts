/**
 * Configuración de THEME a nivel de plataforma — default por TIPO de PI (reporte vs dashboard).
 *
 * Es la primera config que gestionará el "espacio de administración" de la plataforma. Hoy su
 * backing es env (`VERGIS_THEME_REPORT` / `VERGIS_THEME_DASHBOARD`, formato `theme[@paleta]`);
 * mañana el admin escribirá estos valores en un store y este módulo lo leerá de ahí. La costura
 * (resolver por tipo) no cambia.
 *
 * Precedencia: el theme explícito del spec (`delivery.render.theme`) gana; si falta, el default
 * de plataforma para el tipo; la PALETA siempre viene del default de plataforma (los specs aún no
 * la declaran). Default de Producto: paleta `blanco` (fondo claro) para AMBOS tipos — reportes y
 * dashboards (#78).
 */

export type PiKind = 'report' | 'dashboard'

export interface ThemeChoice {
  theme?: string
  palette?: string
}

function parseSpec(spec: string | undefined): ThemeChoice {
  if (!spec) return {}
  const [theme, palette] = spec.split('@')
  return { theme: theme || undefined, palette: palette || undefined }
}

/** Default de plataforma para un tipo de PI (env override + default de Producto). */
export function platformThemeDefault(kind: PiKind): ThemeChoice {
  const env = kind === 'report' ? process.env['VERGIS_THEME_REPORT'] : process.env['VERGIS_THEME_DASHBOARD']
  const parsed = parseSpec(env)
  // Fondo BLANCO para ambos tipos (#78): los reportes ya nacían así; los dashboards se suman, porque
  // la convención pedida es pareja para todos los PIs. `VERGIS_THEME_DASHBOARD` sigue pudiendo fijar
  // otra combinación por instancia (`theme@paleta`).
  return { theme: parsed.theme, palette: parsed.palette ?? 'blanco' }
}

/** Tipos de elemento que delatan un dashboard (vs un reporte tabular). */
const DASHBOARD_TYPES = new Set(['kpi', 'semaforo', 'distribution', 'chart'])

/** Clasifica una pieza compuesta: reporte (tabla-dominante) vs dashboard. */
export function classifyPiece(node: { type?: string; elements?: unknown[] } | undefined): PiKind {
  let hasTable = false
  let hasDashboardEl = false
  const walk = (n: { type?: string; elements?: unknown[] } | undefined): void => {
    if (!n) return
    if (n.type === 'table') hasTable = true
    if (n.type && DASHBOARD_TYPES.has(n.type)) hasDashboardEl = true
    for (const c of n.elements ?? []) walk(c as { type?: string; elements?: unknown[] })
  }
  walk(node)
  return hasTable && !hasDashboardEl ? 'report' : 'dashboard'
}

/** Resuelve theme + paleta para una pieza, combinando el theme del spec con el default de plataforma. */
export function resolveTheme(
  node: { type?: string; elements?: unknown[] } | undefined,
  specTheme: string | undefined,
): ThemeChoice {
  const kind = classifyPiece(node)
  const def = platformThemeDefault(kind)
  return { theme: specTheme ?? def.theme, palette: def.palette }
}
