// #208 · Tooltip por marca. El rótulo de valor no siempre cabe —`labelMode`/`assignLanes` ocultan
// rótulos para que no se fundan—, así que hay dato que se dibuja y no se puede leer. El tooltip lo
// hace legible sin competir por espacio.
//
// Lo que se mide acá NO es que el tooltip "se vea": es (1) que exista UN `<title>` por marca de dato,
// (2) que su texto sea el MISMO `vtFormat` del rótulo impreso —para que hover y etiqueta no puedan
// discrepar— y (3) que el `aria-label` sobreviva, que es lo que lee un lector de pantalla.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, svgTitlesDesdeAria, type ResolvedNode } from '@vergis/capabilities'

async function render(piece: ResolvedNode): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ piece, title: 'T', theme: 'arbol' }, { agent: 't' })) as {
    html: string
  }
  return html
}

/** `<title>` de las MARCAS (excluye el `<title>` de la página, que lleva el título de la pieza). */
function tooltips(html: string): string[] {
  return [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]!).filter((t) => t !== 'T')
}

describe('#208 · distribution simple', () => {
  const piece = {
    type: 'distribution', dimensionField: 'c', metricField: 'v', orientation: 'vertical',
    rows: [{ c: 'Enero', v: 10 }, { c: 'Febrero', v: 20 }],
  } as unknown as ResolvedNode

  it('un tooltip por barra, con la categoría y el valor formateado', async () => {
    const t = tooltips(await render(piece))
    expect(t.sort()).toEqual(['Enero — 10', 'Febrero — 20'])
  })

  it('la CARDINALIDAD calza con las filas de la consulta', async () => {
    expect(tooltips(await render(piece))).toHaveLength(2)
  })

  it('el `aria-label` sobrevive: la misma frase sirve al lector de pantalla', async () => {
    const html = await render(piece)
    expect(html).toContain('aria-label="Febrero — 20"')
  })

  it('el valor del hover usa el MISMO formateador del rótulo impreso (millones abreviados)', async () => {
    const grande = { ...piece, rows: [{ c: 'Enero', v: 1234567 }] } as unknown as ResolvedNode
    const t = tooltips(await render(grande))
    expect(t).toEqual(['Enero — 1,2M'])
  })
})

describe('#208 · distribution agrupado', () => {
  it('el tooltip nombra la SERIE, que es lo que el rótulo no alcanza a decir', async () => {
    const piece = {
      type: 'distribution', dimensionField: 'mes', orientation: 'vertical',
      metricsSpec: [{ field: 'a', label: 'Venta' }, { field: 'b', label: 'Traslado' }],
      rows: [{ mes: 'Enero', a: 10, b: 5 }],
    } as unknown as ResolvedNode
    const t = tooltips(await render(piece))
    expect(t.sort()).toEqual(['Enero · Traslado — 5', 'Enero · Venta — 10'])
  })
})

describe('#208 · series (líneas) — el caso que originó el pedido', () => {
  it('cada punto dice su valor, incluso donde el rótulo se ocultó por colisión', async () => {
    const piece = {
      type: 'series', xField: 'mes',
      seriesSpec: [{ field: 'real', label: 'Real' }],
      rows: [{ mes: 'Ene', real: 100 }, { mes: 'Feb', real: 200 }, { mes: 'Mar', real: 300 }],
    } as unknown as ResolvedNode
    const t = tooltips(await render(piece))
    expect(t).toContain('Ene · Real — 100')
    expect(t).toContain('Mar · Real — 300')
    // Un punto por fila: el tooltip NO depende de que el rótulo se haya mostrado.
    expect(t).toHaveLength(3)
  })
})

describe('#208 · el espejo aria → title, aislado', () => {
  it('solo toca marcas de dato: no inventa títulos en ejes ni leyendas', () => {
    const svg =
      '<path aria-label="ojo" role="graphics-symbol" aria-roledescription="bar" d="M0,0"/>' +
      '<path aria-label="X-axis for a discrete scale" aria-roledescription="axis" d="M0,0"/>'
    const out = svgTitlesDesdeAria(svg)
    expect(out).toContain('<title>ojo</title>')
    expect(out).not.toContain('<title>X-axis')
  })

  it('es idempotente sobre un SVG sin aria-label', () => {
    const svg = '<path d="M0,0"/>'
    expect(svgTitlesDesdeAria(svg)).toBe(svg)
  })
})
