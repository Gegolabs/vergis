// JS embebido de la interacción declarada acotada — extraído de render-html-piece.ts (NEXT · Ola 3·B).
// Genera el <script> que filtra client-side (facetas de la bandeja) y recomputa KPIs/semáforo sobre los
// datasets materializados, SIN nuevas queries. Browser-only: el test `new Function(...)` solo valida
// sintaxis (no comportamiento) — editar con cuidado.
import { SAVED_VIEWS_JS } from './table-runtime'
import type { Interactive } from './piece-types'

export function renderInteractiveScript(it: Interactive): string {
  const data = JSON.stringify(it.datasets).replace(/</g, '\\u003c')
  const filters = JSON.stringify(it.filters).replace(/</g, '\\u003c')
  return `<script>
(function(){
  var DATA = ${data}, FILTERS = ${filters};
  var tray = document.getElementById('vergis-filters');
  var countEl = document.getElementById('vergis-count');
  // Franja ÚNICA de estado de filtros (#114): la misma \`.vfltbar\` de #82 hospeda los chips VIVOS de
  // las facetas client-side. La franja aparece con el primer chip y desaparece con el último.
  var fltbar = document.getElementById('vergis-fltbar');
  var liveEl = document.getElementById('vergis-flt-live');
  var livePrintEl = document.getElementById('vergis-flt-live-print');
  var boxes = tray ? Array.prototype.slice.call(tray.querySelectorAll('input[type=checkbox]')) : [];
  function fmt(v, f){
    if (f === 'percent_1') return (v*100).toFixed(1) + '%';
    if (f === 'int_0') return new Intl.NumberFormat('es-CL',{maximumFractionDigits:0}).format(Math.round(v));
    return String(v);
  }
  // ESPEJO de compose.aggregate (packages/mira/src/compose.ts) — misma semántica de ops para que el
  // recompute bajo filtro coincida con el valor server-rendered. MANTENER EN SINCRONÍA.
  function agg(rows, a){
    function sum(f){ return rows.reduce(function(s,r){ return s + (Number(r[f])||0); }, 0); }
    if (a.op === 'ratio'){ var d = sum(a.den); return d ? sum(a.num)/d : 0; }
    if (a.op === 'avg'){ return rows.length ? sum(a.field)/rows.length : 0; }
    if (a.op === 'count'){
      if (!a.field) return rows.length;
      return rows.filter(function(r){ return r[a.field] != null && r[a.field] !== ''; }).length;
    }
    if (a.op === 'min' || a.op === 'max'){
      var best = NaN;
      rows.forEach(function(r){ var n = Number(r[a.field]); if (isNaN(n)) return; if (isNaN(best) || (a.op === 'min' ? n < best : n > best)) best = n; });
      return isNaN(best) ? 0 : best;
    }
    if (a.op === 'count_distinct'){
      var seen = {}, n = 0;
      rows.forEach(function(r){ var k = String(r[a.field] == null ? '' : r[a.field]); if (!seen[k]){ seen[k] = 1; n++; } });
      return n;
    }
    return sum(a.field); // sum
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
  // Chips vivos: uno por VALOR marcado de cada faceta, en la franja de estado del cuerpo.
  function paintChips(){
    if (!fltbar || !liveEl) return;
    var html = [], parts = [];
    FILTERS.forEach(function(f){
      var picked = selectedFor(f.field);
      if (!picked.length) return;
      var label = f.label || f.field;
      parts.push(label + ': ' + picked.join(', '));
      picked.forEach(function(v){
        html.push('<span class="vflt-chip vflt-screen vflt-live" data-field="' + esc(f.field) + '" data-val="' + esc(v) + '">' +
          '<b>' + esc(label) + ':</b> ' + esc(v) +
          '<span class="vflt-x" role="button" tabindex="0" title="Quitar este filtro" aria-label="Quitar ' + esc(label) + ': ' + esc(v) + '">✕</span></span>');
      });
    });
    liveEl.innerHTML = html.join('');
    if (livePrintEl) livePrintEl.textContent = parts.length ? 'Filtros — ' + parts.join(' · ') : '';
    // Nunca se oculta si hay chips server: esos también son \`.vflt-chip\` y viven siempre en el DOM.
    fltbar.hidden = !fltbar.querySelector('.vflt-chip');
  }
  function update(){
    if (countEl){ var n = totalSelected(); countEl.textContent = n ? String(n) : ''; }
    paintChips();
    document.querySelectorAll('[data-agg]').forEach(function(el){
      var a = JSON.parse(el.getAttribute('data-agg'));
      el.querySelector('.kpi-value').textContent = fmt(agg(filteredRowsFor(a.dataset), a), el.getAttribute('data-format'));
      var ca = el.getAttribute('data-comparison-agg');
      if (ca){ var cab = JSON.parse(ca); var cmp = el.querySelector('.kpi-comparison');
        if (cmp) cmp.textContent = (el.getAttribute('data-comparison-label')||'') + ' ' + fmt(agg(filteredRowsFor(cab.dataset || a.dataset), cab), el.getAttribute('data-format')); }
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
  // El ✕ de un chip vivo desmarca SU checkbox de la bandeja: una sola fuente de verdad (el DOM de
  // los checkboxes). Delegado, una sola vez, sobre el slot vivo.
  if (liveEl) liveEl.addEventListener('click', function(ev){
    var x = ev.target && ev.target.closest ? ev.target.closest('.vflt-x') : null;
    if (!x) return;
    var chip = x.closest('.vflt-chip');
    if (!chip) return;
    var field = chip.getAttribute('data-field'), val = chip.getAttribute('data-val');
    boxes.forEach(function(b){ if (b.getAttribute('data-field')===field && b.value===val) b.checked = false; });
    update();
  });
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

