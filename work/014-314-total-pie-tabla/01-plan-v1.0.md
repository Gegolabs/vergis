# Plan · #314 — total al pie de la tabla por columna (`columns[].total`)

| Campo | Valor |
|--|--|
| Objetivo | El elemento `table` dibuja un `<tfoot>` con el agregado de cada columna que lo declare, en los tres modos de render (interactivo, estático, impresión), y en el modo interactivo el total **sigue a los filtros de la bandeja** (facetas, búsqueda, filtros numéricos y de fecha). |
| Origen | Issue [#314](https://github.com/Gegolabs/vergis/issues/314) · PI-15 de la instancia GH (c.11428: el `dato` al pie no se veía) · Claudio Cornejo, 2026-09-21: «sería bueno que las totalizaciones fuesen estándar del producto» |
| Diseño | Fable (esta sesión), sobre el código leído en `57c1325` |
| Ejecutor | Subagente Opus, worktree `../vergis-wt/314`, rama `feat/314-table-total` |
| Versión | Entra en «Sin publicar»; será parte del corte 0.27.1 |

## ¿Qué se decide acá y no se re-decide?

1. **Capacidad opt-in por columna, jamás automática.** Un total que aparece solo en una columna equivocada (porcentaje, promedio, stock a fechas distintas, código) es peor que ninguno porque nadie lo cuestiona. La columna lo declara.
2. **DSL:** `table.columns[].total: sum | avg | count`. `true` es alias de `sum`. Cualquier otro valor ⇒ error de validación `table-column-total-invalid` con remediación. Ningún otro atributo nuevo.
3. **Semántica del agregado** (una sola función pura, compartida servidor↔browser): se consideran las celdas cuyo valor **coacciona a número finito** (`Number(v)` sobre number o string no vacío; `null`, `''` y no numéricos se **saltan**, no anulan). `sum` = Σ · `avg` = Σ / n de considerados (n = 0 ⇒ `null`) · `count` = n de considerados. Los enteros de 64 bits que llegan como string (SUM sobre BIGINT) se suman como `Number`: la pérdida de precisión sobre `MAX_SAFE_INTEGER` se **documenta** en el comentario de la función; no se implementa BigInt en esta issue.
4. **El total del servidor se calcula sobre TODAS las filas** del nodo (`node.rows`), no sobre el recorte SSR de 500: el pie servido es el total del dataset. En el modo interactivo, `render()` del runtime lo **recalcula sobre `view`** (las filas tras `vtApply`) y pisa las celdas; en el arranque `ssrComplete && stateEmpty` (que salta `render()`) el pie servido ya es correcto.
5. **Con agrupación (`groupLevels`) activa**, el pie sigue siendo el total de `view` (todas las filas filtradas). Subtotales por grupo **quedan fuera** (PI-15 los pidió en v19 y los retiró en v21).
6. **Formato:** cada celda de total usa el `format` de su columna vía `formatValue` (servidor) / `vtFormat` (browser). `avg` con `int_0` redondea como cualquier valor. `null` ⇒ `—`.
7. **Rótulo:** la **primera columna sin `total`** lleva el texto `Total`; si todas tienen total, no hay rótulo. La columna de acciones de drill (si existe) lleva un `<td>` vacío. Ninguna celda del pie lleva `--mag` ni clase de magnitud.
8. **Exportación CSV** (`vtCsv…`): **no** incluye la fila de total. Se declara en el CHANGELOG; agregarlo sería otra issue.
9. **Impresión** (`opts.print`): `<tfoot>` con el total de todas las filas aunque el cuerpo se trunque a `TABLE_PRINT_MAX_ROWS`.

## ¿Dónde se toca? (anclado al código de `57c1325`)

| # | Archivo | Cambio |
|--|--|--|
| 1 | `packages/mira/src/compose.ts` `TableColumn` (~l.75) y `packages/capabilities/src/piece-types.ts` `TableColumn` (l.98) | `total?: 'sum' \| 'avg' \| 'count'`. compose **normaliza** `true → 'sum'` al copiar `columnsSpec` (l.423: hoy es `[...(t.columns ?? [])]`; pasa a mapear cada columna). Los dos tipos se mantienen en sincronía (ya lo exige el comentario del archivo). |
| 2 | `packages/mira/src/dsl/validate.ts` | En el recorrido de elementos (donde ya se inspecciona `obj['table']`, ~l.633, y `ELEMENT_TYPES` l.868): por cada `columns[i].total` presente, si no es `true`/`'sum'`/`'avg'`/`'count'` ⇒ `{ code: 'table-column-total-invalid', path: 'pages[..].…columns[i].total', message, remediation }` siguiendo el patrón de los demás códigos. Si `schema/mira-spec.schema.json` describe las columnas de `table`, añadir la propiedad; si no las describe (hoy no aparece), **no inventar** un bloque nuevo. |
| 3 | `packages/capabilities/src/table-runtime.ts` | Nueva función pura **`vtTotals(cols, rows)`** → `Record<field, number \| null>` con la semántica del punto 3; autocontenida (viaja por `.toString()`), agregada a `PURE_FNS` y al `export` del módulo (l.~725). En `vtBootstrap`: `var totEl = root.querySelector('tfoot .vt-total-row')`; en `render()` (l.1141), tras calcular `view`: si `totEl`, recalcular y escribir cada `td[data-total-field]` con `vtFormat(valor, colFormat(field))`. `cols` del payload ya lleva `format`; añadir `total` a `colMeta` en render-table. |
| 4 | `packages/capabilities/src/render-table.ts` | Función `renderTableFoot(cols, rows, drills)` que devuelve `''` si ninguna columna declara `total`, o `<tfoot><tr class="vt-total-row"><td class="align-… vt-total-label">Total</td>…<td class="align-… vt-total" data-total-field="cantidad">6.414.823</td>…(+ `<td class="vt-actions"></td>` si hay drills)</tr></tfoot>`. Se emite en los **tres** returns (print l.~30, estático l.~45, interactivo dentro de `renderInteractiveTable` l.~185, entre `</tbody>` y `</table>`). Importa `vtTotals` desde `./table-runtime` (mismo cálculo que el browser). |
| 5 | `packages/capabilities/src/piece-css.ts` | En la CSS de tabla: `.table tfoot td{font-weight:600;border-top:2px solid var(--border,#e2e8f0);background:var(--card,#f8fafc)}` y `.table tfoot .vt-total-label{color:var(--fg-dim,#64748b);text-transform:uppercase;font-size:11px;letter-spacing:.04em}`. Verificar que `.vt-scroll` con `thead` sticky (si lo hay) no oculte el `tfoot`. |
| 6 | `docs/capacidades.md` | Fila **`CAP-191`** · «Total al pie de la tabla por columna (`sum`/`avg`/`count`), recalculado con los filtros de la bandeja» · DSL `table.columns[].total` · `<sin publicar>` · doc de referencia. |
| 7 | Doc de referencia del DSL de `table` | Donde estén documentados `format`/`align`/`filter`/`groupBy` de columna (buscar `groupBy` en `docs/` y `README`/`examples`; si solo existe en `capacidades.md`, ahí). Un párrafo + ejemplo. |
| 8 | `CHANGELOG.md` «Sin publicar» | `### Total al pie de la tabla por columna` — qué trae, qué exige (nada: sin env, sin migración), qué NO hace (CSV, subtotales, BigInt), y la referencia a #314 y a PI-15. |
| 9 | `INDEX.md` | Fila `014` apuntando a este directorio. |

## Tests (cada uno debe fallar contra `main`)

Archivo nuevo `tests/table-totals.test.ts`, estilo `tests/table-num-filters.test.ts` / `tests/table-interactive.test.ts`:

1. **`vtTotals` puro:** `sum`/`avg`/`count` sobre un fixture con números, strings numéricos (`'1200'`), `null`, `''` y un texto (`'n/a'`): los tres últimos se saltan; `avg` con cero considerados ⇒ `null`; columna sin `total` ⇒ ausente del resultado. Control: `vtTotals([], rows)` ⇒ `{}`.
2. **Reconciliación:** fixture de 1.000 filas generadas con semilla; `vtTotals` `sum` = suma directa calculada en el test con `reduce` (mismo número, no «aproximado»).
3. **Render interactivo** (`renderHtmlPiece` con `{ type: 'table', interactive: true, columnsSpec: [{field:'especie'},{field:'cantidad', format:'int_0', total:'sum'}], rows }`): el HTML contiene `<tfoot>`, `class="vt-total-row"`, `data-total-field="cantidad"`, el valor formateado `es-CL` (`1.234.567`), y el rótulo `Total` en la primera celda. **Control:** el mismo nodo sin `total` ⇒ sin `<tfoot>`.
4. **Render estático** (`interactive: false`) y **print** (`opts.print`): `<tfoot>` presente con el total de TODAS las filas aunque `rows.length > TABLE_PRINT_MAX_ROWS` (fixture de 5.001 filas: el `tbody` trunca, el pie no).
5. **SSR incompleto:** `rows.length > TABLE_SSR_MAX_ROWS` ⇒ el pie servido suma las 501+ filas, no las 500 del cuerpo.
6. **Runtime:** `TABLE_RUNTIME_SOURCE` contiene `function vtTotals` y `data-total-field` (que el recálculo viaja al browser). Además, `colMeta` del payload lleva `total` (`"total":"sum"` en el JSON del `<script class="vtable-data">`).
7. **Validación:** spec mínima con `total: promedio` ⇒ diagnóstico `table-column-total-invalid`; con `total: true` y `total: avg` ⇒ sin diagnósticos de ese código.
8. **Drill:** con `drills` declarados, la fila del pie tiene una celda más (`vt-actions`) y el número de `<td>` del pie = número de `<th>`.

## Orden de implementación

1 → 3 (`vtTotals` + tests 1–2 en verde) → 4 + 5 (render + CSS; tests 3–5, 8) → 3 (runtime `render()`; test 6) → 2 (validación; test 7) → 6–9 (docs, CHANGELOG, INDEX). `npm run typecheck` **después** de escribir los tests. `npm test` completo. `npm run capacidades:cotejo`.

## Qué NO hacer

- No hacer el total automático para columnas numéricas.
- No tocar `vtCsv…` ni la exportación.
- No implementar subtotales por grupo ni BigInt.
- No reordenar ni reformatear código ajeno al cambio; no tocar `dato`, `kpi` ni `semaforo`.
- No cambiar nada de `server/`.
- No mergear ni taggear: el PR se abre y se reporta; el merge lo hace la custodia (esta sesión) con CI verde.

## Criterios de aceptación

- [ ] `npm run typecheck` verde · `npm test` verde (suite completa) · `npm run capacidades:cotejo` verde.
- [ ] Los 8 tests nuevos pasan, y **al menos los tests 3, 6 y 7 fallan** si se revierte el cambio de código (verificar con `git stash` del código fuente dejando los tests: el ejecutor lo corre y lo reporta).
- [ ] Un spec de ejemplo de `examples/` (o uno nuevo mínimo) con `total: sum` renderiza el pie con `npm run vergis -- …` o el camino local que ya use el repo para renderizar un spec (el ejecutor lo averigua en `README`/`examples`, no lo inventa; si no hay camino local sin base de datos, lo dice y se apoya en el test 3).
- [ ] PR abierto contra `main` con título `feat(table): total al pie por columna (columns[].total) (#314)`, cuerpo con: qué trae, cómo se midió (comandos y salida), qué queda sin evidencia (la instancia GH corre 0.27.0: se verifica al promover 0.27.1), y `Closes #314`.

## Riesgos y reversión

- Riesgo: `thead` sticky o `.vt-scroll` con altura fija dejando el `tfoot` fuera del área visible → verificar en el CSS existente antes de cerrar; si hay `position: sticky` en `thead`, el `tfoot` va con `position: sticky; bottom: 0`.
- Riesgo: `render()` reconstruye `tbody.innerHTML`; el `tfoot` es hermano y no se toca, así que no hay pérdida de nodos.
- Reversión: revertir el PR; sin migración ni env, sin estado.

## Cierre (lo llena el ejecutor)

Ejecutado el 2026-09-21 en el worktree `../vergis-wt/314`, rama `feat/314-table-total`, sobre
`57c1325`. Los 9 puntos de «¿Dónde se toca?» quedaron implementados y la semántica decidida en
«¿Qué se decide acá y no se re-decide?» se respetó sin excepción.

### ¿Qué se desvió del plan, y por qué?

| # | Desviación | Motivo |
|--|--|--|
| 5 | El CSS del pie **no** quedó dentro de `TABLE_INTERACTIVE_CSS`: vive en una constante propia, `TABLE_TOTALS_CSS`, emitida por una señal nueva `signals.tableTotals` (misma mecánica que `magnitude` y `drillActions`) | `TABLE_INTERACTIVE_CSS` se inyecta **solo** con `signals.interactiveTable` (`render-html-piece.ts` l.100). Una tabla estática o en papel —los otros dos modos que el plan exige— se habría servido con el `<tfoot>` sin estilo. La regla sticky del riesgo declarado (`thead` sticky + `.vt-scroll` con `max-height:70vh`) sí quedó en el CSS interactivo, porque solo ahí existe el scroll. Es adaptación de ubicación, no de semántica |
| 2 | La validación **lanza `VergisError`** en vez de acumular un diagnóstico | `validate.ts` no tiene colector de diagnósticos: todo su vocabulario de códigos (`control-default-invalid`, `distribution-sort-unknown`, …) lanza. El código, el `path`, el `message` y la `remediation` son los que el plan pide. El schema **no** describe las columnas de `table`, así que —como el plan ordena— no se inventó bloque nuevo |
| 7 | El doc de referencia del DSL es `docs/catalogo-elementos.md`, sección nueva **§4·quáter** | Es donde ya viven §4·bis (color de magnitud) y §4·ter (filtro de columna), y donde `CAP-15`/`CAP-184`/`CAP-185` apuntan |
| Tests | **18 casos** en vez de 8 | Los 8 del plan están, repartidos en casos `it` de una aserción cada uno; se agregó uno noveno (grupo 9) que mide la **normalización de compose** de `total: true → 'sum'`, que el plan decide (punto 2) y ningún test del listado cubría |
| — | `vtTotals` acepta `total: true` además del vocabulario cerrado | Defensa barata: la función también corre en el browser sobre el payload embebido. Documentado en su firma |

### ¿Qué se corrió, y qué salió?

| Comando | Salida |
|--|--|
| `npm run typecheck` | sin errores (silencio de `tsc --noEmit`) |
| `npm test` | `Test Files 195 passed (195)` · `Tests 2778 passed (2778)` — ningún test ajeno se rompió |
| `npm run capacidades:cotejo` | `capacidades vigentes: 191 · retiradas: 0` · `✓ Numeración sana y todo lo declarado en máquina está citado` |
| `npm run build` | `dist/serve-rls.mjs 2.8mb` (tercer gate de `CLAUDE.md`) |
| `npm run vergis -- run <spec>/total.yaml` | `✔ html → …/total.html`, con `<tfoot><tr class="vt-total-row"><td class="align-left vt-total-label">Total</td><td class="align-right vt-total" data-total-field="cantidad">1.234.567</td><td class="align-right vt-total" data-total-field="rendimiento">100</td></tr></tfoot>` — `sum` = 1.000.000 + 234.567; `avg` = (120+80)/2 = 100 con la fila `null` **saltada**, no promediada |
| el mismo spec con `total: true` | payload con `"total":"sum"` y el mismo pie ⇒ el alias se normaliza en compose |

El spec de prueba es uno mínimo con `capability: static-data` (sin base de datos, sin VM): el camino
local que el repo ya usa (`examples/hello.yaml`). No se agregó a `examples/` para no ampliar el
alcance; vive fuera del repo.

### La corrida que los habría refutado

Con el **código fuente stasheado y los tests puestos** (`git stash push -- packages/`), los 18 casos
corren y **16 fallan**: `vtTotals is not a function` (grupos 1–2), `expected … to contain '<tfoot>'`
(grupos 3, 4, 5 y 8), `expected … to contain 'function vtTotals'` y `… '"total":"sum"'` (grupo 6),
`expected [Function] to throw an error` (grupo 7) y `expected undefined to be 'sum'` (grupo 9). Los
**2 que pasan son los dos CONTROLES** —la tabla sin `total` que no debe emitir pie, y `sum`/`avg`/
`count`/`true` que no deben ser rechazados—, que por construcción valen antes y después. Los tests
3, 6 y 7 que el plan nombra están entre los que fallan.

### ¿Qué queda sin evidencia?

- **El recálculo del pie en un navegador real.** Lo medido es que `vtTotals` viaja en
  `TABLE_RUNTIME_SOURCE`, que la fuente sigue siendo JS válido (`new Function(...)` no lanza), que
  lee `data-total-field` y que el payload de columnas trae `total`. Que el número cambie al marcar
  una faceta **no** está medido acá: el repo no tiene arnés de DOM. Se verifica al abrir un PI con
  la versión que lo publique.
- **La regla sticky del pie** (`position:sticky;bottom:0`) es CSS: se emite, pero que se vea fijo al
  fondo del `.vt-scroll` no lo mide ningún test.
- **La instancia GH corre 0.27.0**: nada de esto está corroborado contra su producción. Se corrobora
  al promover el corte que lo publique — corrobora, no mide (Ley, Norma 7).
- **BigInt**: no implementado por decisión del plan; un `SUM` sobre BIGINT por encima de
  `MAX_SAFE_INTEGER` perdería dígitos bajos, y está documentado en la función y en el CHANGELOG.

---

• *Generado con [Wingworking](https://wingworking.org)*
