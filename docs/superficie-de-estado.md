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
