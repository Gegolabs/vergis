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

/** `{ email → { claim: valor(es) } }` — trust-base producido por un proceso admin (reconciliación AAD↔directorio). */
export type IdentityMap = Record<string, Record<string, string | string[]>>

export interface IdentityResolver {
  identityFor(headers: GateHeaders): IdentityContext
}

export function createIdentity(gateClaims: Record<string, string>, identityMap: IdentityMap | null): IdentityResolver {
  // Las cabeceras del gate vienen latin1 → re-decodificar para acentos ("Producción").
  const mapping = { ...DEFAULT_GATE_MAPPING, claims: gateClaims, decodeUtf8: true }

  function identityFor(headers: GateHeaders): IdentityContext {
    const identity = identityFromHeaders(headers, mapping)
    if (!identityMap || !identity.user) return identity
    const extra = identityMap[identity.user.toLowerCase()]
    if (!extra) return identity // no mapeado → sin claim del directorio → default-deny
    const claims: ClaimSet = { ...(identity.claims ?? {}) }
    for (const [c, v] of Object.entries(extra)) claims[c] = Array.isArray(v) ? v.map(String) : [String(v)]
    return { ...identity, claims }
  }

  return { identityFor }
}
