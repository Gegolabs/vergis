// Anotaciones (work/052 R3-5/R3-6): (a) el contexto puede APUNTAR la tabla destino por `dataset`
// (default: la primera tabla del árbol, como siempre); (b) las filas de la tabla anotada se COPIAN
// antes de mutar — los campos __ann/__anntok ya no contaminan otros payloads que compartan filas
// (p.ej. interactive.datasets) ni el valor del data-cache; (c) columnsSpec del spec cacheado no
// acumula la columna de anotación entre requests (compose copia el arreglo de columnas).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import type { AnnotationContext } from '@vergis/mira'
import type { Capability } from '@vergis/botler'

const YAML = `
mira_version: "1.0"
identity: { id: pi-anns, display_name: "Anns", classification: internal }
piece:
  layout: rows
  elements:
    - table:
        data: data.primera
        columns: [{ field: id, label: "ID" }, { field: area, label: "Área" }]
    - table:
        data: data.segunda
        columns: [{ field: id, label: "ID" }, { field: doc, label: "Doc" }]
interactions:
  filters: [{ dataset: primera, field: area }]
data:
  primera: { capability: mock-sql, params: { sql: "SELECT id, area FROM dbo.p" } }
  segunda: { capability: mock-sql, params: { sql: "SELECT id, doc FROM dbo.s" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

// Filas ESTABLES entre llamadas (mismo objeto devuelto) — simula el data-cache de R2, donde el valor
// cacheado comparte los objetos-fila entre requests: una mutación quedaría escrita DENTRO del caché.
const primeraRows = [
  { id: '1', area: 'A' },
  { id: '2', area: 'B' },
]
const segundaRows = [
  { id: '1', doc: 'D1' },
  { id: '2', doc: 'D2' },
]
const mockSql: Capability = {
  name: 'mock-sql',
  async execute(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sql: string }
    return { rows: /dbo\.p/.test(p.sql) ? primeraRows : segundaRows }
  },
}

const annCtx = (dataset?: string): AnnotationContext => ({
  piId: 'pi-anns',
  endpoint: '/pi-anns/annotations',
  dataset,
  resolve: async (keys) => Object.fromEntries(keys.map((k) => [k, { value: `nota-${k}`, token: `tok-${k}` }])),
})

async function render(dataset?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-anns-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, YAML)
  return { out: await runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql], annotations: annCtx(dataset) }), specPath }
}

describe('anotaciones · tabla destino por dataset', () => {
  it("dataset: 'segunda' → la anotación cae en la SEGUNDA tabla (endpoint + tokens junto a doc)", async () => {
    const { out } = await render('segunda')
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    // El payload de la tabla anotada trae la meta + tokens; el dataset anotado es el pedido.
    const payloads = [...html.matchAll(/<script type="application\/json" class="vtable-data">(.*?)<\/script>/gs)].map((m) =>
      JSON.parse(m[1].replace(/\\u003c/g, '<')),
    )
    expect(payloads).toHaveLength(2)
    const [primera, segunda] = payloads
    expect(JSON.stringify(primera)).not.toContain('__anntok')
    expect(JSON.stringify(segunda)).toContain('__anntok')
    expect(segunda.rows[0].doc).toBe('D1') // la tabla correcta
  })

  it('sin dataset → la PRIMERA tabla (comportamiento clásico)', async () => {
    const { out } = await render()
    const html = out.html ?? ''
    const payloads = [...html.matchAll(/<script type="application\/json" class="vtable-data">(.*?)<\/script>/gs)].map((m) =>
      JSON.parse(m[1].replace(/\\u003c/g, '<')),
    )
    expect(JSON.stringify(payloads[0])).toContain('__anntok')
    expect(JSON.stringify(payloads[1])).not.toContain('__anntok')
  })
})

describe('anotaciones · anti-aliasing de filas y columnas', () => {
  it('las filas ORIGINALES del resultado no se contaminan con __ann (interactive.datasets limpio)', async () => {
    const { out } = await render('primera')
    expect(out.ok).toBe(true)
    // Las filas fuente (compartidas con el caché y con interactive.datasets) quedan intactas.
    for (const r of primeraRows) {
      expect(r).not.toHaveProperty('__ann')
      expect(r).not.toHaveProperty('__anntok')
    }
    // El JSON del dashboard (var DATA = …) materializa los datasets SIN los campos de anotación.
    const html = out.html ?? ''
    const dataJson = /var DATA = (.*?), FILTERS =/s.exec(html)?.[1] ?? ''
    expect(dataJson).not.toContain('__ann')
  })

  it('el columnsSpec del spec cacheado NO acumula la columna de anotación entre requests', async () => {
    // Mismo specPath dos veces → el spec parseado se sirve del caché por mtime (run.ts). Sin la copia
    // de columnas en composePiece, el 2º render tendría DOS columnas "Anotaciones".
    const dir = mkdtempSync(join(tmpdir(), 'vergis-anns2-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, YAML)
    const opts = { specPath, baseDir: dir, extraCapabilities: [mockSql], annotations: annCtx('primera') }
    await runSpec(opts)
    const out2 = await runSpec(opts)
    const html = out2.html ?? ''
    const annCols = html.match(/"field":"__ann"/g) ?? []
    // Una vez en el payload de la única tabla anotada — no acumulada.
    expect(annCols).toHaveLength(1)
  })
})
