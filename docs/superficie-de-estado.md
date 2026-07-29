# Superficie de estado — cómo un PI expone su alcance, sus filtros y su maquinaria

> **Documentación canónica del Producto** (TX-11). Define la convención de superficie de todo PI:
> qué se ve en la **cara**, qué vive en la **gaveta** (Inspector) y qué se lleva el **print**.
> Comportamiento **genérico**, 100 % de presentación: no toca el DSL, los specs, el camino de datos
> ni la semántica de URL. Es también el contrato de superficie que consume el PDF server-side (TX-09).

## 1 · La convención en una línea

**cara = estado · gaveta = maquinaria · print = estado como texto.**

- La **cara** muestra el estado del documento: qué alcance se está viendo (los sellos), qué filtros
  están activos (los chips) y cuántas filas rinde cada tabla (el pie de contador).
- La **gaveta** (Inspector) guarda la **maquinaria**: los pickers de filtro, la búsqueda, el
  agrupar-por, la descarga CSV, los guardados y la config. Nada de esto se imprime.
- El **print** conserva solo el estado, como texto plano: el sello impreso es «OC 17400358», los
  filtros activos son letra chica («Filtros: …»), la maquinaria desaparece.

## 2 · Taxonomía: alcance ≠ filtro

| | **Selector de alcance** | **Filtro** |
|---|---|---|
| Qué hace | elige QUÉ documento se ve (`:ctx.*` en las queries; re-ancla los KPIs) | acota las filas ya traídas |
| Puede estar vacío | **no** (siempre hay un alcance vigente) | **sí** (default = sin efecto = documento completo) |
| Test | si «limpiar» no puede quedar vacío → alcance | si «limpiar» devuelve un superconjunto → filtro |
| Superficie | **sello** siempre visible y clickeable en la banda | **maquinaria** en la gaveta; su estado activo, como chip en la cara |
| En print | texto plano | letra chica sin la ✕ (si está activo); si no, sin rastro |

## 3 · El sello de alcance (la banda de contexto)

Todo PI con `controls:` muestra una **banda estándar** (sticky, arriba) con un sello por control. El
sello **es** el control (una cosa, un lugar — no se duplica en la gaveta):

- **single** → un `<select>` nativo estilizado como sello (accesible por teclado sin reinventar el
  widget). Su `onchange` navega fijando `?ctx.<id>=<valor>` y preservando `page` + el resto del
  contexto — la MISMA mecánica del control histórico de la gaveta.
- **multi** → un `<details>` cuyo *summary* muestra el valor unido («Semana: 27, 28») y cuyo popover
  reúne los checkboxes; cada cambio repite `?ctx.<id>=…` por valor.

Por cada ítem se emiten dos representaciones: `.vctx-screen` (el widget) y `.vctx-print` (el texto).
El CSS `@media print` oculta el widget y deja el texto.

## 4 · Los chips de filtro activo

Los filtros y la búsqueda aplicados aparecen como **chips removibles** en la cara, solo cuando están
activos (silencio = default = documento completo). En print, los chips se imprimen como **letra
chica** («Filtros: Clasificación: X · buscar: rosas»), ocultando solo la acción (la ✕, envuelta en
`.vt-chip-x`). **Agrupar-por no imprime chips**: su estado ya es autoevidente en la estructura de la
tabla renderizada.

## 4·bis · Los dos motores de filtro (y cuándo usar cada uno)

Hay **dos** mecanismos de filtro, con la misma superficie y distinto motor. La regla de elección es
una sola: **¿el documento tiene charts?**

| | `interactions.filters` (client-side) | **`filters:` (server-side, `:flt.*`)** |
|---|---|---|
| Cómo re-ancla | recompute JS sobre datasets materializados en el HTML | **navegación + re-render server-side** |
| Qué alcanza a re-anclar | KPIs, semáforo y tabla | **todo: charts, KPIs, semáforo y tabla** |
| Costo | los datasets viajan completos al HTML | solo las opciones visibles viajan; el catálogo queda server-side |
| Cascada de opciones | no | **sí** (`depends_on`) |
| Cuándo usarlo | reportes tabulares sin gráficos: es el camino barato | **dashboards con charts** |

Los charts son **SVG horneado server-side** (así imprimen gratis, TX-09). Ningún JS de recompute
puede re-dibujarlos sin re-ejecutar Vega en el browser, que es justo lo que el contrato del motor no
hace. Por eso `filters:` re-ancla por re-render, no por recompute. Los dos mecanismos **coexisten**:
un spec puede declarar ambos, y el client-side opera sobre lo que el server ya recortó.

### El bloque `filters:` en el DSL

```yaml
filters:
  - id: familia
    label: Familia
    source: data.catalogo.familia    # catálogo de opciones (un SELECT DISTINCT, bajo la misma RLS)
  - id: tipo
    label: Tipo
    source: data.catalogo.tipo
    multi: true
    depends_on: familia              # cascada: las opciones se condicionan por la selección del padre

data:
  hechos:
    params:
      sql: "SELECT … FROM dbo.hechos WHERE 1=1 AND :flt.familia AND :flt.tipo"
```

- **`:flt.<id>` es un placeholder de PREDICADO**: sin selección se sustituye por `1=1` (ausencia =
  sin efecto = documento completo); con selección, por `<column> IN (@flt_<id>_0, …)`. Los valores del
  usuario viajan **siempre como binds**, jamás interpolados.
- **La granularidad la decide el spec**: los datasets sin `:flt.` no se re-anclan. Así un dashboard
  puede dejar deliberadamente fuera del filtro sus tarjetas de encabezado o una curva de referencia,
  sin ninguna regla especial del motor.
- **`column`** (default: el campo de `source`) es la columna que el predicado filtra; se **interpola**
  en el SQL, así que se valida como identificador — nunca admite una expresión.
- **Correspondencia obligatoria en ambas direcciones**: un `:flt.` sin filtro declarado y un filtro
  que ningún SQL usa son errores de validación, no silencios. El primero sería un filtro que no
  filtra; el segundo, un control en la bandeja que no mueve nada.

### Por qué un placeholder nuevo y no `:ctx.` «expandido»

Reutilizar `:ctx.` expandiendo a todas las opciones cuando no hay selección rompería tres cosas a la
vez: la **semántica de NULL** (las filas con el campo nulo desaparecerían sin que nadie filtrara), el
**tope de parámetros TDS** (~2100 binds con catálogos grandes) y la **nitidez del contrato**
«ausencia = sin efecto».

### Autorización

El filtro es **sustractivo por construcción**: compone dentro de queries que ya corren bajo la RLS
data-anchored, y sus opciones salen del catálogo, que también corrió bajo RLS. Una selección fuera del
catálogo se **descarta** — jamás se bindea. La cascada es post-RLS por construcción, porque opera
in-memory sobre un catálogo ya recortado. Un filtro **nunca** puede producir filas adicionales.

## 5 · Afordancias proporcionales y atribuibles

1. **Tablas display no reciben maquinaria.** Una tabla cuyo dataset es `single_row` o que rinde 1
   fila es presentación pura: sin runtime interactivo, sin iconos de filtro por columna, sin bloque en
   el Inspector. (`interactive: true` explícito y las tablas con **anotación** la conservan — editar
   es su propósito, no filtrar.)
2. **Kit ÚNICO en el Inspector.** Las afordancias (BUSCAR · AGRUPAR POR · DESCARGAR CSV · Limpiar
   todo) aparecen UNA vez. Si una página tiene **≥2 tablas interactivas** (raro tras la regla 1), el
   kit lleva un **selector de objetivo** («Tabla: … ▾», default = la de más filas) — jamás kits
   apilados. *Nota de gobierno:* ≥2 tablas interactivas en una vista es un *smell* del spec (preferir
   multi-vista / drill-through).
3. **El contador de filas es de la cara.** Sale del kit y se vuelve pie discreto de cada tabla
   interactiva («7 filas») — es información del documento, no un control; se imprime (estado honesto).

## 6 · Qué NO cambia

El DSL, los specs, `serve-rls`, `applyCtx`, la resolución de controles y la semántica de URL
(`?ctx.<id>=…` + `page`) quedan **idénticos**: un link compartido antes de esta convención renderiza
igual después. La convención es de superficie; el gate es la versión (**0.8.0**), sin feature flag.

## 7 · Relaciones entre controles (llaves alternativas y cascada)

Un mismo **alcance** puede tener más de una **llave** para elegirlo. En PI-07, una recepción se
identifica por su **OC** *o* por su **Fecha Fin Recepción**: dos campos, un solo alcance. La superficie
lo modela separando dos roles que hasta 0.8.0 estaban fundidos en cada entrada de `controls:`:

| Rol | DSL | Default | Qué controla |
|---|---|---|---|
| **`param`** | `param: <clave>` | el `id` del control | a qué `ctx.<param>` ESCRIBE el sello (la llave de alcance) |
| **`display`** | `display: <campo>` | el campo de `source` | qué campo del MISMO dataset se ve como ETIQUETA de las opciones |

El **valor** de cada opción sale del campo de `source` (la llave que viaja a `ctx`); la **etiqueta**
sale del campo de `display`. Las opciones se construyen como pares `{value, label}` **fila a fila del
mismo dataset**, lo que garantiza el mapeo 1:1 (nunca un par inválido). Sin `param`/`display`, un
control se comporta exactamente como en 0.8.0 (`param = id`, `label = value`).

### 7·1 · (i) Llaves alternativas — dos sellos, un alcance

Dos controles que declaran el **mismo `param`** son **llaves alternativas**: eligen por campos
distintos pero fijan el **mismo `ctx.<param>`**. Al cambiar cualquiera de los dos sellos, el re-render
pinta **ambos coherentes** (elegir la fecha equivale a elegir su OC). Reglas de resolución:

- **Dueño del `param`.** El **primer** control que declara un `param` es su dueño: aplica su `default`
  (`max`/`min`/`first`). Los demás controles del mismo `param` heredan el valor vigente de
  `ctx.<param>` (no aplican default propio).
- **Mismo dataset, `single` obligatorio.** Todos los controles de un `param` compartido deben leer del
  **mismo dataset** de `source` y ser `single` (validación con error claro si no; multi-valor + llaves
  alternativas queda fuera de alcance en esta fase).
- **Etiquetas de fecha.** Si el campo `display` es un datetime ISO (`YYYY-MM-DDThh:mm…`), la etiqueta se
  recorta a `YYYY-MM-DD` (regla general de presentación).
- **Colisión de etiqueta.** Si dos values distintos producen la misma etiqueta (dos OCs con igual
  fecha), ambas opciones se desambiguan con `label (value)` — «2026-07-14 (17400358)». Es la
  **limitación declarada de (i)** y el disparador natural de (ii).

La URL no cambia: la llave sigue siendo `?ctx.<param>=…` (p. ej. `?ctx.oc=17400358`), venga la elección
del sello-OC o del sello-fecha.

### 7·2 · (ii) Cascada `narrows:` — un control acota a otro (diseño, no construido)

La colisión de etiquetas de (i) muestra su límite: cuando una llave no es única por sí sola (varias OCs
comparten fecha), no basta con desambiguar el texto — se necesita que **una elección acote las opciones
de la otra**. Ese es el rol de un vocabulario futuro, aún **no implementado**:

```yaml
controls:
  - { id: semana, label: "Semana", source: data.semanas.semana, default: max }
  - { id: oc, label: "OC", source: data.ocs.oc, narrows: semana }   # ← (ii): las OCs se limitan a la semana elegida
```

- **Semántica.** `narrows: <id>` declara que este control **depende** del valor de otro: sus opciones se
  recomputan filtrando su `source` por el `ctx.<param>` del control referenciado (un `WHERE` implícito o
  un `source` parametrizado por `:ctx.<param>`). El control referenciado es el «padre» de la cascada; el
  que declara `narrows` es el «hijo». Cambiar el padre invalida y recomputa al hijo.
- **Por qué `param`/`display` es la base común de (i) y (ii).** Ambas semánticas necesitan lo mismo:
  desacoplar *qué se escribe* (la llave, `param`) de *qué se ve* (la etiqueta, `display`), y construir
  las opciones como pares `{value, label}` derivados del dato. (i) hace que **dos controles escriban el
  mismo `param`**; (ii) hace que **un control lea el `param` de otro para acotar sus opciones**. La misma
  primitiva de opciones-como-pares sostiene las dos; (ii) solo agrega la **arista de dependencia**
  (`narrows:`) y la re-derivación del hijo. Por eso (i) se construye ahora y (ii) queda diseñada sobre la
  misma base, sin deuda: cuando llegue, no reescribe la resolución de controles, la extiende.
