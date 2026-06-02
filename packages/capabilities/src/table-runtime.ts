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
function vtBootstrap(root){
  var dataEl = root.querySelector('script.vtable-data');
  if(!dataEl) return;
  var payload = JSON.parse(dataEl.textContent);
  var rows = payload.rows, cols = payload.cols;
  var ncols = cols.length;
  var catFields = cols.filter(function(c){ return vtIsCategorical(rows, c.field, c.filter); }).map(function(c){return c;});
  var groupFields = cols.filter(function(c){ return c.groupBy===false?false:(c.groupBy===true?true:vtIsCategorical(rows, c.field, c.filter)); });
  var state = { sort:{field:'',dir:'asc'}, globalSearch:'', colSearch:{}, facets:{}, groupBy:'' };
  var tbody = root.querySelector('tbody');
  var countEl = root.querySelector('.vt-count');
  var chipsEl = root.querySelector('.vt-chips');

  // Poblar dropdowns de filtro (facetas) por columna categórica.
  var filterWrap = root.querySelector('.vt-filters');
  if(filterWrap && catFields.length){
    catFields.forEach(function(c){
      var vals = vtDistinct(rows, c.field).slice().sort(function(a,b){return vtNorm(a).localeCompare(vtNorm(b));});
      var checks = vals.map(function(v){ return '<label><input type="checkbox" value="'+vtEsc(v)+'"> '+vtEsc(v||'(vacío)')+'</label>'; }).join('');
      var d=document.createElement('details'); d.className='vt-facet'; d.setAttribute('data-field', c.field);
      d.innerHTML='<summary>'+vtEsc(c.label||c.field)+'</summary><div class="vt-facet-opts">'+checks+'</div>';
      filterWrap.appendChild(d);
    });
  }
  // Poblar selector "Agrupar por".
  var groupSel = root.querySelector('.vt-groupby');
  if(groupSel){
    if(!groupFields.length){ var gw=root.querySelector('.vt-groupby-wrap'); if(gw) gw.style.display='none'; }
    else groupFields.forEach(function(c){ var o=document.createElement('option'); o.value=c.field; o.textContent=c.label||c.field; groupSel.appendChild(o); });
  }

  function render(){
    var view = vtApply(rows, state);
    if(state.groupBy){
      var groups = vtGroup(view, state.groupBy);
      var gcol = cols.filter(function(c){return c.field===state.groupBy;})[0];
      var glabel = gcol ? (gcol.label||gcol.field) : state.groupBy;
      tbody.innerHTML = groups.map(function(g){
        var head='<tr class="vt-group-head"><td colspan="'+ncols+'"><span class="vt-gcaret">▾</span> '+vtEsc(glabel)+': '+vtEsc(g.key||'(vacío)')+' <span class="vt-gcount">('+g.rows.length+')</span></td></tr>';
        return head + vtBodyRows(cols, g.rows);
      }).join('') || '<tr class="vt-empty"><td colspan="'+ncols+'">Sin resultados</td></tr>';
    } else {
      tbody.innerHTML = vtBodyRows(cols, view) || '<tr class="vt-empty"><td colspan="'+ncols+'">Sin resultados</td></tr>';
    }
    if(countEl) countEl.textContent = view.length + (view.length===1?' fila':' filas') + (view.length!==rows.length?(' de '+rows.length):'');
    // Indicadores de orden en los headers.
    Array.prototype.forEach.call(root.querySelectorAll('th[data-field]'), function(th){
      var f=th.getAttribute('data-field'); var ind=th.querySelector('.vt-sort-ind');
      if(ind) ind.textContent = (state.sort.field===f) ? (state.sort.dir==='asc'?'▲':'▼') : '';
      th.setAttribute('aria-sort', state.sort.field===f ? (state.sort.dir==='asc'?'ascending':'descending') : 'none');
    });
    // Chips de filtros activos.
    if(chipsEl){
      var chips=[];
      for(var f in state.facets){ (state.facets[f]||[]).forEach(function(v){ var c=cols.filter(function(x){return x.field===f;})[0]; chips.push('<span class="vt-chip" data-field="'+vtEsc(f)+'" data-val="'+vtEsc(v)+'">'+vtEsc((c?c.label:f)+': '+(v||'(vacío)'))+' ×</span>'); }); }
      if(state.globalSearch) chips.push('<span class="vt-chip vt-chip-search" data-search="global">buscar: '+vtEsc(state.globalSearch)+' ×</span>');
      for(var cf in state.colSearch){ if(state.colSearch[cf]){ var cc=cols.filter(function(x){return x.field===cf;})[0]; chips.push('<span class="vt-chip vt-chip-search" data-search="'+vtEsc(cf)+'">'+vtEsc((cc?cc.label:cf)+'~ '+state.colSearch[cf])+' ×</span>'); } }
      chipsEl.innerHTML = chips.join('');
    }
  }

  // Orden: click en header (ciclo asc → desc → sin orden).
  Array.prototype.forEach.call(root.querySelectorAll('th[data-sortable="1"]'), function(th){
    th.addEventListener('click', function(e){
      if(e.target && e.target.tagName==='INPUT') return; // no disparar al tipear en la búsqueda por columna
      var f=th.getAttribute('data-field');
      if(state.sort.field!==f){ state.sort={field:f,dir:'asc'}; }
      else if(state.sort.dir==='asc'){ state.sort.dir='desc'; }
      else { state.sort={field:'',dir:'asc'}; }
      render();
    });
  });
  // Búsqueda por columna.
  Array.prototype.forEach.call(root.querySelectorAll('.vt-col-search'), function(inp){
    inp.addEventListener('input', function(){ state.colSearch[inp.getAttribute('data-field')]=inp.value; render(); });
    inp.addEventListener('click', function(e){ e.stopPropagation(); });
  });
  // Búsqueda global.
  var gs=root.querySelector('.vt-global-search');
  if(gs) gs.addEventListener('input', function(){ state.globalSearch=gs.value; render(); });
  // Facetas.
  if(filterWrap) filterWrap.addEventListener('change', function(e){
    var t=e.target; if(!t || t.type!=='checkbox') return;
    var det=t.closest('.vt-facet'); var f=det.getAttribute('data-field');
    var sel=Array.prototype.slice.call(det.querySelectorAll('input:checked')).map(function(b){return b.value;});
    state.facets[f]=sel; render();
  });
  // Agrupar por.
  if(groupSel) groupSel.addEventListener('change', function(){ state.groupBy=groupSel.value; render(); });
  // Quitar chip.
  if(chipsEl) chipsEl.addEventListener('click', function(e){
    var chip=e.target.closest('.vt-chip'); if(!chip) return;
    if(chip.getAttribute('data-search')==='global'){ state.globalSearch=''; if(gs) gs.value=''; }
    else if(chip.hasAttribute('data-search')){ var cf=chip.getAttribute('data-search'); state.colSearch[cf]=''; var ci=root.querySelector('.vt-col-search[data-field="'+cf+'"]'); if(ci) ci.value=''; }
    else { var f=chip.getAttribute('data-field'), v=chip.getAttribute('data-val'); state.facets[f]=(state.facets[f]||[]).filter(function(x){return x!==v;}); var box=filterWrap&&filterWrap.querySelector('.vt-facet[data-field="'+f+'"] input[value="'+v.replace(/"/g,'\\\\"')+'"]'); if(box) box.checked=false; }
    render();
  });

  render();
}
Array.prototype.forEach.call(document.querySelectorAll('.vtable'), vtBootstrap);
`

export const TABLE_RUNTIME_SOURCE: string =
  '(function(){\n' + PURE_FNS.map((f) => f.toString()).join('\n') + '\n' + DOM_GLUE + '\n})();'
