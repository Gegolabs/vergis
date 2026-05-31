/**
 * Servidor RLS de Vergis — render POR CONSUMIDOR (paso 5, modo deploy).
 *
 * A diferencia de `serve.ts` (un HTML estático regenerado en timer y servido a todos igual),
 * acá CADA request se renderiza con la identidad del consumidor: el gate (oauth2-proxy) reenvía
 * sus grupos en `X-Forwarded-Groups` → se inyectan como claims a ClickHouse → la ROW POLICY
 * filtra → el dashboard sale segmentado (cada quien ve solo su Área).
 *
 * Lo elige la imagen cuando VERGIS_RLS=1 (ver Dockerfile). Config por entorno:
 *  - VERGIS_SPEC          spec de instancia con `audience.rls` que sirve vía execute-sql-ch.
 *  - VERGIS_CH_URL        HTTP del store ClickHouse (p.ej. http://clickhouse:8123).
 *  - VERGIS_CH_ADMIN_USER / _PASS   usuario admin (bootstrap + ingesta). Default 'default'.
 *  - VERGIS_CH_CONSUMER_USER        usuario data-plane de bajo privilegio. Default 'botler'.
 *  - VERGIS_CH_SCHEMA     JSON {database, table, columns:{col:tipoCH}} del store.
 *  - VERGIS_CH_SEED       (opcional) ruta a JSON [filas] a ingerir al arrancar (datos sintéticos
 *                         o semilla). Sin esto, se asume que otra corriente ingiere.
 *  - VERGIS_REFRESH_MS    (opcional) re-ingesta de la semilla cada N ms.
 *  - PORT                 default 8080.
 */
import { createServer, type ServerResponse } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runSpec } from '@vergis/cli'
import { identityFromHeaders, DEFAULT_GATE_MAPPING, type GateHeaders } from '@vergis/botler'
import { parseSpec } from '@vergis/mira'
import {
  bootstrapClickHouse,
  createIngestClickHouse,
  createExecuteSqlClickHouse,
  type ChStoreSchema,
} from '@vergis/capabilities'
import { compileClickHouse, parseAudience, type Policy } from '@vergis/policy'

const PORT = Number(process.env['PORT'] ?? 8080)
const SPEC = process.env['VERGIS_SPEC'] ?? '/specs/asistencia-diaria-hijuelas-clickhouse.yaml'
const CH_URL = process.env['VERGIS_CH_URL'] ?? 'http://clickhouse:8123'
const ADMIN = { url: CH_URL, user: process.env['VERGIS_CH_ADMIN_USER'] ?? 'default', password: process.env['VERGIS_CH_ADMIN_PASS'] }
const CONSUMER_USER = process.env['VERGIS_CH_CONSUMER_USER'] ?? 'botler'
const REFRESH_MS = Number(process.env['VERGIS_REFRESH_MS'] ?? 0)

const SCHEMA = JSON.parse(process.env['VERGIS_CH_SCHEMA'] ?? '{}') as ChStoreSchema
if (!SCHEMA.database || !SCHEMA.table || !SCHEMA.columns) {
  throw new Error('VERGIS_CH_SCHEMA inválido (esperado {database, table, columns}).')
}

// Enforcement compilado UNA vez desde la audience del spec (specialize-time).
const spec = parseSpec(readFileSync(resolve(SPEC), 'utf8')) as { quality?: { audience?: unknown }; identity?: { display_name?: string } }
const enforcement = compileClickHouse(parseAudience(spec.quality?.audience as Parameters<typeof parseAudience>[0]) as Policy, {
  database: SCHEMA.database,
  table: SCHEMA.table,
  role: process.env['VERGIS_CH_TARGET_ROLE'] ?? 'consumer_role',
})
if (!enforcement) throw new Error('El spec no declara RLS (audience pública); este server espera una policy.')

const botlerProfile = { url: CH_URL, user: CONSUMER_USER, database: SCHEMA.database }

let ready = false
let lastErr: string | null = null

async function sleep(ms: number): Promise<void> {
  // sin timers de test; espera real para el arranque del store
  await new Promise((r) => setTimeout(r, ms))
}

/** Espera a que ClickHouse responda, hace bootstrap idempotente e ingiere la semilla. */
async function bootstrapAndSeed(): Promise<void> {
  // 1 · esperar el store (puede arrancar después que este server)
  for (let i = 0; i < 60; i += 1) {
    try {
      await bootstrapClickHouse(ADMIN, SCHEMA, enforcement)
      break
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      if (i === 59) throw e
      await sleep(2000)
    }
  }
  // 2 · ingesta de la semilla (si la hay)
  await ingestSeed()
  ready = true
  lastErr = null
}

async function ingestSeed(): Promise<void> {
  const seedPath = process.env['VERGIS_CH_SEED']
  if (!seedPath || !existsSync(seedPath)) return
  const rows = JSON.parse(readFileSync(seedPath, 'utf8')) as Record<string, unknown>[]
  const ingest = createIngestClickHouse(ADMIN, SCHEMA)
  const out = (await ingest.execute({ rows }, { agent: 'vergis' })) as { ingested: number }
  console.log(`[vergis-rls] semilla ingerida: ${out.ingested} filas en ${SCHEMA.database}.${SCHEMA.table}`)
}

// Las cabeceras del gate vienen de un server HTTP real → re-decodificar latin1→utf8
// para que los grupos con acento ("Producción") matcheen la policy.
const GATE_MAPPING = { ...DEFAULT_GATE_MAPPING, decodeUtf8: true }

/** Render por-consumidor: los grupos del gate filtran via RLS. */
async function renderForRequest(headers: GateHeaders): Promise<string> {
  const identity = identityFromHeaders(headers, GATE_MAPPING)
  const out = await runSpec({
    specPath: resolve(SPEC),
    identity,
    baseDir: process.env['VERGIS_OUT'] ?? tmpdir(), // el file-channel del spec escribe acá (throwaway); servimos out.html
    extraCapabilities: [createExecuteSqlClickHouse(botlerProfile, enforcement)],
  })
  if (!out.ok) throw new Error(out.fallback?.reason ?? 'render falló')
  return out.html ?? ''
}

function fail(res: ServerResponse, code: number, msg: string): void {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px">
    <h1>${code}</h1><p>${msg}</p></body>`)
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (url === '/healthz') {
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: ready, lastErr, store: `${SCHEMA.database}.${SCHEMA.table}` }))
    return
  }
  if (!ready) return fail(res, 503, 'Inicializando el store…')
  // El gate (oauth2-proxy) ya autenticó y reenvió X-Forwarded-*; acá solo se segmenta por sus grupos.
  renderForRequest(req.headers as GateHeaders)
    .then((html) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    })
    .catch((e) => fail(res, 500, `Error al render por-consumidor: ${e instanceof Error ? e.message : String(e)}`))
})

await bootstrapAndSeed().catch((e) => {
  console.error(`[vergis-rls] bootstrap falló: ${e instanceof Error ? e.message : String(e)}`)
})
if (REFRESH_MS > 0) setInterval(() => void ingestSeed().catch((e) => console.error('[vergis-rls] re-ingesta:', e)), REFRESH_MS)
server.listen(PORT, () => console.log(`[vergis-rls] sirviendo "${spec.identity?.display_name ?? SPEC}" por-consumidor en :${PORT} · store ${CH_URL}`))
