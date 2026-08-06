/**
 * Reporte periódico de lo ejecutado (issue #102, T3) — el LATIDO.
 *
 * El síntoma que el issue pide se observa acá: el reporte SALE a su hora con novedades, sin ellas,
 * con los insumos caídos y tras un downtime, una vez por período y con su contenido sellado. Store
 * de gobierno REAL (platform_setting + proyección), sinks fake, reloj inyectado.
 */
import { describe, it, expect } from 'vitest'
import { SqliteGovernanceStore, type DeriveMapInput, type ProcessRow, type SourceRow } from '@vergis/capabilities'
import type { Notification, NotificationSink, ReportSchedule } from '../server/notify'
import {
  buildReportRows,
  composeOperationsReport,
  createReportLoop,
  dueFor,
  fmtLocal,
  lastDueAt,
  parseReportLastSent,
  periodKeyOf,
  prevDueBefore,
  REPORT_LAST_SENT_KEY,
  REPORT_MAX_CATCHUP_PERIODS,
  type ReportPeriod,
  type ReportProjectionMeta,
} from '../server/report'

const TZ = 'America/Santiago'
const BASE = 'https://mira.example.com'
const DIARIO: ReportSchedule = { at: '07:30', every: 'daily' }
const t = (iso: string): number => Date.parse(iso)
/** El due del 2026-08-06 en Santiago (UTC−4 en agosto): 07:30 local = 11:30 UTC. */
const DUE_06 = t('2026-08-06T11:30:00.000Z')

// ── Insumos compartidos: un registro con un proceso por sección ──────────────────────────────────

const DOMINIOS = [{ id: 'cartera', label: 'Cartera' }]
const SOURCES: SourceRow[] = [
  { id: 's_cartera', label: 'Core cartera', oferta: 'PT1H', domain: 'cartera' },
  { id: 's_oculto', label: 'Fuente sin dominio declarado', oferta: 'PT1H', domain: 'no-declarado' },
  { id: 's_sem', label: 'Fuente semanal', oferta: 'P7D' },
  { id: 's_evt', label: 'Fuente por evento', oferta: 'evento' },
]
const engine = { workspaceId: 'w', itemId: 'i', jobType: 'Pipeline' }
const PROCS: ProcessRow[] = [
  { id: 'p_fail', label: 'Fallo diario', sourceId: 's_cartera', engine },
  { id: 'p_fail_sd', label: 'Fallo sin dominio', sourceId: 's_oculto', engine },
  { id: 'p_ok', label: 'OK diario', sourceId: 's_cartera', engine },
  { id: 'p_nunca', label: 'Nunca corrió', sourceId: 's_cartera', engine },
  { id: 'p_viejo', label: 'Viejo', sourceId: 's_cartera', engine },
  { id: 'p_semanal', label: 'Semanal', sourceId: 's_sem', engine },
  { id: 'p_frio', label: 'Frío', sourceId: 's_cartera', engine },
  { id: 'p_evento', label: 'Evento', sourceId: 's_evt', engine },
  { id: 'p_manual', label: 'Manual', sourceId: 's_cartera' },
]
const ERROR_LARGO = 'boom '.repeat(60) // 300 caracteres: el reporte lo recorta a 200
const mapInputDe = (procs: ProcessRow[], sources: SourceRow[]): DeriveMapInput => ({
  sources: sources.map((s) => ({ id: s.id, oferta: s.oferta })),
  processes: procs.map((p) => ({ id: p.id, label: p.label, sourceId: p.sourceId })),
  processOutputs: [],
  piTables: [],
  piDemandas: [],
})
const INPUTS = async (): Promise<{ sources: SourceRow[]; procs: ProcessRow[]; mapInput: DeriveMapInput }> => ({
  sources: SOURCES,
  procs: PROCS,
  mapInput: mapInputDe(PROCS, SOURCES),
})

type Store = Awaited<ReturnType<typeof SqliteGovernanceStore.open>>

/** Proyección sembrada como la escribiría el lazo de frescura: observación por lote. */
async function sembrar(g: Store, observedAt = '2026-08-06T11:29:00.000Z'): Promise<void> {
  await g.recordObservations([
    {
      processId: 'p_fail',
      observedAt,
      scheduleSeconds: 3600,
      runs: [
        { startedAt: '2026-08-06T09:00:00Z', endedAt: '2026-08-06T09:05:00Z', status: 'Failed', error: ERROR_LARGO },
        { startedAt: '2026-08-06T03:00:00Z', endedAt: '2026-08-06T03:05:00Z', status: 'Completed' },
      ],
    },
    { processId: 'p_fail_sd', observedAt, scheduleSeconds: 3600, runs: [{ startedAt: '2026-08-06T10:00:00Z', status: 'Failed' }] },
    {
      processId: 'p_ok',
      observedAt,
      scheduleSeconds: 3600,
      runs: [
        { startedAt: '2026-08-06T10:00:00Z', endedAt: '2026-08-06T10:04:00Z', status: 'Completed' },
        { startedAt: '2026-08-06T08:00:00Z', endedAt: '2026-08-06T08:04:00Z', status: 'Completed' },
        { startedAt: '2026-08-05T20:00:00Z', endedAt: '2026-08-05T20:04:00Z', status: 'Completed' },
      ],
    },
    { processId: 'p_nunca', observedAt, scheduleSeconds: 3600, runs: [] },
    { processId: 'p_viejo', observedAt, scheduleSeconds: 3600, runs: [{ startedAt: '2026-08-03T09:00:00Z', endedAt: '2026-08-03T09:04:00Z', status: 'Completed' }] },
    { processId: 'p_semanal', observedAt, scheduleSeconds: 604_800, runs: [{ startedAt: '2026-08-03T09:00:00Z', endedAt: '2026-08-03T09:04:00Z', status: 'Completed' }] },
    // Observación FALLIDA: el proceso existe en la proyección pero jamás se observó (fría).
    { processId: 'p_frio', observedAt, error: 'el motor no respondió' },
    { processId: 'p_evento', observedAt, scheduleSeconds: null, runs: [] },
  ])
}

interface FakeSink extends NotificationSink {
  vistos: Notification[]
  falla: boolean
}
function fakeSink(id: string, falla = false): FakeSink {
  const s: FakeSink = {
    id,
    vistos: [],
    falla,
    send: async (n) => {
      if (s.falla) throw new Error(`${id} caído`)
      s.vistos.push(n)
    },
  }
  return s
}

function armar(g: Store, sinks: NotificationSink[], reloj: { now: number }, extra?: Partial<{ freshnessPollMs: number; engineCabled: boolean; inputs: typeof INPUTS; schedule: ReportSchedule }>) {
  const logs: string[] = []
  const auditorias: Record<string, unknown>[] = []
  const loop = createReportLoop(
    {
      store: g,
      inputs: extra?.inputs ?? INPUTS,
      domains: DOMINIOS,
      sinks,
      audit: (e) => void auditorias.push(e),
      log: (l) => void logs.push(l),
      now: () => reloj.now,
    },
    {
      schedule: extra?.schedule ?? DIARIO,
      timezone: TZ,
      baseUrl: BASE,
      freshnessPollMs: extra?.freshnessPollMs ?? 300_000,
      engineCabled: extra?.engineCabled ?? true,
    },
  )
  return { loop, logs, auditorias }
}

// ── 1 · Aritmética de calendario ─────────────────────────────────────────────────────────────────

describe('report · aritmética de período (Intl, tz real)', () => {
  it('lastDueAt daily toma la ocurrencia de HOY si ya pasó, y la de AYER si no', () => {
    expect(lastDueAt(t('2026-08-06T12:00:00Z'), DIARIO, TZ)).toBe(DUE_06)
    expect(lastDueAt(t('2026-08-06T11:30:00Z'), DIARIO, TZ)).toBe(DUE_06) // el instante exacto YA es due
    expect(lastDueAt(t('2026-08-06T10:00:00Z'), DIARIO, TZ)).toBe(t('2026-08-05T11:30:00Z'))
  })

  it('resuelve el offset de cada estación: Santiago es UTC−4 en agosto y UTC−3 en enero', () => {
    expect(lastDueAt(t('2026-01-15T12:00:00Z'), DIARIO, TZ)).toBe(t('2026-01-15T10:30:00Z'))
    expect(periodKeyOf(t('2026-01-15T10:30:00Z'), TZ)).toBe('2026-01-15')
    expect(periodKeyOf(DUE_06, TZ)).toBe('2026-08-06')
    expect(fmtLocal('2026-08-06T09:00:00Z', TZ)).toBe('2026-08-06 05:00')
    expect(fmtLocal('2026-01-15T09:00:00Z', TZ)).toBe('2026-01-15 06:00')
  })

  it('weekly cae en el último weekday declarado', () => {
    const semanal: ReportSchedule = { at: '07:30', every: 'weekly', weekday: 'monday' }
    // 2026-08-06 es jueves: el último lunes es el 3.
    expect(lastDueAt(t('2026-08-06T12:00:00Z'), semanal, TZ)).toBe(t('2026-08-03T11:30:00Z'))
    // Lunes ANTES de la hora ⇒ el lunes anterior.
    expect(lastDueAt(t('2026-08-03T10:00:00Z'), semanal, TZ)).toBe(t('2026-07-27T11:30:00Z'))
  })

  it('prevDueBefore + un período = due en días normales, y en el cambio de hora el largo cambia SIN romper la identidad del período', () => {
    expect(DUE_06 - prevDueBefore(DUE_06, DIARIO, TZ)).toBe(86_400_000)
    // 2026-09-06: Santiago adelanta el reloj (UTC−4 → UTC−3) ⇒ ese día dura 23 h.
    const dueDst = lastDueAt(t('2026-09-06T12:00:00Z'), DIARIO, TZ)
    const prevDst = prevDueBefore(dueDst, DIARIO, TZ)
    expect(dueDst).toBe(t('2026-09-06T10:30:00Z'))
    expect(dueDst - prevDst).toBe(23 * 3_600_000)
    expect(periodKeyOf(dueDst, TZ)).toBe('2026-09-06')
    expect(periodKeyOf(prevDst, TZ)).toBe('2026-09-05')
    // 2026-04-05: atrasa el reloj (UTC−3 → UTC−4) ⇒ 25 h, y los periodKey siguen siendo distintos.
    const dueFall = lastDueAt(t('2026-04-05T12:00:00Z'), DIARIO, TZ)
    expect(dueFall - prevDueBefore(dueFall, DIARIO, TZ)).toBe(25 * 3_600_000)
    expect(periodKeyOf(dueFall, TZ)).not.toBe(periodKeyOf(prevDueBefore(dueFall, DIARIO, TZ), TZ))
  })

  it('una hora local INEXISTENTE (salto de DST) se resuelve al instante en que el reloj la alcanza', () => {
    // El 2026-09-06 el reloj salta de las 00:00 a las 01:00: las 00:30 locales no existen.
    const due = dueFor(2026, 9, 6, '00:30', TZ)
    expect(due).toBe(t('2026-09-06T04:00:00Z')) // el instante del salto
    expect(fmtLocal(due, TZ)).toBe('2026-09-06 01:00')
  })
})

// ── 2 · Composición: cadenas selladas ────────────────────────────────────────────────────────────

async function filas(g: Store, winStartMs: number, dueMs: number) {
  const { deriveIngestionMap, INGESTION_RUN_RETENTION } = await import('@vergis/capabilities')
  const snapshots = await g.listRunSnapshots({ runsPerProcess: INGESTION_RUN_RETENTION })
  return buildReportRows({ snapshots, procs: PROCS, sources: SOURCES, domains: DOMINIOS, map: deriveIngestionMap(mapInputDe(PROCS, SOURCES)), winStartMs, dueMs })
}

const periodoBase = (over?: Partial<ReportPeriod>): ReportPeriod => ({
  periodKey: '2026-08-06',
  fromIso: '2026-08-05T11:30:00.000Z',
  toIso: '2026-08-06T11:30:00.000Z',
  timezone: TZ,
  every: 'daily',
  periodos: 1,
  primero: false,
  ...over,
})
const proyeccionSana: ReportProjectionMeta = { engineCabled: true, lazoApagado: false, maxObservedAt: '2026-08-06T11:29:00.000Z', stale: false }

describe('report · composición (cadenas selladas, una por sección)', () => {
  it('clasifica cada proceso en su sección, con los conteos del título consistentes', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await sembrar(g)
    const procesos = await filas(g, t('2026-08-05T11:30:00Z'), DUE_06)
    await g.close()
    const n = composeOperationsReport({ periodo: periodoBase(), procesos, proyeccion: proyeccionSana, baseUrl: BASE })

    expect(n.title).toBe('Reporte de ingestión — 2026-08-06 — 3 corrieron · 2 con fallo · 2 no corrieron debiendo')
    expect(n.severity).toBe('warning')
    expect(n.lines).toEqual([
      'período: 2026-08-05 07:30 → 2026-08-06 07:30 (America/Santiago)',
      'Con fallo (2):',
      `✗ Cartera · Fallo diario — falló 2026-08-06 05:00 · 2 corrida(s) en el período — ${ERROR_LARGO.slice(0, 200)}`,
      '✗ Fallo sin dominio — falló 2026-08-06 06:00 · 1 corrida(s) en el período',
      'No corrieron debiendo (2):',
      'Cartera · Nunca corrió — cadencia requerida 60 min · última exitosa nunca',
      'Cartera · Viejo — cadencia requerida 60 min · última exitosa hace 3 d',
      'Corrieron bien (1):',
      '✓ Cartera · OK diario — 3 corrida(s) · última 2026-08-06 06:00 completó',
      'Dentro de su cadencia, sin corrida en el período: Semanal',
      'Sin observación aún (proyección fría): Frío',
      'Sin cadencia exigida, sin corrida en el período: Evento',
      'No observables (sin motor): Manual',
    ])
    expect(n.data['counts']).toEqual({ corrieron: 3, conFallo: 2, ausentes: 2, frios: 1, sinCadencia: 1, noObservables: 1 })
    expect(n.data['window']).toEqual({ from: '2026-08-05T11:30:00.000Z', to: '2026-08-06T11:30:00.000Z', timezone: TZ })
  })

  it('los enlaces: la vista transversal SIEMPRE, y el log solo del fallo con dominio DECLARADO (url-encodeado)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await sembrar(g)
    const procesos = await filas(g, t('2026-08-05T11:30:00Z'), DUE_06)
    await g.close()
    const n = composeOperationsReport({ periodo: periodoBase(), procesos, proyeccion: proyeccionSana, baseUrl: BASE })
    expect(n.links).toEqual([
      { label: 'Fuentes e ingestas', url: `${BASE}/admin/sources` },
      { label: 'Log — Fallo diario', url: `${BASE}/admin/dominio/cartera/corrida?proc=p_fail&started=2026-08-06T09%3A00%3A00Z` },
    ])
  })

  it('la staleness de la proyección va DECLARADA en el cuerpo (un dato rancio que no se declara es un dato falso)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await sembrar(g)
    const procesos = await filas(g, t('2026-08-05T11:30:00Z'), DUE_06)
    await g.close()
    const sinMotor = composeOperationsReport({
      periodo: periodoBase(),
      procesos: [],
      proyeccion: { engineCabled: false, lazoApagado: false, maxObservedAt: null, stale: false },
      baseUrl: BASE,
    })
    expect(sinMotor.lines[1]).toBe('sin motor de ingestión cableado — no hay procesos observables')
    expect(sinMotor.severity).toBe('info')

    const apagado = composeOperationsReport({ periodo: periodoBase(), procesos, proyeccion: { ...proyeccionSana, lazoApagado: true }, baseUrl: BASE })
    expect(apagado.lines[1]).toBe('⚠ la observación del motor está apagada — los datos pueden estar incompletos')

    const rancia = composeOperationsReport({
      periodo: periodoBase(),
      procesos: procesos.filter((p) => p.processId === 'p_ok'),
      proyeccion: { engineCabled: true, lazoApagado: false, maxObservedAt: '2026-08-06T09:00:00.000Z', stale: true },
      baseUrl: BASE,
    })
    expect(rancia.lines[1]).toBe('⚠ última observación del motor: 2026-08-06 05:00 — pueden faltar corridas recientes')
    expect(rancia.severity).toBe('warning') // sin fallos ni ausentes: la severity la pone el ⚠
  })
})

// ── 3 · El lazo ──────────────────────────────────────────────────────────────────────────────────

describe('report · el lazo envía SIEMPRE, una vez por período', () => {
  it('un envío por período: el primer tick tras el due manda, los siguientes no, y el próximo período vuelve a mandar', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await sembrar(g)
    const sink = fakeSink('correo')
    const reloj = { now: t('2026-08-06T12:00:00Z') }
    const { loop } = armar(g, [sink], reloj)
    await loop.tick()
    expect(sink.vistos).toHaveLength(1)
    expect(sink.vistos[0]!.data['periodKey']).toBe('2026-08-06')
    for (let i = 0; i < 10; i++) {
      reloj.now += 60_000
      await loop.tick()
    }
    expect(sink.vistos).toHaveLength(1)
    reloj.now = t('2026-08-07T12:00:00Z')
    await loop.tick()
    expect(sink.vistos).toHaveLength(2)
    expect(sink.vistos[1]!.data['periodKey']).toBe('2026-08-07')
    await g.close()
  })

  it('SIN NOVEDADES sale igual (la condición del issue): todo corrió bien ⇒ reporte info con los tres números', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const procs: ProcessRow[] = [
      { id: 'a', label: 'A', sourceId: 's_cartera', engine },
      { id: 'b', label: 'B', sourceId: 's_cartera', engine },
    ]
    await g.recordObservations(
      procs.map((p) => ({
        processId: p.id,
        observedAt: '2026-08-06T11:29:00.000Z',
        scheduleSeconds: 3600,
        runs: [{ startedAt: '2026-08-06T10:00:00Z', endedAt: '2026-08-06T10:05:00Z', status: 'Completed' as const }],
      })),
    )
    const sink = fakeSink('correo')
    const reloj = { now: t('2026-08-06T12:00:00Z') }
    const { loop } = armar(g, [sink], reloj, {
      inputs: async () => ({ sources: SOURCES, procs, mapInput: mapInputDe(procs, SOURCES) }),
    })
    await loop.tick()
    expect(sink.vistos).toHaveLength(1)
    expect(sink.vistos[0]!.title).toBe('Reporte de ingestión — 2026-08-06 — 2 corrieron · 0 con fallo · 0 no corrieron debiendo')
    expect(sink.vistos[0]!.severity).toBe('info')
    expect(sink.vistos[0]!.lines).toContain('primer reporte de esta instancia')
    await g.close()
  })

  it('un registro SIN procesos también late: lo dice con todas sus letras', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const sink = fakeSink('correo')
    const reloj = { now: t('2026-08-06T12:00:00Z') }
    const { loop } = armar(g, [sink], reloj, { inputs: async () => ({ sources: [], procs: [], mapInput: mapInputDe([], []) }) })
    await loop.tick()
    expect(sink.vistos).toHaveLength(1)
    expect(sink.vistos[0]!.lines).toContain('sin procesos de ingestión declarados')
    expect(sink.vistos[0]!.title).toBe('Reporte de ingestión — 2026-08-06 — 0 corrieron · 0 con fallo · 0 no corrieron debiendo')
    await g.close()
  })

  it('los insumos caídos NO callan el latido: sale el reporte de indisponibilidad y se persiste como enviado', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const sink = fakeSink('correo')
    const reloj = { now: t('2026-08-06T12:00:00Z') }
    const { loop } = armar(g, [sink], reloj, {
      inputs: async () => {
        throw new Error('el store de gobierno no responde')
      },
    })
    await loop.tick()
    expect(sink.vistos).toHaveLength(1)
    const n = sink.vistos[0]!
    expect(n.severity).toBe('warning')
    expect(n.title).toBe('Reporte de ingestión — 2026-08-06 — sin datos (error interno)')
    expect(n.lines).toContain('⚠ no se pudieron leer los insumos del reporte — se emite igual como latido')
    expect(n.lines).toContain('detalle: el store de gobierno no responde')
    expect(parseReportLastSent(await g.getSetting(REPORT_LAST_SENT_KEY))?.periodKey).toBe('2026-08-06')
    await g.close()
  })
})

describe('report · catch-up tras un downtime', () => {
  it('un envío perdido hace 3 períodos produce UN reporte con la ventana extendida y el hueco declarado', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await sembrar(g)
    // Una corrida de hace dos días: fuera de la ventana normal, DENTRO de la extendida.
    await g.recordObservations([
      {
        processId: 'p_ok',
        observedAt: '2026-08-06T11:29:00.000Z',
        scheduleSeconds: 3600,
        runs: [{ startedAt: '2026-08-04T09:00:00Z', endedAt: '2026-08-04T09:05:00Z', status: 'Completed' }],
      },
    ])
    await g.setSetting(
      REPORT_LAST_SENT_KEY,
      JSON.stringify({ periodKey: '2026-08-03', dueAt: '2026-08-03T11:30:00.000Z', sentAt: '2026-08-03T11:30:05.000Z', delivered: ['correo'], failed: [] }),
    )
    const sink = fakeSink('correo')
    const reloj = { now: t('2026-08-06T12:00:00Z') }
    const { loop } = armar(g, [sink], reloj)
    await loop.tick()
    expect(sink.vistos).toHaveLength(1)
    const n = sink.vistos[0]!
    expect(n.lines).toContain('ventana extendida: cubre 3 períodos (2 envío(s) perdido(s) — la instancia estuvo caída o el envío falló)')
    expect(n.lines[0]).toBe('período: 2026-08-03 07:30 → 2026-08-06 07:30 (America/Santiago)')
    expect(n.data['periodos']).toBe(3)
    // La corrida de hace dos días entra en el conteo del proceso.
    const ok = (n.data['procesos'] as { processId: string; corridas: number }[]).find((p) => p.processId === 'p_ok')!
    expect(ok.corridas).toBe(4)
    await g.close()
  })

  it('un hueco enorme se capa en REPORT_MAX_CATCHUP_PERIODS (no se reviven reportes rancios uno a uno)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await sembrar(g)
    await g.setSetting(
      REPORT_LAST_SENT_KEY,
      JSON.stringify({ periodKey: '2026-07-27', dueAt: '2026-07-27T11:30:00.000Z', sentAt: '2026-07-27T11:30:05.000Z', delivered: ['correo'], failed: [] }),
    )
    const sink = fakeSink('correo')
    const reloj = { now: t('2026-08-06T12:00:00Z') }
    const { loop } = armar(g, [sink], reloj)
    await loop.tick()
    expect(sink.vistos).toHaveLength(1)
    expect(sink.vistos[0]!.data['periodos']).toBe(REPORT_MAX_CATCHUP_PERIODS)
    expect((sink.vistos[0]!.data['window'] as { from: string }).from).toBe('2026-07-30T11:30:00.000Z')
    await g.close()
  })
})

describe('report · entrega e idempotencia durable', () => {
  it('si TODOS los destinos fallan no se persiste nada, el reintento espera su ventana, y al entregar sí persiste', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await sembrar(g)
    const sink = fakeSink('correo', true)
    const reloj = { now: t('2026-08-06T12:00:00Z') }
    const { loop, logs } = armar(g, [sink], reloj)
    await loop.tick()
    expect(sink.vistos).toHaveLength(0)
    expect(await g.getSetting(REPORT_LAST_SENT_KEY)).toBeNull()
    expect(logs.some((l) => l.includes('todos los destinos fallaron — reintento en 10 min'))).toBe(true)

    // A los 5 minutos NO se reintenta (la ventana de retry manda).
    const antes = logs.length
    reloj.now += 5 * 60_000
    await loop.tick()
    expect(logs).toHaveLength(antes)

    // A los 11 sí, y esta vez el destino responde.
    sink.falla = false
    reloj.now += 6 * 60_000
    await loop.tick()
    expect(sink.vistos).toHaveLength(1)
    const guardado = parseReportLastSent(await g.getSetting(REPORT_LAST_SENT_KEY))
    expect(guardado).toMatchObject({ periodKey: '2026-08-06', dueAt: '2026-08-06T11:30:00.000Z', delivered: ['correo'], failed: [] })

    // Reinicio simulado: un lazo NUEVO sobre el MISMO store no reenvía el período (hidratación).
    const sink2 = fakeSink('correo')
    const { loop: loop2 } = armar(g, [sink2], reloj)
    await loop2.tick()
    expect(sink2.vistos).toHaveLength(0)
    await g.close()
  })

  it('con un destino caído y otro vivo SÍ se persiste (at-least-once), con el fallido registrado y logueado', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await sembrar(g)
    const caido = fakeSink('slack', true)
    const vivo = fakeSink('correo')
    const reloj = { now: t('2026-08-06T12:00:00Z') }
    const { loop, logs, auditorias } = armar(g, [caido, vivo], reloj)
    await loop.tick()
    expect(vivo.vistos).toHaveLength(1)
    expect(logs).toContain('reporte[slack]: slack caído')
    expect(parseReportLastSent(await g.getSetting(REPORT_LAST_SENT_KEY))).toMatchObject({ delivered: ['correo'], failed: ['slack'] })
    expect(auditorias[0]).toMatchObject({ type: 'reporte-operaciones', by: 'report-loop', periodKey: '2026-08-06', delivered: ['correo'], failed: ['slack'] })
    await g.close()
  })
})

describe('report · robustez del lazo', () => {
  it('parseReportLastSent es fail-safe: basura ⇒ null (se trata como «nunca enviado», jamás como silencio)', () => {
    expect(parseReportLastSent(null)).toBeNull()
    expect(parseReportLastSent('')).toBeNull()
    expect(parseReportLastSent('basura')).toBeNull()
    expect(parseReportLastSent('{"periodKey":""}')).toBeNull()
    expect(parseReportLastSent('{"periodKey":"2026-08-06"}')).toEqual({ periodKey: '2026-08-06', dueAt: '', sentAt: '', delivered: [], failed: [] })
  })

  it('la re-entrada con una vuelta en vuelo es no-op, y el tick JAMÁS propaga (ni con un sink que lanza síncrono)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await sembrar(g)
    let liberar: () => void = () => {}
    const puerta = new Promise<void>((r) => {
      liberar = r
    })
    const lento: NotificationSink = { id: 'lento', send: () => puerta }
    const reloj = { now: t('2026-08-06T12:00:00Z') }
    const { loop, logs } = armar(g, [lento], reloj)
    const vuelta = loop.tick()
    await loop.tick() // en vuelo: no-op
    liberar()
    await vuelta
    expect(logs).toContain('reporte: tick solapado, se omite')

    const explosivo: NotificationSink = {
      id: 'explosivo',
      send: () => {
        throw new Error('revienta síncrono')
      },
    }
    const { loop: loop2, logs: logs2 } = armar(g, [explosivo], { now: t('2026-08-07T12:00:00Z') })
    await expect(loop2.tick()).resolves.toBeUndefined()
    expect(logs2).toContain('reporte[explosivo]: revienta síncrono')
    await g.close()
  })
})
