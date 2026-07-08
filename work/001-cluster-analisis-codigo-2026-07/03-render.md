# Frente 03 · Capabilities de render

**Ámbito:** `packages/capabilities/src/` — render-html-piece (957 LOC), render-csv-piece, table-runtime (550 LOC), markdown, publicar-artefacto, themes/ (default, arbol, index).

---

## Tanda Opus 4.8 — concluida

**1. [ALTA] · rendimiento — Tabla grande: re-render total por keystroke, sin debounce, sin paginación/virtualización, payload JSON sin techo**
`table-runtime.ts:315, 504-512` · `render-html-piece.ts:897`. El código anticipa tablas de "cientos de miles de filas" pero: (a) el JSON embebido lleva SIEMPRE todas las filas (con 200k pesa decenas de MB); (b) `render()` reconstruye el tbody completo (`tbody.innerHTML = vtBodyRows(...)`) de todas las filas filtradas; (c) la búsqueda global dispara `render()` en cada tecla sin debounce. `TABLE_SSR_MAX_ROWS=500` solo protege el primer paint.
*Mejora:* debounce (~150ms) en búsqueda (S); render acotado del tbody (paginación/windowing) reutilizando `vtApply` (M); techo de filas del payload con fail-loud (S).

**2. [MEDIA] · corrección — Drift real entre los TRES formateadores: `percent` se rompe al filtrar**
`render-html-piece.ts:607-611` vs `:942-957` vs `table-runtime.ts:87-98`. Tres copias del formateador: `formatValue` (server), `vtFormat` (runtime), `fmt` (script interactivo, solo `percent_1`/`int_0`). Un KPI `format: 'percent'` renderiza "43%" en server, pero al tocar una faceta el recompute cae a `String(v)` y muestra "0.43". El drift que el comentario "MANTENER EN SINCRONÍA" temía ya ocurrió.
*Mejora:* eliminar `fmt` y reutilizar `vtFormat` (ya viaja al browser vía `PURE_FNS`). Esfuerzo **S**.

**3. [MEDIA] · corrección — El flag `searchable` está muerto y la búsqueda matchea campos ocultos (incl. tokens de anotación)**
`render-html-piece.ts:860` · `table-runtime.ts:108-116`. `colMeta` resuelve `searchable` pero `vtApply` hace `for (const k in r)` sobre TODAS las propiedades — incluidas claves de drill y `ann.tokenField`/`ann.keyField`. Consecuencias: `searchable:false` no tiene efecto; una búsqueda puede matchear por contenido invisible. `state.colSearch` es código muerto.
*Mejora:* iterar solo los `cols` con `searchable !== false`; borrar/cablear `colSearch`. Esfuerzo **S**.

**4. [MEDIA] · corrección — Documento con 2+ tablas: las "Vistas guardadas" se pisan y el badge del inspector es compartido**
`table-runtime.ts:216, 546` · `render-html-piece.ts:657, 684-687`. Cada `vtBootstrap` llama `vergisSavedViews` que hace `wrap.innerHTML=...` sobre el ÚNICO `.tray-saved`: la segunda tabla destruye la UI de la primera, comparten clave de localStorage, y el badge `#vergis-count` lo escriben dashboard y tablas (gana el último).
*Mejora:* índice estable por `.vtable` (`data-vt="0..n"`), namespace en storage, sección con título de tabla. Esfuerzo **M**.

**5. [MEDIA] · seguridad — Inyección de JS en handlers inline vía comilla simple en ids/keys de controles (`escapeHtml` no escapa `'`)**
`render-html-piece.ts:365, 372, 382` · `markdown.ts:19-25`. Los handlers embeben el id dentro de un string JS de comillas simples: `u.searchParams.append('ctx.${escapeHtml(c.id)}',...)`. `escapeHtml` escapa `&<>"` pero NO `'`, así que un `c.id` con comilla simple cierra el literal y ejecuta JS arbitrario. Rompe el invariante "spec no confiable".
*Mejora:* `JSON.stringify('ctx.'+c.id)` en los tres sitios; agregar `'`→`&#39;` a `escapeHtml`. Esfuerzo **S**.

**6. [MEDIA] · seguridad — CSV sin mitigación de formula injection**
`render-csv-piece.ts:59-68`. `rawValue`/`csvField` no neutralizan valores que empiezan con `= + - @`, tab o CR: una celda con `=HYPERLINK(...)` se ejecuta al abrir en Excel/Sheets. Los datos vienen de filas RLS-filtradas (terceros).
*Mejora:* prefijar con `'` los campos que empiecen con caracteres de fórmula. Esfuerzo **S**.

**7. [MEDIA] · seguridad — `publicar-artefacto`: escritura de archivos arbitraria sin contención al baseDir**
`publicar-artefacto.ts:21-24`. Acepta `p.path` absoluto o con `..` y escribe donde sea + `mkdirSync recursive`. Primitiva de path traversal. El comentario lo declara stub, pero ya corre en la plataforma.
*Mejora:* resolver contra `baseDir` y verificar `resolved.startsWith(base+sep)`. Esfuerzo **S**.

**8. [MEDIA] · corrección — Reproducibilidad byte-idéntica: `localeCompare` sin locale en el orden de facetas**
`render-html-piece.ts:584`. `renderDashboardFacets` ordena con `a.localeCompare(b)` sin locale → depende de `LANG`/ICU del proceso: mismo spec+datos puede producir HTML con opciones en distinto orden. Riesgo adicional: `Intl.DateTimeFormat('es-CL')` y tz varían con ICU/tzdata entre versiones de Node.
*Mejora:* `a.localeCompare(b, 'es')` o `Intl.Collator('es')` fijo; documentar/fijar versión de Node. Esfuerzo **S**.

**9. [MEDIA] · estructura — El monolito render-html-piece.ts: corte propuesto**
957 LOC mezclando 6 responsabilidades (~250 líneas de CSS = 26%, orquestación, renderers por tipo, pipeline de charts, render de tablas, JS inline del dashboard). Corte sin cambiar API pública: `piece-css.ts`, `format.ts` (unificado con `vtFormat`), `piece-chart.ts`, `piece-table.ts`, `piece-tray.ts`; queda `render-html-piece.ts` con tipos + `renderNode` + capability (~150 LOC). Esfuerzo **M**.

**10. [MEDIA] · estructura — Duplicación server/cliente del render de filas: 5 pares espejo a mano**
`render-html-piece.ts:795-838, 926-931` vs `table-runtime.ts:235-267`. `ctxQuery`/`vtCtxQuery`, `serverDrillHref`/`vtDrillHref`, `drillActionsCell`/`vtDrillActions`, `renderTableBody`/`vtBodyRows`, `colorscaleBg`/`vtColorBg` (y cuatro escapers). Cualquier cambio hay que hacerlo dos veces.
*Mejora:* mover las 5 funciones de fila a `table-runtime.ts` como puras exportadas, incluirlas en `PURE_FNS`, consumirlas desde el server. Esfuerzo **M**.

**11. [BAJA] · corrección — `table-runtime.ts:488`** — Quitar chip de filtro con valor que contiene `\` produce selector inválido → checkbox desincronizado. `CSS.escape(v)`. **S**

**12. [BAJA] · corrección — `render-html-piece.ts:470-479, 942-957`** — NaN sin guarda: KPI muestra "NaN%", semáforo "NaN / NaN · 0%". NaN → '—'. **S**

**13. [BAJA] · estructura — `render-html-piece.ts:271, 298`** — Detección de features por string-sniffing del body HTML (`body.includes('class="table vtable"')`). Frágil. Que `renderNode` acumule flags. **S**

**14. [BAJA] · estructura — `themes/default.ts:17-76` vs `arbol.ts:76-218`** — ~60 líneas estructurales duplicadas; default.ts repite `.tray-actions`/`.tray-print`; default `wrap` descarta `meta` → un PI `confidential` con theme default pierde la marca de sensibilidad (roza corrección). Extraer `base-css.ts` + footer/meta común. **M**

**15. [BAJA] · a11y — `render-html-piece.ts:337, 552-559` · `table-runtime.ts:247, 761`** — `role="tablist"` mal usado; gaveta `role="dialog"` sin `aria-modal` ni foco, abierta por `<label>` no enfocable (inoperable por teclado); SVG de charts sin `role="img"`/`aria-label`; celda de anotación `contenteditable` sin `aria-label`. **S-M**

**16. [BAJA] · corrección — `render-html-piece.ts:443-444`** — Tipo de nodo desconocido se traga como comentario HTML (`<!-- elemento no soportado -->`), contra la filosofía fail-loud. Lanzar `VergisError` o banner visible. **S**

### Evaluación general (Opus)

Subsistema en buen estado para su madurez: escape consistente en casi toda interpolación, serialización JSON que neutraliza `</script>`, patrón `PURE_FNS.toString()` elegante donde se aplica, cotas `CHART_MAX_BARS`/`TABLE_SSR_MAX_ROWS`. Lo que queda es real: el costo del monolito ya se materializó en bugs (tres formateadores con drift, cinco pares espejo), dos huecos que rompen invariantes declarados (comilla simple en handlers; `localeCompare` sin locale), y el runtime de tabla no está listo para el volumen que el propio código dice esperar. Orden sugerido: fixes S de seguridad (5, 6, 7), drift de formato (2), `searchable` muerto (3), luego corte modular (9) como vehículo para unificar espejos (10).

---

## Segunda corrida — Opus 4.8 (el override a Fable no surtió efecto)

> El parámetro `model: "fable"` **no fue honrado** por el harness: este segundo pase corrió otra vez en Opus 4.8 (confirmado porque el agente hermano de admin/multipart volvió a chocar con el *safeguard de ciberseguridad de Opus*). No es contraste de motor Fable vs Opus, sino una **segunda opinión independiente en el mismo motor** — útil para ver qué hallazgos son estables entre corridas y cuáles aparecen solo en una.

He leído completos los siete archivos del ámbito, más el punto de `packages/mira/src/mira.ts` que construye `carryCtx` (para calibrar la severidad del hueco de escape) y el `package.json` raíz (build esbuild sin `--minify`). Aquí va la revisión.

---

## Hallazgos

### Severidad ALTA

**1. [SEV alta] · Escape/seguridad · `markdown.ts:19-25` + `render-html-piece.ts:365,372,382` · `escapeHtml` no escapa la comilla simple, y hay ids/keys interpolados dentro de strings JS de comillas simples en handlers `onchange`.**
Confirmado: `escapeHtml` solo cubre `& < > "`. En `renderControlsSection`, el handler se arma como `u.searchParams.append('ctx.${escapeHtml(k)}',...)` y `u.searchParams.set('ctx.${escapeHtml(c.id)}',this.value)` — la clave va dentro de un literal JS de comillas simples, y el atributo `onchange="..."` es de comillas dobles, así que una `'` en `c.id` o en la clave de `carry` sobrevive intacta y rompe el literal → inyección de JS. Nótese la asimetría delatora: los *valores* sí van con `JSON.stringify(String(val))` (línea 365), pero las *claves* van por concatenación. Mitigante verificado: `carryCtx` se construye en `mira.ts:240-274` solo con `c.id` del spec YAML (no con claves arbitrarias de la URL), así que el vector es un spec malicioso/descuidado, no un URL reflejado. Aun así es el hueco clásico de defensa en profundidad: `escapeHtml` es LA función central de escape del repo y cualquier interpolación futura en contexto single-quote lo hereda.
**Mejora:** añadir `.replace(/'/g,'&#39;')` a `escapeHtml` (y a `vtEsc`/`esc` de los runtimes embebidos, `table-runtime.ts:235,201`), y de paso usar `JSON.stringify` también para las claves en los handlers. **Esfuerzo: S.**

### Severidad MEDIA

**2. [SEV media] · Corrección (drift de formateadores) · `render-html-piece.ts:607-611` vs `render-html-piece.ts:942-957` vs `table-runtime.ts:87-98` · Tres formateadores con semánticas distintas.**
- El `fmt` del script interactivo (línea 607) soporta solo `percent_1` e `int_0`; **no soporta `percent`**. Un KPI con `format: 'percent'` se sirve como `43%` (server `formatValue:950`) pero al primer filtro el recompute lo pinta como `0.43` crudo.
- `vtFormat` (table-runtime.ts:96) recorta strings ISO datetime a fecha (`/^\d{4}-\d\d-\d\dT/` → slice 10); `formatValue` del server solo recorta `Date` instancias, **no strings ISO** (:955-956). Con `ssrComplete` el tbody servido muestra `2026-01-02T00:00:00` y al primer sort/filtro el runtime lo re-pinta como `2026-01-02` — el dato "cambia" ante el usuario.
**Mejora:** una sola implementación. `vtFormat` ya es función pura embebible (patrón `PURE_FNS`); extenderla con `percent` + manejo de `Date` y usarla también en `formatValue` server-side y en el `fmt` del dashboard (incluirla en `renderInteractiveScript` igual que `SAVED_VIEWS_JS`). **Esfuerzo: S.**

**3. [SEV media] · Reproducibilidad · `render-html-piece.ts:584` · `localeCompare` sin locale en render server-side.**
`renderDashboardFacets` ordena los valores de faceta con `a.localeCompare(b)` a secas: el orden depende del locale/ICU del proceso Node → el HTML no es byte-idéntico entre entornos (rompe la promesa de "pieza pre-forjada y reproducible" y cualquier diff/hash de artefactos). Contraste: el propio repo canonicaliza el spec Vega para el hash del caché. Riesgo hermano, menor: `Intl.NumberFormat('es-CL')` (:946) y `Intl.DateTimeFormat('es-CL')` (`arbol.ts:21,38`) dependen de la versión de ICU del runtime (cambios de separadores/abreviaturas entre versiones de Node).
**Mejora:** `a.localeCompare(b, 'es')` o mejor un comparador determinista (`vtNorm(a) < vtNorm(b)`); para Intl, fijar versión de Node en despliegue o formatear a mano los dos formatos que usa. **Esfuerzo: S.**

**4. [SEV media] · Corrección · `table-runtime.ts:127-137` · Comparador de orden no-transitivo en columnas mixtas.**
`vtApply` decide numérico vs lexicográfico **por par**: en una columna con `["2","10","abc"]`, `("2","10")` compara numérico pero `("2","abc")` y `("10","abc")` lexicográfico — comparador inconsistente → `Array.sort` produce órdenes arbitrarios (dependientes del motor y del tamaño del arreglo). Además `Number("  ")===0`: un string de espacios ordena como cero.
**Mejora:** decidir el modo UNA vez por columna con `vtIsNumericCol` (ya existe, :39) y comparar homogéneo; los no-números al final. **Esfuerzo: S.**

**5. [SEV media] · Rendimiento · `table-runtime.ts:315` + `504-529` · Re-render total del tbody por keystroke, sin debounce.**
`gs.addEventListener('input', function(){ state.globalSearch=gs.value; render(); })` — cada tecla ejecuta `vtApply` sobre todas las filas y reconstruye TODO el tbody vía `innerHTML` (string completo + re-parse del DOM). Con tablas del orden de `TABLE_SSR_MAX_ROWS`+ (el payload va siempre completo) esto es jank perceptible por tecla. El popover (:398) filtra por `style.display` — barato, ese está bien.
**Mejora:** debounce de ~150 ms en la búsqueda global; opcionalmente, cap de filas renderizadas con "mostrando N de M" (el conteo ya existe). **Esfuerzo: S** (debounce) / **M** (cap/virtualización).

**6. [SEV media] · Corrección · `render-html-piece.ts:684-687` + `table-runtime.ts:384,546-550` · Dashboard interactivo + tabla en la misma página: doble init de `vergisSavedViews` y badge en conflicto.**
Si el PI tiene `interactive` (dashboard) y además una tabla, se emiten dos scripts y **ambos** llaman `vergisSavedViews` sobre el mismo `.tray-saved` (misma clave de localStorage): el segundo (la tabla, va después en `tail`) pisa el `innerHTML` y los listeners del primero → las vistas guardadas del dashboard quedan inoperantes y los snapshots de formas distintas comparten storage. Ídem `#vergis-count`: lo escriben el `update()` del dashboard (:657) y el `render()` de la tabla (table-runtime.ts:528), último gana.
**Mejora:** o hacer `vergisSavedViews` idempotente con registro de múltiples proveedores de snapshot (componer estados bajo claves), o al menos detectar la coexistencia y unificar en un solo registrador. **Esfuerzo: M.**

**7. [SEV media] · Corrección · `render-html-piece.ts:860` + `table-runtime.ts:101-123` · `searchable: false` es un no-op silencioso.**
El colMeta serializa `searchable` al runtime, pero `vtApply` en la búsqueda global itera `for (const k in r)` sobre **todos** los campos de la fila — ignora el flag, e incluye campos no mostrados (p. ej. `tokenField`/`keyField` de anotaciones y claves de drill, que viajan en el payload): un usuario puede "matchear" filas por texto invisible. El override declarado en el spec (`TableColumn.searchable`, :84) no tiene efecto alguno. (`colSearch` en `VtState:23` tampoco tiene UI que lo escriba — vestigial.)
**Mejora:** pasar las columnas a `vtApply` y restringir la búsqueda global a `cols` con `searchable !== false`; borrar `colSearch` o cablearlo. **Esfuerzo: S.**

**8. [SEV media] · Seguridad de salida · `render-csv-piece.ts:66-68` · Sin neutralización de fórmulas en el CSV.**
`csvField` es RFC 4180 correcto, pero una celda que empieza con `=`, `+`, `-`, `@` (o tab/CR) se evalúa como fórmula al abrir en Excel/LibreOffice — inyección CSV clásica (DDE/exfiltración) con datos del warehouse que pueden contener texto de origen externo. El docstring del archivo declara "el CSV es para máquinas y planillas": las planillas son exactamente el vector.
**Mejora:** anteponer `'` (o un espacio) a los campos *string* que empiecen por `= + - @ \t \r` — solo strings, para no romper los números crudos que el diseño exige. **Esfuerzo: S.**

### Severidad BAJA

**9. [SEV baja] · Corrección/i18n · `render-html-piece.ts:946-950` · Separador decimal inconsistente entre formatos.**
`int_0` agrupa con es-CL (`1.234`) pero `percent_1` usa `toFixed(1)` → `43.2%` con punto decimal; en es-CL el decimal es coma (`43,2%`). En un mismo dashboard conviven las dos convenciones. Mejora: `Intl.NumberFormat('es-CL',{style:'percent',minimumFractionDigits:1})` o reemplazo manual del punto, replicado en el formateador unificado del hallazgo 2. **Esfuerzo: S.**

**10. [SEV baja] · Corrección · `render-html-piece.ts:470-479,490` · NaN sin guardia en semáforo/KPI.**
`semaforoCard` hace `Number(r[presentF])` sin validar: una fila con null pinta `NaN / NaN` y `pct=0` (rojo). `formatValue(NaN,'percent_1')` → `NaN%`. Mejora: fallback a `—` o 0 explícito. **Esfuerzo: S.**

**11. [SEV baja] · Corrección · `table-runtime.ts:488` · Selector frágil al quitar un chip.**
`pop.querySelector('input[value="'+v.replace(/"/g,'\\"')+'"]')` escapa solo `"`; un valor con `\` produce selector inválido → `SyntaxError` no capturado y el chip deja de quitarse. Ídem `th[data-field="'+f+'"]'` (:488,514) con nombres de campo raros. Mejora: `CSS.escape(v)`, o iterar los inputs comparando `.value`. **Esfuerzo: S.**

**12. [SEV baja] · Corrección · `render-html-piece.ts:789-791` · Tabla truncada sin aviso si el JS no corre.**
Con >500 filas el SSR sirve solo las primeras `TABLE_SSR_MAX_ROWS`; si el runtime falla o JS está deshabilitado (o print inmediato), el usuario ve 500 filas sin ninguna marca de truncamiento. Mejora: una fila final `<tr>` "mostrando 500 de N — requiere JS" que el runtime elimina al arrancar. **Esfuerzo: S.**

**13. [SEV baja] · Estructura · `render-html-piece.ts` (957 LOC) · El monolito: corte propuesto.**
El archivo mezcla seis responsabilidades separables con costuras ya limpias (las funciones apenas comparten `escapeHtml`, `ctxQuery` y tipos). Corte concreto:
- `piece-types.ts` — `ResolvedNode`, `TableColumn`, `Drill`, `Aggregation` (hoy `render-csv-piece` importa tipos desde el render HTML, acoplamiento invertido).
- `ctx.ts` — `CarryCtx`, `ctxQuery`, `serverDrillHref`.
- `render-chart.ts` — `renderDistribution`, `vegaLiteToSvg`, caché LRU, `CHART_MAX_BARS` (única parte async/pesada; aísla la dependencia vega).
- `render-table.ts` — `renderTable`, `renderTableBody`, `renderInteractiveTable`, colorscale, `TABLE_SSR_MAX_ROWS`, `TABLE_INTERACTIVE_CSS`, `DRILL_ACTIONS_CSS`.
- `tray.ts` — `renderTrayShell`, `renderControlsSection`, `renderContextStrip`, `renderPagesNav` + sus 4 bloques CSS.
- `interactive-script.ts` — `renderInteractiveScript`.
- `format.ts` — el formateador unificado (hallazgo 2).
`render-html-piece.ts` queda como orquestador (~150 LOC: la Capability + `renderNode`). **Esfuerzo: M** (mover código, cero cambio de comportamiento; los sniffs de string tipo `body.includes('class="table vtable"')` — :271,298 — convendría reemplazarlos por flags devueltos por los renderers, que además eliminan el falso positivo posible de `vt-actions` como texto de celda).

**14. [SEV baja] · Estructura (drift latente) · `render-html-piece.ts:795-838` vs `table-runtime.ts:235-267` · Render de filas duplicado server/cliente.**
`renderTableBody`/`drillActionsCell`/`serverDrillHref`/`colorscaleBg`/`ctxQuery` tienen espejo manual en `vtBodyRows`/`vtDrillActions`/`vtDrillHref`/`vtColorBg`/`vtCtxQuery`. Hoy coinciden, pero es el mismo tipo de drift que ya se materializó en los formateadores (hallazgo 2), y el repo YA tiene el patrón que lo resuelve (`PURE_FNS` + `toString`). Mejora: mover el render de fila a funciones puras compartidas y que el server las llame directamente. **Esfuerzo: M.**

**15. [SEV baja] · Estructura · `themes/default.ts` vs `themes/arbol.ts` · CSS duplicado entre themes (y dentro de default).**
~60-70% de las reglas son estructuralmente idénticas (layout-*, tray/tray-tab/faceta, kpi, table, semaforo/tl-*, @page/@media print) — arbol con variables, default con hex; TABLE_INTERACTIVE_CSS ya demostró el patrón correcto (vars con fallback claro). Además `default.ts` repite `.tray-actions`/`.tray-print` dos veces dentro del mismo string (:41-42 y :68-69). Mejora: un `base.css` compartido sobre variables (default define las vars claras, arbol las suyas); cada theme aporta solo cromo (header/footer/paletas). De paso, `arbol.ts:63` hardcodea `['gruvbox','claro','blanco']` duplicando su propio `palettes` (:55-59) — derivarlo de `this.palettes`. **Esfuerzo: M.**

**16. [SEV baja] · Robustez de build · `table-runtime.ts:549-550` · `TABLE_RUNTIME_SOURCE` vía `Function.prototype.toString` es sensible al toolchain.**
Hoy el build (`package.json:14`) es esbuild **sin** `--minify`, así que funciona; pero con minificación o con la decoración `keepNames` (`__name(...)`) de esbuild, el `toString()` emitiría referencias a helpers/nombres renombrados inexistentes en el navegador → runtime roto en silencio. Mejora: un comentario-centinela + test que evalúe `TABLE_RUNTIME_SOURCE` con `new Function` desde el bundle final (no desde el fuente), o build del runtime como asset explícito. **Esfuerzo: S.**

**17. [SEV baja] · Seguridad · `publicar-artefacto.ts:21-24` · Escritura de archivos sin acotar al baseDir.**
`isAbsolute(p.path) ? p.path : resolve(base, p.path)` acepta rutas absolutas y `../` — un path derivado de spec escribe en cualquier lugar del filesystem del proceso. Está documentado como stub, pero el guard es una línea: resolver y verificar `full.startsWith(base + sep)` salvo flag explícito. **Esfuerzo: S.**

**18. [SEV baja] · a11y · varios · Interactividad no operable por teclado.**
(a) La gaveta se abre solo con `<label>` sobre checkbox `hidden` (`render-html-piece.ts:552-553`) — no enfocable: el Inspector es inaccesible por teclado, ídem los 3 tabs (radios `hidden`, :561-563). (b) El sort es un `click` sobre un `<span>` (`table-runtime.ts:429`) sin `tabindex`/rol de botón ni tecla Enter. (c) `role="tablist"` en la nav de páginas (:337) con `<a>` sin `role="tab"` — mejor quitar el rol y dejar `<nav>` + `aria-current` que ya está bien. (d) `role="dialog"` en la gaveta sin manejo de foco. Mejora mínima: quitar `hidden` de los inputs y ocultarlos con CSS accesible (`position:absolute;opacity:0`) + `:focus-visible` en los labels; botón real en el header de sort. **Esfuerzo: S-M.**

**19. [SEV baja] · Corrección/i18n · `render-csv-piece.ts:36` · CSV UTF-8 sin BOM.**
Excel (el consumidor típico en es-CL) abre CSV UTF-8 sin BOM con mojibake en acentos/eñes. Mejora: anteponer `\uFEFF` al CSV (o hacerlo opción del render). Nota menor: RFC 4180 pide CRLF; el join usa LF (tolerado universalmente). **Esfuerzo: S.**

---

## Evaluación general

El código está en buen estado para una v0.1 tras tres rondas: se nota el trabajo previo (cap de SSR con skip de render idéntico, caché LRU de charts con clave canónica, fix del spread-stack en colorscale, escape de `</script>` en el JSON embebido, top-N en distribution, RFC 4180, el patrón `PURE_FNS` para cero-drift del runtime testeado). Los comentarios son de calidad inusual — explican el *porqué* y las trampas.

Lo que queda cae en tres familias: **(1)** un hueco puntual pero central de escape (la comilla simple en `escapeHtml`, hallazgo 1) que es barato de cerrar y elimina una clase entera de riesgo; **(2)** el drift entre implementaciones espejo — el repo ya inventó la solución (`PURE_FNS`) pero solo la aplicó a la mitad del problema: los formateadores (donde el drift ya es observable: `percent` y fechas ISO, hallazgo 2) y el render de filas siguen triplicados/duplicados a mano; y **(3)** deuda estructural consciente (monolito de 957 LOC, CSS duplicado entre themes) que aún no duele pero cuyo corte natural ya es visible y barato de ejecutar antes de que crezca. Prioridad sugerida: 1 → 2 → 3/8 (reproducibilidad y CSV, ambos S) → 5 (debounce) → el resto según roadmap.

---

• *Generado con [Wingworking](https://wingworking.org)*
