// Formato de la comparación de un KPI (work/052 F6): antes estaba hardcodeado a int_0 en el server y en
// el runtime client-side → un KPI de porcentaje mostraba la comparación como entero (0.5 → "1" en vez de
// "50.0%"). Ahora respeta node.format (el mismo del valor principal).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import type { Capability } from '@vergis/botler'

const YAML = `
mira_version: "1.0"
identity: { id: pi-kpi-fmt, display_name: "KPI fmt", classification: internal }
piece:
  kpi:
    label: "Asistencia"
    format: percent_1
    metric: data.m.hoy
    comparison: data.m.prev
    comparison_label: "vs semana pasada"
data:
  m:
    capability: mock-sql
    params: { sql: "SELECT hoy, prev FROM dbo.m" }
    shape: { type: single_row, fields: { hoy: number, prev: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

const mockSql: Capability = {
  name: 'mock-sql',
  async execute() { return { rows: [{ hoy: 0.432, prev: 0.5 }] } },
}

describe('KPI · la comparación respeta el format del KPI', () => {
  it('format percent_1: valor 43.2% y comparación 50.0% (no el entero "1")', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-kpi-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, YAML)
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql] })
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(html).toContain('43.2%') // valor principal
    expect(html).toContain('vs semana pasada 50.0%') // comparación EN PORCENTAJE
    // No debe aparecer la comparación formateada como entero (el bug hardcodeaba int_0 → "1").
    expect(html).not.toContain('vs semana pasada 1<')
  })
})

// Regresión (bug PRE-EXISTENTE del renderer, destapado por entrega-primero del plan 100 al previsualizar
// specs de Miranda): un KPI con `accent: true` (BOOLEANO — el schema no constriñe `accent`, típico de un
// autor que quiere «resaltar») reventaba el render con `s.replace is not a function` — `escapeHtml`
// recibía el booleano en `render-html-piece.ts`. La preview daba 500 → el lienzo de la etapa C embebía un
// error. Fix: coerción a string en el sitio (accent es contractualmente un nombre de color).
const ACCENT_YAML = `
mira_version: "1.0"
identity: { id: pi-accent, display_name: "Accent", classification: internal }
piece:
  kpi:
    label: "Resultado"
    format: int_0
    metric: data.m.total
    accent: true
data:
  m:
    capability: mock-sql
    params: { sql: "SELECT total FROM dbo.m" }
    shape: { type: single_row, fields: { total: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

describe('KPI · accent booleano NO revienta el render (regresión pre-existente)', () => {
  it('accent: true → render OK y data-accent="true", sin TypeError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-accent-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, ACCENT_YAML)
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [{ name: 'mock-sql', async execute() { return { rows: [{ total: 12345 }] } } } as Capability] })
    expect(out.ok).toBe(true) // antes: false + fallback agéntico por el TypeError
    const html = out.html ?? ''
    expect(html).toContain('data-accent="true"') // el booleano se coacciona, no rompe
    expect(html).toContain('12.345') // el valor se formatea (int_0)
  })
})

// Plan 102 · Etapa A: la preview de Miranda se sirve SIEMPRE en tema blanco (un reporte se lee como
// documento; el chrome oscuro no debe teñirlo). Un dashboard (KPI) por defecto iría en gruvbox oscuro;
// el override de paleta (que renderPreviewHtml pasa como `palette: 'blanco'`) lo fuerza a blanco.
const BLANCO_YAML = `
mira_version: "1.0"
identity: { id: pi-blanco, display_name: "Blanco", classification: internal }
piece:
  kpi: { label: "Total", format: int_0, metric: data.m.total }
data:
  m:
    capability: mock-sql
    params: { sql: "SELECT total FROM dbo.m" }
    shape: { type: single_row, fields: { total: number } }
quality: {}
delivery: { render: [{ format: html, target: web, theme: roble }] }
`

describe('preview · tema blanco forzado (plan 102 etapa A)', () => {
  it('palette override "blanco" → el HTML lleva data-palette="blanco" (aunque sea dashboard)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-blanco-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, BLANCO_YAML) // theme roble + KPI → dashboard (default gruvbox oscuro sin override)
    const cap = { name: 'mock-sql', async execute() { return { rows: [{ total: 1 }] } } } as Capability
    const conBlanco = await runSpec({ specPath, baseDir: dir, extraCapabilities: [cap], palette: 'blanco' })
    expect(conBlanco.ok).toBe(true)
    // El ATRIBUTO del <html> (no el string suelto, que también vive en el CSS de las 3 paletas).
    expect(conBlanco.html ?? '').toMatch(/<html[^>]*data-palette="blanco"/)
    // Sin el override, el mismo dashboard sale en la paleta oscura por defecto (gruvbox), no blanco.
    const sinBlanco = await runSpec({ specPath, baseDir: dir, extraCapabilities: [cap] })
    expect(sinBlanco.html ?? '').not.toMatch(/<html[^>]*data-palette="blanco"/)
    expect(sinBlanco.html ?? '').toMatch(/<html[^>]*data-palette="gruvbox"/)
  })
})
