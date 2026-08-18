// #203 · pieza 2 — las series de un `distribution` salen de una COLUMNA (`series: <campo>`), no de
// etiquetas estáticas del YAML.
//
// El caso que lo pidió: en PI-25 las series son (año × tipo) y el año lo elige el usuario en
// runtime, así que con `metrics[]` —formato ancho, etiquetas fijas— hubo que pre-plegar seis
// columnas en el SQL y rotularlas de forma relativa. El modo largo resuelve la familia entera.
//
// Lo que se mide acá es el PLIEGUE, que es donde vive todo el riesgo: el render agrupado se
// reutiliza entero y ya tiene su propia suite (chart-stacked, distribution-multi, …).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSpec, validateSpec, foldSeriesColumn, CHART_MAX_SERIES, OTHER_SERIES_LABEL } from '@vergis/mira'
import { VergisError, type Capability } from '@vergis/botler'
import { runSpec } from '@vergis/cli'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

/** El `code` es el contrato estable del error; el texto del mensaje no lo es. */
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return e instanceof VergisError ? String(e.structured.code ?? '') : `no-vergis-error: ${String(e)}`
  }
  return 'no-throw'
}

/** Largo canónico: (categoría, serie, valor). Norte aparece antes que Sur; Enero antes que Febrero. */
const LARGO = [
  { mes: 'Enero', zona: 'Norte', total: 10 },
  { mes: 'Enero', zona: 'Sur', total: 5 },
  { mes: 'Febrero', zona: 'Norte', total: 20 },
  { mes: 'Febrero', zona: 'Sur', total: 7 },
]

describe('#203 · pliegue largo→ancho (foldSeriesColumn)', () => {
  it('una fila por categoría, una columna por serie, con el valor en su celda', () => {
    const { rows, metricsSpec } = foldSeriesColumn(LARGO, 'mes', 'zona', 'total')
    expect(metricsSpec).toEqual([
      { field: '__s0', label: 'Norte' },
      { field: '__s1', label: 'Sur' },
    ])
    expect(rows).toEqual([
      { mes: 'Enero', __s0: 10, __s1: 5 },
      { mes: 'Febrero', __s0: 20, __s1: 7 },
    ])
  })

  it('el orden lo manda el SQL, no el alfabeto — en categorías Y en series', () => {
    // Si se ordenara alfabéticamente, 'Sur' iría después de 'Norte' igual (falso positivo). Se usan
    // valores donde el orden de llegada CONTRADICE al alfabético, que es el único control que
    // distingue «respeta el SQL» de «ordena y coincide».
    const filas = [
      { mes: 'Zulia', zona: 'Sur', total: 1 },
      { mes: 'Anzoátegui', zona: 'Norte', total: 2 },
    ]
    const { rows, metricsSpec } = foldSeriesColumn(filas, 'mes', 'zona', 'total')
    expect(rows.map((r) => r['mes'])).toEqual(['Zulia', 'Anzoátegui'])
    expect(metricsSpec.map((m) => m.label)).toEqual(['Sur', 'Norte'])
  })

  it('la celda ausente es 0, no vacía — en apilado un hueco y un cero se dibujan igual', () => {
    const { rows } = foldSeriesColumn([...LARGO, { mes: 'Marzo', zona: 'Norte', total: 3 }], 'mes', 'zona', 'total')
    expect(rows[2]).toEqual({ mes: 'Marzo', __s0: 3, __s1: 0 })
  })

  it('un par (categoría, serie) repetido se SUMA — quedarse con el último perdería filas en silencio', () => {
    const { rows } = foldSeriesColumn(
      [
        { mes: 'Enero', zona: 'Norte', total: 10 },
        { mes: 'Enero', zona: 'Norte', total: 4 },
      ],
      'mes',
      'zona',
      'total',
    )
    expect(rows[0]!['__s0']).toBe(14)
  })

  it('sobre la cota, el excedente se colapsa en «(otras)» y el total de la categoría se conserva', () => {
    const n = CHART_MAX_SERIES + 3
    const filas = Array.from({ length: n }, (_, i) => ({ mes: 'Enero', zona: `Z${i}`, total: i + 1 }))
    const { rows, metricsSpec, capped } = foldSeriesColumn(filas, 'mes', 'zona', 'total')
    expect(capped).toBe(true)
    expect(metricsSpec).toHaveLength(CHART_MAX_SERIES + 1)
    expect(metricsSpec.at(-1)!.label).toBe(OTHER_SERIES_LABEL)
    // El criterio de aceptación que importa: nada se pierde al colapsar.
    const totalDibujado = metricsSpec.reduce((s, m) => s + Number(rows[0]![m.field]), 0)
    const totalReal = filas.reduce((s, f) => s + f.total, 0)
    expect(totalDibujado).toBe(totalReal)
  })

  it('las claves de salida son sintéticas: un valor de serie no puede pisar la columna de dimensión', () => {
    // El control: una serie que se LLAMA como el campo de dimensión. Con claves derivadas del valor,
    // `row['mes']` quedaría sobrescrito por el número y la categoría se perdería.
    const { rows, metricsSpec } = foldSeriesColumn([{ mes: 'Enero', zona: 'mes', total: 9 }], 'mes', 'zona', 'total')
    expect(rows[0]!['mes']).toBe('Enero')
    expect(rows[0]![metricsSpec[0]!.field]).toBe(9)
  })
})

const yaml = (dist: string): string => `
mira_version: "1.0"
identity: { id: pi-series-col, display_name: "Series desde columna", classification: internal }
piece:
  layout: grid
  columns: 1
  elements:
    - distribution:
${dist}
data:
  cruce:
    capability: mock-sql
    params: { sql: "SELECT mes, zona, total FROM dbo.x" }
    shape: { fields: { mes: string, zona: string, total: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

describe('#203 · validación del modo largo', () => {
  const dist = (extra: string): unknown =>
    parseSpec(yaml(`        dimension: data.cruce.mes\n${extra}`))

  it('acepta `series` + `metric`', () => {
    expect(() => validate(dist('        metric: data.cruce.total\n        series: zona'))).not.toThrow()
  })

  it('rechaza `series` junto a `metrics`: son dos orígenes de series a la vez', () => {
    expect(codeOf(() => validate(dist('        series: zona\n        metrics:\n          - { field: total, label: "T" }')))).toBe(
      'distribution-series-metrics-collision',
    )
  })

  it('rechaza una columna de series colgante: un typo produciría UNA serie con todo el total adentro', () => {
    expect(codeOf(() => validate(dist('        metric: data.cruce.total\n        series: zzona')))).toBe(
      'distribution-series-field-dangling',
    )
  })

  it('rechaza un `series` que no es el nombre de una columna', () => {
    expect(codeOf(() => validate(dist('        metric: data.cruce.total\n        series: { field: zona }')))).toBe(
      'distribution-series-not-field',
    )
  })

  it('el vocabulario cerrado de `sort` rige también en largo: el token legacy no se acepta en silencio', () => {
    expect(codeOf(() => validate(dist('        metric: data.cruce.total\n        series: zona\n        sort: "-total"')))).toBe(
      'distribution-sort-unknown',
    )
  })

  it('acepta `value:<serie>` sin validarlo: las series del modo largo no existen sin los datos', () => {
    expect(() =>
      validate(dist('        metric: data.cruce.total\n        series: zona\n        sort: "value:Norte"')),
    ).not.toThrow()
  })
})

// ── Control end-to-end ───────────────────────────────────────────────────────────────────────────
// El pliegue puro y la validación no demuestran que el gráfico SALGA. Este es el eslabón que ningún
// unit test cubre: spec YAML → compose → render, con datos largos de verdad, verificando que las
// series aparecen rotuladas con los VALORES de la columna (no con el nombre del campo) y que
// apilado y agrupado producen dibujos distintos sobre el mismo dato.
describe('#203 · control end-to-end (spec largo → SVG)', () => {
  const specLargo = (extra = ''): string => `
mira_version: "1.0"
identity: { id: pi-largo-e2e, display_name: "Largo E2E", classification: internal }
piece:
  layout: grid
  columns: 1
  elements:
    - distribution:
        dimension: data.cruce.mes
        metric: data.cruce.total
        series: zona
        title: "Por zona"
${extra}
data:
  cruce:
    capability: mock-sql
    params: { sql: "SELECT mes, zona, total FROM dbo.x" }
    shape: { fields: { mes: string, zona: string, total: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

  async function renderLargo(extra = ''): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-largo-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, specLargo(extra))
    const mock: Capability = { name: 'mock-sql', async execute() { return { rows: LARGO } } }
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mock] })
    expect(out.ok).toBe(true)
    return out.html ?? ''
  }

  it('las series se rotulan con los VALORES de la columna, no con el nombre del campo', async () => {
    const html = await renderLargo()
    expect(html).toContain('Norte')
    expect(html).toContain('Sur')
    // El control negativo: si el pliegue hubiera fallado y quedara una sola serie, el nombre del
    // campo (`total` o `zona`) aparecería como etiqueta de serie en la leyenda.
    expect(html).not.toMatch(/aria-label="Legend[^"]*"[^>]*>[^<]*zona/)
  })

  it('apilado y agrupado dibujan distinto sobre el MISMO dato largo', async () => {
    const agrupado = await renderLargo()
    const apilado = await renderLargo('        stacked: true')
    expect(apilado).not.toBe(agrupado)
  })
})
