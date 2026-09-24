import { describe, it, expect } from 'vitest'
import {
  SqliteGovernanceStore,
  runLogFileName,
  type IntakeSlot,
  type OneLakeEntry,
  type OneLakeListing,
  type RunRecord,
  type SlotWatchSnapshot,
} from '@vergis/capabilities'
import { createIntakeLoop, type IntakeLoopDeps } from '../server/intake-loop'

/**
 * La corrida se identifica por su ID de instancia, no por su `startedAt`.
 *
 * El caso medido (diagnóstico de «Cargando» falso en Cross Docking, 2026-09-24): Fabric reporta una
 * corrida en cola como `NotStarted` con un `startTimeUtc` (el de creación) y, cuando la saca de la cola,
 * con OTRO (el de arranque). La proyección guardaba la corrida con `started_at` como clave, así que la
 * vista en cola quedaba `NotStarted` para siempre y el resolvedor se detenía en ella hasta 60 min: la
 * carga seguía «Cargando» con su `✔` ya declarado en el log.
 *
 * Los instantes son los reales de ese día (cargas #357/#358, jobs `907e4539`/`a184ff9d`).
 */

const FILE = 'oc-17552475-distributions-details-24-09-2026.xlsx'
const SUBIDA = '2026-09-24T15:31:08.595Z'
const A_COLA = '2026-09-24T15:30:54.2833333Z'
const B_COLA = '2026-09-24T15:31:09.5766667Z'
const A_ARRANQUE = '2026-09-24T15:36:23.4725792Z'
const A_FIN = '2026-09-24T15:38:45.2191304Z'
const B_ARRANQUE = '2026-09-24T15:39:15.8862356Z'
const B_FIN = '2026-09-24T15:41:30.7088708Z'
const ID_A = '907e4539-0000-4000-8000-000000000001'
const ID_B = 'a184ff9d-0000-4000-8000-000000000002'

const slot: IntakeSlot = {
  id: 'oc_crossdocking_distribuciones',
  label: 'Distribuciones',
  domain: 'comercial',
  target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/oc/distribuciones' },
  trigger: { processRef: 'sjd_crossdocking' },
}

/** Log de la corrida: el nombre lleva el `_T0` del script (posterior al arranque), como en producción. */
const log = (iso: string): OneLakeEntry => ({ path: `Files/code/_logs/${runLogFileName(iso)}`, isDirectory: false, size: 1, lastModified: iso })

interface Arnes {
  store: SqliteGovernanceStore
  clock: { ms: number }
  runs: { records: RunRecord[] }
  landing: OneLakeEntry[]
  logs: { entries: OneLakeEntry[]; textos: Record<string, string> }
  loop: { tick(): Promise<void> }
}

async function armar(opts: { snapshotsViejos?: (reales: SlotWatchSnapshot[]) => SlotWatchSnapshot[] } = {}): Promise<Arnes> {
  const store = await SqliteGovernanceStore.open(null, {})
  const clock = { ms: Date.parse(SUBIDA) }
  const runs = { records: [] as RunRecord[] }
  const a: Omit<Arnes, 'loop'> = { store, clock, runs, landing: [], logs: { entries: [], textos: {} } }
  // El store de la proyección: el real, o uno cuya lectura devuelve una vista vieja (control de P-3).
  const vista = opts.snapshotsViejos
  const storeDeps = vista
    ? new Proxy(store, {
        get(t, k, r) {
          if (k === 'listSlotSnapshots') return async (o?: { runsPerSlot?: number }) => vista(await t.listSlotSnapshots(o))
          const v = Reflect.get(t, k, r) as unknown
          return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
        },
      })
    : store
  const deps: IntakeLoopDeps = {
    slots: () => [slot],
    landing: async (): Promise<OneLakeListing> => ({ kind: 'ok', entries: a.landing }),
    runs: async () => runs.records,
    store: storeDeps,
    domains: [{ id: 'comercial', label: 'Comercial' }],
    log: () => {},
    now: () => clock.ms,
    notify: async () => {},
    runLogs: { list: async () => a.logs.entries, read: async (_s, p) => a.logs.textos[p] ?? null },
  }
  return { ...a, loop: createIntakeLoop(deps, { publicUrl: 'https://mira.example.com', pollMs: 600_000 }) }
}

async function subir(a: Arnes): Promise<number> {
  return a.store.recordUpload({
    slotId: slot.id,
    filename: FILE,
    sha256: 'a'.repeat(64),
    bytes: 1024,
    uploadedBy: 'claudio.cornejo@teams.ratio.cl',
    uploadedAt: SUBIDA,
    ok: true,
    triggered: true,
    origen: 'upload',
  })
}

/** Los dos ticks medidos: en cola (15:31:10) y ya corridas, con el `✔` en el log del intento #1. */
async function secuenciaMedida(a: Arnes): Promise<void> {
  a.landing = [{ path: `${slot.target.path}/${FILE}`, isDirectory: false, size: 1024, lastModified: SUBIDA }]
  a.clock.ms = Date.parse('2026-09-24T15:31:10.000Z')
  a.runs.records = [
    { instanceId: ID_B, startedAt: B_COLA, status: 'NotStarted' },
    { instanceId: ID_A, startedAt: A_COLA, status: 'NotStarted' },
  ]
  await a.loop.tick()

  // 15:42: las dos arrancaron —con OTRO startTimeUtc— y terminaron. El archivo ya no está en el landing.
  a.landing = []
  a.clock.ms = Date.parse('2026-09-24T15:42:00.000Z')
  a.runs.records = [
    { instanceId: ID_B, startedAt: B_ARRANQUE, endedAt: B_FIN, status: 'Failed' },
    { instanceId: ID_A, startedAt: A_ARRANQUE, endedAt: A_FIN, status: 'Failed' },
  ]
  const l1 = log('2026-09-24T15:37:52Z') // intento YARN #1 del job A: declara el ✔
  const l2 = log('2026-09-24T15:38:20Z') // intento #2 del job A: ya no ve el archivo
  const l3 = log('2026-09-24T15:40:38Z') // job B
  a.logs.entries = [l1, l2, l3]
  a.logs.textos[l1.path] = `[intake] ✔ procesado: ${FILE}\n[intake] ✖ fallido: oc-17552475-distributions-details-23-09-2026.xlsx — descuadre\n`
  a.logs.textos[l2.path] = `[intake] ✖ fallido: oc-17552475-distributions-details-23-09-2026.xlsx — descuadre\n`
  a.logs.textos[l3.path] = `[intake] ✖ fallido: oc-17552475-distributions-details-23-09-2026.xlsx — descuadre\n`
  await a.loop.tick()
}

describe('corrida por id · la carga que pasó por cola termina sin esperar 60 min', () => {
  it('la secuencia medida el 24-09 (NotStarted@15:30:54 → Failed@15:36:23, mismo id) deja la carga `procesada` en el tick siguiente', async () => {
    const a = await armar()
    const id = await subir(a)
    await secuenciaMedida(a)

    const fila = (await a.store.listUploads(slot.id, 10)).find((r) => r.id === id)
    expect(fila?.desenlace).toBe('procesada')
    expect(fila?.desenlaceFinal).toBe(true)
    expect(fila?.desenlaceRunStartedAt).toBe(A_ARRANQUE)

    // La proyección tiene DOS corridas —una por instancia—, ninguna en cola, cada una con su id.
    const snap = (await a.store.listSlotSnapshots({ runsPerSlot: 60 })).find((s) => s.slotId === slot.id)!
    expect(snap.runs.map((r) => [r.instanceId, r.startedAt, r.status])).toEqual([
      [ID_B, B_ARRANQUE, 'Failed'],
      [ID_A, A_ARRANQUE, 'Failed'],
    ])
  })

  it('P-3 · con una proyección que todavía trae la vista en cola del mismo id, lo fresco la reemplaza (dedup por id)', async () => {
    // La lectura de la proyección devuelve, además, la corrida A como estaba en cola: mismo id, otro
    // instante. Deduplicar por instante la dejaría como una corrida aparte, `NotStarted` y reciente.
    const vieja: RunRecord = { instanceId: ID_A, startedAt: A_COLA, status: 'NotStarted' }
    const a = await armar({ snapshotsViejos: (ss) => ss.map((s) => (s.slotId === slot.id ? { ...s, runs: [...s.runs.filter((r) => r.instanceId !== ID_A), vieja] } : s)) })
    const id = await subir(a)
    await secuenciaMedida(a)
    const fila = (await a.store.listUploads(slot.id, 10)).find((r) => r.id === id)
    expect(fila?.desenlace).toBe('procesada')
  })
})
