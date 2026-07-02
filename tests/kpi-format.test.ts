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
