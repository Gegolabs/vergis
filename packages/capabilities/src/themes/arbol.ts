import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { escapeHtml } from '../markdown'
import type { DashboardMeta, Theme } from './index'

// Logo del proyecto A.R.B.O.L. embebido como data URI (autocontenido, offline).
const LOGO_DATA_URI = (() => {
  try {
    const p = resolve(dirname(fileURLToPath(import.meta.url)), 'arbol-logo.png')
    return `data:image/png;base64,${readFileSync(p).toString('base64')}`
  } catch {
    return ''
  }
})()

function formatDate(date?: string | Date): string {
  if (!date) return ''
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return String(date)
  return new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d)
}

const CLASSIFICATION_LABELS: Record<string, string> = {
  public: 'Público',
  internal: 'Uso interno',
  confidential: 'Confidencial',
  regulated: 'Regulado',
}
function classificationLabel(c?: string): string {
  return c ? (CLASSIFICATION_LABELS[c] ?? c) : ''
}

function formatDateTime(date?: string | Date): string {
  if (!date) return ''
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return String(date)
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Santiago',
  }).format(d)
}

/**
 * Theme "arbol" — paleta Gruvbox dark, header con logo A.R.B.O.L. + fecha,
 * réplica del dashboard referencial de QW-04 (cluster 052 del proyecto padre).
 */
export const arbolTheme: Theme = {
  name: 'arbol',
  tokens: {
    chartBar: '#b8bb26',
    chartText: '#ebdbb2',
    chartAxis: '#504945',
    // Acentos Gruvbox: verde · amarillo · azul · naranja · púrpura · rojo · aqua · gris.
    chartSeries: ['#b8bb26', '#fabd2f', '#83a598', '#fe8019', '#d3869b', '#fb4934', '#8ec07c', '#a89984'],
  },
  palettes: [
    { id: 'gruvbox', label: 'Oscuro' },
    { id: 'claro', label: 'Claro' },
    { id: 'blanco', label: 'Blanco' },
  ],
  wrap({ title, body, meta, controls, palette }: { title: string; body: string; meta?: DashboardMeta; controls?: string; palette?: string }) {
    const dateLabel = formatDate(meta?.date)
    const genLabel = formatDateTime(meta?.generatedAt)
    const initialPalette = palette && ['gruvbox', 'claro', 'blanco'].includes(palette) ? palette : 'gruvbox'
    const logo = LOGO_DATA_URI ? `<img class="logo" src="${LOGO_DATA_URI}" alt="A.R.B.O.L.">` : ''
    const metaBlock =
      `<div class="meta">` +
      (dateLabel ? `<div class="date">Datos al ${escapeHtml(dateLabel)}</div>` : '') +
      (genLabel ? `<div class="gen">Generado ${escapeHtml(genLabel)}</div>` : '') +
      `</div>`
    return `<!DOCTYPE html>
<html lang="es" data-palette="${initialPalette}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  /* Paletas conmutables (selector de apariencia en la bandeja) */
  html[data-palette="gruvbox"] {
    --bg: #1d2021; --panel: #282828; --card: #3c3836; --border: #504945;
    --fg: #ebdbb2; --fg-dim: #a89984;
    --green: #b8bb26; --yellow: #fabd2f; --red: #fb4934;
    --blue: #83a598; --orange: #fe8019; --purple: #d3869b; --gray: #a89984;
  }
  html[data-palette="claro"] {
    --bg: #fbf1c7; --panel: #f2e5bc; --card: #ebdbb2; --border: #d5c4a1;
    --fg: #3c3836; --fg-dim: #7c6f64;
    --green: #79740e; --yellow: #b57614; --red: #9d0006;
    --blue: #076678; --orange: #af3a03; --purple: #8f3f71; --gray: #7c6f64;
  }
  html[data-palette="blanco"] {
    --bg: #ffffff; --panel: #ffffff; --card: #ffffff; --border: #e2e8f0;
    --fg: #1a1a1a; --fg-dim: #64748b;
    --green: #16a34a; --yellow: #d97706; --red: #dc2626;
    --blue: #2563eb; --orange: #ea580c; --purple: #9333ea; --gray: #64748b;
  }
  body { transition: background .2s ease, color .2s ease; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; background: var(--bg); color: var(--fg); transition: padding-right .22s ease; }
  /* Bandeja abierta: el contenido se encoge a la izquierda, sin solapar */
  body:has(.tray-toggle:checked) { padding-right: 320px; }
  .app-header { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; padding-right: 30px; }
  .app-header .logo { width: 34px; height: 34px; border-radius: 50%; }
  .app-header h1 { font-size: 20px; font-weight: 600; margin: 0; flex: 1; }
  .app-header .meta { text-align: right; line-height: 1.3; }
  .app-header .meta .date { color: var(--fg); font-size: 14px; font-weight: 600; }
  .app-header .meta .gen { color: var(--fg-dim); font-size: 11px; }
  .app-footer { margin-top: 22px; font-size: 11px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .app-footer .footer-org { color: var(--fg-dim); }
  .app-footer .footer-conf { color: var(--yellow); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
  .app-footer .footer-code { color: var(--fg-dim); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; }
  .app-footer .footer-credit { color: var(--fg-dim); opacity: .5; transition: opacity .18s ease; text-align: right; }
  .app-footer .footer-credit:hover { opacity: .9; }
  .app-footer strong { font-weight: 600; }
  .app-footer a { color: inherit; text-decoration: underline; }
  .app-footer a:hover { color: var(--green); }
  .app-footer .app-footer-detail { opacity: 0; transition: opacity .18s ease; }
  .app-footer .footer-credit:hover .app-footer-detail { opacity: 1; }
  h3 { font-size: 13px; color: var(--fg-dim); margin: 0 0 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }

  .layout-rows { display: flex; flex-direction: column; gap: 16px; }
  .layout-grid { display: grid; grid-template-columns: repeat(var(--cols, 1), minmax(0, 1fr)); gap: 12px; }
  .layout-flow > * + * { margin-top: 12px; }

  .banner { background: #503d1a; border: 1px solid var(--yellow); color: var(--yellow); padding: 8px 14px; border-radius: 8px; font-size: 13px; }

  /* Bandeja de filtros off-canvas + uña/pestaña en el borde derecho (CTA universal) */
  .tray-tab { position: fixed; right: 0; top: 18px; z-index: 45; cursor: pointer;
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    background: var(--card); border: 1px solid var(--border); border-right: none; border-radius: 7px 0 0 7px;
    padding: 8px 4px; color: var(--fg-dim); opacity: .35; transition: right .22s ease, opacity .15s ease; }
  .tray-tab:hover { opacity: 1; color: var(--green); border-color: var(--green); }
  .tray-tab:has(.faceta-count:not(:empty)) { opacity: 1; color: var(--green); border-color: var(--green); }
  .tray-tab .faceta-count:not(:empty) { font-size: 9px; color: var(--green); font-weight: 700; }
  .tray-toggle:checked ~ .tray-tab { right: 300px; opacity: 1; }
  .tray { position: fixed; top: 0; right: 0; height: 100vh; width: 300px; background: var(--panel); border-left: 1px solid var(--border); z-index: 50; transform: translateX(100%); transition: transform .22s ease; padding: 18px; overflow: auto; box-shadow: -14px 0 34px rgba(0,0,0,.35); box-sizing: border-box; }
  .tray-toggle:checked ~ .tray { transform: translateX(0); }
  .tray-toggle:checked ~ .tray-tab { right: 300px; }
  .tray-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .tray-head strong { font-size: 15px; }
  .tray-close { cursor: pointer; color: var(--fg-dim); font-size: 18px; line-height: 1; }
  .tray-close:hover { color: var(--red); }
  .faceta { margin-bottom: 16px; }
  .faceta-title { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: .04em; font-weight: 600; margin-bottom: 6px; }
  .faceta-clear { background: none; border: none; color: var(--fg-dim); cursor: pointer; font-size: 11px; text-decoration: underline; padding: 0; }
  .faceta-clear:hover { color: var(--green); }
  .faceta-options { max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
  .faceta-appearance .faceta-options { max-height: none; }
  .faceta-options label { display: flex; gap: 8px; align-items: center; font-size: 13px; padding: 4px 2px; color: var(--fg); cursor: pointer; text-transform: none; letter-spacing: 0; }
  .faceta-options label:hover { color: var(--green); }
  .tray-actions { margin-top: 18px; border-top: 1px solid var(--border); padding-top: 14px; }
  .tray-print { width: 100%; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 8px; padding: 9px; cursor: pointer; font-size: 13px; }
  .tray-print:hover { border-color: var(--green); color: var(--green); }
  .tray-credit { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--fg-dim); font-size: 10px; line-height: 1.6; }
  .tray-credit strong { color: var(--fg); font-weight: 600; font-size: 12px; }
  .tray-credit a { color: var(--fg-dim); text-decoration: underline; }
  .tray-credit a:hover { color: var(--green); }

  .kpi { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .kpi-lg { display: flex; flex-direction: column; justify-content: center; min-height: 132px; padding: 24px; }
  .kpi-lg .kpi-value { font-size: 52px; }
  .kpi-lg .kpi-label { font-size: 13px; }
  .kpi-value { font-size: 32px; font-weight: 800; line-height: 1.05; }
  .kpi-label { font-size: 11px; color: var(--fg-dim); margin-top: 6px; text-transform: uppercase; letter-spacing: .05em; }
  .kpi-comparison { color: var(--fg-dim); text-transform: none; letter-spacing: 0; }
  .kpi[data-accent="green"] .kpi-value { color: var(--green); }
  .kpi[data-accent="blue"] .kpi-value { color: var(--blue); }
  .kpi[data-accent="red"] .kpi-value { color: var(--red); }
  .kpi[data-accent="orange"] .kpi-value { color: var(--orange); }
  .kpi[data-accent="purple"] .kpi-value { color: var(--purple); }
  .kpi[data-accent="gray"] .kpi-value { color: var(--gray); }

  /* dato (TX-12): atributo rotulado — tipografía de texto, NO tarjeta-medida (distinto del kpi) */
  .dato { display: flex; flex-direction: column; gap: 2px; padding: 6px 0; }
  .dato-k { font-size: 11px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: .04em; }
  .dato-v { font-size: 14px; color: var(--fg); font-weight: 600; }

  .chart, .table, .semaforo { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .chart svg { max-width: 100%; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 6px 10px; border-bottom: 1px solid var(--border); }
  th { text-align: left; color: var(--fg-dim); font-weight: 600; }
  .align-right { text-align: right; }

  .semaforo-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 10px; }
  .semaforo-head h3 { margin: 0; }
  .semaforo-summary { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
  .semaforo-summary .ss-val { font-size: 22px; font-weight: 800; color: var(--green); }
  .semaforo-summary .ss-lbl { font-size: 11px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: .04em; }
  .tl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
  .tl-card { background: var(--panel); border: 1px solid var(--border); border-left: 4px solid var(--gray); border-radius: 8px; padding: 8px 10px; }
  .tl-card.green { border-left-color: var(--green); }
  .tl-card.yellow { border-left-color: var(--yellow); }
  .tl-card.red { border-left-color: var(--red); }
  .tl-card .area-name { font-size: 11px; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tl-card .headcount { font-size: 12px; color: var(--fg); }
  .tl-card .pct { float: right; font-weight: 800; font-size: 15px; }
  .tl-card .pct.green { color: var(--green); }
  .tl-card .pct.yellow { color: var(--yellow); }
  .tl-card .pct.red { color: var(--red); }

  /* Impresión: ocultar controles, repintar en claro, orientación horizontal */
  @page { size: A4 landscape; margin: 12mm; }
  @media print {
    /* mismo selector de atributo que la paleta (si no, gana la oscura por especificidad) */
    html[data-palette] {
      --bg: #fff; --panel: #fff; --card: #fff; --border: #d0d0d0; --fg: #1a1a1a; --fg-dim: #555;
    }
    html, body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { padding: 0 4px !important; }
    .layout-rows, .layout-grid, .semaforo, .kpi, .tl-grid { max-width: 100%; }
    .tray, .tray-tab, .tray-toggle { display: none !important; }
    .app-header { padding-right: 0; }
    .kpi, .chart, .table, .semaforo { box-shadow: none !important; break-inside: avoid; }
    .tl-card { break-inside: avoid; }
    .app-footer .footer-credit { display: none !important; }
    .layout-grid { gap: 6px; }
    .kpi { padding: 8px; }
    .kpi-value { font-size: 21px; }
    .kpi-label { font-size: 8px; letter-spacing: 0; overflow-wrap: anywhere; }
    .kpi-comparison { display: block; }
  }
</style>
</head>
<body>
<header class="app-header">${logo}<h1>${escapeHtml(title)}</h1>${controls ?? ''}${metaBlock}</header>
${body}
<div class="app-footer">
  <span class="footer-org">${escapeHtml(meta?.org ?? '')}${meta?.org && meta?.classification ? ' · ' : ''}${meta?.classification ? `<span class="footer-conf">${escapeHtml(classificationLabel(meta.classification))}</span>` : ''}</span>
  ${meta?.code ? `<span class="footer-code">${escapeHtml(meta.code)}</span>` : ''}
</div>
</body>
</html>
`
  },
}
