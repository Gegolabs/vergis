# Diseño — GH #65 · «Descargar PDF» server-side: endpoint + sidecar WeasyPrint (TX-09)

**Rol:** documento de diseño ejecutable (contrato wingcoding: Fable diseña, Opus implementa en frío).
**Repo:** `Gegolabs/vergis` · working tree `/Users/cesar/wworkspace/productos/vergis` · base `main`.
**Issue:** [#65](https://github.com/Gegolabs/vergis/issues/65) — botón **«Descargar PDF»** junto al CSV (#61): PDF fiel del PI generado en el servidor. Dos piezas: (1) **sidecar** HTML→PDF (WeasyPrint) como contenedor propio del compose, y (2) **endpoint** `/pi-NN/pdf?ctx.*` que renderiza el PI **con la identidad del solicitante** (misma RLS) y lo pasa al sidecar. Sin `VERGIS_PDF_SERVICE_URL`, ni botón ni endpoint (fail-closed).

**Coordinación:** #61 (export CSV) y #114 (chips — ya mergeado) se trabajan en paralelo sobre el render. Este diseño **agrega, no mueve**: no toca `table-runtime.ts`, `render-csv-piece.ts` ni `interactive-script.ts`. La integración es secuencial (el orquestador resuelve el orden de merge).

---

## ¿Qué hay que saber antes de tocar nada? (estado actual, verificado contra `main`)

- **Serving por-consumidor:** `server/routes.ts` — `createRequestHandler(deps)` despacha por URL; la ruta de un PI resuelve `slug` (líneas 146-158): `piBlocked` → 503, `canOpenPi` → 403, `renderReport(report, req.headers, navFromUrl(url))` → HTML. Las sub-rutas por-PI de notas usan el patrón regex `/^\/[^/]+\/(imprimir|notas|comentarios)$/` (línea 119). Una URL `/pi-01/pdf` HOY cae al slug-lookup (`'pi-01/pdf'` no matchea ningún slug) → 404 «Producto de Información no encontrado» — ese es el comportamiento a preservar cuando la feature está apagada.
- **El único punto de render** es `runPi()` en `server/serve-rls.ts` (líneas 419-442): `runSpec({ specPath, identity: identityFor(headers), registerStarters:false, extraCapabilities:[servingCap, renderHtmlPiece, renderCsvPiece, publicarArtefacto], page, ctx, flt })`. La identidad viaja del gate (`X-Forwarded-*` tras oauth2-proxy, mapeada por `createIdentity`) hasta el conector enforcing — **la RLS viaja sola**; el PDF debe pasar por esta misma función, jamás por un camino nuevo.
- **`runSpec`** (`packages/cli/src/run.ts`): `RunOptions` lleva `page/ctx/flt/notas/interactiveMaxRows`; los pasa como `params` al `invoke` de Mira. Devuelve `RunOutcome { html, resolved, freshness, … }`.
- **Mira** (`packages/mira/src/mira.ts`): resuelve controles/filtros/páginas, compone el árbol, materializa `interactions.filters` (facetas client-side) si el total de filas ≤ `interactiveMaxRows`, y llama `render-html-piece` con `{ piece, title: spec.identity.display_name, theme, palette, meta, interactive, pages, controls, carryCtx, notas, filters, fltCarry }`. El comentario de las líneas 180-181 («PDF NO se implementa como render server-side: se cubre con el print-to-PDF del navegador») **queda obsoleto con este issue** y se actualiza.
- **`render-html-piece`** (`packages/capabilities/src/render-html-piece.ts`): compone SIEMPRE el shell de la bandeja (línea 76, incondicional), inyecta CSS por-documento al tope y scripts al final (`TABLE_RUNTIME_SOURCE` si hay tabla interactiva, script de facetas, runtime de notas, script `restore` de paleta/bandeja). La banda de contexto y los chips de filtros ya emiten variantes de print (`.vctx-print`, `.vflt-print`).
- **HTML autocontenido, sin browser:** los charts son **SVG inline** compilados server-side (Vega); el CSS va inline en el `<style>` del theme; el logo del theme `arbol` es **data URI** (`themes/arbol.ts` líneas 9-16); la tipografía es el stack de sistema (`-apple-system, …, sans-serif` — sin webfonts). **No hay ninguna URL externa en el documento** salvo los data: URIs. Verificado en `themes/arbol.ts` y `themes/default.ts`.
- **Print-CSS ya existe:** ambos themes traen `@page { size: A4 landscape; margin: 12mm }` y `@media print` que oculta `.tray, .tray-tab, .tray-toggle`, repinta claro y evita cortes (`break-inside: avoid`) — `arbol.ts` líneas 246-266, `default.ts` 78-83. `piece-css.ts`, `notas-render.ts` y los CSS de chips/contexto/drill también traen reglas print.
- **Por qué NO basta mandar al sidecar el mismo HTML de la página:** (a) el tbody SSR de una tabla interactiva se corta en `TABLE_SSR_MAX_ROWS = 500` (`render-table.ts` líneas 10, 42-43) — el resto lo hidrata el runtime JS, que en WeasyPrint no corre → **PDF incompleto**; (b) el wrapper `.vt-scroll{overflow:auto;max-height:70vh}` de la tabla interactiva **recortaría** la tabla a una pantalla en un motor de print; (c) el HTML de página arrastra payloads JSON embebidos (filas + datasets materializados) que engordan el POST sin aportar nada. La tabla **estática** (rama `interactive:false`/display de `renderTable`, líneas 29-39) no tiene ninguno de los tres problemas: tbody completo, sin scroll-wrapper, sin payload.
- **Colores de charts por paleta:** los hex se hornean en el SVG según la paleta ACTIVA (`resolveChartTokens`) y se abren a CSS vars; el `@media print` repinta fondo/texto pero **no** las vars `--chart-*` → un render en paleta `gruvbox` (dark) produce charts con texto `#ebdbb2` que se lava sobre papel blanco. El theme `arbol` tiene la paleta `blanco` calibrada sobre fondo blanco (líneas 76-83).
- **Sidecar de referencia:** el stack WeasyPrint arm64 ya corre en la instancia GH (fat-image del relay QC①) — la viabilidad está probada allá, pero **este repo no hereda archivos**: el sidecar de acá es autocontenido (`deploy/pdf-sidecar/`, Dockerfile propio). *La lista exacta de paquetes apt de esta receta es conjetura hasta el gate docker (abajo): se escribe desde los requisitos documentados de WeasyPrint ≥ 61 (pango/harfbuzz) y la valida el build.*
- **Convención de nombres del CSV (#61, diseño hermano `diseno-gh61.md` D7):** `slug(título-doc)--slug(tabla)--YYYY-MM-DD[--filtrado].csv`, slug = minúsculas, se eliminan caracteres fuera de `[\wÀ-ÿ -]`, espacios → `-`, separador `--` entre segmentos. El PDF adopta la misma gramática.
- **Botón CSV:** vive en el grupo «Descargar» del **kit por-tabla** que `table-runtime.ts` inyecta client-side en `.tray-sections` (líneas 366-367) — no existe en dashboards sin tabla. Territorio ajeno: no se toca.
- **Config:** `server/config.ts` centraliza los envs (`configFromEnv`, validación numérica). `deploy/compose.reference.yml` es el contrato Producto→Infra (red interna, `expose` sin `ports`, gate D2).

---

## ¿Qué decisiones quedan selladas?

**D1 — Contrato del sidecar: `POST /convert` con `text/html` crudo → `200 application/pdf`; `GET /healthz` → JSON.** El cuerpo del POST es el HTML completo tal cual (UTF-8), sin sobre JSON: evita escapar documentos de MBs y deja el contrato en «un HTML entra, un PDF sale». Respuestas de error con cuerpo `text/plain` en español: `400` (cuerpo vacío), `413` (HTML > `PDF_MAX_HTML_BYTES`, default **20 MiB**), `500` (WeasyPrint falló, con el mensaje). `GET /healthz` → `{"ok":true,"weasyprint":"<versión>"}` (sirve al HEALTHCHECK del contenedor y a diagnóstico). El sidecar es **mudo respecto a identidad**: convierte lo que le llega — la seguridad es que solo Vergis lo alcanza (red interna) y que el HTML ya nació RLS-filtrado.

**D2 — Assets: el HTML viaja 100 % autocontenido; el sidecar NIEGA todo fetch que no sea `data:`.** No hay nada que inlinear porque el render ya es autocontenido (CSS inline, charts SVG inline, logo data URI, fuentes de sistema — verificado arriba). Defensa en profundidad: el `url_fetcher` del sidecar permite **solo** `data:` (delegando en `default_url_fetcher`) y lanza para cualquier otra URL (`http:`, `file:`, …) — un spec malicioso o un markdown con `<img src>` externo no convierte al sidecar en proxy SSRF ni lector de archivos; WeasyPrint registra el recurso fallido y continúa sin él. `base_url=None`.

**D3 — Sidecar: Python 3.12-slim + WeasyPrint y gunicorn PINNEADOS, non-root, sin red saliente; fuentes DejaVu + Liberation.** Imagen `deploy/pdf-sidecar/Dockerfile` autocontenida (base multi-arch `python:3.12-slim-bookworm` — cubre el arm64 de la VM). `pip install weasyprint==63.1 gunicorn==23.0.0` (versiones exactas; renovate las moverá por PR). Fuentes: `fonts-dejavu-core` + `fonts-liberation` — el stack del theme termina en `sans-serif` genérico y Liberation Sans es métricamente compatible con Arial; no se descargan webfonts (imagen offline). Usuario dedicado `uid 10001`, `gunicorn --workers=2 --timeout=60` (el timeout de gunicorn mata un render colgado: el peor caso libera el worker). En el compose el servicio va **solo en la red interna**: sin `ports:`, `expose: ["9090"]` — nadie fuera del compose lo alcanza y él no necesita salir a ninguna parte.

**D4 — El HTML que se manda al sidecar es un RENDER DEDICADO «print» del MISMO pipeline — no el HTML de la página.** Mismo `runPi` (misma identidad, mismos `page/ctx/flt`, misma RLS, mismo árbol resuelto con banner de frescura), pero con `print: true` de punta a punta (`RunOptions.print` → Mira → `RenderParams.print`). En modo print el render: **no** compone el shell de la bandeja ni ningún `<script>` (runtime de tabla, facetas, notas, restore) — para WeasyPrint el script no corre, así que mandar JS solo puede mentir; **no** materializa `interactions.filters` (Mira lo salta: eran datasets para filtrar client-side); **sí** conserva la banda de contexto y los chips de filtros (sus variantes `.vctx-print`/`.vflt-print` imprimen el estado activo — fidelidad: el lector del PDF sabe bajo qué alcance/filtros se generó); **sí** conserva el banner de staleness. El estado que refleja el PDF es el **server-side** (página activa + controles `ctx.*` + filtros `flt.*` de la URL); los filtros client-side del runtime de tabla (búsqueda, facetas por columna) **no** viajan — ese recorte es territorio del CSV «vista actual» (#61), y fingir capturarlo exigiría serializar el estado del browser (otro producto).

**D5 — Tablas en modo print: SIEMPRE estáticas y COMPLETAS, con techo `TABLE_PRINT_MAX_ROWS = 5000` y nota de truncamiento VISIBLE.** `renderTable` con `opts.print` toma la rama estática (tbody completo, sin `.vt-scroll`, sin payload JSON, sin botones de filtro por columna) **ignorando** el tope SSR de 500 — cierra la primera «arruga» del issue. Sin drills (`drills = []` en print: una columna de acciones no clickeable es ruido en papel). Por encima de 5000 filas se corta y se emite una fila final visible: `… mostrando 5000 de N filas — el detalle completo se descarga en CSV`. Racional del techo: un PDF de decenas de miles de filas no es un documento de lectura, es una exportación de datos — y para eso está el CSV; 5000 mantiene el render y la conversión en tiempos sanos. Constante exportada (junto a `TABLE_SSR_MAX_ROWS`), no env: no hay demanda de configurarlo.

**D6 — Paleta de print: el theme declara `printPalette`; en modo print manda sobre la activa.** `Theme.printPalette?: string` (`themes/index.ts`); `arbol` fija `'blanco'` (su juego calibrado sobre fondo blanco); `default` no lo declara (cae a sus tokens únicos). En `render-html-piece`, con `print: true`, la paleta efectiva es `theme.printPalette ?? palette` **antes** de `resolveChartTokens` y del `wrap` — así los hex horneados en los SVG salen calibrados para papel (sin esto, un PI en gruvbox produce charts con texto crema sobre blanco). Cierra la segunda «arruga» (print-CSS) junto con el `@page`/`@media print` ya existente en los themes.

**D7 — Endpoint: `GET /<slug>/pdf?page=…&ctx.*=…&flt.*=…` con EXACTAMENTE los gates de la página.** En `routes.ts`, un match `/^\/([^/]+)\/pdf$/` **solo se intercepta si `deps.renderPdf` está inyectado**; sin él, la URL cae al slug-lookup y responde el mismo 404 de hoy — superficie idéntica sin la env (mismo patrón que Miranda flag-off). Con él: gate-token global (ya aplicado arriba), gate `ready`, resolver el report por slug (404 si no existe), `piBlocked` → 503 con motivo, `canOpenPi` → 403; luego `renderPdf(report, headers, nav)` → `200` con `content-type: application/pdf`, `content-disposition: attachment; …`, `cache-control: no-store`. Sin CSRF (GET de descarga, sin mutación de estado).

**D8 — Fail-closed en dos planos: sin env NO existe la feature; con env y sidecar caído, 503 con mensaje claro (jamás un 500 pelado).** `VERGIS_PDF_SERVICE_URL` vacío ⇒ `renderPdf` no se inyecta y `pdfUrl` no viaja al render ⇒ ni botón ni endpoint (el binario botón↔endpoint es el MISMO if — imposible ofrecer un botón muerto). Con env: el cliente del sidecar (`server/pdf.ts`) usa `fetch` con `AbortSignal.timeout(VERGIS_PDF_TIMEOUT_MS`, default **30 000 ms**`)`; conexión rechazada, timeout o respuesta no-200 lanzan `PdfUnavailableError` con el detalle → la ruta responde **503** «La generación de PDF no está disponible en este momento (el servicio de conversión no respondió). Intenta de nuevo o usa Imprimir.» y loguea el detalle técnico server-side (URL del sidecar, status, causa — nunca en la respuesta al consumidor). Cualquier otro error (render del PI) sigue el camino 500 estándar del router.

**D9 — El botón es un GRUPO «Descargar» server-rendered en el tab Controles de la bandeja, a nivel de DOCUMENTO.** `RenderParams.pdfUrl?: string` (el server lo puebla con `/​<slug>/pdf` cuando la feature está ON y el render NO es print). El render emite, al final de las secciones server-side de `.tray-sections` (tras notas/filtros/facetas): `<div class="faceta tray-descargar"><div class="faceta-title">Descargar</div><a class="tray-pdfbtn" href="…">Descargar PDF</a></div>` con `title` explicativo («El documento completo como PDF, con la vista y filtros actuales del servidor»). El href preserva la navegación server-side: `pdfUrl + '?' + (page activa + ctxQuery(carry) + fltQuery(flt))` (sin query, el href es `pdfUrl` pelado). **Por qué no dentro del grupo «Descargar» del kit CSV:** ese grupo lo crea `table-runtime.ts` client-side y es POR-TABLA (no existe en dashboards sin tabla, y hay N con N tablas) — el PDF es por-DOCUMENTO y debe ofrecerse también donde no hay tablas; meterlo al kit exigiría tocar territorio de #61. Conviven en el mismo tab Controles; el costo aceptado es que en un PI con tabla aparecen dos rótulos «Descargar» (documento vs. tabla — distinción real, no redundancia). La sección cuenta como maquinaria (`controlesHasMachinery`), para que el tab por defecto aterrice donde está el botón. En print/PDF el botón no existe (el shell no se compone) y en el print del browser lo oculta el `@media print` de la bandeja.

**D10 — Nombre del archivo: `slug(título-doc)[--slug(página-activa)]--YYYY-MM-DD[--filtrado].pdf` — la gramática de #61.** Mismo slug (minúsculas, `[^\wÀ-ÿ -]` fuera, espacios → `-`), mismo separador `--`, misma fecha (la del día, `toISOString().slice(0,10)`). El segmento página aparece solo en PI multi-vista (identifica QUÉ vista congela el PDF; se usa el id de página, ya slug-ish); `--filtrado` aparece si hay `flt.*` activos en la URL (el PDF no es el documento completo). Título = `report.name` (el `display_name` del spec vía discovery — mismo dato que usa el catálogo). Función pura `pdfFilename(docTitle, page, dateISO, filtered)` en `server/pdf.ts`, testeada; independiente de `vtCsvName` de #61 (que puede no estar mergeada al implementar — la unificación en una sola función slug es candidata post-integración, anotada, no bloqueante). `Content-Disposition` con fallback ASCII + RFC 5987: `attachment; filename="<sin-no-ASCII>"; filename*=UTF-8''<encodeURIComponent(nombre)>` (los slugs conservan acentos `À-ÿ`).

**D11 — Config del motor: `VERGIS_PDF_SERVICE_URL` y `VERGIS_PDF_TIMEOUT_MS` entran por `config.ts`.** `ServerConfig.pdf: { serviceUrl: string; timeoutMs: number }` — `serviceUrl` = env recortado o `''` (off), `timeoutMs` vía `num(env,'VERGIS_PDF_TIMEOUT_MS',30000)` (valida NaN como el resto). No entra a `deployment-check` (no referencia paths montados). Los envs del sidecar (`PDF_MAX_HTML_BYTES`, `PORT`) viven en su contenedor con defaults sanos.

**D12 — `compose.reference.yml` documenta el sidecar como servicio de red interna, y la env en `vergis`.** Servicio `vergis-pdf` con `build: ./pdf-sidecar` (comentando que la instancia vendorea `deploy/pdf-sidecar/` de este repo o usa la imagen publicada cuando exista), `restart: unless-stopped`, `expose: ["9090"]`, **sin** `ports:`. En `vergis.environment`: `VERGIS_PDF_SERVICE_URL: http://vergis-pdf:9090` con comentario del fail-closed («quitar el servicio + esta env apaga la feature entera: ni botón ni endpoint»). Publicar la imagen a ghcr (CI) queda fuera de alcance — se documenta el `docker build` manual.

**D13 — El render del PDF NO lleva capa de notas.** `runPi` para PDF va **sin** `notasWiring`: sin kit de notas, sin marcadores, sin CSRF embebido. Las notas tienen su propio artefacto congelado (`/impresiones`, vergis#84) con otras garantías (documento congelado vs. dato de hoy); mezclar marcadores vivos en un PDF estático prometería interacción que el papel no tiene.

**D14 — El DSL no cambia: `render: [{format: pdf}]` sigue siendo inválido.** El PDF es un canal de DESCARGA on-demand del serving (endpoint + botón), no un render de delivery del spec — un PI no «declara» PDF, lo ofrece la plataforma cuando la instancia monta el sidecar. Se actualizan los comentarios/remediaciones que hoy dicen «PDF = print-to-PDF del navegador» (`mira.ts` líneas ~180-181 y ~214, `dsl/validate.ts` ~498) para nombrar el camino real («la plataforma ofrece Descargar PDF server-side vía sidecar; el formato de delivery sigue siendo html/csv») — Norma «sin rastros evolutivos»: el texto describe el estado final, no la historia.

---

## ¿Qué reglas duras rigen la implementación?

- **NO tocar** `packages/capabilities/src/table-runtime.ts`, `render-csv-piece.ts`, `interactive-script.ts`, `notas-render.ts` ni nada del territorio de #61/#114. Si un cambio parece necesitarlos, es señal de diseño violado: parar y reportar.
- **La identidad del PDF es la del request, siempre.** El render del PDF pasa por `runPi(report, headers, …)` con los MISMOS headers del gate — jamás una identidad de servicio, jamás `registerStarters: true`, jamás un camino de datos alternativo.
- **CERO dependencias npm nuevas** (el cliente del sidecar usa el `fetch` global de Node 22). El sidecar pinnea sus dependencias pip exactas.
- **Fail-closed simétrico:** el `if` que inyecta `renderPdf` en las deps del router y el que puebla `pdfUrl` en el render salen del MISMO valor de config (`config.pdf.serviceUrl !== ''`). Prohibido introducir un flag adicional que los desalinee.
- **Nada de estado en el sidecar:** sin disco, sin cola, sin caché. Un POST, un PDF, adiós.
- **UI en español**; mensajes de error del endpoint sin URLs internas ni stack traces (el detalle va al log del server).
- **No ampliar alcance:** sin PDFs programados/enviados (no-objetivo del issue), sin Chromium/headless, sin publicar imagen a ghcr en este issue, sin export de notas, sin tocar el `docker-compose.yml` raíz (modo Free: sin sidecar).
- **Aserciones de tests existentes intactas.** Si un test vigente se pone rojo, se corrige el código, no el test.

---

## ¿Cuáles son las tareas, su territorio y su «hecho cuando»?

### T1 — Modo print del pipeline de render

**Territorio exacto:** `packages/capabilities/src/piece-types.ts` · `packages/capabilities/src/render-table.ts` · `packages/capabilities/src/render-html-piece.ts` · `packages/capabilities/src/themes/index.ts` · `packages/capabilities/src/themes/arbol.ts` · `packages/mira/src/mira.ts` · `packages/mira/src/dsl/validate.ts` (solo strings de remediación) · `packages/cli/src/run.ts` · `tests/pdf-print-render.test.ts` (nuevo).

1. `piece-types.ts`: `RenderParams.print?: boolean` y `RenderParams.pdfUrl?: string` (doc-comment: D4/D9); `RenderOpts.print?: boolean`.
2. `themes/index.ts`: `Theme.printPalette?: string` (doc-comment: D6). `themes/arbol.ts`: `printPalette: 'blanco'`.
3. `render-table.ts`: exportar `TABLE_PRINT_MAX_ROWS = 5000`. Al inicio de `renderTable`, si `opts.print`: rama estática con `rows.slice(0, TABLE_PRINT_MAX_ROWS)`, `drills` vacíos, y si `rows.length > TABLE_PRINT_MAX_ROWS` una fila final `<tr class="vt-trunc"><td colspan="${cols.length}">… mostrando ${TABLE_PRINT_MAX_ROWS} de ${rows.length} filas — el detalle completo se descarga en CSV</td></tr>` (celda con estilo discreto vía clase; CSS mínimo en el propio módulo o junto al resto de consts de `render-html-piece`). No se tocan `signals` (quedan en false → sin runtime/CSS interactivo).
4. `render-html-piece.ts`: destructurar `print` y `pdfUrl`. Con `print`: paleta efectiva `theme.printPalette ?? palette` (antes de `resolveChartTokens`/`chartVarMap` y pasada al `wrap`); `opts.print = true`; NO componer `renderTrayShell` ni `restore`, NO anexar ningún `<script>` (runtime de tabla, interactivo, notas); mantener banda de contexto, chips, nav de páginas y CSS asociados. Agregar a `PAGES_NAV_CSS`: `@media print{.vpages{border-bottom:none}.vpages a{display:none}.vpages a.active{display:inline-block;border:none;padding:0 0 6px;font-size:12px}}` (en papel solo se nombra la vista activa; aplica también al print del browser).
5. `mira.ts`: leer `const print = ctx.params?.['print'] === true` y `const pdfUrl = ctx.params?.['pdfUrl'] as string | undefined`; con `print`, saltar la materialización de `interactions.filters` (log `mira-interaction-skipped` con razón `print`); pasar `print` y `pdfUrl` a `renderHtml` → params del capability call. Actualizar los comentarios de líneas ~180-181/~214 y la remediación de `validate.ts` ~498 según D14.
6. `run.ts`: `RunOptions.print?: boolean` y `RunOptions.pdfUrl?: string` (doc-comments); pasarlos en `params` del `invoke`.

**Hecho cuando:** `npx vitest run tests/pdf-print-render.test.ts` verde con estos casos (patrón del repo: `runSpec`/`renderHtmlPiece.execute` con capabilities fake, aserciones sobre el HTML):
- print con tabla de 600 filas → el HTML contiene las 600 (`<tr` count) y NO contiene `vtable-data`, `TABLE_RUNTIME` ni `<script`; la misma spec sin print corta en 500 y sí trae runtime.
- print con 5001+ filas → 5000 filas + la fila `vt-trunc` con «mostrando 5000 de N».
- print → sin `id="vergis-tray-toggle"`, sin `class="tray"`, sin `<script`; con control/filtro activo → los spans `.vctx-print`/`.vflt-print` presentes.
- print con theme `arbol` y paleta `gruvbox` → el SVG del chart hornea los hex del juego `blanco` (`chartBar` `#2563eb`, no el `#b8bb26` de gruvbox) y el `<html>` sale con `data-palette="blanco"`.
- `npm run typecheck` verde.

### T2 — Botón «Descargar PDF» en la bandeja

**Territorio exacto:** `packages/capabilities/src/render-html-piece.ts` (sección + CSS const nuevo) · `tests/pdf-boton.test.ts` (nuevo).

1. En `render-html-piece.ts` (solo cuando NO print y `pdfUrl` presente): componer la sección de D9 al final de las secciones server-side del tab Controles (`sections = trayFilters + facets + descargarSection` en el ensamblado que alimenta `renderTrayShell`); `controlesHasMachinery` incluye `!!descargarSection`. Href: `const q = (pages ? '&page=' + encodeURIComponent(pages.active) : '') + ctxQuery(carry) + fltQuery(flt); const href = q ? pdfUrl + '?' + q.slice(1) : pdfUrl` (mismos helpers `ctxQuery`/`fltQuery` del módulo). Escapar con `escapeHtml`.
2. Const `TRAY_PDF_CSS` (junto a los demás CSS del módulo, inyectado solo si hay sección): `.tray .tray-pdfbtn{display:block;width:100%;box-sizing:border-box;text-align:center;padding:8px;font-size:12px;background:var(--card,#fff);color:var(--fg-dim,#64748b);border:1px solid var(--border,#e2e8f0);border-radius:7px;text-decoration:none}.tray .tray-pdfbtn:hover{color:var(--green,#16a34a);border-color:var(--green,#16a34a)}` (paridad visual con `.vt-export`, sin tocar `piece-css.ts`).

**Hecho cuando:** `npx vitest run tests/pdf-boton.test.ts` verde:
- con `pdfUrl: '/pi-01/pdf'`, página activa `resumen`, ctx `{oc:'123'}` y flt `{tipo:['a']}` → el HTML trae `href="/pi-01/pdf?page=resumen&ctx.oc=123&flt.tipo=a"` dentro de un `.faceta.tray-descargar` con título «Descargar».
- sin `pdfUrl` → cero ocurrencias de `tray-pdfbtn`/`tray-descargar` (superficie idéntica a hoy).
- con `print: true` y `pdfUrl` → tampoco aparece.
- dashboard SIN tabla ni filtros pero con `pdfUrl` → la sección existe y el tab Controles queda `checked` (no el empty-state como default).

### T3 — Endpoint `/pi-NN/pdf`: cliente del sidecar + ruta + wiring

**Territorio exacto:** `server/pdf.ts` (nuevo) · `server/routes.ts` · `server/config.ts` · `server/serve-rls.ts` · `tests/pdf-endpoint.test.ts` (nuevo) · `tests/pdf-client.test.ts` (nuevo) · `tests/config.test.ts` (solo agregar casos).

1. `server/config.ts`: `ServerConfig.pdf: { serviceUrl: string; timeoutMs: number }` según D11.
2. `server/pdf.ts` (módulo puro, testeable sin serve-rls):
   - `export class PdfUnavailableError extends Error` (lleva `detail` para el log).
   - `export function pdfFilename(docTitle: string, page: string | undefined, dateISO: string, filtered: boolean): string` — D10 (slug local con la regla de plataforma; segmento página omitido si vacío o igual al slug del título).
   - `export function contentDisposition(filename: string): string` — fallback ASCII + `filename*=UTF-8''…`.
   - `export function createPdfClient(opts: { serviceUrl: string; timeoutMs: number }): (html: string) => Promise<Uint8Array>` — `fetch(serviceUrl.replace(/\/$/,'') + '/convert', { method:'POST', headers:{'content-type':'text/html; charset=utf-8'}, body: html, signal: AbortSignal.timeout(timeoutMs) })`; no-200/red/timeout → `PdfUnavailableError` con detalle (status + primeros bytes del cuerpo); 200 → `new Uint8Array(await res.arrayBuffer())`.
3. `server/routes.ts`: `RouteDeps.renderPdf?: (report: Report, headers: GateHeaders, nav: ReturnType<typeof navFromUrl>) => Promise<{ pdf: Uint8Array; filename: string }>`. Tras el gate `ready` y `const all = deps.discover()` (antes del branch del índice o junto al slug-lookup): `const pdfM = url.match(/^\/([^/]+)\/pdf$/)`; si matchea **y** `deps.renderPdf` existe: resolver report por `pdfM[1].toLowerCase()` (404 si no está), `blockedReason` → 503, `canOpenPi` → 403 (mismos textos que la página), luego `deps.renderPdf(report, req.headers as GateHeaders, navFromUrl(req.url ?? '/'))` → `writeHead(200, { 'content-type':'application/pdf', 'content-disposition': …, 'cache-control':'no-store' })` + `end(Buffer.from(pdf))`. `catch`: `PdfUnavailableError` → `fail(res, 503, mensaje D8)` + `console.error` del detalle; otro → `fail(res, 500, …)` como el render normal. Sin `renderPdf`, el match NO intercepta (cae al slug-lookup → 404 de hoy). El `content-disposition` viaja armado desde el dep (routes no importa pdf.ts para tipos de error: exportar `PdfUnavailableError` desde `server/pdf.ts` e importarla en routes — import type-safe, sin ciclo).
4. `server/serve-rls.ts`: `runPi` acepta `opts?: { print?: boolean }` y agrega a `runSpec`: `print: opts?.print`, `pdfUrl: config.pdf.serviceUrl && !opts?.print ? '/' + report.slug + '/pdf' : undefined`. Wiring: `const renderPdf = config.pdf.serviceUrl ? (async (report, headers, nav) => { const out = await runPi(report, headers, nav, undefined, { print: true }); const client = createPdfClient({ serviceUrl: config.pdf.serviceUrl, timeoutMs: config.pdf.timeoutMs }); const filtered = !!nav.flt && Object.keys(nav.flt).length > 0; return { pdf: await client(out.html ?? ''), filename: pdfFilename(report.name, nav.page, new Date().toISOString().slice(0,10), filtered) } }) : undefined` — inyectado en `createRequestHandler`. Log de arranque: `[vergis-rls] PDF server-side activo → <serviceUrl>` cuando ON.

**Hecho cuando:** `npx vitest run tests/pdf-endpoint.test.ts tests/pdf-client.test.ts tests/config.test.ts` verde:
- `pdf-endpoint.test.ts` (patrón `routes.test.ts`: req/res fakes): sin `renderPdf` → `/qw-04/pdf` responde 404 «Producto de Información no encontrado» (superficie de hoy); con `renderPdf` → 200, `content-type: application/pdf`, `content-disposition` con el filename esperado y el binario del fake; `canOpenPi:false` → 403; `piBlocked` → 503; `renderPdf` que lanza `PdfUnavailableError` → 503 con «no está disponible» (y NUNCA el detalle interno en el body); slug inexistente → 404.
- `pdf-client.test.ts` (sidecar fake: `node:http` en puerto efímero): 200 con bytes `%PDF-…` → los devuelve; 500 del fake → `PdfUnavailableError`; servidor caído (puerto cerrado) → `PdfUnavailableError`; timeout (fake que nunca responde, `timeoutMs: 100`) → `PdfUnavailableError` en <2 s. Además `pdfFilename`: `('Reporte Facturas', undefined, '2026-08-06', false)` → `reporte-facturas--2026-08-06.pdf`; con página `detalle` → `reporte-facturas--detalle--2026-08-06.pdf`; con `filtered` → sufijo `--filtrado`; título con tildes conservadas; `contentDisposition` con fallback ASCII + RFC 5987.
- `config.test.ts` (agregar): sin env → `pdf.serviceUrl===''`, `timeoutMs===30000`; con envs → poblados; `VERGIS_PDF_TIMEOUT_MS=abc` → lanza.

### T4 — Sidecar WeasyPrint + compose de referencia (puede ir en paralelo con T1-T3)

**Territorio exacto:** `deploy/pdf-sidecar/Dockerfile` (nuevo) · `deploy/pdf-sidecar/app.py` (nuevo) · `deploy/compose.reference.yml` · `scripts/pdf-sample.ts` (nuevo, instrumento del gate).

1. `deploy/pdf-sidecar/app.py` — WSGI puro (stdlib + weasyprint), contrato D1/D2:

```python
"""Sidecar HTML→PDF de Vergis (issue #65, TX-09).

Contrato: POST /convert (cuerpo text/html UTF-8, autocontenido) → 200 application/pdf.
GET /healthz → {"ok": true, "weasyprint": "<versión>"}. Errores 400/413/500 en text/plain.
Sin estado, sin disco, sin red saliente: el url_fetcher solo admite data: URIs (los assets
del render de Vergis viajan embebidos); cualquier otra URL se bloquea y WeasyPrint continúa
sin ese recurso (defensa SSRF/file:// fail-closed).
"""
import json
import logging
import os

import weasyprint
from weasyprint import HTML, default_url_fetcher

MAX_BYTES = int(os.environ.get("PDF_MAX_HTML_BYTES", str(20 * 1024 * 1024)))
logging.basicConfig(level=logging.INFO)


def fetcher(url, *args, **kwargs):
    if url.startswith("data:"):
        return default_url_fetcher(url, *args, **kwargs)
    raise ValueError("recurso externo bloqueado: " + url[:120])


def _plain(start_response, status, text):
    body = text.encode("utf-8")
    start_response(status, [("Content-Type", "text/plain; charset=utf-8"), ("Content-Length", str(len(body)))])
    return [body]


def app(environ, start_response):
    path, method = environ.get("PATH_INFO", ""), environ.get("REQUEST_METHOD", "")
    if path == "/healthz" and method == "GET":
        body = json.dumps({"ok": True, "weasyprint": weasyprint.__version__}).encode()
        start_response("200 OK", [("Content-Type", "application/json"), ("Content-Length", str(len(body)))])
        return [body]
    if path == "/convert" and method == "POST":
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return _plain(start_response, "400 Bad Request", "cuerpo vacío: se espera el HTML del documento (text/html).")
        if length > MAX_BYTES:
            return _plain(start_response, "413 Payload Too Large", f"HTML de {length} bytes supera el tope de {MAX_BYTES}.")
        html = environ["wsgi.input"].read(length).decode("utf-8", errors="replace")
        try:
            pdf = HTML(string=html, base_url=None, url_fetcher=fetcher).write_pdf()
        except Exception as e:  # noqa: BLE001 — el borde del servicio reporta, no clasifica
            logging.exception("conversión falló")
            return _plain(start_response, "500 Internal Server Error", f"weasyprint: {e}")
        start_response("200 OK", [("Content-Type", "application/pdf"), ("Content-Length", str(len(pdf)))])
        return [pdf]
    return _plain(start_response, "404 Not Found", "rutas: POST /convert · GET /healthz")
```

2. `deploy/pdf-sidecar/Dockerfile` — D3 (los nombres apt exactos los ratifica el gate docker; si el build falla por un paquete, se ajusta el nombre, no la estrategia):

```dockerfile
# Sidecar HTML→PDF de Vergis (WeasyPrint) — issue #65. Autocontenido: se construye desde este
# directorio, sin heredar imágenes de otras instancias. Multi-arch (amd64/arm64 vía base oficial).
# Sin red saliente en runtime: el HTML llega autocontenido y el url_fetcher bloquea todo salvo data:.
FROM python:3.12-slim-bookworm

# Librerías nativas de WeasyPrint (pango/harfbuzz) + fuentes offline: DejaVu (cobertura) y
# Liberation (sans métricamente compatible con Arial — el stack del theme termina en sans-serif).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libharfbuzz-subset0 \
      shared-mime-info fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir weasyprint==63.1 gunicorn==23.0.0

RUN useradd --system --uid 10001 --no-create-home pdf
WORKDIR /srv
COPY app.py .
USER pdf
EXPOSE 9090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["python", "-c", "import urllib.request;urllib.request.urlopen('http://127.0.0.1:9090/healthz', timeout=4)"]
# --timeout mata un render colgado y recicla el worker (backstop del timeout del cliente Vergis).
CMD ["gunicorn", "--bind=0.0.0.0:9090", "--workers=2", "--timeout=60", "--access-logfile=-", "app:app"]
```

3. `deploy/compose.reference.yml`: agregar el servicio `vergis-pdf` (D12) y, en `vergis.environment`, `VERGIS_PDF_SERVICE_URL: http://vergis-pdf:9090` con su comentario de fail-closed. Comentar en el servicio: solo red interna (`expose`, jamás `ports`), y que el directorio `pdf-sidecar/` se vendorea desde `deploy/pdf-sidecar/` del repo del producto.
4. `scripts/pdf-sample.ts` — instrumento del gate manual (~15 líneas): corre `runSpec` sobre un spec de `examples/` con `print: true` y escribe el HTML a la ruta que se le pasa (`npx tsx scripts/pdf-sample.ts examples/<spec>.yaml /tmp/pi-sample.html`). Comentario en el header: «instrumento del gate docker de #65».

**Hecho cuando:** los tres gates del repo verdes (el sidecar no compila en ellos, pero compose/scripts no deben romper nada) **y** el bloque de `compose.reference.yml` pasa `docker compose -f deploy/compose.reference.yml config -q` si hay docker disponible en el entorno del ejecutor; si no lo hay, se declara y queda cubierto por el gate manual. La conversión REAL es el **gate manual diferido** (abajo).

### T5 — Cierre

**Territorio exacto:** ninguno nuevo (verificación + PR).

**Hecho cuando:** `npm run typecheck && npm test && npm run build` verdes en la rama; PR con `Closes #65`, resumen de decisiones D1-D14 y la sección «gate manual pendiente» con los comandos de abajo.

### ¿En qué orden?

T1 → T2 → T3 (secuencial: T2 usa el modo de T1; T3 usa runPi con print). **T4 es independiente** (territorio disjunto: deploy/ + scripts/) y puede correr en paralelo. T5 al final sobre la combinación. Un solo frente/subagente es aceptable (el volumen es mediano); si se paraleliza, T4 en su propio worktree y comandos destructivos acotados por ruta.

---

## ¿Quién es el juez?

1. `npm run typecheck` · `npm test` · `npm run build` — los tres gates del repo, verdes.
2. Los tests nuevos: `tests/pdf-print-render.test.ts`, `tests/pdf-boton.test.ts`, `tests/pdf-endpoint.test.ts`, `tests/pdf-client.test.ts` (este último con **sidecar fake HTTP real** en puerto efímero — el contrato de red se prueba de verdad, no con mocks de fetch).
3. Los tests existentes **sin modificar aserciones** — en particular `tests/routes.test.ts` (la superficie sin env debe seguir idéntica), `tests/table-ssr-threshold.test.ts`, `tests/interactive-max-rows.test.ts`, `tests/config.test.ts`.
4. **Gate manual diferido (humano + docker)** — declarado desde el diseño porque el CI no tiene docker ni WeasyPrint; SIN este gate el issue no se considera verificado end-to-end, solo integrado:

```bash
# 1 · construir y levantar el sidecar (en la máquina de César o la VM)
docker build -t vergis-pdf:dev deploy/pdf-sidecar
docker run --rm -d -p 127.0.0.1:9090:9090 --name vergis-pdf-gate vergis-pdf:dev
curl -s http://127.0.0.1:9090/healthz          # → {"ok":true,"weasyprint":"63.1"}
# 2 · producir el HTML de print de un PI de ejemplo y convertirlo
npx tsx scripts/pdf-sample.ts examples/<spec>.yaml /tmp/pi-sample.html
curl -sf -X POST --data-binary @/tmp/pi-sample.html \
     -H 'content-type: text/html; charset=utf-8' \
     http://127.0.0.1:9090/convert -o /tmp/pi-sample.pdf && open /tmp/pi-sample.pdf
docker rm -f vergis-pdf-gate
```

   **Checklist del ojo humano sobre el PDF** (cada punto es una hipótesis que este gate puede refutar — hasta entonces son conducta documentada de WeasyPrint, no medida aquí): charts SVG inline visibles y con colores de la paleta de print; logo (data URI) presente; SIN bandeja/uña/botones; tabla completa (>500 filas) con cortes de página sanos; tildes/ñ correctas con las fuentes de la imagen; layout de grid razonable (WeasyPrint soporta grid desde v61 de forma parcial — si un dashboard denso se deforma, la mitigación es CSS print adicional en el theme, no cambiar de motor); A4 landscape con márgenes del `@page`.

---

## ¿Qué riesgos quedan y cómo se mitigan?

- **Fidelidad WeasyPrint (grid/SVG/fuentes)** — el riesgo central. Mitigado por: los themes ya son print-aware, el modo print elimina la maquinaria (scripts, scroll-wrappers, bandeja) que más se presta a diferencias, y el **gate manual** con checklist explícito. *No verificado hasta el gate:* que WeasyPrint renderice bien los SVG inline de Vega y el grid de `.layout-grid`. Si el grid se deforma, el remedio es CSS `@media print` en los themes (territorio propio, barato).
- **`@media print` como mecanismo:** WeasyPrint renderiza con media type `print` por defecto (documentación oficial de WeasyPrint) — por eso el print-CSS existente aplica sin banderas. El gate lo confirma con un síntoma observable: si el PDF trajera la bandeja, la hipótesis era falsa.
- **Paquetes apt del Dockerfile** — conjetura razonada (requisitos documentados de WeasyPrint ≥ 61 sobre bookworm); el `docker build` del gate la ratifica o ajusta nombres.
- **PDFs pesados / sidecar saturado:** techo de 5000 filas por tabla (D5), sin materialización de datasets (D4), tope 20 MiB en el sidecar (D1), 2 workers + `--timeout=60` (D3) y timeout de 30 s en el cliente (D8). El peor caso degrada a un 503 claro, nunca cuelga el motor.
- **Doble rótulo «Descargar»** en PIs con tabla (grupo documento + grupo del kit CSV) — trade-off aceptado en D9 con racional (documento ≠ tabla); si tras la integración con #61 molesta, la unificación es un follow-up de TX-11 que exigirá tocar `table-runtime` (fuera de este issue por regla dura).
- **Colisión de integración con #61:** este diseño no comparte líneas con el delta de #61 (kit del runtime / render-csv-piece); el único archivo común potencial es `render-html-piece.ts` con #114 (chips, ya en main — este diseño se escribió sobre ese estado). Integración secuencial del orquestador.
- **`report.name` como título del archivo** — es el nombre que ya usa el catálogo; *se asume* equivalente al `display_name` del spec en todos los specs vivos (si difiere, el filename difiere del `<title>` del documento: cosmético, no funcional).

---

*Diseño GH#65 · Fable · 2026-08-06 · cluster work/002-cluster-requests-2026-08*
