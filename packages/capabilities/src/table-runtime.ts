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
  /** Campos sobre los que corre la búsqueda GLOBAL. Si está definido, la búsqueda se limita a ellos
   *  (las columnas mostradas y buscables) — así no matchea campos ocultos del payload (tokens de
   *  anotación, claves de drill). Ausente → todos los campos de la fila (back-compat). */
  searchCols?: string[]
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
  // Los drivers SQL entregan los enteros de 64 bits como STRING para no perder precisión (p. ej.
  // SUM sobre BIGINT) — un `format` numérico debe formatear también el string numérico. Un entero
  // se agrupa SOBRE el string (convertir a Number perdería dígitos más allá de MAX_SAFE_INTEGER);
  // un string no numérico sigue su camino normal (se sirve tal cual, sin romper el render).
  // AUTOCONTENIDO a propósito: esta función viaja al browser vía `.toString()` (PURE_FNS).
  if (typeof value === 'string' && (format === 'int_0' || format === 'percent_1' || format === 'percent' || format === 'abbr')) {
    const s = value.trim()
    if (format === 'int_0' && /^[+-]?\d+$/.test(s)) {
      const digits = s.replace(/^[+-]/, '').replace(/^0+(?=\d)/, '')
      const neg = s.charAt(0) === '-' && digits !== '0' ? '-' : ''
      return neg + digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
    }
    if (s !== '' && !Number.isNaN(Number(s))) return vtFormat(Number(s), format)
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '—'
    if (format === 'int_0')
      return new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(Math.round(value))
    if (format === 'percent_1') return (value * 100).toFixed(1) + '%'
    if (format === 'percent') return Math.round(value * 100) + '%'
    // `abbr` — magnitud abreviada es-CL para rótulos de chart, donde el ancho de la marca es el
    // presupuesto: `1,2M` · `340K` · `2.500M`. Escalera de DOS sufijos a propósito: K (miles) y M
    // (millones). NO se usa «B»: en español «billón» es 10^12, así que 2,5e9 se rotula `2.500M`
    // (millones, la unidad idiomática en Chile) en vez de un `2,5B` que se leería mil veces mayor.
    // Coma decimal y punto de miles como el resto del formateador; un decimal solo si la mantisa es
    // menor a 100 (con más dígitos el decimal no aporta y roba ancho), y se poda el `,0`.
    if (format === 'abbr') {
      const abs = Math.abs(value)
      const [div, suffix] = abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'K'] : [1, '']
      const mant = value / div
      const decimals = Math.abs(mant) < 100 && suffix !== '' ? 1 : 0
      const txt = new Intl.NumberFormat('es-CL', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(mant)
      const trimmed = decimals ? txt.replace(/,0$/, '') : txt
      // `-0` (redondeo de una magnitud negativa diminuta) se rotula `0`: el signo miente sobre el dato.
      return (trimmed === '-0' ? '0' : trimmed) + suffix
    }
    return String(value)
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10)
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
      // Solo las columnas buscables si están declaradas; si no, todos los campos (back-compat).
      const keys = state.searchCols && state.searchCols.length ? state.searchCols : Object.keys(r)
      for (const k of keys) {
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
    // Decidir el modo UNA vez por columna (no por par): un comparador que alterna numérico/léxico
    // según cada par es NO-transitivo → Array.sort da órdenes arbitrarios en columnas mixtas.
    const numeric = vtIsNumericCol(out, field)
    const num = (v: unknown): number => (v == null || v === '' ? NaN : Number(v))
    out.sort((a, b) => {
      let c: number
      if (numeric) {
        const an = num(a[field])
        const bn = num(b[field])
        const aN = Number.isNaN(an)
        const bN = Number.isNaN(bn)
        c = aN && bN ? 0 : aN ? 1 : bN ? -1 : an - bn // celdas no-numéricas/vacías al final
      } else {
        c = vtNorm(a[field]).localeCompare(vtNorm(b[field]))
      }
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
 * Una celda CSV — la ÚNICA regla de celda de la plataforma (GH #61 / D4). La usan el export del
 * cliente (viaja al browser en PURE_FNS) y el CSV de delivery (`render-csv-piece` la importa),
 * con el separador como parámetro: `;` en el cliente (Excel es-CL usa coma decimal) y `,` en
 * delivery. El separador es OBLIGATORIO: un default de parámetro es riesgo evitable en código
 * que viaja serializado por `toString`.
 *
 * Valor RAW (sin formatear: `640838`, no `640.838`); `null`/`undefined` → vacío; `Date` → ISO
 * `YYYY-MM-DD`; strings tal cual.
 *
 * Neutralización de formula injection (D5): se antepone `'` a un STRING que empieza con
 * `= @`, tab o CR, o que empieza con `+`/`-` y NO es un número. La excepción numérica importa:
 * los drivers SQL entregan los BIGINT como string (`"-2644239500"`) y prefijarlos los corrompe.
 * Los `number` nativos jamás se tocan.
 *
 * Quoting RFC 4180: se cita si el valor contiene comilla, salto de línea o el separador; la
 * comilla interna se dobla.
 */
export function vtCsvCell(v: unknown, sep: string): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  let s = String(v)
  if (typeof v === 'string') {
    const inj = /^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && Number.isNaN(Number(s)))
    if (inj) s = "'" + s
  }
  const needsQuote = s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0 || s.indexOf(sep) >= 0
  return needsQuote ? '"' + s.replace(/"/g, '""') + '"' : s
}

/**
 * Armado del CSV del export del cliente (GH #61 / D6): línea de header (`label ?? field`) más
 * una línea por fila, con las COLUMNAS VISIBLES únicamente — los campos ocultos del payload
 * (tokens de notas, claves de drill) no están en `cols` y por eso no viajan: garantía estructural.
 * Separador `;`, líneas unidas con CRLF (convención Windows/Excel).
 *
 * SIN BOM: el BOM es asunto del envoltorio (el handler lo antepone en el Blob; el CSV de delivery
 * lo mantiene opt-in).
 */
export function vtCsv(cols: { field: string; label?: string }[], rows: Record<string, unknown>[]): string {
  const lines = [cols.map((c) => vtCsvCell(c.label == null ? c.field : c.label, ';')).join(';')]
  for (const r of rows) lines.push(cols.map((c) => vtCsvCell(r[c.field], ';')).join(';'))
  return lines.join('\r\n')
}

/**
 * Nombre del archivo descargado (GH #61 / D7): `<doc>--<tabla>--YYYY-MM-DD[--filtrado].csv`.
 * El título del documento identifica el PI; el rótulo del kit distingue CUÁL tabla cuando la
 * página trae varias; la fecha ancla la foto; el sufijo `--filtrado` avisa que lo descargado NO
 * es el dataset completo. Separador `--` entre segmentos porque los slugs internos usan `-`.
 * Si el slug de la tabla es vacío o igual al del documento, el segmento se omite (sin
 * `reporte--reporte`).
 *
 * AUTOCONTENIDA a propósito (el slug es una función local): viaja al browser vía `.toString()`.
 */
export function vtCsvName(docTitle: unknown, kitLabel: unknown, dateISO: string, filtered: boolean): string {
  return vtDownloadName(docTitle, kitLabel, dateISO, filtered, 'csv', 'tabla')
}

/**
 * LA gramática de nombre de archivo descargable de la plataforma — única implementación.
 * `<doc>[--<segmento>]--YYYY-MM-DD[--filtrado].<ext>`
 *
 * El título identifica el PI; el segmento (la tabla en el CSV, la página en el PDF) aparece solo
 * cuando aporta —se omite si es vacío o igual al slug del título, para no producir
 * `reporte--reporte`—; la fecha ancla la foto; el sufijo `--filtrado` avisa que el archivo NO es
 * el completo. Separador `--` porque los slugs internos ya usan `-`.
 *
 * Nació dos veces —`vtCsvName` (#61 · D7) y `pdfFilename` (#65 · D10)— con la misma gramática
 * escrita dos veces. Unificada acá: `vtCsvName` la envuelve para el navegador y `server/pdf.ts`
 * la importa para el PDF. Un cambio de gramática se hace ahora en un solo sitio.
 *
 * AUTOCONTENIDA a propósito (el slug es una función local, sin imports): viaja al browser vía
 * `.toString()` en `PURE_FNS`, igual que su envoltorio. No introducir dependencias acá.
 */
export function vtDownloadName(
  docTitle: unknown,
  segment: unknown,
  dateISO: string,
  filtered: boolean,
  ext: string,
  fallback: string,
): string {
  const slug = function (s: unknown): string {
    return String(s == null ? '' : s)
      .trim()
      .replace(/[^\wÀ-ÿ -]+/g, '')
      .replace(/\s+/g, '-')
      .toLowerCase()
  }
  const base = slug(docTitle) || fallback
  const seg = slug(segment)
  const mid = seg && seg !== base ? '--' + seg : ''
  return base + mid + '--' + dateISO + (filtered ? '--filtrado' : '') + '.' + ext
}

/**
 * Fuente JS que se inyecta en el navegador: las funciones puras de arriba (vía toString,
 * sin tipos tras la transpilación de esbuild) + el cableado del DOM. Se emite UNA vez por
 * documento; cada `.vtable` se autoarranca leyendo su JSON embebido.
 */
const PURE_FNS = [
  vtNorm,
  vtIsNumericCol,
  vtDistinct,
  vtIsCategorical,
  vtFormat,
  vtApply,
  vtGroup,
  vtGroupTree,
  vtCsvCell,
  vtCsv,
  vtCsvName,
  // `vtCsvName` la llama: sin ella emitida acá, el CSV del navegador rompería.
  vtDownloadName,
]

/**
 * Snippet COMPARTIDO del tab "Vistas" (presets) — lo usan TODOS los PI (tabla y dashboard).
 * Genérico vía callbacks: `opts.snapshot()` captura el estado del PI, `opts.apply(state)` lo
 * restituye. La UI (guardar/aplicar/actualizar/eliminar), persistencia por reporte en
 * localStorage, pin de vista por defecto y confirmaciones viven acá, una sola vez. Cada runtime
 * (table-runtime / renderInteractiveScript del dashboard) lo incluye y lo invoca con SUS callbacks.
 */
export const SAVED_VIEWS_JS = `
function vergisSavedViews(opts){
  var wrap = document.querySelector('.tray-saved'); if(!wrap) return;
  var key = 'vergis:saved:'+((typeof location!=='undefined' && location.pathname) || 'pi');
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function load(){ try{ return JSON.parse(localStorage.getItem(key)||'[]'); }catch(e){ return []; } }
  function store(a){ try{ localStorage.setItem(key, JSON.stringify(a)); }catch(e){} }
  function ask(m){ try{ return (typeof window!=='undefined' && typeof window.confirm==='function') ? window.confirm(m) : true; }catch(e){ return true; } }
  function renderList(){
    var list=wrap.querySelector('.vt-saved-list'); if(!list) return;
    var arr=load();
    list.innerHTML = arr.length ? arr.map(function(p,i){
      return '<div class="vt-saved-row'+(p.pinned?' pinned':'')+'">'+
        '<button type="button" class="vt-saved-pin" data-i="'+i+'" title="'+(p.pinned?'Vista por defecto (quitar)':'Fijar como vista por defecto al entrar')+'">'+(p.pinned?'★':'☆')+'</button>'+
        '<span class="vt-saved-name" data-i="'+i+'" title="Aplicar esta vista">'+esc(p.name)+'</span>'+
        '<span class="vt-saved-actions"><button type="button" class="vt-saved-upd" data-i="'+i+'" title="Actualizar con la vista actual">↻</button><button type="button" class="vt-saved-del" data-i="'+i+'" title="Eliminar">×</button></span>'+
        '</div>';
    }).join('') : '<div class="vt-saved-empty">Sin vistas guardadas</div>';
  }
  wrap.innerHTML = '<div class="faceta-title">Guardar la vista actual</div><div class="vt-save-new"><input class="vt-save-name" type="text" placeholder="Nombre de la vista…"><button type="button" class="vt-save-btn">Guardar</button></div><div class="vt-saved-list"></div><div class="vt-saved-hint">★ = vista por defecto al entrar al reporte</div>';
  var nameInp=wrap.querySelector('.vt-save-name');
  wrap.querySelector('.vt-save-btn').addEventListener('click', function(){
    var arr=load(); var nm=(nameInp.value||'').trim()||('Vista '+(arr.length+1));
    arr.push({ name: nm, state: opts.snapshot() }); store(arr); nameInp.value=''; renderList();
  });
  wrap.querySelector('.vt-saved-list').addEventListener('click', function(e){
    var pin=e.target.closest('.vt-saved-pin'), del=e.target.closest('.vt-saved-del'), upd=e.target.closest('.vt-saved-upd'), nm=e.target.closest('.vt-saved-name');
    if(pin){ var ap=load(); var ip=+pin.getAttribute('data-i'); var was=ap[ip]&&ap[ip].pinned; ap.forEach(function(v){v.pinned=false;}); if(ap[ip]) ap[ip].pinned=!was; store(ap); renderList(); }
    else if(del){ var a=load(); var idd=+del.getAttribute('data-i'); var vd=a[idd]; if(vd && ask('¿Eliminar la vista “'+vd.name+'”?')){ a.splice(idd,1); store(a); renderList(); } }
    else if(upd){ var a2=load(); var i2=+upd.getAttribute('data-i'); if(a2[i2] && ask('¿Actualizar la vista “'+a2[i2].name+'” con la vista actual?')){ a2[i2].state=opts.snapshot(); store(a2); } }
    else if(nm){ var a3=load(); var i3=+nm.getAttribute('data-i'); if(a3[i3]) opts.apply(a3[i3].state); }
  });
  renderList();
  var def=load().filter(function(v){return v.pinned;})[0]; if(def) opts.apply(def.state);
}
`

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
/* Una clave multi-valor del carry (control multi-select) se repite: &ctx.k=a&ctx.k=b (espejo de ctxQuery server-side). */
function vtCtxQuery(carry, keys){ var m={},k,q=''; for(k in (carry||{})) m[k]=carry[k]; for(k in (keys||{})) m[k]=keys[k]; for(k in m){ var vs=Array.isArray(m[k])?m[k]:[m[k]]; for(var i=0;i<vs.length;i++){ if(vs[i]!=null&&vs[i]!=='') q+='&ctx.'+encodeURIComponent(k)+'='+encodeURIComponent(String(vs[i])); } } return q; }
/* fltQ = sufijo &flt.k=v YA serializado server-side (filtros de bandeja activos): se anexa tal cual, sin re-implementar su carry aqui. */
function vtDrillHref(drill, r, carry, fltQ){ var keys={}; for(var i=0;i<drill.by.length;i++){ var b=drill.by[i]; keys[b]=String(r[b]==null?'':r[b]); } return '?page='+encodeURIComponent(drill.to)+vtCtxQuery(carry,keys)+(fltQ||''); }
function vtDrillActions(drills, r, carry, fltQ){
  if(!drills||!drills.length) return '';
  var links=drills.map(function(d){ var href=vtEsc(vtDrillHref(d,r,carry,fltQ)); var label=d.label?vtEsc(d.label):'→'; var cls=d.label?'vt-drill-link':'vt-drill-link vt-drill-arrow'; var title=d.label?vtEsc(d.label):'Ver detalle'; return '<a class="'+cls+'" href="'+href+'" title="'+title+'">'+label+'</a>'; }).join('');
  return '<td class="vt-actions">'+links+'</td>';
}
/* Llave canónica de negocio de una fila — espejo EXACTO de llaveCanonicaDeFila (server) y de
   llaveDeFila+canonicalKey (store): columnas ordenadas y valores coercionados a texto. Si las dos
   implementaciones divergen, el marcador aparece o no según por dónde se pregunte. */
function vtNKey(r, key){
  var cols=key.slice().sort();
  return '{'+cols.map(function(k){ return JSON.stringify(k)+':'+JSON.stringify(r[k]==null?'':String(r[k])); }).join(',')+'}';
}
function vtBodyRows(cols, rows, drills, carry, ancla, fltQ){
  var single = drills && drills.length===1;
  return rows.map(function(r){
    var nkey = ancla ? ' data-nkey="'+vtEsc(vtNKey(r,ancla.key))+'" data-ndataset="'+vtEsc(ancla.dataset)+'"' : '';
    var open = single ? '<tr class="vt-drill-row" title="Doble clic: ver detalle" data-href="'+vtEsc(vtDrillHref(drills[0],r,carry,fltQ))+'"'+nkey+'>' : '<tr'+nkey+'>';
    return open+cols.map(function(c){return vtCell(c,r);}).join('')+vtDrillActions(drills,r,carry,fltQ)+'</tr>';
  }).join('');
}
function vtCounts(rows, field){ var m={}; for(var i=0;i<rows.length;i++){ var k=String(rows[i][field]==null?'':rows[i][field]); m[k]=(m[k]||0)+1; } return m; }
function vtBootstrap(root){
  var dataEl = root.querySelector('script.vtable-data');
  if(!dataEl) return;
  var payload = JSON.parse(dataEl.textContent);
  var rows = payload.rows, cols = payload.cols;
  // Drill-through: acciones por fila (1 link por drill). Con un solo drill, además doble-clic de fila.
  // carry (ctx de cabecera, p.ej. la semana) se preserva en cada href de drill.
  var drills = payload.drills || [];
  var carry = payload.carryCtx || {};
  var ancla = payload.ancla || null;
  var fltQ = payload.fltQ || '';
  var nactions = drills.length ? 1 : 0;
  function renderCols(){ return cols; }
  var groupFields = cols.filter(function(c){ return c.groupBy===false?false:(c.groupBy===true?true:vtIsCategorical(rows, c.field, c.filter)); });
  // groupLevels = jerarquía de agrupación (orden = anidamiento). collapsed = paths de grupos colapsados.
  var state = { sort:{field:'',dir:'asc'}, globalSearch:'', colSearch:{}, facets:{}, groupLevels:[], collapsed:{} };
  // Busqueda global acotada a las columnas mostradas y buscables: los campos ocultos del payload
  // (claves de drill) no estan en cols, asi que no se buscan por texto.
  state.searchCols = cols.filter(function(c){ return c.searchable!==false; }).map(function(c){ return c.field; });
  var rendered = false; // ¿render() ya corrió? (p.ej. una vista pinneada aplicada vía applySnapshot)
  var tbody = root.querySelector('tbody');
  var chipsEl = root.querySelector('.vt-chips');
  var footEl = root.querySelector('.vt-count-foot'); // pie de la CARA de esta tabla (contador de filas)
  var badge = document.getElementById('vergis-count'); // uña/pestaña de la bandeja común
  var SEP = '~|~'; // separador de path de grupo (token improbable en datos reales)
  function colLabel(field){ var c=cols.filter(function(x){return x.field===field;})[0]; return c?(c.label||c.field):field; }

  // ---- KIT de afordancias en la BANDEJA COMÚN (.tray-sections): buscar, agrupar (multinivel),
  //      descargar, limpiar. El contador de filas YA NO vive aquí: es pie de la CARA (footEl). El kit
  //      se marca (.vt-kit + label + nº filas) para que el coordinador imponga UN kit por página
  //      (con selector de objetivo si hay ≥2 tablas interactivas) — TX-11 WP4·2. ----
  var gs=null, levelsEl=null, addSel=null, groupActions=null;
  var trayWrap = document.querySelector('.tray-sections');
  if(trayWrap){
    var h3=root.querySelector('h3');
    var kitLabel=(h3 && (h3.textContent||'').trim()) || (cols[0] ? (cols[0].label||cols[0].field) : 'Tabla');
    var sec=document.createElement('div'); sec.className='faceta vt-tray-section vt-kit';
    sec.setAttribute('data-kit-label', kitLabel); sec.setAttribute('data-kit-rows', String(rows.length));
    // Cada control en su grupo lógico (label pegado a su campo; grupos separados entre sí).
    sec.innerHTML =
      '<div class="vt-ctl-grp"><div class="faceta-title">Buscar</div>' +
      '<input class="vt-global-search" type="search" placeholder="Buscar en toda la tabla…" aria-label="Buscar en toda la tabla"></div>' +
      (groupFields.length ? (
        '<div class="vt-ctl-grp"><div class="faceta-title">Agrupar por</div>' +
        '<div class="vt-group-levels"></div>' +
        '<select class="vt-group-add"></select>' +
        '<div class="vt-group-actions"><button type="button" class="vt-expand-all">Expandir todo</button><button type="button" class="vt-collapse-all">Colapsar todo</button></div></div>'
      ) : '') +
      '<div class="vt-ctl-grp"><div class="faceta-title">Descargar</div>' +
      '<button type="button" class="vt-export" title="Exporta las filas visibles (con los filtros aplicados) a CSV, abrible en Excel">Descargar CSV (vista actual)</button></div>' +
      '<div class="vt-ctl-grp"><button type="button" class="vt-clear-all">Limpiar todo</button></div>';
    trayWrap.appendChild(sec);
    gs=sec.querySelector('.vt-global-search');
    levelsEl=sec.querySelector('.vt-group-levels'); addSel=sec.querySelector('.vt-group-add'); groupActions=sec.querySelector('.vt-group-actions');
    // Debounce (~150ms): en una tabla grande, re-renderizar en CADA tecla trababa el input. Se acumulan
    // las pulsaciones y se renderiza una vez que el usuario pausa (el value del input sigue instantáneo).
    var gsTimer; gs.addEventListener('input', function(){ clearTimeout(gsTimer); gsTimer=setTimeout(function(){ state.globalSearch=gs.value; render(); }, 150); });
    sec.querySelector('.vt-clear-all').addEventListener('click', function(){ clearAll(); });
    // Export CSV (issue #61 / TX-01): exporta la VISTA ACTUAL (filtros/búsqueda aplicados) con las
    // columnas visibles. Las NOTAS jamás viajan en el export. La regla de celda y el armado viven
    // en las puras vtCsvCell/vtCsv/vtCsvName (una sola fuente, testeada, compartida con el CSV de
    // delivery): acá solo el envoltorio — BOM UTF-8 + Blob + download. Sin dependencias.
    var expBtn = sec.querySelector('.vt-export');
    if(expBtn) expBtn.addEventListener('click', function(){
      var rc = renderCols();
      var view = vtApply(rows, state);
      // «Filtrado» = el CONJUNTO de filas se redujo (búsqueda global, faceta o búsqueda por
      // columna). El orden y la agrupación no cuentan: no cambian qué filas viajan.
      var filtered = !!state.globalSearch;
      for(var ff in state.facets){ if((state.facets[ff]||[]).length) filtered=true; }
      for(var cf in state.colSearch){ if(state.colSearch[cf]) filtered=true; }
      var blob = new Blob(['\\ufeff'+vtCsv(rc, view)], {type:'text/csv;charset=utf-8'});
      var a = document.createElement('a');
      a.href = window.URL.createObjectURL(blob);
      a.download = vtCsvName(document.title, kitLabel, new Date().toISOString().slice(0,10), filtered);
      document.body.appendChild(a); a.click();
      setTimeout(function(){ window.URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });
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

  // ---- Tab "Vistas": presets persistidos por reporte. La UI/persistencia/pin/confirmación viven
  //      en el snippet COMPARTIDO vergisSavedViews; acá solo el snapshot/apply propios de la tabla. ----
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
  vergisSavedViews({ snapshot: snapshot, apply: applySnapshot });

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

  // ---- Selección de registro: UN clic en una fila hoja la marca como seleccionada (feedback visual).
  //      Selección única (limpia las demás). Ignora los encabezados de grupo. ----
  tbody.addEventListener('click', function(e){
    var tr=e.target.closest('tbody > tr'); if(!tr) return;
    if(tr.classList.contains('vt-group-head') || tr.classList.contains('vt-empty')) return;
    Array.prototype.forEach.call(tbody.querySelectorAll('tr.vt-selected'), function(x){ x.classList.remove('vt-selected'); });
    tr.classList.add('vt-selected');
  });

  // ---- Drill-through: DOBLE clic en una fila hoja → navega a la vista destino con el contexto del
  //      registro. Doble clic (no simple) para no disparar la navegación con un clic casual; deja el
  //      clic simple libre (seleccionar, arriba). Ignora los encabezados de grupo. ----
  if(drills.length===1) tbody.addEventListener('dblclick', function(e){
    if(e.target.closest('tr.vt-group-head')) return;
    if(e.target.closest('.vt-drill-link')) return; // el link ya navega por sí mismo
    var tr=e.target.closest('tr.vt-drill-row'); if(!tr) return;
    var href=tr.getAttribute('data-href'); if(href) location.assign(href);
  });

  // ---- Chips de filtros activos (sobre la tabla): clic = quitar ----
  if(chipsEl) chipsEl.addEventListener('click', function(e){
    var chip=e.target.closest('.vt-chip'); if(!chip) return;
    if(chip.getAttribute('data-search')==='global'){ state.globalSearch=''; if(gs) gs.value=''; }
    else { var f=chip.getAttribute('data-field'), v=chip.getAttribute('data-val'); state.facets[f]=(state.facets[f]||[]).filter(function(x){return x!==v;}); var th=root.querySelector('th[data-field="'+f+'"]'); var pop=th&&th.querySelector('.vt-col-pop'); if(pop&&pop.innerHTML){ var ins=pop.querySelectorAll('.vt-pop-opts input'); for(var bi=0;bi<ins.length;bi++){ if(ins[bi].value===v){ ins[bi].checked=false; break; } } } }
    render();
  });

  // Walk del árbol multinivel → filas <tr>. Cada grupo: encabezado con caret (▾/▸), nivel
  // (data-depth, indentado) y conteo; si está colapsado, no se renderizan sus descendientes.
  function renderNodeTree(rc, ncols, node, depth, prefix){
    if(node.leaf) return vtBodyRows(rc, node.rows, drills, carry, ancla, fltQ);
    return node.groups.map(function(g){
      var path=prefix+node.field+SEP+g.key;
      var collapsed=!!state.collapsed[path];
      var caret=collapsed?'▸':'▾';
      var head='<tr class="vt-group-head" data-depth="'+depth+'" data-path="'+vtEsc(path)+'"><td colspan="'+ncols+'" style="padding-left:'+(depth*18+12)+'px"><span class="vt-gcaret">'+caret+'</span> '+vtEsc(colLabel(node.field))+': '+vtEsc(g.key||'(vacío)')+' <span class="vt-gcount">('+g.count+')</span></td></tr>';
      return head + (collapsed ? '' : renderNodeTree(rc, ncols, g.child, depth+1, path+SEP));
    }).join('');
  }
  function render(){
    rendered = true;
    var rc = renderCols(), ncols = rc.length + nactions;
    var view = vtApply(rows, state);
    if(state.groupLevels.length){
      tbody.innerHTML = renderNodeTree(rc, ncols, vtGroupTree(view, state.groupLevels), 0, '') || '<tr class="vt-empty"><td colspan="'+ncols+'">Sin resultados</td></tr>';
    } else {
      tbody.innerHTML = vtBodyRows(rc, view, drills, carry, ancla, fltQ) || '<tr class="vt-empty"><td colspan="'+ncols+'">Sin resultados</td></tr>';
    }
    if(footEl) footEl.textContent = view.length + (view.length===1?' fila':' filas') + (view.length!==rows.length?(' de '+rows.length):'');
    Array.prototype.forEach.call(root.querySelectorAll('th[data-field]'), function(th){
      var f=th.getAttribute('data-field'); var ind=th.querySelector('.vt-sort-ind');
      if(ind) ind.textContent = (state.sort.field===f) ? (state.sort.dir==='asc'?'▲':'▼') : '';
      th.setAttribute('aria-sort', state.sort.field===f ? (state.sort.dir==='asc'?'ascending':'descending') : 'none');
      var btn=th.querySelector('.vt-filter-btn'); if(btn) btn.classList.toggle('on',(state.facets[f]||[]).length>0);
    });
    if(chipsEl){
      var chips=[];
      for(var f in state.facets){ (state.facets[f]||[]).forEach(function(v){ chips.push('<span class="vt-chip" data-field="'+vtEsc(f)+'" data-val="'+vtEsc(v)+'">'+vtEsc(colLabel(f)+': '+(v||'(vacío)'))+' <span class="vt-chip-x">×</span></span>'); }); }
      if(state.globalSearch) chips.push('<span class="vt-chip vt-chip-search" data-search="global">buscar: '+vtEsc(state.globalSearch)+' <span class="vt-chip-x">×</span></span>');
      chipsEl.innerHTML = chips.join('');
    }
    if(badge){ var n=0; for(var k in state.facets){ if((state.facets[k]||[]).length) n++; } if(state.globalSearch) n++; if(state.groupLevels.length) n++; badge.textContent = n?String(n):''; }
  }
  // Arranque: si una vista pinneada ya aplicó (applySnapshot → render), no hay nada que hacer.
  // Si el tbody servido ya trae TODAS las filas (ssrComplete) y el estado inicial es vacío (sin
  // orden/búsqueda/facetas/grupos) — el render() inicial reconstruiría un tbody IDÉNTICO al
  // servido: se salta, pintando
  // solo el conteo (que de otro modo solo pinta render()). En cualquier otro caso, render() normal.
  var stateEmpty = !state.sort.field && !state.globalSearch && !state.groupLevels.length;
  for(var fk in state.facets){ if((state.facets[fk]||[]).length) stateEmpty=false; }
  if(!rendered){
    // Con 0 filas NO se salta: render() pinta la fila «Sin resultados» (el tbody servido va vacío).
    if(payload.ssrComplete && stateEmpty && rows.length){
      if(footEl) footEl.textContent = rows.length + (rows.length===1?' fila':' filas');
    } else {
      render();
    }
  }
}
Array.prototype.forEach.call(document.querySelectorAll('.vtable'), vtBootstrap);
// ---- Kit ÚNICO en el Inspector (TX-11 WP4·2): con 1 tabla interactiva, su kit va tal cual. Con ≥2
//      (raro tras la heurística display), un solo kit visible + selector de objetivo (default = la de
//      más filas) — jamás kits apilados. Cada tabla ya cableó su propio kit; aquí solo se impone la
//      visibilidad y el conmutador. ----
(function(){
  var tray=document.querySelector('.tray-sections'); if(!tray) return;
  var kits=Array.prototype.slice.call(tray.querySelectorAll('.vt-kit'));
  if(kits.length<2) return;
  var def=0; for(var i=1;i<kits.length;i++){ if((+kits[i].getAttribute('data-kit-rows'))>(+kits[def].getAttribute('data-kit-rows'))) def=i; }
  var bar=document.createElement('div'); bar.className='faceta vt-kit-target';
  bar.innerHTML='<div class="faceta-title">Tabla</div><select class="vt-kit-target-sel" aria-label="Tabla objetivo del panel">'+kits.map(function(k,i){return '<option value="'+i+'">'+vtEsc(k.getAttribute('data-kit-label'))+'</option>';}).join('')+'</select>';
  tray.insertBefore(bar, tray.firstChild);
  var sel=bar.querySelector('select');
  function show(i){ for(var j=0;j<kits.length;j++){ kits[j].style.display=(j===i)?'':'none'; } sel.value=String(i); }
  sel.addEventListener('change', function(){ show(+sel.value); });
  show(def);
})();
`

export const TABLE_RUNTIME_SOURCE: string =
  '(function(){\n' + PURE_FNS.map((f) => f.toString()).join('\n') + '\n' + SAVED_VIEWS_JS + '\n' + DOM_GLUE + '\n})();'
