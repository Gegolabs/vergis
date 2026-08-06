// Convención de plataforma del corte as-of en el header (issue #108): misma posición, mismo formato,
// en TODO PI y en TODO theme; «Generado» extinto (dos renders del mismo dato son byte-idénticos).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import type { Capability } from '@vergis/botler'
import { arbolTheme, defaultTheme, type AsOfMeta, type Theme } from '../packages/capabilities/src/themes/index'

const THEMES: [string, Theme][] = [
  ['arbol', arbolTheme],
  ['default', defaultTheme],
]

const wrapWith = (theme: Theme, asOf: AsOfMeta): string =>
  theme.wrap({ title: 'PI de prueba', body: '<div></div>', meta: { asOf, code: 'PI-1', version: '1' } })

/** El header = todo lo que va antes del contenido; basta con que el bloque esté en el documento. */
describe.each(THEMES)('header as-of · theme %s', (_name, theme) => {
  it('corte de grano FECHA → «Datos al 4 de agosto de 2026»', () => {
    const html = wrapWith(theme, { cutoff: '2026-08-04', source: 'watermark' })
    expect(html).toContain('Datos al 4 de agosto de 2026')
    expect(html).toContain('class="meta"')
  })

  it('corte con HORA → formato con hora («03 ago 2026, 06:15 p. m.»)', () => {
    const html = wrapWith(theme, { cutoff: '2026-08-03T22:15:00.000Z', source: 'ingesta', detail: [] })
    expect(html).toContain('Datos al 03 ago 2026, 06:15')
  })

  it('corte por INGESTA multi-dominio → el tooltip del .date nombra el corte garantizado y cada dominio', () => {
    const html = wrapWith(theme, {
      cutoff: '2026-08-03T22:15:00.000Z',
      source: 'ingesta',
      detail: [
        { domainId: 'personas', label: 'Personas', lastSuccessAt: '2026-08-04T11:00:00.000Z' },
        { domainId: 'cartera', label: 'Cartera / Finanzas', lastSuccessAt: '2026-08-03T22:15:00.000Z' },
      ],
    })
    const title = /<div class="date" title="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(title).toContain('Corte garantizado')
    expect(title).toContain('Personas: 04 ago 2026')
    expect(title).toContain('Cartera / Finanzas: 03 ago 2026')
  })

  it('corte por WATERMARK → el tooltip dice que lo declara el dato, sin detalle de ingesta', () => {
    const html = wrapWith(theme, { cutoff: '2026-08-04', source: 'watermark' })
    const title = /<div class="date" title="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(title).toBe('Corte declarado por el dato del PI (marca de agua).')
  })

  it('SIN corte → la línea se pinta igual, diciendo «corte no disponible» (nunca la hora del render)', () => {
    const html = wrapWith(theme, { cutoff: null, source: 'none' })
    expect(html).toContain('Datos: corte no disponible')
    expect(html).toContain('La plataforma no tiene registro del corte de estos datos.')
  })

  it('sin `asOf` en el meta el header tampoco calla: cae al estado no-disponible', () => {
    const html = theme.wrap({ title: 'PI', body: '<div></div>' })
    expect(html).toContain('Datos: corte no disponible')
  })

  it('«Generado» no existe en ningún caso', () => {
    for (const asOf of [
      { cutoff: '2026-08-04', source: 'watermark' } as const,
      { cutoff: '2026-08-03T22:15:00.000Z', source: 'ingesta' } as const,
      { cutoff: null, source: 'none' } as const,
    ]) {
      expect(wrapWith(theme, asOf)).not.toContain('Generado')
    }
  })
})

// ─── Precedencia y determinismo, end-to-end por runSpec ──────────────────────────────────────────────

const yamlFor = (conFreshness: boolean) => `
mira_version: "1.0"
identity: { id: pi-asof, display_name: "As-of", classification: internal }
piece:
  table: { data: data.detalle, columns: [{ field: fecha_dato, label: Fecha }] }
data:
  detalle:
    capability: mock-sql
    params: { sql: "SELECT fecha_dato FROM dbo.d" }
    shape: { type: single_row, fields: { fecha_dato: date } }
quality:${conFreshness ? '\n  freshness: { source_watermark: required, max_age: P36500D, watermark_field: detalle.fecha_dato }' : ' {}'}
delivery: { render: [{ format: html, target: web }] }
`

const mockSql: Capability = {
  name: 'mock-sql',
  async execute(): Promise<unknown> {
    return { rows: [{ fecha_dato: '2026-08-04' }] }
  },
}

const INGESTA = {
  cutoff: '2026-08-03T22:15:00.000Z',
  detail: [{ domainId: 'cartera', label: 'Cartera / Finanzas', lastSuccessAt: '2026-08-03T22:15:00.000Z' }],
}

async function run(conFreshness: boolean, asOf?: typeof INGESTA) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-asof-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yamlFor(conFreshness))
  return runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql], asOf })
}

describe('precedencia del corte as-of (D1) end-to-end', () => {
  it('la marca de agua del dato le GANA a la ingesta', async () => {
    const out = await run(true, INGESTA)
    expect(out.ok).toBe(true)
    expect(out.html).toContain('Datos al 4 de agosto de 2026') // el watermark, con su grano diario
    expect(out.html).not.toContain('Datos al 03 ago 2026')
  })

  it('sin marca de agua, manda la ingesta que inyecta la plataforma', async () => {
    const out = await run(false, INGESTA)
    expect(out.ok).toBe(true)
    expect(out.html).toContain('Datos al 03 ago 2026, 06:15')
  })

  it('sin marca de agua y sin ingesta conocida → «corte no disponible»', async () => {
    const out = await run(false)
    expect(out.ok).toBe(true)
    expect(out.html).toContain('Datos: corte no disponible')
  })

  it('DETERMINISMO: dos corridas del mismo spec y el mismo dato producen HTML byte-idéntico', async () => {
    // El experimento que refutaría D3 si quedara otra fuente de no-determinismo en el documento.
    const a = await run(true, INGESTA)
    const b = await run(true, INGESTA)
    expect(a.html).toBe(b.html)
  })

  it('ningún render lleva el sello «Generado»', async () => {
    const out = await run(true, INGESTA)
    expect(out.html).not.toContain('Generado')
  })
})
