// Filtros de NÚMERO en columnas numéricas — convención de plataforma.
//
// El caso medido: en PI-01 el embudo de «Deuda Total» abría la lista de valores distintos, donde
// cada monto es único; un usuario que quería «los negativos» marcó decenas de valores y se quedó
// con una pared de chips `Deuda Total: -10261752661 ×`. Excel resuelve esto con filtros de número,
// y eso es lo que la tabla ofrece ahora: lo decide el DATO (`vtIsNumericCol`), no el spec.
//
// Cada caso de acá falla contra `main`: allí no existe `numFilters` ni `vtNumFilterLabel`, y el
// popover de una columna numérica es el mismo checklist que el de una de texto.
import { describe, expect, it } from 'vitest'
import {
  TABLE_RUNTIME_SOURCE,
  vtApply,
  vtNumFilterLabel,
  vtPopHtml,
  type VtState,
} from '@vergis/capabilities'
import { TABLE_INTERACTIVE_CSS } from '../packages/capabilities/src/piece-css'

const ROWS: Record<string, unknown>[] = [
  { rut: 'A', nombre: 'Ana', deuda: -10261752661 },
  { rut: 'B', nombre: 'Beto', deuda: 0 },
  { rut: 'C', nombre: 'Carla', deuda: 15 },
  { rut: 'D', nombre: 'Dora', deuda: 10 },
  { rut: 'E', nombre: 'Édgar', deuda: 20 },
  { rut: 'F', nombre: 'Fran', deuda: null },
  { rut: 'G', nombre: 'Gil', deuda: '' },
]

const baseState = (over: Partial<VtState> = {}): VtState => ({
  sort: { field: '', dir: 'asc' },
  globalSearch: '',
  colSearch: {},
  facets: {},
  groupBy: '',
  ...over,
})

const ruts = (rows: Record<string, unknown>[]): string[] => rows.map((r) => String(r.rut))

describe('vtApply · filtros de número', () => {
  it('CONTROL: sin numFilters el conjunto no cambia', () => {
    expect(ruts(vtApply(ROWS, baseState()))).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    expect(ruts(vtApply(ROWS, baseState({ numFilters: {} })))).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
  })

  it('`< 0` deja solo los negativos', () => {
    const out = vtApply(ROWS, baseState({ numFilters: { deuda: { max: 0, maxIncl: false } } }))
    expect(ruts(out)).toEqual(['A'])
  })

  it('`> 0` deja solo los positivos (el cero queda fuera)', () => {
    const out = vtApply(ROWS, baseState({ numFilters: { deuda: { min: 0, minIncl: false } } }))
    expect(ruts(out)).toEqual(['C', 'D', 'E'])
  })

  it('`= 0` deja solo los ceros', () => {
    const out = vtApply(
      ROWS,
      baseState({ numFilters: { deuda: { min: 0, max: 0, minIncl: true, maxIncl: true } } }),
    )
    expect(ruts(out)).toEqual(['B'])
  })

  it('`entre 10 y 20` es INCLUSIVO en ambos bordes', () => {
    const out = vtApply(
      ROWS,
      baseState({ numFilters: { deuda: { min: 10, max: 20, minIncl: true, maxIncl: true } } }),
    )
    expect(ruts(out)).toEqual(['C', 'D', 'E'])
  })

  it('una celda null o vacía queda FUERA cuando su columna tiene filtro numérico', () => {
    // «Los negativos» no incluye «los que no tienen dato»: un vacío no es un número que cumpla.
    for (const flt of [
      { max: 0, maxIncl: false },
      { min: 0, minIncl: false },
      { min: -1e12, max: 1e12, minIncl: true, maxIncl: true },
    ]) {
      const out = vtApply(ROWS, baseState({ numFilters: { deuda: flt } }))
      expect(ruts(out)).not.toContain('F')
      expect(ruts(out)).not.toContain('G')
    }
  })

  it('un filtro sin bordes no filtra nada (no existe)', () => {
    const out = vtApply(ROWS, baseState({ numFilters: { deuda: {} } }))
    expect(ruts(out)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
  })

  it('los montos que llegan como STRING (BIGINT de los drivers SQL) se comparan como números', () => {
    const rows = [{ rut: 'X', deuda: '-2644239500' }, { rut: 'Y', deuda: '300' }]
    const out = vtApply(rows, baseState({ numFilters: { deuda: { max: 0, maxIncl: false } } }))
    expect(ruts(out)).toEqual(['X'])
  })

  it('compone con la búsqueda global sin pisarla', () => {
    const out = vtApply(
      ROWS,
      baseState({ globalSearch: 'car', numFilters: { deuda: { min: 0, minIncl: false } } }),
    )
    expect(ruts(out)).toEqual(['C'])
  })
})

describe('vtNumFilterLabel · la etiqueta del chip', () => {
  it('produce las cinco etiquetas de la convención', () => {
    expect(vtNumFilterLabel({ max: 0, maxIncl: false })).toBe('< 0')
    expect(vtNumFilterLabel({ min: 0, minIncl: false })).toBe('> 0')
    expect(vtNumFilterLabel({ min: 0, max: 0, minIncl: true, maxIncl: true })).toBe('= 0')
    expect(vtNumFilterLabel({ min: 1000, minIncl: false })).toBe('> 1.000')
    expect(vtNumFilterLabel({ min: 1000, max: 5000, minIncl: true, maxIncl: true })).toBe(
      'entre 1.000 y 5.000',
    )
  })

  it('con el `format` de la columna formatea como la celda (int_0 → miles con punto)', () => {
    expect(vtNumFilterLabel({ min: 1000, minIncl: false }, 'int_0')).toBe('> 1.000')
    expect(vtNumFilterLabel({ min: 1234567, max: 7654321, minIncl: true, maxIncl: true }, 'int_0')).toBe(
      'entre 1.234.567 y 7.654.321',
    )
  })

  it('los bordes inclusivos de un solo lado se leen ≥ / ≤', () => {
    expect(vtNumFilterLabel({ min: 5, minIncl: true })).toBe('≥ 5')
    expect(vtNumFilterLabel({ max: 5, maxIncl: true })).toBe('≤ 5')
  })

  it('un filtro sin bordes no tiene etiqueta (no se pinta chip)', () => {
    expect(vtNumFilterLabel({})).toBe('')
  })
})

describe('vtPopHtml · el popover lo decide el dato', () => {
  it('columna NUMÉRICA → «Filtros de número», sin checklist de valores', () => {
    const html = vtPopHtml('num', 'Deuda Total', '')
    expect(html).toContain('Filtros de número')
    expect(html).toContain('Deuda Total')
    expect(html).not.toContain('vt-pop-opts')
    expect(html).not.toContain('vt-pop-search') // sin buscador de valores
    // Los tres atajos y la fila de operador.
    expect(html).toContain('data-q="pos"')
    expect(html).toContain('data-q="neg"')
    expect(html).toContain('data-q="zero"')
    expect(html).toContain('Positivos (&gt; 0)')
    expect(html).toContain('Negativos (&lt; 0)')
    expect(html).toContain('En cero')
    for (const op of ['mayor que', 'menor que', 'entre', 'igual a']) expect(html).toContain(op)
    expect(html).toContain('vt-pop-apply')
    expect(html).toContain('vt-pop-clear')
  })

  it('CONTROL — columna de TEXTO → checklist de valores, sin filtros de número', () => {
    const html = vtPopHtml('vals', 'Área', '<label><input type="checkbox" value="Norte"></label>')
    expect(html).toContain('vt-pop-opts')
    expect(html).toContain('vt-pop-search')
    expect(html).toContain('value="Norte"')
    expect(html).not.toContain('Filtros de número')
    expect(html).not.toContain('vt-pop-quick')
  })

  it('el atajo activo se marca (toggle visible y accesible)', () => {
    const on = vtPopHtml('num', 'Deuda', '', { max: 0, maxIncl: false })
    expect(on).toContain('class="vt-pop-q on" data-q="neg" aria-pressed="true"')
    const off = vtPopHtml('num', 'Deuda', '', { min: 100, minIncl: false })
    expect(off).not.toContain('aria-pressed="true"')
  })

  it('el rótulo de la columna se escapa', () => {
    expect(vtPopHtml('num', '<b>x</b>', '')).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(vtPopHtml('vals', '<b>x</b>', '')).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})

describe('el runtime servido trae los filtros de número', () => {
  it('el bundle incluye las puras y el cableado', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtNumFilterLabel(')
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtPopHtml(')
    expect(TABLE_RUNTIME_SOURCE).toContain('buildNumPop')
    expect(TABLE_RUNTIME_SOURCE).toContain('vtIsNumericCol(rows, field)') // la bifurcación de buildPop
    expect(TABLE_RUNTIME_SOURCE).toContain('numFilters:{}') // estado inicial
    expect(TABLE_RUNTIME_SOURCE).toContain('data-numfield') // chip removible
  })

  it('el snapshot de las vistas guardadas incluye numFilters (ida y vuelta)', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('numFilters: JSON.parse(JSON.stringify(state.numFilters))')
    expect(TABLE_RUNTIME_SOURCE).toContain('state.numFilters = s.numFilters ?')
  })

  it('«Limpiar todo» y la marca «filtrado» del CSV cuentan los filtros de número', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain("state.facets={}; state.numFilters={};")
    expect(TABLE_RUNTIME_SOURCE).toContain('for(var nff in state.numFilters){ if(state.numFilters[nff]) filtered=true; }')
  })

  it('la convención queda declarada en el código, junto al popover', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('CONVENCIÓN DE PLATAFORMA')
    expect(TABLE_RUNTIME_SOURCE).toContain('Lo decide el DATO (vtIsNumericCol), no el spec.')
  })

  it('el bundle sigue siendo JS válido', () => {
    expect(() => new Function(TABLE_RUNTIME_SOURCE)).not.toThrow()
  })

  it('el CSS trae el estilo del popover numérico', () => {
    expect(TABLE_INTERACTIVE_CSS).toContain('.vt-pop-quick')
    expect(TABLE_INTERACTIVE_CSS).toContain('.vt-pop-range')
    expect(TABLE_INTERACTIVE_CSS).toContain('.vt-pop-title')
  })
})
