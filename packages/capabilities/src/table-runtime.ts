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

/** Nodo del árbol de agrupación multinivel. Hoja = filas; interno = grupos por `field`. */
export interface VtTreeNode {
  leaf: boolean
  rows?: Record<string, unknown>[]
  field?: string
  groups?: { key: string; count: number; child: VtTreeNode }[]
}

/** Agrupación JERÁRQUICA por varios campos en orden (Área › Empresa › Estado…). Recursivo:
 *  agrupa por `fields[0]`, luego cada subgrupo por el resto. Sin campos → hoja con las filas. */
export function vtGroupTree(rows: Record<string, unknown>[], fields: string[]): VtTreeNode {
  if (!fields || fields.length === 0) return { leaf: true, rows }
  const groups = vtGroup(rows, fields[0])
  return {
    leaf: false,
    field: fields[0],
    groups: groups.map((g) => ({ key: g.key, count: g.rows.length, child: vtGroupTree(g.rows, fields.slice(1)) })),
  }
}

/**
 * Fuente JS que se inyecta en el navegador: las funciones puras de arriba (vía toString,
 * sin tipos tras la transpilación de esbuild) + el cableado del DOM. Se emite UNA vez por
 * documento; cada `.vtable` se autoarranca leyendo su JSON embebido.
 */
const PURE_FNS = [vtNorm, vtIsNumericCol, vtDistinct, vtIsCategorical, vtFormat, vtApply, vtGroup, vtGroupTree]

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
  // groupLevels = jerarquía de agrupación (orden = anidamiento). collapsed = paths de grupos colapsados.
  var state = { sort:{field:'',dir:'asc'}, globalSearch:'', colSearch:{}, facets:{}, groupLevels:[], collapsed:{} };
  var tbody = root.querySelector('tbody');
  var chipsEl = root.querySelector('.vt-chips');
  var badge = document.getElementById('vergis-count'); // uña/pestaña de la gaveta común
  var SEP = '~|~'; // separador de path de grupo (token improbable en datos reales)
  function colLabel(field){ var c=cols.filter(function(x){return x.field===field;})[0]; return c?(c.label||c.field):field; }

  // ---- Controles globales en la GAVETA COMÚN (.tray-sections): búsqueda global, agrupar (multinivel), limpiar ----
  var gs=null, countEl=null, levelsEl=null, addSel=null, groupActions=null;
  var trayWrap = document.querySelector('.tray-sections');
  if(trayWrap){
    var sec=document.createElement('div'); sec.className='faceta vt-tray-section';
    sec.innerHTML =
      '<div class="faceta-title">Buscar</div>' +
      '<input class="vt-global-search" type="search" placeholder="Buscar en toda la tabla…" aria-label="Buscar en toda la tabla">' +
      (groupFields.length ? (
        '<div class="faceta-title" style="margin-top:14px">Agrupar por</div>' +
        '<div class="vt-group-levels"></div>' +
        '<select class="vt-group-add"></select>' +
        '<div class="vt-group-actions"><button type="button" class="vt-expand-all">Expandir todo</button><button type="button" class="vt-collapse-all">Colapsar todo</button></div>'
      ) : '') +
      '<button type="button" class="vt-clear-all">Limpiar todo</button>' +
      '<span class="vt-count" role="status" aria-live="polite"></span>';
    trayWrap.appendChild(sec);
    gs=sec.querySelector('.vt-global-search'); countEl=sec.querySelector('.vt-count');
    levelsEl=sec.querySelector('.vt-group-levels'); addSel=sec.querySelector('.vt-group-add'); groupActions=sec.querySelector('.vt-group-actions');
    gs.addEventListener('input', function(){ state.globalSearch=gs.value; render(); });
    sec.querySelector('.vt-clear-all').addEventListener('click', function(){ clearAll(); });
    if(addSel){
      addSel.addEventListener('change', function(){ if(!addSel.value) return; state.groupLevels.push(addSel.value); state.collapsed={}; renderGroupUI(); render(); });
      levelsEl.addEventListener('click', function(e){ var rm=e.target.closest('.vt-gl-rm'); if(!rm) return; var f=rm.getAttribute('data-field'); state.groupLevels=state.groupLevels.filter(function(x){return x!==f;}); state.collapsed={}; renderGroupUI(); render(); });
      sec.querySelector('.vt-expand-all').addEventListener('click', function(){ state.collapsed={}; render(); });
      sec.querySelector('.vt-collapse-all').addEventListener('click', function(){ collapseAll(); render(); });
      renderGroupUI();
    }
  }
  function renderGroupUI(){
    if(!levelsEl) return;
    levelsEl.innerHTML = state.groupLevels.map(function(f,i){ return '<div class="vt-gl-chip"><span><span class="vt-gl-num">'+(i+1)+'.</span> '+vtEsc(colLabel(f))+'</span><span class="vt-gl-rm" data-field="'+vtEsc(f)+'" title="Quitar nivel">×</span></div>'; }).join('');
    var avail=groupFields.filter(function(c){ return state.groupLevels.indexOf(c.field)===-1; });
    addSel.innerHTML='<option value="">'+(state.groupLevels.length?'+ añadir nivel…':'+ agrupar por…')+'</option>'+avail.map(function(c){ return '<option value="'+vtEsc(c.field)+'">'+vtEsc(c.label||c.field)+'</option>'; }).join('');
    addSel.style.display = avail.length ? '' : 'none';
    if(groupActions) groupActions.style.display = state.groupLevels.length ? '' : 'none';
  }
  function collapseAll(){ var acc=[]; gatherPaths(vtGroupTree(vtApply(rows,state), state.groupLevels), '', acc); acc.forEach(function(p){ state.collapsed[p]=1; }); }
  function gatherPaths(node, prefix, acc){ if(node.leaf) return; node.groups.forEach(function(g){ var p=prefix+node.field+SEP+g.key; acc.push(p); gatherPaths(g.child, p+SEP, acc); }); }
  function clearAll(){
    state.facets={}; state.globalSearch=''; state.groupLevels=[]; state.collapsed={};
    if(gs) gs.value='';
    Array.prototype.forEach.call(root.querySelectorAll('.vt-col-pop input[type=checkbox]'), function(b){ b.checked=false; });
    renderGroupUI(); render();
  }

  // ---- Tab "Guardados": presets de filtro persistidos por reporte (localStorage) ----
  var savedWrap = document.querySelector('.tray-saved');
  var SKEY = 'vergis:saved:'+((typeof location!=='undefined' && location.pathname) || 'pi');
  function loadSaved(){ try{ return JSON.parse(localStorage.getItem(SKEY)||'[]'); }catch(e){ return []; } }
  function storeSaved(a){ try{ localStorage.setItem(SKEY, JSON.stringify(a)); }catch(e){} }
  function askConfirm(msg){ try{ return (typeof window!=='undefined' && typeof window.confirm==='function') ? window.confirm(msg) : true; }catch(e){ return true; } }
  function snapshot(){ return { facets: JSON.parse(JSON.stringify(state.facets)), globalSearch: state.globalSearch, groupLevels: state.groupLevels.slice(), sort: { field: state.sort.field, dir: state.sort.dir } }; }
  function applySnapshot(s){
    state.facets = s.facets ? JSON.parse(JSON.stringify(s.facets)) : {};
    state.globalSearch = s.globalSearch || '';
    state.groupLevels = (s.groupLevels||[]).slice();
    state.sort = { field: (s.sort&&s.sort.field)||'', dir: (s.sort&&s.sort.dir)||'asc' };
    state.collapsed = {};
    if(gs) gs.value = state.globalSearch;
    // popovers ya construidos → vaciarlos para que se reconstruyan reflejando las nuevas selecciones
    Array.prototype.forEach.call(root.querySelectorAll('.vt-col-pop'), function(p){ if(p.innerHTML) p.innerHTML=''; });
    renderGroupUI(); render();
  }
  function renderSavedList(){
    if(!savedWrap) return;
    var list=savedWrap.querySelector('.vt-saved-list'); if(!list) return;
    var arr=loadSaved();
    list.innerHTML = arr.length ? arr.map(function(p,i){
      return '<div class="vt-saved-row'+(p.pinned?' pinned':'')+'">'+
        '<button type="button" class="vt-saved-pin" data-i="'+i+'" title="'+(p.pinned?'Vista por defecto (quitar)':'Fijar como vista por defecto al entrar')+'">'+(p.pinned?'★':'☆')+'</button>'+
        '<span class="vt-saved-name" data-i="'+i+'" title="Aplicar esta vista">'+vtEsc(p.name)+'</span>'+
        '<span class="vt-saved-actions"><button type="button" class="vt-saved-upd" data-i="'+i+'" title="Actualizar con la vista actual">↻</button><button type="button" class="vt-saved-del" data-i="'+i+'" title="Eliminar">×</button></span>'+
        '</div>';
    }).join('') : '<div class="vt-saved-empty">Sin vistas guardadas</div>';
  }
  if(savedWrap){
    savedWrap.innerHTML = '<div class="faceta-title">Guardar la vista actual</div><div class="vt-save-new"><input class="vt-save-name" type="text" placeholder="Nombre de la vista…"><button type="button" class="vt-save-btn">Guardar</button></div><div class="vt-saved-list"></div><div class="vt-saved-hint">★ = vista por defecto al entrar al reporte</div>';
    var nameInp=savedWrap.querySelector('.vt-save-name');
    savedWrap.querySelector('.vt-save-btn').addEventListener('click', function(){
      var arr=loadSaved(); var nm=(nameInp.value||'').trim()||('Vista '+(arr.length+1));
      arr.push({ name: nm, state: snapshot() }); storeSaved(arr); nameInp.value=''; renderSavedList();
    });
    savedWrap.querySelector('.vt-saved-list').addEventListener('click', function(e){
      var pin=e.target.closest('.vt-saved-pin'), del=e.target.closest('.vt-saved-del'), upd=e.target.closest('.vt-saved-upd'), nm=e.target.closest('.vt-saved-name');
      if(pin){ var ap=loadSaved(); var ip=+pin.getAttribute('data-i'); var was=ap[ip]&&ap[ip].pinned; ap.forEach(function(v){v.pinned=false;}); if(ap[ip]) ap[ip].pinned=!was; storeSaved(ap); renderSavedList(); }
      else if(del){ var a=loadSaved(); var idd=+del.getAttribute('data-i'); var vd=a[idd]; if(vd && askConfirm('¿Eliminar la vista “'+vd.name+'”?')){ a.splice(idd,1); storeSaved(a); renderSavedList(); } }
      else if(upd){ var a2=loadSaved(); var i2=+upd.getAttribute('data-i'); if(a2[i2] && askConfirm('¿Actualizar la vista “'+a2[i2].name+'” con la vista actual (filtros, agrupación y orden)?')){ a2[i2].state=snapshot(); storeSaved(a2); } }
      else if(nm){ var a3=loadSaved(); var i3=+nm.getAttribute('data-i'); if(a3[i3]) applySnapshot(a3[i3].state); }
    });
    renderSavedList();
    // Vista por defecto (pineada) → se aplica automáticamente al entrar al reporte.
    var def=loadSaved().filter(function(v){return v.pinned;})[0]; if(def) applySnapshot(def.state);
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

  // ---- Colapsar/expandir un grupo: clic en su encabezado (delegado, sobrevive al re-render) ----
  tbody.addEventListener('click', function(e){
    var gh=e.target.closest('tr.vt-group-head'); if(!gh) return;
    var path=gh.getAttribute('data-path');
    if(state.collapsed[path]) delete state.collapsed[path]; else state.collapsed[path]=1;
    render();
  });

  // ---- Chips de filtros activos (sobre la tabla): clic = quitar ----
  if(chipsEl) chipsEl.addEventListener('click', function(e){
    var chip=e.target.closest('.vt-chip'); if(!chip) return;
    if(chip.getAttribute('data-search')==='global'){ state.globalSearch=''; if(gs) gs.value=''; }
    else { var f=chip.getAttribute('data-field'), v=chip.getAttribute('data-val'); state.facets[f]=(state.facets[f]||[]).filter(function(x){return x!==v;}); var th=root.querySelector('th[data-field="'+f+'"]'); var pop=th&&th.querySelector('.vt-col-pop'); if(pop&&pop.innerHTML){ var box=pop.querySelector('.vt-pop-opts input[value="'+v.replace(/"/g,'\\\\"')+'"]'); if(box) box.checked=false; } }
    render();
  });

  // Walk del árbol multinivel → filas <tr>. Cada grupo: encabezado con caret (▾/▸), nivel
  // (data-depth, indentado) y conteo; si está colapsado, no se renderizan sus descendientes.
  function renderNodeTree(node, depth, prefix){
    if(node.leaf) return vtBodyRows(cols, node.rows);
    return node.groups.map(function(g){
      var path=prefix+node.field+SEP+g.key;
      var collapsed=!!state.collapsed[path];
      var caret=collapsed?'▸':'▾';
      var head='<tr class="vt-group-head" data-depth="'+depth+'" data-path="'+vtEsc(path)+'"><td colspan="'+ncols+'" style="padding-left:'+(depth*18+12)+'px"><span class="vt-gcaret">'+caret+'</span> '+vtEsc(colLabel(node.field))+': '+vtEsc(g.key||'(vacío)')+' <span class="vt-gcount">('+g.count+')</span></td></tr>';
      return head + (collapsed ? '' : renderNodeTree(g.child, depth+1, path+SEP));
    }).join('');
  }
  function render(){
    var view = vtApply(rows, state);
    if(state.groupLevels.length){
      tbody.innerHTML = renderNodeTree(vtGroupTree(view, state.groupLevels), 0, '') || '<tr class="vt-empty"><td colspan="'+ncols+'">Sin resultados</td></tr>';
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
    if(badge){ var n=0; for(var k in state.facets){ if((state.facets[k]||[]).length) n++; } if(state.globalSearch) n++; if(state.groupLevels.length) n++; badge.textContent = n?String(n):''; }
  }
  render();
}
Array.prototype.forEach.call(document.querySelectorAll('.vtable'), vtBootstrap);
`

export const TABLE_RUNTIME_SOURCE: string =
  '(function(){\n' + PURE_FNS.map((f) => f.toString()).join('\n') + '\n' + DOM_GLUE + '\n})();'
