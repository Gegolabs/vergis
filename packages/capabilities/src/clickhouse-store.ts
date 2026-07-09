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
import { ident, type ClickHouseEnforcement } from '@vergis/policy'

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
  // Solo la PRIMERA línea del SQL: en un INSERT el statement va en la línea 1 y las filas NDJSON
  // (datos de negocio, posible PII) en las siguientes — no deben terminar en el log de errores.
  if (!res.ok) throw new Error(`clickhouse: ${res.status} — ${text.slice(0, 500)}\n  SQL: ${sql.split('\n')[0].slice(0, 200)}`)
  if (!opts.json) return []
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
}

// Los identificadores del store (db/tabla/columna/tipo/rol/usuario) entran al DDL/DML por interpolación
// de string — el HTTP de ClickHouse no parametriza identificadores. Se validan con el MISMO `ident()` del
// compilador `@vergis/policy` (codegen-common), única fuente del patrón de identificador seguro.

/** Valida TODOS los identificadores del schema antes de que entren al DDL/DML por interpolación. */
function assertSchemaIdents(schema: ChStoreSchema): void {
  ident('database', schema.database)
  ident('table', schema.table)
  for (const [name, type] of Object.entries(schema.columns)) {
    ident('column', name)
    ident('column-type', type)
  }
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
  const role = ident('role', opts.consumerRole ?? 'consumer_role')
  const user = ident('user', opts.consumerUser ?? 'botler')
  assertSchemaIdents(schema)
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
 * `ingest-to-clickhouse` — Capability de ingesta al store (refresh-time). Full-replace ATÓMICO vía
 * tabla staging + `EXCHANGE TABLES`. Un `TRUNCATE` + `INSERT` directo dejaba dos fallas: (1) ventana de
 * 0 filas entre el TRUNCATE y el fin del INSERT — un consumidor que lee ahí ve el store VACÍO; (2) si el
 * INSERT falla a mitad, el store queda vacío/parcial y se sirve como verdad. Con staging, la tabla
 * servida solo cambia en el swap atómico de `EXCHANGE TABLES` (Atomic engine, default en CH): o los datos
 * viejos completos, o los nuevos completos, nunca un estado intermedio. Corre con un usuario WRITER (admin
 * acá), nunca el consumidor. Idempotente: re-ingiere dejando el mismo estado.
 */
export function createIngestClickHouse(writer: ChAdminConn, schema: ChStoreSchema, name = 'ingest-to-clickhouse'): Capability {
  assertSchemaIdents(schema) // el schema es fijo por store: validar al construir, no en cada ingesta
  const qualified = `${schema.database}.${schema.table}`
  const staging = `${schema.database}.${schema.table}_staging`
  return {
    name,
    async execute(params: unknown): Promise<{ ingested: number }> {
      const p = (params ?? {}) as IngestParams
      const rows = p.rows ?? []
      // 1) staging con la MISMA estructura que la tabla servida (idempotente). 2) vaciarla por si quedó
      //    algo de una corrida abortada. 3) poblarla. 4) swap atómico. La tabla servida no ve intermedios.
      await chExec(writer, `CREATE TABLE IF NOT EXISTS ${staging} AS ${qualified}`)
      await chExec(writer, `TRUNCATE TABLE IF EXISTS ${staging}`)
      if (rows.length > 0) {
        const cols = Object.keys(schema.columns)
        const ndjson = rows.map((r) => JSON.stringify(Object.fromEntries(cols.map((c) => [c, r[c]])))).join('\n')
        await chExec({ ...writer }, `INSERT INTO ${staging} (${cols.join(', ')}) FORMAT JSONEachRow\n${ndjson}`)
      }
      // Swap atómico: la tabla servida pasa a tener las filas nuevas de una sola vez (si algo falló
      // antes, se aborta acá y la tabla servida conserva intactos los datos de la corrida anterior).
      await chExec(writer, `EXCHANGE TABLES ${qualified} AND ${staging}`)
      return { ingested: rows.length }
    },
  }
}

export { chExec as _chExec }
