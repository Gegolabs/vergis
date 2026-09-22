// El registro de ESCRITORES del terreno (`VERGIS_WRITERS`, CAP-197).
//
// Lo que se mide acá es la semántica de fallas de dos niveles —clave raíz ausente FATAL, entrada
// inválida OMITIDA con aviso— y la regla que no es obvia: una tabla sin esquema se cae sola, sin
// llevarse por delante al escritor que la declaró.

import { describe, it, expect } from 'vitest'
import { escritoresDe, normalizarTabla, parseWritersConfig } from '../server/writers-config'

const completo = {
  id: 'sjd-ingest-finanzas',
  conexion: 'finanzas',
  tipo: 'sjd',
  estado: 'vigente',
  disparo: 'intake land-and-trigger (slot saldos)',
  tablas: ['dbo.dim_socios', 'dbo.fact_saldos'],
}

describe('parseWritersConfig · clave raíz', () => {
  it('la clave raíz ausente es FATAL — un archivo truncado no puede parecer «cero escritores»', () => {
    expect(() => parseWritersConfig({})).toThrow(/falta la clave raíz 'writers'/)
    expect(() => parseWritersConfig(null)).toThrow(/falta la clave raíz 'writers'/)
    expect(() => parseWritersConfig([])).toThrow(/falta la clave raíz 'writers'/)
  })
  it('`writers: []` es cero escritores, legítimo y silencioso', () => {
    const r = parseWritersConfig({ writers: [] })
    expect(r.writers).toEqual([])
    expect(r.warnings).toEqual([])
  })
  it('`writers:` que no es lista es error de tipo', () => {
    expect(() => parseWritersConfig({ writers: 'x' })).toThrow(/debe ser una lista/)
  })
})

describe('parseWritersConfig · una entrada válida', () => {
  it('normaliza las tablas a `schema.tabla` en minúsculas y sin corchetes', () => {
    const r = parseWritersConfig({ writers: [{ ...completo, tablas: ['[DBO].[Fact_Saldos]', 'dbo.dim_socios'] }] })
    expect(r.writers[0].tablas).toEqual(['dbo.fact_saldos', 'dbo.dim_socios'])
    expect(r.warnings).toEqual([])
  })
  it('colapsa el disparo a una línea y conserva los campos opcionales', () => {
    const r = parseWritersConfig({
      writers: [{ ...completo, disparo: 'intake\n   land-and-trigger', proceso: 'p1', lee: ['dbo.otra'], notas: 'reemplaza al legado' }],
    })
    expect(r.writers[0].disparo).toBe('intake land-and-trigger')
    expect(r.writers[0].proceso).toBe('p1')
    expect(r.writers[0].lee).toEqual(['dbo.otra'])
    expect(r.writers[0].notas).toBe('reemplaza al legado')
  })
  it('las claves desconocidas se IGNORAN: el archivo de la instancia puede ser el mismo que ya tiene', () => {
    const r = parseWritersConfig({ writers: [{ ...completo, code: 'X', fabric_id: 'abc', dinamico: true }] })
    expect(r.writers).toHaveLength(1)
    expect(r.warnings).toEqual([])
  })
})

describe('parseWritersConfig · entradas que se OMITEN (el nodo levanta igual)', () => {
  const casos: [string, Record<string, unknown>, RegExp][] = [
    ['sin id', { ...completo, id: '' }, /'id' debe ser un string no vacío/],
    ['sin conexion', { ...completo, conexion: '' }, /'conexion' debe ser un string no vacío/],
    ['conexion con forma inválida', { ...completo, conexion: 'a b' }, /'conexion' inválida/],
    ['sin tipo', { ...completo, tipo: '' }, /'tipo' debe ser un string no vacío/],
    ['estado fuera del vocabulario', { ...completo, estado: 'activo' }, /'estado' inválido/],
    ['sin disparo', { ...completo, disparo: '   ' }, /'disparo' debe ser un string no vacío/],
    ['tablas vacía', { ...completo, tablas: [] }, /'tablas' debe ser una lista con al menos una/],
    ['no es un mapa', { } as never, /'id' debe ser un string no vacío/],
  ]
  it.each(casos)('%s ⇒ omitida con aviso nombrado', (_n, entrada, patron) => {
    const r = parseWritersConfig({ writers: [entrada] })
    expect(r.writers).toHaveLength(0)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(patron)
  })

  it('un id repetido (case-insensitive) se omite nombrando el choque', () => {
    const r = parseWritersConfig({ writers: [completo, { ...completo, id: 'SJD-Ingest-Finanzas' }] })
    expect(r.writers).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/ya fue declarado por otro escritor/)
  })
})

describe('parseWritersConfig · una tabla sin esquema se cae SOLA', () => {
  it('la tabla se omite con aviso y el escritor se CONSERVA con las demás', () => {
    const r = parseWritersConfig({ writers: [{ ...completo, tablas: ['fact_saldos', 'dbo.dim_socios'] }] })
    // REFUTARÍA: perder el escritor entero por una referencia mala castigaría a las tablas buenas.
    expect(r.writers).toHaveLength(1)
    expect(r.writers[0].tablas).toEqual(['dbo.dim_socios'])
    expect(r.warnings[0]).toMatch(/la tabla 'fact_saldos' se omite/)
  })
  it('si NINGUNA de sus tablas trae esquema, ahí sí se omite el escritor: no queda qué atribuir', () => {
    const r = parseWritersConfig({ writers: [{ ...completo, tablas: ['a', 'b'] }] })
    expect(r.writers).toHaveLength(0)
    expect(r.warnings.some((w) => /ninguna de sus 'tablas' trae esquema/.test(w))).toBe(true)
  })
})

describe('normalizarTabla', () => {
  it.each([
    ['dbo.t', 'dbo.t'],
    ['[DBO].[T]', 'dbo.t'],
    ['  Dbo.Fact  ', 'dbo.fact'],
  ])('%s ⇒ %s', (entrada, esperado) => expect(normalizarTabla(entrada)).toBe(esperado))
  it.each(['t', 'db.dbo.t', '', '.t', 'dbo.', 'dbo.t-x'])('«%s» no es cruzable ⇒ null', (entrada) => {
    expect(normalizarTabla(entrada)).toBeNull()
  })
})

describe('escritoresDe', () => {
  const cfg = parseWritersConfig({
    writers: [
      { ...completo, id: 'retirado', estado: 'retirado', tablas: ['dbo.fact_saldos'] },
      { ...completo, id: 'vigente', estado: 'vigente', tablas: ['dbo.fact_saldos'] },
      { ...completo, id: 'otra-conexion', conexion: 'ventas', tablas: ['dbo.fact_saldos'] },
    ],
  })
  it('la CONEXIÓN es parte de la llave: el escritor de un Datahouse no se atribuye al de otro', () => {
    // REFUTARÍA: dos warehouses pueden tener `dbo.fact_saldos`, y atribuir cruzado sería exactamente
    // la afirmación falsa que este registro existe para no producir.
    expect(escritoresDe(cfg, 'dbo.fact_saldos', 'finanzas').map((w) => w.id)).toEqual(['vigente', 'retirado'])
    expect(escritoresDe(cfg, 'dbo.fact_saldos', 'ventas').map((w) => w.id)).toEqual(['otra-conexion'])
    expect(escritoresDe(cfg, 'dbo.fact_saldos', 'inexistente')).toEqual([])
  })
  it('sin config declarada, cero escritores (y no un throw)', () => {
    expect(escritoresDe(undefined, 'dbo.x', 'y')).toEqual([])
  })
})
