import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminHandler, type DomainEntityFreshness } from '../server/admin'
import { parseMasterDataConfig, parseDomainsConfig, parseIntakeConfig, SqliteMasterDataStore, SqliteAdminStore, type SourceRow, type ProcessRow, type RunRecord } from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'

const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const STEWARD = 'steward@gh.cl'

const ENTITIES = parseMasterDataConfig({ entities: [{ id: 'rel', label: 'Relacionadas', domain: 'cartera', columns: [{ name: 'rut', label: 'RUT', type: 'string', pk: true }] }] })
const DOMAINS = parseDomainsConfig({ domains: [{ id: 'cartera', label: 'Cartera / Finanzas', stewards: [STEWARD] }] })

const SOURCES: SourceRow[] = [{ id: 'sap', label: 'SAP B1', oferta: 'PT1H', domain: 'cartera', connectedBy: 'cesar@x.com' }]
const PROCESSES: ProcessRow[] = [{ id: 'p_sap', label: 'Ingesta SAP', sourceId: 'sap', engine: { workspaceId: 'WS', itemId: 'SJD', jobType: 'sparkjob' } }]
const OUTPUTS = [{ processId: 'p_sap', tableRef: 'fct_saldos' }]
// Fila de frescura con DRIFT (schedule real 1d ≠ cadencia req 2h) → debe renderizar el botón «Aplicar».
// Corre como Spark Job (sparkjob): NO debe mostrar alerta de migración.
const FRESHNESS: DomainEntityFreshness[] = [{
  entity: 'fct_saldos', processId: 'p_sap', processLabel: 'Ingesta SAP', oferta: 'PT1H',
  dependentPis: ['PI-01'], tightestDemand: 'PT2H', requiredCadence: 'PT2H', requiredCadenceSeconds: 7200, unsatisfiable: false,
  engine: true, engineJobType: 'sparkjob', runs: [{ startedAt: '2026-06-24T09:00:00Z', endedAt: '2026-06-24T09:01:00Z', status: 'Completed' }],
  health: { lastStatus: 'Completed', lastSuccessAt: '2026-06-24T09:01:00Z', ageSeconds: 100, failed: false, missed: false },
  actualScheduleSeconds: 86_400,
}]
// Variante: el proceso corre como NOTEBOOK → debe explicitar tipo + alerta de migración a Spark Job.
const FRESHNESS_NOTEBOOK: DomainEntityFreshness[] = [{
  entity: 'fct_asistencia', processId: 'p_buk', processLabel: 'Ingesta Buk', oferta: 'P1D',
  dependentPis: ['PI-04'], tightestDemand: 'P1D', requiredCadence: 'P1D', requiredCadenceSeconds: 86_400, unsatisfiable: false,
  engine: true, engineJobType: 'RunNotebook', runs: [{ startedAt: '2026-06-24T06:00:00Z', endedAt: '2026-06-24T06:05:00Z', status: 'Completed' }],
  health: { lastStatus: 'Completed', lastSuccessAt: '2026-06-24T06:05:00Z', ageSeconds: 100, failed: false, missed: false },
  actualScheduleSeconds: 86_400,
}]

function mockReq(method: string, url: string, user: string, body: string = '', contentType?: string): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url; r.method = method; r.headers = { 'x-test-user': user }
  if (contentType) r.headers['content-type'] = contentType
  return r
}
interface MockRes { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(chunk?: string): void }
function mockRes(): MockRes {
  return { statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(chunk) { if (chunk) this.body += chunk } }
}

describe('admin · Fuentes (plataforma) + Frescura (dominio)', () => {
  let admin: AdminHandler
  let audit: LogEventInput[]
  let applied: { processId: string; by: string }[]

  beforeEach(async () => {
    audit = []
    applied = []
    admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      sourceRegistry: async () => ({ sources: SOURCES, processes: PROCESSES, outputs: OUTPUTS }),
      domainFreshness: async () => FRESHNESS,
      applyCadence: async (processId: string, by: string) => { applied.push({ processId, by }); return { action: 'set', desiredSeconds: 7200 } },
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

  it('Fuentes (plataforma): admin ve el registro técnico; sidebar dice «Fuentes», no «Mapa de Fuentes»', async () => {
    const res = await go(mockReq('GET', '/admin/sources', ADMIN))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('SAP B1')
    expect(res.body).toContain('fct_saldos') // topología proceso→entidad
    expect(res.body).toContain('>Fuentes<')
    expect(res.body).not.toContain('Mapa de Fuentes')
  })

  it('Fuentes es de plataforma: el steward (no-admin) recibe 403', async () => {
    expect((await go(mockReq('GET', '/admin/sources', STEWARD))).statusCode).toBe(403)
  })

  it('home del dominio: la faceta es «Frescura» y apunta a /frescura — el link colapsante a /admin/sources murió', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))
    expect(res.body).toContain('>Frescura<')
    expect(res.body).toContain('href="/admin/dominio/cartera/frescura"')
    expect(res.body).not.toContain('Fuentes & Frescura')
    const card = res.body.slice(res.body.indexOf('class="main"'))
    expect(card).not.toContain('href="/admin/sources"') // el dominio ya no enlaza la página de plataforma
  })

  it('Frescura (dominio): el steward ve la brecha por entidad + corridas; abierta a stewards (no solo admin)', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('fct_saldos')
    expect(res.body).toContain('PT2H') // cadencia requerida
    expect(res.body).toContain('Aplicar') // botón del reconciliador (hay drift)
    expect(res.body).toContain('Spark Job') // tipo de motor explícito
    expect(res.body).not.toContain('migrar a Spark Job') // sparkjob no dispara alerta de migración
  })

  it('Frescura: un proceso que corre como NOTEBOOK explicita el tipo y la alerta de migrar a Spark Job', async () => {
    const nb = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      domainFreshness: async () => FRESHNESS_NOTEBOOK,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const res = mockRes()
    await nb.tryHandle(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD), res as unknown as ServerResponse)
    expect(res.body).toContain('Notebook')
    expect(res.body).toContain('migrar a Spark Job') // alerta explícita (celda + banner)
  })

  // Issue #53: el motivo de la falla del job disparado debe ser legible en Frescura — sin él, quien
  // carga un archivo solo ve «Falló» y reintenta a ciegas.
  it('Frescura: una corrida fallida muestra el MOTIVO (failureReason), escapado', async () => {
    const FAILED: DomainEntityFreshness[] = [{
      ...FRESHNESS[0],
      runs: [{ startedAt: '2026-07-09T09:00:00Z', endedAt: '2026-07-09T09:01:00Z', status: 'Failed', error: 'SystemExit: mezcla de semanas en la landing <W27+W28>' }],
      health: { lastStatus: 'Failed', lastSuccessAt: null, ageSeconds: null, failed: true, missed: false },
    }]
    const a = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      domainFreshness: async () => FAILED,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const res = mockRes()
    await a.tryHandle(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD), res as unknown as ServerResponse)
    expect(res.body).toContain('✕ Falló')
    expect(res.body).toContain('SystemExit: mezcla de semanas en la landing &lt;W27+W28&gt;') // motivo visible y escapado
  })

  it('Frescura: un motivo de falla muy largo se recorta (los failureReason de Fabric traen stacks)', async () => {
    const LONG = 'x'.repeat(400)
    const FAILED: DomainEntityFreshness[] = [{
      ...FRESHNESS[0],
      runs: [{ startedAt: '2026-07-09T09:00:00Z', status: 'Failed', error: LONG }],
      health: { lastStatus: 'Failed', lastSuccessAt: null, ageSeconds: null, failed: true, missed: false },
    }]
    const a = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      domainFreshness: async () => FAILED,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const res = mockRes()
    await a.tryHandle(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD), res as unknown as ServerResponse)
    expect(res.body).toContain(`${'x'.repeat(300)}…`)
    expect(res.body).not.toContain('x'.repeat(301))
  })

  it('Otras cargas: un slot huérfano muestra su última corrida con motivo de falla (intakeStatus)', async () => {
    const SLOTS = parseIntakeConfig({
      slots: [{
        id: 'saldos', label: 'Antigüedad de saldos', domain: 'cartera', maxBytes: 1024,
        target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' },
        trigger: { processRef: 'PIPE-HUERFANO' },
      }],
    })
    const runs: RunRecord[] = [{ startedAt: '2026-07-09T09:00:00Z', status: 'Failed', error: 'SystemExit: mezcla de semanas' }]
    const a = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      domainFreshness: async () => [], // sin entidades: el slot cae en «Otras cargas»
      intakeSlots: SLOTS,
      intake: { put: async () => {} },
      intakeStatus: async () => runs,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const res = mockRes()
    await a.tryHandle(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD), res as unknown as ServerResponse)
    expect(res.body).toContain('Otras cargas')
    expect(res.body).toContain('Última corrida:')
    expect(res.body).toContain('✕ Falló')
    expect(res.body).toContain('SystemExit: mezcla de semanas')
  })

  it('Otras cargas: si el motor no responde, el slot lo dice en vez de callar', async () => {
    const SLOTS = parseIntakeConfig({
      slots: [{
        id: 'saldos', label: 'Antigüedad de saldos', domain: 'cartera', maxBytes: 1024,
        target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' },
        trigger: { processRef: 'PIPE-HUERFANO' },
      }],
    })
    const a = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      domainFreshness: async () => [],
      intakeSlots: SLOTS,
      intake: { put: async () => {} },
      intakeStatus: async () => { throw new Error('fabric caído') },
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const res = mockRes()
    await a.tryHandle(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD), res as unknown as ServerResponse)
    expect(res.body).toContain('No se pudo consultar el estado de la conversión')
  })

  it('Aplicar cadencia: POST con CSRF llama al reconciliador y redirige con mensaje', async () => {
    const page = await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))
    const token = tokenFrom(page.body)
    const body = `_csrf=${token}&process=p_sap`
    const res = await go(mockReq('POST', '/admin/dominio/cartera/frescura', STEWARD, body, 'application/x-www-form-urlencoded'))
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toContain('/admin/dominio/cartera/frescura?msg=')
    expect(applied).toEqual([{ processId: 'p_sap', by: STEWARD }])
  })
})
