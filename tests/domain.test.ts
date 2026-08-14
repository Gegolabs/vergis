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

// #183 · `stewards:` admite GRUPOS de Mira además de correos. La entrada declara qué es (`group:<id>`);
// nada se infiere de la forma del texto. La membresía la resuelve el llamador POR REQUEST y la pasa
// como `groups` — este módulo decide autorización y no habla con el store.
describe('domain · stewards por grupo (#183)', () => {
  const mixto = () =>
    parseDomainsConfig({
      domains: [{ id: 'cartera', label: 'C', stewards: ['group:Finanzas_GH', 'Ana@GH.cl'] }],
    })[0]

  it('parsea correo y grupo mezclados en la misma lista, normalizados', () => {
    expect(mixto().stewards).toEqual(['group:finanzas_gh', 'ana@gh.cl'])
  })

  it('el dominio es gestionable por los miembros del grupo Y por el correo declarado', () => {
    const d = mixto()
    expect(canManageDomain(d, 'felipe@gh.cl', false, ['finanzas_gh'])).toBe(true) // por grupo
    expect(canManageDomain(d, 'ana@gh.cl', false, [])).toBe(true) // por correo, sin grupos
    expect(canManageDomain(d, 'ajeno@x.cl', false, ['otro_grupo'])).toBe(false)
  })

  it('la membresía manda en el momento: cambiarla cambia el acceso sin tocar el YAML', () => {
    // El mismo dominio parseado UNA vez: lo único que cambia entre las dos llamadas es lo que el
    // store respondió en ese request. Es el criterio «alta/baja en /admin/grupos surte efecto ya».
    const d = mixto()
    expect(canManageDomain(d, 'felipe@gh.cl', false, ['finanzas_gh'])).toBe(true)
    expect(canManageDomain(d, 'felipe@gh.cl', false, [])).toBe(false)
  })

  it('fail-closed: grupo inexistente o vacío ⇒ nadie (una lista que no resuelve NO abre el dominio)', () => {
    const d = parseDomainsConfig({ domains: [{ id: 'x', label: 'X', stewards: ['group:no_existe'] }] })[0]
    // Un grupo inexistente y uno existente-pero-vacío son indistinguibles acá, y a propósito: los dos
    // producen «esta identidad no pertenece», que es la respuesta correcta para ambos.
    expect(canManageDomain(d, 'quien@sea.cl', false, [])).toBe(false)
    expect(canManageDomain(d, 'quien@sea.cl', false, ['otro'])).toBe(false)
    expect(manageableDomains([d], 'quien@sea.cl', false, [])).toEqual([])
  })

  it('un grupo inexistente NO tumba el parseo: los demás dominios siguen vivos', () => {
    const ds = parseDomainsConfig({
      domains: [
        { id: 'a', label: 'A', stewards: ['group:fantasma'] },
        { id: 'b', label: 'B', stewards: ['ana@gh.cl'] },
      ],
    })
    expect(ds.map((d) => d.id)).toEqual(['a', 'b'])
    expect(canManageDomain(ds[1], 'ana@gh.cl', false)).toBe(true)
  })

  it('sin `groups` (llamador que no los resolvió) el acceso por grupo se niega, no se asume', () => {
    expect(canManageDomain(mixto(), 'felipe@gh.cl', false)).toBe(false)
  })

  it('una entrada ambigua se rechaza AL PARSEAR, con mensaje que nombra las dos formas válidas', () => {
    expect(() => parseDomainsConfig({ domains: [{ id: 'x', label: 'X', stewards: ['finanzas_gh'] }] })).toThrow(
      /entrada inválida 'finanzas_gh'.*correo.*group:/s,
    )
    expect(() => parseDomainsConfig({ domains: [{ id: 'x', label: 'X', stewards: ['no-es-correo'] }] })).toThrow(/entrada inválida/)
    expect(() => parseDomainsConfig({ domains: [{ id: 'x', label: 'X', stewards: ['group:Mal Id'] }] })).toThrow(/grupo con id inválido/)
    expect(() => parseDomainsConfig({ domains: [{ id: 'x', label: 'X', stewards: ['group:'] }] })).toThrow(/grupo con id inválido/)
  })

  it('un correo que CONTIENE el prefijo no se confunde con un grupo (el prefijo es de inicio)', () => {
    const d = parseDomainsConfig({ domains: [{ id: 'x', label: 'X', stewards: ['ana+group:x@gh.cl'] }] })[0]
    expect(canManageDomain(d, 'ana+group:x@gh.cl', false)).toBe(true)
  })
})
