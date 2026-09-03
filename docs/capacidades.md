# Catálogo de capacidades de Vergis (`CAP-NN`)

> **Índice de superficie del Producto**: qué existe, cómo se llama, desde qué versión, y dónde se
> explica. Vive versionado en el repo para que viaje en el mismo commit que la capacidad que
> describe, se revise en el PR que la agrega, y tenga URL estable para citarlo desde afuera.

## ¿Qué es este documento?

Una lista numerada de **lo que Vergis ya sabe hacer**, para que una petición que la plataforma
satisface hoy se pueda contestar citando su identificador en vez de re-descubrirla o construirla de
nuevo. Nació de [#264](https://github.com/Gegolabs/vergis/issues/264), abierto porque desde afuera
del repo **no hay lista que leer**: dos issues del mismo día pidieron capacidades que ya existían, y
ninguno era un capricho — era la mejor lectura disponible sin un índice.

## ¿Qué NO es?

- **No es un manual de uso.** Una línea por capacidad; el detalle vive en el enlace de la última
  columna. Si la línea no alcanza, el documento enlazado es la fuente.
- **No es el roadmap.** Lo que no está construido **no entra**. Un elemento diseñado y no construido
  aparece solo si el propio documento de diseño lo declara así, y se marca **(no construido)**.
- **No es la fuente de verdad del comportamiento.** La fuente es el código, el schema y el
  `CHANGELOG.md`. Este índice los indexa; cuando discrepen, gana la fuente y el índice se corrige.

## ¿Cómo se citan estos identificadores?

Cada área es una sección con ancla propia. Desde un ticket externo se cita la URL del documento más
el ancla del área, y el identificador de la fila:

```
CAP-85 · https://github.com/Gegolabs/vergis/blob/main/docs/capacidades.md#autorización
```

## ¿Cuál es la regla de los identificadores?

**`CAP-NN` estables, y jamás se reusan.** El número se asigna al agregar la fila y no cambia con
reordenamientos, renombres ni cambios de área — su único trabajo es que una cita sobreviva.

Una capacidad **retirada conserva su número** con estado `retirada` en [§Capacidades
retiradas](#capacidades-retiradas): su fila no se borra, porque la cita vieja tiene que poder
resolverse a «esto existió y ya no». Un número nunca se recicla para nombrar otra cosa.

`npm run capacidades:cotejo` hace cumplir la parte mecánica de esta regla — ver
[§¿Qué garantiza el cotejo?](#qué-garantiza-el-cotejo).

## ¿Cómo se lee la columna «Desde»?

La versión del `CHANGELOG.md` que publicó la capacidad. `≤0.9` cuando la capacidad es anterior al
registro fino y su versión exacta no se puede afirmar.

---

## Piezas del DSL

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-01` | Bloque de texto en Markdown | `markdown_block` | ≤0.9 | [validate.ts · `ELEMENT_TYPES`](../packages/mira/src/dsl/validate.ts) |
| `CAP-02` | Indicador — medida con número grande, acento y comparación | `kpi`, con `kpi.metric`, `kpi.comparison`, `kpi.accent`, `kpi.size` | ≤0.9 | [catalogo-elementos.md §1](catalogo-elementos.md) (distinción vs `dato`) |
| `CAP-03` | Atributo rotulado — par etiqueta + valor, nunca interactivo | `dato` (`label`, `value`, `format`) | 0.10.0 | [catalogo-elementos.md §1](catalogo-elementos.md) |
| `CAP-04` | Semáforo — rol visual de alerta con umbrales | `semaforo` (`thresholds.green` / `.yellow`) | ≤0.9 | [catalogo-elementos.md §5](catalogo-elementos.md) (cubre el rol de `alert`) |
| `CAP-05` | Tabla de datos | `table` (`data`, `columns[]`) | ≤0.9 | [arquitectura-multi-reporte.md §3](arquitectura-multi-reporte.md) |
| `CAP-06` | Barras de una métrica | `distribution` con `dimension` + `metric` | ≤0.9 | [catalogo-elementos.md §2](catalogo-elementos.md) |
| `CAP-07` | Barras agrupadas multi-métrica (formato ancho) | `distribution.metrics[]` (2+ series, `field` + `label`) | 0.10.0 | [catalogo-elementos.md §2](catalogo-elementos.md) |
| `CAP-08` | Series de barras desde una COLUMNA (formato largo) | `distribution.series: <campo>` | 0.18.0 | [catalogo-elementos.md §2 · «Series desde una COLUMNA»](catalogo-elementos.md) |
| `CAP-09` | Barras apiladas | `distribution.stacked: true` | 0.18.0 | [catalogo-elementos.md §2](catalogo-elementos.md) |
| `CAP-10` | Orientación de las barras | `distribution.orientation: horizontal \| vertical` | ≤0.9 | [catalogo-elementos.md §2](catalogo-elementos.md) |
| `CAP-11` | Líneas de 1..N series sobre un eje | `series` (`data`, `x`, `metrics[]`) | 0.10.0 | [catalogo-elementos.md §3](catalogo-elementos.md) |
| `CAP-12` | Composición en rejilla | `layout: grid` + `columns` + `span` por elemento | ≤0.9 | [catalogo-elementos.md §1](catalogo-elementos.md) |
| `CAP-13` | Agregaciones declaradas sobre un dataset | `agg.op`: `sum` · `ratio` (`num`/`den`) · `avg` · `count` · `min` · `max` · `count_distinct` | ≤0.9 | [piece-types.ts · `Aggregation`](../packages/capabilities/src/piece-types.ts) |
| `CAP-14` | Columnas de tabla declaradas | `columns[]`: `field`, `label`, `format`, `align` | ≤0.9 | [arquitectura-multi-reporte.md §3](arquitectura-multi-reporte.md) |
| `CAP-15` | Override por columna de las afordancias automáticas | `sortable`, `searchable`, `filter`, `groupBy`, `colorscale` | 0.18.0 | [catalogo-elementos.md §4·bis](catalogo-elementos.md) |
| `CAP-16` | Tabla estática (sin runtime de interacción) | `table.interactive: false`; `single_row` como display puro | 0.8.0 | [CHANGELOG 0.8.0](../CHANGELOG.md) |
| `CAP-17` | Ancla de negocio de un dataset (habilita comentar una fila) | `data.<ds>.anchor` = `{ entity, key[], display }` | 0.13.0 | [capa-de-notas.md §4](capa-de-notas.md) |
| `CAP-18` | Identidad del PI | `identity.id`, `identity.display_name`, `identity.description`, `identity.owner`, `identity.tags` | ≤0.9 | [schema/mira-spec.schema.json](../schema/mira-spec.schema.json) |
| `CAP-19` | Clasificación del PI | `identity.classification`: `public` · `internal` · `confidential` · `regulated` | ≤0.9 | [schema/mira-spec.schema.json](../schema/mira-spec.schema.json) |
| `CAP-20` | Versión del PI, visible en el pie del inspector | `identity.version` | 0.2.1 | [CHANGELOG 0.2.1](../CHANGELOG.md) |
| `CAP-21` | Slug de URL derivado del código del PI | `identity.code` | 0.18.0 | [CHANGELOG 0.18.0 (#207)](../CHANGELOG.md) |
| `CAP-22` | Contrato de datos de un dataset | `data.<ds>.capability` + `params` + `shape` | ≤0.9 | [arquitectura-multi-reporte.md §2](arquitectura-multi-reporte.md) |
| `CAP-23` | Bloques de calidad y de entrega del spec | `quality` (frescura: `watermark_field`, `max_age`, `timezone`) · `delivery.render[]` | ≤0.9 | [schema/mira-spec.schema.json](../schema/mira-spec.schema.json) |
| `CAP-24` | Canales de entrega **declarados en el DSL y sin implementación** — **(no construido)** | `delivery.channels[]` | — | [mejoras-diagnostico.md §Brechas de cobertura](mejoras-diagnostico.md) |
| `CAP-25` | Elementos diseñados y **no construidos**, con su disparador escrito | `narrative` · `alert` · `comparison` — **(no construido)** | — | [catalogo-elementos.md §5](catalogo-elementos.md) |

## Formatos y orden

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-26` | Entero con separador de miles es-CL, seguro sobre `BIGINT` servido como string | `format: int_0` | 0.4.0 | [table-runtime.ts · `vtFormat`](../packages/capabilities/src/table-runtime.ts) |
| `CAP-27` | Porcentaje con un decimal | `format: percent_1` | ≤0.9 | [table-runtime.ts · `vtFormat`](../packages/capabilities/src/table-runtime.ts) |
| `CAP-28` | Porcentaje redondeado | `format: percent` | ≤0.9 | [table-runtime.ts · `vtFormat`](../packages/capabilities/src/table-runtime.ts) |
| `CAP-29` | Magnitud abreviada es-CL (`1,2M` · `340K` · `2.500M`; sin «B» a propósito) | `format: abbr` | 0.10.0 | [catalogo-elementos.md §2 · «Formato `abbr`»](catalogo-elementos.md) |
| `CAP-30` | Fecha recortada a `YYYY-MM-DD`. **El recorte es automático** para un `Date` o un string ISO; el token `format: date` que documenta el `dato` no tiene rama propia en el formateador | `format: date` (documentado); recorte por defecto de `vtFormat` | 0.10.0 | [catalogo-elementos.md §1](catalogo-elementos.md) · [table-runtime.ts](../packages/capabilities/src/table-runtime.ts) |
| `CAP-31` | Orden declarable de las categorías de un chart, vocabulario cerrado | `sort: magnitude` (default) · `sort: chrono` (manda el `ORDER BY`) · `sort: value:<serie>` | 0.18.0 | [catalogo-elementos.md §2 · «`sort`»](catalogo-elementos.md) |
| `CAP-32` | Cota top-N de categorías con colapso en «(otros)», sumando cada serie por separado | `CHART_MAX_BARS` (30) — convención de plataforma, no se declara | 0.10.0 | [catalogo-elementos.md §2](catalogo-elementos.md) |
| `CAP-33` | Cota de series con colapso en «(otras)», atada al tamaño de la paleta | `CHART_MAX_SERIES` (8) | 0.18.0 | [catalogo-elementos.md §2](catalogo-elementos.md) |
| `CAP-34` | Corte as-of del documento en la cabecera | «Datos al …» — convención de plataforma | 0.14.0 | [CHANGELOG 0.14.0 (#108)](../CHANGELOG.md) |

## Filtros y facetas

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-35` | Control de cabecera **server-side**: fija un alcance que se inyecta como `:ctx.<id>` en las queries | `controls[]`, con `controls[].id` y `controls[].source` | 0.2.0 | [superficie-de-estado.md §4·bis](superficie-de-estado.md) |
| `CAP-36` | Rótulo del control en la banda de contexto | `controls[].label` | 0.2.0 | [superficie-de-estado.md §3](superficie-de-estado.md) |
| `CAP-37` | Llaves alternativas del mismo alcance (dos sellos, un alcance) | `controls[].param` | 0.9.0 | [superficie-de-estado.md §7·1](superficie-de-estado.md) |
| `CAP-38` | Etiqueta de la opción tomada de otro campo del mismo dataset | `controls[].display` | 0.9.0 | [superficie-de-estado.md §7](superficie-de-estado.md) |
| `CAP-39` | Valor inicial del control: computado (`max` / `min` / `first`) o **literal del dominio** | `controls[].default` | 0.9.0 · literal alcanzable en 0.22.0 (#246) | [CHANGELOG 0.22.0](../CHANGELOG.md) |
| `CAP-40` | Valor inicial designado **por el dato** (columna booleana del mismo dataset) | `controls[].defaultField` | 0.22.0 (#235) | [superficie-de-estado.md §7·3](superficie-de-estado.md) |
| `CAP-41` | Control de selección múltiple | `controls[].single` (false ⇒ checkboxes en la bandeja) | 0.8.0 | [superficie-de-estado.md §5](superficie-de-estado.md) |
| `CAP-42` | Filtro de bandeja **server-side**: sustracción opcional que re-ancla el documento (`:flt.<id>`) | `filters[]`, con `filters[].id` y `filters[].source` | 0.18.0 (#82) | [superficie-de-estado.md §4·bis · «El bloque `filters:`»](superficie-de-estado.md) |
| `CAP-43` | Rótulo del filtro de bandeja | `filters[].label` | 0.18.0 | [superficie-de-estado.md §4·bis](superficie-de-estado.md) |
| `CAP-44` | Columna que el predicado filtra, distinta del catálogo de opciones | `filters[].column` | 0.18.0 | [superficie-de-estado.md §4·bis](superficie-de-estado.md) |
| `CAP-45` | Filtro de bandeja de selección múltiple | `filters[].multi` | 0.18.0 | [superficie-de-estado.md §4·bis](superficie-de-estado.md) |
| `CAP-46` | Cascada: la selección de un filtro condiciona las opciones de otro | `filters[].depends_on` | 0.18.0 | [superficie-de-estado.md §4·bis](superficie-de-estado.md) |
| `CAP-47` | Facetas **client-side** sobre el dato ya materializado (checkboxes de la bandeja) | `interactions.filters[]` (`dataset`, `field`, `label`, `multi`) | ≤0.9 | [superficie-de-estado.md §4·bis](superficie-de-estado.md) |
| `CAP-48` | Tope de materialización client-side (por encima, las facetas no se materializan) | `VERGIS_INTERACTIVE_MAX_ROWS` | ≤0.9 | [server/config.ts](../server/config.ts) |
| `CAP-49` | Chips removibles del filtro activo en la cara del documento, imprimibles | chips `vflt` (× por valor o por filtro) | 0.14.0 (#114) | [superficie-de-estado.md §4](superficie-de-estado.md) |
| `CAP-50` | Facetas plegables con tope de opciones visibles y buscador local | tope de 12 + buscador (`.faceta-options`, CSS-only) | 0.18.0 (#209) | [CHANGELOG 0.18.0](../CHANGELOG.md) |
| `CAP-51` | Carry del alcance y de los filtros en TODA navegación (páginas, drills, chips) | `?ctx.<param>=…` y `&flt.<id>=…` | 0.9.0 | [superficie-de-estado.md §4](superficie-de-estado.md) |
| `CAP-52` | Cascada `narrows:` entre controles — **(no construido)** | `narrows:` | — | [superficie-de-estado.md §7·2](superficie-de-estado.md) |
| `CAP-184` | **Filtros de número** en el embudo de una columna numérica (atajos `> 0` / `< 0` / `= 0` + operador `mayor que` · `menor que` · `entre` · `igual a`), con chip legible removible | convención de plataforma, decidida por el dato (`vtIsNumericCol`) — no se declara en el spec | Sin publicar | [catalogo-elementos.md §4·ter](catalogo-elementos.md) |
| `CAP-185` | **Rango de fechas** en el embudo de una columna de fecha ISO (`Desde` / `Hasta` inclusivos + atajos `Este mes` · `Mes anterior` · `Últimos 30 días`), con chip legible removible | convención de plataforma, decidida por el dato (`vtIsDateCol`, evaluada después de `vtIsNumericCol`) — no se declara en el spec | Sin publicar | [catalogo-elementos.md §4·ter](catalogo-elementos.md) |

## Vistas multi-página

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-53` | PI multi-vista con barra de navegación | `pages[]` (`id`, `title`, `piece`), URL `?page=<id>` | ≤0.9 | [arquitectura-multi-reporte.md §1](arquitectura-multi-reporte.md) |
| `CAP-54` | Contexto exigido por una página | `pages[].context[]` | ≤0.9 | [schema/mira-spec.schema.json](../schema/mira-spec.schema.json) |
| `CAP-55` | Drill-through de una fila a otra vista, pasando claves de contexto | `drills[]` = `{ to, by[], label }` (clave simple o compuesta) | 0.2.0 | [CHANGELOG 0.2.0](../CHANGELOG.md) |
| `CAP-56` | PI de una sola vista | `piece` (excluyente con `pages`) | ≤0.9 | [schema/mira-spec.schema.json](../schema/mira-spec.schema.json) |

## Bandeja / inspector

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-57` | La convención: **cara = estado · bandeja = maquinaria · print = estado como texto** | banda de contexto `vctxbar` + bandeja lateral | 0.8.0 | [superficie-de-estado.md §1](superficie-de-estado.md) |
| `CAP-58` | Sello de alcance clickeable (la banda de contexto ES el selector) | `vctxbar` con `<select>` / `<details>` nativos | 0.8.0 | [superficie-de-estado.md §3](superficie-de-estado.md) |
| `CAP-59` | Kit de afordancias del inspector: buscar · agrupar · descargar · limpiar | tab «Controles» de la bandeja | 0.8.0 | [superficie-de-estado.md §5](superficie-de-estado.md) |
| `CAP-60` | Selector de tabla objetivo cuando hay ≥2 tablas interactivas | selector del kit | 0.8.0 | [superficie-de-estado.md §5](superficie-de-estado.md) |
| `CAP-61` | Orden, búsqueda global y por columna, y agrupación en la tabla | runtime de tabla (`vtApply`) | ≤0.9 | [table-runtime.ts](../packages/capabilities/src/table-runtime.ts) |
| `CAP-62` | Contador de filas al pie de cada tabla, imprimible | pie discreto de la tabla | 0.8.0 | [superficie-de-estado.md §5](superficie-de-estado.md) |
| `CAP-63` | Selector de **Apariencia** (paleta del theme), persistido por reporte | grupo «Apariencia» de la bandeja + `localStorage` | 0.10.0 | [catalogo-elementos.md §4](catalogo-elementos.md) |
| `CAP-64` | Color de magnitud en tablas, encendido por el lector y apagado por defecto | interruptor de la bandeja; `--mag` / `--mag-h` / `--mag-s` del theme | 0.18.0 (#210) | [catalogo-elementos.md §4·bis](catalogo-elementos.md) |
| `CAP-65` | Descargar CSV de la **vista actual** (separador `;`, BOM UTF-8, anti formula-injection) | botón «Descargar» de la bandeja | 0.7.0 (#61) | [CHANGELOG 0.7.0 · 0.14.0](../CHANGELOG.md) |
| `CAP-66` | Descargar **PDF** server-side del documento con su alcance y filtros | `GET /<slug>/pdf`; requiere `VERGIS_PDF_SERVICE_URL` (sidecar WeasyPrint) | 0.14.0 (#65) | [CHANGELOG 0.14.0](../CHANGELOG.md) |
| `CAP-67` | Modo **print**: mismo pipeline, sin maquinaria ni scripts, tablas completas | `print: true` (render dedicado; `TABLE_PRINT_MAX_ROWS`) | 0.14.0 (#65) | [piece-types.ts · `RenderParams.print`](../packages/capabilities/src/piece-types.ts) |
| `CAP-68` | **Vistas guardadas** de una tabla, con vista por defecto fijable | tab «Vistas» de la bandeja (★ = por defecto, ↻ actualizar, × eliminar); persistidas por reporte | ≤0.9 | [table-runtime.ts](../packages/capabilities/src/table-runtime.ts) |
| `CAP-69` | Faceta por columna desde el encabezado de la tabla (popover con buscador) | popover del `<th>` («Buscar valor…», «Todos» / «Limpiar») | ≤0.9 | [table-runtime.ts](../packages/capabilities/src/table-runtime.ts) |
| `CAP-70` | Doble pista de versión en el pie del inspector | versión del PI + `Mira v<versión>` (de `package.json`) | 0.2.1 | [CHANGELOG 0.2.1](../CHANGELOG.md) |

## Gráficos

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-71` | Render server-side a SVG estático (Vega-Lite → Vega → SVG) con caché LRU | pipeline de `render-chart` — imprime sin trabajo extra | ≤0.9 | [catalogo-elementos.md](catalogo-elementos.md) (cabecera) |
| `CAP-72` | Rótulo de valor sobre cada marca, pre-computado server-side | convención de plataforma; usa el `format` del chart, si no `abbr` | 0.10.0 | [catalogo-elementos.md §2 · «Rótulos de valor»](catalogo-elementos.md) |
| `CAP-73` | Anti-colisión de rótulos (rotar/omitir, carril por posición del punto) | decisión del motor — **no se declara por spec** | 0.16.0 (#166) | [catalogo-elementos.md §2](catalogo-elementos.md) |
| `CAP-74` | Paleta categórica de series del theme, con re-color en vivo por variable CSS | token `chartSeries`; `Theme.chartTokensByPalette`; `--chart-*` | 0.10.0 · 0.16.0 | [catalogo-elementos.md §4](catalogo-elementos.md) |
| `CAP-75` | Fondo y theme por tipo de PI, conmutables por la instancia | `VERGIS_THEME_REPORT` / `VERGIS_THEME_DASHBOARD` (`theme[@paleta]`) | 0.10.0 | [catalogo-elementos.md §4](catalogo-elementos.md) |
| `CAP-76` | Render de gráficos **sin E/S**: gate declarativo y loader que niega red y disco | gate del render de charts | 0.16.0 | [CHANGELOG 0.16.0](../CHANGELOG.md) |

## Notas

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-77` | **Impresión**: congelar un documento (filas, forma, recorte, versión del spec, autoría) | `POST /<slug>/imprimir`, `GET /impresiones` | 0.13.0 | [capa-de-notas.md §3](capa-de-notas.md) |
| `CAP-78` | **Anotación** sobre una impresión (read-only, sin drills) | rutas `/impresiones/…`; sesión de trabajo de 12 h | 0.13.0 | [capa-de-notas.md §2](capa-de-notas.md) |
| `CAP-79` | **Comentario** anclado a un registro por su llave de negocio, unificado entre PIs | `/<slug>/comentarios`; exige `anchor` en el dataset (fail-closed) | 0.13.0 | [capa-de-notas.md §4](capa-de-notas.md) |
| `CAP-80` | Compartir una impresión: solo el dueño, auditado y revocable hacia adelante | `/impresiones/…/compartir` | 0.13.0 | [capa-de-notas.md §5](capa-de-notas.md) |
| `CAP-81` | «Mis impresiones» en el menú del avatar | entrada del menú + `GET /impresiones` | 0.13.0 | [capa-de-notas.md §6](capa-de-notas.md) |
| `CAP-82` | Retención y purga de impresiones | setting de plataforma (`P12M`; purga al arranque y cada 24 h) | 0.13.0 | [capa-de-notas.md §9](capa-de-notas.md) |
| `CAP-83` | Configuración de la capa de notas | `VERGIS_NOTES_DB`, `VERGIS_CSRF_SECRET` | 0.13.0 | [capa-de-notas.md §9](capa-de-notas.md) |
| `CAP-84` | El gate del comentario se verifica **contra el dato**, con el ctx efectivo del PI | bloque `ctx` publicado a la capa de notas | 0.17.0 (#185) | [capa-de-notas.md §4 · «El gate se verifica contra el dato»](capa-de-notas.md) |

## Autorización

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-85` | RLS multi-PI **data-anchored, default-deny**: la política se ancla al dato, el spec es authz-blind | `entidades.yaml` + policy store; motores ClickHouse y Fabric push-down | ≤0.9 | [gobierno-permisos.md §6](gobierno-permisos.md) |
| `CAP-86` | Modelo de tres estados del gobierno (declarado · aplicado · efectivo) | `GovernanceStore` | ≤0.9 | [gobierno-permisos.md §1](gobierno-permisos.md) |
| `CAP-87` | Dos capas ortogonales: gate de **artefacto** (¿puede abrir el PI?) y RLS de **dato**, en AND y sin bypass | `VERGIS_PI_ACL` enciende el ACL de artefacto; `canOpenPi` + RLS | ≤0.9 | [gobierno-permisos.md §3](gobierno-permisos.md) |
| `CAP-88` | Roles de PI anidados y visibilidad por PI | roles (`viewer` · `collaborator` · `owner`) y visibilidad | ≤0.9 | [gobierno-permisos.md §4](gobierno-permisos.md) |
| `CAP-89` | Grupos gestionados por Mira (no grupos AAD), administrables sin reiniciar | `/admin/grupos`; pertenencia resuelta por request | 0.17.0 (#183) | [gobierno-permisos.md §4](gobierno-permisos.md) |
| `CAP-90` | Rol admin de plataforma, con semilla y **revocación in-app** | `VERGIS_ADMIN_SEED`; tombstone `admin_seed_removed` + aviso de drift | 0.17.0 (#182) | [gobierno-permisos.md §5](gobierno-permisos.md) |
| `CAP-91` | Mapa identidad→claims administrado desde la plataforma, con escritura auditada | superficie admin de identidades | 0.16.0 (#159) | [CHANGELOG 0.16.0](../CHANGELOG.md) |
| `CAP-92` | Claim como **conjunto** (doble pertenencia), con la negación explicada por cardinalidad | claims del gate | 0.16.0 (#165) | [CHANGELOG 0.16.0](../CHANGELOG.md) |
| `CAP-93` | Control por **columna**: vista de máscara + Dynamic Data Masking (no soportado en ClickHouse) | `vw_mask_<tabla>` + DDM; preflight que nombra los objetos | 0.16.0 · 0.17.0 (#163) | [gobierno-permisos.md §6·bis](gobierno-permisos.md) |
| `CAP-94` | Separación de planos persona/máquina, y `GRANT UNMASK` granular por columna | `GRANT UNMASK ON [esquema].[tabla]([columna])` | 0.21.0 · 0.22.0 (#238) | [gobierno-permisos.md §6·bis](gobierno-permisos.md) |
| `CAP-95` | Diagnóstico visual de la máscara, que no colapsa dos causas | `•••` = persona sin derecho · `xxxx` = capacidad ausente | 0.21.0 (#238) | [CHANGELOG 0.21.0](../CHANGELOG.md) |
| `CAP-96` | `grant: all` como política explícita, sin tomar de rehén una columna de negocio | `grant: all` | 0.19.0 (#164) | [CHANGELOG 0.19.0](../CHANGELOG.md) |
| `CAP-97` | Herencia de gobierno vista→base | vista-contrato `WITH SCHEMABINDING` sobre tablas gobernadas | 0.4.0 (#54) | [gobierno-permisos.md §6·bis](gobierno-permisos.md) |
| `CAP-98` | Fail-closed **por PI**: el PI que no verifica su RLS responde 503 con motivo; los demás siguen | `piBlocked` → 503 | 0.4.0 (#52) | [arquitectura-multi-reporte.md §3](arquitectura-multi-reporte.md) |
| `CAP-99` | Gate del proxy por token, con comparación en tiempo constante | `VERGIS_GATE_SECRET` / header `x-gate-token` | 0.12.0 | [gobierno-permisos.md §4](gobierno-permisos.md) |
| `CAP-100` | Identidad de desarrollo inyectable, inerte si el gate está activo | `VERGIS_DEV_IDENTITY` (`email` o `email:grupo1,grupo2`) | 0.12.0 | [gobierno-permisos.md §4 · «Identidad de desarrollo»](gobierno-permisos.md) |
| `CAP-101` | Custodios de un dominio, admitiendo grupos | `stewards:` (`ana@gh.cl` o `group:<grupo>`) + `VERGIS_DEFAULT_STEWARD_GROUPS` | 0.17.0 (#183) | [gestion-de-dominio.md §1](gestion-de-dominio.md) |
| `CAP-102` | Pertenencia del proceso al dominio exigida en las acciones de Frescura | predicado fail-closed heredado de la fuente que ingesta | 0.22.0 (#253) | [CHANGELOG 0.22.0](../CHANGELOG.md) |

## Data maestra y publicación

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-103` | Publicación **universal** de data maestra a un consumidor (no un shortcut de Fabric) | proyección read-only publicada por la plataforma | ≤0.9 | [data-maestra-y-publicacion.md §3](data-maestra-y-publicacion.md) |
| `CAP-104` | Los tres roles de una entidad maestra (origen · canónica · publicada) | modelo de la capacidad | ≤0.9 | [data-maestra-y-publicacion.md §2](data-maestra-y-publicacion.md) |
| `CAP-105` | Convención de nombres de la proyección publicada (estándar de Producto) | sufijo `__replica` | ≤0.9 | [data-maestra-y-publicacion.md §4](data-maestra-y-publicacion.md) |
| `CAP-106` | Store de data maestra versionado, con esquema declarado en la imagen | `MASTER_DATA_SCHEMA_VERSION`; label `vergis.schema.stores` | 0.22.0 | [CONTRIBUTING.draft.md](../CONTRIBUTING.draft.md) |
| `CAP-107` | Catálogo de la instancia como fuente de opciones de un campo editable | `options_ref` (dropdown con validación server-side) | 0.14.0 (#109) | [gestion-de-dominio.md §4 · «`options_ref`»](gestion-de-dominio.md) |
| `CAP-108` | Publicar la definición del job de un proceso en el motor, con el drift a la vista | plantillas de job de la instancia + read-back canónico | 0.15.0 (#107 f2) | [gestion-de-dominio.md §5](gestion-de-dominio.md) |
| `CAP-109` | Gestión in-app de fuentes, procesos y salidas, con precedencia sobre la semilla YAML | `managed_at` + tombstones | 0.14.0 (#107 f1) | [gobierno-permisos.md §2 · «Precedencia runtime-sobre-semilla»](gobierno-permisos.md) |
| `CAP-110` | Override del nombre visible de un PI sin desplegar | configuración del PI (gate de colaborador); tabla `pi_display_name` | 0.18.0 (#207) | [CHANGELOG 0.18.0](../CHANGELOG.md) |
| `CAP-111` | **Publish-on-write**: cada edición en Administración republica la proyección, atómica (staging + swap) | `masterDataPublishPlan` → `md_<id>__replica_new` → swap | ≤0.9 | [master-data-publish.ts](../packages/capabilities/src/master-data-publish.ts) |
| `CAP-112` | Autoría única de data maestra editable in-app (CRUD gobernado) | `MasterDataStore`; entidades `md_<id>`; `VERGIS_MASTER_DATA`, `VERGIS_MASTER_DATA_DB` | ≤0.9 | [data-maestra-y-publicacion.md §2](data-maestra-y-publicacion.md) |

> **Aviso de deriva, medido al barrer (2026-09-02):** la tabla §9 «Estado de implementación» de
> [data-maestra-y-publicacion.md](data-maestra-y-publicacion.md) declara el mecanismo de publicación y el
> publish-on-write como «diseñados, por construir». **El código los tiene** (`master-data-publish.ts`,
> invocado desde Administración). Es exactamente el defecto que motivó [#264](https://github.com/Gegolabs/vergis/issues/264):
> quien leyó ese doc pidió como nueva una capacidad que ya existía. La corrección del doc va aparte de
> este catálogo.

## Ingesta y contrato `_logs/`

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-113` | Ingesta de archivos a **staging**, nunca directo a las tablas | slots declarativos de la instancia (`slots.yaml`) | 0.5.0 | [gestion-de-dominio.md §4](gestion-de-dominio.md) |
| `CAP-114` | Metadata declarada por slot, y derivada del nombre del archivo | bloque de metadata del slot | 0.14.0 (#95) | [gestion-de-dominio.md §4 · «Metadata declarada»](gestion-de-dominio.md) |
| `CAP-115` | Consola de **Cargas** por dominio, con una casilla por vez y URL propia | `/admin/dominio/<id>/cargas?slot=<slotId>` | 0.5.0 · 0.16.0 (#178) | [gestion-de-dominio.md §4 · «La consola de Cargas»](gestion-de-dominio.md) |
| `CAP-116` | Dedup por contenido al subir, con pre-check y badge «sin cambios en el dato» | SHA-256 contra el historial del slot; `[delta] sin cambios en el dato` | 0.7.0 (#62) | [gobierno-permisos.md §2 · «Registro de cargas»](gobierno-permisos.md) |
| `CAP-117` | **Revertir** una carga, con plan sellado por hash y compensación por clave | `revert_delete`; `_processed/<clave>/` → `_retirado/`; audit `intake_revert` | 0.7.0 · 0.14.0 (#63) | [gestion-de-dominio.md §4 · «Revertir una carga»](gestion-de-dominio.md) |
| `CAP-118` | Retiro y reactivación de residuos del landing a un clic | `_retirado/` ↔ `_processed/` | 0.5.0 (#57) | [gestion-de-dominio.md §4](gestion-de-dominio.md) |
| `CAP-119` | Contrato del log por corrida en OneLake, con gramática por archivo | `_logs/run-<ts>.txt` | 0.14.0 · 0.16.0 (#162) | [contrato-ingesta-logs.md](contrato-ingesta-logs.md) |
| `CAP-120` | Desenlace por archivo, con su causa | `procesada` · `saltada` · `fallida` · `sin-informe` · `varada` | 0.16.0 (#162) | [contrato-ingesta-logs.md §2](contrato-ingesta-logs.md) |
| `CAP-121` | Degradación honesta cuando el job no cumple el contrato | calidad de la medida: `fresca` · `ultima-conocida` · `contradice-registro` · `ninguna` | 0.16.0 (#161) | [contrato-ingesta-logs.md §4](contrato-ingesta-logs.md) |
| `CAP-122` | Vigilancia de cargas declarada por slot, fail-closed | bloque `watch:` (ausente = defaults; `watch: false` = opt-out total) | 0.16.0 (#161) | [contrato-ingesta-logs.md §4](contrato-ingesta-logs.md) |
| `CAP-123` | Log de la última conversión visible desde la consola | el slot declara `log` (default `Files/code/_ingest_log.txt`) | 0.5.0 (#55) | [gestion-de-dominio.md §4](gestion-de-dominio.md) |
| `CAP-124` | Acuse ruidoso de incoherencia slot ↔ proceso | aviso en Frescura y en la consola | 0.5.0 (#56) | [gestion-de-dominio.md §4](gestion-de-dominio.md) |
| `CAP-125` | Capabilities de OneLake para operar el landing | `OneLakeReader`: `list` · `copy` · `remove` · `readBytes` (DFS) | 0.5.0 | [CHANGELOG 0.5.0](../CHANGELOG.md) |

## Frescura

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-126` | Frescura gobernada por **oferta / demanda** — dos conceptos distintos a propósito | `quality.freshness` (demanda) vs cadencia del proceso (oferta) | ≤0.9 | [frescura-oferta-demanda.md §1](frescura-oferta-demanda.md) |
| `CAP-127` | Techo de la demanda: un PI no puede pedir más fresco de lo que la oferta entrega | reconciliación oferta/demanda | ≤0.9 | [frescura-oferta-demanda.md §2](frescura-oferta-demanda.md) |
| `CAP-128` | Fuentes **event-driven** además de las de cadencia | `oferta: evento` | 0.6.0 | [frescura-oferta-demanda.md §3](frescura-oferta-demanda.md) |
| `CAP-129` | Observabilidad de ingestión proyectada localmente (Frescura no toca el motor al abrirse) | `ingestion_run` · `ingestion_process_state` | 0.14.0 (#105) | [frescura-oferta-demanda.md §5](frescura-oferta-demanda.md) |
| `CAP-130` | Motivo de falla del job disparado, visible en la vista | `failureReason` en «Última corrida» y «Otras cargas» | 0.4.0 (#53) | [CHANGELOG 0.4.0](../CHANGELOG.md) |
| `CAP-131` | Cadencia, pausa y reanudación de un proceso desde Frescura | acciones por proceso | 0.14.0 (#107 f1) | [gestion-de-dominio.md §1](gestion-de-dominio.md) |
| `CAP-132` | Avisos con destino declarativo y enlaces profundos | `VERGIS_NOTIFY` | 0.14.0 (#100) | [CHANGELOG 0.14.0](../CHANGELOG.md) |
| `CAP-133` | Reporte periódico por email, con SMTP propio y sin dependencias | reporte periódico de Frescura | 0.14.0 (#102) | [CHANGELOG 0.14.0](../CHANGELOG.md) |
| `CAP-134` | Banner de staleness en el documento (también en print) | banner de la cara | 0.14.0 | [superficie-de-estado.md §1](superficie-de-estado.md) |

## Plano de control (lease, anillos, handover)

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-135` | Plano de control por **lease**: un solo nodo escribe, el otro sirve lecturas | `${VERGIS_OUT}/control.lease.json` (época, relevo por staleness, release ordenado) | 0.19.0 | [CHANGELOG 0.19.0 · 0.20.0](../CHANGELOG.md) |
| `CAP-136` | Selección del modo de control y sus tiempos | `VERGIS_CONTROL` (`lease` \| `single`), `VERGIS_LEASE_STALE_MS`, `VERGIS_LEASE_RENEW_MS` | 0.19.0 | [CHANGELOG 0.19.0](../CHANGELOG.md) |
| `CAP-137` | Lazos de fondo colgados del plano de control (re-ingesta, purga, frescura, vigilancia, reporte) | se arman solo en el nodo que controla | 0.20.0 | [CHANGELOG 0.20.0](../CHANGELOG.md) |
| `CAP-138` | Señal para soltar el control sin bajar el proceso | `SIGUSR2` (suelta y queda en espera); `SIGTERM` suelta antes de cerrar | 0.20.0 | [CHANGELOG 0.20.0](../CHANGELOG.md) |
| `CAP-139` | Handover **dirigido** por intent, en vez de esperar el vencimiento del lease | `${VERGIS_OUT}/control.handover.json` = `{successor, expiresAt}` | 0.22.0 (#232) | [CHANGELOG 0.22.0](../CHANGELOG.md) |
| `CAP-140` | Despliegue por **anillos** conmutados en el borde, sin ventana de mantención | `deploy/Caddyfile.reference`, listener interno `:8079`, `rings/active.caddy` | 0.21.0 (#210) | [deploy/rollout/RUNBOOK.md](../deploy/rollout/RUNBOOK.md) |
| `CAP-141` | Herramienta de ciclo de vida de anillos | `vergis-rollout`: `install` · `promote` · `rollback` · `retire` · `prune` · `status` | 0.21.0 | [deploy/rollout/RUNBOOK.md](../deploy/rollout/RUNBOOK.md) |
| `CAP-142` | Identidad de anillo por versión + digest, con rechazo de tags móviles | rechazo de `latest` · `main` · una serie | 0.21.0 | [CHANGELOG 0.21.0](../CHANGELOG.md) |
| `CAP-143` | Pre-flight y smoke de la promoción, contra el bloque `control` de `/contrato` | pre-flight + smoke por el borde con el predicado canónico | 0.21.0 | [CHANGELOG 0.21.0](../CHANGELOG.md) |
| `CAP-144` | Sala de espera del borde durante el flip | página 503 con auto-refresh (`deploy/edge/espera.html`) | 0.21.0 | [CHANGELOG 0.21.0 · 0.22.0 (#256)](../CHANGELOG.md) |
| `CAP-145` | Retención de anillos y presupuesto de la ventana de promoción | `RINGS_RETAIN` (3) · `RINGS_PROMOTE_TIMEOUT` / `--timeout` (10 s) | 0.21.0 · 0.22.0 | [CHANGELOG 0.22.0](../CHANGELOG.md) |
| `CAP-146` | Esquema de los stores embebidos declarado en la imagen, y regla de migración compatible | labels `vergis.schema` y `vergis.schema.stores`; `SCHEMA_VERSION` por store | 0.22.0 | [CONTRIBUTING.draft.md · «Migraciones del store embebido»](../CONTRIBUTING.draft.md) |
| `CAP-147` | Rechazo al abrir un store cuyo esquema es más nuevo que el código | gate por `PRAGMA user_version` | 0.19.0 | [CHANGELOG 0.19.0](../CHANGELOG.md) |

## Contrato operativo

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-148` | El nodo declara **qué recarga en caliente y qué exige reiniciar**, derivado del estado | `GET /contrato` | 0.15.0 (#139) | [arquitectura-multi-reporte.md §6](arquitectura-multi-reporte.md) |
| `CAP-149` | El contrato dice si el archivo que subiste **ya está cargado** o queda pendiente | bloque `artifacts` (sha256 cargado vs disco → `pending`) | 0.15.0 | [arquitectura-multi-reporte.md §6](arquitectura-multi-reporte.md) |
| `CAP-150` | **Delta** entre versiones del contrato, con journal por instancia | `nowReloadable` / `nowBootOnly` | 0.15.0 (#143) | [CHANGELOG 0.15.0](../CHANGELOG.md) |
| `CAP-151` | Bloque `control` del contrato: modo, lease, anillo, lazos y stores con su esquema | `/contrato` → `control` | 0.20.0 | [CHANGELOG 0.20.0](../CHANGELOG.md) |
| `CAP-152` | La imagen lleva su propio CHANGELOG y sus labels OCI | `/app/CHANGELOG.md`; `org.opencontainers.image.description` / `.documentation` | 0.20.1 (#229) | [CHANGELOG 0.20.1](../CHANGELOG.md) |
| `CAP-153` | Fail-closed ante clave raíz ausente en los YAML de instancia, sin opt-out | «declara cero» explícito (`clave: []`) es lo legítimo | 0.14.0 (#117) | [CHANGELOG 0.14.0](../CHANGELOG.md) |
| `CAP-154` | Puerto de credenciales con tres modos | `CredentialProvider`: `secret` · `federated` · `imds` | 0.14.0 (#66) | [CHANGELOG 0.14.0](../CHANGELOG.md) |
| `CAP-155` | Contrato de salida de una Capability validado en la frontera, con timeout por llamada | `{ rows: [...] }`; error `capability-output-invalid`; timeout default 120 s | 0.2.2 | [CHANGELOG 0.2.2](../CHANGELOG.md) |
| `CAP-156` | Dos motores de serving intercambiables | `VERGIS_ENGINE`: `clickhouse` · `fabric` (push-down con `sp_set_session_context`) | ≤0.9 | [arquitectura-multi-reporte.md §4](arquitectura-multi-reporte.md) |
| `CAP-157` | Caché de resultados **por identidad**, nunca compartida entre consumidores | `VERGIS_DATA_CACHE_TTL_MS` (0 = sin caché) | ≤0.9 | [arquitectura-multi-reporte.md §3](arquitectura-multi-reporte.md) |
| `CAP-158` | Auto-chequeo de coherencia del despliegue al arrancar (modo estricto aborta) | `VERGIS_CONFIG_CHECK` (`server/deployment-check.ts`) | ≤0.9 | [arquitectura-multi-reporte.md §5](arquitectura-multi-reporte.md) |
| `CAP-159` | Bitácora de auditoría append-only encadenada por hash, verificable | `$VERGIS_OUT/admin-audit.log`; `verifyChain()` | ≤0.9 | [arquitectura-multi-reporte.md §4](arquitectura-multi-reporte.md) |
| `CAP-160` | Cotejo del corte de versión: lo que el tag trae vs lo que la sección declara | `npm run corte:cotejo` | 0.22.0 | [CHANGELOG · «Antes de cortar: el cotejo»](../CHANGELOG.md) |
| `CAP-161` | Cotejo del **catálogo de capacidades** contra lo declarado en máquina | `npm run capacidades:cotejo` | Sin publicar (#264) | [§¿Qué garantiza el cotejo?](#qué-garantiza-el-cotejo) |

## Hot-reload

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-162` | Specs de PI re-leídos **por request**: subir un spec no exige reiniciar | descubrimiento de specs | ≤0.9 | [arquitectura-multi-reporte.md §6](arquitectura-multi-reporte.md) |
| `CAP-163` | Watch de políticas y de gobierno de dominio: el YAML se toma al escribirlo | `watch:policies`; el arranque declara `[hot-reload] activo · specs=… · policies=N · gobierno-dominio=N` | ≤0.9 | [arquitectura-multi-reporte.md §6](arquitectura-multi-reporte.md) |
| `CAP-164` | Conexiones, dominios e intake recargables, con validate-before-swap por archivo | `VERGIS_CONNECTIONS` (ruta o JSON inline) | 0.4.0 (#50) | [CHANGELOG 0.4.0](../CHANGELOG.md) |
| `CAP-165` | Config recargable por slice, y una señal que fuerza la recarga sin cortar | `VERGIS_NOTIFY` · `VERGIS_PI_OWNERS` · `VERGIS_SOURCES`; `SIGHUP` | 0.15.0 | [arquitectura-multi-reporte.md §6](arquitectura-multi-reporte.md) |

## Miranda

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-166` | Agente conversacional que autora specs de PI (elicita → compila DSL → QC① → preview → publica) | `@vergis/miranda`; rutas `/miranda*` | 0.11.0 | [miranda.md](miranda.md) |
| `CAP-167` | Apagado por defecto: sin el flag, `/miranda` es un 404 y la superficie es idéntica | `MIRANDA_ENABLED` | 0.11.0 | [miranda.md §¿Variables de entorno?](miranda.md) |
| `CAP-168` | Presupuestos y alcance de una sesión | `MIRANDA_MODEL` · `MIRANDA_MAX_TURNS` · `MIRANDA_TOKEN_BUDGET` · `MIRANDA_SCOPE_GROUP` | 0.11.0 | [miranda.md §¿Variables de entorno?](miranda.md) |
| `CAP-169` | Guardia SQL de las probes: solo `SELECT`, `TOP 500`, allowlist de catálogo | contrato de las tools | 0.11.0 | [miranda.md §¿Guardia SQL de las probes?](miranda.md) |
| `CAP-170` | Preview con **RLS real**, impersonando identidades de un roster declarado y auditando al actor | roster por instancia | 0.15.0 (#145) | [miranda.md](miranda.md) |
| `CAP-171` | Self-check QC① interiorizado, y cross-check de la forma declarada vs las piezas del draft | `crossCheckForma` (divergencia = brecha M) | 0.11.0 | [miranda.md §¿Self-check QC①?](miranda.md) |
| `CAP-172` | Gate de publicación en código: solo desde `autochequeado` y sin brechas B/M | flujo de publish | 0.11.0 | [miranda.md](miranda.md) |
| `CAP-173` | Sesiones como ledger de procedencia | `miranda_session` · `miranda_message` · `miranda_artifact` | 0.11.0 | [miranda.md §¿Máquina de estados?](miranda.md) |
| `CAP-174` | Guard dueño-o-admin en todas las rutas de sesión | `/miranda/s/:id`, `message`, `preview`, `validate-intent`, `publish` | 0.15.0 (#142) | [miranda.md §¿Rutas?](miranda.md) |

## Superficie de estado y healthz

| ID | Capacidad | Cómo se llama / se declara | Desde | Dónde se explica |
|--|--|--|--|--|
| `CAP-175` | Salud del nodo con **fase** y conteos, sin gate y sin filtrar slugs | `GET /healthz` → `{ ok, engine, phase, pis: { total, serving } }` | 0.4.0 (#52) | [superficie-de-estado.md](superficie-de-estado.md) |
| `CAP-176` | Fases que no se colapsan | `starting` → `standby` → `degraded` → `serving` | 0.4.0 · 0.20.0 | [server/routes.ts](../server/routes.ts) |
| `CAP-177` | Predicado canónico de salud, el que usan el conmutador y el poller de cortes | `HTTP 200 ∧ phase=serving ∧ pis.serving == pis.total` | 0.21.0 | [CHANGELOG 0.21.0](../CHANGELOG.md) |
| `CAP-178` | Un nodo en espera rechaza toda mutación con 409, **nombrando al nodo activo** y su época | 409 en admin, config de PI, notas y Miranda | 0.20.0 | [server/routes.ts](../server/routes.ts) |
| `CAP-179` | Healthcheck del despliegue de referencia que juzga por la FASE, no por «responde» | `healthcheck` de `docker-compose.yml` y de `deploy/compose.reference.yml` | 0.22.0 | [CHANGELOG 0.22.0](../CHANGELOG.md) |
| `CAP-180` | Centinela de desenmascarado, con tres estados que no se colapsan | `[<schema>].[vergis_unmask_probe]` (presente / medida ausente / no se pudo medir) | 0.21.0 (#238) | [gobierno-permisos.md §6·bis](gobierno-permisos.md) |
| `CAP-181` | Índice **per-consumidor**: cada identidad ve solo los PIs que puede abrir | `GET /` (con un solo PI visible, se sirve ese PI directamente) | ≤0.9 | [arquitectura-multi-reporte.md §1](arquitectura-multi-reporte.md) |
| `CAP-182` | Consola de administración de plataforma y de dominio | `/admin`, `/admin/…` (gateada por rol dentro del handler) | ≤0.9 | [gestion-de-dominio.md §6](gestion-de-dominio.md) |
| `CAP-183` | Configuración por PI desde la propia plataforma | `/<slug>/config` (gate de rol de PI) | 0.18.0 | [gestion-de-dominio.md §1](gestion-de-dominio.md) |

## Capacidades retiradas

Un número retirado **conserva su fila**: la cita vieja tiene que poder resolverse a «esto existió y
ya no». Hoy no hay ninguna — la tabla existe para que el primer retiro no tenga que inventar la
forma.

| ID | Capacidad | Estado | Qué la reemplaza |
|--|--|--|--|
| — | — | — | — |

---

## ¿Qué garantiza el cotejo?

`npm run capacidades:cotejo` (y el test `tests/capacidades-catalogo.test.ts`, que corre en CI)
verifica dos cosas y **solo** dos:

1. **La numeración.** IDs con formato `CAP-NN`, sin duplicados y sin huecos hacia atrás — un hueco
   solo es válido si ese número aparece en §Capacidades retiradas.
2. **La cobertura de lo declarado en máquina.** Deriva del schema y del código los conjuntos
   **cerrados** de la superficie del DSL —tipos de pieza, tokens de formato, tokens de `sort`,
   claves de `interactions`, claves de `controls[]` y de `filters[]`, clasificaciones— y exige que
   cada uno esté citado en alguna fila.

**Lo que el cotejo NO puede decir es que el catálogo esté completo.** Todo lo demás —endpoints,
gobierno, plano de control, frescura, ingesta, Miranda— se barrió **a mano** sobre `CHANGELOG.md`,
`docs/` y el código, y **puede tener omisiones**. Un verde dice «lo que la máquina declara está
citado», nunca «no falta nada».

Si el código se reorganiza y una derivación pierde su ancla, el cotejo **falla ruidoso** nombrando
el ancla que no encontró, en vez de derivar una lista vacía y aprobar por omisión.

---

• *Generado con Wingworking*
