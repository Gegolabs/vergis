import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SqliteGovernanceStore, GovernanceConflict, AdminLockout, INGESTION_RUN_RETENTION, type IntakeUploadRow } from '@vergis/capabilities'

describe('GovernanceStore · admins (consolidado)', () => {
  it('implementa AdminStore: semilla, alta, anti-lockout', async () => {
    const g = await SqliteGovernanceStore.open(null, { admins: ['Cesar@ultrabase.com'] })
    expect(await g.isAdmin('cesar@ultrabase.com')).toBe(true)
    expect(await g.add('claudio@ratio.cl', 'cesar@ultrabase.com')).toBe(true)
    await expect(g.remove('cesar@ultrabase.com')).rejects.toBeInstanceOf(AdminLockout) // semilla
    await g.close()
  })
})

describe('GovernanceStore · grupos de Mira', () => {
  it('siembra grupo con miembros y resuelve membresía', async () => {
    const g = await SqliteGovernanceStore.open(null, {
      groups: [{ id: 'analistas_arbol', label: 'Analistas ARBOL', members: ['ana@ratio.cl', 'Beto@ratio.cl'] }],
    })
    const groups = await g.listGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: 'analistas_arbol', label: 'Analistas ARBOL', seed: true })
    expect(await g.isMember('analistas_arbol', 'beto@ratio.cl')).toBe(true) // normalizado
    expect(await g.groupsOf('ana@ratio.cl')).toEqual(['analistas_arbol'])
    await g.close()
  })

  it('crea grupo, agrega/quita miembros, idempotente', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.createGroup('finanzas_gh', 'Finanzas GH')
    expect(await g.addMember('finanzas_gh', 'felipe@gh.cl')).toBe(true)
    expect(await g.addMember('finanzas_gh', 'felipe@gh.cl')).toBe(false) // idempotente
    expect((await g.listMembers('finanzas_gh')).map((m) => m.email)).toEqual(['felipe@gh.cl'])
    await g.removeMember('finanzas_gh', 'felipe@gh.cl')
    expect(await g.listMembers('finanzas_gh')).toHaveLength(0)
    await g.close()
  })

  it('un miembro SEMILLA removido en runtime NO reaparece al reabrir (tombstone; precedencia runtime)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-gov-')), 'governance.sqlite')
    const seed = { groups: [{ id: 'analistas_arbol', label: 'Analistas ARBOL', members: ['ana@ratio.cl', 'beto@ratio.cl'] }] }
    // 1ª apertura: siembra los dos, un admin remueve a beto.
    const g1 = await SqliteGovernanceStore.open(file, seed)
    await g1.removeMember('analistas_arbol', 'beto@ratio.cl')
    expect((await g1.listMembers('analistas_arbol')).map((m) => m.email)).toEqual(['ana@ratio.cl'])
    await g1.close()
    // Restart con la MISMA config semilla: beto NO debe resucitar; ana sigue.
    const g2 = await SqliteGovernanceStore.open(file, seed)
    expect((await g2.listMembers('analistas_arbol')).map((m) => m.email)).toEqual(['ana@ratio.cl'])
    expect(await g2.isMember('analistas_arbol', 'beto@ratio.cl')).toBe(false)
    // Readmitir a beto limpia el tombstone: persiste tras otro restart.
    await g2.addMember('analistas_arbol', 'beto@ratio.cl')
    await g2.close()
    const g3 = await SqliteGovernanceStore.open(file, seed)
    expect(await g3.isMember('analistas_arbol', 'beto@ratio.cl')).toBe(true)
    await g3.close()
  })

  it('rechaza grupo duplicado, id inválido, correo inválido, miembro en grupo inexistente', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.createGroup('g1', 'Grupo 1')
    await expect(g.createGroup('g1', 'Otra')).rejects.toBeInstanceOf(GovernanceConflict)
    await expect(g.createGroup('Mal Id', 'X')).rejects.toThrow(/inválido/)
    await expect(g.addMember('g1', 'no-correo')).rejects.toThrow(/inválido/)
    await expect(g.addMember('inexistente', 'a@b.com')).rejects.toThrow(/No existe el grupo/)
    await g.close()
  })

  it('borrar grupo arrastra sus miembros', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.createGroup('temp', 'Temp')
    await g.addMember('temp', 'x@y.com')
    await g.deleteGroup('temp')
    expect(await g.listGroups()).toHaveLength(0)
    expect(await g.groupsOf('x@y.com')).toEqual([])
    await g.close()
  })
})

// ─── Registro de cargas del intake + dedup por contenido (issue #62) ────────
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const upload = (over: Partial<Omit<IntakeUploadRow, 'id'>> = {}): Omit<IntakeUploadRow, 'id'> => ({
  slotId: 'saldos',
  filename: 'saldos VH WK28.xlsx',
  sha256: SHA_A,
  bytes: 110760,
  uploadedBy: 'claudio@x.cl',
  uploadedAt: '2026-07-13T16:17:42Z',
  ok: true,
  triggered: true,
  origen: 'upload',
  ...over,
})

describe('GovernanceStore · registro de cargas del intake (issue #62)', () => {
  it('recordUpload devuelve ids crecientes y listUploads los da recientes primero, acotado por limit', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const id1 = await g.recordUpload(upload({ uploadedAt: '2026-07-13T16:17:42Z' }))
    const id2 = await g.recordUpload(upload({ filename: 'b.xlsx', sha256: SHA_B, uploadedAt: '2026-07-20T10:00:00Z' }))
    const id3 = await g.recordUpload(upload({ filename: 'c.xlsx', sha256: 'c'.repeat(64), uploadedAt: '2026-07-27T10:00:00Z' }))
    expect(id2).toBeGreaterThan(id1)
    expect(id3).toBeGreaterThan(id2)
    const rows = await g.listUploads('saldos', 2)
    expect(rows.map((r) => r.filename)).toEqual(['c.xlsx', 'b.xlsx'])
    expect(rows[0]).toMatchObject({ id: id3, slotId: 'saldos', ok: true, triggered: true, origen: 'upload', uploadedBy: 'claudio@x.cl' })
    expect(await g.listUploads('otro-slot', 10)).toEqual([])
    await g.close()
  })

  it('findUploadBySha devuelve la fila MÁS ANTIGUA ok=1 del slot; ignora rechazos, otro slot y sha desconocido', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordUpload(upload({ filename: 'rechazada.xlsx', uploadedAt: '2026-07-01T09:00:00Z', ok: false, error: 'archivo vacío' }))
    const original = await g.recordUpload(upload({ filename: 'original.xlsx', uploadedAt: '2026-07-13T16:17:42Z' }))
    await g.recordUpload(upload({ filename: 'copia (1) (1).xlsx', uploadedAt: '2026-07-20T10:00:00Z', dupOfId: original }))
    await g.recordUpload(upload({ slotId: 'otro', filename: 'ajena.xlsx', uploadedAt: '2026-07-02T10:00:00Z' }))
    const hit = await g.findUploadBySha('saldos', SHA_A)
    expect(hit).toMatchObject({ id: original, filename: 'original.xlsx' })
    expect(await g.findUploadBySha('saldos', SHA_B)).toBeNull()
    expect(await g.findUploadBySha('sin-cargas', SHA_A)).toBeNull()
    // El sha se normaliza a minúsculas en ambos extremos.
    expect((await g.findUploadBySha('saldos', SHA_A.toUpperCase()))?.id).toBe(original)
    // La fila rechazada se registró igual (el timeline la muestra), con su motivo.
    const rechazada = (await g.listUploads('saldos', 10)).find((r) => r.filename === 'rechazada.xlsx')
    expect(rechazada).toMatchObject({ ok: false, error: 'archivo vacío' })
    await g.close()
  })

  it('la marca de indexado retroactivo es por slot e idempotente', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    expect(await g.intakeBackfillDone('saldos')).toBe(false)
    await g.markIntakeBackfillDone('saldos', 12, 1)
    expect(await g.intakeBackfillDone('saldos')).toBe(true)
    await g.markIntakeBackfillDone('saldos', 14, 0) // re-marcar no duplica ni falla
    expect(await g.intakeBackfillDone('saldos')).toBe(true)
    expect(await g.intakeBackfillDone('otro')).toBe(false)
    await g.close()
  })

  it('las cargas y la marca sobreviven al reinicio (persistencia en archivo)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-gov-intake-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, {})
    const id = await g1.recordUpload(upload({ origen: 'retro', uploadedBy: '(retro: _processed)', triggered: false }))
    await g1.markIntakeBackfillDone('saldos', 3, 0)
    await g1.close()
    const g2 = await SqliteGovernanceStore.open(file, {})
    const rows = await g2.listUploads('saldos', 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, origen: 'retro', triggered: false, uploadedBy: '(retro: _processed)' })
    expect((await g2.findUploadBySha('saldos', SHA_A))?.id).toBe(id)
    expect(await g2.intakeBackfillDone('saldos')).toBe(true)
    await g2.close()
  })
})

// Issue #99: el proceso declara dónde deja sus logs por corrida.
describe('GovernanceStore · logs por corrida del proceso (#99)', () => {
  it('upsert con logs → listProcesses lo devuelve sin inventar defaults', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertSource('sap', 'SAP', 'P1D', { domain: 'finanzas' })
    await g.upsertProcess('p_finanzas', 'Ingesta Finanzas', 'sap', { workspaceId: 'WS', itemId: 'SJD', jobType: 'sparkjob' }, { lakehouseId: 'LH' })
    const p = (await g.listProcesses()).find((x) => x.id === 'p_finanzas')
    expect(p?.logs).toEqual({ lakehouseId: 'LH' })
    await g.close()
  })

  it('un upsert posterior SIN logs no borra el ref registrado', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertSource('sap', 'SAP', 'P1D')
    await g.upsertProcess('p_finanzas', 'Ingesta', 'sap', undefined, { lakehouseId: 'LH', workspaceId: 'WS2', dir: 'Files/otro/_logs' })
    await g.upsertProcess('p_finanzas', 'Ingesta (renombrada)', 'sap')
    const p = (await g.listProcesses()).find((x) => x.id === 'p_finanzas')
    expect(p?.label).toBe('Ingesta (renombrada)')
    expect(p?.logs).toEqual({ lakehouseId: 'LH', workspaceId: 'WS2', dir: 'Files/otro/_logs' })
    await g.close()
  })

  it('logs sin lakehouseId lanza', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertSource('sap', 'SAP', 'P1D')
    await expect(g.upsertProcess('p_x', 'X', 'sap', undefined, { lakehouseId: '  ' })).rejects.toThrow(/lakehouseId/)
    await g.close()
  })

  it('la semilla GovernanceSeed.processes[].logs persiste', async () => {
    const g = await SqliteGovernanceStore.open(null, {
      sources: [{ id: 'sap', label: 'SAP', oferta: 'P1D' }],
      processes: [{ id: 'p_finanzas', label: 'Ingesta', sourceId: 'sap', engine: { workspaceId: 'WS', itemId: 'SJD', jobType: 'sparkjob' }, logs: { lakehouseId: 'LH' } }],
    })
    expect((await g.listProcesses())[0]?.logs).toEqual({ lakehouseId: 'LH' })
    await g.close()
  })
})

// ─── Proyección de ingestión: corridas + schedule observados (issue #105) ────
describe('GovernanceStore · proyección de corridas (#105)', () => {
  const snapOf = async (g: SqliteGovernanceStore, pid: string, runsPerProcess?: number) =>
    (await g.listRunSnapshots(runsPerProcess != null ? { runsPerProcess } : undefined)).find((s) => s.processId === pid)

  it('un lote exitoso puebla el snapshot: corridas recientes primero, schedule, observedAt y sin error', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordObservations([
      {
        processId: 'p_finanzas',
        observedAt: '2026-08-06T10:00:00.000Z',
        scheduleSeconds: 3600,
        runs: [
          { startedAt: '2026-08-06T09:00:00Z', endedAt: '2026-08-06T09:04:00Z', status: 'Completed' },
          { startedAt: '2026-08-06T08:00:00Z', status: 'Failed', error: 'timeout' },
        ],
      },
    ])
    const s = await snapOf(g, 'p_finanzas')
    expect(s?.runs.map((r) => r.startedAt)).toEqual(['2026-08-06T09:00:00Z', '2026-08-06T08:00:00Z'])
    expect(s?.runs[1]).toMatchObject({ status: 'Failed', error: 'timeout' })
    expect(s).toMatchObject({ scheduleSeconds: 3600, observedAt: '2026-08-06T10:00:00.000Z', lastError: null, lastErrorAt: null })
    await g.close()
  })

  it('una corrida InProgress re-observada Completed actualiza LA MISMA fila (no duplica)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordObservations([{ processId: 'p', observedAt: '2026-08-06T10:00:00Z', scheduleSeconds: 3600, runs: [{ startedAt: '2026-08-06T09:00:00Z', status: 'InProgress' }] }])
    await g.recordObservations([{ processId: 'p', observedAt: '2026-08-06T10:05:00Z', scheduleSeconds: 3600, runs: [{ startedAt: '2026-08-06T09:00:00Z', endedAt: '2026-08-06T09:07:00Z', status: 'Completed' }] }])
    const s = await snapOf(g, 'p')
    expect(s?.runs).toHaveLength(1)
    expect(s?.runs[0]).toMatchObject({ startedAt: '2026-08-06T09:00:00Z', status: 'Completed', endedAt: '2026-08-06T09:07:00Z' })
    await g.close()
  })

  it('las corridas con startedAt vacío se ignoran (no hay clave posible)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordObservations([{ processId: 'p', observedAt: '2026-08-06T10:00:00Z', scheduleSeconds: null, runs: [{ startedAt: '', status: 'Completed' }, { startedAt: '2026-08-06T09:00:00Z', status: 'Completed' }] }])
    const s = await snapOf(g, 'p')
    expect(s?.runs.map((r) => r.startedAt)).toEqual(['2026-08-06T09:00:00Z'])
    expect(s?.scheduleSeconds).toBeNull()
    await g.close()
  })

  it(`poda a ${INGESTION_RUN_RETENTION} corridas por proceso: se conservan las MÁS NUEVAS`, async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const at = (i: number): string => `2026-08-06T00:00:00.${String(i).padStart(3, '0')}Z`
    const runs = Array.from({ length: 70 }, (_, i) => ({ startedAt: at(i), status: 'Completed' as const }))
    await g.recordObservations([{ processId: 'p', observedAt: '2026-09-01T00:00:00Z', scheduleSeconds: 60, runs }])
    const s = await snapOf(g, 'p', 200)
    expect(s?.runs).toHaveLength(INGESTION_RUN_RETENTION)
    expect(s?.runs[0]?.startedAt).toBe(at(69)) // la más nueva
    expect(s?.runs.at(-1)?.startedAt).toBe(at(10)) // las 10 más viejas se podaron
    await g.close()
  })

  it('una observación con error conserva lo último conocido y marca lastError; la siguiente exitosa lo limpia', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordObservations([{ processId: 'p', observedAt: '2026-08-06T10:00:00Z', scheduleSeconds: 3600, runs: [{ startedAt: '2026-08-06T09:00:00Z', status: 'Completed' }] }])
    await g.recordObservations([{ processId: 'p', observedAt: '2026-08-06T10:05:00Z', error: 'motor no respondió' }])
    const caido = await snapOf(g, 'p')
    expect(caido).toMatchObject({ scheduleSeconds: 3600, observedAt: '2026-08-06T10:00:00Z', lastError: 'motor no respondió', lastErrorAt: '2026-08-06T10:05:00Z' })
    expect(caido?.runs.map((r) => r.startedAt)).toEqual(['2026-08-06T09:00:00Z'])
    await g.recordObservations([{ processId: 'p', observedAt: '2026-08-06T10:10:00Z', scheduleSeconds: 3600, runs: [{ startedAt: '2026-08-06T10:00:00Z', status: 'Completed' }] }])
    const sano = await snapOf(g, 'p')
    expect(sano).toMatchObject({ observedAt: '2026-08-06T10:10:00Z', lastError: null, lastErrorAt: null })
    expect(sano?.runs).toHaveLength(2)
    await g.close()
  })

  it('un lote exitoso con runs: [] actualiza schedule/observedAt sin tocar las corridas (re-observación del botón)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordObservations([{ processId: 'p', observedAt: '2026-08-06T10:00:00Z', scheduleSeconds: 90, runs: [{ startedAt: '2026-08-06T09:00:00Z', status: 'Completed' }] }])
    await g.recordObservations([{ processId: 'p', observedAt: '2026-08-06T10:01:00Z', scheduleSeconds: 60, runs: [] }])
    const s = await snapOf(g, 'p')
    expect(s).toMatchObject({ scheduleSeconds: 60, observedAt: '2026-08-06T10:01:00Z' })
    expect(s?.runs.map((r) => r.startedAt)).toEqual(['2026-08-06T09:00:00Z'])
    await g.close()
  })

  it('runsPerProcess acota las corridas devueltas y un proceso nunca observado no aparece (proyección fría)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordObservations([
      { processId: 'p', observedAt: '2026-08-06T10:00:00Z', scheduleSeconds: 60, runs: [
        { startedAt: '2026-08-06T09:00:00Z', status: 'Completed' },
        { startedAt: '2026-08-06T08:00:00Z', status: 'Completed' },
        { startedAt: '2026-08-06T07:00:00Z', status: 'Completed' },
      ] },
    ])
    expect((await snapOf(g, 'p', 2))?.runs.map((r) => r.startedAt)).toEqual(['2026-08-06T09:00:00Z', '2026-08-06T08:00:00Z'])
    expect(await snapOf(g, 'jamas_observado')).toBeUndefined()
    await g.close()
  })

  it('la proyección sobrevive al reinicio (persistencia en archivo)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-gov-proj-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, {})
    await g1.recordObservations([{ processId: 'p', observedAt: '2026-08-06T10:00:00Z', scheduleSeconds: 3600, runs: [{ startedAt: '2026-08-06T09:00:00Z', status: 'Completed' }] }])
    await g1.close()
    const g2 = await SqliteGovernanceStore.open(file, {})
    const s = (await g2.listRunSnapshots())[0]
    expect(s).toMatchObject({ processId: 'p', scheduleSeconds: 3600, observedAt: '2026-08-06T10:00:00Z', lastError: null })
    expect(s?.runs.map((r) => r.startedAt)).toEqual(['2026-08-06T09:00:00Z'])
    await g2.close()
  })
})

// ─── Registro de fuentes gestionable in-app (#107) ───────────────────────────
// La precedencia declarada: lo editado in-app gana a la semilla; lo dado de baja no resucita; un alta
// posterior del mismo id revoca el tombstone. El test juzga la CONDUCTA, no la forma SQL del upsert.
describe('GovernanceStore · registro gestionable in-app y precedencia sobre la semilla (#107)', () => {
  const SEMILLA = {
    sources: [{ id: 'sap', label: 'SAP (yaml)', oferta: 'PT1H', domain: 'cartera' }],
    processes: [{ id: 'p_sap', label: 'Ingesta SAP (yaml)', sourceId: 'sap' }],
  }

  it('una fila SOLO-semilla se re-siembra en cada arranque (conducta de siempre, intacta)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-gov-seed-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, SEMILLA)
    await g1.close()
    const g2 = await SqliteGovernanceStore.open(file, {
      sources: [{ id: 'sap', label: 'SAP renombrada', oferta: 'PT2H', domain: 'cartera' }],
      processes: [{ id: 'p_sap', label: 'Ingesta renombrada', sourceId: 'sap' }],
    })
    expect((await g2.listSources())[0]).toMatchObject({ label: 'SAP renombrada', oferta: 'PT2H', managed: false })
    expect((await g2.listProcesses())[0]).toMatchObject({ label: 'Ingesta renombrada' })
    await g2.close()
  })

  it('lo editado in-app NO lo pisa la re-siembra; la fila queda marcada como gestionada', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-gov-managed-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, SEMILLA)
    await g1.upsertSource('sap', 'SAP B1 (in-app)', 'PT30M', { domain: 'cartera', connectedBy: 'Cesar@ultrabase.com', managed: true })
    await g1.upsertProcess('p_sap', 'Ingesta SAP (in-app)', 'sap', undefined, undefined, { managed: true })
    expect((await g1.listSources())[0]).toMatchObject({ label: 'SAP B1 (in-app)', oferta: 'PT30M', connectedBy: 'cesar@ultrabase.com', managed: true })
    await g1.close()

    const g2 = await SqliteGovernanceStore.open(file, SEMILLA) // el yaml vuelve a traer sus valores
    expect((await g2.listSources())[0]).toMatchObject({ label: 'SAP B1 (in-app)', oferta: 'PT30M', managed: true })
    expect((await g2.listProcesses())[0]).toMatchObject({ label: 'Ingesta SAP (in-app)', managed: true })
    await g2.close()
  })

  it('una baja in-app deja tombstone: la re-siembra NO resucita ni la fuente ni el proceso', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-gov-tomb-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, SEMILLA)
    await g1.deleteProcess('p_sap')
    await g1.deleteSource('sap')
    await g1.close()

    const g2 = await SqliteGovernanceStore.open(file, SEMILLA)
    expect(await g2.listSources()).toEqual([])
    expect(await g2.listProcesses()).toEqual([])
    // Un alta in-app del mismo id revoca el tombstone: la fila vive y sobrevive al reinicio.
    await g2.upsertSource('sap', 'SAP recontratada', 'PT1H', { managed: true })
    await g2.close()
    const g3 = await SqliteGovernanceStore.open(file, SEMILLA)
    expect((await g3.listSources())[0]).toMatchObject({ id: 'sap', label: 'SAP recontratada', managed: true })
    await g3.close()
  })

  it('pausa: roundtrip con el correo normalizado, persistente por archivo, y la edición no la borra', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-gov-pausa-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, SEMILLA)
    await g1.setProcessPaused('p_sap', true, 'Steward@GH.cl')
    expect((await g1.listProcesses())[0]).toMatchObject({ pausedBy: 'steward@gh.cl' })
    expect((await g1.listProcesses())[0].pausedAt).toBeTruthy()
    await g1.close()

    const g2 = await SqliteGovernanceStore.open(file, SEMILLA)
    expect((await g2.listProcesses())[0].pausedAt).toBeTruthy() // sobrevive al reinicio
    // Editar un proceso pausado NO lo des-pausa.
    await g2.upsertProcess('p_sap', 'Ingesta SAP editada', 'sap', undefined, undefined, { managed: true })
    expect((await g2.listProcesses())[0]).toMatchObject({ label: 'Ingesta SAP editada', pausedBy: 'steward@gh.cl' })
    await g2.setProcessPaused('p_sap', false)
    expect((await g2.listProcesses())[0].pausedAt).toBeUndefined()
    expect((await g2.listProcesses())[0].pausedBy).toBeUndefined()
    await g2.close()
  })

  it('pausar un proceso inexistente lanza (no se inventa la fila)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await expect(g.setProcessPaused('fantasma', true, 'x@y.cl')).rejects.toThrow(/desconocido/i)
    await g.close()
  })

  it('deleteTableSource borra SOLO su mapeo; deleteProcess sigue cascadeando las salidas', async () => {
    const g = await SqliteGovernanceStore.open(null, SEMILLA)
    await g.setTableSource('dw.fct_saldos', 'sap')
    await g.setTableSource('dw.fct_otra', 'sap')
    await g.setProcessOutput('p_sap', 'dw.fct_saldos')
    await g.deleteTableSource('dw.fct_saldos')
    expect((await g.listTableSources()).map((m) => m.tableRef)).toEqual(['dw.fct_otra'])
    await g.deleteProcess('p_sap')
    expect(await g.listProcessOutputs()).toEqual([])
    await g.close()
  })
})
