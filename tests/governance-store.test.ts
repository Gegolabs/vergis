import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SqliteGovernanceStore, GovernanceConflict, AdminLockout, type IntakeUploadRow } from '@vergis/capabilities'

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
