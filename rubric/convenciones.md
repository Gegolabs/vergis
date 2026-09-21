# Convenciones de plataforma — catálogo para Miranda

**Versión:** 2.0 · **Estado:** ledger con 3 casos — el umbral de destranque del cableado está
alcanzado; el cableado en sí es el hito H2 del issue #111 y no está hecho.
Cada entrada: cómo SUENA chocar la convención sin saber que existe, y la frase canónica de respuesta.
Ante conflicto entre una entrada y el doc canónico que cita, manda el doc canónico.
No entra una entrada sin fuente canónica del Producto o caso real registrado.

## ¿Quién es fuente y quién derivado?

**La fuente viva del catálogo es la instancia**; este archivo es su **derivado** para el cinturón de
Miranda. La sede donde una convención nace, se argumenta, se revisa y se retira es la pieza `11`
de la práctica del proceso de PI (`practicas/a-proceso-produccion-de-pi/11-convenciones-de-plataforma`,
IDs `CV-NN`), que vive en el repo de instancia y sostiene además el respaldo externo de cada entrada
con su contra-evidencia. Lo que se monta en `MIRANDA_RUBRIC_DIR` es **este** archivo, destilado de
aquél: la regla, cómo suena y la respuesta lista.

La dirección importa porque es lo que evita que dos documentos aprobados se contradigan en silencio:
**una convención nueva o revisada se escribe primero allá y baja acá; jamás al revés.** Un cambio
nacido en este archivo sin su contraparte en la instancia queda huérfano de argumento y de respaldo.
Lo que sí es propio de acá y no sube: nada — este archivo no agrega doctrina, la recorta.

**Qué se recorta al derivar** (vive en la instancia y no acá): la conducta de cada clase dentro del
proceso de revisión de specs (qué rebota como brecha y en qué columna), el protocolo de educación en
el ticket, el respaldo externo con sus citas, los ejemplos con nombres de PI y de personas, el estado
de revisión de una entrada y el pacto anti-drift con las otras piezas de la práctica.

**IDs.** Se usan los `CV-NN` de la instancia, que son los IDs vivos y citados en sus piezas; no hay
un numerador propio de este archivo. Correspondencia con los IDs que este archivo usó antes de
alinearse, para que ninguna cita quede huérfana:

| ID antiguo | ID vigente | Nota |
|--|--|--|
| `C-01` | `CV-03` | Estética de charts = look & feel de plataforma. |
| `C-02` | `CV-06` | Rótulos de valor sobre las marcas. |
| `C-03` | `CV-07` | Orden de categorías: el default es convención, el orden deseado es contrato — `CV-07` es la formulación exacta. |
| `C-04` | `CV-03` (zona gris) | La legibilidad no es entrada propia: es el borde declarado de `CV-03`. |

## ¿Cómo se lee una entrada?

- **Convención** — la regla y la razón que la sostiene, con su fuente canónica.
- **Zona** — `normal` o `gris`. `gris` marca la entrada cuya frontera es **juicio humano**: se
  reconoce y se declara, no se dictamina.
- **Cómo suena chocarla** — formulaciones reales o verosímiles. Es el insumo del detector.
- **Respuesta canónica** — texto listo para usar en conversación: afirmar la capacidad, explicar la
  razón, ofrecer la vía.
- **Redirige a** — dónde sí cabe lo que la petición quiere.
- **Borde (qué SÍ puede ser defecto)** — el límite honesto de la convención: lo que no se defiende
  con ella porque es incumplimiento del producto.
- **Casos aplicados** — el ledger, con la forma de línea fija de abajo.

**El ledger y su disparador.** Dos casos aplicados registrados destraban el cableado, medibles con:

```bash
grep -c '^  - caso ' rubric/convenciones.md   # cablear cuando ≥ 2
```

Forma de línea fija (dos espacios de sangría, prefijo `- caso `):
`  - caso <fecha> · <instancia> · «<cita>» · <qué se hizo> · <ancla>`.
Circuito de registro: (a) agregar la línea en la entrada chocada de este archivo, (b) pegar la misma
línea como comentario en el issue #111. El conteo del repo manda; el comentario notifica.

**La regla de zona gris la carga el CÓDIGO, no este archivo.** Al cablear, un framing constante del
Producto (`CONVENTIONS_FRAMING`, patrón de `MIRANDA_HARD_RULES`) impone que toda entrada marcada
`zona: gris` se **reconozca y declare**, jamás se dictamine ni se auto-resuelva. Este archivo solo
declara qué entrada es gris; la prohibición no depende de él y no puede desactivarse editándolo.

**Qué está cableado hoy:** nada — ninguna línea de código lee este archivo todavía (el cableado es el
hito H2 del diseño `work/004-cluster-disenos-backlog-2026-08-07/05-111-rubrica-convenciones-v1.0.md`).

## CV-01 · Los controles viven en la bandeja; la cara muestra estado

- **Convención:** todo control —filtros, selectores, búsqueda, agrupar-por, descarga, configuración—
  vive en la **bandeja** (el panel lateral, alias Inspector). El cuerpo del PI es la pieza (tablas,
  tarjetas, gráficos) más la navegación; lo que queda arriba sobre el documento es **estado**: los
  sellos de alcance y los **chips** de los filtros activos. En una línea: *cara = estado · bandeja =
  maquinaria · print = estado como texto*. Existe por tres razones propias: el PI es un documento
  imprimible y el print depende de esa separación (CV-08); el estado se sigue viendo, porque los
  chips lo declaran; y el lector aprende **una vez** dónde están los controles y opera todos los PIs
  igual — fuente: `docs/superficie-de-estado.md` §1.
- **Zona:** normal
- **Cómo suena chocarla:** «incorporar en la cabecera del gráfico filtros de…» · «en el encabezado
  del dashboard debe permitir seleccionar…» · «los filtros deben ir en la parte superior» · «poner el
  selector arriba de la tabla» · «pero estos cambios no se han aplicado» (cuando el filtro sí existe,
  en la bandeja).
- **Respuesta canónica:** «Los filtros están construidos y operando: viven en la **bandeja** del PI
  (el panel lateral donde están todos los controles), que es donde la plataforma ubica los controles
  de todos los PIs por igual — así todos se operan de la misma forma y el documento impreso queda
  limpio. Lo que se ve arriba, sobre el documento, son los **chips** de lo que está filtrando.»
- **Redirige a:** qué dimensiones deben filtrar y qué debe re-anclar cada una — eso sí es del spec.
  La ubicación no lo es.
- **Borde (qué SÍ puede ser defecto):** que la bandeja **no abra**, o que el control no exista o no
  re-ancle lo que la spec declara. La convención dice dónde vive el control; no inmuniza a la
  plataforma de que ese lugar funcione.
- **Casos aplicados:**
  - caso 2026-07-29 · GH · «se solicitó incorporar en la cabecera del gráfico filtros de Año, País Destino, Especie y Variedad… pero estos cambios no se han aplicado» · los cinco filtros estaban operando en la bandeja: se respondió con CV-01 y la evidencia del render, sin mover nada · comentario Jira `11171`

## CV-02 · Alcance y filtro son cosas distintas: sello vs chip

- **Convención:** un **selector de alcance** elige *qué documento se ve* (nunca puede quedar vacío; se
  muestra como **sello** siempre visible en la banda superior, y el sello **es** el control). Un
  **filtro** acota las filas ya traídas (puede quedar vacío; su maquinaria vive en la bandeja y su
  estado activo aparece como **chip** removible). Test: si «limpiar» no puede dejar la selección
  vacía, es alcance; si «limpiar» devuelve un superconjunto, es filtro. Confundirlos produce
  documentos sin identidad («¿qué versión estoy mirando?») o filtros que no se pueden quitar — fuente:
  `docs/superficie-de-estado.md` §1.
- **Zona:** gris
- **Cómo suena chocarla:** «el selector de versión también debe ir con los filtros» · «que el filtro
  venga siempre con un valor elegido» · «quiten el sello de arriba» · «agranda y destaca la semana».
- **Respuesta canónica:** «El selector de [X] es el **alcance** del documento — define qué
  [versión/semana/OC] estás mirando, y por eso se muestra como sello siempre visible, aparte de los
  filtros. Los filtros acotan filas dentro de ese alcance y por eso pueden quedar vacíos. Es la misma
  lógica en todos los PIs.»
- **Redirige a:** qué dimensión cumple rol de alcance y cuál de filtro — eso se declara en el spec.
- **Borde (qué SÍ puede ser defecto):** una petición de estilo sobre un elemento de la banda puede
  estar diciendo que ese elemento **cumple un rol que la convención sub-expresa**. Eso no se zanja ni
  con CSS local ni con un rechazo: se entiende el rol y, si corresponde, la convención cambia para
  todos.
- **Casos aplicados:**

## CV-03 · El look & feel es único y de plataforma

- **Convención:** tema, fondo, paleta, tipografías y tamaños los define la plataforma, parejos para
  todos los PIs. Todo PI nace con **fondo blanco** y colores calibrados para contraste sobre claro; el
  consumidor puede cambiar la apariencia desde el selector de Apariencia de la bandeja, y ese cambio
  re-colorea también los gráficos. Nada de esto se declara por spec ni se implementa como estilo local
  de un PI: la coherencia visual entre PIs es un valor de producto, y técnicamente los colores de los
  charts se hornean server-side con los tokens del tema — un CSS local pelearía con el mecanismo de
  paletas conmutables — fuente: `docs/catalogo-elementos.md` §4.
- **Zona:** gris
- **Cómo suena chocarla:** «considerar como color de fondo el blanco» · «los valores con texto color
  negro» · «resalta esta columna en rojo» · «usa la letra más grande en este reporte» · «que este
  dashboard use los colores corporativos» · «cámbiale el color a las barras».
- **Respuesta canónica:** «El fondo, los colores y la tipografía los define la plataforma, parejos
  para todos los PIs — por eso no se especifican por PI ni se implementan como estilo local. El tema
  vigente ya rinde fondo claro y texto de alto contraste; además, desde Apariencia en la bandeja se
  puede cambiar la paleta y los gráficos se re-colorean con ella. Si algún valor se lee mal (se corta,
  se superpone, no contrasta), eso sí es un defecto y lo levantamos al motor — cuéntanos dónde lo ves.»
- **Redirige a:** el rol del elemento (kpi/dato/semáforo/comparación), que sí es del spec. Si el
  pedido es identidad visual de TODA la instancia, es decisión de instancia (`VERGIS_THEME_REPORT` /
  `VERGIS_THEME_DASHBOARD`) y se levanta al operador — no cabe en un PI.
- **Borde (qué SÍ puede ser defecto) — ZONA GRIS, juicio humano:** la **legibilidad**. Un rótulo que
  no contrasta con su fondo, texto que se corta, elementos que se superponen: eso no es «estilo», es
  defecto de render del motor y se arregla para todos los PIs a la vez. La vara: si hay que esforzarse
  para *leer* el dato, es defecto; si el dato se lee pero se querría *más bonito o distinto*, es
  convención. **Esa vara es juicio humano, no un algoritmo: ante un reporte de legibilidad se
  reconoce, se declara y se encauza al canal humano — no se dictamina que «se lee bien» ni se cambia
  el draft para «arreglarlo».**
- **Casos aplicados:**

## CV-04 · El gesto de UI lo decide la plataforma — y los gráficos son SVG server-side

- **Convención:** la spec captura **intención funcional** («activar el detalle de un registro»), no
  micro-interacciones; el gesto concreto —clic, doble clic, hover, menú— lo decide la plataforma. Los
  gráficos son **SVG horneado en el servidor y se imprimen tal cual**; sobre ese SVG la plataforma
  ofrece dos gestos estándar, no configurables por spec: el tooltip nativo del navegador y el realce
  del rótulo bajo el cursor (desde 0.23.0). Nada esencial vive solo en el hover — el rótulo permanente
  (CV-06) es la lectura primaria y la única que se imprime. Un PI no «gana» un gesto por pedirlo: la
  plataforma lo adopta para todos por igual. Existe porque fijar el gesto sobre-especifica y fabrica
  falsos conflictos spec↔producto — fuente: `docs/catalogo-elementos.md` (encabezado: los charts
  pasan por el pipeline Vega-Lite → Vega → SVG server-side) · `gegolabs/vergis#208` y `#263`.
- **Zona:** normal
- **Cómo suena chocarla:** «al hacer clic debe desplegarse…» · «destacar el valor cuando el mouse pase
  por encima (sensible al contexto)» · «doble clic para entrar al detalle» · «que aparezca un tooltip
  con el dato exacto».
- **Respuesta canónica:** «Tomamos "[gesto]" como la intención de [resultado], que es lo que la spec
  norma; el gesto concreto lo resuelve la plataforma de forma pareja en todos los PIs. Sobre los
  gráficos: el valor exacto va rotulado de forma permanente sobre cada marca —es la lectura primaria y
  la única que sale en el PDF—, al pasar el cursor por un punto su rótulo se realza, y el navegador
  muestra además el valor de la marca. Son gestos de plataforma y no se configuran por spec.»
- **Redirige a:** el resultado esperado («caigo en el detalle del socio»), que es lo que el spec
  declara y contra lo que se evalúa la aceptación.
- **Borde (qué SÍ puede ser defecto):** que la intención no quede satisfecha por ninguna vía — si no
  hay forma de llegar al detalle, el gesto es lo de menos. Antes de afirmar los gestos de gráfico en
  un PI concreto se verifica en el render vivo: la plataforma tiene que estar en 0.23.0 o posterior.
- **Casos aplicados:**
  - caso 2026-09-02 · GH · «que se agrandaran los valores cuando el puntero del mouse pasa sobre ellos. Sensible al contexto» · la convención cedió su letra: se construyó el realce del rótulo bajo el cursor y la entrada se evolucionó · `gegolabs/vergis#263`, 0.23.0

## CV-05 · La leyenda tiene una posición única de plataforma

- **Convención:** la posición y la forma de la leyenda las fija la plataforma, igual en todos los PIs:
  **arriba, en banda horizontal, fuera del área de datos**. No se declara por spec ni se ajusta por
  gráfico. Existe porque el ojo aprende una vez dónde buscar la leyenda, y «fuera del área de datos»
  es parte de la declaración, no un detalle: los orients de esquina dibujan la leyenda **dentro** del
  rectángulo de datos y pisan marcas — fuente: `gegolabs/vergis#96`, PR `#98`, merge `dcb025b`.
- **Zona:** normal
- **Cómo suena chocarla:** «la leyenda ubicarla en la parte superior derecha del gráfico» · «la
  leyenda abajo tapa menos» · «leyenda a la izquierda en este chart».
- **Respuesta canónica:** «La posición de la leyenda la fija la plataforma, igual para todos los
  gráficos de todos los PIs — va arriba, en banda propia fuera del área de datos, para no tapar
  marcas. Si en algún gráfico la leyenda tapa datos o se corta, eso es un defecto de render y lo
  levantamos al motor.»
- **Redirige a:** qué series entran al gráfico y cómo se nombran — eso sí es del spec.
- **Borde (qué SÍ puede ser defecto):** una leyenda que **se superpone** con las marcas o con los
  rótulos de valor, o que se corta. Eso es legibilidad (CV-03) → defecto del motor.
- **Casos aplicados:**

## CV-06 · Rótulos de valor sobre las marcas: siempre, con formato de plataforma

- **Convención:** cada barra (y sub-barra) lleva su valor rotulado — es convención de plataforma, **no
  un opcional del spec**: un gráfico sin cifra obliga a estimar contra el eje y el impreso pierde el
  dato. El formato por defecto es `abbr` es-CL (`1,2M`, `340K`; escala de dos sufijos K/M — nunca «B»,
  porque en español «billón» es 10¹²), y el rótulo es parte del SVG, así que se imprime. La
  anti-colisión fina entre rótulos vecinos la decide el motor y no se declara por spec: **jamás rota**
  el rótulo — elige entre `single` (caben uno al lado del otro), `lanes` (no caben en un carril pero sí
  en dos) y `none` (ni en dos caben, y entonces no rotula, porque dos rótulos fundidos informan menos
  que cero) — fuente: `docs/catalogo-elementos.md` §2 · `packages/capabilities/src/render-chart.ts`.
- **Zona:** normal
- **Cómo suena chocarla:** «quítale los numeritos a las barras» · «se ve muy cargado con tantas
  cifras» · «¿pueden dejar el gráfico limpio, solo las barras?» · «los valores agregados no deben
  superponerse».
- **Respuesta canónica:** «Cada barra lleva su valor rotulado de forma permanente — es parte de la
  plataforma, no algo que cada PI configure, y por ser parte de la imagen también sale en el PDF. La
  distribución fina de los rótulos (que no choquen entre sí ni con la leyenda) la resuelve el motor: si
  no caben en un carril los reparte en dos, y si ni así caben prefiere no rotular antes que fundirlos.
  Si en algún gráfico se están superponiendo, eso es un defecto del motor: dinos en cuál.»
- **Redirige a:** el `format` del elemento (p. ej. `int_0` en vez de `abbr`) si lo que molesta es el
  número, o el corte de datos (top-N, otra dimensión) si lo que molesta es la densidad. Las dos cosas
  son contrato y se declaran en el spec.
- **Borde (qué SÍ puede ser defecto):** la **cobertura** — el motor rotula barras (`distribution`), no
  líneas (`series`): el rótulo sobre la curva es capacidad en camino (`gegolabs/vergis#94`), no
  convención que negar. Y la superposición de rótulos entre sí o con la leyenda es defecto del motor,
  con cauce de issue.
- **Casos aplicados:**
  - caso 2026-07-29 · GH · «los valores agregados no deben superponerse, lo mismo las leyendas» · NO era convención: defecto del motor, arreglado en `gegolabs/vergis#97` (PR `#98`, merge `dcb025b`) · comentario Jira `11171`

## CV-07 · El orden por defecto es magnitud descendente — el orden distinto se declara, no se pelea

- **Convención:** si el spec no declara nada, las categorías de un `distribution` salen por **magnitud
  descendente** — es el default correcto para responder «¿qué pesa más?», la pregunta típica de una
  distribución. Pero el orden **es declarable** desde 0.13.0: `sort: chrono` (manda el `ORDER BY` del
  SQL), `sort: value:<serie>`, `sort: magnitude`. El default es convención; el orden deseado es
  contenido del contrato. `chrono` no parsea meses: el calendario lo conoce el SQL, que es quien tiene
  el dato — un parser de meses en el motor estaría en el lugar equivocado — fuente:
  `docs/catalogo-elementos.md` §2 (`sort`).
- **Zona:** normal
- **Cómo suena chocarla:** «el mes debe ir ordenado desde enero a diciembre» · «los meses salen
  desordenados, ordénalos» · «ordenar de mayor a menor según presupuesto» · «¿por qué las barras salen
  desordenadas?».
- **Respuesta canónica:** «Por defecto las barras se ordenan por magnitud descendente — es el contrato
  del elemento cuando la spec no dice otra cosa. Si quieres un orden distinto (por ejemplo cronológico,
  enero→diciembre), basta declararlo en la spec y la consulta entrega las filas ya ordenadas: es una
  línea, y te la dejo pre-escrita — "[gráfico X] se ordena cronológicamente (ene→dic)".»
- **Redirige a:** la declaración `sort:` en el spec y el `ORDER BY` de la fuente. Eso es contrato, no
  convención.
- **Borde (qué SÍ puede ser defecto):** ninguno propio — un orden que la spec nunca pidió por escrito
  tampoco es defecto del build. Esta entrada es además el patrón general del catálogo: **una
  convención puede graduarse a capacidad declarable** cuando el Producto libera vocabulario, y
  entonces lo que se educaba pasa a declararse.
- **Casos aplicados:**

## CV-08 · Se imprime el estado, no la maquinaria

- **Convención:** el print/PDF de un PI conserva el **estado** como texto plano —el sello de alcance
  («OC 17400358»), los filtros activos como letra chica («Filtros: Especie: Cerezo»), el contador de
  filas— y la **maquinaria desaparece**: pickers, búsqueda, botones, la ✕ de los chips. Los gráficos
  salen idénticos a pantalla porque son SVG server-side. Existe porque un documento impreso debe
  declarar honestamente qué se estaba viendo, sin arrastrar controles muertos que en papel no operan —
  fuente: `docs/superficie-de-estado.md` §1, §3–§4.
- **Zona:** normal
- **Cómo suena chocarla:** «en el PDF no aparecen los selectores» (correcto: no deben) · «que el filtro
  salga en la impresión» (sale — como texto, si está activo) · «el botón de descarga no se ve al
  imprimir».
- **Respuesta canónica:** «El documento impreso conserva el estado —qué alcance y qué filtros estaban
  activos, como texto— y omite los controles, que en papel no operan. Si un filtro activo no estuviera
  quedando declarado en la impresión, eso sí sería un defecto: avísanos.»
- **Redirige a:** qué estado debe quedar declarado en el documento — eso sí puede razonarse en el spec.
- **Borde (qué SÍ puede ser defecto):** que el print **omita el estado**. Un filtro activo que no queda
  declarado hace mentir al documento impreso sobre su contenido.
- **Casos aplicados:**

## CV-09 · Las afordancias son proporcionales: tablas display sin maquinaria, kit único

- **Convención:** una tabla de una sola fila o de presentación pura no recibe maquinaria interactiva
  (ni búsqueda, ni filtros por columna, ni bloque en la bandeja). Las afordancias de tabla (buscar ·
  agrupar por · descargar CSV · limpiar) aparecen **una sola vez** por vista; si hubiera dos tablas
  interactivas, el kit lleva selector de objetivo — jamás kits apilados. El contador de filas es
  información del documento: vive al pie de la tabla, en la cara, y se imprime. Existe porque darle
  buscador a una tabla de una fila es ruido, y duplicar kits confunde sobre cuál manda — fuente:
  `docs/superficie-de-estado.md` §5.
- **Zona:** normal
- **Cómo suena chocarla:** «agréguenle búsqueda a la tabla de resumen» · «cada tabla con sus propios
  botones» · «el contador de filas debería estar en el panel».
- **Respuesta canónica:** «Las tablas de presentación (una fila, o resumen fijo) no llevan buscador ni
  filtros — la maquinaria se reserva para las tablas donde operar filas tiene sentido, y aparece una
  sola vez por vista para que siempre esté claro sobre qué actúa. Si la intención es otra (por ejemplo
  trabajar sobre esa tabla), cuéntame el caso y lo encauzamos por la spec.»
- **Redirige a:** el propósito real de la tabla. Dos o más tablas interactivas en una vista suele ser
  señal de que lo que se quiere es multi-vista o drill-through — y eso sí se declara.
- **Borde (qué SÍ puede ser defecto):** que una tabla declarada interactiva no traiga su kit.
- **Casos aplicados:**

## CV-10 · La plataforma no captura datos estructurados; la única tinta al margen es la anotación

- **Convención:** la plataforma es de **consumo** de información, no de captura: no ofrece campos
  editables nombrados, catálogos de valores, formularios ni estados de workflow. La única excepción son
  las **anotaciones**: texto libre anclado al contenido (celda o fila), multi-usuario, que el motor
  jamás lee ni interpreta — ningún filtro, KPI o cruce puede depender de ellas. Existe porque el dato
  transaccional necesita **una sola verdad, con dueño**: un dato que el negocio lee o filtra pertenece
  a un sistema de registro, con su validación y su ciclo de vida, y abrir captura campo a campo en el
  instrumento de consumo crea una segunda verdad sin gobierno. **Es una decisión de gobierno de esta
  plataforma, no una propiedad de la categoría** — el mercado ofrece write-back desde el reporte, y la
  posición se sostiene igual, por gobierno y no por imposibilidad técnica — fuente:
  `docs/capa-de-notas.md`.
- **Zona:** normal
- **Cómo suena chocarla:** «un campo donde el usuario ingrese el estado de gestión» · «un combo para
  clasificar cada fila» · «que se pueda marcar aprobado/rechazado» · «un formulario para pedir
  correcciones».
- **Respuesta canónica:** «La plataforma consume información; no captura datos estructurados (campos
  nombrados, catálogos, estados) — esos datos pertenecen a un sistema de registro, y allá tienen dueño
  y validación. Lo que sí existe son las anotaciones: texto libre anclado a la celda o la fila, visible
  para todos, que el motor no lee. Si eso cubre la necesidad, la spec puede declararlo así: "el campo X
  se realiza como anotaciones de plataforma (texto libre anclado al registro), sin columna ni campo
  dedicado". Si se necesita que el dato ingresado sea filtrable o computable, conversémoslo como flujo
  hacia el sistema de registro que corresponda.»
- **Redirige a:** **no hay vía dentro de la plataforma.** A diferencia de las demás entradas, acá la
  intención no queda satisfecha en otro lugar: la anotación es un sucedáneo **condicionado** (sirve
  solo si quien consume acepta la forma libre), no un equivalente, y elegirlo es una decisión de
  contrato que debe quedar escrita. Lo que no procede es dejar entrar la captura al spec como si la
  plataforma fuera a satisfacerla.
- **Borde (qué SÍ puede ser defecto):** el contenido de una anotación es libre; la frontera dura es la
  **referencia estructural** — en cuanto alguien necesita filtrar o computar sobre lo anotado, ya no es
  anotación: es un dato que pertenece a un sistema de registro.
- **Casos aplicados:**

## CV-11 · La frescura del dato no es materia del contrato funcional

- **Convención:** la frescura/SLA del dato y su cableado (`quality`/`quality.freshness`) no es materia
  del contrato funcional de un PI: vive en el **plano de gobierno**, no en el DSL. La **oferta** (cada
  cuánto se actualiza una fuente) la declara quien conecta la fuente, en el registro de fuentes; la
  **demanda** (cada cuánto el negocio la necesita fresca) la declaran los colaboradores del PI, en su
  gobierno. La formulación precisa no es «la frescura no se pacta», es **«se pacta en otro contrato»**,
  y el contrato funcional del PI solo lo hereda — fuente: `docs/frescura-oferta-demanda.md` §1.
- **Zona:** normal
- **Cómo suena chocarla:** «el dato debe actualizarse cada hora» · «falta el indicador de última
  actualización» · «la spec no dice el SLA».
- **Respuesta canónica:** «La actualización del dato la gobierna la plataforma a nivel de dominio (las
  ingestas y su calendario), transversal a los PIs — no se pacta en la spec de cada uno. Si el dato que
  ves está desactualizado respecto de lo cargado, eso es un incidente de operación y se revisa de
  inmediato. Si lo que hace falta es pactar cada cuánto llega fresco, eso se declara en el gobierno del
  PI y de sus fuentes, no en la spec.»
- **Redirige a:** el contrato del dato/dominio y la operación de ingesta, no el spec del PI. Lo que una
  spec declare sobre frescura se lee como expectativa informativa, nunca como cláusula exigible.
- **Borde (qué SÍ puede ser defecto):** el dato **visiblemente añejo** puede ser incidente de ingesta —
  operación, no spec. Con el cuidado del falso-añejo: «completed» ≠ «visible», el SQL endpoint lagea.
- **Casos aplicados:**
