# PENDINGS — detectados por el agente

Pendientes que **detectó el agente**, no encargó el humano. TTL 15 días desde `reg`: al vencer
pasan a `PENDINGS-done.md` §vencidas. Lo que César declare o confirme como pendiente vive en `TODO.md` (sin TTL);
la promoción PENDINGS→TODO se pide, no se toma.

## Operación / despliegue

- **Dos conjeturas del 0.15.0 SIGUEN sin verificar, y el deploy no las tocó** — de las cuatro que
  esperaban producción, el despliegue del 2026-08-11 saldó dos (#139·N2 siembra ✓, #151 reclasifica ✓)
  y **las otras dos no, porque no dependían del deploy sino de condiciones que PROD no tiene**:
  (a) **el eslabón `serve-rls → runSpec` con identidad del roster** (#145) — PROD no declara
  `MIRANDA_PREVIEW_IDENTITIES`, así que la preview impersonada contra motor vivo no se ejercitó;
  poblar el roster es decisión de instancia; (b) **la entrega HTTP real por un sink recargado**
  (#151) — el mecanismo está demostrado por test, pero la línea del fan-out en producción sigue
  siendo inspección, no medición. **Ninguna de las dos se vuelve verdadera por el hecho de que el
  deploy saliera bien.** `reg 2026-08-11`
- **`VERGIS_CSRF_SECRET` no definido en QA** — *actualizado 2026-08-10*: en **PROD ya está aplicado**
  (sesión de A.R.B.O.L. del 2026-08-10 tarde, KV `arbol-secrets/vergis-csrf-secret`, corte medido
  6.597 ms). En **QA sigue sin definir** — verificado hoy: `vergis.env` de QA no declara ninguno de
  `VERGIS_NOTIFY|PI_OWNERS|SOURCES|POLICIES` ni el CSRF. Consecuencia observable: `/contrato` reporta
  `watches: []` en QA, que **no es defecto** sino ausencia de archivos que vigilar.
  `reg 2026-08-06 · act 2026-08-10`
- **QA: 403 del service principal al observar 2 items del motor** (`ingest_finanzas_saldos`,
  `ingest_personas_asistencia`) — el lazo de frescura degrada como fue diseñado (registra y sigue),
  pero el entorno QA queda sin observabilidad real de esos procesos. Permisos del SP en el
  workspace de QA. No es regresión de 0.14.0. `reg 2026-08-06`

## Espera decisión de César

*(vacío — las decisiones del cluster 004 se resolvieron el 2026-08-08: 13 aprobadas, 1 diferida
a `TODO.md` (marca). Quedan diferidas POR DISEÑO con disparador propio, no esperando a César:
multi-tenancy (004/11 E5) y re-evaluación de licencia del kernel (004/11 E4).)*

## Código / CI

- **El frente de authz dejó cuatro cosas sin medir, y una de ellas decide si la capacidad sirve** —
  todas del cierre de #163/#159 (2026-08-13). Ninguna se puede medir sin terreno vivo:
  (a) **¿el Service Principal de serving tiene `UNMASK`?** Si NO lo tiene, la vista de máscara
  tampoco discrimina —su rama «en claro» lee la columna base y recibe el default del DDM— y la
  capacidad queda degradada a «esta columna no se sirve a nadie». Es seguro, pero no es lo que el
  issue pide. **Control obligatorio en la misma sesión**: una consulta a la tabla sin vista, o un
  negativo no distingue «no tiene el permiso» de «la vista no se aplicó». (b) que Fabric acepte el
  DDL de la vista y del `ADD MASKED` **sobre una tabla con vista-contrato `SCHEMABINDING`**.
  (c) el costo de enforcement por columna. (d) el bit `is_schema_bound` según el driver: se aceptan
  `1`/`true`/`'1'` y **cualquier otra cosa cae al cubo que no hereda** — fail-closed ruidoso, pero
  si un driver devolviera algo inesperado, vistas-contrato hoy servibles dejarían de serlo.
  `reg 2026-08-13`
- **Miranda deja de muestrear los objetos que NO estén en el policy store** — consecuencia del
  escudo de columna (#163·H9) y de su lectura estricta de «sin política ⇒ no se sondea». Es
  coherente con la doctrina del nodo (dato sin política no se sirve) y es fail-closed, **pero si el
  catálogo de Miranda de una instancia incluye tablas fuera del store, se nota de inmediato**: el
  `describe_table` nombra el esquema y devuelve muestra vacía. Reversible en una línea de
  `columnShield`. **No verificado contra el catálogo de la instancia de referencia.** `reg 2026-08-13`
- **Dos límites declarados del reconocimiento de la vista de máscara** — (a) si una instancia generó
  su DDL con `maskViewName` propio, la derivación por convención no la encuentra y el PI queda **no
  servible** (ruidoso, jamás en claro); la vía entonces es declararla en el store, no aflojar el
  reconocimiento. (b) la corroboración contra `sys` es una **foto del bootstrap**: un `ALTER VIEW`
  posterior no se detecta hasta el próximo `bootstrapAll`, y acá —a diferencia del linaje
  schemabound— nada ata la base. `reg 2026-08-13`
- **El veto de `run_probe` es por token, sin parser SQL** — sobre-bloquea: una columna protegida
  llamada `rut` veta probes que nombren el `rut` de OTRA tabla del `FROM`. Consciente y documentado;
  se anota porque el primer reporte de «Miranda no me deja consultar algo que sí puedo ver» va a
  venir de acá y conviene no diagnosticarlo desde cero. `reg 2026-08-13`

- **La medición de #164 contra Fabric NO se hizo, y sin ella los caminos 1 y 2 son conjetura** — la
  pregunta exacta es si Fabric/Azure SQL acepta un `ADD FILTER PREDICATE` cuya función **no recibe
  ninguna columna** de la tabla (y si no, si acepta un parámetro alimentado por constante). Se puede
  medir en el QA `vm-vergis-qa` contra `ws-arbol-qa`, **sin PROD**. **El control es obligatorio**: la
  forma actual (función con columna) tiene que pasar en el mismo terreno y la misma sesión, o un
  fallo de las variantes no distingue «Fabric no lo admite» de «el terreno estaba mal». Lo construido
  hoy (`schemaDependencies`) **mitiga y no resuelve**: vuelve legible la dependencia, no la quita.
  `reg 2026-08-13`
- **`MASKED WITH` × vistas-contrato `SCHEMABINDING`: interacción no medida** — es el gate que va antes
  del H2 de #163 (back-end Fabric del control por columna), junto con el costo de enforcement por
  columna. La instancia ya usa vistas `SCHEMABINDING`, así que la interacción no es hipotética. El
  issue lo declaró conjetura al abrirse y **lo sigue siendo**: nada de lo hecho hoy lo tocó.
  `reg 2026-08-13`
- **El render de gráficos: queda un residuo que ninguna capa detiene** — un exploit de Vega que haga
  E/S **sin pasar por su loader** (p. ej. vía una dependencia transitiva) atraviesa el gate
  declarativo y el loader que niega. Es justo lo que cubriría un subproceso, y el subproceso se
  descartó con medición (D-21): el permission model de Node 22 **no cubre la red**. El día que haya
  driver, la fs se cierra con el permission model y **la red se cierra en la red del contenedor**,
  no en Node. `reg 2026-08-13`

- **✅ RESUELTO (2026-08-13) — el aviso de incumplimiento del contrato `_logs/` ya aparece.** El lazo
  mide `corridasSinLog` por tick (con caché del listado compartida con el resolver, un solo listado
  por vuelta) y lo persiste en `intake_watch_state.corridas_sin_log`; la consola lo lee de la
  proyección. **La trampa que se evitó**: parecía que el conteo salía gratis de la fase RESOLVER, y
  es falso —`resolverSlot` hace `if (!pendientes.length) return`—, con lo que **el conteo se habría
  congelado justo en el slot incumplidor**, que resuelve todo como `sin-informe` y después no tiene
  pendientes. El aviso habría callado exactamente donde hace falta. Commit `870fa69`.
  **Dos límites declarados**: el conteo se congela si el listado falla tick tras tick (deliberado —
  *no medir no es medir cero*—, y la consola lo muestra bajo el banner `ultima-conocida`); y **satura
  en 10** porque el wiring pide 10 instancias al motor, así que el texto diría «las últimas 10»
  cuando podrían ser más. `reg 2026-08-13 · resuelto 2026-08-13`
- **✅ RESUELTO (2026-08-13) — hay umbrales de vigilancia por slot y opt-out.** Bloque `watch:`
  fail-closed en la config del slot: `false` (opt-out total, incluido el resolver) o
  `{max_age_minutes, max_run_minutes}`. Una declaración malformada **rompe el arranque nombrando el
  slot**, no se degrada en silencio a los defaults. Commits `b839c78` (parse) y `76b51de` (el lazo lo
  consume). **Lo delicado era el silencio al apagar**: al pasar a `watch: false` la clave se retira
  del estado de alertas **sin emitir «recuperado»** — no sanó, lo callaron, y un aviso de
  recuperación falso entrena a desconfiar de los verdaderos.
  **Gate de despliegue pendiente (C7)**: comprobar que ningún `slots.yaml` de instancia traiga hoy
  una clave `watch:` inerte que este parse empezaría a interpretar. Verificado que **este** repo no
  tiene ningún YAML con `slots:`; los de instancia viven en el repo del lab. `reg 2026-08-13 · resuelto 2026-08-13`
- **✅ RESUELTO PARCIAL, con la pérdida ACEPTADA y protegida (2026-08-13) — el control positivo en
  slots land-only.** La decisión de no correr el control **por-archivo** sin corridas **se ratificó**
  tras evaluar tres variantes de corte: todas fabrican alertas falsas o exigen un contrato externo
  nuevo. Lo que sí se agregó, porque no necesita corte: **control positivo sobre el DIRECTORIO** —
  `listOrAbsent` dice `absent` + ≥1 carga vivida ⇒ contradicción—, que cubre la lente rota tipo 404,
  o sea la ceguera exacta del incidente fundante. Commit `52272db`.
  **La pérdida residual —200-vacío sobre un directorio que sí existe, en land-only— queda ACEPTADA**,
  y protegida por un test cuyo nombre lo dice: *«CONTROL NEGATIVO QUE FIJA UNA DECISIÓN — land-only
  con 200-vacío sobre directorio EXISTENTE: NO contradice, y así debe quedar»*. Existe para que nadie
  la «arregle» sin volver a pensar el problema.
  **Gate de despliegue pendiente (C6)**: que drenar un landing real deje el directorio existente
  (`listOrAbsent` ⇒ `ok` vacío, no `absent`). Acotado desde el código —ningún camino de Vergis borra
  el directorio, solo hace `remove` del archivo—, pero la semántica de OneLake no se puede medir sin
  terreno. **Si un landing vaciado devuelve `absent`, este control se retira.** `reg 2026-08-13 · resuelto 2026-08-13`
- **Dos supuestos del frente #161/#162 sin verificar contra motor vivo** — (a) que un job que muere
  antes de arrancar aparezca como `Failed` en `jobs/instances`; (b) que la correlación carga↔corrida
  aguante el desfase de reloj del motor: **no lleva margen**, y con el reloj adelantado una corrida
  real podría quedar fuera y la carga terminaría marcada `varada`. Ambos son de la familia de los
  gates manuales del despliegue. `reg 2026-08-13`

- **✅ RESUELTO (2026-08-13) — los PRs de Renovate nacían con el CI en rojo: era la VERSIÓN DE npm.**
  Renovate regeneraba el lockfile con **npm 12.0.2**, que **poda las optional deps de otras
  plataformas**: 156 referencias `@esbuild/` contra las 234 de `main`, y `npm ci` abortaba.
  **Aislado con control limpio** —mismo árbol, mismo comando, misma imagen, misma plataforma, solo
  cambia el npm—: **10.9.8 ⇒ 234 · 12.0.2 ⇒ 156**.
  **Cura** (`d1cb166`): `constraints.npm` fijado a `^10.9.8`, más `allowedVersions: "<11"` como
  **candado** —Renovate tenía pendiente «update npm tool constraint to v12», que habría vuelto a
  romperlo todo—. **Verificado end-to-end**: la corrida `31719851935` instaló `npm 10.9.9`
  (`"command": "install-tool npm 10.9.9"`), regeneró `renovate/typescript-5.x` y su lockfile pasó de
  **156 → 234**; el **PR #177 nació VERDE** (`test` ✓ `review` ✓ `stability-days` ✓, MERGEABLE/CLEAN).
  **Por qué costó tres días, y es la lección que sobrevive al caso:** `constraints.npm: ">=10"` se
  dio por «refutado» dos veces **porque `>=10` PERMITE npm 12** — el constraint era correcto en
  intención y estaba mal expresado. Y **ninguna medición local reprodujo jamás el defecto**, porque
  todas se hicieron con el npm del repo (10.9.8): **el instrumento no cubría la variable que
  importaba**, así que cada experimento «demostraba» que el lockfile estaba bien. También murió así
  la afirmación del 2026-08-12 de que «no es que npm pode las optional deps» — se midió con un solo
  npm. **Un experimento que no varía la variable sospechosa no la exonera: la ignora.**
  El `postUpgradeTasks` que compensaba esto se **retiró** junto con su `RENOVATE_ALLOWED_COMMANDS`:
  corría de verdad (`Executed post-upgrade task`) pero era inútil, porque Renovate lo ejecutaba con
  el mismo npm 12 que causaba el defecto. Queda **verificado que la palanca funciona** en este
  montaje por si alguna vez hace falta. `reg 2026-08-11 · resuelto 2026-08-13`


- **✅ RESUELTO (2026-08-13) — el 403 al publicar commit status abortaba la corrida entera de
  Renovate, con el job en VERDE.** Cadena escrita por el propio Renovate en el mismo milisegundo:
  `POST /statuses/… = ERR_NON_2XX` → `Caught error setting branch status - aborting` → `Passing
  repository-changed error up` → `Repository has changed during renovation - aborting`. Efecto: de
  ~20 ramas candidatas escribía **una** y cortaba; **nunca alcanzaba una rama npm**.
  **Confirmado por intervención**: César agregó `Commit statuses: Read and write` al PAT, y la
  corrida `31719085575` dio **cero 403, cero abort y tres PRs** (#175, #176, #177). Beneficio
  colateral visible: el check `renovate/stability-days` ahora se publica («Updates have met minimum
  release age requirement») — el cooldown pasó de invisible a evidencia en cada PR.
  **Historial de esta ficha: se afirmó, se «corrigió» y se re-afirmó el mismo día.** La corrección
  intermedia era la inválida: declaró refutado el 403 contando ocurrencias **en logs con
  `LOG_LEVEL=info`, que no imprimen ese DEBUG** — el contador medía el nivel de log, no el fenómeno
  (403 en las 3 corridas `debug`, en ninguna de las 5 `info`, abort en las 8). **Un instrumento que
  no distingue «no ocurrió» de «no lo registré» fabrica refutaciones tan falsas como las
  afirmaciones que pretende arreglar.** `reg 2026-08-12 · resuelto 2026-08-13`


- **✅ RESUELTO (2026-08-13) — el pin de nuestra propia imagen se QUITA** (decisión de César).
  El pin entró con #174 y su churn estaba señalado en el cuerpo del PR antes de mergear:
  `deploy/compose.reference.yml` fijaba `ghcr.io/gegolabs/vergis:latest@sha256:…`, y **cada build de
  `main` publica un digest nuevo**, así que el bot trabajaba a perpetuidad sobre una imagen que este
  repo produce. Vuelve al tag móvil, que además es lo que un lector quiere copiar de una plantilla.
  **Quitar el digest NO basta y ahí está lo delicado**: `renovate.json` extiende `docker:pinDigests`,
  que **re-pinearía la imagen sola** en la corrida siguiente. Por eso va con su regla —
  `matchPackageNames: ghcr.io/gegolabs/vergis` con `pinDigests: false` + `enabled: false`.
  **El cooldown de supply chain no pierde nada**: su objeto son las dependencias de terceros
  (`caddy:2` sigue pineada). Aplicarle 14 días de espera a una imagen propia no protege de nada.
  **Sin verificar todavía** (no se puede sin una corrida): que la regla efectivamente gane sobre el
  preset. La evidencia será la primera corrida de Renovate que no abra ni reabra
  `renovate/ghcr.io-gegolabs-vergis-latest`. `renovate-config-validator` pasó, pero él mismo está
  documentado acá como verificador de FORMA, no de semántica. `reg 2026-08-12 · resuelto 2026-08-13`

- **La hipótesis de que `pin-dependencies` bloqueaba el tablero — REFUTADA por el merge** (2026-08-12).
  Se mergeó (#174) y la corrida siguiente (`31623564782`) **abortó igual**, ahora tras
  `renovate/ghcr.io-gegolabs-vergis-latest`. Esa rama no tenía nada de especial: **el abort ocurre
  tras escribir la primera rama, sea cual sea.** El merge sirvió: era el experimento que la refutaba.
  `reg 2026-08-12`


- **El `reportType` de Renovate NO sirve para detectar el abort** — medido el 2026-08-12 antes de
  colgarle un gate encima (corrida `31599885826`). El reporte se genera (45 KB) con shape
  `{problems: [], repositories: {"Gegolabs/vergis": {problems: [], branches: [], packageFiles: {…}}}}`:
  es un **inventario de dependencias**, no un resultado de corrida. En una corrida que **sí abortó**,
  el reporte no contiene `repository-changed` y `problems` viene vacío. **Un gate colgado de ahí
  habría dado verde siempre** — un control inerte con cara de control. Falta encontrar la vía real
  (candidata sin probar: `LOG_FILE` a `/tmp`, que el runner ve por el bind mount `/tmp:/tmp`, y
  grepear la frase del abort). `reg 2026-08-12`


- **Header del theme `default`: el título quedó como marca enlazada** (desviación declarada de #136 —
  ese theme no tiene logo). Es un elemento visible nuevo, no solo un wrapper; merece ojo humano.
  La instancia A.R.B.O.L. usa el theme `arbol`, así que no la afecta. `reg 2026-08-06`

## Práctica / entorno (fuera del árbol de Vergis)

- **✅ RESUELTO (2026-08-13) — `~/evals-finaliza/` es repo git local, sin remoto** (decisión de
  César: se aplicó la recomendación). `git init` + commit inicial `68b2785`: 12 archivos, 992
  líneas — la clave del espécimen, las 3 rondas anonimizadas, las 2 corridas en seco, los 2 juicios
  ciegos, el reporte de bug de autoidentificación y `RESULTADOS.md`.
  **Sin remoto a propósito**, y queda dicho: contienen salidas crudas de sesiones sobre proyectos
  reales; publicarlas arrastraría ese contenido sin aportar nada. El día que haga falta un remoto,
  que sea decisión tomada y no herencia del `git init`.
  **Lo que faltaba para cerrarlo de verdad no era el `git init`**: la corrida que detectó esto
  (`C.md` del espécimen) pedía **dejarlo dicho en el arnés**, para que la próxima no se lo vuelva a
  preguntar. Hecho en `protocolos`, `evals/finaliza/ARNES-v1.0.md` §7 (commit `3a834c5`), más un
  `README.md` en el repo nuevo que separa método (allá) de corridas (acá).
  `reg 2026-08-07 · resuelto 2026-08-13`
