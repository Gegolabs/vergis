# Catálogo de elementos del DSL — trío `dato` · `distribution` multi-métrica · `series`

> **Documentación canónica del Producto** (0.10.0). Contratos de los tres elementos de pieza con
> demanda real. Todos son **authz-blind** (no declaran autorización; la RLS vive atada al dato) y se
> renderizan a HTML/SVG estático server-side. Los charts (`series`, `distribution`) pasan por el mismo
> pipeline Vega-Lite → Vega → SVG con caché LRU por hash del spec+datos.

## 1 · `dato` — atributo rotulado

Un par etiqueta + valor. Es **contenido/estado**, no una medida: tipografía de texto (NO la
tarjeta grande del `kpi`), sobrio, se imprime tal cual y **jamás es interactivo**.

```yaml
- layout: grid
  columns: 2
  elements:
    - dato: { label: "OC", value: data.encabezado.oc }
    - dato: { label: "Fecha Fin Recepción", value: data.encabezado.fecha_fin_recepcion, format: date }
```

- **`value`** se resuelve con el MISMO mecanismo de path que `kpi.metric` (`data.<dataset>.<campo>`).
- **`format`**: `date` recorta ISO/`Date` a `YYYY-MM-DD` (reusa el helper de 0.9.0); los formatos
  numéricos (`int_0`, `percent_1`, …) y, por defecto, texto.
- **Distinción vs `kpi`** (TX-12): el `kpi` es una medida (número grande, acento, comparación); el
  `dato` es un atributo (OC, fecha, folio). Un dato no lleva `data-attrs` de recompute.

## 2 · `distribution` multi-métrica — barras agrupadas

Extensión **aditiva** del `distribution`: `metrics` (2+ series) reemplaza a `metric` (una serie). El
modo singular queda **intacto** (cero cambios a specs existentes).

```yaml
- distribution:
    dimension: data.cruce.programa_genetico
    metrics:
      - { field: plantas_base,   label: "Base" }
      - { field: plantas_actual, label: "Actual" }
    orientation: horizontal
    title: "Programa Genético — Base vs Actual"
```

- **`metric` (singular)** y **`metrics` (plural)** son mutuamente excluyentes → declarar ambos es
  error de validación (`distribution-metric-metrics-collision`).
- **`dimension`** es una ruta completa `data.<dataset>.<campo>` (como siempre). Las series de
  `metrics` son **campos pelados** del MISMO dataset de `dimension` (formato wide); un campo colgante
  se rechaza (`distribution-metrics-field-dangling`).
- **Render**: `fold` (wide→long) + `color` por serie + `yOffset` (horizontal) / `xOffset` (vertical).
  Paleta categórica del theme (`chartSeries`, con fallback).
- **Cota top-N** (`CHART_MAX_BARS = 30`): colapsa el resto en «(otros)» sumando **cada serie por
  separado** — el total de cada serie se conserva. El criterio de corte es el mismo `sort` de abajo.

### Series desde una COLUMNA (formato largo)

`metrics` es formato **ancho**: una columna por serie, con etiquetas fijas escritas en el YAML. Sirve
cuando las series se conocen al escribir el spec. **No sirve cuando las series salen del dato** — un
año que el usuario elige en runtime, un tipo que aparece o desaparece según el filtro. Para eso está
`series: <campo>`, el formato **largo**: cada fila es `(categoría, serie, valor)`.

```yaml
- distribution:
    dimension: data.cruce.mes          # la categoría
    metric: data.cruce.total           # UNA columna de valor
    series: zona                       # las series salen de los VALORES de esta columna
    stacked: true
    title: "Entregas por zona"
```

- **`series` y `metrics` son mutuamente excluyentes** (`distribution-series-metrics-collision`): son
  dos orígenes de series a la vez. En largo la métrica es una sola y viaja en `metric`.
- **`series` es un campo pelado** del dataset de `dimension`, como las entradas de `metrics`. Un
  campo colgante se rechaza (`distribution-series-field-dangling`): un typo no falla solo — produce
  UNA serie llamada `undefined` con todo el total adentro, o sea un gráfico que se ve bien y miente.
- **El render es el mismo** que el del modo ancho. El pliegue largo→ancho ocurre en `compose`, así
  que apilado, rótulos, cota top-N y `sort` se comportan idéntico en los dos modos por construcción,
  no por dos implementaciones mantenidas de acuerdo.
- **El orden lo manda el SQL** en las dos dimensiones: las categorías y las series salen en orden de
  aparición de las filas. Misma tesis que `chrono` — el calendario lo conoce el `ORDER BY`.
- **Cota de series** (`CHART_MAX_SERIES = 8`): sobre 8 valores distintos, el excedente se colapsa en
  una serie «(otras)» que suma. El techo es el tamaño de la paleta categórica: por encima los colores
  se ciclan y dos series distintas se dibujan iguales, que es peor que agregarlas explícitamente. El
  total de cada categoría se conserva.
- **Celdas ausentes valen 0** y los pares `(categoría, serie)` repetidos se **suman** — un par
  repetido es una agregación incompleta en el SQL, y quedarse con el último perdería filas sin decirlo.
- **`sort: value:<serie>` se acepta pero NO se valida** en modo largo: las series no existen sin los
  datos, así que no hay lista contra la cual verificar el token al validar el spec. Si no matchea
  ninguna serie derivada, el orden cae a `magnitude` — el mismo default de un spec sin `sort`.

### `sort` — orden declarable de las categorías

Vocabulario **cerrado**; el default (ausente) es `magnitude`, que es el contrato histórico: un spec
que no declara `sort` renderiza idéntico.

| Token | Qué ordena |
|--|--|
| `magnitude` | Magnitud descendente. En agrupado, por la **suma** de las series; en mono, por la métrica. |
| `chrono` | **No re-ordena**: manda el orden de llegada de las filas, o sea el `ORDER BY` del SQL. |
| `value:<serie>` | Por **una** serie declarada, descendente. `<serie>` es su `label` o su `field`. |

```yaml
- distribution:
    dimension: data.cruce.periodo
    metrics:
      - { field: plantas_base,   label: "Base" }
      - { field: plantas_actual, label: "Actual" }
    sort: chrono            # ene→dic tal como los ordenó el SQL
```

- **`chrono` NO parsea fechas ni meses.** El calendario lo conoce el `ORDER BY` del SQL, que es quien
  tiene el dato; meter un parser de meses en español dentro del motor sería moverlo al lugar
  equivocado. Es la misma tesis ya vigente en `series`.
- **La cota top-N usa el mismo criterio**: con `chrono` se conservan las primeras N *en orden de
  llegada* (no se re-ordena para cortar); con `value:<serie>` el top-N se rankea por ESA serie. En
  los tres casos «(otros)» sigue sumando cada serie por separado.
- **`value:<serie>` colgante es error de validación** (`distribution-sort-value-dangling`), con la
  lista de series válidas en la remediación — no un orden arbitrario en silencio.
- **Modo mono**: se acepta además el token legacy `-campo` / `campo`, que ordena las filas por ese
  campo. En modo **agrupado** ese token se rechaza (`distribution-sort-unknown`): ahí nunca tuvo
  efecto, y aceptarlo sería prometer un orden que no ocurre.

### Rótulos de valor sobre las marcas

Cada barra (y cada sub-barra del modo agrupado) lleva su valor rotulado. Es **convención de
plataforma**, no un opcional del spec: un gráfico de barras sin cifra obliga a estimar contra el eje.

- El rótulo se **pre-computa server-side** y viaja como un campo del dato; Vega solo lo pinta. El
  formateador es el mismo `vtFormat` de las tablas — no hay una segunda implementación de formato en
  expresiones Vega que pueda divergir.
- **Formato**: el `format` declarado en el `distribution` si lo hay; sin él, `abbr`.
- El rótulo es parte del SVG ⇒ **se imprime**, sin trabajo extra.
- La holgura del dominio cuantitativo (~10 %) evita que el rótulo de la marca más larga se corte
  contra el borde. La anti-colisión fina entre rótulos vecinos (rotar/omitir) es decisión del motor y
  **no se declara por spec**.

#### Formato `abbr` — magnitud abreviada (es-CL)

| Valor | `abbr` | `int_0` |
|--|--|--|
| `1234567` | `1,2M` | `1.234.567` |
| `340000` | `340K` | `340.000` |
| `2500000000` | `2.500M` | `2.500.000.000` |
| `999` | `999` | `999` |

Escalera de **dos** sufijos a propósito: K (miles) y M (millones). No se usa «B»: en español
«billón» es 10¹², así que 2,5·10⁹ se rotula `2.500M` — millones, la unidad idiomática — en vez de un
`2,5B` que se leería mil veces mayor. Coma decimal y punto de miles como el resto del formateador; un
decimal solo si la mantisa es menor a 100.

## 3 · `series` — líneas de N series sobre un eje

```yaml
- series:
    data: data.acumulado          # dataset; cada fila = un punto del eje x
    x: mes                        # campo del eje (el SQL ya lo ordena/agrega)
    metrics:                      # 1..N series (formato wide: una columna por serie)
      - { field: acumulado_base,   label: "Base" }
      - { field: acumulado_actual, label: "Actual" }
    format: int_0
    title: "Acumulado mensual — Base vs Actual"
```

- **`data`** es el dataset (`data.<dataset>`); cada fila es un punto del eje. **`x`** es el campo del
  eje; **`metrics`** las series (≥1). `x` y los campos de serie se validan contra el shape.
- **Render**: `fold` + `mark: line` con puntos, leyenda abajo, paleta del theme (`chartSeries`).
- **El eje x respeta el ORDEN DE LLEGADA de las filas** (`sort: null`): el SQL manda el orden y la
  agregación del eje; **no** se re-ordena alfabético.

### Desviación declarada vs doc de diseño §4.1 (`006/3`)

`time_field` / `granularity` / `range` **no se implementan**. El eje temporal lo modela la **query**
(principio Gold-in-query): la agregación por mes/semana y el orden salen del SQL, no de un motor de
tiempo en el render. **`x` reemplaza a `time_field`.** El eje es ordinal en el orden de las filas.

## 4 · Tema y color de los charts (no declarable por spec)

El fondo y la paleta son **convención de plataforma**, no algo que un PI declare: el spec dice QUÉ se
grafica, la plataforma decide CÓMO se ve.

- **Todo PI nace con fondo blanco** — reportes y dashboards por igual. La instancia puede revertirlo
  con `VERGIS_THEME_REPORT` / `VERGIS_THEME_DASHBOARD` (formato `theme[@paleta]`).
- **Los colores del chart se hornean en el SVG server-side**, así que un theme con paletas
  conmutables declara un juego de tokens **por paleta** (`Theme.chartTokensByPalette`): lo que
  contrasta sobre fondo oscuro se lava sobre blanco. El render resuelve los tokens de la paleta
  ACTIVA, no los del theme a secas.
- **El selector de Apariencia re-colorea también los gráficos.** Un atributo de presentación de SVG
  (`fill="#…"`) no admite `var()`, así que el render reescribe cada color de token a
  `style="fill:var(--chart-bar,#…)"` —una declaración CSS gana sobre el atributo— y cada paleta
  declara sus `--chart-*`. El hex horneado queda solo como respaldo. **No se re-compila Vega en el
  browser**: el contrato del motor sigue siendo SVG server-side, que imprime gratis.
- **Invariante de los juegos de tokens de un theme**: `chartBar` es el color de la primera serie. Así
  el mapa hex→variable asigna los mismos nombres bajo cualquier paleta activa.

## 4·bis · Color de magnitud en tablas — afordancia del lector

El sombreado de una celda según su magnitud es **preferencia de lectura, no contrato de negocio**:
misma familia que orden, filtro, export y columnas fijas. El spec declara QUÉ dato; la plataforma
decide CÓMO se manipula.

- **Nace apagado.** La celda emite su posición en la rampa (`--mag`, 0..1) y el color solo se pinta
  con `data-magnitude="on"` en el documento. El interruptor vive en la bandeja, junto a la paleta, y
  persiste por reporte en `localStorage` — mismo mecanismo que ya usan paleta y anotaciones.
- **La rampa la fija el theme** (`--mag-h` / `--mag-s`), y **nunca es roja**. En un informe de
  negocio el rojo significa *malo*, no *mucho*; una escala de magnitud tiene que leerse como
  magnitud. Señalar bueno/malo es una escala **divergente** anclada en un punto de referencia — otro
  concepto, y ése sí tendría que declararlo el spec.
- **Qué columnas son candidatas**: las numéricas. `colorscale: true` en una columna **acota** las
  candidatas a las declaradas, así que la intención del autor del spec no se pierde — lo que pierde
  es el poder de **encenderlo**, que pasa al lector.
- **El interruptor no aparece si ninguna columna resultó rampeable.** Un control que no enciende
  nada es peor que su ausencia.

Antecedente: la rampa anterior era `hsl(8, 75%, L%)` —hue 8 es rojo— oscureciendo al crecer el
valor, o sea *la cifra más grande era la más roja*. El cliente lo leyó como negatividad y pidió
retirarlo; la instancia sacó los 44 `colorscale` de sus 7 specs.

## 4·ter · Filtro de columna en tablas — lo decide el dato, no el spec

El ícono embudo del encabezado abre un popover, y **qué ofrece ese popover depende del dato de la
columna**, no de lo que el spec declare. Es la misma familia que §4·bis: afordancia del lector.

- **Columna de texto → la lista de valores distintos** (checklist con buscador y conteos). Es lo que
  sirve cuando los valores se repiten: «Área: Logística».
- **Columna numérica → «Filtros de número»**, al modo de Excel: tres atajos (`Positivos (> 0)`,
  `Negativos (< 0)`, `En cero`) y una fila de operador (`mayor que` · `menor que` · `entre` ·
  `igual a`) con sus valores. **Sin** checklist ni buscador — marcar montos uno a uno no expresa
  «los negativos».
- **Lo decide `vtIsNumericCol`**, o sea el dato materializado, no una declaración del spec. Un autor
  de spec no puede prenderlo ni apagarlo: es convención de plataforma.

**Semántica, escrita entera** (vive en `VtNumFilter`): los atajos son estrictos —`> 0` deja fuera el
cero—, `entre a y b` es inclusivo en ambos bordes, y una **celda vacía o no numérica queda fuera**
mientras su columna tenga filtro numérico activo: «los negativos» no incluye «los que no tienen
dato». El estado produce **un** chip por columna (`Deuda Total: < 0`, `Deuda Total: entre 1.000 y
5.000`), removible con un clic, formateado con el `format` de la columna para que el chip lea como
lee la celda. Viaja en las vistas guardadas, lo borra «Limpiar todo» y cuenta para el sufijo
`--filtrado` del CSV.

Antecedente: en PI-01 la columna «Deuda Total» ofrecía sus montos como valores marcables. Quien
quiso los negativos marcó decenas a mano y terminó con una pared de chips de un monto cada uno.

## 5 · El resto del catálogo: diseñado, no construido

Estos elementos del catálogo de diseño quedan **especificados pero sin construir**; su disparador de
construcción se documenta aquí para no re-litigarlo:

- **`narrative`** — bloque de texto generado/asistido. **Disparador**: lo definirá **Miranda** (capa
  de composición asistida); no se construye a mano ahora.
- **`alert`** — aviso accionable con umbral. **Disparador**: requiere un subsistema de *delivery*
  (canales, deduplicación, acuse). El **rol visual** de un aviso ya lo cubre `semaforo`.
- **`comparison`** — comparación explícita entre dos medidas. El caso simple ya lo cubre
  `kpi.comparison` (valor + comparación + etiqueta); un elemento propio espera un caso que lo motive.

---

• *Generado con Wingworking*
