/**
 * PUERTO DE CREDENCIAL (issue #66) — una sola fuente de token para todo lo que habla con Azure/Fabric,
 * con implementaciones intercambiables: `secret` (client-credentials con clientSecret, el default),
 * `federated` (workload identity federation: client_assertion desde un archivo que rota) e `imds`
 * (managed identity de la VM). El modo se declara POR PERFIL (`auth`), nunca se autodetecta.
 *
 * Dos formas de consumo, una sola fuente de decisión: `getToken(scope)` para los recursos REST
 * (OneLake ADLS Gen2, Fabric REST, o el scope que anuncie un SQL endpoint vía fedAuthInfo) y
 * `sqlAuth()` para el `authentication` del driver mssql.
 *
 * CAMINO ROBUSTO, CERO SUPPLY-CHAIN: `fetch` nativo contra el endpoint OAuth2 del tenant y contra el
 * IMDS — sin agregar `@azure/identity` (hoy solo transitivo de mssql) ni `@azure/msal-*`. El
 * adaptador a `TokenCredential` de los modos passwordless satisface el duck-typing de
 * `@azure/core-auth` (solo exige `getToken`) sin importar nada. El saber/acceso vive en la
 * Capability, no en el Botlet (canon); los endpoints de nube viven en las implementaciones.
 *
 * El provider CACHEA por scope hasta poco antes de la expiración (margen de 60 s) con dedupe de
 * adquisiciones en vuelo — los callers jamás cachean.
 */

import type { config as MssqlConfig } from 'mssql' // import type-only: se borra al compilar

/** Token de acceso vigente. `expiresAt` = epoch ms con el margen (60 s) YA descontado. */
export interface AccessToken {
  token: string
  expiresAt: number
}

/** El objeto `authentication` del driver mssql (unión de tedious; incluye 'token-credential'). */
export type SqlAuth = NonNullable<MssqlConfig['authentication']>

/**
 * PUERTO de credencial: una sola fuente de token, implementaciones intercambiables.
 * `getToken` sirve cualquier scope AAD; `sqlAuth` entrega la config de auth del driver mssql.
 */
export interface CredentialProvider {
  getToken(scope: string): Promise<AccessToken>
  sqlAuth(): SqlAuth
}

/** Vista angosta para consumidores que solo necesitan bearer (intake, jobs, engine). */
export type TokenSource = Pick<CredentialProvider, 'getToken'>

export type AuthMode = 'secret' | 'federated' | 'imds'

const AUTH_MODES: readonly AuthMode[] = ['secret', 'federated', 'imds']

/** Campos de credencial de un perfil. `auth` ausente ⇒ 'secret' (compat con la config viva). */
export interface CredentialSource {
  auth?: AuthMode
  tenantId?: string
  clientId?: string
  clientSecret?: string
  /** Modo federated: ruta del archivo con el token OIDC (default: env AZURE_FEDERATED_TOKEN_FILE). */
  federatedTokenFile?: string
}

export interface CredentialProviderOpts {
  fetch?: typeof fetch
  now?: () => number
  /** Lectura del archivo federado (inyectable en tests). Default: node:fs/promises readFile utf8. */
  readFile?: (path: string) => Promise<string>
  /** Env para resolver AZURE_FEDERATED_TOKEN_FILE (inyectable). Default: process.env. */
  env?: Record<string, string | undefined>
  /** Etiqueta para mensajes de error (p. ej. "database_ref 'dwh'"). */
  label?: string
}

type FetchLike = typeof fetch
type Clock = () => number

const EXPIRY_MARGIN_MS = 60_000
const ACQUIRE_TIMEOUT_MS = 15_000
const IMDS_ENDPOINT = 'http://169.254.169.254/metadata/identity/oauth2/token'
const IMDS_API_VERSION = '2018-02-01'

/** `src.auth ?? 'secret'`; lanza si `auth` trae un string desconocido. */
export function resolveAuthMode(src: CredentialSource, label?: string): AuthMode {
  const raw = src.auth
  if (raw === undefined || raw === null) return 'secret'
  if ((AUTH_MODES as readonly string[]).includes(raw)) return raw
  throw new Error(`${prefix(label)}modo de autenticación desconocido '${String(raw)}' (válidos: ${AUTH_MODES.join(' | ')}).`)
}

function prefix(label?: string): string {
  return `credencial${label ? ` (${label})` : ''}: `
}

function requireField(src: CredentialSource, field: 'tenantId' | 'clientId' | 'clientSecret', mode: AuthMode, label?: string): string {
  const v = src[field]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${prefix(label)}modo '${mode}' requiere ${field}.`)
  }
  return v
}

/**
 * Núcleo común a los tres modos: caché por scope + dedupe in-flight + margen de expiración.
 * `acquire` es lo único que cambia entre modos.
 */
function cachingProvider(
  acquire: (scope: string) => Promise<AccessToken>,
  sqlAuth: () => SqlAuth,
  now: Clock,
): CredentialProvider {
  const cache = new Map<string, AccessToken>()
  // Dedupe de adquisiciones en vuelo por scope: al expirar el token, N requests simultáneas verían el
  // miss y dispararían N POSTs (estampida; AAD throttlea por SP). El `.finally` limpia la entrada tanto
  // en éxito como en fallo → un 5xx transitorio no queda cacheado (no reintroduce el bug del pool).
  const inflight = new Map<string, Promise<AccessToken>>()

  return {
    async getToken(scope: string): Promise<AccessToken> {
      const hit = cache.get(scope)
      if (hit && hit.expiresAt > now()) return hit
      let pending = inflight.get(scope)
      if (!pending) {
        pending = acquire(scope).finally(() => inflight.delete(scope))
        inflight.set(scope, pending)
      }
      const fresh = await pending
      cache.set(scope, fresh)
      return fresh
    },
    sqlAuth,
  }
}

/** Respuesta común de AAD y del IMDS (el IMDS puede mandar `expires_in` como string). */
function toAccessToken(json: { access_token?: string; expires_in?: number | string }, scope: string, now: Clock, who: string): AccessToken {
  if (!json.access_token) throw new Error(`${who}: respuesta sin access_token para scope '${scope}'.`)
  const parsed = Number(json.expires_in)
  const ttlSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 3600
  return { token: json.access_token, expiresAt: now() + ttlSec * 1000 - EXPIRY_MARGIN_MS }
}

/** POST al endpoint OAuth2 del tenant. Compartido por los modos `secret` y `federated`. */
async function postToAad(
  doFetch: FetchLike,
  tenantId: string,
  body: URLSearchParams,
  scope: string,
  now: Clock,
): Promise<AccessToken> {
  const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`
  const res = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(ACQUIRE_TIMEOUT_MS), // sin timeout, un AAD colgado bloquea todo lo que dependa del SP
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`aad-token: fallo al obtener token (${res.status}) para scope '${scope}': ${text.slice(0, 300)}`)
  }
  return toAccessToken((await res.json()) as { access_token?: string; expires_in?: number }, scope, now, 'aad-token')
}

/**
 * `resource` del IMDS = el scope sin el sufijo `.default`, conservando la barra
 * (`https://storage.azure.com/.default` → `https://storage.azure.com/`).
 */
function scopeToResource(scope: string): string {
  const suffix = '.default'
  return scope.endsWith('/.default') ? scope.slice(0, scope.length - suffix.length) : scope
}

/**
 * Adaptador al duck-type `TokenCredential` de `@azure/core-auth` (verificado: solo exige `getToken`;
 * tedious usa únicamente `.token` del resultado). Puentea el driver mssql a la MISMA caché del puerto.
 */
function tokenCredentialAdapter(getToken: (scope: string) => Promise<AccessToken>): { getToken: (scopes: string | string[]) => Promise<{ token: string; expiresOnTimestamp: number }> } {
  return {
    getToken: async (scopes: string | string[]) => {
      const scope = Array.isArray(scopes) ? scopes[0] : scopes
      const t = await getToken(scope)
      return { token: t.token, expiresOnTimestamp: t.expiresAt }
    },
  }
}

/**
 * Construye el provider del perfil. Valida el modo y sus campos EAGER (fail-closed): un perfil
 * irresoluble lanza acá, antes de cualquier IO — no se hace red ni disco al construir (el archivo
 * federado se lee en cada adquisición, porque rota). Nunca imprime valores de secretos.
 */
export function credentialProviderFor(src: CredentialSource, opts: CredentialProviderOpts = {}): CredentialProvider {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const env = opts.env ?? process.env
  const label = opts.label
  const mode = resolveAuthMode(src, label)

  if (mode === 'secret') {
    const tenantId = requireField(src, 'tenantId', mode, label)
    const clientId = requireField(src, 'clientId', mode, label)
    const clientSecret = requireField(src, 'clientSecret', mode, label)
    const acquire = (scope: string): Promise<AccessToken> =>
      postToAad(doFetch, tenantId, new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope,
      }), scope, now)
    // El wire del modo default es IDÉNTICO al de producción antes de #66: cero riesgo de regresión.
    const sqlAuth = (): SqlAuth => ({
      type: 'azure-active-directory-service-principal-secret',
      options: { tenantId, clientId, clientSecret },
    })
    return cachingProvider(acquire, sqlAuth, now)
  }

  if (mode === 'federated') {
    const tenantId = requireField(src, 'tenantId', mode, label)
    const clientId = requireField(src, 'clientId', mode, label)
    const tokenFile = src.federatedTokenFile ?? env.AZURE_FEDERATED_TOKEN_FILE
    if (!tokenFile) {
      throw new Error(`${prefix(label)}modo 'federated' requiere federatedTokenFile (o la env AZURE_FEDERATED_TOKEN_FILE).`)
    }
    const readFile = opts.readFile ?? (async (p: string) => (await import('node:fs/promises')).readFile(p, 'utf8'))
    const acquire = async (scope: string): Promise<AccessToken> => {
      // Se RE-LEE en cada adquisición: el token federado rota (lo reescribe el proyector del cluster).
      let assertion: string
      try {
        assertion = (await readFile(tokenFile)).trim()
      } catch (e) {
        throw new Error(`${prefix(label)}modo 'federated': no se pudo leer el token file '${tokenFile}': ${(e as Error).message}`)
      }
      if (!assertion) throw new Error(`${prefix(label)}modo 'federated': el token file '${tokenFile}' está vacío.`)
      return postToAad(doFetch, tenantId, new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        scope,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      }), scope, now)
    }
    const provider: CredentialProvider = cachingProvider(
      acquire,
      () => ({ type: 'token-credential', options: { credential: tokenCredentialAdapter((s) => provider.getToken(s)) } }),
      now,
    )
    return provider
  }

  // mode === 'imds': nada obligatorio; `clientId` opcional para user-assigned MI.
  const clientId = src.clientId
  const acquire = async (scope: string): Promise<AccessToken> => {
    // El host del IMDS es fijo por contrato de la nube (no configurable por perfil).
    const url = new URL(IMDS_ENDPOINT)
    url.searchParams.set('api-version', IMDS_API_VERSION)
    url.searchParams.set('resource', scopeToResource(scope))
    if (clientId) url.searchParams.set('client_id', clientId)
    const res = await doFetch(url.toString(), {
      method: 'GET',
      headers: { Metadata: 'true' },
      signal: AbortSignal.timeout(ACQUIRE_TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${prefix(label)}imds: fallo al obtener token (${res.status}) para scope '${scope}': ${text.slice(0, 300)}`)
    }
    return toAccessToken((await res.json()) as { access_token?: string; expires_in?: number | string }, scope, now, 'imds')
  }
  const provider: CredentialProvider = cachingProvider(
    acquire,
    () => ({ type: 'token-credential', options: { credential: tokenCredentialAdapter((s) => provider.getToken(s)) } }),
    now,
  )
  return provider
}

/** Scopes canónicos de los recursos que toca el intake. */
export const SCOPE_ONELAKE = 'https://storage.azure.com/.default'
export const SCOPE_FABRIC = 'https://api.fabric.microsoft.com/.default'
