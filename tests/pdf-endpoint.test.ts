// Endpoint `/<slug>/pdf` (issue #65 · D7/D8) — la descarga pasa por EXACTAMENTE los mismos gates que
// la página del PI, y sin la env NI SIQUIERA existe: la URL vuelve a caer en el 404 de siempre.
import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequestHandler, type RouteDeps } from '../server/routes'
import { PdfUnavailableError } from '../server/pdf'
import type { Report } from '../server/discovery'

const REPORT: Report = { code: 'QW-04', slug: 'qw-04', name: 'Asistencia', specName: 'Asistencia', specPath: '/a.yaml', proto: 'mira', tables: ['t'], databaseRefs: [] }
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) // "%PDF-"

function mkReq(url: string, method = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  return { url, method, headers } as unknown as IncomingMessage
}

/** res fake que además CAPTURA las cabeceras (el 404/503 no las mira; el 200 del PDF sí). */
function mkRes() {
  const calls: { status: number; body: string; bytes: Buffer | null; headers: Record<string, string> } = {
    status: 0,
    body: '',
    bytes: null,
    headers: {},
  }
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))
  const res = {
    headersSent: false,
    writeHead: (code: number, headers?: Record<string, string>) => {
      calls.status = code
      if (headers) calls.headers = headers
    },
    end: (b?: string | Buffer) => {
      if (Buffer.isBuffer(b)) {
        calls.bytes = b
        calls.body = b.toString('latin1')
      } else {
        calls.body = b ?? ''
      }
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

const okPdf: RouteDeps['renderPdf'] = async () => ({ pdf: PDF_BYTES, filename: 'asistencia--2026-08-06.pdf' })

describe('routes · /<slug>/pdf — fail-closed sin la env (D8)', () => {
  // H3 (#295): sin `renderPdf` la ruta sigue sin existir y sigue respondiendo 404 — pero ahora cae al
  // despacho por Let (`slug` + `rest='pdf'`), que la declara ajena. El cuerpo dice «Ruta no
  // encontrada» en vez de «Producto de Información no encontrado»: el PI existe, la ruta no.
  it('sin renderPdf → 404 (la ruta no existe; ahora lo dice el despacho por Let)', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps())(mkReq('/qw-04/pdf'), res)
    await done
    expect(calls.status).toBe(404)
    expect(calls.body).toContain('Ruta no encontrada')
  })
})

describe('routes · /<slug>/pdf — con el sidecar montado', () => {
  it('200 con content-type, content-disposition y los bytes del PDF', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ renderPdf: okPdf }))(mkReq('/qw-04/pdf'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.headers['content-type']).toBe('application/pdf')
    expect(calls.headers['content-disposition']).toContain('attachment; filename="asistencia--2026-08-06.pdf"')
    expect(calls.headers['cache-control']).toBe('no-store')
    expect(calls.bytes && Buffer.from(PDF_BYTES).equals(calls.bytes)).toBe(true)
  })

  it('la nav de la URL (page/ctx/flt) llega al render — el PDF congela lo que se está mirando', async () => {
    const { res, done } = mkRes()
    let seen: unknown = null
    createRequestHandler(
      deps({
        renderPdf: async (_r, _h, nav) => {
          seen = nav
          return { pdf: PDF_BYTES, filename: 'x.pdf' }
        },
      }),
    )(mkReq('/qw-04/pdf?page=detalle&ctx.oc=123&flt.tipo=a'), res)
    await done
    expect(seen).toEqual({ page: 'detalle', ctx: { oc: '123' }, flt: { tipo: 'a' } })
  })

  it('slug inexistente → 404', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ renderPdf: okPdf }))(mkReq('/no-existe/pdf'), res)
    await done
    expect(calls.status).toBe(404)
  })

  it('sin acceso al artefacto → 403 (mismo texto que la página)', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ renderPdf: okPdf, canOpenPi: async () => false }))(mkReq('/qw-04/pdf'), res)
    await done
    expect(calls.status).toBe(403)
    expect(calls.body).toContain('No tienes acceso a este Producto de Información')
  })

  it('PI bloqueado → 503 con su motivo', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ renderPdf: okPdf, piBlocked: () => 'pendiente de verificación de su RLS nativa.' }))(mkReq('/qw-04/pdf'), res)
    await done
    expect(calls.status).toBe(503)
    expect(calls.body).toContain('pendiente de verificación')
  })

  it('gate global no listo → 503 «Inicializando…» (no se sirve nada)', async () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ renderPdf: okPdf, isReady: () => false }))(mkReq('/qw-04/pdf'), res)
    expect(calls.status).toBe(503)
    expect(calls.body).toContain('Inicializando')
  })

  it('sidecar caído → 503 con mensaje al consumidor y CERO detalle interno en el cuerpo', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(
      deps({
        renderPdf: async () => {
          throw new PdfUnavailableError('POST http://vergis-pdf:9090/convert falló: ConnectionRefused')
        },
      }),
    )(mkReq('/qw-04/pdf'), res)
    await done
    expect(calls.status).toBe(503)
    expect(calls.body).toContain('La generación de PDF no está disponible')
    expect(calls.body).not.toContain('vergis-pdf')
    expect(calls.body).not.toContain('ConnectionRefused')
  })

  it('cualquier otro fallo (el render del PI) sigue el camino 500 estándar', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(
      deps({
        renderPdf: async () => {
          throw new Error('dataset vacío')
        },
      }),
    )(mkReq('/qw-04/pdf'), res)
    await done
    expect(calls.status).toBe(500)
    expect(calls.body).toContain('dataset vacío')
  })

  it('la página del PI sigue sirviéndose igual con la feature encendida', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ renderPdf: okPdf }))(mkReq('/qw-04'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toContain('<html>PI</html>')
  })
})
