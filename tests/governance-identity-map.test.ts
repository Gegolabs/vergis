/**
 * El mapa identidad→claims en el store de gobierno (issue #159, hito 1).
 *
 * Lo que estos casos vigilan no es el CRUD: es que la PROCEDENCIA haga su trabajo. El defecto que el
 * issue reporta —la cuenta de operación que se cae del mapa en cada regeneración— reaparece en el
 * instante en que una reconciliación toque una fila `override`, y ese es el caso central de acá.
 *
 * Se importa por ruta directa (no por `@vergis/capabilities`): el barrel todavía no exporta esta
 * familia — el hito no lo toca — y el patrón de import profundo ya existe en tests/.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SqliteGovernanceStore } from '../packages/capabilities/src/governance-store'
import { importIdentityMap, importIdentityMapFile, parseIdentityMapFile } from '../packages/capabilities/src/identity-map-import'

const tmpFile = (name: string): string => join(mkdtempSync(join(tmpdir(), 'vergis-idmap-')), name)

describe('GovernanceStore · mapa identidad→claims (#159)', () => {
  it('alta, lectura y baja de una entrada, con el email normalizado a minúscula', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertIdentityClaims('Ana.Perez@GH.CL', { claims: { viewer_area: 'Producción' }, origin: 'autoritativa', updatedBy: 'Cesar@ultrabase.com' })

    // El resolver busca por `user.toLowerCase()`: si la clave guardara mayúsculas, el claim no aplicaría nunca.
    const porMinuscula = await g.getIdentityClaims('ana.perez@gh.cl')
    expect(porMinuscula).toMatchObject({ email: 'ana.perez@gh.cl', claims: { viewer_area: ['Producción'] }, origin: 'autoritativa', updatedBy: 'cesar@ultrabase.com' })
    expect(porMinuscula?.updatedAt).toBeTruthy()
    // Y se encuentra igual preguntando con la grafía original.
    expect(await g.getIdentityClaims('ANA.PEREZ@gh.cl')).toMatchObject({ email: 'ana.perez@gh.cl' })
    expect((await g.listIdentityClaims()).map((e) => e.email)).toEqual(['ana.perez@gh.cl'])

    await g.deleteIdentityClaims('Ana.Perez@GH.CL')
    expect(await g.getIdentityClaims('ana.perez@gh.cl')).toBeNull()
    await g.close()
  })

  it('una entrada sobrevive al ciclo de archivo (persist + reopen)', async () => {
    const file = tmpFile('governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, {})
    await g1.upsertIdentityClaims('ops@gh.cl', { claims: { viewer_area: ['Finanzas', 'Cartera'] }, origin: 'override', updatedBy: 'cesar@ultrabase.com' })
    await g1.close()

    const g2 = await SqliteGovernanceStore.open(file, {})
    expect(await g2.getIdentityClaims('ops@gh.cl')).toMatchObject({ claims: { viewer_area: ['Finanzas', 'Cartera'] }, origin: 'override' })
    await g2.close()
  })

  it('EL CASO: una reconciliación en lote NO borra los override, y sí reemplaza las autoritativas', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    // Estado previo: dos de la fuente + la cuenta de operación inscrita a mano (el override).
    await g.reconcileIdentityClaims([
      { email: 'ana@gh.cl', claims: { viewer_area: 'Producción' } },
      { email: 'beto@gh.cl', claims: { viewer_area: 'Cartera' } },
    ])
    await g.upsertIdentityClaims('ops@gh.cl', { claims: { viewer_area: 'Finanzas' }, origin: 'override', updatedBy: 'cesar@ultrabase.com' })

    // Regeneración: la fuente cambia el área de ana, ya no trae a beto, y nunca supo de ops.
    const res = await g.reconcileIdentityClaims([{ email: 'Ana@gh.cl', claims: { viewer_area: 'Cartera' } }], { updatedBy: 'job:reconciliacion' })
    expect(res).toEqual({ escritas: 1, retiradas: 1, conservadas: 0 })

    expect(await g.getIdentityClaims('ana@gh.cl')).toMatchObject({ claims: { viewer_area: ['Cartera'] }, origin: 'autoritativa' })
    expect(await g.getIdentityClaims('beto@gh.cl')).toBeNull() // la fuente es espejo: lo que no trae, se retira
    // Lo que el issue reporta como defecto: acá NO pasa.
    expect(await g.getIdentityClaims('ops@gh.cl')).toMatchObject({ claims: { viewer_area: ['Finanzas'] }, origin: 'override', updatedBy: 'cesar@ultrabase.com' })

    // Y sobrevive a N regeneraciones, incluida una vacía (fuente caída o mapa recién nacido).
    const vacia = await g.reconcileIdentityClaims([])
    expect(vacia).toEqual({ escritas: 0, retiradas: 1, conservadas: 0 })
    expect((await g.listIdentityClaims()).map((e) => e.email)).toEqual(['ops@gh.cl'])
    await g.close()
  })

  it('la fuente NO puede pisar un override ni declararlo: el humano manda sobre la regeneración', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertIdentityClaims('ops@gh.cl', { claims: { viewer_area: 'Finanzas' }, origin: 'override' })

    const res = await g.reconcileIdentityClaims([{ email: 'ops@gh.cl', claims: { viewer_area: 'Bodega' } }])
    expect(res).toEqual({ escritas: 0, retiradas: 0, conservadas: 1 })
    expect(await g.getIdentityClaims('ops@gh.cl')).toMatchObject({ claims: { viewer_area: ['Finanzas'] }, origin: 'override' })

    await expect(
      g.reconcileIdentityClaims([{ email: 'x@gh.cl', claims: {}, origin: 'override' as never }]),
    ).rejects.toThrow(/override/)
    await g.close()
  })

  it('validate-before-write: una entrada inválida no deja el mapa a medio reemplazar', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.reconcileIdentityClaims([{ email: 'ana@gh.cl', claims: { viewer_area: 'Producción' } }])
    await expect(
      g.reconcileIdentityClaims([{ email: 'beto@gh.cl', claims: { viewer_area: 'Cartera' } }, { email: '  ', claims: {} }]),
    ).rejects.toThrow()
    // El mapa previo sigue intacto: ni se borró ana ni se escribió beto.
    expect((await g.listIdentityClaims()).map((e) => e.email)).toEqual(['ana@gh.cl'])
    await g.close()
  })

  it('`autoritativa-ambigua` se persiste y es un ESTADO distinto de «sin entrada»', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    // La persona con dos fichas activas (#165·§4): la fuente la trajo y no resolvió a un valor único.
    await g.reconcileIdentityClaims([
      { email: 'dual@gh.cl', claims: { viewer_area: ['Producción', 'Cartera'] }, origin: 'autoritativa-ambigua' },
      { email: 'sinvalor@gh.cl', claims: {}, origin: 'autoritativa-ambigua' },
    ])

    expect(await g.getIdentityClaims('dual@gh.cl')).toMatchObject({ origin: 'autoritativa-ambigua', claims: { viewer_area: ['Producción', 'Cartera'] } })
    // «Se reconcilió y no resolvió»: entrada presente, sin claims.
    expect(await g.getIdentityClaims('sinvalor@gh.cl')).toMatchObject({ origin: 'autoritativa-ambigua', claims: {} })
    // «Nadie la reconcilió»: no hay entrada. Los dos estados son observables y NO se confunden.
    expect(await g.getIdentityClaims('nadie@gh.cl')).toBeNull()

    // Y ambigua se distingue de autoritativa en la vista de auditoría.
    expect((await g.listIdentityClaims()).map((e) => e.origin)).toEqual(['autoritativa-ambigua', 'autoritativa-ambigua'])
    await g.close()
  })

  it('unresolvedIdentities: solo la que NO tiene fila; la ambigua y la vacía SÍ resolvieron', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.reconcileIdentityClaims([
      { email: 'ana@gh.cl', claims: { viewer_area: 'Producción' } },
      { email: 'sinvalor@gh.cl', claims: {}, origin: 'autoritativa-ambigua' },
    ])
    await g.upsertIdentityClaims('ops@gh.cl', { claims: { viewer_area: 'Finanzas' }, origin: 'override' })

    const sin = await g.unresolvedIdentities(['Ana@gh.cl', 'ops@gh.cl', 'sinvalor@gh.cl', 'Nueva@gh.cl', 'nueva@gh.cl', ''])
    expect(sin).toEqual(['nueva@gh.cl']) // normalizado y deduplicado; nada se adivina por parecido
    await g.close()
  })

  it('el claim es un CONJUNTO: los multi-valor sobreviven el viaje, sin repetidos ni vacíos', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertIdentityClaims('multi@gh.cl', {
      claims: { viewer_area: ['Producción', 'Cartera', 'Producción', ' '], groups: 'analistas' },
      origin: 'autoritativa',
    })
    expect(await g.getIdentityClaims('multi@gh.cl')).toMatchObject({
      claims: { viewer_area: ['Producción', 'Cartera'], groups: ['analistas'] }, // el valor único también es lista
    })
    await g.close()
  })

  it('import desde el JSON del archivo: todo entra como `autoritativa`', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const map = {
      'Ana@GH.CL': { viewer_area: 'Producción' },
      'beto@gh.cl': { viewer_area: ['Cartera', 'Finanzas'] },
    }
    const res = await importIdentityMap(g, map)
    expect(res).toMatchObject({ leidas: 2, escritas: 2, retiradas: 0, conservadas: 0 })

    const todas = await g.listIdentityClaims()
    expect(todas.map((e) => e.email)).toEqual(['ana@gh.cl', 'beto@gh.cl'])
    expect(todas.every((e) => e.origin === 'autoritativa')).toBe(true)
    expect(todas[1]?.claims).toEqual({ viewer_area: ['Cartera', 'Finanzas'] })
    await g.close()
  })

  it('import desde el archivo de VERGIS_IDENTITY_MAP: preserva overrides y reporta las entradas basura', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertIdentityClaims('ops@gh.cl', { claims: { viewer_area: 'Finanzas' }, origin: 'override' })

    const file = tmpFile('identity-map.json')
    writeFileSync(file, JSON.stringify({ 'Ana@GH.CL': { viewer_area: 'Producción' }, 'rota@gh.cl': 'no-es-un-objeto' }))
    const res = await importIdentityMapFile(g, file, { updatedBy: 'cesar@ultrabase.com' })

    expect(res).toMatchObject({ leidas: 1, escritas: 1, invalidas: ['rota@gh.cl'] })
    expect(await g.getIdentityClaims('ana@gh.cl')).toMatchObject({ origin: 'autoritativa', updatedBy: 'cesar@ultrabase.com' })
    expect(await g.getIdentityClaims('rota@gh.cl')).toBeNull() // no se le fabrican claims a una entrada ilegible
    expect(await g.getIdentityClaims('ops@gh.cl')).toMatchObject({ origin: 'override' }) // la migración no pisa lo inscrito a mano
    await g.close()
  })

  it('parseIdentityMapFile rechaza un JSON que no es el mapa', () => {
    expect(() => parseIdentityMapFile('[]')).toThrow()
    expect(() => parseIdentityMapFile('"texto"')).toThrow()
  })
})
