// #203 · Modo APILADO de `distribution` multi-métrica.
//
// Nació de un caso real: la spec de PI-25 (A.R.B.O.L.) pide, aprobada, «gráfico de barras apiladas»,
// y el Producto solo sabía yuxtaponer. Se construyó agrupado como desviación declarada.
//
// Lo que se mide: (1) que apilado NO emita offset de serie —que es lo que separa las sub-barras—,
// (2) que la escala la mande la SUMA por categoría y no el máximo individual, y (3) que no se
// rotulen los segmentos, porque el rótulo de #80 razona sobre barras lado a lado.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

async function render(piece: ResolvedNode): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ piece, title: 'T', theme: 'arbol' }, { agent: 't' })) as {
    html: string
  }
  return html
}

const BASE = {
  type: 'distribution',
  dimensionField: 'mes',
  orientation: 'vertical',
  metricsSpec: [{ field: 'a', label: 'Venta' }, { field: 'b', label: 'Traslado' }],
  rows: [{ mes: 'Enero', a: 100, b: 50 }, { mes: 'Febrero', a: 200, b: 25 }],
} as unknown as ResolvedNode

/** Geometría de las barras dibujadas: `d="M0,<y>h<ancho>v<alto>…"`, en px del área de plot. */
function barras(html: string): { ancho: number; alto: number }[] {
  return [...html.matchAll(/aria-roledescription="bar"[^>]*d="M0,[\d.]+h([-\d.]+)v(-?[\d.]+)/g)].map((m) => ({
    ancho: Math.abs(Number(m[1])),
    alto: Math.abs(Number(m[2])),
  }))
}

describe('#203 · apilado', () => {
  it('agrupado sigue siendo el DEFAULT: sin `stacked`, se dibujan 4 sub-barras angostas', async () => {
    const b = barras(await render(BASE))
    expect(b).toHaveLength(4) // 2 categorías × 2 series, lado a lado
  })

  it('apilado dibuja los mismos 4 segmentos', async () => {
    const b = barras(await render({ ...BASE, stacked: true } as unknown as ResolvedNode))
    expect(b).toHaveLength(4)
  })

  it('LA PRUEBA DE QUE APILA (1): una barra ANCHA por categoría, no N angostas', async () => {
    const agr = barras(await render(BASE))
    const api = barras(await render({ ...BASE, stacked: true } as unknown as ResolvedNode))
    // Con 2 series, la barra apilada es ~el doble de ancha que la sub-barra agrupada.
    expect(api[0]!.ancho).toBeGreaterThan(agr[0]!.ancho * 1.8)
    // Y todos los segmentos de una columna comparten ancho: están uno sobre otro, no al lado.
    expect(new Set(api.map((x) => Math.round(x.ancho))).size).toBe(1)
  })

  it('LA PRUEBA DE QUE APILA (2): la escala la manda la SUMA, no el máximo individual', async () => {
    // Agrupado: el máximo individual (200) toca el tope del plot.
    // Apilado: la columna más alta es 225 (200+25) ⇒ el segmento de 200 ya NO llega al tope.
    const agr = Math.max(...barras(await render(BASE)).map((x) => x.alto))
    const api = Math.max(...barras(await render({ ...BASE, stacked: true } as unknown as ResolvedNode)).map((x) => x.alto))
    expect(api).toBeLessThan(agr)
  })

  it('en apilado NO se rotulan los segmentos: el valor lo dice el tooltip (#208)', async () => {
    const html = await render({ ...BASE, stacked: true } as unknown as ResolvedNode)
    expect(html).not.toContain('mark-text role-mark')
    // Pero el dato sigue siendo legible: un tooltip por segmento, con su serie.
    const tips = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]!).filter((t) => t !== 'T')
    expect(tips).toHaveLength(4)
    expect(tips).toContain('Enero · Venta — 100')
  })

  it('agrupado CONSERVA sus rótulos: el cambio no toca el modo por defecto', async () => {
    expect(await render(BASE)).toContain('mark-text role-mark')
  })
})
