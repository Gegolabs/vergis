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
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

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
  const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol' }, { agent: 't' })) as {
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
