/**
 * Adquisición de tokens AAD por Service Principal (client-credentials), para recursos NO-SQL —
 * OneLake (ADLS Gen2) y Fabric REST. La auth de Fabric SQL va embebida en `mssql`; estos recursos no
 * la tienen, así que el token se obtiene aquí.
 *
 * CAMINO ROBUSTO, CERO SUPPLY-CHAIN: usa `fetch` nativo contra el endpoint OAuth2 del tenant — sin
 * agregar `@azure/identity` (hoy solo transitivo de mssql) ni `@azure/msal-*`. El repo ya usa `fetch`
 * nativo para HTTP (ClickHouse). El saber/acceso vive en la Capability, no en el Botlet (canon).
 *
 * Cachea el token por SCOPE hasta poco antes de su expiración (margen de 60 s).
 */

export interface SpCreds {
  tenantId: string
  clientId: string
  clientSecret: string
}

export interface TokenProvider {
  /** Token de acceso vigente para el scope (p.ej. `https://storage.azure.com/.default`). */
  getToken(scope: string): Promise<string>
}

interface CacheEntry {
  token: string
  /** epoch ms en que deja de servir (con margen ya descontado). */
  expiresAt: number
}

type FetchLike = typeof fetch
type Clock = () => number

const EXPIRY_MARGIN_MS = 60_000

export function createTokenProvider(creds: SpCreds, opts: { fetch?: FetchLike; now?: Clock } = {}): TokenProvider {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const cache = new Map<string, CacheEntry>()
  // Dedupe de adquisiciones en vuelo por scope: al expirar el token, N requests simultáneas verían el
  // miss y dispararían N POSTs (estampida; AAD throttlea por SP). El `.finally` limpia la entrada tanto
  // en éxito como en fallo → un 5xx transitorio no queda cacheado (no reintroduce el bug del pool).
  const inflight = new Map<string, Promise<CacheEntry>>()
  const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`

  async function fetchToken(scope: string): Promise<CacheEntry> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope,
    })
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000), // sin timeout, un AAD colgado bloquea todo lo que dependa del SP
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`aad-token: fallo al obtener token (${res.status}) para scope '${scope}': ${text.slice(0, 300)}`)
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!json.access_token) throw new Error(`aad-token: respuesta sin access_token para scope '${scope}'.`)
    const ttlMs = (json.expires_in ?? 3600) * 1000
    return { token: json.access_token, expiresAt: now() + ttlMs - EXPIRY_MARGIN_MS }
  }

  return {
    async getToken(scope: string): Promise<string> {
      const hit = cache.get(scope)
      if (hit && hit.expiresAt > now()) return hit.token
      let pending = inflight.get(scope)
      if (!pending) {
        pending = fetchToken(scope).finally(() => inflight.delete(scope))
        inflight.set(scope, pending)
      }
      const fresh = await pending
      cache.set(scope, fresh)
      return fresh.token
    },
  }
}

/** Scopes canónicos de los recursos que toca el intake. */
export const SCOPE_ONELAKE = 'https://storage.azure.com/.default'
export const SCOPE_FABRIC = 'https://api.fabric.microsoft.com/.default'
