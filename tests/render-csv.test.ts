// Render CSV (work/052 R3-4): `delivery.render` con `format: csv` produce un artefacto CSV en
// memoria (artifacts[].content) ADEMÁS del HTML — headers = labels, valores RAW sin formatear,
// escaping RFC 4180; varias tablas → un CSV seccionado (fila-título `# ...` + línea en blanco).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { renderCsvPiece, type ResolvedNode } from '@vergis/capabilities'
import type { Capability } from '@vergis/botler'

const YAML = `
mira_version: "1.0"
identity: { id: pi-csv, display_name: "CSV Test", classification: internal }
piece:
  table:
    data: data.saldos
    columns:
      - { field: empresa, label: "Empresa" }
      - { field: saldo, label: "Saldo", format: int_0, align: right }
data:
  saldos: { capability: mock-sql, params: { sql: "SELECT empresa, saldo FROM dbo.saldo" } }
quality: {}
delivery: { render: [{ format: html, target: web }, { format: csv }] }
`

const mockSql: Capability = {
  name: 'mock-sql',
  async execute(): Promise<unknown> {
    return {
      rows: [
        { empresa: 'Agro, Sur', saldo: 1234.5 }, // coma → se cita
        { empresa: 'La "Y"', saldo: 200 }, // comillas → se citan y doblan
      ],
    }
  },
}

describe('delivery.render format csv', () => {
  it('artifacts incluye el csv con headers=labels, valores RAW y escaping correcto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-csv-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, YAML)
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql] })
    expect(out.ok).toBe(true)
    expect(out.html).toContain('<table') // el html sigue produciéndose
    const csvArt = out.artifacts.find((a) => a.format === 'csv')
    expect(csvArt).toBeDefined()
    const csv = csvArt!.content ?? ''
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe('Empresa,Saldo') // headers = labels
    expect(lines[1]).toBe('"Agro, Sur",1234.5') // coma citada; valor RAW (no formateado int_0)
    expect(lines[2]).toBe('"La ""Y""",200') // comilla doblada
  })

  it('varias tablas → un CSV seccionado con fila-título por tabla', async () => {
    const piece: ResolvedNode = {
      layout: 'rows',
      elements: [
        { type: 'table', title: 'Primera', columnsSpec: [{ field: 'a', label: 'A' }], rows: [{ a: 1 }] },
        { type: 'table', title: 'Segunda', columnsSpec: [{ field: 'b', label: 'B' }], rows: [{ b: 2 }] },
      ],
    }
    const out = (await renderCsvPiece.execute({ piece, title: 'X' }, { agent: 'test' })) as { csv: string }
    expect(out.csv).toContain('# Primera\nA\n1\n')
    expect(out.csv).toContain('# Segunda\nB\n2\n')
  })

  it('el CSV exporta las columnas declaradas: las notas no son columnas y no viajan', async () => {
    const piece: ResolvedNode = {
      type: 'table',
      columnsSpec: [{ field: 'a', label: 'A' }],
      // Aunque la fila traiga campos no declarados, solo viajan las columnas del spec.
      rows: [{ a: 1, comentario: 'no debe viajar' }],
    }
    const out = (await renderCsvPiece.execute({ piece }, { agent: 'test' })) as { csv: string }
    expect(out.csv).toBe('A\n1\n')
    expect(out.csv).not.toContain('no debe viajar')
  })

  // GH #61 / D5: la regla de celda es la compartida (`vtCsvCell`) — neutraliza la fórmula, pero
  // deja intacto el string numérico con signo (así entregan los drivers los BIGINT).
  it('neutraliza la formula injection sin corromper el string numérico con signo', async () => {
    const piece: ResolvedNode = {
      type: 'table',
      columnsSpec: [
        { field: 'link', label: 'Link' },
        { field: 'saldo', label: 'Saldo' },
      ],
      rows: [{ link: '=HYPERLINK("http://x")', saldo: '-2644239500' }],
    }
    const out = (await renderCsvPiece.execute({ piece }, { agent: 'test' })) as { csv: string }
    const lines = out.csv.trimEnd().split('\n')
    expect(lines[1]).toBe('"\'=HYPERLINK(""http://x"")",-2644239500')
  })

  it('pieza sin tablas → fail-loud (no un CSV vacío silencioso)', async () => {
    const piece: ResolvedNode = { type: 'kpi', value: 1, label: 'x' }
    await expect(renderCsvPiece.execute({ piece, title: 'SinTablas' }, { agent: 'test' })).rejects.toThrow(/tabla/)
  })

  it('bom opt-in: default sin BOM (parsers de máquina); con bom:true antepone el BOM UTF-8 (Excel)', async () => {
    const piece: ResolvedNode = { type: 'table', columnsSpec: [{ field: 'a', label: 'Á' }], rows: [{ a: 'ñ' }] }
    const plain = (await renderCsvPiece.execute({ piece }, { agent: 'test' })) as { csv: string }
    expect(plain.csv.charCodeAt(0)).not.toBe(0xfeff)
    expect(plain.csv).toBe('Á\nñ\n')
    const withBom = (await renderCsvPiece.execute({ piece, bom: true }, { agent: 'test' })) as { csv: string }
    expect(withBom.csv.charCodeAt(0)).toBe(0xfeff)
    expect(withBom.csv.slice(1)).toBe('Á\nñ\n') // el BOM solo se antepone; el resto es idéntico
  })
})
