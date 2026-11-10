// #459 · #460 · Toda vista lleva en su cabecera «← Volver», «Inicio» y «Catálogo», con aspecto de botón.
//
// Lo pidió la certificación interna de los PI de una instalación (10-11-2026), por tercera vez: el
// regreso era un enlace gris de 12 px que solo existía tras un drill, y no había «Inicio» (la portada
// del PI, no el listado). El catálogo vivía en la bandeja.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

const piece: ResolvedNode = { type: 'table', title: 'T', columnsSpec: [{ field: 'id', label: 'ID' }], rows: [{ id: 1 }] }
const PAGES = { items: [{ id: 'portada', title: 'Portada' }, { id: 'detalle', title: 'Detalle' }], active: 'portada' }

async function render(params: Record<string, unknown>): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ theme: 'roble', title: 'X', piece, ...params }, { agent: 'test' })) as { html: string }
  return html
}
const dec = (s: string) => s.replace(/&amp;/g, '&')
const cabecera = (html: string) => /<nav class="vnav"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? ''
const BOTON = /<a class="vnav-btn ([a-z-]+)" href="([^"]*)"[^>]*>([^<]*)<\/a>/g
const botones = (html: string) => [...cabecera(html).matchAll(BOTON)].map((m) => ({ cls: m[1], href: dec(m[2]), txt: m[3] }))

describe('#459 · Volver e Inicio en la cabecera', () => {
  it('en la portada sin drill: Inicio (marcado como actual) y Catálogo; no hay a dónde volver', async () => {
    const b = botones(await render({ pages: PAGES, carryCtx: { periodo: '2026-11' } }))
    expect(b.map((x) => x.txt)).toEqual(['Inicio', 'Catálogo'])
    expect(cabecera(await render({ pages: PAGES }))).toContain('aria-current="page"')
  })

  it('en una vista alcanzada por drill: «← Volver» a su origen, con vret=1', async () => {
    const back = [{ title: 'Portada', query: 'page=portada&ctx.periodo=2026-11' }]
    const html = await render({ pages: { ...PAGES, active: 'detalle' }, carryCtx: { periodo: '2026-11' }, back })
    const b = botones(html)
    expect(b.map((x) => x.txt)).toEqual(['← Volver', 'Inicio', 'Catálogo'])
    expect(b[0].href).toBe('?page=portada&ctx.periodo=2026-11&vret=1')
    expect(cabecera(html)).toContain('title="Volver a «Portada»"')
  })

  it('Inicio lleva a la PRIMERA vista del PI (la portada), con el alcance de cabecera, no al catálogo', async () => {
    const html = await render({ pages: { ...PAGES, active: 'detalle' }, carryCtx: { periodo: '2026-11' }, back: [{ title: 'Portada', query: 'page=portada' }] })
    const inicio = botones(html).find((x) => x.cls === 'vnav-inicio')!
    expect(inicio.href).toBe('?page=portada&ctx.periodo=2026-11')
    expect(cabecera(html)).not.toMatch(/vnav-inicio[^>]*aria-current/)
  })

  it('un PI de una sola vista también tiene Inicio y Catálogo', async () => {
    const b = botones(await render({}))
    expect(b.map((x) => x.txt)).toEqual(['Inicio', 'Catálogo'])
    expect(b.find((x) => x.cls === 'vnav-catalogo')!.href).toBe('/')
  })

  it('con dos niveles de drill, debajo de los botones va la ruta completa', async () => {
    const back = [
      { title: 'Detalle', query: 'page=detalle&ctx.k=1&from=page%3Dportada' },
      { title: 'Portada', query: 'page=portada' },
    ]
    const html = await render({ pages: { ...PAGES, active: 'detalle' }, back })
    expect(botones(html)[0].href).toBe('?page=detalle&ctx.k=1&from=page%3Dportada&vret=1')
    expect(/<nav class="vback"[\s\S]*?<\/nav>/.exec(html)?.[0]).toMatch(/Portada<\/a><span class="vback-sep">›<\/span><a [^>]*>Detalle/)
  })

  it('aspecto de botón: borde, relleno y fondo; no el enlace gris de 12 px', async () => {
    const html = await render({ pages: PAGES })
    const css = /\.vnav \.vnav-btn\{([^}]*)\}/.exec(html)?.[1] ?? ''
    expect(css).toMatch(/border:1px solid/)
    expect(css).toMatch(/padding:6px 14px/)
    expect(css).toMatch(/background:/)
    expect(css).not.toMatch(/font-size:12px/)
  })
})
