// Memoización del camino de serving (work/052 F3): el schema se parsea una vez por ruta y el spec
// (texto+YAML) se memoiza por (ruta, mtime). Un 2º request del MISMO spec no re-parsea; editar el
// archivo (mtime nuevo) invalida. Los contadores `parseCounters` lo hacen observable.
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec, parseCounters } from '@vergis/cli'
import type { Capability } from '@vergis/botler'

const YAML = `
mira_version: "1.0"
identity: { id: pi-cache, display_name: "Cache", classification: internal }
piece:
  table: { data: data.uno, columns: [{ field: x, label: X }] }
data:
  uno: { capability: mock-sql, params: { sql: "SELECT x FROM dbo.uno" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

const mockSql: Capability = { name: 'mock-sql', async execute() { return { rows: [{ x: 1 }] } } }

async function run(specPath: string, dir: string) {
  return runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql] })
}

describe('camino de serving · caché de spec+schema por request', () => {
  it('2º request del mismo spec NO re-parsea; tocar el mtime invalida', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-cache-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, YAML)

    const specBefore = parseCounters.spec
    const schemaBefore = parseCounters.schema

    const a = await run(specPath, dir)
    expect(a.ok).toBe(true)
    const specAfter1 = parseCounters.spec
    expect(specAfter1).toBe(specBefore + 1) // 1ª vez: parsea

    const b = await run(specPath, dir)
    expect(b.ok).toBe(true)
    expect(parseCounters.spec).toBe(specAfter1) // 2ª vez: caché, NO re-parsea
    expect(b.html).toBe(a.html) // mismo resultado

    // El schema NO se re-parsea entre requests (misma ruta): a lo sumo se parseó 1 vez en todo el test.
    expect(parseCounters.schema - schemaBefore).toBeLessThanOrEqual(1)

    // Tocar el mtime (edición del archivo) invalida la entrada → re-parsea.
    const future = new Date(Date.now() + 5000)
    utimesSync(specPath, future, future)
    const c = await run(specPath, dir)
    expect(c.ok).toBe(true)
    expect(parseCounters.spec).toBe(specAfter1 + 1) // mtime nuevo: re-parsea
  })
})
