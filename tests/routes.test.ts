import { describe, it, expect, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequestHandler, type RouteDeps } from '../server/routes'
import type { Report } from '../server/discovery'

const REPORT: Report = { code: 'QW-04', slug: 'qw-04', name: 'Asistencia', specPath: '/a.yaml', tables: ['t'], databaseRefs: [] }

function mkReq(url: string, method = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  return { url, method, headers } as unknown as IncomingMessage
}

function mkRes() {
  const calls: { status: number; body: string } = { status: 0, body: '' }
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))
  const res = {
    headersSent: false,
    writeHead: (code: number) => {
      calls.status = code
    },
    end: (b?: string) => {
      calls.body = b ?? ''
      resolveDone()
    },
    destroy: () => resolveDone(),
  } as unknown as ServerResponse
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
    identityFor: () => ({ agent: 'test', user: 'ana@x.com' }),
    renderReport: async () => '<html>PI</html>',
    indexReports: async (all) => all,
    renderIndexPage: async () => '<html>INDEX</html>',
    canOpenPi: async () => true,
    ...over,
  }
}

describe('routes · /healthz', () => {
  it('ready → 200 {ok:true, engine, phase:serving}', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ isReady: () => true }))(mkReq('/healthz'), res)
    expect(calls.status).toBe(200)
    expect(JSON.parse(calls.body)).toEqual({ ok: true, engine: 'clickhouse', phase: 'serving' })
  })
  it('no-ready → 503 phase:starting y NO expone slugs/lastErr', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ isReady: () => false }))(mkReq('/healthz'), res)
    expect(calls.status).toBe(503)
    expect(JSON.parse(calls.body).phase).toBe('starting')
    expect(calls.body).not.toContain('slug')
    expect(calls.body).not.toContain('qw-04')
  })
  // Issue #52: distinguir «arrancando» (503) de «N de M degradados» (el proceso sirve el resto → 200).
  it('ready con PIs degradados → 200 {ok:false, phase:degraded, pis:{total,serving}} — solo conteos', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ isReady: () => true, healthSummary: () => ({ total: 3, serving: 2 }) }))(mkReq('/healthz'), res)
    expect(calls.status).toBe(200)
    expect(JSON.parse(calls.body)).toEqual({ ok: false, engine: 'clickhouse', phase: 'degraded', pis: { total: 3, serving: 2 } })
    expect(calls.body).not.toContain('qw-04') // sin slugs ni motivos: healthz corre sin gate
  })
  it('ready con todos los PIs sirviendo → 200 {ok:true, phase:serving, pis}', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ isReady: () => true, healthSummary: () => ({ total: 2, serving: 2 }) }))(mkReq('/healthz'), res)
    expect(JSON.parse(calls.body)).toEqual({ ok: true, engine: 'clickhouse', phase: 'serving', pis: { total: 2, serving: 2 } })
  })
})

describe('routes · servibilidad por PI (issue #52)', () => {
  const r2: Report = { ...REPORT, slug: 'qw-05', code: 'QW-05' }
  const blockQw04 = (r: Report): string | null => (r.slug === 'qw-04' ? 'tabla dbo.saldos sin artefacto SECURITY POLICY' : null)

  it('el PI bloqueado responde 503 con su MOTIVO; el sano sigue sirviendo 200', async () => {
    const make = () => createRequestHandler(deps({ discover: () => [REPORT, r2], piBlocked: blockQw04 }))
    const a = mkRes()
    make()(mkReq('/qw-04'), a.res)
    await a.done
    expect(a.calls.status).toBe(503)
    expect(a.calls.body).toContain('SECURITY POLICY') // motivo accionable, no «Inicializando…» genérico
    const b = mkRes()
    make()(mkReq('/qw-05'), b.res)
    await b.done
    expect(b.calls.status).toBe(200)
    expect(b.calls.body).toBe('<html>PI</html>')
  })
  it('sin piBlocked inyectado (clickhouse) → comportamiento previo intacto', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps())(mkReq('/qw-04'), res)
    await done
    expect(calls.status).toBe(200)
  })
})

describe('routes · gate opt-in (A10)', () => {
  it('con secreto y sin token → 403', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ gateSecret: 's3cr' }))(mkReq('/'), res)
    expect(calls.status).toBe(403)
  })
  it('con secreto y token correcto → pasa (no 403)', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ gateSecret: 's3cr' }))(mkReq('/', 'GET', { 'x-gate-token': 's3cr' }), res)
    await done
    expect(calls.status).toBe(200)
  })
  it('healthz NO requiere el token del gate', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ gateSecret: 's3cr' }))(mkReq('/healthz'), res)
    expect(calls.status).toBe(200)
  })
})

describe('routes · admin / config / ready', () => {
  it('ruta /admin → delega en admin.tryHandle (antes del gate ready)', async () => {
    const tryHandle = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200)
      res.end('admin')
      return true
    })
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ isReady: () => false, getAdmin: () => ({ tryHandle }) }))(mkReq('/admin/roles'), res)
    await done
    expect(tryHandle).toHaveBeenCalled()
    expect(calls.body).toBe('admin')
  })
  it('sin ready y ruta de datos → 503', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ isReady: () => false }))(mkReq('/qw-04'), res)
    expect(calls.status).toBe(503)
  })
})

describe('routes · índice y PI', () => {
  it('el esquema viejo de anotaciones ya no existe: POST /<slug>/annotations → 404', async () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps())(mkReq('/qw-04/annotations', 'POST'), res)
    expect(calls.status).toBe(404)
  })
  it('/ con varios PIs → renderIndexPage', async () => {
    const r2 = { ...REPORT, slug: 'qw-05', code: 'QW-05' }
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ discover: () => [REPORT, r2] }))(mkReq('/'), res)
    await done
    expect(calls.body).toBe('<html>INDEX</html>')
  })
  it('/<slug> existente y canOpenPi true → renderReport', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps())(mkReq('/qw-04'), res)
    await done
    expect(calls.body).toBe('<html>PI</html>')
  })
  it('/<slug> con canOpenPi false → 403 (gate de artefacto)', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ canOpenPi: async () => false }))(mkReq('/qw-04'), res)
    await done
    expect(calls.status).toBe(403)
  })
  it('slug inexistente → 404', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps())(mkReq('/no-existe'), res)
    expect(calls.status).toBe(404)
  })
})
