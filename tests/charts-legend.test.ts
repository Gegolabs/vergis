// #79 · #96 · Leyenda de los charts multi-serie — CONVENCIÓN DE PLATAFORMA (no declarable por spec).
// El contrato es GEOMÉTRICO y se verifica sobre el SVG emitido, que es la verdad servida (un test de
// string sobre el spec Vega-Lite no probaría nada: el motor podría ignorar el `orient`): la leyenda va
// ARRIBA y FUERA del rectángulo de datos, con solape CERO contra el área de plot.
//
// #96 es exactamente ese cero: con `orient: 'top-right'` —un orient de ESQUINA, que Vega posiciona
// dentro del rectángulo de datos sin reservarle espacio— la leyenda caía 100% dentro del área de plot
// y pisaba la barra más alta y el cruce de curvas. Con `orient: 'top'` Vega le reserva una banda del
// lienzo y el área de plot se desplaza hacia abajo.
import { describe, expect, it } from 'vitest'
import { legendColumns, legendEntryWidthPx, renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

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
      if (stack.length > 1) stack.pop()
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
