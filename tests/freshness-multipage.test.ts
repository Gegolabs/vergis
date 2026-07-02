// Frescura en multi-vista (work/052 F9): en multi-vista solo se recuperan los datasets de la página
// activa. Si el `watermark_field` apunta a un dataset de OTRA página, `checkFreshness` no resolvía el
// watermark y devolvía "checked, no stale" en silencio → la garantía de frescura solo protegía la
// página que casualmente cargaba ese dataset. El fix: recuperar SIEMPRE el dataset del watermark.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import type { Capability } from '@vergis/botler'

// El watermark cuelga de `wm` (dataset de la página p1). Renderizamos la página p2 (que NO usa `wm`).
const YAML = `
mira_version: "1.0"
identity: { id: pi-fresh-mp, display_name: "Fresh MP", classification: internal }
pages:
  - id: p1
    title: "P1"
    piece: { table: { data: data.wm, columns: [{ field: fecha, label: "Fecha" }] } }
  - id: p2
    title: "P2"
    piece: { table: { data: data.otro, columns: [{ field: y, label: "Y" }] } }
data:
  wm:
    capability: mock-sql
    params: { sql: "SELECT fecha FROM dbo.wm" }
    shape: { type: single_row, fields: { fecha: date } }
  otro:
    capability: mock-sql
    params: { sql: "SELECT y FROM dbo.otro" }
quality:
  freshness: { source_watermark: required, max_age: P1D, watermark_field: wm.fecha }
delivery: { render: [{ format: html, target: web }] }
`

function makeMock(fecha: string) {
  const calls: string[] = []
  const cap: Capability = {
    name: 'mock-sql',
    async execute(params: unknown): Promise<unknown> {
      const p = (params ?? {}) as { sql: string }
      calls.push(p.sql)
      if (/dbo\.wm/.test(p.sql)) return { rows: [{ fecha }] }
      return { rows: [{ y: 1 }] }
    },
  }
  return { cap, calls }
}

async function renderPage2(fecha: string) {
  const { cap, calls } = makeMock(fecha)
  const dir = mkdtempSync(join(tmpdir(), 'vergis-fmp-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, YAML)
  const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [cap], page: 'p2' })
  return { out, calls }
}

describe('frescura multi-vista · el watermark se resuelve aun en otra página', () => {
  it('render de p2 con watermark viejo (en p1) → el dataset del watermark SÍ se consulta y sale banner stale', async () => {
    const { out, calls } = await renderPage2('2000-01-01')
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    // El dataset del watermark (wm) se recuperó aunque no pertenezca a la página activa (p2).
    expect(calls.some((s) => /dbo\.wm/.test(s))).toBe(true)
    // El check corrió DE VERDAD: banner de dato stale.
    expect(html).toContain('class="banner"')
    expect(html).toContain('2000-01-01')
  })

  it('render de p2 con watermark de HOY → sin banner (el check corre, no está stale)', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const { out } = await renderPage2(today)
    expect(out.ok).toBe(true)
    expect(out.html ?? '').not.toContain('class="banner"')
  })
})
