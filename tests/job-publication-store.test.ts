import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SqliteGovernanceStore, type PublicationInput } from '@vergis/capabilities'

/**
 * El ledger de publicaciones EXPUESTO POR EL STORE (#107 fase 2, wiring de H5). Las ops puras ya
 * están cubiertas por `tests/job-publication.test.ts`; lo que esto mide es lo único que el store
 * agrega: que cada escritura se VUELCA al archivo EN EL MOMENTO. Una publicación que no sobrevive a
 * una caída del proceso deja al motor y a Vergis con memorias distintas.
 *
 * Por qué se relee SIN cerrar el store que escribió: `close()` persiste, así que un test que cierra
 * antes de reabrir pasa igual con el `persist()` de la escritura borrado — mide el cierre ordenado,
 * no la escritura. Verificado quitando ese `persist()`: con `close()` de por medio el test seguía
 * verde; releyendo el archivo con el store vivo, falla.
 */
const intento = (over: Partial<PublicationInput> = {}): PublicationInput => ({
  processId: 'ingesta_saldos',
  templateId: 'sjd_ingesta_excel',
  templateVersion: '1.0',
  workspaceId: 'ws-1',
  action: 'create',
  definitionSha256: 'a'.repeat(64),
  params: { main_file: 'abfss://ws/lh/Files/code/x.py' },
  outcome: 'ok',
  byUser: 'admin@x.com',
  ...over,
})

describe('GovernanceStore · ledger de publicaciones de jobs', () => {
  it('la publicación queda en el ARCHIVO apenas se registra (sin cerrar el store)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-gov-jobpub-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, {})
    const id = await g1.recordPublication(intento({ itemId: 'item-1' }))
    expect(id).toBeGreaterThan(0)

    // Segunda apertura del MISMO archivo, con g1 todavía vivo: lo que se lee es lo volcado por la
    // escritura, no por el cierre.
    const g2 = await SqliteGovernanceStore.open(file, {})
    expect(await g2.lastOkPublication({ processId: 'ingesta_saldos' })).toMatchObject({
      id,
      itemId: 'item-1',
      outcome: 'ok',
      definitionSha256: 'a'.repeat(64),
    })
    expect(await g2.listPublications()).toHaveLength(1)
    await g2.close()
    await g1.close()
  })

  it('la resolución de una `desconocida` también se vuelca, y la original no se muta', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-gov-jobpub-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, {})
    const id = await g1.recordPublication(intento({ outcome: 'desconocida', detail: 'operationId=op-9' }))
    expect(await g1.pendingUnknownPublications()).toHaveLength(1)
    await g1.resolveUnknownPublication(id, { outcome: 'ok', itemId: 'item-7', byUser: 'admin@x.com' })

    const g2 = await SqliteGovernanceStore.open(file, {})
    expect(await g2.pendingUnknownPublications()).toEqual([]) // resuelta: ya no está en la cola
    const filas = await g2.listPublications()
    expect(filas).toHaveLength(2)
    expect(filas.find((f) => f.id === id)).toMatchObject({ outcome: 'desconocida', detail: 'operationId=op-9' })
    expect(await g2.lastOkPublication({ processId: 'ingesta_saldos' })).toMatchObject({ outcome: 'ok', itemId: 'item-7' })
    await g2.close()
    await g1.close()
  })
})
