// Prueba VIVA de la SEMÁNTICA T-SQL que el compilador Fabric da por supuesta — contra un motor real,
// local y gratis (SQL Server 2022 en Docker), usando el DDL que emite `compileFabric`, no uno escrito
// a mano: un arnés que inventa su propio SQL se mide a sí mismo, no al Producto.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// QUÉ MIDE Y QUÉ NO — leerlo antes de citar cualquier resultado de acá.
//
// Mide: SEMÁNTICA T-SQL. Data Masking (DDM), `UNMASK`, `SECURITY POLICY` con `ADD FILTER PREDICATE`,
// `WITH SCHEMABINDING`, `SESSION_CONTEXT` y la interacción entre ellos. Son features del motor SQL
// Server, y la superficie T-SQL de Fabric Warehouse es la misma familia.
//
// NO mide, y no puede: si el **SKU de Fabric** acepta cada DDL, qué permisos tiene el Service
// Principal de una instancia concreta, el costo de enforcement, ni nada del plano de control de
// Fabric. Eso sigue siendo trabajo del terreno propio (issue #186) y NO se responde acá.
//
// La distinción importa porque los dos resultados llevan a caminos distintos: «el motor rechaza esta
// forma» (lo dice este arnés, para toda la familia) vs «Fabric no la soporta en este SKU» (solo lo
// dice Fabric). Un negativo de acá REFUTA para ambos; un positivo de acá NO garantiza Fabric.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Uso:
//   docker run -d --platform linux/amd64 --name vergis-tsql-lab \
//     -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=Vergis!Lab2026' -e MSSQL_PID=Developer \
//     -p 11433:1433 mcr.microsoft.com/mssql/server:2022-latest
//   npx tsx scripts/tsql-lab-proof.ts
//
// No es parte de `npm test` (hermético, sin Docker). Es prueba de aceptación bajo demanda, como
// `live-rls-proof.ts` lo es para ClickHouse.

import sql from 'mssql'
import { compileFabric, sessionContextPrelude } from '../packages/policy/src/fabric'
import { emulateFabricMaskView } from '../packages/policy/src/fabric'
import { MASK_VALUE, type ClaimSet, type ColumnRule, type PolicyDecl } from '../packages/policy/src/ir'
import { settingsForInjections } from '../packages/policy/src/clickhouse'
import { verificarConectorConsola, unmaskProbeReadSQL, UNMASK_PROBE_EXPECTED } from '../server/engines/fabric'
import { createConsolaSql } from '../packages/capabilities/src/consola-sql'
import type { SqlConnectionProfile } from '../packages/capabilities/src/execute-sql-dwh'

const HOST = process.env['TSQL_HOST'] ?? 'localhost'
const PORT = Number(process.env['TSQL_PORT'] ?? 11433)
const SA_PASS = process.env['TSQL_SA_PASSWORD'] ?? 'Vergis!Lab2026'
const DB = 'vergis_lab'
// Contraseña de los principales del laboratorio. Terreno local y efímero; no hay secreto que proteger.
const USER_PASS = 'Lab!Principal2026'

// ── El terreno: la MISMA forma que las fixtures de `tests/policy.test.ts` ────────────────────
const REGLA_PII: ColumnRule = { column: 'rut', claim: 've_pii', action: 'mask' }
const POLICY: PolicyDecl = {
  predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
  combine: 'and',
  default: 'deny',
  columnRules: [REGLA_PII],
}
const TARGET = {
  schema: 'dbo',
  table: 'areas',
  tableColumns: ['area', 'rut', 'sueldo'],
  columnTypes: { area: 'NVARCHAR(50)', rut: 'NVARCHAR(20)', sueldo: 'DECIMAL(18,2)' },
}
const FILAS = [
  { area: 'Producción', rut: '11.111.111-1', sueldo: 900 },
  { area: 'Finanzas', rut: '22.222.222-2', sueldo: 1500 },
  { area: 'Comercial', rut: '33.333.333-3', sueldo: 1200 },
]

// ── Andamiaje de reporte ─────────────────────────────────────────────────────────────────────
let fallos = 0
let hallazgos = 0
function ok(cond: boolean, msg: string): boolean {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) fallos++
  return cond
}
/** Un HALLAZGO no es un fallo: es una respuesta que el terreno da y que había que registrar. */
function hallazgo(msg: string): void {
  hallazgos++
  console.log(`  ◆ ${msg}`)
}
function seccion(t: string): void {
  console.log(`\n${t}\n${'─'.repeat(t.length)}`)
}

const abiertos: sql.ConnectionPool[] = []
async function conectar(user: string, password: string, database?: string): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool({
    server: HOST,
    port: PORT,
    database: database ?? DB,
    user,
    password,
    options: { encrypt: false, trustServerCertificate: true },
    pool: { max: 1, min: 1, idleTimeoutMillis: 30000 }, // 1 conexión: SESSION_CONTEXT es por conexión
    connectionTimeout: 30000,
    requestTimeout: 60000,
  })
  abiertos.push(pool)
  return pool.connect()
}

/** Ejecuta y devuelve el error EXACTO en vez de lanzarlo — el texto del rechazo ES el dato (#164). */
async function intentar(pool: sql.ConnectionPool, batch: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await pool.request().batch(batch)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message.split('\n')[0] }
  }
}

/** Consulta con los claims del consumidor inyectados por `SESSION_CONTEXT`, en la MISMA conexión. */
/** Como `consultar`, pero con el SQL COMPLETO en vez de un objeto — para las sondas de esquive. */
async function consultarRaw(
  pool: sql.ConnectionPool,
  injections: { setting: string; claim: string }[],
  claims: ClaimSet,
  sqlText: string,
): Promise<Record<string, unknown>[]> {
  const p = sessionContextPrelude(injections, claims)
  const req = pool.request()
  for (const x of p.params) req.input(x.name, sql.NVarChar, x.value)
  const r = await req.query(`${p.sql}\n${sqlText}`)
  return r.recordset as unknown as Record<string, unknown>[]
}

async function consultar(
  pool: sql.ConnectionPool,
  injections: { setting: string; claim: string }[],
  claims: ClaimSet,
  query: string,
): Promise<Record<string, unknown>[]> {
  const prelude = sessionContextPrelude(injections, claims)
  const req = pool.request()
  for (const p of prelude.params) req.input(p.name, sql.NVarChar, p.value)
  const res = await req.query(`${prelude.sql}\n${query}`)
  return res.recordset as unknown as Record<string, unknown>[]
}

async function main(): Promise<void> {
  console.log(`\nPrueba VIVA de semántica T-SQL contra ${HOST}:${PORT} — NO es Fabric (ver cabecera)\n`)
  const enf = compileFabric(POLICY, TARGET)
  if (!enf.maskView) throw new Error('El compilador no emitió vista de máscara: la prueba no aplica.')

  // ── Bootstrap del terreno, desde cero e idempotente ────────────────────────────────────────
  const admin = await conectar('sa', SA_PASS, 'master')
  await admin.request().batch(`IF DB_ID(N'${DB}') IS NOT NULL BEGIN ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]; END`)
  await admin.request().batch(`CREATE DATABASE [${DB}]`)
  await admin.close()

  const sa = await conectar('sa', SA_PASS)
  await sa.request().batch(`
    CREATE TABLE dbo.areas (
      area NVARCHAR(50) NOT NULL,
      rut NVARCHAR(20) NOT NULL,
      sueldo DECIMAL(18,2) NOT NULL
    );`)
  for (const f of FILAS) {
    await sa.request()
      .input('a', sql.NVarChar, f.area).input('r', sql.NVarChar, f.rut).input('s', sql.Decimal(18, 2), f.sueldo)
      .query('INSERT INTO dbo.areas (area, rut, sueldo) VALUES (@a, @r, @s)')
  }
  // ── P2 (#163) · el plano de columna corregido, contra el motor ─────────────────────────────
  // Los tres defectos que este bloque cubre los devolvió ESTE arnés, no una lectura del manual:
  //   D1 · el guard `IF EXISTS … DROP MASKED` no guardaba (T-SQL compila el batch entero antes de
  //        ejecutarlo), así que TODA instalación nueva fallaba en su primera sentencia.
  //   D2 · un objeto SCHEMABINDING que referencia la columna bloquea `ADD` y `DROP MASKED`.
  //   D3 · el motor no dice cuál objeto, ni que la salida es el ORDEN.
  seccion('P2a (#163·D1) · instalación limpia sobre tabla LIBRE, y la MISMA otra vez (idempotencia)')
  for (const vuelta of ['1ª vuelta', '2ª vuelta (idempotencia)']) {
    const fallidas: { stmt: string; error: string }[] = []
    for (const stmt of enf.setupSQL) {
      const r = await intentar(sa, stmt)
      if (!r.ok) fallidas.push({ stmt: stmt.split('\n')[0], error: r.error })
    }
    for (const f of fallidas) hallazgo(`${vuelta} RECHAZADA: ${f.stmt}… → ${f.error}`)
    ok(fallidas.length === 0, `${vuelta}: las ${enf.setupSQL.length} sentencias del setup se aplican`)
  }
  const enmascaradasDe = async (tabla: string): Promise<string[]> =>
    (await sa.request().query(`SELECT name FROM sys.masked_columns WHERE object_id = OBJECT_ID(N'${tabla}') AND is_masked = 1`))
      .recordset.map((r) => String((r as Record<string, unknown>)['name']))
  ok((await enmascaradasDe('dbo.areas')).includes('rut'), `corroborado en sys.masked_columns: [${(await enmascaradasDe('dbo.areas')).join(', ')}]`)
  const pol0 = (await sa.request().query(`SELECT name, is_enabled FROM sys.security_policies`)).recordset as unknown as { name: string; is_enabled: boolean }[]
  ok(pol0.some((p) => p.is_enabled), `y el plano de FILA también: ${pol0.map((p) => `${p.name}(${p.is_enabled ? 'ON' : 'off'})`).join(', ')}`)

  // ── P2b · la tabla ATADA por una vista-contrato: tiene que fallar con NUESTRO diagnóstico ──
  seccion('P2b (#163·D2/D3) · sobre tabla con vista-contrato: ¿diagnostica, o repite el error opaco del motor?')
  await sa.request().batch(`CREATE TABLE dbo.atada (area NVARCHAR(50) NOT NULL, rut NVARCHAR(20) NOT NULL, sueldo DECIMAL(18,2) NOT NULL);`)
  await sa.request().batch(`CREATE VIEW dbo.vw_contrato_atada WITH SCHEMABINDING AS SELECT area, rut, sueldo FROM dbo.atada;`)
  const enfAtada = compileFabric(POLICY, { ...TARGET, table: 'atada' })
  const erroresAtada: string[] = []
  for (const stmt of enfAtada.setupSQL) {
    const r = await intentar(sa, stmt)
    if (!r.ok) erroresAtada.push(r.error)
  }
  const diagnostico = erroresAtada.find((e) => e.includes('vergis:'))
  ok(diagnostico !== undefined, `el fallo lo emite el preflight, no el motor: ${diagnostico ?? `(ninguno; errores: ${erroresAtada.join(' | ') || 'ninguno'})`}`)
  ok(diagnostico?.includes('[dbo].[vw_contrato_atada]') === true, 'el diagnóstico NOMBRA el objeto que ata la columna')
  ok(diagnostico?.includes('ORDEN') === true, 'y da la remediación medida, no un «revise su esquema»')
  // CONTROL · el plano de FILA de esa tabla sí quedó: el corte es del plano de columna y nada más.
  const polAtada = (await sa.request().query(`SELECT COUNT(*) AS n FROM sys.security_policies WHERE name = N'secpol_atada' AND is_enabled = 1`)).recordset[0] as Record<string, unknown>
  ok(Number(polAtada['n']) === 1, 'CONTROL · el plano de FILA de la tabla atada SÍ quedó instalado (el corte es solo el de columna)')
  ok((await enmascaradasDe('dbo.atada')).length === 0, 'CONTROL · y ninguna columna quedó enmascarada a medias')

  // ── P2c · la remediación que el mensaje promete, MEDIDA ────────────────────────────────────
  // Un mensaje de error que promete una salida sin que nadie la haya corrido es una conjetura con
  // cara de instrucción. Acá se corre: máscara primero, vista-contrato después.
  seccion('P2c · la remediación que el diagnóstico promete: ¿de verdad funciona el orden inverso?')
  await sa.request().batch(`CREATE TABLE dbo.ordenada (area NVARCHAR(50) NOT NULL, rut NVARCHAR(20) NOT NULL, sueldo DECIMAL(18,2) NOT NULL);`)
  const enfOrden = compileFabric(POLICY, { ...TARGET, table: 'ordenada' })
  const fallidasOrden: string[] = []
  for (const stmt of enfOrden.setupSQL) {
    const r = await intentar(sa, stmt)
    if (!r.ok) fallidasOrden.push(r.error)
  }
  ok(fallidasOrden.length === 0, `1) el plano completo entra sobre la tabla libre${fallidasOrden.length ? ` — ${fallidasOrden.join(' | ')}` : ''}`)
  const vistaDespues = await intentar(sa, `CREATE VIEW dbo.vw_contrato_ordenada WITH SCHEMABINDING AS SELECT area, rut, sueldo FROM dbo.ordenada;`)
  ok(vistaDespues.ok, `2) y la vista-contrato se crea DESPUÉS, sobre la columna ya enmascarada${vistaDespues.ok ? '' : ` — ${vistaDespues.error}`}`)
  ok((await enmascaradasDe('dbo.ordenada')).includes('rut'), 'CONTROL · la máscara sigue puesta con la vista-contrato encima')
  hallazgo('REMEDIACIÓN MEDIDA: no es incompatibilidad, es orden — máscara primero, vista-contrato después.')

  // ── Los dos sujetos: sin ellos no se distingue «discrimina» de «esconde para todos» ─────────
  // Los LOGIN son de SERVIDOR: sobreviven al DROP DATABASE, así que el bootstrap los tira primero
  // (sin esto el script solo corre una vez, y un arnés que no es idempotente no es un arnés).
  await sa.request().batch(`
    IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'srv_plain') DROP LOGIN srv_plain;
    IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'srv_unmask') DROP LOGIN srv_unmask;
    CREATE LOGIN srv_plain WITH PASSWORD = '${USER_PASS}', CHECK_POLICY = OFF;
    CREATE LOGIN srv_unmask WITH PASSWORD = '${USER_PASS}', CHECK_POLICY = OFF;`)
  await sa.request().batch(`
    CREATE USER srv_plain FOR LOGIN srv_plain;
    CREATE USER srv_unmask FOR LOGIN srv_unmask;
    GRANT SELECT ON dbo.areas TO srv_plain, srv_unmask;
    GRANT SELECT ON ${enf.maskView.qualifiedName} TO srv_plain, srv_unmask;
    GRANT UNMASK TO srv_unmask;`)

  const plain = await conectar('srv_plain', USER_PASS)
  const unmask = await conectar('srv_unmask', USER_PASS)
  const VISTA = `SELECT area, rut, sueldo FROM ${enf.maskView.qualifiedName} ORDER BY area`
  const TABLA = `SELECT area, rut, sueldo FROM dbo.areas ORDER BY area`
  // Multi-valor va como ARREGLO: el nodo rechaza la coma dentro de un valor a propósito (rompería
  // el encoding del setting), y pasarla como cadena mediría el arnés, no el Producto.
  const TODOS: ClaimSet = { groups: ['Producción', 'Finanzas', 'Comercial'] }
  const rutDe = (rows: Record<string, unknown>[]) => rows.map((r) => String(r['rut']))

  // ── P1 (#163·a) · ¿la rama «en claro» de la vista honra al sujeto sin UNMASK? ───────────────
  seccion('P1 (#163·a) · ¿el principal SIN `UNMASK` recibe el valor en la rama «en claro» de la vista?')
  const conClaim: ClaimSet = { ...TODOS, ve_pii: ['1'] }

  // CONTROL OBLIGATORIO, misma sesión: la TABLA sin vista. Sin él, un negativo en la vista no
  // distingue «no tiene el permiso» de «la vista no se aplicó».
  const ctrlPlainTabla = rutDe(await consultar(plain, enf.injections, conClaim, TABLA))
  const ctrlUnmaskTabla = rutDe(await consultar(unmask, enf.injections, conClaim, TABLA))
  ok(ctrlPlainTabla.every((v) => v !== '11.111.111-1'), `CONTROL · sin UNMASK, la TABLA sin vista ya devuelve enmascarado: [${ctrlPlainTabla.join(' ')}]`)
  ok(ctrlUnmaskTabla.includes('11.111.111-1'), `CONTROL · con UNMASK, la TABLA sin vista devuelve el valor: [${ctrlUnmaskTabla.join(' ')}]`)

  const plainConClaim = rutDe(await consultar(plain, enf.injections, conClaim, VISTA))
  const unmaskConClaim = rutDe(await consultar(unmask, enf.injections, conClaim, VISTA))
  const unmaskSinClaim = rutDe(await consultar(unmask, enf.injections, TODOS, VISTA))

  const sinUnmaskVeElValor = plainConClaim.includes('11.111.111-1')
  hallazgo(
    sinUnmaskVeElValor
      ? 'SIN UNMASK + claim presente → la vista SÍ devuelve el valor (la capacidad no depende de UNMASK)'
      : `SIN UNMASK + claim presente → la vista NO devuelve el valor: [${plainConClaim.join(' ')}] — la capacidad queda degradada a «esta columna no se sirve a nadie»`,
  )
  ok(unmaskConClaim.includes('11.111.111-1'), `CON UNMASK + claim presente → el sujeto ve el valor: [${unmaskConClaim.join(' ')}]`)
  ok(
    unmaskSinClaim.every((v) => v === MASK_VALUE),
    `CON UNMASK + claim AUSENTE → la vista enmascara igual (honra al sujeto, no al principal): [${unmaskSinClaim.join(' ')}]`,
  )
  // El control que vuelve concluyente al par de arriba: con UNMASK, la vista DISCRIMINA entre los dos
  // estados del claim. Sin esta aserción, «ve el valor» podría ser «la vista no hace nada».
  ok(
    unmaskConClaim.join() !== unmaskSinClaim.join(),
    'CONTROL · la vista DISCRIMINA por claim (con y sin claim dan distinto), no es un no-op',
  )

  // ── P1b (#238·E2) · ¿hay ALGUNA construcción que esquive el DDM sin `UNMASK`? ────────────────
  seccion('P1b (#238·E2) · ¿alguna construcción T-SQL obtiene el valor real SIN `UNMASK`?')
  // El diseño de #238 se apoya en que NO existe: por eso la capacidad de desenmascarar es
  // precondición y no una alternativa a rediseñar. Eso era RAZONAMIENTO —todo camino pasa por la
  // columna—, no medición. Acá se pone en riesgo: si alguna devuelve el valor, el diseño tiene una
  // alternativa que no se consideró **y** el DDM tiene un agujero reportable.
  const T = 'dbo.areas'
  const RUT_REAL = '11.111.111-1'
  const esquives: { nombre: string; sql: string }[] = [
    { nombre: 'proyección directa (línea base)', sql: `SELECT rut AS r FROM ${T}` },
    { nombre: 'cómputo intermedio (CONCAT)', sql: `SELECT CONCAT(rut, N'') AS r FROM ${T}` },
    { nombre: 'SUBSTRING sobre la columna', sql: `SELECT SUBSTRING(rut, 1, 20) AS r FROM ${T}` },
    { nombre: 'CROSS APPLY (VALUES (rut))', sql: `SELECT v.r FROM ${T} CROSS APPLY (VALUES (rut)) AS v(r)` },
    { nombre: 'CTE intermedia', sql: `WITH c AS (SELECT rut FROM ${T}) SELECT rut AS r FROM c` },
    { nombre: 'subconsulta derivada', sql: `SELECT r FROM (SELECT rut AS r FROM ${T}) AS d` },
    { nombre: 'agregación (MAX)', sql: `SELECT MAX(rut) AS r FROM ${T}` },
    { nombre: 'CASE que la re-proyecta', sql: `SELECT CASE WHEN 1 = 1 THEN rut ELSE N'' END AS r FROM ${T}` },
    { nombre: 'materialización en #temp y lectura', sql: `SELECT rut INTO #esq FROM ${T}; SELECT rut AS r FROM #esq; DROP TABLE #esq;` },
  ]
  // CONTROL POSITIVO del experimento: el MISMO sujeto, con UNMASK, sí ve el valor por la vía directa.
  // Sin él, N negativos podrían significar «el sujeto no ve NADA» en vez de «el DDM aguanta».
  const ctrlDirecto = (await consultarRaw(unmask, enf.injections, TODOS, `SELECT rut AS r FROM ${T}`)).map((r) => String(r['r']))
  ok(ctrlDirecto.includes(RUT_REAL), `CONTROL POSITIVO · el mismo sujeto CON UNMASK ve el valor real: [${ctrlDirecto.slice(0, 3).join(' ')}]`)

  let esquivoAlguno = false
  let medidas = 0
  for (const e of esquives) {
    let filas: Record<string, unknown>[] | null = null
    try {
      filas = await consultarRaw(plain, enf.injections, TODOS, e.sql)
    } catch (err) {
      // NO cuenta como «aguantó»: cuenta como NO MEDIDA. Una sonda que el motor rechaza no exonera
      // a nadie — es justo la confusión que la Norma 7 persigue en los instrumentos.
      hallazgo(`${e.nombre}: LA SONDA NO CORRIÓ (${(err as Error).message.split('\n')[0].slice(0, 70)}) — no mide`)
      continue
    }
    medidas++
    const vio = filas.some((r) => String(r['r'] ?? '').includes('-'))
    if (vio) esquivoAlguno = true
    ok(!vio, `${e.nombre}: ${vio ? `⚠ DEVUELVE EL VALOR REAL [${filas.map((r) => String(r['r'])).slice(0, 2).join(' ')}]` : 'enmascarada'}`)
  }
  // El resumen se calcula sobre las que DE VERDAD corrieron. La primera versión de este bloque
  // declaró «E2 corroborada en 8 construcciones» con las 8 rechazadas por un error de sintaxis mío:
  // cero mediciones y un veredicto positivo. Queda el contador a la vista para que no se repita.
  if (medidas === 0) {
    ok(false, 'E2 NO SE MIDIÓ: ninguna sonda corrió. Nada se concluye sobre el DDM.')
  } else if (esquivoAlguno) {
    hallazgo(`E2 REFUTADA (${medidas}/${esquives.length} sondas corridas): existe una construcción que esquiva el DDM sin UNMASK — el diseño de #238 tiene alternativa Y el DDM tiene un agujero`)
  } else {
    hallazgo(`E2 CORROBORADA en ${medidas}/${esquives.length} sondas corridas: ninguna obtiene el valor sin UNMASK. Corrobora, NO demuestra: es una lista, no una prueba de imposibilidad`)
  }

  // ── P3 (#164) · las tres formas del FILTER PREDICATE, con su control positivo ───────────────
  seccion('P3 (#164) · ¿acepta el motor un FILTER PREDICATE cuya función no recibe columna?')
  await sa.request().batch(`
    CREATE TABLE dbo.publica (id INT NOT NULL, nombre NVARCHAR(50) NOT NULL);
    INSERT INTO dbo.publica (id, nombre) VALUES (1, N'uno'), (2, N'dos');`)

  // (a) CONTROL POSITIVO — la forma ACTUAL (función con columna), en el mismo terreno y la misma
  //     sesión. Sin esto, un rechazo de (b) no distingue «esta forma no se acepta» de «acá nada anda».
  const formaActual = await intentar(sa, `
    CREATE FUNCTION dbo.fn_pol_actual(@id INT) RETURNS TABLE WITH SCHEMABINDING
      AS RETURN SELECT 1 AS vergis_allowed;`)
  const polActual = formaActual.ok
    ? await intentar(sa, `CREATE SECURITY POLICY dbo.secpol_actual ADD FILTER PREDICATE dbo.fn_pol_actual(id) ON dbo.publica WITH (STATE = ON);`)
    : { ok: false as const, error: '(no se intentó: la función no se creó)' }
  ok(polActual.ok, `CONTROL POSITIVO · la forma actual (función CON columna) se acepta${polActual.ok ? '' : ` — ${polActual.error}`}`)
  await intentar(sa, `DROP SECURITY POLICY IF EXISTS dbo.secpol_actual; DROP FUNCTION IF EXISTS dbo.fn_pol_actual;`)

  // (b) función SIN NINGÚN parámetro — lo que #164 quiere para no tomar rehén a una columna.
  const fnSinParam = await intentar(sa, `
    CREATE FUNCTION dbo.fn_pol_sinparam() RETURNS TABLE WITH SCHEMABINDING
      AS RETURN SELECT 1 AS vergis_allowed;`)
  hallazgo(`(b) CREATE FUNCTION sin parámetro: ${fnSinParam.ok ? 'ACEPTADO' : `RECHAZADO — ${fnSinParam.error}`}`)
  if (fnSinParam.ok) {
    const polSinParam = await intentar(sa, `CREATE SECURITY POLICY dbo.secpol_sinparam ADD FILTER PREDICATE dbo.fn_pol_sinparam() ON dbo.publica WITH (STATE = ON);`)
    hallazgo(`(b) ADD FILTER PREDICATE sin argumento: ${polSinParam.ok ? 'ACEPTADO — la columna deja de ser rehén' : `RECHAZADO — ${polSinParam.error}`}`)
    if (polSinParam.ok) {
      const filas = (await sa.request().query('SELECT id FROM dbo.publica')).recordset.length
      ok(filas === 2, `(b) con la policy sin columna instalada, la tabla sigue sirviendo sus 2 filas (allow-all real, no deny silencioso): ${filas}`)
    }
    await intentar(sa, `DROP SECURITY POLICY IF EXISTS dbo.secpol_sinparam; DROP FUNCTION IF EXISTS dbo.fn_pol_sinparam;`)
  }

  // (c) parámetro alimentado por CONSTANTE — la variante de respaldo que el issue nombra.
  const fnConst = await intentar(sa, `
    CREATE FUNCTION dbo.fn_pol_const(@x INT) RETURNS TABLE WITH SCHEMABINDING
      AS RETURN SELECT 1 AS vergis_allowed;`)
  if (fnConst.ok) {
    const polConst = await intentar(sa, `CREATE SECURITY POLICY dbo.secpol_const ADD FILTER PREDICATE dbo.fn_pol_const(1) ON dbo.publica WITH (STATE = ON);`)
    hallazgo(`(c) ADD FILTER PREDICATE con argumento CONSTANTE: ${polConst.ok ? 'ACEPTADO' : `RECHAZADO — ${polConst.error}`}`)
    await intentar(sa, `DROP SECURITY POLICY IF EXISTS dbo.secpol_const; DROP FUNCTION IF EXISTS dbo.fn_pol_const;`)
  }

  // ── P3b · el allow-all que EMITE el compilador tras el rediseño de #164 ─────────────────────
  //
  // P3 midió la forma a mano. Esto mide LO QUE SALE DE `compileFabric`, que es lo único que autoriza
  // a cerrar #164: entre una y otra puede haber diferencias que nadie eligió (nombres, tipos, orden
  // de sentencias), y ese hueco es exactamente el que produjo #197 en el plano de columna.
  seccion('P3b (#164) · el allow-all EMITIDO por el compilador, aplicado tal cual sale')
  await intentar(sa, `DROP SECURITY POLICY IF EXISTS dbo.secpol_publica; DROP FUNCTION IF EXISTS dbo.fn_pol_publica;`)
  await intentar(sa, `DROP TABLE IF EXISTS dbo.publica_emit;
    CREATE TABLE dbo.publica_emit (id INT NOT NULL, nombre NVARCHAR(50) NOT NULL);
    INSERT INTO dbo.publica_emit (id, nombre) VALUES (1, N'uno'), (2, N'dos');`)
  const enfPub = compileFabric({ public: true }, { schema: 'dbo', table: 'publica_emit' })
  let pubOk = true
  for (const [i, stmt] of enfPub.setupSQL.entries()) {
    const r = await intentar(sa, stmt)
    if (!ok(r.ok, `[${i + 1}/${enfPub.setupSQL.length}] ${stmt.split('\n')[0].slice(0, 72)}${r.ok ? '' : ` — ${r.error}`}`)) pubOk = false
  }
  if (pubOk) {
    // No es deny mudo: la tabla sigue sirviendo sus filas con la policy instalada.
    const filas = (await sa.request().query('SELECT id FROM dbo.publica_emit')).recordset.length
    ok(filas === 2, `con el allow-all EMITIDO instalado la tabla sigue sirviendo sus 2 filas: ${filas}`)
    // EL CONTROL QUE DECIDE #164: la columna deja de ser rehén. Con la policy vieja este ALTER se
    // rechazaba por la dependencia de SCHEMABINDING; si ahora pasa, el rehén se soltó de verdad.
    const alter = await intentar(sa, `ALTER TABLE dbo.publica_emit ALTER COLUMN nombre NVARCHAR(80) NOT NULL;`)
    ok(alter.ok, `ALTER sobre una columna de negocio con la policy INSTALADA: ${alter.ok ? 'ACEPTADO — la columna NO es rehén' : `rechazado — ${alter.error}`}`)
    // Y el compilador lo declara: ninguna dependencia de esquema aportada por el allow-all.
    ok(enfPub.schemaDependencies.length === 0, `schemaDependencies del allow-all: ${JSON.stringify(enfPub.schemaDependencies)} (vacío = nada atado)`)
  }
  await intentar(sa, `DROP SECURITY POLICY IF EXISTS dbo.secpol_publica_emit; DROP FUNCTION IF EXISTS dbo.fn_pol_publica_emit; DROP TABLE IF EXISTS dbo.publica_emit;`)

  // ── P4 · El DIFERENCIAL: el emulador que sostiene la suite vs el motor ──────────────────────
  seccion('P4 · diferencial emulador ↔ motor (el emulador sostiene 2000+ tests; nadie lo había contrastado con un motor)')
  const CASOS: { nombre: string; claims: ClaimSet }[] = [
    { nombre: 'un área + PII', claims: { groups: ['Finanzas'], ve_pii: ['1'] } },
    { nombre: 'un área, sin PII', claims: { groups: ['Finanzas'] } },
    { nombre: 'multi-área + PII', claims: { groups: ['Producción', 'Comercial'], ve_pii: ['1'] } },
    { nombre: 'sin claims (default-deny)', claims: {} },
    { nombre: 'área inexistente', claims: { groups: ['Marte'], ve_pii: ['1'] } },
  ]
  for (const c of CASOS) {
    // El emulador se consulta con los MISMOS claims; el motor, con el principal que SÍ tiene UNMASK
    // (si no, la brecha del DDM se mezclaría con la de la vista y el diferencial no diría nada).
    const esperado = emulateFabricMaskView(enf, settingsForInjections(enf.injections, c.claims), FILAS as unknown as Record<string, unknown>[])
    const real = await consultar(unmask, enf.injections, c.claims, VISTA)
    const norm = (rows: Record<string, unknown>[]) =>
      rows.map((r) => `${r['area']}|${r['rut']}`).sort().join(' · ')
    ok(norm(esperado) === norm(real), `${c.nombre} → emulador y motor coinciden  [${norm(real) || '(vacío)'}]`)
  }

  // ══ C · CONSOLA SQL (#306) ═══════════════════════════════════════════════════════════════════
  //
  // La Consola ejecuta T-SQL LIBRE bajo un principal de solo lectura, con los claims del ingeniero
  // en `SESSION_CONTEXT`. Este bloque mide, en el motor, las tres cosas de las que depende que eso
  // «acote y nunca amplíe»: que el predicado no filtre lo que la máscara esconde (C3), que el
  // principal no pueda escribir (C1) y que `@read_only` clave el claim dentro del batch (C2).

  // ── C3 · INFERENCIA POR PREDICADO bajo DDM ───────────────────────────────────────────────────
  //
  // El DDM enmascara la PROYECCIÓN. La pregunta que decide si un Conector con `columnRules` es
  // ofrecible es otra: ¿el motor evalúa el `WHERE` contra el valor REAL o contra la máscara? Si es
  // contra el real, un `WHERE rut LIKE '33.%'` acota el valor sin mostrarlo nunca — y la promesa
  // «ves lo que un PI te mostraría» es falsa, porque el PI no deja escribir el `WHERE`.
  //
  // Los tres controles que lo vuelven una medición y no una impresión:
  //   PREMISA  · bajo este mismo principal y en esta misma sesión, la proyección sale enmascarada
  //              (si saliera en claro no habría nada que inferir y el resultado no diría nada).
  //   POSITIVO · las mismas sondas bajo el principal CON `UNMASK` discriminan (si no, el
  //              instrumento no mide: un cero podría ser «no filtró» o «la sonda no corrió»).
  //   NEGATIVO · un predicado que NINGUNA fila satisface devuelve 0 bajo ambos (si diera > 0, el
  //              contador estaría midiendo otra cosa).
  seccion('C3 (#306) · ¿se INFIERE el valor de una columna enmascarada con predicados, sin verlo nunca?')
  const RUT_C3 = '33.333.333-3' // el de Comercial
  const unoDe = async (pool: sql.ConnectionPool, sqlText: string): Promise<number | null> => {
    try {
      const filas = await consultarRaw(pool, enf.injections, TODOS, sqlText)
      return Number((filas[0] as Record<string, unknown>)['n'])
    } catch (err) {
      // NO cuenta como «aguantó»: cuenta como NO MEDIDA (Norma 7, corolario de instrumentos).
      hallazgo(`sonda RECHAZADA por el motor (${(err as Error).message.split('\n')[0].slice(0, 70)}) — no mide`)
      return null
    }
  }

  const premisaC3 = (await consultarRaw(plain, enf.injections, TODOS, `SELECT rut AS r FROM ${T}`)).map((r) => String(r['r']))
  // El valor de la máscara acá es el DEFAULT del DDM del motor (`xxxx` para NVARCHAR), NO el
  // `MASK_VALUE` del compilador (`•••`), que es de la vista de máscara: la sonda lee la TABLA BASE.
  // Por eso la premisa se afirma por lo que importa —que el RUT real no aparece— y no por la cadena.
  ok(
    premisaC3.length === 3 && premisaC3.every((v) => !v.includes('-')),
    `CONTROL DE PREMISA · sin UNMASK la PROYECCIÓN sale enmascarada: [${premisaC3.join(' ')}]`,
  )

  const SONDAS_C3: { nombre: string; sql: string; esperadoSiFiltraPorElReal: number }[] = [
    { nombre: 'igualdad exacta contra el valor real', sql: `SELECT COUNT(*) AS n FROM ${T} WHERE rut = N'${RUT_C3}'`, esperadoSiFiltraPorElReal: 1 },
    { nombre: "prefijo con LIKE ('33.%')", sql: `SELECT COUNT(*) AS n FROM ${T} WHERE rut LIKE N'33.%'`, esperadoSiFiltraPorElReal: 1 },
    { nombre: 'rango con BETWEEN (acota por bisección)', sql: `SELECT COUNT(*) AS n FROM ${T} WHERE rut BETWEEN N'20' AND N'30'`, esperadoSiFiltraPorElReal: 1 },
    { nombre: 'comparación de orden (>)', sql: `SELECT COUNT(*) AS n FROM ${T} WHERE rut > N'30'`, esperadoSiFiltraPorElReal: 1 },
    { nombre: 'subcadena en el predicado', sql: `SELECT COUNT(*) AS n FROM ${T} WHERE SUBSTRING(rut, 1, 2) = N'22'`, esperadoSiFiltraPorElReal: 1 },
  ]

  let infiereAlguna = false
  let medidasC3 = 0
  for (const s of SONDAS_C3) {
    const sinUnmask = await unoDe(plain, s.sql)
    const conUnmask = await unoDe(unmask, s.sql)
    if (sinUnmask === null || conUnmask === null) continue
    // CONTROL POSITIVO por sonda: si CON UNMASK tampoco da lo esperado, esta sonda no mide nada.
    if (conUnmask !== s.esperadoSiFiltraPorElReal) {
      hallazgo(`${s.nombre}: CONTROL POSITIVO FALLÓ (con UNMASK devolvió ${conUnmask}, se esperaba ${s.esperadoSiFiltraPorElReal}) — la sonda NO mide`)
      continue
    }
    medidasC3++
    const infiere = sinUnmask === s.esperadoSiFiltraPorElReal
    if (infiere) infiereAlguna = true
    console.log(`  ${infiere ? '◆' : '✓'} ${s.nombre}: sin UNMASK → ${sinUnmask} · con UNMASK → ${conUnmask} ${infiere ? '⚠ EL PREDICADO FILTRA POR EL VALOR REAL' : '(el predicado NO ve el valor real)'}`)
    if (infiere) hallazgos++
  }

  // CONTROL NEGATIVO del contador: un predicado que no satisface NINGUNA fila.
  const vacioSin = await unoDe(plain, `SELECT COUNT(*) AS n FROM ${T} WHERE rut LIKE N'99.%'`)
  const vacioCon = await unoDe(unmask, `SELECT COUNT(*) AS n FROM ${T} WHERE rut LIKE N'99.%'`)
  ok(vacioSin === 0 && vacioCon === 0, `CONTROL NEGATIVO · un prefijo que ninguna fila satisface da 0 bajo ambos principales (sin=${vacioSin} · con=${vacioCon})`)

  // ORDER BY: ordena por el valor real o por la máscara (todas iguales ⇒ orden de inserción).
  try {
    const ordenSin = (await consultarRaw(plain, enf.injections, TODOS, `SELECT area AS r FROM ${T} ORDER BY rut DESC`)).map((r) => String(r['r']))
    const ordenCon = (await consultarRaw(unmask, enf.injections, TODOS, `SELECT area AS r FROM ${T} ORDER BY rut DESC`)).map((r) => String(r['r']))
    const ordenaPorElReal = ordenSin.join('|') === ordenCon.join('|') && ordenCon[0] === 'Comercial'
    console.log(`  ${ordenaPorElReal ? '◆' : '✓'} ORDER BY sobre la columna enmascarada: sin UNMASK [${ordenSin.join(' ')}] · con UNMASK [${ordenCon.join(' ')}]${ordenaPorElReal ? ' ⚠ MISMO ORDEN: ordena por el valor real' : ''}`)
    if (ordenaPorElReal) { infiereAlguna = true; hallazgos++ }
    medidasC3++
  } catch (err) {
    hallazgo(`ORDER BY: LA SONDA NO CORRIÓ (${(err as Error).message.split('\n')[0].slice(0, 70)}) — no mide`)
  }

  if (medidasC3 === 0) {
    ok(false, 'C3 NO SE MIDIÓ: ninguna sonda con su control positivo corrió. Nada se concluye sobre DDM y predicados.')
  } else if (infiereAlguna) {
    hallazgo(
      `C3 REFUTADA (${medidasC3} sonda(s) con control positivo): bajo SQL libre el predicado se evalúa contra el valor REAL, ` +
        'así que una columna enmascarada se infiere sin verse. ⇒ un Conector con `columnRules` NO se ofrece en la Consola (P-7, fail-closed).',
    )
  } else {
    hallazgo(`C3 CORROBORADA en ${medidasC3} sonda(s): ningún predicado filtró por el valor real. Corrobora, NO demuestra (es una lista, no una prueba de imposibilidad)`)
  }

  // ── El terreno de la Consola: una tabla SIN política y los dos principales del gate ───────────
  seccion('C · terreno de la Consola (#306): tabla sin política + principal lector + principal escritor')
  await sa.request().batch(`
    DROP TABLE IF EXISTS dbo.zz_sin_politica;
    CREATE TABLE dbo.zz_sin_politica (id INT NOT NULL, dato NVARCHAR(40) NOT NULL);
    INSERT INTO dbo.zz_sin_politica (id, dato) VALUES (1, N'uno'), (2, N'dos');`)
  await sa.request().batch(`
    DROP TABLE IF EXISTS dbo.diez;
    CREATE TABLE dbo.diez (n INT NOT NULL);
    INSERT INTO dbo.diez (n) VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10);`)
  await sa.request().batch(`
    IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'consola_lab') DROP LOGIN consola_lab;
    IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'consola_lab_escritor') DROP LOGIN consola_lab_escritor;
    CREATE LOGIN consola_lab WITH PASSWORD = '${USER_PASS}', CHECK_POLICY = OFF;
    CREATE LOGIN consola_lab_escritor WITH PASSWORD = '${USER_PASS}', CHECK_POLICY = OFF;`)
  // El principal de consola: SELECT en la base y NADA más. Sin `UNMASK`, sin escritura.
  await sa.request().batch(`
    CREATE USER consola_lab FOR LOGIN consola_lab;
    CREATE USER consola_lab_escritor FOR LOGIN consola_lab_escritor;
    GRANT SELECT TO consola_lab;
    GRANT VIEW DEFINITION TO consola_lab;
    GRANT SELECT TO consola_lab_escritor;
    ALTER ROLE db_datawriter ADD MEMBER consola_lab_escritor;`)
  const consolaPool = await conectar('consola_lab', USER_PASS)
  const escritorPool = await conectar('consola_lab_escritor', USER_PASS)

  // ── C1 · ¿el principal de consola puede escribir? ─────────────────────────────────────────────
  // La garantía de «solo lectura» del diseño NO vive en un parser: vive en el permiso del principal.
  // Acá se pone en riesgo esa afirmación con las cuatro escrituras que importan.
  seccion('C1 (#306) · bajo el principal de consola, ¿las escrituras fallan POR PERMISO?')
  const ESCRITURAS: { nombre: string; sql: string }[] = [
    { nombre: 'INSERT', sql: `INSERT INTO dbo.areas (area, rut, sueldo) VALUES (N'X', N'9', 1)` },
    { nombre: 'CREATE TABLE', sql: `CREATE TABLE dbo.zz_intruso (id INT NOT NULL)` },
    { nombre: 'ALTER SECURITY POLICY … STATE = OFF', sql: `ALTER SECURITY POLICY dbo.secpol_areas WITH (STATE = OFF)` },
    { nombre: 'DROP TABLE', sql: `DROP TABLE dbo.zz_sin_politica` },
  ]
  for (const e of ESCRITURAS) {
    const r = await intentar(consolaPool, e.sql)
    // El TEXTO del rechazo es el dato: «permission was denied» es permiso; un error de sintaxis
    // sería una sonda mal escrita que exonera al motor sin haber medido nada.
    const porPermiso = !r.ok && /permission|denied|principal|no tiene permiso/i.test(r.error)
    ok(porPermiso, `${e.nombre}: ${r.ok ? '⚠ ¡PASÓ! el principal PUEDE escribir' : `rechazado — ${r.error.slice(0, 90)}`}`)
  }
  // CONTROL POSITIVO: el escritor SÍ escribe en el mismo terreno. Sin él, cuatro rechazos podrían
  // significar «acá no anda nada» en vez de «a este principal le falta el permiso».
  const ctrlEscritor = await intentar(escritorPool, `INSERT INTO dbo.zz_sin_politica (id, dato) VALUES (99, N'control')`)
  ok(ctrlEscritor.ok, `CONTROL POSITIVO · el principal ESCRITOR sí inserta en el mismo terreno${ctrlEscritor.ok ? '' : ` — ${ctrlEscritor.error}`}`)

  // ── C2 · ¿`@read_only` clava el claim DENTRO del batch? ───────────────────────────────────────
  // Es el mecanismo del que cuelga todo el plano de fila de la Consola. Acá se mide para la FAMILIA
  // T-SQL: un negativo refutaría para Fabric también; un positivo NO lo afirma para Fabric — eso lo
  // dice `fab:proof` y solo él, y sin ese verde la Fase 1 no se mergea.
  seccion('C2 (#306) · con `@read_only = 1`, ¿un re-set del claim en el MISMO batch falla?')
  const preludeRO = sessionContextPrelude(enf.injections, { groups: ['Finanzas'] }, { readOnly: true })
  const conParams = (pool: sql.ConnectionPool) => {
    const req = pool.request()
    for (const p of preludeRO.params) req.input(p.name, sql.NVarChar, p.value)
    return req
  }
  // CONTROL POSITIVO: el MISMO batch SIN el re-set devuelve solo Finanzas.
  // OJO (medido acá): una clave marcada `read_only` queda clavada por toda la SESIÓN, así que el
  // control NO puede correr sobre `consolaPool` — lo dejaría inservible para C6 y C7 con un error
  // que parecería un fallo del gate. Sesión propia y descartable, igual que hace el gate real.
  const ctrlPool = await conectar('consola_lab', USER_PASS)
  let ctrlC2: Record<string, unknown>[] | null = null
  try {
    ctrlC2 = (await conParams(ctrlPool).query(`${preludeRO.sql}\nSELECT area FROM dbo.areas`)).recordset as unknown as Record<string, unknown>[]
  } catch (e) {
    hallazgo(`C2 CONTROL POSITIVO NO CORRIÓ (${(e as Error).message.split('\n')[0].slice(0, 70)}) — C2 no mide`)
  }
  if (ctrlC2) {
    ok(
      ctrlC2.length === 1 && String(ctrlC2[0]!['area']) === 'Finanzas',
      `CONTROL POSITIVO · con read_only y sin ataque, la RLS devuelve solo lo del claim: [${ctrlC2.map((r) => String(r['area'])).join(' ')}]`,
    )
    // EL ATAQUE: re-setear la clave REAL en el MISMO batch que el SELECT. Sesión nueva, porque la
    // clave del control ya quedó clavada en la anterior.
    const atacante = await conectar('consola_lab', USER_PASS)
    const reqA = atacante.request()
    for (const p of preludeRO.params) reqA.input(p.name, sql.NVarChar, p.value)
    reqA.input('vergis_atacante', sql.NVarChar, 'Producción')
    let filasAtaque: Record<string, unknown>[] | null = null
    let errorAtaque = ''
    try {
      filasAtaque = (await reqA.query(
        `${preludeRO.sql}\nEXEC sys.sp_set_session_context @key = N'${enf.injections[0]!.setting}', @value = @vergis_atacante;\nSELECT area FROM dbo.areas`,
      )).recordset as unknown as Record<string, unknown>[]
    } catch (e) {
      errorAtaque = (e as Error).message.split('\n')[0]
    }
    const gano = filasAtaque !== null && filasAtaque.some((r) => String(r['area']) === 'Producción')
    ok(!gano, `el batch con re-set ${gano ? `⚠ DEVOLVIÓ FILAS AJENAS [${filasAtaque!.map((r) => String(r['area'])).join(' ')}]` : `falla y no devuelve filas — ${errorAtaque.slice(0, 90)}`}`)
    ok(/15664|read_only|read only/i.test(errorAtaque), `y falla por LA razón (read_only, error 15664), no por otra: ${errorAtaque.slice(0, 90) || '(no falló)'}`)
    await atacante.close()
    await ctrlPool.close()
    hallazgo('C2 mide la FAMILIA T-SQL. Que Fabric honre `@read_only` sigue SIN medir: es `fab:proof`, y sin ese verde la Fase 1 no se mergea.')
  }

  // ── C4/C5/C6 · el GATE de ofrecibilidad, contra el motor ──────────────────────────────────────
  seccion('C4/C5/C6 (#306) · el gate de ofrecibilidad por Conector, medido contra el motor')
  const ejecutarCon = (pool: sql.ConnectionPool) => async (q: string): Promise<Record<string, unknown>[]> =>
    (await pool.request().query(q)).recordset as unknown as Record<string, unknown>[]
  const sondaSiempre = async (): Promise<'honra' | 'no-honra' | 'indeterminado'> => 'honra'
  const storeLab = new Map<string, PolicyDecl>([['dbo.areas', POLICY]])
  const storeSoloFila = new Map<string, PolicyDecl>([['dbo.areas', { ...POLICY, columnRules: undefined } as PolicyDecl]])

  // C4 · con `dbo.zz_sin_politica` presente, el Conector NO se ofrece y el motivo la nombra.
  const c4 = await verificarConectorConsola({ ejecutar: ejecutarCon(consolaPool), sondaReadOnly: sondaSiempre, store: storeSoloFila, tablasDelRef: ['dbo.areas'], ref: 'lab' })
  ok(!c4.ofrecible && (c4.motivo ?? '').includes('zz_sin_politica'), `C4 · tabla sin política ⇒ no ofrecible, y el motivo la nombra: ${c4.motivo?.slice(0, 110)}`)
  // …y el centinela de #238, que TAMPOCO tiene política, no cuenta: es instrumento, no dato.
  ok(!(c4.medido.tablasSinPolitica ?? []).some((t) => t.includes('vergis_unmask_probe')), 'C4 · el centinela de #238 NO se cuenta como tabla sin gobierno (es instrumento)')

  // Remediación: artefacto allow-all sobre TODAS las huérfanas que el gate nombró (el terreno del
  // arnés acumula tablas auxiliares de las secciones anteriores; el gate las ve igual, que es
  // justamente lo que tiene que hacer). Se aplica lo que EMITE el compilador, no SQL a mano.
  for (const t of c4.medido.tablasSinPolitica ?? []) {
    const enfAllow = compileFabric({ public: true }, { schema: t.split('.')[0], table: t.split('.')[1] })
    for (const stmt of enfAllow.setupSQL) await intentar(sa, stmt)
  }
  const c4b = await verificarConectorConsola({ ejecutar: ejecutarCon(consolaPool), sondaReadOnly: sondaSiempre, store: storeSoloFila, tablasDelRef: ['dbo.areas'], ref: 'lab' })
  ok(c4b.ofrecible, `C4 · tras aplicar allow-all a la tabla huérfana ⇒ ofrecible${c4b.ofrecible ? '' : ` — ${c4b.motivo}`}`)

  // C5 · el principal ESCRITOR nunca es ofrecible, y el motivo nombra el permiso ofensor.
  const c5 = await verificarConectorConsola({ ejecutar: ejecutarCon(escritorPool), sondaReadOnly: sondaSiempre, store: storeSoloFila, tablasDelRef: ['dbo.areas'], ref: 'lab' })
  ok(!c5.ofrecible && /INSERT|UPDATE|DELETE/.test(c5.motivo ?? ''), `C5 · principal escritor ⇒ no ofrecible, con el permiso nombrado: ${c5.motivo?.slice(0, 110)}`)

  // C6 · el plano de columna bajo el principal de consola: base y vista, ambas enmascaradas.
  const baseC6 = (await consultarRaw(consolaPool, enf.injections, { ...TODOS, ve_pii: ['1'] }, `SELECT rut AS r FROM dbo.areas`)).map((r) => String(r['r']))
  const vistaC6 = (await consultarRaw(consolaPool, enf.injections, { ...TODOS, ve_pii: ['1'] }, `SELECT rut AS r FROM ${enf.maskView.qualifiedName}`)).map((r) => String(r['r']))
  ok(baseC6.every((v) => !v.includes('-')), `C6 · TABLA BASE bajo el principal de consola: enmascarada [${baseC6.join(' ')}]`)
  ok(vistaC6.every((v) => !v.includes('-')), `C6 · VISTA DE MÁSCARA bajo el principal de consola: enmascarada [${vistaC6.join(' ')}] (el claim NO la abre: la vista solo discrimina con UNMASK)`)
  const c6Antes = await verificarConectorConsola({ ejecutar: ejecutarCon(consolaPool), sondaReadOnly: sondaSiempre, store: storeLab, tablasDelRef: ['dbo.areas'], ref: 'lab' })
  ok(c6Antes.medido.unmask === 'incapable', `C6 · (c) medido: el principal de consola es \`${c6Antes.medido.unmask}\` de desenmascarar`)
  ok(!c6Antes.ofrecible && (c6Antes.motivo ?? '').includes('P-7'), 'C6 · y AUN ASÍ no se ofrece: con reglas de columna manda P-7 (inferencia por predicado, C3), no (c)')
  // CONTROL de (c): con `UNMASK` concedido, ¿algo lo delata? Se mide en DOS niveles, y el primero
  // fue un HALLAZGO de esta corrida: `UNMASK` es un permiso de base, así que `fn_my_permissions` lo
  // devuelve y (a) apaga el Conector ANTES de que (c) llegue a medirse. Es defensa en profundidad
  // que el diseño no había previsto — y, como (c) ya no corre, el control de que el CENTINELA
  // discrimina hay que hacerlo directo contra el instrumento, o no se habría medido nada.
  await sa.request().batch(`GRANT UNMASK TO consola_lab;`)
  const c6Despues = await verificarConectorConsola({ ejecutar: ejecutarCon(consolaPool), sondaReadOnly: sondaSiempre, store: storeLab, tablasDelRef: ['dbo.areas'], ref: 'lab' })
  ok(!c6Despues.ofrecible && (c6Despues.motivo ?? '').includes('UNMASK'), `CONTROL · con UNMASK concedido, (a) ya lo apaga: ${c6Despues.motivo?.slice(0, 100)}`)
  const centinela = (await ejecutarCon(consolaPool)(unmaskProbeReadSQL('dbo'))).map((r) => String(r['probe']))
  ok(centinela[0] === UNMASK_PROBE_EXPECTED, `CONTROL · y el CENTINELA discrimina: con UNMASK lee '${centinela[0]}' donde sin UNMASK leía enmascarado (no es un no-op)`)
  await sa.request().batch(`REVOKE UNMASK FROM consola_lab;`)

  // ── C7/C8/C9/C10 · la capability I2 contra el motor ───────────────────────────────────────────
  // El seam `connect` inyecta el pool LOCAL: lo que se mide es la lógica de streaming, corte,
  // timeout y cierre contra un motor de verdad, sin AAD de por medio.
  seccion('C7/C8/C9/C10 (#306) · la ejecución (streaming, corte, timeout, multi-recordset, costo)')
  const perfilLab: Record<string, SqlConnectionProfile> = {
    lab: {
      server: HOST, database: DB, port: PORT,
      auth: 'secret', tenantId: 't', clientId: 'sp-serving', clientSecret: 'x',
      consola: { auth: 'secret', tenantId: 't', clientId: 'sp-consola', clientSecret: 'x' },
    },
  }
  const conectarLocal = async (): Promise<sql.ConnectionPool> =>
    new sql.ConnectionPool({
      server: HOST, port: PORT, database: DB, user: 'consola_lab', password: USER_PASS,
      options: { encrypt: false, trustServerCertificate: true },
      pool: { max: 1, min: 0 }, connectionTimeout: 30000, requestTimeout: 60000,
    }).connect()
  const capDe = (maxRows: number, timeoutMs: number) =>
    createConsolaSql(perfilLab, { injections: enf.injections, maxRows, timeoutMs, connect: async () => (await conectarLocal()) as never })
  const identLab = { agent: 'vergis', user: 'ing@lab', claims: TODOS }

  // C7 · tope por streaming con cancelación efectiva.
  try {
    const r7 = await capDe(3, 20000).execute({ ref: 'lab', sql: 'SELECT n FROM dbo.diez ORDER BY n' }, identLab)
    ok(r7.filas === 3 && r7.truncado, `C7 · tope de 3 sobre 10 filas: ${r7.filas} fila(s), truncado=${r7.truncado}`)
    const vivas = (await sa.request().query(`SELECT COUNT(*) AS n FROM sys.dm_exec_sessions WHERE login_name = N'consola_lab' AND status = 'running'`)).recordset[0] as Record<string, unknown>
    hallazgo(`C7 · sesiones de consola en estado 'running' tras el corte: ${Number(vivas['n'])} (la cancelación liberó la conexión)`)
  } catch (e) {
    ok(false, `C7 NO MIDIÓ: ${(e as Error).message.split('\n')[0]}`)
  }

  // C8 · timeout con cancelación efectiva.
  const t8 = Date.now()
  try {
    await capDe(100, 2000).execute({ ref: 'lab', sql: "WAITFOR DELAY '00:00:10'; SELECT 1 AS uno" }, identLab)
    ok(false, 'C8 · ⚠ la consulta de 10 s NO fue cortada por el tope de 2 s')
  } catch (e) {
    const ms = Date.now() - t8
    const motivo = (e as { motivo?: string }).motivo
    ok(motivo === 'consola/timeout' && ms < 6000, `C8 · cortada a los ${ms} ms con motivo '${motivo}' (tope 2000 ms)`)
  }

  // C9 · batch multi-sentencia ⇒ varios recordsets.
  try {
    const r9 = await capDe(100, 20000).execute({ ref: 'lab', sql: 'SELECT 1 AS uno; SELECT 2 AS dos' }, identLab)
    ok(r9.recordsets.length === 2, `C9 · batch de dos sentencias ⇒ ${r9.recordsets.length} recordset(s)`)
  } catch (e) {
    ok(false, `C9 NO MIDIÓ: ${(e as Error).message.split('\n')[0]}`)
  }

  // C10 · el costo del login por ejecución (la conexión con `read_only` no vuelve a un pool).
  const muestras: number[] = []
  for (let i = 0; i < 20; i += 1) {
    const t = Date.now()
    try {
      await capDe(10, 20000).execute({ ref: 'lab', sql: 'SELECT 1 AS uno' }, identLab)
      muestras.push(Date.now() - t)
    } catch { /* una corrida que no midió no entra en la muestra */ }
  }
  if (muestras.length >= 10) {
    const ord = [...muestras].sort((a, b) => a - b)
    const p = (q: number): number => ord[Math.min(ord.length - 1, Math.floor(q * ord.length))]!
    hallazgo(`C10 · costo por ejecución con conexión dedicada (${muestras.length} corridas, motor LOCAL sin AAD): p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · máx ${ord[ord.length - 1]} ms. NO es el costo en Fabric (falta el handshake TLS+AAD): eso lo mide fab:proof`)
  } else {
    ok(false, `C10 NO MIDIÓ: solo ${muestras.length} corridas completaron`)
  }

  seccion('Resumen')
  console.log(`  ${fallos === 0 ? '✓ sin fallos' : `✗ ${fallos} fallo(s)`} · ${hallazgos} hallazgo(s) registrado(s)`)
  console.log('  Recordatorio: esto mide SEMÁNTICA T-SQL. Lo que Fabric acepte en su SKU sigue sin medirse (#186).\n')
  if (fallos > 0) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error('\n✗ La prueba no pudo correr:', (e as Error).message)
    process.exitCode = 1
  })
  // Los pools quedarían vivos y el proceso no saldría nunca — un arnés que se cuelga al fallar
  // esconde su propio fallo detrás de un timeout, que es el modo de falla que la Norma 7 persigue.
  .finally(async () => {
    for (const p of abiertos) await p.close().catch(() => {})
  })
