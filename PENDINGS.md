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
- **La proyección guardada del contrato NO es estable justo tras el arranque** — medido en el deploy
  de 0.15.0 a PROD (2026-08-11 22:21). Dos lecturas del **mismo archivo y la misma única entrada**
  del journal dieron distinto: primero `watches: []`, `signals: []`, `projectionSha256 c61ab476…`;
  minutos después `watches: 4`, `signals: 1`, sha `8539f4db…`. **Importa porque N2 computa su delta
  diffeando proyecciones persistidas**: si el sha de un mismo arranque cambia, hay que saber cuál
  queda registrada — y una lectura temprana puede producir un delta fantasma en el deploy siguiente.
  **La causa NO está medida** (re-registro deliberado, escritura diferida, o una primera recarga que
  re-proyecta): es observación, no mecanismo. Casi se publica como «#151 no registra sus watches en
  producción», que era **falso**. `reg 2026-08-11`
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

- **El aviso de incumplimiento del contrato `_logs/` está implementado y NO APARECE NUNCA** — frente
  #161/#162, 2026-08-13. `avisoContratoLogs` está escrito y testeado en `admin-cargas.ts`, pero el
  campo que lo dispara (`corridasSinLog`) **no se llena**: correlacionar las corridas terminadas
  contra el listado de `_logs/` es lectura del almacenamiento, **prohibida en el request path** por
  doctrina del repo (la misma que declara `freshness-loop`: el render lee solo la proyección), y la
  proyección no guarda ese conteo. **Con el campo ausente la página no miente** —simplemente no
  muestra el aviso—, pero la parte «se hace exigible» del punto 1 de #162 no se cumple. Arreglo:
  que el lazo persista el conteo (columna o clave en `platform_setting`). `reg 2026-08-13`
- **No hay umbrales de vigilancia por slot ni opt-out** — el `watch:` declarativo de §4.1 del diseño
  `work/008` **no existe**: `IntakeSlot` no lo declara y su parse estaba asignado a un hito que no se
  ejecutó. Hoy rigen los defaults (120 min de edad, 60 de corrida colgada) para **todos** los slots.
  Un slot legítimamente lento producirá ruido y no hay cómo apagarlo salvo apagar el lazo entero.
  `reg 2026-08-13`
- **El control positivo se apaga en los slots sin corridas observadas** — decisión declarada del
  ejecutor de H4, que **contradice §3.3 del diseño** (que lo pide también en land-only). Sin corridas
  no hay corte —la última `Completed`— y toda carga histórica se «esperaría» para siempre, con lo que
  la primera drenada legítima fabricaría una contradicción falsa. La decisión es correcta; lo que
  queda es que **los slots land-only no tienen control positivo**. `reg 2026-08-13`
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


- **Pinear nuestra propia imagen creó una fuente permanente de churn** — consecuencia del merge de
  #174, y estaba señalada en su cuerpo antes de mergear. `deploy/compose.reference.yml` ahora fija
  `ghcr.io/gegolabs/vergis:latest@sha256:…`, así que **cada build de `main` publica un digest nuevo y
  Renovate abre/actualiza `renovate/ghcr.io-gegolabs-vergis-latest`**. Hoy esa rama encabeza la cola
  y es la que se lleva el único intento de escritura antes del abort. **No es la causa del abort**
  (el patrón es idéntico con cualquier rama), pero garantiza trabajo perpetuo del bot sobre una
  imagen que es nuestra. **Decidir:** si la referencia debe seguir el tag móvil, quitar ese pin;
  si debe quedar fija, ignorar ese paquete en `renovate.json`. `reg 2026-08-12`

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

- **`~/evals-finaliza/` no está bajo control de versiones** — ahí viven la clave, los 3 reportes
  del A/B, los 2 veredictos y el reporte de bug de esta sesión. Perderlos borraría la evidencia del
  experimento. Decidir: `git init` local (sin remoto basta) o declarar en el arnés que es scratch
  desechable. `reg 2026-08-07`
- **`dotclaude` con cambios sin sellar de otras sesiones** — *revisado el 2026-08-10 (diff SANO) y
  **encogido el 2026-08-11***: las sesiones dueñas ya sellaron lo suyo — `WATCH.md`/`WATCH-logs.md`
  están commiteados (con **la ocurrencia 8 de W-01** que registró esta sesión; el contador va en
  **12**, las 9-12 son de otras). **Quedan solo dos**: `settings.json` (hook `Stop` a
  `hooks/sync-cmux-title.sh` —el script existe, ejecutable, del 08-08— y la clave `model` reubicada
  sin cambiar de valor, que es el `/model` reescribiendo el archivo) y `commands/label.md` borrado.
  **NO se sellan a propósito**: no son de esta sesión, y commitear el estado parcial de otro actor
  es el fenómeno W-01 que el propio diff registra. `reg 2026-08-07 · act 2026-08-11`
