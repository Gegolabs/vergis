// Degradación por staleness (work/052 §3.1/§3.2): `agentic_fallback` es PROVISIONAL mientras la
// Capa 2 cognitiva no exista — degrada a banner con log explícito en vez de matar el PI con un
// error. `show_last_valid` (sin rescate real: requiere el data-cache habilitado en la instancia)
// muestra el dato stale con banner explícito de a qué fecha corresponde («Mostrando datos al …»).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import type { Capability } from '@vergis/botler'

const yamlFor = (onStale: string) => `
mira_version: "1.0"
identity: { id: pi-stale, display_name: "Stale", classification: internal }
piece:
  table: { data: data.detalle, columns: [{ field: fecha_dato, label: Fecha }] }
data:
  detalle:
    capability: mock-sql
    params: { sql: "SELECT fecha_dato FROM dbo.d" }
    shape: { type: single_row, fields: { fecha_dato: date } }
quality:
  freshness: { source_watermark: required, max_age: P1D, watermark_field: detalle.fecha_dato }
  degradation: { on_stale: ${onStale} }
delivery: { render: [{ format: html, target: web }] }
`

// Watermark viejísimo → SIEMPRE stale contra max_age P1D.
const mockSql: Capability = {
  name: 'mock-sql',
  async execute(): Promise<unknown> {
    return { rows: [{ fecha_dato: '2020-01-01' }] }
  },
}

async function run(onStale: string) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-stale-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yamlFor(onStale))
  return runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql] })
}

describe('on_stale · degradaciones', () => {
  it('agentic_fallback (provisional, sin Capa 2) → NO mata el PI: banner + log mira-agentic-fallback-degraded', async () => {
    const out = await run('agentic_fallback')
    expect(out.ok).toBe(true) // antes: throw → PI muerto
    expect(out.html).toContain('Datos al 2020-01-01')
    expect(out.html).toContain('agentic_fallback') // el banner DICE que la cognición no está disponible
    expect(out.log.some((e) => e.type === 'mira-agentic-fallback-degraded')).toBe(true)
  })

  it('show_last_valid → banner explícito «Mostrando datos al …» (rescate real requiere el data-cache)', async () => {
    const out = await run('show_last_valid')
    expect(out.ok).toBe(true)
    expect(out.html).toContain('Mostrando datos al 2020-01-01')
  })

  it('warn_and_show → banner estándar, sigue igual', async () => {
    const out = await run('warn_and_show')
    expect(out.ok).toBe(true)
    expect(out.html).toContain('Datos al 2020-01-01')
    expect(out.html).not.toContain('Mostrando datos al')
  })

  it('refuse_render → sigue rechazando (fail-loud intacto)', async () => {
    const out = await run('refuse_render')
    expect(out.ok).toBe(false)
    expect(out.fallback?.reason).toMatch(/refuse_render/)
  })
})
