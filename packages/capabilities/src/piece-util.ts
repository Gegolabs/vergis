// Helpers PUROS compartidos del render de piezas — extraídos de render-html-piece.ts (NEXT · Ola 3·B).
// Neutrales: los usan tanto render-html-piece (nav/kpi/semáforo) como render-table, sin ciclo de imports.
import type { CarryCtx } from './piece-types'
import { vtFormat } from './table-runtime'

/** `&ctx.k=v` por cada par de `carry` (más overrides), para preservar contexto en cualquier href
 *  (nav de páginas, drills, selectores). Un valor multi (control multi-select) emite un par por valor. */
export function ctxQuery(carry: CarryCtx, overrides: Record<string, string> = {}): string {
  const merged: CarryCtx = { ...carry, ...overrides }
  let q = ''
  for (const [k, v] of Object.entries(merged)) {
    for (const val of Array.isArray(v) ? v : [v]) {
      if (val == null || val === '') continue
      q += `&ctx.${encodeURIComponent(k)}=${encodeURIComponent(String(val))}`
    }
  }
  return q
}

/** Formatea un valor para display (delega en el formateador único del runtime de tabla). */
export function formatValue(value: unknown, format?: string): string {
  return vtFormat(value, format)
}
