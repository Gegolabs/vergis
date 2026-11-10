// «Volver al catálogo» a la mano (issue #136) — convención de PLATAFORMA, no config per-spec:
// (1) la marca/logo del header enlaza al índice (`/`) en TODO theme; (2) la bandeja abre con una
// entrada «← Catálogo» antes de sus tabs. En papel (`print: true`) no hay bandeja → no hay entrada.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'
import { robleTheme, defaultTheme, type Theme } from '../packages/capabilities/src/themes/index'

const THEMES: [string, Theme][] = [
  ['roble', robleTheme],
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

it('roble: el que envuelve al logo es el enlace (el `<img>` queda adentro)', () => {
  const html = robleTheme.wrap({ title: 'PI', body: '<div></div>' })
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
  const { html } = (await renderHtmlPiece.execute({ theme: 'roble', title: 'X', piece, ...params }, { agent: 'test' })) as { html: string }
  return html
}

// #460 · El acceso al catálogo se mudó de la bandeja a la cabecera de navegación de la vista.
describe('acceso al catálogo en la cabecera, fuera de la bandeja (#460)', () => {
  const bandeja = (html: string) => /<aside class="tray"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? ''
  const cabecera = (html: string) => /<nav class="vnav"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? ''

  it('la cabecera de la vista trae un botón «Catálogo» a `/`', async () => {
    const html = await render({})
    expect(cabecera(html)).toMatch(/<a class="vnav-btn vnav-catalogo" href="\/"[^>]*>Catálogo<\/a>/)
  })

  it('la bandeja ya no trae el acceso al catálogo', async () => {
    const html = await render({})
    expect(bandeja(html)).not.toBe('')
    expect(bandeja(html)).not.toContain('Catálogo')
    expect(html).not.toContain('tray-catalog')
  })

  it('la cabecera va antes del contenido de la vista', async () => {
    const html = await render({})
    expect(html.indexOf('class="vnav"')).toBeGreaterThan(-1)
    expect(html.indexOf('class="vnav"')).toBeLessThan(html.indexOf('<table'))
  })

  it('en print NO viaja: en papel no hay a dónde ir (D4)', async () => {
    const html = await render({ print: true })
    expect(html).not.toContain('class="vnav"')
    expect(html).not.toContain('class="tray"')
  })

  it('en print el logo-link sí sigue ahí — un `<a>` inerte es aceptable en papel (D4)', async () => {
    const html = await render({ print: true })
    expect(brandAnchor(html)).toContain('href="/"')
  })
})
