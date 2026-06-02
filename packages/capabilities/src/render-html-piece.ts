import * as vega from 'vega'
import { compile, type TopLevelSpec } from 'vega-lite'
import type { Capability } from '@vergis/botler'
import { escapeHtml, renderMarkdown } from './markdown'
import { getTheme, type DashboardMeta, type ThemeTokens } from './themes'
import { TABLE_RUNTIME_SOURCE } from './table-runtime'

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
interface RenderParams {
  piece: ResolvedNode
  title?: string
  theme?: string
  meta?: DashboardMeta
  interactive?: Interactive
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
.vtable .vt-controls{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:10px}
.vtable .vt-global-search{flex:1 1 220px;min-width:170px;padding:7px 10px;font-size:13px;border:1px solid var(--border,#e2e8f0);border-radius:7px;background:var(--bg,#fff);color:var(--fg,#1f2937)}
.vtable .vt-groupby-wrap label{font-size:12px;color:var(--fg-dim,#64748b);display:inline-flex;gap:6px;align-items:center}
.vtable .vt-groupby{padding:6px 8px;font-size:13px;border:1px solid var(--border,#e2e8f0);border-radius:7px;background:var(--bg,#fff);color:var(--fg,#1f2937)}
.vtable .vt-count{font-size:12px;color:var(--fg-dim,#64748b);margin-left:auto;white-space:nowrap}
.vtable .vt-filters{display:flex;flex-wrap:wrap;gap:8px;flex-basis:100%}
.vtable .vt-facet{position:relative}
.vtable .vt-facet>summary{list-style:none;cursor:pointer;font-size:12px;padding:5px 10px;border:1px solid var(--border,#e2e8f0);border-radius:7px;background:var(--card,#fff);color:var(--fg,#1f2937)}
.vtable .vt-facet>summary::-webkit-details-marker{display:none}
.vtable .vt-facet[open]>summary{border-color:var(--green,#2563eb);color:var(--green,#2563eb)}
.vtable .vt-facet-opts{position:absolute;z-index:30;margin-top:4px;min-width:180px;max-height:260px;overflow:auto;background:var(--panel,#fff);border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:8px;box-shadow:0 10px 30px rgba(0,0,0,.22)}
.vtable .vt-facet-opts label{display:flex;gap:8px;align-items:center;font-size:13px;padding:3px 2px;color:var(--fg,#1f2937);white-space:nowrap;cursor:pointer}
.vtable .vt-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.vtable .vt-chips:empty{display:none}
.vtable .vt-chip{font-size:11px;padding:3px 8px;border-radius:20px;background:var(--card,#eef2ff);color:var(--fg,#1f2937);border:1px solid var(--border,#e2e8f0);cursor:pointer}
.vtable .vt-chip:hover{border-color:var(--red,#dc2626);color:var(--red,#dc2626)}
.vtable .vt-scroll{overflow-x:auto}
.vtable th.vt-sortable{cursor:pointer;user-select:none;white-space:nowrap}
.vtable th.vt-sortable:hover{color:var(--green,#2563eb)}
.vtable .vt-sort-ind{font-size:10px;margin-left:4px}
.vtable .vt-search-row th{padding-top:0;padding-bottom:8px}
.vtable .vt-col-search{width:100%;box-sizing:border-box;padding:4px 6px;font-size:12px;font-weight:400;border:1px solid var(--border,#e2e8f0);border-radius:5px;background:var(--bg,#fff);color:var(--fg,#1f2937)}
.vtable tr.vt-group-head td{background:var(--panel,#f1f5f9);font-weight:700;color:var(--fg,#1f2937);font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.vtable .vt-gcount{color:var(--fg-dim,#64748b);font-weight:600}
.vtable tr.vt-empty td{text-align:center;color:var(--fg-dim,#64748b);padding:18px;font-style:italic}
@media print{.vtable .vt-controls,.vtable .vt-chips,.vtable .vt-search-row{display:none!important}}
`

export const renderHtmlPiece: Capability = {
  name: 'render-html-piece',
  async execute(params: unknown): Promise<unknown> {
    const { piece, title, theme: themeName, meta, interactive } = (params ?? {}) as RenderParams
    if (!piece) throw new Error('render-html-piece: falta el árbol de pieza (piece)')
    const theme = getTheme(themeName)
    const opts: RenderOpts = { tokens: theme.tokens, interactive: !!interactive }
    let body = await renderNode(piece, opts)
    if (interactive) {
      // La bandeja (con su uña/pestaña) es overlay universal: no forma parte del dashboard.
      body = renderFaceta(interactive, theme.palettes) + body + renderInteractiveScript(interactive)
    }
    // Tabla interactiva (orden/filtro/búsqueda/agrupar): CSS + runtime se inyectan UNA vez
    // por documento si hay al menos una `.vtable`. Cada tabla se autoarranca desde su JSON.
    if (body.includes('class="table vtable"')) {
      body += `<style>${TABLE_INTERACTIVE_CSS}</style><script>${TABLE_RUNTIME_SOURCE}</script>`
    }
    return { html: theme.wrap({ title: title ?? 'Vergis', body, meta }) }
  },
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
 * Bandeja de filtros (off-canvas, desde la derecha). Es el lugar donde viven los
 * filtros disponibles (cada uno una Faceta catalogo-selector). El CTA es una uña
 * /pestaña que sobresale del borde derecho — universal, ajena al dashboard. Al
 * abrir, el contenido se encoge a la izquierda (no se solapa) para ver el resultado
 * en vivo. Apertura/cierre por toggle CSS puro.
 */
function renderFaceta(it: Interactive, palettes?: { id: string; label: string }[]): string {
  const groups = it.filters
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
  // Selector de apariencia (cambia la paleta del theme en vivo) — vive en la bandeja.
  let appearance = ''
  if (palettes && palettes.length > 1) {
    const radios = palettes
      .map(
        (p, i) =>
          `<label><input type="radio" name="vergis-palette" value="${escapeHtml(p.id)}"${i === 0 ? ' checked' : ''} onchange="document.documentElement.dataset.palette=this.value"> ${escapeHtml(p.label)}</label>`,
      )
      .join('')
    appearance =
      `<div class="faceta faceta-appearance"><div class="faceta-title">Apariencia</div>` +
      `<div class="faceta-options">${radios}</div></div>`
  }
  return (
    `<input type="checkbox" id="vergis-tray-toggle" class="tray-toggle" hidden>` +
    `<label for="vergis-tray-toggle" class="tray-tab" title="Filtros" aria-label="Abrir filtros">` +
    `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 3.2h12l-4.6 5.5v3.4l-2.8 1.4V8.7z"/></svg>` +
    `<span class="faceta-count" id="vergis-count"></span>` +
    `</label>` +
    `<aside class="tray" id="vergis-filters" role="dialog" aria-label="Filtros">` +
    `<div class="tray-head"><strong>Filtros</strong><label for="vergis-tray-toggle" class="tray-close" title="Cerrar">✕</label></div>` +
    groups +
    appearance +
    `<div class="tray-actions"><button type="button" class="tray-print" onclick="window.print()">Imprimir</button></div>` +
    `<div class="tray-credit">Powered by <strong>Vergis</strong><br>© 2026 Gegolabs · <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener">AGPL-3.0</a> · <a href="https://agencydomains.org" target="_blank" rel="noopener">código fuente</a></div>` +
    `</aside>`
  )
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
    return (
      `<section class="table">${titleHtml}` +
      `<table><thead><tr>${head}</tr></thead><tbody>${tbody}</tbody></table></section>`
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
    filter: c.filter,
    groupBy: c.groupBy,
  }))
  const anySearchable = colMeta.some((c) => c.searchable)

  const headCells = colMeta
    .map((c) => {
      const sortAttr = c.sortable ? ' data-sortable="1"' : ''
      const sortCls = c.sortable ? ' vt-sortable' : ''
      return (
        `<th class="align-${c.align}${sortCls}" data-field="${escapeHtml(c.field)}"${sortAttr} aria-sort="none">` +
        `${escapeHtml(c.label)}<span class="vt-sort-ind"></span></th>`
      )
    })
    .join('')
  const searchCells = colMeta
    .map((c) =>
      c.searchable
        ? `<th class="align-${c.align}"><input class="vt-col-search" data-field="${escapeHtml(c.field)}" type="text" placeholder="buscar…" aria-label="Buscar en ${escapeHtml(c.label)}"></th>`
        : `<th class="align-${c.align}"></th>`,
    )
    .join('')

  const controls =
    `<div class="vt-controls">` +
    (anySearchable
      ? `<input class="vt-global-search" type="search" placeholder="Buscar en toda la tabla…" aria-label="Buscar en toda la tabla">`
      : '') +
    `<span class="vt-groupby-wrap"><label>Agrupar por <select class="vt-groupby"><option value="">(sin agrupar)</option></select></label></span>` +
    `<span class="vt-count" role="status" aria-live="polite"></span>` +
    `<div class="vt-filters"></div>` +
    `</div>` +
    `<div class="vt-chips"></div>`

  // Datos embebidos (raw, ya RLS-filtrados) + meta. Escape de `<` para no romper el </script>.
  const payload = JSON.stringify({ rows, cols: colMeta }).replace(/</g, '\\u003c')

  return (
    `<section class="table vtable">${titleHtml}${controls}` +
    `<div class="vt-scroll"><table><thead><tr class="vt-head-row">${headCells}</tr>` +
    `<tr class="vt-search-row">${searchCells}</tr></thead><tbody>${tbody}</tbody></table></div>` +
    `<script type="application/json" class="vtable-data">${payload}</script></section>`
  )
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
