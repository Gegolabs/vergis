// #461 · El panel lateral se llama «Bandeja» en toda la plataforma: el rótulo, el botón que lo abre y
// lo que lee un lector de pantalla. «Inspector» se leía como inspección, y lo que contiene son los
// filtros, la agrupación y las vistas guardadas (decidido por el operador de la instalación, 10-11-2026).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

const piece: ResolvedNode = { type: 'table', title: 'T', columnsSpec: [{ field: 'id', label: 'ID' }], rows: [{ id: 1 }] }
async function render(theme: string): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ theme, title: 'X', piece }, { agent: 'test' })) as { html: string }
  return html
}

describe.each(['roble', 'default'])('#461 · la bandeja se llama «Bandeja» · theme %s', (theme) => {
  it('el rótulo del panel, el botón que lo abre y el aria del panel dicen «Bandeja»', async () => {
    const html = await render(theme)
    expect(html).toContain('<strong>Bandeja</strong>')
    expect(html).toMatch(/class="tray-tab" title="Bandeja" aria-label="Abrir la bandeja"/)
    expect(html).toMatch(/<aside class="tray"[^>]*aria-label="Bandeja"/)
  })
  it('ningún texto del documento servido dice «Inspector»', async () => {
    expect(await render(theme)).not.toMatch(/inspector/i)
  })
})

it('#461 · la documentación de la plataforma tampoco lo llama «Inspector»', () => {
  for (const f of ['docs/capacidades.md', 'docs/superficie-de-estado.md', 'rubric/convenciones.md']) {
    expect(readFileSync(f, 'utf8'), f).not.toMatch(/inspector/i)
  }
})
