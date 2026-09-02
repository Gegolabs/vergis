import sql from 'mssql'
import { pkColumn, type MasterDataColumn, type MasterDataEntity } from './master-data'
import type { MasterDataRow } from './master-data-store'
import type { SqlConnectionProfile } from './execute-sql-dwh'
import { credentialProviderFor } from './aad-token'

/**
 * PUBLICADOR de data maestra — realiza el modelo de publicación (ver
 * `docs/data-maestra-y-publicacion.md`): toma las filas de la **autoría** (`md_<id>`) y materializa la
 * **proyección read-only** `md_<id>__replica` en el store de cada **target** declarado por la entidad,
 * con su **SECURITY POLICY allow-all** (para el gate fail-closed). Universal: el target es cualquier
 * store con un ejecutor SQL (acá, Fabric/Azure SQL por Service Principal).
 *
 * Es la pieza que vuelve la data maestra **consumible**: el PI hace join local contra la réplica.
 * `publish-on-write` (en el ambiente de Administración) la invoca tras cada edición → inmediatez.
 */

/** Nombre de la tabla de proyección de una entidad (convención `__replica`). `id` validado → seguro. */
export const replicaTable = (entity: MasterDataEntity): string => `dbo.md_${entity.id}__replica`

/** Tabla STAGING de la publicación (`__replica_new`): se construye y puebla acá, luego swap a la viva. */
export const replicaStagingTable = (entity: MasterDataEntity): string => `dbo.md_${entity.id}__replica_new`

// NVARCHAR (no VARCHAR): la data maestra puede traer acentos/no-Latin (nombres de socios, etc.). VARCHAR
// bajo una collation Latin los mutila; NVARCHAR (Unicode) los preserva. Igual en el bind y en el fn.
const ddlType = (c: MasterDataColumn): string => (c.type === 'string' ? 'NVARCHAR(400)' : c.type === 'int' ? 'BIGINT' : 'BIT')

/**
 * Plan de publicación ATÓMICO (staging + swap) — puro y testeable, sin motor. El `publish()` clásico hacía
 * DROP TABLE de la réplica VIVA y LUEGO el INSERT fila-a-fila: si el INSERT fallaba a mitad, la réplica
 * quedaba destruida/parcial para TODOS los PIs consumidores (outage). Acá se construye y puebla una tabla
 * `__replica_new`, y solo cuando está lista se hace el swap (drop de la vieja + `sp_rename`), recreando la
 * policy allow-all sobre el nombre vivo. El tramo destructivo es breve y ocurre DESPUÉS de tener los datos.
 */
export function masterDataPublishPlan(
  entity: MasterDataEntity,
  consumerPrincipals: string[] = [],
): { staging: string; live: string; columns: string[]; buildStaging: string[]; swap: string[] } {
  const live = replicaTable(entity) // dbo.md_<id>__replica
  const staging = replicaStagingTable(entity) // dbo.md_<id>__replica_new
  const bare = live.replace(/^dbo\./, '')
  const pk = pkColumn(entity)
  const columns = entity.columns.map((c) => c.name)
  const colDdl = entity.columns.map((c) => `${c.name} ${ddlType(c)}`).join(', ')
  const buildStaging = [
    `DROP TABLE IF EXISTS ${staging};`, // limpia un staging de una corrida abortada previa
    `CREATE TABLE ${staging} (${colDdl});`,
  ]
  const swap = [
    // El DROP de policy+función va ANTES del DROP TABLE (dependencia de SCHEMABINDING sobre la tabla viva).
    `DROP SECURITY POLICY IF EXISTS [dbo].[secpol_${bare}];`,
    `DROP FUNCTION IF EXISTS [dbo].[fn_pol_${bare}];`,
    `DROP TABLE IF EXISTS ${live};`,
    `EXEC sp_rename '${staging}', '${bare}';`, // 2º arg = nuevo nombre del objeto SIN schema
    `CREATE FUNCTION [dbo].[fn_pol_${bare}](@c NVARCHAR(400)) RETURNS TABLE WITH SCHEMABINDING AS RETURN SELECT 1 AS vergis_allowed;`,
    `CREATE SECURITY POLICY [dbo].[secpol_${bare}] ADD FILTER PREDICATE [dbo].[fn_pol_${bare}](${pk.name}) ON ${live} WITH (STATE = ON);`,
    ...consumerPrincipals.map((p) => `GRANT SELECT ON ${live} TO [${p.replace(/]/g, ']]')}];`),
  ]
  return { staging, live, columns, buildStaging, swap }
}

export interface PublisherTarget {
  /** database_ref del store consumidor (debe existir en VERGIS_CONNECTIONS). */
  database_ref: string
  /**
   * Principals (SP/usuario) que deben poder LEER la réplica (RO). El publicador la crea como dueño
   * (RW); a estos se les da `SELECT`. Si publicador==consumidor (mismo SP), no hace falta. Multi-SP: sí.
   */
  consumerPrincipals?: string[]
}

/**
 * Resultado de publicar UN target. Es el contrato que vuelve visible lo que antes solo sabía el audit
 * log (#262): el llamador —el handler de Administración— lo lleva a la pantalla, target por target.
 * `ok:false` trae SIEMPRE el `error`: un fallo sin causa legible es el mismo silencio con otra forma.
 */
export interface PublishTargetResult {
  database_ref: string
  ok: boolean
  error?: string
}

/**
 * Conteo de la réplica en UN target. `count` y `error` son EXCLUYENTES y ninguno tiene default: una
 * lectura que falla se dice «no se pudo leer» con su causa, jamás un 0 — un cero fabricado es
 * indistinguible de una réplica vacía de verdad, y eso es peor que no saber (#262 §3).
 */
export interface ReplicaCountResult {
  database_ref: string
  count?: number
  error?: string
}

export interface Publisher {
  /** Publica/refresca la proyección `__replica` de una entidad en un target (idempotente: DROP+CREATE). */
  publish(entity: MasterDataEntity, rows: MasterDataRow[], target: PublisherTarget): Promise<void>
  /**
   * Cuántas filas tiene la réplica VIVA en el target. La cuenta el publicador porque él es el dueño
   * del nombre de la tabla (`replicaTable`): duplicar la convención afuera la haría derivar sola.
   * Lanza si no se puede leer (ref no configurado, credencial, tabla inexistente); el llamador
   * traduce ese throw a «no se pudo leer», nunca a un número.
   */
  count(entity: MasterDataEntity, target: PublisherTarget): Promise<number>
  close(): Promise<void>
}

/**
 * Publicador a Fabric/Azure SQL (mssql + Service Principal). Una conexión por `database_ref`.
 * NOTA: pools SEPARADOS por ref — nunca el `sql.connect` global (apuntaría todos al mismo store).
 */
export function createDwhPublisher(profiles: Record<string, SqlConnectionProfile>): Publisher {
  const pools = new Map<string, Promise<sql.ConnectionPool>>()
  function getPool(ref: string): Promise<sql.ConnectionPool> {
    const existing = pools.get(ref)
    if (existing) return existing
    const p = profiles[ref]
    if (!p) throw new Error(`publish: database_ref '${ref}' no configurado.`)
    // Fail-closed: un perfil sin credencial resoluble lanza ACÁ, antes de tocar la red.
    const provider = credentialProviderFor(p, { label: `database_ref '${ref}'` })
    const created = new sql.ConnectionPool({
      server: p.server,
      database: p.database,
      port: p.port ?? 1433,
      authentication: provider.sqlAuth(),
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: 30000,
      requestTimeout: 120000,
    }).connect()
    pools.set(ref, created)
    // Evictar la promesa si la primera conexión falla: si no, el fallo transitorio queda cacheado
    // para siempre (outage permanente hasta restart). El caller ve el rechazo; solo se limpia el caché.
    created.catch(() => pools.delete(ref))
    return created
  }

  return {
    async publish(entity, rows, target) {
      const plan = masterDataPublishPlan(entity, target.consumerPrincipals ?? [])
      const pool = await getPool(target.database_ref)
      // 1) construir la STAGING (la réplica VIVA sigue intacta y sirviendo).
      for (const stmt of plan.buildStaging) await pool.request().batch(stmt)
      // 2) poblar la staging con las filas (bindeadas). Es el tramo lento/propenso a fallar — si revienta
      //    acá, la réplica viva NO se tocó: los PIs consumidores siguen viendo los datos anteriores.
      const names = plan.columns
      for (const r of rows) {
        const rq = pool.request()
        entity.columns.forEach((c, i) => {
          const v = r[c.name]
          if (v == null) rq.input(`p${i}`, c.type === 'string' ? sql.NVarChar : c.type === 'int' ? sql.BigInt : sql.Bit, null)
          else if (c.type === 'bool') rq.input(`p${i}`, sql.Bit, v ? 1 : 0)
          else if (c.type === 'int') rq.input(`p${i}`, sql.BigInt, Number(v))
          else rq.input(`p${i}`, sql.NVarChar, String(v))
        })
        await rq.query(`INSERT INTO ${plan.staging} (${names.join(',')}) VALUES (${names.map((_, i) => '@p' + i).join(',')})`)
      }
      // 3) SWAP: recién ahora se toca la réplica viva (drop de la vieja + sp_rename de la staging + policy
      //    allow-all recreada). Tramo breve y con los datos ya listos.
      for (const stmt of plan.swap) await pool.request().batch(stmt)
    },
    async count(entity, target) {
      const pool = await getPool(target.database_ref)
      // `replicaTable(entity)` es el MISMO nombre que escribe `publish` (id validado por el parser).
      const r = await pool.request().query(`SELECT COUNT(*) AS n FROM ${replicaTable(entity)}`)
      const n = (r.recordset?.[0] as { n?: unknown } | undefined)?.n
      if (n == null || !Number.isFinite(Number(n))) throw new Error(`count: el conteo de ${replicaTable(entity)} no devolvió un número.`)
      return Number(n)
    },
    async close() {
      for (const p of pools.values()) {
        try {
          ;(await p).close()
        } catch {
          /* noop */
        }
      }
      pools.clear()
    },
  }
}
