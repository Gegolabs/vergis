// #285 · Las facetas y los grupos se ordenan como una persona los escribiría, no como el alfabeto.
//
// El caso medido en PI-15 (0.25.1): la faceta `Mes` abría `Abril, Agosto, Diciembre, Enero…` y la
// faceta `Week` listaba `W1, W10, W11, …, W2`. Ninguna de las dos es una lista: son el alfabeto
// aplicado a una serie que tiene orden propio.
//
// La regla la decide el CONJUNTO de valores, no el par (un comparador que cambia de modo por par es
// no-transitivo). Contra `main` estos casos fallan: allí `vtSortValues` no existe, y tanto `buildPop`
// como `vtGroup` ordenan con `vtNorm(a).localeCompare(vtNorm(b))` — «Abril» primero.
import { describe, expect, it } from 'vitest'
import { TABLE_RUNTIME_SOURCE, vtGroup, vtSortValues } from '@vergis/capabilities'

describe('vtSortValues · orden natural por familia del conjunto', () => {
  it('1 · todos numéricos → ascendente por número, no por texto', () => {
    expect(vtSortValues(['10', '2', '1', '100', '20'])).toEqual(['1', '2', '10', '20', '100'])
    // El control que separa la familia numérica del alfabético: por texto, '10' iría antes que '2'.
    expect(vtSortValues(['10', '2'])).not.toEqual(['10', '2'].sort())
    expect(vtSortValues(['-5', '0', '3.5', '-10'])).toEqual(['-10', '-5', '0', '3.5'])
  })

  it('2 · todos fecha ISO → cronológico (el lexicográfico del ISO), con hora incluida', () => {
    expect(vtSortValues(['2026-03-01', '2025-12-31', '2026-01-15'])).toEqual([
      '2025-12-31',
      '2026-01-15',
      '2026-03-01',
    ])
    expect(vtSortValues(['2026-01-02T10:00', '2026-01-02T09:00', '2026-01-01T23:59'])).toEqual([
      '2026-01-01T23:59',
      '2026-01-02T09:00',
      '2026-01-02T10:00',
    ])
  })

  it('3 · prefijo alfabético corto + número, mismo prefijo → por el número (W2 antes que W10)', () => {
    expect(vtSortValues(['W1', 'W10', 'W11', 'W2', 'W20', 'W3'])).toEqual([
      'W1',
      'W2',
      'W3',
      'W10',
      'W11',
      'W20',
    ])
    expect(vtSortValues(['Q4', 'Q1', 'Q10', 'Q2'])).toEqual(['Q1', 'Q2', 'Q4', 'Q10'])
    expect(vtSortValues(['S-3', 'S-12', 'S-1'])).toEqual(['S-1', 'S-3', 'S-12'])
    // Insensible a mayúsculas en el prefijo: sigue siendo la misma serie.
    expect(vtSortValues(['w10', 'W2'])).toEqual(['W2', 'w10'])
  })

  it('3 bis · prefijos DISTINTOS no son una serie → alfabético', () => {
    // `A1 B2 A10` mezcla dos series; ordenarlas por número las intercalaría sin sentido.
    expect(vtSortValues(['B2', 'A10', 'A1'])).toEqual(['A1', 'A10', 'B2'])
  })

  it('4 · nombres de mes es/en, completos o abreviados → orden calendario', () => {
    expect(vtSortValues(['Abril', 'Agosto', 'Diciembre', 'Enero', 'Marzo'])).toEqual([
      'Enero',
      'Marzo',
      'Abril',
      'Agosto',
      'Diciembre',
    ])
    expect(vtSortValues(['dic', 'ene', 'sep', 'feb'])).toEqual(['ene', 'feb', 'sep', 'dic'])
    expect(vtSortValues(['August', 'April', 'January'])).toEqual(['January', 'April', 'August'])
    // Insensible a acentos y a punto final de abreviatura.
    expect(vtSortValues(['Nov.', 'Ene.', 'Jul.'])).toEqual(['Ene.', 'Jul.', 'Nov.'])
  })

  it('5 · lo que no califica cae al alfabético de siempre', () => {
    expect(vtSortValues(['Sur', 'Norte', 'Centro'])).toEqual(['Centro', 'Norte', 'Sur'])
    // Mezcla que NO califica en ninguna familia: una semana y un mes juntos → alfabético.
    expect(vtSortValues(['W1', 'Marzo'])).toEqual(['Marzo', 'W1'])
    // Un solo intruso rompe la familia numérica: el conjunto manda sobre el par.
    expect(vtSortValues(['10', '2', 'N/D'])).toEqual(['10', '2', 'N/D'])
  })

  it('el vacío va SIEMPRE al final, en cualquier familia', () => {
    expect(vtSortValues(['W10', '', 'W2'])).toEqual(['W2', 'W10', ''])
    expect(vtSortValues(['', 'Marzo', 'Enero'])).toEqual(['Enero', 'Marzo', ''])
    expect(vtSortValues(['', 'Sur', 'Norte'])).toEqual(['Norte', 'Sur', ''])
    // Un valor de puros espacios cuenta como vacío (no arrastra la familia consigo).
    expect(vtSortValues(['10', '   ', '2'])).toEqual(['2', '10', '   '])
  })

  it('conjunto vacío o de un solo valor no explota', () => {
    expect(vtSortValues([])).toEqual([])
    expect(vtSortValues([''])).toEqual([''])
    expect(vtSortValues(['Marzo'])).toEqual(['Marzo'])
  })

  it('los empates dentro de una familia son deterministas', () => {
    expect(vtSortValues(['W2', 'w2', 'W1'])).toEqual(['W1', 'W2', 'w2'])
  })
})

describe('vtGroup · las claves de grupo heredan el orden natural (#285)', () => {
  const ROWS = [
    { mes: 'Marzo', v: 1 },
    { mes: 'Enero', v: 2 },
    { mes: 'Abril', v: 3 },
    { mes: 'Diciembre', v: 4 },
    { mes: 'Enero', v: 5 },
  ]

  it('agrupar por mes ordena por calendario, no por alfabeto', () => {
    // CONTRA `main`: la primera clave es 'Abril'.
    expect(vtGroup(ROWS, 'mes').map((g) => g.key)).toEqual(['Enero', 'Marzo', 'Abril', 'Diciembre'])
  })

  it('las filas dentro de cada grupo conservan su orden de llegada', () => {
    const enero = vtGroup(ROWS, 'mes').filter((g) => g.key === 'Enero')[0]
    expect(enero.rows.map((r) => r.v)).toEqual([2, 5])
  })

  it('agrupar por semana pone W2 antes que W10', () => {
    const rows = [{ w: 'W10' }, { w: 'W2' }, { w: 'W1' }]
    expect(vtGroup(rows, 'w').map((g) => g.key)).toEqual(['W1', 'W2', 'W10'])
  })
})

describe('la fuente que viaja al navegador', () => {
  it('emite vtSortValues y ya no ordena la faceta con localeCompare crudo', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtSortValues')
    expect(TABLE_RUNTIME_SOURCE).toContain('vtSortValues(')
    expect(TABLE_RUNTIME_SOURCE).not.toContain('vtDistinct(rows, field).slice().sort')
  })
})
