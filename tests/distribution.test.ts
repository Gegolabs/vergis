import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec } from '@vergis/mira'
import { VergisError, type Capability } from '@vergis/botler'

/**
 * Regresión del bug de PI-07: los gráficos `distribution` salían VACÍOS porque el spec escribía
 * los ejes como campo pelado (`dimension: local`) con la fuente en una clave `data:` aparte que el
 * render IGNORA. El componente toma su dataset desde la ruta completa de dimension/metric
 * (data.<dataset>.<campo>, como un kpi). El render no falla con un eje pelado: simplemente no
 * dibuja barras — por eso el deploy no lo detectó. Acá: el validador rechaza el cableado malo
 * (capa 2) y el render confirma que el cableado bueno sí dibuja barras (capa 3).
 */

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object

const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

// Spec testigo: una vista con un ranking distribution bien cableado (ejes = ruta completa).
const GOOD_YAML = `
mira_version: "1.0"
identity: { id: pi-dist-test, display_name: "Distribution Test", classification: internal }
piece:
  layout: rows
  elements:
    - distribution: { dimension: data.por_local.local, metric: data.por_local.unidades, title: "Total Unidades por Local" }
data:
  por_local: { capability: mock-sql, params: { sql: "SELECT local, unidades FROM dbo.x" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

function makeMockSql(): Capability {
  return {
    name: 'mock-sql',
    async execute(): Promise<unknown> {
      return {
        rows: [
          { local: 'LOCALNORTE', unidades: 100 },
          { local: 'LOCALSUR', unidades: 60 },
        ],
      }
    },
  }
}

async function render(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-dist-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yaml)
  return runSpec({ specPath, baseDir: dir, extraCapabilities: [makeMockSql()] })
}

describe('distribution · validación del cableado de ejes (capa 2)', () => {
  it('ejes como ruta completa data.<dataset>.<campo> → pasa', () => {
    expect(() => validate(parseSpec(GOOD_YAML))).not.toThrow()
  })

  it('eje pelado (el bug de PI-07: dimension: local) → rechazo', () => {
    const bad = GOOD_YAML.replace('dimension: data.por_local.local', 'dimension: local')
    expect(() => validate(parseSpec(bad))).toThrow(/ruta completa data\.<dataset>\.<campo>/)
  })

  it('metric pelado → rechazo', () => {
    const bad = GOOD_YAML.replace('metric: data.por_local.unidades', 'metric: unidades')
    expect(() => validate(parseSpec(bad))).toThrow(VergisError)
  })

  it('clave `data:` colgante en el distribution (la fuente no quedó cableada) → rechazo', () => {
    const bad = GOOD_YAML.replace(
      'distribution: { dimension: data.por_local.local',
      'distribution: { data: data.por_local, dimension: data.por_local.local',
    )
    expect(() => validate(parseSpec(bad))).toThrow(/no lee la clave 'data:'/)
  })

  it('eje que apunta a un dataset inexistente → rechazo (ref colgante)', () => {
    const bad = GOOD_YAML.replace('dimension: data.por_local.local', 'dimension: data.fantasma.local')
    expect(() => validate(parseSpec(bad))).toThrow(/no existe en el bloque data/)
  })
})

describe('distribution · render con datos (capa 3)', () => {
  it('un distribution bien cableado dibuja barras (no sale vacío)', async () => {
    const out = await render(GOOD_YAML)
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    // La sección del gráfico existe con su título...
    expect(html).toContain('Total Unidades por Local')
    expect(html).toContain('<section class="chart">')
    // ...y trae marcas de barra de los datos (Vega emite role-mark por cada barra). Un chart vacío
    // (el bug de PI-07) no tendría ninguna marca aunque el título y el <svg> sí aparecieran.
    expect(html).toMatch(/role-mark/)
    expect(html).toContain('LOCALNORTE')
  })
})
