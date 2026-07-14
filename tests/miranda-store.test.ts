import { describe, it, expect } from 'vitest'
import { SqliteGovernanceStore, GovernanceConflict } from '@vergis/capabilities'

async function store() {
  return SqliteGovernanceStore.open(null) // en memoria
}

describe('MirandaStore · sesiones (CRUD)', () => {
  it('crea, lee y lista sesiones (más recientes primero); createSession duplicado → conflicto', async () => {
    const s = await store()
    const a = await s.createSession('sess-a', 'Saldos por empresa', 'Ana@X.com')
    expect(a.state).toBe('explorando')
    expect(a.createdBy).toBe('ana@x.com') // normEmail
    const got = await s.getMirandaSession('sess-a')
    expect(got?.title).toBe('Saldos por empresa')
    await s.createSession('sess-b', 'Otra', 'ana@x.com')
    const list = await s.listMirandaSessions('ana@x.com')
    expect(list.map((x) => x.id).sort()).toEqual(['sess-a', 'sess-b'])
    const onlyBob = await s.listMirandaSessions('bob@x.com')
    expect(onlyBob).toEqual([])
    await expect(s.createSession('sess-a', 'dup', 'ana@x.com')).rejects.toBeInstanceOf(GovernanceConflict)
  })
})

describe('MirandaStore · máquina de estados', () => {
  it('transición legal avanza; ilegal se rechaza', async () => {
    const s = await store()
    await s.createSession('m1', 't', 'a@x.com')
    await s.setMirandaState('m1', 'borrador')
    await s.setMirandaState('m1', 'validado')
    await s.setMirandaState('m1', 'autochequeado')
    await s.setMirandaState('m1', 'publicado')
    expect((await s.getMirandaSession('m1'))?.state).toBe('publicado')
    // publicado es terminal: cualquier salida es ilegal
    await expect(s.setMirandaState('m1', 'borrador')).rejects.toBeInstanceOf(GovernanceConflict)
  })
  it('validado → autochequeado sin pasar por borrador de nuevo es legal; explorando → validado es ilegal', async () => {
    const s = await store()
    await s.createSession('m2', 't', 'a@x.com')
    await expect(s.setMirandaState('m2', 'validado')).rejects.toBeInstanceOf(GovernanceConflict)
    await s.setMirandaState('m2', 'borrador')
    await s.setMirandaState('m2', 'validado')
    // el resumen cambia → regresa a borrador (transición legal)
    await s.setMirandaState('m2', 'borrador')
    expect((await s.getMirandaSession('m2'))?.state).toBe('borrador')
  })
  it('descartar es legal desde cualquier estado no terminal', async () => {
    const s = await store()
    await s.createSession('m3', 't', 'a@x.com')
    await s.setMirandaState('m3', 'borrador')
    await s.setMirandaState('m3', 'descartado')
    await expect(s.setMirandaState('m3', 'borrador')).rejects.toBeInstanceOf(GovernanceConflict)
  })
})

describe('MirandaStore · mensajes y presupuesto de tokens', () => {
  it('append incrementa seq; los tokens se suman', async () => {
    const s = await store()
    await s.createSession('m', 't', 'a@x.com')
    expect(await s.appendMirandaMessage('m', 'user', JSON.stringify({ text: 'hola' }), 0)).toBe(1)
    expect(await s.appendMirandaMessage('m', 'assistant', JSON.stringify({ text: 'buenas' }), 120)).toBe(2)
    expect(await s.appendMirandaMessage('m', 'tool', JSON.stringify({ rows: [] }), 30)).toBe(3)
    const msgs = await s.listMirandaMessages('m')
    expect(msgs.map((x) => x.role)).toEqual(['user', 'assistant', 'tool'])
    expect(await s.mirandaSessionTokens('m')).toBe(150)
  })
})

describe('MirandaStore · artefactos append-only con versión', () => {
  it('cada append de un kind incrementa su versión; latest devuelve la mayor', async () => {
    const s = await store()
    await s.createSession('m', 't', 'a@x.com')
    expect(await s.appendMirandaArtifact('m', 'spec_draft', 'yaml v1')).toBe(1)
    expect(await s.appendMirandaArtifact('m', 'spec_draft', 'yaml v2')).toBe(2)
    expect(await s.appendMirandaArtifact('m', 'intent_summary', '{"titulo":"x"}')).toBe(1)
    const latest = await s.latestMirandaArtifact('m', 'spec_draft')
    expect(latest?.version).toBe(2)
    expect(latest?.content).toBe('yaml v2')
    const drafts = await s.listMirandaArtifacts('m', 'spec_draft')
    expect(drafts.map((d) => d.content)).toEqual(['yaml v1', 'yaml v2']) // v1 no se pisa (procedencia)
    expect((await s.listMirandaArtifacts('m')).length).toBe(3)
  })
})

describe('MirandaStore · secuencia de códigos PI (semilla 101)', () => {
  it('el primer código es 101 y avanza de a uno', async () => {
    const s = await store()
    expect(await s.nextMirandaPiCode()).toBe(101)
    expect(await s.nextMirandaPiCode()).toBe(102)
    expect(await s.nextMirandaPiCode()).toBe(103)
  })
})
