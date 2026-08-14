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
    await g.upsertIdentityClaims('Ana.Perez@ga.test', { claims: { viewer_area: 'Producción' }, origin: 'autoritativa', updatedBy: 'Admin@ua.test' })

    // El resolver busca por `user.toLowerCase()`: si la clave guardara mayúsculas, el claim no aplicaría nunca.
    const porMinuscula = await g.getIdentityClaims('ana.perez@ga.test')
    expect(porMinuscula).toMatchObject({ email: 'ana.perez@ga.test', claims: { viewer_area: ['Producción'] }, origin: 'autoritativa', updatedBy: 'admin@ua.test' })
    expect(porMinuscula?.updatedAt).toBeTruthy()
    // Y se encuentra igual preguntando con la grafía original.
    expect(await g.getIdentityClaims('ANA.PEREZ@ga.test')).toMatchObject({ email: 'ana.perez@ga.test' })
    expect((await g.listIdentityClaims()).map((e) => e.email)).toEqual(['ana.perez@ga.test'])

    await g.deleteIdentityClaims('Ana.Perez@ga.test')
    expect(await g.getIdentityClaims('ana.perez@ga.test')).toBeNull()
    await g.close()
  })

  it('una entrada sobrevive al ciclo de archivo (persist + reopen)', async () => {
    const file = tmpFile('governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, {})
    await g1.upsertIdentityClaims('ops@ga.test', { claims: { viewer_area: ['Finanzas', 'Cartera'] }, origin: 'override', updatedBy: 'admin@ua.test' })
    await g1.close()

    const g2 = await SqliteGovernanceStore.open(file, {})
    expect(await g2.getIdentityClaims('ops@ga.test')).toMatchObject({ claims: { viewer_area: ['Finanzas', 'Cartera'] }, origin: 'override' })
    await g2.close()
  })

  it('EL CASO: una reconciliación en lote NO borra los override, y sí reemplaza las autoritativas', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    // Estado previo: dos de la fuente + la cuenta de operación inscrita a mano (el override).
    await g.reconcileIdentityClaims([
      { email: 'ana@ga.test', claims: { viewer_area: 'Producción' } },
      { email: 'beto@ga.test', claims: { viewer_area: 'Cartera' } },
    ])
    await g.upsertIdentityClaims('ops@ga.test', { claims: { viewer_area: 'Finanzas' }, origin: 'override', updatedBy: 'admin@ua.test' })

    // Regeneración: la fuente cambia el área de ana, ya no trae a beto, y nunca supo de ops.
    const res = await g.reconcileIdentityClaims([{ email: 'Ana@ga.test', claims: { viewer_area: 'Cartera' } }], { updatedBy: 'job:reconciliacion' })
    expect(res).toEqual({ escritas: 1, retiradas: 1, conservadas: 0 })

    expect(await g.getIdentityClaims('ana@ga.test')).toMatchObject({ claims: { viewer_area: ['Cartera'] }, origin: 'autoritativa' })
    expect(await g.getIdentityClaims('beto@ga.test')).toBeNull() // la fuente es espejo: lo que no trae, se retira
    // Lo que el issue reporta como defecto: acá NO pasa.
    expect(await g.getIdentityClaims('ops@ga.test')).toMatchObject({ claims: { viewer_area: ['Finanzas'] }, origin: 'override', updatedBy: 'admin@ua.test' })

    // Y sobrevive a N regeneraciones, incluida una vacía (fuente caída o mapa recién nacido).
    const vacia = await g.reconcileIdentityClaims([])
    expect(vacia).toEqual({ escritas: 0, retiradas: 1, conservadas: 0 })
    expect((await g.listIdentityClaims()).map((e) => e.email)).toEqual(['ops@ga.test'])
    await g.close()
  })

  it('la fuente NO puede pisar un override ni declararlo: el humano manda sobre la regeneración', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertIdentityClaims('ops@ga.test', { claims: { viewer_area: 'Finanzas' }, origin: 'override' })

    const res = await g.reconcileIdentityClaims([{ email: 'ops@ga.test', claims: { viewer_area: 'Bodega' } }])
    expect(res).toEqual({ escritas: 0, retiradas: 0, conservadas: 1 })
    expect(await g.getIdentityClaims('ops@ga.test')).toMatchObject({ claims: { viewer_area: ['Finanzas'] }, origin: 'override' })

    await expect(
      g.reconcileIdentityClaims([{ email: 'x@ga.test', claims: {}, origin: 'override' as never }]),
    ).rejects.toThrow(/override/)
    await g.close()
  })

  it('validate-before-write: una entrada inválida no deja el mapa a medio reemplazar', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.reconcileIdentityClaims([{ email: 'ana@ga.test', claims: { viewer_area: 'Producción' } }])
    await expect(
      g.reconcileIdentityClaims([{ email: 'beto@ga.test', claims: { viewer_area: 'Cartera' } }, { email: '  ', claims: {} }]),
    ).rejects.toThrow()
    // El mapa previo sigue intacto: ni se borró ana ni se escribió beto.
    expect((await g.listIdentityClaims()).map((e) => e.email)).toEqual(['ana@ga.test'])
    await g.close()
  })

  it('`autoritativa-ambigua` se persiste y es un ESTADO distinto de «sin entrada»', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    // La persona con dos fichas activas (#165·§4): la fuente la trajo y no resolvió a un valor único.
    await g.reconcileIdentityClaims([
      { email: 'dual@ga.test', claims: { viewer_area: ['Producción', 'Cartera'] }, origin: 'autoritativa-ambigua' },
      { email: 'sinvalor@ga.test', claims: {}, origin: 'autoritativa-ambigua' },
    ])

    expect(await g.getIdentityClaims('dual@ga.test')).toMatchObject({ origin: 'autoritativa-ambigua', claims: { viewer_area: ['Producción', 'Cartera'] } })
    // «Se reconcilió y no resolvió»: entrada presente, sin claims.
    expect(await g.getIdentityClaims('sinvalor@ga.test')).toMatchObject({ origin: 'autoritativa-ambigua', claims: {} })
    // «Nadie la reconcilió»: no hay entrada. Los dos estados son observables y NO se confunden.
    expect(await g.getIdentityClaims('nadie@ga.test')).toBeNull()

    // Y ambigua se distingue de autoritativa en la vista de auditoría.
    expect((await g.listIdentityClaims()).map((e) => e.origin)).toEqual(['autoritativa-ambigua', 'autoritativa-ambigua'])
    await g.close()
  })

  it('unresolvedIdentities: solo la que NO tiene fila; la ambigua y la vacía SÍ resolvieron', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.reconcileIdentityClaims([
      { email: 'ana@ga.test', claims: { viewer_area: 'Producción' } },
      { email: 'sinvalor@ga.test', claims: {}, origin: 'autoritativa-ambigua' },
    ])
    await g.upsertIdentityClaims('ops@ga.test', { claims: { viewer_area: 'Finanzas' }, origin: 'override' })

    const sin = await g.unresolvedIdentities(['Ana@ga.test', 'ops@ga.test', 'sinvalor@ga.test', 'Nueva@ga.test', 'nueva@ga.test', ''])
    expect(sin).toEqual(['nueva@ga.test']) // normalizado y deduplicado; nada se adivina por parecido
    await g.close()
  })

  it('el claim es un CONJUNTO: los multi-valor sobreviven el viaje, sin repetidos ni vacíos', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertIdentityClaims('multi@ga.test', {
      claims: { viewer_area: ['Producción', 'Cartera', 'Producción', ' '], groups: 'analistas' },
      origin: 'autoritativa',
    })
    expect(await g.getIdentityClaims('multi@ga.test')).toMatchObject({
      claims: { viewer_area: ['Producción', 'Cartera'], groups: ['analistas'] }, // el valor único también es lista
    })
    await g.close()
  })

  it('import desde el JSON del archivo: todo entra como `autoritativa`', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const map = {
      'Ana@ga.test': { viewer_area: 'Producción' },
      'beto@ga.test': { viewer_area: ['Cartera', 'Finanzas'] },
    }
    const res = await importIdentityMap(g, map)
    expect(res).toMatchObject({ leidas: 2, escritas: 2, retiradas: 0, conservadas: 0 })

    const todas = await g.listIdentityClaims()
    expect(todas.map((e) => e.email)).toEqual(['ana@ga.test', 'beto@ga.test'])
    expect(todas.every((e) => e.origin === 'autoritativa')).toBe(true)
    expect(todas[1]?.claims).toEqual({ viewer_area: ['Cartera', 'Finanzas'] })
    await g.close()
  })

  it('import desde el archivo de VERGIS_IDENTITY_MAP: preserva overrides y reporta las entradas basura', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertIdentityClaims('ops@ga.test', { claims: { viewer_area: 'Finanzas' }, origin: 'override' })

    const file = tmpFile('identity-map.json')
    writeFileSync(file, JSON.stringify({ 'Ana@ga.test': { viewer_area: 'Producción' }, 'rota@ga.test': 'no-es-un-objeto' }))
    const res = await importIdentityMapFile(g, file, { updatedBy: 'admin@ua.test' })

    expect(res).toMatchObject({ leidas: 1, escritas: 1, invalidas: ['rota@ga.test'] })
    expect(await g.getIdentityClaims('ana@ga.test')).toMatchObject({ origin: 'autoritativa', updatedBy: 'admin@ua.test' })
    expect(await g.getIdentityClaims('rota@ga.test')).toBeNull() // no se le fabrican claims a una entrada ilegible
    expect(await g.getIdentityClaims('ops@ga.test')).toMatchObject({ origin: 'override' }) // la migración no pisa lo inscrito a mano
    await g.close()
  })

  it('parseIdentityMapFile rechaza un JSON que no es el mapa', () => {
    expect(() => parseIdentityMapFile('[]')).toThrow()
    expect(() => parseIdentityMapFile('"texto"')).toThrow()
  })
})
