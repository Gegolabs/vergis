# Changelog — Vergis

Versionado del Producto (la imagen `ghcr.io/gegolabs/vergis`). La versión vigente se muestra en el
pie del inspector de cada PI (`Mira v<versión>`, de `package.json`). Esquema **X.Y**: Y sube con
cada conjunto de capacidades nuevas del DSL/runtime; X se reserva para el primer release estable.

## Qué significa cada tag de la imagen

Publicar es un **acto deliberado**: el tag de versión lo mueve un tag de git, no un merge a `main`.

| Tag | Qué es | Para quién |
|--|--|--|
| `0.16.0` | Una versión publicada. **No se reescribe** | Producción — es el pin recomendado |
| `0.16` | Flota al último patch de la serie 0.16 | Producción que quiere correcciones sin capacidades nuevas |
| `latest` | La **última versión publicada** | Lectura y desarrollo local. No para producción |
| `main` | El último commit de `main`. Cambia sin aviso y puede traer trabajo a medio verificar | QA que quiere probar antes de la release |
| `sha-<commit>` | Un commit exacto | Diagnóstico y reproducibilidad |

No se publica el tag `0` (major solo): pre-1.0 el eje de ruptura es la **Y** de este mismo esquema,
así que `:0` prometería una compatibilidad que nadie sostuvo.

**El despliegue es del operador de la instancia, no del Producto.** Acá se publica la versión y se
declara qué trae y qué exige; qué versión corre cada instancia, cuándo entra y bajo qué control de
cambio lo decide quien opera esa instancia.

## 0.16.0 — 2026-08-14

**El intake que se observa y la autorización que baja a la columna** — 70 commits sobre los issues
#161 #162 #163 #165 #159 #178, más dos CVEs y el frente de Renovate. Tests 1661 → 2095.

- **La plataforma observa sus propias cargas** (#161): un lazo de vigilancia clasifica cada slot y la
  consola dibuja el veredicto ya medido —jamás mide en el request path—. Lo que el requisito exige y
  la vista entrega es que el operador **distinga «no hay novedad» de «no pude medir»**: la calidad de
  la medida es un campo de primera clase (`fresca` · `ultima-conocida` · `contradice-registro` ·
  `ninguna`), un archivo que nadie tomó a tiempo se marca **VARADO** con su edad, y la vigilancia se
  declara por slot con un bloque `watch:` fail-closed (ausente = los defaults; `watch: false` es el
  opt-out total, con todas sus consecuencias escritas). Sin vigilante cableado, la consola renderiza
  exactamente la página anterior: regresión cero por construcción.
- **El fallo de una carga llega al usuario con su causa** (#162): desenlace por carga —`procesada`,
  `saltada`, `fallida`, `sin-informe`, `varada`— resuelto contra el log de la corrida que la cubrió,
  con el motivo textual que el job declaró (escapado y redactado: un log puede traer una cadena de
  conexión). Y el contrato `_logs/` que el error ya prometía queda **especificado** — con su aviso
  ruidoso cuando la instancia no lo cumple: sin log por corrida no hay causa por archivo, y el
  desenlace cae a «sin informe», que es la verdad y es cara.
- **Autorización por COLUMNA** (#163, nueve hitos): la política sabía esconder filas y el terreno
  ancho traía columnas que no se podían proteger. Ahora el compilador controla por columna, la vista
  de máscara es **servible** —el gate la reconoce corroborando en `sys`, no por el prefijo del
  nombre, que cualquiera con `CREATE VIEW` puede falsificar— y Miranda **nombra** la columna
  protegida en vez de sondearla. En ClickHouse la capacidad se declara **no soportada** y el PI no se
  sirve: ese back-end no controla la proyección, y fingir que sí sería servir dato sin protección.
- **El claim como conjunto** (#165): la doble pertenencia legítima —un sujeto que pertenece a dos
  zonas— negaba **en silencio**. La negación por cardinalidad del claim ahora se explica, y el
  rechazo de ClickHouse llega con el sitio donde ocurrió.
- **El mapa identidad→claims se administra desde la plataforma** (#159): deja de vivir en un archivo
  desplegado. Un cambio de claims era un despliegue; ahora es una escritura auditada.
- **La consola de Cargas navega por casilla** (#178): con más de un slot, una barra de pestañas —una
  por casilla, en el orden de `slots.yaml`— y **URL propia por casilla** (`?slot=<slotId>`), así que
  se le manda a alguien el link de la suya en vez de una instrucción de scroll. El rechazo ya no
  navega a Frescura: deja al usuario en su casilla y, cuando el archivo **sí** matchea el `accept`
  declarado de otra, el error la nombra y la enlaza. Sin candidato no se ofrece destino: cero
  heurística de parecido. Nace de un incidente medido —cinco cargas rechazadas en dos días, todas por
  el mismo motivo—, y con un solo slot la página es la de siempre.
- **Render**: el carril del rótulo de una serie lo decide la posición del punto, no el índice de la
  serie (#166); y el render de gráficos **no hace E/S** —ni de red ni de disco— por gate declarativo
  más un loader que niega. El subproceso para aislarlo se descartó **con medición**: el permission
  model de Node 22 no cubre la red.
- **Supply chain**: las dos CVEs de `ajv` y `yaml` corregidas a mano (#173); Renovate corriendo
  self-hosted con su cooldown de 14 días efectivo; y la política de tags de la imagen que encabeza
  este archivo, para que publicar sea un acto y no un efecto secundario de mergear.

**⚠ Notas de despliegue** — lo que el operador necesita para decidir:

- **La autorización por columna (#163/#165) está cerrada EN CÓDIGO y no se ha corrido contra un motor
  vivo.** Lo verificado es el SQL emitido y sus emuladores contra el oráculo. Cuatro preguntas siguen
  abiertas y la primera manda: si el Service Principal de serving **no** tiene `UNMASK`, la rama «en
  claro» de la vista de máscara recibe igual el default del DDM y la capacidad queda degradada a
  «esta columna no se sirve a nadie» — segura, pero no es lo pedido. **No apoyar una decisión de
  protección de datos en esta capacidad hasta medirla en el terreno de destino.**
- **#164 sigue abierto**: el andamiaje de RLS ancla su allow-all en una columna de datos, o sea que
  toma rehén al terreno. Está declarado y medido; no resuelto.
- **La vigilancia del intake (#161) no se enciende sola**: sin el lazo cableado en la instancia, la
  consola es la de antes. El aviso de incumplimiento del contrato `_logs/` exige que el convertidor
  de la instancia escriba su log al terminar (`docs/contrato-ingesta-logs.md`).
- **Recomendación de pin**: quien corra esto en producción debería referenciar `:0.16.0` (o su
  digest) en vez de `:latest`. Con la política de tags de esta versión, `:latest` ya significa «la
  última versión publicada» y no «el último merge» — pero un tag móvil en producción sigue
  significando que la próxima release entra en el siguiente recreate, sin decidirlo nadie.

## 0.15.0 — 2026-08-10

**El nodo que se explica a sí mismo** — 21 PRs (#140–#160) sobre los issues #107 #110 #111 #113
#138 #139. Tests 1409 → 1661.

- **Seguridad — el fix que cambia la postura**: cinco rutas de Miranda no verificaban dueño de
  sesión (#142). No eran las dos que el hallazgo original reportaba: además de `message` y
  `preview`, tampoco lo hacían `GET /miranda/s/:id` (transcript, intent, QC y draft completos),
  `validate-intent` y **`publish`** — cualquier identidad con scope podía publicar el draft ajeno
  como PI servido. Agravante: la lista SÍ filtraba por dueño, o sea que había **ilusión de
  privacidad** que la URL directa saltaba. Guard `dueño-o-admin` central en las cinco (404
  inexistente / 403 ajena; sesión legada sin `created_by` = solo-admin, fail-closed), con
  experimento de refutación: removido el guard, 10 tests caen. El gate del proxy pasa a
  comparación en **tiempo constante** (#160).
- **`GET /contrato` — el binario contesta «¿esto exige reiniciar?» y «¿tomaste mi archivo?»**
  (#139, N1 en #141 y N2 en #143). Derivado del estado, jamás declarado a mano: la misma llamada
  que instala un watch lo registra, y las claves de env se descubren corriendo `configFromEnv`
  sobre un Proxy que registra accesos —lo que además delata las presentes-y-jamás-consumidas—.
  `artifacts` compara sha256 de lo CARGADO contra lo que hay EN DISCO: distinto ⇒ `pending`.
  N2 agrega el **delta entre versiones** con journal por instancia, y `nowReloadable`/`nowBootOnly`
  como campos de primera clase: la reclasificación es el dato que invalida las reglas del operador.
- **Config recargable en caliente** (#138·2 fase 1, #151): `VERGIS_NOTIFY`, `VERGIS_PI_OWNERS` y
  `VERGIS_SOURCES` salen de la vía que exige recrear el proceso — watch por slice con
  validate-before-swap (un yaml roto conserva lo vigente y queda `ok:false` en el ring), `SIGHUP`
  recarga todo lo recargable, y la reclasificación `bootOnly→reloadableContent` aparece sola en
  `/contrato`. La respuesta del binario a «¿esto exige reiniciar?» cambió de «sí» a «no» para esos
  tres, y lo dice él mismo.
- **Publicación de definiciones de jobs en el motor** (#107 fase 2, #152–#158): autoría de items
  verificada contra el tenant real antes de construir, plantillas de job, publicación, superficie
  admin y wiring. La comparación es **canónica**, no byte-a-byte: el motor normaliza el payload
  (`""→null`, re-serialización) y compararlo crudo producía falsos negativos.
- **Miranda**: preview de RLS con **dos identidades de un roster declarado por instancia**
  (#145) — jamás impersonate libre, sin roster la superficie es cero, y cada render impersonado se
  audita con el actor real. Y se retira una promesa falsa: `MIRANDA_VALIDATE_CAPS` ofrecía
  `send-email`/`send-slack`, capabilities que no existen en el repo — Miranda validaba OK drafts
  que el serving rechazaba al registrarlos (#144).
- **Rendimiento del arranque en frío** (#140): medido que **no escala con N PIs** —
  `sourceStateOf` corre 1 vez por conexión, no por PI, y la evaluación por PI es pura en memoria.
  Lo único serial real eran las 2 queries de sistema por conexión; paralelizadas, 122,5 ms → 61,7 ms.
- **Gobernanza y supply chain**: ADR-002 fija el corte open-core antes de que lo fije el primer
  contribuidor externo (#146); catálogo de convenciones de plataforma sembrado en `rubric/` (#147);
  endurecimiento D8 de supply chain (#148), manifiesto de `packages/miranda` en el Dockerfile
  (#149) y fix de audit (#150). **Renovate pasa a correr self-hosted en el CI** (#160): el cooldown
  de 14 días del ADR-001 llevaba desde junio declarado pero inerte, porque instalar la GitHub App
  exige un acto humano que nunca ocurrió.

## 0.14.0 — 2026-08-06

**El barrido del backlog** — 15 frentes en una sesión (issues #61 #62 #63 #65 #66 #95 #99 #100 #101
#102 #105 #106 #107·f1 #108 #109 #114 #117; PRs #118–#134). Tests 1039 → 1409.

- **Observabilidad de ingestas completa**: log de cada corrida —fallida Y exitosa— desde el producto
  (#99, convención `_logs/run-<ts>.txt` en OneLake); proyección local `ingestion_run` — la vista de
  Frescura ya no toca el motor al abrirse, y con el motor caído sirve lo último conocido con
  staleness visible (#105); estado por proceso en la vista transversal de Fuentes (#101); avisos con
  destino declarativo (`VERGIS_NOTIFY`) y enlaces profundos (#100); reporte periódico por email
  **enviado siempre** — un día sin correo es señal de problema, no día tranquilo (#102, SMTP propio
  sin dependencias).
- **Intake transaccional**: registro de cargas en el GovernanceStore con pre-check de duplicado
  «¿Continuar?» y retro-indexado de `_processed/` (#62); «Revertir esta carga» de primera clase con
  plan sellado por hash y compensación por clave (#63); `options_ref` — catálogo de la instancia
  como fuente de opciones, dropdown con validación server-side (#109); metadata derivada del nombre
  del archivo por convención declarada (#95).
- **Gestión por rol, fase 1** (#107, issue abierto para la fase 2): fuentes/procesos/salidas
  gestionables in-app con precedencia sobre la semilla YAML (`managed_at` + tombstones), cadencia y
  pausa/reanudación desde Frescura.
- **Render**: chips de filtros activos visibles en el cuerpo del PI (#114); corte as-of «Datos
  al …» como convención de plataforma en el header — y «Generado» eliminado: dos renders del mismo
  dato son byte-idénticos (#108); export CSV con celda única cliente/delivery, anti formula-injection
  y fix de BIGINT con signo (#61); «Descargar PDF» server-side con sidecar WeasyPrint (#65).
- **Robustez y auth**: fail-closed ante la clave raíz ausente en los 8 YAML de instancia — «declara
  cero» (`clave: []`) sigue siendo legítimo; sin opt-out (#117); puerto `CredentialProvider`
  (secret/federated/imds) — el clientSecret deja de estar cableado en el código (#66).
- **Docs**: arquitectura multi-reporte y gobierno de permisos (#106).

**⚠ Notas de despliegue**: (a) #117 — verificar los YAML de la instancia antes de subir: un archivo
decapitado ya no arranca; (b) los modos passwordless de #66 no se activan sin sus gates manuales;
(c) gates manuales pendientes contra motor/canales vivos: contrato escritor de `_logs/` (#99),
rate limits del poll (#105), Slack (#100), relay SMTP (#102), sidecar PDF (#65), pausa real (#107),
contrato D8 del convertidor (#63).

## 0.13.0 — 2026-07-28

**La capa de notas — impresiones, anotaciones y comentarios** (vergis#84, cierra #60). Lo que una
persona dice sobre lo que ve tiene por fin dónde vivir. Doc:
[`docs/capa-de-notas.md`](docs/capa-de-notas.md).

- **Dos especies, no una.** El **comentario** se ancla a un REGISTRO gobernado (entidad + llave de
  negocio) y es el mismo se mire desde el PI que se mire; la **anotación** se ancla a una
  **impresión**: lo que viste, congelado tal como lo viste (filas, forma, recorte, watermark,
  versión del spec, autoría). Confundirlas produce un sistema que no sirve para ninguna.
- **El gate del comentario se verifica contra el DATO, al escribir** — el server re-ejecuta la
  recuperación del dataset bajo la identidad del autor y exige que la llave esté en el resultado. Un
  token firmado verificaría lo que el server dijo antes; una autorización revocada seguiría
  escribiendo. La lectura del hilo es igual de fail-closed.
- **`anchor` en el DSL** — el dataset declara `{ entity, key[], display? }`: identidad de negocio,
  jamás autorización (el spec sigue authz-blind). **Sin `anchor` el gesto no se ofrece** (404).
- **Impresión perezosa** — la primera anotación hace nacer la impresión sola; dentro de la sesión de
  trabajo (12 h) las notas del mismo sustrato comparten impresión. Se ve read-only y sin drills: es
  un documento, no una vista.
- **Compartición gobernada** — solo el dueño, auditada, revocable **hacia adelante**: el receptor
  pierde el acceso y sus notas persisten. El registro ES la fuente de «Compartidas conmigo».
- **«Mis impresiones»** en el menú del avatar — una capacidad que no se ve, no existe.
- **El motor jamás lee una nota**: el enriquecimiento corre tras componer, sobre el resultado ya
  cerrado; si falla, el PI se sirve idéntico. Las notas no viajan en el export CSV.
- **Envs nuevos** — `VERGIS_NOTES_DB` (default `<VERGIS_OUT>/notas.sqlite`), `VERGIS_CSRF_SECRET`.
  **Retirados** (se ignoran con aviso, sin imprimir su valor): `VERGIS_ANNOTATION_SECRET`,
  `VERGIS_ANNOTATIONS_DB`, `VERGIS_ANNOTATIONS_URL`.
- **Settings de plataforma** — retención de impresiones `P12M` (**se aplica**: purga al arranque y
  cada 24 h, medida desde la última actividad), envíos programados por usuario `10` y
  anti-cementerio `on` (declarados; se aplican cuando los envíos programados existan).
- **Retirado el esquema anterior de anotaciones** — la columna editable y los tokens HMAC por fila
  visible en cada render (≈850 firmas por carga, sosteniendo cero anotaciones) desaparecen junto con
  su store, sus rutas y su secreto. Sin migración: estaba vacío.

## 0.12.0 — 2026-07-15

**`VERGIS_DEV_IDENTITY` — identidad de desarrollo inyectable (fail-safe)** (work/087). En un despliegue
de dev **sin gate** (sin oauth2-proxy) ninguna request trae `x-forwarded-*` → identidad vacía → 403 en
toda superficie con scope, imposible de manejar desde el navegador. Este env inyecta una identidad fija
para **manejar Mira y los PIs desde el browser local** sin forjar headers por curl. Formato: `email` o
`email:grupo1,grupo2` (los grupos pueblan el claim `groups`). Doc:
[`docs/gobierno-permisos.md`](docs/gobierno-permisos.md) §«Identidad de desarrollo».

- **Seguridad (requisito #1): imposible de activar donde hay gate real.** La activación es
  `seteado ∧ ¬gate-real`; la señal de gate real es la presencia de `VERGIS_GATE_SECRET`. Con gate real
  presente el env **se ignora** (nunca inyecta) y se emite un warning al arranque — config contradictoria
  prioriza seguridad. Sin el env, comportamiento **idéntico a hoy** (test de regresión). La decisión vive
  en una función pura y testeada (`decideDevIdentity`); el header de gate, cuando existe, **siempre gana**.
- **Los tres caminos** — sin gate + env → una request sin header toma la identidad del env; con header de
  gate → el header manda (se preserva el 403/otras identidades por curl); sin env → sin cambio alguno.
- **Defensa en profundidad** — con `VERGIS_GATE_SECRET` definido, el gate A10 rechaza (403) toda request
  sin `x-gate-token` antes de resolver identidad, además de que el env queda inerte.

## 0.11.0 — 2026-07-14

**Miranda — agente conversacional que autora specs de PI** (cluster 077, Fase 1). Capacidad nueva del
Producto (`@vergis/miranda` + superficie `server/miranda.ts`): un especificador crea un PI nuevo
end-to-end conversando, sin tocar YAML — Miranda elicita → compila DSL → se auto-chequea (QC①
interiorizado, juez ≠ autor) → previsualiza con RLS real → publica. Doc:
[`docs/miranda.md`](docs/miranda.md).

- **Todo detrás del feature flag `MIRANDA_ENABLED` (default off)** — con el flag apagado, cero
  superficie nueva (ni rutas, ni nav, ni dependencias activas; `GET /miranda` = 404 idéntico a hoy).
- **Envs nuevos** — `MIRANDA_ENABLED`, `MIRANDA_MODEL` (default `claude-sonnet-5`),
  `ANTHROPIC_API_KEY`, `MIRANDA_RUBRIC_DIR` (monta `dsl.md`/`qc1.md`), `MIRANDA_CATALOG` (allowlist de
  probes), `MIRANDA_MAX_TURNS` (40), `MIRANDA_TOKEN_BUDGET` (500k/sesión), `MIRANDA_SCOPE_GROUP`
  (`miranda`), `MIRANDA_ANNOUNCE_WEBHOOK`. Scope `miranda` (403 sin él); autorización de la capacidad
  independiente de la RLS del dato (preview y serving pasan por el mismo `serve-rls`).
- **Sesiones en el governance store** — `miranda_session`/`miranda_message`/`miranda_artifact`
  (append-only, versión por artefacto) + `miranda_seq` (semilla **PI-101**). La sesión es el ledger
  de procedencia del PI, exportable a git.
- **`forma` por vista en el resumen de intención** (ajuste post-diseño, hallazgo PI-17/F-01) — el
  resumen que el usuario valida lleva `vistas[]` (`{nombre, forma: tabla|dashboard|mixta, piezas:
  [tarjetas|graficos|tabla]}`), haciendo la intención visual validable sin leer el DSL. El self-check
  cruza la forma declarada contra las piezas reales del draft (KPI/dato→tarjetas, chart/series/
  distribution→graficos, table→tabla): divergencia = brecha M. Enforcement en código
  (`crossCheckForma`), no solo prompt.
- **Gates en código** (no solo prompt): publish solo desde `autochequeado`, sin brechas B/M, con draft
  que valida contra el DSL; probes SQL por guardia (solo SELECT, TOP 500, allowlist de catálogo);
  authz-blind; secretos jamás en logs/transcripts.

## 0.10.0 — 2026-07-14

**Trío de primitivas del catálogo DSL** (work/081) — tres elementos de pieza nuevos con demanda real,
100 % aditivos (los specs existentes renderizan idéntico). Doc:
[`docs/catalogo-elementos.md`](docs/catalogo-elementos.md).

- **`dato`** (#71) — atributo rotulado (etiqueta + valor). Es contenido/estado, no una medida:
  tipografía de texto (distinto del `kpi`), se imprime tal cual y **jamás es interactivo**. El valor
  se resuelve por el mismo path que `kpi.metric`; `format: date` recorta ISO/`Date` a `YYYY-MM-DD`
  (reusa el helper de 0.9.0). Origen TX-12.
- **`distribution` multi-métrica** (#70) — `metrics` (2+ series) reemplaza a `metric` (singular) para
  **barras agrupadas**. El singular queda intacto; declarar ambos es error. `fold` + `color` por serie
  + `xOffset`/`yOffset`. La cota top-N ordena categorías por la suma de las series y colapsa «(otros)»
  sumando **cada serie por separado** (el total por serie cuadra). Origen TX-13.
- **`series`** (#69) — líneas de 1..N series sobre un eje. Formato wide + `fold`; `mark: line` con
  puntos. El eje x es ordinal en el **orden de llegada de las filas** (el SQL manda; no se re-ordena
  alfabético). Desviación vs doc §4.1: `time_field`/`granularity`/`range` NO se implementan — el eje
  lo modela la query (Gold-in-query), `x` reemplaza a `time_field`. Origen PI-17.
- **Themes** — token `chartSeries` (paleta categórica) en `default` y `arbol`, con fallback en
  render-chart. Charts multi-serie ciclan la paleta.
- **`narrative` / `alert` / `comparison`** — *diseñados, no construidos*: narrative lo definirá
  Miranda; alert requiere subsistema de delivery (su rol visual lo cubre `semaforo`); comparison simple
  ya lo cubre `kpi.comparison`. Ver `docs/catalogo-elementos.md` §4.

## 0.9.1 — 2026-07-14

- **Fix: etiqueta de display con `Date` del driver** — el driver mssql/tedious devuelve las columnas
  datetime como **objetos `Date` de JS**; `String(dateObj)` produce la forma larga («Tue May 26 2026
  00:00:00 GMT+0000 …») que esquivaba el recorte ISO→`YYYY-MM-DD` (visto en el sello-fecha de PI-07
  vivo). La normalización de etiquetas (`trimIsoLabel`/`buildControlOptions`) ahora trata
  `value instanceof Date` → `toISOString().slice(0, 10)` — aplica a las opciones del sello Y al span
  print de cualquier control cuyo `display` sea datetime.

## 0.9.0 — 2026-07-14

**Selectores de alcance por llave alternativa** (work/079) — extensión aditiva del sello de alcance de
0.8.0: un mismo alcance puede elegirse por **más de una llave**. Cada entrada de `controls:` gana dos
roles opcionales; sin ellos, el comportamiento es **idéntico a 0.8.0** (cero cambio a specs,
`serve-rls`, `applyCtx` ni a la semántica de URL). Doc:
[`docs/superficie-de-estado.md` §7](docs/superficie-de-estado.md).

- **`param`** (default = `id`) — a qué `ctx.<param>` escribe el control. Dos controles con el mismo
  `param` son **llaves alternativas** del mismo alcance: eligen por campos distintos, fijan el mismo
  `ctx.<param>` y la banda pinta **ambos sellos sincronizados** (elegir la fecha equivale a elegir su
  OC). URL intacta (`?ctx.<param>=…`).
- **`display`** (default = el campo de `source`) — qué campo del MISMO dataset se muestra como etiqueta.
  Las opciones se resuelven como pares `{value, label}` fila a fila (mapeo 1:1). Datetime ISO en la
  etiqueta → recortado a `YYYY-MM-DD`; colisión de etiqueta entre values distintos → desambiguada con
  `label (value)`.
- **Resolución y validación** — el **dueño** del `param` (1er control que lo declara) aplica el
  `default`; los demás heredan el valor vigente. Params compartidos exigen **mismo dataset** y `single`
  (rechazo con error claro si no); `display` colgante se rechaza como el `source` colgante.
- **(ii) cascada `narrows:`** — *diseñada, no construida*: el diseño de un control que acota las opciones
  de otro queda documentado en §7·2 sobre la misma base de opciones-como-pares.

## 0.8.0 — 2026-07-14

**Superficie de estado** (TX-11) — convención de plataforma: *cara = estado · gaveta = maquinaria ·
print = estado como texto*. Cambio de comportamiento visible en todos los PI, 100 % de superficie
(cero cambio al DSL, a los specs, al camino de datos ni a la semántica de URL — los links `?ctx.*`
compartidos siguen idénticos). Doc: [`docs/superficie-de-estado.md`](docs/superficie-de-estado.md).

- **El sello de alcance es clickeable** — la banda de contexto (`vctxbar`) deja de ser solo-lectura y
  se vuelve EL selector: un control single es un `<select>` nativo estilizado como sello; uno multi,
  un `<details>` con los checkboxes. Una cosa, un lugar: el control sale de la gaveta. En print, el
  sello degrada a texto plano.
- **Chips de filtro imprimibles como letra chica** — los filtros activos aparecen como chip removible
  en la cara solo al aplicarse, y en print se imprimen como texto discreto («Filtros: …»), ocultando
  solo la acción (la ✕). Agrupar-por no imprime chips. La maquinaria (pickers, búsqueda, agrupar,
  export, config) jamás se imprime.
- **Afordancias proporcionales y atribuibles** — una tabla que rinde 1 fila (single_row) es display
  puro: sin runtime, sin iconos de filtro, sin kit. El kit de afordancias (buscar · agrupar ·
  descargar · limpiar) es ÚNICO en el Inspector, con selector de objetivo solo si hay ≥2 tablas
  interactivas (jamás kits apilados). El contador de filas sale del kit y pasa a pie discreto de cada
  tabla en la cara (se imprime).

## 0.7.0 — 2026-07-13

- **Descargar CSV de la vista actual** (#61) — botón en la gaveta de tabla: exporta la vista
  (filtros/búsqueda/facetas aplicados), columnas visibles sin anotaciones, separador `;`
  (Excel es-CL) y BOM UTF-8. Decisión de instancia: CSV es la resolución del export (xlsx
  descartado; PDF server-side es #65).
- **Dedup de carga por contenido** (#62) — SHA-256 al subir vs historial del slot (el nombre no
  participa): idéntico → aviso sin bloquear + tag «contenido idéntico a X» en Actividad; el hash
  queda en el audit event. Badge **«sin cambios en el dato»** cuando el log de la corrida trae el
  marcador `[delta] sin cambios en el dato` (la emisión es del pipeline de la instancia).
- **«Revertir esta carga»** (#63, fase 1) — acción por archivo del histórico `_processed/<clave>/`
  (el layout es el ledger carga→clave): revertido → `_retirado/`; con versión previa de la clave,
  se reactiva y re-corre (last-wins restaura el estado anterior); sin versión previa, aviso honesto
  de dato sin origen (compensación del pipeline = fase 2). Auditado `intake-revert`.

## 0.6.1 — 2026-07-13

- **fix(render): los controles del Inspector navegan de nuevo** — el `onchange` generado usaba
  `new URL(…)`, que dentro de un handler inline resuelve contra `document.URL` (un string que
  sombrea al constructor) y lanzaba `TypeError` en todo browser real: el selector single/multi
  jamás navegó por clic (la URL directa `?ctx.*` sí funcionaba, por eso los probes no lo vieron).
  Ahora `new window.URL(…)` + test de regresión que ejecuta el handler bajo el scoping real de
  inline (`with(document)`), no solo su sintaxis. Reportado por la instancia GH (PI-01/PI-07).

## 0.6.0 — 2026-07-13

- **`oferta: evento`** — fuentes EVENT-DRIVEN de primera clase (la mejora que la instancia GH
  documentaba como pendiente): una fuente sin cadencia (cada llegada es un evento, p. ej. una OC
  por archivo) se declara honestamente sin fabricar una periodicidad. No impone piso a la demanda,
  el reconciliador no la agenda, su entidad aparece en Frescura con corridas y salud de falla, y el
  monitor alerta conversiones fallidas. Habilita registrar el proceso de PI-07 y cerrar su hueco de
  observabilidad (#56) sin datos inventados.

## 0.5.0 — 2026-07-13

La operación de cargas se vuelve una superficie de primera clase (issues #55–#58, todos
nacidos de la operación real de la instancia GH ese mismo día).

- **Consola de Cargas por dominio** (#58, `/admin/dominio/<id>/cargas`): línea de tiempo
  que correlaciona cargas de archivos (quién/cuándo/tamaño, del audit) con corridas de
  conversión (estado/duración/motivo); landing y archivo histórico (`_processed/`)
  navegables; **re-run** de la conversión, **retiro** de un archivo del landing (a
  `_retirado/`, reversible) y **reactivación** desde el histórico — el ciclo completo de
  rollback honesto para pipelines por-clave. Todas las acciones con CSRF + steward + audit.
- **Log de la última conversión visible** (#55): en Frescura y en la consola; el slot
  declara la ruta (`log`, default `Files/code/_ingest_log.txt`); lectura OneLake tolerante.
- **Coherencia declarativa** (#56): un slot cuyo trigger no está registrado como proceso
  en Fuentes se acusa ruidosamente (Frescura + consola) — era el hueco silencioso que dejó
  al slot de PI-07 sin observabilidad.
- **Residuos en el landing** (#57): archivos anteriores a la última corrida completada se
  marcan «se re-procesará», con retiro a un clic — la causa raíz del duplicado de datos
  del incidente PI-07.
- Capabilities: `OneLakeReader` gana `list`/`copy`/`remove`/`readBytes` (DFS).

## 0.4.0 — 2026-07-13

Cierre de los issues #50–#54 (todos reportados desde la instancia GH en beta): robustez
operacional del serving push-down y del gobierno de dominio.

**Serving (engine=fabric):**
- **Fail-closed por PI, no por proceso** (#52): la verificación de RLS nativa es por PI y
  consulta solo las conexiones en uso; un PI que no verifica responde `503` con motivo
  accionable y los demás siguen sirviendo. Indeterminación (conexión caída) conserva el
  veredicto sano previo; un veredicto definitivo siempre bloquea. `/healthz` distingue
  `starting`/`degraded`/`serving` con conteos `{total, serving}` (sin slugs: sigue reducido).
- **Herencia de gobierno vista→base** (#54): una vista-contrato `WITH SCHEMABINDING` sobre
  bases gobernadas sirve sin entrada propia en el policy store ni secpol duplicada; el
  linaje se resuelve en la fuente (certeza o nada, transitivo, fail-closed) y la herencia
  queda en el log del gate. La visibilidad del índice hereda igual.

**Gobierno de dominio:**
- **Hot-reload de conexiones, dominios e intake** (#50): `VERGIS_CONNECTIONS` acepta ruta a
  archivo (preferido: secretos fuera de `/proc`/`docker inspect`) además de JSON inline;
  los tres archivos recargan con validate-before-swap por archivo (uno malformado conserva
  su estado vigente). El alta completa de un dominio ya no exige restart.

**UX / correctness:**
- **Motivo de falla del job disparado visible** (#53): la celda «Última corrida» de Frescura
  y los slots de «Otras cargas» muestran el `failureReason` de Fabric (escapado, recortado) —
  quien carga un archivo ya no reintenta a ciegas.
- **`format: int_0` sobre strings numéricos** (#51): los `SUM(BIGINT)` que el driver entrega
  como string se formatean igual que los números; enteros sobre `MAX_SAFE_INTEGER` se agrupan
  sobre el string sin perder dígitos. Aplica a servidor y cliente (formateador único).

## 0.3.0 — 2026-07-07

Cuarta ronda de revisión (cluster `work/001`): hardening de seguridad, robustez y
divergencias de policy. Sin capacidades nuevas del DSL; el bump de Y refleja el
conjunto de correcciones de runtime/seguridad de las olas 1–3.

**Seguridad:**
- **`escapeHtml` escapa la comilla simple** — cierra la inyección JS en handlers inline y el escape del catálogo desde un solo lugar.
- **Gate de gobernanza del policy store**: se rechaza el `dataset` duplicado (el last-wins podía pisar la RLS) y las divergencias de backend (`COLLATE` binario en Fabric, guard de cardinalidad en `op: eq`, `CREATE ROW POLICY OR REPLACE`).
- **Intake**: nombre de archivo endurecido (sin traversal ni caracteres que rompan el path DFS) y codificación por segmento.
- **CSV**: neutralización de formula injection. **`.env`** fuera del build context; **8080** en loopback.

**Robustez:**
- **Escritura atómica** del store de gobierno (tmp+rename); **evict** de pools mssql envenenados; **timeouts** en todo fetch de red.
- **`expectString`** en la frontera de render (cierra el 200-en-blanco); **contrato insert/update** de master-data DWH; **`setDemanda`** validado con el parser real.
- **Validación DSL** de `agg.dataset`/`table.data` pelados (un typo ya no muestra 0 en silencio).

**Operación / CI:** `HEALTHCHECK` + rotación de logs + `mem_limit` en compose; permisos mínimos por job + `concurrency` en CI; pin de Actions/imagen por digest (Renovate); `engines: node>=22`.

## 0.2.2 — 2026-06-11

Hardening de runtime y de supply chain (sin capacidades nuevas del DSL). Ver
`docs/adr-001-lenguaje-y-supply-chain.md` y `docs/mejoras-diagnostico.md`.

**Supply chain:**
- **Lifecycle scripts bloqueados** (`.npmrc` con `ignore-scripts`) — ningún paquete ejecuta código al instalar.
- **vega 6 / vega-lite 6** — cierra dos HIGH (XSS, GHSA-7f2v-3qq3-vvjf y GHSA-m9rg-mr6g-75gm). `npm audit`: 0 vulnerabilidades.
- **Cooldown de updates** (Renovate, `minimumReleaseAge` 14 días; las alertas de vulnerabilidad lo saltan).
- **CI**: gate de `npm audit --omit=dev`, verificación del build, SBOM + provenance en la imagen.
- **Imagen multi-stage**: el server corre precompilado (`node dist/serve-rls.mjs`, sin tsx), con deps
  solo de producción, sin scripts y como usuario no-root.

**Runtime:**
- **Timeout por capability-call** (configurable, default 120 s) — una Capability colgada ya no cuelga la invocación.
- **Contrato de salida validado en la frontera**: una Capability de datos que no devuelve `{ rows: [...] }`
  falla ruidoso y accionable (`capability-output-invalid`), no críptico aguas abajo.
- **Límite de profundidad** en la composición de pieza (guard contra specs patológicas).
- **`mira-ctx-missing` en el log** cuando una query referencia `:ctx.<param>` sin valor (se bindea `''`, que acota igual).

## 0.2.1 — 2026-06-04

- **Versión del PI distinta de la de Mira.** El inspector muestra, por separado, la versión del **PI**
  (instancia, de `identity.version`, p.ej. `PI-01 · v1.1`) y la versión de **Mira** (motor, este
  `package.json`). Dos pistas de versión independientes: el motor evoluciona aparte de cada reporte.

## 0.2.0 — 2026-06-04

Primera versión con seguimiento explícito. Es lo **publicado y vivo** hoy (PI-01/04/12 en la VM).

**Nuevas capacidades del DSL (genéricas, por configuración):**
- **Controles de cabecera (`controls`):** selector single-select server-side que fija `:ctx.<id>` en
  las queries (cambia el dato, no solo la vista), con **default computado** (`max`=más reciente / `min`
  / `first`). El valor se preserva al navegar/drillear.
- **Multi-drill + clave compuesta:** `drillthrough` acepta objeto o arreglo; `by` acepta una clave o
  varias (p.ej. empresa+socio). Columna de acciones con N links etiquetados; con un solo drill se
  conserva el doble-clic de fila. El contexto se bindea (injection-safe) y **acota, nunca amplía**.

**Lineamiento de construcción:**
- Los **controles viven en el inspector** (gaveta, tab Controles), nunca en el cuerpo del reporte.

## 0.1.0 — línea base (walking skeleton)

Servidor RLS multi-PI por consumidor (motores ClickHouse / Fabric push-down, data-anchored,
default-deny), multi-vista + drill-through simple, tablas interactivas (orden/filtro/búsqueda/
agrupación/vistas guardadas), facetas de dashboard, anotaciones gateadas por HMAC, themes pluggables.
