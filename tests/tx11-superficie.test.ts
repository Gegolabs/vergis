// TX-11 · Superficie de estado («cara = estado · gaveta = maquinaria · print = estado como texto»).
// Cobertura de la convención: el sello de alcance en la banda (single/multi), el par screen/print, la
// salida de los controles de la gaveta, la heurística de tabla display, el kit único, el contador al
// pie y los chips imprimibles. Ver work/078-plan-tx11-superficie-estado.
import { describe, it, expect } from 'vitest'
import { renderHtmlPiece, TABLE_RUNTIME_SOURCE, type ResolvedNode } from '@vergis/capabilities'
import { TABLE_INTERACTIVE_CSS } from '../packages/capabilities/src/piece-css'

const render = async (params: Record<string, unknown>): Promise<string> =>
  ((await renderHtmlPiece.execute(params, {} as never)) as { html: string }).html

const banner: ResolvedNode = { type: 'banner', content: 'demo' }
const table2 = (extra: Partial<ResolvedNode> = {}): ResolvedNode => ({
  type: 'table',
  columnsSpec: [{ field: 'a', label: 'A' }, { field: 'b', label: 'B' }],
  rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }],
  ...extra,
})

describe('TX-11 WP1 · sello de alcance en la banda', () => {
  it('single → <select> estilizado como sello, opción vigente marcada, misma navegación por URL', async () => {
    const html = await render({
      piece: banner,
      controls: [{ id: 'oc', label: 'OC', options: ['17400358', '17400359'], value: '17400358' }],
    })
    expect(html).toContain('class="vctxbar"')
    expect(html).toMatch(/<select class="[^"]*vctx-sel[^"]*"/) // sello = <select> nativo estilizado
    expect(html).toContain('<option value="17400358" selected>17400358</option>')
    expect(html).toContain('onchange=') // clickeable: navega
    expect(html).toContain('ctx.oc') // fija ctx.<id> en la URL (misma semántica que el control viejo)
    expect(html).toContain('window.URL') // robusto ante el scoping inline (document.URL sombrea a URL)
  })

  it('multi → sello <details> con summary del valor unido + checkboxes en popover', async () => {
    const html = await render({
      piece: banner,
      controls: [{ id: 'semana', label: 'Semana', options: ['W20', 'W21', 'W22'], value: 'W20, W21', values: ['W20', 'W21'], multi: true }],
    })
    expect(html).toContain('class="vctxbar"')
    expect(html).toContain('vctx-multi') // sello multi = <details>
    expect(html).toContain('data-ctl="semana"')
    expect(html).toContain('W20, W21') // summary con el valor unido
    expect(html).toMatch(/value="W20" checked/)
    expect(html).toContain('searchParams.append') // repite ctx.<id> por valor
  })

  it('sin controles → no hay banda', async () => {
    const html = await render({ piece: banner })
    expect(html).not.toContain('vctxbar')
  })
})

describe('TX-11 WP1 · par screen/print (el sello impreso es texto plano)', () => {
  it('cada ítem emite .vctx-screen (widget) y .vctx-print (texto), con CSS que los alterna', async () => {
    const html = await render({
      piece: banner,
      controls: [{ id: 'oc', label: 'OC', options: ['17400358'], value: '17400358' }],
    })
    expect(html).toContain('vctx-screen') // el widget
    expect(html).toContain('vctx-print') // el texto plano para print
    // CSS: en pantalla el texto se oculta; en print el widget se oculta y queda el texto.
    expect(html).toContain('.vctx-print{display:none}')
    expect(html).toContain('@media print{')
    expect(html).toContain('.vctxbar .vctx-screen{display:none!important}')
    expect(html).toContain('.vctxbar .vctx-print{display:inline!important')
  })
})

describe('TX-11 WP2 · los controles salen de la gaveta', () => {
  it('PI con control + tabla: el sello está en la banda; la gaveta NO trae el control', async () => {
    const html = await render({
      piece: table2(),
      controls: [{ id: 'oc', label: 'OC', options: ['A', 'B'], value: 'A' }],
    })
    expect(html).toContain('class="vctxbar"')
    expect(html).toContain('vctx-sel')
    expect(html).toContain('tray-sections') // la gaveta existe (por la tabla interactiva)
    expect(html).not.toContain('vt-ctl-select') // pero el control YA NO vive en ella
    expect(html).not.toContain('vt-ctl-multi')
  })

  it('PI con controles + sin tabla → el sello está en la banda; la gaveta universal existe pero NO aloja el control', async () => {
    const html = await render({
      piece: banner, // sin tabla ni interactividad
      controls: [{ id: 'oc', label: 'OC', options: ['A', 'B'], value: 'A' }],
    })
    expect(html).toContain('class="vctxbar"') // el sello sí está (en la banda)
    // La gaveta/Inspector es UNIVERSAL (Apariencia + Config): existe aunque no haya maquinaria.
    expect(html).toContain('id="vergis-tray-toggle"')
    expect(html).toContain('<aside class="tray"')
    // pero el control NO se cuela a la gaveta (vive en la banda) → Controles muestra su empty-state.
    expect(html).not.toContain('vt-ctl-select')
    expect(html).not.toContain('vt-ctl-multi')
    expect(html).toContain('Esta vista no tiene filtros disponibles.')
  })
})

describe('TX-11 WP4·1 · heurística de tabla display', () => {
  it('tabla que rinde 1 fila → display pura (sin runtime de tabla ni iconos de filtro)', async () => {
    const html = await render({ piece: { type: 'table', columnsSpec: [{ field: 'a', label: 'A' }], rows: [{ a: 1 }] } })
    expect(html).toContain('class="table"')
    expect(html).not.toContain('vtable')
    expect(html).not.toContain('vt-filter-btn')
    // NO hay maquinaria de tabla, pero la gaveta universal (Apariencia+Config) igual existe;
    // el tab Controles queda con su empty-state (no un panel en blanco).
    expect(html).toContain('<aside class="tray"')
    expect(html).toContain('Esta vista no tiene filtros disponibles.')
  })

  it('tabla de 2 filas → interactiva', async () => {
    const html = await render({ piece: table2() })
    expect(html).toContain('class="table vtable"')
  })

  it('1 fila con interactive:true explícito → conserva runtime', async () => {
    const html = await render({ piece: { type: 'table', columnsSpec: [{ field: 'a', label: 'A' }], rows: [{ a: 1 }], interactive: true } })
    expect(html).toContain('class="table vtable"')
  })

  it('el payload de la tabla no lleva rastro del esquema viejo de anotaciones', async () => {
    const html = await render({ piece: table2(), theme: 'arbol' })
    expect(html).not.toContain('"annotation"')
    expect(html).not.toContain('__anntok')
    expect(html).not.toContain('vt-ann-cell')
  })
})

describe('TX-11 WP4·2/3 · kit único + contador al pie', () => {
  it('la tabla interactiva emite el pie de contador de filas (visible también en print)', async () => {
    const html = await render({ piece: table2() })
    expect(html).toContain('class="vt-count-foot"')
    // El pie NO se oculta en print (estado honesto) — no aparece en la lista de display:none de print.
    expect(html).not.toMatch(/@media print\{[^}]*vt-count-foot[^}]*display:none/)
  })

  it('el runtime marca cada kit y trae el coordinador de kit único con selector de objetivo', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain("'faceta vt-tray-section vt-kit'") // cada tabla marca su kit
    expect(TABLE_RUNTIME_SOURCE).toContain('data-kit-rows') // metadato para elegir el default (más filas)
    expect(TABLE_RUNTIME_SOURCE).toContain('vt-kit-target-sel') // selector de objetivo cuando hay ≥2
    expect(TABLE_RUNTIME_SOURCE).toContain('.vt-count-foot') // el runtime puebla el pie, no el kit
    expect(TABLE_RUNTIME_SOURCE).not.toContain("querySelector('.vt-count')") // el contador salió del kit
  })

  it('el runtime serializado sigue siendo JS válido', () => {
    expect(() => new Function(TABLE_RUNTIME_SOURCE)).not.toThrow()
  })
})

describe('TX-11 WP3 · chips de filtro imprimibles como letra chica', () => {
  it('print imprime los chips (letra chica) y oculta solo la acción (.vt-chip-x)', () => {
    const printBlock = TABLE_INTERACTIVE_CSS.slice(TABLE_INTERACTIVE_CSS.indexOf('@media print'))
    // Los chips YA NO se ocultan en print (dejaron la lista de display:none)…
    expect(printBlock).not.toContain('.vtable .vt-chips,')
    // …se imprimen como texto discreto con prefijo, y solo la ✕ se oculta.
    expect(printBlock).toContain('.vtable .vt-chips{display:block')
    expect(printBlock).toContain('.vtable .vt-chips::before{content:"Filtros: "')
    expect(printBlock).toContain('.vt-chip-x{display:none')
  })

  it('el runtime envuelve la ✕ del chip en .vt-chip-x (para ocultarla solo en print)', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('<span class="vt-chip-x">×</span>')
  })
})
