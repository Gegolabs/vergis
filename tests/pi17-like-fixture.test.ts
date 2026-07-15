// Verificación cruzada del trío de primitivas (WP4): una página estilo PI-17 que combina una fila de
// KPIs + un `series` de 2 series + dos `distribution` agrupados. Comprueba que el árbol compone y
// renderiza SIN errores y que cada chart dibuja marcas (regla a/05 paso 7: «gráfico vacío, dato
// correcto» se detecta contando `role-mark` — un chart vacío no tendría ninguna).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import type { Capability } from '@vergis/botler'

const YAML = `
mira_version: "1.0"
identity: { id: pi-17-like, display_name: "PI-17-like — trío de primitivas", classification: internal }
piece:
  layout: rows
  elements:
    - layout: grid
      columns: 3
      elements:
        - kpi: { label: "Plantas Base", agg: { op: sum, field: base, dataset: cruce_prog } }
        - kpi: { label: "Plantas Actual", agg: { op: sum, field: actual, dataset: cruce_prog } }
        - dato: { label: "Corte", value: data.encab.corte, format: date }
    - series:
        data: data.acum
        x: mes
        metrics:
          - { field: acum_base, label: "Base" }
          - { field: acum_actual, label: "Actual" }
        title: "Acumulado mensual — Base vs Actual"
    - layout: grid
      columns: 2
      elements:
        - distribution:
            dimension: data.cruce_prog.programa
            metrics:
              - { field: base, label: "Base" }
              - { field: actual, label: "Actual" }
            title: "Programa Genético — Base vs Actual"
        - distribution:
            dimension: data.cruce_var.variedad
            metrics:
              - { field: base, label: "Base" }
              - { field: actual, label: "Actual" }
            title: "Variedad — Base vs Actual"
data:
  encab:
    capability: mock-sql
    params: { sql: "SELECT corte FROM enc" }
    shape: { type: single_row, fields: { corte: string } }
  acum:
    capability: mock-sql
    params: { sql: "SELECT mes, acum_base, acum_actual FROM acum" }
    shape: { type: rows, fields: { mes: string, acum_base: number, acum_actual: number } }
  cruce_prog:
    capability: mock-sql
    params: { sql: "SELECT programa, base, actual FROM prog" }
    shape: { type: rows, fields: { programa: string, base: number, actual: number } }
  cruce_var:
    capability: mock-sql
    params: { sql: "SELECT variedad, base, actual FROM var" }
    shape: { type: rows, fields: { variedad: string, base: number, actual: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

// Un solo mock que despacha por la tabla de la query (cada dataset trae su propio SQL).
const mockSql: Capability = {
  name: 'mock-sql',
  async execute(params: unknown): Promise<unknown> {
    const sql = String((params as { sql?: string })?.sql ?? '')
    if (sql.includes('FROM enc')) return { rows: [{ corte: '2026-07-14T00:00:00.000Z' }] }
    if (sql.includes('FROM acum'))
      return {
        rows: [
          { mes: 'ene', acum_base: 100, acum_actual: 120 },
          { mes: 'feb', acum_base: 220, acum_actual: 260 },
          { mes: 'mar', acum_base: 330, acum_actual: 410 },
        ],
      }
    if (sql.includes('FROM prog'))
      return {
        rows: [
          { programa: 'G1', base: 40, actual: 52 },
          { programa: 'G2', base: 25, actual: 20 },
          { programa: 'G3', base: 12, actual: 18 },
        ],
      }
    if (sql.includes('FROM var'))
      return {
        rows: [
          { variedad: 'V1', base: 30, actual: 33 },
          { variedad: 'V2', base: 18, actual: 14 },
        ],
      }
    return { rows: [] }
  },
}

/** Marcas `role-mark` dentro de cada `<section class="chart">` del HTML. */
function roleMarksPerChart(html: string): number[] {
  const counts: number[] = []
  let from = 0
  for (;;) {
    const start = html.indexOf('<section class="chart">', from)
    if (start === -1) break
    let end = html.indexOf('<section class="chart">', start + 1)
    if (end === -1) end = html.length
    const frag = html.slice(start, end)
    counts.push((frag.match(/role-mark/g) ?? []).length)
    from = start + 1
  }
  return counts
}

describe('WP4 · fixture PI-17-like (KPIs + series + 2 distribution agrupados)', () => {
  it('la página compone y renderiza sin errores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-pi17-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, YAML)
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql] })
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    // Ningún elemento cayó al comentario «no soportado» (typo/whitelist).
    expect(html).not.toContain('no soportado en v0.1')
    // Los tres títulos de chart presentes.
    expect(html).toContain('Acumulado mensual — Base vs Actual')
    expect(html).toContain('Programa Genético — Base vs Actual')
    expect(html).toContain('Variedad — Base vs Actual')
    // El `dato` (fecha de corte) recortado a YYYY-MM-DD.
    expect(html).toContain('<span class="dato-v">2026-07-14</span>')
  })

  it('cada chart dibuja marcas (role-mark > 0) con conteo coherente con la cardinalidad', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-pi17-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, YAML)
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql] })
    const html = out.html ?? ''
    const marks = roleMarksPerChart(html)
    // 3 charts: series (2 series × 3 meses) + distribution prog (3 cat × 2 series = 6) + var (2 × 2 = 4).
    expect(marks.length).toBe(3)
    for (const m of marks) expect(m).toBeGreaterThan(0)
    // Las barras agrupadas: conteo = categorías × series (detección de chart vacío).
    expect(marks).toContain(6) // programa: 3 × 2
    expect(marks).toContain(4) // variedad: 2 × 2
  })
})
