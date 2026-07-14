import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Capability } from '@vergis/botler'
import { escapeHtml, renderMarkdown } from './markdown'
import { getTheme, type ThemeTokens } from './themes'
import { TABLE_RUNTIME_SOURCE } from './table-runtime'
import { TABLE_INTERACTIVE_CSS, TRAY_CSS } from './piece-css'
import { renderTable } from './render-table'
import { renderDistribution } from './render-chart'
import { renderInteractiveScript } from './interactive-script'
import { ctxQuery, formatValue } from './piece-util'
import type {
  Interactive, PagesNav, ControlResolved, CarryCtx, RenderParams,
  ResolvedNode, RenderOpts, RenderSignals,
} from './piece-types'

/** Versión del producto (fuente única: package.json raíz). Se muestra en el pie de la gaveta. */
const VERGIS_VERSION = (() => {
  try {
    const p = resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json')
    return (JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
})()

/**
 * `render-html-piece` — árbol de pieza resuelto (compuesto por Mira) → HTML estático
 * con assets embebidos, vía THEME pluggable. Charts vía Vega-Lite → SVG server-side.
 *
 * Interacción declarada acotada (doc 2 §10): si Mira pasa `interactive`, el render
 * compone una Faceta (catalogo-selector) sobre una dimensión declarada y embebe los
 * datos materializados + JS que filtra y recomputa KPIs/semáforo client-side — sin
 * nuevas queries. La pieza sigue siendo pre-forjada y reproducible.
 */

export const renderHtmlPiece: Capability = {
  name: 'render-html-piece',
  async execute(params: unknown): Promise<unknown> {
    const { piece, title, theme: themeName, palette, meta, interactive, pages, controls, carryCtx } = (params ?? {}) as RenderParams
    if (!piece) throw new Error('render-html-piece: falta el árbol de pieza (piece)')
    const theme = getTheme(themeName)
    const carry = carryCtx ?? {}
    const signals: RenderSignals = { interactiveTable: false, drillActions: false }
    const opts: RenderOpts = { tokens: theme.tokens, interactive: !!interactive, carry, signals }
    // CONVENCIÓN (TX-11 «una cosa, un lugar»): el selector de alcance vive en la BANDA (el sello ES
    // el control), no en la gaveta. La gaveta queda para la maquinaria (facetas de dashboard /
    // runtime de tabla, guardados, config). Un PI cuyo único contenido de gaveta eran los controles
    // queda SIN gaveta.
    const contextStrip = controls && controls.length ? renderContextStrip(controls, pages?.active, carry) : ''
    const nav = pages ? renderPagesNav(pages, carry) : ''
    let body = contextStrip + nav + (await renderNode(piece, opts))
    const hasTable = signals.interactiveTable
    // GAVETA COMÚN (un solo shell por documento) para PI con interactividad de dashboard o de tabla.
    // 3 tabs: Controles · Guardados · Config. El tab «Controles» reúne las facetas del dashboard /
    // los controles del runtime de tabla (los selectores de alcance viven en la banda, no aquí).
    const hasTray = !!interactive || hasTable
    // Etiqueta de versión del PI (instancia) para el pie del inspector: "<code> · v<version>".
    const piLabel = meta?.code
      ? `${meta.code}${meta.version ? ' · v' + meta.version : ''}`
      : meta?.version
        ? `v${meta.version}`
        : ''
    let tail = '' // scripts al FINAL del body (DOM ya parseado)
    if (interactive) {
      body = renderTrayShell(renderDashboardFacets(interactive), theme.palettes, palette, piLabel) + body
      tail += renderInteractiveScript(interactive)
    } else if (hasTray) {
      body = renderTrayShell('', theme.palettes, palette, piLabel) + body
    }
    // CSS al TOPE del body, ANTES del contenido (evita FOUC: en tablas grandes el navegador
    // pintaba el HTML sin estilar mientras parseaba miles de filas + el JSON embebido, y solo
    // aplicaba el CSS al llegar al `<style>` del final). Todo el CSS por-documento va junto, arriba.
    let css = ''
    if (hasTray) css += TRAY_CSS
    if (hasTable) css += TABLE_INTERACTIVE_CSS
    if (pages) css += PAGES_NAV_CSS
    if (contextStrip) css += CONTEXT_BAR_CSS
    if (signals.drillActions) css += DRILL_ACTIONS_CSS
    if (css) body = `<style>${css}</style>` + body
    // El runtime de la tabla (orden/filtro/búsqueda/agrupar/drill) al final: se autoarranca por `.vtable`.
    if (hasTable) tail += `<script>${TABLE_RUNTIME_SOURCE}</script>`
    return { html: theme.wrap({ title: title ?? 'Vergis', body: body + tail, meta, palette }) }
  },
}

/** CSS de la barra de navegación de vistas (PI multi-vista). Variables del theme con fallback claro. */
const PAGES_NAV_CSS = `
.vpages{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 18px;border-bottom:1px solid var(--border,#e2e8f0)}
.vpages a{font-size:13px;padding:8px 16px;text-decoration:none;color:var(--fg-dim,#64748b);border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.vpages a:hover{color:var(--fg,#1f2937)}
.vpages a.active{color:var(--green,#2563eb);border-bottom-color:var(--green,#2563eb);font-weight:600}
`


/** Barra de navegación de vistas: un link por página (`?page=<id>`), preservando el carry (ctx). */
function renderPagesNav(pages: PagesNav, carry: CarryCtx = {}): string {
  const q = ctxQuery(carry)
  const tabs = pages.items
    .map(
      (p) =>
        `<a href="?page=${encodeURIComponent(p.id)}${q}"${p.id === pages.active ? ' class="active" aria-current="page"' : ''}>${escapeHtml(p.title)}</a>`,
    )
    .join('')
  return `<nav class="vpages" role="tablist">${tabs}</nav>`
}

/** CSS de la banda de CONTEXTO ACTIVO (sticky arriba) — la superficie estándar del selector de
 * alcance (TX-11 «cara = estado»): el sello muestra el valor vigente y ES clickeable (single =
 * `<select>` estilizado; multi = `<details>` con checkboxes). En print (`.vctx-print`) degrada a
 * texto plano y el widget (`.vctx-screen`) se oculta. Variables del theme con fallback claro. */
const CONTEXT_BAR_CSS = `
.vctxbar{position:sticky;top:0;z-index:8;display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:8px 14px;margin:0 0 16px;background:var(--panel,var(--bg,#fff));border:1px solid var(--border,#e2e8f0);border-radius:8px;font-size:12px}
.vctxbar .vctx-item{display:inline-flex;align-items:center;gap:6px}
.vctxbar .vctx-k{color:var(--fg-dim,#64748b);text-transform:uppercase;letter-spacing:.04em;font-size:10px;margin-right:2px}
.vctxbar .vctx-v{color:var(--fg,#1f2937);font-weight:700}
.vctxbar select.vctx-sel{font:inherit;font-weight:700;color:var(--fg,#1f2937);background-color:var(--bg,#fff);border:1px solid var(--border,#e2e8f0);border-radius:6px;padding:3px 22px 3px 8px;cursor:pointer;-webkit-appearance:none;-moz-appearance:none;appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%2364748b' stroke-width='1.4'/></svg>");background-repeat:no-repeat;background-position:right 7px center}
.vctxbar select.vctx-sel:hover{border-color:var(--green,#2563eb)}
.vctxbar .vctx-multi{position:relative;display:inline-block}
.vctxbar .vctx-multi>summary{list-style:none;cursor:pointer;font-weight:700;color:var(--fg,#1f2937);background:var(--bg,#fff);border:1px solid var(--border,#e2e8f0);border-radius:6px;padding:3px 10px 3px 8px}
.vctxbar .vctx-multi>summary::-webkit-details-marker{display:none}
.vctxbar .vctx-multi>summary::after{content:"▾";margin-left:6px;color:var(--fg-dim,#64748b);font-size:10px}
.vctxbar .vctx-multi[open]>summary{border-color:var(--green,#2563eb)}
.vctxbar .vctx-pop{position:absolute;z-index:20;top:calc(100% + 4px);left:0;min-width:150px;display:flex;flex-direction:column;gap:4px;padding:8px;background:var(--panel,#fff);border:1px solid var(--border,#e2e8f0);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.18)}
.vctxbar .vctx-pop label{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:400;white-space:nowrap;cursor:pointer;color:var(--fg,#1f2937)}
.vctx-print{display:none}
@media print{.vctxbar{position:static;border:none;padding:0;margin:0 0 10px;gap:12px;font-size:11px}.vctxbar .vctx-screen{display:none!important}.vctxbar .vctx-print{display:inline!important;font-weight:700}}
`

/**
 * Prefijo común del handler de navegación de un sello (banda) o control: reconstruye el query con
 * la página activa + el carry (menos ESTE control; un valor multi se repite con append). `window.URL`
 * es obligatorio: en un handler inline `document.URL` (string) sombrea al constructor global y
 * `new URL(…)` lanzaría TypeError (ver test controls-multidrill, ejecutado bajo `with(document)`).
 */
function ctxNavBase(cId: string, activePage: string | undefined, carry: CarryCtx): string {
  return (
    `var u=new window.URL(location.href);u.search='';` +
    (activePage ? `u.searchParams.set('page',${JSON.stringify(activePage)});` : '') +
    Object.entries(carry)
      .filter(([k]) => k !== cId)
      .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((val) => `u.searchParams.append('ctx.${escapeHtml(k)}',${JSON.stringify(String(val))});`))
      .join('')
  )
}

/**
 * Banda de contexto activo = EL selector de alcance (TX-11 WP1). Por control con valor vigente emite
 * un sello clickeable: single → `<select>` nativo estilizado (a11y gratis) con las mismas opciones y
 * navegación que el control histórico de la gaveta; multi → `<details>` cuyo summary muestra el valor
 * unido y cuyo popover reúne los checkboxes existentes. Por ítem se emite además `.vctx-print` (texto
 * plano) — en print el widget `.vctx-screen` se oculta y queda el texto (el sello impreso es «OC …»).
 */
function renderContextStrip(controls: ControlResolved[], activePage: string | undefined, carry: CarryCtx): string {
  const items = controls
    .filter((c) => c.value != null && c.value !== '')
    .map((c) => {
      const label = escapeHtml(c.label)
      // Opciones normalizadas a pares {value,label}: la resolución emite pares (value = la llave que se
      // escribe en ctx, label = el texto visible); un `string[]` legado se lee como label = value.
      const pairs = c.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
      // El texto de print/summary es la ETIQUETA del valor vigente (`displayLabel`), no la llave cruda.
      const printText = c.displayLabel ?? String(c.value)
      const printVal = `<span class="vctx-v vctx-print">${escapeHtml(printText)}</span>`
      if (c.multi) {
        // Multi: al cambiar cualquier checkbox se recolectan los marcados y se navega con `ctx.<id>`
        // repetido por valor (mismo contrato que el control histórico, misma navegación por URL).
        const onchange =
          ctxNavBase(c.id, activePage, carry) +
          `var g=this.closest('.vctx-multi');Array.prototype.forEach.call(g.querySelectorAll('input[type=checkbox]:checked'),function(b){u.searchParams.append('ctx.${escapeHtml(c.id)}',b.value);});location.assign(u.pathname+u.search);`
        const selected = new Set(c.values ?? [])
        const checks = pairs
          .map((o) => `<label><input type="checkbox" value="${escapeHtml(o.value)}"${selected.has(o.value) ? ' checked' : ''} onchange="${escapeHtml(onchange)}"> ${escapeHtml(o.label)}</label>`)
          .join('')
        return (
          `<span class="vctx-item"><span class="vctx-k">${label}</span>` +
          `<details class="vctx-multi vctx-screen" data-ctl="${escapeHtml(c.id)}"><summary class="vctx-v vctx-sum">${escapeHtml(printText)}</summary>` +
          `<div class="vctx-pop" role="group" aria-label="${label}">${checks}</div></details>` +
          printVal +
          `</span>`
        )
      }
      const onchange = ctxNavBase(c.id, activePage, carry) + `u.searchParams.set('ctx.${escapeHtml(c.id)}',this.value);location.assign(u.pathname+u.search);`
      const opts = pairs
        .map((o) => `<option value="${escapeHtml(o.value)}"${o.value === c.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`)
        .join('')
      return (
        `<span class="vctx-item"><span class="vctx-k">${label}</span>` +
        `<select class="vctx-v vctx-sel vctx-screen" aria-label="${label}" onchange="${escapeHtml(onchange)}">${opts}</select>` +
        printVal +
        `</span>`
      )
    })
    .join('')
  return items ? `<div class="vctxbar">${items}</div>` : ''
}

/** CSS de la columna de acciones de drill (links por fila + menú cuando hay varias). */
const DRILL_ACTIONS_CSS = `
.vtable td.vt-actions,.table td.vt-actions{white-space:nowrap;text-align:center;width:1px}
.vt-drill-link{display:inline-block;padding:1px 7px;margin:0 1px;font-size:12px;text-decoration:none;color:var(--green,#2563eb);border:1px solid transparent;border-radius:6px;cursor:pointer}
.vt-drill-link:hover{border-color:var(--green,#2563eb);background:var(--card,#eef2ff)}
.vt-drill-arrow{font-weight:700}
@media print{td.vt-actions{display:none!important}}
`

async function renderNode(node: ResolvedNode, opts: RenderOpts): Promise<string> {
  if (node.layout) {
    const children = await Promise.all((node.elements ?? []).map((e) => renderNode(e, opts)))
    const styles: string[] = []
    if (node.layout === 'grid' && node.columns) styles.push(`--cols:${node.columns}`)
    if (node.span) styles.push(`grid-column:span ${node.span}`) // abarcar N columnas del grid padre
    const style = styles.length ? ` style="${styles.join(';')}"` : ''
    return `<div class="layout layout-${escapeHtml(node.layout)}"${style}>\n${children.join('\n')}\n</div>`
  }
  switch (node.type) {
    case 'banner':
      return `<div class="banner">${escapeHtml(String(node.content ?? ''))}</div>`
    case 'markdown_block':
      return `<section class="markdown">${renderMarkdown(String(node.content ?? ''))}</section>`
    case 'kpi':
      return renderKpi(node, opts)
    case 'distribution':
      return renderDistribution(node, opts.tokens)
    case 'table':
      return renderTable(node, opts)
    case 'semaforo':
      return renderSemaforo(node, opts)
    default:
      return `<!-- elemento no soportado en v0.1: ${escapeHtml(String(node.type))} -->`
  }
}

function renderKpi(node: ResolvedNode, opts: RenderOpts): string {
  const value = formatValue(node.value, node.format)
  const accent = node.accent ? ` data-accent="${escapeHtml(node.accent)}"` : ''
  // Atributos para recompute client-side (interacción declarada acotada).
  let dataAttrs = ''
  if (opts.interactive && node.agg) {
    dataAttrs = ` data-format="${escapeHtml(node.format ?? '')}" data-agg="${escapeHtml(JSON.stringify(node.agg))}"`
    if (node.comparisonAgg) dataAttrs += ` data-comparison-agg="${escapeHtml(JSON.stringify(node.comparisonAgg))}" data-comparison-label="${escapeHtml(node.comparisonLabel ?? '')}"`
  }
  const comparison =
    node.comparison != null
      ? ` <span class="kpi-comparison">${escapeHtml(node.comparisonLabel ?? '')} ${escapeHtml(formatValue(node.comparison, node.format))}</span>`
      : ''
  const sizeCls = node.size ? ` kpi-${escapeHtml(node.size)}` : ''
  return (
    `<section class="kpi${sizeCls}"${accent}${dataAttrs}>` +
    `<div class="kpi-value">${escapeHtml(value)}</div>` +
    `<div class="kpi-label">${escapeHtml(String(node.label ?? ''))}${comparison}</div>` +
    `</section>`
  )
}

function semaforoCard(label: string, present: number, total: number, green: number, yellow: number): string {
  // Guard NaN: una fila con present/total nulos pintaba «NaN / NaN» y 0% (rojo). Mostrar «—».
  const valid = Number.isFinite(present) && Number.isFinite(total)
  const pct = valid && total > 0 ? Math.round((present / total) * 100) : 0
  const cls = !valid ? 'red' : pct >= green ? 'green' : pct >= yellow ? 'yellow' : 'red'
  return (
    `<div class="tl-card ${cls}">` +
    `<div class="area-name" title="${escapeHtml(label)}">${escapeHtml(label)}</div>` +
    `<span class="headcount">${valid ? `${present} / ${total}` : '—'}</span>` +
    `<span class="pct ${cls}">${valid ? `${pct}%` : '—'}</span>` +
    `</div>`
  )
}

function renderSemaforo(node: ResolvedNode, opts: RenderOpts): string {
  const rows = node.rows ?? []
  const labelF = node.labelField ?? 'label'
  const presentF = node.presentField ?? 'present'
  const totalF = node.totalField ?? 'total'
  const green = node.thresholds?.green ?? 90
  const yellow = node.thresholds?.yellow ?? 70
  const cards = rows
    .map((r) => semaforoCard(String(r[labelF] ?? ''), Number(r[presentF]), Number(r[totalF]), green, yellow))
    .join('\n')
  let dataAttr = ''
  if (opts.interactive) {
    dataAttr = ` data-semaforo="${escapeHtml(JSON.stringify({ dataset: node.dataset, labelField: labelF, presentField: presentF, totalField: totalF, green, yellow }))}"`
  }
  // Header: título a la izquierda + summary (un agregado) inline a la derecha.
  let summaryHtml = ''
  if (node.summary) {
    const sAttr = opts.interactive
      ? ` data-summary="${escapeHtml(JSON.stringify({ dataset: node.summary.dataset, agg: node.summary.agg, format: node.summary.format }))}"`
      : ''
    const accent = node.summary.accent ? ` data-accent="${escapeHtml(node.summary.accent)}"` : ''
    summaryHtml =
      `<div class="semaforo-summary"${accent}${sAttr}>` +
      `<span class="ss-val">${escapeHtml(formatValue(node.summary.value, node.summary.format))}</span>` +
      `<span class="ss-lbl">${escapeHtml(String(node.summary.label ?? ''))}</span>` +
      `</div>`
  }
  const head =
    node.title || summaryHtml
      ? `<div class="semaforo-head">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : '<span></span>'}${summaryHtml}</div>`
      : ''
  // `columns` fuerza N columnas fijas (p.ej. 5 días en una línea); por defecto, auto-fill (CSS).
  const gridStyle = node.columns ? ` style="grid-template-columns:repeat(${node.columns},minmax(0,1fr))"` : ''
  return `<section class="semaforo"${dataAttr}>${head}<div class="tl-grid"${gridStyle}>${cards}</div></section>`
}

/**
 * Gaveta (off-canvas, desde la derecha) — **shell común a TODOS los PI** (dashboard y tabla).
 * El CTA es una uña/pestaña que sobresale del borde derecho (overlay universal, ajeno al
 * contenido). Al abrir, el contenido se encoge a la izquierda. Apertura/cierre por toggle CSS
 * puro. `sections` es el contenido específico del PI (facetas de dashboard server-rendered, o
 * vacío para que el runtime de tabla inyecte sus controles en `.tray-sections`). Apariencia,
 * Imprimir y crédito son universales. Una sola implementación = comportamiento idéntico.
 */
function renderTrayShell(sections: string, palettes?: { id: string; label: string }[], activePalette?: string, piLabel?: string): string {
  const active = activePalette || (palettes && palettes[0]?.id) || ''
  let appearance = ''
  if (palettes && palettes.length > 1) {
    const radios = palettes
      .map(
        (p) =>
          `<label><input type="radio" name="vergis-palette" value="${escapeHtml(p.id)}"${p.id === active ? ' checked' : ''} onchange="document.documentElement.dataset.palette=this.value;try{localStorage.setItem('vergis:palette:'+location.pathname,this.value)}catch(e){}"> ${escapeHtml(p.label)}</label>`,
      )
      .join('')
    appearance =
      `<div class="faceta faceta-appearance"><div class="faceta-title">Apariencia (Theme)</div>` +
      `<div class="faceta-options">${radios}</div></div>`
  }
  // Restaura la paleta elegida por el usuario (persistida por reporte) sobre el default de plataforma.
  const restore =
    `<script>(function(){try{var p=localStorage.getItem('vergis:palette:'+location.pathname);if(p){document.documentElement.dataset.palette=p;var r=document.querySelector('input[name=vergis-palette][value="'+p+'"]');if(r)r.checked=true;}}catch(e){}})();</script>`
  // Pie de la gaveta (pegado al fondo): versión + crédito discreto. URL como texto, sin links.
  // Pie del inspector: versión del PI (instancia) + versión de Mira (motor) — pistas DISTINTAS.
  const footer =
    `<div class="tray-foot">` +
    (piLabel ? `<div class="tray-version tray-piversion">${escapeHtml(piLabel)}</div>` : '') +
    `<div class="tray-version">Mira v${escapeHtml(VERGIS_VERSION)}</div>` +
    `<div class="tray-credit">Powered by Vergis · © 2026 Gegolabs · AGPL-3.0 · https://agencydomains.org/</div>` +
    `</div>`
  return (
    `<input type="checkbox" id="vergis-tray-toggle" class="tray-toggle" hidden>` +
    `<label for="vergis-tray-toggle" class="tray-tab" title="Inspector" aria-label="Abrir inspector">` +
    // Ícono de sliders/controles (no embudo): el panel es un Inspector (controles + vistas + config).
    `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2 4.5h12M2 8h12M2 11.5h12"/><circle cx="6" cy="4.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="10.5" cy="8" r="1.7" fill="currentColor" stroke="none"/><circle cx="5" cy="11.5" r="1.7" fill="currentColor" stroke="none"/></svg>` +
    `<span class="faceta-count" id="vergis-count"></span>` +
    `</label>` +
    `<aside class="tray" id="vergis-filters" role="dialog" aria-label="Inspector">` +
    `<div class="tray-head"><strong>Inspector</strong><label for="vergis-tray-toggle" class="tray-close" title="Cerrar">✕</label></div>` +
    // 3 tabs (radios CSS puros): Controles · Guardados · Config
    `<input type="radio" name="vergis-traytab" id="vergis-tt-controles" class="tray-tabin" checked hidden>` +
    `<input type="radio" name="vergis-traytab" id="vergis-tt-guardados" class="tray-tabin" hidden>` +
    `<input type="radio" name="vergis-traytab" id="vergis-tt-config" class="tray-tabin" hidden>` +
    `<div class="tray-tabs">` +
    `<label for="vergis-tt-controles" class="tray-tablabel tt-controles">Controles</label>` +
    `<label for="vergis-tt-guardados" class="tray-tablabel tt-guardados">Vistas</label>` +
    `<label for="vergis-tt-config" class="tray-tablabel tt-config">Config</label>` +
    `</div>` +
    `<div class="tray-panel tray-panel-controles"><div class="tray-sections">${sections}</div></div>` +
    `<div class="tray-panel tray-panel-guardados"><div class="tray-saved"></div></div>` +
    `<div class="tray-panel tray-panel-config">${appearance}<div class="tray-actions"><button type="button" class="tray-print" onclick="window.print()">Imprimir</button></div></div>` +
    // Pie COMÚN a los 3 tabs (fuera de los paneles) → siempre visible, pegado al fondo.
    footer +
    `</aside>` +
    restore
  )
}

/** Sección de la gaveta específica del dashboard: las facetas (catálogo-selector) por filtro. */
function renderDashboardFacets(it: Interactive): string {
  return it.filters
    .map((f) => {
      const rows = it.datasets[f.dataset] ?? []
      const values = [...new Set(rows.map((r) => String(r[f.field] ?? '')))].sort((a, b) => a.localeCompare(b, 'es'))
      const checks = values
        .map((v) => `<label><input type="checkbox" data-field="${escapeHtml(f.field)}" value="${escapeHtml(v)}"> ${escapeHtml(v)}</label>`)
        .join('')
      return (
        `<div class="faceta" data-field="${escapeHtml(f.field)}">` +
        `<div class="faceta-title">${escapeHtml(f.label ?? f.field)}<button type="button" class="faceta-clear" data-field="${escapeHtml(f.field)}">limpiar</button></div>` +
        `<div class="faceta-options">${checks}</div>` +
        `</div>`
      )
    })
    .join('')
}

