import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  manualFedProcesses,
  reconcilePlan,
  SqliteGovernanceStore,
  SqliteMasterDataStore,
  SqliteAdminStore,
  parseMasterDataConfig,
  parseDomainsConfig,
  parseIntakeConfig,
  type IngestionEngineClient,
  type ProcessRow,
  type SourceRow,
  type RunRecord,
  type DeriveMapInput,
  type IntakeSlot,
} from '@vergis/capabilities'
import { createFreshnessLoop, type FreshnessLoopDeps } from '../server/freshness-loop'
import { createAdmin, type DomainEntityFreshness } from '../server/admin'

/**
 * #279 · «Aplicar cadencia» programaba corridas del motor TAMBIÉN en procesos que alimenta una carga
 * manual (land-and-trigger). Medido en A.R.B.O.L. (Finanzas, 2026-09-02): nueve corridas «Completed»
 * de un minuto sobre nada, cada miércoles, y un «✓ Listo» que se leyó como dato fresco mientras
 * `wh_finanzas` seguía en la semana 30 porque nadie subía el archivo desde julio.
 *
 * Las tres corridas que ponen el mecanismo en riesgo (Norma 7): si la distinción no existiera, el
 * motor fake recibiría `setScheduleSeconds` para el proceso manual (lo que hace `main` hoy), el
 * control POSITIVO no distinguiría nada, y la página seguiría ofreciendo el botón.
 */

// ─── 1 · la función pura ────────────────────────────────────────────────────────────────────────
describe('#279 · manualFedProcesses (pura)', () => {
  it('recoge los `trigger.processRef` y deja fuera los slots land-only (sin trigger)', () => {
    const slots = [
      { id: 'saldos', trigger: { processRef: 'SJD-FIN' } },
      { id: 'solo_aterriza' }, // land-only: nadie corre nada
      { id: 'oc', trigger: { processRef: 'SJD-OC' } },
    ]
    expect([...manualFedProcesses(slots)].sort()).toEqual(['SJD-FIN', 'SJD-OC'])
  })

  it('varios slots al MISMO proceso lo declaran una sola vez; el ref vacío no cuenta', () => {
    const slots = [
      { trigger: { processRef: 'SJD-FIN' } },
      { trigger: { processRef: 'SJD-FIN' } },
      { trigger: { processRef: '   ' } },
      { trigger: {} },
    ]
    expect([...manualFedProcesses(slots)]).toEqual(['SJD-FIN'])
  })

  it('sin slots, conjunto vacío (instancia sin intake: conducta idéntica a la de antes)', () => {
    expect(manualFedProcesses([]).size).toBe(0)
  })

  it('sale del YAML real de intake: un slot con `trigger` marca su proceso, uno sin `trigger` no', () => {
    const cfg = parseIntakeConfig({
      slots: [
        { id: 'saldos', label: 'Antigüedad de saldos', target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/landing' }, trigger: { processRef: 'SJD-FIN' } },
        { id: 'adjuntos', label: 'Adjuntos', target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/adj' } },
      ],
    })
    expect([...manualFedProcesses(cfg)]).toEqual(['SJD-FIN'])
  })
})

// ─── 2 · el plan del reconciliador ──────────────────────────────────────────────────────────────
describe('#279 · reconcilePlan con alimentación manual', () => {
  it('`vigilar` gana sobre `set` y sobre `noop`: la cadencia se vigila, no se programa', () => {
    expect(reconcilePlan(7200, null, true)).toEqual({ action: 'vigilar', desiredSeconds: 7200 })
    expect(reconcilePlan(7200, 86_400, true)).toEqual({ action: 'vigilar', desiredSeconds: 7200 })
    expect(reconcilePlan(7200, 7200, true)).toEqual({ action: 'vigilar', desiredSeconds: 7200 })
  })

  it('no es `noop`: `noop` diría «ya está como debe estar» y el feedback tiene que decir la verdad', () => {
    expect(reconcilePlan(7200, 86_400, true).action).not.toBe('noop')
  })

  it('sin la marca, el comportamiento de siempre (control positivo)', () => {
    expect(reconcilePlan(7200, 86_400)).toEqual({ action: 'set', desiredSeconds: 7200 })
    expect(reconcilePlan(7200, 7200)).toEqual({ action: 'noop', desiredSeconds: 7200 })
  })
})

// ─── 3 · el lazo (fase 3) con un motor que REGISTRA las llamadas ────────────────────────────────
class FakeEngine implements IngestionEngineClient {
  runs = new Map<string, RunRecord[]>()
  schedules = new Map<string, number | null>()
  sets: { processId: string; seconds: number }[] = []
  enables: { processId: string; enabled: boolean }[] = []
  async listRunHistory(id: string): Promise<RunRecord[]> {
    return this.runs.get(id) ?? []
  }
  async getScheduleSeconds(id: string): Promise<number | null> {
    return this.schedules.get(id) ?? null
  }
  async setScheduleSeconds(id: string, seconds: number): Promise<void> {
    this.sets.push({ processId: id, seconds })
    this.schedules.set(id, seconds)
  }
  async setScheduleEnabled(id: string, enabled: boolean): Promise<void> {
    this.enables.push({ processId: id, enabled })
  }
}

const T0 = Date.parse('2026-09-02T12:00:00.000Z')

/** Dos procesos: `p_manual` (item `SJD-FIN`, el del slot) y `p_motor` (item `SJD-SAP`, el que sí se programa). */
function inputsOf(): () => Promise<{ procs: ProcessRow[]; sources: SourceRow[]; mapInput: DeriveMapInput }> {
  const rows: ProcessRow[] = [
    { id: 'p_manual', label: 'Antigüedad de saldos', sourceId: 'src_manual', engine: { workspaceId: 'WS', itemId: 'SJD-FIN', jobType: 'sparkjob' } },
    { id: 'p_motor', label: 'Ventas SAP HANA', sourceId: 'src_motor', engine: { workspaceId: 'WS', itemId: 'SJD-SAP', jobType: 'sparkjob' } },
  ]
  const sources: SourceRow[] = [
    { id: 'src_manual', label: 'Planilla de Finanzas', oferta: 'P1W', domain: 'cartera' },
    { id: 'src_motor', label: 'SAP HANA', oferta: 'P1D', domain: 'cartera' },
  ]
  const mapInput: DeriveMapInput = {
    sources: sources.map((s) => ({ id: s.id, oferta: s.oferta })),
    processes: rows.map((r) => ({ id: r.id, label: r.label, sourceId: r.sourceId })),
    processOutputs: [],
    piTables: [],
    piDemandas: [],
  }
  return async () => ({ procs: rows, sources, mapInput })
}

async function armar(slots: { trigger?: { processRef?: string } }[]): Promise<{
  engine: FakeEngine
  logs: string[]
  audits: { type: string; [k: string]: unknown }[]
  store: SqliteGovernanceStore
  loop: { tick(): Promise<void> }
  clock: { ms: number }
}> {
  const store = await SqliteGovernanceStore.open(null, {})
  const engine = new FakeEngine()
  const logs: string[] = []
  const audits: { type: string; [k: string]: unknown }[] = []
  const clock = { ms: T0 }
  const deps: FreshnessLoopDeps = {
    engine,
    store,
    inputs: inputsOf(),
    domains: [{ id: 'cartera', label: 'Cartera / Finanzas' }],
    intakeSlots: () => slots,
    audit: (e) => void audits.push(e as { type: string }),
    log: (l) => void logs.push(l),
    now: () => clock.ms,
  }
  const loop = createFreshnessLoop(deps, { reconcile: true, reconcileDebounceMs: 1, publicUrl: 'https://mira.example.com' })
  return { engine, logs, audits, store, loop, clock }
}

describe('#279 · freshness-loop fase 3: los alimentados por carga manual se vigilan, no se programan', () => {
  it('EL EXPERIMENTO: con el slot declarado, el motor NO recibe ni un setScheduleSeconds para el proceso manual — y sí para el del motor (control positivo en la MISMA corrida)', async () => {
    const a = await armar([{ trigger: { processRef: 'SJD-FIN' } }])
    a.engine.schedules.set('p_manual', null)
    a.engine.schedules.set('p_motor', null)
    await a.loop.tick()
    expect(a.engine.sets.map((s) => s.processId)).toEqual(['p_motor'])
    expect(a.engine.sets).toEqual([{ processId: 'p_motor', seconds: 86_400 }])
    // Y no se toca el enable del manual desde el lazo: deshabilitar el residuo es acto del steward.
    expect(a.engine.enables).toEqual([])
    expect(a.audits.filter((e) => e.type === 'frescura-reconcile').map((e) => e.process)).toEqual(['p_motor'])
    await a.store.close()
  })

  it('CONTROL NEGATIVO del propio arnés: sin el slot, el proceso «manual» se programa como cualquier otro', async () => {
    const a = await armar([])
    a.engine.schedules.set('p_manual', null)
    a.engine.schedules.set('p_motor', null)
    await a.loop.tick()
    expect(a.engine.sets.map((s) => s.processId).sort()).toEqual(['p_manual', 'p_motor'])
    await a.store.close()
  })

  it('el aviso sale UNA sola vez por proceso, no en cada vuelta (el log del lazo es señal, no latido)', async () => {
    const a = await armar([{ trigger: { processRef: 'SJD-FIN' } }])
    a.engine.schedules.set('p_manual', null)
    a.engine.schedules.set('p_motor', 86_400)
    for (const salto of [0, 600_000, 1_200_000]) {
      a.clock.ms = T0 + salto
      await a.loop.tick()
    }
    const avisos = a.logs.filter((l) => l.includes('se alimenta por carga manual'))
    expect(avisos).toEqual(["frescura-loop: 'p_manual' se alimenta por carga manual: se vigila, no se programa"])
    expect(a.engine.sets).toEqual([])
    await a.store.close()
  })

  it('la VIGILANCIA sigue entera: la fase 1 observa el proceso manual igual (sus corridas se proyectan)', async () => {
    const a = await armar([{ trigger: { processRef: 'SJD-FIN' } }])
    a.engine.runs.set('p_manual', [{ startedAt: '2026-07-20T03:00:00Z', endedAt: '2026-07-20T03:01:00Z', status: 'Completed' }])
    await a.loop.tick()
    const snap = (await a.store.listRunSnapshots()).find((s) => s.processId === 'p_manual')
    expect(snap?.runs).toEqual([{ startedAt: '2026-07-20T03:00:00Z', endedAt: '2026-07-20T03:01:00Z', status: 'Completed' }])
    await a.store.close()
  })
})

// ─── 4 · la página de Frescura ──────────────────────────────────────────────────────────────────
const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const STEWARD = 'steward@gh.cl'
const ENTITIES = parseMasterDataConfig({ entities: [{ id: 'rel', label: 'Relacionadas', domain: 'cartera', columns: [{ name: 'rut', label: 'RUT', type: 'string', pk: true }] }] })
const DOMAINS = parseDomainsConfig({ domains: [{ id: 'cartera', label: 'Cartera / Finanzas', stewards: [STEWARD] }] })

/** Fila CON drift (schedule 7d ≠ cadencia req 1w… acá 1d) cuyo item es el que dispara el slot. */
const FILA: DomainEntityFreshness[] = [{
  entity: 'fct_saldos', processId: 'p_manual', processLabel: 'Antigüedad de saldos', oferta: 'P1W',
  dependentPis: ['PI-01'], tightestDemand: 'P1W', requiredCadence: 'P1W', requiredCadenceSeconds: 604_800, unsatisfiable: false,
  engine: true, engineJobType: 'sparkjob', engineItemId: 'SJD-FIN',
  runs: [{ startedAt: '2026-08-28T03:53:00Z', endedAt: '2026-08-28T03:54:00Z', status: 'Completed' }],
  health: { lastStatus: 'Completed', lastSuccessAt: '2026-08-28T03:54:00Z', ageSeconds: 100, failed: false, missed: false },
  actualScheduleSeconds: 86_400,
}]

const SLOT: IntakeSlot = {
  id: 'saldos_cartera',
  label: 'Antigüedad de saldos',
  domain: 'cartera',
  target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/landing' },
  trigger: { processRef: 'SJD-FIN' },
}

function mockReq(method: string, url: string, user: string, body = '', contentType?: string): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user }
  if (contentType) r.headers['content-type'] = contentType
  return r
}
interface MockRes { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(chunk?: string): void }
function mockRes(): MockRes {
  return { statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(chunk) { if (chunk) this.body += chunk } }
}

async function admin(slots: IntakeSlot[], applyResult: { action: 'set' | 'noop' | 'vigilar'; desiredSeconds: number; disabledSchedule?: boolean }) {
  return createAdmin({
    entities: ENTITIES,
    mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
    adminStore: await SqliteAdminStore.open(null, [ADMIN]),
    domains: DOMAINS,
    domainFreshness: async () => FILA,
    intakeSlots: slots,
    intake: { put: async () => {}, runNow: async () => {} },
    applyCadence: async () => applyResult,
    identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
    audit: () => {},
    secret: SECRET,
  })
}

describe('#279 · página de Frescura: el steward lee la razón, no un botón que miente', () => {
  it('con el slot declarado, la fila dice «se vigila, no se programa» y NO ofrece «Aplicar»', async () => {
    const h = await admin([SLOT], { action: 'vigilar', desiredSeconds: 604_800 })
    const res = mockRes()
    await h.tryHandle(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD), res as unknown as ServerResponse)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Alimentado por carga manual')
    expect(res.body).toContain('la cadencia se vigila, no se programa')
    expect(res.body).toContain('Antigüedad de saldos') // el label del slot, para saber cuál archivo subir
    expect(res.body).not.toContain('<button class="add">Aplicar</button>')
  })

  it('CONTROL POSITIVO: sin slot que lo dispare, la MISMA fila con drift sigue ofreciendo «Aplicar»', async () => {
    const h = await admin([], { action: 'set', desiredSeconds: 604_800 })
    const res = mockRes()
    await h.tryHandle(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD), res as unknown as ServerResponse)
    expect(res.body).toContain('<button class="add">Aplicar</button>')
    expect(res.body).not.toContain('la cadencia se vigila, no se programa')
  })

  it('el feedback del POST dice la verdad de por qué no se programó, y que se deshabilitó el residuo', async () => {
    const h = await admin([SLOT], { action: 'vigilar', desiredSeconds: 604_800, disabledSchedule: true })
    const get = mockRes()
    await h.tryHandle(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD), get as unknown as ServerResponse)
    const token = get.body.match(/name="_csrf" value="([0-9a-f]+)"/)![1]
    const res = mockRes()
    await h.tryHandle(
      mockReq('POST', '/admin/dominio/cartera/frescura', STEWARD, `_csrf=${token}&process=p_manual`, 'application/x-www-form-urlencoded'),
      res as unknown as ServerResponse,
    )
    const location = decodeURIComponent(res.headers['location'] ?? '')
    expect(location).toContain('se alimenta por carga manual: la cadencia se vigila, no se programa')
    expect(location).toContain('Se deshabilitó el schedule que corría sobre nada')
    expect(location).not.toContain('Cadencia aplicada al motor')
  })
})
