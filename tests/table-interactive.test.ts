import { describe, expect, it } from 'vitest'
import {
  renderHtmlPiece,
  TABLE_RUNTIME_SOURCE,
  vtNorm,
  vtIsNumericCol,
  vtDistinct,
  vtIsCategorical,
  vtFormat,
  vtApply,
  vtGroup,
  vtGroupTree,
  type ResolvedNode,
  type VtState,
} from '@vergis/capabilities'
import { classifyPiece, platformThemeDefault, resolveTheme } from '@vergis/mira'

/**
 * Tabla interactiva (orden/filtro/búsqueda/agrupación). La lógica del navegador y la testeada
 * aquí son LA MISMA fuente (table-runtime.ts → embebida vía toString), así que estos tests de
 * funciones puras cubren el comportamiento real del cliente. Más: estructura del HTML emitido,
 * kill-switch estático y validez sintáctica del runtime serializado.
 */

const ROWS: Record<string, unknown>[] = [
  { id: 3, nombre: 'Ana Pérez', area: 'Logística', estado: 'Presente' },
  { id: 1, nombre: 'Beto Soto', area: 'Logística', estado: 'Ausente' },
  { id: 2, nombre: 'Carla Díaz', area: 'Finanzas', estado: 'Presente' },
  { id: 10, nombre: 'Édgar Ñúñez', area: 'Finanzas', estado: 'Licencia' },
]

const baseState = (over: Partial<VtState> = {}): VtState => ({
  sort: { field: '', dir: 'asc' },
  globalSearch: '',
  colSearch: {},
  facets: {},
  groupBy: '',
  ...over,
})

describe('table-runtime · helpers puros', () => {
  it('vtNorm normaliza minúsculas y acentos', () => {
    expect(vtNorm('Édgar Ñúñez')).toBe('edgar nunez')
    expect(vtNorm(null)).toBe('')
    expect(vtNorm(42)).toBe('42')
  })

  it('vtIsNumericCol distingue numéricas de texto', () => {
    expect(vtIsNumericCol(ROWS, 'id')).toBe(true)
    expect(vtIsNumericCol(ROWS, 'nombre')).toBe(false)
    expect(vtIsNumericCol(ROWS, 'area')).toBe(false)
  })

  it('vtDistinct preserva orden de aparición', () => {
    expect(vtDistinct(ROWS, 'area')).toEqual(['Logística', 'Finanzas'])
  })

  it('vtIsCategorical: baja cardinalidad sí, numérica/alta no; override gana', () => {
    expect(vtIsCategorical(ROWS, 'area')).toBe(true)
    expect(vtIsCategorical(ROWS, 'estado')).toBe(true)
    expect(vtIsCategorical(ROWS, 'id')).toBe(false) // numérica
    expect(vtIsCategorical(ROWS, 'nombre')).toBe(false) // cardinalidad = nº filas
    expect(vtIsCategorical(ROWS, 'nombre', true)).toBe(true) // override fuerza
    expect(vtIsCategorical(ROWS, 'area', false)).toBe(false) // override desactiva
  })

  it('vtFormat: números, porcentajes y recorte de fecha ISO', () => {
    expect(vtFormat(0.123, 'percent_1')).toBe('12.3%')
    expect(vtFormat('2026-05-25T00:00:00.000Z')).toBe('2026-05-25')
    expect(vtFormat('Presente')).toBe('Presente')
  })
})

describe('table-runtime · vtApply (filtro + búsqueda + orden)', () => {
  it('faceta filtra por valores seleccionados', () => {
    const out = vtApply(ROWS, baseState({ facets: { area: ['Finanzas'] } }))
    expect(out.map((r) => r.nombre)).toEqual(['Carla Díaz', 'Édgar Ñúñez'])
  })

  it('faceta multi-valor une las selecciones', () => {
    const out = vtApply(ROWS, baseState({ facets: { estado: ['Presente', 'Licencia'] } }))
    expect(out).toHaveLength(3)
  })

  it('búsqueda global es insensible a acentos y mayúsculas', () => {
    expect(vtApply(ROWS, baseState({ globalSearch: 'nunez' }))).toHaveLength(1)
    expect(vtApply(ROWS, baseState({ globalSearch: 'PEREZ' })).map((r) => r.id)).toEqual([3])
  })

  it('búsqueda por columna solo mira esa columna', () => {
    const out = vtApply(ROWS, baseState({ colSearch: { estado: 'pres' } }))
    expect(out.map((r) => r.id).sort()).toEqual([2, 3])
  })

  it('orden numérico asc/desc', () => {
    expect(vtApply(ROWS, baseState({ sort: { field: 'id', dir: 'asc' } })).map((r) => r.id)).toEqual([1, 2, 3, 10])
    expect(vtApply(ROWS, baseState({ sort: { field: 'id', dir: 'desc' } })).map((r) => r.id)).toEqual([10, 3, 2, 1])
  })

  it('orden de texto respeta acentos vía normalización', () => {
    const out = vtApply(ROWS, baseState({ sort: { field: 'nombre', dir: 'asc' } }))
    expect(out.map((r) => r.nombre)).toEqual(['Ana Pérez', 'Beto Soto', 'Carla Díaz', 'Édgar Ñúñez'])
  })

  it('no muta el arreglo de entrada', () => {
    const before = ROWS.map((r) => r.id)
    vtApply(ROWS, baseState({ sort: { field: 'id', dir: 'desc' } }))
    expect(ROWS.map((r) => r.id)).toEqual(before)
  })

  it('combina faceta + búsqueda + orden', () => {
    const out = vtApply(
      ROWS,
      baseState({ facets: { area: ['Logística'] }, globalSearch: 'o', sort: { field: 'id', dir: 'asc' } }),
    )
    expect(out.map((r) => r.nombre)).toEqual(['Beto Soto', 'Ana Pérez']) // ambos de Logística contienen 'o' (Soto, Logística)
  })
})

describe('table-runtime · vtGroup (categorización)', () => {
  it('agrupa por columna, grupos en orden alfabético, conteo correcto', () => {
    const sorted = vtApply(ROWS, baseState({ sort: { field: 'nombre', dir: 'asc' } }))
    const groups = vtGroup(sorted, 'area')
    expect(groups.map((g) => g.key)).toEqual(['Finanzas', 'Logística'])
    expect(groups.map((g) => g.rows.length)).toEqual([2, 2])
  })

  it('preserva el orden de filas (hereda el sort) dentro del grupo', () => {
    const sorted = vtApply(ROWS, baseState({ sort: { field: 'id', dir: 'desc' } }))
    const groups = vtGroup(sorted, 'area')
    const log = groups.find((g) => g.key === 'Logística')!
    expect(log.rows.map((r) => r.id)).toEqual([3, 1]) // desc por id dentro del grupo
  })

  it('vtGroupTree: agrupación jerárquica multinivel (área › estado)', () => {
    const tree = vtGroupTree(ROWS, ['area', 'estado'])
    expect(tree.leaf).toBe(false)
    expect(tree.field).toBe('area')
    expect(tree.groups!.map((g) => g.key)).toEqual(['Finanzas', 'Logística'])
    // nivel 2 dentro de Finanzas: Carla (Presente) + Édgar (Licencia) → 2 subgrupos
    const fin = tree.groups!.find((g) => g.key === 'Finanzas')!
    expect(fin.count).toBe(2)
    expect(fin.child.leaf).toBe(false)
    expect(fin.child.field).toBe('estado')
    expect(fin.child.groups!.map((g) => g.key)).toEqual(['Licencia', 'Presente'])
    // la hoja lleva las filas
    const lic = fin.child.groups!.find((g) => g.key === 'Licencia')!
    expect(lic.child.leaf).toBe(true)
    expect(lic.child.rows!.map((r) => r.nombre)).toEqual(['Édgar Ñúñez'])
  })

  it('vtGroupTree: sin campos → hoja con todas las filas', () => {
    const tree = vtGroupTree(ROWS, [])
    expect(tree.leaf).toBe(true)
    expect(tree.rows).toHaveLength(4)
  })
})

describe('render-html-piece · tabla interactiva', () => {
  const piece: ResolvedNode = {
    type: 'table',
    title: 'Personal',
    columnsSpec: [
      { field: 'id', label: 'ID', align: 'right' },
      { field: 'nombre', label: 'Nombre' },
      { field: 'area', label: 'Área' },
      { field: 'estado', label: 'Estado' },
    ],
    rows: ROWS,
  }

  it('auto-on: gaveta común + ícono/popover por columna + headers ordenables + datos embebidos', async () => {
    const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol' }, { agent: 'test' })) as { html: string }
    expect(html).toContain('class="table vtable"')
    // gaveta común (shell) emitida también para PI tabular
    expect(html).toContain('id="vergis-tray-toggle"')
    expect(html).toContain('class="tray"')
    expect(html).toContain('tray-sections')
    expect(html).toContain('faceta-appearance') // apariencia universal (theme arbol con paletas)
    // ícono + popover por columna (uno por columna)
    expect(html).toContain('vt-filter-btn')
    expect(html).toContain('vt-col-pop')
    expect(html.match(/class="vt-filter-btn"/g)).toHaveLength(4)
    // orden por header
    expect(html).toContain('data-sortable="1"')
    expect(html).toContain('vt-th-label')
    // datos embebidos + meta de columnas
    expect(html).toContain('class="vtable-data"')
    expect(html).toContain('"field":"area"')
    expect(html).toContain('Édgar Ñúñez')
    // runtime + CSS inyectados una sola vez
    expect(html).toContain('function vtBootstrap')
    expect(html).toContain('.vtable .vt-col-pop')
    expect(html.match(/function vtBootstrap/g)).toHaveLength(1)
    // los controles globales NO van inline (los inyecta el runtime en la gaveta)
    expect(html).not.toContain('class="vt-controls"')
    // gaveta de 3 tabs: Controles · Guardados · Config
    expect(html).toContain('id="vergis-tt-controles"')
    expect(html).toContain('id="vergis-tt-guardados"')
    expect(html).toContain('id="vergis-tt-config"')
    expect(html).toContain('tray-panel-guardados')
    expect(html).toContain('class="tray-saved"')
    expect(html).toContain('Apariencia (Theme)')
  })

  it('paleta: se propaga a data-palette del html (theme arbol)', async () => {
    const { html } = (await renderHtmlPiece.execute(
      { piece, title: 'X', theme: 'arbol', palette: 'blanco' },
      { agent: 'test' },
    )) as { html: string }
    expect(html).toContain('data-palette="blanco"')
    // el radio de la paleta activa queda marcado
    expect(html).toMatch(/value="blanco"[^>]*checked|checked[^>]*value="blanco"/)
  })

  it('kill-switch: interactive:false → tabla estática, sin runtime ni gaveta', async () => {
    const { html } = (await renderHtmlPiece.execute({
      piece: { ...piece, interactive: false },
      title: 'X',
      theme: 'arbol',
    }, { agent: 'test' })) as { html: string }
    expect(html).not.toContain('vtable')
    expect(html).not.toContain('vt-filter-btn')
    expect(html).not.toContain('tray-sections')
    expect(html).not.toContain('function vtBootstrap')
    expect(html).toContain('<table>') // sigue habiendo tabla
    expect(html).toContain('Ana Pérez')
  })

  it('override por columna: sortable:false quita data-sortable de esa columna', async () => {
    const p: ResolvedNode = {
      ...piece,
      columnsSpec: [
        { field: 'id', label: 'ID', sortable: false },
        { field: 'nombre', label: 'Nombre' },
      ],
    }
    const { html } = (await renderHtmlPiece.execute({ piece: p, title: 'X', theme: 'arbol' }, { agent: 'test' })) as { html: string }
    // el th de id no es ordenable (sin vt-sortable ni data-sortable); el de nombre sí
    expect(html).toContain('<th class="align-left vt-col" data-field="id" aria-sort="none">')
    expect(html).toMatch(/data-field="nombre" data-sortable="1"/)
  })

  it('dashboard interactivo también cablea Vistas (vergisSavedViews, código compartido) + título Inspector', async () => {
    const dashPiece: ResolvedNode = { type: 'kpi', value: 5, label: 'x', format: 'int_0', agg: { dataset: 'd', op: 'sum', field: 'v' } }
    const interactive = { datasets: { d: [{ area: 'A', v: 1 }, { area: 'B', v: 2 }] }, filters: [{ dataset: 'd', field: 'area', label: 'Área' }] }
    const { html } = (await renderHtmlPiece.execute(
      { piece: dashPiece, title: 'X', theme: 'arbol', interactive } as never,
      { agent: 'test' },
    )) as { html: string }
    expect(html).toContain('class="tray-saved"') // tab Vistas en la gaveta común
    expect(html).toContain('vergisSavedViews(') // mismo snippet de Vistas que la tabla
    expect(html).toContain('dashSnapshot') // snapshot propio del dashboard (selección de facetas)
    expect(html).toContain('class="faceta"') // faceta del dashboard server-rendered
    expect(html).toContain('<strong>Inspector</strong>') // título del panel
    // dashboard (kpi, sin tabla) → no se fuerza paleta blanco (queda el default del theme)
    expect(html).not.toContain('class="table vtable"')
  })

  it('override por columna: filter:false quita el ícono de filtro de esa columna', async () => {
    const p: ResolvedNode = {
      ...piece,
      columnsSpec: [
        { field: 'id', label: 'ID', filter: false },
        { field: 'area', label: 'Área' },
      ],
    }
    const { html } = (await renderHtmlPiece.execute({ piece: p, title: 'X', theme: 'arbol' }, { agent: 'test' })) as { html: string }
    expect(html.match(/class="vt-filter-btn"/g)).toHaveLength(1) // solo area
    expect(html).toMatch(/data-field="area"[^]*?vt-filter-btn/)
  })

  it('payload escapa < para no romper el </script>', async () => {
    const p: ResolvedNode = {
      ...piece,
      rows: [{ id: 1, nombre: '<script>x</script>', area: 'A', estado: 'P' }],
      columnsSpec: piece.columnsSpec,
    }
    const { html } = (await renderHtmlPiece.execute({ piece: p, title: 'X', theme: 'arbol' }, { agent: 'test' })) as { html: string }
    expect(html).not.toContain('"nombre":"<script>')
    expect(html).toContain('\\u003c')
  })

  it('el CSS de la tabla va ANTES del markup, y el runtime DESPUÉS (anti-FOUC)', async () => {
    const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol' }, { agent: 'test' })) as { html: string }
    const cssIdx = html.indexOf('.vtable .vt-chips') // regla de TABLE_INTERACTIVE_CSS
    const tableIdx = html.indexOf('class="table vtable"')
    const runtimeIdx = html.indexOf('var payload = JSON.parse') // marca del runtime serializado
    expect(cssIdx).toBeGreaterThan(-1)
    expect(tableIdx).toBeGreaterThan(-1)
    expect(cssIdx).toBeLessThan(tableIdx) // CSS antes del markup → sin flash sin estilo
    expect(runtimeIdx).toBeGreaterThan(tableIdx) // runtime después del DOM
  })
})

describe('table-runtime · runtime serializado', () => {
  it('TABLE_RUNTIME_SOURCE es JS sintácticamente válido (compila sin ejecutar)', () => {
    // new Function compila el cuerpo; no lo ejecuta → no toca document/window.
    expect(() => new Function(TABLE_RUNTIME_SOURCE)).not.toThrow()
  })

  it('incluye las funciones puras serializadas', () => {
    for (const name of ['vtNorm', 'vtApply', 'vtGroup', 'vtIsCategorical', 'vtFormat']) {
      expect(TABLE_RUNTIME_SOURCE).toContain('function ' + name)
    }
  })
})

describe('theme-config · default por tipo de PI', () => {
  const tablePiece = { type: 'table' as const }
  const dashPiece = { layout: 'rows', elements: [{ type: 'kpi' }, { type: 'semaforo' }] }
  const mixedPiece = { layout: 'rows', elements: [{ type: 'table' }, { type: 'kpi' }] }

  it('classifyPiece: tabla→report, kpi/semáforo→dashboard, mixto→dashboard', () => {
    expect(classifyPiece(tablePiece)).toBe('report')
    expect(classifyPiece(dashPiece)).toBe('dashboard')
    expect(classifyPiece(mixedPiece)).toBe('dashboard')
  })

  it('platformThemeDefault: reportes → paleta blanco; dashboard → sin paleta forzada', () => {
    expect(platformThemeDefault('report').palette).toBe('blanco')
    expect(platformThemeDefault('dashboard').palette).toBeUndefined()
  })

  it('resolveTheme: un reporte hereda paleta blanco; el theme del spec gana sobre el default', () => {
    const r = resolveTheme(tablePiece, 'arbol')
    expect(r.theme).toBe('arbol') // spec gana en theme
    expect(r.palette).toBe('blanco') // paleta del default de plataforma (report)
    const d = resolveTheme(dashPiece, 'arbol')
    expect(d.palette).toBeUndefined() // dashboard sin paleta forzada
  })
})
