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
 * las opciones (`max` = mayor/más reciente, `min` = menor, `first` = primera de aparición — y
 * cualquier OTRO string es un LITERAL, #92: si es una de las opciones resueltas, gana; si no está en
 * el dominio al momento del render, cae al comportamiento sin default — fail-safe, no fail-closed,
 * porque el dominio lo produce el SQL y puede moverse bajo un spec quieto). Los keywords conservan su
 * semántica aunque el dominio contenga un valor homónimo. Sin opciones, respeta lo pedido; sin nada,
 * cadena vacía.
 */
export function resolveControlValue(current: string | undefined, options: string[], def?: string): string {
  if (current != null && current !== '' && (options.length === 0 || options.includes(current))) return current
  if (options.length === 0) return ''
  if (def === 'first') return options[0]
  if (def != null && def !== 'max' && def !== 'min') {
    // Literal (#92): validado contra las opciones RESUELTAS; fuera del dominio → default de siempre.
    if (options.includes(def)) return def
  }
  const sorted = [...options].sort(cmpVals)
  return def === 'min' ? sorted[0] : sorted[sorted.length - 1]
}

/**
 * Recorta una etiqueta datetime a solo su fecha (`YYYY-MM-DD`). Regla GENERAL de presentación (no
 * per-spec): el sello muestra la fecha, no la hora. Dos formas de datetime llegan hasta aquí:
 *  - un STRING ISO (`YYYY-MM-DDThh:mm…`) — p. ej. de un mock o de un driver que serializa;
 *  - un OBJETO `Date` de JS — el driver mssql/tedious devuelve las columnas datetime así, y
 *    `String(dateObj)` produce la forma larga («Tue May 26 2026 00:00:00 GMT+0000 …») que esquivaba
 *    el recorte (bug visto en PI-07 vivo) → se toma la fecha UTC de `toISOString()`.
 * Cualquier otro valor pasa intacto.
 */
export function trimIsoLabel(v: string | Date): string {
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? String(v) : v.toISOString().slice(0, 10)
  }
  const m = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/.exec(v)
  return m ? m[1] : v
}

/** Opción de un control: `value` es la llave que se escribe en `ctx.<param>`, `label` lo que se ve. */
export interface ControlOption {
  value: string
  label: string
}

/**
 * Construye los pares {value,label} de un control desde las filas del dataset fuente:
 *  - `value` = campo de `source` (la LLAVE que se fija en `ctx.<param>`),
 *  - `label` = campo de `display` (recortado si es ISO-datetime); si el display viene vacío/null,
 *    cae al propio value (nunca una etiqueta en blanco).
 * Dedup por value (1ª aparición gana), orden numeric-aware por value. Si dos values DISTINTOS producen
 * la MISMA etiqueta (dos OCs con igual fecha), ambas se desambiguan con « label (value) » — es la
 * limitación declarada de (i) llaves-alternativas y el disparador natural de (ii) cascada `narrows:`.
 */
export function buildControlOptions(
  rows: Record<string, unknown>[],
  valueField: string,
  displayField: string,
): ControlOption[] {
  const seen = new Set<string>()
  const pairs: ControlOption[] = []
  for (const r of rows) {
    const value = String(r[valueField] ?? '')
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    const raw = r[displayField]
    // El Date del driver se pasa TAL CUAL a trimIsoLabel (String(dateObj) daría la forma larga).
    const label = raw == null || raw === '' ? trimIsoLabel(value) : trimIsoLabel(raw instanceof Date ? raw : String(raw))
    pairs.push({ value, label })
  }
  pairs.sort((a, b) => cmpVals(a.value, b.value))
  const labelCount = new Map<string, number>()
  for (const p of pairs) labelCount.set(p.label, (labelCount.get(p.label) ?? 0) + 1)
  for (const p of pairs) if ((labelCount.get(p.label) ?? 0) > 1) p.label = `${p.label} (${p.value})`
  return pairs
}

/** La etiqueta del `value` vigente dentro de un juego de pares (para el print/summary del sello). */
export function labelForValue(pairs: ControlOption[], value: string): string {
  return pairs.find((p) => p.value === value)?.label ?? value
}

/**
 * Valores de un control MULTI-SELECT: los de la URL se filtran contra las opciones (solo valores del
 * catálogo — injection/typo-safe); si no queda ninguno válido, aplica el default (un solo valor,
 * la misma semántica que el control single).
 */
export function resolveControlValues(
  current: string | string[] | undefined,
  options: string[],
  def?: string,
): string[] {
  const asked = (current == null ? [] : Array.isArray(current) ? current : [current]).filter((v) => v !== '')
  const valid = options.length === 0 ? asked : asked.filter((v) => options.includes(v))
  if (valid.length > 0) return [...new Set(valid)]
  const fallback = resolveControlValue(undefined, options, def)
  return fallback === '' ? [] : [fallback]
}

/** Pieza-guía cuando se entra a una vista de detalle sin el contexto requerido (no por drill). */
