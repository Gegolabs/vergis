// LA MEDICIÓN DE UNA CONEXIÓN para el Datadoc (CAP-197), puesta en riesgo.
//
// Lo que esta suite existe para atrapar es UNA cosa, y cuesta una fuga: que el catálogo publique el
// `COUNT(*)` de una tabla cuya RLS filtra. La defensa tiene dos eslabones —clasificar bien, y no
// preguntar donde no corresponde— y acá se mide cada uno por separado, con un `execute` falso que
// REGISTRA cada SQL emitido. Un test que solo mirara el modelo devuelto no vería la diferencia entre
// «no preguntó» y «preguntó y descartó la respuesta», que es justamente la que importa.
//
// El fixture del predicado FILTRADO no está escrito a mano: sale del COMPILADOR REAL
// (`compileFabric`), así que el día que el compilador cambie la forma que emite, este test lo sigue
// en vez de quedarse midiendo un string que ya nadie produce.

import { describe, it, expect } from 'vitest'
import { compileFabric, parseAudience } from '@vergis/policy'
import {
  clasificarPredicado,
  funcionDelPredicado,
  guardSoloLectura,
  medirConexion,
  qConteo,
  qTablas,
  Q_MODULOS,
  Q_SECPOL,
  type EjecutarSql,
} from '../server/datadoc-introspect'

const FAB_TARGET = { schema: 'dbo', table: 'areas' }
const CON_FILTRO = { rls: [{ column: 'area', claim: 'groups', op: 'in' }], default: 'deny' }

/** La definición de la función de predicado que el compilador emite para CADA rama. */
function definicionDe(audiencia: unknown): string {
  const enf = compileFabric(parseAudience(audiencia as never), FAB_TARGET)!
  const create = enf.setupSQL.find((s) => s.startsWith('CREATE FUNCTION'))
  expect(create, 'el compilador tiene que emitir un CREATE FUNCTION').toBeTruthy()
  return create!
}

const DEF_ABIERTA = definicionDe({ public: true })
const DEF_FILTRADA = definicionDe(CON_FILTRO)

// ── (0) El fixture es real: las DOS ramas comparten el literal ──────────────────────────────────

describe('el literal `SELECT 1 AS vergis_allowed` NO discrimina', () => {
  it('el compilador lo emite en las DOS ramas — por eso clasificar por substring es la falla', () => {
    // Esta es la medición que funda toda la regla: si alguna vez dejara de ser cierta, el test de
    // abajo pasaría por la razón equivocada y nadie se enteraría.
    expect(DEF_ABIERTA).toContain('SELECT 1 AS vergis_allowed')
    expect(DEF_FILTRADA).toContain('SELECT 1 AS vergis_allowed')
    // El regex ingenuo —el que usa el generador de instancia— matchea las dos.
    const ingenuo = /select\s+1\s+as\s+vergis_allowed/i
    expect(ingenuo.test(DEF_ABIERTA)).toBe(true)
    expect(ingenuo.test(DEF_FILTRADA)).toBe(true)
  })
})

// ── (1) Clasificación por forma completa ────────────────────────────────────────────────────────

describe('clasificarPredicado', () => {
  it('la rama allow-all del compilador ⇒ `abierta`', () => {
    expect(clasificarPredicado(DEF_ABIERTA)).toBe('abierta')
  })

  it('⚠ la rama CON FILTRO del compilador ⇒ `filtrada` — el test que falla si se clasifica por substring', () => {
    // REFUTARÍA la regla: `abierta` acá significaría que toda tabla con RLS real quedaría clasificada
    // como abierta y el catálogo publicaría su COUNT. Es la falla que la v1.1 del plan corrigió.
    expect(clasificarPredicado(DEF_FILTRADA)).toBe('filtrada')
  })

  it('tolera comentarios, saltos y `;` — lo que cambia la forma sin cambiar el sentido', () => {
    const conRuido = DEF_ABIERTA.replace('AS RETURN', 'AS RETURN -- comentario\n /* bloque */') + ';'
    expect(clasificarPredicado(conRuido)).toBe('abierta')
  })

  it('fail-closed: una definición cuyo `AS RETURN` no se localiza ⇒ `filtrada`, no `abierta`', () => {
    expect(clasificarPredicado('SELECT 1 AS vergis_allowed WHERE 1 = 0')).toBe('filtrada')
    expect(clasificarPredicado('')).toBe('filtrada')
    expect(clasificarPredicado('cualquier cosa')).toBe('filtrada')
  })

  it('un predicado que EMPIEZA igual pero sigue no es allow-all', () => {
    expect(clasificarPredicado('CREATE FUNCTION f() RETURNS TABLE AS RETURN SELECT 1 AS vergis_allowed WHERE 1=1')).toBe('filtrada')
  })
})

describe('funcionDelPredicado', () => {
  it('extrae la función invocada sin suponer ninguna convención de nombre', () => {
    expect(funcionDelPredicado('([dbo].[fn_pol_areas]([area]))')).toBe('dbo.fn_pol_areas')
    expect(funcionDelPredicado('(dbo.rls_lo_que_sea(col))')).toBe('dbo.rls_lo_que_sea')
    expect(funcionDelPredicado('(mi_funcion())')).toBe('mi_funcion')
    expect(funcionDelPredicado('')).toBeNull()
  })
})

// ── (2) El guard de solo lectura ────────────────────────────────────────────────────────────────

describe('guardSoloLectura', () => {
  it('deja pasar un SELECT y un WITH', () => {
    expect(guardSoloLectura('SELECT 1')).toBe('SELECT 1')
    expect(guardSoloLectura('WITH x AS (SELECT 1) SELECT * FROM x')).toBeTruthy()
  })
  it.each(['DROP TABLE t', 'DELETE FROM t', 'SELECT * INTO otra FROM t', 'EXEC sp_x', 'UPDATE t SET a = 1'])(
    'rechaza «%s»',
    (sql) => {
      expect(() => guardSoloLectura(sql)).toThrow()
    },
  )
  it('rechaza más de una sentencia', () => {
    expect(() => guardSoloLectura('SELECT 1; SELECT 2')).toThrow(/una sola sentencia/)
  })
  it('un verbo dentro de un comentario o de un literal NO es un verbo', () => {
    expect(() => guardSoloLectura("SELECT 'DELETE' AS x -- DROP TABLE t")).not.toThrow()
  })
  it('todas las consultas del módulo pasan el guard (se verifica al cargar, y otra vez acá)', () => {
    for (const q of [qTablas(['dbo']), Q_MODULOS, Q_SECPOL, qConteo('dbo', 'x')]) expect(() => guardSoloLectura(q)).not.toThrow()
  })
  it('el identificador del COUNT se valida por parte: nada que no sea [A-Za-z0-9_]+ entra', () => {
    expect(() => qConteo('dbo', 'a];DROP TABLE x--')).toThrow(/no contable/)
    expect(() => qConteo('db o', 't')).toThrow(/no contable/)
  })
})

describe('la lista de esquemas es BLANCA, no negra', () => {
  it('solo los esquemas declarados entran a la consulta', () => {
    const q = qTablas(['dbo', 'analitica'])
    expect(q).toContain("N'dbo'")
    expect(q).toContain("N'analitica'")
    expect(q).toContain('TABLE_SCHEMA IN (')
    // REFUTARÍA: un `NOT IN` dejaría entrar el `queryinsights` de Fabric, medido en wh_finanzas.
    expect(q).not.toContain('NOT IN')
  })
  it('un esquema con forma inválida rompe antes de tocar la red', () => {
    expect(() => qTablas(["dbo'; DROP"])).toThrow(/esquema inválido/)
  })
})

// ── (3) La medición: el `execute` falso que registra cada SQL ───────────────────────────────────

const OBJETOS = [
  { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'abierta', TABLE_TYPE: 'BASE TABLE' },
  { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'filtrada', TABLE_TYPE: 'BASE TABLE' },
  { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'sin_politica', TABLE_TYPE: 'BASE TABLE' },
  { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'huerfana', TABLE_TYPE: 'BASE TABLE' },
  { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'v_abierta', TABLE_TYPE: 'VIEW' },
]

const COLUMNAS = [
  { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'abierta', COLUMN_NAME: 'id', ORDINAL_POSITION: 1, DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
  { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'abierta', COLUMN_NAME: 'nombre', ORDINAL_POSITION: 2, DATA_TYPE: 'nvarchar', CHARACTER_MAXIMUM_LENGTH: 50, IS_NULLABLE: 'YES' },
  { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'filtrada', COLUMN_NAME: 'area', ORDINAL_POSITION: 1, DATA_TYPE: 'nvarchar', CHARACTER_MAXIMUM_LENGTH: -1, IS_NULLABLE: 'NO' },
  { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'sin_politica', COLUMN_NAME: 'monto', ORDINAL_POSITION: 1, DATA_TYPE: 'decimal', NUMERIC_PRECISION: 18, NUMERIC_SCALE: 2, IS_NULLABLE: 'YES' },
]

const MODULOS = [
  { sch: 'dbo', obj: 'v_abierta', tipo: 'V ', def: 'CREATE VIEW dbo.v_abierta AS SELECT * FROM dbo.abierta' },
  { sch: 'dbo', obj: 'fn_pol_abierta', tipo: 'IF', def: DEF_ABIERTA },
  { sch: 'dbo', obj: 'fn_pol_filtrada', tipo: 'IF', def: DEF_FILTRADA },
]

const SECPOL = [
  { secpol: 'secpol_abierta', habilitada: 1, sch: 'dbo', objetivo: 'abierta', predicado: '([dbo].[fn_pol_abierta]())' },
  { secpol: 'secpol_filtrada', habilitada: 1, sch: 'dbo', objetivo: 'filtrada', predicado: '([dbo].[fn_pol_filtrada]([area]))' },
  // Una política cuya función NO está en sys.sql_modules: indeterminada, y por lo tanto sin conteo.
  { secpol: 'secpol_huerfana', habilitada: 1, sch: 'dbo', objetivo: 'huerfana', predicado: '([dbo].[fn_que_no_existe]())' },
]

const LINAJE = [{ vsch: 'dbo', vname: 'v_abierta', bsch: 'dbo', bname: 'abierta', bound: 1 }]

/** Un `execute` que responde por FORMA de consulta y deja el registro de todo lo que se le pidió. */
function ejecutorFalso(opts: { rechaza?: (sql: string) => boolean } = {}): { execute: EjecutarSql; sqls: string[] } {
  const sqls: string[] = []
  const execute: EjecutarSql = async ({ sql }) => {
    sqls.push(sql)
    if (opts.rechaza?.(sql)) throw new Error('permiso denegado por el motor')
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) return { rows: OBJETOS }
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return { rows: COLUMNAS }
    if (sql.includes('sys.sql_modules m JOIN sys.objects')) return { rows: MODULOS }
    if (sql.includes('sys.security_policies')) return { rows: SECPOL }
    if (sql.includes('sys.sql_expression_dependencies')) return { rows: LINAJE }
    if (sql.includes('COUNT_BIG')) return { rows: [{ n: 42 }] }
    return { rows: [] }
  }
  return { execute, sqls }
}

const CONEXION = { ref: 'demo', server: 'endpoint.example', database: 'wh_demo' }

describe('medirConexion · los conteos', () => {
  it('⚠ NO emite COUNT sobre una tabla FILTRADA, y sí sobre la abierta y la no gobernada', async () => {
    const { execute, sqls } = ejecutorFalso()
    const m = await medirConexion(execute, CONEXION)
    const cuentas = sqls.filter((s) => s.includes('COUNT_BIG'))
    // REFUTARÍA: un solo COUNT que nombre `filtrada` significaría que el catálogo le preguntó a una
    // tabla que la RLS protege — la fuga que esta regla existe para no tener.
    expect(cuentas.some((s) => s.includes('[filtrada]'))).toBe(false)
    expect(cuentas.some((s) => s.includes('[huerfana]'))).toBe(false)
    expect(cuentas.some((s) => s.includes('[abierta]'))).toBe(true)
    expect(cuentas.some((s) => s.includes('[sin_politica]'))).toBe(true)
    // …y el modelo lo refleja: la filtrada no trae número, las otras sí.
    expect(m.conteos['dbo.filtrada']).toBeUndefined()
    expect(m.conteos['dbo.huerfana']).toBeUndefined()
    expect(m.conteos['dbo.abierta']).toBe(42)
    expect(m.conteos['dbo.sin_politica']).toBe(42)
  })

  it('con `conteos: off` no emite NINGÚN COUNT, ni sobre las abiertas', async () => {
    const { execute, sqls } = ejecutorFalso()
    const m = await medirConexion(execute, CONEXION, { conteos: 'off' })
    expect(sqls.filter((s) => s.includes('COUNT_BIG'))).toHaveLength(0)
    expect(Object.keys(m.conteos)).toHaveLength(0)
  })

  it('a una vista nunca se le pide el conteo: se lee de su base', async () => {
    const { execute, sqls } = ejecutorFalso()
    await medirConexion(execute, CONEXION)
    expect(sqls.some((s) => s.includes('COUNT_BIG') && s.includes('[v_abierta]'))).toBe(false)
  })
})

describe('medirConexion · el gobierno', () => {
  it('clasifica cada tabla por la forma completa de su predicado', async () => {
    const m = await medirConexion(ejecutorFalso().execute, CONEXION)
    expect(m.gobierno['dbo.abierta'].clase).toBe('abierta')
    expect(m.gobierno['dbo.filtrada'].clase).toBe('filtrada')
    expect(m.gobierno['dbo.sin_politica'].clase).toBe('no gobernada')
    expect(m.gobierno['dbo.huerfana'].clase).toBe('indeterminada')
    expect(m.gobierno['dbo.filtrada'].politicas[0].funcion).toBe('dbo.fn_pol_filtrada')
  })

  it('el perfil manda sobre la consulta: `server` y `database` no salen del motor', async () => {
    const m = await medirConexion(ejecutorFalso().execute, CONEXION)
    expect(m.database).toBe('wh_demo')
    expect(m.server).toBe('endpoint.example')
  })

  it('las columnas salen con su tipo legible y en orden ordinal', async () => {
    const m = await medirConexion(ejecutorFalso().execute, CONEXION)
    expect(m.columnas['dbo.abierta'].map((c) => `${c.nombre}:${c.tipo}`)).toEqual(['id:int', 'nombre:nvarchar(50)'])
    expect(m.columnas['dbo.filtrada'][0].tipo).toBe('nvarchar(max)')
    expect(m.columnas['dbo.sin_politica'][0].tipo).toBe('decimal(18,2)')
  })

  it('el linaje sale de `sys`, no de un regex sobre la definición de la vista', async () => {
    const m = await medirConexion(ejecutorFalso().execute, CONEXION)
    expect(m.linaje).toEqual([{ vista: 'dbo.v_abierta', base: 'dbo.abierta', schemabound: true }])
  })
})

describe('medirConexion · un sub-error NO invalida la conexión', () => {
  it('con `sys.security_policies` denegada: el modelo sale con errores[], todo indeterminado y SIN conteos', async () => {
    const { execute, sqls } = ejecutorFalso({ rechaza: (s) => s.includes('sys.security_policies') })
    const m = await medirConexion(execute, CONEXION)
    // No lanza: la conexión respondió, solo una sub-consulta no.
    expect(m.objetos).toHaveLength(5)
    expect(m.errores.some((e) => e.startsWith('sys.security_policies:'))).toBe(true)
    // «No pude medir» ≠ «medí y no hay»: sin el barrido, TODA tabla queda indeterminada…
    for (const t of ['dbo.abierta', 'dbo.filtrada', 'dbo.sin_politica', 'dbo.huerfana']) expect(m.gobierno[t].clase).toBe('indeterminada')
    // …y por lo tanto no se le pide el conteo a ninguna. REFUTARÍA: un COUNT acá sería publicar el
    // tamaño de una tabla cuyo gobierno el nodo no pudo verificar.
    expect(sqls.filter((s) => s.includes('COUNT_BIG'))).toHaveLength(0)
  })

  it('con `sys.sql_modules` denegada: las políticas quedan indeterminadas, no abiertas', async () => {
    const { execute } = ejecutorFalso({ rechaza: (s) => s.includes('sys.sql_modules') })
    const m = await medirConexion(execute, CONEXION)
    expect(m.errores.some((e) => e.startsWith('sys.sql_modules:'))).toBe(true)
    expect(m.gobierno['dbo.abierta'].clase).toBe('indeterminada')
  })

  it('con el linaje denegado: el resto del catálogo sigue siendo válido', async () => {
    const { execute } = ejecutorFalso({ rechaza: (s) => s.includes('sys.sql_expression_dependencies') })
    const m = await medirConexion(execute, CONEXION)
    expect(m.linaje).toHaveLength(0)
    expect(m.objetos).toHaveLength(5)
  })
})
