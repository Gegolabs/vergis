// `series` en formato LARGO — `series: <campo>` + `value: <campo>` (la contraparte de #203 para líneas)
// y `names: true` (rótulo con el nombre de la serie en el extremo de cada línea).
// El pliegue largo→ancho vive en `compose` y el render de líneas se reutiliza entero; acá se mide:
// (1) el formato ancho existente NO cambia (sha), (2) validación con nombre, (3) pliegue, cota y
// huecos, (4) el render muestra lo que el spec pide: leyenda con el nombre exacto, rótulos abreviados,
// nombre sobre cada línea.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec, foldSeriesColumn, CHART_MAX_SERIES, OTHER_SERIES_LABEL } from '@vergis/mira'
import { renderHtmlPiece, spreadNameTops, type ResolvedNode } from '@vergis/capabilities'
import { VergisError, type Capability } from '@vergis/botler'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

const spec = (seriesBlock: string) => `
mira_version: "1.0"
identity: { id: pi-series-largo, display_name: "Series largo", classification: internal }
controls:
  - { id: version, label: "Versión", source: data.versiones.version_etiqueta, single: false }
piece:
  series:
${seriesBlock}
data:
  versiones: { capability: mock-sql, params: { sql: "SELECT DISTINCT version_etiqueta FROM dbo.x" } }
  acumulado:
    capability: mock-sql
    params: { sql: "SELECT mes, version_etiqueta, acumulado FROM dbo.x WHERE version_etiqueta IN (:ctx.version)" }
    shape: { type: rows, fields: { mes: string, version_etiqueta: string, acumulado: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`
const LARGO = spec(`    data: data.acumulado
    x: mes
    series: version_etiqueta
    value: acumulado
    names: true
    format: abbr
    title: "Acumulado por versión"`)

function mockSql(rows: Record<string, unknown>[]): Capability {
  return { name: 'mock-sql', async execute() { return { rows } } }
}
async function render(yaml: string, rows: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-series-largo-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yaml)
  return runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql(rows)] })
}
async function renderPiece(piece: ResolvedNode): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'roble' }, { agent: 't' })) as { html: string }
  return html
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun']
const largo = (versiones: string[], k = 1_000_000) =>
  MESES.flatMap((mes, i) => versiones.map((v, j) => ({ mes, version_etiqueta: v, acumulado: (i + 1) * k * (j + 1) })))

describe('series largo · el formato ancho no cambia', () => {
  const wide = MESES.map((m, i) => ({ mes: m, base: (i + 1) * 100000, actual: (i + 1) * 120000 + 5000 }))
  const seriesSpec = [{ field: 'base', label: 'Base' }, { field: 'actual', label: 'Actual' }]

  // Golden calculado con el código de `main` (12ca3d7) ANTES de tocar nada: si cambia, cambió el
  // render de todo `series` existente y hay que decir por qué.
  it('render ancho sin `names`: HTML idéntico byte a byte al de main', async () => {
    const a = await renderPiece({ type: 'series', xField: 'mes', rows: wide, seriesSpec } as ResolvedNode)
    expect(sha(a)).toBe('1dc1a20c2c8c91b1299d7949466bbe07848be461c66049c3c90b69b9b47bdf12')
    const b = await renderPiece({ type: 'series', xField: 'mes', rows: wide, seriesSpec, format: 'int_0', title: 'T', legend: 'right' } as ResolvedNode)
    expect(sha(b)).toBe('28aa41f0ef27d553b5b4dab59cb309e80ff373c620db8deb59d334a011743a16')
  })

  it('`names: false` explícito es lo mismo que ausente', async () => {
    const out = await render(
      spec(`    data: data.acumulado
    x: mes
    metrics: [{ field: acumulado, label: "A" }]
    names: false`),
      largo(['x']),
    )
    expect(out.ok).toBe(true)
  })
})

describe('series largo · validación', () => {
  it('un series largo bien formado pasa', () => {
    expect(() => validate(parseSpec(LARGO))).not.toThrow()
  })

  const caso = (block: string, code: string) => {
    let err: unknown
    try { validate(parseSpec(spec(block))) } catch (e) { err = e }
    expect(err).toBeInstanceOf(VergisError)
    expect((err as VergisError).structured.code).toBe(code)
  }

  it('falta `x` → series-x-missing', () => {
    caso(`    data: data.acumulado
    series: version_etiqueta
    value: acumulado`, 'series-x-missing')
  })
  it('falta `value` → series-value-missing', () => {
    caso(`    data: data.acumulado
    x: mes
    series: version_etiqueta`, 'series-value-missing')
  })
  it('`value` sin `series` → series-value-without-series', () => {
    caso(`    data: data.acumulado
    x: mes
    value: acumulado`, 'series-value-without-series')
  })
  it('ancho y largo a la vez → series-series-metrics-collision', () => {
    caso(`    data: data.acumulado
    x: mes
    series: version_etiqueta
    value: acumulado
    metrics: [{ field: acumulado, label: "A" }]`, 'series-series-metrics-collision')
  })
  it('`series` que no es un nombre de columna → series-series-not-field', () => {
    caso(`    data: data.acumulado
    x: mes
    series: 3
    value: acumulado`, 'series-series-not-field')
  })
  it('columna de series o de valor inexistente en shape → dangling', () => {
    caso(`    data: data.acumulado
    x: mes
    series: fantasma
    value: acumulado`, 'series-series-field-dangling')
    caso(`    data: data.acumulado
    x: mes
    series: version_etiqueta
    value: fantasma`, 'series-value-field-dangling')
  })
  it('`names` que no es booleano → series-names-not-boolean', () => {
    caso(`    data: data.acumulado
    x: mes
    series: version_etiqueta
    value: acumulado
    names: "false"`, 'series-names-not-boolean')
  })
  it('sin `metrics` ni `series` el rechazo de siempre sigue en pie', () => {
    expect(() => validate(parseSpec(spec(`    data: data.acumulado\n    x: mes`)))).toThrow(/requiere 'metrics'/)
  })
})

describe('series largo · pliegue', () => {
  it('series en orden de aparición (el SQL manda), x conserva su valor crudo, y los pares repetidos suman', () => {
    const rows = [
      { mes: 'Ene', v: 'B', a: 1 }, { mes: 'Ene', v: 'A', a: 2 },
      { mes: 'Feb', v: 'B', a: 3 }, { mes: 'Feb', v: 'B', a: 4 }, { mes: 'Feb', v: 'A', a: 5 },
    ]
    const f = foldSeriesColumn(rows, 'mes', 'v', 'a', CHART_MAX_SERIES, Number.NaN)
    expect(f.metricsSpec.map((m) => m.label)).toEqual(['B', 'A'])
    expect(f.rows.map((r) => r['mes'])).toEqual(['Ene', 'Feb'])
    expect(f.rows[1]).toMatchObject({ __s0: 7, __s1: 5 })
  })
  it('la celda ausente es hueco (NaN) con `fill: NaN` y 0 por defecto (el apilado de #203 no cambia)', () => {
    const rows = [{ mes: 'Ene', v: 'A', a: 1 }, { mes: 'Ene', v: 'B', a: 2 }, { mes: 'Feb', v: 'A', a: 3 }]
    expect(Number.isNaN(foldSeriesColumn(rows, 'mes', 'v', 'a', 8, Number.NaN).rows[1]['__s1'])).toBe(true)
    expect(foldSeriesColumn(rows, 'mes', 'v', 'a').rows[1]['__s1']).toBe(0)
  })
  it('sobre 8 series, el excedente se agrega en «(otras)» (misma cota que #203)', () => {
    const f = foldSeriesColumn(largo(Array.from({ length: 10 }, (_, i) => `V${i}`)).map((r) => ({ ...r, acumulado: 1 })), 'mes', 'version_etiqueta', 'acumulado')
    expect(f.capped).toBe(true)
    expect(f.metricsSpec).toHaveLength(9)
    expect(f.metricsSpec[8].label).toBe(OTHER_SERIES_LABEL)
    expect(f.rows[0]['__s8']).toBe(2)
  })
})

describe('series largo · spreadNameTops', () => {
  it('separa lo que está a menos de `gap`, conserva el orden y no sale del área', () => {
    const out = spreadNameTops([100, 101, 102, 239], 13, 240)
    const sorted = [...out].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(13 - 1e-9)
    expect(Math.max(...out)).toBeLessThanOrEqual(240)
    expect(out[0]).toBeLessThan(out[1])
  })
  it('lo ya separado no se mueve', () => {
    expect(spreadNameTops([10, 100, 200], 13, 240)).toEqual([10, 100, 200])
  })
})

describe('series largo · render', () => {
  /** `<text>` de las capas de marcas (excluye ejes y leyenda), con opacidad ≠ 0. */
  const visibles = (html: string): string[] => {
    const out: string[] = []
    let i = html.indexOf('mark-text role-mark')
    while (i >= 0) {
      const seg = html.slice(i, html.indexOf('</g>', i))
      for (const m of seg.matchAll(/<text([^>]*)>([^<>]*)<\/text>/g)) if (!/\sopacity="0"/.test(m[1])) out.push(m[2])
      i = html.indexOf('mark-text role-mark', i + 1)
    }
    return out
  }
  const VERSIONES = ['Base', 'Presupuesto 2026 v3', 'Reproyección Q2']

  it('una línea por valor de la columna: la leyenda trae el nombre EXACTO de cada versión', async () => {
    const out = await render(LARGO, largo(VERSIONES))
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    for (const v of VERSIONES) expect(html).toContain(`>${v}<`)
    expect(html).toContain('Acumulado por versión')
  })

  it('`names: true` rotula cada línea con su nombre, una vez por serie', async () => {
    const out = await render(LARGO, largo(VERSIONES))
    const t = visibles(out.html ?? '')
    for (const v of VERSIONES) expect(t.filter((x) => x === v)).toHaveLength(1)
  })

  it('sin `names` ninguna línea lleva su nombre en el área de datos (default apagado)', async () => {
    const out = await render(LARGO.replace('    names: true\n', ''), largo(VERSIONES))
    expect(out.ok).toBe(true)
    const t = visibles(out.html ?? '')
    for (const v of VERSIONES) expect(t).not.toContain(v)
  })

  it('los rótulos de valor salen abreviados con `format: abbr`', async () => {
    const out = await render(LARGO, largo(VERSIONES, 1_500_000))
    const t = visibles(out.html ?? '')
    expect(t.some((x) => /^\d+(,\d)?\s?(M|MM|K|mil)/i.test(x) || /M$/.test(x))).toBe(true)
    expect(t.some((x) => /^1\.500\.000$/.test(x))).toBe(false)
  })

  it('el número de series sale del dato: dos selecciones distintas, dos gráficos con sus series', async () => {
    const dos = (await render(LARGO, largo(['Base', 'Alta']))).html ?? ''
    const cuatro = (await render(LARGO, largo(['Base', 'Alta', 'Media', 'Baja']))).html ?? ''
    expect(visibles(dos).filter((x) => ['Base', 'Alta'].includes(x))).toHaveLength(2)
    expect(visibles(cuatro).filter((x) => ['Base', 'Alta', 'Media', 'Baja'].includes(x))).toHaveLength(4)
    expect(dos).not.toContain('>Media<')
  })

  it('un mes sin dato en una serie es hueco, no una caída a cero', async () => {
    const rows = largo(['Base', 'Alta']).filter((r) => !(r.mes === 'Mar' && r.version_etiqueta === 'Alta'))
    const out = await render(LARGO, rows)
    expect(out.ok).toBe(true)
    // El «0» de una caída falsa se rotularía; con hueco no hay rótulo de cero.
    expect(visibles(out.html ?? '')).not.toContain('0')
  })

  it('`names` también rotula el formato ancho (y respeta el label del spec)', async () => {
    const piece = {
      type: 'series', xField: 'mes', seriesNames: true,
      rows: MESES.map((m, i) => ({ mes: m, a: (i + 1) * 10, b: (i + 1) * 30 })),
      seriesSpec: [{ field: 'a', label: 'Real' }, { field: 'b', label: 'Plan' }],
    } as ResolvedNode
    const t = visibles(await renderPiece(piece))
    expect(t).toContain('Real')
    expect(t).toContain('Plan')
  })

  it('nombres de dos líneas que terminan juntas no se pisan (misma altura de extremo)', async () => {
    const piece = {
      type: 'series', xField: 'mes', seriesNames: true,
      rows: MESES.map((m, i) => ({ mes: m, a: (i + 1) * 10, b: (i + 1) * 10 })),
      seriesSpec: [{ field: 'a', label: 'Uno' }, { field: 'b', label: 'Dos' }],
    } as ResolvedNode
    const html = await renderPiece(piece)
    const ys = ['Uno', 'Dos'].map((n) => {
      const m = html.match(new RegExp(`<text[^>]*transform="translate\\(([\\d.]+),([\\d.]+)\\)"[^>]*>${n}</text>`))
      return m ? Number(m[2]) : NaN
    })
    expect(ys.every(Number.isFinite)).toBe(true)
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThanOrEqual(12)
  })
})
