import { describe, it, expect } from 'vitest'
import {
  effectiveRole,
  canOpen,
  canCollaborate,
  canGovern,
  SqliteGovernanceStore,
  GovernanceConflict,
  type PiGrant,
} from '@vergis/capabilities'

describe('pi-authz · effectiveRole (composición visibilidad + grants)', () => {
  const grants: PiGrant[] = [
    { principalType: 'user', principal: 'dueño@ga.test', role: 'owner' },
    { principalType: 'group', principal: 'analistas_roble', role: 'collaborator' },
    { principalType: 'user', principal: 'visor@ga.test', role: 'viewer' },
  ]

  it('privado: sin grant → sin acceso', () => {
    expect(effectiveRole({ visibility: 'privado', grants, email: 'ajeno@ga.test', groups: [] })).toBeNull()
  })
  it('privado: dueño por user', () => {
    expect(effectiveRole({ visibility: 'privado', grants, email: 'dueño@ga.test', groups: [] })).toBe('owner')
  })
  it('colaborador por grupo de Mira', () => {
    expect(effectiveRole({ visibility: 'privado', grants, email: 'ana@consultora.test', groups: ['analistas_roble'] })).toBe('collaborator')
  })
  it('público: cualquiera autenticado es al menos visor', () => {
    expect(effectiveRole({ visibility: 'publico', grants, email: 'cualquiera@ga.test', groups: [] })).toBe('viewer')
  })
  it('toma el rol MÁS ALTO entre piso público y grants', () => {
    expect(effectiveRole({ visibility: 'publico', grants, email: 'dueño@ga.test', groups: ['analistas_roble'] })).toBe('owner')
  })
  it('PI no bootstrapeado (visibility null) → null', () => {
    expect(effectiveRole({ visibility: null, grants: [], email: 'x@y.com', groups: [] })).toBeNull()
  })
  it('sin identidad → null', () => {
    expect(effectiveRole({ visibility: 'publico', grants, email: undefined, groups: [] })).toBeNull()
  })

  it('capacidades por rol', () => {
    expect([canOpen('viewer'), canCollaborate('viewer'), canGovern('viewer')]).toEqual([true, false, false])
    expect([canOpen('collaborator'), canCollaborate('collaborator'), canGovern('collaborator')]).toEqual([true, true, false])
    expect([canOpen('owner'), canCollaborate('owner'), canGovern('owner')]).toEqual([true, true, true])
    expect([canOpen(null), canCollaborate(null), canGovern(null)]).toEqual([false, false, false])
  })
})

describe('GovernanceStore · gobierno de PI (bootstrap, ACL, demanda)', () => {
  it('bootstrap idempotente: dueño inicial + colaborador-default, visibilidad privada', async () => {
    const g = await SqliteGovernanceStore.open(null, { groups: [{ id: 'analistas_roble', label: 'Analistas ROBLE', members: ['ana@consultora.test'] }] })
    await g.bootstrapPi('PI-01', 'felipe@ga.test', ['analistas_roble'])
    await g.bootstrapPi('PI-01', 'otro@ga.test', []) // idempotente: no pisa
    const gov = await g.getPiGovernance('PI-01')
    expect(gov).toMatchObject({ piCode: 'PI-01', visibility: 'privado' })
    // dueño abre y gobierna
    expect(await g.roleFor('PI-01', 'felipe@ga.test')).toBe('owner')
    // miembro del grupo default → colaborador
    expect(await g.roleFor('PI-01', 'ana@consultora.test')).toBe('collaborator')
    // ajeno → sin acceso (privado)
    expect(await g.roleFor('PI-01', 'ajeno@ga.test')).toBeNull()
    await g.close()
  })

  it('cambiar a público abre a cualquiera como visor; sigue dueño', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.bootstrapPi('PI-07', 'dueño@ga.test')
    expect(await g.roleFor('PI-07', 'ajeno@ga.test')).toBeNull()
    await g.setVisibility('PI-07', 'publico')
    expect(await g.roleFor('PI-07', 'ajeno@ga.test')).toBe('viewer')
    expect(await g.roleFor('PI-07', 'dueño@ga.test')).toBe('owner')
    await g.close()
  })

  it('setGrant/removeGrant + anti-lockout del último dueño', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.bootstrapPi('PI-04', 'd1@ga.test')
    await g.setGrant('PI-04', 'user', 'visor@ga.test', 'viewer', 'd1@ga.test')
    expect(await g.roleFor('PI-04', 'visor@ga.test')).toBe('viewer')
    // no se puede quitar el último dueño
    await expect(g.removeGrant('PI-04', 'user', 'd1@ga.test')).rejects.toBeInstanceOf(GovernanceConflict)
    // con un segundo dueño, sí
    await g.setGrant('PI-04', 'user', 'd2@ga.test', 'owner', 'd1@ga.test')
    await g.removeGrant('PI-04', 'user', 'd1@ga.test')
    expect(await g.roleFor('PI-04', 'd1@ga.test')).toBeNull()
    expect(await g.roleFor('PI-04', 'd2@ga.test')).toBe('owner')
    await g.close()
  })

  it('demanda: valida duración ISO-8601 y persiste', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.bootstrapPi('PI-01', 'd@ga.test')
    await g.setDemanda('PI-01', 'PT1H', 'd@ga.test')
    expect((await g.getDemanda('PI-01'))?.maxAge).toBe('PT1H')
    await g.setDemanda('PI-01', 'p1w', 'd@ga.test') // normaliza mayúsculas
    expect((await g.getDemanda('PI-01'))?.maxAge).toBe('P1W')
    await expect(g.setDemanda('PI-01', '1 hora')).rejects.toThrow(/ISO-8601/)
    await g.close()
  })
})
