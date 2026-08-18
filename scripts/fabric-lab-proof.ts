// Prueba VIVA contra un Warehouse FABRIC REAL — el terreno propio del Producto (issue #186).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// QUÉ MIDE Y QUÉ NO — leerlo antes de citar cualquier resultado de acá.
//
// Mide: lo que SOLO Fabric contesta. Si el SKU acepta cada sentencia que emite `compileFabric`,
// si los artefactos quedan instalados (corroborado en `sys`), si la vista de máscara SIRVE al
// consultarse, y qué ve un SERVICE PRINCIPAL real —la pregunta de #163—.
//
// NO mide: la semántica del lenguaje T-SQL. Eso lo hace `scripts/tsql-lab-proof.ts`, que es local,
// gratis y no exige capacidad prendida. Si una forma falla ACÁ, correr primero el arnés local para
// saber si el rechazo es de la familia T-SQL o del SKU de Fabric — son caminos distintos.
//
// LA ASIMETRÍA, en el otro sentido que el arnés local: acá un NEGATIVO es definitivo para Fabric,
// y un POSITIVO vale para ESTE SKU (F2) y ESTE rol — no para cualquier instancia.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// EL PRINCIPIO QUE NO SE NEGOCIA, heredado del arnés local: el terreno usa el DDL que emite
// `compileFabric`, nunca SQL escrito a mano para la ocasión, y levanta LA MISMA FORMA que
// `tsql-lab-proof.ts` — así la única diferencia entre los dos bancos es el motor. Un banco que
// además difiere en el esquema mide dos cosas a la vez y no distingue cuál falló.
//
// EL TERRENO SE RECREA, NO SE RESPALDA: este script parte de cero y es idempotente. Si no puede
// levantarlo desde nada, el script está incompleto.
//
// Uso — ver `scripts/README-fabric-lab.md`:
//   npm run fab:resume && npm run fab:proof && npm run fab:pause
//
// No entra en `npm test`: la suite es hermética y sin red. Es prueba de aceptación bajo demanda,
// igual que `tsql-lab-proof.ts` y `live-rls-proof.ts`.

import sql from 'mssql'
import { compileFabric, sessionContextPrelude } from '../packages/policy/src/fabric'
import type { ClaimSet, ColumnRule, PolicyDecl } from '../packages/policy/src/ir'

// ── El terreno: la MISMA forma que `tsql-lab-proof.ts` y que `tests/policy.test.ts` ──────────
const REGLA_PII: ColumnRule = { column: 'rut', claim: 've_pii', action: 'mask' }
const POLICY: PolicyDecl = {
  predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
  combine: 'and',
  default: 'deny',
  columnRules: [REGLA_PII],
}
// Fabric Warehouse no soporta NVARCHAR: el terreno declara VARCHAR con collation UTF-8, que es la
// forma que la instancia real usa. La diferencia con el arnés local es del MOTOR, no del banco.
const TARGET = {
  schema: 'dbo',
  table: 'areas',
  tableColumns: ['area', 'rut', 'sueldo'],
  columnTypes: { area: 'VARCHAR(50)', rut: 'VARCHAR(20)', sueldo: 'DECIMAL(18,2)' },
}
/** Datos SINTÉTICOS. Ningún dato de ninguna instancia entra acá jamás (issue #186, «Qué NO hacer»). */
const FILAS = [
  { area: 'Produccion', rut: '11.111.111-1', sueldo: 900 },
  { area: 'Finanzas', rut: '22.222.222-2', sueldo: 1500 },
  { area: 'Comercial', rut: '33.333.333-3', sueldo: 1200 },
]

const SERVER = process.env['FAB_SERVER']
const DB = process.env['FAB_DB'] ?? 'vergislab'
const TOKEN = process.env['FAB_TOKEN']
const SP_TOKEN = process.env['FAB_SP_TOKEN']

// ── Andamiaje de reporte, mismo vocabulario que el arnés local ───────────────────────────────
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

async function conectar(token: string): Promise<sql.ConnectionPool> {
  return new sql.ConnectionPool({
    server: SERVER!,
    database: DB,
    port: 1433,
    authentication: { type: 'azure-active-directory-access-token', options: { token } },
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 1, min: 1 }, // 1 conexión: SESSION_CONTEXT es por conexión
    connectionTimeout: 60000,
    requestTimeout: 180000,
  } as never).connect()
}

/** Ejecuta y devuelve el error EXACTO en vez de lanzarlo — el texto del rechazo ES el dato. */
async function intentar(pool: sql.ConnectionPool, batch: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await pool.request().batch(batch)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message.split('\n')[0] }
  }
}

const enf = compileFabric(POLICY, TARGET)

/** Consulta con los claims inyectados por `SESSION_CONTEXT`, en la MISMA conexión. */
async function leer(pool: sql.ConnectionPool, claims: ClaimSet, query: string): Promise<Record<string, unknown>[] | null> {
  const p = sessionContextPrelude(enf.injections, claims)
  const req = pool.request()
  for (const x of p.params) req.input(x.name, sql.NVarChar, x.value)
  try {
    const r = await req.query(`${p.sql}\n${query}`)
    return r.recordset as unknown as Record<string, unknown>[]
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  if (!SERVER || !TOKEN) {
    console.error('Faltan FAB_SERVER y/o FAB_TOKEN — ver scripts/README-fabric-lab.md')
    process.exit(2)
  }
  console.log(`\nPrueba VIVA contra FABRIC REAL — ${SERVER.split('-')[0]}… / ${DB}`)
  if (!enf.maskView) throw new Error('El compilador no emitió vista de máscara: la prueba no aplica.')

  const admin = await conectar(TOKEN)
  const quien = await admin.request().query('SELECT SUSER_SNAME() AS w')
  console.log(`Principal administrador: ${(quien.recordset[0] as { w: string }).w}`)

  // ── Bootstrap del terreno, desde cero e idempotente ────────────────────────────────────────
  seccion('P0 · El terreno, desde cero (idempotente): tabla + datos sintéticos')
  await intentar(admin, `DROP VIEW IF EXISTS ${enf.maskView.name}`)
  await intentar(admin, `DROP SECURITY POLICY IF EXISTS [dbo].[secpol_areas]`)
  await intentar(admin, `DROP TABLE IF EXISTS [dbo].[areas]`)
  const t = await intentar(
    admin,
    `CREATE TABLE [dbo].[areas] (area VARCHAR(50) NOT NULL, rut VARCHAR(20) NOT NULL, sueldo DECIMAL(18,2) NOT NULL)`,
  )
  // El veredicto NO es lo que devolvió el cliente: es si la tabla EXISTE. El driver puede reportar
  // un timeout propio (`Failed to cancel request in …ms`) sobre un DDL que Fabric sí ejecutó, y un
  // instrumento que no distingue «no pude medir» de «salió mal» produce datos con cara de verdad.
  const existe = await admin.request().query(`SELECT OBJECT_ID(N'[dbo].[areas]') AS id`)
  const creada = (existe.recordset[0] as { id: number | null }).id !== null
  ok(creada, `CREATE TABLE dbo.areas — corroborado por OBJECT_ID${t.ok ? '' : ` (el cliente reportó: ${t.error})`}`)
  if (creada && !t.ok) hallazgo(`El driver reportó error en un DDL que SÍ se aplicó: ${t.error}`)
  for (const f of FILAS) {
    await admin
      .request()
      .input('a', sql.VarChar, f.area)
      .input('r', sql.VarChar, f.rut)
      .input('s', sql.Decimal(18, 2), f.sueldo)
      .query('INSERT INTO [dbo].[areas] (area, rut, sueldo) VALUES (@a, @r, @s)')
  }
  const n = await admin.request().query('SELECT COUNT(*) AS n FROM [dbo].[areas]')
  ok((n.recordset[0] as { n: number }).n === FILAS.length, `${FILAS.length} filas sintéticas cargadas`)

  // ── P1 · ¿acepta el SKU cada sentencia que emitimos? ───────────────────────────────────────
  seccion(`P1 (#186) · ¿Acepta Fabric CADA una de las ${enf.setupSQL.length} sentencias de compileFabric?`)
  let i = 0
  for (const stmt of enf.setupSQL) {
    i++
    const head = stmt.trim().split('\n')[0].slice(0, 88)
    const r = await intentar(admin, stmt)
    ok(r.ok, `[${i}/${enf.setupSQL.length}] ${head}`)
    if (!r.ok) hallazgo(`RECHAZO EXACTO DE FABRIC: ${r.error}`)
  }

  seccion('P2 · Corroboración en sys — ¿quedó instalado lo que creemos?')
  const mask = await admin
    .request()
    .query(`SELECT c.name, c.is_masked, c.masking_function FROM sys.masked_columns c WHERE OBJECT_NAME(c.object_id)='areas'`)
  ok(mask.recordset.length === 1, `sys.masked_columns: ${JSON.stringify(mask.recordset)}`)
  const pol = await admin.request().query(`SELECT name, is_enabled, is_schema_bound FROM sys.security_policies`)
  ok(pol.recordset.length >= 1, `sys.security_policies: ${JSON.stringify(pol.recordset)}`)

  // ── P3 · el control que separa «discrimina» de «esconde para todos» ────────────────────────
  seccion('P3 · La row policy: ¿DISCRIMINA, o esconde para todos?')
  const conGrupo = await leer(admin, { groups: ['Finanzas', 'Comercial'] } as ClaimSet, 'SELECT area FROM [dbo].[areas]')
  const sinGrupo = await leer(admin, { groups: [] } as unknown as ClaimSet, 'SELECT area FROM [dbo].[areas]')
  ok((conGrupo?.length ?? 0) === 2, `sujeto con 2 grupos ve 2 filas (vio ${conGrupo?.length ?? 'ERROR'})`)
  ok((sinGrupo?.length ?? -1) === 0, `sujeto sin grupos ve 0 filas — el deny muerde (vio ${sinGrupo?.length ?? 'ERROR'})`)

  // ── P4 · la vista de máscara, CON filas visibles ───────────────────────────────────────────
  // El control positivo de P3 es obligatorio: sin filas visibles, un `[]` acá no distingue
  // «Fabric rechazó la expresión» de «no había nada que evaluar». Un instrumento que confunde
  // las dos produce datos con cara de verdad.
  seccion('P4 (#163) · La vista de máscara que emite el Producto, con filas visibles')
  const CLAIMS: ClaimSet = { groups: ['Finanzas', 'Comercial'] } as ClaimSet
  const vista = await leer(admin, CLAIMS, `SELECT area, rut FROM ${enf.maskView.name}`)
  if (vista === null) {
    ok(false, `SELECT sobre ${enf.maskView.name} FALLA en Fabric`)
    hallazgo('La vista se CREA (P1 verde) pero no se puede CONSULTAR. Aceptar el DDL no es servir.')
    const detalle = await intentar(admin, `SELECT area, rut FROM ${enf.maskView.name}`)
    if (!detalle.ok) hallazgo(`Rechazo exacto: ${detalle.error}`)
    // El experimento que aísla la causa — sin esto, «la vista falla» es conjetura sobre el porqué.
    const soloCol = await leer(admin, CLAIMS, `SELECT area FROM ${enf.maskView.name}`)
    hallazgo(`Control · SELECT de la columna NO enmascarada sobre la misma vista: ${soloCol ? 'PASA' : 'falla'}`)
    const sinCase = await leer(admin, CLAIMS, `SELECT CASE WHEN 1=1 THEN rut ELSE 'x' END AS r FROM [dbo].[areas]`)
    hallazgo(`Control · CASE sobre la columna enmascarada SIN SESSION_CONTEXT: ${sinCase ? 'PASA' : 'falla'}`)
    const scEnSelect = await leer(admin, CLAIMS, `SELECT area, CAST(SESSION_CONTEXT(N'vergis_claim_ve_pii') AS VARCHAR(8000)) AS v FROM [dbo].[areas]`)
    hallazgo(`Control · SESSION_CONTEXT en la lista SELECT con FROM tabla, sin CASE: ${scEnSelect ? 'PASA' : 'falla'}`)
    hallazgo('Los tres controles juntos aíslan la causa: SESSION_CONTEXT DENTRO de un CASE sobre un scan de tabla.')
    // La forma emitida es C2 desde el rediseño de #197. Si AUN ASÍ falla, la diferencia contra el
    // C2 que P6 midió pasando no es la forma: es el TIPO del CAST — P6 usó `VARCHAR(8000)` y el
    // compilador emite `NVARCHAR(MAX)`, y Fabric Warehouse no soporta NVARCHAR. Este control lo
    // aísla reescribiendo SOLO ese tipo sobre el MISMO DDL emitido. Es DIAGNÓSTICO, no una forma
    // candidata: si pasa, lo que hay que cambiar en el compilador es `sessionRead`, y se vuelve a
    // medir con lo emitido antes de afirmar nada.
    const vwDx = `[dbo].[v_p4_dx_varchar]`
    await intentar(admin, `DROP VIEW IF EXISTS ${vwDx}`)
    const ddlDx = enf.maskView.createSQL
      .replace(enf.maskView.qualifiedName, vwDx)
      .replaceAll('AS NVARCHAR(MAX))', 'AS VARCHAR(8000))')
    const dx = await intentar(admin, ddlDx)
    if (!dx.ok) {
      hallazgo(`Diagnóstico · el mismo DDL con VARCHAR(8000) tampoco CREA: ${dx.error} — la causa no es el tipo`)
    } else {
      const leidaDx = await leer(admin, CLAIMS, `SELECT * FROM ${vwDx}`)
      hallazgo(
        leidaDx
          ? 'Diagnóstico · con VARCHAR(8000) la MISMA vista SÍ sirve: la causa es el NVARCHAR(MAX) de sessionRead, no la forma C2'
          : 'Diagnóstico · con VARCHAR(8000) tampoco sirve: la causa no es el tipo del CAST',
      )
      await intentar(admin, `DROP VIEW IF EXISTS ${vwDx}`)
    }
  } else {
    ok(true, `la vista responde: ${JSON.stringify(vista)}`)
    // EL CONTROL QUE DECIDE (lección del 2026-08-18): que la vista se consulte no significa que
    // DISCRIMINE. Una vista que devuelve lo mismo con y sin el claim pasa el `ok` de arriba y no
    // protege nada — el defecto de #197 con otra cara. Se compara la MISMA vista bajo dos claims.
    const conClaim = await leer(admin, { groups: ['Finanzas', 'Comercial'], ve_pii: 'true' } as unknown as ClaimSet, `SELECT area, rut FROM ${enf.maskView.name}`)
    const sinClaim = await leer(admin, CLAIMS, `SELECT area, rut FROM ${enf.maskView.name}`)
    if (conClaim === null || sinClaim === null) {
      ok(false, 'el control de discriminación no pudo correr (una de las dos lecturas falló) — la vista NO se declara viable')
    } else {
      const a = JSON.stringify(conClaim)
      const b = JSON.stringify(sinClaim)
      if (!ok(a !== b, `la vista DISCRIMINA por claim — con: ${a} · sin: ${b}`)) {
        hallazgo('Consultable pero inútil: con y sin el claim devuelve lo mismo. La máscara no honra al sujeto.')
      }
    }
  }

  // ── P5 · la pregunta de instancia, con el principal correcto ───────────────────────────────
  seccion('P5 (#163) · ¿El SERVICE PRINCIPAL de serving tiene UNMASK?')
  if (!SP_TOKEN) {
    hallazgo('FAB_SP_TOKEN no está: la pregunta NO se responde en esta corrida. No es un verde.')
    hallazgo('Un admin humano SIEMPRE tiene UNMASK — medirlo con la cuenta propia no contesta nada.')
  } else {
    const sp = await conectar(SP_TOKEN)
    const w = await sp.request().query('SELECT SUSER_SNAME() AS w')
    console.log(`  principal: ${(w.recordset[0] as { w: string }).w}`)
    // El ROL del workspace decide `UNMASK` (medido 2026-08-16: Member ve el valor real, Viewer ve la
    // máscara). Un veredicto sin el rol al lado no dice nada — declararlo es parte del resultado.
    console.log(`  rol declarado por quien corre: ${process.env['FAB_SP_ROLE'] ?? '(no declarado — el veredicto queda sin contexto)'}`)
    const control = await leer(sp, CLAIMS, 'SELECT area FROM [dbo].[areas]')
    if (!control || control.length === 0) {
      ok(false, 'CONTROL POSITIVO FALLIDO: el SP no ve filas — nada se concluye sobre UNMASK')
    } else {
      ok(true, `control positivo: el SP ve ${control.length} filas`)
      const r = await leer(sp, CLAIMS, 'SELECT rut FROM [dbo].[areas]')
      const valor = String(r?.[0]?.['rut'] ?? '')
      const real = valor.includes('-')
      hallazgo(`rut leído de la TABLA (sin vista), sujeto SIN ve_pii = ${JSON.stringify(valor)}`)
      const rol = process.env['FAB_SP_ROLE'] ?? 'rol NO declarado'
      hallazgo(
        real
          ? `EL SP TIENE UNMASK con ${rol} → el DDM es INERTE para él; la única protección de columna sería la vista.`
          : `EL SP NO TIENE UNMASK con ${rol} → el DDM muerde para él.`,
      )
      hallazgo('El veredicto vale para ESTE rol. Cambiar el rol cambia la respuesta — no se generaliza.')
    }
    await sp.close()
  }

  // ── P6 · el rediseño de #197: ¿QUÉ forma expresa la discriminación por claim DENTRO de una vista?
  //
  // #197 dejó aislado que `SESSION_CONTEXT()` DENTRO de un `CASE` sobre un scan de tabla es lo que
  // Fabric rechaza, y que la alternativa que sí funciona —materializar el claim en una variable
  // local— NO CABE en una `VIEW`. De ahí que haga falta rediseñar y no parchear.
  //
  // Este experimento pone en riesgo las tres formas candidatas del rediseño. Está escrito para
  // REFUTAR: si las tres fallan, ese resultado es tan válido como un verde — dice que la vista de
  // máscara no es expresable en Fabric y que la protección de columna tiene que vivir en otro
  // lado. Lo que NO se hace hasta que esto corra es cambiar el compilador: emitir una forma nueva
  // sin verla pasar en el SKU sería exactamente lo que produjo #197.
  //
  // Los dos controles son obligatorios y van en la MISMA sesión:
  //  · POSITIVO — una consulta trivial pasa (si no, nada de lo de abajo significa algo).
  //  · NEGATIVO — la forma ACTUAL, la que #197 midió, sigue fallando. Si de pronto PASA, lo que
  //    cambió es el motor y todo el diagnóstico de #197 hay que rehacerlo, no celebrarlo.
  seccion('P6 (#197) · Formas candidatas para la vista de máscara en Fabric')
  const CL: ClaimSet = { groups: ['Finanzas', 'Comercial'] } as ClaimSet
  const SC = `CAST(SESSION_CONTEXT(N'vergis_claim_ve_pii') AS VARCHAR(8000))`

  const ctrlPos = await leer(admin, CL, 'SELECT 1 AS uno')
  if (!ok(ctrlPos !== null, 'CONTROL POSITIVO · la sesión responde una consulta trivial')) {
    hallazgo('Sin control positivo, ningún resultado de P6 significa nada. P6 se aborta.')
  } else {
    const actual = await leer(admin, CL, `SELECT CASE WHEN ${SC} = 'true' THEN rut ELSE '***' END AS r FROM [dbo].[areas]`)
    hallazgo(
      actual === null
        ? 'CONTROL NEGATIVO · la forma ACTUAL sigue fallando, como midió #197 — el diagnóstico sigue en pie'
        : 'CONTROL NEGATIVO INESPERADO · la forma actual AHORA PASA. Cambió el motor: el diagnóstico de #197 hay que rehacerlo antes de usar nada de esto.',
    )

    // C1 · el claim se materializa en una fuente escalar de UNA fila y se une por CROSS JOIN. Es la
    // traducción a sintaxis-de-vista del `DECLARE` que #197 ya midió funcionando.
    const c1 = `WITH c AS (SELECT ${SC} AS v) SELECT CASE WHEN c.v = 'true' THEN t.rut ELSE '***' END AS r FROM [dbo].[areas] t CROSS JOIN c`
    hallazgo(`C1 · CTE escalar + CROSS JOIN: ${(await leer(admin, CL, c1)) ? 'ACEPTADA' : 'RECHAZADA'}`)

    // C2 · mismo espíritu, otra sintaxis: el planner puede tratarlas distinto y eso es justamente
    // lo que no se puede saber leyendo.
    const c2 = `SELECT CASE WHEN c.v = 'true' THEN t.rut ELSE '***' END AS r FROM [dbo].[areas] t CROSS APPLY (VALUES (${SC})) AS c(v)`
    hallazgo(`C2 · CROSS APPLY (VALUES …): ${(await leer(admin, CL, c2)) ? 'ACEPTADA' : 'RECHAZADA'}`)

    // C3 · sin `CASE`: si lo que el SKU rechaza es la construcción condicional sobre el scan y no
    // `SESSION_CONTEXT` en sí, una forma sin CASE pasaría. Refuta o confirma el alcance del
    // diagnóstico de #197, que es lo que decide cuánto del diseño hay que mover.
    const c3 = `SELECT NULLIF(rut, IIF(${SC} = 'true', CAST(NULL AS VARCHAR(20)), rut)) AS r FROM [dbo].[areas]`
    hallazgo(`C3 · sin CASE (NULLIF/IIF): ${(await leer(admin, CL, c3)) ? 'ACEPTADA' : 'RECHAZADA'}`)

    // Una forma ACEPTADA como consulta todavía no es una vista: el CREATE VIEW puede rechazarla por
    // su cuenta. Aceptar el DDL tampoco basta —#197 nace exactamente de esa confusión—, así que de
    // las candidatas que pasen se crea la vista Y se la consulta.
    for (const [nombre, cuerpo] of [['C1', c1], ['C2', c2], ['C3', c3]] as const) {
      const vw = `[dbo].[v_p6_${nombre.toLowerCase()}]`
      await intentar(admin, `DROP VIEW IF EXISTS ${vw}`)
      const ddl = await intentar(admin, `CREATE VIEW ${vw} AS ${cuerpo}`)
      if (!ddl.ok) {
        hallazgo(`${nombre} · CREATE VIEW rechazado: ${ddl.error}`)
        continue
      }
      const leida = await leer(admin, CL, `SELECT * FROM ${vw}`)
      if (!leida) {
        hallazgo(`${nombre} · vista creada pero el SELECT falla — el modo de falla de #197: aceptar el DDL no es servir`)
        await intentar(admin, `DROP VIEW IF EXISTS ${vw}`)
        continue
      }
      hallazgo(`${nombre} · vista CREADA y CONSULTABLE`)
      // EL CONTROL QUE DECIDE, y sin el cual «consultable» no significa nada: ¿DISCRIMINA?
      // Una vista que se consulta pero devuelve lo mismo con y sin el claim pasaría el paso de
      // arriba y no protegería nada — que es exactamente el defecto que #197 vino a corregir, con
      // otra cara. Se compara la MISMA vista bajo dos claims en la misma sesión.
      const conClaim = await leer(admin, { groups: ['Finanzas', 'Comercial'], ve_pii: 'true' } as unknown as ClaimSet, `SELECT * FROM ${vw}`)
      const sinClaim = await leer(admin, { groups: ['Finanzas', 'Comercial'] } as ClaimSet, `SELECT * FROM ${vw}`)
      const a = JSON.stringify(conClaim)
      const b = JSON.stringify(sinClaim)
      if (conClaim === null || sinClaim === null) {
        hallazgo(`${nombre} · el control de discriminación no pudo correr (una de las dos lecturas falló) — NO se declara viable`)
      } else if (a === b) {
        hallazgo(`${nombre} · NO DISCRIMINA: con y sin el claim devuelve lo mismo (${a}). Consultable pero inútil — no es candidata.`)
      } else {
        hallazgo(`${nombre} · DISCRIMINA por claim — con: ${a} · sin: ${b}`)
        hallazgo(`${nombre} · CANDIDATA VIABLE para el rediseño de #197 (acepta, sirve y discrimina)`)
      }
      await intentar(admin, `DROP VIEW IF EXISTS ${vw}`)
    }
    hallazgo('Ninguna candidata se lleva al compilador antes de verse pasar acá (Norma 7).')
  }

  // ── P7 · #164 en el SKU: ¿el FILTER PREDICATE puede NO recibir columna? ────────────────────
  //
  // #164 pide que un `grant: all` deje de anclar en una columna de datos: `WITH SCHEMABINDING` hace
  // que la referencia sea una dependencia dura, así que el andamiaje de autorización toma REHÉN a
  // una columna de negocio elegida por accidente (medido en una instancia: 9 de 10 columnas cayeron
  // y `barcode` no).
  //
  // La forma sin columna ya se midió ACEPTADA en la familia T-SQL (PR #190, arnés local). Pero la
  // asimetría manda y es la razón exacta de que esto corra acá: **un positivo local no garantiza
  // Fabric**. Es el mismo error que produjo #197, en este mismo plano.
  //
  // Se replica la MISMA forma que el arnés local, para que la única diferencia entre los dos bancos
  // sea el motor. Un banco que además difiere en el esquema mide dos cosas a la vez.
  seccion('P7 (#164) · ¿acepta el SKU un FILTER PREDICATE cuya función no recibe columna?')
  await intentar(admin, `DROP SECURITY POLICY IF EXISTS dbo.secpol_p7_actual`)
  await intentar(admin, `DROP SECURITY POLICY IF EXISTS dbo.secpol_p7_sinparam`)
  await intentar(admin, `DROP SECURITY POLICY IF EXISTS dbo.secpol_p7_const`)
  for (const f of ['fn_pol_p7_actual', 'fn_pol_p7_sinparam', 'fn_pol_p7_const']) {
    await intentar(admin, `DROP FUNCTION IF EXISTS dbo.${f}`)
  }
  await intentar(admin, `DROP TABLE IF EXISTS dbo.publica_p7`)
  const terrenoP7 = await intentar(
    admin,
    `CREATE TABLE dbo.publica_p7 (id INT NOT NULL, nombre VARCHAR(50) NOT NULL);
     INSERT INTO dbo.publica_p7 (id, nombre) VALUES (1, 'uno'), (2, 'dos');`,
  )
  if (!ok(terrenoP7.ok, `terreno de P7 creado${terrenoP7.ok ? '' : ` — ${terrenoP7.error}`}`)) {
    hallazgo('Sin terreno, P7 no mide nada. Se salta.')
  } else {
    // (a) CONTROL POSITIVO — la forma ACTUAL (función CON columna), mismo terreno y misma sesión.
    // Sin esto, un rechazo de (b) no distingue «esta forma no se acepta» de «acá nada anda».
    const fnActual = await intentar(
      admin,
      `CREATE FUNCTION dbo.fn_pol_p7_actual(@id INT) RETURNS TABLE WITH SCHEMABINDING AS RETURN SELECT 1 AS vergis_allowed;`,
    )
    const polActual = fnActual.ok
      ? await intentar(
          admin,
          `CREATE SECURITY POLICY dbo.secpol_p7_actual ADD FILTER PREDICATE dbo.fn_pol_p7_actual(id) ON dbo.publica_p7 WITH (STATE = ON);`,
        )
      : { ok: false as const, error: `(no se intentó: la función no se creó — ${fnActual.error})` }
    ok(polActual.ok, `CONTROL POSITIVO · la forma ACTUAL (función CON columna) se acepta${polActual.ok ? '' : ` — ${polActual.error}`}`)
    await intentar(admin, `DROP SECURITY POLICY IF EXISTS dbo.secpol_p7_actual`)
    await intentar(admin, `DROP FUNCTION IF EXISTS dbo.fn_pol_p7_actual`)

    // (b) función SIN NINGÚN parámetro — lo que #164 quiere para no tomar rehén a una columna.
    const fnSinParam = await intentar(
      admin,
      `CREATE FUNCTION dbo.fn_pol_p7_sinparam() RETURNS TABLE WITH SCHEMABINDING AS RETURN SELECT 1 AS vergis_allowed;`,
    )
    hallazgo(`(b) CREATE FUNCTION sin parámetro: ${fnSinParam.ok ? 'ACEPTADO' : `RECHAZADO — ${fnSinParam.error}`}`)
    if (fnSinParam.ok) {
      const polSinParam = await intentar(
        admin,
        `CREATE SECURITY POLICY dbo.secpol_p7_sinparam ADD FILTER PREDICATE dbo.fn_pol_p7_sinparam() ON dbo.publica_p7 WITH (STATE = ON);`,
      )
      hallazgo(
        `(b) ADD FILTER PREDICATE sin argumento: ${polSinParam.ok ? 'ACEPTADO — la columna deja de ser rehén' : `RECHAZADO — ${polSinParam.error}`}`,
      )
      if (polSinParam.ok) {
        // El control que impide cambiar un andamiaje por algo PEOR: una policy que instala y niega
        // todo también «se acepta». #164 existe para quitar un rehén, no para fabricar un deny mudo.
        const q = await intentar(admin, 'SELECT id FROM dbo.publica_p7')
        const filas = q.ok ? (await admin.request().query('SELECT id FROM dbo.publica_p7')).recordset.length : -1
        ok(filas === 2, `(b) con la policy sin columna instalada la tabla sigue sirviendo sus 2 filas (allow-all real, no deny silencioso): ${filas}`)
        // Y la corroboración en `sys`: que el DDL pase no significa que el artefacto quedara.
        const sys = await admin
          .request()
          .query(`SELECT name, is_enabled, is_schema_bound FROM sys.security_policies WHERE name = 'secpol_p7_sinparam'`)
        hallazgo(`(b) sys.security_policies: ${JSON.stringify(sys.recordset)}`)
      }
      await intentar(admin, `DROP SECURITY POLICY IF EXISTS dbo.secpol_p7_sinparam`)
      await intentar(admin, `DROP FUNCTION IF EXISTS dbo.fn_pol_p7_sinparam`)
    }

    // (c) parámetro alimentado por CONSTANTE — la variante de respaldo que el issue nombra, por si
    // (b) tropieza con algo propio del SKU.
    const fnConst = await intentar(
      admin,
      `CREATE FUNCTION dbo.fn_pol_p7_const(@x INT) RETURNS TABLE WITH SCHEMABINDING AS RETURN SELECT 1 AS vergis_allowed;`,
    )
    if (fnConst.ok) {
      const polConst = await intentar(
        admin,
        `CREATE SECURITY POLICY dbo.secpol_p7_const ADD FILTER PREDICATE dbo.fn_pol_p7_const(1) ON dbo.publica_p7 WITH (STATE = ON);`,
      )
      hallazgo(`(c) ADD FILTER PREDICATE con argumento CONSTANTE: ${polConst.ok ? 'ACEPTADO' : `RECHAZADO — ${polConst.error}`}`)
      await intentar(admin, `DROP SECURITY POLICY IF EXISTS dbo.secpol_p7_const`)
      await intentar(admin, `DROP FUNCTION IF EXISTS dbo.fn_pol_p7_const`)
    } else {
      hallazgo(`(c) CREATE FUNCTION con parámetro: RECHAZADO — ${fnConst.error}`)
    }
    await intentar(admin, `DROP TABLE IF EXISTS dbo.publica_p7`)
  }

  await admin.close()
  console.log(`\n${fallos === 0 ? '✅ Sin fallos' : `❌ ${fallos} fallo(s)`} · ${hallazgos} hallazgo(s) registrados\n`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FALLO DE LA SONDA:', (e as Error).message)
  process.exit(2)
})
