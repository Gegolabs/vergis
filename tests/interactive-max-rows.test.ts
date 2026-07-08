// Tope de materialización client-side (work/052 §2.5): con `interactions.filters` los datasets se
// embeben COMPLETOS en el HTML. Superado `interactiveMaxRows` (inyectado por el llamador — Mira no
// lee env), NO se materializa: render sin facetas + log `mira-interaction-skipped` con el tamaño.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import type { Capability } from '@vergis/botler'

const YAML = `
mira_version: "1.0"
identity: { id: pi-maxrows, display_name: "MaxRows", classification: internal }
piece:
  layout: rows
  elements:
    - table: { data: data.detalle, columns: [{ field: area, label: "Área" }, { field: v, label: V }] }
data:
  detalle: { capability: mock-sql, params: { sql: "SELECT area, v FROM dbo.d" } }
quality: {}
interactions:
  filters:
    - { dataset: detalle, field: area, label: "Área" }
delivery: { render: [{ format: html, target: web }] }
`

function mockSql(rows: number): Capability {
  return {
    name: 'mock-sql',
    async execute(): Promise<unknown> {
      return { rows: Array.from({ length: rows }, (_, i) => ({ area: i % 2 ? 'A' : 'B', v: i })) }
    },
  }
}

async function run(rows: number, interactiveMaxRows?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-maxrows-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, YAML)
  return runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql(rows)], interactiveMaxRows })
}

describe('interactions.filters · tope de materialización', () => {
  it('bajo el tope → se materializa (facetas de dashboard presentes)', async () => {
    const out = await run(10, 100)
    expect(out.ok).toBe(true)
    expect(out.html).toContain('var DATA =') // script de interacción con datasets embebidos
    expect(out.log.some((e) => e.type === 'mira-interaction')).toBe(true)
    expect(out.log.some((e) => e.type === 'mira-interaction-skipped')).toBe(false)
  })

  it('sobre el tope → NO materializa, loguea el tamaño y el render sale sin facetas', async () => {
    const out = await run(150, 100)
    expect(out.ok).toBe(true)
    expect(out.html).not.toContain('var DATA =') // sin datasets embebidos del dashboard
    expect(out.html).toContain('class="table vtable"') // la tabla sigue interactiva por su runtime
    const skipped = out.log.find((e) => e.type === 'mira-interaction-skipped')
    expect(skipped).toBeDefined()
    expect(skipped).toMatchObject({ rows: 150, max: 100 })
    expect(out.log.some((e) => e.type === 'mira-interaction')).toBe(false)
  })

  it('sin tope explícito → aplica el default de Mira (5000): 10 filas pasan', async () => {
    const out = await run(10)
    expect(out.ok).toBe(true)
    expect(out.html).toContain('var DATA =')
  })
})
