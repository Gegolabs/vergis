// Subtotal por grupo en la cabecera de cada nivel de agrupación (#316) — continúa #314.
//
// El caso medido: PI-37 de la instancia GH (Claudio Cornejo, 2026-09-21) pidió «totalizador a
// discreción por mes y/o semana y/o especie y/o variedad, agregarlo o quitarlo cuando guste». Con
// la bandeja ya agrupando por esos campos, lo que faltaba era el agregado del grupo en su propia
// fila de cabecera.
//
// OPT-IN DOBLE: la columna declara `total` (#314) **y** el usuario agrupa. Sin columnas con `total`
// la cabecera de grupo queda byte a byte como estaba (caso 2, control de invariancia).
//
// Cada caso de acá falla contra `main`: allí no existe `vtGroupHeadCells`, `vtGroupTree` no
// conserva `rows` por grupo, y la cabecera es un único `<td colspan>`.
import { describe, expect, it } from 'vitest'
import { TABLE_RUNTIME_SOURCE, vtGroupHeadCells, vtGroupTree, vtTotals, type TableColumn } from '@vergis/capabilities'

const LABEL = '<span class="vt-gcaret">▾</span> Especie: Palto <span class="vt-gcount">(3)</span>'

const COLS: TableColumn[] = [
  { field: 'especie', label: 'Especie' },
  { field: 'cantidad', label: 'Cantidad', format: 'int_0', align: 'right', total: 'sum' },
  { field: 'rendimiento', label: 'Rendimiento', align: 'right' },
]

const FILAS: Record<string, unknown>[] = [
  { mes: '2026-01', especie: 'Palto', cantidad: 1000, rendimiento: 10 },
  { mes: '2026-01', especie: 'Nogal', cantidad: '234', rendimiento: 20 },
  { mes: '2026-02', especie: 'Palto', cantidad: 500, rendimiento: null },
]

/** 1 · El árbol conserva las filas del SUBÁRBOL de cada grupo (no solo sus hojas directas). */
describe('vtGroupTree · cada grupo lleva las filas de su subárbol', () => {
  it('nivel 1: rows son exactamente las filas del grupo y rows.length === count', () => {
    const tree = vtGroupTree(FILAS, ['mes', 'especie'])
    const enero = tree.groups!.find((g) => g.key === '2026-01')!
    expect(enero.rows.length).toBe(enero.count)
    expect(enero.rows.map((r) => r.especie)).toEqual(['Palto', 'Nogal'])
  })

  it('nivel 2: el hijo también trae sus rows, y son un subconjunto de las del padre', () => {
    const tree = vtGroupTree(FILAS, ['mes', 'especie'])
    const enero = tree.groups!.find((g) => g.key === '2026-01')!
    const palto = enero.child.groups!.find((g) => g.key === 'Palto')!
    expect(palto.rows).toEqual([FILAS[0]])
    expect(palto.rows.length).toBe(palto.count)
  })
})

/** 2 · CONTROL DE INVARIANCIA: sin columnas con `total`, la cabecera es la de siempre. */
describe('vtGroupHeadCells · sin columnas con total', () => {
  it('devuelve un único <td colspan> con el rótulo y la sangría, idéntico al formato actual', () => {
    const sinTotal: TableColumn[] = [{ field: 'especie' }, { field: 'cantidad' }]
    expect(vtGroupHeadCells(sinTotal, FILAS, 0, LABEL, 12)).toBe(
      '<td colspan="2" style="padding-left:12px">' + LABEL + '</td>',
    )
  })

  it('las celdas de acciones cuentan en el colspan', () => {
    const sinTotal: TableColumn[] = [{ field: 'especie' }, { field: 'cantidad' }]
    expect(vtGroupHeadCells(sinTotal, FILAS, 1, LABEL, 30)).toContain('colspan="3"')
  })
})

/** 3 · Con una columna `sum`: una celda por columna, el rótulo en la primera sin total. */
describe('vtGroupHeadCells · con columna total: sum', () => {
  const html = vtGroupHeadCells(COLS, FILAS, 1, LABEL, 12)

  it('la columna con total lleva su celda marcada y el valor formateado es-CL', () => {
    expect(html).toContain('<td class="align-right vt-gtotal" data-total-field="cantidad">1.734</td>')
  })

  it('el rótulo va en la primera columna sin total, con la sangría', () => {
    expect(html.startsWith('<td style="padding-left:12px">' + LABEL + '</td>')).toBe(true)
  })

  it('las columnas sin total que no llevan el rótulo quedan vacías', () => {
    expect(html).toContain('<td></td>')
  })

  it('emite una celda por columna más las de acciones', () => {
    expect(html.match(/<td[ >]/g)!.length).toBe(COLS.length + 1)
    expect(html).toContain('<td class="vt-actions"></td>')
  })

  it('ninguna celda de subtotal lleva clase ni variable de magnitud', () => {
    expect(html).not.toContain('--mag')
    expect(html).not.toContain('vt-mag')
  })

  it('un subtotal null se muestra como raya, no como vacío ni NaN', () => {
    const solo: TableColumn[] = [{ field: 'especie' }, { field: 'x', total: 'avg' }]
    expect(vtGroupHeadCells(solo, [{ especie: 'Palto', x: null }], 0, LABEL, 12)).toContain(
      'data-total-field="x">—</td>',
    )
  })
})

/** 4 · Caso límite: si TODAS las columnas totalizan, el rótulo va en la primera. */
describe('vtGroupHeadCells · todas las columnas con total', () => {
  const todas: TableColumn[] = [
    { field: 'cantidad', format: 'int_0', align: 'right', total: 'sum' },
    { field: 'rendimiento', align: 'right', total: 'count' },
  ]
  const html = vtGroupHeadCells(todas, FILAS, 0, LABEL, 12)

  it('la primera columna lleva el rótulo y NO su subtotal', () => {
    expect(html.startsWith('<td style="padding-left:12px">' + LABEL + '</td>')).toBe(true)
    expect(html).not.toContain('data-total-field="cantidad"')
  })

  it('las demás sí llevan su subtotal', () => {
    expect(html).toContain('data-total-field="rendimiento">2</td>')
  })
})

/** 5 · Reconciliación: Σ subtotales = el total del pie, y Σ hijos = el padre. */
describe('reconciliación · 300 filas, dos niveles (mes › especie)', () => {
  // Semilla fija (LCG) — el fixture es el mismo en cada corrida.
  function sembrar(n: number): Record<string, unknown>[] {
    let x = 7
    const meses = ['2026-01', '2026-02', '2026-03']
    const especies = ['Palto', 'Nogal', 'Cítrico', 'Vid']
    return Array.from({ length: n }, (_, i) => {
      x = (x * 1103515245 + 12345) % 2147483648
      return { mes: meses[i % 3], especie: especies[x % 4], cantidad: x % 100000 }
    })
  }
  const filas = sembrar(300)
  const cols: TableColumn[] = [{ field: 'especie' }, { field: 'cantidad', total: 'sum' }]
  const colsCount: TableColumn[] = [{ field: 'especie' }, { field: 'cantidad', total: 'count' }]
  const tree = vtGroupTree(filas, ['mes', 'especie'])

  it('Σ de los subtotales `sum` del primer nivel = el total del pie, dígito a dígito', () => {
    const suma = tree.groups!.reduce((a, g) => a + (vtTotals(cols, g.rows).cantidad as number), 0)
    expect(suma).toBe(vtTotals(cols, filas).cantidad)
  })

  it('Σ de los `count` del primer nivel = el count del pie', () => {
    const suma = tree.groups!.reduce((a, g) => a + (vtTotals(colsCount, g.rows).cantidad as number), 0)
    expect(suma).toBe(vtTotals(colsCount, filas).cantidad)
    expect(suma).toBe(300)
  })

  it('Σ de los hijos de un grupo = el subtotal de su padre', () => {
    const padre = tree.groups![0]
    const hijos = padre.child.groups!.reduce((a, g) => a + (vtTotals(cols, g.rows).cantidad as number), 0)
    expect(hijos).toBe(vtTotals(cols, padre.rows).cantidad)
  })
})

/** 6 · `avg` y `count` por grupo: sobre los CONSIDERADOS del grupo, con el null saltado. */
describe('vtGroupHeadCells · avg y count por grupo', () => {
  const filas = [
    { g: 'A', v: 10 },
    { g: 'A', v: 20 },
    { g: 'A', v: null },
  ]
  it('avg = suma/considerados del grupo (el null no promedia)', () => {
    const cols: TableColumn[] = [{ field: 'g' }, { field: 'v', total: 'avg' }]
    expect(vtGroupHeadCells(cols, filas, 0, LABEL, 12)).toContain('data-total-field="v">15</td>')
  })
  it('count cuenta los considerados, no las filas', () => {
    const cols: TableColumn[] = [{ field: 'g' }, { field: 'v', total: 'count' }]
    expect(vtGroupHeadCells(cols, filas, 0, LABEL, 12)).toContain('data-total-field="v">2</td>')
  })
})

/** 7 · El mecanismo viaja al browser, y la ruta vieja se REEMPLAZÓ (no se duplicó). */
describe('TABLE_RUNTIME_SOURCE · lo que llega al navegador', () => {
  it('lleva vtGroupHeadCells y la clase de la celda de subtotal', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtGroupHeadCells')
    expect(TABLE_RUNTIME_SOURCE).toContain('vt-gtotal')
  })

  it('la cabecera de grupo ya NO se arma con el <td colspan> inline de renderNodeTree', () => {
    expect(TABLE_RUNTIME_SOURCE).not.toContain('<td colspan="\'+ncols+\'" style="padding-left:')
  })

  it('sigue siendo JS válido tras la sustitución', () => {
    expect(() => new Function(TABLE_RUNTIME_SOURCE)).not.toThrow()
  })
})
