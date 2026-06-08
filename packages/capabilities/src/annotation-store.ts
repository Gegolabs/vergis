import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import initSqlJs from 'sql.js'

/**
 * Anotaciones — enriquecimiento del dataset que vive SOLO en la capa de visualización.
 *
 * Un campo de anotación COMPARTIDO por PI, atado a cada registro por su clave. El dato es
 * compartido (RLS-scoped al servir); mostrar/ocultar la columna es preferencia por-usuario.
 *
 * `AnnotationStore` es la interfaz; la impl. por defecto (`SqliteAnnotationStore`) es una DB
 * relacional EMBEBIDA (SQLite vía WASM, sin binarios nativos). El contrato es relacional a
 * propósito: enchufar una externa de apoyo (Postgres, etc.) = otra impl. de esta misma interfaz.
 */

export interface AnnotationRecord {
  value: string
  updatedBy?: string
  updatedAt?: string
}

export interface AnnotationStore {
  /** Lee las anotaciones de un conjunto de claves de un PI. */
  get(piId: string, keys: string[]): Promise<Map<string, AnnotationRecord>>
  /** Crea/actualiza la anotación de un registro. `value` vacío borra. */
  upsert(piId: string, key: string, value: string, user?: string): Promise<void>
  close(): void
}

type SqlDb = {
  run: (sql: string, params?: unknown[]) => void
  exec: (sql: string) => { columns: string[]; values: unknown[][] }[]
  export: () => Uint8Array
  close: () => void
}

const DDL = `CREATE TABLE IF NOT EXISTS annotation (
  pi_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  PRIMARY KEY (pi_id, record_key)
);`

/**
 * Impl. embebida con SQLite (sql.js / WASM). Persiste a un archivo: carga al abrir, exporta
 * tras cada escritura (volumen de anotaciones bajo → escritura inmediata es suficiente).
 */
export class SqliteAnnotationStore implements AnnotationStore {
  private constructor(
    private db: SqlDb,
    private file: string | null,
  ) {}

  /** `file` null → DB en memoria (tests). Si el archivo existe, se carga. */
  static async open(file: string | null): Promise<SqliteAnnotationStore> {
    const SQL = await initSqlJs({
      locateFile: (f: string) => new URL(`../../../node_modules/sql.js/dist/${f}`, import.meta.url).pathname,
    })
    const bytes = file && existsSync(file) ? readFileSync(file) : undefined
    const db = new SQL.Database(bytes) as unknown as SqlDb
    db.run(DDL)
    return new SqliteAnnotationStore(db, file)
  }

  private persist(): void {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, Buffer.from(this.db.export()))
  }

  async get(piId: string, keys: string[]): Promise<Map<string, AnnotationRecord>> {
    const out = new Map<string, AnnotationRecord>()
    if (keys.length === 0) return out
    const dbp = this.db as unknown as { prepare: (s: string) => SqlStmt }
    // Prepared statement con bind por clave (injection-safe; sql.js no parametriza en exec()).
    const stmt = dbp.prepare(
      `SELECT value, updated_by, updated_at FROM annotation WHERE pi_id = ? AND record_key = ?`,
    )
    for (const k of keys) {
      stmt.bind([piId, k])
      if (stmt.step()) {
        const row = stmt.getAsObject() as { value: string; updated_by?: string; updated_at?: string }
        out.set(k, { value: String(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at })
      }
      stmt.reset()
    }
    stmt.free()
    return out
  }

  async upsert(piId: string, key: string, value: string, user?: string): Promise<void> {
    const now = new Date().toISOString()
    if (value === '') {
      this.db.run(`DELETE FROM annotation WHERE pi_id = ? AND record_key = ?`, [piId, key])
    } else {
      this.db.run(
        `INSERT INTO annotation (pi_id, record_key, value, updated_by, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(pi_id, record_key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
        [piId, key, value, user ?? null, now],
      )
    }
    this.persist()
  }

  close(): void {
    this.persist()
    this.db.close()
  }
}

interface SqlStmt {
  bind: (v: unknown[]) => void
  step: () => boolean
  getAsObject: () => Record<string, unknown>
  reset: () => void
  free: () => void
}

/**
 * Selector del store por entorno (la costura del swap):
 *  - `VERGIS_ANNOTATIONS_URL` → store externo (impl. futura: Postgres/etc.).
 *  - `VERGIS_ANNOTATIONS_DB`  → archivo SQLite embebido (default).
 *  - nada → SQLite en `<baseDir>/annotations.sqlite`.
 */
export async function openAnnotationStore(baseDir: string): Promise<AnnotationStore> {
  const url = process.env['VERGIS_ANNOTATIONS_URL']
  if (url) {
    throw new Error(
      'VERGIS_ANNOTATIONS_URL: store externo aún no implementado. Provea una impl. de AnnotationStore (seam).',
    )
  }
  const file = process.env['VERGIS_ANNOTATIONS_DB'] ?? `${baseDir.replace(/\/$/, '')}/annotations.sqlite`
  return SqliteAnnotationStore.open(file)
}
