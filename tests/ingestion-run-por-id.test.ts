import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SqliteGovernanceStore, SCHEMA_VERSION, openSqliteDb, persistSqliteDb, selectAll, type RunRecord } from '@vergis/capabilities'

/**
 * #362 · la proyección de corridas de PROCESOS (`ingestion_run`, #105) identifica la corrida por su id
 * de instancia, como `intake_watch_run` desde #361. Misma fuente (`createFabricJobStatus.listInstances`)
 * y misma clave `started_at`: Fabric informa la corrida en cola como `NotStarted` con un instante y, al
 * arrancarla, con otro; con el instante como clave, la vista en cola quedaba `NotStarted` para siempre.
 *
 * Los instantes son los medidos el 24-09 en `intake_watch_run` (jobs `907e4539` / `a184ff9d`): en
 * `ingestion_run` el fantasma no está observado, se infiere por construcción (ver el issue).
 */

const PROC = 'sjd_crossdocking'
const A_COLA = '2026-09-24T15:30:54.2833333Z'
const B_COLA = '2026-09-24T15:31:09.5766667Z'
const A_ARRANQUE = '2026-09-24T15:36:23.4725792Z'
const A_FIN = '2026-09-24T15:38:45.2191304Z'
const B_ARRANQUE = '2026-09-24T15:39:15.8862356Z'
const B_FIN = '2026-09-24T15:41:30.7088708Z'
const ID_A = '907e4539-0000-4000-8000-000000000001'
const ID_B = 'a184ff9d-0000-4000-8000-000000000002'

const observar = (g: SqliteGovernanceStore, observedAt: string, runs: RunRecord[]): Promise<void> =>
  g.recordObservations([{ processId: PROC, observedAt, runs, scheduleSeconds: null }])
const corridas = async (g: SqliteGovernanceStore): Promise<RunRecord[]> =>
  (await g.listRunSnapshots({ runsPerProcess: 60 })).find((s) => s.processId === PROC)?.runs ?? []

describe('#362 · la corrida que sale de la cola no deja una fila NotStarted fantasma', () => {
  it('cola → arrancada con otro instante y el mismo id: una sola corrida, la arrancada', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await observar(g, '2026-09-24T15:32:00Z', [
      { instanceId: ID_B, startedAt: B_COLA, status: 'NotStarted' },
      { instanceId: ID_A, startedAt: A_COLA, status: 'NotStarted' },
    ])
    await observar(g, '2026-09-24T15:37:00Z', [
      { instanceId: ID_A, startedAt: A_ARRANQUE, status: 'InProgress' },
      { instanceId: ID_B, startedAt: B_COLA, status: 'NotStarted' },
    ])
    await observar(g, '2026-09-24T15:42:00Z', [
      { instanceId: ID_B, startedAt: B_ARRANQUE, endedAt: B_FIN, status: 'Failed' },
      { instanceId: ID_A, startedAt: A_ARRANQUE, endedAt: A_FIN, status: 'Failed' },
    ])
    const runs = await corridas(g)
    expect(runs.filter((r) => r.status === 'NotStarted')).toEqual([])
    expect(runs.map((r) => [r.startedAt, r.instanceId, r.status])).toEqual([
      [B_ARRANQUE, ID_B, 'Failed'],
      [A_ARRANQUE, ID_A, 'Failed'],
    ])
    await g.close()
  })

  it('control · un motor sin id conserva la identidad por instante (no se fusiona nada)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await observar(g, '2026-09-24T15:32:00Z', [{ startedAt: A_COLA, status: 'NotStarted' }])
    await observar(g, '2026-09-24T16:40:00Z', [{ startedAt: '2026-09-24T16:35:00Z', status: 'Completed' }])
    // 64 min después: fuera de la ventana de sustitución, la fila en cola sigue proyectándose.
    expect((await corridas(g)).map((r) => r.status)).toEqual(['Completed', 'NotStarted'])
    await g.close()
  })
})

describe('#362 · migración de un archivo escrito por la versión anterior', () => {
  const OLD_DDL = `CREATE TABLE ingestion_run (process_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL, error TEXT, PRIMARY KEY (process_id, started_at))`
  const OLD_UPSERT = `INSERT INTO ingestion_run (process_id, started_at, ended_at, status, error) VALUES (?,?,?,?,?)
       ON CONFLICT(process_id, started_at) DO UPDATE SET ended_at=excluded.ended_at, status=excluded.status, error=excluded.error`
  const VECINA = '2026-09-24T13:47:36.8089028Z'

  /** Lo que dejó la versión anterior: las dos vistas en cola, sin id, y una vecina terminada. */
  async function archivoLegado(): Promise<string> {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-ingestion-id-')), 'governance.sqlite')
    const db = await openSqliteDb(file)
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.run(OLD_DDL)
    db.run(OLD_UPSERT, [PROC, VECINA, '2026-09-24T13:49:30Z', 'Completed', null])
    db.run(OLD_UPSERT, [PROC, A_COLA, null, 'NotStarted', null])
    db.run(OLD_UPSERT, [PROC, B_COLA, null, 'NotStarted', null])
    persistSqliteDb(db, file)
    db.close()
    return file
  }

  it('abre sin perder filas; el primer tick con ids cierra las dos legadas como sustituidas, uno a uno, sin borrar', async () => {
    const file = await archivoLegado()
    const g = await SqliteGovernanceStore.open(file, {})
    expect((await corridas(g)).filter((r) => r.status === 'NotStarted')).toHaveLength(2) // la migración sola no decide
    await observar(g, '2026-09-24T17:00:00Z', [
      { instanceId: ID_B, startedAt: B_ARRANQUE, endedAt: B_FIN, status: 'Failed' },
      { instanceId: ID_A, startedAt: A_ARRANQUE, endedAt: A_FIN, status: 'Failed' },
    ])
    expect((await corridas(g)).map((r) => [r.startedAt, r.status])).toEqual([
      [B_ARRANQUE, 'Failed'],
      [A_ARRANQUE, 'Failed'],
      [VECINA, 'Completed'],
    ])
    await g.close()
    const insp = await openSqliteDb(file, { mode: 'read', schemaVersion: SCHEMA_VERSION })
    const filas = selectAll(insp, `SELECT started_at, superseded_by FROM ingestion_run WHERE process_id = '${PROC}'`)
    expect(filas).toHaveLength(5)
    expect(Object.fromEntries(filas.filter((r) => r['superseded_by'] != null).map((r) => [r['started_at'], r['superseded_by']]))).toEqual({
      [A_COLA]: A_ARRANQUE,
      [B_COLA]: B_ARRANQUE,
    })
    insp.close()
  })

  it('una legada todavía en cola cuya instancia el motor sigue listando en ese instante se ADOPTA y no se cierra', async () => {
    const file = await archivoLegado()
    const g = await SqliteGovernanceStore.open(file, {})
    await observar(g, '2026-09-24T15:37:00Z', [
      { instanceId: ID_B, startedAt: B_COLA, status: 'NotStarted' },
      { instanceId: ID_A, startedAt: A_ARRANQUE, status: 'InProgress' },
    ])
    const enCola = (await corridas(g)).filter((r) => r.status === 'NotStarted')
    expect(enCola.map((r) => [r.startedAt, r.instanceId])).toEqual([[B_COLA, ID_B]])
    await g.close()
  })

  it('rollback · la versión anterior sigue escribiendo sobre el archivo migrado (su ON CONFLICT no tropieza)', async () => {
    const file = await archivoLegado()
    const g = await SqliteGovernanceStore.open(file, {})
    await observar(g, '2026-09-24T17:00:00Z', [{ instanceId: ID_A, startedAt: A_ARRANQUE, endedAt: A_FIN, status: 'Failed' }])
    await g.close()
    const viejo = await openSqliteDb(file)
    expect(() => {
      viejo.run(OLD_UPSERT, [PROC, A_ARRANQUE, A_FIN, 'Completed', null]) // la fila adoptada
      viejo.run(OLD_UPSERT, [PROC, '2026-09-25T10:00:00.1Z', null, 'NotStarted', null]) // una nueva sin id
    }).not.toThrow()
    viejo.close()
  })
})
