import sql from 'mssql'
import {
  openSqliteDb,
  persistSqliteDb,
  selectAll,
  sqliteControlStatus,
  type SqlDb,
  type SqliteControlOptions,
  type SqliteControlStatus,
} from './sqlite'
import { pkColumn, type MasterDataColumn, type MasterDataEntity } from './master-data'
import type { SqlConnectionProfile } from './execute-sql-dwh'
import { credentialProviderFor } from './aad-token'

/**
 * Almacenamiento de las filas de una entidad de data maestra. Es una COSTURA con dos impls:
 *  - `SqliteMasterDataStore` — embebido (sql.js). Para desarrollo/prueba local del ambiente de
 *    Administración sin tocar Fabric.
 *  - `createDwhMasterDataStore` — escritura gobernada a Fabric (DML parametrizado por Service
 *    Principal). Es la fuente única en producción: el PI la consume por JOIN (shortcut OneLake).
 *
 * La autoría (quién/cuándo) NO vive en la fila sino en el log append-only de auditoría (la fuente
 * de la provenance). El store escribe solo las columnas declaradas de la entidad.
 */

export type MasterDataRow = Record<string, string | number | boolean | null>

export interface MasterDataStore {
  /** Lee todas las filas de la entidad (orden por PK ascendente). */
  list(entity: MasterDataEntity): Promise<MasterDataRow[]>
  /** Inserta una fila. Falla si la PK ya existe. */
  insert(entity: MasterDataEntity, values: MasterDataRow): Promise<void>
  /** Actualiza las columnas no-PK de la fila identificada por su PK. */
  update(entity: MasterDataEntity, pk: string | number, values: MasterDataRow): Promise<void>
  /** Elimina la fila identificada por su PK. */
  remove(entity: MasterDataEntity, pk: string | number): Promise<void>
  close(): Promise<void>
}

export class MasterDataConflict extends Error {}

const sqlType = (c: MasterDataColumn): string => (c.type === 'string' ? 'TEXT' : 'INTEGER')
const toStorage = (c: MasterDataColumn, v: string | number | boolean | null): unknown =>
  v == null ? null : c.type === 'bool' ? (v ? 1 : 0) : v
const fromStorage = (c: MasterDataColumn, v: unknown): string | number | boolean | null =>
  v == null ? null : c.type === 'bool' ? Boolean(v) : c.type === 'int' ? Number(v) : String(v)

/** Nombre físico de la tabla embebida de una entidad. id validado por el parser → seguro interpolar. */
const localTable = (entity: MasterDataEntity): string => `md_${entity.id}`

/**
 * Versión del esquema de este store, escrita como `PRAGMA user_version`. Toda migración que altere el
 * esquema la incrementa EN EL MISMO COMMIT; abrir un archivo con una versión mayor se niega.
 */
export const MASTER_DATA_SCHEMA_VERSION = 1

// ─── Impl. embebida (SQLite) ────────────────────────────────────────────────
export class SqliteMasterDataStore implements MasterDataStore {
  private constructor(
    private db: SqlDb,
    private file: string | null,
  ) {}

  /** Abre la DB y materializa una tabla por entidad (idempotente). */
  static async open(
    file: string | null,
    entities: MasterDataEntity[],
    control: SqliteControlOptions = {},
  ): Promise<SqliteMasterDataStore> {
    const db = await openSqliteDb(file, { ...control, schemaVersion: MASTER_DATA_SCHEMA_VERSION })
    for (const e of entities) {
      const cols = e.columns
        .map((c) => `${c.name} ${sqlType(c)}${c.pk ? ' PRIMARY KEY' : ''}${c.required && !c.pk ? ' NOT NULL' : ''}`)
        .join(', ')
      db.run(`CREATE TABLE IF NOT EXISTS ${localTable(e)} (${cols})`)
    }
    persistSqliteDb(db, file)
    return new SqliteMasterDataStore(db, file)
  }

  /** Estado del plano de escritura de este store (esquema, época, degradado). */
  controlStatus(): SqliteControlStatus | undefined {
    return sqliteControlStatus(this.db)
  }

  async list(entity: MasterDataEntity): Promise<MasterDataRow[]> {
    const pk = pkColumn(entity)
    const rows = selectAll(this.db, `SELECT * FROM ${localTable(entity)} ORDER BY ${pk.name} ASC`)
    return rows.map((r) => {
      const out: MasterDataRow = {}
      for (const c of entity.columns) out[c.name] = fromStorage(c, r[c.name])
      return out
    })
  }

  async insert(entity: MasterDataEntity, values: MasterDataRow): Promise<void> {
    const pk = pkColumn(entity)
    const exists = this.existsPk(entity, values[pk.name] as string | number)
    if (exists) throw new MasterDataConflict(`Ya existe un registro con ${pk.label} = ${values[pk.name]}.`)
    const cols = entity.columns.map((c) => c.name)
    const placeholders = cols.map(() => '?').join(', ')
    const params = entity.columns.map((c) => toStorage(c, values[c.name] ?? null))
    this.db.run(`INSERT INTO ${localTable(entity)} (${cols.join(', ')}) VALUES (${placeholders})`, params)
    persistSqliteDb(this.db, this.file)
  }

  async update(entity: MasterDataEntity, pkValue: string | number, values: MasterDataRow): Promise<void> {
    const pk = pkColumn(entity)
    if (!this.existsPk(entity, pkValue)) throw new MasterDataConflict(`No existe un registro con ${pk.label} = ${pkValue}.`)
    const setCols = entity.columns.filter((c) => !c.pk)
    if (setCols.length === 0) return
    const setSql = setCols.map((c) => `${c.name} = ?`).join(', ')
    const params = [...setCols.map((c) => toStorage(c, values[c.name] ?? null)), pkScalar(pk, pkValue)]
    this.db.run(`UPDATE ${localTable(entity)} SET ${setSql} WHERE ${pk.name} = ?`, params)
    persistSqliteDb(this.db, this.file)
  }

  async remove(entity: MasterDataEntity, pkValue: string | number): Promise<void> {
    const pk = pkColumn(entity)
    this.db.run(`DELETE FROM ${localTable(entity)} WHERE ${pk.name} = ?`, [pkScalar(pk, pkValue)])
    persistSqliteDb(this.db, this.file)
  }

  private existsPk(entity: MasterDataEntity, pkValue: string | number): boolean {
    const pk = pkColumn(entity)
    const stmt = this.db.prepare(`SELECT 1 FROM ${localTable(entity)} WHERE ${pk.name} = ?`)
    stmt.bind([pkScalar(pk, pkValue)])
    const found = stmt.step()
    stmt.free()
    return found
  }

  async close(): Promise<void> {
    persistSqliteDb(this.db, this.file)
    this.db.close()
  }
}

const pkScalar = (pk: MasterDataColumn, v: string | number): string | number =>
  pk.type === 'int' ? Number(v) : String(v)

// ─── Impl. Fabric (push-down, DML parametrizado por Service Principal) ───────
/**
 * Escritura gobernada a Fabric: INSERT/UPDATE/DELETE sobre la tabla física de la entidad. Los
 * identificadores (tabla, columnas) vienen del contrato validado → seguros; los VALORES viajan
 * BINDEADOS (`@p<n>`), nunca concatenados → injection-safe. Es la fuente única que el PI lee por JOIN.
 */
export function createDwhMasterDataStore(profiles: Record<string, SqlConnectionProfile>): MasterDataStore {
  const pools = new Map<string, Promise<sql.ConnectionPool>>()
  function getPool(ref: string): Promise<sql.ConnectionPool> {
    const existing = pools.get(ref)
    if (existing) return existing
    const p = profiles[ref]
    if (!p) throw new Error(`master-data(fabric): database_ref '${ref}' no configurado.`)
    // Fail-closed: un perfil sin credencial resoluble lanza ACÁ, antes de tocar la red.
    const provider = credentialProviderFor(p, { label: `database_ref '${ref}'` })
    const cfg: sql.config = {
      server: p.server,
      database: p.database,
      port: p.port ?? 1433,
      authentication: provider.sqlAuth(),
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: 30000,
      requestTimeout: 60000,
    }
    const created = new sql.ConnectionPool(cfg).connect()
    pools.set(ref, created)
    // Evictar la promesa si la primera conexión falla: si no, el fallo transitorio queda cacheado
    // para siempre (outage permanente hasta restart). El caller ve el rechazo; solo se limpia el caché.
    created.catch(() => pools.delete(ref))
    return created
  }
  function target(entity: MasterDataEntity): { ref: string; table: string } {
    if (!entity.database_ref || !entity.table)
      throw new Error(`master-data(fabric): entidad '${entity.id}' sin database_ref/table — requeridos en motor Fabric.`)
    return { ref: entity.database_ref, table: entity.table }
  }
  const mssqlType = (c: MasterDataColumn) => (c.type === 'string' ? sql.NVarChar : sql.BigInt)
  const bind = (req: sql.Request, name: string, c: MasterDataColumn, v: string | number | boolean | null) => {
    if (v == null) req.input(name, mssqlType(c), null)
    else if (c.type === 'bool') req.input(name, sql.Bit, v ? 1 : 0)
    else if (c.type === 'int') req.input(name, sql.BigInt, Number(v))
    else req.input(name, sql.NVarChar, String(v))
  }

  return {
    async list(entity) {
      const { ref, table } = target(entity)
      const pk = pkColumn(entity)
      const pool = await getPool(ref)
      const out = await pool.request().query(`SELECT * FROM ${table} ORDER BY ${pk.name} ASC`)
      return (out.recordset ?? []).map((r) => {
        const row: MasterDataRow = {}
        for (const c of entity.columns) row[c.name] = fromStorage(c, (r as Record<string, unknown>)[c.name])
        return row
      })
    },
    async insert(entity, values) {
      const { ref, table } = target(entity)
      const pk = pkColumn(entity)
      const pool = await getPool(ref)
      // Fabric Warehouse declara las PK como NOT ENFORCED → un INSERT duplicado NO falla. Chequear
      // explícito para honrar el contrato (la impl. SQLite lanza MasterDataConflict).
      const check = pool.request()
      bind(check, 'pk', pk, pkScalar(pk, String(values[pk.name] ?? '')))
      const found = await check.query(`SELECT 1 FROM ${table} WHERE ${pk.name} = @pk`)
      if ((found.recordset ?? []).length > 0) {
        throw new MasterDataConflict(`Ya existe un registro con ${pk.label} = ${values[pk.name]}.`)
      }
      const req = pool.request()
      entity.columns.forEach((c, i) => bind(req, `p${i}`, c, values[c.name] ?? null))
      const cols = entity.columns.map((c) => c.name).join(', ')
      const ph = entity.columns.map((_, i) => `@p${i}`).join(', ')
      await req.query(`INSERT INTO ${table} (${cols}) VALUES (${ph})`)
    },
    async update(entity, pkValue, values) {
      const { ref, table } = target(entity)
      const pk = pkColumn(entity)
      const setCols = entity.columns.filter((c) => !c.pk)
      if (setCols.length === 0) return
      const pool = await getPool(ref)
      const req = pool.request()
      setCols.forEach((c, i) => bind(req, `p${i}`, c, values[c.name] ?? null))
      bind(req, 'pk', pk, pkScalar(pk, pkValue))
      const setSql = setCols.map((c, i) => `${c.name} = @p${i}`).join(', ')
      const res = await req.query(`UPDATE ${table} SET ${setSql} WHERE ${pk.name} = @pk`)
      // Sin fila afectada → la PK no existía: no-op silencioso donde SQLite lanza. La UI de
      // Administración (desarrollada contra la gemela local) asume el error.
      if ((res.rowsAffected?.[0] ?? 0) === 0) {
        throw new MasterDataConflict(`No existe un registro con ${pk.label} = ${pkValue}.`)
      }
    },
    async remove(entity, pkValue) {
      const { ref, table } = target(entity)
      const pk = pkColumn(entity)
      const pool = await getPool(ref)
      const req = pool.request()
      bind(req, 'pk', pk, pkScalar(pk, pkValue))
      await req.query(`DELETE FROM ${table} WHERE ${pk.name} = @pk`)
    },
    async close() {
      for (const pool of pools.values()) {
        try {
          ;(await pool).close()
        } catch {
          /* noop */
        }
      }
      pools.clear()
    },
  }
}
