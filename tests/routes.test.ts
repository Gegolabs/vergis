import { describe, it, expect, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequestHandler, type RouteDeps } from '../server/routes'
import type { Report } from '../server/discovery'

const REPORT: Report = { code: 'QW-04', slug: 'qw-04', name: 'Asistencia', specName: 'Asistencia', specPath: '/a.yaml', proto: 'mira', tables: ['t'], databaseRefs: [] }

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
  it('ready con Lets degradados → 200 {ok:false, phase:degraded, lets:{total,serving}} — solo conteos', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ isReady: () => true, healthSummary: () => ({ total: 3, serving: 2 }) }))(mkReq('/healthz'), res)
    expect(calls.status).toBe(200)
    expect(JSON.parse(calls.body)).toEqual({ ok: false, engine: 'clickhouse', phase: 'degraded', lets: { total: 3, serving: 2 } })
    expect(calls.body).not.toContain('qw-04') // sin slugs ni motivos: healthz corre sin gate
  })
  it('ready con todos los Lets sirviendo → 200 {ok:true, phase:serving, lets}', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ isReady: () => true, healthSummary: () => ({ total: 2, serving: 2 }) }))(mkReq('/healthz'), res)
    expect(JSON.parse(calls.body)).toEqual({ ok: true, engine: 'clickhouse', phase: 'serving', lets: { total: 2, serving: 2 } })
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
  // D6 del diseño 004/10: la comparación pasó a tiempo constante. Estos casos fijan la SEMÁNTICA
  // (qué se acepta y qué no); que además sea constant-time lo garantiza `constantTimeEqual`, con
  // sus propios tests en http-util. Un token de largo distinto y uno del mismo largo con un byte
  // cambiado deben ser indistinguibles en resultado: ambos 403.
  it('token del mismo largo con un byte distinto → 403', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ gateSecret: 's3cr' }))(mkReq('/', 'GET', { 'x-gate-token': 's3cX' }), res)
    expect(calls.status).toBe(403)
  })
  it('token con prefijo correcto pero más corto → 403 (no hay crédito por acertar el prefijo)', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ gateSecret: 's3cr' }))(mkReq('/', 'GET', { 'x-gate-token': 's3c' }), res)
    expect(calls.status).toBe(403)
  })
  it('header REPETIDO (llega como array) → 403, no se concatena ni se toma el primero', () => {
    const { res, calls } = mkRes()
    const req = mkReq('/', 'GET', {})
    ;(req.headers as Record<string, unknown>)['x-gate-token'] = ['s3cr', 'otro']
    createRequestHandler(deps({ gateSecret: 's3cr' }))(req, res)
    expect(calls.status).toBe(403)
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
  // H3 (#295): el slug-lookup pasó a partir `slug` + `rest`, así que esta URL ya no es «un slug que
  // no existe» sino «una subruta que el Let no reconoce». Sigue siendo 404 y sigue sin escribir nada;
  // lo que cambió es el TEXTO del cuerpo y que el veredicto llega tras el gate de artefacto (async).
  it('el esquema viejo de anotaciones ya no existe: POST /<slug>/annotations → 404', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps())(mkReq('/qw-04/annotations', 'POST'), res)
    await done
    expect(calls.status).toBe(404)
    expect(calls.body).toContain('Ruta no encontrada')
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

// --- H3 (#295) · el despacho por Let -----------------------------------------------------------
//
// El router deja de saber que `/<slug>` es «la página de un PI»: parte la URL en slug + resto y le
// entrega el resto al Let. Lo que estos tests fijan es la FRONTERA — qué llega al Let, qué se sigue
// atendiendo antes, y qué pasa cuando el visible no es Mira.
describe('routes · despacho por Let (H3)', () => {
  const DAFTAR: Report = { ...REPORT, code: 'estudios', slug: 'estudios', name: 'Daftar', specName: 'Daftar', proto: 'daftar', tables: [] }

  it('`/<slug>/api/guides/x` → invokeLet con rest="api/guides/x"', async () => {
    const vistos: string[] = []
    const { res, calls, done } = mkRes()
    createRequestHandler(
      deps({
        discover: () => [DAFTAR],
        invokeLet: async (r, _req, response, rest) => {
          vistos.push(`${r.slug}|${rest}`)
          response.writeHead(200)
          response.end('OK')
          return true
        },
      }),
    )(mkReq('/estudios/api/guides/051-x?s=ana'), res)
    await done
    expect(vistos).toEqual(['estudios|api/guides/051-x'])
    expect(calls.status).toBe(200)
  })

  it('la raíz del Let llega con rest="" (y la barra final no cambia nada)', async () => {
    for (const url of ['/estudios', '/estudios/']) {
      const vistos: string[] = []
      const { res, done } = mkRes()
      createRequestHandler(
        deps({
          discover: () => [DAFTAR],
          invokeLet: async (_r, _q, response, rest) => {
            vistos.push(rest)
            response.writeHead(200)
            response.end('OK')
            return true
          },
        }),
      )(mkReq(url), res)
      await done
      expect(vistos, url).toEqual([''])
    }
  })

  it('el Let que devuelve false (ruta ajena) → 404 del nodo', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ discover: () => [DAFTAR], invokeLet: async () => false }))(mkReq('/estudios/nada'), res)
    await done
    expect(calls.status).toBe(404)
    expect(calls.body).toContain('Ruta no encontrada')
  })

  it('`/<slug>/pdf` de un Let NO-Mira NO lo intercepta el endpoint de PDF: cae a invokeLet', async () => {
    const vistos: string[] = []
    const { res, done } = mkRes()
    createRequestHandler(
      deps({
        discover: () => [DAFTAR],
        renderPdf: async () => ({ pdf: new Uint8Array([1]), filename: 'x.pdf' }),
        invokeLet: async (_r, _q, response, rest) => {
          vistos.push(rest)
          response.writeHead(200)
          response.end('OK')
          return true
        },
      }),
    )(mkReq('/estudios/pdf'), res)
    await done
    expect(vistos).toEqual(['pdf'])
  })

  it('`/<slug>/pdf` de un PI de MIRA lo sigue sirviendo el endpoint de PDF (cero cambio)', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(
      deps({
        renderPdf: async () => ({ pdf: new Uint8Array([37, 80, 68, 70]), filename: 'a.pdf' }),
        invokeLet: async () => {
          throw new Error('no debía llegar al Let')
        },
      }),
    )(mkReq('/qw-04/pdf'), res)
    await done
    expect(calls.status).toBe(200)
  })

  it('`/<slug>/config` de un Let NO-Mira NO lo intercepta la config por-PI: cae a invokeLet', async () => {
    const vistos: string[] = []
    const { res, done } = mkRes()
    createRequestHandler(
      deps({
        discover: () => [DAFTAR],
        getPiConfig: () => ({ tryHandle: async () => true }) as unknown as ReturnType<RouteDeps['getPiConfig']>,
        invokeLet: async (_r, _q, response, rest) => {
          vistos.push(rest)
          response.writeHead(200)
          response.end('OK')
          return true
        },
      }),
    )(mkReq('/estudios/config'), res)
    await done
    expect(vistos).toEqual(['config'])
  })

  it('`/` con UN visible que no es Mira → 302 a `/<slug>` (su HTML enlaza relativo a su prefijo)', async () => {
    const { res, done } = mkRes()
    let loc = ''
    const r = {
      ...res,
      writeHead: (code: number, h?: Record<string, string>) => {
        ;(res as unknown as { headersSent: boolean }).headersSent = false
        loc = `${code} ${h?.['location'] ?? ''}`
      },
    } as unknown as typeof res
    createRequestHandler(deps({ discover: () => [DAFTAR], indexReports: async (all) => all }))(mkReq('/'), r)
    await done
    expect(loc).toBe('302 /estudios')
  })

  it('`/` con UN visible que SÍ es Mira → se sigue renderizando en la raíz (cero cambio)', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ indexReports: async (all) => all }))(mkReq('/'), res)
    await done
    expect(calls.body).toBe('<html>PI</html>')
  })

  it('sin `invokeLet` inyectado la superficie es la de antes de H3: raíz renderizada, subruta 404', async () => {
    const a = mkRes()
    createRequestHandler(deps())(mkReq('/qw-04'), a.res)
    await a.done
    expect(a.calls.body).toBe('<html>PI</html>')
    const b = mkRes()
    createRequestHandler(deps())(mkReq('/qw-04/lo-que-sea'), b.res)
    await b.done
    expect(b.calls.status).toBe(404)
  })

  it('el gate de artefacto corre ANTES del Let: sin acceso, el Let ni se invoca', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(
      deps({
        discover: () => [DAFTAR],
        canOpenPi: async () => false,
        invokeLet: async () => {
          throw new Error('no debía invocarse')
        },
      }),
    )(mkReq('/estudios/api/guides'), res)
    await done
    expect(calls.status).toBe(403)
  })
})
