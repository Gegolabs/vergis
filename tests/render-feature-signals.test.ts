// Gating de CSS/runtime por SEÑALES, no por sniff del HTML (NEXT · Ola 3·E, ref 03·13). El render
// solía re-inspeccionar su propia salida (`body.includes('class="table vtable"')`) para decidir si
// inyectar el runtime de tabla / el CSS de drill — frágil ante un rename de clase. Ahora quien emite la
// feature marca la señal. Este test fija el contrato: la señal correcta prende (y solo entonces) el
// runtime y el CSS.
import { describe, it, expect } from 'vitest'
import { renderHtmlPiece } from '@vergis/capabilities'

async function render(piece: unknown): Promise<string> {
  const out = (await renderHtmlPiece.execute({ piece }, { agent: 'test' })) as { html: string }
  return out.html
}

const cols = [{ field: 'a', label: 'A' }]
// ≥2 filas: una tabla que rinde 1 fila es display puro (TX-11 WP4·1); aquí probamos el gating por
// señales de una tabla interactiva, así que necesita al menos 2 filas.
const rows = [{ a: '1' }, { a: '2' }]

describe('render · gating por señales', () => {
  it('tabla interactiva (default) → incluye el runtime de tabla y el shell de gaveta', async () => {
    const html = await render({ type: 'table', columnsSpec: cols, rows })
    expect(html).toContain('class="table vtable"')
    expect(html).toContain('vtBootstrap') // marcador del runtime embebido (autoarranque por .vtable)
  })

  it('tabla estática (interactive:false) sin drills → NO inyecta el runtime', async () => {
    const html = await render({ type: 'table', columnsSpec: cols, rows, interactive: false })
    expect(html).toContain('class="table"')
    expect(html).not.toContain('vtable')
    expect(html).not.toContain('vtBootstrap')
  })

  it('tabla con drills → emite celdas de acción y su CSS de drill', async () => {
    const html = await render({
      type: 'table',
      columnsSpec: cols,
      rows,
      interactive: false,
      drills: [{ to: 'detalle', by: ['a'], label: 'Ver' }],
    })
    expect(html).toContain('vt-actions')
    expect(html).toContain('td.vt-actions') // regla de DRILL_ACTIONS_CSS, inyectada solo si hay drills
  })

  it('pieza sin tablas (solo markdown) → ni runtime ni CSS de drill', async () => {
    const html = await render({ type: 'markdown_block', content: 'hola' })
    expect(html).not.toContain('vtable')
    expect(html).not.toContain('vt-actions')
  })
})
