import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import initSqlJs from 'sql.js'

/**
 * Apertura/persistencia de SQLite embebido (sql.js / WASM, sin binarios nativos) — la base común
 * de los stores embebidos del nodo (anotaciones, data maestra local, lista de admins). El WASM se
 * localiza por resolución de módulos (robusto en dev con tsx y en el bundle de dist/).
 */

export interface SqlStmt {
  bind: (v: unknown[]) => void
  step: () => boolean
  getAsObject: () => Record<string, unknown>
  reset: () => void
  free: () => void
}

export interface SqlDb {
  run: (sql: string, params?: unknown[]) => void
  exec: (sql: string) => { columns: string[]; values: unknown[][] }[]
  prepare: (s: string) => SqlStmt
  export: () => Uint8Array
  close: () => void
}

/** Abre una DB SQLite. `file` null → en memoria (tests). Si el archivo existe, se carga. */
export async function openSqliteDb(file: string | null): Promise<SqlDb> {
  const sqlJsDist = dirname(createRequire(import.meta.url).resolve('sql.js'))
  const SQL = await initSqlJs({ locateFile: (f: string) => `${sqlJsDist}/${f}` })
  const bytes = file && existsSync(file) ? readFileSync(file) : undefined
  return new SQL.Database(bytes) as unknown as SqlDb
}

/** Vuelca la DB a su archivo (no-op si es en memoria). Volumen bajo → escritura inmediata. */
export function persistSqliteDb(db: SqlDb, file: string | null): void {
  if (!file) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(db.export()))
}

/** Lee todas las filas de un prepared SELECT (sin params) como objetos. */
export function selectAll(db: SqlDb, sql: string): Record<string, unknown>[] {
  const res = db.exec(sql)
  if (res.length === 0) return []
  const { columns, values } = res[0]
  return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])))
}
