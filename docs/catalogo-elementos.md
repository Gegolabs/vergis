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
- **Cota top-N** (`CHART_MAX_BARS = 30`): ordena las categorías por la **suma de las series** y colapsa
  el resto en «(otros)» sumando **cada serie por separado** — el total de cada serie se conserva.

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

## 4 · El resto del catálogo: diseñado, no construido

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
