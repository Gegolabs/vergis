import { describe, it, expect, vi } from 'vitest'
import {
  SqliteGovernanceStore,
  FRESHNESS_ALERT_STATE_KEY,
  type IngestionEngineClient,
  type ProcessRow,
  type SourceRow,
  type RunRecord,
  type DeriveMapInput,
} from '@vergis/capabilities'
import { createFreshnessLoop, type FreshnessLoopDeps } from '../server/freshness-loop'
import type { Notification } from '../server/notify'

/**
 * Motor FAKE (issue #105): corridas y schedules programables, «caído» por proceso, y —clave— el
 * REDONDEO a minutos de Fabric (`secondsToIntervalMinutes = max(1, floor(s/60))`, leído de vuelta
 * como `interval*60`). Ese redondeo es el mecanismo que hace que un `desired` no múltiplo de 60 NO
 * converja jamás: es lo que el test del debounce pone en riesgo.
 */
class FakeEngine implements IngestionEngineClient {
  runs = new Map<string, RunRecord[]>()
  schedules = new Map<string, number | null>()
  down = new Set<string>()
  sets: { processId: string; seconds: number }[] = []
  redondeaAMinutos = false

  private guard(id: string): void {
    if (this.down.has(id)) throw new Error(`motor caído (${id})`)
  }
  async listRunHistory(id: string): Promise<RunRecord[]> {
    this.guard(id)
    return this.runs.get(id) ?? []
  }
  async getScheduleSeconds(id: string): Promise<number | null> {
    this.guard(id)
    return this.schedules.get(id) ?? null
  }
  async setScheduleSeconds(id: string, seconds: number): Promise<void> {
    this.guard(id)
    this.sets.push({ processId: id, seconds })
    this.schedules.set(id, this.redondeaAMinutos ? Math.max(1, Math.floor(seconds / 60)) * 60 : seconds)
  }
  async setScheduleEnabled(id: string, enabled: boolean): Promise<void> {
    this.guard(id)
    this.enables.push({ processId: id, enabled })
  }
  enables: { processId: string; enabled: boolean }[] = []
}

const T0 = Date.parse('2026-08-06T12:00:00.000Z')
const PUBLIC_URL = 'https://mira.example.com'
/** Dominio declarado del arnés: solo los declarados aportan label y enlace al aviso (#100). */
const DOMINIOS = [{ id: 'cartera', label: 'Cartera / Finanzas' }]

/** Un proceso del arnés: su oferta y, opcionalmente, el dominio que tagea su fuente y su label humano. */
interface ProcSpec {
  id: string
  oferta: string
  label?: string
  domain?: string
  pausedAt?: string
}

/** Insumos del lazo: un proceso observable por fuente, sin PIs (la cadencia requerida = la oferta). */
function inputsOf(procs: ProcSpec[]): () => Promise<{ procs: ProcessRow[]; sources: SourceRow[]; mapInput: DeriveMapInput }> {
  const rows: ProcessRow[] = procs.map((p) => ({
    id: p.id,
    label: p.label ?? p.id,
    sourceId: `src_${p.id}`,
    engine: { workspaceId: 'WS', itemId: `item_${p.id}`, jobType: 'sparkjob' },
    ...(p.pausedAt ? { pausedAt: p.pausedAt, pausedBy: 'steward@gh.cl' } : {}),
  }))
  const sources: SourceRow[] = procs.map((p) => ({
    id: `src_${p.id}`,
    label: `Fuente de ${p.id}`,
    oferta: p.oferta,
    ...(p.domain ? { domain: p.domain } : {}),
  }))
  const mapInput: DeriveMapInput = {
    sources: procs.map((p) => ({ id: `src_${p.id}`, oferta: p.oferta })),
    processes: rows.map((r) => ({ id: r.id, label: r.label, sourceId: r.sourceId })),
    processOutputs: [],
    piTables: [],
    piDemandas: [],
  }
  return async () => ({ procs: rows, sources, mapInput })
}

interface Arnes {
  store: SqliteGovernanceStore
  engine: FakeEngine
  alerts: Notification[]
  audits: { type: string; [k: string]: unknown }[]
  logs: string[]
  clock: { ms: number }
  loop: { tick(): Promise<void> }
  snap: (pid: string) => Promise<{ runs: RunRecord[]; scheduleSeconds: number | null; observedAt: string | null; lastError: string | null } | undefined>
}

async function armar(opts: {
  procs: ProcSpec[]
  alertas?: boolean
  reconcile?: boolean
  debounceMs?: number
  storeOverride?: (store: SqliteGovernanceStore) => FreshnessLoopDeps['store']
}): Promise<Arnes> {
  const store = await SqliteGovernanceStore.open(null, {})
  const engine = new FakeEngine()
  const alerts: Notification[] = []
  const audits: { type: string; [k: string]: unknown }[] = []
  const logs: string[] = []
  const clock = { ms: T0 }
  const deps: FreshnessLoopDeps = {
    engine,
    store: opts.storeOverride ? opts.storeOverride(store) : store,
    inputs: inputsOf(opts.procs),
    domains: DOMINIOS,
    audit: (e) => void audits.push(e as { type: string }),
    log: (l) => void logs.push(l),
    now: () => clock.ms,
  }
  if (opts.alertas !== false) deps.notify = async (n) => void alerts.push(n)
  const loop = createFreshnessLoop(deps, {
    reconcile: opts.reconcile ?? false,
    reconcileDebounceMs: opts.debounceMs ?? 21_600_000,
    publicUrl: PUBLIC_URL,
  })
  return {
    store,
    engine,
    alerts,
    audits,
    logs,
    clock,
    loop,
    snap: async (pid) => (await store.listRunSnapshots()).find((s) => s.processId === pid),
  }
}

describe('freshness-loop · fase 1: observar → proyección (#105)', () => {
  it('un tick puebla la proyección; el siguiente agrega la corrida nueva y cierra la InProgress', async () => {
    const a = await armar({ procs: [{ id: 'p', oferta: 'PT1H' }] })
    a.engine.schedules.set('p', 3600)
    a.engine.runs.set('p', [{ startedAt: '2026-08-06T11:55:00Z', status: 'InProgress' }])
    await a.loop.tick()
    expect((await a.snap('p'))?.runs).toEqual([{ startedAt: '2026-08-06T11:55:00Z', status: 'InProgress' }])
    expect((await a.snap('p'))?.scheduleSeconds).toBe(3600)

    a.clock.ms = T0 + 300_000
    a.engine.runs.set('p', [
      { startedAt: '2026-08-06T12:03:00Z', status: 'InProgress' },
      { startedAt: '2026-08-06T11:55:00Z', endedAt: '2026-08-06T11:58:00Z', status: 'Completed' },
    ])
    await a.loop.tick()
    const s = await a.snap('p')
    expect(s?.runs.map((r) => `${r.startedAt}:${r.status}`)).toEqual(['2026-08-06T12:03:00Z:InProgress', '2026-08-06T11:55:00Z:Completed'])
    expect(s?.observedAt).toBe(new Date(T0 + 300_000).toISOString())
    await a.store.close()
  })

  it('motor caído: la proyección conserva lo último conocido con su lastError, y NO se fabrica un `missed`', async () => {
    const a = await armar({ procs: [{ id: 'p', oferta: 'PT1H' }] })
    a.engine.schedules.set('p', 3600)
    a.engine.runs.set('p', [{ startedAt: '2026-08-06T11:50:00Z', endedAt: '2026-08-06T11:52:00Z', status: 'Completed' }])
    await a.loop.tick()
    expect(a.alerts).toEqual([])

    a.clock.ms = T0 + 300_000
    a.engine.down.add('p')
    await a.loop.tick()
    const s = await a.snap('p')
    expect(s?.runs.map((r) => r.startedAt)).toEqual(['2026-08-06T11:50:00Z']) // lo último conocido, intacto
    expect(s?.scheduleSeconds).toBe(3600)
    expect(s?.observedAt).toBe(new Date(T0).toISOString()) // la observación exitosa sigue siendo la del tick 1
    expect(s?.lastError).toMatch(/motor caído/)
    expect(a.alerts).toEqual([]) // el motor caído NO es un proceso atrasado
    await a.store.close()
  })

  it('motor caído Y reloj más allá de la cadencia: SÍ notifica atrasada (la edad corre sobre lo proyectado)', async () => {
    const a = await armar({ procs: [{ id: 'p', oferta: 'PT1H' }] })
    a.engine.schedules.set('p', 3600)
    a.engine.runs.set('p', [{ startedAt: '2026-08-06T11:50:00Z', endedAt: '2026-08-06T11:52:00Z', status: 'Completed' }])
    await a.loop.tick()
    a.clock.ms = T0 + 3 * 3600_000
    a.engine.down.add('p')
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)
    expect(a.alerts[0]!.title).toContain('atrasada')
    await a.store.close()
  })

  it('un fallo del propio lazo (inputs() lanza) no propaga: el tick resuelve y lo deja en el log', async () => {
    const a = await armar({ procs: [] })
    const loop = createFreshnessLoop(
      { engine: a.engine, store: a.store, inputs: async () => { throw new Error('store no responde') }, domains: DOMINIOS, audit: () => {}, log: (l) => void a.logs.push(l) },
      { reconcile: true, reconcileDebounceMs: 1000, publicUrl: PUBLIC_URL },
    )
    await expect(loop.tick()).resolves.toBeUndefined()
    expect(a.logs.some((l) => l.includes('vuelta fallida') && l.includes('store no responde'))).toBe(true)
    await a.store.close()
  })

  it('guard anti-solape: un tick re-entrante retorna sin efectos mientras hay una vuelta en vuelo', async () => {
    const a = await armar({ procs: [{ id: 'p', oferta: 'PT1H' }] })
    let liberar = (): void => {}
    const puerta = new Promise<void>((r) => { liberar = r })
    a.engine.listRunHistory = async () => { await puerta; return [] }
    const enVuelo = a.loop.tick()
    await a.loop.tick() // re-entrada
    expect(a.logs.some((l) => l.includes('tick saltado'))).toBe(true)
    liberar()
    await enVuelo
    await a.store.close()
  })
})

describe('freshness-loop · fase 2: alertas (semántica de #104 preservada)', () => {
  it('primera transición notifica, la repetición no, y la recuperación notifica; el estado se persiste SOLO en transición', async () => {
    const store = await SqliteGovernanceStore.open(null, {})
    const setSetting = vi.fn(async (k: string, v: string, by?: string) => store.setSetting(k, v, by))
    const a = await armar({
      procs: [{ id: 'p', oferta: 'PT1H' }],
      storeOverride: () => ({
        recordObservations: (o) => store.recordObservations(o),
        listRunSnapshots: (o) => store.listRunSnapshots(o),
        getSetting: (k) => store.getSetting(k),
        setSetting,
      }),
    })
    a.engine.schedules.set('p', 3600)
    a.engine.runs.set('p', [{ startedAt: '2026-08-06T11:50:00Z', status: 'Failed', error: 'boom' }])
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)
    expect(a.alerts[0]!.title).toContain('la corrida falló')
    expect(setSetting).toHaveBeenCalledTimes(1)

    a.clock.ms = T0 + 300_000
    await a.loop.tick() // sigue fallida: ni re-notifica ni re-escribe
    expect(a.alerts).toHaveLength(1)
    expect(setSetting).toHaveBeenCalledTimes(1)

    a.clock.ms = T0 + 600_000
    a.engine.runs.set('p', [{ startedAt: '2026-08-06T12:09:00Z', endedAt: '2026-08-06T12:09:30Z', status: 'Completed' }])
    await a.loop.tick()
    expect(a.alerts).toHaveLength(2)
    expect(a.alerts[1]!.title).toContain('recuperado')
    expect(setSetting).toHaveBeenCalledTimes(2)
    expect(JSON.parse((await store.getSetting(FRESHNESS_ALERT_STATE_KEY))!)).toEqual({})
    await store.close()
    await a.store.close()
  })

  it('el estado se hidrata desde el store en el PRIMER TICK: lo ya avisado antes del reinicio no re-notifica', async () => {
    const store = await SqliteGovernanceStore.open(null, {})
    await store.setSetting(FRESHNESS_ALERT_STATE_KEY, JSON.stringify({ p: 'failed' }), 'test')
    const a = await armar({
      procs: [{ id: 'p', oferta: 'PT1H' }],
      storeOverride: () => store,
    })
    a.engine.schedules.set('p', 3600)
    a.engine.runs.set('p', [{ startedAt: '2026-08-06T11:50:00Z', status: 'Failed', error: 'boom' }])
    await a.loop.tick()
    expect(a.alerts).toEqual([])
    await store.close()
    await a.store.close()
  })

  it('sin `notify` la fase 2 está apagada: no lee ni escribe el estado, pero proyección y reconcile corren', async () => {
    const store = await SqliteGovernanceStore.open(null, {})
    const getSetting = vi.fn(async (k: string) => store.getSetting(k))
    const setSetting = vi.fn(async (k: string, v: string, by?: string) => store.setSetting(k, v, by))
    const a = await armar({
      procs: [{ id: 'p', oferta: 'PT1H' }],
      alertas: false,
      reconcile: true,
      storeOverride: () => ({
        recordObservations: (o) => store.recordObservations(o),
        listRunSnapshots: (o) => store.listRunSnapshots(o),
        getSetting,
        setSetting,
      }),
    })
    a.engine.schedules.set('p', null)
    a.engine.runs.set('p', [{ startedAt: '2026-08-06T11:50:00Z', status: 'Failed', error: 'boom' }])
    await a.loop.tick()
    expect(getSetting).not.toHaveBeenCalled()
    expect(setSetting).not.toHaveBeenCalled()
    expect((await store.listRunSnapshots())[0]?.runs).toHaveLength(1)
    expect(a.engine.sets).toEqual([{ processId: 'p', seconds: 3600 }])
    await store.close()
    await a.store.close()
  })
})

describe('freshness-loop · fase 2: el aviso trae dónde mirar (#100)', () => {
  it('una corrida fallida avisa con LABELS (no ids), enlace a ESA corrida y enlace a la frescura del dominio', async () => {
    const a = await armar({ procs: [{ id: 'proc_cartera', oferta: 'PT1H', label: 'Cargas diarias', domain: 'cartera' }] })
    a.engine.schedules.set('proc_cartera', 3600)
    a.engine.runs.set('proc_cartera', [{ startedAt: '2026-08-06T11:50:00Z', status: 'Failed', error: 'boom en el motor' }])
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)
    const n = a.alerts[0]!
    expect(n.title).toBe('Frescura — Cartera / Finanzas · Cargas diarias: la corrida falló')
    expect(n.lines[0]).toBe('motivo: boom en el motor')
    expect(n.links).toEqual([
      { label: 'Ver corrida', url: `${PUBLIC_URL}/admin/dominio/cartera/corrida?proc=proc_cartera&started=2026-08-06T11%3A50%3A00Z` },
      { label: 'Frescura del dominio', url: `${PUBLIC_URL}/admin/dominio/cartera/frescura` },
    ])
    expect(n.data).toMatchObject({ event: 'freshness-alert', processId: 'proc_cartera', reason: 'failed', domainId: 'cartera' })
    await a.store.close()
  })

  it('el dedup sobrevive al aviso nuevo: la repetición no re-emite y la recuperación llega con su enlace', async () => {
    const a = await armar({ procs: [{ id: 'proc_cartera', oferta: 'PT1H', label: 'Cargas diarias', domain: 'cartera' }] })
    a.engine.schedules.set('proc_cartera', 3600)
    a.engine.runs.set('proc_cartera', [{ startedAt: '2026-08-06T11:50:00Z', status: 'Failed', error: 'boom' }])
    await a.loop.tick()
    a.clock.ms = T0 + 300_000
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1) // sigue fallando: el aviso nuevo NO reabrió la puerta al ruido

    a.clock.ms = T0 + 600_000
    a.engine.runs.set('proc_cartera', [{ startedAt: '2026-08-06T12:09:00Z', endedAt: '2026-08-06T12:09:30Z', status: 'Completed' }])
    await a.loop.tick()
    expect(a.alerts).toHaveLength(2)
    expect(a.alerts[1]!.severity).toBe('ok')
    expect(a.alerts[1]!.title).toBe('Frescura — Cartera / Finanzas · Cargas diarias: recuperado')
    expect(a.alerts[1]!.links).toEqual([{ label: 'Frescura del dominio', url: `${PUBLIC_URL}/admin/dominio/cartera/frescura` }])
    await a.store.close()
  })

  it('sin dominio DECLARADO no hay página que enlazar: el aviso va sin enlaces y dice por qué', async () => {
    const a = await armar({
      procs: [
        { id: 'p_huerfano', oferta: 'PT1H', label: 'Suelto' },
        { id: 'p_tageado', oferta: 'PT1H', label: 'Tageado a un dominio que nadie declaró', domain: 'inexistente' },
      ],
    })
    for (const id of ['p_huerfano', 'p_tageado']) {
      a.engine.schedules.set(id, 3600)
      a.engine.runs.set(id, [{ startedAt: '2026-08-06T11:50:00Z', status: 'Failed', error: 'boom' }])
    }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(2)
    for (const n of a.alerts) {
      expect(n.title).toContain('(sin dominio)')
      expect(n.links).toEqual([])
      expect(n.lines).toContain('enlaces no disponibles: el proceso no pertenece a un dominio declarado')
      expect(n.data['domainId']).toBeNull()
    }
    await a.store.close()
  })

  it('atrasada con historial: dice la hora esperada según el reloj y NO ofrece «Ver corrida» (no hay corrida que mirar)', async () => {
    const a = await armar({ procs: [{ id: 'proc_cartera', oferta: 'PT30M', label: 'Cargas diarias', domain: 'cartera' }] })
    a.engine.schedules.set('proc_cartera', 1800)
    a.engine.runs.set('proc_cartera', [{ startedAt: '2026-08-06T11:00:00Z', endedAt: '2026-08-06T11:02:00Z', status: 'Completed' }])
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)
    const n = a.alerts[0]!
    expect(n.title).toBe('Frescura — Cartera / Finanzas · Cargas diarias: atrasada (no corre a tiempo)')
    expect(n.lines).toEqual([
      'última corrida exitosa: hace 58 min (2026-08-06T11:02:00Z)',
      'se esperaba una corrida antes de: 2026-08-06T11:32:00.000Z (cadencia requerida 30 min)',
    ])
    expect(n.links).toEqual([{ label: 'Frescura del dominio', url: `${PUBLIC_URL}/admin/dominio/cartera/frescura` }])
    await a.store.close()
  })
})

describe('freshness-loop · fase 3: reconcile con debounce', () => {
  it('EL EXPERIMENTO DEL DEBOUNCE: con un motor que redondea a minutos (90→60) el drift no converge NUNCA; se empuja una vez y recién se reintenta pasada la ventana', async () => {
    const a = await armar({ procs: [{ id: 'p', oferta: 'PT90S' }], reconcile: true, debounceMs: 6 * 3600_000 })
    a.engine.redondeaAMinutos = true
    a.engine.schedules.set('p', null)
    await a.loop.tick()
    expect(a.engine.sets).toEqual([{ processId: 'p', seconds: 90 }])
    // El motor redondeó: lee 60 ≠ 90 → `reconcilePlan` diría `set` en CADA vuelta, para siempre.
    expect(await a.engine.getScheduleSeconds('p')).toBe(60)
    // D5 · lo proyectado es lo RE-OBSERVADO (60), no lo prometido (90).
    expect((await a.snap('p'))?.scheduleSeconds).toBe(60)

    for (const salto of [300_000, 3600_000, 5 * 3600_000]) {
      a.clock.ms = T0 + salto
      await a.loop.tick()
    }
    expect(a.engine.sets).toHaveLength(1) // el debounce lo frenó dentro de la ventana

    a.clock.ms = T0 + 6 * 3600_000 + 1000
    await a.loop.tick()
    expect(a.engine.sets).toHaveLength(2) // vencida la ventana, se reintenta
    expect(a.audits.filter((e) => e.type === 'frescura-reconcile')).toHaveLength(2)
    await a.store.close()
  })

  it('drift convergente: un solo set y la vuelta siguiente es noop, sin que el debounce participe', async () => {
    const a = await armar({ procs: [{ id: 'p', oferta: 'PT2H' }], reconcile: true, debounceMs: 1 })
    a.engine.schedules.set('p', 3600)
    await a.loop.tick()
    expect(a.engine.sets).toEqual([{ processId: 'p', seconds: 7200 }])
    expect((await a.snap('p'))?.scheduleSeconds).toBe(7200)
    a.clock.ms = T0 + 300_000 // ventana de 1 ms: si el plan siguiera dando `set`, empujaría de nuevo
    await a.loop.tick()
    expect(a.engine.sets).toHaveLength(1)
    await a.store.close()
  })

  it('un `desired` que CAMBIA se empuja de inmediato, aunque la ventana siga abierta', async () => {
    const store = await SqliteGovernanceStore.open(null, {})
    const engine = new FakeEngine()
    engine.redondeaAMinutos = true
    const audits: { type: string }[] = []
    const clock = { ms: T0 }
    let oferta = 'PT90S'
    const loop = createFreshnessLoop(
      {
        engine,
        store,
        inputs: async () => inputsOf([{ id: 'p', oferta }])(),
        domains: DOMINIOS,
        audit: (e) => void audits.push(e as { type: string }),
        log: () => {},
        now: () => clock.ms,
      },
      { reconcile: true, reconcileDebounceMs: 6 * 3600_000, publicUrl: PUBLIC_URL },
    )
    await loop.tick()
    expect(engine.sets).toEqual([{ processId: 'p', seconds: 90 }])
    clock.ms = T0 + 60_000
    oferta = 'PT150S' // la demanda cambió: no espera la ventana
    await loop.tick()
    expect(engine.sets).toEqual([{ processId: 'p', seconds: 90 }, { processId: 'p', seconds: 150 }])
    await store.close()
  })

  it('con reconcile apagado jamás se toca el schedule del motor', async () => {
    const a = await armar({ procs: [{ id: 'p', oferta: 'PT1H' }], reconcile: false })
    a.engine.schedules.set('p', 60)
    await a.loop.tick()
    a.clock.ms = T0 + 3600_000
    await a.loop.tick()
    expect(a.engine.sets).toEqual([])
    expect((await a.snap('p'))?.scheduleSeconds).toBe(60) // se OBSERVA el drift, no se corrige
    await a.store.close()
  })
})

// Issue #107: la pausa apaga la ALERTA y el RECONCILE, nunca la OBSERVACIÓN. Lo que se pone en riesgo
// acá es exactamente eso: si el filtro estuviera de más, el lazo revivería lo que un steward apagó; si
// estuviera de menos, la pausa apagaría también la memoria del producto sobre ese proceso.
describe('freshness-loop · la pausa de un proceso (#107)', () => {
  const PAUSADO = '2026-08-06T09:00:00Z'

  it('proceso pausado con drift: CERO empujes de schedule en varias vueltas', async () => {
    const a = await armar({ procs: [{ id: 'p', oferta: 'PT1H', pausedAt: PAUSADO }], reconcile: true, debounceMs: 1 })
    a.engine.schedules.set('p', 60) // drift enorme contra la cadencia requerida (3600s)
    await a.loop.tick()
    a.clock.ms = T0 + 600_000
    await a.loop.tick()
    a.clock.ms = T0 + 1_200_000
    await a.loop.tick()
    expect(a.engine.sets).toEqual([])
    expect(a.audits.filter((e) => e.type === 'frescura-reconcile')).toEqual([])
    await a.store.close()
  })

  it('proceso pausado vencido de cadencia: CERO alertas — y uno NO pausado del mismo tick sí alerta', async () => {
    const a = await armar({ procs: [{ id: 'quieto', oferta: 'PT1H', pausedAt: PAUSADO }, { id: 'vivo', oferta: 'PT1H' }] })
    const vieja: RunRecord[] = [{ startedAt: '2026-08-05T00:00:00Z', endedAt: '2026-08-05T00:05:00Z', status: 'Completed' }]
    a.engine.runs.set('quieto', vieja)
    a.engine.runs.set('vivo', vieja)
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)
    expect(a.alerts[0]!.title).toContain('vivo')
    await a.store.close()
  })

  it('proceso pausado: su OBSERVACIÓN se registra igual (corridas y schedule frescos)', async () => {
    const a = await armar({ procs: [{ id: 'p', oferta: 'PT1H', pausedAt: PAUSADO }], reconcile: true })
    a.engine.schedules.set('p', 3600)
    a.engine.runs.set('p', [{ startedAt: '2026-08-06T11:50:00Z', endedAt: '2026-08-06T11:52:00Z', status: 'Completed' }])
    await a.loop.tick()
    const s = await a.snap('p')
    expect(s?.observedAt).toBe(new Date(T0).toISOString())
    expect(s?.runs.map((r) => r.startedAt)).toEqual(['2026-08-06T11:50:00Z'])
    expect(s?.scheduleSeconds).toBe(3600)
    await a.store.close()
  })

  it('despausar: el tick siguiente vuelve a reconciliar (la pausa era el único freno)', async () => {
    const store = await SqliteGovernanceStore.open(null, {})
    const engine = new FakeEngine()
    engine.schedules.set('p', 60)
    const clock = { ms: T0 }
    let pausedAt: string | undefined = PAUSADO
    const loop = createFreshnessLoop(
      { engine, store, inputs: async () => inputsOf([{ id: 'p', oferta: 'PT1H', pausedAt }])(), domains: [], audit: () => {}, log: () => {}, now: () => clock.ms },
      { reconcile: true, reconcileDebounceMs: 1, publicUrl: PUBLIC_URL },
    )
    await loop.tick()
    expect(engine.sets).toEqual([])
    pausedAt = undefined // el steward reanudó
    clock.ms = T0 + 300_000
    await loop.tick()
    expect(engine.sets).toEqual([{ processId: 'p', seconds: 3600 }])
    await store.close()
  })

  it('pausar un proceso que estaba alertando no anuncia «recuperado» (nadie observó tal recuperación)', async () => {
    const store = await SqliteGovernanceStore.open(null, {})
    const engine = new FakeEngine()
    engine.runs.set('p', [{ startedAt: '2026-08-05T00:00:00Z', status: 'Failed' }])
    const alerts: Notification[] = []
    const clock = { ms: T0 }
    let pausedAt: string | undefined
    const loop = createFreshnessLoop(
      { engine, store, inputs: async () => inputsOf([{ id: 'p', oferta: 'PT1H', pausedAt }])(), domains: [], notify: async (n) => void alerts.push(n), audit: () => {}, log: () => {}, now: () => clock.ms },
      { reconcile: false, reconcileDebounceMs: 1, publicUrl: PUBLIC_URL },
    )
    await loop.tick()
    expect(alerts).toHaveLength(1) // falló
    pausedAt = PAUSADO
    clock.ms = T0 + 300_000
    await loop.tick()
    expect(alerts).toHaveLength(1) // ni re-alerta ni «recuperado»
    await store.close()
  })
})
