import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vega from 'vega'
import { compile, type TopLevelSpec } from 'vega-lite'
import type { Capability } from '@vergis/botler'
import { escapeHtml, renderMarkdown } from './markdown'
import { getTheme, type DashboardMeta, type ThemeTokens } from './themes'
import { TABLE_RUNTIME_SOURCE, SAVED_VIEWS_JS } from './table-runtime'

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
interface FilterSpec {
  dataset: string
  field: string
  label?: string
  multi?: boolean
}
interface Interactive {
  datasets: Record<string, Record<string, unknown>[]>
  /** Los filtros disponibles que viven en la bandeja. */
  filters: FilterSpec[]
}
interface PagesNav {
  items: { id: string; title: string }[]
  active: string
}
interface RenderParams {
  piece: ResolvedNode
  title?: string
  theme?: string
  /** Paleta inicial del theme (default por tipo de PI; el usuario la cambia en la gaveta). */
  palette?: string
  meta?: DashboardMeta
  interactive?: Interactive
  /** PI multi-vista: barra de navegación de páginas (links `?page=<id>`). */
  pages?: PagesNav
}

export interface TableColumn {
  field: string
  label?: string
  format?: string
  align?: string
  colorscale?: boolean
  /** Override del auto-on: orden por esta columna (default: true). */
  sortable?: boolean
  /** Override del auto-on: búsqueda por esta columna (default: true). */
  searchable?: boolean
  /** Override de la heurística: faceta de filtro (default: auto por cardinalidad). */
  filter?: boolean
  /** Override de la heurística: disponible para agrupar (default: igual que filter). */
  groupBy?: boolean
  /** Columna de anotación (editable; enriquecimiento de la capa de viz). */
  annotation?: boolean
}
interface Aggregation {
  dataset?: string
  op: 'sum' | 'ratio'
  field?: string
  num?: string
  den?: string
}

export interface ResolvedNode {
  layout?: string
  columns?: number
  elements?: ResolvedNode[]
  type?: string
  content?: string
  value?: unknown
  label?: string
  format?: string
  accent?: string
  comparison?: unknown
  comparisonLabel?: string
  agg?: Aggregation
  comparisonAgg?: Aggregation
  size?: string
  span?: number
  rows?: Record<string, unknown>[]
  dimensionField?: string
  metricField?: string
  orientation?: string
  title?: string
  columnsSpec?: TableColumn[]
  labelField?: string
  presentField?: string
  totalField?: string
  pctField?: string
  thresholds?: { green?: number; yellow?: number }
  dataset?: string
  summary?: { value?: unknown; label?: string; format?: string; accent?: string; agg?: Aggregation; dataset?: string }
  /** Tabla: `false` desactiva la interactividad (orden/filtro/búsqueda/agrupar) → tabla estática. */
  interactive?: boolean
  /** Tabla: meta de anotaciones (columna editable compartida). */
  annotation?: { valueField: string; tokenField: string; keyField: string; endpoint: string; label: string }
  /** Tabla: drill-through (al clickear una fila hoja, navegar a la vista `to` pasando el campo `by`). */
  drill?: { to: string; by: string }
}

interface RenderOpts {
  tokens: ThemeTokens
  interactive: boolean
}

/**
 * CSS de la tabla interactiva. Usa las variables del theme con fallback al look claro,
 * así sirve en `arbol` (que define las vars) y en `default` (que cae al fallback).
 * Se inyecta una vez por documento (ver renderHtmlPiece).
 */
const TABLE_INTERACTIVE_CSS = `
.vtable .vt-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.vtable .vt-chips:empty{display:none}
.vtable .vt-chip{font-size:11px;padding:3px 8px;border-radius:20px;background:var(--card,#eef2ff);color:var(--fg,#1f2937);border:1px solid var(--border,#e2e8f0);cursor:pointer}
.vtable .vt-chip:hover{border-color:var(--red,#dc2626);color:var(--red,#dc2626)}
.vtable .vt-scroll{overflow-x:auto}
.vtable th.vt-col{position:relative}
.vtable .vt-th-inner{display:flex;align-items:center;gap:6px;justify-content:space-between}
.vtable th.align-right .vt-th-inner{flex-direction:row-reverse}
.vtable th.vt-sortable .vt-th-label{cursor:pointer;user-select:none;white-space:nowrap}
.vtable th.vt-sortable .vt-th-label:hover{color:var(--green,#2563eb)}
.vtable .vt-sort-ind{font-size:10px;margin-left:4px}
.vtable .vt-filter-btn{flex:none;background:none;border:none;padding:2px;margin:0;cursor:pointer;color:var(--fg-dim,#94a3b8);opacity:.4;line-height:0;border-radius:4px}
.vtable .vt-filter-btn:hover,.vtable .vt-filter-btn.on{opacity:1;color:var(--green,#2563eb)}
.vtable .vt-col-pop{position:fixed;z-index:60;width:280px;max-width:calc(100vw - 16px);background:var(--panel,#fff);border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:8px;box-shadow:0 12px 32px rgba(0,0,0,.24);font-weight:400;text-transform:none;letter-spacing:0}
.vtable .vt-pop-search{width:100%;box-sizing:border-box;padding:5px 7px;font-size:12px;border:1px solid var(--border,#e2e8f0);border-radius:5px;background:var(--bg,#fff);color:var(--fg,#1f2937)}
.vtable .vt-pop-actions{display:flex;gap:8px;margin:6px 0}
.vtable .vt-pop-actions button{flex:1;font-size:11px;padding:3px;background:var(--card,#fff);color:var(--fg-dim,#64748b);border:1px solid var(--border,#e2e8f0);border-radius:5px;cursor:pointer}
.vtable .vt-pop-actions button:hover{color:var(--green,#2563eb);border-color:var(--green,#2563eb)}
.vtable .vt-pop-opts{max-height:240px;overflow:auto}
.vtable .vt-pop-opts label{display:flex;align-items:center;gap:7px;font-size:13px;padding:3px 2px;color:var(--fg,#1f2937);white-space:nowrap;cursor:pointer;font-weight:400}
.vtable .vt-pop-val{flex:1;overflow:hidden;text-overflow:ellipsis}
.vtable .vt-pop-count{color:var(--fg-dim,#94a3b8);font-size:11px}
.vtable tr.vt-group-head td{background:var(--panel,#f1f5f9);font-weight:700;color:var(--fg,#1f2937);font-size:12px;text-transform:uppercase;letter-spacing:.03em;cursor:pointer;user-select:none}
.vtable tr.vt-group-head:hover td{color:var(--green,#2563eb)}
.vtable tr.vt-group-head[data-depth="1"] td{font-size:11px;opacity:.94;text-transform:none;letter-spacing:0}
.vtable tr.vt-group-head[data-depth="2"] td{font-size:11px;opacity:.85;text-transform:none;letter-spacing:0;font-weight:600}
.vtable tr.vt-group-head[data-depth="3"] td,.vtable tr.vt-group-head[data-depth="4"] td{font-size:11px;opacity:.78;text-transform:none;letter-spacing:0;font-weight:600}
.vtable .vt-gcaret{display:inline-block;width:.9em;color:var(--fg-dim,#94a3b8)}
.vtable .vt-gcount{color:var(--fg-dim,#64748b);font-weight:600}
.vtable tr.vt-empty td{text-align:center;color:var(--fg-dim,#64748b);padding:18px;font-style:italic}
.tray .vt-tray-section .vt-ctl-grp{margin-bottom:18px}
.tray .vt-tray-section .vt-ctl-grp:last-child{margin-bottom:0}
.tray .vt-tray-section .vt-global-search,.tray .vt-tray-section .vt-group-add{width:100%;box-sizing:border-box;padding:7px 9px;font-size:13px;border:1px solid var(--border,#e2e8f0);border-radius:7px;background:var(--bg,#fff);color:var(--fg,#1f2937)}
.tray .vt-tray-section .vt-group-add{margin-top:6px}
.tray .vt-group-levels{display:flex;flex-direction:column;gap:4px;margin:6px 0}
.tray .vt-group-levels:empty{display:none}
.tray .vt-gl-chip{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;padding:4px 9px;background:var(--card,#fff);border:1px solid var(--border,#e2e8f0);border-radius:6px;color:var(--fg,#1f2937)}
.tray .vt-gl-num{color:var(--fg-dim,#94a3b8);font-size:10px;margin-right:2px}
.tray .vt-gl-rm{cursor:pointer;color:var(--fg-dim,#94a3b8);font-size:14px;line-height:1}
.tray .vt-gl-rm:hover{color:var(--red,#dc2626)}
.tray .vt-group-actions{display:flex;gap:8px;margin-top:8px}
.tray .vt-group-actions button{flex:1;font-size:11px;padding:5px;background:var(--card,#fff);color:var(--fg-dim,#64748b);border:1px solid var(--border,#e2e8f0);border-radius:6px;cursor:pointer}
.tray .vt-group-actions button:hover{color:var(--green,#2563eb);border-color:var(--green,#2563eb)}
.tray .vt-tray-section .vt-clear-all{width:100%;padding:8px;font-size:12px;background:var(--card,#fff);color:var(--fg-dim,#64748b);border:1px solid var(--border,#e2e8f0);border-radius:7px;cursor:pointer}
.tray .vt-tray-section .vt-clear-all:hover{color:var(--red,#dc2626);border-color:var(--red,#dc2626)}
.tray .vt-tray-section .vt-count{display:block;margin-top:8px;font-size:12px;color:var(--fg-dim,#64748b)}
.tray .vt-ann-toggle{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--fg,#1f2937);cursor:pointer}
.vtable .vt-ann-hint{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;margin-bottom:10px;background:var(--card,#fffbeb);border:1px solid var(--yellow,#d97706);border-radius:8px;font-size:12px;color:var(--fg,#1f2937)}
.vtable .vt-ann-hint button{flex:none;background:none;border:1px solid var(--yellow,#d97706);color:var(--yellow,#d97706);border-radius:6px;padding:3px 12px;font-size:12px;cursor:pointer}
.vtable .vt-ann-hint button:hover{background:var(--yellow,#d97706);color:var(--bg,#fff)}
.vtable td.vt-ann-cell{background:var(--panel,#f8fafc);min-width:120px;cursor:text;outline:none}
.vtable td.vt-ann-cell:focus{box-shadow:inset 0 0 0 2px var(--green,#2563eb)}
.vtable td.vt-ann-cell:empty::before{content:'+ nota';color:var(--fg-dim,#94a3b8);opacity:.55}
.vtable td.vt-ann-cell.vt-ann-err{box-shadow:inset 0 0 0 2px var(--red,#dc2626)}
.vtable tr.vt-drill-row{cursor:pointer}
.vtable tr.vt-drill-row:hover td{background:var(--card,#eef2ff)}
.vtable td.vt-drill-arrow{color:var(--green,#2563eb);font-weight:700;text-align:center;width:1.6em}
@media print{.vtable .vt-chips,.vtable .vt-filter-btn,.vtable .vt-ann-hint,.vtable td.vt-drill-arrow{display:none!important}.vtable td.vt-ann-cell:empty::before{content:''}}
`

/** CSS de la gaveta común: tabs (Controles·Guardados·Config) + panel de filtros guardados.
 *  Se inyecta una vez por documento cuando hay gaveta (dashboard o tabla). Variables del theme
 *  con fallback claro → sirve en arbol y default. */
const TRAY_CSS = `
.tray{display:flex;flex-direction:column}
.tray-foot{margin-top:auto;padding-top:14px;text-align:center}
.tray-version{font-size:10px;color:var(--fg-dim,#94a3b8);opacity:.6;letter-spacing:.03em}
.tray-credit{border-top:none;padding-top:3px;font-size:9px;line-height:1.5;color:var(--fg-dim,#94a3b8);opacity:.32;word-break:break-word}
.tray-tabin{position:absolute;width:0;height:0;opacity:0;pointer-events:none}
.tray-tabs{display:flex;gap:2px;margin-bottom:14px;border-bottom:1px solid var(--border,#e2e8f0)}
.tray-tablabel{flex:1;text-align:center;font-size:12px;padding:7px 4px;cursor:pointer;color:var(--fg-dim,#94a3b8);border-bottom:2px solid transparent;margin-bottom:-1px;user-select:none}
.tray-tablabel:hover{color:var(--fg,#1f2937)}
#vergis-tt-controles:checked~.tray-tabs .tt-controles,#vergis-tt-guardados:checked~.tray-tabs .tt-guardados,#vergis-tt-config:checked~.tray-tabs .tt-config{color:var(--green,#2563eb);border-bottom-color:var(--green,#2563eb);font-weight:600}
.tray-panel{display:none}
#vergis-tt-controles:checked~.tray-panel-controles,#vergis-tt-guardados:checked~.tray-panel-guardados,#vergis-tt-config:checked~.tray-panel-config{display:block}
.tray-saved .vt-save-new{display:flex;gap:6px;margin:6px 0 14px}
.tray-saved .vt-save-name{flex:1;min-width:0;box-sizing:border-box;padding:6px 8px;font-size:13px;border:1px solid var(--border,#e2e8f0);border-radius:6px;background:var(--bg,#fff);color:var(--fg,#1f2937)}
.tray-saved .vt-save-btn{padding:6px 10px;font-size:12px;background:var(--card,#fff);color:var(--fg,#1f2937);border:1px solid var(--border,#e2e8f0);border-radius:6px;cursor:pointer;white-space:nowrap}
.tray-saved .vt-save-btn:hover{color:var(--green,#2563eb);border-color:var(--green,#2563eb)}
.tray-saved .vt-saved-row{display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--border,#e2e8f0);border-radius:6px;margin-bottom:5px}
.tray-saved .vt-saved-row.pinned{border-color:var(--yellow,#d97706)}
.tray-saved .vt-saved-pin{flex:none;background:none;border:none;cursor:pointer;color:var(--fg-dim,#94a3b8);font-size:14px;line-height:1;padding:0 2px}
.tray-saved .vt-saved-pin:hover{color:var(--yellow,#d97706)}
.tray-saved .vt-saved-row.pinned .vt-saved-pin{color:var(--yellow,#d97706)}
.tray-saved .vt-saved-hint{font-size:10px;color:var(--fg-dim,#94a3b8);margin-top:8px}
.tray-saved .vt-saved-name{flex:1;cursor:pointer;font-size:13px;color:var(--fg,#1f2937);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tray-saved .vt-saved-name:hover{color:var(--green,#2563eb)}
.tray-saved .vt-saved-actions{display:flex;gap:4px}
.tray-saved .vt-saved-actions button{background:none;border:none;cursor:pointer;color:var(--fg-dim,#94a3b8);font-size:14px;line-height:1;padding:2px 4px;border-radius:4px}
.tray-saved .vt-saved-upd:hover{color:var(--green,#2563eb)}
.tray-saved .vt-saved-del:hover{color:var(--red,#dc2626)}
.tray-saved .vt-saved-empty{font-size:12px;color:var(--fg-dim,#94a3b8);font-style:italic;padding:6px 2px}
`

export const renderHtmlPiece: Capability = {
  name: 'render-html-piece',
  async execute(params: unknown): Promise<unknown> {
    const { piece, title, theme: themeName, palette, meta, interactive, pages } = (params ?? {}) as RenderParams
    if (!piece) throw new Error('render-html-piece: falta el árbol de pieza (piece)')
    const theme = getTheme(themeName)
    const opts: RenderOpts = { tokens: theme.tokens, interactive: !!interactive }
    // PI multi-vista: barra de navegación de páginas, arriba de la pieza (links `?page=<id>`).
    const nav = pages ? renderPagesNav(pages) : ''
    let body = nav + (await renderNode(piece, opts))
    const hasTable = body.includes('class="table vtable"')
    // GAVETA COMÚN (un solo shell por documento) para cualquier PI interactivo: dashboard y/o tabla.
    // 3 tabs: Controles · Guardados · Config. Dashboard → sus facetas van server-rendered en
    // `.tray-sections` + script de recompute; Tabla → el runtime inyecta sus controles ahí.
    const hasTray = !!interactive || hasTable
    if (interactive) {
      body = renderTrayShell(renderDashboardFacets(interactive), theme.palettes, palette) + body + renderInteractiveScript(interactive)
    } else if (hasTable) {
      body = renderTrayShell('', theme.palettes, palette) + body
    }
    if (hasTray) body += `<style>${TRAY_CSS}</style>`
    // Tabla interactiva (orden/filtro/búsqueda/agrupar): CSS + runtime se inyectan UNA vez
    // por documento si hay al menos una `.vtable`. Cada tabla se autoarranca desde su JSON.
    if (hasTable) {
      body += `<style>${TABLE_INTERACTIVE_CSS}</style><script>${TABLE_RUNTIME_SOURCE}</script>`
    }
    if (pages) body += `<style>${PAGES_NAV_CSS}</style>`
    return { html: theme.wrap({ title: title ?? 'Vergis', body, meta, palette }) }
  },
}

/** CSS de la barra de navegación de vistas (PI multi-vista). Variables del theme con fallback claro. */
const PAGES_NAV_CSS = `
.vpages{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 18px;border-bottom:1px solid var(--border,#e2e8f0)}
.vpages a{font-size:13px;padding:8px 16px;text-decoration:none;color:var(--fg-dim,#64748b);border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.vpages a:hover{color:var(--fg,#1f2937)}
.vpages a.active{color:var(--green,#2563eb);border-bottom-color:var(--green,#2563eb);font-weight:600}
`

/** Barra de navegación de vistas: un link por página (`?page=<id>`), marcando la activa. */
function renderPagesNav(pages: PagesNav): string {
  const tabs = pages.items
    .map(
      (p) =>
        `<a href="?page=${encodeURIComponent(p.id)}"${p.id === pages.active ? ' class="active" aria-current="page"' : ''}>${escapeHtml(p.title)}</a>`,
    )
    .join('')
  return `<nav class="vpages" role="tablist">${tabs}</nav>`
}

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
      return renderTable(node)
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
      ? ` <span class="kpi-comparison">${escapeHtml(node.comparisonLabel ?? '')} ${escapeHtml(formatValue(node.comparison, 'int_0'))}</span>`
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
  const pct = total > 0 ? Math.round((present / total) * 100) : 0
  const cls = pct >= green ? 'green' : pct >= yellow ? 'yellow' : 'red'
  return (
    `<div class="tl-card ${cls}">` +
    `<div class="area-name" title="${escapeHtml(label)}">${escapeHtml(label)}</div>` +
    `<span class="headcount">${present} / ${total}</span>` +
    `<span class="pct ${cls}">${pct}%</span>` +
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
function renderTrayShell(sections: string, palettes?: { id: string; label: string }[], activePalette?: string): string {
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
  const footer =
    `<div class="tray-foot">` +
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
      const values = [...new Set(rows.map((r) => String(r[f.field] ?? '')))].sort((a, b) => a.localeCompare(b))
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

function renderInteractiveScript(it: Interactive): string {
  const data = JSON.stringify(it.datasets).replace(/</g, '\\u003c')
  const filters = JSON.stringify(it.filters).replace(/</g, '\\u003c')
  return `<script>
(function(){
  var DATA = ${data}, FILTERS = ${filters};
  var tray = document.getElementById('vergis-filters');
  var countEl = document.getElementById('vergis-count');
  var boxes = tray ? Array.prototype.slice.call(tray.querySelectorAll('input[type=checkbox]')) : [];
  function fmt(v, f){
    if (f === 'percent_1') return (v*100).toFixed(1) + '%';
    if (f === 'int_0') return new Intl.NumberFormat('es-CL',{maximumFractionDigits:0}).format(Math.round(v));
    return String(v);
  }
  function agg(rows, a){
    function sum(f){ return rows.reduce(function(s,r){ return s + (Number(r[f])||0); }, 0); }
    if (a.op === 'ratio'){ var d = sum(a.den); return d ? sum(a.num)/d : 0; }
    return sum(a.field);
  }
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function card(r, c){
    var present = Number(r[c.presentField]), total = Number(r[c.totalField]);
    var pct = total > 0 ? Math.round(present/total*100) : 0;
    var cls = pct >= c.green ? 'green' : pct >= c.yellow ? 'yellow' : 'red';
    var label = String(r[c.labelField] || '');
    return '<div class="tl-card '+cls+'"><div class="area-name" title="'+esc(label)+'">'+esc(label)+
      '</div><span class="headcount">'+present+' / '+total+'</span><span class="pct '+cls+'">'+pct+'%</span></div>';
  }
  function selectedFor(field){ return boxes.filter(function(b){ return b.getAttribute('data-field')===field && b.checked; }).map(function(b){ return b.value; }); }
  function totalSelected(){ return boxes.filter(function(b){ return b.checked; }).length; }
  // Recompute dataset-aware: cada elemento se filtra solo por los filtros de SU dataset.
  function filteredRowsFor(ds){
    var rows = DATA[ds] || [];
    var fs = FILTERS.filter(function(f){ return f.dataset === ds; });
    return rows.filter(function(r){
      return fs.every(function(f){
        var picked = selectedFor(f.field);
        return picked.length === 0 || picked.indexOf(String(r[f.field])) !== -1;
      });
    });
  }
  function update(){
    if (countEl){ var n = totalSelected(); countEl.textContent = n ? String(n) : ''; }
    document.querySelectorAll('[data-agg]').forEach(function(el){
      var a = JSON.parse(el.getAttribute('data-agg'));
      el.querySelector('.kpi-value').textContent = fmt(agg(filteredRowsFor(a.dataset), a), el.getAttribute('data-format'));
      var ca = el.getAttribute('data-comparison-agg');
      if (ca){ var cab = JSON.parse(ca); var cmp = el.querySelector('.kpi-comparison');
        if (cmp) cmp.textContent = (el.getAttribute('data-comparison-label')||'') + ' ' + fmt(agg(filteredRowsFor(cab.dataset || a.dataset), cab), 'int_0'); }
    });
    document.querySelectorAll('[data-semaforo]').forEach(function(el){
      var c = JSON.parse(el.getAttribute('data-semaforo'));
      el.querySelector('.tl-grid').innerHTML = filteredRowsFor(c.dataset).map(function(r){ return card(r, c); }).join('');
    });
    document.querySelectorAll('[data-summary]').forEach(function(el){
      var s = JSON.parse(el.getAttribute('data-summary'));
      var v = el.querySelector('.ss-val');
      if (v) v.textContent = fmt(agg(filteredRowsFor(s.dataset), s.agg), s.format);
    });
  }
  boxes.forEach(function(b){ b.addEventListener('change', update); });
  Array.prototype.slice.call(document.querySelectorAll('.faceta-clear')).forEach(function(btn){
    btn.addEventListener('click', function(){
      var field = btn.getAttribute('data-field');
      boxes.forEach(function(b){ if (b.getAttribute('data-field')===field) b.checked = false; });
      update();
    });
  });
  // Tab "Vistas" para el dashboard: una vista = las selecciones de faceta. Mismo snippet que la tabla.
  ${SAVED_VIEWS_JS}
  function dashSnapshot(){ var s={}; boxes.forEach(function(b){ if(b.checked){ var f=b.getAttribute('data-field'); (s[f]=s[f]||[]).push(b.value); } }); return { facets: s }; }
  function dashApply(st){ var sel=(st&&st.facets)||{}; boxes.forEach(function(b){ var f=b.getAttribute('data-field'); b.checked = !!(sel[f] && sel[f].indexOf(b.value)!==-1); }); update(); }
  vergisSavedViews({ snapshot: dashSnapshot, apply: dashApply });
})();
</script>`
}

async function renderDistribution(node: ResolvedNode, tokens: ThemeTokens): Promise<string> {
  const rows = node.rows ?? []
  const dim = node.dimensionField ?? 'dimension'
  const metric = node.metricField ?? 'metric'
  const horizontal = (node.orientation ?? 'horizontal') === 'horizontal'
  const spec: TopLevelSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    background: 'transparent',
    width: 320,
    height: Math.max(120, rows.length * 34),
    data: { values: rows },
    mark: { type: 'bar', cornerRadiusEnd: 2, color: tokens.chartBar },
    encoding: horizontal
      ? { y: { field: dim, type: 'nominal', sort: '-x', title: null }, x: { field: metric, type: 'quantitative', title: null } }
      : { x: { field: dim, type: 'nominal', sort: '-y', title: null }, y: { field: metric, type: 'quantitative', title: null } },
    config: {
      view: { stroke: null },
      axis: {
        labelFontSize: 12,
        grid: false,
        labelColor: tokens.chartText,
        titleColor: tokens.chartText,
        domainColor: tokens.chartAxis ?? tokens.chartText,
        tickColor: tokens.chartAxis ?? tokens.chartText,
      },
    },
  }
  const svg = await vegaLiteToSvg(spec)
  return `<section class="chart">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''}${svg}</section>`
}

function renderTable(node: ResolvedNode): string {
  const cols = node.columnsSpec ?? []
  const rows = node.rows ?? []
  const ranges = colorscaleRanges(cols, rows)
  const tbody = renderTableBody(cols, rows, ranges)
  const titleHtml = node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''

  // Auto-on por defecto: la tabla es interactiva salvo `interactive: false` (kill switch).
  if (node.interactive === false) {
    const head = cols.map((c) => `<th class="align-${c.align ?? 'left'}">${escapeHtml(c.label ?? c.field)}</th>`).join('')
    const staticBody = node.drill ? renderStaticDrillBody(cols, rows, ranges, node.drill) : tbody
    return (
      `<section class="table">${titleHtml}` +
      `<table><thead><tr>${head}</tr></thead><tbody>${staticBody}</tbody></table></section>${node.drill ? `<style>${DRILL_CSS}</style>` : ''}`
    )
  }
  return renderInteractiveTable(node, cols, rows, ranges, tbody, titleHtml)
}

function renderTableBody(
  cols: TableColumn[],
  rows: Record<string, unknown>[],
  ranges: Record<string, { min: number; max: number }>,
): string {
  return rows
    .map((r) => {
      const cells = cols
        .map((c) => {
          const raw = r[c.field]
          const text = formatValue(raw, c.format)
          const bg = c.colorscale ? colorscaleBg(Number(raw), ranges[c.field]) : ''
          return `<td class="align-${c.align ?? 'left'}"${bg}>${escapeHtml(text)}</td>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('\n')
}

function renderInteractiveTable(
  node: ResolvedNode,
  cols: TableColumn[],
  rows: Record<string, unknown>[],
  ranges: Record<string, { min: number; max: number }>,
  tbody: string,
  titleHtml: string,
): string {
  // Meta de columnas que viaja al runtime (sortable/searchable resueltos; filter/groupBy tri-estado).
  const colMeta = cols.map((c) => ({
    field: c.field,
    label: c.label ?? c.field,
    align: c.align ?? 'left',
    format: c.format,
    colorscale: c.colorscale === true || undefined,
    ranges: c.colorscale ? ranges[c.field] : undefined,
    sortable: c.sortable !== false,
    searchable: c.searchable !== false,
    // La columna de anotación: sin faceta ni agrupar (texto libre); editable lo maneja el runtime.
    filter: c.annotation ? false : c.filter,
    groupBy: c.annotation ? false : c.groupBy,
    annotation: c.annotation || undefined,
  }))
  // Cada columna filtrable lleva un ícono discreto (embudo) en su header. Al clickearlo se
  // abre un popover (estilo autofiltro): buscador que acota + selector de valores únicos.
  // Sin fila de búsqueda siempre visible.
  const headCells = colMeta
    .map((c) => {
      const sortAttr = c.sortable ? ' data-sortable="1"' : ''
      const sortCls = c.sortable ? ' vt-sortable' : ''
      const filterCtrl =
        c.filter !== false
          ? `<button type="button" class="vt-filter-btn" data-field="${escapeHtml(c.field)}" aria-label="Filtrar y buscar en ${escapeHtml(c.label)}" title="Filtrar / buscar">` +
            `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M1.7 3h12.6l-5 6v4.1l-2.6 1.2V9z" fill="currentColor"/></svg></button>` +
            `<div class="vt-col-pop" data-field="${escapeHtml(c.field)}" hidden></div>`
          : ''
      return (
        `<th class="align-${c.align}${sortCls} vt-col" data-field="${escapeHtml(c.field)}"${sortAttr} aria-sort="none">` +
        `<span class="vt-th-inner"><span class="vt-th-label">${escapeHtml(c.label)}<span class="vt-sort-ind"></span></span>${filterCtrl}</span></th>`
      )
    })
    .join('')

  // Los controles globales (búsqueda en toda la tabla, agrupar, limpiar, conteo) NO van inline:
  // el runtime los inyecta en la GAVETA COMÚN (.tray-sections). Inline solo quedan los chips de
  // filtros activos (feedback visible sin abrir la gaveta) y el ícono por columna en el header.
  const chips = `<div class="vt-chips"></div>`

  // Datos embebidos (raw, ya RLS-filtrados) + meta. Escape de `<` para no romper el </script>.
  // `annotation` (si la tabla la tiene): el runtime habilita la columna editable + mostrar/ocultar.
  // `drill` (si la tabla la tiene): el runtime hace clickeable cada fila hoja → `?page=<to>&ctx.<by>=<val>`.
  const payload = JSON.stringify({ rows, cols: colMeta, annotation: node.annotation, drill: node.drill }).replace(/</g, '\\u003c')

  return (
    `<section class="table vtable">${titleHtml}${chips}` +
    `<div class="vt-scroll"><table><thead><tr class="vt-head-row">${headCells}</tr></thead>` +
    `<tbody>${tbody}</tbody></table></div>` +
    `<script type="application/json" class="vtable-data">${payload}</script></section>`
  )
}

/** CSS de filas con drill-through (clickeables). Compartido por tabla estática e interactiva. */
const DRILL_CSS = `tr.vt-drill-row{cursor:pointer}tr.vt-drill-row:hover td{background:var(--card,#eef2ff)}`

/** Cuerpo de tabla ESTÁTICA con drill: cada fila navega a `?page=<to>&ctx.<by>=<valor>`. */
function renderStaticDrillBody(
  cols: TableColumn[],
  rows: Record<string, unknown>[],
  ranges: Record<string, { min: number; max: number }>,
  drill: { to: string; by: string },
): string {
  return rows
    .map((r) => {
      const cells = cols
        .map((c) => {
          const raw = r[c.field]
          const bg = c.colorscale ? colorscaleBg(Number(raw), ranges[c.field]) : ''
          return `<td class="align-${c.align ?? 'left'}"${bg}>${escapeHtml(formatValue(raw, c.format))}</td>`
        })
        .join('')
      const href = `?page=${encodeURIComponent(drill.to)}&ctx.${encodeURIComponent(drill.by)}=${encodeURIComponent(String(r[drill.by] ?? ''))}`
      return `<tr class="vt-drill-row" data-href="${escapeHtml(href)}" onclick="location.assign(this.getAttribute('data-href'))">${cells}</tr>`
    })
    .join('\n')
}

function colorscaleRanges(cols: TableColumn[], rows: Record<string, unknown>[]): Record<string, { min: number; max: number }> {
  const ranges: Record<string, { min: number; max: number }> = {}
  for (const c of cols) {
    if (!c.colorscale) continue
    const nums = rows.map((r) => Number(r[c.field])).filter((n) => !Number.isNaN(n))
    ranges[c.field] = { min: Math.min(...nums), max: Math.max(...nums) }
  }
  return ranges
}

function colorscaleBg(value: number, range?: { min: number; max: number }): string {
  if (!range || Number.isNaN(value) || range.max === range.min) return ''
  const t = (value - range.min) / (range.max - range.min)
  const light = Math.round(95 - t * 45)
  return ` style="background:hsl(8,75%,${light}%)"`
}

async function vegaLiteToSvg(spec: TopLevelSpec): Promise<string> {
  const vgSpec = compile(spec).spec
  const view = new vega.View(vega.parse(vgSpec as vega.Spec), { renderer: 'none' })
  await view.runAsync()
  const svg = await view.toSVG()
  view.finalize()
  return svg
}

function formatValue(value: unknown, format?: string): string {
  if (typeof value === 'number') {
    switch (format) {
      case 'int_0':
        return new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(Math.round(value))
      case 'percent_1':
        return `${(value * 100).toFixed(1)}%`
      case 'percent':
        return `${Math.round(value * 100)}%`
      default:
        return String(value)
    }
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value ?? '')
}
