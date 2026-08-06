# Diseño — GH #61 · Exportar a Excel/CSV cualquier tabla visible (capacidad de plataforma, TX-01)

**Rol:** documento de diseño ejecutable (contrato wingcoding: Fable diseña, Opus implementa en frío).
**Repo:** `Gegolabs/vergis` · working tree `/Users/cesar/wworkspace/productos/vergis` · base `main`.
**Issue:** [#61](https://github.com/Gegolabs/vergis/issues/61) — botón de descarga en las tablas de los PIs: exportar la tabla visible (con filtros/facetas aplicados) a CSV abrible en Excel. Capacidad de **plataforma** (todos los PIs por igual). Demanda dura: PI-16 «Reporte Facturas» (criterio de aceptación F-12) + 2× del especificador de PI-01.

---

## ¿Qué hay que saber antes de tocar nada? (estado actual, verificado contra `main`)

El **núcleo del export ya está mergeado** (PR #64, 2026-07-14): el runtime de tabla interactiva ofrece «Descargar CSV (vista actual)» en la bandeja común. El issue sigue OPEN (el PR no llevó `Closes #61`). Este diseño **sella las decisiones ya tomadas** (quedan ratificadas y con racional citable) y define el **delta** que falta para cerrar el issue con criterio de excelencia. Hechos verificados:

- `packages/capabilities/src/table-runtime.ts` — runtime de la tabla interactiva. Funciones **puras** (`vtNorm`, `vtApply`, `vtFormat`, …) exportadas para test en Node y **embebidas en el HTML vía `.toString()`** (`PURE_FNS` → `TABLE_RUNTIME_SOURCE`, líneas 235 y 595-596): una sola fuente de verdad, cero drift cliente/test. Regla del módulo (header, líneas 12-14): cada función serializada es **autocontenida o referencia solo a sus pares del módulo** (se concatenan en un mismo IIFE) — sin imports ni globals de Node dentro de ellas.
- El handler de export vive en `DOM_GLUE` (líneas 376-393): construye el CSV inline (función local `cell` con quoting para `; " \n \r`), separador `;`, BOM UTF-8 + CRLF, descarga vía `Blob` + `<a download>`; nombre = `slug(document.title)-YYYY-MM-DD.csv`. El botón (`.vt-export`, líneas 366-367) vive en el grupo «Descargar» del **kit** que cada tabla inyecta en la bandeja común (`.tray-sections`, tab Controles); con ≥2 tablas interactivas el coordinador impone UN kit visible con selector de objetivo (líneas 576-592). Exporta `renderCols()` (columnas visibles) sobre `vtApply(rows, state)` (la vista filtrada). CSS del botón: `piece-css.ts` líneas 59-60.
- `packages/capabilities/src/render-csv-piece.ts` — el CSV de **delivery** (server-side, `render: csv` del spec): valores RAW sin formatear, headers = labels, separador `,`, BOM **opt-in** (`bom: true`), secciones `# título` con varias tablas, y **neutralización de formula injection** en `rawValue` (líneas 63-72: prefijo `'` a strings que empiezan con `= + - @ \t \r`).
- `packages/capabilities/src/render-table.ts` — toda tabla es interactiva **por defecto**; excepciones: `interactive: false` (kill-switch) y tabla display (rinde 1 fila) — esas se sirven estáticas, sin runtime ni kit (líneas 24-39).
- Los facetas de dashboard (`interactive-script.ts`) recomputan **solo** KPIs/semáforos/summaries (`[data-agg]`, `[data-semaforo]`, `[data-summary]`); no filtran las filas de una vtable — cada tabla filtra con su propio kit.
- Print: ambos themes ocultan `.tray, .tray-tab, .tray-toggle` en `@media print` (`themes/arbol.ts` línea ~255, `themes/default.ts` línea ~80) — el botón jamás se imprime.
- Tests existentes: `tests/table-export.test.ts` (presencia de strings en `TABLE_RUNTIME_SOURCE` + validez sintáctica vía `new Function` + CSS), `tests/table-interactive.test.ts` (funciones puras testeadas directo en Node — el patrón del repo), `tests/render-csv.test.ts` (delivery CSV: RAW, secciones, BOM opt-in; **sin** casos de formula injection hoy).
- Decisión previa de César (comentario en #61, 2026-07-13): **CSV es la resolución**; `.xlsx` real **descartado** (exigiría la primera dependencia gorda + endpoint server-side, sin demanda que lo justifique); PDF cubierto por print del browser.

### ¿Cuál es el delta que este diseño manda a construir?

1. La lógica de armado del CSV del cliente es **inline y no testeable** (función local `cell` dentro del handler) — viola el patrón «una sola fuente de verdad testeada» del propio módulo.
2. El export del cliente **no neutraliza formula injection** (el de delivery sí) — una celda `=HYPERLINK(...)` viajera se ejecuta al abrir en Excel.
3. La regla de neutralización de `rawValue` tiene un **bug**: un string numérico con signo (`"-2644239500"` — así entregan los drivers los BIGINT, ver `vtFormat` líneas 92-95) se corrompe a `'-2644239500`.
4. El nombre del archivo no distingue **cuál tabla** (con ≥2 tablas ambas descargan igual) ni si la vista estaba **filtrada**.

---

## ¿Qué decisiones quedan selladas?

**D1 — Se exporta lo VISIBLE, client-side; sin endpoint server-side nuevo.** El export nace de `vtApply(rows, state)` sobre las filas **ya materializadas y RLS-filtradas** que el HTML embebe — sin path nuevo de datos, sin query nueva, fail-closed por construcción (el consumidor solo reordena lo que ya tiene permitido ver). El dataset completo sin filtros ya lo cubre la plataforma vía `delivery: render: csv` (render-csv-piece). No se agrega un «exportar todo» al botón: serían dos productos distintos con el mismo nombre.

**D2 — CSV con BOM UTF-8 + separador `;`; sin `.xlsx`, sin dependencia nueva.** Ratifica la decisión de César (2026-07-13). Excel es-CL usa coma decimal → su separador de lista es `;`; el BOM hace que Excel Windows lea UTF-8 (tildes correctas). `.xlsx` exigiría la primera dependencia gorda de producción (supply-chain estricta) sin demanda que lo justifique. Caveat documentado y aceptado: Excel infiere tipos al abrir CSV (folios/RUT con ceros a la izquierda).

**D3 — Valores RAW, sin `vtFormat`; misma filosofía que el CSV de delivery.** El CSV es para re-procesar en planilla: `640838`, no `640.838`; fechas `Date` → ISO `YYYY-MM-DD`; strings (incluidos timestamps ISO que vienen como string en el payload JSON) **tal cual**, sin recorte. Exportar lo formateado convertiría números en texto y ataría el export al locale del render. Caveat aceptado: un decimal raw (`0.432`) bajo Excel es-CL puede inferirse mal — dominio real (listados: folios, RUT, montos enteros CLP, fechas, estados) casi no trae decimales; si aparece demanda, se revisa entonces, no ahora.

**D4 — La celda CSV es UNA función pura compartida: `vtCsvCell(v, sep)` en `table-runtime.ts`, usada por el runtime del cliente Y por `render-csv-piece`.** Criterio de excelencia: hoy hay dos implementaciones (el `cell` inline del handler sin neutralización, y `rawValue`+`csvField` del delivery) — si diseñáramos desde cero habría una sola regla de celda con el separador como parámetro. `vtCsvCell` entra a `PURE_FNS` (viaja al browser) y `render-csv-piece` la **importa** (server-side; sin ciclo: `table-runtime` no importa nada). `rawValue` y `csvField` se eliminan. El parámetro `sep` es **obligatorio** (sin default: los defaults de parámetro son un riesgo evitable en código que viaja serializado por `toString`).

**D5 — Regla de neutralización anti formula-injection, refinada y única:** se antepone `'` a un **string** que (a) empieza con `= @ \t \r`, o (b) empieza con `+`/`-` **y no es un número** (`Number(s)` es NaN). Corrige el bug de D-estado-3: `"-2644239500"` (BIGINT del driver) queda intacto; `"=HYPERLINK(...)"`, `"@SUM(A1)"` y `"+56 9 no-numero"` se neutralizan. Los `number` nativos jamás se tocan. Aplica igual en cliente y delivery (es la misma función).

**D6 — El armado del CSV es puro y testeable: `vtCsv(cols, rows)`.** Header = `label ?? field` por columna visible; una línea por fila con `vtCsvCell(r[c.field], ';')`; join con `\r\n` (CRLF: convención Windows/Excel). **Sin BOM dentro de `vtCsv`** — el BOM es asunto del envoltorio (el handler lo antepone en el Blob; delivery lo mantiene opt-in). El handler queda como cáscara de 5 líneas: `new Blob(['﻿' + vtCsv(rc, view)], …)`.

**D7 — Nombre del archivo: `slug(título-doc)--slug(tabla)--YYYY-MM-DD[--filtrado].csv`, vía función pura `vtCsvName(docTitle, kitLabel, dateISO, filtered)`.** Racional: el título del documento identifica el PI (es el `<title>` que emite el theme); el rótulo del kit (`kitLabel`: el `<h3>` de la tabla, ya calculado en el runtime, línea 353) distingue la tabla cuando hay varias; la fecha ancla la foto; el sufijo `--filtrado` avisa que NO es el dataset completo (aparece si hay búsqueda global, faceta o búsqueda por columna activa — el orden y la agrupación no cuentan: no cambian el conjunto de filas). Separador `--` entre segmentos porque los slugs internos usan `-`. Slug: minúsculas, se eliminan caracteres fuera de `[\wÀ-ÿ -]`, espacios → `-` (la regla actual del handler, ahora testeada). Si `slug(kitLabel)` es vacío o igual al del título, el segmento tabla se omite (sin `reporte--reporte`).

**D8 — Cobertura de plataforma: toda tabla interactiva lleva el botón; display y kill-switch NO; dashboards sin tabla NO.** La tabla interactiva es el default de plataforma (render-table.ts) ⇒ el botón llega a todos los PIs con listado **sin tocar ningún spec** — eso ES la capacidad de plataforma que pide el issue. Una tabla display (1 fila) no es un listado; `interactive: false` es el kill-switch explícito de TODA la maquinaria (el spec optó por salir — el export es maquinaria). Un dashboard sin tabla no tiene listado que descargar (sus datos tabulares se exportan declarando una tabla o `delivery: csv`); ampliarlo sería alcance nuevo, fuera de este issue. Las **anotaciones/notas jamás viajan** (issue #60): el export usa las columnas visibles (`renderCols()`), y los campos ocultos del payload (tokens de notas, claves de drill) no están en `cols` — garantía estructural, ya cubierta por test de delivery y ahora también por test del cliente.

**D9 — Multi-vista y drill: el export es por página activa, plano, sin columna de acciones.** Cada página de un PI multi-vista es un render independiente — el botón exporta la tabla de la página en que estás (lo visible, literalmente). La agrupación multinivel es presentación: se exporta la vista **plana** post-filtros/orden (`vtApply`), sin filas de encabezado de grupo — un CSV con subtotales incrustados no se re-procesa. La columna de acciones de drill no existe en `cols` ⇒ no viaja.

**D10 — Accesibilidad y superficie: botón real con texto visible, en la bandeja; no se imprime.** `<button type="button">` con texto «Descargar CSV (vista actual)» (nunca icon-only: el texto ES el label accesible; el `title` explica el alcance), dentro del grupo «Descargar» del kit en el tab Controles del Inspector — consistencia de plataforma: los controles viven en la bandeja, la cara muestra estado (TX-11). Con ≥2 tablas, el selector de kit existente resuelve el objetivo. En print el botón desaparece con toda la bandeja (verificado en ambos themes).

---

## ¿Qué reglas duras rigen la implementación?

- **NO tocar** el pipeline de enforcement RLS ni el serving: `server/serve-rls.ts`, `server/admin*.ts`, `packages/policy/`, `packages/mira/` (salvo cero — este diseño no los necesita). El export no abre ningún path de datos nuevo.
- **CERO dependencias nuevas** (de producción o dev). Todo es `Blob` + `URL` + string building.
- **Las funciones que entran a `PURE_FNS` son autocontenidas o referencian solo pares del módulo** (se serializan por `toString` y se concatenan en un IIFE): sin imports, sin globals de Node, sin parámetros con default, sin sintaxis exótica — el gate sintáctico es el test `new Function(TABLE_RUNTIME_SOURCE)`.
- **No cambiar el contrato del CSV de delivery**: separador `,`, BOM opt-in (`bom: true`), secciones `# título`, join `\n`, headers = labels, fail-loud sin tablas. El único cambio de conducta permitido allí es el de D5 (corrección del bug del signo), con test que lo documente.
- **UI en español.** No cambiar el texto del botón ni las clases CSS existentes (`.vt-export` ya tiene estilo y test).
- **No ampliar alcance**: nada de export en dashboards sin tabla, nada de `.xlsx`, nada de endpoint server-side, nada de exportar anotaciones.

---

## ¿Cuáles son las tareas, su territorio y su «hecho cuando»?

### T1 — Funciones puras de export + recableado del handler

**Territorio exacto:** `packages/capabilities/src/table-runtime.ts` · `packages/capabilities/src/index.ts` (solo el bloque de re-exports de table-runtime, líneas ~30-40).

1. Agregar a `table-runtime.ts` tres funciones exportadas, con doc-comment en español (estilo del módulo):
   - `vtCsvCell(v: unknown, sep: string): string` — `null/undefined` → `''`; `v instanceof Date` → `toISOString().slice(0,10)`; si es string y (`/^[=@\t\r]/` o (`/^[+-]/` y `Number.isNaN(Number(s))`)) → prefijo `'`; luego quoting RFC-4180 parametrizado: si contiene `"`, `\n`, `\r` o `sep` → se envuelve en `"` con `"` interna doblada.
   - `vtCsv(cols: { field: string; label?: string }[], rows: Record<string, unknown>[]): string` — línea header (`label ?? field` por `vtCsvCell(..., ';')`) + una línea por fila (`vtCsvCell(r[c.field], ';')`), join `';'` por celda y `'\r\n'` entre líneas. Sin BOM.
   - `vtCsvName(docTitle: unknown, kitLabel: unknown, dateISO: string, filtered: boolean): string` — slug interno (función local dentro de `vtCsvName`, para que viaje serializada): `String(s??'').trim().replace(/[^\wÀ-ÿ -]+/g,'').replace(/\s+/g,'-').toLowerCase()`; base = slug(docTitle) o `'tabla'`; segmento tabla omitido si vacío o igual a base; retorna `base [+ '--' + tabla] + '--' + dateISO + (filtered ? '--filtrado' : '') + '.csv'`.
2. Sumar las tres a `PURE_FNS` (línea 235).
3. Recablear el handler de export en `DOM_GLUE` (líneas 379-393): eliminar `cell`, el armado de `lines` y el cálculo de `base`; en su lugar `var filtered = !!state.globalSearch; for(var ff in state.facets){ if((state.facets[ff]||[]).length) filtered=true; } for(var cf in state.colSearch){ if(state.colSearch[cf]) filtered=true; }`, `blob = new Blob(['﻿' + vtCsv(rc, view)], {type:'text/csv;charset=utf-8'})`, `a.download = vtCsvName(document.title, kitLabel, new Date().toISOString().slice(0,10), filtered)` (`kitLabel` ya está en scope, línea 353). Conservar `window.URL.createObjectURL/revokeObjectURL` y el append/click/remove actuales (lección documentada en el test: `window.URL`, no `URL` pelado).
4. Re-exportar `vtCsvCell`, `vtCsv`, `vtCsvName` desde `index.ts`.

**Hecho cuando:** `npx vitest run tests/table-export.test.ts tests/table-interactive.test.ts` verde (incluye los tests nuevos de T3 si ya existen; como mínimo los existentes: presencia de `vt-export`, `vtApply(rows, state)`, `'﻿'`, `window.URL.*`, y `new Function(TABLE_RUNTIME_SOURCE)` sin throw) **y** `npm run typecheck` verde.

### T2 — `render-csv-piece` reutiliza la celda compartida

**Territorio exacto:** `packages/capabilities/src/render-csv-piece.ts`.

1. `import { vtCsvCell } from './table-runtime'`.
2. Eliminar `rawValue` y `csvField`; en `tableToCsv`, cada celda y cada header pasan por `vtCsvCell(x, ',')` (la fila-título de sección también: `vtCsvCell('# ' + sectionTitle, ',')`). El join `\n`, las secciones y el BOM opt-in **no cambian**.
3. Actualizar el doc-comment del módulo: la regla de celda (RAW, Date→ISO, neutralización, quoting) vive en `vtCsvCell` (una sola fuente, compartida con el export del cliente); anotar la corrección de D5 (string numérico con signo ya no se neutraliza).

**Hecho cuando:** `npx vitest run tests/render-csv.test.ts` verde sin tocar ningún caso existente (los 5 casos actuales son el contrato: RAW + quoting con `,`, secciones, notas fuera, fail-loud, BOM opt-in).

### T3 — Tests nuevos (comportamiento, no solo presencia)

**Territorio exacto:** `tests/table-export.test.ts` (ampliar) · `tests/render-csv.test.ts` (ampliar, solo agregar casos).

En `table-export.test.ts`, siguiendo el patrón del repo (funciones puras importadas de `@vergis/capabilities`, testeadas directo — la misma fuente que viaja al browser):

- `vtCsvCell`: quoting con `;` (`a;b` → `"a;b"`, `x"y` → `"x""y"`); `null`/`undefined` → `''`; `new Date('2026-08-06T12:00:00Z')` → `2026-08-06`; string timestamp ISO queda intacto (RAW); neutralización: `'=SUM(A1)'` → `"'=SUM(A1)"`, `'@x'`, `'\tx'` neutralizados; `'-2644239500'` y `'+123.5'` **intactos** (número con signo, bug D5 corregido); `'+56 9 8888'` neutralizado; `1234.5` (number) intacto.
- `vtCsv`: con cols `[{field:'a',label:'Col A'},{field:'b'}]` y 2 filas → header `Col A;b`, join CRLF, **sin** BOM (`charCodeAt(0) !== 0xfeff`), celdas RAW; un campo presente en las filas pero ausente de `cols` NO aparece (las notas/campos ocultos no viajan).
- `vtCsvName`: `('Reporte Facturas','Listado','2026-08-06',true)` → `reporte-facturas--listado--2026-08-06--filtrado.csv`; sin filtro → sin sufijo; `kitLabel` vacío o igual al título → segmento omitido; título vacío → base `tabla`.
- Wiring (presencia sobre `TABLE_RUNTIME_SOURCE`, como hoy): contiene `vtCsv(rc, view)` y `vtCsvName(` — el handler usa las puras, no una copia inline; y sigue el gate `new Function`.

En `render-csv.test.ts`, agregar un caso: una tabla cuyo dato trae `'=HYPERLINK("http://x")'` y `'-2644239500'` → el CSV neutraliza el primero (`'=…`) y deja el segundo intacto.

**Hecho cuando:** `npx vitest run tests/table-export.test.ts tests/render-csv.test.ts` verde.

### T4 — Cierre

**Territorio exacto:** ninguno nuevo (verificación + PR).

**Hecho cuando:** `npm run typecheck && npm test && npm run build` verdes en la rama; PR con cuerpo que incluya `Closes #61` (el PR #64 no lo llevó y el issue quedó abierto — no repetir).

### ¿En qué orden?

T1 → T2 → T3 → T4, secuencial (T2 importa lo que T1 crea; T3 testea ambos). Un solo frente/subagente: el territorio es chico y compartiría archivos — no paralelizar.

---

## ¿Quién es el juez?

1. `npm run typecheck` · `npm test` · `npm run build` — los tres gates del repo, verdes.
2. Los tests nuevos de T3 (comportamiento de `vtCsvCell`/`vtCsv`/`vtCsvName` + injection en delivery).
3. Los tests existentes **sin modificar ninguna aserción**: `tests/table-export.test.ts` (los 3 casos actuales), `tests/render-csv.test.ts` (los 5 casos actuales), `tests/table-interactive.test.ts`, `tests/table-ssr-threshold.test.ts`, `tests/interactive-max-rows.test.ts`. Si alguno se pone rojo, el diseño se violó — no se «arregla» el test.

---

## ¿Qué riesgos quedan y cómo se mitigan?

- **Sintaxis que no sobrevive la serialización `toString`** — mitigado por regla dura (sin defaults, sin globals) y por el gate `new Function(TABLE_RUNTIME_SOURCE)` que ya existe. El test de wiring (`vtCsv(rc, view)` presente en el bundle) verifica que el handler llama a las puras de verdad.
- **Cambio de conducta en el CSV de delivery** por D5: strings numéricos con signo dejan de llevar `'`. Es corrección de bug (los BIGINT de los drivers llegan como string — hoy el delivery los corrompe); queda documentado con test propio. Ningún test existente cubre el comportamiento viejo (verificado: `render-csv.test.ts` no tiene casos de injection).
- **Cambio del nombre de archivo descargado** (se agrega segmento tabla + sufijo `--filtrado`): no hay contrato que dependa del nombre anterior — F-12 de PI-16 pide «poder descargar el listado», sin nombre comprometido. *Se asume* que ningún usuario automatizó contra el nombre viejo (mergeado hace 3 semanas, pre-launch).
- **Decimales con punto bajo Excel es-CL** (D3): caveat aceptado y documentado en el issue; el dominio real de los listados es entero/fecha/texto. Si aparece demanda de decimales, se decide entonces (posible `vtFormat` opt-in por columna) — fuera de este alcance.

---

*Diseño GH#61 · Fable · 2026-08-06 · cluster work/002-cluster-requests-2026-08*
