// ClickHouse como STORE servido del motor B (doc 9 §4–§5): caché desechable que la
// fuente-sin-RLS (Buk/Excel) alimenta y desde el que se sirve con RLS activa.
//
// Dos piezas, dos momentos:
//   · bootstrapClickHouse  — specialize/deploy-time (una vez): crea db/tabla, el rol e
//     usuario data-plane de BAJO privilegio (`botler`, default `vergis_claim_*=''`) y aplica
//     la ROW POLICY EMITIDA POR EL COMPILADOR (verbatim). Es config-gen idempotente.
//   · createIngestClickHouse — refresh-time: el Botler ingiere las filas de la fuente al
//     store (full-replace, caché desechable). Corre con un usuario WRITER, no el consumidor.
//
// La lectura servida NO vive acá: la hace `execute-sql-ch` como `botler` + claims del
// consumidor (RLS). Tres identidades, tres privilegios: admin (bootstrap) · writer (ingesta)
// · botler/consumer (serve). El consumidor jamás escribe ni ve más que su policy.

import type { Capability } from '@vergis/botler'
import type { ClickHouseEnforcement } from '@vergis/policy'

/** Conexión a ClickHouse con privilegio (admin para bootstrap, writer para ingesta). */
export interface ChAdminConn {
  url: string
  user: string
  password?: string
  database?: string
}

/** Una sentencia HTTP a ClickHouse. `json: true` para SELECT (JSONEachRow); void para DDL/DML. */
async function chExec(conn: ChAdminConn, sql: string, opts: { json?: boolean } = {}): Promise<Record<string, unknown>[]> {
  const u = new URL(conn.url)
  if (conn.database) u.searchParams.set('database', conn.database)
  if (opts.json) u.searchParams.set('default_format', 'JSONEachRow')
  const res = await fetch(u.toString(), {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': conn.user,
      ...(conn.password ? { 'X-ClickHouse-Key': conn.password } : {}),
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: sql,
    signal: AbortSignal.timeout(60_000), // un socket colgado en bootstrap/ingesta dejaba todo pendiente
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`clickhouse: ${res.status} — ${text.slice(0, 500)}\n  SQL: ${sql.slice(0, 200)}`)
  if (!opts.json) return []
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** Tipo ClickHouse de una columna del store (mínimo para QW-04: texto + enteros). */
export type ChColumnType = 'String' | 'UInt32' | 'Int32' | 'Float64' | 'Date'

export interface ChStoreSchema {
  database: string
  table: string
  /** columna → tipo ClickHouse. La 1ª que aparezca en la policy es la que segmenta. */
  columns: Record<string, ChColumnType>
}

export interface BootstrapOptions {
  /** Usuario data-plane de bajo privilegio que usa `execute-sql-ch` al servir. Default 'botler'. */
  consumerUser?: string
  /** Rol de bajo privilegio (SELECT sobre la tabla con policy). Default 'consumer_role'. */
  consumerRole?: string
}

/**
 * Prepara el store en ClickHouse de forma IDEMPOTENTE: db, tabla, rol/usuario data-plane y
 * la ROW POLICY del compilador. Re-ejecutable sin romper estado (IF NOT EXISTS · DROP+CREATE
 * de la policy para reflejar cambios del spec). Si `enforcement` es null (PI público), crea
 * el store SIN policy (gate-only).
 */
export async function bootstrapClickHouse(
  admin: ChAdminConn,
  schema: ChStoreSchema,
  enforcement: ClickHouseEnforcement | null,
  opts: BootstrapOptions = {},
): Promise<void> {
  const role = opts.consumerRole ?? 'consumer_role'
  const user = opts.consumerUser ?? 'botler'
  const cols = Object.entries(schema.columns).map(([n, t]) => `${n} ${t}`).join(', ')
  const orderBy = Object.keys(schema.columns)[0] ?? 'tuple()'

  await chExec(admin, `CREATE DATABASE IF NOT EXISTS ${schema.database}`)
  await chExec(
    admin,
    `CREATE TABLE IF NOT EXISTS ${schema.database}.${schema.table} (${cols}) ENGINE = MergeTree ORDER BY ${orderBy}`,
  )
  await chExec(admin, `CREATE ROLE IF NOT EXISTS ${role}`)
  await chExec(admin, `GRANT SELECT ON ${schema.database}.${schema.table} TO ${role}`)

  // Usuario data-plane: default de TODOS los settings de claims en '' → default-deny por construcción.
  const claimDefaults = enforcement
    ? enforcement.injections.map((i) => `${i.setting} = ''`).join(', ')
    : ''
  const settingsClause = claimDefaults ? ` SETTINGS ${claimDefaults}` : ''
  await chExec(
    admin,
    `CREATE USER IF NOT EXISTS ${user} IDENTIFIED WITH no_password${settingsClause} DEFAULT ROLE ${role}`,
  )
  await chExec(admin, `GRANT ${role} TO ${user}`)

  if (enforcement) {
    // DROP + CREATE para idempotencia y para reflejar cambios del spec (la policy es config-gen).
    const policyName = enforcement.rowPolicySQL.match(/CREATE ROW POLICY (\w+)/)?.[1]
    if (policyName) {
      await chExec(admin, `DROP ROW POLICY IF EXISTS ${policyName} ON ${schema.database}.${schema.table}`)
    }
    await chExec(admin, enforcement.rowPolicySQL) // verbatim del compilador
  }
}

interface IngestParams {
  rows: Record<string, unknown>[]
}

/**
 * `ingest-to-clickhouse` — Capability de ingesta al store (refresh-time). Full-replace:
 * TRUNCATE + INSERT (caché desechable; el sistema de registro es la fuente). Corre con un
 * usuario WRITER (admin acá), nunca el consumidor. Idempotente: re-ingiere dejando el mismo estado.
 */
export function createIngestClickHouse(writer: ChAdminConn, schema: ChStoreSchema, name = 'ingest-to-clickhouse'): Capability {
  return {
    name,
    async execute(params: unknown): Promise<{ ingested: number }> {
      const p = (params ?? {}) as IngestParams
      const rows = p.rows ?? []
      await chExec(writer, `TRUNCATE TABLE IF EXISTS ${schema.database}.${schema.table}`)
      if (rows.length > 0) {
        const cols = Object.keys(schema.columns)
        const ndjson = rows.map((r) => JSON.stringify(Object.fromEntries(cols.map((c) => [c, r[c]])))).join('\n')
        await chExec({ ...writer }, `INSERT INTO ${schema.database}.${schema.table} (${cols.join(', ')}) FORMAT JSONEachRow\n${ndjson}`)
      }
      return { ingested: rows.length }
    },
  }
}

export { chExec as _chExec }
