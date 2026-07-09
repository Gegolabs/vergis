import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SqliteGovernanceStore, GovernanceConflict, AdminLockout } from '@vergis/capabilities'

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
