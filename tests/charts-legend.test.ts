// #79 · Leyenda arriba a la derecha — CONVENCIÓN DE PLATAFORMA (no declarable por spec).
// La posición se verifica GEOMÉTRICAMENTE sobre el SVG emitido: Vega serializa el grupo de leyenda
// como `<g class="mark-group role-legend">` seguido de un `<g transform="translate(x,y)">`. Arriba a
// la derecha ⇒ `y` en la banda superior del lienzo y `x` en la mitad derecha. Un test de string sobre
// el spec Vega-Lite no probaría nada (el motor podría ignorarlo); el SVG es la verdad servida.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

/**
 * Lienzo del SVG del CHART — `class="marks"` es el emitido por Vega; el HTML trae además SVGs
 * pequeños de iconografía del shell, que no son el lienzo contra el que se mide la leyenda.
 */
function svgBox(html: string): { w: number; h: number } {
  const m = html.match(/<svg[^>]*class="marks"[^>]*width="(\d+(?:\.\d+)?)"\s+height="(\d+(?:\.\d+)?)"/)
  if (!m) throw new Error('no se encontró el <svg class="marks"> del chart')
  return { w: Number(m[1]), h: Number(m[2]) }
}

/** Traslación del grupo de leyenda (el `translate` inmediatamente posterior a `role-legend`). */
function legendTranslate(html: string): { x: number; y: number } {
  const i = html.indexOf('role-legend"')
  if (i < 0) throw new Error('el SVG no trae grupo de leyenda (role-legend)')
  const m = html.slice(i).match(/translate\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)/)
  if (!m) throw new Error('el grupo de leyenda no trae translate')
  return { x: Number(m[1]), y: Number(m[2]) }
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

describe('#79 · leyenda top-right', () => {
  it('distribution agrupado horizontal: leyenda en la banda superior y mitad derecha', async () => {
    const html = await renderPiece(GROUPED)
    const { w, h } = svgBox(html)
    const { x, y } = legendTranslate(html)
    expect(y).toBeLessThan(h * 0.25)
    expect(x).toBeGreaterThan(w * 0.5)
  })

  it('distribution agrupado vertical: misma convención', async () => {
    const html = await renderPiece({ ...GROUPED, orientation: 'vertical' })
    const { w, h } = svgBox(html)
    const { x, y } = legendTranslate(html)
    expect(y).toBeLessThan(h * 0.25)
    expect(x).toBeGreaterThan(w * 0.5)
  })

  it('series (líneas): misma convención', async () => {
    const html = await renderPiece(SERIES)
    const { w, h } = svgBox(html)
    const { x, y } = legendTranslate(html)
    expect(y).toBeLessThan(h * 0.25)
    expect(x).toBeGreaterThan(w * 0.5)
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
