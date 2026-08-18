import { type Capability } from '@vergis/botler'
import { VERGIS_VERSION_LABEL } from './version'
import { escapeHtml, renderMarkdown } from './markdown'
import { getTheme, resolveChartTokens, chartVarMap, type ThemeTokens } from './themes'
import { TABLE_RUNTIME_SOURCE } from './table-runtime'
import { TABLE_INTERACTIVE_CSS, TRAY_CSS } from './piece-css'
import { renderTable } from './render-table'
import { renderDistribution, renderSeries } from './render-chart'
import { renderInteractiveScript } from './interactive-script'
import { renderNotasTraySection, NOTAS_CSS, NOTAS_RUNTIME_SOURCE } from './notas-render'
import { ctxQuery, fltQuery, formatValue } from './piece-util'
import type {
  Interactive, PagesNav, ControlResolved, CarryCtx, FilterResolved, RenderParams,
  ResolvedNode, RenderOpts, RenderSignals,
} from './piece-types'

/**
 * `render-html-piece` — árbol de pieza resuelto (compuesto por Mira) → HTML estático
 * con assets embebidos, vía THEME pluggable. Charts vía Vega-Lite → SVG server-side.
 *
 * Interacción declarada acotada (doc 2 §10): si Mira pasa `interactive`, el render
 * compone una Faceta (catalogo-selector) sobre una dimensión declarada y embebe los
 * datos materializados + JS que filtra y recomputa KPIs/semáforo client-side — sin
 * nuevas queries. La pieza sigue siendo pre-forjada y reproducible.
 */

export const renderHtmlPiece: Capability = {
  name: 'render-html-piece',
  async execute(params: unknown): Promise<unknown> {
    const { piece, title, theme: themeName, palette, meta, interactive, pages, controls, carryCtx, notas, filters, fltCarry, print, pdfUrl } = (params ?? {}) as RenderParams
    if (!piece) throw new Error('render-html-piece: falta el árbol de pieza (piece)')
    const theme = getTheme(themeName)
    // PAPEL (#65 · D6): en modo print manda la paleta declarada por el theme, ANTES de resolver los
    // tokens — los hex se hornean en el SVG y el `@media print` no los alcanza.
    const effPalette = print ? (theme.printPalette ?? palette) : palette
    // Los colores del chart se hornean en el SVG server-side ⇒ el juego de tokens es el de la paleta
    // ACTIVA, no el del theme a secas (los tonos calibrados para fondo oscuro se lavan sobre blanco).
    const chartTokens = resolveChartTokens(theme, effPalette)
    // …y además se abren a CSS vars, para que el conmutador de Apariencia re-coloree los gráficos
    // sin re-compilar Vega en el browser (el contrato del motor es SVG server-side).
    const chartVars = chartVarMap(chartTokens)
    const carry = carryCtx ?? {}
    const signals: RenderSignals = { interactiveTable: false, drillActions: false }
    const flt = fltCarry ?? {}
    const opts: RenderOpts = { tokens: chartTokens, chartVars, interactive: !!interactive, print: !!print, carry, signals, fltQ: fltQuery(flt) }
    // CONVENCIÓN (TX-11 «una cosa, un lugar»): el selector de alcance vive en la BANDA (el sello ES
    // el control), no en la bandeja. El tab «Controles» de la bandeja queda para la maquinaria
    // (facetas de dashboard / runtime de tabla). Los selectores de alcance NO viven aquí.
    const contextStrip = controls && controls.length ? renderContextStrip(controls, pages?.active, carry) : ''
    // Franja de CHIPS de los filtros activos (#82), bajo la banda de contexto: la cara muestra el
    // estado, el control vive en la bandeja. Sin filtros activos, la franja no existe.
    // …y la MISMA franja hospeda los chips VIVOS de las facetas client-side (#114): una sola
    // superficie de estado de filtros por documento, sin importar quién los aplique.
    const hasFacets = !!(interactive && interactive.filters.length > 0)
    const chips = renderFilterChips(filters ?? [], pages?.active, carry, flt, hasFacets)
    const nav = pages ? renderPagesNav(pages, carry, flt) : ''
    let body = contextStrip + chips + nav + (await renderNode(piece, opts))
    const hasTable = signals.interactiveTable
    // BANDEJA COMÚN (un solo shell por documento) — contenido UNIVERSAL a TODO PI: Apariencia (Theme),
    // los tabs Controles·Vistas·Config y el pie de versión. El shell NO se gatea por maquinaria: una
    // vista de dashboard puro (KPIs+charts, sin tabla, con la interactividad de gráficos aún no
    // construida — capacidad #82) también merece su Inspector con Apariencia+Config. El tab
    // «Controles» reúne las facetas del dashboard / los controles del runtime de tabla; cuando no hay
    // ninguna, muestra un empty-state (no un panel en blanco).
    // El tab «Controles» reúne los filtros SERVER-SIDE (#82, re-render por navegación) y las facetas
    // client-side de `interactions.filters` — en ese orden: los primeros re-anclan charts y KPIs de
    // una vez; las segundas son el camino barato para tablas/KPIs sin gráficos.
    const trayFilters = renderTrayFilters(filters ?? [], pages?.active, carry, flt)
    // Grupo «Descargar» a nivel de DOCUMENTO (#65 · D9): el PDF congela el documento entero con la
    // vista y los filtros SERVER-SIDE vigentes. Server-rendered y por-documento — distinto del kit
    // «Descargar» por-TABLA que el runtime inyecta client-side (ese exporta UNA tabla, en CSV).
    const descargarSection = !print && pdfUrl ? renderDescargarSection(pdfUrl, pages?.active, carry, flt) : ''
    const facets = trayFilters + (interactive ? renderDashboardFacets(interactive) : '') + descargarSection
    // «Controles trae maquinaria» = facetas server-rendered (dashboard), el grupo Descargar o el
    // runtime de tabla que las inyecta client-side. Decide el empty-state y el tab por defecto — NO
    // decide si hay bandeja.
    const controlesHasMachinery = !!facets || hasTable || !!notas
    // Etiqueta de versión del PI (instancia) para el pie del inspector: "<code> · v<version>".
    const piLabel = meta?.code
      ? `${meta.code}${meta.version ? ' · v' + meta.version : ''}`
      : meta?.version
        ? `v${meta.version}`
        : ''
    let tail = '' // scripts al FINAL del body (DOM ya parseado)
    // PAPEL (#65 · D4): en print NO se compone el shell del Inspector ni viaja NINGÚN script — en un
    // motor de print el JS no corre, así que un botón o un runtime embebido solo prometerían algo que
    // el papel no puede cumplir. Queda la CARA: banda de contexto, chips, nav de la vista activa.
    if (!print) {
      // El shell del Inspector se compone SIEMPRE (una sola vez). Las facetas de dashboard van al tab
      // Controles solo cuando `interactive`; si no, `''` (y el tab muestra su empty-state).
      body = renderTrayShell(facets, theme.palettes, palette, piLabel, controlesHasMachinery, hasTable, !!notas) + body
      if (interactive) tail += renderInteractiveScript(interactive)
    }
    // CSS al TOPE del body, ANTES del contenido (evita FOUC: en tablas grandes el navegador
    // pintaba el HTML sin estilar mientras parseaba miles de filas + el JSON embebido, y solo
    // aplicaba el CSS al llegar al `<style>` del final). Todo el CSS por-documento va junto, arriba.
    let css = ''
    if (!print) css += TRAY_CSS // el shell del Inspector existe SIEMPRE (salvo en papel) → su CSS también
    if (hasTable) css += TABLE_INTERACTIVE_CSS
    if (notas) css += NOTAS_CSS
    if (pages) css += PAGES_NAV_CSS
    if (contextStrip) css += CONTEXT_BAR_CSS
    if (chips) css += FILTER_CHIPS_CSS
    if (trayFilters) css += TRAY_FILTERS_CSS
    if (descargarSection) css += TRAY_PDF_CSS
    if (signals.drillActions) css += DRILL_ACTIONS_CSS
    if (print) css += PRINT_TRUNC_CSS
    if (css) body = `<style>${css}</style>` + body
    // El runtime de la tabla (orden/filtro/búsqueda/agrupar/drill) al final: se autoarranca por `.vtable`.
    if (hasTable && !print) tail += `<script>${TABLE_RUNTIME_SOURCE}</script>`
    // #209 · El buscador de los filtros de bandeja. Es local por construcción (el catálogo ya viaja
    // completo en el HTML) y no depende del runtime de tabla: un dashboard sin tablas también tiene
    // filtros. En papel no va: ahí no hay quién escriba.
    if (trayFilters && !print) tail += `<script>${TRAY_FILTER_SEARCH_SOURCE}</script>`
    // La capa de NOTAS va DESPUÉS del runtime de tabla: decora un tbody que ya existe y se engancha
    // a sus re-renders. Su contexto viaja como JSON (endpoints + CSRF + recorte), nunca interpolado
    // en el script — el recorte lo escribe el usuario y no puede acabar como código.
    if (notas && !print) {
      tail +=
        `<script type="application/json" id="vergis-notas">${JSON.stringify(notas).replace(/</g, '\\u003c')}</script>` +
        `<script>${NOTAS_RUNTIME_SOURCE}</script>`
    }
    return { html: theme.wrap({ title: title ?? 'Vergis', body: body + tail, meta, palette: effPalette }) }
  },
}

/** CSS de la barra de navegación de vistas (PI multi-vista). Variables del theme con fallback claro. */
const PAGES_NAV_CSS = `
.vpages{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 18px;border-bottom:1px solid var(--border,#e2e8f0)}
.vpages a{font-size:13px;padding:8px 16px;text-decoration:none;color:var(--fg-dim,#64748b);border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.vpages a:hover{color:var(--fg,#1f2937)}
.vpages a.active{color:var(--green,#2563eb);border-bottom-color:var(--green,#2563eb);font-weight:600}
@media print{.vpages{border-bottom:none}.vpages a{display:none}.vpages a.active{display:inline-block;border:none;padding:0 0 6px;font-size:12px}}
`

/**
 * CSS del grupo «Descargar» de la bandeja (#65 · D9). Paridad visual con el botón de export del kit
 * por-tabla, sin tocar `piece-css.ts` (territorio del runtime de tabla).
 */
const TRAY_PDF_CSS = `
.tray .tray-pdfbtn{display:block;width:100%;box-sizing:border-box;text-align:center;padding:8px;font-size:12px;background:var(--card,#fff);color:var(--fg-dim,#64748b);border:1px solid var(--border,#e2e8f0);border-radius:7px;text-decoration:none}
.tray .tray-pdfbtn:hover{color:var(--green,#16a34a);border-color:var(--green,#16a34a)}
`

/** Fila de truncamiento de una tabla en papel (#65 · D5): discreta, pero VISIBLE — nunca un corte mudo. */
const PRINT_TRUNC_CSS = `
tr.vt-trunc td{padding:6px 8px;font-size:11px;font-style:italic;color:var(--fg-dim,#64748b);text-align:center}
`

/**
 * Grupo «Descargar» del tab Controles (#65 · D9) — a nivel de DOCUMENTO: el PDF congela el documento
 * completo con la vista y los filtros SERVER-SIDE vigentes (el href los preserva). Es un link simple:
 * la conversión ocurre en el servidor, no hay nada que ejecutar en el browser.
 */
function renderDescargarSection(pdfUrl: string, activePage: string | undefined, carry: CarryCtx, flt: Record<string, string[]>): string {
  const q = (activePage ? `&page=${encodeURIComponent(activePage)}` : '') + ctxQuery(carry) + fltQuery(flt)
  const href = q ? `${pdfUrl}?${q.slice(1)}` : pdfUrl
  return (
    `<div class="faceta tray-descargar"><div class="faceta-title">Descargar</div>` +
    `<a class="tray-pdfbtn" href="${escapeHtml(href)}" title="El documento completo como PDF, con la vista y filtros actuales del servidor">Descargar PDF</a></div>`
  )
}


/** Barra de navegación de vistas: un link por página (`?page=<id>`), preservando el carry (ctx). */
function renderPagesNav(pages: PagesNav, carry: CarryCtx = {}, flt: Record<string, string[]> = {}): string {
  const q = ctxQuery(carry) + fltQuery(flt)
  const tabs = pages.items
    .map(
      (p) =>
        `<a href="?page=${encodeURIComponent(p.id)}${q}"${p.id === pages.active ? ' class="active" aria-current="page"' : ''}>${escapeHtml(p.title)}</a>`,
    )
    .join('')
  return `<nav class="vpages" role="tablist">${tabs}</nav>`
}

/** CSS de la banda de CONTEXTO ACTIVO (sticky arriba) — la superficie estándar del selector de
 * alcance (TX-11 «cara = estado»): el sello muestra el valor vigente y ES clickeable (single =
 * `<select>` estilizado; multi = `<details>` con checkboxes). En print (`.vctx-print`) degrada a
 * texto plano y el widget (`.vctx-screen`) se oculta. Variables del theme con fallback claro. */
const CONTEXT_BAR_CSS = `
.vctxbar{position:sticky;top:0;z-index:8;display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:8px 14px;margin:0 0 16px;background:var(--panel,var(--bg,#fff));border:1px solid var(--border,#e2e8f0);border-radius:8px;font-size:12px}
.vctxbar .vctx-item{display:inline-flex;align-items:center;gap:6px}
.vctxbar .vctx-k{color:var(--fg-dim,#64748b);text-transform:uppercase;letter-spacing:.04em;font-size:10px;margin-right:2px}
.vctxbar .vctx-v{color:var(--fg,#1f2937);font-weight:700}
.vctxbar select.vctx-sel{font:inherit;font-weight:700;color:var(--fg,#1f2937);background-color:var(--bg,#fff);border:1px solid var(--border,#e2e8f0);border-radius:6px;padding:3px 22px 3px 8px;cursor:pointer;-webkit-appearance:none;-moz-appearance:none;appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%2364748b' stroke-width='1.4'/></svg>");background-repeat:no-repeat;background-position:right 7px center}
.vctxbar select.vctx-sel:hover{border-color:var(--green,#2563eb)}
.vctxbar .vctx-multi{position:relative;display:inline-block}
.vctxbar .vctx-multi>summary{list-style:none;cursor:pointer;font-weight:700;color:var(--fg,#1f2937);background:var(--bg,#fff);border:1px solid var(--border,#e2e8f0);border-radius:6px;padding:3px 10px 3px 8px}
.vctxbar .vctx-multi>summary::-webkit-details-marker{display:none}
.vctxbar .vctx-multi>summary::after{content:"▾";margin-left:6px;color:var(--fg-dim,#64748b);font-size:10px}
.vctxbar .vctx-multi[open]>summary{border-color:var(--green,#2563eb)}
.vctxbar .vctx-pop{position:absolute;z-index:20;top:calc(100% + 4px);left:0;min-width:150px;display:flex;flex-direction:column;gap:4px;padding:8px;background:var(--panel,#fff);border:1px solid var(--border,#e2e8f0);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.18)}
.vctxbar .vctx-pop label{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:400;white-space:nowrap;cursor:pointer;color:var(--fg,#1f2937)}
.vctx-print{display:none}
@media print{.vctxbar{position:static;border:none;padding:0;margin:0 0 10px;gap:12px;font-size:11px}.vctxbar .vctx-screen{display:none!important}.vctxbar .vctx-print{display:inline!important;font-weight:700}}
`

/**
 * Prefijo común del handler de navegación de un sello (banda) o control: reconstruye el query con
 * la página activa + el carry (menos ESTE control; un valor multi se repite con append). `window.URL`
 * es obligatorio: en un handler inline `document.URL` (string) sombrea al constructor global y
 * `new URL(…)` lanzaría TypeError (ver test controls-multidrill, ejecutado bajo `with(document)`).
 */
function ctxNavBase(cId: string, activePage: string | undefined, carry: CarryCtx): string {
  return (
    `var u=new window.URL(location.href);u.search='';` +
    (activePage ? `u.searchParams.set('page',${JSON.stringify(activePage)});` : '') +
    Object.entries(carry)
      .filter(([k]) => k !== cId)
      .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((val) => `u.searchParams.append('ctx.${escapeHtml(k)}',${JSON.stringify(String(val))});`))
      .join('')
  )
}

/**
 * Banda de contexto activo = EL selector de alcance (TX-11 WP1). Por control con valor vigente emite
 * un sello clickeable: single → `<select>` nativo estilizado (a11y gratis) con las mismas opciones y
 * navegación que el control histórico de la bandeja; multi → `<details>` cuyo summary muestra el valor
 * unido y cuyo popover reúne los checkboxes existentes. Por ítem se emite además `.vctx-print` (texto
 * plano) — en print el widget `.vctx-screen` se oculta y queda el texto (el sello impreso es «OC …»).
 */
function renderContextStrip(controls: ControlResolved[], activePage: string | undefined, carry: CarryCtx): string {
  const items = controls
    .filter((c) => c.value != null && c.value !== '')
    .map((c) => {
      const label = escapeHtml(c.label)
      // Opciones normalizadas a pares {value,label}: la resolución emite pares (value = la llave que se
      // escribe en ctx, label = el texto visible); un `string[]` legado se lee como label = value.
      const pairs = c.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
      // Llave de contexto que el sello ESCRIBE: `param` (default id). Dos controles con el mismo `param`
      // fijan el MISMO `ctx.<param>` → al elegir por cualquiera, el re-render pinta ambos sellos
      // coherentes (llaves alternativas sincronizadas). `ctxNavBase(param)` excluye ESE param del carry
      // para que el valor fresco lo reemplace. El texto de print/summary es la ETIQUETA (`displayLabel`).
      const param = c.param ?? c.id
      const printText = c.displayLabel ?? String(c.value)
      const printVal = `<span class="vctx-v vctx-print">${escapeHtml(printText)}</span>`
      if (c.multi) {
        // Multi: al cambiar cualquier checkbox se recolectan los marcados y se navega con `ctx.<param>`
        // repetido por valor (mismo contrato que el control histórico, misma navegación por URL).
        const onchange =
          ctxNavBase(param, activePage, carry) +
          `var g=this.closest('.vctx-multi');Array.prototype.forEach.call(g.querySelectorAll('input[type=checkbox]:checked'),function(b){u.searchParams.append('ctx.${escapeHtml(param)}',b.value);});location.assign(u.pathname+u.search);`
        const selected = new Set(c.values ?? [])
        const checks = pairs
          .map((o) => `<label><input type="checkbox" value="${escapeHtml(o.value)}"${selected.has(o.value) ? ' checked' : ''} onchange="${escapeHtml(onchange)}"> ${escapeHtml(o.label)}</label>`)
          .join('')
        return (
          `<span class="vctx-item"><span class="vctx-k">${label}</span>` +
          `<details class="vctx-multi vctx-screen" data-ctl="${escapeHtml(c.id)}"><summary class="vctx-v vctx-sum">${escapeHtml(printText)}</summary>` +
          `<div class="vctx-pop" role="group" aria-label="${label}">${checks}</div></details>` +
          printVal +
          `</span>`
        )
      }
      const onchange = ctxNavBase(param, activePage, carry) + `u.searchParams.set('ctx.${escapeHtml(param)}',this.value);location.assign(u.pathname+u.search);`
      const opts = pairs
        .map((o) => `<option value="${escapeHtml(o.value)}"${o.value === c.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`)
        .join('')
      return (
        `<span class="vctx-item"><span class="vctx-k">${label}</span>` +
        `<select class="vctx-v vctx-sel vctx-screen" aria-label="${label}" onchange="${escapeHtml(onchange)}">${opts}</select>` +
        printVal +
        `</span>`
      )
    })
    .join('')
  return items ? `<div class="vctxbar">${items}</div>` : ''
}

/**
 * CSS de la franja de CHIPS de filtros activos (#82). Vive bajo la banda de contexto: el control está
 * en la bandeja, la CARA muestra el estado (TX-11 «una cosa, un lugar»). En print los chips se ocultan
 * y queda un resumen en letra chica — un PDF no tiene botones que remover.
 */
const FILTER_CHIPS_CSS = `
.vfltbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px;font-size:12px}
.vfltbar .vflt-k{color:var(--fg-dim,#64748b);text-transform:uppercase;letter-spacing:.04em;font-size:10px}
.vfltbar .vflt-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 6px 2px 9px;border:1px solid var(--border,#e2e8f0);border-radius:999px;background:var(--card,#f1f5f9);color:var(--fg,#1f2937)}
.vfltbar .vflt-chip b{font-weight:600}
.vfltbar .vflt-x{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;text-decoration:none;color:var(--fg-dim,#64748b);font-size:11px;line-height:1}
.vfltbar .vflt-x:hover{background:var(--border,#e2e8f0);color:var(--fg,#1f2937)}
.vfltbar .vflt-live .vflt-x{cursor:pointer}
.vfltbar .vflt-clear{margin-left:2px;font-size:11px;text-decoration:none;color:var(--fg-dim,#64748b)}
.vfltbar .vflt-clear:hover{text-decoration:underline}
.vflt-print{display:none}
@media print{.vfltbar .vflt-screen{display:none!important}.vflt-print{display:inline!important;font-size:10px;color:#555}}
`

/**
 * CSS de la sección de filtros server-side de la bandeja. Reusa las clases `.faceta*` que ya estila
 * cada theme; solo agrega lo propio del LINK (los filtros de #82 navegan, no marcan un checkbox).
 */
/**
 * #209 · Cuántas opciones de un filtro de bandeja se muestran antes de plegar el resto.
 *
 * El pedido del cliente fue «un límite de opciones a la vez por filtro + search». La medición previa
 * matizó el síntoma y conviene dejarla escrita: `.faceta-options` YA acota su alto a 220px con
 * scroll interno en los dos themes, así que un filtro nunca ocupó literalmente la columna entera.
 * Lo que sí ocurre es que N filtros suman N franjas de 220px, y que dentro de un catálogo de 47
 * opciones la que se busca se encuentra scrolleando a ciegas. De ahí las DOS piezas: plegar (baja la
 * suma de alturas) y buscar (alcanza lo plegado sin scrollear).
 *
 * 12 es el tope: entra en los 220px sin scroll interno, así que un filtro plegado no anida dos
 * mecanismos de scroll — que es la forma clásica de que el de adentro se coma la rueda del de afuera.
 */
export const FILTER_VISIBLE_MAX = 12

const TRAY_FILTERS_CSS = `
.faceta-options .vflt-opt{display:block;padding:0;text-transform:none;letter-spacing:0}
.vflt-search{width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:4px 8px;margin:0 0 6px;color:var(--fg,#1f2937);background:var(--bg,#fff);border:1px solid var(--border,#e2e8f0);border-radius:6px}
.vflt-allbox{position:absolute;opacity:0;pointer-events:none;width:0;height:0}
.vflt-showall{display:block;font-size:11px;color:var(--green,#2563eb);cursor:pointer;margin:0 0 6px;text-decoration:underline}
.vflt-extra{display:none}
.vflt-allbox:checked ~ .faceta-options .vflt-extra{display:block}
.vflt-allbox:checked ~ .vflt-showall{display:none}
.faceta-options .vflt-opt.vflt-hit{display:block}
.faceta-options .vflt-opt.vflt-miss{display:none}
.vflt-nohit{display:none;font-size:11px;color:var(--fg-dim,#64748b);padding:2px 0}
.faceta.vflt-empty .vflt-nohit{display:block}
@media print{.vflt-search,.vflt-showall,.vflt-nohit{display:none!important}}
.faceta-options .vflt-opt a{display:flex;gap:8px;align-items:center;font-size:13px;padding:4px 2px;color:var(--fg,#1f2937);text-decoration:none}
.faceta-options .vflt-opt a:hover{color:var(--green,#2563eb)}
.faceta-options .vflt-opt .vflt-box{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:0 0 14px;border:1px solid var(--border,#94a3b8);border-radius:3px;font-size:10px;line-height:1}
.faceta-options .vflt-opt.on a{font-weight:600;color:var(--green,#2563eb)}
.faceta-options .vflt-opt.on .vflt-box{border-color:var(--green,#2563eb)}
@media print{.faceta-options .vflt-opt{display:none}}
`

/** `?page=…&ctx…&flt…` para un href de filtro (misma página, contexto intacto, `flt` recompuesto). */
function fltHref(activePage: string | undefined, carry: CarryCtx, flt: Record<string, string[]>, omit?: { id: string; value?: string }, add?: { id: string; value: string }): string {
  const base = activePage ? `?page=${encodeURIComponent(activePage)}` : '?'
  let q = ctxQuery(carry) + fltQuery(flt, omit)
  if (add) q += `&flt.${encodeURIComponent(add.id)}=${encodeURIComponent(add.value)}`
  return base + q
}

/**
 * Franja de chips: un chip REMOVIBLE por valor activo (`Especie: Cerezo ×`). El × navega quitando ESE
 * valor de la URL; el re-render server-side es lo que re-ancla charts, KPIs y tablas de una vez.
 * Sin filtros activos la franja no existe (ausencia = documento completo, sin ruido en la cara).
 *
 * `hasFacets` (#114): el documento declara facetas client-side. Entonces la franja se emite SIEMPRE
 * como contenedor (con `hidden` si aún no trae chips server) y lleva los dos slots vivos que
 * `update()` mantiene: `#vergis-flt-live` (chips de pantalla) y `#vergis-flt-live-print` (resumen).
 * Sin filtros activos NI facetas → nada (byte a byte como antes: ausencia = documento completo).
 */
function renderFilterChips(filters: FilterResolved[], activePage: string | undefined, carry: CarryCtx, flt: Record<string, string[]>, hasFacets = false): string {
  const active = filters.filter((f) => f.selected.length > 0)
  if (active.length === 0 && !hasFacets) return ''
  // Slots que el script client rellena; solo existen si hay facetas que puedan poblarlos. El `id` de
  // la franja también: sin facetas no hay script que la busque, y la marca extra sería ruido.
  const live = hasFacets
    ? `<span id="vergis-flt-live"></span><span class="vflt-print" id="vergis-flt-live-print"></span>`
    : ''
  const barId = hasFacets ? ' id="vergis-fltbar"' : ''
  if (active.length === 0) {
    // Solo facetas: contenedor vacío y oculto, listo para que `update()` lo pueble y lo muestre.
    return `<div class="vfltbar"${barId} hidden><span class="vflt-k vflt-screen">Filtros</span>${live}</div>`
  }
  const chips = active
    .flatMap((f) =>
      f.selected.map((v) => {
        const href = escapeHtml(fltHref(activePage, carry, flt, { id: f.id, value: v }))
        return (
          `<span class="vflt-chip vflt-screen"><b>${escapeHtml(f.label)}:</b> ${escapeHtml(v)}` +
          `<a class="vflt-x" href="${href}" title="Quitar este filtro" aria-label="Quitar ${escapeHtml(f.label)}: ${escapeHtml(v)}">✕</a></span>`
        )
      }),
    )
    .join('')
  // Resumen para el papel: los chips son botones y en print no tienen sentido.
  const printSummary = active.map((f) => `${f.label}: ${f.selected.join(', ')}`).join(' · ')
  const clearAll =
    active.length > 1 || active[0].selected.length > 1
      ? `<a class="vflt-clear vflt-screen" href="${escapeHtml(fltHref(activePage, carry, {}))}">limpiar todo</a>`
      : ''
  return (
    `<div class="vfltbar"${barId}><span class="vflt-k vflt-screen">Filtros</span>${chips}${live}${clearAll}` +
    `<span class="vflt-print">Filtros — ${escapeHtml(printSummary)}</span></div>`
  )
}

/**
 * Sección de FILTROS SERVER-SIDE del tab «Controles» de la bandeja. Cada opción es un LINK, no un
 * checkbox con JS: el mecanismo de #82 es navegación + re-render server-side (así se re-anclan los
 * charts, que son SVG horneado), no recompute client-side. Las opciones ya vienen cascadeadas.
 */
function renderTrayFilters(filters: FilterResolved[], activePage: string | undefined, carry: CarryCtx, flt: Record<string, string[]>): string {
  return filters
    .map((f) => {
      const grande = f.options.length > FILTER_VISIBLE_MAX
      let visibles = 0
      const opts = f.options
        .map((v) => {
          const on = f.selected.includes(v)
          // #209 · Una opción SELECCIONADA nunca se pliega: esconder la propia selección del usuario
          // es peor que la lista larga — deja de poder ver, y de poder quitar, lo que él eligió.
          const extra = grande && !on && visibles >= FILTER_VISIBLE_MAX
          if (!extra) visibles++
          // Multi: el link alterna ESE valor. Single: elegir reemplaza la selección previa.
          const href = on
            ? fltHref(activePage, carry, flt, { id: f.id, value: v })
            : fltHref(activePage, carry, flt, f.multi ? undefined : { id: f.id }, { id: f.id, value: v })
          return (
            `<label class="vflt-opt${on ? ' on' : ''}${extra ? ' vflt-extra' : ''}" data-v="${escapeHtml(v.toLowerCase())}">` +
            `<a href="${escapeHtml(href)}" role="checkbox" aria-checked="${on}">` +
            `<span class="vflt-box">${on ? '✓' : ''}</span> ${escapeHtml(v)}</a></label>`
          )
        })
        .join('')
      const clear = f.selected.length
        ? `<a class="faceta-clear" href="${escapeHtml(fltHref(activePage, carry, flt, { id: f.id }))}">limpiar</a>`
        : ''
      // #209 · Buscador LOCAL: el catálogo ya viaja completo en el HTML (las opciones son links
      // server-rendered), así que alcanzar una opción fuera del tope no necesita ningún endpoint. Y
      // como cada aplicación de filtro re-renderiza la página entera, el catálogo cascadeado por
      // `depends_on` nace fresco con el HTML — no hay caché client-side que invalidar.
      const buscador = grande
        ? `<input type="search" class="vflt-search" placeholder="Buscar entre ${f.options.length}…"` +
          ` aria-label="Buscar en ${escapeHtml(f.label)}" oninput="vfltSearch(this)">`
        : ''
      // El plegado es CSS-only (un checkbox + hermano general), mismo patrón que el colapso de la
      // bandeja: sin JS el botón sigue funcionando y ninguna opción queda inalcanzable. El buscador
      // sí necesita JS, y su ausencia degrada a «no filtra», nunca a «no se puede llegar».
      const restantes = f.options.length - visibles
      const verTodas =
        grande && restantes > 0
          ? `<input type="checkbox" class="vflt-allbox" id="vflt-all-${escapeHtml(f.id)}">` +
            `<label class="vflt-showall" for="vflt-all-${escapeHtml(f.id)}">Ver las ${restantes} restantes</label>`
          : ''
      const body = f.options.length
        ? `${buscador}${verTodas}<div class="faceta-options">${opts}</div><div class="vflt-nohit">Ninguna opción coincide.</div>`
        : `<div class="tray-empty">Sin opciones para la selección actual.</div>`
      return `<div class="faceta" data-flt="${escapeHtml(f.id)}"><div class="faceta-title">${escapeHtml(f.label)}${clear}</div>${body}</div>`
    })
    .join('')
}

/**
 * #209 · Buscador local de un filtro de bandeja.
 *
 * Filtra sobre TODAS las opciones, incluidas las plegadas por el tope: un buscador que solo alcanza
 * lo ya visible no resuelve nada — el caso que lo pidió es justamente llegar a la opción número 40
 * de 47. Por eso el `.vflt-hit` gana sobre `.vflt-extra` en la hoja.
 *
 * Con la caja vacía se restaura el estado de reposo (plegado incluido) en vez de dejar todo abierto:
 * si no, buscar una vez desplegaría el filtro para siempre.
 */
const TRAY_FILTER_SEARCH_SOURCE = `
function vfltSearch(input){
  var faceta = input.closest ? input.closest('.faceta') : null;
  if(!faceta) return;
  var q = (input.value||'').trim().toLowerCase();
  var opts = faceta.querySelectorAll('.vflt-opt');
  var hits = 0;
  for(var i=0;i<opts.length;i++){
    var o = opts[i];
    o.classList.remove('vflt-hit','vflt-miss');
    if(!q){ continue; }
    if((o.getAttribute('data-v')||'').indexOf(q) >= 0){ o.classList.add('vflt-hit'); hits++; }
    else { o.classList.add('vflt-miss'); }
  }
  faceta.classList.toggle('vflt-empty', !!q && hits === 0);
}
`

/** CSS de la columna de acciones de drill (links por fila + menú cuando hay varias). */
const DRILL_ACTIONS_CSS = `
.vtable td.vt-actions,.table td.vt-actions{white-space:nowrap;text-align:center;width:1px}
.vt-drill-link{display:inline-block;padding:1px 7px;margin:0 1px;font-size:12px;text-decoration:none;color:var(--green,#2563eb);border:1px solid transparent;border-radius:6px;cursor:pointer}
.vt-drill-link:hover{border-color:var(--green,#2563eb);background:var(--card,#eef2ff)}
.vt-drill-arrow{font-weight:700}
@media print{td.vt-actions{display:none!important}}
`

async function renderNode(node: ResolvedNode, opts: RenderOpts): Promise<string> {
  if (node.layout) {
    const children = await Promise.all((node.elements ?? []).map((e) => renderNode(e, opts)))
    const styles: string[] = []
    if (node.layout === 'grid' && node.columns) styles.push(`--cols:${node.columns}`)
    if (node.span) styles.push(`grid-column:span ${node.span}`) // abarcar N columnas del grid padre
    const style = styles.length ? ` style="${styles.join(';')}"` : ''
    return `<div class="layout layout-${escapeHtml(node.layout)}"${style}>\n${children.join('\n')}\n</div>`
  }
  switch (node.type) {
    case 'banner':
      return `<div class="banner">${escapeHtml(String(node.content ?? ''))}</div>`
    case 'markdown_block':
      return `<section class="markdown">${renderMarkdown(String(node.content ?? ''))}</section>`
    case 'kpi':
      return renderKpi(node, opts)
    case 'dato':
      return renderDato(node)
    case 'distribution':
      return renderDistribution(node, opts.tokens, opts.chartVars)
    case 'series':
      return renderSeries(node, opts.tokens, opts.chartVars)
    case 'table':
      return renderTable(node, opts)
    case 'semaforo':
      return renderSemaforo(node, opts)
    default:
      return `<!-- elemento no soportado en v0.1: ${escapeHtml(String(node.type))} -->`
  }
}

function renderKpi(node: ResolvedNode, opts: RenderOpts): string {
  const value = formatValue(node.value, node.format)
  const accent = node.accent ? ` data-accent="${escapeHtml(node.accent)}"` : ''
  // Atributos para recompute client-side (interacción declarada acotada).
  let dataAttrs = ''
  if (opts.interactive && node.agg) {
    dataAttrs = ` data-format="${escapeHtml(node.format ?? '')}" data-agg="${escapeHtml(JSON.stringify(node.agg))}"`
    if (node.comparisonAgg) dataAttrs += ` data-comparison-agg="${escapeHtml(JSON.stringify(node.comparisonAgg))}" data-comparison-label="${escapeHtml(node.comparisonLabel ?? '')}"`
  }
  const comparison =
    node.comparison != null
      ? ` <span class="kpi-comparison">${escapeHtml(node.comparisonLabel ?? '')} ${escapeHtml(formatValue(node.comparison, node.format))}</span>`
      : ''
  const sizeCls = node.size ? ` kpi-${escapeHtml(node.size)}` : ''
  return (
    `<section class="kpi${sizeCls}"${accent}${dataAttrs}>` +
    `<div class="kpi-value">${escapeHtml(value)}</div>` +
    `<div class="kpi-label">${escapeHtml(String(node.label ?? ''))}${comparison}</div>` +
    `</section>`
  )
}

/**
 * `dato` (TX-12) — atributo rotulado: etiqueta + valor en tipografía de texto (NO tarjeta-medida).
 * Es contenido/estado, no una métrica: se imprime tal cual y JAMÁS es interactivo (sin data-attrs de
 * recompute). El valor ya viene resuelto por compose; acá solo se formatea y escapa.
 */
function renderDato(node: ResolvedNode): string {
  const value = formatValue(node.value, node.format)
  return (
    `<div class="dato">` +
    `<span class="dato-k">${escapeHtml(String(node.label ?? ''))}</span>` +
    `<span class="dato-v">${escapeHtml(value)}</span>` +
    `</div>`
  )
}

function semaforoCard(label: string, present: number, total: number, green: number, yellow: number): string {
  // Guard NaN: una fila con present/total nulos pintaba «NaN / NaN» y 0% (rojo). Mostrar «—».
  const valid = Number.isFinite(present) && Number.isFinite(total)
  const pct = valid && total > 0 ? Math.round((present / total) * 100) : 0
  const cls = !valid ? 'red' : pct >= green ? 'green' : pct >= yellow ? 'yellow' : 'red'
  return (
    `<div class="tl-card ${cls}">` +
    `<div class="area-name" title="${escapeHtml(label)}">${escapeHtml(label)}</div>` +
    `<span class="headcount">${valid ? `${present} / ${total}` : '—'}</span>` +
    `<span class="pct ${cls}">${valid ? `${pct}%` : '—'}</span>` +
    `</div>`
  )
}

function renderSemaforo(node: ResolvedNode, opts: RenderOpts): string {
  const rows = node.rows ?? []
  const labelF = node.labelField ?? 'label'
  const presentF = node.presentField ?? 'present'
  const totalF = node.totalField ?? 'total'
  const green = node.thresholds?.green ?? 90
  const yellow = node.thresholds?.yellow ?? 70
  const cards = rows
    .map((r) => semaforoCard(String(r[labelF] ?? ''), Number(r[presentF]), Number(r[totalF]), green, yellow))
    .join('\n')
  let dataAttr = ''
  if (opts.interactive) {
    dataAttr = ` data-semaforo="${escapeHtml(JSON.stringify({ dataset: node.dataset, labelField: labelF, presentField: presentF, totalField: totalF, green, yellow }))}"`
  }
  // Header: título a la izquierda + summary (un agregado) inline a la derecha.
  let summaryHtml = ''
  if (node.summary) {
    const sAttr = opts.interactive
      ? ` data-summary="${escapeHtml(JSON.stringify({ dataset: node.summary.dataset, agg: node.summary.agg, format: node.summary.format }))}"`
      : ''
    const accent = node.summary.accent ? ` data-accent="${escapeHtml(node.summary.accent)}"` : ''
    summaryHtml =
      `<div class="semaforo-summary"${accent}${sAttr}>` +
      `<span class="ss-val">${escapeHtml(formatValue(node.summary.value, node.summary.format))}</span>` +
      `<span class="ss-lbl">${escapeHtml(String(node.summary.label ?? ''))}</span>` +
      `</div>`
  }
  const head =
    node.title || summaryHtml
      ? `<div class="semaforo-head">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : '<span></span>'}${summaryHtml}</div>`
      : ''
  // `columns` fuerza N columnas fijas (p.ej. 5 días en una línea); por defecto, auto-fill (CSS).
  const gridStyle = node.columns ? ` style="grid-template-columns:repeat(${node.columns},minmax(0,1fr))"` : ''
  return `<section class="semaforo"${dataAttr}>${head}<div class="tl-grid"${gridStyle}>${cards}</div></section>`
}

/**
 * Bandeja (off-canvas, desde la derecha) — **shell común a TODOS los PI** (dashboard y tabla).
 * El CTA es una uña/pestaña que sobresale del borde derecho (overlay universal, ajeno al
 * contenido). Al abrir, el contenido se encoge a la izquierda. Apertura/cierre por toggle CSS
 * puro. `sections` es el contenido específico del PI (facetas de dashboard server-rendered, o
 * vacío para que el runtime de tabla inyecte sus controles en `.tray-sections`). Apariencia,
 * Imprimir y crédito son universales. Una sola implementación = comportamiento idéntico.
 */
function renderTrayShell(
  sections: string,
  palettes?: { id: string; label: string }[],
  activePalette?: string,
  piLabel?: string,
  controlesHasMachinery = true,
  hasTable = false,
  hasNotas = false,
): string {
  const active = activePalette || (palettes && palettes[0]?.id) || ''
  let appearance = ''
  if (palettes && palettes.length > 1) {
    const radios = palettes
      .map(
        (p) =>
          `<label><input type="radio" name="vergis-palette" value="${escapeHtml(p.id)}"${p.id === active ? ' checked' : ''} onchange="document.documentElement.dataset.palette=this.value;try{localStorage.setItem('vergis:palette:'+location.pathname,this.value)}catch(e){}"> ${escapeHtml(p.label)}</label>`,
      )
      .join('')
    appearance =
      `<div class="faceta faceta-appearance"><div class="faceta-title">Apariencia (Theme)</div>` +
      `<div class="faceta-options">${radios}</div></div>`
  }
  // Restaura el estado del usuario (persistido POR REPORTE, como la paleta y las anotaciones) sobre
  // los defaults de plataforma: (1) la paleta elegida y (2) si el Inspector queda abierto. El colapso
  // es CSS-only (un checkbox), así que un POST→redirect→GET —aplicar un filtro server-side, enviar
  // cualquier form— re-renderiza la página y lo devolvía a cerrado en cada turno. Mismo mecanismo que
  // ya usan paleta y anotaciones: localStorage + re-aplicación al cargar.
  const restore =
    `<script>(function(){try{var p=localStorage.getItem('vergis:palette:'+location.pathname);if(p){document.documentElement.dataset.palette=p;var r=document.querySelector('input[name=vergis-palette][value="'+p+'"]');if(r)r.checked=true;}}catch(e){}` +
    `try{var t=localStorage.getItem('vergis:tray:'+location.pathname);if(t!==null){var c=document.getElementById('vergis-tray-toggle');if(c)c.checked=(t==='1');}}catch(e){}})();</script>`
  // Pie de la bandeja (pegado al fondo): versión + crédito discreto. URL como texto, sin links.
  // Pie del inspector: versión del PI (instancia) + versión de Mira (motor) — pistas DISTINTAS.
  const footer =
    `<div class="tray-foot">` +
    (piLabel ? `<div class="tray-version tray-piversion">${escapeHtml(piLabel)}</div>` : '') +
    `<div class="tray-version">${escapeHtml(VERGIS_VERSION_LABEL)}</div>` +
    `<div class="tray-credit">Powered by Vergis · © 2026 Gegolabs · AGPL-3.0 · https://agencydomains.org/</div>` +
    `</div>`
  // Tab por defecto (radio `checked`): Controles cuando trae maquinaria (facetas de dashboard o
  // runtime de tabla); si no, se abre en Config (Apariencia + Imprimir) — el único tab con contenido
  // real en una vista de dashboard puro, para no aterrizar en un panel vacío. Exactamente un radio
  // `checked` en ambos casos.
  const controlesChecked = controlesHasMachinery ? ' checked' : ''
  const configChecked = controlesHasMachinery ? '' : ' checked'
  // Empty-state sobrio cuando el tab no tiene maquinaria (evita el panel en blanco). Sin prometer #82.
  const controlesBody = controlesHasMachinery
    ? sections
    : `<div class="tray-empty">Esta vista no tiene filtros disponibles.</div>`
  // «Vistas» (guardados) lo puebla el runtime de tabla; sin tabla no hay qué guardar → empty-state.
  const guardadosBody = hasTable
    ? ''
    : `<div class="tray-empty">Las vistas guardadas están disponibles en reportes con tabla.</div>`
  // Los actos de la capa de notas (Imprimir · Anotar) son CONTROLES: viven en la bandeja, junto al
  // resto de la maquinaria, jamás sueltos en el cuerpo del documento.
  const notasKit = hasNotas ? renderNotasTraySection() : ''
  return (
    // El colapso se PERSISTE (por reporte) al cambiar: sin esto, cada POST→redirect→GET lo resetea.
    `<input type="checkbox" id="vergis-tray-toggle" class="tray-toggle" hidden onchange="try{localStorage.setItem('vergis:tray:'+location.pathname,this.checked?'1':'0')}catch(e){}">` +
    `<label for="vergis-tray-toggle" class="tray-tab" title="Inspector" aria-label="Abrir inspector">` +
    // Ícono de sliders/controles (no embudo): el panel es un Inspector (controles + vistas + config).
    `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2 4.5h12M2 8h12M2 11.5h12"/><circle cx="6" cy="4.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="10.5" cy="8" r="1.7" fill="currentColor" stroke="none"/><circle cx="5" cy="11.5" r="1.7" fill="currentColor" stroke="none"/></svg>` +
    `<span class="faceta-count" id="vergis-count"></span>` +
    `</label>` +
    `<aside class="tray" id="vergis-filters" role="dialog" aria-label="Inspector">` +
    `<div class="tray-head"><strong>Inspector</strong><label for="vergis-tray-toggle" class="tray-close" title="Cerrar">✕</label></div>` +
    // «Volver al catálogo» (#136 · D3): PRIMERA entrada de la bandeja, antes de los tabs. Enlace
    // simple al índice (`/`), que ya está gateado por identidad y filtra por lo abrible.
    `<a class="tray-catalog" href="/" title="Volver al catálogo" aria-label="Volver al catálogo">← Catálogo</a>` +
    // 3 tabs (radios CSS puros): Controles · Guardados · Config
    `<input type="radio" name="vergis-traytab" id="vergis-tt-controles" class="tray-tabin"${controlesChecked} hidden>` +
    `<input type="radio" name="vergis-traytab" id="vergis-tt-guardados" class="tray-tabin" hidden>` +
    `<input type="radio" name="vergis-traytab" id="vergis-tt-config" class="tray-tabin"${configChecked} hidden>` +
    `<div class="tray-tabs">` +
    `<label for="vergis-tt-controles" class="tray-tablabel tt-controles">Controles</label>` +
    `<label for="vergis-tt-guardados" class="tray-tablabel tt-guardados">Vistas</label>` +
    `<label for="vergis-tt-config" class="tray-tablabel tt-config">Config</label>` +
    `</div>` +
    `<div class="tray-panel tray-panel-controles"><div class="tray-sections">${notasKit}${controlesBody}</div></div>` +
    `<div class="tray-panel tray-panel-guardados"><div class="tray-saved">${guardadosBody}</div></div>` +
    `<div class="tray-panel tray-panel-config">${appearance}<div class="tray-actions"><button type="button" class="tray-print" onclick="window.print()">Imprimir</button></div></div>` +
    // Pie COMÚN a los 3 tabs (fuera de los paneles) → siempre visible, pegado al fondo.
    footer +
    `</aside>` +
    restore
  )
}

/** Sección de la bandeja específica del dashboard: las facetas (catálogo-selector) por filtro. */
function renderDashboardFacets(it: Interactive): string {
  return it.filters
    .map((f) => {
      const rows = it.datasets[f.dataset] ?? []
      const values = [...new Set(rows.map((r) => String(r[f.field] ?? '')))].sort((a, b) => a.localeCompare(b, 'es'))
      const checks = values
        .map((v) => `<label><input type="checkbox" data-field="${escapeHtml(f.field)}" value="${escapeHtml(v)}"> ${escapeHtml(v)}</label>`)
        .join('')
      return (
        `<div class="faceta" data-field="${escapeHtml(f.field)}">` +
        `<div class="faceta-title">${escapeHtml(f.label ?? f.field)}<button type="button" class="faceta-clear" data-field="${escapeHtml(f.field)}">limpiar</button></div>` +
        `<div class="faceta-options">${checks}</div>` +
        `</div>`
      )
    })
    .join('')
}

