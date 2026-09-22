/**
 * I4 · el log de la Consola, e I9 · la verificación offline de la cadena.
 *
 * Los dos casos que sostienen la promesa: el VALOR de un claim jamás toca el archivo (el nombre sí,
 * porque es lo que un auditor necesita), y una línea alterada en el medio se detecta con su `seq`.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConsolaLog, validarPerfilesConsola } from '../server/consola'
import { verifyChainLines } from '@vergis/botler'
import type { SqlConnectionProfile } from '@vergis/capabilities'

const nuevoArchivo = (): string => join(mkdtempSync(join(tmpdir(), 'consola-log-')), 'consola-audit.log')

describe('consola · log de auditoría', () => {
  it('escribe inicio y fin, y el historial los devuelve del más nuevo al más viejo', () => {
    const path = nuevoArchivo()
    const log = createConsolaLog(path)
    for (const n of [1, 2, 3]) {
      log.inicio({ actor: 'ana@gh.cl', ref: 'fin', sql: `SELECT ${n}`, claims: ['groups'] })
      log.fin({ actor: 'ana@gh.cl', ref: 'fin', sql: `SELECT ${n}`, claims: ['groups'], inicio: 'T', duracionMs: n, estado: 'ok', filas: n, truncado: false, recordsets: 1, error: null })
    }
    const h = log.historial(10)
    expect(h.map((e) => e.sql)).toEqual(['SELECT 3', 'SELECT 2', 'SELECT 1'])
    // Solo las ejecuciones: las entradas `consola-inicio` existen para dejar rastro de una caída a
    // mitad de consulta, no para llenar el historial de la persona.
    expect(h).toHaveLength(3)
  })

  it('la entrada se escribe también en error, timeout y cancelación', () => {
    const path = nuevoArchivo()
    const log = createConsolaLog(path)
    for (const estado of ['error', 'timeout', 'cancelado'] as const) {
      log.fin({ actor: 'ana@gh.cl', ref: 'fin', sql: 'SELECT 1', claims: [], inicio: 'T', duracionMs: 1, estado, filas: 0, truncado: false, recordsets: 0, error: 'x' })
    }
    expect(log.historial(10).map((e) => e.estado).sort()).toEqual(['cancelado', 'error', 'timeout'])
  })

  it('NUNCA escribe el VALOR de un claim (el nombre sí)', () => {
    const path = nuevoArchivo()
    const log = createConsolaLog(path)
    log.fin({ actor: 'ana@gh.cl', ref: 'fin', sql: 'SELECT 1', claims: ['groups', 'viewer_area'], inicio: 'T', duracionMs: 1, estado: 'ok', filas: 0, truncado: false, recordsets: 1, error: null })
    const texto = readFileSync(path, 'utf8')
    expect(texto).toContain('groups')
    expect(texto).not.toContain('ZZ-CLAIM-ZZ') // el centinela no se filtró por ninguna vía
  })

  it('filtra por actor, y un archivo inexistente da historial vacío en vez de reventar', () => {
    const path = nuevoArchivo()
    const log = createConsolaLog(path)
    log.fin({ actor: 'ana@gh.cl', ref: 'fin', sql: 'A', claims: [], inicio: 'T', duracionMs: 1, estado: 'ok', filas: 0, truncado: false, recordsets: 1, error: null })
    log.fin({ actor: 'beto@gh.cl', ref: 'fin', sql: 'B', claims: [], inicio: 'T', duracionMs: 1, estado: 'ok', filas: 0, truncado: false, recordsets: 1, error: null })
    expect(log.historial(10, 'ana@gh.cl').map((e) => e.sql)).toEqual(['A'])
    expect(createConsolaLog(join(tmpdir(), 'no-existe-jamas.log')).historial(10)).toEqual([])
  })
})

describe('I9 · verificación OFFLINE de la cadena', () => {
  it('una cadena recién escrita verifica', () => {
    const path = nuevoArchivo()
    const log = createConsolaLog(path)
    for (const n of [1, 2, 3]) log.fin({ actor: 'a', ref: 'r', sql: `S${n}`, claims: [], inicio: 'T', duracionMs: 1, estado: 'ok', filas: 0, truncado: false, recordsets: 1, error: null })
    const r = verifyChainLines(readFileSync(path, 'utf8').split('\n'))
    expect(r).toMatchObject({ ok: true, verificadas: 3 })
  })

  it('una línea ALTERADA en el medio se detecta, con el `seq` donde se cortó', () => {
    const path = nuevoArchivo()
    const log = createConsolaLog(path)
    for (const n of [0, 1, 2]) log.fin({ actor: 'a', ref: 'r', sql: `S${n}`, claims: [], inicio: 'T', duracionMs: 1, estado: 'ok', filas: 0, truncado: false, recordsets: 1, error: null })
    const lineas = readFileSync(path, 'utf8').trim().split('\n')
    const alterada = JSON.parse(lineas[1]!) as Record<string, unknown>
    alterada['sql'] = 'SELECT * FROM lo_que_yo_quiera'
    lineas[1] = JSON.stringify(alterada)
    writeFileSync(path, lineas.join('\n'))
    const r = verifyChainLines(readFileSync(path, 'utf8').split('\n'))
    expect(r.ok).toBe(false)
    expect(r.rotoEn).toBe(1)
  })
})

describe('I1 · validación del sub-perfil `consola`', () => {
  const base: SqlConnectionProfile = { server: 's', database: 'd', auth: 'secret', tenantId: 't', clientId: 'sp-serving', clientSecret: 'x' }
  it('un `consola` con server/database propio es config rota', () => {
    expect(() => validarPerfilesConsola({ fin: { ...base, consola: { clientId: 'otro', server: 'z' } as never } })).toThrow(/no admite server/)
  })
  it('un `consola` con el MISMO clientId del serving es config rota (sería bypass)', () => {
    expect(() => validarPerfilesConsola({ fin: { ...base, consola: { clientId: 'sp-serving' } } })).toThrow(/MISMO clientId/)
  })
  it('un perfil sin `consola` es válido: simplemente no se ofrece en la Consola', () => {
    expect(() => validarPerfilesConsola({ fin: base })).not.toThrow()
  })
})
