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
