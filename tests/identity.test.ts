import { describe, it, expect } from 'vitest'
import { createIdentity, clavesNoNormalizadas, IdentityProjection, type IdentityClaimsSource } from '../server/identity'
import { SqliteGovernanceStore } from '../packages/capabilities/src/governance-store'

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

/**
 * El resolver contra el STORE DE GOBIERNO (issue #159, hito 2).
 *
 * Lo que vigilan estos casos no es el lookup: es que el trust-base pueda MOVERSE sin reiniciar y que
 * el resolver siga siendo síncrono mientras el store es asíncrono — las dos cosas que el issue pide y
 * que un `await` por request habría roto.
 */
describe('createIdentity · proyección del mapa del store de gobierno (#159)', () => {
  it('enriquece desde el store, con el email normalizado en la entrada y en la búsqueda', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    // Entrada guardada con mayúsculas: el store la normaliza, así que el claim SÍ aplica.
    await g.upsertIdentityClaims('Ana.Perez@GH.CL', { claims: { viewer_area: 'Producción' }, origin: 'autoritativa' })
    const proj = new IdentityProjection()
    expect((await proj.refresh(g)).ok).toBe(true)

    const { identityFor } = createIdentity(CLAIMS, proj)
    const id = identityFor({ 'x-forwarded-email': 'ANA.perez@gh.cl', 'x-forwarded-groups': 'g1' })
    expect(id.claims).toEqual({ groups: ['g1'], viewer_area: ['Producción'] })
    await g.close()
  })

  it('el claim es un CONJUNTO: el multi-valor del store llega intacto', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertIdentityClaims('beto@x.com', { claims: { viewer_area: ['A', 'B'] }, origin: 'autoritativa-ambigua' })
    const proj = new IdentityProjection()
    await proj.refresh(g)
    const { identityFor } = createIdentity(CLAIMS, proj)
    expect(identityFor({ 'x-forwarded-email': 'beto@x.com' }).claims).toEqual({ viewer_area: ['A', 'B'] })
    await g.close()
  })

  it('fail-closed: sin entrada en el store → sin claims del directorio (nunca se infiere)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertIdentityClaims('ana@x.com', { claims: { viewer_area: 'P' }, origin: 'autoritativa' })
    const proj = new IdentityProjection()
    await proj.refresh(g)
    const { identityFor } = createIdentity(CLAIMS, proj)
    // Ni por parecido de correo ni de dominio: `ana.perez@x.com` no es `ana@x.com`.
    expect(identityFor({ 'x-forwarded-email': 'ana.perez@x.com' }).claims).toBeUndefined()
    expect(identityFor({ 'x-forwarded-email': 'ajeno@otro.cl' }).claims).toBeUndefined()
    await g.close()
  })

  it('entrada PRESENTE pero sin claims → no fabrica un claims vacío (sigue siendo fail-closed)', async () => {
    const proj = new IdentityProjection()
    proj.swapFromEntries([{ email: 'muda@x.com', claims: {} }])
    const { identityFor } = createIdentity(CLAIMS, proj)
    expect(identityFor({ 'x-forwarded-email': 'muda@x.com' }).claims).toBeUndefined()
  })

  it('RECARGA EN CALIENTE: corregir el mapa en el store surte efecto SIN recrear el resolver', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertIdentityClaims('ana@x.com', { claims: { viewer_area: 'Ventas' }, origin: 'autoritativa' })
    const proj = new IdentityProjection()
    await proj.refresh(g)
    // ESTE es el resolver que el router capturó al arrancar: no se vuelve a crear en toda la prueba.
    const { identityFor } = createIdentity(CLAIMS, proj)
    expect(identityFor({ 'x-forwarded-email': 'ana@x.com' }).claims).toEqual({ viewer_area: ['Ventas'] })

    // El administrador corrige el área y da de alta un override — sin reiniciar nada.
    await g.upsertIdentityClaims('ana@x.com', { claims: { viewer_area: 'Producción' }, origin: 'autoritativa' })
    await g.upsertIdentityClaims('ops@x.com', { claims: { viewer_area: ['A', 'B'] }, origin: 'override' })
    await proj.refresh(g)

    expect(identityFor({ 'x-forwarded-email': 'ana@x.com' }).claims).toEqual({ viewer_area: ['Producción'] })
    expect(identityFor({ 'x-forwarded-email': 'ops@x.com' }).claims).toEqual({ viewer_area: ['A', 'B'] })
    // Y la baja también viaja: retirada la entrada, la identidad vuelve a quedar sin claims.
    await g.deleteIdentityClaims('ana@x.com')
    await proj.refresh(g)
    expect(identityFor({ 'x-forwarded-email': 'ana@x.com' }).claims).toBeUndefined()
    await g.close()
  })

  it('una recarga FALLIDA conserva la proyección vigente y deja el motivo (nunca degrada a «sin claims»)', async () => {
    const proj = new IdentityProjection()
    proj.swapFromEntries([{ email: 'ana@x.com', claims: { viewer_area: ['Producción'] } }])
    const roto: IdentityClaimsSource = { listIdentityClaims: () => Promise.reject(new Error('store ilegible')) }
    const r = await proj.refresh(roto)

    expect(r.ok).toBe(false)
    expect(proj.state).toMatchObject({ cargada: true, entradas: 1, error: 'store ilegible' })
    const { identityFor } = createIdentity(CLAIMS, proj)
    expect(identityFor({ 'x-forwarded-email': 'ana@x.com' }).claims).toEqual({ viewer_area: ['Producción'] })
  })

  it('una proyección que NUNCA cargó no inventa claims, y se DECLARA no cargada (el arranque decide)', async () => {
    const proj = new IdentityProjection()
    const roto: IdentityClaimsSource = { listIdentityClaims: () => Promise.reject(new Error('sin store')) }
    await proj.refresh(roto)
    // Distinguir «cargada y vacía» de «nunca cargó» es lo que permite el fail-closed del arranque
    // (503 con la Administración en pie) en vez de servir cero filas mudas a todo el mundo.
    expect(proj.state).toMatchObject({ cargada: false, entradas: 0, error: 'sin store' })
    expect(createIdentity(CLAIMS, proj).identityFor({ 'x-forwarded-email': 'ana@x.com' }).claims).toBeUndefined()
  })
})

/**
 * El AVISO DE ALCANCE de la migración (hallazgo del hito 1).
 *
 * El resolver por archivo indexa las claves tal cual y busca en minúscula: una clave con mayúsculas
 * está en el mapa y NO aplica. El store normaliza ⇒ migrar la revive. Es una corrección, pero cambia
 * el alcance de autorización en producción, y por eso se cuenta para poder anunciarla.
 */
describe('mapa de identidad · claves no normalizadas (aviso de alcance, #159)', () => {
  const MAP = { 'ana@x.com': { viewer_area: 'P' }, 'Beto@X.com': { viewer_area: 'Q' }, ' caro@x.com ': { viewer_area: 'R' } }

  it('cuenta exactamente las claves que estaban muertas por no estar normalizadas', () => {
    expect(clavesNoNormalizadas(MAP)).toEqual(['Beto@X.com', ' caro@x.com '])
  })

  it('con el ARCHIVO esas claves no aplican; con la PROYECCIÓN del store sí — ese es el cambio', () => {
    const porArchivo = createIdentity(CLAIMS, MAP).identityFor
    expect(porArchivo({ 'x-forwarded-email': 'beto@x.com' }).claims).toBeUndefined() // muerta hoy

    const proj = new IdentityProjection()
    proj.seedFromMap(MAP)
    const porStore = createIdentity(CLAIMS, proj).identityFor
    expect(porStore({ 'x-forwarded-email': 'beto@x.com' }).claims).toEqual({ viewer_area: ['Q'] }) // revivida
    expect(porStore({ 'x-forwarded-email': 'caro@x.com' }).claims).toEqual({ viewer_area: ['R'] })
  })
})
