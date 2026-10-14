// #79 · #96 · Leyenda de los charts multi-serie — arriba por CONVENCIÓN DE PLATAFORMA (CV-05); desde
// #365 (decisión de César, 2026-10-14) el spec puede pedirla a la derecha con `legend: right` (bloque final de este archivo).
// El contrato es GEOMÉTRICO y se verifica sobre el SVG emitido, que es la verdad servida (un test de
// string sobre el spec Vega-Lite no probaría nada: el motor podría ignorar el `orient`): la leyenda va
// ARRIBA y FUERA del rectángulo de datos, con solape CERO contra el área de plot.
//
// #96 es exactamente ese cero: con `orient: 'top-right'` —un orient de ESQUINA, que Vega posiciona
// dentro del rectángulo de datos sin reservarle espacio— la leyenda caía 100% dentro del área de plot
// y pisaba la barra más alta y el cruce de curvas. Con `orient: 'top'` Vega le reserva una banda del
// lienzo y el área de plot se desplaza hacia abajo.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  chartLegendConfig,
  LEGEND_RIGHT_LABEL_LIMIT_PX,
  legendColumns,
  legendEntryWidthPx,
  renderHtmlPiece,
  type ResolvedNode,
} from '@vergis/capabilities'
import { parseSpec, validateSpec } from '@vergis/mira'
import { VergisError, type Capability } from '@vergis/botler'
import { runSpec } from '@vergis/cli'

type Rect = { x: number; y: number; w: number; h: number }

/**
 * Lienzo del SVG del CHART — `class="marks"` es el emitido por Vega; el HTML trae además SVGs
 * pequeños de iconografía del shell, que no son el lienzo contra el que se mide la leyenda.
 */
function svgBox(html: string): { w: number; h: number } {
  const m = html.match(/<svg[^>]*class="marks"[^>]*width="(\d+(?:\.\d+)?)"\s+height="(\d+(?:\.\d+)?)"/)
  if (!m) throw new Error('no se encontró el <svg class="marks"> del chart')
  return { w: Number(m[1]), h: Number(m[2]) }
}

/**
 * Rects ABSOLUTOS (coordenadas del lienzo) del área de plot y del grupo de leyenda. Vega anida grupos
 * con `transform="translate(x,y)"` y le pone a cada uno un `<path class="background" d="M0,0h{w}v{h}…">`
 * con sus dimensiones: se acumulan los translate por la pila de `<g>` y se lee el primer background
 * no vacío del marco (plot) y del grupo `role-legend` (leyenda).
 */
function chartGeom(html: string): { plot: Rect; legend: Rect } {
  const stack: { cls: string; x: number; y: number }[] = [{ cls: '', x: 0, y: 0 }]
  let plot: Rect | undefined
  let legend: Rect | undefined
  for (const m of html.matchAll(/<\/?(?:g|path)\b[^>]*>/g)) {
    const tag = m[0]
    const top = stack[stack.length - 1]
    if (tag.startsWith('</')) {
      // Solo un `</g>` cierra un nivel de la pila: un `</path>` (las marcas con `<title>` adentro) no
      // abrió ninguno, y desapilar ahí perdía translates — invisible arriba, falso a la derecha.
      if (tag.startsWith('</g') && stack.length > 1) stack.pop()
      continue
    }
    if (tag.startsWith('<g')) {
      const t = tag.match(/transform="translate\((-?[\d.]+),(-?[\d.]+)\)"/)
      const c = tag.match(/class="([^"]*)"/)
      stack.push({ cls: c ? c[1] : '', x: top.x + (t ? Number(t[1]) : 0), y: top.y + (t ? Number(t[2]) : 0) })
      continue
    }
    if (!/class="background"/.test(tag)) continue
    const d = tag.match(/\bd="M0,0h(-?[\d.]+)v(-?[\d.]+)h/)
    if (!d) continue
    const w = Math.abs(Number(d[1]))
    const h = Math.abs(Number(d[2]))
    if (w === 0 || h === 0) continue
    const inFrame = stack.some((s) => /role-frame/.test(s.cls))
    const inLegend = stack.some((s) => /role-legend\b/.test(s.cls))
    if (!plot && inFrame && !inLegend) plot = { x: top.x, y: top.y, w, h }
    if (!legend && inLegend) legend = { x: top.x, y: top.y, w, h }
  }
  if (!plot) throw new Error('no se pudo medir el área de plot')
  if (!legend) throw new Error('el SVG no trae grupo de leyenda (role-legend)')
  return { plot, legend }
}

/** Área de intersección de dos rects, en px² (0 ⇒ no se tocan). */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

async function renderPiece(piece: ResolvedNode): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'roble' }, { agent: 't' })) as {
    html: string
  }
  return html
}

const GROUPED: ResolvedNode = {
  type: 'distribution',
  dimensionField: 'prog',
  metricsSpec: [
    { field: 'a', label: 'Alfa' },
    { field: 'b', label: 'Beta' },
  ],
  rows: [
    { prog: 'x', a: 1, b: 2 },
    { prog: 'y', a: 3, b: 4 },
  ],
}

const SERIES: ResolvedNode = {
  type: 'series',
  xField: 'mes',
  seriesSpec: [
    { field: 'a', label: 'Alfa' },
    { field: 'b', label: 'Beta' },
  ],
  rows: [
    { mes: 'ene', a: 1, b: 2 },
    { mes: 'feb', a: 3, b: 4 },
    { mes: 'mar', a: 2, b: 5 },
  ],
}

describe('#96 · la leyenda va fuera del área de plot', () => {
  for (const [nombre, piece] of [
    ['distribution agrupado horizontal', GROUPED],
    ['distribution agrupado vertical', { ...GROUPED, orientation: 'vertical' } as ResolvedNode],
    ['series (líneas)', SERIES],
  ] as [string, ResolvedNode][]) {
    it(`${nombre}: solape cero con el área de datos, y por encima de ella`, async () => {
      const html = await renderPiece(piece)
      const { plot, legend } = chartGeom(html)
      // El contrato de #96: ni un px² de la leyenda cae sobre el rectángulo de datos.
      expect(overlapArea(plot, legend)).toBe(0)
      // Y está ARRIBA: termina antes de que empiece el plot (no al costado ni abajo).
      expect(legend.y + legend.h).toBeLessThanOrEqual(plot.y)
    })
  }

  it('la banda de la leyenda la paga el LIENZO, no el área de plot (la geometría del chart no cambia)', async () => {
    const html = await renderPiece({ ...GROUPED, orientation: 'vertical' })
    const { plot } = chartGeom(html)
    const { h } = svgBox(html)
    // Contrato visual vigente del distribution agrupado vertical: 320 × 260 px de área de plot.
    expect(plot.w).toBe(320)
    expect(plot.h).toBe(260)
    // El lienzo es más alto que el plot: incluye los ejes y la banda de la leyenda.
    expect(h).toBeGreaterThan(plot.y + plot.h)
  })

  it('la leyenda no pisa las marcas: las etiquetas siguen presentes y el chart dibuja', async () => {
    const html = await renderPiece(GROUPED)
    expect(html).toContain('>Alfa<')
    expect(html).toContain('>Beta<')
    // 2 categorías × 2 series = 4 barras, + 1 contenedor de la capa de rótulos (#80).
    expect((html.match(/role-mark/g) ?? []).length).toBe(4 + 1)
  })

  it('distribution mono-métrica no emite leyenda (sin regresión)', async () => {
    const html = await renderPiece({
      type: 'distribution',
      dimensionField: 'prog',
      metricField: 'v',
      rows: [
        { prog: 'x', v: 1 },
        { prog: 'y', v: 3 },
      ],
    })
    expect(html).not.toContain('role-legend')
  })
})

// #365 · Con muchas series, la leyenda de una sola fila fijaba el ancho del SVG: en PI-32 (9 series de
// Clasificación) el SVG medía ~4× su área de datos, y en una rejilla de dos columnas el gráfico se
// dibujaba a menos de la mitad. La leyenda se parte en columnas para no pasar del ancho del área de
// datos; si ya cabía, queda exactamente como estaba.
const CLASIFICACIONES = [
  'Árboles frutales', 'Plantas de interior', 'Arbustos', 'Herramientas', 'Maceteros',
  'Sustratos', 'Semillas', 'Riego', 'Otros',
]
const MESES = ['jul-25', 'ago-25', 'sep-25', 'jul-26', 'ago-26', 'sep-26']

function apilado(labels: string[]): ResolvedNode {
  return {
    type: 'distribution',
    orientation: 'vertical',
    stacked: true,
    dimensionField: 'mes',
    metricsSpec: labels.map((label, k) => ({ field: `s${k}`, label })),
    rows: MESES.map((mes, i) => ({ mes, ...Object.fromEntries(labels.map((_, k) => [`s${k}`, (i + 1) * (k + 1)])) })),
  }
}

function seriesDe(labels: string[]): ResolvedNode {
  return {
    type: 'series',
    xField: 'mes',
    seriesSpec: labels.map((label, k) => ({ field: `s${k}`, label })),
    rows: MESES.map((mes, i) => ({ mes, ...Object.fromEntries(labels.map((_, k) => [`s${k}`, (i + 1) * (k + 1)])) })),
  }
}

describe('#365 · la leyenda no es más ancha que el área de datos', () => {
  for (const [nombre, piece] of [
    ['apilado vertical, 9 series (PI-32)', apilado(CLASIFICACIONES)],
    ['agrupado horizontal, 9 series', { ...apilado(CLASIFICACIONES), stacked: false, orientation: 'horizontal' } as ResolvedNode],
    ['series (líneas), 9 series de rótulo largo', seriesDe(CLASIFICACIONES.map((c) => `${c} — temporada completa`))],
  ] as [string, ResolvedNode][]) {
    it(`${nombre}: la leyenda cabe en el ancho del plot, en varias filas, arriba y sin pisarlo`, async () => {
      const html = await renderPiece(piece)
      const { plot, legend } = chartGeom(html)
      expect(legend.w).toBeLessThanOrEqual(plot.w)
      expect(legend.x + legend.w).toBeLessThanOrEqual(plot.x + plot.w)
      // Se partió: la banda tiene más de una fila (una fila mide 11 px).
      expect(legend.h).toBeGreaterThan(11)
      // Las garantías de #96 siguen: arriba y con solape cero.
      expect(overlapArea(plot, legend)).toBe(0)
      expect(legend.y + legend.h).toBeLessThanOrEqual(plot.y)
      // Todas las series siguen nombradas.
      for (const c of CLASIFICACIONES) expect(html).toContain(c)
    })
  }

  it('el SVG del caso PI-32 deja de medir ~4× su área de datos', async () => {
    const html = await renderPiece(apilado(CLASIFICACIONES))
    const { plot } = chartGeom(html)
    // Antes de #365 este SVG medía 997 px con un plot de 320. Ahora lo ensanchan solo los ejes.
    expect(svgBox(html).w).toBeLessThan(plot.w * 1.3)
  })

  it('una leyenda que ya cabía en una fila sale idéntica: el spec no lleva `columns`', async () => {
    // Dos series cortas en 320 px: una fila. El HTML debe ser el de siempre, sin grilla de leyenda.
    const html = await renderPiece({ ...GROUPED, orientation: 'vertical' })
    const { legend } = chartGeom(html)
    expect(legend.h).toBe(11)
    expect(legendColumns(['Alfa', 'Beta'], 320)).toBe(2)
  })

  it('legendColumns: el mayor número de columnas que cabe, alineando cada columna a su entrada más ancha', () => {
    // Entradas de 16 + 8·caracteres px: «Arbustos» = 80, «Plantas de interior» = 168.
    expect(legendEntryWidthPx('Arbustos')).toBe(80)
    expect(legendEntryWidthPx('Plantas de interior')).toBe(168)
    // labelLimit: un rótulo larguísimo mide como mucho 16 + 160.
    expect(legendEntryWidthPx('x'.repeat(100))).toBe(176)
    // Tres de 80 px caben en 260 (80·3 + 10·2), no en 259.
    expect(legendColumns(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'], 260)).toBe(3)
    expect(legendColumns(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'], 259)).toBe(2)
    // Ni una columna cabe: queda en 1 (vertical), nunca 0.
    expect(legendColumns(['Plantas de interior'], 50)).toBe(1)
    expect(legendColumns([], 320)).toBe(1)
  })
})

// #365 · decisión de César del 2026-10-14 · `legend: right` — la posición es declarable por spec, con ARRIBA por defecto. Lo que se
// mide es la geometría del SVG servido: la leyenda queda a la DERECHA del área de datos, vertical, sin
// pisarla y sin aplastarla. El control negativo es el mismo gráfico sin `legend`: sigue arriba.
const RUBROS = [
  'Árboles frutales', 'Plantas de interior', 'Arbustos ornamentales', 'Herramientas de jardín',
  'Maceteros y contenedores', 'Sustratos y fertilizantes', 'Semillas y bulbos', 'Riego y accesorios', '(otras)',
]

describe('#365 · `legend: right` pone la leyenda a la derecha y vertical', () => {
  for (const [nombre, piece] of [
    ['apilado vertical, 9 series (PI-32)', apilado(RUBROS)],
    ['agrupado vertical, 2 series', { ...GROUPED, orientation: 'vertical' } as ResolvedNode],
    ['agrupado horizontal, 9 series', { ...apilado(RUBROS), stacked: false, orientation: 'horizontal' } as ResolvedNode],
    ['series (líneas), 9 series', seriesDe(RUBROS)],
  ] as [string, ResolvedNode][]) {
    it(`${nombre}: a la derecha del plot, a su altura y sin solape; sin \`legend\` sigue arriba`, async () => {
      const n = piece.metricsSpec?.length ?? piece.seriesSpec?.length ?? 0
      const der = chartGeom(await renderPiece({ ...piece, legend: 'right' }))
      // A la derecha: empieza donde termina el área de datos, y no la pisa.
      expect(der.legend.x).toBeGreaterThanOrEqual(der.plot.x + der.plot.w)
      expect(overlapArea(der.plot, der.legend)).toBe(0)
      // A la altura del plot (no arriba ni abajo): su banda vertical empieza dentro de la del plot.
      expect(der.legend.y).toBeGreaterThanOrEqual(der.plot.y)
      expect(der.legend.y).toBeLessThan(der.plot.y + der.plot.h)
      // Vertical: una entrada por fila ⇒ al menos n filas de ~11 px (una fila horizontal mide 11).
      expect(der.legend.h).toBeGreaterThanOrEqual(11 * n)
      // El área de datos no cambia por mover la leyenda.
      const arr = chartGeom(await renderPiece(piece))
      expect(der.plot.w).toBe(arr.plot.w)
      expect(der.plot.h).toBe(arr.plot.h)
      // Control negativo: el MISMO gráfico sin `legend` deja la leyenda arriba, como en 0.43.0.
      expect(arr.legend.y + arr.legend.h).toBeLessThanOrEqual(arr.plot.y)
      expect(arr.legend.x).toBeLessThan(arr.plot.x + arr.plot.w)
    })
  }

  it('las barras no se aplastan: en el caso PI-32 el área de datos es más de la mitad del ancho del SVG', async () => {
    const html = await renderPiece({ ...apilado(RUBROS), legend: 'right' })
    const { plot } = chartGeom(html)
    // Medido en #365 con rótulos de hasta 20 caracteres visibles: 0,57. Con el tope de 25 la leyenda
    // es un poco más ancha; el piso que se garantiza es la mitad.
    expect(plot.w / svgBox(html).w).toBeGreaterThan(0.5)
  })

  it('a la derecha, un rótulo de hasta 25 caracteres sale entero; arriba se corta (control)', async () => {
    const largo = 'Sustratos y fertilizantes' // 25 caracteres
    const der = await renderPiece({ ...apilado(RUBROS), legend: 'right' })
    expect(der).toContain(`>${largo}<`)
    const arr = await renderPiece(apilado(RUBROS))
    expect(arr).not.toContain(`>${largo}<`)
  })

  it('`legend: top` explícito y la ausencia de `legend` dan el mismo SVG', async () => {
    const piece = apilado(RUBROS)
    expect(await renderPiece({ ...piece, legend: 'top' })).toBe(await renderPiece(piece))
  })

  it('chartLegendConfig: default arriba (sin cambio), derecha vertical con `labelLimit` solo si hace falta y con tope', () => {
    expect(chartLegendConfig(['Alfa', 'Beta'], 320)).toEqual({ orient: 'top', title: null, direction: 'horizontal' })
    expect(chartLegendConfig(['Alfa', 'Beta'], 320, 'top')).toEqual(chartLegendConfig(['Alfa', 'Beta'], 320))
    // Rótulos cortos: la derecha no reserva ancho que no usa (el `labelLimit` por defecto, 160).
    expect(chartLegendConfig(['Alfa', 'Beta'], 320, 'right')).toEqual({ orient: 'right', title: null, direction: 'vertical' })
    // 22 caracteres × 8 px = 176: el tope sube a lo justo (+1: Vega corta si el ancho NO es menor).
    expect(chartLegendConfig(['x'.repeat(22)], 320, 'right')).toEqual({ orient: 'right', title: null, direction: 'vertical', labelLimit: 177 })
    // Un rótulo larguísimo no hace crecer la leyenda más allá del tope.
    expect(chartLegendConfig(['x'.repeat(80)], 320, 'right')).toMatchObject({ labelLimit: LEGEND_RIGHT_LABEL_LIMIT_PX + 1 })
    expect(LEGEND_RIGHT_LABEL_LIMIT_PX).toBe(200)
    // La derecha no pasa por el cálculo de columnas: muchas series siguen siendo UNA columna.
    expect(chartLegendConfig(RUBROS, 50, 'right')).not.toHaveProperty('columns')
  })
})

// ── Validación y end-to-end del campo del DSL ────────────────────────────────────────────────────
const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']

const specCon = (el: 'distribution' | 'series', extra: string): string => `
mira_version: "1.0"
identity: { id: pi-leyenda, display_name: "Leyenda", classification: internal }
piece:
  layout: grid
  columns: 1
  elements:
${
  el === 'distribution'
    ? `    - distribution:
        dimension: data.cruce.mes
        metric: data.cruce.total
        series: zona
        stacked: true
        orientation: vertical
        title: "Por zona"`
    : `    - series:
        data: data.cruce
        x: mes
        metrics:
          - { field: total, label: "Total" }
          - { field: meta, label: "Meta" }
        title: "Acumulado"`
}
${extra}
data:
  cruce:
    capability: mock-sql
    params: { sql: "SELECT mes, zona, total, meta FROM dbo.x" }
    shape: { fields: { mes: string, zona: string, total: number, meta: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

describe('#365 · `legend` en el DSL', () => {
  const codeOf = (el: 'distribution' | 'series', extra: string): string => {
    try {
      validateSpec(parseSpec(specCon(el, extra)), { capabilities: CAPS, schema: SCHEMA })
    } catch (e) {
      return e instanceof VergisError ? String(e.structured.code ?? '') : `no-vergis-error: ${String(e)}`
    }
    return 'no-throw'
  }

  it('acepta `legend: right`, `legend: top` y su ausencia, en distribution y en series', () => {
    for (const el of ['distribution', 'series'] as const) {
      expect(codeOf(el, '')).toBe('no-throw')
      expect(codeOf(el, '        legend: right')).toBe('no-throw')
      expect(codeOf(el, '        legend: top')).toBe('no-throw')
    }
  })

  it('rechaza un valor fuera del vocabulario: dejaría la leyenda arriba en silencio', () => {
    expect(codeOf('distribution', '        legend: derecha')).toBe('distribution-legend-unknown')
    expect(codeOf('distribution', '        legend: Right')).toBe('distribution-legend-unknown')
    expect(codeOf('distribution', '        legend: left')).toBe('distribution-legend-unknown')
    expect(codeOf('series', '        legend: 1')).toBe('series-legend-unknown')
  })

  it('de punta a punta: el spec con `legend: right` sale con la leyenda a la derecha; sin él, arriba', async () => {
    const rows = ['ene', 'feb', 'mar'].flatMap((mes, i) =>
      ['Norte', 'Centro', 'Sur'].map((zona, k) => ({ mes, zona, total: (i + 1) * (k + 2), meta: 10 })),
    )
    const run = async (el: 'distribution' | 'series', extra: string): Promise<string> => {
      const dir = mkdtempSync(join(tmpdir(), 'vergis-leyenda-'))
      const specPath = join(dir, 'spec.yaml')
      writeFileSync(specPath, specCon(el, extra))
      const mock: Capability = { name: 'mock-sql', async execute() { return { rows } } }
      const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mock] })
      expect(out.ok).toBe(true)
      return out.html ?? ''
    }
    for (const el of ['distribution', 'series'] as const) {
      const der = chartGeom(await run(el, '        legend: right'))
      expect(der.legend.x).toBeGreaterThanOrEqual(der.plot.x + der.plot.w)
      const arr = chartGeom(await run(el, ''))
      expect(arr.legend.y + arr.legend.h).toBeLessThanOrEqual(arr.plot.y)
    }
  })
})
