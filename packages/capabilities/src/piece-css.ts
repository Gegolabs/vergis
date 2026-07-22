// CSS por-documento de las piezas interactivas — extraído de render-html-piece.ts (NEXT · Ola 3·B).
// Constantes de estilo PURAS (sin lógica): el runtime de tabla (orden/filtro/búsqueda/agrupar/anotar/
// drill) y la gaveta común (tabs Controles·Guardados·Config). Usan las variables del theme con fallback
// al look claro → sirven en `arbol` (define las vars) y en `default` (cae al fallback). Se inyectan una
// vez por documento cuando corresponde (ver renderHtmlPiece). Aquí viven separadas de la lógica de render.

/**
 * CSS de la tabla interactiva. Usa las variables del theme con fallback al look claro,
 * así sirve en `arbol` (que define las vars) y en `default` (que cae al fallback).
 * Se inyecta una vez por documento (ver renderHtmlPiece).
 */
export const TABLE_INTERACTIVE_CSS = `
.vtable .vt-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.vtable .vt-chips:empty{display:none}
.vtable .vt-chip{font-size:11px;padding:3px 8px;border-radius:20px;background:var(--card,#eef2ff);color:var(--fg,#1f2937);border:1px solid var(--border,#e2e8f0);cursor:pointer}
.vtable .vt-chip:hover{border-color:var(--red,#dc2626);color:var(--red,#dc2626)}
.vtable .vt-scroll{overflow:auto;max-height:70vh}
.vtable thead th,.vtable th.vt-col{position:sticky;top:0;z-index:3;background:var(--bg,#fff)}
.vtable thead th::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--border,#e2e8f0)}
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
.tray .vt-tray-section .vt-export{width:100%;padding:8px;font-size:12px;background:var(--card,#fff);color:var(--fg-dim,#64748b);border:1px solid var(--border,#e2e8f0);border-radius:7px;cursor:pointer}
.tray .vt-tray-section .vt-export:hover{color:var(--green,#16a34a);border-color:var(--green,#16a34a)}
.tray .vt-kit-target{margin-bottom:16px}
.tray .vt-kit-target .vt-kit-target-sel{width:100%;box-sizing:border-box;padding:7px 9px;font-size:13px;border:1px solid var(--border,#e2e8f0);border-radius:7px;background:var(--bg,#fff);color:var(--fg,#1f2937);cursor:pointer}
.tray .vt-kit-target .vt-kit-target-sel:hover{border-color:var(--green,#2563eb)}
.vtable .vt-count-foot{margin-top:8px;font-size:11px;color:var(--fg-dim,#64748b)}
.vtable .vt-count-foot:empty{display:none}
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
.vtable tbody tr.vt-selected td{background:var(--card,#e0e7ff)}
.vtable tbody tr.vt-selected td:first-child{box-shadow:inset 3px 0 0 var(--green,#2563eb)}
.vtable td.vt-drill-arrow{color:var(--green,#2563eb);font-weight:700;text-align:center;width:1.6em}
@media print{.vtable .vt-filter-btn,.vtable .vt-ann-hint,.vtable td.vt-drill-arrow,.vtable .vt-chip-x{display:none!important}.vtable td.vt-ann-cell:empty::before{content:''}.vtable .vt-chips{display:block;margin:0 0 6px;font-size:10px;color:var(--fg-dim,#64748b)}.vtable .vt-chips::before{content:"Filtros: ";font-weight:600}.vtable .vt-chip{display:inline;background:none!important;border:none!important;padding:0;border-radius:0;margin:0;color:var(--fg-dim,#64748b);cursor:default}.vtable .vt-chip:not(:first-child)::before{content:"· "}}
`

/** CSS de la gaveta común: tabs (Controles·Guardados·Config) + panel de filtros guardados.
 *  Se inyecta una vez por documento cuando hay gaveta (dashboard o tabla). Variables del theme
 *  con fallback claro → sirve en arbol y default. */
export const TRAY_CSS = `
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
.tray-empty{font-size:12px;line-height:1.5;color:var(--fg-dim,#94a3b8);padding:10px 2px}
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
