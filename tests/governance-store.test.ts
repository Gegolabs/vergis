import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  SqliteGovernanceStore, GovernanceConflict, AdminLockout, INGESTION_RUN_RETENTION, INTAKE_WATCH_RUN_RETENTION,
  openSqliteDb, persistSqliteDb, selectAll,
  type IntakeUploadRow, type IntakeRevertRow, type ClaveAccion, type OneLakeEntry,
} from '@vergis/capabilities'

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

// ─── Registro de reversiones (issue #63) ────────────────────────────────────
const RESUMEN: ClaveAccion[] = [
  { clave: 'W28', accion: 'rematerializar', revertido: 'Files/intake/_processed/W28/saldos.xlsx', previa: 'Files/intake/_processed/W28/v1.xlsx' },
  { clave: 'W29', accion: 'pisada', revertido: 'Files/intake/_processed/W29/saldos.xlsx', vigente: 'Files/intake/_processed/W29/otra.xlsx', vigenteAt: '2026-07-20T09:00:00Z' },
]
const revert = (over: Partial<Omit<IntakeRevertRow, 'id'>> = {}): Omit<IntakeRevertRow, 'id'> => ({
  slotId: 'saldos',
  uploadId: 7,
  filename: 'saldos VH WK28.xlsx',
  byUser: 'steward@gh.cl',
  at: '2026-08-06T18:00:00Z',
  resumen: RESUMEN,
  landingRetirado: true,
  ...over,
})

describe('GovernanceStore · registro de reversiones del intake (issue #63)', () => {
  it('recordRevert devuelve id; listReverts da recientes primero, acotado, sin filas de otro slot', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const id1 = await g.recordRevert(revert({ at: '2026-08-01T10:00:00Z' }))
    const id2 = await g.recordRevert(revert({ at: '2026-08-06T18:00:00Z', filename: 'nueva.xlsx' }))
    await g.recordRevert(revert({ slotId: 'otro', filename: 'ajena.xlsx' }))
    expect(id2).toBeGreaterThan(id1)
    const rows = await g.listReverts('saldos', 10)
    expect(rows.map((r) => r.filename)).toEqual(['nueva.xlsx', 'saldos VH WK28.xlsx'])
    expect(await g.listReverts('saldos', 1)).toHaveLength(1)
    expect((await g.listReverts('otro', 10)).map((r) => r.filename)).toEqual(['ajena.xlsx'])
    expect(await g.listReverts('sin-reversiones', 10)).toEqual([])
    await g.close()
  })

  it('el resumen por clave hace roundtrip como JSON, y una carga sin ancla queda sin uploadId', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordRevert(revert())
    const sinAncla = await g.recordRevert(revert({ at: '2026-08-07T09:00:00Z', uploadId: undefined, landingRetirado: false }))
    const rows = await g.listReverts('saldos', 10)
    expect(rows[0]).toMatchObject({ id: sinAncla, landingRetirado: false })
    expect(rows[0].uploadId).toBeUndefined()
    expect(rows[1]).toMatchObject({ uploadId: 7, byUser: 'steward@gh.cl', landingRetirado: true })
    expect(rows[1].resumen).toEqual(RESUMEN)
    await g.close()
  })

  it('las reversiones sobreviven al reinicio (persistencia en archivo)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-gov-revert-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, {})
    const id = await g1.recordRevert(revert())
    await g1.close()
    const g2 = await SqliteGovernanceStore.open(file, {})
    const rows = await g2.listReverts('saldos', 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, uploadId: 7, filename: 'saldos VH WK28.xlsx' })
    expect(rows[0].resumen).toEqual(RESUMEN)
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

describe('GovernanceStore · reseed en caliente: la MISMA proyección del arranque (#138·2)', () => {
  const SEMILLA_R = {
    sources: [{ id: 'sap', label: 'SAP (yaml)', oferta: 'PT1H', domain: 'cartera' }],
    processes: [{ id: 'p_sap', label: 'Ingesta SAP (yaml)', sourceId: 'sap' }],
    tableSources: [{ tableRef: 'dw.fct_saldos', sourceId: 'sap' }],
    processOutputs: [{ processId: 'p_sap', tableRef: 'dw.fct_saldos' }],
  }

  it('(1) NO pisa una fila gestionada in-app aunque el yaml recargado traiga otros valores', async () => {
    const g = await SqliteGovernanceStore.open(null, SEMILLA_R)
    await g.upsertSource('sap', 'SAP B1 (in-app)', 'PT30M', { domain: 'cartera', managed: true })
    await g.reseed({ sources: [{ id: 'sap', label: 'SAP renombrada en el yaml', oferta: 'PT6H' }] })
    expect((await g.listSources())[0]).toMatchObject({ label: 'SAP B1 (in-app)', oferta: 'PT30M', managed: true })
    await g.close()
  })

  it('(2) NO resucita un id tombstoneado por una baja in-app', async () => {
    const g = await SqliteGovernanceStore.open(null, SEMILLA_R)
    await g.deleteProcess('p_sap')
    await g.deleteSource('sap')
    await g.reseed(SEMILLA_R)
    expect(await g.listSources()).toEqual([])
    expect(await g.listProcesses()).toEqual([])
    await g.close()
  })

  it('(3) tras un alta in-app que revoca el tombstone, el reseed sí entra', async () => {
    const g = await SqliteGovernanceStore.open(null, SEMILLA_R)
    await g.deleteSource('sap')
    await g.upsertSource('sap', 'SAP recontratada', 'PT1H') // el alta in-app revoca el tombstone
    await g.reseed({ sources: [{ id: 'otra', label: 'Otra fuente', oferta: 'PT2H' }] })
    expect((await g.listSources()).map((s) => s.id).sort()).toEqual(['otra', 'sap'])
    await g.close()
  })

  it('(4) semilla inválida en la fila N: NINGUNA fila escrita (validate-before-write)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await expect(
      g.reseed({
        sources: [
          { id: 'buena', label: 'Fuente sana', oferta: 'PT1H' },
          { id: 'mala', label: 'Fuente con oferta rota', oferta: 'cada ratito' },
        ],
      }),
    ).rejects.toThrow()
    expect(await g.listSources()).toEqual([]) // la fila 1 NO quedó escrita
    await g.close()
  })

  it('(4-bis) id de grupo semilla inválido: ningún grupo escrito', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await expect(
      g.reseed({
        groups: [
          { id: 'analistas', label: 'Analistas', members: ['a@b.cl'] },
          { id: 'NO VÁLIDO!', label: 'Roto' },
        ],
      }),
    ).rejects.toThrow(/id de grupo semilla inválido/i)
    expect(await g.listGroups()).toEqual([])
    await g.close()
  })

  it('(5) open(seed) y open({}) + reseed(seed) dejan el store IDÉNTICO (misma proyección)', async () => {
    const conOpen = await SqliteGovernanceStore.open(null, SEMILLA_R)
    const conReseed = await SqliteGovernanceStore.open(null, {})
    await conReseed.reseed(SEMILLA_R)
    expect(await conReseed.listSources()).toEqual(await conOpen.listSources())
    expect(await conReseed.listProcesses()).toEqual(await conOpen.listProcesses())
    expect(await conReseed.listTableSources()).toEqual(await conOpen.listTableSources())
    expect(await conReseed.listProcessOutputs()).toEqual(await conOpen.listProcessOutputs())
    await conOpen.close()
    await conReseed.close()
  })

  it('(5-bis) grupos: reseed reproduce la siembra de open, y un miembro removido in-app no vuelve', async () => {
    const GRUPOS = { groups: [{ id: 'analistas', label: 'Analistas', members: ['a@b.cl', 'c@d.cl'] }] }
    const g = await SqliteGovernanceStore.open(null, GRUPOS)
    await g.removeMember('analistas', 'c@d.cl')
    await g.reseed(GRUPOS)
    expect((await g.listGroups()).map((x) => x.id)).toEqual(['analistas'])
    expect((await g.listMembers('analistas')).map((m) => m.email)).toEqual(['a@b.cl'])
    await g.close()
  })
})

// ─── Vigilancia del intake: proyección por slot (#161) + desenlace por carga (#162) ────────
const entry = (path: string, lastModified: string, size = 100): OneLakeEntry => ({ path, isDirectory: false, size, lastModified })

describe('GovernanceStore · proyección de la vigilancia del intake (#161·§3.5)', () => {
  const snapOf = async (g: SqliteGovernanceStore, slotId: string, runsPerSlot?: number) =>
    (await g.listSlotSnapshots(runsPerSlot != null ? { runsPerSlot } : undefined)).find((s) => s.slotId === slotId)

  it('una observación exitosa sella landing, corridas y observed_at (y siembra first_attempt_at)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordSlotObservations([
      {
        slotId: 'saldos',
        observedAt: '2026-08-13T10:00:00Z',
        landing: [entry('Files/intake/saldos/a.xlsx', '2026-08-13T08:00:00Z')],
        runs: [{ startedAt: '2026-08-13T09:00:00Z', status: 'Completed', endedAt: '2026-08-13T09:05:00Z' }],
      },
    ])
    expect(await snapOf(g, 'saldos')).toEqual({
      slotId: 'saldos',
      landing: [entry('Files/intake/saldos/a.xlsx', '2026-08-13T08:00:00Z')],
      runs: [{ startedAt: '2026-08-13T09:00:00Z', endedAt: '2026-08-13T09:05:00Z', status: 'Completed' }],
      observedAt: '2026-08-13T10:00:00Z',
      firstAttemptAt: '2026-08-13T10:00:00Z',
      lastError: null,
      lastErrorAt: null,
    })
    await g.close()
  })

  it('CRITERIO 1 · una observación con ERROR no pisa el snapshot previo: solo escribe last_error', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordSlotObservations([
      {
        slotId: 'saldos',
        observedAt: '2026-08-13T10:00:00Z',
        landing: [entry('Files/intake/saldos/varado.xlsx', '2026-08-10T08:00:00Z')],
        runs: [{ startedAt: '2026-08-13T09:00:00Z', status: 'Failed' }],
      },
    ])
    await g.recordSlotObservations([{ slotId: 'saldos', observedAt: '2026-08-13T10:10:00Z', error: 'listar falló (403)' }])
    const s = (await snapOf(g, 'saldos'))!
    // Lo último conocido intacto: el varado sigue ahí (si se borrara, el vigilante clasificaría sobre
    // la nada y el archivo varado dejaría de alertar justo cuando menos se ve).
    expect(s.landing).toEqual([entry('Files/intake/saldos/varado.xlsx', '2026-08-10T08:00:00Z')])
    expect(s.runs).toEqual([{ startedAt: '2026-08-13T09:00:00Z', status: 'Failed' }])
    // `observed_at` NO avanza: es la última medida BUENA, y de ella cuelga la edad de la proyección.
    expect(s.observedAt).toBe('2026-08-13T10:00:00Z')
    expect(s.lastError).toBe('listar falló (403)')
    expect(s.lastErrorAt).toBe('2026-08-13T10:10:00Z')
    // Una medida buena posterior limpia el error.
    await g.recordSlotObservations([{ slotId: 'saldos', observedAt: '2026-08-13T10:20:00Z', landing: [], runs: [] }])
    const s2 = (await snapOf(g, 'saldos'))!
    expect([s2.lastError, s2.lastErrorAt, s2.observedAt]).toEqual([null, null, '2026-08-13T10:20:00Z'])
    await g.close()
  })

  it('un slot CIEGO desde el primer tick igual tiene first_attempt_at (baseline de sin-medida)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordSlotObservations([{ slotId: 'oc', observedAt: '2026-08-13T10:00:00Z', error: 'timeout' }])
    await g.recordSlotObservations([{ slotId: 'oc', observedAt: '2026-08-13T10:10:00Z', error: 'timeout' }])
    const s = (await snapOf(g, 'oc'))!
    expect(s).toMatchObject({ observedAt: null, firstAttemptAt: '2026-08-13T10:00:00Z', lastErrorAt: '2026-08-13T10:10:00Z' })
    expect(s.landing).toEqual([])
    await g.close()
  })

  it('CRITERIO 2 · upsert + retención del landing: lo que el listado no trae, DRENÓ', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordSlotObservations([
      { slotId: 'saldos', observedAt: '2026-08-13T10:00:00Z', landing: [entry('L/a.xlsx', '2026-08-13T08:00:00Z', 10), entry('L/b.xlsx', '2026-08-13T08:00:00Z')] },
    ])
    await g.recordSlotObservations([
      { slotId: 'saldos', observedAt: '2026-08-13T10:10:00Z', landing: [entry('L/b.xlsx', '2026-08-13T09:30:00Z', 999), entry('L/c.xlsx', '2026-08-13T09:40:00Z')] },
    ])
    const s = (await snapOf(g, 'saldos'))!
    expect(s.landing.map((e) => e.path)).toEqual(['L/b.xlsx', 'L/c.xlsx']) // 'a' drenó y ya no está
    expect(s.landing[0]).toEqual(entry('L/b.xlsx', '2026-08-13T09:30:00Z', 999)) // 'b' actualizado
    await g.close()
  })

  it('en una observación exitosa, landing/runs AUSENTES no vacían la proyección (land-only)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.recordSlotObservations([
      { slotId: 'oc', observedAt: '2026-08-13T10:00:00Z', landing: [entry('L/x.xlsx', '2026-08-13T08:00:00Z')], runs: [{ startedAt: '2026-08-13T09:00:00Z', status: 'Completed' }] },
    ])
    // Slot land-only: se midió el landing, las corridas NI SE MIRARON — no es «no hay corridas».
    await g.recordSlotObservations([{ slotId: 'oc', observedAt: '2026-08-13T10:10:00Z', landing: [entry('L/x.xlsx', '2026-08-13T08:00:00Z')] }])
    expect((await snapOf(g, 'oc'))!.runs).toHaveLength(1)
    await g.close()
  })

  it('poda las corridas del slot a INTAKE_WATCH_RUN_RETENTION y las sirve más reciente primero', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const runs = Array.from({ length: INTAKE_WATCH_RUN_RETENTION + 5 }, (_, i) => ({
      startedAt: `2026-08-${String(1 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`,
      status: 'Completed' as const,
    }))
    await g.recordSlotObservations([{ slotId: 'saldos', observedAt: '2026-08-13T10:00:00Z', runs }])
    expect((await snapOf(g, 'saldos', 1000))!.runs).toHaveLength(INTAKE_WATCH_RUN_RETENTION)
    const top = (await snapOf(g, 'saldos', 3))!.runs
    expect(top).toHaveLength(3)
    expect(top[0]!.startedAt > top[1]!.startedAt).toBe(true)
    await g.close()
  })

  it('la proyección sobrevive al reinicio (es la memoria que el lazo re-hidrata)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-watch-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, {})
    await g1.recordSlotObservations([{ slotId: 'saldos', observedAt: '2026-08-13T10:00:00Z', landing: [entry('L/a.xlsx', '2026-08-13T08:00:00Z')], runs: [] }])
    await g1.close()
    const g2 = await SqliteGovernanceStore.open(file, {})
    expect((await snapOf(g2, 'saldos'))!.landing).toEqual([entry('L/a.xlsx', '2026-08-13T08:00:00Z')])
    await g2.close()
  })
})

describe('GovernanceStore · desenlace por carga (#162·§3.4)', () => {
  it('listUploadsSinDesenlace: pendientes del slot, antiguas primero, sin rechazadas ni retro', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const vieja = await g.recordUpload(upload({ filename: 'vieja.xlsx', uploadedAt: '2026-08-01T10:00:00Z' }))
    const nueva = await g.recordUpload(upload({ filename: 'nueva.xlsx', sha256: SHA_B, uploadedAt: '2026-08-10T10:00:00Z' }))
    await g.recordUpload(upload({ filename: 'rechazada.xlsx', uploadedAt: '2026-08-02T10:00:00Z', ok: false, error: 'vacío' }))
    await g.recordUpload(upload({ filename: 'retro.xlsx', uploadedAt: '2026-08-03T10:00:00Z', origen: 'retro' }))
    await g.recordUpload(upload({ slotId: 'otro', filename: 'ajena.xlsx', uploadedAt: '2026-08-04T10:00:00Z' }))
    expect((await g.listUploadsSinDesenlace('saldos')).map((r) => r.id)).toEqual([vieja, nueva])
    // Resuelta ⇒ sale de la cola (dedup natural del resolver: no se re-notifica lo ya resuelto).
    await g.setUploadDesenlace(vieja, { desenlace: 'procesada', at: '2026-08-13T10:00:00Z' })
    expect((await g.listUploadsSinDesenlace('saldos')).map((r) => r.id)).toEqual([nueva])
    expect(await g.listUploadsSinDesenlace('saldos', 0)).toEqual([])
    await g.close()
  })

  it('setUploadDesenlace persiste desenlace + motivo textual + corrida, y listUploads lo sirve', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-desenlace-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, {})
    const id = await g1.recordUpload(upload())
    await g1.setUploadDesenlace(id, {
      desenlace: 'fallida',
      motivo: 'ancho inesperado: 28 columnas (se esperaban 48)',
      runStartedAt: '2026-07-13T16:20:00Z',
      at: '2026-07-13T16:30:00Z',
    })
    await g1.close()
    const g2 = await SqliteGovernanceStore.open(file, {})
    expect((await g2.listUploads('saldos', 10))[0]).toMatchObject({
      id,
      desenlace: 'fallida',
      desenlaceMotivo: 'ancho inesperado: 28 columnas (se esperaban 48)',
      desenlaceRunStartedAt: '2026-07-13T16:20:00Z',
      desenlaceAt: '2026-07-13T16:30:00Z',
    })
    await g2.close()
  })

  it('CRITERIO 3 · un desenlace NO se sobrescribe: la segunda escritura lanza y el motivo original queda', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const id = await g.recordUpload(upload())
    await g.setUploadDesenlace(id, { desenlace: 'sin-informe' })
    await expect(g.setUploadDesenlace(id, { desenlace: 'procesada', motivo: 'otro' })).rejects.toBeInstanceOf(GovernanceConflict)
    expect((await g.listUploads('saldos', 10))[0]).toMatchObject({ desenlace: 'sin-informe' })
    expect((await g.listUploads('saldos', 10))[0]!.desenlaceMotivo).toBeUndefined()
    await expect(g.setUploadDesenlace(9999, { desenlace: 'procesada' })).rejects.toThrow(/No existe la carga/)
    await g.close()
  })

  it('CRITERIO 4 · una db PRE-EXISTENTE sin las columnas nuevas migra sin pérdida de datos', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-migra-')), 'governance.sqlite')
    // Se construye a mano el esquema VIEJO (el de #62, sin las columnas de desenlace) con datos.
    const vieja = await openSqliteDb(file)
    vieja.run(`CREATE TABLE intake_upload (
      id INTEGER PRIMARY KEY, slot_id TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL, uploaded_by TEXT, uploaded_at TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 1,
      error TEXT, triggered INTEGER NOT NULL DEFAULT 0, origen TEXT NOT NULL DEFAULT 'upload', dup_of INTEGER
    );`)
    vieja.run(
      `INSERT INTO intake_upload (id, slot_id, filename, sha256, bytes, uploaded_by, uploaded_at, ok, error, triggered, origen, dup_of)
       VALUES (1,'saldos','historica.xlsx',?,110760,'claudio@x.cl','2026-07-13T16:17:42Z',1,NULL,1,'upload',NULL)`,
      [SHA_A],
    )
    expect(selectAll(vieja, `PRAGMA table_info(intake_upload)`).map((c) => String(c['name']))).not.toContain('desenlace')
    persistSqliteDb(vieja, file)
    vieja.close()
    // Abrir el store migra: la fila histórica sigue entera y ya acepta desenlace.
    const g = await SqliteGovernanceStore.open(file, {})
    const filas = await g.listUploads('saldos', 10)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      id: 1, slotId: 'saldos', filename: 'historica.xlsx', sha256: SHA_A, bytes: 110760,
      uploadedBy: 'claudio@x.cl', uploadedAt: '2026-07-13T16:17:42Z', ok: true, triggered: true, origen: 'upload',
    })
    expect(filas[0]!.desenlace).toBeUndefined() // NULL = pendiente, que es la verdad de una fila pre-#161
    expect((await g.listUploadsSinDesenlace('saldos')).map((r) => r.id)).toEqual([1])
    await g.setUploadDesenlace(1, { desenlace: 'varada' })
    expect((await g.listUploads('saldos', 10))[0]).toMatchObject({ desenlace: 'varada' })
    // Y es idempotente: reabrir no vuelve a migrar ni pierde lo escrito.
    await g.close()
    const g2 = await SqliteGovernanceStore.open(file, {})
    expect((await g2.listUploads('saldos', 10))[0]).toMatchObject({ filename: 'historica.xlsx', desenlace: 'varada' })
    await g2.close()
  })
})
