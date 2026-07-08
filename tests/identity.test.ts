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
