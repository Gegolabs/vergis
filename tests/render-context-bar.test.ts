import { describe, it, expect } from 'vitest'
import { renderHtmlPiece } from '../packages/capabilities/src/render-html-piece'

// render-html-piece no usa la identidad; se pasa vacía para satisfacer la firma Capability.execute.
const render = async (params: Record<string, unknown>): Promise<string> =>
  ((await renderHtmlPiece.execute(params, {} as never)) as { html: string }).html

describe('render · barra de contexto activo (#1 — semana siempre visible)', () => {
  it('muestra el valor vigente de cada control (Semana · W24) en una barra sticky', async () => {
    const html = await render({
      piece: { type: 'banner', content: 'demo' },
      title: 'PI-01',
      controls: [{ id: 'semana', label: 'Semana', options: ['W24', 'W21'], value: 'W24' }],
    })
    expect(html).toContain('class="vctxbar"')
    expect(html).toContain('Semana')
    expect(html).toContain('W24')
    expect(html).toContain('.vctxbar{position:sticky') // sticky CSS inyectado
  })

  it('sin controles → no hay barra de contexto', async () => {
    const html = await render({ piece: { type: 'banner', content: 'demo' }, title: 'X' })
    expect(html).not.toContain('vctxbar')
  })
})

describe('render · headers de tabla congelados (#2 — inmovilizar panel)', () => {
  it('la tabla queda en un scroll-box con max-height y thead sticky', async () => {
    const html = await render({
      // ≥2 filas: una tabla que rinde 1 fila es display puro (TX-11 WP4·1) → sin runtime ni scroll-box.
      piece: { type: 'table', columnsSpec: [{ field: 'a', label: 'A' }, { field: 'b', label: 'B' }], rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }] },
      title: 'Tabla',
    })
    expect(html).toContain('class="table vtable"')
    expect(html).toContain('.vt-scroll{overflow:auto;max-height:70vh}') // scroll-box (freeze-panes)
    expect(html).toContain('thead th,.vtable th.vt-col{position:sticky;top:0') // headers congelados
  })
})
