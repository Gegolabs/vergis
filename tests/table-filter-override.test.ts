// Clase de embudo DECLARADA por la columna (CAP-192) — `filter: vals | num | date`.
//
// El caso medido: en PI-12 la columna «Id Persona» es un identificador numérico, y desde 0.24.0
// (CAP-184) el embudo lo decide el DATO: `vtIsNumericCol` la ve numérica y le ofrece «Positivos /
// Negativos / En cero», que sobre un identificador no significan nada. Lo mismo pasa con un folio o
// un número de documento. El dato solo NO puede distinguir un monto de un identificador: quien lo
// sabe es el spec, y hasta acá no tenía cómo decirlo.
//
// La regla: `filter` sigue aceptando el booleano de siempre (override del auto-on de la faceta) y
// además un STRING que fija la clase de embudo y PREVALECE sobre la heurística del dato.
//
// Contra `main` fallan (b), (c), (d-string) y el cableado del runtime: allí no existe `vtPopKind`,
// `colFilterKind` no está en el bundle y `buildPop` bifurca directo por `vtIsNumericCol`. El caso
// (a) es CONTROL y pasa en ambos lados — es justamente lo que no debe cambiar.
import { describe, expect, it } from 'vitest'
import {
  renderHtmlPiece,
  TABLE_RUNTIME_SOURCE,
  vtApply,
  vtIsCategorical,
  vtPopHtml,
  vtPopKind,
  type ResolvedNode,
  type VtState,
} from '@vergis/capabilities'

/** Identificadores numéricos (el caso del beta tester) + una columna de texto + una de fecha. */
const ROWS: Record<string, unknown>[] = [
  { id_persona: 101, nombre: 'Ana', folio: '20260703', fecha: '2026-07-03', area: 'Logística' },
  { id_persona: 102, nombre: 'Beto', folio: '20260704', fecha: '2026-07-04', area: 'Finanzas' },
  { id_persona: 103, nombre: 'Carla', folio: '20260705', fecha: '2026-07-05', area: 'Logística' },
]

const baseState = (over: Partial<VtState> = {}): VtState => ({
  sort: { field: '', dir: 'asc' },
  globalSearch: '',
  colSearch: {},
  facets: {},
  groupBy: '',
  ...over,
})

const nombres = (rows: Record<string, unknown>[]): string[] => rows.map((r) => String(r.nombre))

/** El popover que la columna recibiría, ya resuelto: clase → HTML (el camino real de `buildPop`). */
const popFor = (field: string, declared?: boolean | string): string => {
  const kind = vtPopKind(ROWS, field, declared)
  return vtPopHtml(kind, field, kind === 'vals' ? '<label><input type="checkbox" value="101"></label>' : '')
}

describe('vtPopKind · quién decide la clase de embudo', () => {
  it('(a) CONTROL — sin override, lo decide el DATO: id numérico → num, fecha → date, texto → vals', () => {
    expect(vtPopKind(ROWS, 'id_persona')).toBe('num')
    expect(vtPopKind(ROWS, 'folio')).toBe('num') // string numérico: el dato lo ve número igual
    expect(vtPopKind(ROWS, 'fecha')).toBe('date')
    expect(vtPopKind(ROWS, 'area')).toBe('vals')
  })

  it('(b) la columna declara `filter: vals` → lista de valores, aunque el dato sea numérico', () => {
    expect(vtPopKind(ROWS, 'id_persona', 'vals')).toBe('vals')
    expect(vtPopKind(ROWS, 'folio', 'vals')).toBe('vals')
    // También gana sobre la heurística de FECHA.
    expect(vtPopKind(ROWS, 'fecha', 'vals')).toBe('vals')
  })

  it('(c) la columna declara `filter: num` → filtros de número, aunque el dato sea texto', () => {
    expect(vtPopKind(ROWS, 'area', 'num')).toBe('num')
    expect(vtPopKind(ROWS, 'nombre', 'num')).toBe('num')
  })

  it('`filter: date` fija el rango de fechas sobre una columna que el dato no reconoce como fecha', () => {
    // El folio `20260703` NO califica como fecha (regla deliberadamente estricta de vtIsDateCol).
    expect(vtPopKind(ROWS, 'folio')).not.toBe('date')
    expect(vtPopKind(ROWS, 'folio', 'date')).toBe('date')
  })

  it('(d) el BOOLEANO no fija clase: `true`/`false` siguen siendo el override del auto-on de siempre', () => {
    expect(vtPopKind(ROWS, 'id_persona', true)).toBe('num')
    expect(vtPopKind(ROWS, 'id_persona', false)).toBe('num')
    expect(vtPopKind(ROWS, 'area', true)).toBe('vals')
    // Y ese booleano sigue gobernando la faceta/agrupación como antes.
    expect(vtIsCategorical(ROWS, 'id_persona', true)).toBe(true)
    expect(vtIsCategorical(ROWS, 'area', false)).toBe(false)
  })

  it('(e) un string que no es del vocabulario NO fija nada: cae a la heurística del dato', () => {
    // La validación del DSL no mira `columns[].filter` (ver el PR): la degradación es segura —
    // un typo se comporta como si no se hubiera declarado, jamás rompe el embudo.
    expect(vtPopKind(ROWS, 'id_persona', 'texto')).toBe('num')
    expect(vtPopKind(ROWS, 'area', 'numero')).toBe('vals')
    expect(vtPopKind(ROWS, 'area', '')).toBe('vals')
  })

  it('un string declarado NO vuelve agrupable a la columna (eso sigue siendo `groupBy`)', () => {
    // `filter: vals` sobre «Id Persona» no vuelve útil «agrupar por Id Persona».
    expect(vtIsCategorical(ROWS, 'id_persona', 'vals')).toBe(false)
    expect(vtIsCategorical(ROWS, 'id_persona', true)).toBe(true)
  })
})

describe('el popover que se arma con el override', () => {
  it('(a) CONTROL — id numérico sin override → «Filtros de número»', () => {
    const html = popFor('id_persona')
    expect(html).toContain('Filtros de número')
    expect(html).not.toContain('vt-pop-opts')
  })

  it('(b) id numérico con `filter: vals` → checklist de valores, sin filtros de número', () => {
    const html = popFor('id_persona', 'vals')
    expect(html).toContain('vt-pop-opts')
    expect(html).toContain('vt-pop-search')
    expect(html).toContain('value="101"')
    expect(html).not.toContain('Filtros de número')
    expect(html).not.toContain('data-q="pos"')
  })

  it('(c) columna de texto con `filter: num` → «Filtros de número» con sus tres atajos', () => {
    const html = popFor('area', 'num')
    expect(html).toContain('Filtros de número')
    expect(html).toContain('data-q="pos"')
    expect(html).not.toContain('vt-pop-opts')
  })

  it('`filter: date` arma el rango Desde/Hasta', () => {
    const html = popFor('folio', 'date')
    expect(html).toContain('Rango de fechas')
    expect(html).toContain('vt-pop-from')
    expect(html).toContain('vt-pop-to')
  })
})

describe('vtApply · el filtro aplicado es coherente con la clase declarada', () => {
  it('(b) con `filter: vals` en una columna de ids, marcar valores filtra por IGUALDAD (faceta)', () => {
    const out = vtApply(ROWS, baseState({ facets: { id_persona: ['101', '103'] } }))
    expect(nombres(out)).toEqual(['Ana', 'Carla'])
  })

  it('la faceta sobre ids numéricos compara como STRING (el valor del checkbox), sin perder filas', () => {
    // El checkbox del popover lleva `String(valor)`; la faceta de vtApply compara con el mismo molde.
    const out = vtApply(ROWS, baseState({ facets: { id_persona: ['102'] } }))
    expect(nombres(out)).toEqual(['Beto'])
    expect(nombres(vtApply(ROWS, baseState({ facets: { id_persona: [] } })))).toHaveLength(3)
  })

  it('(c) con `filter: num` en una columna de texto, el filtro numérico deja fuera lo no numérico', () => {
    // Coherencia del otro lado: el predicado numérico de vtApply no cambia — una celda no numérica
    // queda FUERA mientras su columna tenga filtro de número activo.
    const out = vtApply(ROWS, baseState({ numFilters: { area: { min: 0, minIncl: false } } }))
    expect(out).toHaveLength(0)
  })

  it('el ORDEN de una columna de ids sigue siendo numérico aunque su embudo sea de valores', () => {
    // El override gobierna el EMBUDO, no el orden: ordenar «Id Persona» como texto pondría 10 antes
    // que 2. La decisión de orden la sigue tomando el dato (vtIsNumericCol), y así debe quedar.
    const rows = [{ id_persona: 10 }, { id_persona: 2 }, { id_persona: 100 }]
    const out = vtApply(rows, baseState({ sort: { field: 'id_persona', dir: 'asc' } }))
    expect(out.map((r) => r.id_persona)).toEqual([2, 10, 100])
  })
})

describe('el runtime servido lleva el override al navegador', () => {
  it('el bundle incluye la pura y el lector de la declaración de la columna', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtPopKind(')
    expect(TABLE_RUNTIME_SOURCE).toContain('function colFilterKind(field)')
    expect(TABLE_RUNTIME_SOURCE).toContain("typeof c.filter==='string'")
    // buildPop ya no bifurca por el dato: pregunta por la clase resuelta.
    expect(TABLE_RUNTIME_SOURCE).toContain('var kind = vtPopKind(rows, field, colFilterKind(field));')
  })

  it('la convención actualizada queda declarada en el código, junto al popover', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('SALVO que')
    expect(TABLE_RUNTIME_SOURCE).toContain('filter: vals|num|date')
  })

  it('el bundle sigue siendo JS válido', () => {
    expect(() => new Function(TABLE_RUNTIME_SOURCE)).not.toThrow()
  })
})

describe('render · la columna con `filter` string conserva su embudo y viaja en la meta', () => {
  const piece: ResolvedNode = {
    type: 'table',
    title: 'Personal',
    columnsSpec: [
      { field: 'id_persona', label: 'Id Persona', align: 'right', filter: 'vals' },
      { field: 'nombre', label: 'Nombre' },
      { field: 'area', label: 'Área', filter: false },
    ],
    rows: ROWS,
  }

  it('un string implica embudo (no es `false`) y llega al payload tal cual', async () => {
    const { html } = (await renderHtmlPiece.execute(
      { piece, title: 'X', theme: 'arbol' },
      { agent: 'test' },
    )) as { html: string }
    expect(html).toContain('"filter":"vals"') // la meta de columnas lo transporta
    // Embudo en «Id Persona» y en «Nombre»; NO en «Área», que lo apagó con `filter: false`.
    expect(html).toContain('data-field="id_persona" aria-label="Filtrar y buscar en Id Persona"')
    expect(html.match(/class="vt-filter-btn"/g)).toHaveLength(2)
  })
})
