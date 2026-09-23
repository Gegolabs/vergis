/**
 * Helpers compartidos de las superficies SSR de gestión (Administración + configuración por-PI):
 * shell de página con tema, lectura de formularios urlencoded, respuestas y CSRF. Mismo lenguaje
 * visual que el índice de Vergis.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac } from 'node:crypto'
import { escapeHtml } from '@vergis/capabilities'
import { constantTimeEqual } from './http-util'
import type { MenuSection } from './menu-config'

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
.avmenu .sep{border-top:1px solid var(--border);margin:4px 0}
.avmenu .avlbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;padding:6px 11px 2px}`

/**
 * Los TOKENS de color de Mira (#269·§5), un solo origen para toda superficie SSR: el catálogo los
 * importa en vez de duplicarlos. Los siete de siempre más los de estado: `--ok`/`--warn`/`--info`/
 * `--wait` y sus fondos. `--warn` reemplaza al `var(--yellow,#d97706)` que se usaba sin definir.
 */
export const TOKENS_CSS = `:root{--bg:#1d2021;--fg:#ebdbb2;--card:#3c3836;--border:#504945;--accent:#b8bb26;--muted:#928374;--err:#fb4934;--ok:#b8bb26;--warn:#fabd2f;--info:#83a598;--wait:#a89984;--ok-bg:rgba(184,187,38,.14);--warn-bg:rgba(250,189,47,.14);--err-bg:rgba(251,73,52,.14);--info-bg:rgba(131,165,152,.16)}
html[data-theme="blanco"]{--bg:#fff;--fg:#1f2937;--card:#f8fafc;--border:#e2e8f0;--accent:#2563eb;--muted:#94a3b8;--err:#dc2626;--ok:#15803d;--warn:#b45309;--info:#1d4ed8;--wait:#64748b;--ok-bg:#dcfce7;--warn-bg:#fef3c7;--err-bg:#fee2e2;--info-bg:#dbeafe}`

/** CSS de los componentes compartidos de estado (#269·§5): chip, aviso, ficha, zona de subida, fila
 *  de carga, pasos y plegado. Vive en `PAGE_CSS`, así que toda página con `page`/`shellNav` lo tiene. */
export const COMPONENTES_CSS = `
.chip{display:inline-block;font-size:12px;font-weight:700;padding:2px 9px;border-radius:10px;white-space:nowrap}
.chip.t-ok{color:var(--ok);background:var(--ok-bg)}.chip.t-curso{color:var(--info);background:var(--info-bg)}.chip.t-espera{color:var(--wait);background:var(--border)}
.chip.t-atencion{color:var(--warn);background:var(--warn-bg)}.chip.t-error{color:var(--err);background:var(--err-bg)}
.aviso{padding:10px 13px;border-radius:8px;font-size:14px;margin:10px 0;border:1px solid var(--border)}
.aviso.t-ok{color:var(--ok);background:var(--ok-bg);border-color:var(--ok)}.aviso.t-atencion{color:var(--warn);background:var(--warn-bg);border-color:var(--warn)}
.aviso.t-error{color:var(--err);background:var(--err-bg);border-color:var(--err)}.aviso.t-curso{color:var(--info);background:var(--info-bg);border-color:var(--info)}
.ficha{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:6px 16px;margin:10px 0}
.ficha dt{font-weight:700;font-size:13px;margin-top:10px}.ficha dd{margin:3px 0 8px;font-size:14px}
.zona{border:2px dashed var(--border);border-radius:12px;padding:18px;margin:12px 0;background:var(--card)}.zona.sobre{border-color:var(--accent)}
.zona .zt{font-weight:700}.zona input[type=file]{max-width:100%}
.rev{list-style:none;padding:0;margin:10px 0}.rev li{padding:8px 0;border-top:1px solid var(--border);font-size:14px}
.fila{padding:11px 0;border-top:1px solid var(--border)}.fila .ft{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.fila .fn{font-weight:600;word-break:break-all}
.fila .fr{font-size:14px;margin-top:4px}.fila .fx{margin-top:6px}
ol.pasos{margin:4px 0 4px 20px;padding:0;font-size:14px}
details.plegado summary{cursor:pointer;color:var(--muted);font-size:13px}
.tarjetas{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.tarjetas li{background:var(--card);border:1px solid var(--border);border-radius:11px;padding:14px 16px}.tarjetas .tt{font-weight:700}
@media (max-width:640px){body{padding:16px}body.adm{display:block}.side{width:auto;border-right:none;border-bottom:1px solid var(--border)}.main{padding:16px}}`

export const PAGE_CSS = `
${TOKENS_CSS}
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
.tabs{display:flex;flex-wrap:wrap;gap:4px;margin:18px 0 4px;border-bottom:1px solid var(--border)}
.tabs a,.tabs b{display:inline-block;padding:9px 15px;font-size:13px;border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;margin-bottom:-1px}
.tabs a{color:var(--muted)}.tabs a:hover{color:var(--accent);background:var(--card);text-decoration:none}
.tabs b.on{background:var(--card);border-color:var(--border);color:var(--fg);font-weight:700}${AVATAR_CSS}${COMPONENTES_CSS}`

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
 * sin JS. El menú gradúa según el rol: Perfil y Mis impresiones siempre · Gestión si gestiona
 * dominios · Configuración si admin. `signoutRd` = a dónde volver tras cerrar sesión. Requiere
 * AVATAR_CSS en la página.
 *
 * `sections` son las secciones que declaró la INSTANCIA (`VERGIS_MENU`): se renderizan en el orden
 * declarado, cada una con su rótulo, entre los ítems de identidad y el separador del tema. Con cero
 * secciones el menú es byte a byte el de antes. La instancia AGREGA: los ítems del Producto no se
 * mueven ni se reemplazan, y el Producto no sabe qué son los enlaces declarados. */
export function avatarMenu(opts: {
  email: string
  isAdmin: boolean
  hasDomains: boolean
  /** ¿Mostrar la entrada «Miranda» (el agente que autora specs)? Solo con scope (cluster 077). */
  hasMiranda?: boolean
  /** ¿Mostrar la entrada «Consola SQL»? Solo con scope (issue #306): la superficie no se anuncia a
   *  quien no puede abrirla, igual que Miranda. */
  hasConsola?: boolean
  /** Secciones declaradas por la instancia (`VERGIS_MENU`). Vacío o ausente ⇒ el menú de siempre. */
  sections?: MenuSection[]
  signoutRd?: string
  /** #269·§5.1 · ¿La identidad puede subir archivos (gestiona un dominio con tipos de archivo)? Agrega
   *  «Cargar archivos» debajo de «Catálogo de PIs». Ausente ⇒ el menú de siempre. */
  hasCargas?: boolean
}): string {
  const { email, isAdmin, hasDomains } = opts
  const local = email.split('@')[0] || '?'
  const initials = (local.split(/[._-]/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('') || local[0] || '?').toUpperCase()
  const it = (href: string, label: string): string => `<a href="${href}">${escapeHtml(label)}</a>`
  const rd = encodeURIComponent(opts.signoutRd ?? '/admin')
  let m = `<div class="avhead">${escapeHtml(email || '(anónima)')}${isAdmin ? '<span class="avrole">admin</span>' : ''}</div>`
  m += it('/', 'Catálogo de PIs')
  if (opts.hasCargas) m += it('/cargar', 'Cargar archivos')
  m += `<div class="sep"></div>`
  m += it('/admin/perfil', 'Perfil')
  // «Mis impresiones» es universal: la capacidad de anotar existió meses con cero uso porque nadie
  // la veía. Si no está en el menú, no existe (D9).
  m += it('/impresiones', 'Mis impresiones')
  if (opts.hasMiranda) m += it('/miranda', 'Miranda')
  if (opts.hasConsola) m += it('/consola', 'Consola SQL')
  if (hasDomains) m += it('/admin', 'Gestión')
  if (isAdmin) m += it('/admin/plataforma', 'Configuración')
  // Secciones de la instancia. Cero secciones ⇒ ni separador ni rótulo: el menú de una instancia que
  // no declara nada tiene que quedar idéntico al de siempre.
  for (const sec of opts.sections ?? []) {
    if (!sec.links.length) continue
    m += `<div class="sep"></div><div class="avlbl">${escapeHtml(sec.title)}</div>`
    for (const h of sec.links) {
      const attrs = [`href="${escapeHtml(h.href)}"`]
      if (h.description) attrs.push(`title="${escapeHtml(h.description)}"`)
      if (h.newTab) attrs.push('target="_blank"', 'rel="noopener"')
      m += `<a ${attrs.join(' ')}>${escapeHtml(h.label)}</a>`
    }
  }
  m += `<div class="sep"></div>`
  m += `<button type="button" onclick="${THEME_TOGGLE_JS}">◐ Cambiar tema</button>`
  m += `<a href="/oauth2/sign_out?rd=${rd}">Cerrar sesión</a>`
  // Cierre por clic-afuera (el <details> nativo solo cierra al reclicar el summary).
  const closeJs = `<script>(function(){var d=document.querySelector('details.avm');if(!d)return;document.addEventListener('click',function(e){if(d.open&&!d.contains(e.target))d.open=false});document.addEventListener('keydown',function(e){if(e.key==='Escape')d.open=false})})()</script>`
  return `<details class="avm"><summary class="av" title="${escapeHtml(email)}">${escapeHtml(initials)}</summary><div class="avmenu">${m}</div></details>${closeJs}`
}

// ─── Componentes compartidos de estado (#269·§5) ───────────────────────────────
// Presentacionales y puros: reciben texto ya decidido (y ya escapado donde se dice `html`) y lo
// dibujan con los tokens. Qué estado tiene una carga y qué frase le corresponde lo decide quien llama.

/** Los cinco tonos de un estado: listo · en curso · en espera · requiere atención · error. */
export type Tono = 'ok' | 'curso' | 'espera' | 'atencion' | 'error'

/** Chip de estado. `texto` es texto plano (se escapa). */
export const chip = (tono: Tono, texto: string): string => `<span class="chip t-${tono}">${escapeHtml(texto)}</span>`

/** Aviso en bloque (resultado de una acción, advertencia). `html` ya viene escapado. */
export const aviso = (tono: Tono, html: string): string => `<div class="aviso t-${tono}" role="status">${html}</div>`

/** Lista numerada de pasos (texto plano, se escapa cada uno). */
export const pasos = (lista: string[]): string => (lista.length ? `<ol class="pasos">${lista.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ol>` : '')

/** Bloque plegado. `html` ya viene escapado. */
export const plegado = (titulo: string, html: string, id?: string): string =>
  `<details class="plegado"${id ? ` id="${escapeHtml(id)}"` : ''}><summary>${escapeHtml(titulo)}</summary>${html}</details>`

/** Ficha: preguntas con su respuesta. Un bloque sin respuesta no se dibuja. `html` ya escapado. */
export function ficha(bloques: { pregunta: string; html: string | null | undefined }[]): string {
  const b = bloques.filter((x) => x.html)
  return b.length ? `<dl class="ficha">${b.map((x) => `<dt>${escapeHtml(x.pregunta)}</dt><dd>${x.html}</dd>`).join('')}</dl>` : ''
}

/** Una fila de carga: nombre, chip, frase y lo que venga debajo (guía, historia, acción). */
export const filaCarga = (o: { nombre: string; chipHtml: string; cuandoHtml?: string; fraseHtml?: string; extraHtml?: string }): string =>
  `<div class="fila"><div class="ft">${o.chipHtml}<span class="fn">${escapeHtml(o.nombre)}</span>${o.cuandoHtml ? `<span class="sub">${o.cuandoHtml}</span>` : ''}</div>${o.fraseHtml ? `<div class="fr">${o.fraseHtml}</div>` : ''}${o.extraHtml ? `<div class="fx">${o.extraHtml}</div>` : ''}</div>`

/**
 * La zona de subida: arrastrar o elegir, con la línea del máximo. `camposHtml` son los datos que el
 * tipo pide (ya escapados); `ocultos` los campos ocultos del formulario. Sin JS es un formulario normal.
 */
export function zonaSubida(o: { action: string; token: string; maxMb: number; ocultos?: Record<string, string>; camposHtml?: string; id: string }): string {
  const hid = Object.entries(o.ocultos ?? {}).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('')
  return `<form class="zona" id="${escapeHtml(o.id)}" method="post" action="${escapeHtml(o.action)}" enctype="multipart/form-data">
<input type="hidden" name="_csrf" value="${escapeHtml(o.token)}">${hid}
<div class="zt">Arrastra aquí el archivo o elígelo desde tu computador</div>
<div class="sub">Puedes subir varios a la vez (máximo ${escapeHtml(String(o.maxMb))} MB cada uno).</div>
<p><input type="file" name="file" multiple required></p>
<ul class="rev" hidden></ul>
${o.camposHtml ?? ''}
<p><button class="add" type="submit">Subir</button></p>
</form>`
}

/** Fecha en la zona del navegador: el server escribe UTC rotulado; `FECHAS_LOCALES_JS` la reescribe. */
export function fecha(iso: string | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = new Date(t).toISOString()
  return `<time datetime="${escapeHtml(d)}">${escapeHtml(`${d.slice(0, 10)} ${d.slice(11, 16)} UTC`)}</time>`
}

/** Reescribe cada `<time datetime>` en la zona del navegador (`es-CL`). Sin JS queda el UTC rotulado. */
export const FECHAS_LOCALES_JS = `(function(){try{var f=new Intl.DateTimeFormat('es-CL',{dateStyle:'medium',timeStyle:'short'});window.__fechas=function(r){[].forEach.call((r||document).querySelectorAll('time[datetime]'),function(t){var d=new Date(t.getAttribute('datetime'));if(!isNaN(d))t.textContent=f.format(d)})};window.__fechas()}catch(e){}})()`

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
