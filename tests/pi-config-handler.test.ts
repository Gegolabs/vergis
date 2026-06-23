import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createPiConfig, type PiConfigHandler } from '../server/pi-config'
import { SqliteGovernanceStore, type PiRole } from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'

const SECRET = 'cfg-secret'
function mockReq(method: string, url: string, user: string, body = ''): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user }
  return r
}
interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  writeHead(code: number, h?: Record<string, string>): MockRes
  end(chunk?: string): void
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, h) {
      this.statusCode = code
      Object.assign(this.headers, h ?? {})
      return this
    },
    end(chunk) {
      if (chunk) this.body += chunk
    },
  }
}

describe('pi-config handler · gobierno por rol de PI', () => {
  let gov: SqliteGovernanceStore
  let audit: LogEventInput[]
  let h: PiConfigHandler

  beforeEach(async () => {
    gov = await SqliteGovernanceStore.open(null, {
      groups: [{ id: 'analistas_roble', label: 'Analistas ROBLE', members: ['ana@consultora.test'] }],
    })
    await gov.bootstrapPi('PI-01', 'felipe@ga.test', ['analistas_roble'])
    audit = []
    const roleOf = async (code: string, email: string | undefined): Promise<PiRole | null> => {
      if (await gov.isAdmin(email)) return 'owner'
      return gov.roleFor(code, email)
    }
    h = createPiConfig({
      gov,
      resolve: (slug) => (slug === 'pi-01' ? { code: 'PI-01', name: 'Cartera' } : undefined),
      identityOf: (hd) => ({ user: (hd as Record<string, string>)['x-test-user'] }),
      roleOf,
      // El PI-01 lee una fuente que ofrece P1D → no puede exigir más fresco que diario.
      ceilingFor: async () => ['P1D'],
      audit: (e) => audit.push(e),
      secret: SECRET,
    })
  })

  const go = async (req: IncomingMessage) => {
    const res = mockRes()
    const handled = await h.tryHandle(req, res as unknown as ServerResponse)
    return { handled, res }
  }
  const tok = (html: string) => html.match(/name="_csrf" value="([0-9a-f]+)"/)![1]

  it('ruta ajena no se maneja', async () => {
    expect((await go(mockReq('GET', '/pi-01', 'x@y.com'))).handled).toBe(false)
  })

  it('ajeno (privado) → 403', async () => {
    const { res } = await go(mockReq('GET', '/pi-01/config', 'ajeno@ga.test'))
    expect(res.statusCode).toBe(403)
  })

  it('dueño ve la página con formularios de gobierno', async () => {
    const { res } = await go(mockReq('GET', '/pi-01/config', 'felipe@ga.test'))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Visibilidad')
    expect(res.body).toContain('Agregar al compartido')
    expect(res.body).toContain('Demanda de frescura')
  })

  it('dueño cambia visibilidad a público y comparte; auditado', async () => {
    const token = tok((await go(mockReq('GET', '/pi-01/config', 'felipe@ga.test'))).res.body)
    expect((await go(mockReq('POST', '/pi-01/config/visibility', 'felipe@ga.test', `_csrf=${token}&visibility=publico`))).res.statusCode).toBe(303)
    expect((await gov.getPiGovernance('PI-01'))?.visibility).toBe('publico')
    await go(mockReq('POST', '/pi-01/config/grant', 'felipe@ga.test', `_csrf=${token}&principal_type=user&principal=nuevo@ga.test&role=collaborator`))
    expect(await gov.roleFor('PI-01', 'nuevo@ga.test')).toBe('collaborator')
    expect(audit.map((e) => e.op)).toContain('grant-set')
  })

  it('colaborador NO cambia visibilidad (403) pero SÍ edita la demanda (303)', async () => {
    const token = tok((await go(mockReq('GET', '/pi-01/config', 'ana@consultora.test'))).res.body)
    expect((await go(mockReq('POST', '/pi-01/config/visibility', 'ana@consultora.test', `_csrf=${token}&visibility=publico`))).res.statusCode).toBe(403)
    expect((await go(mockReq('POST', '/pi-01/config/demanda', 'ana@consultora.test', `_csrf=${token}&max_age=P1W`))).res.statusCode).toBe(303)
    expect((await gov.getDemanda('PI-01'))?.maxAge).toBe('P1W')
  })

  it('demanda inválida → 400', async () => {
    const token = tok((await go(mockReq('GET', '/pi-01/config', 'felipe@ga.test'))).res.body)
    expect((await go(mockReq('POST', '/pi-01/config/demanda', 'felipe@ga.test', `_csrf=${token}&max_age=cada%20hora`))).res.statusCode).toBe(400)
  })

  it('demanda más fresca que el techo (oferta diaria) → 400; diaria o menos → 303', async () => {
    const token = tok((await go(mockReq('GET', '/pi-01/config', 'felipe@ga.test'))).res.body)
    const r = await go(mockReq('POST', '/pi-01/config/demanda', 'felipe@ga.test', `_csrf=${token}&max_age=PT1H`))
    expect(r.res.statusCode).toBe(400)
    expect(r.res.body).toContain('Máximo exigible')
    expect((await go(mockReq('POST', '/pi-01/config/demanda', 'felipe@ga.test', `_csrf=${token}&max_age=P1D`))).res.statusCode).toBe(303)
  })

  it('CSRF inválido → 403', async () => {
    expect((await go(mockReq('POST', '/pi-01/config/visibility', 'felipe@ga.test', `_csrf=NOPE&visibility=publico`))).res.statusCode).toBe(403)
  })
})
