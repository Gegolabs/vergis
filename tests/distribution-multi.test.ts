// `distribution` multi-métrica (#70) — barras AGRUPADAS: `metrics` (2+ series) reemplaza a `metric`.
// Aditivo: el modo singular (`metric`) queda intacto (compat por snapshot). La cota top-N ordena las
// categorías por la suma de las series y agrega «(otros)» sumando CADA serie por separado (cuadra).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec } from '@vergis/mira'
import { renderHtmlPiece, CHART_MAX_BARS, groupedTopN, type ResolvedNode } from '@vergis/capabilities'
import { VergisError, type Capability } from '@vergis/botler'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

const SINGULAR_YAML = `
mira_version: "1.0"
identity: { id: pi-dist-single, display_name: "Single", classification: internal }
piece:
  distribution: { dimension: data.d.prog, metric: data.d.plantas, title: "Por Programa" }
data:
  d:
    capability: mock-sql
    params: { sql: "SELECT prog, plantas FROM dbo.x" }
    shape: { type: rows, fields: { prog: string, plantas: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

const GROUPED_YAML = `
mira_version: "1.0"
identity: { id: pi-dist-grouped, display_name: "Grouped", classification: internal }
piece:
  distribution:
    dimension: data.cruce.programa_genetico
    metrics:
      - { field: plantas_base, label: "Base" }
      - { field: plantas_actual, label: "Actual" }
    orientation: horizontal
    title: "Programa Genético — Base vs Actual"
data:
  cruce:
    capability: mock-sql
    params: { sql: "SELECT programa_genetico, plantas_base, plantas_actual FROM dbo.x" }
    shape: { type: rows, fields: { programa_genetico: string, plantas_base: number, plantas_actual: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

function mockSql(rows: Record<string, unknown>[]): Capability {
  return { name: 'mock-sql', async execute() { return { rows } } }
}
async function render(yaml: string, rows: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-distm-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yaml)
  return runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql(rows)] })
}

describe('distribution singular · compat (modo `metric` intacto)', () => {
  it('un distribution singular sigue dibujando barras (aditivo, sin regresión)', async () => {
    const out = await render(SINGULAR_YAML, [{ prog: 'P1', plantas: 10 }, { prog: 'P2', plantas: 6 }])
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(html).toContain('Por Programa')
    expect(html).toMatch(/role-mark/)
    // 2 categorías × 1 serie = 2 barras, + 1 contenedor de la capa de rótulos (#80) = 3.
    expect((html.match(/role-mark/g) ?? []).length).toBe(2 + 1)
  })
})

describe('distribution multi-métrica · validación', () => {
  it('modo agrupado bien formado pasa', () => {
    expect(() => validate(parseSpec(GROUPED_YAML))).not.toThrow()
  })

  it('declarar `metric` y `metrics` a la vez → colisión', () => {
    const bad = GROUPED_YAML.replace(
      'dimension: data.cruce.programa_genetico',
      'dimension: data.cruce.programa_genetico\n    metric: data.cruce.plantas_base',
    )
    expect(() => validate(parseSpec(bad))).toThrow(/mutuamente excluyentes/)
  })

  it('serie con campo inexistente en shape → rechazo (dangling)', () => {
    const bad = GROUPED_YAML.replace('field: plantas_actual', 'field: no_existe')
    expect(() => validate(parseSpec(bad))).toThrow(/no está declarada en data\.cruce\.shape\.fields/)
  })

  it('serie sin `field` → rechazo', () => {
    const bad = GROUPED_YAML.replace('- { field: plantas_actual, label: "Actual" }', '- { label: "Actual" }')
    expect(() => validate(parseSpec(bad))).toThrow(/requiere 'field'/)
  })
})

describe('distribution multi-métrica · render', () => {
  it('2 series agrupadas → marcas por (categoría × serie) + leyenda con ambas etiquetas', async () => {
    const out = await render(GROUPED_YAML, [
      { programa_genetico: 'G1', plantas_base: 10, plantas_actual: 14 },
      { programa_genetico: 'G2', plantas_base: 6, plantas_actual: 5 },
      { programa_genetico: 'G3', plantas_base: 3, plantas_actual: 9 },
    ])
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(html).toContain('Programa Genético — Base vs Actual')
    // 3 categorías × 2 series = 6 barras, + 1 contenedor de rótulos (#80) = 7 (chart NO vacío).
    expect((html.match(/role-mark/g) ?? []).length).toBe(6 + 1)
    // Leyenda con las dos etiquetas de serie.
    expect(html).toContain('>Base<')
    expect(html).toContain('>Actual<')
  })

  it('3 series agrupadas → 3×3 = 9 barras (+ la capa de rótulos)', async () => {
    const yaml3 = GROUPED_YAML.replace(
      '      - { field: plantas_actual, label: "Actual" }',
      '      - { field: plantas_actual, label: "Actual" }\n      - { field: plantas_meta, label: "Meta" }',
    ).replace('plantas_actual: number }', 'plantas_actual: number, plantas_meta: number }')
    const out = await render(yaml3, [
      { programa_genetico: 'G1', plantas_base: 10, plantas_actual: 14, plantas_meta: 12 },
      { programa_genetico: 'G2', plantas_base: 6, plantas_actual: 5, plantas_meta: 7 },
      { programa_genetico: 'G3', plantas_base: 3, plantas_actual: 9, plantas_meta: 8 },
    ])
    expect(out.ok).toBe(true)
    expect(((out.html ?? '').match(/role-mark/g) ?? []).length).toBe(9 + 1)
    expect(out.html ?? '').toContain('>Meta<')
  })

  it('render agrupado del ResolvedNode directo dibuja marcas', async () => {
    const piece: ResolvedNode = {
      type: 'distribution',
      dimensionField: 'prog',
      metricsSpec: [{ field: 'a', label: 'A' }, { field: 'b', label: 'B' }],
      rows: [{ prog: 'x', a: 1, b: 2 }, { prog: 'y', a: 3, b: 4 }],
    }
    const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol' }, { agent: 't' })) as { html: string }
    expect((html.match(/role-mark/g) ?? []).length).toBe(4 + 1)
  })
})

describe('distribution multi-métrica · cota top-N «(otros)» cuadra por serie', () => {
  it('sobre CHART_MAX_BARS: «(otros)» suma cada serie por separado y el total por serie se conserva', () => {
    const fields = ['s1', 's2']
    const n = CHART_MAX_BARS + 12
    const rows = Array.from({ length: n }, (_, i) => ({ dim: `d${i}`, s1: n - i, s2: (i % 5) + 1 }))
    const totalS1 = rows.reduce((s, r) => s + r.s1, 0)
    const totalS2 = rows.reduce((s, r) => s + r.s2, 0)
    const { rows: out, grouped } = groupedTopN(rows, 'dim', fields, CHART_MAX_BARS)
    expect(grouped).toBe(true)
    // CHART_MAX_BARS categorías + 1 «(otros)».
    expect(out.length).toBe(CHART_MAX_BARS + 1)
    const otros = out[out.length - 1]
    expect(otros.dim).toBe('(otros)')
    // El total de CADA serie sobre todas las barras dibujadas = el total original de esa serie.
    const drawnS1 = out.reduce((s, r) => s + (Number(r.s1) || 0), 0)
    const drawnS2 = out.reduce((s, r) => s + (Number(r.s2) || 0), 0)
    expect(drawnS1).toBe(totalS1)
    expect(drawnS2).toBe(totalS2)
  })

  it('≤ CHART_MAX_BARS: sin colapsar', () => {
    const rows = [{ dim: 'a', s1: 1, s2: 2 }, { dim: 'b', s1: 3, s2: 4 }]
    const { rows: out, grouped } = groupedTopN(rows, 'dim', ['s1', 's2'], CHART_MAX_BARS)
    expect(grouped).toBe(false)
    expect(out).toBe(rows)
  })
})

// Mantiene el import de VergisError vinculado (los .toThrow usan mensajes; este chequeo ancla el tipo).
it('los rechazos de validación son VergisError', () => {
  const bad = GROUPED_YAML.replace('field: plantas_actual', 'field: no_existe')
  expect(() => validate(parseSpec(bad))).toThrow(VergisError)
})
