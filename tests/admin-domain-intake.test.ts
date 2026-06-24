import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminHandler, type IntakeRunner } from '../server/admin'
import {
  parseMasterDataConfig,
  parseDomainsConfig,
  parseIntakeConfig,
  SqliteMasterDataStore,
  SqliteAdminStore,
  SqliteGovernanceStore,
  type IntakeTarget,
  type IntakeTrigger,
  type RunRecord,
} from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'

const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const STEWARD = 'steward@gh.cl'
const BOUNDARY = 'TESTBOUNDARY'

const ENTITIES = parseMasterDataConfig({
  entities: [{ id: 'empresas_relacionadas', label: 'Empresas Relacionadas', domain: 'cartera', columns: [{ name: 'rut', label: 'RUT', type: 'string', pk: true }] }],
})
const DOMAINS = parseDomainsConfig({ domains: [{ id: 'cartera', label: 'Cartera / Finanzas', stewards: [STEWARD] }] })
const SLOTS = parseIntakeConfig({
  slots: [{
    id: 'saldos_cartera', label: 'Antigüedad de saldos', domain: 'cartera',
    accept: 'saldos *.xlsx', maxBytes: 1024,
    target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' },
    trigger: { processRef: 'PIPE' },
  }],
})

function mockReq(method: string, url: string, user: string, body: Buffer | string = '', contentType?: string): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user }
  if (contentType) r.headers['content-type'] = contentType
  return r
}
function multipart(fields: Record<string, string>, file?: { filename: string; bytes: Buffer }): { body: Buffer; ct: string } {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  if (file) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`))
    parts.push(file.bytes, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return { body: Buffer.concat(parts), ct: `multipart/form-data; boundary=${BOUNDARY}` }
}
function multipartFiles(fields: Record<string, string>, files: { filename: string; bytes: Buffer }[]): { body: Buffer; ct: string } {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  for (const f of files) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`))
    parts.push(f.bytes, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return { body: Buffer.concat(parts), ct: `multipart/form-data; boundary=${BOUNDARY}` }
}
interface MockRes { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(chunk?: string): void }
function mockRes(): MockRes {
  return { statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(chunk) { if (chunk) this.body += chunk } }
}

describe('admin · gestión de dominio + ingesta', () => {
  let admin: AdminHandler
  let audit: LogEventInput[]
  let puts: { filename: string; len: number; target: IntakeTarget }[]
  let runs: string[]
  let statusRuns: RunRecord[]

  beforeEach(async () => {
    audit = []
    puts = []
    runs = []
    statusRuns = []
    const intake: IntakeRunner = {
      put: async (target: IntakeTarget, filename: string, bytes: Buffer) => { puts.push({ filename, len: bytes.length, target }) },
      runNow: async (trigger: IntakeTrigger) => { runs.push(trigger.processRef) },
    }
    admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      intakeSlots: SLOTS,
      intake,
      intakeStatus: async () => statusRuns,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: (e) => audit.push(e),
      secret: SECRET,
    })
  })

  const go = async (req: IncomingMessage) => {
    const res = mockRes()
    await admin.tryHandle(req, res as unknown as ServerResponse)
    return res
  }
  const tokenFrom = (html: string): string => html.match(/name="_csrf" value="([0-9a-f]+)"/)![1]

  it('dashboard: admin ve el dominio y, en el avatar, Configuración', async () => {
    const res = await go(mockReq('GET', '/admin', ADMIN))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Cartera / Finanzas')
    expect(res.body).toContain('Configuración') // entrada de plataforma en el menú de avatar
  })

  it('steward (no-admin) entra y ve su dominio; NO ve Configuración', async () => {
    const dash = await go(mockReq('GET', '/admin', STEWARD))
    expect(dash.statusCode).toBe(200)
    expect(dash.body).toContain('Cartera / Finanzas')
    expect(dash.body).not.toContain('Configuración')
    // /admin/plataforma y /admin/roles → 403 para el steward
    expect((await go(mockReq('GET', '/admin/plataforma', STEWARD))).statusCode).toBe(403)
    expect((await go(mockReq('GET', '/admin/roles', STEWARD))).statusCode).toBe(403)
  })

  it('ajeno (ni admin ni steward) → 403 en /admin', async () => {
    const res = await go(mockReq('GET', '/admin', 'nadie@x.com'))
    expect(res.statusCode).toBe(403)
    expect(audit.find((e) => e.type === 'admin-access-denied')?.user).toBe('nadie@x.com')
  })

  it('página de dominio muestra el form de ingesta', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Antigüedad de saldos')
    expect(res.body).toContain('enctype="multipart/form-data"')
  })

  it('ingesta válida (steward): 303 + put a OneLake + run-now + auditoría', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))).body)
    const mp = multipart({ _csrf: token }, { filename: 'saldos w24.xlsx', bytes: Buffer.from('contenido ok') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toContain('/admin/dominio/cartera?ok=')
    expect(puts).toHaveLength(1)
    expect(puts[0].filename).toBe('saldos w24.xlsx')
    expect(puts[0].target.path).toBe('Files/intake/saldos')
    expect(runs).toEqual(['PIPE']) // land-and-trigger
    const ev = audit.find((e) => e.type === 'intake')
    expect(ev?.ok).toBe(true)
    expect(ev?.triggered).toBe(true)
  })

  it('nombre que no matchea el patrón → 400, sin put', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))).body)
    const mp = multipart({ _csrf: token }, { filename: 'otra-cosa.csv', bytes: Buffer.from('x') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(400)
    expect(puts).toHaveLength(0)
    expect(audit.find((e) => e.type === 'intake')?.ok).toBe(false)
  })

  it('archivo que excede maxBytes → 400, sin put', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))).body)
    const mp = multipart({ _csrf: token }, { filename: 'saldos big.xlsx', bytes: Buffer.alloc(2048, 7) })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(400)
    expect(puts).toHaveLength(0)
  })

  it('CSRF inválido → 403, sin put', async () => {
    const mp = multipart({ _csrf: 'NOPE' }, { filename: 'saldos w24.xlsx', bytes: Buffer.from('x') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(403)
    expect(puts).toHaveLength(0)
  })

  it('multi-archivo: N archivos → N puts + UN SOLO run-now por lote', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))).body)
    const mp = multipartFiles({ _csrf: token }, [
      { filename: 'saldos clientes w24.xlsx', bytes: Buffer.from('clientes') },
      { filename: 'saldos proveedores w24.xlsx', bytes: Buffer.from('proveedores') },
    ])
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toContain('/admin/dominio/cartera?ok=2&run=1')
    expect(puts).toHaveLength(2)
    expect(runs).toEqual(['PIPE']) // UN trigger, no dos
    expect(audit.filter((e) => e.type === 'intake' && e.ok)).toHaveLength(2)
  })

  it('multi-archivo atómico: si un archivo del lote es inválido → 400 y NINGÚN put', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))).body)
    const mp = multipartFiles({ _csrf: token }, [
      { filename: 'saldos clientes w24.xlsx', bytes: Buffer.from('ok') },
      { filename: 'otra-cosa.csv', bytes: Buffer.from('mal') }, // no matchea el patrón
    ])
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(400)
    expect(puts).toHaveLength(0) // o entra el lote completo o ninguno
    expect(runs).toHaveLength(0)
  })

  it('input de archivo acepta selección múltiple', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))
    expect(res.body).toMatch(/<input type="file" name="file" multiple required>/)
  })

  it('panel «Últimas cargas» refleja el estado del SJD por slot', async () => {
    statusRuns = [
      { startedAt: '2026-06-24T10:00:00Z', status: 'InProgress' },
      { startedAt: '2026-06-24T09:00:00Z', endedAt: '2026-06-24T09:02:00Z', status: 'Completed' },
      { startedAt: '2026-06-24T08:00:00Z', endedAt: '2026-06-24T08:01:00Z', status: 'Failed', error: 'mezcla de semanas' },
    ]
    const res = await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Últimas cargas')
    expect(res.body).toContain('Procesando')
    expect(res.body).toContain('Listo')
    expect(res.body).toContain('Falló')
    expect(res.body).toContain('mezcla de semanas') // el motivo del fallo se muestra
  })

  it('sin corridas todavía → el panel lo dice (no se cae)', async () => {
    statusRuns = []
    const res = await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))
    expect(res.body).toContain('Sin cargas todavía')
  })

  it('steward de cartera NO puede ingestar a un dominio que no gestiona', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/personas', STEWARD))
    expect(res.statusCode).toBe(404) // dominio no declarado → 404 (no se filtra su existencia con 403)
  })

  it('miembro de un default-steward-group gestiona TODOS los dominios (sin ser admin ni steward directo)', async () => {
    const gov = await SqliteGovernanceStore.open(null, { admins: [ADMIN], groups: [{ id: 'ce', label: 'Centro de Excelencia', members: ['consultor@teams.ratio.cl'] }] })
    const a = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: gov,
      groupStore: gov,
      domains: DOMAINS,
      domainStewardGroups: ['ce'],
      intakeSlots: SLOTS,
      intake: { put: async () => {}, runNow: async () => {} },
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const run = async (req: IncomingMessage) => { const res = mockRes(); await a.tryHandle(req, res as unknown as ServerResponse); return res }
    // consultor@teams.ratio.cl: NO admin, NO steward directo de cartera (stewards=[STEWARD]), pero está en 'ce'
    const dash = await run(mockReq('GET', '/admin', 'consultor@teams.ratio.cl'))
    expect(dash.statusCode).toBe(200)
    expect(dash.body).toContain('Cartera / Finanzas')
    const dom = await run(mockReq('GET', '/admin/dominio/cartera', 'consultor@teams.ratio.cl'))
    expect(dom.statusCode).toBe(200)
    expect(dom.body).toContain('Antigüedad de saldos')
    // ajeno (ni admin, ni steward, ni en el grupo) → 403
    const ajeno = await run(mockReq('GET', '/admin', 'nadie@x.com'))
    expect(ajeno.statusCode).toBe(403)
  })
})
