// `series` (#69) — líneas de N series sobre un eje. Formato wide (una columna por serie), fold en
// Vega-Lite. El eje x es ORDINAL en el ORDEN DE LLEGADA de las filas (el SQL manda; no se re-ordena
// alfabético). authz-blind, SVG estático server-side, mismo LRU de charts.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec } from '@vergis/mira'
import { renderHtmlPiece, chartCacheStats, type ResolvedNode } from '@vergis/capabilities'
import { VergisError, type Capability } from '@vergis/botler'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

const YAML = `
mira_version: "1.0"
identity: { id: pi-series-test, display_name: "Series Test", classification: internal }
piece:
  series:
    data: data.acumulado
    x: mes
    metrics:
      - { field: acumulado_base, label: "Base" }
      - { field: acumulado_actual, label: "Actual" }
    format: int_0
    title: "Acumulado mensual — Base vs Actual"
data:
  acumulado:
    capability: mock-sql
    params: { sql: "SELECT mes, acumulado_base, acumulado_actual FROM dbo.x" }
    shape: { type: rows, fields: { mes: string, acumulado_base: number, acumulado_actual: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

function mockSql(rows: Record<string, unknown>[]): Capability {
  return { name: 'mock-sql', async execute() { return { rows } } }
}
async function render(yaml: string, rows: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-series-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yaml)
  return runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql(rows)] })
}

describe('series · validación', () => {
  it('un series bien formado pasa', () => {
    expect(() => validate(parseSpec(YAML))).not.toThrow()
  })

  it('`data` colgante (dataset inexistente) → rechazo', () => {
    const bad = YAML.replace('data: data.acumulado', 'data: data.fantasma')
    // El dataset colgante lo caza el barrido de refs (paso 2) antes que la validación de series.
    expect(() => validate(parseSpec(bad))).toThrow(VergisError)
  })

  it('`x` con campo inexistente en shape → rechazo', () => {
    const bad = YAML.replace('x: mes', 'x: no_existe')
    expect(() => validate(parseSpec(bad))).toThrow(/no está declarado en data\.acumulado\.shape\.fields/)
  })

  it('serie con campo inexistente → rechazo (dangling)', () => {
    const bad = YAML.replace('field: acumulado_actual', 'field: no_existe')
    expect(() => validate(parseSpec(bad))).toThrow(/no está declarada en data\.acumulado\.shape\.fields/)
  })

  it('sin `metrics` → rechazo', () => {
    const bad = YAML.replace(/    metrics:\n(      - .*\n)+/, '    dummy: 1\n')
    expect(() => validate(parseSpec(bad))).toThrow(/requiere 'metrics'/)
  })
})

describe('series · render', () => {
  it('2 series dibujan marcas y leyenda con ambas etiquetas', async () => {
    const out = await render(YAML, [
      { mes: 'ene', acumulado_base: 10, acumulado_actual: 12 },
      { mes: 'feb', acumulado_base: 22, acumulado_actual: 25 },
      { mes: 'mar', acumulado_base: 30, acumulado_actual: 40 },
    ])
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(html).toContain('Acumulado mensual — Base vs Actual')
    expect(html).toContain('<section class="chart">')
    expect(html).toMatch(/role-mark/) // el chart dibujó (no vacío)
    expect(html).toContain('>Base<')
    expect(html).toContain('>Actual<')
  })

  it('1 serie también dibuja', async () => {
    const yaml1 = YAML.replace('      - { field: acumulado_actual, label: "Actual" }\n', '')
    const out = await render(yaml1, [
      { mes: 'ene', acumulado_base: 1, acumulado_actual: 0 },
      { mes: 'feb', acumulado_base: 2, acumulado_actual: 0 },
    ])
    expect(out.ok).toBe(true)
    expect(out.html ?? '').toMatch(/role-mark/)
  })

  it('el eje x respeta el ORDEN DE LLEGADA de las filas (el SQL manda, NO alfabético)', async () => {
    // Filas en orden mar → ene → feb: el eje debe seguir ese orden, no re-ordenarse alfabéticamente.
    const piece: ResolvedNode = {
      type: 'series',
      title: 'Orden',
      xField: 'mes',
      seriesSpec: [{ field: 'v', label: 'V' }],
      rows: [{ mes: 'mar', v: 3 }, { mes: 'ene', v: 1 }, { mes: 'feb', v: 2 }],
    }
    const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol' }, { agent: 't' })) as { html: string }
    const iMar = html.indexOf('>mar<')
    const iEne = html.indexOf('>ene<')
    const iFeb = html.indexOf('>feb<')
    expect(iMar).toBeGreaterThanOrEqual(0)
    // Orden de aparición en el SVG = orden de llegada (mar, ene, feb), no alfabético (ene, feb, mar).
    expect(iMar).toBeLessThan(iEne)
    expect(iEne).toBeLessThan(iFeb)
  })

  it('caché: segundo render con los mismos datos → HIT (no recompila Vega)', async () => {
    const piece: ResolvedNode = {
      type: 'series',
      xField: 'mes',
      seriesSpec: [{ field: 'a', label: 'A' }],
      rows: [{ mes: 'e', a: 991 }, { mes: 'f', a: 992 }], // datos únicos de este test
    }
    const first = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol' }, { agent: 't' })) as { html: string }
    const h0 = chartCacheStats.hits
    const second = (await renderHtmlPiece.execute(
      { piece: { ...piece, rows: [{ mes: 'e', a: 991 }, { mes: 'f', a: 992 }] }, title: 'X', theme: 'arbol' },
      { agent: 't' },
    )) as { html: string }
    expect(chartCacheStats.hits).toBe(h0 + 1)
    expect(second.html).toBe(first.html)
  })
})
