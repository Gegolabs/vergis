// #286 · El embudo de una columna lista solo los valores que sobreviven a los DEMÁS filtros.
//
// El caso medido en PI-15 (0.25.1): con `Mes = Marzo` puesto, la faceta `Week` seguía ofreciendo las
// 52 semanas del año con el conteo del dataset completo. Se marcaba una, la tabla quedaba vacía, y
// nada explicaba por qué. La convención adoptada es la del autofiltro de Excel: las opciones de la
// faceta de X se calculan sobre `vtApply(rows, estado sin la faceta de X)`.
//
// Contra `main` todo este archivo falla: `vtFacetOptions` no existe allí, y `buildPop` arma su lista
// con `vtDistinct(rows, field)` + `vtCounts(rows, field)` sobre el dataset entero.
import { describe, expect, it } from 'vitest'
import { TABLE_RUNTIME_SOURCE, vtFacetOptions, type VtState } from '@vergis/capabilities'

// Un calendario chico: cada mes con sus semanas, más un monto para cruzar con un filtro de número.
const ROWS: Record<string, unknown>[] = [
  { mes: 'Enero', week: 'W1', monto: 10 },
  { mes: 'Enero', week: 'W2', monto: -5 },
  { mes: 'Marzo', week: 'W10', monto: 20 },
  { mes: 'Marzo', week: 'W10', monto: 30 },
  { mes: 'Marzo', week: 'W11', monto: -1 },
  { mes: 'Abril', week: 'W15', monto: 40 },
  { mes: 'Abril', week: 'W10', monto: 50 },
]

const st = (over: Partial<VtState> = {}): VtState => ({
  sort: { field: '', dir: 'asc' },
  globalSearch: '',
  colSearch: {},
  facets: {},
  groupBy: '',
  ...over,
})

const vals = (o: { value: string; count: number }[]): string[] => o.map((x) => x.value)
const pairs = (o: { value: string; count: number }[]): [string, number][] =>
  o.map((x) => [x.value, x.count] as [string, number])

describe('vtFacetOptions · las opciones se acotan con el resto del estado', () => {
  it('CONTROL: sin ningún filtro lista todo el dominio de la columna, en orden natural', () => {
    expect(pairs(vtFacetOptions(ROWS, st(), 'mes'))).toEqual([
      ['Enero', 2],
      ['Marzo', 3],
      ['Abril', 2],
    ])
    expect(vals(vtFacetOptions(ROWS, st(), 'week'))).toEqual(['W1', 'W2', 'W10', 'W11', 'W15'])
  })

  it('otra faceta activa acota la lista Y los conteos', () => {
    const s = st({ facets: { mes: ['Marzo'] } })
    // Con Marzo puesto, `Week` deja de ofrecer las semanas de Enero y Abril.
    expect(pairs(vtFacetOptions(ROWS, s, 'week'))).toEqual([
      ['W10', 2],
      ['W11', 1],
    ])
  })

  it('la propia faceta NUNCA se auto-acota (si no, marcar un valor borraría los demás)', () => {
    const s = st({ facets: { mes: ['Marzo'] } })
    expect(pairs(vtFacetOptions(ROWS, s, 'mes'))).toEqual([
      ['Enero', 2],
      ['Marzo', 3],
      ['Abril', 2],
    ])
  })

  it('es simétrica, no jerárquica: Week acota a Mes igual que Mes acota a Week', () => {
    const s = st({ facets: { week: ['W10'] } })
    expect(pairs(vtFacetOptions(ROWS, s, 'mes'))).toEqual([
      ['Marzo', 2],
      ['Abril', 1],
    ])
  })

  it('varias facetas activas se acumulan sobre la que se abre', () => {
    const s = st({ facets: { mes: ['Marzo', 'Abril'], week: ['W10'] } })
    // Al abrir `week` se retira solo `week`: quedan las semanas de Marzo y Abril.
    expect(vals(vtFacetOptions(ROWS, s, 'week'))).toEqual(['W10', 'W11', 'W15'])
  })

  it('un filtro de NÚMERO activo acota la faceta igual que una faceta', () => {
    const s = st({ numFilters: { monto: { min: 0, minIncl: false } } })
    // Solo los positivos: W2 (-5) y W11 (-1) desaparecen, y Enero baja a un solo registro.
    expect(pairs(vtFacetOptions(ROWS, s, 'week'))).toEqual([
      ['W1', 1],
      ['W10', 3],
      ['W15', 1],
    ])
    expect(pairs(vtFacetOptions(ROWS, s, 'mes'))).toEqual([
      ['Enero', 1],
      ['Marzo', 2],
      ['Abril', 2],
    ])
  })

  it('la búsqueda global también acota', () => {
    expect(vals(vtFacetOptions(ROWS, st({ globalSearch: 'marzo' }), 'week'))).toEqual(['W10', 'W11'])
  })

  it('la búsqueda por columna también acota', () => {
    expect(vals(vtFacetOptions(ROWS, st({ colSearch: { mes: 'ener' } }), 'week'))).toEqual(['W1', 'W2'])
  })

  it('un valor YA SELECCIONADO sin filas se conserva, marcado con conteo 0, para poder quitarlo', () => {
    // `Mes = Enero` y `Week = W10`: W10 no existe en Enero. Sin esta regla, la opción desaparecería
    // del embudo y la persona quedaría atrapada en una tabla vacía sin nada que desmarcar.
    const s = st({ facets: { mes: ['Enero'], week: ['W10'] } })
    expect(pairs(vtFacetOptions(ROWS, s, 'week'))).toEqual([
      ['W1', 1],
      ['W2', 1],
      ['W10', 0],
    ])
  })

  it('el estado sin datos no explota y el conjunto vacío devuelve lista vacía', () => {
    expect(vtFacetOptions([], st(), 'mes')).toEqual([])
    expect(vals(vtFacetOptions(ROWS, st({ facets: { mes: ['Julio'] } }), 'week'))).toEqual([])
  })

  it('el vacío es un valor más de la faceta y va al final', () => {
    const rows = [{ area: 'Sur' }, { area: '' }, { area: 'Norte' }, { area: null }]
    expect(pairs(vtFacetOptions(rows, st(), 'area'))).toEqual([
      ['Norte', 1],
      ['Sur', 1],
      ['', 2],
    ])
  })
})

describe('la fuente que viaja al navegador', () => {
  it('el embudo arma su lista con vtFacetOptions y ya no con vtDistinct/vtCounts sobre todo el dataset', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtFacetOptions')
    expect(TABLE_RUNTIME_SOURCE).toContain('vtFacetOptions(rows, state, field)')
    // `vtDistinct(rows, field)` sigue vivo dentro de `vtIsCategorical` (ahí SÍ mira todo el
    // dataset: decide si la columna merece embudo). Lo que no debe quedar es el armado de la
    // lista del embudo con él, ni el contador sobre las filas sin filtrar.
    expect(TABLE_RUNTIME_SOURCE).not.toContain('var vals=vtDistinct(rows, field)')
    expect(TABLE_RUNTIME_SOURCE).not.toContain('vtCounts(')
  })

  it('el embudo lleva sello del resto del estado y se reconstruye al abrirse si cambió', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain("setAttribute('data-built-for'")
    expect(TABLE_RUNTIME_SOURCE).toContain("getAttribute('data-built-for')")
    expect(TABLE_RUNTIME_SOURCE).toContain('sello!==facetSello(pf)')
    // El sello NO incluye la faceta propia: marcar un valor no debe rehacer su propia lista.
    expect(TABLE_RUNTIME_SOURCE).toContain('if(k!==field && state.facets[k]')
  })
})
