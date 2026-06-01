import sql from 'mssql'
import type { Capability, IdentityContext } from '@vergis/botler'
import { sessionContextPrelude } from '@vergis/policy'

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

/** Opciones de enforcing (motor C, push-down). */
export interface ExecuteSqlDwhOptions {
  /**
   * Inyecciones del nodo (setting↔claim), de la UNIÓN de las políticas push-down compiladas
   * (`FabricEnforcement.injections`). Si se proveen, la Capability pasa a **enforcing**: ante cada
   * query reinyecta TODAS las settings vía `sp_set_session_context` (las de claim ausente con '')
   * → la RLS nativa de Fabric filtra por consumidor. Si se omite, modo plano (ej. ingesta-desde-fuente).
   */
  injections?: { setting: string; claim: string }[]
  /** Override del nombre de la Capability. */
  name?: string
}

/**
 * `execute-sql-dwh` — Capability cloud-resident, online-only. Ejecuta SQL contra un Fabric SQL
 * endpoint (o Azure SQL) vía mssql + Service Principal.
 *
 * MOTOR C (push-down, doc 9 §4): cuando se le pasan `injections`, opera **enforcing** — antes de
 * cada query reinyecta los claims del consumidor con `sp_set_session_context`, y la SECURITY POLICY
 * nativa de la fuente (emitida por `@vergis/policy`/`compileFabric`) filtra las filas. El consumidor
 * jamás controla los claims (vienen de `identity.claims`, puestos por el gate vía el Botler).
 *
 * SEGURIDAD (doc 10 §5): SESSION_CONTEXT persiste en la conexión → con pool, fuga entre consumidores.
 * Por eso se reinyecta el set COMPLETO en cada request (claim ausente → '' → guard `<> ''` de la
 * policy → default-deny), sobreescribiendo cualquier residuo. El VALOR del claim viaja PARAMETRIZADO
 * (`@vergis_sc_N`), nunca concatenado al SQL → injection-safe.
 */
export function createExecuteSqlDwh(
  profiles: Record<string, SqlConnectionProfile>,
  opts: ExecuteSqlDwhOptions = {},
): Capability {
  const pools = new Map<string, Promise<sql.ConnectionPool>>()
  const name = opts.name ?? 'execute-sql-dwh'

  function getPool(ref: string): Promise<sql.ConnectionPool> {
    const existing = pools.get(ref)
    if (existing) return existing
    const profile = profiles[ref]
    if (!profile) {
      throw new Error(`${name}: database_ref '${ref}' no está configurado en los perfiles de conexión.`)
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
    name,
    async execute(params: unknown, identity: IdentityContext): Promise<unknown> {
      const p = (params ?? {}) as SqlParams
      if (!p.database_ref) throw new Error(`${name}: falta params.database_ref`)
      if (!p.sql) throw new Error(`${name}: falta params.sql`)
      const pool = await getPool(p.database_ref)
      const request = pool.request()

      // Enforcing (push-down): prepende la inyección de claims request-scoped. Reinyectar el set
      // COMPLETO en cada request neutraliza la persistencia de SESSION_CONTEXT en el pool.
      let text = p.sql
      if (opts.injections && opts.injections.length > 0) {
        const prelude = sessionContextPrelude(opts.injections, identity?.claims ?? {})
        for (const { name: pname, value } of prelude.params) {
          request.input(pname, sql.NVarChar, value)
        }
        text = `${prelude.sql}\n${p.sql}`
      }

      // Los `EXEC sp_set_session_context` no emiten result set → el único recordset es el de la
      // query final, igual que en el modo plano.
      const result = await request.query(text)
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
