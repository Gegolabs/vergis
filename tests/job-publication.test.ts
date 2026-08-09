import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  openSqliteDb,
  selectAll,
  ensureJobPublicationTable,
  recordPublication,
  lastOkPublication,
  listPublications,
  pendingUnknownPublications,
  resolveUnknownPublication,
  derivePublishPlan,
  SqliteGovernanceStore,
  type PublicationInput,
  type PublishPlanInput,
  type SqlDb,
} from '@vergis/capabilities'

/** Un db de gobierno en memoria con solo la tabla del ledger (las ops son puras sobre SqlDb). */
async function ledgerDb(): Promise<SqlDb> {
  const db = await openSqliteDb(null)
  ensureJobPublicationTable(db)
  return db
}

const fila = (over: Partial<PublicationInput> = {}): PublicationInput => ({
  processId: 'ingesta_ventas',
  templateId: 'sjd_ingesta_excel',
  templateVersion: '1.0',
  workspaceId: 'ws-1',
  itemId: 'item-1',
  action: 'update',
  definitionSha256: 'sha-render',
  params: { main_file: 'abfss://ws/lh/Files/code/ingesta.py', lakehouse_id: 'lh-1' },
  outcome: 'ok',
  byUser: 'cesar@ultrabase.com',
  ...over,
})

const plan = (over: Partial<PublishPlanInput> = {}): PublishPlanInput => ({
  processId: 'ingesta_ventas',
  templateId: 'sjd_ingesta_excel',
  templateVersion: '1.0',
  workspaceId: 'ws-1',
  itemId: 'item-1',
  renderedSha: 'sha-render',
  engineSha: 'sha-motor',
  lastOkSha: 'sha-motor',
  params: { main_file: 'abfss://ws/lh/Files/code/ingesta.py' },
  ...over,
})

describe('job_publication · DDL en el store de gobierno', () => {
  it('la tabla nace en el db de gobierno al abrir el store', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-jobpub-')), 'gov.sqlite')
    const g = await SqliteGovernanceStore.open(file, {})
    await g.close()
    // Se re-abre el ARCHIVO que dejó el store: si el DDL no corrió en `open`, la tabla no está.
    const db = await openSqliteDb(file)
    const tablas = selectAll(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_publication'`)
    expect(tablas.map((r) => String(r['name']))).toEqual(['job_publication'])
    ensureJobPublicationTable(db) // idempotente sobre una db que ya la tiene
    expect(listPublications(db)).toEqual([])
    db.close()
  })
})

describe('job_publication · los cuatro outcomes', () => {
  it('registra ok / denegada / fallida / desconocida y los devuelve legibles', async () => {
    const db = await ledgerDb()
    recordPublication(db, fila({ outcome: 'ok', detail: 'read-back sha-render' }))
    recordPublication(db, fila({ outcome: 'denegada', detail: 'InsufficientPrivileges' }))
    recordPublication(db, fila({ outcome: 'fallida', detail: 'timeout de red' }))
    recordPublication(db, fila({ outcome: 'desconocida', detail: 'operationId=op-77', itemId: undefined, action: 'create' }))
    const rows = listPublications(db)
    expect(rows.map((r) => r.outcome)).toEqual(['desconocida', 'fallida', 'denegada', 'ok'])
    expect(rows[0]).toMatchObject({ action: 'create', detail: 'operationId=op-77' })
    expect(rows[0].itemId).toBeUndefined()
    expect(rows[3]).toMatchObject({ outcome: 'ok', itemId: 'item-1', byUser: 'cesar@ultrabase.com' })
    expect(rows[3].params).toEqual({ main_file: 'abfss://ws/lh/Files/code/ingesta.py', lakehouse_id: 'lh-1' })
    expect(rows.every((r) => typeof r.at === 'string' && r.at.length > 0)).toBe(true)
    db.close()
  })

  it('rechaza outcome y action inválidos, y params con pinta de secreto', async () => {
    const db = await ledgerDb()
    expect(() => recordPublication(db, fila({ outcome: 'publicada' as never }))).toThrow(/outcome/)
    expect(() => recordPublication(db, fila({ action: 'delete' as never }))).toThrow(/action/)
    expect(() => recordPublication(db, fila({ params: { client_secret: 'x' } }))).toThrow(/secreto/)
    expect(listPublications(db)).toEqual([])
    db.close()
  })
})

describe('job_publication · append-only', () => {
  it('una re-publicación agrega fila y no muta la anterior', async () => {
    const db = await ledgerDb()
    const id1 = recordPublication(db, fila({ definitionSha256: 'sha-v1', at: '2026-08-01T10:00:00.000Z' }))
    const id2 = recordPublication(db, fila({ definitionSha256: 'sha-v2', at: '2026-08-02T10:00:00.000Z' }))
    expect(id2).toBeGreaterThan(id1)
    const rows = listPublications(db, { processId: 'ingesta_ventas' })
    expect(rows).toHaveLength(2)
    const original = rows.find((r) => r.id === id1)!
    expect(original.definitionSha256).toBe('sha-v1')
    expect(original.at).toBe('2026-08-01T10:00:00.000Z')
    expect(lastOkPublication(db, { processId: 'ingesta_ventas' })!.definitionSha256).toBe('sha-v2')
    db.close()
  })

  it('lastOkPublication ignora los desenlaces que no son ok, por proceso y por item', async () => {
    const db = await ledgerDb()
    recordPublication(db, fila({ definitionSha256: 'sha-ok' }))
    recordPublication(db, fila({ definitionSha256: 'sha-falla', outcome: 'fallida' }))
    recordPublication(db, fila({ definitionSha256: 'sha-deneg', outcome: 'denegada' }))
    expect(lastOkPublication(db, { processId: 'ingesta_ventas' })!.definitionSha256).toBe('sha-ok')
    expect(lastOkPublication(db, { workspaceId: 'ws-1', itemId: 'item-1' })!.definitionSha256).toBe('sha-ok')
    expect(lastOkPublication(db, { workspaceId: 'ws-1', itemId: 'otro' })).toBeNull()
    expect(lastOkPublication(db, { processId: 'otro_proceso' })).toBeNull()
    db.close()
  })
})

describe('job_publication · resolución de una desconocida (D7)', () => {
  it('resuelve con fila NUEVA que referencia la desconocida; la original queda intacta', async () => {
    const db = await ledgerDb()
    const unknownId = recordPublication(db, fila({ action: 'create', itemId: undefined, outcome: 'desconocida', detail: 'operationId=op-77' }))
    expect(pendingUnknownPublications(db).map((r) => r.id)).toEqual([unknownId])

    const nuevoId = resolveUnknownPublication(db, unknownId, { outcome: 'ok', detail: 'read-back tras op-77', itemId: 'item-nuevo' })
    const rows = listPublications(db)
    expect(rows).toHaveLength(2)
    const original = rows.find((r) => r.id === unknownId)!
    expect(original.outcome).toBe('desconocida') // NO mutada
    expect(original.detail).toBe('operationId=op-77')
    const resolucion = rows.find((r) => r.id === nuevoId)!
    expect(resolucion.outcome).toBe('ok')
    expect(resolucion.itemId).toBe('item-nuevo')
    expect(resolucion.detail).toContain(`resuelve:#${unknownId}`)
    expect(resolucion.definitionSha256).toBe(original.definitionSha256)
    expect(pendingUnknownPublications(db)).toEqual([]) // ya no está pendiente
    expect(lastOkPublication(db, { processId: 'ingesta_ventas' })!.id).toBe(nuevoId)
    db.close()
  })

  it('rechaza resolver una fila inexistente o que no está desconocida', async () => {
    const db = await ledgerDb()
    const okId = recordPublication(db, fila({ outcome: 'ok' }))
    expect(() => resolveUnknownPublication(db, 999, { outcome: 'ok' })).toThrow(/no existe/)
    expect(() => resolveUnknownPublication(db, okId, { outcome: 'fallida' })).toThrow(/no está 'desconocida'/)
    db.close()
  })

  it('la marca de resolución no confunde ids con prefijo común (#1 vs #12)', async () => {
    const db = await ledgerDb()
    const u1 = recordPublication(db, fila({ outcome: 'desconocida' }))
    for (let i = 0; i < 10; i++) recordPublication(db, fila({ outcome: 'fallida' }))
    const u12 = recordPublication(db, fila({ outcome: 'desconocida' }))
    expect(u1).toBe(1)
    expect(u12).toBe(12)
    resolveUnknownPublication(db, u12, { outcome: 'ok' })
    expect(pendingUnknownPublications(db).map((r) => r.id)).toEqual([u1]) // la #1 sigue pendiente
    db.close()
  })
})

describe('derivePublishPlan · create vs update', () => {
  it('create cuando no hay item destino', () => {
    expect(derivePublishPlan(plan({ itemId: null, engineSha: null, lastOkSha: null })).action).toBe('create')
    expect(derivePublishPlan(plan({ itemId: '  ', engineSha: null, lastOkSha: null })).action).toBe('create')
  })

  it('create cuando el ledger recuerda un item que el motor ya no tiene', () => {
    const p = derivePublishPlan(plan({ itemId: 'item-1', engineSha: null, lastOkSha: 'sha-viejo' }))
    expect(p.action).toBe('create')
    expect(p.drift).toBe(false) // sin sha del motor no hay drift medible
  })

  it('update cuando el item existe en el motor', () => {
    expect(derivePublishPlan(plan()).action).toBe('update')
  })
})

describe('derivePublishPlan · drift (D6: se declara, no se corrige)', () => {
  it('drift cuando el motor difiere de lo último publicado ok', () => {
    const p = derivePublishPlan(plan({ engineSha: 'sha-editado-a-mano', lastOkSha: 'sha-publicado' }))
    expect(p.drift).toBe(true)
    expect(p.action).toBe('update') // el plan NO cambia de naturaleza: solo declara
  })

  it('sin drift cuando engineSha === lastOkSha', () => {
    expect(derivePublishPlan(plan({ engineSha: 'sha-x', lastOkSha: 'sha-x' })).drift).toBe(false)
  })

  it('sin drift con engineSha null (item inexistente) ni con lastOkSha null (nunca publicado)', () => {
    expect(derivePublishPlan(plan({ engineSha: null, lastOkSha: 'sha-x' })).drift).toBe(false)
    expect(derivePublishPlan(plan({ engineSha: 'sha-x', lastOkSha: null })).drift).toBe(false)
  })

  it('sinCambios cuando el motor ya tiene exactamente la definición renderizada', () => {
    expect(derivePublishPlan(plan({ renderedSha: 'sha-igual', engineSha: 'sha-igual', lastOkSha: 'sha-igual' })).sinCambios).toBe(true)
    expect(derivePublishPlan(plan()).sinCambios).toBe(false)
  })
})

describe('derivePublishPlan · hash sellado (D5, contra carreras)', () => {
  it('mismo insumo ⇒ mismo hash, y el orden de las claves de params no lo mueve', () => {
    const a = derivePublishPlan(plan({ params: { alfa: '1', beta: '2' } }))
    const b = derivePublishPlan(plan({ params: { beta: '2', alfa: '1' } }))
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('el hash cambia si cambia CUALQUIER insumo', () => {
    const base = derivePublishPlan(plan())
    const variantes: PublishPlanInput[] = [
      plan({ processId: 'otro' }),
      plan({ templateId: 'otra_plantilla' }),
      plan({ templateVersion: '2.0' }),
      plan({ workspaceId: 'ws-2' }),
      plan({ itemId: 'item-2' }),
      plan({ renderedSha: 'sha-render-2' }),
      plan({ engineSha: 'sha-motor-2' }),
      plan({ lastOkSha: 'sha-ok-2' }),
      plan({ params: { main_file: 'abfss://ws/lh/Files/code/otro.py' } }),
      plan({ params: { main_file: 'abfss://ws/lh/Files/code/ingesta.py', extra: 'x' } }),
    ]
    const hashes = variantes.map((v) => derivePublishPlan(v).hash)
    for (const h of hashes) expect(h).not.toBe(base.hash)
    expect(new Set(hashes).size).toBe(hashes.length) // todas distintas entre sí
  })

  it('itemId null y itemId en blanco sellan el mismo plan (normalización)', () => {
    expect(derivePublishPlan(plan({ itemId: null, engineSha: null })).hash).toBe(derivePublishPlan(plan({ itemId: '   ', engineSha: null })).hash)
  })

  it('rechaza renderedSha vacío y params con pinta de secreto', () => {
    expect(() => derivePublishPlan(plan({ renderedSha: '' }))).toThrow(/renderedSha/)
    expect(() => derivePublishPlan(plan({ params: { api_key: 'x' } }))).toThrow(/secreto/)
  })
})

describe('job_publication · el plan desemboca en el ledger', () => {
  it('el sha del plan es el que se sella y `lastOkPublication` lo devuelve para el plan siguiente', async () => {
    const db = await ledgerDb()
    const p1 = derivePublishPlan(plan({ itemId: null, engineSha: null, lastOkSha: null, renderedSha: 'sha-v1' }))
    expect(p1.action).toBe('create')
    recordPublication(db, fila({ action: p1.action, itemId: 'item-creado', definitionSha256: p1.renderedSha, outcome: 'ok' }))

    const ultimo = lastOkPublication(db, { processId: 'ingesta_ventas' })!
    const p2 = derivePublishPlan(plan({ itemId: ultimo.itemId!, engineSha: 'sha-v1', lastOkSha: ultimo.definitionSha256, renderedSha: 'sha-v2' }))
    expect(p2).toMatchObject({ action: 'update', drift: false, sinCambios: false })
    db.close()
  })
})
