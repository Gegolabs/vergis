import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SqliteGovernanceStore, SCHEMA_VERSION, emparejarSustituidas, openSqliteDb, persistSqliteDb, selectAll } from '@vergis/capabilities'

/**
 * P-2 · el legado de la corrida identificada por instante. Hasta 0.38.0 la proyección guardaba cada
 * corrida con `started_at` como clave, y el motor le cambia ese instante al sacarla de la cola: quedaron
 * filas `NotStarted` huérfanas que nadie cierra. Con la identidad por id no nacen más (ver
 * `intake-corrida-por-id.test.ts`); estas se cierran como SUSTITUIDAS con un criterio conservador
 * (`emparejarSustituidas`) y jamás se borran.
 */

// Instantes reales del 24-09 (jobs `907e4539` / `a184ff9d`).
const A_COLA = '2026-09-24T15:30:54.2833333Z'
const B_COLA = '2026-09-24T15:31:09.5766667Z'
const A_ARRANQUE = '2026-09-24T15:36:23.4725792Z'
const A_FIN = '2026-09-24T15:38:45.2191304Z'
const B_ARRANQUE = '2026-09-24T15:39:15.8862356Z'
const B_FIN = '2026-09-24T15:41:30.7088708Z'
const ID_A = '907e4539-0000-4000-8000-000000000001'
const ID_B = 'a184ff9d-0000-4000-8000-000000000002'

/**
 * Las 6 fantasma REALES de producción (proyección de `vergis-0-38-0`, leída en memoria el 2026-09-24),
 * con sus vecinas inmediatas: la anterior y las dos siguientes del mismo slot. `esperada` es la corrida
 * que la sustituye según el criterio; la de 21-09, la de 22-09 16:10 y las dos de 24-09 coinciden con
 * el `submittedDateTime` de Livy que midió el diagnóstico.
 */
const FANTASMAS: { grupo: 'crossdocking' | 'plantacion'; cola: string; esperada: string; vecinas: [string, string, string][] }[] = [
  {
    grupo: 'crossdocking',
    cola: '2026-09-04T23:20:47.1566667Z',
    esperada: '2026-09-04T23:22:27.0171799Z',
    vecinas: [
      ['2026-09-04T23:20:16.3047557Z', '2026-09-04T23:21:00Z', 'Completed'],
      ['2026-09-04T23:22:27.0171799Z', '2026-09-04T23:24:00Z', 'Completed'],
      ['2026-09-16T17:35:54.1892108Z', '2026-09-16T17:37:00Z', 'Completed'],
    ],
  },
  {
    grupo: 'plantacion',
    cola: '2026-09-21T23:39:17.81Z',
    esperada: '2026-09-21T23:39:22.4927303Z',
    vecinas: [
      ['2026-09-06T00:31:05.4223058Z', '2026-09-06T00:33:00Z', 'Completed'],
      ['2026-09-21T23:39:22.4927303Z', '2026-09-21T23:41:00Z', 'Completed'],
      ['2026-09-24T16:25:11.9970422Z', '2026-09-24T16:27:00Z', 'Completed'],
    ],
  },
  {
    grupo: 'crossdocking',
    cola: '2026-09-22T14:39:45.6833333Z',
    esperada: '2026-09-22T14:42:08.6463174Z',
    vecinas: [
      ['2026-09-22T14:38:53.0160818Z', '2026-09-22T14:41:13.6414422Z', 'Failed'],
      ['2026-09-22T14:42:08.6463174Z', '2026-09-22T14:44:15.1017869Z', 'Failed'],
      ['2026-09-22T14:50:42.6462184Z', '2026-09-22T14:52:41.2241057Z', 'Failed'],
    ],
  },
  {
    grupo: 'crossdocking',
    cola: '2026-09-22T16:10:05.57Z',
    esperada: '2026-09-22T16:10:09.8310527Z',
    vecinas: [
      ['2026-09-22T15:46:42.1462392Z', '2026-09-22T15:48:28.6913617Z', 'Failed'],
      ['2026-09-22T16:10:09.8310527Z', '2026-09-22T16:12:41.9716697Z', 'Failed'],
      ['2026-09-22T16:17:54.595846Z', '2026-09-22T16:20:13.0216591Z', 'Failed'],
    ],
  },
  {
    grupo: 'crossdocking',
    cola: A_COLA,
    esperada: A_ARRANQUE,
    vecinas: [
      ['2026-09-24T13:47:36.8089028Z', '2026-09-24T13:49:30Z', 'Failed'],
      [A_ARRANQUE, A_FIN, 'Failed'],
      [B_ARRANQUE, B_FIN, 'Failed'],
    ],
  },
  // La segunda en cola del 24-09: la primera arrancada (15:36:23) ya es de la otra — uno a uno.
  { grupo: 'crossdocking', cola: B_COLA, esperada: B_ARRANQUE, vecinas: [] },
]

/** Filas legadas de UN slot tal como las escribió 0.38.0 (sin id), deduplicadas por `started_at`. */
function filasLegadas(grupo: 'crossdocking' | 'plantacion'): { startedAt: string; endedAt: string | null; status: string }[] {
  const m = new Map<string, { startedAt: string; endedAt: string | null; status: string }>()
  for (const f of FANTASMAS.filter((x) => x.grupo === grupo)) {
    m.set(f.cola, { startedAt: f.cola, endedAt: null, status: 'NotStarted' })
    for (const [s, e, st] of f.vecinas) m.set(s, { startedAt: s, endedAt: e, status: st })
  }
  return [...m.values()]
}

describe('P-2 · criterio de sustitución (puro) contra las 6 fantasma reales', () => {
  it('cada fantasma se empareja con la corrida que es ella misma arrancada; ninguna vecina se toca', () => {
    for (const grupo of ['crossdocking', 'plantacion'] as const) {
      const pares = emparejarSustituidas(filasLegadas(grupo))
      expect(Object.fromEntries(pares)).toEqual(Object.fromEntries(FANTASMAS.filter((f) => f.grupo === grupo).map((f) => [f.cola, f.esperada])))
    }
  })

  it('control · uno a uno: sin la segunda arrancada, la segunda en cola NO se cierra (sigue en cola de verdad)', () => {
    const filas = filasLegadas('crossdocking').filter((f) => f.startedAt !== B_ARRANQUE)
    const pares = emparejarSustituidas(filas)
    expect(pares.get(A_COLA)).toBe(A_ARRANQUE)
    expect(pares.has(B_COLA)).toBe(false)
  })

  it('control · una `NotStarted` con id no se cierra nunca, y una sin arrancada posterior dentro de la ventana tampoco', () => {
    const pares = emparejarSustituidas([
      { startedAt: A_COLA, status: 'NotStarted', instanceId: ID_A },
      { startedAt: A_ARRANQUE, status: 'Failed', instanceId: ID_B },
      { startedAt: '2026-09-24T10:00:00.1Z', status: 'NotStarted' },
      { startedAt: '2026-09-24T11:00:00.2Z', status: 'Completed' }, // 60 min + 0,1 s después: fuera
      { startedAt: '2026-09-24T09:59:00Z', status: 'Completed' }, // anterior: no es sustituta
    ])
    expect(pares.size).toBe(0)
  })
})

describe('P-2 · migración de un archivo de 0.38.0 con las fantasma reales', () => {
  const OLD_DDL = `CREATE TABLE intake_watch_run (slot_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL, error TEXT, PRIMARY KEY (slot_id, started_at))`
  const OLD_UPSERT = `INSERT INTO intake_watch_run (slot_id, started_at, ended_at, status, error) VALUES (?,?,?,?,?)
       ON CONFLICT(slot_id, started_at) DO UPDATE SET ended_at=excluded.ended_at, status=excluded.status, error=excluded.error`
  const SLOTS = ['oc_crossdocking', 'oc_crossdocking_distribuciones', 'oc_crossdocking_maestro']

  async function archivoLegado(): Promise<string> {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-corrida-id-')), 'governance.sqlite')
    const db = await openSqliteDb(file)
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.run(OLD_DDL)
    for (const sid of SLOTS) for (const f of filasLegadas('crossdocking')) db.run(OLD_UPSERT, [sid, f.startedAt, f.endedAt, f.status, null])
    persistSqliteDb(db, file)
    db.close()
    return file
  }

  it('abre sin perder filas; el primer tick (con ids) cierra las 5 de Cross Docking en cada slot como sustituidas y no borra nada', async () => {
    const cd = FANTASMAS.filter((f) => f.grupo === 'crossdocking')
    const file = await archivoLegado()
    const g = await SqliteGovernanceStore.open(file, {})
    const antes = (await g.listSlotSnapshots({ runsPerSlot: 60 })).find((s) => s.slotId === SLOTS[0])!
    expect(antes.runs.filter((r) => r.status === 'NotStarted')).toHaveLength(cd.length) // la migración sola no decide

    // El tick que sigue al despliegue: Fabric lista las dos del 24-09 con su id (ya arrancadas).
    const obs = SLOTS.map((slotId) => ({
      slotId,
      observedAt: '2026-09-24T17:00:00Z',
      landing: [],
      runs: [
        { instanceId: ID_B, startedAt: B_ARRANQUE, endedAt: B_FIN, status: 'Failed' as const },
        { instanceId: ID_A, startedAt: A_ARRANQUE, endedAt: A_FIN, status: 'Failed' as const },
      ],
    }))
    await g.recordSlotObservations(obs)

    const total = filasLegadas('crossdocking').length
    for (const sid of SLOTS) {
      const snap = (await g.listSlotSnapshots({ runsPerSlot: 60 })).find((s) => s.slotId === sid)!
      expect(snap.runs.filter((r) => r.status === 'NotStarted')).toEqual([])
      expect(snap.runs).toHaveLength(total - cd.length) // se dejan de proyectar las fantasma; las demás siguen
      expect(snap.runs.find((r) => r.startedAt === A_ARRANQUE)?.instanceId).toBe(ID_A) // adoptada, no duplicada
    }
    await g.close()

    // En el archivo: nada se borró, y cada fantasma apunta a su sustituta.
    const insp = await openSqliteDb(file, { mode: 'read', schemaVersion: SCHEMA_VERSION })
    const filas = selectAll(insp, `SELECT slot_id, started_at, superseded_by FROM intake_watch_run WHERE slot_id = '${SLOTS[0]}'`)
    expect(filas).toHaveLength(total)
    const marcadas = Object.fromEntries(filas.filter((r) => r['superseded_by'] != null).map((r) => [r['started_at'], r['superseded_by']]))
    expect(marcadas).toEqual(Object.fromEntries(cd.map((f) => [f.cola, f.esperada])))
    insp.close()
  })

  it('rollback · la versión anterior sigue escribiendo sobre el archivo migrado (su ON CONFLICT no tropieza)', async () => {
    const file = await archivoLegado()
    const g = await SqliteGovernanceStore.open(file, {})
    await g.recordSlotObservations([{ slotId: SLOTS[0]!, observedAt: '2026-09-24T17:00:00Z', landing: [], runs: [{ instanceId: ID_A, startedAt: A_ARRANQUE, endedAt: A_FIN, status: 'Failed' }] }])
    await g.close()
    const viejo = await openSqliteDb(file)
    expect(() => {
      viejo.run(OLD_UPSERT, [SLOTS[0]!, A_ARRANQUE, A_FIN, 'Completed', null]) // la fila adoptada
      viejo.run(OLD_UPSERT, [SLOTS[0]!, '2026-09-25T10:00:00.1Z', null, 'NotStarted', null]) // una nueva sin id
    }).not.toThrow()
    viejo.close()
  })

  it('una fila legada todavía en cola cuya instancia el motor sigue listando en ese instante se ADOPTA y no se cierra', async () => {
    const file = await archivoLegado()
    const g = await SqliteGovernanceStore.open(file, {})
    // B sigue en cola con su instante de cola: es la fila legada B_COLA, viva. La de A ya arrancó.
    await g.recordSlotObservations([
      {
        slotId: SLOTS[0]!,
        observedAt: '2026-09-24T15:37:00Z',
        landing: [],
        runs: [
          { instanceId: ID_B, startedAt: B_COLA, status: 'NotStarted' },
          { instanceId: ID_A, startedAt: A_ARRANQUE, status: 'InProgress' },
        ],
      },
    ])
    const snap = (await g.listSlotSnapshots({ runsPerSlot: 60 })).find((s) => s.slotId === SLOTS[0])!
    const enCola = snap.runs.filter((r) => r.status === 'NotStarted')
    expect(enCola.map((r) => [r.startedAt, r.instanceId])).toEqual([[B_COLA, ID_B]])
    await g.close()
  })
})
