/**
 * PARIDAD MEDIDA del port de `render_report` (H3 · #295 · §3.7).
 *
 * El esperado NO lo escribió nadie a mano: lo produjo el `server.py` de Daftar corriendo sobre estas
 * mismas fixtures sintéticas (`tests/fixtures/daftar/generar-esperados.py`). Un test por tipo de
 * ejercicio, más el caso mixto que ejercita los totales, la nota, el peor `form`, el cronómetro y el
 * resumen de confianza. Si el port se desvía en un solo `<span>`, se pone rojo y dice en cuál.
 *
 * La comparación normaliza espacios entre etiquetas: el HTML de Python nace de f-strings con saltos
 * de línea que no significan nada para el navegador, y exigir el byte exacto convertiría un cambio
 * de formato del literal en una falla. Lo que se compara es la ESTRUCTURA y el TEXTO, entero.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderReport } from '@vergis/daftar'
import type { Guia, Progreso } from '@vergis/daftar'

const DIR = join(import.meta.dirname, 'fixtures/daftar')
const CASOS = JSON.parse(readFileSync(join(DIR, 'casos.json'), 'utf8')) as Record<string, { guide: Guia; progress: Progreso }>

/** Los mismos que el generador le inyecta a `STUDENT_INFO`. */
export const ESTUDIANTES = {
  ana: { name: 'Ana Sintética', grade: '1° Medio' },
  beto: { name: 'Beto Sintético', grade: '2° Medio' },
}

export const norm = (h: string): string => h.replace(/>\s+</g, '><').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()

describe('daftar · render_report portado — paridad contra el Python, tipo por tipo', () => {
  for (const nombre of Object.keys(CASOS).sort()) {
    it(`${nombre} → idéntico al esperado`, () => {
      const { guide, progress } = CASOS[nombre]!
      const esperado = readFileSync(join(DIR, 'esperado', `${nombre}.report.html`), 'utf8')
      // `base: ''` reproduce el `href="/"` del Python: el prefijo del Let es lo ÚNICO que el port
      // agrega, y con el prefijo vacío las dos salidas tienen que coincidir byte a byte (normalizado).
      expect(norm(renderReport(guide, progress, { estudiantes: ESTUDIANTES, base: '' }))).toBe(norm(esperado))
    })
  }

  it('el prefijo del Let es lo único que cambia con `base`', () => {
    const { guide, progress } = CASOS['fill']!
    const conBase = renderReport(guide, progress, { estudiantes: ESTUDIANTES, base: '/estudios' })
    expect(conBase).toContain('href="/estudios/"')
    expect(conBase).not.toContain('href="/"')
  })
})
