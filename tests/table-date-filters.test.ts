// Filtro por RANGO en columnas de FECHA — hermano del filtro de número de 0.24.0 (#280).
//
// El caso medido: en PI-16 (Informe Factura) el embudo de «Fecha Documento» abría la lista de
// valores distintos, un día por línea; acotar «del 1 al 31 de julio» eran treinta clics y el
// resultado no se leía como un rango sino como una pared de chips de día. Ahora una columna cuyos
// valores son fechas ISO recibe Desde/Hasta: lo decide el DATO (`vtIsDateCol`), no el spec.
//
// Cada caso de acá falla contra `main`: allí no existe `dateFilters` ni `vtDateFilterLabel`, y el
// popover de una columna de fechas es el mismo checklist que el de una de texto.
import { describe, expect, it } from 'vitest'
import {
  TABLE_RUNTIME_SOURCE,
  vtApply,
  vtDateFilterLabel,
  vtIsDateCol,
  vtIsNumericCol,
  vtPopHtml,
  type VtState,
} from '@vergis/capabilities'
import { TABLE_INTERACTIVE_CSS } from '../packages/capabilities/src/piece-css'

const ROWS: Record<string, unknown>[] = [
  { id: 'A', glosa: 'Ana', fecha: '2026-06-30' },
  { id: 'B', glosa: 'Beto', fecha: '2026-07-01' },
  { id: 'C', glosa: 'Carla', fecha: '2026-07-15' },
  { id: 'D', glosa: 'Dora', fecha: '2026-07-31' },
  { id: 'E', glosa: 'Édgar', fecha: '2026-08-01' },
  { id: 'F', glosa: 'Fran', fecha: null },
  { id: 'G', glosa: 'Gil', fecha: '' },
]

const baseState = (over: Partial<VtState> = {}): VtState => ({
  sort: { field: '', dir: 'asc' },
  globalSearch: '',
  colSearch: {},
  facets: {},
  groupBy: '',
  ...over,
})

const ids = (rows: Record<string, unknown>[]): string[] => rows.map((r) => String(r.id))

describe('vtIsDateCol · la detección la decide el dato', () => {
  it('POSITIVO: ISO puro, y también ISO con hora (T o espacio, con y sin segundos)', () => {
    expect(vtIsDateCol(ROWS, 'fecha')).toBe(true)
    expect(vtIsDateCol([{ f: '2026-07-01T13:45' }, { f: '2026-07-02T00:00:00' }], 'f')).toBe(true)
    expect(vtIsDateCol([{ f: '2026-07-01 13:45:00' }], 'f')).toBe(true)
  })

  it('NEGATIVO: un folio de 8 dígitos NO es una fecha (por eso la regla es estricta)', () => {
    const folios = [{ f: '20260703' }, { f: '20260704' }]
    expect(vtIsDateCol(folios, 'f')).toBe(false)
    // …y ese folio sí es numérico: `vtIsNumericCol` corre primero y se lo lleva.
    expect(vtIsNumericCol(folios, 'f')).toBe(true)
  })

  it('NEGATIVO: fecha sin ceros a la izquierda (`2026-7-3`) no califica', () => {
    expect(vtIsDateCol([{ f: '2026-7-3' }], 'f')).toBe(false)
  })

  it('NEGATIVO: texto, y NEGATIVO: columna mixta (una sola celda no-fecha basta)', () => {
    expect(vtIsDateCol([{ f: 'Logística' }, { f: 'Ventas' }], 'f')).toBe(false)
    expect(vtIsDateCol([{ f: '2026-07-01' }, { f: 'sin fecha' }], 'f')).toBe(false)
  })

  it('NEGATIVO: una columna sin ningún valor no vacío no es de fecha (nada que detectar)', () => {
    expect(vtIsDateCol([{ f: null }, { f: '' }], 'f')).toBe(false)
    expect(vtIsDateCol([], 'f')).toBe(false)
  })

  it('las celdas vacías o nulas NO invalidan la detección', () => {
    expect(vtIsDateCol([{ f: '2026-07-01' }, { f: null }, { f: '' }], 'f')).toBe(true)
  })

  it('una columna de fecha NO es numérica (las dos detecciones son disjuntas acá)', () => {
    expect(vtIsNumericCol(ROWS, 'fecha')).toBe(false)
  })
})

describe('vtApply · filtros de fecha', () => {
  it('CONTROL: sin dateFilters el conjunto no cambia', () => {
    expect(ids(vtApply(ROWS, baseState()))).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    expect(ids(vtApply(ROWS, baseState({ dateFilters: {} })))).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
  })

  it('solo `min` = «desde»: incluye el borde', () => {
    const out = vtApply(ROWS, baseState({ dateFilters: { fecha: { min: '2026-07-01' } } }))
    expect(ids(out)).toEqual(['B', 'C', 'D', 'E'])
  })

  it('solo `max` = «hasta»: incluye el borde', () => {
    const out = vtApply(ROWS, baseState({ dateFilters: { fecha: { max: '2026-07-31' } } }))
    expect(ids(out)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('`entre` es INCLUSIVO en ambos bordes — el 1 y el 31 de julio entran', () => {
    const out = vtApply(
      ROWS,
      baseState({ dateFilters: { fecha: { min: '2026-07-01', max: '2026-07-31' } } }),
    )
    expect(ids(out)).toEqual(['B', 'C', 'D'])
  })

  it('un solo día: min = max deja exactamente ese día', () => {
    const out = vtApply(
      ROWS,
      baseState({ dateFilters: { fecha: { min: '2026-07-15', max: '2026-07-15' } } }),
    )
    expect(ids(out)).toEqual(['C'])
  })

  it('una celda null o vacía queda FUERA cuando su columna tiene filtro de fecha', () => {
    for (const flt of [
      { min: '2026-07-01' },
      { max: '2026-07-31' },
      { min: '1900-01-01', max: '2999-12-31' },
    ]) {
      const out = ids(vtApply(ROWS, baseState({ dateFilters: { fecha: flt } })))
      expect(out).not.toContain('F')
      expect(out).not.toContain('G')
    }
  })

  it('un filtro sin bordes no filtra nada (no existe)', () => {
    expect(ids(vtApply(ROWS, baseState({ dateFilters: { fecha: {} } })))).toEqual([
      'A', 'B', 'C', 'D', 'E', 'F', 'G',
    ])
    // Bordes en cadena vacía = igual que ausentes (lo que entrega un <input type=date> sin valor).
    expect(ids(vtApply(ROWS, baseState({ dateFilters: { fecha: { min: '', max: '' } } })))).toEqual([
      'A', 'B', 'C', 'D', 'E', 'F', 'G',
    ])
  })

  it('un valor con HORA se compara por su día (los primeros 10 caracteres del ISO)', () => {
    const rows = [
      { id: 'X', fecha: '2026-07-31T23:59:00' },
      { id: 'Y', fecha: '2026-08-01T00:01:00' },
    ]
    const out = vtApply(rows, baseState({ dateFilters: { fecha: { max: '2026-07-31' } } }))
    expect(ids(out)).toEqual(['X'])
  })

  it('compone con la búsqueda global y con las facetas sin pisarlas', () => {
    const out = vtApply(
      ROWS,
      baseState({
        globalSearch: 'car',
        dateFilters: { fecha: { min: '2026-07-01', max: '2026-07-31' } },
      }),
    )
    expect(ids(out)).toEqual(['C'])
  })

  it('CONTROL: no toca el filtro de número — ambos conviven en el mismo estado', () => {
    const rows = [
      { id: 'A', fecha: '2026-07-05', monto: -5 },
      { id: 'B', fecha: '2026-07-06', monto: 5 },
      { id: 'C', fecha: '2026-08-06', monto: -5 },
    ]
    const out = vtApply(
      rows,
      baseState({
        numFilters: { monto: { max: 0, maxIncl: false } },
        dateFilters: { fecha: { min: '2026-07-01', max: '2026-07-31' } },
      }),
    )
    expect(ids(out)).toEqual(['A'])
  })
})

describe('vtDateFilterLabel · la etiqueta del chip', () => {
  it('el rango completo se lee DD-MM-AAAA con flecha', () => {
    expect(vtDateFilterLabel({ min: '2026-07-01', max: '2026-07-31' })).toBe('01-07-2026 → 31-07-2026')
  })

  it('con un solo borde se lee «desde …» / «hasta …»', () => {
    expect(vtDateFilterLabel({ min: '2026-07-01' })).toBe('desde 01-07-2026')
    expect(vtDateFilterLabel({ max: '2026-07-31' })).toBe('hasta 31-07-2026')
  })

  it('un solo día no se repite dos veces', () => {
    expect(vtDateFilterLabel({ min: '2026-07-15', max: '2026-07-15' })).toBe('15-07-2026')
  })

  it('un filtro sin bordes no tiene etiqueta (no se pinta chip)', () => {
    expect(vtDateFilterLabel({})).toBe('')
    expect(vtDateFilterLabel({ min: '', max: '' })).toBe('')
  })
})

describe('vtPopHtml · el popover de fecha', () => {
  it('columna de FECHA → Desde/Hasta, sin checklist de valores', () => {
    const html = vtPopHtml('date', 'Fecha Documento', '')
    expect(html).toContain('Rango de fechas')
    expect(html).toContain('Fecha Documento')
    expect(html).toContain('type="date"')
    expect(html).toContain('vt-pop-from')
    expect(html).toContain('vt-pop-to')
    expect(html).toContain('Desde')
    expect(html).toContain('Hasta')
    expect(html).toContain('vt-pop-apply')
    expect(html).toContain('vt-pop-clear')
    expect(html).not.toContain('vt-pop-opts')
    expect(html).not.toContain('vt-pop-search')
    expect(html).not.toContain('Filtros de número')
  })

  it('los atajos van con su clave (este mes · mes anterior · últimos 30 días)', () => {
    const html = vtPopHtml('date', 'Fecha', '')
    expect(html).toContain('data-dq="mes"')
    expect(html).toContain('data-dq="mesant"')
    expect(html).toContain('data-dq="d30"')
  })

  it('el filtro vigente vuelve a los campos (el popover se reabre con lo aplicado)', () => {
    const html = vtPopHtml('date', 'Fecha', '', undefined, { min: '2026-07-01', max: '2026-07-31' })
    expect(html).toContain('class="vt-pop-from" type="date" value="2026-07-01"')
    expect(html).toContain('class="vt-pop-to" type="date" value="2026-07-31"')
  })

  it('un valor con hora se recorta al día en el campo (un input date no acepta la hora)', () => {
    const html = vtPopHtml('date', 'Fecha', '', undefined, { min: '2026-07-01T10:00:00' })
    expect(html).toContain('value="2026-07-01"')
  })

  it('el rótulo de la columna se escapa', () => {
    expect(vtPopHtml('date', '<b>x</b>', '')).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('CONTROL — la columna numérica y la de texto no cambian', () => {
    expect(vtPopHtml('num', 'Deuda', '')).toContain('Filtros de número')
    expect(vtPopHtml('num', 'Deuda', '')).not.toContain('type="date"')
    expect(vtPopHtml('vals', 'Área', '<label></label>')).toContain('vt-pop-opts')
    expect(vtPopHtml('vals', 'Área', '<label></label>')).not.toContain('type="date"')
  })
})

describe('el runtime servido trae los filtros de fecha', () => {
  it('el bundle incluye las puras y el cableado', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtIsDateCol(')
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtDateFilterLabel(')
    expect(TABLE_RUNTIME_SOURCE).toContain('buildDatePop')
    expect(TABLE_RUNTIME_SOURCE).toContain('vtIsDateCol(rows, field)') // la bifurcación de buildPop
    expect(TABLE_RUNTIME_SOURCE).toContain('dateFilters:{}') // estado inicial
    expect(TABLE_RUNTIME_SOURCE).toContain('data-datefield') // chip removible
  })

  it('el snapshot de las vistas guardadas incluye dateFilters (ida y vuelta)', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('dateFilters: JSON.parse(JSON.stringify(state.dateFilters))')
    expect(TABLE_RUNTIME_SOURCE).toContain('state.dateFilters = s.dateFilters ?')
  })

  it('«Limpiar todo» y la marca «filtrado» del CSV cuentan los filtros de fecha', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('state.numFilters={}; state.dateFilters={};')
    expect(TABLE_RUNTIME_SOURCE).toContain(
      'for(var dff in state.dateFilters){ if(state.dateFilters[dff]) filtered=true; }',
    )
  })

  it('el orden de detección está en el código: numérica primero, fecha después', () => {
    const src = TABLE_RUNTIME_SOURCE
    expect(src.indexOf('vtIsNumericCol(rows, field)')).toBeLessThan(src.indexOf('vtIsDateCol(rows, field)'))
  })

  it('el bundle sigue siendo JS válido', () => {
    expect(() => new Function(TABLE_RUNTIME_SOURCE)).not.toThrow()
  })

  it('el CSS trae el estilo de la pareja Desde/Hasta', () => {
    expect(TABLE_INTERACTIVE_CSS).toContain('.vt-pop-dates')
  })
})
