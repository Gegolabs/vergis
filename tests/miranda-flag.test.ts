import { describe, it, expect, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { configFromEnv, parsePreviewIdentities } from '../server/config'
import { createRequestHandler, type RouteDeps } from '../server/routes'
import type { Report } from '../server/discovery'

const fixedSecret = () => 'S'

describe('config · Miranda tras el flag', () => {
  it('flag apagado (default) → miranda.enabled=false y sin key obligatoria', () => {
    const c = configFromEnv({}, fixedSecret)
    expect(c.miranda.enabled).toBe(false)
    expect(c.miranda.model).toBe('claude-sonnet-5')
    expect(c.miranda.maxTurns).toBe(40)
    expect(c.miranda.tokenBudget).toBe(500_000)
    expect(c.miranda.scopeGroup).toBe('miranda')
  })
  it('flag encendido SIN key → aborta con error claro', () => {
    expect(() => configFromEnv({ MIRANDA_ENABLED: '1' }, fixedSecret)).toThrow(/ANTHROPIC_API_KEY/)
  })
  it('flag encendido CON key → OK, envs overridables', () => {
    const c = configFromEnv({ MIRANDA_ENABLED: 'on', ANTHROPIC_API_KEY: 'sk-x', MIRANDA_MODEL: 'claude-opus-5', MIRANDA_MAX_TURNS: '20' }, fixedSecret)
    expect(c.miranda.enabled).toBe(true)
    expect(c.miranda.apiKey).toBe('sk-x')
    expect(c.miranda.model).toBe('claude-opus-5')
    expect(c.miranda.maxTurns).toBe(20)
  })
})

// #110·1 — el ROSTER de identidades inspeccionables en preview. Sin la env, la feature no existe;
// con ella, un roster inválido debe abortar el arranque en vez de degradar a una feature a medias.
describe('config · roster de preview (MIRANDA_PREVIEW_IDENTITIES)', () => {
  const ON = { MIRANDA_ENABLED: '1', ANTHROPIC_API_KEY: 'sk-x' }
  it('sin la env → previewIdentitiesPath undefined (superficie cero)', () => {
    expect(configFromEnv(ON, fixedSecret).miranda.previewIdentitiesPath).toBeUndefined()
  })
  it('con la env y Miranda ON → la ruta viaja al server', () => {
    const c = configFromEnv({ ...ON, MIRANDA_PREVIEW_IDENTITIES: '/etc/vergis/roster.json' }, fixedSecret)
    expect(c.miranda.previewIdentitiesPath).toBe('/etc/vergis/roster.json')
  })
  it('con Miranda OFF la env se IGNORA (la feature no puede existir sin Miranda)', () => {
    const c = configFromEnv({ MIRANDA_PREVIEW_IDENTITIES: '/etc/vergis/roster.json' }, fixedSecret)
    expect(c.miranda.enabled).toBe(false)
    expect(c.miranda.previewIdentitiesPath).toBeUndefined()
  })

  it('roster válido → labels, user y claims normalizados a arreglos', () => {
    const r = parsePreviewIdentities(
      JSON.stringify([
        { label: 'gerente-zona-norte', user: 'persona.norte@inst.test', claims: { groups: ['gerencia'], area: 'Norte' } },
        { label: 'vendedor-sur', user: 'persona.sur@inst.test', claims: { groups: ['ventas'], area: ['Sur'] } },
      ]),
    )
    expect(r).toEqual([
      { label: 'gerente-zona-norte', user: 'persona.norte@inst.test', claims: { groups: ['gerencia'], area: ['Norte'] } },
      { label: 'vendedor-sur', user: 'persona.sur@inst.test', claims: { groups: ['ventas'], area: ['Sur'] } },
    ])
  })
  it('JSON ilegible → aborta', () => {
    expect(() => parsePreviewIdentities('{no-json')).toThrow(/MIRANDA_PREVIEW_IDENTITIES/)
  })
  it('no es arreglo → aborta', () => {
    expect(() => parsePreviewIdentities('{"identities":[]}')).toThrow(/arreglo/)
  })
  it('label duplicado → aborta nombrando la etiqueta', () => {
    const raw = JSON.stringify([
      { label: 'dup', user: 'a@x.com', claims: {} },
      { label: 'DUP', user: 'b@x.com', claims: {} },
    ])
    expect(() => parsePreviewIdentities(raw)).toThrow(/duplicado: 'DUP'/)
  })
  it('sin `user` → aborta', () => {
    expect(() => parsePreviewIdentities(JSON.stringify([{ label: 'x', claims: {} }]))).toThrow(/user/)
  })
  it('sin `claims` → aborta (un roster a medias verifica una ficción)', () => {
    expect(() => parsePreviewIdentities(JSON.stringify([{ label: 'x', user: 'a@x.com' }]))).toThrow(/claims/)
  })
  it('label con caracteres fuera del alfabeto de URL → aborta', () => {
    expect(() => parsePreviewIdentities(JSON.stringify([{ label: 'a b/c', user: 'a@x.com', claims: {} }]))).toThrow(/inválido/)
  })
})

// Snapshot de superficie: con el flag apagado (getMiranda ausente/null) la superficie de rutas es
// idéntica a hoy — `/miranda*` no existe (cae al 404 del slug-lookup normal).
const REPORT: Report = { code: 'PI-1', slug: 'pi-1', name: 'X', specName: 'X', specPath: '/a.yaml', tables: ['t'], databaseRefs: [] }
function mkReq(url: string, method = 'GET'): IncomingMessage {
  return { url, method, headers: {} } as unknown as IncomingMessage
}
function mkRes() {
  const calls = { status: 0, body: '' }
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))
  const res = { headersSent: false, writeHead: (c: number) => { calls.status = c }, end: (b?: string) => { calls.body = b ?? ''; resolveDone() } } as unknown as ServerResponse
  return { res, calls, done }
}
function deps(over: Partial<RouteDeps> = {}): RouteDeps {
  return {
    engine: 'clickhouse',
    gateSecret: '',
    isReady: () => true,
    getAdmin: () => null,
    getPiConfig: () => null,
    discover: () => [REPORT],
    identityFor: () => ({ agent: 't', user: 'a@x.com' }),
    renderReport: async () => '<html>PI</html>',
    indexReports: async (all) => all,
    renderIndexPage: async () => '<html>INDEX</html>',
    canOpenPi: async () => true,
    ...over,
  }
}

describe('routes · Miranda tras el flag', () => {
  it('flag OFF (getMiranda ausente) → GET /miranda = 404, idéntico a hoy', async () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps())(mkReq('/miranda'), res)
    expect(calls.status).toBe(404)
  })
  it('flag OFF → GET /miranda/s/xyz = 404', async () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps())(mkReq('/miranda/s/xyz'), res)
    expect(calls.status).toBe(404)
  })
  it('flag ON (getMiranda no-null) → delega en miranda.tryHandle', async () => {
    const tryHandle = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200)
      res.end('miranda')
      return true
    })
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ getMiranda: () => ({ tryHandle }) }))(mkReq('/miranda'), res)
    await done
    expect(tryHandle).toHaveBeenCalled()
    expect(calls.body).toBe('miranda')
  })
  it('flag ON pero tryHandle no atiende (false) → 404', async () => {
    const tryHandle = vi.fn(async () => false)
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ getMiranda: () => ({ tryHandle }) }))(mkReq('/miranda/nope'), res)
    await done
    expect(calls.status).toBe(404)
  })
})
