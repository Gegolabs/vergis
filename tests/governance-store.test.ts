import { describe, it, expect } from 'vitest'
import { SqliteGovernanceStore, GovernanceConflict, AdminLockout } from '@vergis/capabilities'

describe('GovernanceStore · admins (consolidado)', () => {
  it('implementa AdminStore: semilla, alta, anti-lockout', async () => {
    const g = await SqliteGovernanceStore.open(null, { admins: ['Admin@ua.test'] })
    expect(await g.isAdmin('admin@ua.test')).toBe(true)
    expect(await g.add('especificador@consultora.test', 'admin@ua.test')).toBe(true)
    await expect(g.remove('admin@ua.test')).rejects.toBeInstanceOf(AdminLockout) // semilla
    await g.close()
  })
})

describe('GovernanceStore · grupos de Mira', () => {
  it('siembra grupo con miembros y resuelve membresía', async () => {
    const g = await SqliteGovernanceStore.open(null, {
      groups: [{ id: 'analistas_roble', label: 'Analistas ROBLE', members: ['ana@consultora.test', 'Beto@consultora.test'] }],
    })
    const groups = await g.listGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: 'analistas_roble', label: 'Analistas ROBLE', seed: true })
    expect(await g.isMember('analistas_roble', 'beto@consultora.test')).toBe(true) // normalizado
    expect(await g.groupsOf('ana@consultora.test')).toEqual(['analistas_roble'])
    await g.close()
  })

  it('crea grupo, agrega/quita miembros, idempotente', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.createGroup('finanzas_cli', 'Finanzas CLI')
    expect(await g.addMember('finanzas_cli', 'felipe@ga.test')).toBe(true)
    expect(await g.addMember('finanzas_cli', 'felipe@ga.test')).toBe(false) // idempotente
    expect((await g.listMembers('finanzas_cli')).map((m) => m.email)).toEqual(['felipe@ga.test'])
    await g.removeMember('finanzas_cli', 'felipe@ga.test')
    expect(await g.listMembers('finanzas_cli')).toHaveLength(0)
    await g.close()
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
