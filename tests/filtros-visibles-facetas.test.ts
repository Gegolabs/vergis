// #114 · El estado de los filtros activos es VISIBLE en el cuerpo del PI.
//
// La convención que se prueba: una sola franja `.vfltbar` por documento hospeda el estado de TODOS
// los filtros que sustraen filas — los server-side de #82 (chips horneados) y las facetas
// client-side de `interactions.filters` (chips vivos que pinta `update()`). Sin filtros activos,
// cero cromo: la ausencia de franja significa «documento completo».
import { describe, it, expect } from 'vitest'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'
import { renderInteractiveScript } from '../packages/capabilities/src/interactive-script'
import type { Interactive } from '../packages/capabilities/src/piece-types'

const render = async (params: Record<string, unknown>): Promise<string> =>
  ((await renderHtmlPiece.execute(params, {} as never)) as { html: string }).html

const banner: ResolvedNode = { type: 'banner', content: 'demo' }

const ROWS = [
  { area: 'Norte', monto: 10 },
  { area: 'Sur', monto: 20 },
]
const IT: Interactive = {
  datasets: { d: ROWS },
  filters: [{ dataset: 'd', field: 'area', label: 'Área' }],
}

describe('#114 · la franja de estado de filtros en el cuerpo', () => {
  it('dashboard con facetas y sin filtros server → franja oculta, lista para vivir', async () => {
    const html = await render({ piece: banner, interactive: IT })
    expect(html).toContain('id="vergis-fltbar"')
    expect(html).toMatch(/<div class="vfltbar" id="vergis-fltbar" hidden>/)
    expect(html).toContain('id="vergis-flt-live"')
    expect(html).toContain('id="vergis-flt-live-print"')
    expect(html).toContain('.vfltbar{') // FILTER_CHIPS_CSS inyectado aunque no haya chips server
  })

  it('sin facetas ni filtros activos → cero cromo (regresión de #82)', async () => {
    const html = await render({ piece: banner })
    expect(html).not.toContain('vfltbar')
  })

  it('server + facetas → UNA sola franja, visible desde el render', async () => {
    const html = await render({
      piece: banner,
      interactive: IT,
      filters: [{ id: 'zona', label: 'Zona', multi: false, options: ['Norte', 'Sur'], selected: ['Norte'] }],
      fltCarry: { zona: ['Norte'] },
    })
    expect((html.match(/class="vfltbar"/g) ?? []).length).toBe(1)
    expect(html).toContain('<div class="vfltbar" id="vergis-fltbar">') // sin `hidden`: ya hay chip server
    expect(html).toContain('<b>Zona:</b> Norte')
    // Los slots vivos conviven con los chips horneados, dentro de la MISMA franja.
    const bar = html.slice(html.indexOf('<div class="vfltbar"'))
    const barEnd = bar.indexOf('</div>')
    expect(bar.slice(0, barEnd)).toContain('id="vergis-flt-live"')
    expect(bar.slice(0, barEnd)).toContain('id="vergis-flt-live-print"')
  })
})

describe('#114 · el script pinta y despinta los chips vivos', () => {
  const src = renderInteractiveScript(IT)

  it('pinta chips en el slot vivo y mantiene el resumen de print', () => {
    expect(src).toContain("getElementById('vergis-flt-live')")
    expect(src).toContain("getElementById('vergis-flt-live-print')")
    expect(src).toContain('vflt-chip vflt-screen vflt-live')
    expect(src).toContain('vflt-x')
    expect(src).toContain("'Filtros — '")
    // La franja aparece con el primer chip y desaparece con el último.
    expect(src).toContain("fltbar.hidden = !fltbar.querySelector('.vflt-chip')")
  })

  it('el ✕ del chip desmarca SU checkbox de la bandeja y recomputa', () => {
    expect(src).toContain("data-field")
    expect(src).toContain("data-val")
    expect(src).toMatch(/getAttribute\('data-field'\)===field && b\.value===val/)
    expect(src).toMatch(/b\.checked = false;[\s\S]{0,40}update\(\);/)
  })

  it('el script sigue siendo sintácticamente válido (browser-only, sin jsdom)', () => {
    const code = src.replace(/^<script>/, '').replace(/<\/script>$/, '')
    expect(() => new Function(code)).not.toThrow()
  })
})
