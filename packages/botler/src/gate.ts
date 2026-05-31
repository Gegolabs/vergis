// Gate → identidad: traduce las cabeceras que el gate (oauth2-proxy/AAD, doc 8 §7)
// reenvía a un IdentityContext con claims. Es la COSTURA donde el oauth2-proxy real
// se enchufa: el parser es genérico y puro (testeable sin gate), y el deploy solo
// aporta las cabeceras reales. El consumidor nunca las controla — las pone el proxy
// tras autenticar, y el Botler las porta hacia la inyección de RLS (doc 10 §5).

import type { ClaimSet, IdentityContext } from './types'

/** Cabeceras HTTP tal como llegan de Node (`req.headers`): valor o lista. */
export type GateHeaders = Record<string, string | string[] | undefined>

export interface GateMapping {
  /** claim → nombre de cabecera que lo transporta (lista separada por coma). */
  claims: Record<string, string>
  /** Cabecera que trae el identificador del usuario (para `identity.user`). */
  userHeader?: string
  /** Nombre del agente runtime. Default 'vergis'. */
  agent?: string
}

/**
 * Mapeo por defecto: oauth2-proxy reenvía los grupos en `X-Forwarded-Groups`
 * (coma-separados) y el usuario en `X-Forwarded-Email`. El claim `groups` es el
 * que QW-04 declara en `audience.rls`.
 */
export const DEFAULT_GATE_MAPPING: GateMapping = {
  claims: { groups: 'x-forwarded-groups' },
  userHeader: 'x-forwarded-email',
  agent: 'vergis',
}

function headerValue(headers: GateHeaders, name: string): string | undefined {
  // Node normaliza las cabeceras a minúsculas; toleramos cualquier casing igual.
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue
    if (v == null) return undefined
    return Array.isArray(v) ? v.join(',') : v
  }
  return undefined
}

/** Parte un valor de cabecera coma-separado en valores limpios (sin vacíos ni espacios). */
function splitClaim(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Cabeceras del gate → ClaimSet (claim → valores). Ausente/vacío ⇒ claim ausente (default-deny). */
export function claimsFromHeaders(headers: GateHeaders, mapping: GateMapping = DEFAULT_GATE_MAPPING): ClaimSet {
  const claims: ClaimSet = {}
  for (const [claim, header] of Object.entries(mapping.claims)) {
    const values = splitClaim(headerValue(headers, header))
    if (values.length > 0) claims[claim] = values
  }
  return claims
}

/**
 * Cabeceras del gate → IdentityContext completo (agent + user + claims). Es lo que
 * el driver per-request (server, doc) construye por consumidor antes de invocar al Botlet.
 */
export function identityFromHeaders(headers: GateHeaders, mapping: GateMapping = DEFAULT_GATE_MAPPING): IdentityContext {
  const identity: IdentityContext = { agent: mapping.agent ?? 'vergis' }
  const user = mapping.userHeader ? headerValue(headers, mapping.userHeader) : undefined
  if (user) identity.user = user
  const claims = claimsFromHeaders(headers, mapping)
  if (Object.keys(claims).length > 0) identity.claims = claims
  return identity
}
