/**
 * Runtime de la tabla interactiva — lógica PURA, compartida entre Node y el navegador.
 *
 * Una sola fuente de verdad: estas funciones se testean en Node y se EMBEBEN en el
 * HTML vía `.toString()` (ver `TABLE_RUNTIME_SOURCE`). No hay reimplementación paralela
 * en el cliente → cero drift entre lo testeado y lo servido.
 *
 * Todo opera sobre las filas YA materializadas y RLS-filtradas por el push-down. Orden,
 * filtro, búsqueda y agrupación son presentación pura, client-side: el consumidor solo
 * reordena lo que ya tiene permitido ver (authz-blind, sin queries nuevas).
 *
 * IMPORTANTE: cada función es autocontenida o referencia solo a sus pares de este módulo,
 * porque se concatenan dentro de un mismo IIFE en el navegador. No introducir dependencias
 * externas (imports, globals de Node) en las funciones marcadas como runtime.
 */

export interface VtState {
  /** Orden activo: campo + dirección. `field` vacío = sin orden (orden de origen). */
  sort: { field: string; dir: 'asc' | 'desc' }
  /** Búsqueda global (todas las columnas). */
  globalSearch: string
  /** Búsqueda por columna: field → substring. */
  colSearch: Record<string, string>
  /** Filtros faceteados: field → valores seleccionados (vacío = sin filtro en ese campo). */
  facets: Record<string, string[]>
  /** Columna por la que agrupar (categorización). Vacío = tabla plana. */
  groupBy: string
}

/** Normaliza para comparar: minúsculas + sin acentos. */
export function vtNorm(s: unknown): string {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/** ¿La columna es numérica? (todos los valores no vacíos parsean a número). */
export function vtIsNumericCol(rows: Record<string, unknown>[], field: string): boolean {
  let seen = false
  for (const r of rows) {
    const v = r[field]
    if (v == null || v === '') continue
    seen = true
    if (typeof v === 'number') continue
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) continue
    return false
  }
  return seen
}

/** Valores distintos de una columna (como strings), preservando orden de aparición. */
export function vtDistinct(rows: Record<string, unknown>[], field: string): string[] {
  const seen: Record<string, boolean> = {}
  const out: string[] = []
  for (const r of rows) {
    const k = String(r[field] == null ? '' : r[field])
    if (!seen[k]) {
      seen[k] = true
      out.push(k)
    }
  }
  return out
}

/**
 * ¿Columna categórica? (apta para faceta de filtro y para agrupar). Heurística: no numérica
 * y de baja cardinalidad. `override` (true/false) gana sobre la heurística.
 */
export function vtIsCategorical(
  rows: Record<string, unknown>[],
  field: string,
  override?: boolean,
): boolean {
  if (override === true) return true
  if (override === false) return false
  if (rows.length === 0) return false
  if (vtIsNumericCol(rows, field)) return false
  const n = vtDistinct(rows, field).length
  // Categórica = ≤25 valores distintos (faceta manejable) Y con repetición (distinct < filas:
  // si cada fila es única no hay valor de agrupar/filtrar). Escala a tablas grandes (cap 25).
  const cap = Math.min(25, rows.length - 1)
  return n >= 1 && n <= cap
}

/** Formatea un valor de celda en el cliente (espejo del formatValue del render). */
export function vtFormat(value: unknown, format?: string): string {
  if (typeof value === 'number') {
    if (format === 'int_0')
      return new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(Math.round(value))
    if (format === 'percent_1') return (value * 100).toFixed(1) + '%'
    if (format === 'percent') return Math.round(value * 100) + '%'
    return String(value)
  }
  const s = String(value == null ? '' : value)
  if (/^\d{4}-\d\d-\d\dT/.test(s)) return s.slice(0, 10)
  return s
}

/** Aplica facetas + búsqueda (global y por columna) + orden. Devuelve un arreglo nuevo. */
export function vtApply(rows: Record<string, unknown>[], state: VtState): Record<string, unknown>[] {
  const gq = vtNorm(state.globalSearch)
  const out = rows.filter((r) => {
    for (const f in state.facets) {
      const sel = state.facets[f]
      if (sel && sel.length && sel.indexOf(String(r[f] == null ? '' : r[f])) === -1) return false
    }
    if (gq) {
      let hit = false
      for (const k in r) {
        if (vtNorm(r[k]).indexOf(gq) !== -1) {
          hit = true
          break
        }
      }
      if (!hit) return false
    }
    for (const f in state.colSearch) {
      const q = vtNorm(state.colSearch[f])
      if (q && vtNorm(r[f]).indexOf(q) === -1) return false
    }
    return true
  })
  if (state.sort && state.sort.field) {
    const field = state.sort.field
    const k = state.sort.dir === 'desc' ? -1 : 1
    out.sort((a, b) => {
      const av = a[field]
      const bv = b[field]
      const an = Number(av)
      const bn = Number(bv)
      let c: number
      if (av !== '' && bv !== '' && av != null && bv != null && !Number.isNaN(an) && !Number.isNaN(bn))
        c = an - bn
      else c = vtNorm(av).localeCompare(vtNorm(bv))
      return c * k
    })
  }
  return out
}

/** Agrupa filas (ya filtradas/ordenadas) por una columna. Grupos ordenados alfabéticamente;
 *  el orden de filas dentro de cada grupo se preserva (hereda el sort activo). */
export function vtGroup(
  rows: Record<string, unknown>[],
  field: string,
): { key: string; rows: Record<string, unknown>[] }[] {
  const buckets: Record<string, Record<string, unknown>[]> = {}
  const order: string[] = []
  for (const r of rows) {
    const key = String(r[field] == null ? '' : r[field])
    if (!buckets[key]) {
      buckets[key] = []
      order.push(key)
    }
    buckets[key].push(r)
  }
  return order
    .sort((a, b) => vtNorm(a).localeCompare(vtNorm(b)))
    .map((key) => ({ key, rows: buckets[key] }))
}

/**
 * Fuente JS que se inyecta en el navegador: las funciones puras de arriba (vía toString,
 * sin tipos tras la transpilación de esbuild) + el cableado del DOM. Se emite UNA vez por
 * documento; cada `.vtable` se autoarranca leyendo su JSON embebido.
 */
const PURE_FNS = [vtNorm, vtIsNumericCol, vtDistinct, vtIsCategorical, vtFormat, vtApply, vtGroup]

const DOM_GLUE = `
function vtEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function vtColorBg(value, range){
  if(!range || isNaN(value) || range.max===range.min) return '';
  var t=(value-range.min)/(range.max-range.min); var light=Math.round(95 - t*45);
  return ' style="background:hsl(8,75%,'+light+'%)"';
}
function vtCell(col, r){
  var raw=r[col.field]; var text=vtFormat(raw, col.format);
  var bg=col.colorscale ? vtColorBg(Number(raw), col.ranges) : '';
  return '<td class="align-'+(col.align||'left')+'"'+bg+'>'+vtEsc(text)+'</td>';
}
function vtBodyRows(cols, rows){
  return rows.map(function(r){ return '<tr>'+cols.map(function(c){return vtCell(c,r);}).join('')+'</tr>'; }).join('');
}
function vtCounts(rows, field){ var m={}; for(var i=0;i<rows.length;i++){ var k=String(rows[i][field]==null?'':rows[i][field]); m[k]=(m[k]||0)+1; } return m; }
function vtBootstrap(root){
  var dataEl = root.querySelector('script.vtable-data');
  if(!dataEl) return;
  var payload = JSON.parse(dataEl.textContent);
  var rows = payload.rows, cols = payload.cols, ncols = cols.length;
  var groupFields = cols.filter(function(c){ return c.groupBy===false?false:(c.groupBy===true?true:vtIsCategorical(rows, c.field, c.filter)); });
  var state = { sort:{field:'',dir:'asc'}, globalSearch:'', colSearch:{}, facets:{}, groupBy:'' };
  var tbody = root.querySelector('tbody');
  var chipsEl = root.querySelector('.vt-chips');
  var badge = document.getElementById('vergis-count'); // uña/pestaña de la gaveta común
  function colLabel(field){ var c=cols.filter(function(x){return x.field===field;})[0]; return c?(c.label||c.field):field; }

  // ---- Controles globales en la GAVETA COMÚN (.tray-sections): búsqueda global, agrupar, limpiar ----
  var gs=null, groupSel=null, countEl=null;
  var trayWrap = document.querySelector('.tray-sections');
  if(trayWrap){
    var sec=document.createElement('div'); sec.className='faceta vt-tray-section';
    var gopts = groupFields.map(function(c){ return '<option value="'+vtEsc(c.field)+'">'+vtEsc(c.label||c.field)+'</option>'; }).join('');
    sec.innerHTML =
      '<div class="faceta-title">Buscar</div>' +
      '<input class="vt-global-search" type="search" placeholder="Buscar en toda la tabla…" aria-label="Buscar en toda la tabla">' +
      (groupFields.length ? ('<div class="faceta-title" style="margin-top:14px">Agrupar por</div><select class="vt-groupby"><option value="">(sin agrupar)</option>'+gopts+'</select>') : '') +
      '<button type="button" class="vt-clear-all">Limpiar todo</button>' +
      '<span class="vt-count" role="status" aria-live="polite"></span>';
    trayWrap.appendChild(sec);
    gs=sec.querySelector('.vt-global-search'); groupSel=sec.querySelector('.vt-groupby'); countEl=sec.querySelector('.vt-count');
    gs.addEventListener('input', function(){ state.globalSearch=gs.value; render(); });
    if(groupSel) groupSel.addEventListener('change', function(){ state.groupBy=groupSel.value; render(); });
    sec.querySelector('.vt-clear-all').addEventListener('click', function(){ clearAll(); });
  }
  function clearAll(){
    state.facets={}; state.globalSearch=''; state.groupBy='';
    if(gs) gs.value=''; if(groupSel) groupSel.value='';
    Array.prototype.forEach.call(root.querySelectorAll('.vt-col-pop input[type=checkbox]'), function(b){ b.checked=false; });
    render();
  }

  // ---- Popover por columna (ícono embudo en el header): buscador + selector de valores únicos ----
  function closeAllPops(except){ Array.prototype.forEach.call(root.querySelectorAll('.vt-col-pop'), function(p){ if(p!==except) p.hidden=true; }); }
  function buildPop(pop, field){
    var counts=vtCounts(rows, field);
    var vals=vtDistinct(rows, field).slice().sort(function(a,b){return vtNorm(a).localeCompare(vtNorm(b));});
    var sel=state.facets[field]||[];
    var opts=vals.map(function(v){ var ck=sel.indexOf(v)!==-1?' checked':''; return '<label><input type="checkbox" value="'+vtEsc(v)+'"'+ck+'> <span class="vt-pop-val">'+vtEsc(v||'(vacío)')+'</span> <span class="vt-pop-count">'+counts[v]+'</span></label>'; }).join('');
    pop.innerHTML =
      '<input class="vt-pop-search" type="search" placeholder="Buscar valor…" aria-label="Buscar valor en '+vtEsc(colLabel(field))+'">' +
      '<div class="vt-pop-actions"><button type="button" class="vt-pop-all">Todos</button><button type="button" class="vt-pop-clear">Limpiar</button></div>' +
      '<div class="vt-pop-opts">'+opts+'</div>';
    var ps=pop.querySelector('.vt-pop-search');
    ps.addEventListener('input', function(){ var q=vtNorm(ps.value); Array.prototype.forEach.call(pop.querySelectorAll('.vt-pop-opts label'), function(l){ l.style.display=(!q||vtNorm(l.textContent).indexOf(q)!==-1)?'':'none'; }); });
    var optsBox=pop.querySelector('.vt-pop-opts');
    function syncFacet(){ state.facets[field]=Array.prototype.slice.call(optsBox.querySelectorAll('input:checked')).map(function(b){return b.value;}); render(); }
    optsBox.addEventListener('change', syncFacet);
    pop.querySelector('.vt-pop-all').addEventListener('click', function(){ Array.prototype.forEach.call(optsBox.querySelectorAll('label'), function(l){ if(l.style.display!=='none') l.querySelector('input').checked=true; }); syncFacet(); });
    pop.querySelector('.vt-pop-clear').addEventListener('click', function(){ Array.prototype.forEach.call(optsBox.querySelectorAll('input'), function(b){b.checked=false;}); state.facets[field]=[]; render(); });
  }
  Array.prototype.forEach.call(root.querySelectorAll('.vt-filter-btn'), function(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      var th=btn.closest('th'); var pop=th.querySelector('.vt-col-pop'); var willOpen=pop.hidden;
      closeAllPops(willOpen?pop:null);
      if(willOpen){
        if(!pop.innerHTML) buildPop(pop, btn.getAttribute('data-field'));
        pop.hidden=false;
        // position:fixed anclado al botón → ningún contenedor con overflow lo recorta
        // (la tabla vive en .vt-scroll, cuyo overflow recortaría un popover absoluto).
        var r=btn.getBoundingClientRect(); var vw=window.innerWidth||1024;
        pop.style.top=(r.bottom+4)+'px';
        pop.style.left=Math.max(8, Math.min(r.left, vw-288))+'px';
        var ps=pop.querySelector('.vt-pop-search'); if(ps) ps.focus();
      }
      else pop.hidden=true;
    });
  });
  Array.prototype.forEach.call(root.querySelectorAll('.vt-col-pop'), function(p){ p.addEventListener('click', function(e){ e.stopPropagation(); }); });
  document.addEventListener('click', function(){ closeAllPops(null); });

  // ---- Orden: click en la etiqueta del header (ciclo asc → desc → sin orden) ----
  Array.prototype.forEach.call(root.querySelectorAll('th[data-sortable="1"]'), function(th){
    var label=th.querySelector('.vt-th-label')||th;
    label.addEventListener('click', function(e){
      if(e.target.closest('.vt-filter-btn')||e.target.closest('.vt-col-pop')) return;
      var f=th.getAttribute('data-field');
      if(state.sort.field!==f){ state.sort={field:f,dir:'asc'}; }
      else if(state.sort.dir==='asc'){ state.sort.dir='desc'; }
      else { state.sort={field:'',dir:'asc'}; }
      render();
    });
  });

  // ---- Chips de filtros activos (sobre la tabla): clic = quitar ----
  if(chipsEl) chipsEl.addEventListener('click', function(e){
    var chip=e.target.closest('.vt-chip'); if(!chip) return;
    if(chip.getAttribute('data-search')==='global'){ state.globalSearch=''; if(gs) gs.value=''; }
    else { var f=chip.getAttribute('data-field'), v=chip.getAttribute('data-val'); state.facets[f]=(state.facets[f]||[]).filter(function(x){return x!==v;}); var th=root.querySelector('th[data-field="'+f+'"]'); var pop=th&&th.querySelector('.vt-col-pop'); if(pop&&pop.innerHTML){ var box=pop.querySelector('.vt-pop-opts input[value="'+v.replace(/"/g,'\\\\"')+'"]'); if(box) box.checked=false; } }
    render();
  });

  function render(){
    var view = vtApply(rows, state);
    if(state.groupBy){
      var groups = vtGroup(view, state.groupBy); var glabel=colLabel(state.groupBy);
      tbody.innerHTML = groups.map(function(g){
        return '<tr class="vt-group-head"><td colspan="'+ncols+'"><span class="vt-gcaret">▾</span> '+vtEsc(glabel)+': '+vtEsc(g.key||'(vacío)')+' <span class="vt-gcount">('+g.rows.length+')</span></td></tr>' + vtBodyRows(cols, g.rows);
      }).join('') || '<tr class="vt-empty"><td colspan="'+ncols+'">Sin resultados</td></tr>';
    } else {
      tbody.innerHTML = vtBodyRows(cols, view) || '<tr class="vt-empty"><td colspan="'+ncols+'">Sin resultados</td></tr>';
    }
    if(countEl) countEl.textContent = view.length + (view.length===1?' fila':' filas') + (view.length!==rows.length?(' de '+rows.length):'');
    Array.prototype.forEach.call(root.querySelectorAll('th[data-field]'), function(th){
      var f=th.getAttribute('data-field'); var ind=th.querySelector('.vt-sort-ind');
      if(ind) ind.textContent = (state.sort.field===f) ? (state.sort.dir==='asc'?'▲':'▼') : '';
      th.setAttribute('aria-sort', state.sort.field===f ? (state.sort.dir==='asc'?'ascending':'descending') : 'none');
      var btn=th.querySelector('.vt-filter-btn'); if(btn) btn.classList.toggle('on',(state.facets[f]||[]).length>0);
    });
    if(chipsEl){
      var chips=[];
      for(var f in state.facets){ (state.facets[f]||[]).forEach(function(v){ chips.push('<span class="vt-chip" data-field="'+vtEsc(f)+'" data-val="'+vtEsc(v)+'">'+vtEsc(colLabel(f)+': '+(v||'(vacío)'))+' ×</span>'); }); }
      if(state.globalSearch) chips.push('<span class="vt-chip vt-chip-search" data-search="global">buscar: '+vtEsc(state.globalSearch)+' ×</span>');
      chipsEl.innerHTML = chips.join('');
    }
    if(badge){ var n=0; for(var k in state.facets){ if((state.facets[k]||[]).length) n++; } if(state.globalSearch) n++; if(state.groupBy) n++; badge.textContent = n?String(n):''; }
  }
  render();
}
Array.prototype.forEach.call(document.querySelectorAll('.vtable'), vtBootstrap);
`

export const TABLE_RUNTIME_SOURCE: string =
  '(function(){\n' + PURE_FNS.map((f) => f.toString()).join('\n') + '\n' + DOM_GLUE + '\n})();'
