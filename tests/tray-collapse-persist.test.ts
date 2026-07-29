// El colapso del Inspector es CSS-only (un checkbox). Un POST→redirect→GET —aplicar un filtro
// server-side, enviar cualquier form— re-renderiza la página y devolvía el panel a su default
// (cerrado) en cada turno, mientras paleta y anotaciones sí sobrevivían vía localStorage. Se iguala
// el patrón: se persiste al cambiar y se re-aplica al cargar, con la MISMA clave por-reporte
// (`…:'+location.pathname`) que usa la paleta.
import { describe, it, expect } from 'vitest'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

const render = async (params: Record<string, unknown>): Promise<string> =>
  ((await renderHtmlPiece.execute(params, { agent: 'test' } as never)) as { html: string }).html

const piece = (): ResolvedNode =>
  ({
    layout: 'grid',
    columns: 1,
    elements: [{ type: 'kpi', label: 'Total', value: 42, format: 'int' }],
  }) as ResolvedNode

describe('render · el colapso del Inspector sobrevive el turno (localStorage)', () => {
  it('el checkbox del colapso escribe su estado en localStorage al cambiar', async () => {
    const html = await render({ piece: piece(), title: 'PI test', theme: 'arbol' })
    expect(html).toContain('id="vergis-tray-toggle"')
    expect(html).toContain(
      `onchange="try{localStorage.setItem('vergis:tray:'+location.pathname,this.checked?'1':'0')}catch(e){}"`,
    )
  })

  it('el script de restauración re-aplica el estado guardado al cargar', async () => {
    const html = await render({ piece: piece(), title: 'PI test', theme: 'arbol' })
    expect(html).toContain(`localStorage.getItem('vergis:tray:'+location.pathname)`)
    expect(html).toContain(`c.checked=(t==='1')`)
    // sin nada guardado (`null`), manda el default de plataforma: no se toca el checkbox
    expect(html).toContain(`if(t!==null)`)
  })

  it('la clave es POR REPORTE, igual que la de la paleta (no una global compartida)', async () => {
    const html = await render({ piece: piece(), title: 'PI test', theme: 'arbol' })
    for (const k of ["'vergis:palette:'+location.pathname", "'vergis:tray:'+location.pathname"]) {
      expect(html).toContain(k)
    }
  })

  it('el default no cambia: el Inspector se renderiza cerrado (checkbox sin `checked`)', async () => {
    const html = await render({ piece: piece(), title: 'PI test', theme: 'arbol' })
    const tag = html.slice(html.indexOf('<input type="checkbox" id="vergis-tray-toggle"'))
    expect(tag.slice(0, tag.indexOf('>'))).not.toContain(' checked')
  })
})
