import sql from 'mssql'
import type { Capability } from '@vergis/botler'

/**
 * Perfil de conexión a un DWH/SQL endpoint. El spec del Botlet solo referencia
 * `database_ref`; las credenciales viven aquí (el saber/acceso vive en la Capability,
 * no en el Botlet — canon). Para Fabric: autenticación por Service Principal.
 */
export interface SqlConnectionProfile {
  server: string
  database: string
  tenantId: string
  clientId: string
  clientSecret: string
  port?: number
}

interface SqlParams {
  database_ref: string
  sql: string
}

/**
 * `execute-sql-dwh` — Capability cloud-resident, online-only. Reemplaza el stub
 * `static-data` de v0.1. Ejecuta SQL contra un Fabric SQL endpoint vía mssql + SP.
 * (Patrón de conexión validado en scripts/check-tables.mjs.)
 */
export function createExecuteSqlDwh(profiles: Record<string, SqlConnectionProfile>): Capability {
  const pools = new Map<string, Promise<sql.ConnectionPool>>()

  function getPool(ref: string): Promise<sql.ConnectionPool> {
    const existing = pools.get(ref)
    if (existing) return existing
    const profile = profiles[ref]
    if (!profile) {
      throw new Error(`execute-sql-dwh: database_ref '${ref}' no está configurado en los perfiles de conexión.`)
    }
    const cfg: sql.config = {
      server: profile.server,
      database: profile.database,
      port: profile.port ?? 1433,
      authentication: {
        type: 'azure-active-directory-service-principal-secret',
        options: {
          tenantId: profile.tenantId,
          clientId: profile.clientId,
          clientSecret: profile.clientSecret,
        },
      },
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: 30000,
      requestTimeout: 60000,
    }
    const created = new sql.ConnectionPool(cfg).connect()
    pools.set(ref, created)
    return created
  }

  return {
    name: 'execute-sql-dwh',
    async execute(params: unknown): Promise<unknown> {
      const p = (params ?? {}) as SqlParams
      if (!p.database_ref) throw new Error('execute-sql-dwh: falta params.database_ref')
      if (!p.sql) throw new Error('execute-sql-dwh: falta params.sql')
      const pool = await getPool(p.database_ref)
      const result = await pool.request().query(p.sql)
      return { rows: result.recordset ?? [] }
    },
    async close(): Promise<void> {
      for (const pool of pools.values()) {
        try {
          ;(await pool).close()
        } catch {
          /* noop */
        }
      }
      pools.clear()
    },
  } as Capability & { close(): Promise<void> }
}
