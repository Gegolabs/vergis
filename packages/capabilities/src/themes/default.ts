import { escapeHtml } from '../markdown'
import type { Theme } from './index'

/** Theme claro por defecto (el look base de v0.1). */
export const defaultTheme: Theme = {
  name: 'default',
  tokens: { chartBar: '#2563eb', chartText: '#334155', chartAxis: '#e2e8f0' },
  wrap({ title, body, controls }) {
    const header = controls ? `<div style="display:flex;justify-content:flex-end;margin-bottom:12px">${controls}</div>` : ''
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: #1f2937; }
  body { margin: 0; padding: 24px; background: #f8fafc; transition: padding-right .22s ease; }
  body:has(.tray-toggle:checked) { padding-right: 324px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h3 { font-size: 14px; color: #475569; margin: 0 0 8px; font-weight: 600; }
  .layout-rows { display: flex; flex-direction: column; gap: 16px; }
  .layout-grid { display: grid; grid-template-columns: repeat(var(--cols, 1), minmax(0, 1fr)); gap: 12px; }
  .layout-flow > * + * { margin-top: 12px; }
  .banner { background: #fef3c7; border: 1px solid #f59e0b; color: #92400e; padding: 8px 14px; border-radius: 8px; font-size: 13px; }
  .tray-tab { position: fixed; right: 0; top: 22px; z-index: 45; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 3px; background: #fff; border: 1px solid #e2e8f0; border-right: none; border-radius: 7px 0 0 7px; padding: 8px 4px; color: #94a3b8; opacity: .4; transition: right .22s ease, opacity .15s ease; }
  .tray-tab:hover, .tray-tab:has(.faceta-count:not(:empty)) { opacity: 1; color: #2563eb; border-color: #2563eb; }
  .tray-tab .faceta-count:not(:empty) { font-size: 9px; color: #2563eb; font-weight: 700; }
  .tray { position: fixed; top: 0; right: 0; height: 100vh; width: 300px; background: #fff; border-left: 1px solid #e2e8f0; z-index: 50; transform: translateX(100%); transition: transform .22s ease; padding: 18px; overflow: auto; box-shadow: -14px 0 34px rgba(0,0,0,.12); box-sizing: border-box; }
  .tray-toggle:checked ~ .tray { transform: translateX(0); }
  .tray-toggle:checked ~ .tray-tab { right: 300px; }
  .tray-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .tray-close { cursor: pointer; color: #94a3b8; font-size: 18px; }
  .faceta { margin-bottom: 16px; }
  .faceta-title { display: flex; justify-content: space-between; font-size: 12px; color: #64748b; font-weight: 600; margin-bottom: 6px; }
  .faceta-clear { background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 11px; text-decoration: underline; }
  .faceta-options { max-height: 220px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 8px; }
  .faceta-appearance .faceta-options { max-height: none; }
  .faceta-options label { display: flex; gap: 8px; align-items: center; font-size: 13px; padding: 4px 2px; }
  .tray-actions { margin-top: 16px; }
  .tray-print { width: 100%; background: #fff; color: #1f2937; border: 1px solid #e2e8f0; border-radius: 8px; padding: 9px; cursor: pointer; font-size: 13px; }
  .tray-credit { margin-top: 16px; padding-top: 12px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 10px; line-height: 1.6; }
  .tray-credit strong { color: #1f2937; font-size: 12px; }
  .tray-credit a { color: #94a3b8; }
  .kpi { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; }
  .kpi-value { font-size: 30px; font-weight: 700; line-height: 1.1; }
  .kpi-label { font-size: 12px; color: #64748b; margin-top: 4px; text-transform: uppercase; letter-spacing: .03em; }
  .kpi-comparison { color: #94a3b8; text-transform: none; letter-spacing: 0; }
  .chart, .table, .semaforo { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 6px 10px; border-bottom: 1px solid #f1f5f9; }
  th { text-align: left; color: #64748b; font-weight: 600; }
  .align-right { text-align: right; }
  .semaforo-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 10px; }
  .semaforo-head h3 { margin: 0; }
  .semaforo-summary { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
  .semaforo-summary .ss-val { font-size: 22px; font-weight: 700; color: #16a34a; }
  .semaforo-summary .ss-lbl { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: .03em; }
  .tl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .tl-card { border: 1px solid #e2e8f0; border-left: 4px solid #cbd5e1; border-radius: 8px; padding: 8px 10px; }
  .tl-card.green { border-left-color: #16a34a; }
  .tl-card.yellow { border-left-color: #d97706; }
  .tl-card.red { border-left-color: #dc2626; }
  .tl-card .area-name { font-size: 11px; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tl-card .headcount { font-size: 12px; color: #94a3b8; }
  .tl-card .pct { float: right; font-weight: 700; }
  .tray-actions { margin-top: 18px; border-top: 1px solid #e2e8f0; padding-top: 14px; }
  .tray-print { width: 100%; background: #fff; color: #1f2937; border: 1px solid #e2e8f0; border-radius: 8px; padding: 9px; cursor: pointer; font-size: 13px; }
  @page { size: A4 landscape; margin: 12mm; }
  @media print {
    body { padding: 0 !important; }
    .tray, .tray-tab, .tray-toggle { display: none !important; }
    .kpi, .chart, .table, .semaforo, .tl-card { box-shadow: none !important; break-inside: avoid; }
  }
</style>
</head>
<body>
${header}
${body}
</body>
</html>
`
  },
}
