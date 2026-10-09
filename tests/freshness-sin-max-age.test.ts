// #411 · La marca de agua declara el corte aunque el PI no tenga SLA de frescura.
// Sin `max_age` (global o por-dataset) la marca de agua se resuelve y el header dice «Datos al …»
// (precedencia 1 de #108), pero el veredicto es siempre fresco y no hay banner. `maxAgeMs` queda
// INDEFINIDO, no 0: con 0 toda marca de agua saldría atrasada.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { checkFreshness, parseSpec, validateSpec } from '@vergis/mira'
import { asOfFor } from '../packages/mira/src/mira'
import type { Capability } from '@vergis/botler'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object

type SpecArg = Parameters<typeof checkFreshness>[0]
type ResultsArg = Parameters<typeof checkFreshness>[1]

const NOW = Date.parse('2026-06-10T15:00:00Z')
const base = (quality: unknown, data: Record<string, unknown>) =>
  ({ mira_version: '1.0', identity: { id: 'x', display_name: 'x', classification: 'internal' }, piece: {}, data, quality, delivery: {} }) as unknown as SpecArg

describe('checkFreshness · sin max_age (#411)', () => {
  it('global sin max_age y marca de agua de hace un año → fresca, con corte y sin umbral', () => {
    const spec = base(
      { freshness: { source_watermark: 'required', watermark_field: 'meta.fecha', timezone: 'America/Santiago' } },
      { meta: { capability: 'x', shape: { type: 'single_row', fields: { fecha: 'date' } } } },
    )
    const v = checkFreshness(spec, { meta: { rows: [{ fecha: '2025-06-10T03:00:00.000Z' }] } } as unknown as ResultsArg, NOW)
    expect(v.checked).toBe(true)
    expect(v.stale).toBe(false)
    expect(v.watermarkRaw).toBe('2025-06-10T03:00:00.000Z')
    expect(v.maxAgeMs).toBeUndefined()
    expect(v.maxAgeRaw).toBeUndefined()
    expect(asOfFor(v)).toEqual({ cutoff: '2025-06-10T03:00:00.000Z', source: 'watermark' })
  })

  it('por-dataset sin max_age → fresca y declara el corte (máximo de la columna)', () => {
    const spec = base({}, { detalle: { capability: 'x', freshness: { watermark_field: 'fecha_carga' } } })
    const v = checkFreshness(
      spec,
      { detalle: { rows: [{ fecha_carga: '2024-01-01' }, { fecha_carga: '2024-02-01' }] } } as unknown as ResultsArg,
      NOW,
    )
    expect(v).toMatchObject({ checked: true, stale: false, watermarkRaw: '2024-02-01' })
    expect(asOfFor(v).source).toBe('watermark')
  })

  it('por-dataset sin max_age sigue a la página: si su dataset no se recuperó, no declara corte', () => {
    const spec = base({}, {
      plantacion: { capability: 'x', freshness: { watermark_field: 'fecha_carga' } },
      despachos: { capability: 'x' },
    })
    const v = checkFreshness(spec, { despachos: { rows: [{ total: 1 }] } } as unknown as ResultsArg, NOW)
    expect(v.checked).toBe(false)
    expect(asOfFor(v)).toEqual({ cutoff: null, source: 'none' })
  })

  it('regresión: CON max_age el atraso se evalúa igual que antes', () => {
    const spec = base(
      { freshness: { source_watermark: 'required', watermark_field: 'meta.fecha', max_age: 'P7D' } },
      { meta: { capability: 'x', shape: { type: 'single_row', fields: { fecha: 'date' } } } },
    )
    const v = checkFreshness(spec, { meta: { rows: [{ fecha: '2026-05-01' }] } } as unknown as ResultsArg, NOW)
    expect(v).toMatchObject({ checked: true, stale: true, maxAgeRaw: 'P7D' })
  })

  it('una declaración sin SLA nunca vuelve atrasado el veredicto agregado', () => {
    const spec = base(
      { freshness: { source_watermark: 'required', watermark_field: 'meta.fecha', max_age: 'P7D' } },
      {
        meta: { capability: 'x', shape: { type: 'single_row', fields: { fecha: 'date' } } },
        viejo: { capability: 'x', freshness: { watermark_field: 'f' } },
      },
    )
    const v = checkFreshness(
      spec,
      { meta: { rows: [{ fecha: '2026-06-09' }] }, viejo: { rows: [{ f: '2020-01-01' }] } } as unknown as ResultsArg,
      NOW,
    )
    expect(v.stale).toBe(false)
    expect(v.staleDatasets).toBeUndefined()
  })
})

describe('validación · frescura global sin max_age (#411)', () => {
  const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
  const yaml = (wf: string) => `
mira_version: "1.0"
identity: { id: pi-411, display_name: "411", classification: internal }
piece:
  table: { data: data.meta, columns: [{ field: fecha, label: Fecha }] }
data:
  meta:
    capability: mock-sql
    params: { sql: "SELECT fecha FROM dbo.m" }
    shape: { type: single_row, fields: { fecha: date } }
quality: { freshness: { source_watermark: required, watermark_field: ${wf} } }
delivery: { render: [{ format: html, target: web }] }
`
  const validate = (y: string) => validateSpec(parseSpec(y), { capabilities: CAPS, schema: SCHEMA })

  it('válida sin max_age', () => {
    expect(() => validate(yaml('meta.fecha'))).not.toThrow()
  })

  it('sin max_age el watermark_field se sigue validando: dataset colgante → rechazo', () => {
    expect(() => validate(yaml('fantasma.fecha'))).toThrow(/fantasma/)
  })
})

describe('render · sin max_age: «Datos al …» y sin banner (#411)', () => {
  it('por-dataset sin max_age con marca de agua antigua → header con el corte y sin banner', async () => {
    const yaml = `
mira_version: "1.0"
identity: { id: pi-411-r, display_name: "411 render", classification: internal }
piece:
  table: { data: data.detalle, columns: [{ field: v, label: V }] }
data:
  detalle:
    capability: mock-sql
    params: { sql: "SELECT v, fecha_carga FROM dbo.d" }
    freshness: { watermark_field: fecha_carga, timezone: America/Santiago }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`
    const mockSql: Capability = {
      name: 'mock-sql',
      async execute() {
        return { rows: [{ v: 1, fecha_carga: '2020-01-02T15:00:00.000Z' }] }
      },
    }
    const dir = mkdtempSync(join(tmpdir(), 'vergis-411-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, yaml)
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql] })
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(html).not.toContain('class="banner"')
    expect(html).toContain('Datos al ')
    expect(html).not.toContain('corte no disponible')
  })
})

describe('corte del header cuando conviven declaraciones con y sin SLA (#411 · C-2)', () => {
  const spec = base(
    { freshness: { source_watermark: 'required', watermark_field: 'meta.fecha', max_age: 'P30D' } },
    {
      meta: { capability: 'x', shape: { type: 'single_row', fields: { fecha: 'date' } } },
      detalle: { capability: 'x', freshness: { watermark_field: 'fecha_carga' } },
    },
  )

  it('todas frescas: el header declara la marca de agua MÁS ANTIGUA (la global de hace 9 días, no la sin SLA de hace 1 h)', () => {
    const v = checkFreshness(
      spec,
      {
        meta: { rows: [{ fecha: '2026-06-01T15:00:00.000Z' }] }, // hace 9 días, dentro de P30D
        detalle: { rows: [{ fecha_carga: '2026-06-10T14:00:00.000Z' }] }, // hace 1 h, sin SLA
      } as unknown as ResultsArg,
      NOW,
    )
    expect(v.stale).toBe(false)
    expect(asOfFor(v)).toEqual({ cutoff: '2026-06-01T15:00:00.000Z', source: 'watermark' })
  })

  it('todas frescas y la sin SLA es la más vieja: el header declara la sin SLA', () => {
    const v = checkFreshness(
      spec,
      {
        meta: { rows: [{ fecha: '2026-06-09T15:00:00.000Z' }] },
        detalle: { rows: [{ fecha_carga: '2026-05-01T00:00:00.000Z' }] },
      } as unknown as ResultsArg,
      NOW,
    )
    expect(v.stale).toBe(false)
    expect(asOfFor(v).cutoff).toBe('2026-05-01T00:00:00.000Z')
  })

  it('con una atrasada: gana la atrasada aunque la sin SLA sea más vieja', () => {
    const v = checkFreshness(
      spec,
      {
        meta: { rows: [{ fecha: '2026-04-01T00:00:00.000Z' }] }, // > P30D → atrasada
        detalle: { rows: [{ fecha_carga: '2020-01-01T00:00:00.000Z' }] },
      } as unknown as ResultsArg,
      NOW,
    )
    expect(v.stale).toBe(true)
    expect(v.staleDatasets).toEqual(['meta'])
    expect(asOfFor(v).cutoff).toBe('2026-04-01T00:00:00.000Z')
  })
})
