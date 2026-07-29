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
