// Botón «Descargar PDF» (issue #65 · D9) — grupo «Descargar» a nivel de DOCUMENTO, server-rendered en
// el tab Controles de la bandeja. Su href preserva la navegación SERVER-SIDE (página activa + `ctx.*`
// + `flt.*`): el PDF congela exactamente lo que el consumidor está mirando del lado del servidor.
//
// El binario es UNO solo: sin `pdfUrl` no hay botón (y sin la env no hay endpoint). Un botón muerto es
// estructuralmente imposible.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, type ResolvedNode, type FilterResolved } from '@vergis/capabilities'

const PIECE: ResolvedNode = {
  type: 'table',
  title: 'Detalle',
  columnsSpec: [{ field: 'id', label: 'ID' }],
  rows: [{ id: 1 }, { id: 2 }],
}

const DASHBOARD: ResolvedNode = {
  layout: 'grid',
  columns: 2,
  elements: [
    { type: 'kpi', label: 'Total', value: 42 },
    { type: 'kpi', label: 'Abiertos', value: 7 },
  ],
}

async function render(params: Record<string, unknown>): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ theme: 'arbol', title: 'X', ...params }, { agent: 'test' })) as { html: string }
  return html
}

describe('bandeja · grupo «Descargar» (D9)', () => {
  it('el href preserva página activa, ctx y flt del servidor', async () => {
    const filters: FilterResolved[] = [{ id: 'tipo', label: 'Tipo', multi: true, options: ['a', 'b'], selected: ['a'] }]
    const html = await render({
      piece: PIECE,
      pdfUrl: '/pi-01/pdf',
      pages: { items: [{ id: 'resumen', title: 'Resumen' }, { id: 'detalle', title: 'Detalle' }], active: 'resumen' },
      carryCtx: { oc: '123' },
      filters,
      fltCarry: { tipo: ['a'] },
    })
    expect(html).toContain('href="/pi-01/pdf?page=resumen&amp;ctx.oc=123&amp;flt.tipo=a"')
    expect(html).toContain('class="faceta tray-descargar"')
    expect(html).toContain('<div class="faceta-title">Descargar</div>')
    expect(html).toContain('Descargar PDF')
  })

  it('sin página ni contexto → el href es la URL pelada', async () => {
    const html = await render({ piece: PIECE, pdfUrl: '/pi-01/pdf' })
    expect(html).toContain('href="/pi-01/pdf"')
  })

  it('sin pdfUrl → superficie idéntica a hoy: ni botón ni sección', async () => {
    const html = await render({ piece: PIECE })
    expect(html).not.toContain('tray-pdfbtn')
    expect(html).not.toContain('tray-descargar')
  })

  it('en print el botón no existe (el shell de la bandeja no se compone)', async () => {
    const html = await render({ piece: PIECE, pdfUrl: '/pi-01/pdf', print: true })
    expect(html).not.toContain('tray-pdfbtn')
    expect(html).not.toContain('tray-descargar')
  })

  it('dashboard SIN tabla ni filtros pero con pdfUrl → la sección existe y Controles es el tab por defecto', async () => {
    const html = await render({ piece: DASHBOARD, pdfUrl: '/pi-02/pdf' })
    expect(html).toContain('tray-descargar')
    expect(html).toContain('id="vergis-tt-controles" class="tray-tabin" checked')
    expect(html).not.toContain('Esta vista no tiene filtros disponibles.')
    // El CSS del botón viaja solo cuando hay sección que estilar.
    expect(html).toContain('.tray .tray-pdfbtn')
  })

  it('el mismo dashboard sin pdfUrl aterriza en Config con su empty-state', async () => {
    const html = await render({ piece: DASHBOARD })
    expect(html).toContain('id="vergis-tt-config" class="tray-tabin" checked')
    expect(html).toContain('Esta vista no tiene filtros disponibles.')
  })
})
