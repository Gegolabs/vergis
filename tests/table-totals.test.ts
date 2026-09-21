// Total al pie de la tabla por columna (#314) — `table.columns[].total: sum | avg | count`.
//
// El caso medido: en PI-15 el totalizador vivía como una fila más del dato y Claudio no lo veía al
// pie; la petición que lo generalizó fue «sería bueno que las totalizaciones fuesen estándar del
// producto» (2026-09-21). El pie es OPT-IN por columna: un total sobre un porcentaje o sobre un
// stock a fechas distintas es peor que ninguno, porque nadie lo cuestiona.
//
// Cada caso de acá falla contra `main`: allí no existe `vtTotals`, ni `<tfoot>`, ni el código de
// validación `table-column-total-invalid`.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  renderHtmlPiece,
  vtTotals,
  TABLE_RUNTIME_SOURCE,
  TABLE_SSR_MAX_ROWS,
  TABLE_PRINT_MAX_ROWS,
  type ResolvedNode,
  type TableColumn,
} from '@vergis/capabilities'
import { composePiece, parseSpec, validateSpec } from '@vergis/mira'

const COLS: TableColumn[] = [
  { field: 'especie' },
  { field: 'cantidad', format: 'int_0', total: 'sum' },
  { field: 'promedio', format: 'int_0', total: 'avg' },
  { field: 'con_dato', total: 'count' },
]

// Mezcla deliberada: number, string numérico (BIGINT de un driver SQL), null, vacío y texto.
const ROWS: Record<string, unknown>[] = [
  { especie: 'Palto', cantidad: 100, promedio: 10, con_dato: 1 },
  { especie: 'Nogal', cantidad: '1200', promedio: 20, con_dato: '2' },
  { especie: 'Cítrico', cantidad: null, promedio: null, con_dato: null },
  { especie: 'Vid', cantidad: '', promedio: '', con_dato: '' },
  { especie: 'Olivo', cantidad: 'n/a', promedio: 'n/a', con_dato: 'n/a' },
]

/** 1 · La función pura: qué entra al agregado y qué se salta. */
describe('vtTotals · semántica del agregado', () => {
  it('sum suma number y string numérico; null, vacío y texto se SALTAN (no anulan)', () => {
    expect(vtTotals(COLS, ROWS).cantidad).toBe(1300)
  })

  it('avg divide por los CONSIDERADOS, no por las filas', () => {
    expect(vtTotals(COLS, ROWS).promedio).toBe(15) // (10+20)/2, no /5
  })

  it('count cuenta los considerados', () => {
    expect(vtTotals(COLS, ROWS).con_dato).toBe(2)
  })

  it('una columna sin `total` NO aparece en el resultado', () => {
    expect('especie' in vtTotals(COLS, ROWS)).toBe(false)
  })

  it('avg con CERO considerados ⇒ null (no NaN, no 0)', () => {
    const vacias = [{ x: null }, { x: '' }, { x: 'n/a' }]
    expect(vtTotals([{ field: 'x', total: 'avg' }], vacias).x).toBeNull()
    expect(vtTotals([{ field: 'x', total: 'sum' }], vacias).x).toBe(0)
    expect(vtTotals([{ field: 'x', total: 'count' }], vacias).x).toBe(0)
  })

  it('CONTROL: sin columnas ⇒ {}', () => {
    expect(vtTotals([], ROWS)).toEqual({})
  })
})

/** 2 · Reconciliación: el total no es «aproximado». */
describe('vtTotals · reconciliación sobre 1.000 filas', () => {
  // Semilla fija (LCG) — el fixture es el mismo en cada corrida.
  function sembrar(n: number): Record<string, unknown>[] {
    let x = 42
    return Array.from({ length: n }, () => {
      x = (x * 1103515245 + 12345) % 2147483648
      return { monto: x % 100000 }
    })
  }
  it('sum = la suma calculada con reduce en el test, dígito a dígito', () => {
    const filas = sembrar(1000)
    const esperado = filas.reduce((a, r) => a + Number(r.monto), 0)
    expect(vtTotals([{ field: 'monto', total: 'sum' }], filas).monto).toBe(esperado)
  })
})

function tabla(over: Partial<ResolvedNode> = {}): ResolvedNode {
  return {
    type: 'table',
    title: 'Cosecha',
    columnsSpec: [
      { field: 'especie', label: 'Especie' },
      { field: 'cantidad', label: 'Cantidad', format: 'int_0', align: 'right', total: 'sum' },
    ],
    rows: [
      { especie: 'Palto', cantidad: 1000000 },
      { especie: 'Nogal', cantidad: 234567 },
    ],
    interactive: true,
    ...over,
  }
}

async function html(piece: ResolvedNode, print = false): Promise<string> {
  const out = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol', print }, { agent: 'test' })) as {
    html: string
  }
  return out.html
}

/** 3 · Render interactivo. */
describe('render interactivo · <tfoot> con el total', () => {
  it('emite tfoot, la fila de total, el data-attr, el valor formateado es-CL y el rótulo', async () => {
    const h = await html(tabla())
    expect(h).toContain('<tfoot>')
    expect(h).toContain('class="vt-total-row"')
    expect(h).toContain('data-total-field="cantidad"')
    expect(h).toContain('1.234.567') // 1.000.000 + 234.567, con format int_0
    expect(h).toContain('vt-total-label">Total<')
  })

  it('CONTROL: la MISMA tabla sin `total` no emite tfoot alguno', async () => {
    const h = await html(
      tabla({ columnsSpec: [{ field: 'especie', label: 'Especie' }, { field: 'cantidad', format: 'int_0' }] }),
    )
    expect(h).not.toContain('<tfoot>')
    // `vt-total-row` a secas SÍ aparece en el documento (el runtime lo busca siempre); lo que no
    // debe existir es la FILA marcada con esa clase.
    expect(h).not.toContain('class="vt-total-row"')
  })
})

/** 4 · Estática y papel: el pie totaliza TODAS las filas aunque el cuerpo se trunque. */
describe('render estático y papel', () => {
  const muchas = Array.from({ length: TABLE_PRINT_MAX_ROWS + 1 }, () => ({ especie: 'X', cantidad: 2 }))

  it('estática (interactive:false) emite el pie', async () => {
    const h = await html(tabla({ interactive: false }))
    expect(h).toContain('<tfoot>')
    expect(h).toContain('1.234.567')
  })

  it('print: el tbody se trunca a TABLE_PRINT_MAX_ROWS y el pie suma las 5.001 filas', async () => {
    const h = await html(tabla({ rows: muchas }), true)
    const tbody = h.match(/<tbody>([\s\S]*?)<\/tbody>/)![1]
    expect((tbody.match(/<tr/g) ?? []).length).toBe(TABLE_PRINT_MAX_ROWS + 1) // + la fila de truncamiento
    expect(h).toContain('<tfoot>')
    expect(h).toContain(`>${new Intl.NumberFormat('es-CL').format((TABLE_PRINT_MAX_ROWS + 1) * 2)}<`)
  })
})

/** 5 · SSR incompleto: el pie servido no es el del recorte de 500. */
describe('SSR incompleto · el pie suma el DATASET, no el primer paint', () => {
  it('con 501 filas el pie dice 501, no 500', async () => {
    const n = TABLE_SSR_MAX_ROWS + 1
    const filas = Array.from({ length: n }, () => ({ especie: 'X', cantidad: 1 }))
    const h = await html(tabla({ rows: filas }))
    expect(h).toContain('"ssrComplete":false')
    const foot = h.match(/<tfoot>([\s\S]*?)<\/tfoot>/)![1]
    expect(foot).toContain(`>${n}<`)
    expect(foot).not.toContain(`>${TABLE_SSR_MAX_ROWS}<`)
  })
})

/** 6 · El recálculo viaja al browser. */
describe('runtime · el total sigue a los filtros', () => {
  it('TABLE_RUNTIME_SOURCE trae vtTotals y lee data-total-field', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtTotals')
    expect(TABLE_RUNTIME_SOURCE).toContain('data-total-field')
    expect(TABLE_RUNTIME_SOURCE).toContain('vt-total-row')
    expect(() => new Function(TABLE_RUNTIME_SOURCE)).not.toThrow()
  })

  it('el payload de columnas lleva `total` (sin él, el runtime no sabría qué recalcular)', async () => {
    expect(await html(tabla())).toContain('"total":"sum"')
  })
})

/** 7 · Validación del DSL. */
describe('DSL · table.columns[].total', () => {
  const SCHEMA = JSON.parse(
    readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
  ) as object
  const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
  const BASE = (total: string) => `
mira_version: "1.0"
identity: { id: pi-total, display_name: "Total", classification: internal }
piece:
  layout: rows
  elements:
    - table:
        data: data.datos
        columns:
          - { field: area }
          - { field: n, format: int_0, total: ${total} }
data:
  datos:
    capability: mock-sql
    params: { sql: "SELECT area, n FROM dbo.datos" }
    shape: { type: rows, fields: { area: string, n: integer } }
quality:
  freshness: { source_watermark: required, max_age: P1D, watermark_field: datos.area }
delivery: { render: [{ format: html, target: web }] }
`
  const validar = (total: string) => validateSpec(parseSpec(BASE(total)), { capabilities: CAPS, schema: SCHEMA })

  it('un valor fuera del vocabulario ⇒ table-column-total-invalid', () => {
    expect(() => validar('promedio')).toThrow(/table-column-total-invalid|promedio/)
    try {
      validar('promedio')
      throw new Error('debió lanzar')
    } catch (e) {
      expect((e as { structured?: { code?: string } }).structured?.code).toBe('table-column-total-invalid')
    }
  })

  it('sum, avg, count y true (alias) pasan', () => {
    for (const t of ['sum', 'avg', 'count', 'true']) expect(() => validar(t)).not.toThrow()
  })
})

/** 8 · Drill: el pie mantiene la geometría de la tabla. */
describe('drill · el pie lleva su celda de acciones', () => {
  it('el número de <td> del pie iguala el de <th> de la cabecera', async () => {
    const h = await html(tabla({ drills: [{ to: 'detalle', by: ['especie'], label: 'Ver' }] }))
    const thead = h.match(/<thead>([\s\S]*?)<\/thead>/)![1]
    const foot = h.match(/<tfoot>([\s\S]*?)<\/tfoot>/)![1]
    expect((foot.match(/<td/g) ?? []).length).toBe((thead.match(/<th/g) ?? []).length)
    expect(foot).toContain('<td class="vt-actions"></td>')
  })
})

/** 9 · `true` es alias de `sum`, y compose lo NORMALIZA (aguas abajo el vocabulario es cerrado). */
describe('compose · el alias `total: true`', () => {
  it('llega al render ya normalizado a `sum`', () => {
    const nodo = composePiece(
      { table: { data: 'data.d', columns: [{ field: 'n', total: true }] } },
      { d: { rows: [{ n: 3 }, { n: 4 }] } as never },
      { data: {} } as never,
    )
    expect(nodo.columnsSpec?.[0].total).toBe('sum')
  })
})
