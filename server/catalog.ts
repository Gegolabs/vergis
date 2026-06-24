/**
 * Render del CATÁLOGO de PIs (índice `/`). Función pura (sin efectos de servidor) para poder testearla
 * y previsualizarla aislada. Va enmarcado con el AVATAR de identidad — el mismo componente que la
 * administración (ver `avatarMenu`/`AVATAR_CSS` en `ui.ts`).
 */
import { AVATAR_CSS } from './ui'

export interface CatalogItem {
  code: string
  slug: string
  name: string
}

export function indexHtml(
  items: CatalogItem[],
  title: string,
  opts: { logoUrl?: string; avatar?: string } = {},
): string {
  const lis = items.map((r) => `<li><a href="/${r.slug}"><span class="c">${r.code}</span> ${r.name}</a></li>`).join('')
  const logo = opts.logoUrl ? `<img class="logo" src="${opts.logoUrl}" alt="">` : ''
  const avatar = opts.avatar ?? ''
  // Theme oscuro (default, gruvbox) / blanco — vía CSS vars + data-theme; el toggle vive en el avatar.
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{--bg:#1d2021;--fg:#ebdbb2;--card:#3c3836;--border:#504945;--accent:#b8bb26;--muted:#928374}
html[data-theme="blanco"]{--bg:#ffffff;--fg:#1f2937;--card:#f8fafc;--border:#e2e8f0;--accent:#2563eb;--muted:#94a3b8}
body{font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:40px;transition:background .15s,color .15s;min-height:100vh;box-sizing:border-box;display:flex;flex-direction:column}
.head{display:flex;gap:14px;align-items:center;margin-bottom:18px}.head .logo{width:40px;height:40px;border-radius:50%;flex:none}h1{font-size:20px;margin:0;font-weight:700;flex:1}
ul{list-style:none;padding:0;max-width:560px}li a{display:flex;gap:12px;align-items:baseline;padding:14px 16px;margin:8px 0;background:var(--card);border:1px solid var(--border);border-radius:10px;color:var(--fg);text-decoration:none}
li a:hover{border-color:var(--accent)}.c{font-family:ui-monospace,Menlo,monospace;color:var(--accent);font-weight:700}.f{margin-top:auto;padding-top:24px;color:var(--muted);font-size:11px;opacity:.7}
${AVATAR_CSS}</style></head>
<body>${avatar}<div class="head">${logo}<h1>${title}</h1></div><ul>${lis}</ul><div class="f">Powered by Vergis · <a href="/admin" style="color:inherit;text-decoration:underline">Administración</a></div>
<script>
(function(){var t='oscuro';try{t=localStorage.getItem('vergis:index-theme')||'oscuro'}catch(e){}document.documentElement.setAttribute('data-theme',t)})();
</script></body></html>`
}
