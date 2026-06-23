import { describe, it, expect } from 'vitest'
import { parseDomainsConfig, canManageDomain, manageableDomains } from '@vergis/capabilities'

describe('domain · contrato y autorización', () => {
  it('parsea dominios y normaliza stewards a minúsculas', () => {
    const ds = parseDomainsConfig({
      domains: [
        { id: 'cartera', label: 'Cartera / Finanzas', stewards: ['Ana@GH.cl', 'beto@gh.cl'] },
        { id: 'personas', label: 'Personas' },
      ],
    })
    expect(ds).toHaveLength(2)
    expect(ds[0].stewards).toEqual(['ana@gh.cl', 'beto@gh.cl'])
    expect(ds[1].stewards).toBeUndefined()
  })

  it('lista vacía / ausente → []', () => {
    expect(parseDomainsConfig({})).toEqual([])
    expect(parseDomainsConfig(undefined)).toEqual([])
  })

  it('rechaza id inválido y duplicado', () => {
    expect(() => parseDomainsConfig({ domains: [{ id: 'Mal Id' }] })).toThrow(/id inválido/)
    expect(() => parseDomainsConfig({ domains: [{ id: 'x' }, { id: 'x' }] })).toThrow(/duplicado/)
  })

  it('canManageDomain: admin override · steward · ajeno', () => {
    const d = { id: 'cartera', label: 'C', stewards: ['ana@gh.cl'] }
    expect(canManageDomain(d, 'cualquiera@x.com', true)).toBe(true) // admin
    expect(canManageDomain(d, 'ANA@gh.cl', false)).toBe(true) // steward (case-insensitive)
    expect(canManageDomain(d, 'otro@x.com', false)).toBe(false)
    expect(canManageDomain(d, '', false)).toBe(false)
    expect(canManageDomain({ id: 'p', label: 'P' }, 'x@x.com', false)).toBe(false) // sin stewards
  })

  it('manageableDomains: admin ve todos; steward solo los suyos', () => {
    const ds = parseDomainsConfig({
      domains: [
        { id: 'cartera', label: 'C', stewards: ['ana@gh.cl'] },
        { id: 'personas', label: 'P', stewards: ['rrhh@gh.cl'] },
      ],
    })
    expect(manageableDomains(ds, 'x@x.com', true).map((d) => d.id)).toEqual(['cartera', 'personas'])
    expect(manageableDomains(ds, 'ana@gh.cl', false).map((d) => d.id)).toEqual(['cartera'])
    expect(manageableDomains(ds, 'nadie@x.com', false)).toEqual([])
  })
})
