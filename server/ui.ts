/**
 * Helpers compartidos de las superficies SSR de gestión (Administración + configuración por-PI):
 * shell de página con tema, lectura de formularios urlencoded, respuestas y CSRF. Mismo lenguaje
 * visual que el índice de Vergis.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac } from 'node:crypto'
import { escapeHtml } from '@vergis/capabilities'
import { constantTimeEqual } from './annotations'

/** CSS del avatar de identidad (menú arriba-derecha). Compartido por las superficies de admin y el
 * catálogo, para que ambas usen el mismo marco. Referencia las mismas CSS vars (--card/--accent/…). */
export const AVATAR_CSS = `
.avm{position:fixed;top:16px;right:18px;z-index:20}
.av{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;background:var(--accent);color:#1d2021;font-weight:700;font-size:12px;cursor:pointer;list-style:none;user-select:none}
.av::-webkit-details-marker{display:none}.av::marker{content:""}
.avmenu{position:absolute;right:0;top:42px;background:var(--card);border:1px solid var(--border);border-radius:11px;padding:6px;min-width:188px;box-shadow:0 10px 30px rgba(0,0,0,.28)}
.avmenu a,.avmenu button{display:block;width:100%;text-align:left;padding:8px 11px;border-radius:7px;color:var(--fg);font-size:13px;background:none;border:none;cursor:pointer;font-family:inherit;text-decoration:none}
.avmenu a:hover,.avmenu button:hover{background:var(--bg);text-decoration:none}
.avhead{font-size:11px;color:var(--muted);padding:6px 11px 8px;border-bottom:1px solid var(--border);margin-bottom:4px;word-break:break-all}
.avhead .avrole{display:block;margin-top:4px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--accent);opacity:.9;word-break:normal}
.avmenu .sep{border-top:1px solid var(--border);margin:4px 0}`

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
input[type=file]{padding:5px 8px;font-size:12px;color:var(--muted);max-width:250px;cursor:pointer}
input[type=file]::file-selector-button{font:inherit;font-weight:600;font-size:12px;background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px 12px;margin-right:10px;cursor:pointer}
input[type=file]::file-selector-button:hover{border-color:var(--accent);color:var(--accent)}
button{cursor:pointer;border:none;border-radius:7px;padding:9px 15px;font-size:13px;font-weight:600;font-family:inherit}
.add{background:var(--accent);color:#1d2021}.del{background:transparent;color:var(--err);border:1px solid var(--err);padding:5px 11px}
.edit{margin-right:10px;font-size:13px}.cancel{align-self:center;color:var(--muted)}.actions{display:flex;gap:14px;align-items:center}
.msg{padding:11px 14px;border-radius:8px;font-size:14px}.msg.err{background:color-mix(in srgb,var(--err) 16%,transparent);color:var(--err);border:1px solid var(--err)}
.msg.ok{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);border:1px solid var(--accent)}
code{font-family:ui-monospace,Menlo,monospace;font-size:.92em}
.tsw{position:fixed;top:18px;right:18px;background:none;border:none;color:var(--muted);cursor:pointer;opacity:.6}.tsw:hover{opacity:1;color:var(--accent)}
.ro{opacity:.55}
body.adm{display:flex;padding:0;max-width:none;min-height:100vh}
.side{width:214px;flex:none;background:var(--card);border-right:1px solid var(--border);padding:22px 14px;box-sizing:border-box}
.side .bca{font-size:11px;color:var(--muted);margin-bottom:16px;display:block;padding:0 6px}
.side a{display:block;padding:7px 10px;border-radius:7px;color:var(--fg);font-size:13px;margin:2px 0}
.side a:hover{background:var(--bg);text-decoration:none}
.side a.on{background:var(--accent);color:#1d2021;font-weight:600}.side a.on .c{color:#1d2021}
.side .grp{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:18px 0 5px 10px}
.side .catlink{color:var(--muted);font-size:12px;border-bottom:1px solid var(--border);border-radius:0;margin:0 0 8px;padding:0 10px 10px}.side .catlink:hover{color:var(--accent);background:none}
.side a.l2{padding-left:24px;font-size:12.5px}.side a.l3{padding-left:38px;font-size:12px;color:var(--muted)}
.side a.l2.on,.side a.l3.on{color:#1d2021}html[data-theme="blanco"] .side a.l2.on,html[data-theme="blanco"] .side a.l3.on{color:#fff}
.main{flex:1;padding:32px 44px;max-width:880px;box-sizing:border-box}
.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 4px}
.tile{background:var(--card);border:1px solid var(--border);border-radius:11px;padding:14px 18px;min-width:96px}
.tile .n{font-size:26px;font-weight:700;line-height:1.1}.tile .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:6px}
.tile.warn{border-color:var(--err)}.tile.warn .n{color:var(--err)}
/* ── Miranda · superficie de chat (server-rendered, sin framework) ── */
body.chat{max-width:1180px}
.mir-cols{display:grid;grid-template-columns:minmax(0,1fr) auto 380px;gap:30px;align-items:start;margin-top:6px}
.mir-conv{display:flex;flex-direction:column;min-width:0}
.mir-thread{display:flex;flex-direction:column;gap:16px;padding:4px 2px}
.turn{display:flex;gap:10px;align-items:flex-start;max-width:82%}
.turn--miranda{align-self:flex-start}
.turn--you{align-self:flex-end;flex-direction:row-reverse}
.turn .av2{width:30px;height:30px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;line-height:1;box-sizing:border-box;margin-top:18px}
.turn--miranda .av2{background:var(--card);border:1px solid var(--border);color:var(--muted)}
.turn--you .av2{background:var(--accent);color:#1d2021}
.turn-b{display:flex;flex-direction:column;min-width:0}
.turn--you .turn-b{align-items:flex-end}
.turn .cap{font-size:11px;color:var(--muted);margin:0 6px 4px;letter-spacing:.02em}
.bubble{padding:10px 14px;border-radius:15px;line-height:1.55;border:1px solid var(--border);font-size:14px;word-wrap:break-word;overflow-wrap:anywhere}
.bubble>:first-child{margin-top:0}.bubble>:last-child{margin-bottom:0}
.bubble p{margin:0 0 8px}.bubble ul,.bubble ol{margin:6px 0;padding-left:20px}.bubble li{margin:2px 0}
.bubble code{background:color-mix(in srgb,var(--muted) 20%,transparent);padding:1px 4px;border-radius:5px}
.turn--miranda .bubble{background:var(--card);border-bottom-left-radius:5px}
.turn--you .bubble{background:color-mix(in srgb,var(--accent) 14%,transparent);border-color:color-mix(in srgb,var(--accent) 30%,var(--border));border-bottom-right-radius:5px}
/* Traza de tools: separador discreto (summary) que abre el detalle por paso (disclosure nativo, sin JS). */
.trace-d{margin:2px 8px}
.trace{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:11.5px}
summary.trace{cursor:pointer;list-style:none}
summary.trace::-webkit-details-marker{display:none}
summary.trace::before,summary.trace::after{content:"";flex:1;height:1px;background:var(--border);opacity:.55}
summary.trace .chev{transition:transform .15s ease;display:inline-block;flex:none}
.trace-d[open]>summary.trace .chev{transform:rotate(90deg)}
.trace-body{margin:9px 2px 2px;display:flex;flex-direction:column;gap:10px}
.trace-step{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:9px 12px;font-size:12px}
.trace-tool{font-weight:600;margin-bottom:4px}
.trace-tool code{background:color-mix(in srgb,var(--muted) 20%,transparent);padding:1px 6px;border-radius:5px}
.trace-k{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin:7px 0 2px}
.trace-step pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;color:var(--fg);max-height:280px;overflow:auto}
.mir-empty{color:var(--muted);font-size:13px;text-align:center;padding:34px 0}
.mir-composer{position:sticky;bottom:0;background:var(--bg);padding:14px 0 6px;margin-top:8px}
.mir-composer::before{content:"";position:absolute;left:0;right:0;top:-20px;height:20px;background:linear-gradient(to top,var(--bg),transparent);pointer-events:none}
.mir-send{display:flex;gap:10px;align-items:flex-end;background:var(--card);border:1px solid var(--border);border-radius:15px;padding:8px 8px 8px 12px}
.mir-send textarea{flex:1;background:transparent;border:none;color:var(--fg);font-family:inherit;font-size:14px;line-height:1.5;resize:none;padding:6px 4px;min-height:38px;max-height:180px;box-sizing:border-box}
.mir-send textarea:focus{outline:none}
.mir-send button{flex:none}
/* Turno asíncrono: burbuja «pensando» (puntos animados CSS-only) mientras el turno corre en background. */
.mir-thinking .bubble{display:inline-flex;align-items:center;gap:5px;color:var(--muted)}
.mir-dots{display:inline-flex;gap:4px}
.mir-dots i{width:6px;height:6px;border-radius:50%;background:var(--muted);display:inline-block;animation:mir-blink 1.2s infinite ease-in-out both}
.mir-dots i:nth-child(2){animation-delay:.2s}
.mir-dots i:nth-child(3){animation-delay:.4s}
@keyframes mir-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
@media (prefers-reduced-motion:reduce){.mir-dots i{animation:none;opacity:.6}}
/* Stepper de progreso del turno (plan 101 etapa A): pasos del pipeline, el actual iluminado, los
   cumplidos visibles; marca el más avanzado alcanzado (no retrocede en un rebote). CSS-only. */
.mir-stepper{display:flex;flex-wrap:wrap;align-items:center;gap:5px 6px;margin:0 0 7px;font-size:11px;line-height:1.6}
.mir-step{color:var(--muted);padding:2px 9px;border-radius:999px;border:1px solid transparent}
.mir-step.is-done{color:var(--fg)}
.mir-step.is-active{color:var(--fg);font-weight:600;border-color:var(--border);background:var(--card)}
.mir-sep{color:var(--muted);opacity:.5;font-size:10px}
/* Composer deshabilitado mientras Miranda responde (legado; en etapa D el composer queda habilitado). */
.mir-composer--busy{opacity:.6}
.mir-composer .mir-busy-note{font-size:12px;color:var(--muted);margin:0 0 8px;text-align:center}
/* Mensaje «en cola» (plan 101 etapa D): recibido durante un turno vivo, pendiente de atender. */
.mir-queued{opacity:.62}
.mir-queued-tag{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:1px 7px}
/* Línea de presupuesto de la sesión — maquinaria, vive en la gaveta (convención work/093). */
.mir-budget{font-size:12px;color:var(--muted);margin:14px 0 2px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:10px}
.mir-budget b{color:var(--fg);font-weight:600}
.mir-budget--warn{color:var(--err)}
.mir-budget--warn b{color:var(--err)}
/* Lienzo (plan 101 etapa C): el reporte embebido es el protagonista de la 2ª columna. */
.mir-canvas{width:100%;height:min(72vh,680px);border:1px solid var(--border);border-radius:12px;background:var(--bg);display:block}
.mir-canvas-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:10px 0 4px}
.mir-canvas-detach{font-size:12px;color:var(--muted)}
.mir-canvas-empty{border:1px dashed var(--border);border-radius:12px;padding:48px 20px;text-align:center;background:var(--card)}
/* Ficha técnica (plan 101 etapa B): sustento a demanda, disclosure cerrado por defecto, con secciones
   legibles (Intención · Verificación · Definición técnica). CSS-only. */
.mir-ficha{margin-top:14px;border:1px solid var(--border);border-radius:12px;background:var(--card)}
.mir-ficha>.mir-ficha-sum{cursor:pointer;list-style:none;padding:11px 14px;font-size:12px;font-weight:600;color:var(--fg);text-transform:uppercase;letter-spacing:.05em;display:flex;align-items:center;gap:8px}
.mir-ficha>.mir-ficha-sum::-webkit-details-marker{display:none}
.mir-ficha>.mir-ficha-sum::before{content:"›";display:inline-block;color:var(--muted);transition:transform .15s ease}
.mir-ficha[open]>.mir-ficha-sum::before{transform:rotate(90deg)}
.mir-ficha[open]>.mir-ficha-sum{border-bottom:1px solid var(--border)}
.mir-ficha-body{padding:6px 16px 16px}
.mir-ficha-sec{padding:14px 0;border-top:1px solid var(--border)}
.mir-ficha-sec:first-child{border-top:none}
.mir-ficha-sec>h3{font-size:11px;margin:0 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.mir-ficha-dsl{overflow:auto;background:var(--bg);border:1px solid var(--border);padding:12px;border-radius:8px;font-size:12px;margin:0}
.mir-intent{position:sticky;top:24px;min-width:0;display:flex;flex-direction:column}
.mir-intent--empty{border:1px dashed var(--border);border-radius:14px;padding:2px 18px 20px;opacity:.75}
/* Gaveta de intención (work/093): divisor punteado = borde de la gaveta + tirador sobre él. CSS-only:
   checkbox oculto (accesible por teclado) + labels; :has() dirige el grid. */
.col-toggle{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;clip:rect(0 0 0 0);clip-path:inset(50%);overflow:hidden;white-space:nowrap}
/* Divisor vertical punteado entre la conversación y la gaveta; se estira a la altura de la fila. */
.mir-divider{align-self:stretch;position:relative;border-left:2px dashed var(--border);margin:6px 0;min-height:60px}
/* Tirador de gaveta anclado sobre el divisor (chevron › = cerrar la gaveta). No vive en la tarjeta. */
.mir-drawer-pull{position:absolute;top:50%;left:-1px;transform:translate(-50%,-50%);z-index:5;display:flex;align-items:center;justify-content:center;width:22px;height:48px;cursor:pointer;user-select:none;background:var(--card);border:1px solid var(--border);border-radius:9px;color:var(--muted);font-size:14px;line-height:1;box-shadow:0 1px 8px rgba(0,0,0,.12)}
.mir-drawer-pull:hover{color:var(--fg);border-color:var(--muted)}
/* Gaveta cerrada: el divisor punteado queda fijo al borde derecho, con su tirador (chevron ‹ = abrir). */
.mir-reopen{display:none;position:fixed;right:0;top:0;bottom:0;width:14px;z-index:20;cursor:pointer;user-select:none;border-left:2px dashed var(--border)}
.mir-reopen .mir-reopen-tab{position:absolute;top:50%;left:-1px;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;width:22px;height:48px;background:var(--card);border:1px solid var(--border);border-radius:9px;color:var(--fg);font-size:14px;line-height:1;box-shadow:0 2px 12px rgba(0,0,0,.14)}
.mir-reopen:hover .mir-reopen-tab{color:var(--accent);border-color:var(--accent)}
.mir-cols:has(> .col-toggle:checked){grid-template-columns:1fr}
.mir-cols:has(> .col-toggle:checked) .mir-intent{display:none}
.mir-cols:has(> .col-toggle:checked) .mir-divider{display:none}
.mir-cols:has(> .col-toggle:checked) .mir-reopen{display:block}
.col-toggle:focus-visible ~ .mir-divider .mir-drawer-pull,.col-toggle:focus-visible ~ .mir-reopen .mir-reopen-tab{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:900px){body.chat{max-width:920px}.mir-cols{grid-template-columns:1fr;gap:16px}.mir-intent{position:static}.turn{max-width:92%}.mir-divider{align-self:auto;border-left:none;border-top:2px dashed var(--border);margin:4px 0;min-height:0;height:0}.mir-drawer-pull{top:-1px;left:50%;transform:translate(-50%,-50%);width:48px;height:22px}}
${AVATAR_CSS}`

/** Shell de página SSR con tema oscuro/blanco persistido. `bodyClass` amplía la vista (p. ej.
 * `chat` para la superficie de Miranda: contenedor ancho). */
export function page(brand: string, title: string, body: string, bodyClass = '', headExtra = ''): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${headExtra}<title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head><body${bodyClass ? ` class="${bodyClass}"` : ''}>
<button type="button" class="tsw" title="Tema" onclick="(function(){var t=document.documentElement.getAttribute('data-theme')==='blanco'?'oscuro':'blanco';document.documentElement.setAttribute('data-theme',t);try{localStorage.setItem('vergis:index-theme',t)}catch(e){}})()">◐</button>
<div class="bc">${escapeHtml(brand)}</div>
<h1>${escapeHtml(title)}</h1>
${body}
<script>(function(){var t='oscuro';try{t=localStorage.getItem('vergis:index-theme')||'oscuro'}catch(e){}document.documentElement.setAttribute('data-theme',t)})();</script>
</body></html>`
}

/** Shell SSR con MENÚ LATERAL + AVATAR (apps de administración). `avatar` = el menú de identidad. */
export function shellNav(brand: string, title: string, sidebar: string, avatar: string, body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head><body class="adm">
${avatar}
<aside class="side">${sidebar}</aside>
<main class="main">
<div class="bc">${escapeHtml(brand)}</div>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
<script>(function(){var t='oscuro';try{t=localStorage.getItem('vergis:index-theme')||'oscuro'}catch(e){}document.documentElement.setAttribute('data-theme',t)})();
document.addEventListener('click',function(e){var d=document.querySelector('details.avm[open]');if(d&&!d.contains(e.target))d.removeAttribute('open')});</script>
</body></html>`
}

/** Toggle de tema reutilizable (item del menú de avatar). */
export const THEME_TOGGLE_JS = "(function(){var t=document.documentElement.getAttribute('data-theme')==='blanco'?'oscuro':'blanco';document.documentElement.setAttribute('data-theme',t);try{localStorage.setItem('vergis:index-theme',t)}catch(e){}})()"

/** Avatar de identidad (menú arriba-derecha) — COMPARTIDO por admin y el catálogo. `<details>` puro,
 * sin JS. El menú gradúa según el rol: Perfil siempre · Gestión si gestiona dominios · Configuración si
 * admin. `signoutRd` = a dónde volver tras cerrar sesión. Requiere AVATAR_CSS en la página. */
export function avatarMenu(opts: {
  email: string
  isAdmin: boolean
  hasDomains: boolean
  /** ¿Mostrar la entrada «Miranda» (el agente que autora specs)? Solo con scope (cluster 077). */
  hasMiranda?: boolean
  signoutRd?: string
}): string {
  const { email, isAdmin, hasDomains } = opts
  const local = email.split('@')[0] || '?'
  const initials = (local.split(/[._-]/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('') || local[0] || '?').toUpperCase()
  const it = (href: string, label: string): string => `<a href="${href}">${escapeHtml(label)}</a>`
  const rd = encodeURIComponent(opts.signoutRd ?? '/admin')
  let m = `<div class="avhead">${escapeHtml(email || '(anónima)')}${isAdmin ? '<span class="avrole">admin</span>' : ''}</div>`
  m += it('/', 'Catálogo de PIs')
  m += `<div class="sep"></div>`
  m += it('/admin/perfil', 'Perfil')
  if (opts.hasMiranda) m += it('/miranda', 'Miranda')
  if (hasDomains) m += it('/admin', 'Gestión')
  if (isAdmin) m += it('/admin/plataforma', 'Configuración')
  m += `<div class="sep"></div>`
  m += `<button type="button" onclick="${THEME_TOGGLE_JS}">◐ Cambiar tema</button>`
  m += `<a href="/oauth2/sign_out?rd=${rd}">Cerrar sesión</a>`
  // Cierre por clic-afuera (el <details> nativo solo cierra al reclicar el summary).
  const closeJs = `<script>(function(){var d=document.querySelector('details.avm');if(!d)return;document.addEventListener('click',function(e){if(d.open&&!d.contains(e.target))d.open=false});document.addEventListener('keydown',function(e){if(e.key==='Escape')d.open=false})})()</script>`
  return `<details class="avm"><summary class="av" title="${escapeHtml(email)}">${escapeHtml(initials)}</summary><div class="avmenu">${m}</div></details>${closeJs}`
}

export class CsrfError extends Error {}

/** Factory de token CSRF firmado por-identidad (mismo secreto del nodo). */
export function csrfFactory(secret: string): (email: string) => string {
  return (email: string) => createHmac('sha256', secret).update(`vergis-csrf|${email}`).digest('hex').slice(0, 24)
}
export function requireCsrf(f: Record<string, string>, token: string): void {
  if (!constantTimeEqual(f['_csrf'] ?? '', token)) throw new CsrfError('Token de formulario inválido (recarga la página).')
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
