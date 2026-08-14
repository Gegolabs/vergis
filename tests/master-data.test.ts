import { describe, it, expect } from 'vitest'
import {
  parseMasterDataConfig,
  coerceRow,
  coerceValue,
  pkColumn,
  SqliteMasterDataStore,
  MasterDataConflict,
  SqliteAdminStore,
  AdminLockout,
  type MasterDataEntity,
} from '@vergis/capabilities'

const RELACIONADAS_YAML = {
  entities: [
    {
      id: 'empresas_relacionadas',
      label: 'Empresas Relacionadas',
      database_ref: 'mira',
      table: 'dbo.md_empresas_relacionadas',
      columns: [
        { name: 'codigo_socio', label: 'RUT', type: 'string', pk: true },
        { name: 'nombre', label: 'Nombre', type: 'string', required: true },
        { name: 'activo', label: 'Activo', type: 'bool' },
      ],
    },
  ],
}

describe('master-data · contrato', () => {
  it('parsea una entidad válida y deriva la PK', () => {
    const [e] = parseMasterDataConfig(RELACIONADAS_YAML)
    expect(e.id).toBe('empresas_relacionadas')
    expect(pkColumn(e).name).toBe('codigo_socio')
    expect(e.columns).toHaveLength(3)
  })

  it('clave raíz ausente → lanza; entities: [] es «declara cero» legítimo (#117)', () => {
    for (const doc of [{}, null, undefined, { otra: 1 }]) {
      expect(() => parseMasterDataConfig(doc)).toThrow(/falta la clave raíz 'entities'/)
    }
    expect(() => parseMasterDataConfig({})).toThrow(/usa 'entities: \[\]'/)
    expect(parseMasterDataConfig({ entities: [] })).toEqual([])
    expect(() => parseMasterDataConfig({ entities: null })).toThrow(/debe ser una lista/)
  })

  it('rechaza id inválido, columnas vacías y conteo de PK ≠ 1', () => {
    expect(() => parseMasterDataConfig({ entities: [{ id: 'Mal-Id', columns: [{ name: 'x', pk: true }] }] })).toThrow(/id inválido/)
    expect(() => parseMasterDataConfig({ entities: [{ id: 'ok', columns: [] }] })).toThrow(/sin columnas/)
    expect(() =>
      parseMasterDataConfig({ entities: [{ id: 'ok', columns: [{ name: 'a' }, { name: 'b' }] }] }),
    ).toThrow(/exactamente 1 columna pk/)
    expect(() =>
      parseMasterDataConfig({ entities: [{ id: 'ok', columns: [{ name: 'a', pk: true }, { name: 'b', pk: true }] }] }),
    ).toThrow(/exactamente 1 columna pk/)
  })

  it('coacciona y valida valores por tipo', () => {
    const intCol = { name: 'n', label: 'N', type: 'int' as const }
    expect(coerceValue(intCol, '76717733')).toEqual({ ok: true, value: 76717733 })
    expect(coerceValue(intCol, '12x')).toMatchObject({ ok: false })
    const boolCol = { name: 'b', label: 'Activo', type: 'bool' as const }
    expect(coerceValue(boolCol, 'sí')).toEqual({ ok: true, value: true })
    expect(coerceValue(boolCol, '0')).toEqual({ ok: true, value: false })
    const reqCol = { name: 'r', label: 'Nombre', type: 'string' as const, required: true }
    expect(coerceValue(reqCol, '   ')).toMatchObject({ ok: false })
  })

  it('coerceRow agrega errores de fila', () => {
    const [e] = parseMasterDataConfig(RELACIONADAS_YAML)
    const bad = coerceRow(e, { codigo_socio: '', nombre: '' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors).toHaveLength(2) // PK y nombre obligatorios
    const good = coerceRow(e, { codigo_socio: '76717733', nombre: 'Hijuelas Home & Garden', activo: 'sí' })
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.values).toEqual({ codigo_socio: '76717733', nombre: 'Hijuelas Home & Garden', activo: true })
  })
})

describe('master-data · SqliteMasterDataStore (local)', () => {
  const entity = (): MasterDataEntity => parseMasterDataConfig(RELACIONADAS_YAML)[0]

  it('insert / list / update / remove con coerción de tipos', async () => {
    const e = entity()
    const s = await SqliteMasterDataStore.open(null, [e])
    await s.insert(e, { codigo_socio: '76717733', nombre: 'Hijuelas Home & Garden', activo: true })
    await s.insert(e, { codigo_socio: '99524470', nombre: 'VIVEROS V.H. S.A.', activo: true })
    let rows = await s.list(e)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ codigo_socio: '76717733', nombre: 'Hijuelas Home & Garden', activo: true })
    // bool persiste como booleano, no como 1/0
    expect(typeof rows[0].activo).toBe('boolean')

    await s.update(e, '76717733', { codigo_socio: '76717733', nombre: 'H&G actualizado', activo: false })
    rows = await s.list(e)
    expect(rows.find((r) => r.codigo_socio === '76717733')).toEqual({ codigo_socio: '76717733', nombre: 'H&G actualizado', activo: false })

    await s.remove(e, '99524470')
    expect(await s.list(e)).toHaveLength(1)
    await s.close()
  })

  it('insert duplicado de PK → MasterDataConflict', async () => {
    const e = entity()
    const s = await SqliteMasterDataStore.open(null, [e])
    await s.insert(e, { codigo_socio: '1', nombre: 'A' })
    await expect(s.insert(e, { codigo_socio: '1', nombre: 'B' })).rejects.toBeInstanceOf(MasterDataConflict)
    await s.close()
  })
})

describe('admin-roles · SqliteAdminStore (semilla + anti-lockout)', () => {
  it('siembra, agrega y consulta admins', async () => {
    const s = await SqliteAdminStore.open(null, ['Cesar@ultrabase.com'])
    expect(await s.isAdmin('cesar@ultrabase.com')).toBe(true) // normalizado lowercase
    expect(await s.isAdmin('otro@x.com')).toBe(false)
    expect(await s.add('claudio@ratio.cl', 'cesar@ultrabase.com')).toBe(true)
    expect(await s.add('claudio@ratio.cl')).toBe(false) // idempotente
    const list = await s.list()
    expect(list.map((a) => a.email).sort()).toEqual(['cesar@ultrabase.com', 'claudio@ratio.cl'])
    expect(list.find((a) => a.email === 'cesar@ultrabase.com')?.seed).toBe(true)
    await s.close()
  })

  it('rechaza correo inválido', async () => {
    const s = await SqliteAdminStore.open(null, ['a@b.com'])
    await expect(s.add('no-es-correo')).rejects.toThrow(/inválido/)
    await s.close()
  })

  it('el único lockout es el último admin — la semilla SÍ se puede quitar (#182)', async () => {
    const s = await SqliteAdminStore.open(null, ['seed@x.com'])
    await expect(s.remove('seed@x.com')).rejects.toBeInstanceOf(AdminLockout) // último admin
    await s.add('normal@x.com', 'seed@x.com')
    await s.remove('seed@x.com') // ya no es el último: la semilla se va, sin 409
    expect((await s.list()).map((a) => a.email)).toEqual(['normal@x.com'])
    await expect(s.remove('normal@x.com')).rejects.toBeInstanceOf(AdminLockout) // ahora ESTE es el último
    await s.close()
  })
})
