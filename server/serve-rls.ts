/**
 * Servidor RLS de Vergis — MULTI-PI por nodo, render POR CONSUMIDOR (charter §2a), con SELECTOR DE
 * CONECTOR (motor B ClickHouse | motor C Fabric push-down).
 *
 * Un nodo hospeda N Productos de Información (ruteados por `/<slug>`, índice en `/`). La autorización
 * vive ATADA AL DATO (policy store, autoría por entidad — charter §2c), no en los PIs, que son
 * AUTHZ-BLIND. El consumidor autentica una vez (gate); sus claims se inyectan en cada query; ve solo
 * su porción. Default-deny: dato sin política no se sirve.
 *
 * La LÓGICA DE NEGOCIO es agnóstica del motor; el motor es un CONECTOR (la Capability de query):
 *  - VERGIS_ENGINE=clickhouse (default): motor B. La fuente NO tiene RLS → se replica a un store
 *    ClickHouse (caja negra desechable) que el compilador gobierna con ROW POLICY; serve por
 *    `execute-sql-ch`. Requiere bootstrap + ingesta desde fuente.
 *  - VERGIS_ENGINE=fabric: motor C (push-down). La fuente (Fabric/Azure SQL) YA tiene la RLS nativa
 *    aplicada (SECURITY POLICY, fuera de banda) → NO se replica: serve por `execute-sql-dwh`
 *    enforcing (inyecta los claims con sp_set_session_context). Fail-closed: al arrancar verifica
 *    que cada tabla gobernada tenga RLS nativa habilitada; si falta, NO sirve.
 *
 * Lo elige la imagen con VERGIS_RLS=1 (Dockerfile). Config por entorno:
 *  - VERGIS_ENGINE      clickhouse (default) | fabric
 *  - VERGIS_SPECS_DIR / VERGIS_SPECS / VERGIS_SPEC   specs authz-blind (descubrimiento dinámico)
 *  - VERGIS_POLICIES    policy store (entidad-canónica o legacy por-tabla): política → dataset
 *  - VERGIS_CONNECTIONS perfiles SQL (Service Principal) — requerido en fabric; ingesta en clickhouse
 *  - [clickhouse] VERGIS_DATASETS · VERGIS_CH_URL · VERGIS_CH_ADMIN_USER/_PASS · VERGIS_CH_CONSUMER_USER · VERGIS_CH_TARGET_ROLE · VERGIS_REFRESH_MS
 *  - PORT
 */
import { createServer, type ServerResponse } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { runSpec } from '@vergis/cli'
import { identityFromHeaders, DEFAULT_GATE_MAPPING, type Capability, type ClaimSet, type GateHeaders } from '@vergis/botler'
import { parseSpec } from '@vergis/mira'
import {
  bootstrapClickHouse,
  createIngestClickHouse,
  createExecuteSqlClickHouse,
  createExecuteSqlDwh,
  renderHtmlPiece,
  publicarArtefacto,
  type ChStoreSchema,
  type ChColumnType,
  type SqlConnectionProfile,
} from '@vergis/capabilities'
import {
  claimValues,
  compileClickHouse,
  isPublic,
  parsePolicyStore,
  settingForClaim,
  type ClickHouseEnforcement,
  type Policy,
  type PolicyDecl,
  type PolicyStoreDoc,
} from '@vergis/policy'

const ENGINE = (process.env['VERGIS_ENGINE'] ?? 'clickhouse').toLowerCase()
if (ENGINE !== 'clickhouse' && ENGINE !== 'fabric') throw new Error(`VERGIS_ENGINE inválido: '${ENGINE}' (clickhouse | fabric).`)
const PORT = Number(process.env['PORT'] ?? 8080)
const REFRESH_MS = Number(process.env['VERGIS_REFRESH_MS'] ?? 0)

// El catálogo de serving (hardening, charter §2b): SOLO la Capability enforcing del motor activo.
// En fabric, `execute-sql-dwh` es enforcing PORQUE hay push-down (la RLS vive en la fuente).
const SERVING_CAPS = new Set([ENGINE === 'fabric' ? 'execute-sql-dwh' : 'execute-sql-ch'])

// --- Policy store (data-anchored, autoría por entidad — charter §2c) --------
const store = new Map<string, PolicyDecl>()
for (const p of (process.env['VERGIS_POLICIES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  for (const [ds, pol] of parsePolicyStore(parseYaml(readFileSync(resolve(p), 'utf8')) as PolicyStoreDoc)) store.set(ds, pol)
}

// --- Productos de Información (specs authz-blind, ruteados por slug) ---------
// DESCUBRIMIENTO DINÁMICO re-escaneado por request. Solo specs SERVIBLES (todas sus data-capabilities
// en el catálogo de serving del motor activo) — los demás se omiten (no-bypass).
interface Report { code: string; slug: string; name: string; specPath: string; tables: string[] }
const SPECS_DIR = process.env['VERGIS_SPECS_DIR']
const SPECS_LIST = (process.env['VERGIS_SPECS'] ?? process.env['VERGIS_SPEC'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
if (!SPECS_DIR && SPECS_LIST.length === 0) throw new Error('Falta VERGIS_SPECS_DIR o VERGIS_SPECS.')

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function tablesOf(sql: string): string[] {
  return [...sql.matchAll(/\b(?:from|join)\s+([a-z_][\w]*\.[a-z_][\w]*)/gi)].map((m) => m[1])
}
function specPaths(): string[] {
  if (SPECS_DIR) return readdirSync(resolve(SPECS_DIR)).filter((f) => !f.startsWith('.') && /\.ya?ml$/.test(f)).map((f) => join(resolve(SPECS_DIR), f)).sort()
  return SPECS_LIST.map((p) => resolve(p))
}
function discover(): Report[] {
  const out: Report[] = []
  for (const p of specPaths()) {
    let spec: { identity?: { code?: string; id?: string; display_name?: string }; data?: Record<string, { capability?: string; params?: { sql?: string } }> }
    try { spec = parseSpec(readFileSync(p, 'utf8')) as typeof spec } catch { continue }
    const data = spec.data ?? {}
    const caps = Object.values(data).map((d) => d.capability ?? '')
    if (caps.length === 0 || !caps.every((c) => SERVING_CAPS.has(c))) {
      console.warn(`[vergis-rls] '${p}' no servible bajo engine=${ENGINE} (capability fuera del catálogo: ${caps.join(',')}) — omitido`)
      continue
    }
    const tables = [...new Set(Object.values(data).flatMap((d) => tablesOf(d.params?.sql ?? '')))]
    // GATE DE GOBERNANZA (fail-closed, charter §2b) — crítico en push-down: en Fabric una tabla SIN
    // política devuelve TODAS sus filas (el motor no niega por omisión) → un PI que lea una tabla
    // no-gobernada FUGA. No se sirve un PI a menos que CADA tabla que toca tenga política (rls o
    // grant:all). En clickhouse la seguridad la da el bootstrap (solo existen tablas gobernadas).
    if (ENGINE === 'fabric') {
      const ungoverned = tables.filter((t) => !store.has(t))
      if (ungoverned.length > 0) {
        console.warn(`[vergis-rls] '${p}' no servible: lee tabla(s) sin política → fuga en push-down: ${ungoverned.join(', ')} — omitido`)
        continue
      }
    }
    const code = spec.identity?.code ?? spec.identity?.id ?? 'pi'
    out.push({ code, slug: slugify(code), name: spec.identity?.display_name ?? code, specPath: p, tables })
  }
  return out
}
/** ¿El consumidor puede acceder a algún dato de este PI? (índice per-consumidor) */
function canAccess(table: string, claims: ClaimSet): boolean {
  const policy = store.get(table)
  if (!policy) return false // sin política → deny
  if (isPublic(policy)) return true // grant: all
  return policy.predicates.some((pred) => claimValues(claims, pred.claim).length > 0)
}
function visibleFor(reports: Report[], claims: ClaimSet): Report[] {
  return reports.filter((r) => r.tables.length === 0 || r.tables.some((t) => canAccess(t, claims)))
}

// --- Setup del CONECTOR según el motor --------------------------------------
const connections = process.env['VERGIS_CONNECTIONS']
  ? (JSON.parse(process.env['VERGIS_CONNECTIONS']) as Record<string, SqlConnectionProfile>)
  : null

let ready = false
let lastErr: string | null = null
let servingCap: Capability // la Capability de query enforcing (el conector)
let bootstrapAll: () => Promise<void>

if (ENGINE === 'clickhouse') {
  // --- Motor B: replica gobernada en ClickHouse (bootstrap + ingesta + ROW POLICY) ---
  const CH_URL = process.env['VERGIS_CH_URL'] ?? 'http://clickhouse:8123'
  const ADMIN = { url: CH_URL, user: process.env['VERGIS_CH_ADMIN_USER'] ?? 'default', password: process.env['VERGIS_CH_ADMIN_PASS'] }
  const CONSUMER_USER = process.env['VERGIS_CH_CONSUMER_USER'] ?? 'botler'
  const TARGET_ROLE = process.env['VERGIS_CH_TARGET_ROLE'] ?? 'consumer_role'

  interface DatasetCfg { table: string; columns: Record<string, ChColumnType>; ingest?: { database_ref: string; sql: string }; seed?: Record<string, unknown>[] }
  const DATASETS: DatasetCfg[] = process.env['VERGIS_DATASETS']
    ? ((parseYaml(readFileSync(resolve(process.env['VERGIS_DATASETS']), 'utf8')) as { datasets?: DatasetCfg[] }).datasets ?? [])
    : []
  if (DATASETS.length === 0) throw new Error('engine=clickhouse: falta VERGIS_DATASETS (datasets del nodo).')

  interface BoundDataset { schema: ChStoreSchema; enforcement: ClickHouseEnforcement | null; cfg: DatasetCfg }
  const BOUND: BoundDataset[] = DATASETS.map((cfg) => {
    const [database, table] = cfg.table.split('.')
    if (!database || !table) throw new Error(`Dataset '${cfg.table}' debe ser 'db.tabla'.`)
    const policy = store.get(cfg.table)
    if (!policy) throw new Error(`Sin política para '${cfg.table}' en el policy store. Default-deny: declara la entidad/grant — el dato no se sirve sin política.`)
    const schema: ChStoreSchema = { database, table, columns: cfg.columns }
    return { schema, enforcement: compileClickHouse(policy, { database, table, role: TARGET_ROLE }), cfg }
  })

  const UNION_INJECTIONS = [...new Map(BOUND.flatMap((b) => b.enforcement?.injections ?? []).map((inj) => [inj.setting, inj])).values()]
  const chProfile = { url: CH_URL, user: CONSUMER_USER, database: BOUND[0].schema.database }
  servingCap = createExecuteSqlClickHouse(chProfile, null, { injections: UNION_INJECTIONS })
  const ingestDwh = connections ? createExecuteSqlDwh(connections) : null

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  async function ingestAll(): Promise<void> {
    for (const b of BOUND) {
      const ingest = createIngestClickHouse(ADMIN, b.schema)
      let rows: Record<string, unknown>[] | null = null
      if (b.cfg.ingest && ingestDwh) {
        const out = (await ingestDwh.execute({ database_ref: b.cfg.ingest.database_ref, sql: b.cfg.ingest.sql }, { agent: 'vergis' })) as { rows: Record<string, unknown>[] }
        rows = out.rows
      } else if (b.cfg.seed) rows = b.cfg.seed
      if (rows) {
        const r = (await ingest.execute({ rows }, { agent: 'vergis' })) as { ingested: number }
        console.log(`[vergis-rls] ${b.schema.database}.${b.schema.table}: ${r.ingested} filas`)
      }
    }
  }
  bootstrapAll = async () => {
    for (let i = 0; i < 60; i += 1) {
      try { for (const b of BOUND) await bootstrapClickHouse(ADMIN, b.schema, b.enforcement); break }
      catch (e) { lastErr = e instanceof Error ? e.message : String(e); if (i === 59) throw e; await sleep(2000) }
    }
    await ingestAll()
    ready = true; lastErr = null
  }
  if (REFRESH_MS > 0) setInterval(() => void ingestAll().catch((e) => console.error('[vergis-rls] re-ingesta:', e)), REFRESH_MS)
} else {
  // --- Motor C: push-down a Fabric. La RLS nativa YA está aplicada en la fuente (fuera de banda).
  // No hay store, ni bootstrap, ni ingesta: se consulta la fuente directo, enforcing por SESSION_CONTEXT.
  if (!connections) throw new Error('engine=fabric: falta VERGIS_CONNECTIONS (perfiles SQL del Service Principal).')

  // Inyecciones del nodo = la UNIÓN de los claims de todas las políticas gobernadas (no-public).
  const injections = [
    ...new Map(
      [...store.values()]
        .filter((p): p is Policy => !isPublic(p))
        .flatMap((p) => p.predicates)
        .map((pred) => [settingForClaim(pred.claim), { setting: settingForClaim(pred.claim), claim: pred.claim }]),
    ).values(),
  ]
  const dwh = createExecuteSqlDwh(connections, { injections })
  servingCap = dwh

  // FAIL-CLOSED: cada tabla gobernada que sirva un PI DEBE tener RLS nativa habilitada en la fuente.
  // Sin eso, push-down devolvería todas las filas (fuga). Si falta, no se marca ready.
  bootstrapAll = async () => {
    const needed = new Set<string>()
    for (const r of discover()) for (const t of r.tables) {
      const pol = store.get(t)
      if (pol && !isPublic(pol)) needed.add(t) // schema.table que DEBE estar protegida
    }
    const sysSql =
      `SELECT OBJECT_SCHEMA_NAME(pr.target_object_id) AS sch, OBJECT_NAME(pr.target_object_id) AS tbl ` +
      `FROM sys.security_policies p JOIN sys.security_predicates pr ON pr.object_id = p.object_id WHERE p.is_enabled = 1`
    const protectedTables = new Set<string>()
    for (const ref of Object.keys(connections)) {
      const out = (await dwh.execute({ database_ref: ref, sql: sysSql }, { agent: 'vergis' })) as { rows: { sch: string; tbl: string }[] }
      for (const row of out.rows) protectedTables.add(`${row.sch}.${row.tbl}`)
    }
    const missing = [...needed].filter((t) => !protectedTables.has(t))
    if (missing.length) {
      throw new Error(
        `Fail-closed (engine=fabric): estas tablas gobernadas NO tienen RLS nativa en la fuente: ${missing.join(', ')}. ` +
          `Aplica la SECURITY POLICY (deploy/fabric-pushdown/) antes de servir.`,
      )
    }
    console.log(`[vergis-rls] push-down OK: ${[...needed].length} tabla(s) gobernada(s) con RLS nativa verificada.`)
    ready = true; lastErr = null
  }
}

// Mapeo claim→cabecera CONFIGURABLE: cada instancia trae sus claims en sus cabeceras (el criterio
// de la política decide qué claims importan: `groups`, `viewer_area`, etc.). Formato:
// VERGIS_GATE_CLAIMS="viewer_area:x-forwarded-area,groups:x-forwarded-groups" (default: groups).
// Las cabeceras del gate vienen latin1 → re-decodificar para acentos ("Producción").
const gateClaims = (process.env['VERGIS_GATE_CLAIMS'] ?? 'groups:x-forwarded-groups')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .reduce<Record<string, string>>((acc, pair) => {
    const [claim, header] = pair.split(':').map((s) => s.trim())
    if (claim && header) acc[claim] = header.toLowerCase()
    return acc
  }, {})
const GATE_MAPPING = { ...DEFAULT_GATE_MAPPING, claims: gateClaims, decodeUtf8: true }

async function renderReport(report: Report, headers: GateHeaders): Promise<string> {
  const out = await runSpec({
    specPath: report.specPath,
    identity: identityFromHeaders(headers, GATE_MAPPING),
    baseDir: process.env['VERGIS_OUT'] ?? tmpdir(),
    // HARDENING (charter §2b): catálogo de serving = solo el conector enforcing + render/publish.
    // SIN starters (no `static-data` ni vías crudas) → imposible servir dato no-gobernado.
    registerStarters: false,
    extraCapabilities: [servingCap, renderHtmlPiece, publicarArtefacto],
  })
  if (!out.ok) throw new Error(out.fallback?.reason ?? 'render falló')
  return out.html ?? ''
}

function fail(res: ServerResponse, code: number, msg: string): void {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h1>${code}</h1><p>${msg}</p></body>`)
}

function indexHtml(reports: Report[]): string {
  const items = reports.map((r) => `<li><a href="/${r.slug}"><span class="c">${r.code}</span> ${r.name}</a></li>`).join('')
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vergis · Productos de Información</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#1d2021;color:#ebdbb2;margin:0;padding:40px}
h1{font-size:20px}ul{list-style:none;padding:0;max-width:560px}li a{display:flex;gap:12px;align-items:baseline;padding:14px 16px;margin:8px 0;background:#3c3836;border:1px solid #504945;border-radius:10px;color:#ebdbb2;text-decoration:none}
li a:hover{border-color:#b8bb26}.c{font-family:ui-monospace,Menlo,monospace;color:#b8bb26;font-weight:700}.f{margin-top:24px;color:#a89984;font-size:11px}</style></head>
<body><h1>Productos de Información · Grupo Hijuelas</h1><ul>${items}</ul><div class="f">Powered by Vergis · seguridad por dato (RLS) · motor ${ENGINE}</div></body></html>`
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (url === '/healthz') {
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: ready, engine: ENGINE, lastErr, pi: discover().map((r) => r.slug) }))
    return
  }
  if (!ready) return fail(res, 503, 'Inicializando…')
  const claims = identityFromHeaders(req.headers as GateHeaders, GATE_MAPPING).claims ?? {}
  const all = discover()
  if (url === '/' || url === '') {
    const visible = visibleFor(all, claims) // índice PER-CONSUMIDOR: solo PIs a los que tiene acceso
    if (visible.length === 1) {
      renderReport(visible[0], req.headers as GateHeaders).then((html) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
      }).catch((e) => fail(res, 500, String(e instanceof Error ? e.message : e)))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(indexHtml(visible))
    return
  }
  const slug = url.replace(/^\//, '').replace(/\/$/, '').toLowerCase()
  const report = all.find((r) => r.slug === slug)
  if (!report) return fail(res, 404, `Producto de Información no encontrado. <a href="/">Ver disponibles</a>`)
  renderReport(report, req.headers as GateHeaders)
    .then((html) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    })
    .catch((e) => fail(res, 500, `Error al render por-consumidor: ${e instanceof Error ? e.message : String(e)}`))
})

await bootstrapAll().catch((e) => console.error(`[vergis-rls] bootstrap falló: ${e instanceof Error ? e.message : String(e)}`))
server.listen(PORT, () => {
  const r = discover()
  console.log(`[vergis-rls] engine=${ENGINE} · ${r.length} PI por-consumidor en :${PORT} · rutas: ${r.map((x) => '/' + x.slug).join(' ')}`)
})
