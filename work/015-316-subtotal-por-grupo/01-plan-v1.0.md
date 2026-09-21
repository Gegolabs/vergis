# Plan · #316 — subtotal por grupo en la fila de cabecera de cada nivel de agrupación

| Campo | Valor |
|--|--|
| Objetivo | Cuando la tabla interactiva está **agrupada** (bandeja: «agrupar por…», niveles anidables), la fila de cabecera de cada grupo muestra, en las columnas que declaran `total` (#314), el agregado de **las filas de ese grupo** (subárbol completo), con el mismo cálculo del pie (`vtTotals`). Sigue a los filtros (el árbol se construye sobre `view`). |
| Origen | Issue [#316](https://github.com/Gegolabs/vergis/issues/316) · PI-37 de la instancia GH (Claudio Cornejo, 2026-09-21: «totalizador a discreción por mes y/o semana y/o especie y/o variedad, agregarlo o quitarlo cuando guste») · continúa #314 (0.28.0) |
| Diseño | Fable (esta sesión), sobre `main@273e065` (0.28.0) |
| Ejecutor | Subagente Opus, worktree `../vergis-wt/316`, rama `feat/316-subtotal-grupo` |
| Versión | «Sin publicar»; catálogo **`CAP-193`** (`CAP-192` está reservado para el PR #310, que se rebasa en paralelo) |

## ¿Qué se decide acá y no se re-decide?

1. **Opt-in doble, nada automático:** la columna declara `total` (ya existe) **y** el usuario agrupa. Sin agrupación no cambia nada; con agrupación pero sin columnas con `total`, la cabecera de grupo queda **exactamente como hoy** (un solo `<td colspan>`), byte a byte.
2. **El subtotal de un nivel es sobre todas las filas de su subárbol** (`g.rows`), no solo las hojas directas. `vtGroupTree` pasa a conservar `rows` en cada grupo (referencias, sin copiar).
3. **Un solo cálculo:** `vtTotals(cols, g.rows)`. Ninguna otra suma en el runtime. `avg`/`count` valen igual que en el pie; `null` ⇒ `—`.
4. **Forma de la fila con totales:** una celda por columna renderizada (`rc`) + la de acciones si hay drills (`nactions`). La **primera columna sin `total`** lleva caret + `Campo: valor (n)` con la sangría por profundidad (`padding-left` como hoy); cada columna con `total` lleva `<td class="align-<align> vt-gtotal" data-total-field="<field>">` con el valor formateado por `vtFormat(v, col.format)`; el resto, `<td></td>` vacíos. Si **todas** las columnas declaran `total`, el rótulo va en la primera y su subtotal no se muestra (caso límite, documentado en el comentario de la función; no se inventa otra fila).
5. **Ninguna celda de subtotal lleva `--mag`** ni clase de magnitud (misma razón que el pie).
6. **La cabecera sigue siendo clicable entera** (colapsar/expandir): el listener actual busca `tr.vt-group-head` por `closest`, así que las celdas nuevas no rompen el gesto. Verificarlo leyendo el listener (l.~1147), no suponerlo.
7. **El pie (`tfoot`) no cambia**: sigue siendo el total de `view`. Reconciliación obligatoria: Σ subtotales del primer nivel = total del pie, para `sum` y `count`.
8. **Papel (print) y tabla estática:** sin cambio — la agrupación es client-side y solo existe en la interactiva.
9. **CSV:** fuera (igual que #314).

## ¿Dónde se toca? (anclado a `main@273e065`)

| # | Archivo | Cambio |
|--|--|--|
| 1 | `packages/capabilities/src/table-runtime.ts` `vtGroupTree` (l.~607) y su tipo `VtTreeNode` | cada grupo lleva `rows: g.rows` además de `key`, `count`, `child`. |
| 2 | `packages/capabilities/src/table-runtime.ts` — **nueva función pura `vtGroupHeadCells(cols, rows, nactions, labelHtml, padPx)`** en `PURE_FNS` y exportada | Devuelve el HTML de las celdas de la cabecera: si `!cols.some(c=>c.total)` ⇒ `'<td colspan="'+(cols.length+nactions)+'" style="padding-left:'+padPx+'px">'+labelHtml+'</td>'` (idéntico a hoy); si no ⇒ una celda por columna según la decisión 4 (+ `<td class="vt-actions"></td>` × `nactions`). Autocontenida salvo llamadas a `vtTotals` y `vtFormat` (ambas en `PURE_FNS`, resolubles por nombre en el browser). |
| 3 | `packages/capabilities/src/table-runtime.ts` `renderNodeTree` (l.~1184) | reemplaza el `<td colspan…>` inline por `vtGroupHeadCells(rc, g.rows, nactions, '<span class="vt-gcaret">…</span> '+label+' <span class="vt-gcount">(n)</span>', depth*18+12)`. El `<tr>` conserva `class="vt-group-head" data-depth data-path`. `vtEsc` sigue aplicándose a `colLabel` y `g.key` **antes** de armar `labelHtml`. |
| 4 | `packages/capabilities/src/piece-css.ts` | `.vtable tr.vt-group-head td.vt-gtotal{text-transform:none;letter-spacing:0;font-variant-numeric:tabular-nums;font-weight:600}` y `.vtable tr.vt-group-head td.vt-gtotal.align-right{text-align:right}` (revisar si `align-right` ya existe global; si sí, no duplicar). |
| 5 | `docs/capacidades.md` | Fila **`CAP-193`** · «Subtotal por grupo en la cabecera de cada nivel de agrupación (columnas con `total`), mismo cálculo que el pie, sigue a los filtros» · `<sin publicar>` · doc. |
| 6 | `docs/catalogo-elementos.md` §4·quáter | Un párrafo: con agrupación activa, las columnas con `total` muestran subtotal por grupo. |
| 7 | `CHANGELOG.md` «Sin publicar» | `### Subtotal por grupo en la fila de cabecera (columnas con total)` — qué trae, qué exige (nada), qué NO hace (CSV; nada en papel/estática; nada sin `total`). Referencias: #316; origen PI-37/PI-15 de la instancia GH. |
| 8 | `INDEX.md` | Fila `015` → este directorio. |

## Tests (`tests/table-group-totals.test.ts`, cada uno debe fallar contra `main`)

1. `vtGroupTree`: cada grupo trae `rows` con exactamente las filas del subárbol (2 niveles; `rows.length === count`).
2. `vtGroupHeadCells` **sin** columnas con `total` ⇒ un solo `<td colspan="N">` con el `labelHtml` y el `padding-left` (control de invariancia: string idéntico al formato actual).
3. `vtGroupHeadCells` con `cantidad total: sum` ⇒ celda `data-total-field="cantidad"` con el valor `es-CL` (`1.234`), rótulo en la primera columna sin total, celdas vacías para las demás, `+ nactions` celdas de acciones.
4. Todas las columnas con `total` ⇒ el rótulo va en la primera y no hay `data-total-field` para ella; el resto sí.
5. **Reconciliación:** fixture con semilla, 300 filas, 2 niveles (`mes` → `especie`): Σ de `vtTotals` sobre `rows` de cada grupo de primer nivel = `vtTotals(cols, rows)` total, para `sum` y `count`; y Σ de los hijos de un grupo = el del padre.
6. `avg` por grupo: valor = suma/considerados del grupo (con un `null` saltado); `count` cuenta considerados.
7. `TABLE_RUNTIME_SOURCE` contiene `function vtGroupHeadCells` y `vt-gtotal` (que viaja al browser) y **no** contiene el literal viejo `'<td colspan="'+ncols+'" style="padding-left:'` dentro de `renderNodeTree` (que la ruta vieja se reemplazó, no se duplicó).

## Orden

1 → 2 (+ tests 1–6) → 3 → 4 (+ test 7) → 5–8. `npm run typecheck` **después** de los tests; `npm test`; `npm run capacidades:cotejo` (debe seguir sano con `CAP-193`; si el cotejo exige contigüidad y falla porque `CAP-192` no existe aún en `main`, reportarlo y **no** renumerar: `CAP-192` es de #310).

## Qué NO hacer

- No tocar `renderTableFoot`, `vtTotals`, `vtApply`, `vtBodyRows`, el CSV, ni el render de papel/estática.
- No hacer el subtotal automático ni añadir vocabulario nuevo al DSL.
- No mergear ni taggear.

## Criterios de aceptación

- [ ] typecheck · suite completa · capacidades:cotejo en verde (o el caso `CAP-192` reportado tal cual).
- [ ] Stash-check: con el código fuera y los tests puestos, fallan al menos 1, 3, 5 y 7.
- [ ] Render local sin BD (`npm run vergis -- run` con `static-data`, como en #314): el HTML servido **no** cambia respecto de `main` para una tabla agrupable sin agrupar (la agrupación es client-side) — se declara; la evidencia de la cabecera con subtotal es el test 3 + el test 7.
- [ ] PR contra `main`: `feat(table): subtotal por grupo en la cabecera de cada nivel de agrupación (#316)`, cuerpo con medición, sin evidencia (navegador real), `Closes #316`, y las líneas de atribución de siempre.

## Cierre (lo llena el ejecutor)

Ejecutado el 2026-09-21 en el worktree `../vergis-wt/316`, rama `feat/316-subtotal-grupo`, sobre
`main@273e065`. Los 8 puntos de «¿Dónde se toca?» quedaron implementados y las 9 decisiones de
«¿Qué se decide acá y no se re-decide?» se respetaron sin excepción: ni `renderTableFoot`, ni
`vtTotals`, ni `vtApply`, ni `vtBodyRows`, ni el CSV, ni el render de papel/estática se tocaron.

### ¿Qué se desvió del plan, y por qué?

| # | Desviación | Motivo |
|--|--|--|
| 3 | `renderNodeTree` **pierde el parámetro `ncols`** (pasa de `(rc, ncols, node, depth, prefix)` a `(rc, node, depth, prefix)`), con sus dos llamadas actualizadas | `ncols` solo existía para el `colspan` que `vtGroupHeadCells` ahora calcula por sí misma. Dejarlo habría sido un parámetro muerto. `ncols` sigue vivo en `render()` para el `<tr class="vt-empty">`. Adaptación de ubicación, no de semántica |
| 2 | El `field` que va al atributo se emite con las comillas escapadas (`String(c.field).replace(/"/g,'&quot;')`) | El plan pide la función autocontenida salvo `vtTotals`/`vtFormat`, y `vtEsc` **no** viaja en `PURE_FNS`. Un `replace` inline mantiene la autocontención y no deja el atributo sin escapar. Ningún efecto sobre el HTML de un `field` normal |
| 4 | El CSS **no** duplica `.vt-gtotal.align-right{text-align:right}` | El plan mandaba revisarlo: `.align-right{text-align:right}` ya existe global en los dos temas (`themes/default.ts` l.73, `themes/arbol.ts` l.215) y nada en `tr.vt-group-head td` fija `text-align`, así que la regla global gana sin ayuda |
| 6 | El doc no es «un párrafo en §4·quáter»: es una **sección nueva, §4·quinquies**, más la corrección de la línea de §4·quáter que declaraba «no hay subtotales por grupo» (quedó falsa con este cambio) | `CAP-193` necesita un ancla propia a la que apuntar, igual que §4·bis/ter/quáter sirven a `CAP-15`/`CAP-184`/`CAP-191`. Deja de ser cierto que el pie sea la única totalización, y una línea que lo siguiera afirmando desinformaría |
| Tests | **20 casos** en vez de 7 | Los 7 del plan están, repartidos en casos `it` de una aserción cada uno (grupos 1–7 del archivo); se agregaron controles que el listado implicaba: colspan con acciones, ausencia de `--mag`, el `—` del subtotal nulo, y que la fuente del runtime siga siendo JS válido |

### ¿Qué se corrió, y qué salió?

| Comando | Salida |
|--|--|
| `npm run typecheck` | sin errores (silencio de `tsc --noEmit`) |
| `npm test` | `Test Files 1 failed \| 195 passed (196)` · `Tests 1 failed \| 2797 passed (2798)`. **El único fallo es `tests/capacidades-catalogo.test.ts`, por el hueco `CAP-192`** — ver abajo. Ningún test ajeno se rompió |
| `npm run capacidades:cotejo` | `capacidades vigentes: 192 · retiradas: 0` y `✗ NUMERACIÓN: hueco sin explicar: CAP-192 no aparece ni como capacidad vigente ni como retirada` |
| `npm run build` | `dist/serve-rls.mjs 2.8mb` (tercer gate de `CLAUDE.md`) |
| `npx vitest run tests/table-group-totals.test.ts` | `Tests 20 passed (20)` |
| `npm run vergis -- run subtotal.yaml` (`static-data`, sin BD) | el `<table>` servido es **byte a byte el de `main`** (diff vacío del bloque `<table>…</table>`); el documento difiere solo en la regla CSS nueva y en el runtime (`function vtGroupHeadCells`, `renderNodeTree` sin `ncols`) |

**El hueco `CAP-192` es el caso que el plan previó y NO se renumeró:** `CAP-192` está reservado para
el PR #310, que se rebasa en paralelo y todavía no está en `main`; esta rama declara `CAP-193`. El
cotejo —y el test que lo envuelve— vuelven a verde en cuanto #310 aterrice, sin tocar nada de acá.
Renumerar a `CAP-192` habría hecho pasar el gate a costa de colisionar con #310.

### La corrida que los habría refutado

Con el **código fuente stasheado y los tests puestos** (`git stash push -- packages/`), el archivo
**no llega ni a colectar**: `TypeError: vtGroupHeadCells is not a function` — los 20 casos caen. Esa
corrida refuta en bloque pero no distingue el mecanismo del import, así que se corrió una **segunda**
con una variante del archivo limitada a los grupos 1, 5 y 7 (los que usan solo API que `main` ya
exporta: `vtGroupTree`, `vtTotals`, `TABLE_RUNTIME_SOURCE`): **7 de 8 casos fallan** contra `main`
—`Cannot read properties of undefined (reading 'length')` y `expected undefined to deeply equal […]`
en el árbol sin `rows`; la reconciliación entera; y los dos del runtime (`function vtGroupHeadCells`
ausente, `<td colspan="'+ncols+'"` todavía presente)—. **El que pasa es el control**: la fuente del
runtime ya era JS válido antes y después. Los casos 1, 3, 5 y 7 que el plan nombra están entre los
que caen.

### ¿Qué queda sin evidencia?

- **El subtotal dibujado en un navegador real.** Lo medido es que `vtGroupHeadCells` viaja en
  `TABLE_RUNTIME_SOURCE`, que la fuente sigue siendo JS válido, que `vtGroupTree` entrega las filas
  del subárbol y que la función arma las celdas correctas. Que la cabecera se repinte al agrupar
  desde la bandeja, y que el gesto de colapsar siga funcionando con las celdas nuevas, **no** lo
  mide ningún test: el repo no tiene arnés de DOM. Lo que sí se verificó por lectura es el listener
  (`tbody.addEventListener('click', …)` busca `e.target.closest('tr.vt-group-head')`, no un `<td>`
  concreto), así que las celdas nuevas quedan dentro del mismo `<tr>` que el gesto interroga.
- **La instancia GH corre 0.28.0**: nada de esto está corroborado contra su producción, y su
  despliegue corroborará — no medirá — lo ya medido acá.
- **El cotejo de capacidades queda rojo** hasta que #310 publique `CAP-192`. Es una condición
  externa a esta rama, declarada arriba.

---

• *Generado con [Wingworking](https://wingworking.org)*
