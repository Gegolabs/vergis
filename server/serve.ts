/**
 * Servidor de despliegue de Vergis — UN solo app sirve MÚLTIPLES reportes, ruteados
 * por código (/<slug>). Cada reporte es un spec; el código vive en identity.code.
 * Regenera todos cada N minutos. Detrás de Basic Auth (gate temporal) / Easy Auth.
 * Secretos (perfil SQL con el Service Principal) por env VERGIS_CONNECTIONS (Key Vault).
 *
 * Config:
 *  - VERGIS_SPECS: rutas de specs separadas por coma (o VERGIS_SPEC para uno solo).
 *  - VERGIS_CONNECTIONS, VERGIS_OUT, PORT, VERGIS_REFRESH_MS, VERGIS_USER/PASS.
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSpec } from '@vergis/cli'
import { parseSpec } from '@vergis/mira'
import type { SqlConnectionProfile } from '@vergis/capabilities'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env['VERGIS_OUT'] ?? '/tmp/vergis'
const PORT = Number(process.env['PORT'] ?? 8080)
const REFRESH_MS = Number(process.env['VERGIS_REFRESH_MS'] ?? 5 * 60 * 1000)
const BASIC_USER = process.env['VERGIS_USER']
const BASIC_PASS = process.env['VERGIS_PASS']

interface Report {
  code: string
  slug: string
  name: string
  specPath: string
  artifact: string // ruta absoluta del HTML generado
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function loadReports(): Report[] {
  const list = (process.env['VERGIS_SPECS'] ?? process.env['VERGIS_SPEC'] ?? resolve(ROOT, 'examples/hello.yaml'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return list.map((p) => {
    const specPath = resolve(p)
    const spec = parseSpec(readFileSync(specPath, 'utf8')) as {
      identity?: { code?: string; id?: string; display_name?: string }
      delivery?: { channels?: { capability?: string; params?: { path?: string } }[] }
    }
    // Server estático: camino dev/demo para PIs sin dato gobernado. El dato gobernado se sirve
    // SOLO por el server RLS (VERGIS_RLS=1), que enforcea contra el policy store (charter §2a).
    const code = spec.identity?.code ?? spec.identity?.id ?? 'report'
    const slug = slugify(code)
    const pub = (spec.delivery?.channels ?? []).find((c) => c.capability === 'publicar-artefacto')
    const file = pub?.params?.path ?? `${slug}.html`
    return { code, slug, name: spec.identity?.display_name ?? code, specPath, artifact: resolve(OUT, file) }
  })
}

const REPORTS = loadReports()

function connections(): Record<string, SqlConnectionProfile> {
  const raw = process.env['VERGIS_CONNECTIONS']
  if (!raw) throw new Error('VERGIS_CONNECTIONS no configurado')
  return JSON.parse(raw) as Record<string, SqlConnectionProfile>
}

let lastOk: string | null = null
let lastErr: string | null = null
let running = false

async function regen(): Promise<void> {
  if (running) return
  running = true
  try {
    const conns = connections()
    for (const r of REPORTS) {
      await runSpec({ specPath: r.specPath, baseDir: OUT, logPath: resolve(OUT, `${r.slug}.log.jsonl`), connections: conns })
    }
    lastOk = new Date().toISOString()
    lastErr = null
    console.log(`[vergis] ${REPORTS.length} reporte(s) regenerado(s) ${lastOk}: ${REPORTS.map((r) => r.code).join(', ')}`)
  } catch (e) {
    lastErr = e instanceof Error ? e.message : String(e)
    console.error(`[vergis] error regenerando: ${lastErr}`)
  } finally {
    running = false
  }
}

function authorized(header: string | undefined): boolean {
  if (!BASIC_USER || !BASIC_PASS) return true
  if (!header || !header.startsWith('Basic ')) return false
  const [u, p] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':')
  return u === BASIC_USER && p === BASIC_PASS
}

function indexHtml(): string {
  const items = REPORTS.map(
    (r) => `<li><a href="/${r.slug}"><span class="c">${r.code}</span> ${r.name}</a></li>`,
  ).join('')
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vergis · Productos de Información</title><style>
body{font-family:-apple-system,system-ui,sans-serif;background:#1d2021;color:#ebdbb2;margin:0;padding:40px}
h1{font-size:20px}ul{list-style:none;padding:0;max-width:560px}
li a{display:flex;gap:12px;align-items:baseline;padding:14px 16px;margin:8px 0;background:#3c3836;border:1px solid #504945;border-radius:10px;color:#ebdbb2;text-decoration:none}
li a:hover{border-color:#b8bb26}.c{font-family:ui-monospace,Menlo,monospace;color:#b8bb26;font-weight:700}
.f{margin-top:24px;color:#a89984;font-size:11px}</style></head>
<body><h1>Productos de Información · Grupo Hijuelas</h1><ul>${items}</ul><div class="f">Powered by Vergis</div></body></html>`
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (url === '/healthz') {
    res.writeHead(lastOk ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: Boolean(lastOk), lastOk, lastErr, reports: REPORTS.map((r) => r.slug) }))
    return
  }
  if (!authorized(req.headers['authorization'])) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Vergis · Grupo Hijuelas", charset="UTF-8"' })
    res.end('Autenticación requerida')
    return
  }
  // Ruta raíz: un reporte → servirlo directo; varios → índice.
  if (url === '/' || url === '') {
    if (REPORTS.length === 1) return serveReport(REPORTS[0], res)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(indexHtml())
    return
  }
  const slug = url.replace(/^\//, '').replace(/\/$/, '').toLowerCase()
  const report = REPORTS.find((r) => r.slug === slug)
  if (!report) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<p>Reporte no encontrado.</p><p><a href="/">Ver reportes</a></p>`)
    return
  }
  serveReport(report, res)
})

function serveReport(report: Report, res: import('node:http').ServerResponse): void {
  if (existsSync(report.artifact)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(report.artifact))
    return
  }
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px">
    <h1>${report.code}</h1><p>Generando…</p>${lastErr ? `<pre>${lastErr}</pre>` : ''}
    <script>setTimeout(()=>location.reload(),5000)</script></body>`)
}

await regen()
setInterval(() => void regen(), REFRESH_MS)
server.listen(PORT, () =>
  console.log(`[vergis] sirviendo ${REPORTS.length} reporte(s) en :${PORT} · refresh ${REFRESH_MS}ms · rutas: ${REPORTS.map((r) => '/' + r.slug).join(' ')}`),
)
