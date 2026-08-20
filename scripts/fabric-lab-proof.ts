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
// EL SUJETO QUE MIDE NO ES CUALQUIERA (lección de #238). Toda comprobación de discriminación de
// máscara que corra como `admin` es REFERENCIA, no veredicto: el admin siempre tiene `UNMASK`, así
// que mide una propiedad real sobre un sujeto que no es el que sirve — y así se coló #238 tras los
// verdes que cerraron #197. Las comprobaciones del admin se conservan a propósito (el contraste
// admin-vs-SP es lo que hizo visible el defecto), y el veredicto sobre el sujeto que sirve lo da P9.
//
// Y ANTES DE CUALQUIER VEREDICTO SOBRE `UNMASK`, EL CONTROL DE PREMISA: el estado del sujeto se mide
// LEYENDO —plano de datos—, nunca consultando el plano de control. `FAB_SP_ROLE=Viewer` fue cierto en
// el plano de control y falso en el plano de datos durante más de una hora de staleness de
// revocación; un veredicto apoyado en esa declaración habría sido falso con cara de medido.
// `fn_my_permissions` y `DATABASE_PRINCIPAL_ID()` no sirven en Fabric (medido): su `[]` significa «no
// pude medir», no «no tiene» — no se usan acá.
//
// TRES ESTADOS, NO DOS. Este arnés distingue `✓` (medí y salió bien), `✗` (medí y salió mal) y
// `⚠` (NO PUDE MEDIR: premisa no satisfecha, credencial ausente, lectura que falló). La
// indeterminación no es un verde ni un rojo — es el instrumento diciendo que no sabe (Norma 7,
// corolario de instrumentos). Sale en el resumen y en el código de salida: 0 sin fallos ni
// indeterminaciones · 1 con fallos · 3 solo con indeterminaciones · 2 la sonda no pudo correr.
//
// Uso — ver `scripts/README-fabric-lab.md`:
//   npm run fab:resume && npm run fab:proof && npm run fab:pause
//
// SIN MOTOR Y SIN GASTO — `FAB_PROOF_PRINT_SQL=1 npm run fab:proof` imprime todo el SQL que el
// arnés emite (el del COMPILADOR, no escrito a mano) y ejercita la lógica del control de premisa con
// dobles, sin conectarse a nada. Es la revisión previa a gastar una ventana de capacidad.
//
// No entra en `npm test`: la suite es hermética y sin red. Es prueba de aceptación bajo demanda,
// igual que `tsql-lab-proof.ts` y `live-rls-proof.ts`.

import sql from 'mssql'
import { compileFabric, sessionContextPrelude } from '../packages/policy/src/fabric'
import type { ClaimSet, ColumnRule, PolicyDecl } from '../packages/policy/src/ir'
import { UNMASK_PROBE_EXPECTED, UNMASK_PROBE_SCHEMAS_SQL, unmaskProbeReadSQL } from '../server/engines/fabric'

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
const PRINT_SQL = process.env['FAB_PROOF_PRINT_SQL'] === '1'

/**
 * El token del SERVICE PRINCIPAL, por UNA sola vía para todos los sondeos que lo usan.
 *
 * Dos rutas, en este orden: `FAB_SP_TOKEN` ya obtenido (lo que este arnés usaba) y, si no está,
 * `client_credentials` con `FAB_SP_APP_ID` / `FAB_SP_SECRET` / `FAB_TENANT`. La segunda existe porque
 * un sondeo que muere por una variable que el runner no exportó es un modo de falla ya pagado: dos
 * experimentos del mismo día pedían el token de dos maneras distintas y uno se quedó sin medir.
 * Devuelve también la RUTA, porque un veredicto sobre un principal sin decir cómo se autenticó deja
 * al lector sin saber a quién se midió.
 */
async function tokenSP(): Promise<{ token: string; via: string } | { token: null; via: string }> {
  const ya = process.env['FAB_SP_TOKEN']
  if (ya) return { token: ya, via: 'FAB_SP_TOKEN (pre-obtenido)' }
  const appId = process.env['FAB_SP_APP_ID']
  const secret = process.env['FAB_SP_SECRET']
  const tenant = process.env['FAB_TENANT']
  if (!appId || !secret || !tenant) {
    return { token: null, via: 'sin credencial: falta FAB_SP_TOKEN o el trío FAB_SP_APP_ID/FAB_SP_SECRET/FAB_TENANT' }
  }
  const body = new URLSearchParams({
    client_id: appId,
    client_secret: secret,
    scope: 'https://database.windows.net/.default',
    grant_type: 'client_credentials',
  })
  try {
    const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: 'POST', body })
    const j = (await r.json()) as { access_token?: string; error_description?: string }
    if (!j.access_token) return { token: null, via: `client_credentials FALLÓ: ${j.error_description ?? r.status}` }
    return { token: j.access_token, via: `client_credentials (${appId.slice(0, 8)}…)` }
  } catch (e) {
    return { token: null, via: `client_credentials FALLÓ: ${(e as Error).message.split('\n')[0]}` }
  }
}

// ── Andamiaje de reporte, mismo vocabulario que el arnés local, más el tercer estado ─────────
let fallos = 0
let hallazgos = 0
let indeterminaciones = 0
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
/**
 * NO PUDE MEDIR — el tercer estado, y el que faltaba.
 *
 * No es un verde ni un rojo: es el instrumento declarando que no sabe. Se usa cuando la premisa del
 * experimento no está satisfecha, cuando falta la credencial del sujeto o cuando la lectura falló.
 * Antes esto salía como `hallazgo`, indistinguible de un dato — y un instrumento que confunde «medí y
 * salió negativo» con «no pude medir» produce datos con cara de verdad (Norma 7).
 */
function noMedido(msg: string): void {
  indeterminaciones++
  console.log(`  ⚠ NO MEDIDO · ${msg}`)
}

// ── El control de premisa, como lógica PURA: se ejercita sin motor ───────────────────────────
type EstadoUnmask = 'unmask' | 'enmascarado' | 'no-medible'
interface Premisa {
  estado: EstadoUnmask
  valor: string | null
  motivo: string
}
/**
 * ¿Qué ve el sujeto al LEER la columna gobernada de la tabla? El plano de DATOS, que es el único que
 * no miente durante la staleness de revocación.
 *
 * La lectura se juzga contra los valores SINTÉTICOS que este terreno cargó —conocidos por
 * construcción—, y la ausencia de capacidad se reconoce por «≠ esperado», nunca por el literal que
 * el motor use para enmascarar (`default()` rinde `xxxx` hoy; el veredicto no cuelga de eso). Es la
 * misma doctrina del centinela de #238.
 */
function premisaUnmask(filas: Record<string, unknown>[] | null, columna = 'rut'): Premisa {
  if (filas === null) return { estado: 'no-medible', valor: null, motivo: 'la lectura de la tabla FALLÓ: no se sabe qué ve el sujeto' }
  if (filas.length === 0) {
    return { estado: 'no-medible', valor: null, motivo: 'el sujeto no ve NINGUNA fila (RLS o terreno vacío): sin fila no hay valor que juzgar' }
  }
  const valor = String(filas[0]?.[columna] ?? '')
  if (valor === '') return { estado: 'no-medible', valor, motivo: 'la columna vino vacía: no se distingue máscara de dato ausente' }
  if (FILAS.some((f) => f.rut === valor)) {
    return { estado: 'unmask', valor, motivo: 'lee un valor sintético EN CLARO ⇒ el sujeto DESENMASCARA' }
  }
  return { estado: 'enmascarado', valor, motivo: 'lee algo distinto de todo valor sintético ⇒ el motor ENMASCARÓ para él' }
}
/**
 * Lo que el PLANO DE CONTROL declara, para poder CONTRASTARLO — jamás para sustituir la medición.
 * Un rol que no sabemos mapear no declara nada: inventar la expectativa sería peor que no tenerla.
 */
function esperadoPorRol(rol: string | undefined): EstadoUnmask | null {
  if (!rol) return null
  const r = rol.trim().toLowerCase()
  if (['member', 'admin', 'contributor'].includes(r)) return 'unmask'
  if (r === 'viewer') return 'enmascarado'
  return null
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

/**
 * MODO SIN MOTOR Y SIN GASTO (`FAB_PROOF_PRINT_SQL=1`).
 *
 * Imprime el SQL que los sondeos nuevos emiten —tomado del COMPILADOR y del descubrimiento del
 * serving, jamás escrito a mano para la ocasión— y ejercita la lógica del control de premisa con
 * dobles. Existe porque entre el SQL de un experimento suelto y el que emite `compileFabric` hubo
 * diferencias que nadie eligió, y eso ya cobró su precio dos veces: acá se revisa antes de encender
 * la capacidad, que cuesta plata.
 *
 * Lo que este modo NO hace, y hay que decirlo: no mide nada contra Fabric. Que el SQL se vea bien no
 * dice que el SKU lo acepte — eso solo lo contesta la corrida con la ventana abierta.
 */
function imprimirSQL(): void {
  const vista = enf.maskView!
  const cent = enf.unmaskProbe!
  seccion('SQL EMITIDO · el centinela de desenmascarado (P10) — sale de compileFabric')
  cent.setupSQL.forEach((s, i) => console.log(`\n-- setupSQL[${i + 1}/${cent.setupSQL.length}]\n${s}`))
  console.log(`\n-- dropSQL\n${cent.dropSQL}`)
  console.log(`\n-- probeSQL (del compilador)\n${cent.probeSQL}`)
  console.log(`\n-- unmaskProbeReadSQL('dbo') (lo que el SERVING ejecuta)\n${unmaskProbeReadSQL('dbo')}`)
  console.log(`\n-- UNMASK_PROBE_SCHEMAS_SQL (el descubrimiento del serving)\n${UNMASK_PROBE_SCHEMAS_SQL}`)
  console.log(`\n-- corroboración en sys\nSELECT name, is_masked FROM sys.masked_columns WHERE object_id = OBJECT_ID(N'${cent.qualifiedName}')`)
  console.log(`\n-- idempotencia\nSELECT COUNT(*) AS n FROM ${cent.qualifiedName}`)

  seccion('SQL EMITIDO · el control de premisa y la discriminación como SP (P9)')
  const prel = sessionContextPrelude(enf.injections, { groups: ['Finanzas', 'Comercial'] } as ClaimSet)
  console.log(`\n-- prelude de SESSION_CONTEXT (params: ${prel.params.map((p) => p.name).join(', ')})\n${prel.sql}`)
  console.log(`\n-- control de premisa: se mide LEYENDO la tabla, en el plano de DATOS\nSELECT rut FROM [dbo].[areas]`)
  console.log(`\n-- la discriminación, misma vista y dos claims\nSELECT area, rut FROM ${vista.name} ORDER BY area`)
  console.log(`\n-- la vista, tal como la emite el compilador\n${vista.createSQL}`)

  seccion('DRY-RUN de la lógica del control de premisa — con dobles, sin motor')
  const casos: [string, Record<string, unknown>[] | null][] = [
    ['lectura que falló (null)', null],
    ['sin filas visibles', []],
    ['valor sintético en claro', [{ rut: FILAS[0]!.rut }]],
    ['default() del motor (XXXX)', [{ rut: 'XXXX' }]],
    ['literal de la vista (•••)', [{ rut: '•••' }]],
    ['string vacío', [{ rut: '' }]],
    ['valor inesperado', [{ rut: 'lo-que-sea' }]],
  ]
  for (const [nombre, doble] of casos) {
    const p = premisaUnmask(doble)
    console.log(`  ${p.estado === 'no-medible' ? '⚠' : '·'} ${nombre.padEnd(26)} ⇒ ${p.estado.padEnd(13)} · ${p.motivo}`)
  }
  // El trampantojo que un sondeo por desigualdad de JSON NO habría atrapado, ejercitado con dobles:
  // la rama ELSE de la vista devuelve el literal del IR (`•••`) y el DDM devuelve el default del tipo
  // (`XXXX`), así que las dos lecturas DIFIEREN sin que ninguna traiga el dato.
  seccion('DRY-RUN · por qué el veredicto NO es la desigualdad de JSON')
  const conDDM = [{ area: 'Finanzas', rut: 'XXXX' }]
  const sinDDM = [{ area: 'Finanzas', rut: '•••' }]
  const realesEn = (f: Record<string, unknown>[]) => f.filter((r) => FILAS.some((x) => x.rut === String(r['rut']))).length
  console.log(`  · estado DEFECTUOSO (sujeto sin UNMASK): con=${JSON.stringify(conDDM)} · sin=${JSON.stringify(sinDDM)}`)
  console.log(`  ✗ el test por desigualdad diría: ${JSON.stringify(conDDM) !== JSON.stringify(sinDDM) ? 'DISCRIMINA (verde falso)' : 'no discrimina'}`)
  console.log(`  ✓ el test por VALOR REAL dice: ${realesEn(conDDM)} celdas reales con el claim ⇒ no concede nada`)
  const conSano = [{ area: 'Finanzas', rut: FILAS[1]!.rut }]
  console.log(`  · estado SANO (sujeto con UNMASK): con=${JSON.stringify(conSano)} ⇒ ${realesEn(conSano)} celdas reales ⇒ concede`)

  seccion('DRY-RUN del contraste plano de control vs plano de datos')
  for (const rol of ['Member', 'Viewer', 'Admin', 'Contributor', 'Cualquiera', undefined]) {
    console.log(`  · FAB_SP_ROLE=${String(rol).padEnd(12)} ⇒ esperado ${esperadoPorRol(rol) ?? '(no se mapea: no se inventa expectativa)'}`)
  }
  console.log('\nEste modo NO mide contra Fabric. Que el SQL se vea bien no dice que el SKU lo acepte.\n')
}

async function main(): Promise<void> {
  if (PRINT_SQL) {
    imprimirSQL()
    return
  }
  if (!SERVER || !TOKEN) {
    console.error('Faltan FAB_SERVER y/o FAB_TOKEN — ver scripts/README-fabric-lab.md')
    process.exit(2)
  }
  console.log(`\nPrueba VIVA contra FABRIC REAL — ${SERVER.split('-')[0]}… / ${DB}`)
  if (!enf.maskView) throw new Error('El compilador no emitió vista de máscara: la prueba no aplica.')
  if (!enf.unmaskProbe) throw new Error('El compilador no emitió centinela de desenmascarado: la prueba no aplica.')
  const VISTA = enf.maskView
  const CENTINELA = enf.unmaskProbe

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
    //
    // PERO ESTO ES REFERENCIA, NO VEREDICTO: corre como `admin`, que SIEMPRE tiene `UNMASK`. Es la
    // mitad del contraste que hizo visible #238 y por eso se conserva; el veredicto sobre el sujeto
    // que sirve lo da P9, y solo tras verificar su premisa en el plano de datos.
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
  const cred = await tokenSP()
  console.log(`  credencial del SP: ${cred.via}`)
  if (!cred.token) {
    noMedido('sin credencial del SP la pregunta NO se responde en esta corrida. No es un verde.')
    hallazgo('Un admin humano SIEMPRE tiene UNMASK — medirlo con la cuenta propia no contesta nada.')
  } else {
    const sp = await conectar(cred.token)
    const w = await sp.request().query('SELECT SUSER_SNAME() AS w')
    console.log(`  principal: ${(w.recordset[0] as { w: string }).w}`)
    // El ROL del workspace decide `UNMASK` (medido 2026-08-16: Member ve el valor real, Viewer ve la
    // máscara). Se DECLARA para poder contrastarlo con la medición — no para sustituirla.
    const rolDeclarado = process.env['FAB_SP_ROLE']
    console.log(`  rol declarado por quien corre: ${rolDeclarado ?? '(no declarado — no hay nada que contrastar)'}`)
    const control = await leer(sp, CLAIMS, 'SELECT area FROM [dbo].[areas]')
    if (!control || control.length === 0) {
      noMedido('CONTROL POSITIVO FALLIDO: el SP no ve filas — nada se concluye sobre UNMASK')
    } else {
      ok(true, `control positivo: el SP ve ${control.length} filas`)
      const p = premisaUnmask(await leer(sp, CLAIMS, 'SELECT rut FROM [dbo].[areas]'))
      hallazgo(`rut leído de la TABLA (sin vista), sujeto SIN ve_pii = ${JSON.stringify(p.valor)} — ${p.motivo}`)
      const rol = rolDeclarado ?? 'rol NO declarado'
      if (p.estado === 'no-medible') {
        noMedido(`el estado de UNMASK del SP no se pudo determinar: ${p.motivo}`)
      } else if (p.estado === 'unmask') {
        hallazgo(`EL SP TIENE UNMASK con ${rol} → el DDM es INERTE para él; la única protección de columna sería la vista.`)
      } else {
        hallazgo(`EL SP NO TIENE UNMASK con ${rol} → el DDM muerde para él, y el gate de #238 lo declara NO SERVIBLE.`)
      }
      const esperado = esperadoPorRol(rolDeclarado)
      if (esperado && p.estado !== 'no-medible' && esperado !== p.estado) {
        hallazgo(
          `EL PLANO DE CONTROL MIENTE AHORA MISMO: el rol declarado '${rolDeclarado}' implica '${esperado}' y ` +
            `el plano de datos dice '${p.estado}'. Es la staleness de revocación (medida >1 h, techo desconocido).`,
        )
      }
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
      // También acá el sujeto es el `admin`: sirve para elegir la FORMA (qué sintaxis el planner
      // acepta y discrimina), que es lo que P6 decide. Que la forma elegida discrimine para el
      // principal que SIRVE es otra pregunta, y es la de P9.
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

  // ── P8 · #164 con lo que EMITE el compilador, y el control que decide: ¿se suelta el rehén? ──
  //
  // P7 midió la FORMA a mano. Esto aplica el `setupSQL` que sale de `compileFabric` tras el
  // rediseño, y sobre todo hace la pregunta que el issue plantea y que ninguna corrida había
  // hecho: con la policy INSTALADA, ¿se puede alterar una columna de negocio? Con la forma anterior
  // eso se rechazaba por la dependencia de `SCHEMABINDING` — y así se descubrió el problema, con un
  // ALTER rechazado en una instancia. Si acá pasa, el rehén se soltó de verdad.
  seccion('P8 (#164) · el allow-all EMITIDO, y el ALTER que antes se rechazaba')
  await intentar(admin, `DROP SECURITY POLICY IF EXISTS dbo.secpol_publica_emit`)
  await intentar(admin, `DROP FUNCTION IF EXISTS dbo.fn_pol_publica_emit`)
  await intentar(admin, `DROP TABLE IF EXISTS dbo.publica_emit`)
  const terrenoP8 = await intentar(
    admin,
    `CREATE TABLE dbo.publica_emit (id INT NOT NULL, nombre VARCHAR(50) NOT NULL);
     INSERT INTO dbo.publica_emit (id, nombre) VALUES (1, 'uno'), (2, 'dos');`,
  )
  if (!ok(terrenoP8.ok, `terreno de P8 creado${terrenoP8.ok ? '' : ` — ${terrenoP8.error}`}`)) {
    hallazgo('Sin terreno, P8 no mide nada. Se salta.')
  } else {
    const enfPub = compileFabric({ public: true }, { schema: 'dbo', table: 'publica_emit' })
    let pubOk = true
    for (const [i, stmt] of enfPub.setupSQL.entries()) {
      const r = await intentar(admin, stmt)
      if (!ok(r.ok, `[${i + 1}/${enfPub.setupSQL.length}] ${stmt.split('\n')[0].slice(0, 68)}${r.ok ? '' : ` — ${r.error}`}`)) pubOk = false
    }
    if (pubOk) {
      const q = await intentar(admin, 'SELECT id FROM dbo.publica_emit')
      const filas = q.ok ? (await admin.request().query('SELECT id FROM dbo.publica_emit')).recordset.length : -1
      ok(filas === 2, `con el allow-all EMITIDO instalado la tabla sigue sirviendo sus 2 filas: ${filas}`)
      const alter = await intentar(admin, `ALTER TABLE dbo.publica_emit ALTER COLUMN nombre VARCHAR(80) NOT NULL;`)
      ok(alter.ok, `ALTER sobre una columna de negocio con la policy INSTALADA: ${alter.ok ? 'ACEPTADO — la columna NO es rehén' : `rechazado — ${alter.error}`}`)
      ok(enfPub.schemaDependencies.length === 0, `schemaDependencies del allow-all: ${JSON.stringify(enfPub.schemaDependencies)} (vacío = nada atado)`)
      const sysP8 = await admin
        .request()
        .query(`SELECT name, is_enabled, is_schema_bound FROM sys.security_policies WHERE name = 'secpol_publica_emit'`)
      hallazgo(`sys.security_policies del emitido: ${JSON.stringify(sysP8.recordset)}`)
    }
    await intentar(admin, `DROP SECURITY POLICY IF EXISTS dbo.secpol_publica_emit`)
    await intentar(admin, `DROP FUNCTION IF EXISTS dbo.fn_pol_publica_emit`)
    await intentar(admin, `DROP TABLE IF EXISTS dbo.publica_emit`)
  }

  // ── P9 · el veredicto sobre EL SUJETO QUE SIRVE, con su premisa medida antes ────────────────
  //
  // POR QUÉ EXISTE: todas las comprobaciones de discriminación de arriba corren como `admin`, y el
  // admin siempre tiene `UNMASK`. Miden una propiedad real sobre un sujeto que no es el que sirve —
  // y así se coló #238 tras los verdes que cerraron #197. Esto lo mide con el principal correcto.
  //
  // EL CONTROL DE PREMISA VA PRIMERO Y ES BLOQUEANTE, y se mide LEYENDO (plano de datos): el estado
  // de `UNMASK` del SP decide QUÉ resultado es el esperado, así que un veredicto sobre la vista sin
  // la premisa medida no dice nada. Se re-mide acá aunque P5 ya lo midió: entre P5 y este punto pasan
  // minutos, y la staleness de revocación de Fabric dura más que eso.
  //
  // Y LAS DOS EXPECTATIVAS SON OPUESTAS, que es lo que vuelve la premisa indispensable:
  //  · SP CON unmask   → el gate de #238 lo declara SERVIBLE, y la vista TIENE que discriminar.
  //  · SP SIN unmask   → el DDM enmascara río arriba de la vista: las dos ramas del CASE devuelven la
  //    máscara y la vista NO discrimina. Eso es la CORROBORACIÓN de #238, no un fallo del Producto —
  //    su respuesta correcta es el fail-closed del gate. Si acá discriminara, el diagnóstico de #238
  //    estaría mal y habría que rehacerlo, no celebrarlo.
  seccion('P9 (#238) · La vista de máscara ante EL SUJETO QUE SIRVE — premisa medida en el plano de datos')
  if (!cred.token) {
    noMedido(`sin credencial del SP (${cred.via}): la discriminación para el sujeto que sirve NO se mide. No es un verde.`)
  } else {
    const sp = await conectar(cred.token)
    const quienSp = await sp.request().query('SELECT SUSER_SNAME() AS w')
    console.log(`  principal que sirve: ${(quienSp.recordset[0] as { w: string }).w}`)
    const p = premisaUnmask(await leer(sp, CLAIMS, 'SELECT rut FROM [dbo].[areas]'))
    console.log(`  premisa medida LEYENDO la tabla: ${JSON.stringify(p.valor)} ⇒ '${p.estado}' (${p.motivo})`)
    const esperado = esperadoPorRol(process.env['FAB_SP_ROLE'])
    if (p.estado === 'no-medible') {
      noMedido(`PREMISA NO VERIFICABLE: ${p.motivo}. No se emite veredicto sobre la vista.`)
    } else if (esperado && esperado !== p.estado) {
      // El defecto que esto cierra, textual: `FAB_SP_ROLE=Viewer` fue cierto en el plano de control y
      // FALSO en el plano de datos durante la staleness. Concluir ahí es publicar un veredicto sobre
      // un sujeto cuyo estado no es el declarado — y se hizo, y se coló.
      noMedido(
        `PREMISA NO SATISFECHA: se declaró rol '${process.env['FAB_SP_ROLE']}' (⇒ '${esperado}') y el plano de datos ` +
          `mide '${p.estado}'. El experimento SE NIEGA A CONCLUIR: staleness de revocación en curso.`,
      )
      hallazgo('Reintentar más tarde con el mismo rol declarado. La cota inferior medida de la staleness es >1 h.')
    } else {
      ok(true, `premisa verificada en el plano de datos: el sujeto que sirve está '${p.estado}'${esperado ? ' (coincide con el rol declarado)' : ' (sin rol declarado: la medición ES la premisa)'}`)
      const con = await leer(sp, { groups: ['Finanzas', 'Comercial'], ve_pii: 'true' } as unknown as ClaimSet, `SELECT area, rut FROM ${VISTA.name} ORDER BY area`)
      const sinC = await leer(sp, CLAIMS, `SELECT area, rut FROM ${VISTA.name} ORDER BY area`)
      if (con === null || sinC === null || con.length === 0 || sinC.length === 0) {
        noMedido('el SP no pudo consultar la vista con filas visibles: sin control positivo nada se concluye')
      } else {
        const a = JSON.stringify(con)
        const b = JSON.stringify(sinC)
        console.log(`  · con ve_pii : ${a}`)
        console.log(`  · sin ve_pii : ${b}`)
        // EL TEST NO ES «¿DEVUELVE ALGO DISTINTO?», Y ESTA ES LA MITAD DEL DEFECTO DE #238 QUE UN
        // SONDEO POR DESIGUALDAD NO HABRÍA VISTO. La rama ELSE de la vista devuelve un LITERAL del IR
        // (`•••`), y el DDM devuelve el default DEL TIPO (`XXXX`): para un sujeto SIN `UNMASK` las dos
        // lecturas difieren en el texto —`XXXX` vs `•••`— aunque NINGUNA traiga el dato. Comparar
        // JSON habría dado verde sobre una capacidad muerta. Lo que se mide es si el claim CONCEDE EL
        // VALOR REAL, y el valor real se conoce por construcción: los ruts sintéticos del terreno.
        const real = (filas: Record<string, unknown>[]) => filas.filter((r) => FILAS.some((f) => f.rut === String(r['rut']))).length
        const conReal = real(con)
        const sinReal = real(sinC)
        console.log(`  · celdas con el VALOR REAL — con ve_pii: ${conReal}/${con.length} · sin ve_pii: ${sinReal}/${sinC.length}`)
        hallazgo(`el sondeo por DESIGUALDAD de JSON habría dicho '${a !== b ? 'discrimina' : 'no discrimina'}' — por eso no es el test`)
        if (p.estado === 'unmask') {
          if (ok(conReal === con.length && sinReal === 0, 'EL CLAIM CONCEDE EL VALOR REAL AL SUJETO QUE SIRVE, y sin el claim no concede nada')) {
            hallazgo('`ve_pii` concede de verdad al principal que sirve: es el estado en que el gate de #238 permite servir.')
          } else if (conReal === 0) {
            hallazgo('DEFECTO VIVO: el sujeto desenmascara y AUN ASÍ el claim no le concede el valor real — `ve_pii` no concede nada.')
          } else {
            hallazgo(`Resultado MIXTO (${conReal} de ${con.length} con el claim, ${sinReal} sin él): no se declara sano hasta explicarlo.`)
          }
        } else {
          if (ok(conReal === 0, 'CONTROL NEGATIVO · sin capacidad de desenmascarar, ni CON el claim llega el valor real — como midió #238')) {
            hallazgo('Corrobora por qué el gate de #238 declara NO SERVIBLE a este principal: la vista le concedería nada.')
          } else {
            hallazgo('CONTROL NEGATIVO INESPERADO: un sujeto SIN unmask recibe el valor real. El diagnóstico de #238 hay que rehacerlo antes de usar esto.')
          }
        }
      }
      // La referencia, en la MISMA corrida: el contraste admin-vs-SP es lo que hizo visible #238.
      const ac = await leer(admin, { groups: ['Finanzas', 'Comercial'], ve_pii: 'true' } as unknown as ClaimSet, `SELECT area, rut FROM ${VISTA.name} ORDER BY area`)
      const as_ = await leer(admin, CLAIMS, `SELECT area, rut FROM ${VISTA.name} ORDER BY area`)
      hallazgo(
        JSON.stringify(ac) !== JSON.stringify(as_)
          ? 'REFERENCIA · el admin SÍ discrimina sobre la misma vista — por eso su verde no decía nada del SP'
          : 'REFERENCIA · el admin tampoco discrimina — el fenómeno no depende del principal',
      )
    }
    await sp.close()
  }

  // ── P10 · el centinela de desenmascarado, medido ANTES de cortar una versión ────────────────
  //
  // ESTE SONDEO ES LA CONDICIÓN DE CORTAR VERSIÓN cuando el corte toca el centinela: el DDL de #238
  // se midió contra Fabric VEINTE MINUTOS DESPUÉS de empujar el tag 0.21.0. La medición salió limpia,
  // y eso es exactamente lo que la vuelve peligrosa: el orden estuvo mal y el resultado no lo delató.
  // Que el centinela viva acá quita la dependencia de que alguien se acuerde.
  //
  // Mide lo que «aceptar el DDL» no basta para decir (#197): que el SKU acepte las 3 sentencias, que
  // sean idempotentes de verdad, que el descubrimiento del serving lo ENCUENTRE, que `sys` corrobore
  // la máscara, que el sujeto CON capacidad lea el valor esperado —control positivo del instrumento—
  // y que sin centinela el descubrimiento diga `uninstrumented` en vez de mentir.
  seccion('P10 (#238) · El centinela de desenmascarado: ¿lo acepta el SKU, y SIRVE lo que promete?')
  hallazgo(`centinela emitido: ${CENTINELA.qualifiedName} · columna ${CENTINELA.column} · valor esperado '${CENTINELA.expectedValue}'`)
  // Las dos mitades del instrumento viven en módulos distintos —el EMISOR en el compilador, el LECTOR
  // en el serving— y si divergen el gate mide otra cosa que la que se instaló, sin decirlo. Cuesta dos
  // comparaciones de strings y no necesita motor.
  ok(CENTINELA.probeSQL === unmaskProbeReadSQL('dbo'), 'el SQL de sondeo del EMISOR y el del SERVING son el mismo byte a byte')
  ok(CENTINELA.expectedValue === UNMASK_PROBE_EXPECTED, `el valor esperado por el emisor y por el serving coincide ('${UNMASK_PROBE_EXPECTED}')`)
  // C0 · el estado `uninstrumented`, ANTES de instalar: sin centinela el descubrimiento no miente.
  // Nótese que P1 ya lo instaló (el emisor lo mete en `setupSQL` cuando hay plano de columna), así que
  // esto además prueba que `dropSQL` retira de verdad — y el retiro se VERIFICA midiendo, no se supone
  // porque la sentencia no dio error.
  await intentar(admin, CENTINELA.dropSQL)
  const vacio = await admin.request().query(UNMASK_PROBE_SCHEMAS_SQL)
  ok(
    vacio.recordset.length === 0,
    `retirado con dropSQL, el descubrimiento del serving devuelve ${vacio.recordset.length} filas ⇒ 'uninstrumented' honesto`,
  )
  // C1 · ¿acepta el SKU las 3 sentencias EMITIDAS?
  for (const [i, stmt] of CENTINELA.setupSQL.entries()) {
    const r = await intentar(admin, stmt)
    ok(r.ok, `[${i + 1}/${CENTINELA.setupSQL.length}] ${stmt.split('\n')[0].slice(0, 78)}${r.ok ? '' : ` — ${r.error}`}`)
    if (!r.ok) hallazgo(`RECHAZO EXACTO DE FABRIC: ${r.error}`)
  }
  // C2 · idempotencia REAL: el centinela es crear-si-falta a propósito (no tira-y-recrea), porque
  // conexiones vivas de otros PIs lo sondean. Correrlo dos veces no puede duplicar la fila.
  for (const stmt of CENTINELA.setupSQL) {
    const r = await intentar(admin, stmt)
    if (!r.ok) ok(false, `la SEGUNDA pasada del centinela rompió: ${r.error}`)
  }
  const nProbe = await admin.request().query(`SELECT COUNT(*) AS n FROM ${CENTINELA.qualifiedName}`)
  ok(Number((nProbe.recordset[0] as { n: number }).n) === 1, `tras DOS pasadas la tabla sigue con UNA fila: ${(nProbe.recordset[0] as { n: number }).n}`)
  // C3 · ¿lo encuentra el descubrimiento que corre el serving, y corrobora `sys` la máscara?
  const hallado = (await admin.request().query(UNMASK_PROBE_SCHEMAS_SQL)).recordset as { sch: string }[]
  ok(hallado.some((r) => r.sch === 'dbo'), `el descubrimiento lo encuentra en: [${hallado.map((r) => r.sch).join(', ')}]`)
  const maskedProbe = await admin
    .request()
    .query(`SELECT name, is_masked FROM sys.masked_columns WHERE object_id = OBJECT_ID(N'${CENTINELA.qualifiedName}')`)
  ok(maskedProbe.recordset.length === 1, `sys corrobora la máscara del centinela: ${JSON.stringify(maskedProbe.recordset)}`)
  // C4 · el instrumento ante los dos sujetos. El admin es el CONTROL POSITIVO: si el que tiene
  // capacidad no lee el valor esperado, el centinela no mide nada y ningún veredicto sobre el SP vale.
  const leerCentinela = async (pool: sql.ConnectionPool, quien: string): Promise<string | null> => {
    try {
      const r = (await pool.request().query(unmaskProbeReadSQL('dbo'))).recordset as { probe: string }[]
      const v = String(r[0]?.['probe'] ?? '')
      console.log(`  · ${quien} lee ${JSON.stringify(v)} ⇒ ${v === UNMASK_PROBE_EXPECTED ? 'capable' : 'incapable'}`)
      return v
    } catch (e) {
      console.log(`  · ${quien}: la lectura FALLÓ ⇒ 'no pude medir' (${(e as Error).message.split('\n')[0].slice(0, 60)})`)
      return null
    }
  }
  const vAdmin = await leerCentinela(admin, 'ADMIN (tiene UNMASK)')
  ok(vAdmin === UNMASK_PROBE_EXPECTED, 'CONTROL POSITIVO DEL INSTRUMENTO · el sujeto CON capacidad lee el valor esperado')
  if (!cred.token) {
    noMedido('sin credencial del SP el centinela no se lee con el sujeto que sirve — el estado del serving queda sin medir')
  } else {
    const sp2 = await conectar(cred.token)
    const vSp = await leerCentinela(sp2, 'SP de serving       ')
    if (vSp === null) {
      noMedido('la lectura del centinela por el SP falló: es indeterminación, jamás un veredicto de capacidad')
    } else {
      hallazgo(
        vSp === UNMASK_PROBE_EXPECTED
          ? "el SP lee el valor ⇒ 'capable': el gate de #238 lo dejaría servir un PI con reglas de columna."
          : `el SP lee ${JSON.stringify(vSp)} ⇒ 'incapable': el gate de #238 lo declara NO SERVIBLE, y eso es lo correcto.`,
      )
      hallazgo('Este dato vale para el rol vigente AHORA en el plano de datos, no para el rol declarado en el plano de control.')
    }
    await sp2.close()
  }
  // C5 · LIMPIEZA VERIFICADA MIDIENDO. El centinela se deja instalado a propósito —es infraestructura
  // compartida por schema y el `teardownSQL` del emisor NO lo retira, por diseño (retirarlo al
  // desinstalar UNA tabla dejaría ciegas a las demás)—, así que lo que se verifica es que quede en el
  // MISMO estado en que el `setupSQL` emitido lo deja, y que el retiro explícito funcione de verdad.
  const trasDrop = await intentar(admin, CENTINELA.dropSQL)
  const verifDrop = await admin.request().query(UNMASK_PROBE_SCHEMAS_SQL)
  ok(
    trasDrop.ok && verifDrop.recordset.length === 0,
    `el retiro explícito se VERIFICA leyendo el descubrimiento: ${verifDrop.recordset.length} filas${trasDrop.ok ? '' : ` (el cliente reportó: ${trasDrop.error})`}`,
  )
  for (const stmt of CENTINELA.setupSQL) await intentar(admin, stmt)
  const reinstalado = await admin.request().query(UNMASK_PROBE_SCHEMAS_SQL)
  ok(reinstalado.recordset.length >= 1, 'el terreno queda como el `setupSQL` emitido lo deja: centinela instalado (compartido por schema, a propósito)')

  await admin.close()

  const veredicto = fallos > 0 ? `❌ ${fallos} fallo(s)` : indeterminaciones > 0 ? '⚠ sin fallos, pero con indeterminación' : '✅ Sin fallos'
  console.log(`\n${veredicto} · ${hallazgos} hallazgo(s) · ${indeterminaciones} sin medir\n`)
  if (indeterminaciones > 0) {
    console.log('Lo que NO se midió no es un verde: revisar las líneas ⚠ antes de citar cualquier resultado de esta corrida.\n')
  }
  process.exit(fallos > 0 ? 1 : indeterminaciones > 0 ? 3 : 0)
}

main().catch((e) => {
  console.error('FALLO DE LA SONDA:', (e as Error).message)
  process.exit(2)
})
