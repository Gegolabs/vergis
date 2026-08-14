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
  // La VISTA-CONTRATO con SCHEMABINDING que la instancia real usa. Está acá porque #163 dejó como
  // conjetura si `ADD MASKED` y la vista de máscara conviven con ella — no es hipotético.
  await sa.request().batch(`
    CREATE VIEW dbo.vw_contrato_areas WITH SCHEMABINDING AS
      SELECT area, rut, sueldo FROM dbo.areas;`)

  // ── P2 (#163·b) · ¿acepta el motor el DDL del compilador SOBRE una tabla con vista-contrato? ──
  seccion('P2 (#163·b) · el DDL emitido, sobre una tabla que YA tiene vista-contrato SCHEMABINDING')
  const rechazadas: { stmt: string; error: string }[] = []
  for (const stmt of enf.setupSQL) {
    const r = await intentar(sa, stmt)
    if (!r.ok) rechazadas.push({ stmt: stmt.split('\n')[0], error: r.error })
  }
  for (const r of rechazadas) {
    hallazgo(`RECHAZADO: ${r.stmt}…`)
    hallazgo(`   motor: ${r.error}`)
  }
  const setupLimpio = rechazadas.length === 0
  ok(setupLimpio, `las ${enf.setupSQL.length} sentencias del setup emitido se aplican sobre la tabla con vista-contrato`)

  // El plano de FILA sí entra: acotar el hallazgo a la máscara es lo que lo vuelve accionable.
  const policies = (await sa.request().query(
    `SELECT name, is_enabled FROM sys.security_policies`,
  )).recordset as unknown as { name: string; is_enabled: boolean }[]
  ok(policies.some((p) => p.is_enabled), `el plano de FILA sí queda instalado — sys.security_policies: ${policies.map((p) => `${p.name}(${p.is_enabled ? 'ON' : 'off'})`).join(', ')}`)

  const enmascaradas = async (): Promise<string[]> =>
    (await sa.request().query(`SELECT name FROM sys.masked_columns WHERE object_id = OBJECT_ID(N'dbo.areas') AND is_masked = 1`))
      .recordset.map((r) => String((r as Record<string, unknown>)['name']))

  if (!setupLimpio) {
    // CONTROL DE CAUSA — el experimento que habría refutado «la vista-contrato es la culpable».
    // Se retira SOLO la vista y se reintenta la MISMA sentencia, en la misma sesión y sobre la misma
    // tabla. Si el rechazo fuera por otra cosa (el tipo, la policy de fila, el motor), seguiría
    // rechazando. Sin este control, «falló con la vista puesta» es correlación, no mecanismo.
    ok((await enmascaradas()).length === 0, 'CONTROL · con la vista-contrato puesta, NINGUNA columna quedó enmascarada')
    await sa.request().batch('DROP VIEW dbo.vw_contrato_areas;')
    const reintento = await intentar(sa, `ALTER TABLE [dbo].[areas] ALTER COLUMN [rut] ADD MASKED WITH (FUNCTION = 'default()');`)
    ok(reintento.ok, `CONTROL · retirada SOLO la vista-contrato, la MISMA sentencia se acepta${reintento.ok ? '' : ` — ${reintento.error}`}`)
    ok((await enmascaradas()).includes('rut'), `CONTROL · corroborado en sys.masked_columns: [${(await enmascaradas()).join(', ')}]`)
    hallazgo('MECANISMO MEDIDO: la vista-contrato SCHEMABINDING bloquea el `ADD MASKED` de las columnas que proyecta.')
    hallazgo('   Consecuencia: el plano de COLUMNA de #163 no se instala en las tablas con vista-contrato — que son las que la instancia real usa.')
    // La vista de máscara se emite al final del setup y cayó con la máscara: se instala ahora que sí.
    if (rechazadas.some((r) => r.stmt.startsWith('CREATE VIEW'))) {
      const v = await intentar(sa, enf.maskView.createSQL)
      ok(v.ok, `la vista de máscara se instala una vez que la columna pudo enmascararse${v.ok ? '' : ` — ${v.error}`}`)
    }
  } else {
    ok((await enmascaradas()).includes('rut'), `corroborado en sys.masked_columns: [${(await enmascaradas()).join(', ')}]`)
  }

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
