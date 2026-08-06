import { describe, it, expect } from 'vitest'
import { parseGroupsConfig, parsePiOwnersConfig, parseSourcesConfig } from '@vergis/capabilities'

const SOURCE = { id: 'sap', label: 'SAP', oferta: 'P1D' }

describe('governance-config · clave raíz ausente vs «declara cero» (#117)', () => {
  it('groups: ausente lanza, [] pasa, nulo es error de tipo', () => {
    for (const doc of [{}, null, undefined, { otra: 1 }, 'chatarra']) {
      expect(() => parseGroupsConfig(doc)).toThrow(/falta la clave raíz 'groups'/)
    }
    expect(() => parseGroupsConfig({})).toThrow(/usa 'groups: \[\]'/)
    expect(parseGroupsConfig({ groups: [] })).toEqual([])
    expect(() => parseGroupsConfig({ groups: null })).toThrow(/debe ser una lista/)
  })

  it('owners: ausente lanza sugiriendo {}, mapa vacío pasa, nulo es error de tipo', () => {
    for (const doc of [{}, null, undefined, { otra: 1 }]) {
      expect(() => parsePiOwnersConfig(doc)).toThrow(/falta la clave raíz 'owners'/)
    }
    expect(() => parsePiOwnersConfig({})).toThrow(/usa 'owners: \{\}'/)
    expect(parsePiOwnersConfig({ owners: {} })).toEqual({})
    expect(() => parsePiOwnersConfig({ owners: null })).toThrow(/debe ser un mapa/)
    expect(() => parsePiOwnersConfig({ owners: [] })).toThrow(/debe ser un mapa/)
  })

  it('sources: ausente lanza, [] pasa, nulo es error de tipo', () => {
    for (const doc of [{}, null, undefined, { tableSources: [] }]) {
      expect(() => parseSourcesConfig(doc)).toThrow(/falta la clave raíz 'sources'/)
    }
    expect(() => parseSourcesConfig({})).toThrow(/usa 'sources: \[\]'/)
    expect(parseSourcesConfig({ sources: [] })).toEqual({ sources: [] })
    expect(() => parseSourcesConfig({ sources: null })).toThrow(/debe ser una lista/)
  })
})

describe('governance-config · forma de los items', () => {
  it('parsea grupos con label default = id y members', () => {
    const gs = parseGroupsConfig({ groups: [{ id: 'analistas', members: ['Ana@GH.cl'] }, { id: 'jefes', label: 'Jefaturas' }] })
    expect(gs).toEqual([
      { id: 'analistas', label: 'analistas', members: ['Ana@GH.cl'] },
      { id: 'jefes', label: 'Jefaturas' },
    ])
  })

  it('grupo con id fuera de slug, no-string o duplicado lanza', () => {
    expect(() => parseGroupsConfig({ groups: [{ id: 'Mal Id' }] })).toThrow(/id inválido/)
    expect(() => parseGroupsConfig({ groups: [{ id: 7 }] })).toThrow(/'id' debe ser un string/)
    expect(() => parseGroupsConfig({ groups: [{ id: 'x' }, { id: 'X' }] })).toThrow(/duplicado/)
    expect(() => parseGroupsConfig({ groups: [{ id: 'x', members: 'ana@gh.cl' }] })).toThrow(/members debe ser una lista/)
  })

  it('owner con valor no-string lanza nombrando el PI', () => {
    expect(parsePiOwnersConfig({ owners: { 'pi-1': 'ana@gh.cl' } })).toEqual({ 'pi-1': 'ana@gh.cl' })
    expect(() => parsePiOwnersConfig({ owners: { 'pi-1': 42 } })).toThrow(/'pi-1'/)
    expect(() => parsePiOwnersConfig({ owners: { 'pi-1': '' } })).toThrow(/'pi-1'/)
  })

  it('claves secundarias de sources: ausentes pasan, presentes-vacías pasan', () => {
    expect(parseSourcesConfig({ sources: [SOURCE] })).toEqual({ sources: [SOURCE] })
    expect(parseSourcesConfig({ sources: [SOURCE], tableSources: [], processes: [], processOutputs: [] })).toEqual({
      sources: [SOURCE],
      tableSources: [],
      processes: [],
      processOutputs: [],
    })
  })

  it('parsea el registro completo, con engine', () => {
    const cfg = parseSourcesConfig({
      sources: [{ ...SOURCE, domain: 'cartera', connectedBy: 'ana@gh.cl' }],
      tableSources: [{ tableRef: 'qw04.areas', sourceId: 'sap' }],
      processes: [{ id: 'p1', label: 'P1', sourceId: 'sap', engine: { workspaceId: 'w', itemId: 'i', jobType: 'Pipeline' } }],
      processOutputs: [{ processId: 'p1', tableRef: 'qw04.areas' }],
    })
    expect(cfg.processes?.[0].engine).toEqual({ workspaceId: 'w', itemId: 'i', jobType: 'Pipeline' })
    expect(cfg.sources[0].domain).toBe('cartera')
  })

  it('item de sources sin campo obligatorio lanza nombrándolo', () => {
    expect(() => parseSourcesConfig({ sources: [{ id: 'sap', label: 'SAP' }] })).toThrow(/'oferta'/)
    expect(() => parseSourcesConfig({ sources: [{ label: 'SAP', oferta: 'P1D' }] })).toThrow(/'id'/)
    expect(() => parseSourcesConfig({ sources: [SOURCE, SOURCE] })).toThrow(/duplicado/)
    expect(() => parseSourcesConfig({ sources: [SOURCE], tableSources: [{ tableRef: 't' }] })).toThrow(/'sourceId'/)
    expect(() => parseSourcesConfig({ sources: [SOURCE], processes: [{ id: 'p', label: 'P' }] })).toThrow(/'sourceId'/)
    expect(() =>
      parseSourcesConfig({ sources: [SOURCE], processes: [{ id: 'p', label: 'P', sourceId: 's', engine: { workspaceId: 'w' } }] }),
    ).toThrow(/'itemId'/)
    expect(() => parseSourcesConfig({ sources: [SOURCE], processOutputs: [{ tableRef: 't' }] })).toThrow(/'processId'/)
  })
})
