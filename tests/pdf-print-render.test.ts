// Modo PRINT del pipeline de render (issue #65 · D4/D5/D6) — el HTML que viaja al sidecar HTML→PDF.
// Mismo render, misma identidad, mismo árbol: lo que cambia es que en papel NO hay maquinaria (ni
// bandeja, ni scripts, ni scroll-wrappers) y las tablas salen estáticas y COMPLETAS. La cara —banda de
// contexto, chips de filtros, nav de la vista activa— sí viaja: el lector del PDF debe poder saber
// bajo qué alcance se generó.
import { describe, expect, it } from 'vitest'
import {
  renderHtmlPiece,
  TABLE_SSR_MAX_ROWS,
  TABLE_PRINT_MAX_ROWS,
  type ResolvedNode,
  type FilterResolved,
} from '@vergis/capabilities'

function makeRows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, nombre: `Fila ${i + 1}` }))
}

function tablePiece(rows: Record<string, unknown>[]): ResolvedNode {
  return {
    type: 'table',
    title: 'Detalle',
    columnsSpec: [
      { field: 'id', label: 'ID' },
      { field: 'nombre', label: 'Nombre' },
    ],
    rows,
  }
}

async function render(params: Record<string, unknown>): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ theme: 'arbol', title: 'X', ...params }, { agent: 'test' })) as { html: string }
  return html
}

/** Filas del primer tbody del documento (el que se sirve, no el payload del runtime). */
function tbodyRowCount(html: string): number {
  const m = html.match(/<tbody>([\s\S]*?)<\/tbody>/)
  return (m?.[1].match(/<tr/g) ?? []).length
}

describe('print · tablas estáticas y completas (D5)', () => {
  it('600 filas en print → las 600 en el tbody, sin runtime ni payload ni script', async () => {
    const html = await render({ piece: tablePiece(makeRows(600)), print: true })
    expect(tbodyRowCount(html)).toBe(600)
    expect(html).toContain('Fila 600')
    expect(html).not.toContain('vtable-data')
    expect(html).not.toContain('vt-scroll')
    expect(html).not.toContain('<script')
  })

  it('la MISMA spec sin print corta en el tope SSR y sí trae runtime', async () => {
    const html = await render({ piece: tablePiece(makeRows(600)) })
    expect(tbodyRowCount(html)).toBe(TABLE_SSR_MAX_ROWS)
    expect(html).toContain('vtable-data')
    expect(html).toContain('<script')
  })

  it('sobre el techo de print → TABLE_PRINT_MAX_ROWS filas + la fila de truncamiento visible', async () => {
    const n = TABLE_PRINT_MAX_ROWS + 1
    const html = await render({ piece: tablePiece(makeRows(n)), print: true })
    // Las filas de datos + la fila `vt-trunc` que declara el corte.
    expect(tbodyRowCount(html)).toBe(TABLE_PRINT_MAX_ROWS + 1)
    expect(html).toContain('vt-trunc')
    expect(html).toContain(`mostrando ${TABLE_PRINT_MAX_ROWS} de ${n} filas`)
    expect(html).not.toContain(`Fila ${n}<`)
  })

  it('print sin drills: una columna de acciones no clickeable es ruido en papel', async () => {
    const piece = { ...tablePiece(makeRows(3)), drills: [{ to: 'detalle', by: ['id'], label: 'Ver' }] }
    const html = await render({ piece, print: true })
    expect(html).not.toContain('vt-actions')
    expect(html).not.toContain('vt-drill-link')
  })
})

describe('print · sin maquinaria, con la cara (D4)', () => {
  it('sin bandeja, sin toggle, sin ningún script', async () => {
    const html = await render({ piece: tablePiece(makeRows(5)), print: true })
    expect(html).not.toContain('id="vergis-tray-toggle"')
    expect(html).not.toContain('class="tray"')
    expect(html).not.toContain('<script')
  })

  it('conserva la banda de contexto y los chips de filtros en su variante de print', async () => {
    const filters: FilterResolved[] = [{ id: 'tipo', label: 'Tipo', multi: true, options: ['a', 'b'], selected: ['a'] }]
    const html = await render({
      piece: tablePiece(makeRows(2)),
      print: true,
      controls: [{ id: 'oc', label: 'OC', options: ['123', '456'], value: '123' }],
      carryCtx: { oc: '123' },
      filters,
      fltCarry: { tipo: ['a'] },
    })
    expect(html).toContain('vctx-print')
    expect(html).toContain('vflt-print')
    expect(html).toContain('Filtros — Tipo: a')
    // Los widgets de pantalla (select, chips removibles) siguen emitidos pero los oculta el @media
    // print del theme; lo que NO puede viajar es el script.
    expect(html).not.toContain('<script')
  })

  it('multi-vista en print → la nav existe (el CSS deja solo la vista activa en papel)', async () => {
    const html = await render({
      piece: tablePiece(makeRows(2)),
      print: true,
      pages: { items: [{ id: 'resumen', title: 'Resumen' }, { id: 'detalle', title: 'Detalle' }], active: 'resumen' },
    })
    expect(html).toContain('class="vpages"')
    expect(html).toContain('@media print{.vpages{border-bottom:none}')
  })
})

describe('print · paleta de papel (D6)', () => {
  const chartPiece: ResolvedNode = {
    type: 'distribution',
    title: 'Por especie',
    dimensionField: 'k',
    metricField: 'v',
    rows: [
      { k: 'Cerezo', v: 10 },
      { k: 'Nogal', v: 6 },
    ],
  }

  /** El SVG del chart — es ahí donde los colores están HORNEADOS (el `@media print` no los alcanza).
   *  El `<style>` del theme declara los hex de TODAS sus paletas: mirarlo no probaría nada. */
  //  El documento trae otros SVG chicos (iconos de la bandeja): el del chart es el más grande.
  const chartSvg = (html: string): string =>
    (html.match(/<svg[\s\S]*?<\/svg>/g) ?? []).reduce((a, b) => (b.length > a.length ? b : a), '')

  it('theme arbol + paleta gruvbox en print → los hex del juego «blanco», no los de gruvbox', async () => {
    const html = await render({ piece: chartPiece, palette: 'gruvbox', print: true })
    expect(html).toContain('data-palette="blanco"')
    const svg = chartSvg(html)
    expect(svg).toContain('#2563eb') // chartBar del juego blanco
    expect(svg).not.toContain('#b8bb26') // chartBar de gruvbox
  })

  it('la MISMA spec sin print respeta la paleta activa', async () => {
    const html = await render({ piece: chartPiece, palette: 'gruvbox' })
    expect(html).toContain('data-palette="gruvbox"')
    const svg = chartSvg(html)
    expect(svg).toContain('#b8bb26')
    expect(svg).not.toContain('#2563eb')
  })
})
