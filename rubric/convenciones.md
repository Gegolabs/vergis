# Convenciones de plataforma — catálogo para Miranda

**Versión:** 1.0 · **Estado:** acumulando casos (sin cablear — issue #111)
Cada entrada: cómo SUENA chocar la convención sin saber que existe, y la frase canónica de respuesta.
Ante conflicto entre una entrada y el doc canónico que cita, manda el doc canónico.
No entra una entrada sin fuente canónica del Producto o caso real registrado.

**Qué es este archivo.** La **semilla montable** del Producto: la sede canónica del catálogo vive
versionada aquí; la instancia lo **copia** a su `MIRANDA_RUBRIC_DIR` junto a `dsl.md` y `qc1.md`.
Hoy **no está cableado**: ninguna línea de código lo lee todavía (el cableado es el hito H2 del
diseño `work/004-cluster-disenos-backlog-2026-08-07/05-111-rubrica-convenciones-v1.0.md`).

**Disparador de destranque del cableado** — dos casos aplicados registrados en el ledger de las
entradas, medibles con:

```bash
grep -c '^  - caso ' rubric/convenciones.md   # cablear cuando ≥ 2
```

Circuito de registro de un caso: (a) agregar la línea `- caso …` en la entrada chocada de este
archivo, (b) pegar la misma línea como comentario en el issue #111. El conteo del repo manda; el
comentario notifica.

**La regla de zona gris la carga el CÓDIGO, no este archivo.** Al cablear, un framing constante del
Producto (`CONVENTIONS_FRAMING`, patrón de `MIRANDA_HARD_RULES`) impone que toda entrada marcada
`zona: gris` se **reconozca y declare**, jamás se dictamine ni se auto-resuelva. Este archivo solo
declara qué entrada es gris; la prohibición no depende de él y no puede desactivarse editándolo.

## C-01 · Estética de charts: el spec dice QUÉ, la plataforma decide CÓMO se ve

- **Convención:** el fondo y la paleta son convención de plataforma, no algo que un PI declare;
  todo PI nace con fondo blanco y la identidad visual se decide por instancia (`VERGIS_THEME_*`),
  jamás por spec — fuente: `docs/catalogo-elementos.md` §4.
- **Zona:** normal
- **Cómo suena chocarla:** «¿pueden poner el gráfico en los colores de la empresa?» ·
  «quiero este reporte con fondo oscuro» · «cámbiale el color a las barras».
- **Respuesta canónica:** «El color y el fondo son convención de la plataforma: el spec dice QUÉ se
  grafica y la plataforma decide CÓMO se ve, para que todos los PI se lean igual. Lo que sí me ayuda:
  ¿qué rol cumple este elemento — una medida, una comparación, una alerta?»
- **Redirige a:** el rol del elemento (kpi/dato/semaforo/comparación). Si el pedido es identidad
  visual de TODA la instancia, es decisión de instancia (`VERGIS_THEME_REPORT`/`_DASHBOARD`) y se
  levanta al operador — no cabe en un PI.
- **Casos aplicados:**

## C-02 · Rótulos de valor sobre las barras: siempre presentes

- **Convención:** cada barra (y sub-barra) lleva su valor rotulado; es convención de plataforma, no
  un opcional del spec — un gráfico sin cifra obliga a estimar contra el eje y no imprime bien —
  fuente: `docs/catalogo-elementos.md` §«Rótulos de valor sobre las marcas».
- **Zona:** normal
- **Cómo suena chocarla:** «quítale los numeritos a las barras» · «se ve muy cargado con tantas
  cifras» · «¿pueden dejar el gráfico limpio, solo las barras?»
- **Respuesta canónica:** «Los rótulos de valor son convención de la plataforma: sin la cifra, leer
  el gráfico obliga a estimar contra el eje, y el reporte impreso pierde el dato. Si el problema es
  la densidad, la palanca es otra: menos categorías o un corte distinto.»
- **Redirige a:** si molesta el formato del número → `format` del elemento (p. ej. `abbr`); si
  molesta la densidad → el corte de datos (top-N, otra dimensión) — eso sí es del spec.
- **Casos aplicados:**

## C-03 · El orden de las categorías lo manda la query, no el motor

- **Convención:** el motor no parsea fechas ni meses: el calendario lo conoce el `ORDER BY` del SQL
  (Gold-in-query); `sort: chrono` respeta el orden de llegada de las filas — fuente:
  `docs/catalogo-elementos.md` §`sort` y §3 (`series`).
- **Zona:** normal
- **Cómo suena chocarla:** «los meses salen desordenados, ordénalos de enero a diciembre» ·
  «¿por qué el gráfico ordena de mayor a menor si esto es una serie en el tiempo?»
- **Respuesta canónica:** «El orden calendario lo pone la consulta, que es quien conoce el dato: yo
  declaro `sort: chrono` y la fuente entrega los meses ya ordenados. No hay un parser de meses en el
  motor — y eso es a propósito.»
- **Redirige a:** la definición de la medida/fuente (que el orden quede en la query) — eso sí se
  especifica en el PI.
- **Casos aplicados:**

## C-04 · Legibilidad — ZONA GRIS: juicio humano

- **Convención:** «que se lea bien» (tamaño percibido, apretujamiento, comprensibilidad de un
  gráfico) no tiene regla mecánica: es juicio humano y NO se auto-resuelve — fuente: issue #111
  (frontera declarada; origen P-105, instancia GH).
- **Zona:** gris
- **Cómo suena chocarla:** «no se lee» · «la letra quedó muy chica» · «este gráfico no se entiende».
- **Respuesta canónica:** «Ese punto cae en zona gris: la legibilidad es un juicio humano y no me
  corresponde zanjarlo — ni afirmarte que se lee bien ni cambiar el spec para “arreglarlo”. Lo dejo
  planteado para el operador de la plataforma, y sigamos con lo que sí puedo resolver contigo.»
- **Redirige a:** el operador de la plataforma / César (canal humano). Miranda NO modifica el draft
  para zanjar legibilidad ni emite veredicto en ningún sentido.
- **Casos aplicados:**
