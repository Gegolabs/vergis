// Frescura POR-DATASET (work/052 R3-1): además de la global (quality.freshness), un dataset puede
// declarar su propia frescura (`data.<ds>.freshness: { watermark_field: <campo del dataset>, max_age }`).
// El veredicto agregado = el MÁS stale gana; el banner nombra al/los dataset(s) atrasado(s). Además:
// un dataset MULTI-FILA resuelve su watermark como el MÁXIMO de la columna (antes `toDate(arreglo)`
// devolvía null → «fresco» en silencio).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { checkFreshness, parseSpec, validateSpec } from '@vergis/mira'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Capability } from '@vergis/botler'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object

type SpecArg = Parameters<typeof checkFreshness>[0]
type ResultsArg = Parameters<typeof checkFreshness>[1]

const NOW = Date.parse('2026-06-10T15:00:00Z')

describe('checkFreshness · declaraciones por-dataset', () => {
  const spec = {
    mira_version: '1.0',
    identity: { id: 'x', display_name: 'x', classification: 'internal' },
    piece: {},
    data: {
      meta: { capability: 'x', shape: { type: 'single_row', fields: { fecha: 'date' } } },
      detalle: { capability: 'x', freshness: { watermark_field: 'fecha_mov', max_age: 'P2D' } },
    },
    quality: { freshness: { source_watermark: 'required', max_age: 'P7D', watermark_field: 'meta.fecha' } },
    delivery: {},
  } as unknown as SpecArg

  it('global fresco + por-dataset stale → stale, y staleDatasets nombra al atrasado', () => {
    const results = {
      meta: { rows: [{ fecha: '2026-06-10' }] }, // global: hoy → fresco (P7D)
      detalle: { rows: [{ fecha_mov: '2026-06-01' }, { fecha_mov: '2026-06-03' }] }, // max = 06-03 → 7 días > P2D
    } as unknown as ResultsArg
    const v = checkFreshness(spec, results, NOW)
    expect(v.checked).toBe(true)
    expect(v.stale).toBe(true)
    expect(v.staleDatasets).toEqual(['detalle'])
    // El watermark representativo es el del MÁS stale (el del dataset atrasado, no el global fresco).
    expect(v.watermark?.toISOString().slice(0, 10)).toBe('2026-06-03')
  })

  it('dataset MULTI-FILA: el watermark es el MÁXIMO de la columna (no null-silencioso)', () => {
    const results = {
      meta: { rows: [{ fecha: '2026-06-10' }] },
      detalle: { rows: [{ fecha_mov: '2026-06-01' }, { fecha_mov: '2026-06-10' }] }, // max = HOY → fresco
    } as unknown as ResultsArg
    const v = checkFreshness(spec, results, NOW)
    expect(v.stale).toBe(false)
  })

  it('todo fresco → no stale y sin staleDatasets', () => {
    const results = {
      meta: { rows: [{ fecha: '2026-06-10' }] },
      detalle: { rows: [{ fecha_mov: '2026-06-09' }] },
    } as unknown as ResultsArg
    const v = checkFreshness(spec, results, NOW)
    expect(v.checked).toBe(true)
    expect(v.stale).toBe(false)
    expect(v.staleDatasets).toBeUndefined()
  })

  it('la GLOBAL sola sigue funcionando igual (back-compat)', () => {
    const soloGlobal = {
      ...(spec as unknown as Record<string, unknown>),
      data: { meta: { capability: 'x', shape: { type: 'single_row', fields: { fecha: 'date' } } } },
    } as unknown as SpecArg
    const stale = checkFreshness(soloGlobal, { meta: { rows: [{ fecha: '2026-05-01' }] } } as unknown as ResultsArg, NOW)
    expect(stale.stale).toBe(true)
    const fresh = checkFreshness(soloGlobal, { meta: { rows: [{ fecha: '2026-06-10' }] } } as unknown as ResultsArg, NOW)
    expect(fresh.stale).toBe(false)
  })

  it('por-dataset sin global: se evalúa sola (no requiere quality.freshness)', () => {
    const sinGlobal = {
      ...(spec as unknown as Record<string, unknown>),
      quality: {},
    } as unknown as SpecArg
    const v = checkFreshness(sinGlobal, {
      meta: { rows: [{ fecha: '2026-06-10' }] },
      detalle: { rows: [{ fecha_mov: '2026-06-01' }] },
    } as unknown as ResultsArg, NOW)
    expect(v.checked).toBe(true)
    expect(v.stale).toBe(true)
    expect(v.staleDatasets).toEqual(['detalle'])
  })
})

describe('validación · frescura por-dataset', () => {
  const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
  const baseYaml = (freshness: string) => `
mira_version: "1.0"
identity: { id: pi-fpd, display_name: "FPD", classification: internal }
piece:
  table: { data: data.detalle, columns: [{ field: fecha_mov, label: Fecha }] }
data:
  detalle:
    capability: mock-sql
    params: { sql: "SELECT fecha_mov FROM dbo.d" }
    shape: { fields: { fecha_mov: date } }
    freshness: ${freshness}
quality: {}
delivery: { render: [{ format: html, target: web }] }
`
  const validate = (yaml: string) => validateSpec(parseSpec(yaml), { capabilities: CAPS, schema: SCHEMA })

  it('max_age no soportado (P1W) → rechazo accionable', () => {
    expect(() => validate(baseYaml('{ watermark_field: fecha_mov, max_age: P1W }'))).toThrow(/max_age 'P1W'/)
  })

  it('watermark_field no declarado en shape.fields → rechazo', () => {
    expect(() => validate(baseYaml('{ watermark_field: fantasma, max_age: P1D }'))).toThrow(/fantasma/)
  })

  it('declaración incompleta (sin max_age) → rechazo', () => {
    expect(() => validate(baseYaml('{ watermark_field: fecha_mov }'))).toThrow(/max_age/)
  })

  it('declaración correcta → válida', () => {
    expect(() => validate(baseYaml('{ watermark_field: fecha_mov, max_age: P1D }'))).not.toThrow()
  })
})

describe('render · el banner nombra al dataset atrasado', () => {
  it('por-dataset stale → banner con el nombre del dataset', async () => {
    const yaml = `
mira_version: "1.0"
identity: { id: pi-fpd-r, display_name: "FPD render", classification: internal }
piece:
  table: { data: data.detalle, columns: [{ field: fecha_mov, label: Fecha }] }
data:
  detalle:
    capability: mock-sql
    params: { sql: "SELECT fecha_mov FROM dbo.d" }
    freshness: { watermark_field: fecha_mov, max_age: P1D }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`
    const mockSql: Capability = {
      name: 'mock-sql',
      async execute() {
        return { rows: [{ fecha_mov: '2020-01-01' }, { fecha_mov: '2020-01-02' }] }
      },
    }
    const dir = mkdtempSync(join(tmpdir(), 'vergis-fpd-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, yaml)
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql] })
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(html).toContain('class="banner"')
    expect(html).toContain('2020-01-02') // el máximo de la columna, no null-silencioso
    expect(html).toContain('dataset(s) atrasado(s): detalle') // el banner NOMBRA al atrasado
  })
})
