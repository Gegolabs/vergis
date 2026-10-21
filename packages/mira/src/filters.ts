/**
 * FILTROS DE BANDEJA server-side (#82) — sustracción opcional que re-ancla TODO el documento.
 *
 * La distinción que gobierna el diseño, y que hay que no perder de vista:
 *
 * - Un **control** (`controls`, `:ctx.*`) es **alcance**: siempre tiene valor, siempre acota, y su
 *   superficie es el sello de la banda de contexto.
 * - Un **filtro** (`filters`, `:flt.*`) es **sustracción opcional**: su default es *sin efecto* —
 *   documento completo—, su control vive en la bandeja y su estado activo se muestra como chip.
 *
 * Por qué un placeholder NUEVO y no reutilizar `:ctx.` «expandido a todas las opciones cuando no hay
 * selección»: eso rompería tres cosas a la vez — la semántica de NULL (las filas con el campo nulo
 * desaparecerían sin que nadie filtrara), el tope de parámetros de TDS (~2100 binds con catálogos
 * grandes) y la nitidez del contrato «ausencia = sin efecto».
 *
 * AUTORIZACIÓN: el filtro es sustractivo POR CONSTRUCCIÓN. Compone dentro de queries que ya corren
 * bajo la RLS data-anchored, y sus opciones salen del catálogo, que también corrió bajo RLS. Una
 * selección fuera del catálogo se DESCARTA (no se bindea): jamás puede producir filas adicionales.
 * Los valores del usuario viajan SIEMPRE como binds, nunca interpolados en el SQL.
 */
import { VergisError } from '@vergis/botler'
import { trimIsoLabel } from './controls'
import type { MiraFilter } from './dsl/validate'

/** Tope de valores seleccionables en un filtro — guard contra una URL que infle los binds. */
export const FILTER_MAX_VALUES = 100

/** Selección cruda por filtro, tal como llega de la URL (`flt.<id>=v`, repetible). */
export type FltValues = Record<string, string | string[]>

/**
 * Opción de un filtro (#420): `value` es lo que se bindea en `:flt.<id>` y viaja en la URL; `label`
 * es solo presentación. Sin `display` declarado, `label === value`.
 */
export interface FilterOption {
  value: string
  label: string
}

/** Un filtro ya resuelto: opciones (cascadeadas) + selección (saneada contra ellas). */
export interface FilterResolved {
  id: string
  label: string
  multi: boolean
  /** Opciones vigentes, ya condicionadas por la selección del padre si el filtro depende de otro. */
  options: FilterOption[]
  /** Selección efectiva: solo `value`s presentes en `options` (typo/injection-safe). */
  selected: string[]
}

/**
 * Normaliza la selección cruda de la URL (`flt.<id>=v`, repetible) a un mapa id→valores.
 * Mismo transporte y mismo criterio que `normalizeCtx`: `Object.create(null)` para que un `__proto__`
 * multi-valor sea una clave normal y no corrompa el prototipo del mapa.
 */
export function normalizeFlt(raw: unknown): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const list = (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '').map(String)
    if (list.length > 0) out[k] = [...new Set(list)]
  }
  return out
}

/** `data.<dataset>.<field>` → [dataset, field]. */
export function stripFilterSource(source: string): [string, string] {
  const ref = typeof source === 'string' && source.startsWith('data.') ? source.slice('data.'.length) : String(source ?? '')
  const [ds, field] = ref.split('.')
  return [ds ?? '', field ?? '']
}

/** Columna SQL que el filtro predica: la declarada, o el campo de su `source`. */
export function filterColumn(f: MiraFilter): string {
  return f.column && f.column !== '' ? f.column : stripFilterSource(f.source)[1]
}

/** Cadena de ancestros de un filtro (del más lejano al padre directo), por `depends_on`. */
function ancestors(f: MiraFilter, byId: Map<string, MiraFilter>): MiraFilter[] {
  const chain: MiraFilter[] = []
  let cur = f.depends_on ? byId.get(f.depends_on) : undefined
  while (cur) {
    chain.unshift(cur)
    cur = cur.depends_on ? byId.get(cur.depends_on) : undefined
  }
  return chain
}

/**
 * Pares {value,label} del filtro (#420). El ORDEN y el dedup son los de siempre (por `value`, numeric-
 * aware), así que sin `display` el resultado es exactamente el de antes con `label = value` — sin
 * recorte ISO ni desambiguación, que solo existen cuando hay un rótulo que pueda diferir del valor.
 * Con `display`, las MISMAS reglas que `buildControlOptions`: la 1ª aparición del valor fija el
 * rótulo, un rótulo vacío/null cae al valor, el ISO-datetime se recorta, y dos valores distintos con
 * el mismo rótulo se desambiguan con « rótulo (valor) ».
 */
function filterOptions(rows: Record<string, unknown>[], field: string, displayField: string | undefined): FilterOption[] {
  const values = distinctSorted(rows, field)
  if (!displayField) return values.map((v) => ({ value: v, label: v }))
  const firstLabel = new Map<string, string>()
  for (const r of rows) {
    const v = r[field]
    if (v == null || v === '') continue
    const value = String(v)
    if (firstLabel.has(value)) continue
    const raw = r[displayField]
    firstLabel.set(value, raw == null || raw === '' ? trimIsoLabel(value) : trimIsoLabel(raw instanceof Date ? raw : String(raw)))
  }
  const pairs = values.map((value) => ({ value, label: firstLabel.get(value) ?? value }))
  const labelCount = new Map<string, number>()
  for (const p of pairs) labelCount.set(p.label, (labelCount.get(p.label) ?? 0) + 1)
  for (const p of pairs) if ((labelCount.get(p.label) ?? 0) > 1) p.label = `${p.label} (${p.value})`
  return pairs
}

/** Valores distintos de un campo sobre unas filas, sin vacíos, en orden natural (numeric-aware). */
function distinctSorted(rows: Record<string, unknown>[], field: string): string[] {
  const seen = new Set<string>()
  for (const r of rows) {
    const v = r[field]
    if (v == null || v === '') continue
    seen.add(String(v))
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))
}

/**
 * Resuelve los filtros declarados contra sus catálogos y la selección de la URL.
 *
 * La CASCADA es in-memory sobre el catálogo: las opciones de un filtro dependiente son los valores
 * distintos de su campo sobre las filas donde el campo del padre está en la selección del padre. Como
 * el catálogo ya corrió bajo la RLS, la cascada es post-RLS por construcción.
 *
 * SANEO: la selección se intersecta con las opciones vigentes. Eso resuelve de una sola vez dos
 * casos: un valor inventado en la URL (typo o intento de inyección) y una selección que quedó
 * HUÉRFANA porque cambió la del padre — el hijo simplemente se limpia.
 */
export function resolveFilters(
  filters: MiraFilter[],
  catalogs: Record<string, Record<string, unknown>[]>,
  requested: Record<string, string[]>,
): FilterResolved[] {
  const byId = new Map(filters.map((f) => [f.id, f]))
  const selections = new Map<string, string[]>()
  const out: FilterResolved[] = []
  for (const f of filters) {
    const [dsName, field] = stripFilterSource(f.source)
    let rows = catalogs[dsName] ?? []
    // Cascada: acotar el catálogo por la selección de CADA ancestro (cadena simple, sin ciclos —
    // lo garantiza la validación). Un ancestro sin selección no acota (ausencia = sin efecto).
    for (const a of ancestors(f, byId)) {
      const sel = selections.get(a.id) ?? []
      if (sel.length === 0) continue
      const aField = stripFilterSource(a.source)[1]
      rows = rows.filter((r) => sel.includes(String(r[aField] ?? '')))
    }
    const options = filterOptions(rows, field, f.display ? stripFilterSource(f.display)[1] : undefined)
    const values = new Set(options.map((o) => o.value))
    const asked = requested[f.id] ?? []
    let selected = asked.filter((v) => values.has(v))
    // Single: un solo valor manda (una URL con varios no convierte el filtro en multi).
    if (!f.multi && selected.length > 1) selected = [selected[0]]
    if (selected.length > FILTER_MAX_VALUES) {
      throw new VergisError({
        error: 'mira/filters',
        code: 'filter-too-many-values',
        path: `filters[${f.id}]`,
        value: selected.length,
        message: `El filtro '${f.id}' recibió ${selected.length} valores; el tope es ${FILTER_MAX_VALUES}.`,
        remediation: `Acotar la selección: cada valor es un parámetro bind de la query, y los motores TDS topan alrededor de 2100.`,
      })
    }
    selections.set(f.id, selected)
    out.push({ id: f.id, label: f.label ?? f.id, multi: !!f.multi, options, selected })
  }
  return out
}

/**
 * Sustituye `:flt.<id>` en `params.sql` por el predicado del filtro:
 *  - sin selección → `1=1` (el filtro es una sustracción OPCIONAL: ausencia = sin efecto);
 *  - con selección → `<column> IN (@flt_<id>_0, …)`, con los valores como PARÁMETROS BIND.
 *
 * Los valores del usuario JAMÁS se interpolan en el SQL — solo la `column`, que la validación exige
 * que sea un identificador (`^[A-Za-z0-9_[\].]+$`) declarado en el spec, no algo que el usuario
 * controle. Un `:flt.<id>` sin filtro declarado se reporta en `missing` y degrada a `1=1`: defensa en
 * profundidad detrás del validate, para que nunca quede un placeholder literal roto en la query.
 */
export function applyFlt(
  params: Record<string, unknown> | undefined,
  resolved: FilterResolved[],
  columns: Record<string, string>,
  missing?: string[],
): Record<string, unknown> | undefined {
  if (!params || typeof params['sql'] !== 'string') return params
  const sql = params['sql'] as string
  if (!sql.includes(':flt.')) return params
  const byId = new Map(resolved.map((r) => [r.id, r]))
  const bound: Record<string, string> = {}
  const rewritten = sql.replace(/:flt\.([a-zA-Z0-9_]+)/g, (_m, id: string) => {
    const r = byId.get(id)
    if (!r) {
      if (missing && !missing.includes(id)) missing.push(id)
      return '1=1'
    }
    if (r.selected.length === 0) return '1=1'
    const col = columns[id]
    const binds = r.selected.map((val, i) => {
      bound[`flt_${id}_${i}`] = val
      return `@flt_${id}_${i}`
    })
    return `${col} IN (${binds.join(', ')})`
  })
  return { ...params, sql: rewritten, params: { ...((params['params'] as Record<string, unknown>) ?? {}), ...bound } }
}

/** Los `flt.` con selección, para el carry de navegación (páginas, drills, sellos). */
export function filterCarry(resolved: FilterResolved[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const r of resolved) if (r.selected.length > 0) out[r.id] = r.selected
  return out
}
