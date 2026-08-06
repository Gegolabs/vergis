/**
 * Issue #101 · La vista transversal de Fuentes responde «¿mis ingestas corrieron?» para TODA la instancia.
 *
 * El síntoma que se observa acá es el HTML del GET `/admin/sources`: por proceso, su schedule observado y
 * su última corrida con desenlace y salud — con los MISMOS textos de la Frescura por dominio (#105/#99),
 * que este frente hereda vía el helper compartido `runStateCell`. La proyección es FAKE: la vista jamás
 * pega al motor, así que testearla no exige uno.
 *
 * Regla de oro: sin `processStates` cableada la página es EXACTAMENTE la de hoy (caso «modo registro»).
 */
import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminDeps, type AdminHandler, type ProcessIngestionState, type RunLogsOps } from '../server/admin'
import { parseMasterDataConfig, parseDomainsConfig, SqliteMasterDataStore, SqliteAdminStore, type SourceRow, type ProcessRow } from '@vergis/capabilities'

const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const STEWARD = 'steward@gh.cl'

const ENTITIES = parseMasterDataConfig({ entities: [{ id: 'rel', label: 'Relacionadas', domain: 'cartera', columns: [{ name: 'rut', label: 'RUT', type: 'string', pk: true }] }] })
const DOMAINS = parseDomainsConfig({ domains: [{ id: 'cartera', label: 'Cartera / Finanzas', stewards: [STEWARD] }] })

const SOURCES: SourceRow[] = [{ id: 'sap', label: 'SAP B1', oferta: 'PT1H', domain: 'cartera', connectedBy: 'cesar@x.com' }]
const PROCESSES: ProcessRow[] = [{ id: 'p_sap', label: 'Ingesta SAP', sourceId: 'sap', engine: { workspaceId: 'WS', itemId: 'SJD', jobType: 'sparkjob' } }]
const OUTPUTS = [{ processId: 'p_sap', tableRef: 'fct_saldos' }]

const haceMinutos = (m: number): string => new Date(Date.now() - m * 60_000).toISOString()
const FRESCA = { observedAt: haceMinutos(1), stale: false, lastError: null, off: false }

/** Estado sano por default; cada caso lo dobla en lo que le importa. */
const estado = (over: Partial<ProcessIngestionState> = {}): ProcessIngestionState => ({
  processId: 'p_sap',
  runs: [{ startedAt: haceMinutos(30), endedAt: haceMinutos(29), status: 'Completed' }],
  scheduleSeconds: 7200,
  health: { lastStatus: 'Completed', lastSuccessAt: haceMinutos(29), ageSeconds: 1740, failed: false, missed: false },
  projection: FRESCA,
  ...over,
})

const RUN_LOGS: RunLogsOps = {
  refOf: async () => null,
  list: async () => [],
  read: async () => null,
  runsOf: async () => [],
}

function mockReq(method: string, url: string, user: string): IncomingMessage {
  const r = Readable.from(['']) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url; r.method = method; r.headers = { 'x-test-user': user }
  return r
}
interface MockRes { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(chunk?: string): void }
function mockRes(): MockRes {
  return { statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(chunk) { if (chunk) this.body += chunk } }
}

async function build(over: Partial<AdminDeps> = {}): Promise<AdminHandler> {
  return createAdmin({
    entities: ENTITIES,
    mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
    adminStore: await SqliteAdminStore.open(null, [ADMIN]),
    domains: DOMAINS,
    sourceRegistry: async () => ({ sources: SOURCES, processes: PROCESSES, outputs: OUTPUTS }),
    processStates: async () => [estado()],
    identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
    audit: () => {},
    secret: SECRET,
    ...over,
  })
}

/** GET `/admin/sources` como admin, con las deps dobladas del caso. */
async function sources(over: Partial<AdminDeps> = {}, user = ADMIN): Promise<MockRes> {
  const admin = await build(over)
  const res = mockRes()
  await admin.tryHandle(mockReq('GET', '/admin/sources', user), res as unknown as ServerResponse)
  return res
}

describe('admin · Fuentes con estado de las ingestas (#101)', () => {
  it('c1 · sana: desenlace, edad, bandera ✓ y schedule observado en la misma fila', async () => {
    const res = await sources()
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('✓ Listo')
    expect(res.body).toContain('hace ')
    expect(res.body).toContain(' · ✓')
    expect(res.body).toContain('PT2H')
    expect(res.body).toContain('Última corrida')
  })

  it('c2 · fallida: ✕ Falló, bandera fallida y el motivo recortado a la vista', async () => {
    const res = await sources({
      processStates: async () => [estado({
        runs: [{ startedAt: haceMinutos(10), status: 'Failed', error: 'OutOfMemoryError en el executor' }],
        health: { lastStatus: 'Failed', lastSuccessAt: null, ageSeconds: null, failed: true, missed: true },
      })],
    })
    expect(res.body).toContain('✕ Falló')
    expect(res.body).toContain(' · ✕ fallida')
    expect(res.body).toContain('OutOfMemoryError en el executor')
  })

  it('c3 · atrasada: sin éxito reciente vs la cadencia ⇒ ⚠️ atrasada', async () => {
    const res = await sources({
      processStates: async () => [estado({
        health: { lastStatus: 'Completed', lastSuccessAt: haceMinutos(6000), ageSeconds: 360_000, failed: false, missed: true },
      })],
    })
    expect(res.body).toContain(' · ⚠️ atrasada')
  })

  it('c4 · fallida SIN cadencia (event-driven): la última fallida nunca luce ✓', async () => {
    const res = await sources({
      processStates: async () => [estado({
        runs: [{ startedAt: haceMinutos(5), status: 'Failed', error: 'boom' }],
        health: undefined,
      })],
    })
    expect(res.body).toContain(' · ✕ fallida')
    expect(res.body).not.toContain(' · ✓')
  })

  it('c5 · proyección fría: dice que espera el primer refresco y NO afirma nada del schedule', async () => {
    const res = await sources({
      processStates: async () => [estado({ runs: [], scheduleSeconds: null, health: undefined, projection: { observedAt: null, stale: false, lastError: null, off: false } })],
    })
    expect(res.body).toContain('esperando el primer refresco del motor')
    expect(res.body).not.toContain('sin schedule')
    expect(res.body).not.toContain('sin corridas')
  })

  it('c6 · schedule observado y vacío: «sin schedule» (la ausencia ES información)', async () => {
    const res = await sources({ processStates: async () => [estado({ scheduleSeconds: null })] })
    expect(res.body).toContain('sin schedule')
  })

  it('c7 · stale y off: el estado del refresco viaja en la celda, con los textos sellados', async () => {
    const stale = await sources({
      processStates: async () => [estado({ projection: { observedAt: haceMinutos(120), stale: true, lastError: null, off: false } })],
    })
    expect(stale.body).toContain('el refresco no está corriendo')
    const off = await sources({
      processStates: async () => [estado({ projection: { observedAt: haceMinutos(120), stale: true, lastError: null, off: true } })],
    })
    expect(off.body).toContain('refresco apagado')
  })

  it('c8 · proceso sin engine_ref: se DECLARA no observable, y no se ofrece log de una corrida inexistente', async () => {
    const res = await sources({
      sourceRegistry: async () => ({ sources: SOURCES, processes: [{ id: 'p_man', label: 'Carga manual', sourceId: 'sap' }], outputs: [] }),
      processStates: async () => [],
      runLogs: RUN_LOGS,
    })
    expect(res.body).toContain('no observable (sin motor)')
    expect(res.body).not.toContain('/corrida?')
  })

  it('c9 · enlaces: dominio → Frescura, corrida → la página de #99; sin runLogs no hay «Ver log»', async () => {
    const con = await sources({ runLogs: RUN_LOGS })
    expect(con.body).toContain('href="/admin/dominio/cartera/frescura"')
    expect(con.body).toContain('corrida?proc=p_sap&amp;started=')

    const sin = await sources()
    expect(sin.body).not.toContain('/corrida?')

    const huerfana = await sources({
      sourceRegistry: async () => ({ sources: [{ id: 'sap', label: 'SAP B1', oferta: 'PT1H' }], processes: PROCESSES, outputs: OUTPUTS }),
      runLogs: RUN_LOGS,
    })
    expect(huerfana.body).not.toContain('/corrida?')
    expect(huerfana.body).not.toContain('/frescura"')
  })

  it('c10 · orden: por dominio ASC, las fuentes sin dominio al final', async () => {
    const res = await sources({
      sourceRegistry: async () => ({
        sources: [
          { id: 's_zeta', label: 'Zeta', oferta: 'P1D', domain: 'zeta' },
          { id: 's_huerfana', label: 'Huerfana', oferta: 'P1D' },
          { id: 's_alfa', label: 'Alfa', oferta: 'P1D', domain: 'alfa' },
        ],
        processes: [],
        outputs: [],
      }),
    })
    const iAlfa = res.body.indexOf('s_alfa')
    const iZeta = res.body.indexOf('s_zeta')
    const iHuerfana = res.body.indexOf('s_huerfana')
    expect(iAlfa).toBeGreaterThan(-1)
    expect(iAlfa).toBeLessThan(iZeta)
    expect(iZeta).toBeLessThan(iHuerfana)
  })

  it('c11 · una fila por PROCESO: las celdas de la fuente se funden con rowspan', async () => {
    const res = await sources({
      sourceRegistry: async () => ({
        sources: SOURCES,
        processes: [...PROCESSES, { id: 'p_sap2', label: 'Ingesta SAP maestros', sourceId: 'sap', engine: { workspaceId: 'WS', itemId: 'SJ2', jobType: 'sparkjob' } }],
        outputs: OUTPUTS,
      }),
      processStates: async () => [estado(), estado({ processId: 'p_sap2' })],
    })
    expect(res.body).toContain('rowspan="2"')
    expect(res.body).toContain('p_sap2')
  })

  it('c12 · sin processStates: la página es EXACTAMENTE la de hoy (registro puro)', async () => {
    const res = await sources({
      processStates: undefined,
      sourceRegistry: async () => ({ sources: SOURCES, processes: [{ id: 'p_man', label: 'Carga manual', sourceId: 'sap' }], outputs: [] }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('Última corrida')
    expect(res.body).not.toContain('/corrida?')
    expect(res.body).toContain('sin motor (no observable)')
    expect(res.body).toContain('Procesos → entidades')
  })

  it('c13 · fail-safe: si la lectura de estado revienta, se muestra el registro con aviso — nunca un 500', async () => {
    const res = await sources({ processStates: async () => { throw new Error('sqlite down') } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('No se pudo leer el estado de las ingestas')
    expect(res.body).not.toContain('Última corrida')
  })

  it('c14 · una sola lectura de la proyección por GET (cero awaits por fila)', async () => {
    let n = 0
    const res = await sources({
      sourceRegistry: async () => ({
        sources: [...SOURCES, { id: 'buk', label: 'Buk', oferta: 'P1D', domain: 'rrhh' }],
        processes: [...PROCESSES, { id: 'p_buk', label: 'Ingesta Buk', sourceId: 'buk', engine: { workspaceId: 'WS', itemId: 'NB', jobType: 'sparkjob' } }],
        outputs: OUTPUTS,
      }),
      processStates: async () => { n += 1; return [estado(), estado({ processId: 'p_buk' })] },
    })
    expect(res.statusCode).toBe(200)
    expect(n).toBe(1)
  })

  it('c15 · el gate no se movió: la vista sigue siendo solo de plataforma', async () => {
    expect((await sources({}, STEWARD)).statusCode).toBe(403)
  })
})
