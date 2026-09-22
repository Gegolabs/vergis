/**
 * DIBUJAR el Datadoc (`CAP-197`) — el sitio estático multi-página, estilo Javadoc, como **función
 * pura** del modelo ensamblado: `renderDatadoc(entrada) → Archivo[]`. No toca disco, no consulta
 * nada, no mira el reloj. Quien la llama escribe los bytes.
 *
 * Es el emisor que la instancia A.R.B.O.L. probó en producción (`lab/scripts/gen-datadoc.mjs`),
 * portado **sin sus literales**: ni el nombre del proyecto ni el del cliente, ni «PowerBI», ni la
 * resolución interna que justifica su política abierta, ni la ruta de su generador. Todo eso, cuando
 * la instancia lo quiera decir, entra por `semantica.portada` / `semantica.seguridad`. Un test cierra
 * la lista de cadenas prohibidas y la mide sobre cada archivo emitido — sin ese test, el literal
 * vuelve en el primer merge distraído.
 *
 * ── TRES PROPIEDADES DEL EMISOR QUE NO SON ADORNO ───────────────────────────────────────────────
 *
 *  1. **Funciona por `file://`.** Los enlaces son SIEMPRE relativos y el índice del buscador es una
 *     **variable declarada** en `search-index.js`, no un JSON que se busca con `fetch` — que bajo
 *     `file://` lo bloquea CORS. La propiedad se conserva a propósito: un build se puede descargar,
 *     comprimir y mandar por correo, y sigue navegando.
 *  2. **Cada entidad tiene URL estable** (`entidades/<conexion>--<schema>.<tabla>.html`), para poder
 *     mandarle a alguien el enlace de UNA entidad. La llave es la **conexión** y no el dominio: el
 *     dominio es una etiqueta que puede reagrupar conexiones sin que la entidad cambie de lugar, y
 *     atar la URL a la etiqueta sería atarla a lo que sí se mueve.
 *  3. **El marco de tres paneles nunca lee el DOM del iframe.** Bajo `file://` cada archivo es un
 *     origen opaco; toda la navegación va del padre al hijo (el padre le cambia la URL). Servido por
 *     http(s) —donde padre e hijo comparten origen— el padre además lee la URL del iframe al cargar
 *     y sincroniza los paneles; si esa lectura lanza, la vista degrada a una sola dirección en vez
 *     de romperse.
 */

import { escapeHtml } from '@vergis/capabilities'
import type { ClaseEntidad } from './semantica-config'
import type { ConexionDatadoc, DominioDatadoc, EntidadDatadoc, ModeloDatadoc } from './datadoc-modelo'

/** Un archivo emitido: su ruta relativa a la raíz del build y su contenido. */
export interface Archivo {
  rel: string
  contenido: string
}

export interface EntradaRender {
  modelo: ModeloDatadoc
  /** Título de la plataforma (el `index_title` vigente). El sitio se titula `<brand> · Datadoc`. */
  brandTitle?: string
  /** Zona horaria con que se escriben las fechas legibles. Default: la del host. */
  timezone?: string
}

const esc = escapeHtml
const nf = (n: number): string => Number(n).toLocaleString('es-CL')
const pl = (n: number, sing: string, plur = `${sing}s`): string => `${nf(n)} ${n === 1 ? sing : plur}`

/** Fecha legible en la zona declarada. Sin zona, la del host — y el pie dice cuál se usó. */
function fecha(iso: string | null, tz?: string): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  try {
    return new Date(t).toLocaleString('es-CL', { ...(tz ? { timeZone: tz } : {}), dateStyle: 'full', timeStyle: 'short' })
  } catch {
    return new Date(t).toISOString()
  }
}

/** Nombre de archivo seguro: lo que no sea `[A-Za-z0-9_.-]` pasa a `_`. */
const fileSafe = (s: string): string => String(s).replace(/[^A-Za-z0-9_.-]/g, '_')
const domFile = (id: string): string => `dominios/${fileSafe(id)}.html`
const entFile = (conexion: string, ref: string): string => `entidades/${fileSafe(conexion)}--${fileSafe(ref)}.html`

const CLASE_CSS: Record<ClaseEntidad, string> = { publicado: 'pub', interno: 'int', deuda: 'deu' }
const CLASE_NOMBRE: Record<ClaseEntidad, string> = {
  publicado: 'PUBLICADO',
  interno: 'INTERNO',
  deuda: 'DEUDA / SIN CONSUMIDOR',
}
const badge = (c: ClaseEntidad): string => `<span class="badge b-${CLASE_CSS[c]}">${CLASE_NOMBRE[c]}</span>`

/** Hoja compartida. Ni una sola regla depende de la instancia. */
const CSS = `/* GENERADO por el nodo Vergis (CAP-197) — hoja compartida del Datadoc. NO editar a mano. */
:root{--ink:#16212e;--ink-soft:#45525f;--acceso:#b3540e;--consulta:#1246a8;--ingesta:#1c7a45;--ops:#5b6878}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#e9edf1;color:var(--ink);font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;padding:24px;font-size:15px;line-height:1.5}
.wrap{max-width:1180px;margin:0 auto;background:#fff;border:1px solid #c8d0d8;border-radius:10px;padding:20px 36px}
h1{font-family:Charter,Georgia,"Times New Roman",serif;font-size:28px;font-weight:700;letter-spacing:.2px;margin:10px 0 6px}
h1 code{font-size:.82em;vertical-align:1px}
h2{font-family:Charter,Georgia,serif;font-size:22px;margin:30px 0 10px;padding-top:10px;border-top:1.5px solid #c8d0d8}
h3{font-size:16px;margin:0 0 6px}
header.chrome{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;border-bottom:2px solid var(--ink);padding-bottom:14px;margin:8px 0 6px;flex-wrap:wrap}
header.chrome h1{font-size:30px;margin:0}
p{margin:8px 0}
ul{margin:6px 0 10px 22px}
li{margin:3px 0}
.sub{font-size:14px;color:var(--ink-soft);margin-top:5px;max-width:760px}
.sello{flex:none;text-align:left;border:1.5px solid var(--ingesta);border-radius:8px;padding:10px 14px;max-width:460px;font-size:12.5px}
.sello b{font-size:13px}
.sello .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ingesta);margin-right:6px}
.sello.parcial{border-color:var(--acceso)}
.sello.parcial .dot{background:var(--acceso)}
.sello table{border-collapse:collapse;margin-top:6px;width:100%}
.sello td{padding:1.5px 8px 1.5px 0;font-size:11.5px;color:var(--ink-soft);vertical-align:top}
.sello tr.bad td{color:#a12b1e;font-weight:600}
code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.92em;background:#f0f3f6;padding:1px 4px;border-radius:3px}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12px}
.src{font-size:12.5px;color:var(--ink-soft)}
.rojo{color:#a12b1e}
a{color:var(--consulta)}
nav.barra{position:sticky;top:0;background:#fff;z-index:5;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid #c8d0d8}
nav.barra a{color:var(--consulta);text-decoration:none;font-size:13px;white-space:nowrap}
nav.barra a:hover{text-decoration:underline}
nav.barra a.brand{font-family:Charter,Georgia,serif;font-weight:700;font-size:16px;color:var(--ink)}
nav.barra a.vista-paneles{font-weight:700;border:1px solid #c8d0d8;border-radius:5px;padding:2px 8px;background:#f6f8fa}
nav.barra .doms{display:flex;gap:9px;flex-wrap:wrap;align-items:center;border-left:1px solid #c8d0d8;border-right:1px solid #c8d0d8;padding:0 12px}
.buscador{position:relative;flex:1;min-width:220px}
.buscador input{width:100%;padding:7px 12px;border:1.5px solid #c8d0d8;border-radius:6px;font-size:14px}
#sres{position:absolute;top:100%;left:0;right:0;margin-top:4px;background:#fff;border:1.5px solid #c8d0d8;border-radius:6px;max-height:340px;overflow:auto;z-index:9;box-shadow:0 6px 18px rgba(22,33,46,.15)}
#sres a{display:block;padding:6px 12px;color:var(--ink);text-decoration:none;font-size:13px;border-bottom:1px solid #eef1f4;white-space:normal}
#sres a:hover{background:#f0f3f6}
#sres .sd{color:var(--ink-soft);font-size:11.5px;margin-left:6px}
#sres .vacio{display:block;padding:8px 12px}
.migas{font-size:13px;color:var(--ink-soft);margin:10px 0 2px}
.migas a{color:var(--consulta);text-decoration:none}
.migas a:hover{text-decoration:underline}
.migas .sep{margin:0 2px}
.frescura{font-size:12.5px;color:var(--ink-soft);border-bottom:1px solid #e2e7ec;padding-bottom:8px;margin:4px 0 12px}
.warn{border:1.5px solid var(--acceso);background:#fdf3ea;border-radius:8px;padding:12px 16px;margin:14px 0}
.warn-central{border:2px solid #a12b1e;background:#fdefec;border-radius:8px;padding:14px 18px;margin:16px 0;font-size:15px}
.ent{border:1px solid #d5dce2;border-left-width:5px;border-radius:7px;padding:12px 16px;margin:10px 0;background:#fbfcfd}
.ent.c-pub{border-left-color:var(--ingesta)}
.ent.c-int{border-left-color:var(--ops)}
.ent.c-deu{border-left-color:var(--acceso);background:#fdfaf7}
.badge{font-size:10.5px;font-weight:700;letter-spacing:.6px;padding:2px 8px;border-radius:10px;vertical-align:2px;white-space:nowrap}
.b-pub{background:var(--ingesta);color:#fff}
.b-int{background:var(--ops);color:#fff}
.b-deu{background:var(--acceso);color:#fff}
.desc{margin:6px 0}
.meta{font-size:13px;color:var(--ink-soft);margin:6px 0}
.conex{font-size:13.5px;background:#f0f3f6;border-radius:6px;padding:8px 12px}
table.cols,table.idx{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}
table.cols th,table.idx th{text-align:left;border-bottom:2px solid var(--ink);padding:4px 10px 4px 0;font-size:12px}
table.cols td,table.idx td{border-bottom:1px solid #e2e7ec;padding:4px 10px 4px 0;vertical-align:top}
.scrollx{overflow-x:auto}
details>summary{cursor:pointer;font-size:14px;padding:2px 0}
details[open]>summary{margin-bottom:6px}
footer{border-top:2px solid var(--ink);margin-top:30px;padding-top:12px;font-size:12.5px;color:var(--ink-soft)}
@media print{nav.barra{position:static}.buscador{display:none}nav.barra a.vista-paneles{display:none}}
`

/** CSS del marco de tres paneles. Va inline en `marco.html` (es su única página). */
const CSS_MARCO = `:root{--ink:#16212e;--ink-soft:#45525f;--acceso:#b3540e;--consulta:#1246a8;--ingesta:#1c7a45;--ops:#5b6878;--borde:#c8d0d8}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{overflow:hidden;background:#e9edf1;color:var(--ink);font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
.m-cols{display:flex;height:100vh}
.m-izq{flex:none;width:322px;min-width:236px;max-width:60vw;resize:horizontal;overflow:hidden;display:flex;flex-direction:column;background:#f6f8fa;border-right:1.5px solid var(--borde)}
.m-plegar{display:none}
.m-paneles{display:flex;flex-direction:column;flex:1;min-height:0}
.m-panel h2{font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:var(--ink-soft);margin:8px 10px 3px}
.m-doms{flex:none;max-height:44vh;overflow:auto;border-bottom:2px solid var(--ink);padding-bottom:8px}
.m-ents{flex:1;display:flex;flex-direction:column;min-height:0}
.m-entcab{flex:none;display:flex;gap:6px;align-items:center;padding:7px 10px 6px;border-bottom:1px solid var(--borde)}
.m-modos{display:flex;flex:none}
.m-modos button{font:inherit;font-size:11.5px;padding:3px 8px;border:1px solid var(--borde);background:#fff;color:var(--ink);cursor:pointer;white-space:nowrap}
.m-modos button:first-child{border-radius:5px 0 0 5px}
.m-modos button:last-child{border-radius:0 5px 5px 0;border-left:0}
.m-modos button[aria-pressed="true"]{background:var(--ink);color:#fff;border-color:var(--ink)}
#mfiltro{flex:1;min-width:60px;font:inherit;font-size:12px;padding:3px 8px;border:1px solid var(--borde);border-radius:5px}
.m-scroll{flex:1;overflow:auto;padding:4px 0 8px}
.m-lista{list-style:none;font-size:12px;line-height:1.5;white-space:nowrap}
.m-lista li{padding:0}
.m-lista a{display:block;padding:0 10px;color:var(--consulta);text-decoration:none}
.m-lista a:hover{background:#e4eaf1}
.m-lista a:focus-visible{outline:2px solid var(--consulta);outline-offset:-2px}
.m-lista a.activo{background:var(--ink);color:#fff}
.m-lista a.activo code{color:#fff}
.m-lista code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:11.5px;color:inherit}
.m-lista .dm{font-size:10.5px;color:var(--ink-soft);margin-left:5px}
.m-lista a.activo .dm{color:#cfd6de}
.m-vacio{padding:2px 10px;font-size:11.5px;color:var(--ink-soft);white-space:normal}
.k{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:6px;vertical-align:0}
.k-pub{background:var(--ingesta)}.k-int{background:var(--ops)}.k-deu{background:var(--acceso)}
.m-leyenda{flex:none;font-size:10.5px;color:var(--ink-soft);padding:4px 10px 6px;border-top:1px solid var(--borde)}
.m-marca{flex:none;font-family:Charter,Georgia,serif;font-weight:700;font-size:15px;padding:8px 10px 0}
.m-marca a{color:var(--ink);text-decoration:none}
#mcont{flex:1;border:0;height:100%;background:#fff;min-width:0}
noscript .m-aviso{display:block;padding:10px 14px;background:#fdf3ea;border-bottom:1.5px solid var(--acceso);font-size:13px}
@media (max-width:760px){
  .m-cols{flex-direction:column}
  .m-izq{width:auto;max-width:none;resize:none;border-right:0;border-bottom:2px solid var(--ink)}
  .m-plegar{display:block;font:inherit;font-size:13px;font-weight:700;text-align:left;padding:8px 12px;border:0;background:#e9edf1;cursor:pointer;width:100%}
  .m-paneles{max-height:42vh}
  .m-izq.plegado .m-doms{max-height:16vh}
  .m-izq.plegado .m-paneles{display:none}
}`

/** Etiqueta corta de un dominio, para la barra y los paneles. */
const corto = (d: DominioDatadoc): string => (d.label.length <= 18 ? d.label : `${d.label.slice(0, 17)}…`)

/**
 * La página «aún no generado» — la que el nodo sirve en `/datadoc/` mientras no haya build.
 *
 * Existe porque un 404 pelado en la única URL que el menú de la instancia enlaza le dice al usuario
 * «esto no existe» cuando lo cierto es «esto todavía no se generó», que son cosas distintas y llevan
 * a remediaciones distintas. Es autocontenida (sin CSS externo): no hay build del que leerlo.
 */
export function paginaSinBuild(brandTitle?: string): string {
  const marca = esc(brandTitle ? `${brandTitle} · Datadoc` : 'Datadoc')
  return `<!DOCTYPE html>
<html lang="es-CL">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${marca}</title>
<style>
body{background:#e9edf1;color:#16212e;font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,Arial,sans-serif;padding:40px 24px;font-size:15px;line-height:1.55}
.wrap{max-width:720px;margin:0 auto;background:#fff;border:1px solid #c8d0d8;border-radius:10px;padding:24px 36px}
h1{font-family:Charter,Georgia,serif;font-size:26px;margin:0 0 10px}
code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f0f3f6;padding:1px 4px;border-radius:3px}
a{color:#1246a8}
</style>
</head>
<body>
<div class="wrap">
<h1>Datadoc aún no generado</h1>
<p>El catálogo del esquema de datos existe como capacidad de este nodo, pero todavía no se ha generado ninguna vez — así que no hay nada que mostrar. <b>No es un error:</b> es el estado inicial.</p>
<p>Para generarlo: <b>Administración › Datadoc › Generar</b> (<a href="/admin/datadoc">/admin/datadoc</a>). La generación consulta el catálogo vivo de cada conexión en modo estrictamente de solo lectura y deja el sitio publicado en <code>/datadoc/</code>.</p>
</div>
</body>
</html>
`
}

/** Cáscara común de página: barra + migas + línea de frescura + cuerpo + pie + buscador. */
function pagina(args: {
  root: string
  titulo: string
  marca: string
  migas: { t: string; href?: string }[] | null
  cuerpo: string
  conSello?: boolean
  self: string
  modelo: ModeloDatadoc
  tz?: string
}): string {
  const { root, titulo, marca, migas, cuerpo, self, modelo, tz } = args
  const noMedidas = modelo.conexiones.filter((c) => !c.medidaHoy)
  const medidas = modelo.conexiones.length - noMedidas.length
  const navDoms = modelo.dominios.map((d) => `<a href="${root}${domFile(d.id)}">${esc(corto(d))}</a>`).join(' ')
  const migasHTML = migas
    ? `<div class="migas">${migas
        .map((m) => (m.href != null ? `<a href="${root}${m.href}">${esc(m.t)}</a>` : `<span>${esc(m.t)}</span>`))
        .join(' <span class="sep">›</span> ')}</div>`
    : ''
  const frescura = args.conSello
    ? ''
    : `<p class="frescura">Generado el <b>${esc(fecha(modelo.generadoEn, tz))}</b> contra el catálogo vivo · <a href="${root}index.html#sello">sello de frescura completo</a>${
        noMedidas.length ? ` · <b class="rojo">⚠ ${noMedidas.length} conexión(es) NO medidas en esta corrida</b>` : ''
      }</p>`
  return `<!DOCTYPE html>
<html lang="es-CL">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<!-- Datadoc multi-página (CAP-197). GENERADO por el nodo Vergis el ${esc(modelo.generadoEn)} —
     NO editar a mano: se pudre. Se regenera desde Administración › Datadoc. -->
<link rel="stylesheet" href="${root}datadoc.css">
</head>
<body>
<div class="wrap">
<nav class="barra">
  <a class="brand" href="${root}index.html">${esc(marca)}</a>
  <a class="vista-paneles" href="${root}marco.html#${esc(self)}" target="_top" title="Abrir esta misma página en la vista con paneles">⊞ Paneles</a>
  <a href="${root}index.html">Índice</a>
  <span class="doms"><span class="src">Dominios:</span> ${navDoms}</span>
  <a href="${root}todas-las-entidades.html">Todas las entidades</a>
  <a href="${root}seguridad.html">Seguridad</a>
  <span class="buscador"><input id="buscar" type="search" placeholder="Buscar entidad o columna…" autocomplete="off"><div id="sres" hidden></div></span>
</nav>
${migasHTML}
${frescura}
${cuerpo}

<footer>
  <p><b>Este catálogo se genera, no se escribe.</b> Los cambios se hacen en las fuentes —las specs de los PI, el registro de escritores, el registro de fuentes, el diccionario semántico, o el catálogo mismo— y se regenera desde <b>Administración › Datadoc</b>.</p>
  <p>Generado por el nodo el ${esc(fecha(modelo.generadoEn, tz))}${tz ? ` (${esc(tz)})` : ''} · fuentes: catálogo vivo (${medidas}/${modelo.conexiones.length} conexiones medidas) + specs de PI + registro de escritores + registro de fuentes + diccionario semántico · <i>Generado con Wingworking</i></p>
</footer>
</div>
<script src="${root}search-index.js"></script>
<script>
(function () {
  var inp = document.getElementById('buscar'), out = document.getElementById('sres')
  if (!inp || !out || typeof DATADOC_INDEX === 'undefined') return
  var ROOT = ${JSON.stringify(root)}
  inp.addEventListener('input', function () {
    var q = inp.value.trim().toLowerCase()
    if (!q) { out.hidden = true; out.innerHTML = ''; return }
    var directos = [], porColumna = []
    for (var i = 0; i < DATADOC_INDEX.length; i++) {
      var e = DATADOC_INDEX[i]
      if (e.n.toLowerCase().indexOf(q) >= 0) directos.push(e)
      else if (e.s.indexOf(q) >= 0) porColumna.push(e)
    }
    var hits = directos.concat(porColumna).slice(0, 25)
    out.innerHTML = hits.length
      ? hits.map(function (e) { return '<a href="' + ROOT + e.u + '"><code>' + e.n + '</code><span class="sd">' + e.dn + ' · ' + e.cl + '</span></a>' }).join('')
      : '<span class="sd vacio">sin resultados</span>'
    out.hidden = false
  })
  document.addEventListener('click', function (ev) {
    if (ev.target !== inp && !out.contains(ev.target)) out.hidden = true
  })
})()
</script>
</body>
</html>
`
}

/** La marca de una conexión no medida hoy — se repite en portada, dominio y entidad, a propósito. */
function marcaNoMedida(c: ConexionDatadoc, tz?: string): string {
  if (c.medidaHoy) return ''
  const cuando = c.medidoEn ? `se muestra la medición del <b>${esc(fecha(c.medidoEn, tz))}</b>` : '<b>nunca se ha medido</b>, así que no hay entidades que mostrar'
  return `<div class="warn">⚠ <b>Conexión <code>${esc(c.ref)}</code> NO medida en esta corrida</b> — ${cuando}. Motivo: <code>${esc(c.error ?? 'no consultada en esta corrida')}</code>.</div>`
}

export function renderDatadoc(entrada: EntradaRender): Archivo[] {
  const { modelo } = entrada
  const tz = entrada.timezone
  const marca = entrada.brandTitle ? `${entrada.brandTitle} · Datadoc` : 'Datadoc'
  const archivos: Archivo[] = []
  const conexionDe = new Map(modelo.conexiones.map((c) => [c.ref, c]))
  const dominioPorId = new Map(modelo.dominios.map((d) => [d.id, d]))
  const existe = new Set(modelo.entidades.map((e) => `${e.conexion}\u0000${e.ref}`))
  const linkEnt = (root: string, conexion: string, ref: string): string =>
    existe.has(`${conexion}\u0000${ref}`)
      ? `<a href="${root}${entFile(conexion, ref)}"><code>${esc(ref)}</code></a>`
      : `<code>${esc(ref)}</code>`

  const noMedidas = modelo.conexiones.filter((c) => !c.medidaHoy)
  const medidas = modelo.conexiones.length - noMedidas.length

  // ── search-index.js: VARIABLE declarada, no JSON con fetch (file:// bloquea fetch por CORS) ────
  archivos.push({
    rel: 'search-index.js',
    contenido:
      `// GENERADO por el nodo Vergis (CAP-197) el ${modelo.generadoEn} — índice del buscador del Datadoc.\n` +
      `// Es una variable declarada y no un JSON que se hace fetch: file:// bloquea fetch() por CORS.\n` +
      `var DATADOC_INDEX = ${JSON.stringify(
        modelo.entidades.map((e) => ({
          n: e.ref,
          dn: dominioPorId.get(conexionDe.get(e.conexion)?.dominioId ?? '')?.label ?? e.conexion,
          cl: CLASE_NOMBRE[e.clase],
          u: entFile(e.conexion, e.ref),
          s: [e.ref, ...e.columnas.map((c) => c.nombre)].join(' ').toLowerCase(),
        })),
      )}\n`,
  })
  archivos.push({ rel: 'datadoc.css', contenido: CSS })

  // ── Sello de frescura ──────────────────────────────────────────────────────────────────────────
  const selloFilas = modelo.conexiones
    .map((c) => {
      const dom = dominioPorId.get(c.dominioId)
      const rotulo = dom && !dom.tecnico ? `${dom.label} <span class="src">(${esc(c.ref)})</span>` : `<code>${esc(c.ref)}</code>`
      if (!c.medidaHoy)
        return `<tr class="bad"><td>${rotulo}</td><td>✗ NO medida</td><td colspan="2"><code>${esc(c.error ?? 'no consultada')}</code></td></tr>`
      const base = c.entidades.filter((e) => !e.esVista).length
      const vistas = c.entidades.filter((e) => e.esVista).length
      return `<tr><td>${rotulo}</td><td>✓ <code>${esc(c.database ?? '—')}</code></td><td>${pl(base, 'tabla')} · ${pl(vistas, 'vista')}</td><td>${nf(c.ms ?? 0)} ms${
        c.errores.length ? ` · ⚠ ${c.errores.length} sub-error(es)` : ''
      }</td></tr>`
    })
    .join('\n')

  const selloHTML = `<div class="sello${noMedidas.length ? ' parcial' : ''}" id="sello">
  <span class="dot"></span><b>Sello de frescura</b><br>
  Generado el <b>${esc(fecha(modelo.generadoEn, tz))}</b> contra el catálogo vivo.
  Conexiones medidas: <b>${medidas} de ${modelo.conexiones.length}</b>${
    noMedidas.length ? ` — <b class="rojo">${noMedidas.length} NO respondieron</b>: lo que este catálogo dice de ellas NO está verificado hoy` : ''
  }.
  <table>${selloFilas}</table>
</div>`

  const avisoRancio = modelo.rancio
    ? `<div class="warn-central"><b>Catálogo marcado rancio.</b> El gobierno de la plataforma cambió después de la última medición (${esc(
        modelo.rancio.razon,
      )}, ${esc(fecha(modelo.rancio.desde, tz))}), así que la clasificación de seguridad que se muestra puede haber quedado atrás. <b>Los conteos de filas se retiraron</b> hasta la próxima generación: un número calculado bajo el gobierno anterior no se publica bajo el nuevo.</div>`
    : ''

  const avisosHTML = modelo.avisos.length
    ? `<details class="src"><summary>${modelo.avisos.length} aviso(s) de esta corrida — lo que se omitió o no se pudo cruzar</summary><ul>${modelo.avisos
        .map((a) => `<li>${esc(a)}</li>`)
        .join('')}</ul></details>`
    : ''

  // ── Portada ────────────────────────────────────────────────────────────────────────────────────
  const idxFilas = modelo.conexiones
    .map((c) => {
      const dom = dominioPorId.get(c.dominioId)
      const pub = c.medidaHoy || c.entidades.length ? c.entidades.filter((e) => e.esVista).length : '—'
      const tot = c.medidaHoy || c.entidades.length ? c.entidades.length : '—'
      const pis = c.pis.map((p) => esc(p.code)).join(', ')
      return `<tr><td><a href="${domFile(c.dominioId)}">${esc(dom?.label ?? c.ref)}</a>${
        dom?.tecnico ? ' <span class="src">(conexión sin dominio declarado)</span>' : ''
      }</td><td><code>${esc(c.ref)}</code></td><td><code>${c.database ? esc(c.database) : '—'}</code></td><td>${
        c.medidaHoy ? '' : '<b class="rojo">NO medida</b>'
      }</td><td>${pis || '—'}</td><td>${pub}</td><td>${tot}</td></tr>`
    })
    .join('\n')

  const deuda = modelo.entidades.filter((e) => e.clase === 'deuda').length

  const cuerpoIndex = `
<header class="chrome">
  <div>
    <h1>${esc(marca)}</h1>
    <p class="sub">Catálogo del esquema de datos de la plataforma, para quien quiere <b>consumir el dato</b> y necesita saber qué hay, qué significa y de dónde viene, sin preguntarle a nadie. <b>Este catálogo se genera, no se escribe</b>: si dudas de su vigencia, regenéralo desde Administración.</p>
    ${modelo.portada ? `<p class="sub">${modelo.portada}</p>` : ''}
  </div>
  ${selloHTML}
</header>
${avisoRancio}

<section>
<h2 id="que-es">¿Qué es esto y cómo se generó?</h2>
<p>El catálogo sale de sus fuentes verdaderas cada vez que el nodo lo genera. Cinco insumos, cada uno con lo que los otros no tienen:</p>
<ul>
  <li><b>El catálogo vivo</b> de cada conexión (<code>INFORMATION_SCHEMA</code>, <code>sys.security_policies</code>, <code>sys.sql_modules</code>, linaje de <code>sys</code>) — qué <b>existe</b> y su forma real, en modo estrictamente de solo lectura.</li>
  <li><b>Las specs de los Productos de Información</b> — qué está <b>en uso</b> y quién lo lee. Sale de la misma extracción que usa el gate de gobernanza del nodo, no de una lectura aparte.</li>
  <li><b>El registro de escritores</b> — <b>quién escribe</b> cada tabla y con qué disparo.</li>
  <li><b>El registro de fuentes</b> — de dónde proviene y <b>cada cuánto</b> cambia el dato.</li>
  <li><b>El diccionario semántico</b> — qué significa cada tabla y cada columna. Es la única parte curada a mano: el catálogo SQL no trae semántica.</li>
</ul>
<p class="src">Lo que no está declarado se muestra como hueco —«escritor no declarado», «sin descripción»—, nunca como un valor inventado. Un hueco visible es el mapa de lo que falta; una atribución adivinada es un contrato falso.</p>
${avisosHTML}
</section>

<section>
<h2 id="como-leer">¿Cómo leo este catálogo?</h2>
<p>El sitio se navega como un Javadoc: este índice lista las <a href="#indice">conexiones y sus dominios</a>; la página de cada <b>dominio</b> trae sus entidades clasificadas; la página de cada <b>entidad</b> trae sus columnas con tipo y semántica, quién la escribe y qué PI la consumen — y su URL es estable, así que se puede enlazar <i>una</i> entidad puntual. <a href="todas-las-entidades.html">Todas las entidades</a> es el índice alfabético global, y el buscador de la barra encuentra entidades y columnas desde cualquier página.</p>
<p><b>La forma más cómoda de explorar es la <a href="marco.html" target="_top">vista con paneles</a></b> (enlace «⊞ Paneles», en la barra de toda página): dos exploradores a la izquierda —dominios arriba, entidades abajo, con filtro rápido y modo «todas»— y el contenido a la derecha, sin recargar los paneles al navegar.</p>
<p>Cada entidad está clasificada en una de tres, y esa clasificación es lo primero que hay que mirar:</p>
<ul>
  <li>${badge('publicado')} — las <b>vistas</b>. Existen para ser el contrato estable frente a un consumidor. <b>Es lo que debes usar.</b></li>
  <li>${badge('interno')} — tablas base, dimensiones y plomería: tienen lector, escritor declarado o política de gobierno. Se listan para entender el modelo, <b>no para conectarse a ellas</b>: su esquema puede cambiar sin aviso a consumidores externos.</li>
  <li>${badge('deuda')} — lo que existe y nadie lee: ningún PI la lee, ningún escritor la declara, ninguna política la gobierna. Mostrarlo es un servicio: es el mapa de lo que hay que limpiar.</li>
</ul>
</section>

<section>
<h2 id="conectar">¿Cómo me conecto?</h2>
<p>Cada conexión expone un <b>SQL endpoint</b>; su host y su base de datos aparecen en la página del dominio correspondiente. La autenticación es con la cuenta corporativa de cada persona — no hay usuarios de base de datos ni claves compartidas.</p>
<p><b>Antes de conectar, lee <a href="seguridad.html">Acceso y seguridad</a>:</b> lo que se ve hoy y lo que se verá cuando la autorización por fila se cierre no son lo mismo, y conviene decidir con eso a la vista.</p>
</section>

<section>
<h2 id="indice">Índice de conexiones</h2>
<div class="scrollx">
<table class="idx"><thead><tr><th>Dominio</th><th>Conexión</th><th>Base de datos</th><th>Estado</th><th>PIs servidos</th><th>Vistas</th><th>Objetos</th></tr></thead><tbody>
${idxFilas}
</tbody></table>
</div>
${
  modelo.pis.length
    ? `<p class="src">Productos de Información servidos por este nodo: ${modelo.pis.map((p) => `<b>${esc(p.code)}</b> «${esc(p.nombre)}»`).join(' · ')}.</p>`
    : '<p class="src">Este nodo no sirve ningún Producto de Información todavía, así que ninguna entidad tiene lector registrado.</p>'
}
</section>

<section>
<h2 id="deuda">¿Qué existe y nadie lee? — resumen de deuda</h2>
<p>Medido en esta corrida sobre las conexiones que respondieron: <b>${nf(deuda)} entidad(es) sin consumidor</b> — ningún PI las lee, ningún escritor las declara, ninguna política las gobierna. El detalle vive en la página de cada dominio, sección ${badge('deuda')}.</p>
</section>`

  // ── Seguridad ──────────────────────────────────────────────────────────────────────────────────
  const s = modelo.seguridad
  const medicion = medidas
    ? `Medido en esta corrida: <b>${pl(s.politicas, 'política de seguridad de fila')}</b> en las conexiones que respondieron — <b>${nf(
        s.abiertas,
      )} con predicado abierto</b> (allow-all explícito: dejan pasar todo)${
        s.filtradas ? ` y <b>${nf(s.filtradas)} con filtro real</b> (${s.conFiltro.map((x) => `<code>${esc(x)}</code>`).join(' · ')})` : ''
      }${s.indeterminadas ? ` · <b>${nf(s.indeterminadas)} indeterminadas</b> (su función de predicado no se localizó)` : ''}.`
    : 'Ninguna conexión respondió en esta corrida: los números vivos de esta sección no se midieron.'

  const cuerpoSeguridad = `
<h1>¿Quién ve qué? — acceso y seguridad, tal como está hoy</h1>
<p class="sub">Lo que un consumidor tiene que leer <b>antes de conectar nada</b>.</p>
<p><b>Autenticación.</b> Nadie llega a la plataforma ni a los SQL endpoints sin su cuenta corporativa.</p>
<p><b>Autorización a nivel de fila (RLS).</b> Cada tabla gobernada tiene su política aplicada en la fuente. Lo que cada política <i>hace</i> —dejar pasar todo, o filtrar por consumidor— está medido y se declara por entidad, en su campo <b>Gobierno (RLS)</b>.</p>
<p class="src">${medicion}</p>
${modelo.seguridadTexto ? `<p>${modelo.seguridadTexto}</p>` : ''}
<h2>¿Por qué algunas entidades no muestran su número de filas?</h2>
<p>Un <code>COUNT(*)</code> parece metadato, pero sobre una tabla gobernada <b>es</b> información que la autorización por fila protege: cuántos registros hay del área que no me corresponde. Por eso este catálogo <b>no pide el conteo</b> de una tabla cuyo predicado filtra, ni de una cuyo gobierno no pudo determinar — y lo dice con esas palabras en vez de mostrar un guion sin explicación.</p>
<p class="src">La protección es <b>no preguntar</b>, y no «confiar en que la respuesta venga filtrada»: si la identidad con que el nodo mide estuviera exenta del predicado, la respuesta llegaría completa. Que el nodo mida sin claims es defensa en profundidad, no la regla.${
    modelo.conteos === 'off' ? ' <b>En esta plataforma los conteos están apagados por completo</b>: no se pide ninguno, ni siquiera sobre tablas abiertas.' : ''
  }</p>
<div class="warn-central"><b>El aviso central para ti, consumidor:</b> un reporte construido directo sobre una tabla base puede vaciarse o romperse el día que su gobierno se cierre o su esquema cambie. Consume las <b>vistas</b> (sección ${badge(
    'publicado',
  )} de cada dominio) y asume que el acceso que tienes hoy es el de esta etapa, no una promesa.</div>`

  // ── Todas las entidades ────────────────────────────────────────────────────────────────────────
  const todasFilas = modelo.entidades
    .map((e) => {
      const c = conexionDe.get(e.conexion)
      const dom = dominioPorId.get(c?.dominioId ?? '')
      return `<tr><td><a href="${entFile(e.conexion, e.ref)}"><code>${esc(e.ref)}</code></a></td><td><a href="${domFile(
        c?.dominioId ?? e.conexion,
      )}">${esc(dom?.label ?? e.conexion)}</a></td><td>${badge(e.clase)}</td><td>${esc(e.filas.texto)}</td><td>${
        e.lectores.length ? e.lectores.map((l) => esc(l.code)).join(', ') : '<i>ningún PI</i>'
      }</td></tr>`
    })
    .join('\n')

  const cuerpoTodas = `
<h1>Todas las entidades <span class="src">(${nf(modelo.entidades.length)})</span></h1>
<p class="sub">Índice alfabético global${
    noMedidas.length ? ` — <b class="rojo">no refleja el estado de hoy de ${noMedidas.map((c) => `<code>${esc(c.ref)}</code>`).join(', ')} (NO medidas en esta corrida)</b>` : ''
  }. El buscador de la barra encuentra también por nombre de columna.</p>
<div class="scrollx">
<table class="idx"><thead><tr><th>Entidad</th><th>Dominio</th><th>Clasificación</th><th>Filas</th><th>La consumen</th></tr></thead><tbody>
${todasFilas}
</tbody></table>
</div>`

  // ── Páginas ────────────────────────────────────────────────────────────────────────────────────
  const conSello = (cuerpo: string): Archivo => ({
    rel: 'index.html',
    contenido: pagina({ root: '', titulo: marca, marca, migas: null, cuerpo, conSello: true, self: 'index.html', modelo, tz }),
  })
  archivos.push(conSello(cuerpoIndex))
  archivos.push({
    rel: 'seguridad.html',
    contenido: pagina({
      root: '',
      titulo: `Acceso y seguridad — ${marca}`,
      marca,
      migas: [{ t: 'Datadoc', href: 'index.html' }, { t: 'Seguridad' }],
      cuerpo: cuerpoSeguridad,
      self: 'seguridad.html',
      modelo,
      tz,
    }),
  })
  archivos.push({
    rel: 'todas-las-entidades.html',
    contenido: pagina({
      root: '',
      titulo: `Todas las entidades — ${marca}`,
      marca,
      migas: [{ t: 'Datadoc', href: 'index.html' }, { t: 'Todas las entidades' }],
      cuerpo: cuerpoTodas,
      self: 'todas-las-entidades.html',
      modelo,
      tz,
    }),
  })

  // Una página por DOMINIO (que puede agrupar varias conexiones).
  for (const d of modelo.dominios) {
    const root = '../'
    const suyas = modelo.conexiones.filter((c) => d.conexiones.includes(c.ref))
    const pis = [...new Map(suyas.flatMap((c) => c.pis).map((p) => [p.code, p])).values()].sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true }),
    )
    const bloques = suyas
      .map((c) => {
        const cab = `<p class="conex"><b>Conexión <code>${esc(c.ref)}</code>:</b> base de datos <code>${esc(
          c.database ?? '—',
        )}</code> · SQL endpoint <code class="mono">${esc(c.server ?? '—')}</code>${
          c.esquemas.length ? ` · esquemas catalogados: ${c.esquemas.map((x) => `<code>${esc(x)}</code>`).join(', ')}` : ''
        }</p>`
        const intro = c.intro ? `<p class="desc">${c.intro}</p>` : ''
        const joins = c.joins.length ? `<p><b>¿Cómo se consume (joins declarados)?</b></p><ul>${c.joins.map((j) => `<li>${j}</li>`).join('')}</ul>` : ''
        const errs = c.errores.length
          ? `<details class="src"><summary>⚠ ${c.errores.length} sub-consulta(s) fallaron en esta conexión (el resto del catálogo es válido)</summary><ul>${c.errores
              .map((er) => `<li><code>${esc(er)}</code></li>`)
              .join('')}</ul></details>`
          : ''
        const grupo = (clase: ClaseEntidad, titulo: string, nota?: string): string => {
          const g = c.entidades.filter((e) => e.clase === clase)
          if (!g.length) return ''
          return (
            `<h2>${titulo} <span class="src">(${nf(g.length)})</span></h2>${nota ?? ''}\n` +
            g
              .map(
                (e) => `<article class="ent c-${CLASE_CSS[clase]}">
  <h3><a href="${root}${entFile(e.conexion, e.ref)}"><code>${esc(e.ref)}</code></a> ${badge(e.clase)}</h3>
  ${e.descripcion ? `<p class="desc">${e.descripcion}</p>` : ''}
  <p class="meta"><b>Filas:</b> ${esc(e.filas.texto)} · <b>La consumen:</b> ${
    e.lectores.length ? e.lectores.map((l) => esc(l.code)).join(', ') : '<i>ningún PI</i>'
  }${e.motivoDeuda ? `<br><b>Por qué es deuda:</b> ${esc(e.motivoDeuda)}` : ''}</p>
</article>`,
              )
              .join('\n')
          )
        }
        return `${marcaNoMedida(c, tz)}
${intro}
${cab}
${joins}
${errs}
${grupo('publicado', '¿Qué está publicado? — vistas', '<p class="src">Esto es lo que un consumidor debe usar: el contrato estable. Las tablas base pueden cambiar; estas vistas existen para no romper el reporte.</p>')}
${grupo('interno', '¿Qué es interno? — tablas base y dimensiones', '<p class="src"><b>No te acoples a esto.</b> Se listan para entender el modelo; su esquema puede cambiar sin aviso a consumidores externos.</p>')}
${grupo('deuda', '¿Qué existe y nadie lee? — deuda')}`
      })
      .join('\n')

    const cuerpo = `<h1>${esc(d.label)}${d.tecnico ? ' <span class="src">(conexión sin dominio declarado)</span>' : ''}</h1>
${pis.length ? `<p><b>Productos de Información servidos desde aquí:</b> ${pis.map((p) => `${esc(p.code)} «${esc(p.nombre)}»`).join(' · ')}</p>` : ''}
${bloques}`
    archivos.push({
      rel: domFile(d.id),
      contenido: pagina({
        root,
        titulo: `${d.label} — ${marca}`,
        marca,
        migas: [{ t: 'Datadoc', href: 'index.html' }, { t: d.label }],
        cuerpo,
        self: domFile(d.id),
        modelo,
        tz,
      }),
    })
  }

  // Una página por ENTIDAD — la URL estable.
  for (const e of modelo.entidades) {
    const root = '../'
    const c = conexionDe.get(e.conexion)
    const dom = dominioPorId.get(c?.dominioId ?? '')
    const meta: string[] = []
    meta.push(`<b>Filas:</b> ${esc(e.filas.texto)}`)
    meta.push(
      `<b>La consumen:</b> ${
        e.lectores.length
          ? e.lectores.map((l) => esc(l.code) + (l.via ? ` <span class="src">(vía ${linkEnt(root, e.conexion, l.via)})</span>` : '')).join(', ')
          : '<i>ningún PI</i>'
      }`,
    )
    if (!e.esVista) {
      meta.push(`<b>La escribe:</b> ${e.escritor}`)
      if (e.vistas.length) meta.push(`<b>Su(s) vista(s):</b> ${e.vistas.map((v) => linkEnt(root, e.conexion, v)).join(', ')}`)
    }
    if (e.oferta) meta.push(`<b>Proviene de:</b> ${e.oferta}`)
    meta.push(`<b>Gobierno (RLS):</b> ${e.gobierno}`)
    if (e.motivoDeuda) meta.push(`<b>Por qué es deuda:</b> ${esc(e.motivoDeuda)}`)
    if (e.claseForzada) meta.push(`<b>Clasificación:</b> declarada por la instancia en el diccionario semántico (no derivada de lo medido).`)

    const columnas = e.columnas.length
      ? `<div class="scrollx"><table class="cols"><thead><tr><th>Columna</th><th>Tipo</th><th>¿Nula?</th><th>¿Qué significa?</th></tr></thead><tbody>
${e.columnas
  .map((col) => `<tr><td><code>${esc(col.nombre)}</code></td><td class="mono">${esc(col.tipo)}</td><td>${col.nulable ? 'sí' : 'no'}</td><td>${col.significado}</td></tr>`)
  .join('\n')}
</tbody></table></div>`
      : '<p class="src"><i>Columnas no disponibles (el catálogo de esta conexión no las devolvió).</i></p>'

    const cuerpo = `<h1><code>${esc(e.ref)}</code> ${badge(e.clase)}</h1>
<p class="src">${e.esVista ? 'Vista' : 'Tabla base'} de <a href="${root}${domFile(c?.dominioId ?? e.conexion)}">${esc(
      dom?.label ?? e.conexion,
    )}</a> · conexión <code>${esc(e.conexion)}</code> · base de datos <code>${esc(c?.database ?? '—')}</code> · SQL endpoint <code class="mono">${esc(
      c?.server ?? '—',
    )}</code></p>
${c && !c.medidaHoy ? marcaNoMedida(c, tz) : ''}
${e.descripcion ? `<p class="desc">${e.descripcion}</p>` : '<p class="src"><i>Sin descripción: esta entidad todavía no está documentada en el diccionario semántico.</i></p>'}
${e.base ? `<p class="src">Base de esta vista (linaje de <code>sys</code>): ${linkEnt(root, e.conexion, e.base)}.</p>` : ''}
<p class="meta">${meta.join('<br>')}</p>
<h2>Columnas <span class="src">(${nf(e.columnas.length)})</span></h2>
${columnas}
<p><a href="${root}${domFile(c?.dominioId ?? e.conexion)}">← Volver a ${esc(dom?.label ?? e.conexion)}</a></p>`

    archivos.push({
      rel: entFile(e.conexion, e.ref),
      contenido: pagina({
        root,
        titulo: `${e.ref} (${dom?.label ?? e.conexion}) — ${marca}`,
        marca,
        migas: [
          { t: 'Datadoc', href: 'index.html' },
          { t: dom?.label ?? e.conexion, href: domFile(c?.dominioId ?? e.conexion) },
          { t: e.ref },
        ],
        cuerpo,
        self: entFile(e.conexion, e.ref),
        modelo,
        tz,
      }),
    })
  }

  archivos.push({ rel: 'marco.html', contenido: renderMarco(modelo, marca) })
  return archivos
}

/** El marco de tres paneles: el frameset del Javadoc clásico, hecho con un iframe. */
function renderMarco(modelo: ModeloDatadoc, marca: string): string {
  const K: Record<ClaseEntidad, string> = CLASE_CSS
  const dominioPorId = new Map(modelo.dominios.map((d) => [d.id, d]))
  const conexionDe = new Map(modelo.conexiones.map((c) => [c.ref, c]))
  const targets: Record<string, string | null> = {
    'index.html': null,
    'todas-las-entidades.html': null,
    'seguridad.html': null,
  }
  for (const d of modelo.dominios) targets[domFile(d.id)] = d.id
  for (const e of modelo.entidades) targets[entFile(e.conexion, e.ref)] = conexionDe.get(e.conexion)?.dominioId ?? e.conexion
  const cortos = Object.fromEntries(modelo.dominios.map((d) => [d.id, corto(d)]))

  const item = (e: EntidadDatadoc, conDominio: boolean): string => {
    const dom = dominioPorId.get(conexionDe.get(e.conexion)?.dominioId ?? '')
    return `<li data-n="${esc(e.ref.toLowerCase())}" data-u="${entFile(e.conexion, e.ref)}"><a href="#${entFile(
      e.conexion,
      e.ref,
    )}"><span class="k k-${K[e.clase]}" title="${CLASE_NOMBRE[e.clase]}"></span><code>${esc(e.ref)}</code>${
      conDominio ? ` <span class="dm">${esc(dom ? corto(dom) : e.conexion)}</span>` : ''
    }</a></li>`
  }

  const ulsDom = modelo.dominios
    .map((d) => {
      const suyas = modelo.entidades.filter((e) => d.conexiones.includes(e.conexion))
      const items = suyas.length
        ? suyas.map((e) => item(e, d.conexiones.length > 1)).join('\n')
        : '<li class="m-vacio"><i>sin catálogo: ninguna de sus conexiones se midió</i></li>'
      return `<ul class="m-lista" id="ul-dom-${esc(fileSafe(d.id))}" hidden aria-label="Entidades de ${esc(d.label)}">\n${items}\n</ul>`
    })
    .join('\n')
  const ulTodas = `<ul class="m-lista" id="ul-todas" hidden aria-label="Todas las entidades">\n${modelo.entidades.map((e) => item(e, true)).join('\n')}\n</ul>`
  const liDoms = modelo.dominios.map((d) => `<li><a href="#${domFile(d.id)}" data-dom="${esc(fileSafe(d.id))}">${esc(d.label)}</a></li>`).join('\n')
  const primero = modelo.dominios[0]?.id ?? ''

  return `<!DOCTYPE html>
<html lang="es-CL">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(marca)} (vista con paneles)</title>
<!-- Marco de tres paneles del Datadoc (CAP-197). GENERADO por el nodo Vergis el ${esc(modelo.generadoEn)} — NO editar a mano.
     Enlace profundo: marco.html#entidades/<conexion>--<schema>.<tabla>.html (el padre lee SU PROPIO hash).
     Servido por http(s) el padre además LEE LA URL del iframe al cargar y sincroniza los paneles; bajo
     file:// el iframe es origen opaco y esa lectura lanza: solo se le cambia la URL. Nunca se le lee el DOM. -->
<style>
${CSS_MARCO}
</style>
</head>
<body>
<noscript><span class="m-aviso">La vista con paneles necesita JavaScript. Sin él, usa la <a href="index.html">portada</a> — el sitio completo funciona igual página a página.</span></noscript>
<div class="m-cols">
  <div class="m-izq" id="mizq">
    <button class="m-plegar" id="mplegar" aria-expanded="true" aria-controls="mpaneles">Exploradores ▾</button>
    <div class="m-paneles" id="mpaneles">
      <p class="m-marca"><a href="#index.html">${esc(marca)}</a></p>
      <section class="m-panel m-doms" aria-label="Explorador de dominios y páginas">
        <h2>Páginas</h2>
        <ul class="m-lista" id="mpags">
          <li><a href="#index.html">Portada e índice</a></li>
          <li><a href="#todas-las-entidades.html">Todas las entidades</a></li>
          <li><a href="#seguridad.html">Acceso y seguridad</a></li>
        </ul>
        <h2>Dominios</h2>
        <ul class="m-lista" id="mdoms">
${liDoms}
        </ul>
      </section>
      <section class="m-panel m-ents" aria-label="Explorador de entidades">
        <div class="m-entcab">
          <div class="m-modos" role="group" aria-label="Alcance del explorador de entidades">
            <button type="button" id="mbtn-dom" aria-pressed="true">Dominio</button>
            <button type="button" id="mbtn-todas" aria-pressed="false">Todas</button>
          </div>
          <input id="mfiltro" type="search" placeholder="Filtrar (nombre o columna)…" aria-label="Filtrar la lista de entidades" autocomplete="off">
        </div>
        <div class="m-scroll" id="mentscroll">
${ulsDom}
${ulTodas}
        </div>
        <p class="m-leyenda"><span class="k k-pub"></span>publicado · <span class="k k-int"></span>interno · <span class="k k-deu"></span>deuda/sin consumidor</p>
      </section>
    </div>
  </div>
  <iframe id="mcont" name="contenido" title="Contenido del Datadoc" src="index.html"></iframe>
</div>
<script src="search-index.js"></script>
<script>
(function () {
  var TARGETS = ${JSON.stringify(targets)}
  var DOMSHORT = ${JSON.stringify(cortos)}
  var SAFE = ${JSON.stringify(Object.fromEntries(modelo.dominios.map((d) => [d.id, fileSafe(d.id)])))}
  var frame = document.getElementById('mcont')
  var scroller = document.getElementById('mentscroll')
  var btnDom = document.getElementById('mbtn-dom'), btnTodas = document.getElementById('mbtn-todas')
  var filtro = document.getElementById('mfiltro')
  var modo = 'dom'
  var domActual = ${JSON.stringify(primero)}
  var actual = 'index.html'

  var porUrl = {}
  if (typeof DATADOC_INDEX !== 'undefined') for (var i = 0; i < DATADOC_INDEX.length; i++) porUrl[DATADOC_INDEX[i].u] = DATADOC_INDEX[i].s

  function objetivo() {
    var h = location.hash.slice(1)
    try { h = decodeURIComponent(h) } catch (e) {}
    return Object.prototype.hasOwnProperty.call(TARGETS, h) ? h : 'index.html'
  }
  function listaVisible() {
    return document.getElementById(modo === 'todas' ? 'ul-todas' : 'ul-dom-' + (SAFE[domActual] || domActual))
  }
  function mostrarLista() {
    var uls = scroller.getElementsByTagName('ul'), vis = listaVisible()
    for (var i = 0; i < uls.length; i++) uls[i].hidden = uls[i] !== vis
    btnDom.setAttribute('aria-pressed', modo === 'dom' ? 'true' : 'false')
    btnTodas.setAttribute('aria-pressed', modo === 'todas' ? 'true' : 'false')
    btnDom.textContent = 'Dominio · ' + (DOMSHORT[domActual] || domActual)
  }
  function resaltar(url, desplazar) {
    var viejos = document.querySelectorAll('.m-lista a.activo')
    for (var i = 0; i < viejos.length; i++) viejos[i].classList.remove('activo')
    var sel = document.querySelectorAll('.m-lista a[href="#' + url + '"]')
    for (var j = 0; j < sel.length; j++) sel[j].classList.add('activo')
    var dom = TARGETS[url]
    if (dom && url.indexOf('dominios/') !== 0) {
      var dl = document.querySelector('#mdoms a[data-dom="' + (SAFE[dom] || dom) + '"]')
      if (dl) dl.classList.add('activo')
    }
    if (desplazar) {
      var vis = listaVisible(), act = vis && vis.querySelector('a.activo')
      if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' })
      var dact = document.querySelector('#mdoms a.activo, #mpags a.activo')
      if (dact && dact.scrollIntoView) dact.scrollIntoView({ block: 'nearest' })
    }
  }
  function navegar() {
    var url = objetivo(), dom = TARGETS[url]
    var cambioLista = false
    if (dom && dom !== domActual) {
      domActual = dom
      if (modo === 'dom') cambioLista = true
    }
    if (dom && modo === 'todas' && url.indexOf('dominios/') === 0) { modo = 'dom'; cambioLista = true }
    if (cambioLista) mostrarLista()
    else btnDom.textContent = 'Dominio · ' + (DOMSHORT[domActual] || domActual)
    resaltar(url, true)
    if (url !== actual) {
      actual = url
      var abs = new URL(url, location.href).href
      try { frame.contentWindow.location.replace(abs) } catch (e) { frame.src = url }
    }
  }
  document.getElementById('mpaneles').addEventListener('click', function (ev) {
    var a = ev.target.closest ? ev.target.closest('a') : null
    if (!a) return
    var h = a.getAttribute('href') || ''
    if (h.charAt(0) !== '#') return
    actual = ''
    setTimeout(navegar, 0)
  })
  window.addEventListener('hashchange', navegar)

  var BASE = ''
  try { BASE = new URL('.', location.href).href } catch (e) { BASE = '' }
  frame.addEventListener('load', function () {
    if (!BASE) return
    var href
    try { href = frame.contentWindow.location.href } catch (e) { return }
    if (!href || href.indexOf(BASE) !== 0) return
    var url = href.slice(BASE.length).split('#')[0].split('?')[0]
    try { url = decodeURIComponent(url) } catch (e) {}
    if (!Object.prototype.hasOwnProperty.call(TARGETS, url) || url === actual) return
    actual = url
    var dom = TARGETS[url]
    if (dom && dom !== domActual) {
      domActual = dom
      if (modo === 'dom') mostrarLista()
      else btnDom.textContent = 'Dominio · ' + (DOMSHORT[domActual] || domActual)
    }
    resaltar(url, true)
    if (location.hash.slice(1) !== url) {
      try { history.replaceState(null, '', '#' + url) } catch (e) {}
    }
  })

  filtro.addEventListener('input', function () {
    var q = filtro.value.trim().toLowerCase()
    var lis = scroller.querySelectorAll('li[data-n]')
    for (var i = 0; i < lis.length; i++) {
      var n = lis[i].getAttribute('data-n'), s = porUrl[lis[i].getAttribute('data-u')] || n
      lis[i].hidden = !!q && n.indexOf(q) < 0 && s.indexOf(q) < 0
    }
  })
  btnDom.addEventListener('click', function () { modo = 'dom'; mostrarLista(); resaltar(actual || objetivo(), true) })
  btnTodas.addEventListener('click', function () { modo = 'todas'; mostrarLista(); resaltar(actual || objetivo(), true) })

  var izq = document.getElementById('mizq'), plegar = document.getElementById('mplegar')
  plegar.addEventListener('click', function () {
    var plegado = izq.classList.toggle('plegado')
    plegar.setAttribute('aria-expanded', plegado ? 'false' : 'true')
    plegar.textContent = plegado ? 'Exploradores ▸' : 'Exploradores ▾'
  })
  var mq = window.matchMedia('(max-width: 760px)')
  function alAnchar() { if (!mq.matches) { izq.classList.remove('plegado'); plegar.setAttribute('aria-expanded', 'true'); plegar.textContent = 'Exploradores ▾' } }
  if (mq.addEventListener) mq.addEventListener('change', alAnchar)

  actual = ''
  domActual = TARGETS[objetivo()] || domActual
  mostrarLista()
  navegar()
})()
</script>
</body>
</html>
`
}
