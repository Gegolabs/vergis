import { describe, it, expect, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { configFromEnv } from '../server/config'
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

// Snapshot de superficie: con el flag apagado (getMiranda ausente/null) la superficie de rutas es
// idéntica a hoy — `/miranda*` no existe (cae al 404 del slug-lookup normal).
const REPORT: Report = { code: 'PI-1', slug: 'pi-1', name: 'X', specPath: '/a.yaml', tables: ['t'], databaseRefs: [] }
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
    handleAnnotationWrite: async () => {},
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
