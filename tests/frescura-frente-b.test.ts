import { describe, it, expect } from 'vitest'
import {
  deriveEntityFreshness,
  createFabricScheduler,
  createFabricEngineClient,
  freshnessAlerts,
  diffAlertState,
  parseAlertState,
  SqliteGovernanceStore,
  type TokenSource,
  type EngineRef,
  type DeriveMapInput,
  type RunRecord,
} from '@vergis/capabilities'

const tokens: TokenSource = { getToken: async () => ({ token: 'BEARER123', expiresAt: Number.MAX_SAFE_INTEGER }) }

// ─── Proyección por ENTIDAD (la vista de Frescura del dominio) ───────────────
describe('deriveEntityFreshness · por entidad', () => {
  const input: DeriveMapInput = {
    sources: [
      { id: 'buk', oferta: 'P1D' }, // diaria
      { id: 'sap', oferta: 'PT1H' }, // horaria
    ],
    processes: [
      { id: 'p_buk', label: 'Ingesta Buk', sourceId: 'buk' },
      { id: 'p_sap', label: 'Ingesta SAP', sourceId: 'sap' },
    ],
    processOutputs: [
      { processId: 'p_buk', tableRef: 'fct_asistencia' },
      { processId: 'p_buk', tableRef: 'fct_extra' }, // sin consumidores
      { processId: 'p_sap', tableRef: 'fct_saldos' },
    ],
    piTables: [
      { piCode: 'PI-04', tables: ['fct_asistencia'] },
      { piCode: 'PI-01', tables: ['fct_saldos'] },
    ],
    piDemandas: [
      { piCode: 'PI-04', maxAge: 'PT1H' }, // exige horaria sobre fuente diaria → insatisfacible
      { piCode: 'PI-01', maxAge: 'PT2H' }, // exige 2h sobre fuente horaria → ok
    ],
  }

  it('ancla en la entidad: oferta, demanda más exigente, cadencia requerida (piso en oferta) e insatisfacible', () => {
    const rows = deriveEntityFreshness(input)
    expect(rows.map((r) => r.entity)).toEqual(['fct_asistencia', 'fct_extra', 'fct_saldos']) // ordenadas

    const asis = rows.find((r) => r.entity === 'fct_asistencia')!
    expect(asis.processId).toBe('p_buk')
    expect(asis.oferta).toBe('P1D')
    expect(asis.dependentPis).toEqual(['PI-04'])
    expect(asis.tightestDemand).toBe('PT1H')
    expect(asis.requiredCadenceSeconds).toBe(86_400) // piso en la oferta diaria
    expect(asis.unsatisfiable).toBe(true) // PT1H < P1D

    const saldos = rows.find((r) => r.entity === 'fct_saldos')!
    expect(saldos.oferta).toBe('PT1H')
    expect(saldos.tightestDemand).toBe('PT2H')
    expect(saldos.requiredCadenceSeconds).toBe(7_200) // max(2h, 1h) = 2h
    expect(saldos.unsatisfiable).toBe(false)
  })

  it('entidad sin demanda: tightestDemand null, cadencia requerida = oferta, no insatisfacible', () => {
    const extra = deriveEntityFreshness(input).find((r) => r.entity === 'fct_extra')!
    expect(extra.dependentPis).toEqual([])
    expect(extra.tightestDemand).toBeNull()
    expect(extra.requiredCadenceSeconds).toBe(86_400) // la oferta
    expect(extra.unsatisfiable).toBe(false)
  })
})

// ─── Cliente de schedule de Fabric (Job Scheduler API) ───────────────────────
interface SCall { url: string; method: string; body?: string }
function schedMock(schedules: unknown[], calls: SCall[] = []): typeof fetch {
  return (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
    const value = String(url).includes('/schedules') ? schedules : []
    return { ok: true, status: 200, text: async () => '', json: async () => ({ value }) } as unknown as Response
  }) as unknown as typeof fetch
}
const eng: EngineRef = { workspaceId: 'WS', itemId: 'SJD', jobType: 'sparkjob' }
const fixedClock = () => Date.parse('2026-06-24T00:00:00Z')

describe('createFabricScheduler · get/set', () => {
  it('getScheduleSeconds: Cron interval (min) → segundos; prefiere el habilitado', async () => {
    const sched = createFabricScheduler(tokens, { fetch: schedMock([
      { id: 's0', enabled: false, configuration: { type: 'Cron', interval: 5 } },
      { id: 's1', enabled: true, configuration: { type: 'Cron', interval: 60 } },
    ]), now: fixedClock })
    expect(await sched.getScheduleSeconds(eng)).toBe(3_600)
  })

  it('getScheduleSeconds: Daily/Weekly aproximados; sin schedule → null', async () => {
    const daily = createFabricScheduler(tokens, { fetch: schedMock([{ id: 'd', enabled: true, configuration: { type: 'Daily' } }]), now: fixedClock })
    expect(await daily.getScheduleSeconds(eng)).toBe(86_400)
    const none = createFabricScheduler(tokens, { fetch: schedMock([]), now: fixedClock })
    expect(await none.getScheduleSeconds(eng)).toBeNull()
  })

  it('setScheduleSeconds: PATCH al schedule existente, intervalo en minutos, tipo Cron', async () => {
    const calls: SCall[] = []
    const sched = createFabricScheduler(tokens, { fetch: schedMock([{ id: 's1', enabled: true, configuration: { type: 'Cron', interval: 1440 } }], calls), now: fixedClock })
    await sched.setScheduleSeconds(eng, 7_200) // 2h → 120 min
    const write = calls.find((c) => c.method === 'PATCH')!
    expect(write.url).toContain('/jobs/sparkjob/schedules/s1')
    const body = JSON.parse(write.body!)
    expect(body.configuration.type).toBe('Cron')
    expect(body.configuration.interval).toBe(120)
  })

  it('setScheduleSeconds: sin schedule previo → POST (crea)', async () => {
    const calls: SCall[] = []
    const sched = createFabricScheduler(tokens, { fetch: schedMock([], calls), now: fixedClock })
    await sched.setScheduleSeconds(eng, 3_600)
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toMatch(/\/jobs\/sparkjob\/schedules$/)
    expect(JSON.parse(post.body!).configuration.interval).toBe(60)
  })

  // #107 · pausa: se apaga el schedule SIN tocar su configuración (eco de la leída). Con el motor
  // aceptando el PATCH, la pausa es reversible sin perder la cadencia que ya estaba escrita.
  it('setScheduleEnabled(false): PATCH con enabled:false y ECO de la configuración leída', async () => {
    const calls: SCall[] = []
    const cfg = { type: 'Cron' as const, interval: 120 }
    const sched = createFabricScheduler(tokens, { fetch: schedMock([{ id: 's1', enabled: true, configuration: cfg }], calls), now: fixedClock })
    await sched.setScheduleEnabled(eng, false)
    const write = calls.find((c) => c.method === 'PATCH')!
    expect(write.url).toContain('/jobs/sparkjob/schedules/s1')
    expect(JSON.parse(write.body!)).toEqual({ enabled: false, configuration: cfg })
  })

  it('setScheduleEnabled(false) sin schedules: CERO escrituras y resuelve (no hay nada que apagar)', async () => {
    const calls: SCall[] = []
    const sched = createFabricScheduler(tokens, { fetch: schedMock([], calls), now: fixedClock })
    await sched.setScheduleEnabled(eng, false)
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('setScheduleEnabled(true) sin schedule: lanza nombrando setScheduleSeconds (habilitar exige cadencia)', async () => {
    const sched = createFabricScheduler(tokens, { fetch: schedMock([]), now: fixedClock })
    await expect(sched.setScheduleEnabled(eng, true)).rejects.toThrow(/setScheduleSeconds/)
  })

  it('setScheduleEnabled: un error HTTP del motor lanza con su status (la pausa NO se da por buena)', async () => {
    const fetchErr = (async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'GET') return { ok: true, status: 200, text: async () => '', json: async () => ({ value: [{ id: 's1', enabled: true, configuration: { type: 'Cron', interval: 60 } }] }) } as unknown as Response
      return { ok: false, status: 403, text: async () => 'Forbidden', json: async () => ({}) } as unknown as Response
    }) as unknown as typeof fetch
    const sched = createFabricScheduler(tokens, { fetch: fetchErr, now: fixedClock })
    await expect(sched.setScheduleEnabled(eng, false)).rejects.toThrow(/403/)
  })
})

// ─── Engine client (resuelve processRef → EngineRef) ─────────────────────────
describe('createFabricEngineClient · resuelve engine_ref', () => {
  const resolver = async (ref: string): Promise<EngineRef | undefined> => (ref === 'p1' ? eng : undefined)

  it('listRunHistory: con engine_ref lee jobs/instances; sin engine_ref → []', async () => {
    const runs = [{ status: 'Completed', startTimeUtc: '2026-06-24T09:00:00Z', endTimeUtc: '2026-06-24T09:01:00Z' }]
    const fetchMock = (async (url: string) => {
      const value = String(url).includes('/jobs/instances') ? runs : []
      return { ok: true, status: 200, text: async () => '', json: async () => ({ value }) } as unknown as Response
    }) as unknown as typeof fetch
    const client = createFabricEngineClient(tokens, resolver, { fetch: fetchMock, now: fixedClock })
    expect((await client.listRunHistory('p1')).map((r) => r.status)).toEqual(['Completed'])
    expect(await client.listRunHistory('unknown')).toEqual([]) // sin engine_ref, no observable
  })

  it('setScheduleSeconds sin engine_ref → lanza con mensaje claro', async () => {
    const client = createFabricEngineClient(tokens, resolver, { fetch: schedMock([]), now: fixedClock })
    await expect(client.setScheduleSeconds('unknown', 3_600)).rejects.toThrow(/engine_ref/)
    expect(await client.getScheduleSeconds('unknown')).toBeNull()
  })

  it('setScheduleEnabled sin engine_ref: apagar es no-op, encender lanza (#107)', async () => {
    const calls: SCall[] = []
    const client = createFabricEngineClient(tokens, resolver, { fetch: schedMock([], calls), now: fixedClock })
    await client.setScheduleEnabled('unknown', false) // resuelve sin tocar el motor
    expect(calls).toEqual([])
    await expect(client.setScheduleEnabled('unknown', true)).rejects.toThrow(/engine_ref/)
  })
})

// ─── Alerta autónoma (detección + transición/dedup) ──────────────────────────
describe('freshnessAlerts + diffAlertState · alerta autónoma', () => {
  const now = Date.parse('2026-06-24T12:00:00Z')
  const ok: RunRecord = { startedAt: '2026-06-24T11:30:00Z', endedAt: '2026-06-24T11:31:00Z', status: 'Completed' }
  const failed: RunRecord = { startedAt: '2026-06-24T11:55:00Z', endedAt: '2026-06-24T11:55:30Z', status: 'Failed', error: 'boom' }
  const stale: RunRecord = { startedAt: '2026-06-20T00:00:00Z', endedAt: '2026-06-20T00:05:00Z', status: 'Completed' } // hace días

  it('detecta fallida (con error) y faltante (antigüedad > cadencia); sana no alerta', () => {
    const alerts = freshnessAlerts(
      [
        { processId: 'p_fail', runs: [failed], requiredCadenceSeconds: 3600 },
        { processId: 'p_stale', runs: [stale], requiredCadenceSeconds: 3600 }, // diaria exigida, última hace días
        { processId: 'p_ok', runs: [ok], requiredCadenceSeconds: 3600 },
        { processId: 'p_nodemand', runs: [stale], requiredCadenceSeconds: Number.POSITIVE_INFINITY }, // nadie demanda → no «missed»
      ],
      now,
    )
    const byId = Object.fromEntries(alerts.map((a) => [a.processId, a]))
    expect(byId['p_fail'].reason).toBe('failed')
    expect(byId['p_fail'].lastError).toBe('boom')
    expect(byId['p_stale'].reason).toBe('missed')
    expect(byId['p_ok']).toBeUndefined()
    expect(byId['p_nodemand']).toBeUndefined() // sin demanda no se exige frescura
  })

  it('diffAlertState: solo notifica transiciones (nuevas/cambiadas) y reporta recuperados', () => {
    const current = freshnessAlerts([{ processId: 'p_fail', runs: [failed], requiredCadenceSeconds: 3600 }], now)
    // primera vez: notifica
    const first = diffAlertState({}, current)
    expect(first.notify.map((a) => a.processId)).toEqual(['p_fail'])
    // segunda vez con el mismo estado: NO re-notifica
    const second = diffAlertState(first.next, current)
    expect(second.notify).toEqual([])
    // el proceso se recupera (ya no está en current): se reporta como recuperado
    const third = diffAlertState(first.next, [])
    expect(third.recovered).toEqual(['p_fail'])
    expect(third.next).toEqual({})
  })
})

// ─── engine_ref + domain en el GovernanceStore ───────────────────────────────
describe('GovernanceStore · engine_ref del proceso y dominio de la fuente', () => {
  it('upsertProcess persiste engine_ref; re-upsert sin engine lo PRESERVA (COALESCE)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertProcess('p_sap', 'Pipeline saldos', 'sap', { workspaceId: 'W', itemId: 'I', jobType: 'sparkjob' })
    let p = (await g.listProcesses()).find((x) => x.id === 'p_sap')!
    expect(p.engine).toEqual({ workspaceId: 'W', itemId: 'I', jobType: 'sparkjob' })
    // re-upsert SOLO label, sin engine → el engine_ref no se borra
    await g.upsertProcess('p_sap', 'Pipeline saldos (v2)', 'sap')
    p = (await g.listProcesses()).find((x) => x.id === 'p_sap')!
    expect(p.label).toBe('Pipeline saldos (v2)')
    expect(p.engine?.itemId).toBe('I')
    await g.close()
  })

  it('upsertSource guarda el dominio (tag); jobType default Pipeline si no se da', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertSource('buk', 'Buk RRHH', 'P1D', { domain: 'personas' })
    expect((await g.listSources()).find((s) => s.id === 'buk')!.domain).toBe('personas')
    await g.upsertProcess('p_buk', 'Ingesta Buk', 'buk', { workspaceId: 'W', itemId: 'I', jobType: '' })
    expect((await g.listProcesses()).find((x) => x.id === 'p_buk')!.engine?.jobType).toBe('Pipeline')
    await g.close()
  })
})

describe('P-31 · el estado de alertas sobrevive al reinicio', () => {
  it('parseAlertState: lee lo que setSetting guardó', () => {
    const guardado = JSON.stringify({ 'ingest-finanzas': 'failed', 'ingest-ventas': 'missed' })
    expect(parseAlertState(guardado)).toEqual({ 'ingest-finanzas': 'failed', 'ingest-ventas': 'missed' })
  })

  it('parseAlertState: sin estado previo (primer arranque) devuelve vacío', () => {
    expect(parseAlertState(null)).toEqual({})
    expect(parseAlertState('')).toEqual({})
  })

  it('parseAlertState: es fail-safe ante basura, forma vieja o razones desconocidas', () => {
    expect(parseAlertState('{no es json')).toEqual({})
    expect(parseAlertState('["ingest-a"]')).toEqual({})
    expect(parseAlertState('null')).toEqual({})
    expect(parseAlertState(JSON.stringify({ a: 'failed', b: 'explotó', c: 42 }))).toEqual({ a: 'failed' })
  })

  it('el ciclo completo NO re-notifica tras un reinicio', () => {
    const procs = [
      { processId: 'ingest-finanzas', runs: [{ status: 'Failed' as const, startedAt: new Date(Date.now() - 60_000).toISOString() }], requiredCadenceSeconds: 86_400 },
    ]
    // Sesión 1: la alerta es nueva → se notifica y el estado se persiste.
    const s1 = diffAlertState({}, freshnessAlerts(procs, Date.now()))
    expect(s1.notify).toHaveLength(1)
    const persistido = JSON.stringify(s1.next)

    // Reinicio: el estado se hidrata desde el store y la MISMA falla ya no vuelve a gritar.
    const s2 = diffAlertState(parseAlertState(persistido), freshnessAlerts(procs, Date.now()))
    expect(s2.notify).toHaveLength(0)
    expect(s2.recovered).toHaveLength(0)

    // Si en cambio el estado se hubiera perdido (el comportamiento viejo), habría re-notificado.
    expect(diffAlertState({}, freshnessAlerts(procs, Date.now())).notify).toHaveLength(1)
  })

  it('tras el reinicio, la recuperación se sigue detectando', () => {
    const persistido = JSON.stringify({ 'ingest-finanzas': 'failed' })
    const sano = [{ processId: 'ingest-finanzas', runs: [{ status: 'Completed' as const, startedAt: new Date().toISOString() }], requiredCadenceSeconds: 86_400 }]
    const s = diffAlertState(parseAlertState(persistido), freshnessAlerts(sano, Date.now()))
    expect(s.recovered).toEqual(['ingest-finanzas'])
    expect(s.next).toEqual({})
  })
})
