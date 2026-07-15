// `dato` (TX-12) — atributo rotulado (etiqueta + valor). Se distingue del `kpi`: NO es una medida
// (tarjeta grande), es contenido/estado en tipografía de texto, se imprime tal cual y JAMÁS es
// interactivo. El valor se resuelve por el mismo mecanismo de path que kpi.metric (resolvePath).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec } from '@vergis/mira'
import type { Capability } from '@vergis/botler'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

const YAML = `
mira_version: "1.0"
identity: { id: pi-dato-test, display_name: "Dato Test", classification: internal }
piece:
  layout: grid
  columns: 2
  elements:
    - dato: { label: "OC", value: data.encabezado.oc }
    - dato: { label: "Fecha Fin Recepción", value: data.encabezado.fecha_fin, format: date }
    - dato: { label: "Cantidad", value: data.encabezado.cantidad, format: int_0 }
data:
  encabezado:
    capability: mock-sql
    params: { sql: "SELECT oc, fecha_fin, cantidad FROM dbo.x" }
    shape: { type: single_row, fields: { oc: string, fecha_fin: string, cantidad: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

function makeMockSql(rows: Record<string, unknown>[]): Capability {
  return { name: 'mock-sql', async execute() { return { rows } } }
}

async function render(yaml: string, rows: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-dato-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yaml)
  return runSpec({ specPath, baseDir: dir, extraCapabilities: [makeMockSql(rows)] })
}

describe('dato · validación (elemento del catálogo)', () => {
  it('un `dato` bien formado pasa la validación', () => {
    expect(() => validate(parseSpec(YAML))).not.toThrow()
  })

  it('`dato` con dataset colgante → rechazo (ref colgante, mismo criterio que kpi)', () => {
    const bad = YAML.replace('value: data.encabezado.oc', 'value: data.fantasma.oc')
    expect(() => validate(parseSpec(bad))).toThrow(/no existe en el bloque data/)
  })

  it('`dato` con campo inexistente en shape → rechazo', () => {
    const bad = YAML.replace('value: data.encabezado.oc', 'value: data.encabezado.no_existe')
    expect(() => validate(parseSpec(bad))).toThrow(/no está declarado en data\.encabezado\.shape\.fields/)
  })
})

describe('dato · render', () => {
  it('rotula etiqueta + valor (texto por defecto)', async () => {
    const out = await render(YAML, [{ oc: 'OC-4471', fecha_fin: '2026-05-26', cantidad: 1200 }])
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(html).toContain('<div class="dato">')
    expect(html).toContain('<span class="dato-k">OC</span>')
    expect(html).toContain('<span class="dato-v">OC-4471</span>')
  })

  it('format: date recorta ISO/Date a YYYY-MM-DD (reusa el helper de 0.9.0)', async () => {
    const out = await render(YAML, [
      { oc: 'OC-1', fecha_fin: '2026-05-26T00:00:00.000Z', cantidad: 5 },
    ])
    const html = out.html ?? ''
    expect(html).toContain('<span class="dato-v">2026-05-26</span>')
    expect(html).not.toContain('T00:00:00')
    // Un objeto Date del driver también se recorta.
    const out2 = await render(YAML, [{ oc: 'OC-2', fecha_fin: new Date('2026-01-02T10:00:00Z'), cantidad: 5 }])
    expect(out2.html ?? '').toContain('<span class="dato-v">2026-01-02</span>')
  })

  it('format: int_0 agrupa el número', async () => {
    const out = await render(YAML, [{ oc: 'OC-3', fecha_fin: '2026-05-26', cantidad: 1234567 }])
    expect(out.html ?? '').toContain('<span class="dato-v">1.234.567</span>')
  })

  it('NO es interactivo: el HTML del dato no lleva data-attrs de recompute y aparece tal cual', async () => {
    const out = await render(YAML, [{ oc: 'OC-9', fecha_fin: '2026-05-26', cantidad: 42 }])
    const html = out.html ?? ''
    // Aislar el fragmento del primer dato y confirmar que no hay atributos data-* (recompute).
    const frag = html.slice(html.indexOf('<div class="dato">'), html.indexOf('</div>', html.indexOf('<div class="dato">')) + 6)
    expect(frag).not.toMatch(/data-(agg|format|semaforo|summary)=/)
    expect(html).toContain('OC-9')
  })
})
