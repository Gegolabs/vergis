// El banco de pruebas `examples/charts-lab.yaml` es el fixture de QA visual del paquete de charts
// (#79 leyenda · #80 rótulos · #81 orden). Este test lo ancla: si el ejemplo se pudre —un spec que
// ya no valida, un chart que deja de dibujar— se entera CI, no el revisor mirando el PDF.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'

const SPEC = resolve(fileURLToPath(new URL('../examples/charts-lab.yaml', import.meta.url)))

let work: string
let html = ''
beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'vergis-charts-lab-'))
  const out = await runSpec({ specPath: SPEC, baseDir: work })
  expect(out.ok).toBe(true)
  html = out.html ?? ''
})
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** Fragmento HTML de cada `<section class="chart">`. */
function chartSections(h: string): string[] {
  const parts = h.split('<section class="chart">').slice(1)
  return parts.map((p) => p.slice(0, p.indexOf('</section>')))
}

/** Etiquetas del eje categórico, en el orden en que Vega las emite. */
function order(section: string, cats: string[]): string[] {
  const set = new Set(cats)
  return [...section.matchAll(/>([^<>]+)<\/text>/g)].map((m) => m[1]).filter((t) => set.has(t))
}

describe('examples/charts-lab.yaml · banco de pruebas de charts', () => {
  it('renderiza los 6 charts declarados', () => {
    expect(chartSections(html).length).toBe(6)
  })

  it('ningún chart sale vacío: todos dibujan marcas', () => {
    for (const s of chartSections(html)) {
      expect((s.match(/role-mark/g) ?? []).length).toBeGreaterThan(0)
    }
  })

  it('#81 · los tres criterios de sort producen tres órdenes DISTINTOS sobre el mismo dato', () => {
    const T = ['T1', 'T2', 'T3', 'T4']
    const secs = chartSections(html)
    const chrono = order(secs[0], T)
    const magnitude = order(secs[1], T)
    const value = order(secs[2], T)
    expect(chrono).toEqual(['T1', 'T2', 'T3', 'T4']) // el orden de llegada del dato
    expect(magnitude).toEqual(['T2', 'T4', 'T3', 'T1']) // suma Plan+Real descendente
    expect(value).toEqual(['T2', 'T3', 'T4', 'T1']) // solo la serie Real, descendente
    expect(new Set([chrono, magnitude, value].map((o) => o.join('|'))).size).toBe(3)
  })

  it('#79 · los charts multi-serie traen leyenda; los mono-métrica no', () => {
    const secs = chartSections(html)
    for (const i of [0, 1, 2, 5]) expect(secs[i], `chart ${i}`).toContain('role-legend')
    for (const i of [3, 4]) expect(secs[i], `chart ${i}`).not.toContain('role-legend')
  })

  it('#80 · sin `format` el rótulo abrevia; con `format: int_0` va completo', () => {
    const secs = chartSections(html)
    expect(secs[3]).toContain('>1,2M</text>')
    expect(secs[3]).not.toContain('>1.234.567</text>')
    expect(secs[4]).toContain('>1.234.567</text>')
  })

  it('#80 · barras agrupadas: un rótulo por sub-barra (4 categorías × 2 series)', () => {
    const s = chartSections(html)[0]
    const i = s.indexOf('mark-text role-mark')
    const seg = s.slice(i, s.indexOf('</g>', i))
    expect([...seg.matchAll(/>([^<>]*)<\/text>/g)].length).toBe(8)
  })
})
