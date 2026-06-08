// `execute-sql-ch` — Capability de consulta a ClickHouse con INYECCIÓN DE CLAIMS (doc 10 §5).
//
// Es el motor B del compilador (doc 9 §4) en operación: la fuente sin RLS propia se sirve
// desde ClickHouse, que filtra con la ROW POLICY emitida por `@vergis/policy`. Esta Capability
// es la mano que, por cada query, escribe los custom settings `vergis_claim_*` con los claims
// del CONSUMIDOR (que viajan en `identity.claims`, puestos por el gate vía el Botler — el
// consumidor jamás los controla).
//
// Mecanismo canónico (validado por el PoC de Fase 0 + cross-check de Fase 2):
//   - los settings van como QUERY-PARAM HTTP → request-scoped → pooling-safe (no `SET` de sesión);
//   - el claim viaja como VALOR de setting, nunca concatenado al SQL → injection-safe;
//   - sin claim ⇒ setting '' ⇒ el guard `!= ''` de la policy ⇒ 0 filas (default-deny).
//
// `requestSettings` (de @vergis/policy) calcula el mapa setting→valor; acá solo lo transportamos.

import type { Capability, IdentityContext } from '@vergis/botler'
import { requestSettings, settingsForInjections, type ClickHouseEnforcement } from '@vergis/policy'

/** Perfil de conexión a ClickHouse (data-plane de bajo privilegio: SELECT sobre la tabla con policy). */
export interface ClickHouseProfile {
  /** Base URL del HTTP interface, p.ej. `http://localhost:8123`. */
  url: string
  /** Usuario data-plane (el `botler` del PoC): bajo privilegio, default `vergis_claim_*=''`. */
  user: string
  password?: string
  /** Base de datos por defecto de las queries. */
  database?: string
}

/** La query ya resuelta que se manda al transporte: settings = los claims inyectados. */
export interface ChQueryRequest {
  url: string
  user: string
  password?: string
  database?: string
  sql: string
  /** Custom settings request-scoped (`vergis_claim_*`) calculados desde los claims. */
  settings: Record<string, string>
}

export interface ChQueryResult {
  rows: Record<string, unknown>[]
}

/** Seam de transporte HTTP (inyectable para tests herméticos). */
export type ChTransport = (req: ChQueryRequest) => Promise<ChQueryResult>

interface ChParams {
  sql: string
}

/**
 * Transporte por defecto: HTTP interface de ClickHouse. Los settings y el formato van
 * como query-params (request-scoped); el SQL va en el body; credenciales por cabecera.
 */
export const fetchChTransport: ChTransport = async (req) => {
  const u = new URL(req.url)
  if (req.database) u.searchParams.set('database', req.database)
  u.searchParams.set('default_format', 'JSONEachRow')
  // Los claims inyectados: cada uno un query-param → request-scoped, no persiste en la conexión.
  for (const [k, v] of Object.entries(req.settings)) u.searchParams.set(k, v)

  const res = await fetch(u.toString(), {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': req.user,
      ...(req.password ? { 'X-ClickHouse-Key': req.password } : {}),
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: req.sql,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`execute-sql-ch: ClickHouse ${res.status} — ${text.slice(0, 500)}`)
  }
  const rows = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  return { rows }
}

/**
 * Crea la Capability de consulta a ClickHouse con inyección de claims.
 *
 * @param profile     conexión (URL, usuario data-plane de bajo privilegio).
 * @param enforcement el enforcement compilado del spec (specialize-time). Si es `null`
 *                    (PI público), no hay RLS de fila y no se inyecta nada.
 * @param opts.transport seam HTTP (default: fetch). opts.name override del nombre de la Capability.
 */
export function createExecuteSqlClickHouse(
  profile: ClickHouseProfile,
  enforcement: ClickHouseEnforcement | null,
  opts: { transport?: ChTransport; name?: string; injections?: { setting: string; claim: string }[] } = {},
): Capability {
  const transport = opts.transport ?? fetchChTransport
  const name = opts.name ?? 'execute-sql-ch'

  return {
    name,
    async execute(params: unknown, identity: IdentityContext): Promise<ChQueryResult> {
      const p = (params ?? {}) as ChParams
      if (!p.sql) throw new Error(`${name}: falta params.sql`)
      // Inyección request-time: settings = claims del consumidor. `opts.injections` (la UNIÓN de
      // todas las políticas del nodo) permite servir VARIAS tablas por un solo canal; si no, cae
      // al enforcement único. Sin claims → '' → default-deny por el guard de la row policy.
      const settings = opts.injections
        ? settingsForInjections(opts.injections, identity.claims ?? {})
        : enforcement
          ? requestSettings(enforcement, identity.claims ?? {})
          : {}
      return transport({
        url: profile.url,
        user: profile.user,
        password: profile.password,
        database: profile.database,
        sql: p.sql,
        settings,
      })
    },
  }
}
