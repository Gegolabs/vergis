// Controles de cabecera (server-side) — extraído de mira.ts (NEXT · Ola 3·B).
// Resuelve el valor vigente de cada control (max/min/first o el seleccionado) y sustituye `:ctx.<param>`
// en el SQL por PARÁMETROS BIND (injection-safe: la capability los bindea, nunca concatena valores).
import type { CtxValues } from './mira-types'

/**
 * Sustituye `:ctx.<param>` en `params.sql` por PARÁMETRO(S) BIND y adjunta su(s) valor(es) en
 * `params.params` (la Capability los bindea — nunca concatena → injection-safe).
 *  - Valor único → `@ctx_<param>` (comportamiento clásico).
 *  - Valor MÚLTIPLE (control multi-select) → `@ctx_<param>_0, @ctx_<param>_1, …` — CONTRATO: con
 *    multi-valor el placeholder DEBE vivir dentro de paréntesis de IN en el spec
 *    (`WHERE semana IN (:ctx.semana)`); Mira solo expande la lista de binds, jamás interpola valores.
 * Si no hay `:ctx.` o no hay sql, devuelve los params intactos. Un param sin valor en `ctxValues`
 * se bindea como `''` (acota igual) y se reporta en `missing` para que el llamador lo loguee.
 */
export function applyCtx(params: Record<string, unknown> | undefined, ctxValues: CtxValues, missing?: string[]): Record<string, unknown> | undefined {
  if (!params || typeof params['sql'] !== 'string') return params
  const sql = params['sql'] as string
  if (!sql.includes(':ctx.')) return params
  const bound: Record<string, string> = {}
  const rewritten = sql.replace(/:ctx\.([a-zA-Z0-9_]+)/g, (_m, param: string) => {
    const v = ctxValues[param]
    if (v === undefined && missing && !missing.includes(param)) missing.push(param)
    if (Array.isArray(v)) {
      return v
        .map((val, i) => {
          bound[`ctx_${param}_${i}`] = val
          return `@ctx_${param}_${i}`
        })
        .join(', ')
    }
    bound[`ctx_${param}`] = v ?? ''
    return `@ctx_${param}`
  })
  return { ...params, sql: rewritten, params: { ...((params['params'] as Record<string, unknown>) ?? {}), ...bound } }
}

/** `data.<dataset>.<field>` (source de un control) → [dataset, field]. */
export function stripCtrlSource(source: string): [string, string] {
  const ref = typeof source === 'string' && source.startsWith('data.') ? source.slice('data.'.length) : String(source ?? '')
  const [ds, field] = ref.split('.')
  return [ds ?? '', field ?? '']
}

/** Compara valores de opción: numérico si ambos parsean, si no orden natural (numeric-aware). */
function cmpVals(a: string, b: string): number {
  const an = Number(a)
  const bn = Number(b)
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn
  return a.localeCompare(b, undefined, { numeric: true })
}

/**
 * Valor de un control: si `current` (de la URL) es una opción válida, gana; si no, el default sobre
 * las opciones (`max` = mayor/más reciente, `min` = menor, `first` = primera de aparición). Sin
 * opciones, respeta lo pedido; sin nada, cadena vacía.
 */
export function resolveControlValue(current: string | undefined, options: string[], def?: 'max' | 'min' | 'first'): string {
  if (current != null && current !== '' && (options.length === 0 || options.includes(current))) return current
  if (options.length === 0) return ''
  if (def === 'first') return options[0]
  const sorted = [...options].sort(cmpVals)
  return def === 'min' ? sorted[0] : sorted[sorted.length - 1]
}

/**
 * Valores de un control MULTI-SELECT: los de la URL se filtran contra las opciones (solo valores del
 * catálogo — injection/typo-safe); si no queda ninguno válido, aplica el default (un solo valor,
 * la misma semántica que el control single).
 */
export function resolveControlValues(
  current: string | string[] | undefined,
  options: string[],
  def?: 'max' | 'min' | 'first',
): string[] {
  const asked = (current == null ? [] : Array.isArray(current) ? current : [current]).filter((v) => v !== '')
  const valid = options.length === 0 ? asked : asked.filter((v) => options.includes(v))
  if (valid.length > 0) return [...new Set(valid)]
  const fallback = resolveControlValue(undefined, options, def)
  return fallback === '' ? [] : [fallback]
}

/** Pieza-guía cuando se entra a una vista de detalle sin el contexto requerido (no por drill). */
