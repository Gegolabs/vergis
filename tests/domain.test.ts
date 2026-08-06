import { describe, it, expect } from 'vitest'
import { parseDomainsConfig, canManageDomain, manageableDomains } from '@vergis/capabilities'

describe('domain · contrato y autorización', () => {
  it('parsea dominios y normaliza stewards a minúsculas', () => {
    const ds = parseDomainsConfig({
      domains: [
        { id: 'cartera', label: 'Cartera / Finanzas', stewards: ['Ana@ga.test', 'beto@ga.test'] },
        { id: 'personas', label: 'Personas' },
      ],
    })
    expect(ds).toHaveLength(2)
    expect(ds[0].stewards).toEqual(['ana@ga.test', 'beto@ga.test'])
    expect(ds[1].stewards).toBeUndefined()
  })

  it('«declara cero» es legítimo: domains: [] → []', () => {
    expect(parseDomainsConfig({ domains: [] })).toEqual([])
  })

  it('clave raíz ausente → lanza nombrando la clave (#117)', () => {
    for (const doc of [{}, null, undefined, { otra: 1 }, 'chatarra', []]) {
      expect(() => parseDomainsConfig(doc)).toThrow(/falta la clave raíz 'domains'/)
    }
    expect(() => parseDomainsConfig({})).toThrow(/usa 'domains: \[\]'/)
  })

  it('domains: nulo sigue siendo error de tipo', () => {
    expect(() => parseDomainsConfig({ domains: null })).toThrow(/debe ser una lista/)
  })

  it('rechaza id inválido y duplicado', () => {
    expect(() => parseDomainsConfig({ domains: [{ id: 'Mal Id' }] })).toThrow(/id inválido/)
    expect(() => parseDomainsConfig({ domains: [{ id: 'x' }, { id: 'x' }] })).toThrow(/duplicado/)
  })

  it('canManageDomain: admin override · steward · ajeno', () => {
    const d = { id: 'cartera', label: 'C', stewards: ['ana@ga.test'] }
    expect(canManageDomain(d, 'cualquiera@x.com', true)).toBe(true) // admin
    expect(canManageDomain(d, 'ANA@ga.test', false)).toBe(true) // steward (case-insensitive)
    expect(canManageDomain(d, 'otro@x.com', false)).toBe(false)
    expect(canManageDomain(d, '', false)).toBe(false)
    expect(canManageDomain({ id: 'p', label: 'P' }, 'x@x.com', false)).toBe(false) // sin stewards
  })

  it('manageableDomains: admin ve todos; steward solo los suyos', () => {
    const ds = parseDomainsConfig({
      domains: [
        { id: 'cartera', label: 'C', stewards: ['ana@ga.test'] },
        { id: 'personas', label: 'P', stewards: ['rrhh@ga.test'] },
      ],
    })
    expect(manageableDomains(ds, 'x@x.com', true).map((d) => d.id)).toEqual(['cartera', 'personas'])
    expect(manageableDomains(ds, 'ana@ga.test', false).map((d) => d.id)).toEqual(['cartera'])
    expect(manageableDomains(ds, 'nadie@x.com', false)).toEqual([])
  })
})
