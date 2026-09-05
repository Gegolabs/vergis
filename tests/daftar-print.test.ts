/**
 * PARIDAD MEDIDA del port de `render_print` (H3 · #295 · §3.7) — mismo instrumento que el de
 * `daftar-report.test.ts`, y además el brazo `?blank=1` (la versión para llenar a mano), que es
 * justamente el que no depende del progreso y por eso se cae distinto si el port se equivoca.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPrint } from '@vergis/daftar'
import type { Guia, Progreso } from '@vergis/daftar'
import { ESTUDIANTES, norm } from './daftar-report.test'

const DIR = join(import.meta.dirname, 'fixtures/daftar')
const CASOS = JSON.parse(readFileSync(join(DIR, 'casos.json'), 'utf8')) as Record<string, { guide: Guia; progress: Progreso }>

describe('daftar · render_print portado — paridad contra el Python, tipo por tipo', () => {
  for (const nombre of Object.keys(CASOS).sort()) {
    it(`${nombre} con respuestas → idéntico al esperado`, () => {
      const { guide, progress } = CASOS[nombre]!
      const esperado = readFileSync(join(DIR, 'esperado', `${nombre}.print.html`), 'utf8')
      expect(norm(renderPrint(guide, progress, { estudiantes: ESTUDIANTES, base: '' }))).toBe(norm(esperado))
    })
    it(`${nombre} en blanco → idéntico al esperado`, () => {
      const { guide } = CASOS[nombre]!
      const esperado = readFileSync(join(DIR, 'esperado', `${nombre}.print-blank.html`), 'utf8')
      expect(norm(renderPrint(guide, {}, { estudiantes: ESTUDIANTES, base: '', blank: true }))).toBe(norm(esperado))
    })
  }
})
