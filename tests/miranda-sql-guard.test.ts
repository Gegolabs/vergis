import { describe, it, expect } from 'vitest'
import { guardProbeSql, SqlGuardError, referencedTables } from '@vergis/miranda'

const ALLOW = ['dbo.v_saldos', 'dbo.v_movimiento']
const guard = (sql: string) => guardProbeSql(sql, { allowlist: ALLOW })

describe('sql-guard · acepta lecturas legítimas y fuerza TOP', () => {
  it('SELECT simple → inyecta TOP 500', () => {
    const g = guard('SELECT empresa, saldo FROM dbo.v_saldos')
    expect(g.sql).toBe('SELECT TOP 500 empresa, saldo FROM dbo.v_saldos')
    expect(g.tables).toContain('dbo.v_saldos')
  })
  it('respeta DISTINCT al inyectar TOP', () => {
    expect(guard('SELECT DISTINCT empresa FROM dbo.v_saldos').sql).toBe('SELECT DISTINCT TOP 500 empresa FROM dbo.v_saldos')
  })
  it('descarta el TOP del usuario y fuerza el propio (TOP inyectado vs forzado)', () => {
    expect(guard('SELECT TOP 100000 * FROM dbo.v_saldos').sql).toBe('SELECT TOP 500 * FROM dbo.v_saldos')
    expect(guard('SELECT top(999) * FROM dbo.v_saldos').sql).toBe('SELECT TOP 500 * FROM dbo.v_saldos')
    expect(guard('SELECT TOP 5 PERCENT * FROM dbo.v_saldos').sql).toBe('SELECT TOP 500 * FROM dbo.v_saldos')
  })
  it('JOIN entre dos objetos del catálogo pasa', () => {
    const g = guard('SELECT s.empresa FROM dbo.v_saldos s JOIN dbo.v_movimiento m ON m.empresa = s.empresa')
    expect(g.tables.sort()).toEqual(['dbo.v_movimiento', 'dbo.v_saldos'])
  })
  it('objeto sin esquema pero allowlisteado por hoja pasa', () => {
    expect(guard('SELECT * FROM v_saldos').sql).toBe('SELECT TOP 500 * FROM v_saldos')
  })
  it('tolera un `;` final (lo quita)', () => {
    expect(guard('SELECT 1 AS x FROM dbo.v_saldos;').sql).toBe('SELECT TOP 500 1 AS x FROM dbo.v_saldos')
  })
})

describe('sql-guard · rechaza todo lo demás', () => {
  const rejects = (sql: string, re?: RegExp) => {
    expect(() => guard(sql)).toThrow(SqlGuardError)
    if (re) expect(() => guard(sql)).toThrow(re)
  }
  it('DML: INSERT/UPDATE/DELETE/MERGE', () => {
    rejects('INSERT INTO dbo.v_saldos VALUES (1)')
    rejects('UPDATE dbo.v_saldos SET saldo = 0')
    rejects('DELETE FROM dbo.v_saldos')
    rejects('SELECT * FROM dbo.v_saldos; MERGE dbo.v_saldos AS t USING x ON 1=1')
  })
  it('DDL: DROP/ALTER/CREATE/TRUNCATE', () => {
    rejects('DROP TABLE dbo.v_saldos')
    rejects('SELECT 1 FROM dbo.v_saldos WHERE 1=1 ALTER')
    rejects('TRUNCATE TABLE dbo.v_saldos')
  })
  it('multi-statement (`;` en medio)', () => {
    rejects('SELECT * FROM dbo.v_saldos; SELECT * FROM dbo.v_movimiento', /UNA sentencia/)
  })
  it('CTE (WITH) — se bloquea entero (cubre «CTE con DML»)', () => {
    rejects('WITH x AS (SELECT 1) SELECT * FROM x', /SELECT/)
    rejects('WITH x AS (INSERT INTO dbo.v_saldos VALUES(1)) SELECT * FROM dbo.v_saldos')
  })
  it('SELECT … INTO (crea tabla)', () => {
    rejects('SELECT * INTO nueva FROM dbo.v_saldos', /INTO/)
  })
  it('comment-smuggling (`--` y `/* */`)', () => {
    rejects('SELECT * FROM dbo.v_saldos -- ; DROP TABLE x', /Comentarios/)
    rejects('SELECT * /* sneaky */ FROM dbo.v_saldos', /Comentarios/)
  })
  it('procedimientos: EXEC / sp_ / xp_', () => {
    rejects('EXEC sp_who')
    rejects("SELECT * FROM dbo.v_saldos WHERE x = 1 EXECUTE('drop')")
  })
  it('lecturas fuera de catálogo: OPENROWSET / BULK', () => {
    rejects("SELECT * FROM OPENROWSET('x','y','z')")
  })
  it('tabla fuera del allowlist', () => {
    rejects('SELECT * FROM dbo.otra_tabla', /fuera del catálogo/)
  })
  it('sin FROM → nada que leer del catálogo', () => {
    rejects('SELECT 1', /FROM/)
  })
  it('no-SELECT de arranque', () => {
    rejects('EXPLAIN SELECT * FROM dbo.v_saldos')
  })
  it('vacío', () => {
    rejects('   ', /vac/)
  })
})

describe('sql-guard · referencedTables', () => {
  it('extrae FROM y JOIN, ignora subqueries derivadas', () => {
    expect(referencedTables('SELECT * FROM dbo.a JOIN dbo.b ON 1=1')).toEqual(['dbo.a', 'dbo.b'])
    expect(referencedTables('SELECT * FROM (SELECT * FROM dbo.c) t')).toEqual(['dbo.c'])
  })
})
