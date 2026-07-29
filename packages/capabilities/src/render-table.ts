// Render de TABLAS (estáticas e interactivas) — extraído de render-html-piece.ts (NEXT · Ola 3·B).
// Del árbol resuelto a HTML: tabla estática (todas las filas) o interactiva (tbody SSR acotado + payload
// JSON embebido que el runtime de tabla hidrata con orden/filtro/búsqueda/agrupar/drill). El CSS
// interactivo (piece-css) y el runtime (table-runtime) los inyecta el ensamblador (render-html-piece).
import { escapeHtml } from './markdown'
import { ctxQuery, formatValue } from './piece-util'
import type { ResolvedNode, RenderOpts, Drill, CarryCtx, TableColumn } from './piece-types'

export const TABLE_SSR_MAX_ROWS = 500

export function renderTable(node: ResolvedNode, opts: RenderOpts): string {
  const carry = opts.carry
  const cols = node.columnsSpec ?? []
  const rows = node.rows ?? []
  const drills = node.drills ?? []
  const ranges = colorscaleRanges(cols, rows)
  const titleHtml = node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''
  // Las señales las marca quien emite la feature (no un sniff del HTML de salida): drills → celdas
  // `vt-actions`; tabla interactiva (default salvo `interactive:false`) → runtime + gaveta + CSS.
  if (drills.length > 0) opts.signals.drillActions = true

  // Heurística de plataforma (TX-11 WP4·1): una tabla DISPLAY —single_row, o que rinde 1 fila— es
  // presentación pura, no recibe maquinaria (runtime interactivo, iconos de filtro por columna, kit
  // del Inspector). `interactive: true` explícito la conserva. El kill-switch `interactive: false`
  // fuerza estática igual.
  const displayByRows = node.interactive !== true && rows.length === 1
  if (node.interactive === false || displayByRows) {
    // Estática/display: sin runtime que complete después → el tbody lleva TODAS las filas.
    const tbody = renderTableBody(cols, rows, ranges, drills, carry)
    const head =
      cols.map((c) => `<th class="align-${c.align ?? 'left'}">${escapeHtml(c.label ?? c.field)}</th>`).join('') +
      (drills.length ? `<th class="vt-actions" aria-label="Acciones"></th>` : '')
    return (
      `<section class="table">${titleHtml}` +
      `<table><thead><tr>${head}</tr></thead><tbody>${tbody}</tbody></table></section>`
    )
  }
  // Interactiva (auto-on): recién aquí se prende la señal → runtime + gaveta + CSS interactivo.
  opts.signals.interactiveTable = true
  const ssrComplete = rows.length <= TABLE_SSR_MAX_ROWS
  const tbody = renderTableBody(cols, ssrComplete ? rows : rows.slice(0, TABLE_SSR_MAX_ROWS), ranges, drills, carry)
  return renderInteractiveTable(node, cols, rows, ranges, tbody, titleHtml, drills, carry, ssrComplete)
}

/** href server-side de una acción de drill, preservando el carry (ctx) y agregando las claves `by`. */
function serverDrillHref(drill: Drill, row: Record<string, unknown>, carry: CarryCtx): string {
  const keys: Record<string, string> = {}
  for (const k of drill.by) keys[k] = String(row[k] ?? '')
  return `?page=${encodeURIComponent(drill.to)}${ctxQuery(carry, keys)}`
}

/** Celda de acciones de una fila: un link por drill (etiqueta del drill, o "→" si no la tiene). */
function drillActionsCell(drills: Drill[], row: Record<string, unknown>, carry: CarryCtx): string {
  if (drills.length === 0) return ''
  const links = drills
    .map((d) => {
      const href = escapeHtml(serverDrillHref(d, row, carry))
      const label = d.label ? escapeHtml(d.label) : '→'
      const cls = d.label ? 'vt-drill-link' : 'vt-drill-link vt-drill-arrow'
      const title = d.label ? escapeHtml(d.label) : 'Ver detalle'
      return `<a class="${cls}" href="${href}" title="${title}">${label}</a>`
    })
    .join('')
  return `<td class="vt-actions">${links}</td>`
}

function renderTableBody(
  cols: TableColumn[],
  rows: Record<string, unknown>[],
  ranges: Record<string, { min: number; max: number }>,
  drills: Drill[] = [],
  carry: CarryCtx = {},
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
      // Single-drill: la fila admite doble-clic (back-compat) además del link de acciones.
      const open = drills.length === 1 ? `<tr class="vt-drill-row" title="Doble clic: ver detalle" data-href="${escapeHtml(serverDrillHref(drills[0], r, carry))}">` : '<tr>'
      return `${open}${cells}${drillActionsCell(drills, r, carry)}</tr>`
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
  drills: Drill[] = [],
  carry: CarryCtx = {},
  ssrComplete = true,
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
    .join('') + (drills.length ? `<th class="vt-actions" aria-label="Acciones"></th>` : '')

  // Los controles globales (búsqueda en toda la tabla, agrupar, limpiar, conteo) NO van inline:
  // el runtime los inyecta en la GAVETA COMÚN (.tray-sections). Inline solo quedan los chips de
  // filtros activos (feedback visible sin abrir la gaveta) y el ícono por columna en el header.
  const chips = `<div class="vt-chips"></div>`

  // Datos embebidos (raw, ya RLS-filtrados) + meta. Escape de `<` para no romper el </script>.
  // `drills` (si la tabla las tiene): el runtime renderiza la columna de acciones (1 link por drill);
  //   con un solo drill, además habilita el doble-clic de fila. `carryCtx` se preserva en cada href.
  // `ssrComplete`: el tbody servido trae TODAS las filas (≤ TABLE_SSR_MAX_ROWS) — el runtime puede
  //   saltarse el render() inicial (que reconstruiría un tbody idéntico) si el estado es vacío.
  const payload = JSON.stringify({ rows, cols: colMeta, drills, carryCtx: carry, ssrComplete }).replace(/</g, '\\u003c')

  // Pie con el contador de filas (TX-11 WP4·3): información del documento, no control — vive en la
  // CARA de cada tabla interactiva (el runtime lo puebla) y se imprime (estado honesto).
  return (
    `<section class="table vtable">${titleHtml}${chips}` +
    `<div class="vt-scroll"><table><thead><tr class="vt-head-row">${headCells}</tr></thead>` +
    `<tbody>${tbody}</tbody></table></div>` +
    `<div class="vt-count-foot" role="status" aria-live="polite"></div>` +
    `<script type="application/json" class="vtable-data">${payload}</script></section>`
  )
}

function colorscaleRanges(cols: TableColumn[], rows: Record<string, unknown>[]): Record<string, { min: number; max: number }> {
  const ranges: Record<string, { min: number; max: number }> = {}
  for (const c of cols) {
    if (!c.colorscale) continue
    // Loop en vez de `Math.min(...nums)` / `Math.max(...nums)`: el spread de un arreglo de cientos de
    // miles de filas revienta el stack (RangeError: too many arguments). El loop es O(n) sin ese límite.
    let min = Infinity
    let max = -Infinity
    for (const r of rows) {
      const n = Number(r[c.field])
      if (Number.isNaN(n)) continue
      if (n < min) min = n
      if (n > max) max = n
    }
    ranges[c.field] = { min, max }
  }
  return ranges
}

function colorscaleBg(value: number, range?: { min: number; max: number }): string {
  if (!range || Number.isNaN(value) || range.max === range.min) return ''
  const t = (value - range.min) / (range.max - range.min)
  const light = Math.round(95 - t * 45)
  return ` style="background:hsl(8,75%,${light}%)"`
}
