// Guardas de validación añadidas en work/052: cada una convierte un fallo SILENCIOSO en un rechazo
// accionable al validar la spec (filosofía fail-loud del DSL).
//  F5  · quality.freshness.max_age no soportado (P1W/P1M → 0 ms → staleness silenciosa).
//  F7a · delivery.render sin ningún format html → página en blanco con 200.
//  F8  · tipo de elemento desconocido en la pieza (typo → comentario HTML invisible).
//  F10 · interactions.filters con dataset/campo colgante → faceta vacía en silencio.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSpec, validateSpec } from '@vergis/mira'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

// Spec testigo VÁLIDA: layout + varios tipos de elemento + filtro + frescura correcta. Debe pasar.
const BASE = `
mira_version: "1.0"
identity: { id: pi-guards, display_name: "Guards", classification: internal }
interactions:
  filters:
    - { dataset: datos, field: area, label: "Área" }
piece:
  layout: rows
  elements:
    - kpi: { label: "Total", format: int_0, agg: { dataset: datos, op: sum, field: n } }
    - markdown_block: { content: "Hola" }
    - table: { data: data.datos, columns: [{ field: area, label: "Área" }] }
data:
  datos:
    capability: mock-sql
    params: { sql: "SELECT area, n FROM dbo.datos" }
    shape: { type: rows, fields: { area: string, n: integer } }
quality:
  freshness: { source_watermark: required, max_age: P1D, watermark_field: datos.area }
delivery: { render: [{ format: html, target: web }] }
`

describe('validate-guards · la spec testigo válida pasa', () => {
  it('BASE válida no lanza', () => {
    expect(() => validate(parseSpec(BASE))).not.toThrow()
  })
})

describe('F5 · quality.freshness.max_age', () => {
  it('P1W (semanas, no soportado por el parser) → rechazo', () => {
    const s = parseSpec(BASE.replace('max_age: P1D', 'max_age: P1W')) as Record<string, unknown>
    expect(() => validate(s)).toThrow(/max_age|soportada/)
  })
  it('P1M (meses) → rechazo', () => {
    const s = parseSpec(BASE.replace('max_age: P1D', 'max_age: P1M')) as Record<string, unknown>
    expect(() => validate(s)).toThrow(/soportada|ISO 8601/)
  })
  it('source_watermark: ignore desactiva el chequeo (max_age raro no importa)', () => {
    const s = parseSpec(
      BASE.replace('source_watermark: required, max_age: P1D', 'source_watermark: ignore, max_age: P1W'),
    ) as Record<string, unknown>
    expect(() => validate(s)).not.toThrow()
  })
})

describe('F7a · delivery.render debe incluir html', () => {
  it('render solo pdf → rechazo', () => {
    const s = parseSpec(BASE.replace('render: [{ format: html, target: web }]', 'render: [{ format: pdf }]')) as Record<string, unknown>
    expect(() => validate(s)).toThrow(/html/)
  })
  it('typo htlm → rechazo', () => {
    const s = parseSpec(BASE.replace('format: html', 'format: htlm')) as Record<string, unknown>
    expect(() => validate(s)).toThrow(/html/)
  })
})

describe('F8 · tipo de elemento desconocido en la pieza', () => {
  it('typo markdwon_block → rechazo con path del nodo', () => {
    const s = parseSpec(BASE.replace('markdown_block:', 'markdwon_block:')) as Record<string, unknown>
    expect(() => validate(s)).toThrow(/element|markdwon|reconocido/i)
  })
})

describe('F10 · interactions.filters', () => {
  it('filtro sobre dataset inexistente → rechazo', () => {
    const s = parseSpec(BASE.replace('dataset: datos, field: area', 'dataset: fantasma, field: area')) as Record<string, unknown>
    expect(() => validate(s)).toThrow(/no existe en data/)
  })
  it('filtro con campo no declarado en shape.fields → rechazo', () => {
    const s = parseSpec(BASE.replace('field: area, label: "Área"', 'field: fantasma, label: "X"')) as Record<string, unknown>
    expect(() => validate(s)).toThrow(/shape\.fields|no está declarado/)
  })
})
