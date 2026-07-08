// Recuperación de datasets de página EN PARALELO (work/052 F2): antes el loop hacía un `await` por
// dataset → la latencia era la SUMA de las queries. Con `Promise.all` es el MÁXIMO. La capability
// instrumentada registra timestamps: los dos datasets deben ARRANCAR sin esperarse (solapamiento).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import type { Capability } from '@vergis/botler'

const YAML = `
mira_version: "1.0"
identity: { id: pi-par, display_name: "Paralelo", classification: internal }
piece:
  layout: rows
  elements:
    - table: { data: data.uno, columns: [{ field: x, label: X }] }
    - table: { data: data.dos, columns: [{ field: x, label: X }] }
data:
  uno: { capability: slow-sql, params: { sql: "SELECT x FROM dbo.uno" } }
  dos: { capability: slow-sql, params: { sql: "SELECT x FROM dbo.dos" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

function makeSlowCap(delayMs: number) {
  const starts: number[] = []
  const ends: number[] = []
  const cap: Capability = {
    name: 'slow-sql',
    async execute(): Promise<unknown> {
      starts.push(Date.now())
      await new Promise((r) => setTimeout(r, delayMs))
      ends.push(Date.now())
      return { rows: [{ x: 1 }] }
    },
  }
  return { cap, starts, ends }
}

describe('recuperación de datasets · paralela (Promise.all)', () => {
  it('dos datasets de página arrancan solapados (max(inicios) < min(fines))', async () => {
    const { cap, starts, ends } = makeSlowCap(60)
    const dir = mkdtempSync(join(tmpdir(), 'vergis-par-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, YAML)
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [cap] })
    expect(out.ok).toBe(true)
    expect(starts.length).toBe(2)
    expect(ends.length).toBe(2)
    // Prueba load-independiente de paralelismo: ambos datasets ARRANCAN antes de que cualquiera
    // TERMINE (max(inicios) < min(fines)). Con la recuperación secuencial vieja, el 2º inicio ocurría
    // DESPUÉS del 1er fin (60ms de delay) → esta desigualdad no se cumpliría.
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends))
  })
})
