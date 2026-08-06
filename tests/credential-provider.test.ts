import { describe, it, expect } from 'vitest'
import { credentialProviderFor, resolveAuthMode, type CredentialSource } from '@vergis/capabilities'

interface Call { url: string; body: string; headers: Record<string, string>; method: string }

function fakeFetch(calls: Call[], token = 'TOK', expiresIn: number | string = 3600) {
  return (async (url: string, init?: { body?: string; headers?: Record<string, string>; method?: string }) => {
    calls.push({ url: String(url), body: String(init?.body ?? ''), headers: init?.headers ?? {}, method: init?.method ?? 'GET' })
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: token, expires_in: expiresIn }),
      text: async () => '',
    } as unknown as Response
  }) as unknown as typeof fetch
}

const SECRET: CredentialSource = { tenantId: 'TEN', clientId: 'CID', clientSecret: 'SEC' }

// ─── Modo secret (default): el comportamiento probado, ahora devolviendo AccessToken ─────────
describe('credential-provider · modo secret (default)', () => {
  it('obtiene token y arma el body correcto (client_credentials + scope)', async () => {
    const calls: Call[] = []
    const cp = credentialProviderFor(SECRET, { fetch: fakeFetch(calls), now: () => 0 })
    const tok = await cp.getToken('https://storage.azure.com/.default')
    expect(tok.token).toBe('TOK')
    expect(tok.expiresAt).toBe(3600_000 - 60_000) // TTL menos el margen
    expect(calls[0].url).toContain('/TEN/oauth2/v2.0/token')
    expect(calls[0].body).toContain('grant_type=client_credentials')
    expect(calls[0].body).toContain('client_id=CID')
    expect(calls[0].body).toContain('client_secret=SEC')
    expect(calls[0].body).toContain('scope=https%3A%2F%2Fstorage.azure.com%2F.default')
  })

  it('cachea por scope mientras no expira; refetch tras expiración', async () => {
    const calls: Call[] = []
    let t = 0
    const cp = credentialProviderFor({ tenantId: 'T', clientId: 'C', clientSecret: 'S' }, { fetch: fakeFetch(calls), now: () => t })
    await cp.getToken('scopeA')
    await cp.getToken('scopeA') // dentro de TTL → cache
    expect(calls).toHaveLength(1)
    await cp.getToken('scopeB') // otro scope → nuevo fetch
    expect(calls).toHaveLength(2)
    t = 3600_000 // pasó el TTL (con margen) → refetch
    await cp.getToken('scopeA')
    expect(calls).toHaveLength(3)
  })

  it('error HTTP → throw accionable', async () => {
    const failing = (async () => ({ ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch
    const cp = credentialProviderFor({ tenantId: 'T', clientId: 'C', clientSecret: 'S' }, { fetch: failing, now: () => 0 })
    await expect(cp.getToken('s')).rejects.toThrow(/401/)
  })
})

// ─── Modo federated: client_assertion desde un archivo que ROTA ──────────────────────────────
describe('credential-provider · modo federated', () => {
  const src: CredentialSource = { auth: 'federated', tenantId: 'TEN', clientId: 'CID', federatedTokenFile: '/var/run/secrets/token' }

  it('manda client_assertion (y NADA de client_secret)', async () => {
    const calls: Call[] = []
    const cp = credentialProviderFor(src, { fetch: fakeFetch(calls), now: () => 0, readFile: async () => 'JWT-A\n' })
    const tok = await cp.getToken('https://api.fabric.microsoft.com/.default')
    expect(tok.token).toBe('TOK')
    expect(calls[0].url).toContain('/TEN/oauth2/v2.0/token')
    expect(calls[0].body).toContain('client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer')
    expect(calls[0].body).toContain('client_assertion=JWT-A') // .trim() aplicado
    expect(calls[0].body).not.toContain('client_secret')
  })

  it('re-lee el archivo en cada adquisición (el token rota)', async () => {
    const calls: Call[] = []
    let t = 0
    let contenido = 'JWT-A'
    const cp = credentialProviderFor(src, { fetch: fakeFetch(calls), now: () => t, readFile: async () => contenido })
    await cp.getToken('s')
    expect(calls[0].body).toContain('client_assertion=JWT-A')
    contenido = 'JWT-B'
    t = 3600_000 // expiró → nueva adquisición → nueva lectura
    await cp.getToken('s')
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toContain('client_assertion=JWT-B')
  })

  it('archivo vacío al adquirir → throw con la ruta', async () => {
    const cp = credentialProviderFor(src, { fetch: fakeFetch([]), now: () => 0, readFile: async () => '  \n' })
    await expect(cp.getToken('s')).rejects.toThrow(/\/var\/run\/secrets\/token.*vac/)
  })

  it('sin federatedTokenFile ni env → falla al CONSTRUIR (fail-closed eager)', () => {
    expect(() => credentialProviderFor({ auth: 'federated', tenantId: 'T', clientId: 'C' }, { env: {} })).toThrow(/AZURE_FEDERATED_TOKEN_FILE/)
  })

  it('resuelve el archivo desde la env AZURE_FEDERATED_TOKEN_FILE', async () => {
    const calls: Call[] = []
    const cp = credentialProviderFor({ auth: 'federated', tenantId: 'T', clientId: 'C' }, {
      fetch: fakeFetch(calls), now: () => 0, env: { AZURE_FEDERATED_TOKEN_FILE: '/env/token' }, readFile: async (p) => `JWT-${p}`,
    })
    await cp.getToken('s')
    expect(calls[0].body).toContain('client_assertion=JWT-%2Fenv%2Ftoken')
  })
})

// ─── Modo imds: managed identity de la VM ────────────────────────────────────────────────────
describe('credential-provider · modo imds', () => {
  it('arma la URL del IMDS con resource derivado del scope y el header Metadata', async () => {
    const calls: Call[] = []
    const cp = credentialProviderFor({ auth: 'imds' }, { fetch: fakeFetch(calls), now: () => 0 })
    const tok = await cp.getToken('https://storage.azure.com/.default')
    expect(tok.token).toBe('TOK')
    expect(calls[0].url).toContain('169.254.169.254/metadata/identity/oauth2/token')
    expect(calls[0].url).toContain('api-version=2018-02-01')
    expect(calls[0].url).toContain('resource=https%3A%2F%2Fstorage.azure.com%2F') // sin '.default', con la barra
    expect(calls[0].headers['Metadata']).toBe('true')
    expect(calls[0].url).not.toContain('client_id') // system-assigned: sin clientId
  })

  it('incluye client_id solo si el perfil lo trae (user-assigned MI)', async () => {
    const calls: Call[] = []
    const cp = credentialProviderFor({ auth: 'imds', clientId: 'UAMI' }, { fetch: fakeFetch(calls), now: () => 0 })
    await cp.getToken('https://api.fabric.microsoft.com/.default')
    expect(calls[0].url).toContain('client_id=UAMI')
  })

  it('expires_in como STRING parsea bien', async () => {
    const cp = credentialProviderFor({ auth: 'imds' }, { fetch: fakeFetch([], 'TOK', '3600'), now: () => 0 })
    const tok = await cp.getToken('s')
    expect(tok.expiresAt).toBe(3600_000 - 60_000)
  })
})

// ─── Selección de modo y fail-closed ─────────────────────────────────────────────────────────
describe('credential-provider · selección de modo y fail-closed', () => {
  it('perfil sin `auth` y con secret → modo secret', () => {
    expect(resolveAuthMode(SECRET)).toBe('secret')
    expect(credentialProviderFor(SECRET).sqlAuth().type).toBe('azure-active-directory-service-principal-secret')
  })

  it('perfil sin `auth` y sin clientSecret → throw nombrando label, modo y campo', () => {
    expect(() => credentialProviderFor({ tenantId: 'T', clientId: 'C' }, { label: "database_ref 'dwh'" }))
      .toThrow("credencial (database_ref 'dwh'): modo 'secret' requiere clientSecret.")
  })

  it("auth 'imds' sin tenant/clientId/secret → construye OK", () => {
    expect(() => credentialProviderFor({ auth: 'imds' })).not.toThrow()
  })

  it("auth 'zzz' → throw", () => {
    expect(() => credentialProviderFor({ auth: 'zzz' } as unknown as CredentialSource)).toThrow(/desconocido/)
  })

  it('no filtra el valor del secreto en los mensajes de error', () => {
    try {
      credentialProviderFor({ auth: 'federated', tenantId: 'T', clientSecret: 'SUPERSECRETO' }, { env: {} })
      expect.unreachable('debió lanzar')
    } catch (e) {
      expect((e as Error).message).not.toContain('SUPERSECRETO')
    }
  })
})

// ─── sqlAuth(): el wire del driver mssql ─────────────────────────────────────────────────────
describe('credential-provider · sqlAuth', () => {
  it('modo secret → el objeto nativo de tedious, idéntico al wire actual de producción', () => {
    expect(credentialProviderFor(SECRET).sqlAuth()).toEqual({
      type: 'azure-active-directory-service-principal-secret',
      options: { tenantId: 'TEN', clientId: 'CID', clientSecret: 'SEC' },
    })
  })

  it('modo imds → token-credential cuyo adaptador puentea a la MISMA caché del puerto', async () => {
    const calls: Call[] = []
    const cp = credentialProviderFor({ auth: 'imds' }, { fetch: fakeFetch(calls), now: () => 0 })
    const auth = cp.sqlAuth()
    expect(auth.type).toBe('token-credential')
    const credential = (auth as { options: { credential: { getToken(s: string | string[]): Promise<{ token: string; expiresOnTimestamp: number }> } } }).options.credential
    const a = await credential.getToken('https://database.windows.net/.default')
    expect(a).toEqual({ token: 'TOK', expiresOnTimestamp: 3600_000 - 60_000 })
    // El array (forma que usa @azure/core-auth) toma el primer scope; y la segunda llamada
    // no dispara otro fetch → prueba que comparte la caché del puerto.
    const b = await credential.getToken(['https://database.windows.net/.default'])
    expect(b).toEqual(a)
    expect(calls).toHaveLength(1)
  })

  it('modo federated → token-credential', () => {
    const cp = credentialProviderFor({ auth: 'federated', tenantId: 'T', clientId: 'C', federatedTokenFile: '/f' }, { readFile: async () => 'J' })
    expect(cp.sqlAuth().type).toBe('token-credential')
  })
})
