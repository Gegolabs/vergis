import { describe, it, expect } from 'vitest'
import { createIdentity } from '../server/identity'

const CLAIMS = { groups: 'x-forwarded-groups' }

describe('createIdentity · cabeceras del gate → identidad + claims', () => {
  it('mapea el claim configurado desde su cabecera', () => {
    // Valores ASCII: el resolver hace decodeUtf8 (latin1→utf8, correcto para cabeceras reales de
    // Node); pasar un UTF-8 limpio con acento acá lo manglaría — ese camino no es el de este test.
    const { identityFor } = createIdentity(CLAIMS, null)
    const id = identityFor({ 'x-forwarded-email': 'ana@x.com', 'x-forwarded-groups': 'Ventas,Finanzas' })
    expect(id.user).toBe('ana@x.com')
    expect(id.claims).toEqual({ groups: ['Ventas', 'Finanzas'] })
  })

  it('sin cabeceras de claim → identidad sin claims (default-deny aguas abajo)', () => {
    const { identityFor } = createIdentity(CLAIMS, null)
    const id = identityFor({ 'x-forwarded-email': 'ana@x.com' })
    expect(id.user).toBe('ana@x.com')
    expect(id.claims).toBeUndefined()
  })
})

describe('createIdentity · enriquecimiento desde el directorio (IdentityMap)', () => {
  const MAP = { 'ana@x.com': { viewer_area: 'Producción' }, 'beto@x.com': { viewer_area: ['A', 'B'] } }

  it('email mapeado → agrega el claim del directorio (normalizado a arreglo)', () => {
    const { identityFor } = createIdentity(CLAIMS, MAP)
    const id = identityFor({ 'x-forwarded-email': 'ANA@x.com', 'x-forwarded-groups': 'g1' })
    expect(id.claims).toEqual({ groups: ['g1'], viewer_area: ['Producción'] })
  })

  it('valor de claim multi-valor del directorio se preserva como arreglo', () => {
    const { identityFor } = createIdentity(CLAIMS, MAP)
    const id = identityFor({ 'x-forwarded-email': 'beto@x.com' })
    expect(id.claims).toEqual({ viewer_area: ['A', 'B'] })
  })

  it('fail-closed: email NO mapeado → sin claim del directorio', () => {
    const { identityFor } = createIdentity(CLAIMS, MAP)
    const id = identityFor({ 'x-forwarded-email': 'ajeno@x.com' })
    expect(id.claims).toBeUndefined()
  })
})

describe('createIdentity · dev identity inyectable (los tres caminos)', () => {
  const DEV = { user: 'cesar@x.com', claims: { groups: ['miranda'] } }

  it('sin header de gate + dev activa → inyecta la identidad de dev', () => {
    const { identityFor } = createIdentity(CLAIMS, null, DEV)
    const id = identityFor({}) // browser local: sin headers de gate
    expect(id.user).toBe('cesar@x.com')
    expect(id.claims).toEqual({ groups: ['miranda'] })
  })

  it('CON header de gate + dev activa → el header MANDA (dev se ignora)', () => {
    const { identityFor } = createIdentity(CLAIMS, null, DEV)
    const id = identityFor({ 'x-forwarded-email': 'otra@x.com', 'x-forwarded-groups': 'ventas' })
    expect(id.user).toBe('otra@x.com')
    expect(id.claims).toEqual({ groups: ['ventas'] })
  })

  it('header de gate presente aunque solo traiga groups → NO se inyecta dev (el header manda)', () => {
    const { identityFor } = createIdentity(CLAIMS, null, DEV)
    const id = identityFor({ 'x-forwarded-groups': 'ventas' })
    expect(id.user).toBeUndefined()
    expect(id.claims).toEqual({ groups: ['ventas'] })
  })

  it('sin dev identity + sin header → identidad vacía (403 preservado, comportamiento de hoy)', () => {
    const { identityFor } = createIdentity(CLAIMS, null)
    const id = identityFor({})
    expect(id.user).toBeUndefined()
    expect(id.claims).toBeUndefined()
  })

  it('dev identity solo-email (sin grupos) → user sin claims', () => {
    const { identityFor } = createIdentity(CLAIMS, null, { user: 'solo@x.com', claims: {} })
    const id = identityFor({})
    expect(id.user).toBe('solo@x.com')
    expect(id.claims).toBeUndefined()
  })

  it('dev identity + IdentityMap → la inyectada también se enriquece por el directorio', () => {
    const MAP = { 'cesar@x.com': { viewer_area: 'Producción' } }
    const { identityFor } = createIdentity(CLAIMS, MAP, DEV)
    const id = identityFor({})
    expect(id.user).toBe('cesar@x.com')
    expect(id.claims).toEqual({ groups: ['miranda'], viewer_area: ['Producción'] })
  })
})
