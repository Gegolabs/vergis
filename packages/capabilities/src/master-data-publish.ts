import sql from 'mssql'
import { pkColumn, type MasterDataColumn, type MasterDataEntity } from './master-data'
import type { MasterDataRow } from './master-data-store'
import type { SqlConnectionProfile } from './execute-sql-dwh'

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

const ddlType = (c: MasterDataColumn): string => (c.type === 'string' ? 'VARCHAR(400)' : c.type === 'int' ? 'BIGINT' : 'BIT')

export interface PublisherTarget {
  /** database_ref del store consumidor (debe existir en VERGIS_CONNECTIONS). */
  database_ref: string
  /**
   * Principals (SP/usuario) que deben poder LEER la réplica (RO). El publicador la crea como dueño
   * (RW); a estos se les da `SELECT`. Si publicador==consumidor (mismo SP), no hace falta. Multi-SP: sí.
   */
  consumerPrincipals?: string[]
}

export interface Publisher {
  /** Publica/refresca la proyección `__replica` de una entidad en un target (idempotente: DROP+CREATE). */
  publish(entity: MasterDataEntity, rows: MasterDataRow[], target: PublisherTarget): Promise<void>
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
    const created = new sql.ConnectionPool({
      server: p.server,
      database: p.database,
      port: p.port ?? 1433,
      authentication: { type: 'azure-active-directory-service-principal-secret', options: { tenantId: p.tenantId, clientId: p.clientId, clientSecret: p.clientSecret } },
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: 30000,
      requestTimeout: 120000,
    }).connect()
    pools.set(ref, created)
    return created
  }

  return {
    async publish(entity, rows, target) {
      const t = replicaTable(entity)
      const bare = t.replace(/^dbo\./, '')
      const pk = pkColumn(entity)
      const pool = await getPool(target.database_ref)
      // 1) (re)crear la réplica
      await pool.request().batch(`DROP SECURITY POLICY IF EXISTS [dbo].[secpol_${bare}];`)
      await pool.request().batch(`DROP FUNCTION IF EXISTS [dbo].[fn_pol_${bare}];`)
      await pool.request().batch(`DROP TABLE IF EXISTS ${t};`)
      const colDdl = entity.columns.map((c) => `${c.name} ${ddlType(c)}`).join(', ')
      await pool.request().batch(`CREATE TABLE ${t} (${colDdl});`)
      // 2) insertar filas (bindeadas)
      const names = entity.columns.map((c) => c.name)
      for (const r of rows) {
        const rq = pool.request()
        entity.columns.forEach((c, i) => {
          const v = r[c.name]
          if (v == null) rq.input(`p${i}`, c.type === 'string' ? sql.VarChar : c.type === 'int' ? sql.BigInt : sql.Bit, null)
          else if (c.type === 'bool') rq.input(`p${i}`, sql.Bit, v ? 1 : 0)
          else if (c.type === 'int') rq.input(`p${i}`, sql.BigInt, Number(v))
          else rq.input(`p${i}`, sql.VarChar, String(v))
        })
        await rq.query(`INSERT INTO ${t} (${names.join(',')}) VALUES (${names.map((_, i) => '@p' + i).join(',')})`)
      }
      // 3) SECURITY POLICY allow-all (gate fail-closed; público gobernado)
      await pool.request().batch(`CREATE FUNCTION [dbo].[fn_pol_${bare}](@c VARCHAR(400)) RETURNS TABLE WITH SCHEMABINDING AS RETURN SELECT 1 AS vergis_allowed;`)
      await pool.request().batch(`CREATE SECURITY POLICY [dbo].[secpol_${bare}] ADD FILTER PREDICATE [dbo].[fn_pol_${bare}](${pk.name}) ON ${t} WITH (STATE = ON);`)
      // 4) grants RO: la réplica es read-only para los consumidores (el publicador, dueño, la escribe).
      for (const principal of target.consumerPrincipals ?? []) {
        await pool.request().batch(`GRANT SELECT ON ${t} TO [${principal.replace(/]/g, ']]')}];`)
      }
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
