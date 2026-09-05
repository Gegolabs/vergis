/**
 * PUBLICAR ES COPIAR UN ARCHIVO (H3 · D-75). Lo que se mide acá es que el catálogo del Let se refresca
 * SIN reconstruir nada: el caché es por `mtime`, así que la guía nueva aparece en el request
 * siguiente y el watch del nodo solo adelanta la invalidación. Y la contracara, que es la regla
 * editorial: un id que reaparece con otro sha se sirve igual y se avisa UNA vez.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crearInstrumentos, type Instrumentos } from '@vergis/daftar'

let dir: string
let logs: string[]
let instrumentos: Instrumentos

const guia = (titulo: string) => JSON.stringify({ title: titulo, student: 'ana', sections: [{ type: 'reading', exercises: [] }] })

/** Escribe y ADELANTA el mtime: dos escrituras en el mismo milisegundo son indistinguibles para un
 *  caché por mtime, y sin esto el test mediría el reloj del sistema de archivos, no el caché. */
function publicar(id: string, contenido: string, segundos = 0): void {
  const f = join(dir, 'guides', `${id}.json`)
  writeFileSync(f, contenido)
  if (segundos) {
    const t = new Date(Date.now() + segundos * 1000)
    utimesSync(f, t, t)
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'h3-hot-'))
  mkdirSync(join(dir, 'guides'), { recursive: true })
  logs = []
  instrumentos = crearInstrumentos({ dir, log: (m) => logs.push(m) })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('daftar · instrumentos en caliente', () => {
  it('una guía COPIADA al directorio aparece en el listado siguiente, sin reconstruir nada', () => {
    expect(instrumentos.listar()).toEqual([])
    publicar('nueva', guia('Recién publicada'))
    expect(instrumentos.listar().map((m) => m.id)).toEqual(['nueva'])
    expect(instrumentos.guia('nueva')!.meta.title).toBe('Recién publicada')
  })

  it('una guía RETIRADA del directorio desaparece', () => {
    publicar('efimera', guia('X'))
    expect(instrumentos.listar()).toHaveLength(1)
    rmSync(join(dir, 'guides', 'efimera.json'))
    expect(instrumentos.listar()).toEqual([])
  })

  it('el mismo id con otro contenido se SIRVE igual, y el aviso de inmutabilidad sale UNA vez', () => {
    publicar('g1', guia('Versión 1'))
    expect(instrumentos.guia('g1')!.meta.title).toBe('Versión 1')
    publicar('g1', guia('Versión 2'), 5)
    expect(instrumentos.guia('g1')!.meta.title).toBe('Versión 2')
    publicar('g1', guia('Versión 3'), 10)
    expect(instrumentos.guia('g1')!.meta.title).toBe('Versión 3')
    expect(logs.filter((l) => l.includes('cambió de sha'))).toHaveLength(1)
    expect(logs[0]).toContain('INMUTABLE')
  })

  it('con el MISMO mtime no se relee el disco: el caché es lo que evita parsear por request', () => {
    publicar('g1', guia('Original'))
    expect(instrumentos.guia('g1')!.meta.title).toBe('Original')
    const t = new Date(2026, 0, 1)
    utimesSync(join(dir, 'guides', 'g1.json'), t, t)
    instrumentos.invalidar()
    expect(instrumentos.guia('g1')!.meta.title).toBe('Original') // se re-cachea con ese mtime
    writeFileSync(join(dir, 'guides', 'g1.json'), guia('Editada'))
    utimesSync(join(dir, 'guides', 'g1.json'), t, t) // contenido nuevo, mtime IDÉNTICO
    expect(instrumentos.guia('g1')!.meta.title).toBe('Original')
    // …y `invalidar()` —lo que el watch del nodo llama— es lo que lo desatasca.
    instrumentos.invalidar()
    expect(instrumentos.guia('g1')!.meta.title).toBe('Editada')
  })

  it('un JSON roto se omite con log y NO tumba el catálogo del resto', () => {
    publicar('buena', guia('Buena'))
    publicar('rota', '{ esto no es json')
    expect(instrumentos.listar().map((m) => m.id)).toEqual(['buena'])
    expect(logs.some((l) => l.includes('ilegible'))).toBe(true)
  })

  it('un directorio inexistente da catálogo vacío, no una excepción', () => {
    expect(crearInstrumentos({ dir: '/no/existe/en/ningun/lado', log: () => {} }).listar()).toEqual([])
  })
})
