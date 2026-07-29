// Superficie de la CAPA DE NOTAS dentro de un PI servido (vergis#84).
//
// Tres piezas, todas gobernadas por un único contexto que el server inyecta (`NotasRenderContext`):
//  1. La sección de la BANDEJA con «Imprimir» y «Anotar» — los controles viven en la bandeja, jamás
//     sueltos en el cuerpo del documento.
//  2. El MARCADOR de comentario en las filas comentadas (triángulo discreto, estilo planilla) y su
//     popover con el hilo. Solo aparece en tablas cuyo dataset declaró `anchor`: sin llave de
//     negocio declarada no hay registro al que clavar el comentario, y el gesto no se ofrece.
//  3. La acción «Comentar el registro» por fila — acto DELIBERADO (D3), nunca un default.
//
// Nada de esto lee ni escribe dato de negocio: el motor jamás lee una nota. El marcador se dibuja
// SOLO sobre llaves que ya viajaron en el render, es decir sobre filas que la RLS ya autorizó.

import { escapeHtml } from './markdown'

/** Lo que la bandeja y los marcadores necesitan saber de la capa de notas para este render. */
export interface NotasRenderContext {
  /** `POST` — congela una impresión explícita de la vista actual. */
  imprimirUrl: string
  /** `POST` — crea una anotación (materializando la impresión perezosamente si hace falta). */
  notasUrl: string
  /** `POST` crea un comentario · `GET` lee el hilo de una llave. */
  comentariosUrl: string
  /** Dónde viven las impresiones del usuario (el enlace de descubrimiento tras imprimir). */
  impresionesUrl: string
  /** Token CSRF de la identidad del render. */
  csrf: string
  /** Recorte vigente: viaja en cada escritura para que la impresión congele LO QUE SE VE. */
  page?: string
  ctx?: Record<string, string | string[]>
}

/** Llave de negocio declarada por un dataset + lo ya comentado sobre las filas servidas. */
export interface TablaAncla {
  dataset: string
  /** Entidad gobernada normalizada (`schema.tabla`). */
  entity: string
  /** Columnas del dataset que componen la llave. */
  key: string[]
  display?: string
  /** Por llave canónica: cuántos comentarios hay y sobre qué campos. Solo llaves CON comentarios. */
  comentarios: Record<string, { count: number; porCampo: Record<string, number> }>
}

/**
 * Llave canónica de una fila — el espejo EXACTO de `llaveDeFila` + `canonicalKey` del store.
 * Los valores se coercionan a texto y las columnas se ordenan: un `4021` numérico y un `"4021"`
 * textual deben producir la misma llave, o el marcador aparecería según por dónde se pregunte.
 */
export function llaveCanonicaDeFila(row: Record<string, unknown>, key: string[]): string {
  const cols = [...key].sort()
  return `{${cols.map((k) => `${JSON.stringify(k)}:${JSON.stringify(row[k] == null ? '' : String(row[k]))}`).join(',')}}`
}

/** Sección de la BANDEJA: los dos actos deliberados sobre la vista actual. */
export function renderNotasTraySection(): string {
  return (
    `<div class="faceta vt-notas-kit">` +
    `<div class="faceta-title">Notas</div>` +
    `<div class="notas-actions">` +
    `<button type="button" class="notas-imprimir" title="Congela esta vista tal como se ve: filas, forma, recorte y fecha del dato">Imprimir</button>` +
    `<button type="button" class="notas-anotar" title="Escribe una nota sobre la fila seleccionada, o sobre la vista completa">Anotar</button>` +
    `</div>` +
    `<div class="notas-msg" role="status" aria-live="polite"></div>` +
    `</div>`
  )
}

export const NOTAS_CSS = `
.tray .vt-notas-kit .notas-actions{display:flex;gap:8px;flex-wrap:wrap}
.tray .vt-notas-kit button{background:var(--card,#f8fafc);color:var(--fg,#1f2937);border:1px solid var(--border,#e2e8f0);border-radius:7px;padding:7px 14px;font-size:12.5px;font-family:inherit;cursor:pointer}
.tray .vt-notas-kit button:hover{border-color:var(--green,#2563eb);color:var(--green,#2563eb)}
.tray .notas-msg{margin-top:9px;font-size:11.5px;color:var(--fg-dim,#64748b);line-height:1.45}
.tray .notas-msg a{color:var(--green,#2563eb)}
.tray .notas-form{margin-top:9px;display:flex;flex-direction:column;gap:7px}
.tray .notas-form textarea{width:100%;box-sizing:border-box;min-height:74px;background:var(--bg,#fff);color:var(--fg,#1f2937);border:1px solid var(--border,#e2e8f0);border-radius:7px;padding:8px 10px;font:inherit;font-size:12.5px;resize:vertical}
.tray .notas-form .notas-target{font-size:11px;color:var(--fg-dim,#64748b)}
.vtable td.vt-ncell{position:relative}
.vtable .vt-nmark{position:absolute;top:0;right:0;width:0;height:0;border-top:7px solid var(--green,#2563eb);border-left:7px solid transparent;cursor:pointer}
.vtable .vt-nmark:hover{border-top-color:var(--red,#dc2626)}
.vtable td.vt-nactions{white-space:nowrap;text-align:right}
.vtable .vt-ncomentar{background:none;border:none;color:var(--fg-dim,#94a3b8);cursor:pointer;font-size:13px;padding:0 4px;line-height:1}
.vtable .vt-ncomentar:hover{color:var(--green,#2563eb)}
.notas-pop{position:absolute;z-index:60;min-width:270px;max-width:360px;background:var(--card,#fff);border:1px solid var(--border,#e2e8f0);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.22);padding:11px 13px;font-size:12.5px;color:var(--fg,#1f2937)}
.notas-pop h4{margin:0 0 7px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--fg-dim,#64748b);font-weight:600}
.notas-pop .notas-hilo{max-height:230px;overflow:auto;margin:0 0 9px}
.notas-pop .notas-item{padding:6px 0;border-top:1px solid var(--border,#e2e8f0)}
.notas-pop .notas-item:first-child{border-top:none}
.notas-pop .notas-meta{font-size:10.5px;color:var(--fg-dim,#94a3b8);margin-bottom:2px}
.notas-pop .notas-vacia{color:var(--fg-dim,#94a3b8)}
.notas-pop textarea{width:100%;box-sizing:border-box;min-height:56px;background:var(--bg,#fff);color:var(--fg,#1f2937);border:1px solid var(--border,#e2e8f0);border-radius:7px;padding:7px 9px;font:inherit;font-size:12.5px;resize:vertical}
.notas-pop .notas-pop-foot{display:flex;gap:8px;align-items:center;margin-top:7px}
.notas-pop button.notas-enviar{background:var(--green,#2563eb);color:#fff;border:none;border-radius:6px;padding:6px 13px;font-size:12px;font-family:inherit;cursor:pointer}
.notas-pop button.notas-cerrar{background:none;border:none;color:var(--fg-dim,#94a3b8);cursor:pointer;font-size:12px}
.notas-pop .notas-err{color:var(--red,#dc2626);font-size:11.5px}
@media print{.notas-pop,.vtable .vt-ncomentar,.vtable td.vt-nactions{display:none!important}}
`

/**
 * Runtime de la capa de notas. Lee el contexto de `script#vergis-notas` y cablea:
 *  · la sección de la bandeja (Imprimir · Anotar sobre la fila seleccionada, o la vista entera),
 *  · los marcadores de comentario y su popover con el hilo,
 *  · la acción «Comentar el registro» por fila.
 *
 * Los marcadores se re-aplican tras cada re-render del runtime de tabla (orden, filtro, agrupar) vía
 * MutationObserver: el tbody se reconstruye entero y una decoración de una sola pasada se perdería.
 */
export const NOTAS_RUNTIME_SOURCE: string = `(function(){
var cfgEl=document.getElementById('vergis-notas'); if(!cfgEl) return;
var CFG=JSON.parse(cfgEl.textContent||'{}');
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function post(url, body){
  var payload={}; for(var k in body) payload[k]=body[k];
  payload._csrf=CFG.csrf; payload.page=CFG.page; payload.ctx=CFG.ctx;
  return fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){
      if(!r.ok) throw new Error((j&&j.error)||('Error '+r.status));
      return j;
    }); });
}
function fecha(iso){ try{ return new Date(iso).toLocaleString('es-CL',{dateStyle:'short',timeStyle:'short'}); }catch(e){ return iso||''; } }

// ── Bandeja: Imprimir · Anotar ───────────────────────────────────────────────────────────────
var kit=document.querySelector('.vt-notas-kit');
if(kit){
  var msg=kit.querySelector('.notas-msg');
  function aviso(html){ if(msg) msg.innerHTML=html; }
  kit.querySelector('.notas-imprimir').addEventListener('click', function(){
    aviso('Congelando la vista…');
    post(CFG.imprimirUrl,{}).then(function(j){
      aviso('Impresión guardada. <a href="'+esc(CFG.impresionesUrl)+'/'+esc(j.id)+'">Abrirla</a> · <a href="'+esc(CFG.impresionesUrl)+'">Mis impresiones</a>');
    }).catch(function(e){ aviso('<span class="notas-err">No se pudo imprimir: '+esc(e.message)+'</span>'); });
  });
  kit.querySelector('.notas-anotar').addEventListener('click', function(){
    if(kit.querySelector('.notas-form')) return;
    // El objetivo es la fila seleccionada (la selección ya existe en el runtime de tabla); sin
    // selección, la nota es sobre la impresión entera.
    var sel=document.querySelector('.vtable tr.vt-selected[data-nkey]');
    var objetivo = sel ? {tipo:'fila', llave: JSON.parse(sel.getAttribute('data-nkey')), dataset: sel.getAttribute('data-ndataset')} : {tipo:'impresion'};
    var form=document.createElement('div'); form.className='notas-form';
    form.innerHTML='<div class="notas-target">'+(sel?'Sobre la fila seleccionada':'Sobre esta vista completa')+'</div>'+
      '<textarea placeholder="Escribe tu nota…" aria-label="Nota"></textarea>'+
      '<div class="notas-actions"><button type="button" class="notas-enviar">Guardar nota</button><button type="button" class="notas-cancelar">Cancelar</button></div>';
    kit.insertBefore(form, msg);
    var ta=form.querySelector('textarea'); ta.focus();
    form.querySelector('.notas-cancelar').addEventListener('click', function(){ form.remove(); });
    form.querySelector('.notas-enviar').addEventListener('click', function(){
      var texto=(ta.value||'').trim(); if(!texto) return;
      aviso('Guardando…');
      post(CFG.notasUrl,{contenido:texto, objetivo:objetivo}).then(function(j){
        form.remove();
        aviso('Nota guardada en <a href="'+esc(CFG.impresionesUrl)+'/'+esc(j.impresionId)+'">esta impresión</a>.');
      }).catch(function(e){ aviso('<span class="notas-err">No se pudo guardar: '+esc(e.message)+'</span>'); });
    });
  });
}

// ── Comentarios: marcador, popover con el hilo, y la acción por fila ─────────────────────────
var pop=null;
function cerrarPop(){ if(pop){ pop.remove(); pop=null; } }
document.addEventListener('click', function(e){ if(pop && !pop.contains(e.target) && !e.target.closest('.vt-nmark') && !e.target.closest('.vt-ncomentar')) cerrarPop(); });
document.addEventListener('keydown', function(e){ if(e.key==='Escape') cerrarPop(); });

function abrirPop(anchorEl, ancla, llave, campo){
  cerrarPop();
  pop=document.createElement('div'); pop.className='notas-pop';
  pop.innerHTML='<h4>'+esc(campo?('Comentarios · '+campo):'Comentarios del registro')+'</h4><div class="notas-hilo">Cargando…</div>'+
    '<textarea placeholder="Escribe un comentario…" aria-label="Comentario"></textarea>'+
    '<div class="notas-pop-foot"><button type="button" class="notas-enviar">Comentar</button><button type="button" class="notas-cerrar">Cerrar</button><span class="notas-err"></span></div>';
  document.body.appendChild(pop);
  var r=anchorEl.getBoundingClientRect();
  pop.style.top=(window.scrollY+r.bottom+6)+'px';
  pop.style.left=Math.max(8, Math.min(window.scrollX+r.left, window.scrollX+document.documentElement.clientWidth-pop.offsetWidth-8))+'px';
  pop.querySelector('.notas-cerrar').addEventListener('click', cerrarPop);
  var hilo=pop.querySelector('.notas-hilo');
  var err=pop.querySelector('.notas-err');
  function pintar(notas){
    if(!notas.length){ hilo.innerHTML='<div class="notas-vacia">Nadie ha comentado este registro.</div>'; return; }
    hilo.innerHTML=notas.map(function(n){
      return '<div class="notas-item"><div class="notas-meta">'+esc(n.autor)+' · '+esc(fecha(n.createdAt))+(n.campo?(' · '+esc(n.campo)):'')+(n.refRota?' · referencia no resuelta':'')+'</div>'+esc(n.contenido||'(nota retirada)')+'</div>';
    }).join('');
  }
  var q=CFG.comentariosUrl+'?dataset='+encodeURIComponent(ancla.dataset)+'&key='+encodeURIComponent(JSON.stringify(llave));
  fetch(q,{headers:{accept:'application/json'}}).then(function(r2){ return r2.json(); })
    .then(function(j){ pintar(j.notas||[]); })
    .catch(function(){ hilo.innerHTML='<div class="notas-err">No se pudo leer el hilo.</div>'; });
  pop.querySelector('.notas-enviar').addEventListener('click', function(){
    var ta=pop.querySelector('textarea'); var texto=(ta.value||'').trim(); if(!texto) return;
    err.textContent='';
    post(CFG.comentariosUrl,{dataset:ancla.dataset, key:llave, campo:campo||undefined, contenido:texto})
      .then(function(){ ta.value=''; return fetch(q,{headers:{accept:'application/json'}}).then(function(r2){ return r2.json(); }); })
      .then(function(j){ pintar(j.notas||[]); marcarTablas(); })
      .catch(function(e){ err.textContent=e.message; });
  });
}

/** Decora las filas de las tablas ancladas: marcador donde ya hay comentarios + acción por fila. */
function marcarTablas(){
  Array.prototype.forEach.call(document.querySelectorAll('.vtable'), function(root){
    var dataEl=root.querySelector('script.vtable-data'); if(!dataEl) return;
    var payload; try{ payload=JSON.parse(dataEl.textContent); }catch(e){ return; }
    var ancla=payload.ancla; if(!ancla) return;
    Array.prototype.forEach.call(root.querySelectorAll('tbody > tr[data-nkey]'), function(tr){
      var llaveTxt=tr.getAttribute('data-nkey');
      var info=(ancla.comentarios||{})[llaveTxt];
      var tds=tr.querySelectorAll('td');
      // Marcador por CELDA comentada, y en la primera celda para los comentarios de fila.
      Array.prototype.forEach.call(tds, function(td, i){
        var old=td.querySelector('.vt-nmark'); if(old) old.remove();
        if(!info) return;
        var col=payload.cols[i]; var campo=col?col.field:null;
        var n=(campo && info.porCampo[campo]) ? info.porCampo[campo] : 0;
        if(i===0) n+=(info.porCampo['']||0);
        if(!n) return;
        td.classList.add('vt-ncell');
        var mark=document.createElement('span'); mark.className='vt-nmark';
        mark.setAttribute('title', n+(n===1?' comentario':' comentarios'));
        mark.setAttribute('data-campo', (i===0 && info.porCampo['']) ? '' : (campo||''));
        td.appendChild(mark);
      });
      // Acción «Comentar el registro»: deliberada, por fila, en la celda de acciones.
      if(!tr.querySelector('.vt-ncomentar')){
        var cell=tr.querySelector('td.vt-actions');
        if(!cell){ cell=document.createElement('td'); cell.className='vt-actions vt-nactions'; tr.appendChild(cell); }
        var b=document.createElement('button');
        b.type='button'; b.className='vt-ncomentar'; b.title='Comentar el registro'; b.textContent='💬';
        cell.appendChild(b);
      }
    });
    if(!root.hasAttribute('data-nwired')){
      root.setAttribute('data-nwired','1');
      root.addEventListener('click', function(e){
        var tr=e.target.closest ? e.target.closest('tr[data-nkey]') : null; if(!tr) return;
        var llave; try{ llave=JSON.parse(tr.getAttribute('data-nkey')); }catch(err2){ return; }
        var mk=e.target.closest('.vt-nmark');
        if(mk){ e.stopPropagation(); abrirPop(mk, ancla, llave, mk.getAttribute('data-campo')||''); return; }
        var cb=e.target.closest('.vt-ncomentar');
        if(cb){ e.stopPropagation(); abrirPop(cb, ancla, llave, ''); }
      });
      var tb=root.querySelector('tbody');
      if(tb && window.MutationObserver){
        // El runtime de tabla reconstruye el tbody en cada orden/filtro/agrupar: sin re-decorar, los
        // marcadores desaparecerían al primer clic en un encabezado.
        new MutationObserver(function(){ marcarTablas(); }).observe(tb,{childList:true});
      }
    }
  });
}
marcarTablas();
})();`
