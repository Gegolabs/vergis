/**
 * Resolución de IDENTIDAD del servidor RLS — módulo del refactor createApp() (A14).
 *
 * Cabeceras del gate (oauth2-proxy) → identidad + claims, enriquecidos desde un DIRECTORIO
 * (IdentityMap) cuando el claim del criterio no viaja en la cabecera sino que se deriva de la
 * identidad autenticada (p.ej. el ÁREA del viewer a partir de su email). Fail-closed: email no
 * mapeado → sin claim del directorio → default-deny.
 *
 * Puro e inyectable (se le pasan gateClaims + identityMap ya parseados) → testeable sin server.
 */
import { identityFromHeaders, DEFAULT_GATE_MAPPING, type ClaimSet, type GateHeaders, type IdentityContext } from '@vergis/botler'
import type { DevIdentity } from './config'

/** `{ email → { claim: valor(es) } }` — trust-base producido por un proceso admin (reconciliación AAD↔directorio). */
export type IdentityMap = Record<string, Record<string, string | string[]>>

export interface IdentityResolver {
  identityFor(headers: GateHeaders): IdentityContext
}

export function createIdentity(
  gateClaims: Record<string, string>,
  identityMap: IdentityMap | null,
  devIdentity: DevIdentity | null = null,
): IdentityResolver {
  // Las cabeceras del gate vienen latin1 → re-decodificar para acentos ("Producción").
  const mapping = { ...DEFAULT_GATE_MAPPING, claims: gateClaims, decodeUtf8: true }

  function identityFor(headers: GateHeaders): IdentityContext {
    const identity = identityFromHeaders(headers, mapping)
    // DEV IDENTITY (fail-safe — `decideDevIdentity` en ./config garantiza que `devIdentity` es null
    // ante gate real): si NO llegó ningún header de gate (browser local sin oauth2-proxy → sin user
    // ni claims) y hay identidad de dev, se inyecta. Con CUALQUIER header de gate presente, el header
    // MANDA — permite probar 403/otras identidades por curl exactamente como hoy.
    if (devIdentity && !identity.user && !identity.claims) {
      const claims = Object.keys(devIdentity.claims).length ? { ...devIdentity.claims } : undefined
      const injected: IdentityContext = { agent: identity.agent, user: devIdentity.user }
      if (claims) injected.claims = claims
      return enrichFromMap(injected, identityMap)
    }
    return enrichFromMap(identity, identityMap)
  }

  return { identityFor }
}

/** Enriquece la identidad con los claims del directorio (IdentityMap) por email. Fail-closed. */
function enrichFromMap(identity: IdentityContext, identityMap: IdentityMap | null): IdentityContext {
  if (!identityMap || !identity.user) return identity
  const extra = identityMap[identity.user.toLowerCase()]
  if (!extra) return identity // no mapeado → sin claim del directorio → default-deny
  const claims: ClaimSet = { ...(identity.claims ?? {}) }
  for (const [c, v] of Object.entries(extra)) claims[c] = Array.isArray(v) ? v.map(String) : [String(v)]
  return { ...identity, claims }
}
