// Endurecimiento del gate de gobernanza (work/052 F4): `tablesOf` es la ÚNICA fuente de "qué tablas
// toca un PI". Si no ve una tabla, esa tabla se serviría sin verificar política → en Fabric fuga TODAS
// sus filas. La regex vieja no reconocía corchetes T-SQL, comillas dobles ni comma-joins.
import { describe, it, expect } from 'vitest'
import { analyzeSqlTables, tablesOf } from '../server/sql-tables'

describe('tablesOf · extracción de tablas para el gate fail-closed', () => {
  it('caso base: FROM/JOIN con schema.tabla desnudo (minúscula, sin repetir)', () => {
    const sql = 'SELECT a.x, b.y FROM dbo.saldo a JOIN dbo.dim_fechas b ON a.wk = b.wk'
    expect(tablesOf(sql)).toEqual(['dbo.saldo', 'dbo.dim_fechas'])
  })

  it('corchetes T-SQL: [dbo].[fct_cartera] → dbo.fct_cartera', () => {
    expect(tablesOf('SELECT * FROM [dbo].[fct_cartera]')).toEqual(['dbo.fct_cartera'])
  })

  it('comillas dobles: "Schema"."Tabla" → schema.tabla (normalizado a minúscula)', () => {
    expect(tablesOf('SELECT * FROM "Schema"."Tabla" WHERE 1=1')).toEqual(['schema.tabla'])
  })

  it('comma-join: FROM dbo.a, dbo.b → AMBAS (la 2ª escapaba a la regex vieja)', () => {
    expect(tablesOf('SELECT * FROM dbo.a, dbo.b WHERE dbo.a.id = dbo.b.id')).toEqual(['dbo.a', 'dbo.b'])
  })

  it('comma-join con alias: FROM dbo.a a, dbo.b b → ambas (los alias no tienen punto, se ignoran)', () => {
    expect(tablesOf('SELECT * FROM dbo.a a, dbo.b b')).toEqual(['dbo.a', 'dbo.b'])
  })

  it('NO captura columnas calificadas del SELECT/ON como si fueran tablas (sin falsos positivos)', () => {
    // `t.col` en el SELECT tiene la forma ident.ident pero NO es una tabla — vive fuera de la región FROM.
    const sql = 'SELECT dbo.a.col1, dbo.a.col2 FROM dbo.a WHERE dbo.a.col1 > 0'
    expect(tablesOf(sql)).toEqual(['dbo.a'])
  })

  it('mezcla de estilos en el mismo SQL (comma-join en el FROM + JOIN explícito)', () => {
    const sql = 'SELECT * FROM [dbo].[a], dbo.c JOIN "s"."b" ON [dbo].[a].k = "s"."b".k'
    expect(tablesOf(sql).sort()).toEqual(['dbo.a', 'dbo.c', 's.b'])
  })
})

describe('analyzeSqlTables · referencias single-part (work/052 R3-8)', () => {
  it('FROM dim_area (sin esquema) → unqualified (el gate la trata como NO gobernable)', () => {
    const a = analyzeSqlTables('SELECT * FROM dim_area WHERE 1=1')
    expect(a.tables).toEqual([])
    expect(a.unqualified).toEqual(['dim_area'])
  })

  it('single-part con alias y en JOIN también se detecta', () => {
    const a = analyzeSqlTables('SELECT * FROM dbo.a x JOIN dim_area d ON x.k = d.k')
    expect(a.tables).toEqual(['dbo.a'])
    expect(a.unqualified).toEqual(['dim_area'])
  })

  it('CTE no dispara: los nombres de WITH ... AS ( quedan exentos', () => {
    const sql = 'WITH w1 AS (SELECT 1), w2 AS (SELECT k FROM dbo.b) SELECT * FROM w1 JOIN w2 ON 1=1'
    const a = analyzeSqlTables(sql)
    expect(a.tables).toEqual(['dbo.b'])
    expect(a.unqualified).toEqual([])
  })

  it('función de tabla pegada al paréntesis (numbers(5), STRING_SPLIT(...)) queda exenta', () => {
    const a = analyzeSqlTables('WITH dias AS (SELECT n FROM numbers(5)) SELECT * FROM dias')
    expect(a.unqualified).toEqual([])
  })

  it('alias de tabla calificada NO se marca como single-part (sin falsos positivos)', () => {
    const a = analyzeSqlTables('SELECT * FROM dbo.a a, dbo.b b WHERE a.k = b.k')
    expect(a.tables).toEqual(['dbo.a', 'dbo.b'])
    expect(a.unqualified).toEqual([])
  })

  it('tablesOf sigue devolviendo solo las calificadas (contrato existente intacto)', () => {
    expect(tablesOf('SELECT * FROM dim_area, dbo.a')).toEqual(['dbo.a'])
  })
})
