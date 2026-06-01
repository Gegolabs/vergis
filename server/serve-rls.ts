/**
 * Servidor RLS de Vergis — MULTI-REPORTE por nodo, render POR CONSUMIDOR (charter §2a).
 *
 * Un nodo hospeda N reportes (ruteados por `/<slug>`, índice en `/`) sobre UN store ClickHouse
 * compartido. La autorización vive ATADA AL DATO (policy store), no en los reportes — que son
 * AUTHZ-BLIND. El consumidor autentica una vez (gate); sus claims se inyectan en cada query; en
 * todos los reportes ve solo su porción. Default-deny: una tabla sin política no se sirve.
 *
 * Lo elige la imagen con VERGIS_RLS=1 (Dockerfile). Config por entorno:
 *  - VERGIS_SPECS     specs separados por coma (o VERGIS_SPEC para uno). Authz-blind.
 *  - VERGIS_POLICIES  archivo(s) del policy store (data-anchored): política → dataset.
 *  - VERGIS_DATASETS  archivo YAML: {datasets:[{table, columns, ingest?{database_ref,sql} | seed?[]}]}.
 *  - VERGIS_CH_URL · VERGIS_CH_ADMIN_USER/_PASS · VERGIS_CH_CONSUMER_USER · VERGIS_CH_TARGET_ROLE
 *  - VERGIS_CONNECTIONS  perfiles SQL (para ingesta desde fuente). VERGIS_REFRESH_MS · PORT.
 */
import { createServer, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { runSpec } from '@vergis/cli'
import { identityFromHeaders, DEFAULT_GATE_MAPPING, type GateHeaders } from '@vergis/botler'
import { parseSpec } from '@vergis/mira'
import {
  bootstrapClickHouse,
  createIngestClickHouse,
  createExecuteSqlClickHouse,
  createExecuteSqlDwh,
  type ChStoreSchema,
  type ChColumnType,
  type SqlConnectionProfile,
} from '@vergis/capabilities'
import { compileClickHouse, parsePolicyStore, type ClickHouseEnforcement, type PolicyDecl, type PolicyStoreDoc } from '@vergis/policy'

const PORT = Number(process.env['PORT'] ?? 8080)
const CH_URL = process.env['VERGIS_CH_URL'] ?? 'http://clickhouse:8123'
const ADMIN = { url: CH_URL, user: process.env['VERGIS_CH_ADMIN_USER'] ?? 'default', password: process.env['VERGIS_CH_ADMIN_PASS'] }
const CONSUMER_USER = process.env['VERGIS_CH_CONSUMER_USER'] ?? 'botler'
const TARGET_ROLE = process.env['VERGIS_CH_TARGET_ROLE'] ?? 'consumer_role'
const REFRESH_MS = Number(process.env['VERGIS_REFRESH_MS'] ?? 0)

// --- Reportes (specs authz-blind, ruteados por slug) ------------------------
interface Report { code: string; slug: string; name: string; specPath: string }
function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
const SPEC_PATHS = (process.env['VERGIS_SPECS'] ?? process.env['VERGIS_SPEC'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
if (SPEC_PATHS.length === 0) throw new Error('Falta VERGIS_SPECS (o VERGIS_SPEC).')
const REPORTS: Report[] = SPEC_PATHS.map((p) => {
  const specPath = resolve(p)
  const spec = parseSpec(readFileSync(specPath, 'utf8')) as { identity?: { code?: string; id?: string; display_name?: string } }
  const code = spec.identity?.code ?? spec.identity?.id ?? 'report'
  return { code, slug: slugify(code), name: spec.identity?.display_name ?? code, specPath }
})

// --- Policy store (data-anchored): política ATADA AL DATO --------------------
const store = new Map<string, PolicyDecl>()
for (const p of (process.env['VERGIS_POLICIES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  for (const [ds, pol] of parsePolicyStore(parseYaml(readFileSync(resolve(p), 'utf8')) as PolicyStoreDoc)) store.set(ds, pol)
}

// --- Datasets del nodo (tabla → columnas + ingesta) -------------------------
interface DatasetCfg {
  table: string // db.table
  columns: Record<string, ChColumnType>
  ingest?: { database_ref: string; sql: string }
  seed?: Record<string, unknown>[]
}
const DATASETS: DatasetCfg[] = process.env['VERGIS_DATASETS']
  ? ((parseYaml(readFileSync(resolve(process.env['VERGIS_DATASETS']), 'utf8')) as { datasets?: DatasetCfg[] }).datasets ?? [])
  : []
if (DATASETS.length === 0) throw new Error('Falta VERGIS_DATASETS (datasets del nodo).')

// Cada dataset: su política (del store, fail-closed si falta), su schema y su ingesta.
interface BoundDataset { schema: ChStoreSchema; enforcement: ClickHouseEnforcement | null; cfg: DatasetCfg }
const BOUND: BoundDataset[] = DATASETS.map((cfg) => {
  const [database, table] = cfg.table.split('.')
  if (!database || !table) throw new Error(`Dataset '${cfg.table}' debe ser 'db.tabla'.`)
  const policy = store.get(cfg.table)
  if (!policy) {
    throw new Error(`Sin política para el dataset '${cfg.table}' en el policy store. Default-deny: declara 'rls: [...]' o 'grant: all' — el dato no se sirve sin política.`)
  }
  const schema: ChStoreSchema = { database, table, columns: cfg.columns }
  const enforcement = compileClickHouse(policy, { database, table, role: TARGET_ROLE })
  return { schema, enforcement, cfg }
})

// Unión de inyecciones de TODAS las políticas → un solo canal de claims para todos los reportes.
const UNION_INJECTIONS = [
  ...new Map(
    BOUND.flatMap((b) => b.enforcement?.injections ?? []).map((inj) => [inj.setting, inj]),
  ).values(),
]
const chProfile = { url: CH_URL, user: CONSUMER_USER, database: BOUND[0].schema.database }
const execSqlCh = createExecuteSqlClickHouse(chProfile, null, { injections: UNION_INJECTIONS })

// Ingesta desde fuente (Fabric) si hay conexiones; si no, semilla inline (dev).
const connections = process.env['VERGIS_CONNECTIONS']
  ? (JSON.parse(process.env['VERGIS_CONNECTIONS']) as Record<string, SqlConnectionProfile>)
  : null
const dwh = connections ? createExecuteSqlDwh(connections) : null

let ready = false
let lastErr: string | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function bootstrapAll(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      for (const b of BOUND) await bootstrapClickHouse(ADMIN, b.schema, b.enforcement)
      break
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      if (i === 59) throw e
      await sleep(2000)
    }
  }
  await ingestAll()
  ready = true
  lastErr = null
}

async function ingestAll(): Promise<void> {
  for (const b of BOUND) {
    const ingest = createIngestClickHouse(ADMIN, b.schema)
    let rows: Record<string, unknown>[] | null = null
    if (b.cfg.ingest && dwh) {
      const out = (await dwh.execute({ database_ref: b.cfg.ingest.database_ref, sql: b.cfg.ingest.sql }, { agent: 'vergis' })) as { rows: Record<string, unknown>[] }
      rows = out.rows
    } else if (b.cfg.seed) {
      rows = b.cfg.seed
    }
    if (rows) {
      const r = (await ingest.execute({ rows }, { agent: 'vergis' })) as { ingested: number }
      console.log(`[vergis-rls] ${b.schema.database}.${b.schema.table}: ${r.ingested} filas`)
    }
  }
}

// Las cabeceras del gate vienen latin1 → re-decodificar para acentos ("Producción").
const GATE_MAPPING = { ...DEFAULT_GATE_MAPPING, decodeUtf8: true }

async function renderReport(report: Report, headers: GateHeaders): Promise<string> {
  const out = await runSpec({
    specPath: report.specPath,
    identity: identityFromHeaders(headers, GATE_MAPPING),
    baseDir: process.env['VERGIS_OUT'] ?? tmpdir(),
    extraCapabilities: [execSqlCh],
  })
  if (!out.ok) throw new Error(out.fallback?.reason ?? 'render falló')
  return out.html ?? ''
}

function fail(res: ServerResponse, code: number, msg: string): void {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h1>${code}</h1><p>${msg}</p></body>`)
}

function indexHtml(): string {
  const items = REPORTS.map((r) => `<li><a href="/${r.slug}"><span class="c">${r.code}</span> ${r.name}</a></li>`).join('')
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vergis · Reportes</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#1d2021;color:#ebdbb2;margin:0;padding:40px}
h1{font-size:20px}ul{list-style:none;padding:0;max-width:560px}li a{display:flex;gap:12px;align-items:baseline;padding:14px 16px;margin:8px 0;background:#3c3836;border:1px solid #504945;border-radius:10px;color:#ebdbb2;text-decoration:none}
li a:hover{border-color:#b8bb26}.c{font-family:ui-monospace,Menlo,monospace;color:#b8bb26;font-weight:700}.f{margin-top:24px;color:#a89984;font-size:11px}</style></head>
<body><h1>Reportes · Grupo Hijuelas</h1><ul>${items}</ul><div class="f">Powered by Vergis · seguridad por dato (RLS)</div></body></html>`
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (url === '/healthz') {
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: ready, lastErr, reports: REPORTS.map((r) => r.slug), datasets: BOUND.map((b) => `${b.schema.database}.${b.schema.table}`) }))
    return
  }
  if (!ready) return fail(res, 503, 'Inicializando el store…')
  if (url === '/' || url === '') {
    if (REPORTS.length === 1) {
      renderReport(REPORTS[0], req.headers as GateHeaders).then((html) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
      }).catch((e) => fail(res, 500, String(e instanceof Error ? e.message : e)))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(indexHtml())
    return
  }
  const slug = url.replace(/^\//, '').replace(/\/$/, '').toLowerCase()
  const report = REPORTS.find((r) => r.slug === slug)
  if (!report) return fail(res, 404, `Reporte no encontrado. <a href="/">Ver reportes</a>`)
  renderReport(report, req.headers as GateHeaders)
    .then((html) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    })
    .catch((e) => fail(res, 500, `Error al render por-consumidor: ${e instanceof Error ? e.message : String(e)}`))
})

await bootstrapAll().catch((e) => console.error(`[vergis-rls] bootstrap falló: ${e instanceof Error ? e.message : String(e)}`))
if (REFRESH_MS > 0) setInterval(() => void ingestAll().catch((e) => console.error('[vergis-rls] re-ingesta:', e)), REFRESH_MS)
server.listen(PORT, () =>
  console.log(`[vergis-rls] ${REPORTS.length} reporte(s) por-consumidor en :${PORT} · rutas: ${REPORTS.map((r) => '/' + r.slug).join(' ')} · store ${CH_URL}`),
)
