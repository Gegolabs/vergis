import { describe, it, expect } from 'vitest'
import { createTokenProvider } from '@vergis/capabilities'

function fakeFetch(calls: { url: string; body: string }[], token = 'TOK', expiresIn = 3600) {
  return (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: token, expires_in: expiresIn }),
      text: async () => '',
    } as unknown as Response
  }) as unknown as typeof fetch
}

describe('aad-token · client-credentials con caché', () => {
  it('obtiene token y arma el body correcto (client_credentials + scope)', async () => {
    const calls: { url: string; body: string }[] = []
    const tp = createTokenProvider({ tenantId: 'TEN', clientId: 'CID', clientSecret: 'SEC' }, { fetch: fakeFetch(calls), now: () => 0 })
    const tok = await tp.getToken('https://storage.azure.com/.default')
    expect(tok).toBe('TOK')
    expect(calls[0].url).toContain('/TEN/oauth2/v2.0/token')
    expect(calls[0].body).toContain('grant_type=client_credentials')
    expect(calls[0].body).toContain('client_id=CID')
    expect(calls[0].body).toContain('scope=https%3A%2F%2Fstorage.azure.com%2F.default')
  })

  it('cachea por scope mientras no expira; refetch tras expiración', async () => {
    const calls: { url: string; body: string }[] = []
    let t = 0
    const tp = createTokenProvider({ tenantId: 'T', clientId: 'C', clientSecret: 'S' }, { fetch: fakeFetch(calls, 'TOK', 3600), now: () => t })
    await tp.getToken('scopeA')
    await tp.getToken('scopeA') // dentro de TTL → cache
    expect(calls).toHaveLength(1)
    await tp.getToken('scopeB') // otro scope → nuevo fetch
    expect(calls).toHaveLength(2)
    t = 3600_000 // pasó el TTL (con margen) → refetch
    await tp.getToken('scopeA')
    expect(calls).toHaveLength(3)
  })

  it('error HTTP → throw accionable', async () => {
    const failing = (async () => ({ ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch
    const tp = createTokenProvider({ tenantId: 'T', clientId: 'C', clientSecret: 'S' }, { fetch: failing, now: () => 0 })
    await expect(tp.getToken('s')).rejects.toThrow(/401/)
  })
})
