// #250 · El fallback de `?page=<id>` desconocido se declara al USUARIO, no solo al operador.
//
// Un enlace guardado a una vista que después se renombró sigue sirviendo con HTTP 200 la primera
// vista (deliberado: no romper marcadores viejos vale). El operador ya se enteraba —evento
// `mira-page-unknown`—; el usuario no. Acá se mide que la nav emite el aviso, que el id pedido viaja
// ESCAPADO y RECORTADO (viene de la URL: es entrada no confiable y puede ser arbitrariamente larga),
// que sin fallback no hay aviso (control) y que en papel sobrevive — un PDF generado desde el mismo
// enlace roto también tiene que decirlo.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, type ResolvedNode, type PagesNav } from '@vergis/capabilities'

const piece = { text: { content: 'contenido' } } as unknown as ResolvedNode

const nav = (extra: Partial<PagesNav> = {}): PagesNav => ({
  items: [
    { id: 'resumen', title: 'Resumen' },
    { id: 'detalle', title: 'Detalle' },
  ],
  active: 'resumen',
  ...extra,
})

async function render(pages: PagesNav, print = false): Promise<string> {
  const { html } = (await renderHtmlPiece.execute(
    { piece, title: 'T', theme: 'arbol', pages, print },
    { agent: 't' },
  )) as { html: string }
  return html
}

describe('nav de vistas · aviso de vista desconocida (#250)', () => {
  it('con `unknown` → el aviso nombra la vista PEDIDA y la que se está mostrando', async () => {
    const html = await render(nav({ unknown: 'nope' }))
    expect(html).toContain('class="vpages-aviso"')
    expect(html).toContain('role="status"')
    expect(html).toContain('nope')
    expect(html).toContain('Resumen')
  })

  it('sin `unknown` → NINGÚN aviso (control: la navegación normal no dice nada)', async () => {
    const html = await render(nav())
    expect(html).not.toContain('vpages-aviso')
  })

  it('el id pedido viaja ESCAPADO — un `?page=` con markup no inyecta nada', async () => {
    const html = await render(nav({ unknown: '<img src=x>' }))
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img src=x>')
  })

  it('un id larguísimo se RECORTA (≤60 + elipsis): la URL no dicta el largo del aviso', async () => {
    const largo = 'a'.repeat(200)
    const html = await render(nav({ unknown: largo }))
    const aviso = /<p class="vpages-aviso"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? ''
    expect(aviso).toContain(`${'a'.repeat(60)}…`)
    expect(aviso).not.toContain('a'.repeat(61))
  })

  it('en print el aviso SIGUE presente (el PDF nace del mismo enlace roto)', async () => {
    const html = await render(nav({ unknown: 'nope' }), true)
    expect(html).toContain('class="vpages-aviso"')
    expect(html).toContain('nope')
  })
})
