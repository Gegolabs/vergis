// #81 · Orden declarable de las categorías de un `distribution`.
// Vocabulario CERRADO: `magnitude` (default e implícito, contrato histórico) · `chrono` (manda el
// ORDER BY del SQL — el motor NO parsea fechas) · `value:<serie>` (por UNA serie declarada).
// El orden se verifica sobre el SVG servido leyendo las etiquetas del eje categórico en el orden en
// que Vega las emite: el `sort` del encoding es lo que antes dejaba MUERTO al orden declarado.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec, parseChartSort } from '@vergis/mira'
import { renderHtmlPiece, CHART_MAX_BARS, groupedTopN, type ResolvedNode } from '@vergis/capabilities'
import { VergisError, type Capability } from '@vergis/botler'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

function mockSql(rows: Record<string, unknown>[]): Capability {
  return { name: 'mock-sql', async execute() { return { rows } } }
}
async function render(yaml: string, rows: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-dsort-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yaml)
  return runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql(rows)] })
}

/**
 * Etiquetas del eje categórico en el ORDEN en que Vega las emite. El eje categórico es el que trae
 * las etiquetas de texto no numéricas; se filtran los números del eje cuantitativo y las etiquetas
 * de leyenda (que van dentro del grupo `role-legend`).
 */
function axisLabels(html: string, expected: string[]): string[] {
  // `class="marks"` es el SVG que emite Vega; el shell HTML trae además SVGs de iconografía.
  const i = html.indexOf('<svg xmlns')
  if (i < 0) throw new Error('no se encontró el SVG del chart')
  const svg = html.slice(i, html.indexOf('</svg>', i))
  const legend = svg.indexOf('role-legend"')
  const body = legend >= 0 ? svg.slice(0, legend) : svg
  const set = new Set(expected)
  return [...body.matchAll(/>([^<>]+)<\/text>/g)].map((m) => m[1]).filter((t) => set.has(t))
}

const GROUPED_YAML = (sort = ''): string => `
mira_version: "1.0"
identity: { id: pi-sort-grouped, display_name: "Sort", classification: internal }
piece:
  distribution:
    dimension: data.d.periodo
    metrics:
      - { field: a, label: "Alfa" }
      - { field: b, label: "Beta" }
    orientation: vertical
${sort ? `    sort: ${sort}\n` : ''}    title: "Orden"
data:
  d:
    capability: mock-sql
    params: { sql: "SELECT periodo, a, b FROM dbo.x ORDER BY orden" }
    shape: { type: rows, fields: { periodo: string, a: number, b: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

// Orden de llegada (el «SQL») deliberadamente distinto de cualquier orden por magnitud:
//   suma:  p1=11 · p2=104 · p3=53   → magnitude: p2, p3, p1
//   Alfa:  p1=10 · p2=4   · p3=50   → value:Alfa: p3, p1, p2
const ROWS = [
  { periodo: 'p1', a: 10, b: 1 },
  { periodo: 'p2', a: 4, b: 100 },
  { periodo: 'p3', a: 50, b: 3 },
]
const CATS = ['p1', 'p2', 'p3']

describe('#81 · normalización del token (parseChartSort)', () => {
  const metrics = [
    { field: 'a', label: 'Alfa' },
    { field: 'b', label: 'Beta' },
  ]
  it('ausente ⇒ sin criterio (el render aplica el contrato histórico)', () => {
    expect(parseChartSort(undefined, metrics)).toBeUndefined()
  })
  it('magnitude y chrono se reconocen', () => {
    expect(parseChartSort('magnitude', metrics)).toEqual({ kind: 'magnitude' })
    expect(parseChartSort('chrono', metrics)).toEqual({ kind: 'chrono' })
  })
  it('value:<label> y value:<field> resuelven a la MISMA serie', () => {
    expect(parseChartSort('value:Alfa', metrics)).toEqual({ kind: 'value', field: 'a', label: 'Alfa' })
    expect(parseChartSort('value:a', metrics)).toEqual({ kind: 'value', field: 'a', label: 'Alfa' })
  })
  it('token legacy `-campo` se sigue leyendo como orden por campo', () => {
    expect(parseChartSort('-a', metrics)).toEqual({ kind: 'field', field: 'a', desc: true })
    expect(parseChartSort('a', metrics)).toEqual({ kind: 'field', field: 'a', desc: false })
  })
  it('value:<inexistente> degrada a magnitude (nunca a un campo fantasma)', () => {
    expect(parseChartSort('value:no_existe', metrics)).toEqual({ kind: 'magnitude' })
  })
})

describe('#81 · validación', () => {
  it('magnitude / chrono / value:<serie> pasan', () => {
    for (const s of ['magnitude', 'chrono', 'value:Alfa', 'value:b']) {
      expect(() => validate(parseSpec(GROUPED_YAML(s))), s).not.toThrow()
    }
  })
  it('value:<inexistente> se rechaza con remediación que nombra las series', () => {
    expect(() => validate(parseSpec(GROUPED_YAML('value:no_existe')))).toThrow(
      /no corresponde a ninguna serie/,
    )
    try {
      validate(parseSpec(GROUPED_YAML('value:no_existe')))
    } catch (e) {
      expect((e as VergisError).structured.remediation).toMatch(/'Alfa'/)
      expect((e as VergisError).structured.code).toBe('distribution-sort-value-dangling')
    }
  })
  it('token fuera del vocabulario en modo agrupado se rechaza (nunca tuvo efecto ahí)', () => {
    expect(() => validate(parseSpec(GROUPED_YAML('"-a"')))).toThrow(/no pertenece al vocabulario/)
  })
  it('sort no-cadena se rechaza', () => {
    expect(() => validate(parseSpec(GROUPED_YAML('123')))).toThrow(/debe ser una cadena/)
  })
})

describe('#81 · render agrupado: el mismo dato en tres órdenes distintos', () => {
  it('sort ausente ⇒ magnitude (suma de series desc) — contrato histórico', async () => {
    const out = await render(GROUPED_YAML(), ROWS)
    expect(out.ok).toBe(true)
    expect(axisLabels(out.html ?? '', CATS)).toEqual(['p2', 'p3', 'p1'])
  })
  it('magnitude explícito ⇒ idéntico al default', async () => {
    const a = await render(GROUPED_YAML(), ROWS)
    const b = await render(GROUPED_YAML('magnitude'), ROWS)
    expect(axisLabels(b.html ?? '', CATS)).toEqual(axisLabels(a.html ?? '', CATS))
  })
  it('chrono ⇒ orden de llegada de las filas (manda el SQL)', async () => {
    const out = await render(GROUPED_YAML('chrono'), ROWS)
    expect(axisLabels(out.html ?? '', CATS)).toEqual(['p1', 'p2', 'p3'])
  })
  it('value:Alfa ⇒ orden por ESA serie, no por la suma', async () => {
    const out = await render(GROUPED_YAML('value:Alfa'), ROWS)
    expect(axisLabels(out.html ?? '', CATS)).toEqual(['p3', 'p1', 'p2'])
  })
  it('los tres órdenes son visiblemente distintos entre sí', async () => {
    const [m, c, v] = await Promise.all([
      render(GROUPED_YAML('magnitude'), ROWS),
      render(GROUPED_YAML('chrono'), ROWS),
      render(GROUPED_YAML('value:Alfa'), ROWS),
    ])
    const orders = [m, c, v].map((o) => axisLabels(o.html ?? '', CATS).join('|'))
    expect(new Set(orders).size).toBe(3)
  })
  it('cualquier orden dibuja las 3×2 = 6 barras (ninguno vacía el chart)', async () => {
    for (const s of ['magnitude', 'chrono', 'value:Alfa']) {
      const out = await render(GROUPED_YAML(s), ROWS)
      // 6 barras + 1 contenedor de la capa de rótulos (#80).
      expect(((out.html ?? '').match(/role-mark/g) ?? []).length, s).toBe(6 + 1)
    }
  })
})

describe('#81 · cota top-N bajo cada criterio', () => {
  const N = CHART_MAX_BARS + 5
  // Serie `s1` decreciente con el índice, `s2` creciente ⇒ los rankings por s1, por s2 y por suma
  // difieren, y el orden de llegada es el del índice.
  const rows = Array.from({ length: N }, (_, i) => ({ dim: `d${i}`, s1: N - i, s2: i + 1 }))
  const fields = ['s1', 's2']

  it('chrono NO re-ordena al aplicar la cota: primeras N en orden de llegada + «(otros)»', () => {
    const { rows: out, grouped } = groupedTopN(rows, 'dim', fields, CHART_MAX_BARS, { by: 'arrival' })
    expect(grouped).toBe(true)
    expect(out.slice(0, CHART_MAX_BARS).map((r) => r.dim)).toEqual(
      rows.slice(0, CHART_MAX_BARS).map((r) => r.dim),
    )
    expect(out[out.length - 1].dim).toBe('(otros)')
  })

  it('value:<serie> ⇒ el top-N usa ESA serie y «(otros)» sigue cuadrando por serie', () => {
    const totalS1 = rows.reduce((s, r) => s + r.s1, 0)
    const totalS2 = rows.reduce((s, r) => s + r.s2, 0)
    const { rows: out } = groupedTopN(rows, 'dim', fields, CHART_MAX_BARS, { by: 'field', field: 's2' })
    // Ranking por s2 (creciente con el índice) ⇒ arriba las ÚLTIMAS filas de llegada.
    expect(out[0].dim).toBe(`d${N - 1}`)
    expect(out.reduce((s, r) => s + (Number(r.s1) || 0), 0)).toBe(totalS1)
    expect(out.reduce((s, r) => s + (Number(r.s2) || 0), 0)).toBe(totalS2)
  })

  it('el ranking por defecto (suma) queda intacto', () => {
    const { rows: out } = groupedTopN(rows, 'dim', fields, CHART_MAX_BARS)
    const bySum = [...rows].sort((a, b) => b.s1 + b.s2 - (a.s1 + a.s2))
    expect(out.slice(0, CHART_MAX_BARS).map((r) => r.dim)).toEqual(
      bySum.slice(0, CHART_MAX_BARS).map((r) => r.dim),
    )
  })
})

describe('#81 · modo mono', () => {
  const MONO: ResolvedNode = {
    type: 'distribution',
    dimensionField: 'periodo',
    metricField: 'a',
    orientation: 'vertical',
    rows: ROWS,
  }
  async function html(node: ResolvedNode): Promise<string> {
    const r = (await renderHtmlPiece.execute({ piece: node, title: 'X', theme: 'arbol' }, { agent: 't' })) as {
      html: string
    }
    return r.html
  }

  it('sin sortSpec ⇒ magnitud descendente (contrato histórico)', async () => {
    expect(axisLabels(await html(MONO), CATS)).toEqual(['p3', 'p1', 'p2'])
  })

  it('chrono ⇒ el orden de llegada, que antes el encoding pisaba', async () => {
    expect(axisLabels(await html({ ...MONO, sortSpec: { kind: 'chrono' } }), CATS)).toEqual(['p1', 'p2', 'p3'])
  })

  it('el token legacy pre-ordenado por compose YA SURTE EFECTO en el render', async () => {
    // compose pre-ordena las filas (ascendente por `a`) y marca kind:'field'; antes de #81 el
    // encoding `-y` lo pisaba y el chart salía igual que magnitude.
    const asc = [...ROWS].sort((x, y) => x.a - y.a)
    const out = await html({ ...MONO, rows: asc, sortSpec: { kind: 'field', field: 'a', desc: false } })
    expect(axisLabels(out, CATS)).toEqual(['p2', 'p1', 'p3'])
  })
})
