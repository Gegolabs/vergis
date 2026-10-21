// #425 · El GET del hilo de comentarios lleva el MISMO ctx que el POST.
//
// El defecto: el runtime armaba el POST con `payload.ctx = CFG.ctx` (desde #185, el ctx efectivo) pero
// el GET del hilo con `?dataset=…&key=…` solo. El servidor re-ejecuta el dataset con el ctx de la URL
// (`navCtxDe`): en un dataset cuyo SQL usa `:ctx.*`, el control quedaba vacío, la fila no aparecía y el
// gate respondía 403 sobre una fila que la identidad SÍ ve. Comentar funcionaba; leer el hilo, nunca.
// Medido en una instancia: PI-16 (`cruce`, `:ctx.empresa`) y un `anchor` por persona × semana
// (`:ctx.semana`): 403 sin ctx, 200 con él. La suite probaba el GET con datasets que no leen ctx.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { createNotas, type NotasHandler } from '../server/notas'
import { csrfFactory } from '../server/ui'
import { SqliteNotasStore, NOTAS_RUNTIME_SOURCE } from '@vergis/capabilities'
import type { MiraSpec } from '@vergis/mira'

/** La función del runtime que arma el sufijo de ctx, evaluada tal como viaja al navegador. */
function ctxQsDelRuntime(): (ctx: unknown) => string {
  const m = /function ctxQs\(ctx\)\{[\s\S]*?\n\}/.exec(NOTAS_RUNTIME_SOURCE)
  if (!m) throw new Error('el runtime de notas no define ctxQs')
  return new Function(`${m[0]}; return ctxQs;`)() as (ctx: unknown) => string
}

describe('runtime de notas · el GET del hilo lleva el ctx (#425)', () => {
  const ctxQs = ctxQsDelRuntime()

  it('un valor por llave, multivalor repetido, y nada sin ctx', () => {
    expect(ctxQs({ empresa: '96835510-4' })).toBe('&ctx.empresa=96835510-4')
    expect(ctxQs({ semana: ['2026-10-19', '2026-10-26'] })).toBe('&ctx.semana=2026-10-19&ctx.semana=2026-10-26')
    expect(ctxQs(undefined)).toBe('')
    expect(ctxQs({})).toBe('')
    // Vacío o nulo se omite, como ctxQuery del servidor: GET y POST nunca difieren.
    expect(ctxQs({ empresa: '', semana: ['2026-10-26', ''], x: null })).toBe('&ctx.semana=2026-10-26')
  })

  it('codifica llave y valor (un & en el valor no parte la query)', () => {
    expect(ctxQs({ 'área': 'A&B' })).toBe('&ctx.%C3%A1rea=A%26B')
  })

  it('la URL del hilo se arma con el ctx del CFG, el mismo que lleva el POST', () => {
    expect(NOTAS_RUNTIME_SOURCE).toContain("encodeURIComponent(JSON.stringify(llave))+ctxQs(CFG.ctx)")
    expect(NOTAS_RUNTIME_SOURCE).toContain('payload.ctx=CFG.ctx')
    // El re-fetch del hilo después de comentar usa la MISMA url (con ctx), no una armada aparte.
    expect(NOTAS_RUNTIME_SOURCE).toContain('return fetch(q,')
  })
})

// ── El ciclo completo por el handler: comentar y leer el hilo de una fila que depende del ctx ──

const SECRET = 'notas-secret'
const csrf = csrfFactory(SECRET)
function mockReq(method: string, url: string, user: string, body: unknown = ''): IncomingMessage {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const r = Readable.from([text]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user, accept: 'application/json' }
  return r
}
function mockRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code: number) {
      this.statusCode = code
      return this
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk
    },
  }
}

// La forma del caso real: el dataset anclado filtra por el control (`WHERE empresa = :ctx.empresa`).
const FILAS = [
  { folio: '1792', empresa: '76100013-6' },
  { folio: '1811', empresa: '96000006-4' },
]
const SPEC = {
  mira_version: '1.0',
  identity: { id: 'pi-16', display_name: 'Folios', classification: 'internal' },
  data: { cruce: { capability: 'mock', anchor: { entity: 'dbo.fct_documento', key: ['folio'] } } },
  quality: {},
  delivery: {},
} as unknown as MiraSpec

describe('capa de notas · hilo de un dataset que lee :ctx.* (#425)', () => {
  let h: NotasHandler
  const ctx = { empresa: '96000006-4' }
  const llave = { folio: '1811' }

  beforeEach(async () => {
    const store = await SqliteNotasStore.open(null)
    h = createNotas({
      store,
      resolve: (slug) => (slug === 'pi-16' ? { code: 'PI-16', name: 'Folios', slug, spec: SPEC } : undefined),
      identityOf: (hd) => ({ user: (hd as Record<string, string>)['x-test-user'] }),
      canOpenPi: async () => true,
      // El dato depende del ctx, como el SQL bindeado: sin empresa no hay filas.
      retrieve: async (_slug, _ds, c) => FILAS.filter((f) => f.empresa === String(c?.['empresa'] ?? '')).map(({ folio }) => ({ folio })),
      congelar: async () => {
        throw new Error('no se usa')
      },
      renderCongelado: async () => '',
      avatarFor: async () => '',
      audit: () => {},
      secret: SECRET,
      brandTitle: 'Vergis',
    })
  })

  const llamar = async (method: string, url: string, body?: Record<string, unknown>) => {
    const res = mockRes()
    await h.tryHandle(mockReq(method, url, 'ana@x.com', body ? { _csrf: csrf('ana@x.com'), ...body } : ''), res as never)
    return res
  }
  const hilo = (sufijo: string) => `/pi-16/comentarios?dataset=cruce&key=${encodeURIComponent(JSON.stringify(llave))}${sufijo}`

  it('comentar con el ctx del CFG y leer el hilo con la URL que arma el runtime: 200 los dos, y vuelve la nota', async () => {
    const p = await llamar('POST', '/pi-16/comentarios', { dataset: 'cruce', key: llave, contenido: 'Contabilidad: OK', ctx })
    expect(p.statusCode).toBe(200)
    const g = await llamar('GET', hilo(ctxQsDelRuntime()(ctx)))
    expect(g.statusCode).toBe(200)
    expect(JSON.parse(g.body).notas.map((n: { contenido: string }) => n.contenido)).toEqual(['Contabilidad: OK'])
  })

  it('control negativo: el mismo GET sin ctx (la URL de antes de #425) no encuentra la fila', async () => {
    await llamar('POST', '/pi-16/comentarios', { dataset: 'cruce', key: llave, contenido: 'x', ctx })
    const g = await llamar('GET', hilo(''))
    expect(g.statusCode).toBe(403)
  })
})
