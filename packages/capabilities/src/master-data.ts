/**
 * Data Maestra — contrato declarativo de una ENTIDAD gestionada a mano.
 *
 * Una entidad de data maestra es un catálogo SIN fuente externa (lo mantiene un humano): listas
 * de referencia, mapeos, overrides. La plataforma la gobierna como un dato más (policy store +
 * RLS), la publica como tabla en el lakehouse y la sirve a los PIs por JOIN (modelo pull, fuente
 * única). La gestión (alta/baja/edición de filas) vive en el ambiente de Administración.
 *
 * Este módulo define SOLO el contrato (genérico, agnóstico de instancia): qué columnas tiene la
 * entidad, cuál es su clave, y cómo se valida/coacciona un valor que llega de un formulario. El
 * almacenamiento vive en `master-data-store.ts`; las entidades concretas (Empresas Relacionadas,
 * etc.) las declara la INSTANCIA en un YAML.
 */

export type MasterDataColumnType = 'string' | 'int' | 'bool'

export interface MasterDataColumn {
  /** Nombre físico de la columna (en la tabla del lakehouse y en el form). */
  name: string
  /** Etiqueta para la UI. */
  label: string
  type: MasterDataColumnType
  /** Clave primaria (exactamente una por entidad). */
  pk?: boolean
  /** Obligatoria al crear/editar (la PK es obligatoria siempre). */
  required?: boolean
}

export interface PublicationTargetDecl {
  /** database_ref del store consumidor donde se publica la proyección `__replica`. */
  database_ref: string
}

export interface MasterDataEntity {
  /** Slug estable, usado en rutas y como id lógico (p.ej. `empresas_relacionadas`). */
  id: string
  /** Nombre legible para la UI (p.ej. `Empresas Relacionadas`). */
  label: string
  description?: string
  /** Dominio al que pertenece (tag; deriva la gestión de dominio en Administración). */
  domain?: string
  /** Perfil de conexión (motor Fabric) donde vive la AUTORÍA física. Opcional en local. */
  database_ref?: string
  /** Tabla física de la AUTORÍA `schema.tabla` (p.ej. `dbo.md_empresas_relacionadas`). Opcional en local. */
  table?: string
  /** Destinos de PUBLICACIÓN: stores consumidores donde se materializa `md_<id>__replica` (modelo pull). */
  targets?: PublicationTargetDecl[]
  columns: MasterDataColumn[]
}

const SLUG_RE = /^[a-z][a-z0-9_]*$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Valida y normaliza la config declarativa (YAML de instancia) a entidades tipadas. */
export function parseMasterDataConfig(doc: unknown): MasterDataEntity[] {
  const root = (doc ?? {}) as { entities?: unknown }
  const raw = root.entities
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('master-data: `entities` debe ser una lista.')
  const seen = new Set<string>()
  return raw.map((e, i) => parseEntity(e, i, seen))
}

function parseEntity(e: unknown, i: number, seen: Set<string>): MasterDataEntity {
  const o = (e ?? {}) as Record<string, unknown>
  const id = String(o['id'] ?? '')
  if (!SLUG_RE.test(id)) throw new Error(`master-data: entidad #${i} con id inválido '${id}' (esperado [a-z][a-z0-9_]*).`)
  if (seen.has(id)) throw new Error(`master-data: id de entidad duplicado '${id}'.`)
  seen.add(id)
  const label = String(o['label'] ?? id)
  const colsRaw = o['columns']
  if (!Array.isArray(colsRaw) || colsRaw.length === 0) throw new Error(`master-data: entidad '${id}' sin columnas.`)
  const columns = colsRaw.map((c, j) => parseColumn(c, id, j))
  const pks = columns.filter((c) => c.pk)
  if (pks.length !== 1) throw new Error(`master-data: entidad '${id}' debe tener exactamente 1 columna pk (tiene ${pks.length}).`)
  const out: MasterDataEntity = { id, label, columns }
  if (o['description'] != null) out.description = String(o['description'])
  if (o['domain'] != null) out.domain = String(o['domain'])
  if (o['database_ref'] != null) out.database_ref = String(o['database_ref'])
  if (o['table'] != null) {
    const t = String(o['table'])
    if (!/^[A-Za-z_][\w]*\.[A-Za-z_][\w]*$/.test(t)) throw new Error(`master-data: entidad '${id}' con table inválida '${t}' (esperado schema.tabla).`)
    out.table = t
  }
  if (o['targets'] != null) {
    if (!Array.isArray(o['targets'])) throw new Error(`master-data: '${id}'.targets debe ser una lista.`)
    out.targets = o['targets'].map((t) => {
      const ref = String((t as Record<string, unknown>)?.['database_ref'] ?? '')
      if (!ref) throw new Error(`master-data: '${id}' target sin database_ref.`)
      return { database_ref: ref }
    })
  }
  return out
}

function parseColumn(c: unknown, entityId: string, j: number): MasterDataColumn {
  const o = (c ?? {}) as Record<string, unknown>
  const name = String(o['name'] ?? '')
  if (!IDENT_RE.test(name)) throw new Error(`master-data: '${entityId}' columna #${j} con name inválido '${name}'.`)
  const type = String(o['type'] ?? 'string') as MasterDataColumnType
  if (type !== 'string' && type !== 'int' && type !== 'bool') throw new Error(`master-data: '${entityId}.${name}' tipo inválido '${type}'.`)
  const col: MasterDataColumn = { name, label: String(o['label'] ?? name), type }
  if (o['pk'] === true) col.pk = true
  if (o['required'] === true || col.pk) col.required = true
  return col
}

/** La columna PK de la entidad (garantizada única por el parser). */
export function pkColumn(entity: MasterDataEntity): MasterDataColumn {
  const pk = entity.columns.find((c) => c.pk)
  if (!pk) throw new Error(`master-data: entidad '${entity.id}' sin pk.`)
  return pk
}

export type CoerceResult = { ok: true; value: string | number | boolean | null } | { ok: false; error: string }

/**
 * Coacciona un valor crudo (string de formulario) al tipo de la columna y valida obligatoriedad.
 * Devuelve un resultado accionable (Agent/Operator First): el error explica qué corregir.
 */
export function coerceValue(col: MasterDataColumn, raw: unknown): CoerceResult {
  const s = raw == null ? '' : String(raw).trim()
  if (s === '') {
    if (col.required) return { ok: false, error: `«${col.label}» es obligatorio.` }
    return { ok: true, value: null }
  }
  if (col.type === 'int') {
    if (!/^-?\d+$/.test(s)) return { ok: false, error: `«${col.label}» debe ser un entero (recibido '${s}').` }
    return { ok: true, value: Number(s) }
  }
  if (col.type === 'bool') {
    if (['1', 'true', 'sí', 'si', 'on', 'yes'].includes(s.toLowerCase())) return { ok: true, value: true }
    if (['0', 'false', 'no', 'off', ''].includes(s.toLowerCase())) return { ok: true, value: false }
    return { ok: false, error: `«${col.label}» debe ser sí/no (recibido '${s}').` }
  }
  return { ok: true, value: s }
}

/** Coacciona una fila completa; devuelve {values} o la lista de errores de validación. */
export function coerceRow(
  entity: MasterDataEntity,
  input: Record<string, unknown>,
): { ok: true; values: Record<string, string | number | boolean | null> } | { ok: false; errors: string[] } {
  const values: Record<string, string | number | boolean | null> = {}
  const errors: string[] = []
  for (const col of entity.columns) {
    const r = coerceValue(col, input[col.name])
    if (r.ok) values[col.name] = r.value
    else errors.push(r.error)
  }
  return errors.length ? { ok: false, errors } : { ok: true, values }
}
