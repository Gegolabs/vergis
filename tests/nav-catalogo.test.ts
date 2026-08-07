// «Volver al catálogo» a la mano (issue #136) — convención de PLATAFORMA, no config per-spec:
// (1) la marca/logo del header enlaza al índice (`/`) en TODO theme; (2) la bandeja abre con una
// entrada «← Catálogo» antes de sus tabs. En papel (`print: true`) no hay bandeja → no hay entrada.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'
import { arbolTheme, defaultTheme, type Theme } from '../packages/capabilities/src/themes/index'

const THEMES: [string, Theme][] = [
  ['arbol', arbolTheme],
  ['default', defaultTheme],
]

/** El `<a>` de la marca del header, con sus atributos tal como se emiten. */
const brandAnchor = (html: string): string => /<a class="brand"[^>]*>/.exec(html)?.[0] ?? ''

describe.each(THEMES)('logo-link al catálogo · theme %s (T1)', (_name, theme) => {
  const html = theme.wrap({ title: 'PI de prueba', body: '<div></div>' })

  it('la marca del header es un enlace al catálogo, rotulado para lector de pantalla', () => {
    const a = brandAnchor(html)
    expect(a).toContain('href="/"')
    expect(a).toContain('aria-label="Volver al catálogo"')
    expect(a).toContain('title="Volver al catálogo"')
  })

  it('el destino es exactamente `/` — nada de rutas inventadas', () => {
    expect(/<a class="brand"[^>]*href="([^"]*)"/.exec(html)?.[1]).toBe('/')
  })

  it('la marca vive DENTRO del header y no anida otro enlace', () => {
    const header = /<div class="app-header"|<header class="app-header"/.exec(html)
    expect(header).not.toBeNull()
    const a = brandAnchor(html)
    const inner = html.slice(html.indexOf(a) + a.length, html.indexOf('</a>', html.indexOf(a)))
    expect(inner).not.toContain('<a ')
  })
})

it('arbol: el que envuelve al logo es el enlace (el `<img>` queda adentro)', () => {
  const html = arbolTheme.wrap({ title: 'PI', body: '<div></div>' })
  expect(html).toMatch(/<a class="brand"[^>]*aria-label="Volver al catálogo"><img class="logo"/)
})

// ─── Entrada «← Catálogo» en la bandeja (T2) ────────────────────────────────────────────────────

const piece: ResolvedNode = {
  type: 'table',
  title: 'Detalle',
  columnsSpec: [{ field: 'id', label: 'ID' }],
  rows: [{ id: 1 }],
}

async function render(params: Record<string, unknown>): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ theme: 'arbol', title: 'X', piece, ...params }, { agent: 'test' })) as { html: string }
  return html
}

describe('entrada «← Catálogo» en la bandeja (T2)', () => {
  it('la bandeja abre con un enlace `.tray-catalog` a `/`', async () => {
    const html = await render({})
    expect(html).toMatch(/<a class="tray-catalog" href="\/"[^>]*>← Catálogo<\/a>/)
  })

  it('va ANTES del primer tab de la bandeja (posicionalmente en el HTML)', async () => {
    const html = await render({})
    expect(html.indexOf('class="tray-catalog"')).toBeLessThan(html.indexOf('class="tray-tabs"'))
    expect(html.indexOf('class="tray-catalog"')).toBeLessThan(html.indexOf('class="tray-tablabel'))
  })

  it('en print NO viaja: sin bandeja no hay entrada (D4)', async () => {
    const html = await render({ print: true })
    expect(html).not.toContain('tray-catalog')
    expect(html).not.toContain('← Catálogo')
    expect(html).not.toContain('class="tray"')
  })

  it('en print el logo-link sí sigue ahí — un `<a>` inerte es aceptable en papel (D4)', async () => {
    const html = await render({ print: true })
    expect(brandAnchor(html)).toContain('href="/"')
  })
})
