/**
 * Helpers compartidos de las superficies SSR de gestión (Administración + configuración por-PI):
 * shell de página con tema, lectura de formularios urlencoded, respuestas y CSRF. Mismo lenguaje
 * visual que el índice de Vergis.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac } from 'node:crypto'
import { escapeHtml } from '@vergis/capabilities'

export const PAGE_CSS = `
:root{--bg:#1d2021;--fg:#ebdbb2;--card:#3c3836;--border:#504945;--accent:#b8bb26;--muted:#928374;--err:#fb4934}
html[data-theme="blanco"]{--bg:#fff;--fg:#1f2937;--card:#f8fafc;--border:#e2e8f0;--accent:#2563eb;--muted:#94a3b8;--err:#dc2626}
body{font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:40px;max-width:920px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.bc{color:var(--muted);font-size:12px;margin-bottom:18px}
ul.cards{list-style:none;padding:0;max-width:620px}ul.cards li{padding:13px 16px;margin:8px 0;background:var(--card);border:1px solid var(--border);border-radius:10px}
ul.cards li a{display:flex;gap:10px;align-items:baseline}.c{font-family:ui-monospace,Menlo,monospace;color:var(--accent);font-weight:700}
.sub{color:var(--muted);font-size:12px;margin-top:3px}
table{width:100%;border-collapse:collapse;margin:6px 0;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}td.r,th:last-child{text-align:right}td.r form{display:inline}
.tag{font-size:11px;background:var(--border);color:var(--fg);padding:2px 7px;border-radius:10px}
form.row{display:flex;gap:8px;align-items:center;max-width:560px;flex-wrap:wrap}form.grid{display:flex;flex-direction:column;gap:12px;max-width:520px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px}
.fld{display:flex;flex-direction:column;gap:5px}.fld span{font-size:12px;color:var(--muted)}.fld input[type=checkbox]{width:18px;height:18px}
input,select{background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:7px;padding:9px 11px;font-size:14px;font-family:inherit}
input[readonly]{opacity:.6}
button{cursor:pointer;border:none;border-radius:7px;padding:9px 15px;font-size:13px;font-weight:600;font-family:inherit}
.add{background:var(--accent);color:#1d2021}.del{background:transparent;color:var(--err);border:1px solid var(--err);padding:5px 11px}
.edit{margin-right:10px;font-size:13px}.cancel{align-self:center;color:var(--muted)}.actions{display:flex;gap:14px;align-items:center}
.msg{padding:11px 14px;border-radius:8px;font-size:14px}.msg.err{background:color-mix(in srgb,var(--err) 16%,transparent);color:var(--err);border:1px solid var(--err)}
.msg.ok{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);border:1px solid var(--accent)}
code{font-family:ui-monospace,Menlo,monospace;font-size:.92em}
.tsw{position:fixed;top:18px;right:18px;background:none;border:none;color:var(--muted);cursor:pointer;opacity:.6}.tsw:hover{opacity:1;color:var(--accent)}
.ro{opacity:.55}`

/** Shell de página SSR con tema oscuro/blanco persistido. */
export function page(brand: string, title: string, body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head><body>
<button type="button" class="tsw" title="Tema" onclick="(function(){var t=document.documentElement.getAttribute('data-theme')==='blanco'?'oscuro':'blanco';document.documentElement.setAttribute('data-theme',t);try{localStorage.setItem('vergis:index-theme',t)}catch(e){}})()">◐</button>
<div class="bc">${escapeHtml(brand)}</div>
<h1>${escapeHtml(title)}</h1>
${body}
<script>(function(){var t='oscuro';try{t=localStorage.getItem('vergis:index-theme')||'oscuro'}catch(e){}document.documentElement.setAttribute('data-theme',t)})();</script>
</body></html>`
}

export class CsrfError extends Error {}

/** Factory de token CSRF firmado por-identidad (mismo secreto del nodo). */
export function csrfFactory(secret: string): (email: string) => string {
  return (email: string) => createHmac('sha256', secret).update(`vergis-csrf|${email}`).digest('hex').slice(0, 24)
}
export function requireCsrf(f: Record<string, string>, token: string): void {
  if ((f['_csrf'] ?? '') !== token) throw new CsrfError('Token de formulario inválido (recarga la página).')
}

export function readForm(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, string>> {
  return new Promise((resolveBody, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > limit) reject(new Error('formulario demasiado grande'))
    })
    req.on('end', () => {
      const out: Record<string, string> = {}
      for (const [k, v] of new URLSearchParams(data)) out[k] = v
      resolveBody(out)
    })
    req.on('error', reject)
  })
}

export function send(res: ServerResponse, code: number, html: string): void {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}
export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store' })
  res.end()
}
