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
  } else {
    ok(true, `la vista responde: ${JSON.stringify(vista)}`)
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

  await admin.close()
  console.log(`\n${fallos === 0 ? '✅ Sin fallos' : `❌ ${fallos} fallo(s)`} · ${hallazgos} hallazgo(s) registrados\n`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FALLO DE LA SONDA:', (e as Error).message)
  process.exit(2)
})
