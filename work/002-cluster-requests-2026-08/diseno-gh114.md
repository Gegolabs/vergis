# Diseño #114 — Estado de los filtros activos VISIBLE en el cuerpo del PI (chips)

> Contrato de delegación wingcoding: **Fable diseñó, Opus implementa en frío.** Este documento es
> autocontenido: todo lo que hay que saber está aquí o en las rutas exactas que se citan.
> Issue: <https://github.com/Gegolabs/vergis/issues/114> · Ola B del cluster 002.

## ¿Qué pide el issue?

Que un lector que mira el cuerpo del PI (o una foto de él) sepa **de un vistazo** si mira el total
o un subconjunto: cuando hay filtros activos, el cuerpo muestra chips «dimensión: valor»; sin
filtros activos, **cero cromo**. Es convención de plataforma (todos los PIs por igual, nada
configurable per-spec). El chip es **estado, no control**: editar sigue viviendo en el inspector
(la bandeja lateral); si además permite quitar con ✕, mejor.

## ¿Qué hay hoy en el código? (inventario verificado)

Hay **cuatro superficies de acotación** y el issue solo tiene UN hueco real. Todo lo siguiente está
verificado contra el código en la rama `main` (commit `10393e0`):

| Familia | Dónde se declara | Dónde aplica | ¿Estado visible en el cuerpo hoy? |
|---|---|---|---|
| **Controles de cabecera** (`controls`, `:ctx.*`) | spec DSL | server-side (binds por request) | **Sí** — banda de contexto sticky `.vctxbar` (el sello ES el control, TX-11). `renderContextStrip` en `packages/capabilities/src/render-html-piece.ts`. No son filtros: son **alcance** (siempre tienen valor, siempre acotan). |
| **Filtros de bandeja server-side** (#82, `filters`, `:flt.*`) | spec DSL | server-side (navegación + re-render) | **Sí** — chips `.vfltbar` con ✕ por valor, «limpiar todo» y resumen de print, YA implementados: `renderFilterChips` en `render-html-piece.ts` (líneas ~265–289) + `FILTER_CHIPS_CSS`. Cubierto por `tests/filtros-bandeja.test.ts` (describe «superficie»). |
| **Facetas client-side de dashboard** (`interactions.filters`) | spec DSL | client-side (checkboxes del tab «Controles» de la bandeja; `update()` recomputa KPIs/semáforo sobre datasets materializados) | **NO** — la única señal es el badge numérico `#vergis-count` en la uña de la bandeja (`interactive-script.ts`, función `update()`). Un lector del cuerpo no ve qué está filtrado ni a qué valores. **← ESTE es el hueco.** |
| **Runtime de tabla** (facetas por columna + búsqueda global) | automático por tabla interactiva | client-side | **Sí** — chips `.vt-chips` sobre cada tabla (`table-runtime.ts`, dentro de `render()`, líneas ~551–556), con ×, contador al pie `.vt-count-foot` y degradación print ya resuelta en `TABLE_INTERACTIVE_CSS`. |

**Conclusión de la disección**: el issue, leído contra el código, se implementa cerrando el hueco de
las facetas client-side de dashboard — y sellando la convención con tests que la protejan entera.
No hay que construir la franja de chips desde cero: existe (`.vfltbar`, #82) y este diseño la
convierte en la franja ÚNICA de estado de filtros, compartida por filtros server-side y facetas
client-side.

**Conjetura etiquetada** (no verificable desde este repo): el spec de PI-17 vive en la instancia GH,
no aquí; **se asume** que su fricción vino de facetas client-side o del runtime de tabla. No importa
para el diseño: la convención queda cubierta para las tres familias de filtros, use PI-17 la que use.

## ¿Cómo viven hoy las facetas client-side? (mecánica exacta, para el implementador)

- Mira materializa `interactive = { datasets, filters }` solo si `spec.interactions.filters` existe y
  el total de filas no supera `interactiveMaxRows` (`packages/mira/src/mira.ts`, paso 5a).
- `render-html-piece.ts` pinta las facetas como checkboxes en la bandeja (`renderDashboardFacets`)
  y anexa `renderInteractiveScript(interactive)` al final del body.
- `interactive-script.ts` genera el `<script>`: `boxes` = todos los checkboxes de la bandeja,
  `update()` recomputa `[data-agg]`, `[data-semaforo]`, `[data-summary]` y el badge. El estado vive
  SOLO en el DOM (checked); no viaja por URL; las «Vistas» guardadas lo persisten aparte
  (`vergisSavedViews`).
- El orden del body hoy: `contextStrip + chips + nav + contenido` (línea ~51 de
  `render-html-piece.ts`), donde `chips` es la franja `.vfltbar` de #82 (vacía = string vacío).

## ¿Decisiones selladas?

**D1 — Qué cuenta como «filtro activo».** Selección efectiva no vacía, por familia:
filtros server-side → `selected.length > 0` (criterio ya vigente en `renderFilterChips`);
facetas client-side → faceta con ≥1 checkbox marcado; runtime de tabla → faceta de columna con
selección o búsqueda global no vacía (criterio ya vigente en `.vt-chips`). Los **controles de
cabecera NO son filtros** (son alcance, siempre visibles en `.vctxbar`) — quedan fuera. La
**agrupación** de tabla NO es filtro (no sustrae filas) — no genera chip (sigue contando en el
badge, como hoy).

**D2 — Dónde se pintan.** UNA franja `.vfltbar` por documento, en la posición ya convenida por #82:
**entre la banda de contexto (`.vctxbar`) y la nav de páginas (`.vpages`)**, dentro del body — nunca
en el header del theme (territorio de #108). Los chips de facetas client-side se pintan EN ESA MISMA
franja (no una segunda barra). Los chips del runtime de tabla se quedan donde están, sobre su tabla:
una página puede tener varias tablas y el chip pegado al dato que recorta es MÁS legible en foto que
uno global que no dice cuál tabla; no se tocan.

**D3 — Forma del chip.** `Etiqueta: valor ✕`, clases `.vflt-chip` existentes (una sola convención
visual para server y client). Los chips client llevan además la clase `vflt-live` y
`data-field`/`data-val` para el toggle. La etiqueta de la faceta es `f.label ?? f.field` (la misma
que muestra la bandeja).

**D4 — Sin filtros activos: cero cromo.** La franja no se ve. Racional de foto: la ausencia de
franja significa «documento completo»; un rótulo permanente «sin filtros» sería ruido y además
ambiguo en PIs que ni siquiera declaran filtros. Mecánica: con filtros server-side activos la franja
se emite como hoy; cuando hay facetas client-side declaradas (con o sin server chips), la franja se
emite SIEMPRE como contenedor (con `hidden` si no trae chips server) y `update()` la muestra/oculta
según haya chips vivos. Sin `filters` activos NI `interactive.filters` → no se emite nada (byte a
byte igual que hoy; protege las aserciones `not.toContain('vfltbar')` existentes).

**D5 — Interacción: mínimo ideal = ✕ por chip, nada más.** El ✕ de un chip server navega quitando
ese valor (ya implementado). El ✕ de un chip client desmarca el checkbox correspondiente de la
bandeja y llama `update()` (mismo efecto que tocarlo en la faceta — una sola fuente de verdad: el
DOM de los checkboxes). El cuerpo del chip NO abre el inspector: la uña ya es visible y clickeable,
y un chip-que-abre junto a un ✕-que-borra es ambigüedad gestual gratuita.

**D6 — Print.** Igual paridad que #82: en `@media print` los chips (botones) se ocultan y queda el
resumen textual. La franja lleva, además del `.vflt-print` server-rendered actual, un slot
`<span class="vflt-print" id="vergis-flt-live-print"></span>` que `update()` mantiene con
`Filtros — Etiqueta: v1, v2 · …` (solo facetas activas; vacío si ninguna). El CSS print vigente de
`FILTER_CHIPS_CSS` ya alterna `.vflt-screen`/`.vflt-print` — no hay que tocarlo para esto.

**D7 — Server-rendered vs client-rendered: el diseño sigue a la realidad.** Los filtros #82 aplican
por request → chips server-rendered (ya hecho, no se toca). Las facetas aplican client-side → chips
client-rendered por el MISMO script que ya recomputa (`update()`); no se inventa persistencia por
URL para facetas (fuera de alcance; «Vistas» ya cubre persistencia).

**D8 — Multi-vista/drill.** Sin cambios: los `flt.` viajan en el carry (ya); el estado de facetas es
por-página y se resetea al navegar (coherente con su naturaleza DOM). Los chips reflejan siempre el
estado real de la página servida.

**D9 — Convención de plataforma.** Cero cambios en el DSL, el schema (`schema/mira-spec.schema.json`)
y `packages/mira/*`: nada per-spec, nada configurable.

## ¿Territorio exacto?

Solo `packages/capabilities/src/` (render) + tests:

1. `packages/capabilities/src/render-html-piece.ts` — `renderFilterChips` y su llamada.
2. `packages/capabilities/src/interactive-script.ts` — `update()` + listener del ✕.
3. `tests/filtros-visibles-facetas.test.ts` — NUEVO.

Nada más. En particular NO se tocan: `packages/mira/**` (filters.ts/controls.ts/mira.ts ya hacen su
parte), `packages/capabilities/src/themes/**` (header del theme = territorio de #108),
`table-runtime.ts` ni `render-table.ts` (sus chips ya cumplen), `piece-css.ts`, el schema, el
server, ni nada de RLS/enforcement.

## ¿Tareas?

### T1 — La franja `.vfltbar` acepta chips vivos (render server)

En `render-html-piece.ts`:

- Cambiar la firma a `renderFilterChips(filters, activePage, carry, flt, hasFacets: boolean)` donde
  `hasFacets = !!(interactive && interactive.filters.length > 0)` desde el caller (línea ~49).
- Comportamiento:
  - `active.length === 0 && !hasFacets` → `''` (idéntico a hoy).
  - `active.length > 0` → la franja actual, más (si `hasFacets`) los dos slots vivos.
  - `active.length === 0 && hasFacets` → `<div class="vfltbar" id="vergis-fltbar" hidden>` con el
    rótulo `<span class="vflt-k vflt-screen">Filtros</span>`, los dos slots vivos, y nada más.
  - Los slots vivos: `<span id="vergis-flt-live"></span>` (chips de pantalla) y
    `<span class="vflt-print" id="vergis-flt-live-print"></span>` (resumen print).
  - Cuando la franja existe (cualquier caso), lleva `id="vergis-fltbar"` (el script la localiza por
    id; hoy no tiene id — agregarlo también en el caso server-only es inofensivo y uniforme).
- Inyección de CSS (línea ~87): la condición `if (chips) css += FILTER_CHIPS_CSS` sigue válida
  porque ahora `chips !== ''` también cuando solo hay facetas — verificar que así quede.
- Agregar a `FILTER_CHIPS_CSS` la regla del ✕ vivo (es `<span>`, no `<a>`):
  `.vfltbar .vflt-live .vflt-x{cursor:pointer}`.

**Hecho cuando**: `npx vitest run tests/filtros-bandeja.test.ts` sigue verde (las aserciones
`not.toContain('vfltbar')` de las líneas ~300 y ~403 cubren specs SIN `interactions` — no deben
romperse) y los casos nuevos de T3 sobre la franja pasan.

### T2 — `update()` pinta los chips vivos (script client)

En `interactive-script.ts`, dentro del IIFE generado:

- Referencias al inicio: `var fltbar = document.getElementById('vergis-fltbar');`,
  `var liveEl = document.getElementById('vergis-flt-live');`,
  `var livePrintEl = document.getElementById('vergis-flt-live-print');`.
- En `update()`, tras recomputar (usar el `esc()` ya presente en el script):
  - construir por cada `f` de `FILTERS` con `selectedFor(f.field).length > 0` un chip por valor:
    `<span class="vflt-chip vflt-screen vflt-live" data-field="…" data-val="…"><b>Label:</b> valor <span class="vflt-x" title="Quitar este filtro">✕</span></span>`
    (label = `f.label || f.field`);
  - `liveEl.innerHTML = chips.join('')`;
  - `livePrintEl.textContent` = `'Filtros — ' + resumen` o `''`;
  - visibilidad: `fltbar.hidden = !fltbar.querySelector('.vflt-chip')` — así la franja aparece con
    el primer chip vivo y desaparece con el último, pero NUNCA se oculta si hay chips server (que
    también son `.vflt-chip` y están siempre en el DOM). Guardas `if (fltbar && liveEl)` en todo.
- Listener delegado (una vez, fuera de `update()`): click en `#vergis-flt-live` sobre un `.vflt-x` →
  tomar `data-field`/`data-val` del chip, desmarcar el checkbox de la bandeja cuyo
  `getAttribute('data-field')` y `value` coincidan, y llamar `update()`.
- El badge `#vergis-count` no cambia.

**Hecho cuando**: los casos de T3 sobre el script pasan, incluido el chequeo de sintaxis
`new Function(...)`.

### T3 — Tests de la convención

Nuevo `tests/filtros-visibles-facetas.test.ts`, siguiendo el patrón del repo (string-level +
`new Function` para sintaxis; el entorno vitest es node, sin jsdom — igual que
`tests/tx11-superficie.test.ts` y `tests/aggregations.test.ts`, que invocan
`renderHtmlPiece.execute` directo):

```ts
import { renderHtmlPiece } from '@vergis/capabilities'
import { renderInteractiveScript } from '../packages/capabilities/src/interactive-script'
```

Casos mínimos (nombres orientativos):

1. **Dashboard con facetas y sin filtros server → franja oculta lista para vivir**: render con
   `interactive: { datasets: { d: rows }, filters: [{ dataset: 'd', field: 'area', label: 'Área' }] }`
   y sin `filters` → el HTML contiene `id="vergis-fltbar"` con `hidden`, `id="vergis-flt-live"`,
   `id="vergis-flt-live-print"` y el CSS `.vfltbar` (FILTER_CHIPS_CSS inyectado).
2. **Sin facetas ni filtros activos → cero cromo** (regresión): render sin `interactive` ni
   `filters` → `not.toContain('vfltbar')`.
3. **Server + facetas → UNA sola franja, visible**: render con `filters` activos
   (`[{ id, label, multi: false, options: ['Norte'], selected: ['Norte'] }]`) e `interactive` → el
   HTML contiene exactamente una ocurrencia de `class="vfltbar"`, SIN `hidden` en su tag, y con los
   slots vivos dentro.
4. **El script pinta y despinta**: `renderInteractiveScript(it)` contiene `vergis-flt-live`,
   `vflt-live`, `vflt-x`, la escritura de `hidden` y el listener de remoción; y
   `new Function(<contenido sin las etiquetas script>)` no lanza (validez sintáctica — patrón
   declarado en la cabecera de `interactive-script.ts`).
5. **El chip es removible desmarcando el checkbox**: aserción string de que el listener busca el
   checkbox por `data-field` + `value` y llama `update()` (no hay DOM en el entorno de test; el
   comportamiento fino queda cubierto por la validez sintáctica + la revisión del QC visual de
   instancia, como el resto del runtime client del repo).

**Hecho cuando**: `npx vitest run tests/filtros-visibles-facetas.test.ts` verde.

## ¿Reglas duras?

- **NO tocar** `packages/capabilities/src/themes/**` ni nada del header del PI / `meta` — es la
  franja de #108 (as-of), que se diseña en paralelo. Los chips viven en el body, bajo `.vctxbar`.
- **NO tocar** `packages/mira/**`, el schema del DSL, el server, RLS/enforcement, `table-runtime.ts`
  ni `render-table.ts`.
- **NO agregar** nada configurable per-spec: es convención de plataforma.
- UI en español; sin dependencias nuevas; sin jsdom.
- Los valores del usuario que acaban en HTML pasan por `esc()`/`escapeHtml` — los chips muestran
  valores de datos (mismo régimen que las facetas actuales).

## ¿Juez?

`npm run typecheck` && `npm test` && `npm run build` — los tres verdes, con
`tests/filtros-visibles-facetas.test.ts` incluido y **sin tocar** ninguna aserción existente
(`tests/filtros-bandeja.test.ts`, `tests/tx11-superficie.test.ts`, `tests/aggregations.test.ts`,
`tests/render-tray-always.test.ts` deben pasar tal cual están).

## ¿Riesgos?

- **La franja `hidden` aparece en el DOM de dashboards que antes no la tenían** — riesgo de romper
  aserciones `not.toContain('vfltbar')`. Auditado: solo existen en `filtros-bandeja.test.ts`
  (líneas ~300 y ~403) y ambas usan specs sin `interactions` → no cambian. Correr la suite completa
  confirma.
- **Sin jsdom, el comportamiento del click no se ejecuta en tests** — se asume la misma cobertura
  que el resto del runtime client del repo (sintaxis + strings + QC de instancia). Es el patrón
  establecido, no una excepción nueva.
- **Doble estilo de chip** (`.vflt-chip` global vs `.vt-chip` de tabla): queda como deuda estética
  menor y deliberada — unificar el look de `.vt-chip` es scope creep de este frente.
- **Facetas por encima de `interactiveMaxRows`**: si Mira no materializa (`mira-interaction-skipped`),
  no hay facetas → no hay chips → coherente por construcción; nada que hacer.
- **Conjetura PI-17** (ver inventario): si su fricción viniera de una familia ya cubierta, este
  frente igual sella la convención y el issue cierra por la definición del pedido (visibilidad en
  todas las familias).

— Diseño Fable · cluster 002 · 2026-08-06
