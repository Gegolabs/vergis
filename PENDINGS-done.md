# PENDINGS-done — derivado frío de `PENDINGS.md`

Partidas detectadas por el agente que ya cerraron, con la evidencia del cierre. Las que vencieron
su TTL de 15 días **sin veredicto** viven en la sección «Vencidas sin veredicto» — vencer no es
cerrar.

## Cerradas con veredicto

### Cerrada por el frente arbol — 2026-08-26 · el gate no iba donde la ficha decía

- **El extractor de fase del rollout se llama SIN el gate de status en el camino de diagnóstico** —
  `phase_of()` (`deploy/rollout/vergis-rollout:206`) saca la fase del cuerpo con un `sed`. El
  **veredicto** está protegido: `serving_ok` exige `200` antes de mirarla. El **`warn` del smoke**
  (`:402`) no: llama a `phase_of` sobre el cuerpo de un fallo, así que cualquier cuerpo de error que
  contenga el literal imprime una fase falsa **justo cuando alguien está diagnosticando**.
  **La ocurrencia concreta ya se cortó en la fuente** el 2026-08-26 —`deploy/edge/espera.html`, que es
  el cuerpo del 503 del borde, llevaba el literal en un comentario; medido con el extractor real y su
  control positivo—. Queda el **defecto de forma**: el lector sigue sin gate, así que el próximo
  cuerpo de error que traiga el literal reabre lo mismo. Cortar en la fuente fue lo correcto (los
  lectores se multiplican, la fuente es una), pero no es lo mismo que arreglar al lector.
  **No se tocó**, y la razón es de custodia, no de criterio: `deploy/rollout/` es del frente **arbol**
  y lo está editando ahora mismo. Avisado por mensaje directo el 2026-08-26. `reg 2026-08-26`
  **✅ CERRADA 2026-08-26 (PR #259, `aacea73`) — y el arreglo CORRIGE ESTA FICHA, que tenía el síntoma
  bien y la causa a medias.**
  Esta ficha pedía «ponerle el gate al lector». **Eso habría estado mal**, y el frente arbol lo vio: la
  fase `starting` se sirve con **HTTP 503** (`server/routes.ts`), así que gatear `phase_of()` por 200
  habría dejado **ciego a quien espera un arranque**. El gate no iba donde esta ficha señalaba.
  **La salida correcta fue un lector aparte**: `phase_reportada()` exige el 200 **en el camino de
  diagnóstico** y dice `sin-fase(http-503)` cuando no lo hubo; `phase_of()` queda intacto donde un
  no-200 es legítimo. **Son dos lectores porque son dos preguntas** — y esa distinción no está en esta
  ficha, la puso quien la atendió.
  **Control negativo, y vive en la suite** (no en una corrida que haya que recordar): con el cuerpo
  envenenado, el lector sin gate sigue diciendo `serving` y el gateado no. Verificado por esta casa
  quitándole el gate al lector: cae **exactamente** el test que sostiene la promesa, y ninguno más.
  **Lo que queda dicho para el próximo que lea:** cortar en la fuente (`espera.html`) fue correcto, y
  **no** era suficiente ni tampoco lo era «ponerle el gate al lector». Lo suficiente fue separar las
  dos preguntas. Declarado en «Sin publicar» porque `vergis-rollout` viaja al operador.

### Refutaciones — 2026-08-26 · hipótesis medidas y descartadas, que no eran pendientes

> Las dos tienen **veredicto**: una hipótesis refutada y un instrumento medido como inservible para
> la pregunta que se le hacía. Vivían en el archivo caliente con TTL corriendo, y de haber vencido
> habrían caído en «Vencidas **sin** veredicto» — que es justo lo contrario de lo que son. Su valor
> es impedir que alguien reintente el camino, y ese valor no caduca.

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

### Egreso de higiene — 2026-08-26 · fichas cerradas que se habían quedado en el archivo caliente

> Estaban **cerradas con su veredicto escrito** y nunca egresaron: 11 de 34 fichas de `PENDINGS.md`
> —casi un tercio— eran peso muerto. No es cosmética: un archivo caliente donde una de cada tres
> fichas ya está muerta le cobra a cada pasada de vigencia el costo de re-leerlas, y entrena a
> hojear. Se mueven **con su texto íntegro**, sin re-redactar el veredicto de nadie.
>
> **Tres cerradas se quedaron a propósito** y conviene decir cuáles, porque el criterio importa: las
> que declaran una mitad viva —«queda sin medir hasta la primera corrida con la ventana abierta»
> (el arnés P9 y el centinela P10) y el «RESUELTO PARCIAL» con su gate C6 pendiente—. Una ficha con
> mitad viva no egresa: eso sería cerrar por la mitad que sí se hizo.

- **✅ RESUELTO (2026-08-19) — los dos compose juzgan por la FASE, y el instrumento demostró que sabe
  reprobar.** La ficha decía que el `healthcheck` de `docker-compose.yml` juzgaba por `r.ok` y que desde
  0.20.0 eso daba «sano» a un nodo en `standby` (que responde HTTP 200 con `ok:true` por diseño). Ahora
  el predicado es el canónico —el mismo del borde y de `rollout/vergis-rollout` (`serving_ok`)—:
  **`HTTP 200 ∧ "phase":"serving" ∧ (sin bloque pis ∨ pis.serving == pis.total)`**, con el cuerpo
  **parseado** y no grepeado, y con todo lo no medible (vacío, no-JSON, conexión rechazada) contando
  como fallo. El `pis` se exige **solo si viene**: `/healthz` lo omite cuando el motor no tiene
  servibilidad por PI (`VERGIS_ENGINE` ≠ `fabric`), y exigirlo incondicionalmente habría dejado el modo
  Free en `unhealthy` perpetuo — ese detalle era el que decidía el diseño.
  **También se le agregó healthcheck al servicio `vergis` de `deploy/compose.reference.yml`**, que no
  tenía ninguno, porque el modo un-solo-nodo está documentado como válido en ese archivo y ahí un
  `docker ps` que dice `healthy` sobre un standby es la mentira más cara en un incidente. Va con el
  comentario que desarma las dos malas lecturas: es **diagnóstico, no ruteo** (quien rutea es el
  conmutador del borde), y **no viaja a los anillos** — `rollout/ring.args` no lleva healthcheck, y no
  le hace falta porque la salud de un anillo la mide el borde, el único que puede actuar sobre ella.
  El healthcheck del borde `caddy` **se deja intacto**: es un proxy sin fases y su comentario ya explica
  por qué juzga por HTTP.
  **Verificado con arnés propio** (`spawn` asíncrono + servidor de mentira; el comando se **extrae** del
  YAML, no se copia a mano): 10 casos, 0 discrepancias — `serving` con y sin `pis` → 0; `standby`,
  `degraded`, `serving` con `pis` incompletos, 503, cuerpo vacío, cuerpo no-JSON, la trampa del grep
  (`"serving"` fuera de `phase`) y conexión rechazada → 1. Con **control negativo**: el comando viejo
  (`r.ok`) contra el cuerpo `standby` da **0**, que es exactamente el defecto que esto cierra.
  **NO se verificó contra un contenedor real corriendo**: el arnés mide el **predicado**, no el montaje
  —ni que Docker interprete el `test` como se espera, ni el `start_period`, ni la transición
  `starting → healthy → unhealthy` de un nodo vivo—. Tampoco se midió el caso de un nodo reiniciado que
  espera el vencimiento del lease anterior; se **razonó** que cabe en el `start_period` (lease stale
  10 s por default contra 40 s de gracia) y eso es conjetura, no medición. El gemelo del lado del
  operador lo lleva el frente arbol (`P-239`) y sigue siendo suyo. `reg 2026-08-18`

- ~~**867 líneas de shell entrarán al repo sin linter en CI**~~ — **✅ RESUELTO (2026-08-19)**: el gate
  existe y es `npm run lint:shell` (`scripts/lint-shell.sh`), con job hermano `shell` en
  `.github/workflows/build.yml` y `image` colgado de `needs: [test, shell]` — o sea que **ninguna
  imagen se publica con el shell en rojo**. El gate **descubre, no enumera**: `git ls-files --cached
  --others --exclude-standard` filtrado por `*.sh` **o por shebang**, así que cubre los dos scripts
  extensionless (un glob `**/*.sh` habría medido 259 de 1130 líneas) y **también el script de shell
  que alguien agregue mañana sin tocar ninguna lista**. El dialecto lo deriva shellcheck del shebang:
  no se fuerza `-s bash`, que volvería el gate ciego a los bashismos que la VM objetivo no soporta
  (medido: el falsificador con `[ $1 == x ]` sale rojo por SC3014). Los 15 hallazgos que había se
  **arreglaron**, sin ningún `disable` nuevo en los tres archivos: 9×SC1007 (`var=` → `var=''`),
  1×SC2020 (`tr '{}' '\n\n'` → dos `tr` de un carácter: POSIX declara *unspecified* el segundo
  conjunto más corto) y 2×SC2015 (`A && B || C` → `if`). El gate se falsificó en tres direcciones
  (script nuevo no enumerado, bug inyectado en el archivo grande, shellcheck ausente) y las tres
  salieron rojas.
  **Lo que NO cubre, dicho con esas palabras:** (a) un script de shell **ignorado por `.gitignore`**
  —`local/`, por ejemplo— no se lintea, por construcción; (b) el CI usa el `shellcheck` preinstalado
  del runner, que **no está pinneado**: su versión puede diferir de la local (0.11.0) y un upgrade de
  imagen del runner puede traer hallazgos nuevos — se verá como un rojo en el job `shell`, no como un
  falso verde; (c) shellcheck queda con su severidad por defecto (`style`), **sin** los *optional
  checks*; y (d) los dos SC2015 se arreglaron como **remoción de un peligro estructural**, no como
  cierre de un bug demostrado: no se logró construir una corrida en que la forma anterior diera una
  respuesta falsa — el detalle está en el PR y en el comentario de cada línea. `reg 2026-08-18`

- ~~**La medición de #164 NO está en el arnés de Fabric**~~ — **SALDADO 2026-08-18**: es P7 de
  `fab:proof` (PR #219) y ya corrió contra el SKU. Resultado en el comentario de #164

- **✅ SALDADO (2026-08-19) — el secreto del SP está en la máquina y P5 (#163) quedó respondida:
  `Viewer` NO tiene `UNMASK`.** La ficha pedía «regenerar el secreto», y esa premisa era **falsa a
  medias**: la app tenía una credencial vigente (`lab-186`); lo perdido era **su valor**. Se emitió
  `lab-186-b` con `--append`, por mandato explícito de César en sesión; vive en
  `local/fabric-lab-sp.env` (ver `RESOURCES.md`).
  **Esta ficha afirmó primero lo contrario y se corrige el mismo día.** La corrida de la mañana midió
  el SP en `Viewer` leyendo **en claro** y publicó «el DDM le es inerte». **Era residuo de la
  revocación no propagada** del 16-ago: el experimento del rol de la tarde, con conexión nueva, token
  nuevo y sin tocar DDL, midió el baseline **enmascarado**. El registro del 16-ago era el correcto.
  **La lección, que vale más que el dato:** el arnés tenía su control positivo en verde y aun así
  entregó un veredicto falso, porque **el control positivo prueba que la lectura ocurrió, no que la
  premisa del sujeto sea la declarada**. `FAB_SP_ROLE=Viewer` era cierto en el plano de control y
  falso en el plano de datos, y ningún control del arnés mira esa diferencia.

- **✅ RESUELTO (2026-08-18) — #164 medido en los dos motores y publicado en 0.19.0.** La ficha decía
  «hecha a MEDIAS, falta Fabric», y eso dejó de ser cierto: el `ADD FILTER PREDICATE` sin argumento se
  midió **aceptado en el SKU F2** con control positivo y verificando que la tabla siga sirviendo sus
  filas (no deny silencioso), y después el codegen se midió **con el SQL emitido** en los dos motores
  —SQL Server 2022 y Fabric— **con el control que el issue pedía y ninguna corrida había hecho**: con
  la policy instalada, el `ALTER` sobre una columna de negocio **se acepta**. `schemaDependencies` de
  un allow-all pasa a `[]`: la dependencia no se declara mejor, **se quita**. `bindColumn` retirado
  del contrato (D-40). Lo construido antes (`schemaDependencies` como mitigación) cumplió su papel de
  puente y ya no hace falta para el allow-all. Ver #164, PR #223.

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

### Saldado autónomo del pasivo — 2026-08-26 · los controles que no controlaban

- **`tsconfig.json` no incluye `scripts/`, así que `npm run typecheck` NUNCA los chequeó** — descubierto
  al promover el control de premisa y el centinela al arnés (P9/P10): `scripts/fabric-lab-proof.ts` y
  `scripts/tsql-lab-proof.ts` están **fuera** del `include`, o sea que el gate del repo daba verde sobre
  ellos **por ausencia**, no por corrección. Se typechequearon aparte con un tsconfig temporal (verde),
  y el hueco quedó abierto a propósito: tocar el `include` afecta a los demás scripts a la vez y puede
  destapar errores preexistentes en archivos que nadie estaba mirando. Es de la familia del instrumento
  que no sabe reportar su propio fallo — **un gate que no mira un directorio no dice «no medí», dice
  «verde»**. Lo barato: agregar `scripts/` al `include` en su propia rama y ver qué sale. `reg 2026-08-19`
  **✅ CERRADA 2026-08-26 · el gate ciego se abrió, y lo que destapó valía más que el gate.**
  `scripts/**/*` entró al `include` de `tsconfig.json`. **Control negativo corrido**: el mismo error
  deliberado en un script es **rojo** con el directorio adentro y **verde** sin él — o sea que lo que
  cambió no es que los scripts estén correctos, es que ahora se miran.
  **Cuatro errores de tipo**, todos en `notas-smoke.ts`: tres imports con extensión `.ts` (ningún otro
  script del directorio las usa) y un fixture que había driftado del tipo `Report` desde que nació
  `specName`. Corregidos.
  **Y dos instrumentos rotos que ningún typecheck habría visto** — el hallazgo que justifica la
  partida sola: `notas-smoke.ts` **moría al correr** (segundo handle de escritura sobre el mismo
  archivo; el fencing del store tenía razón, ver `DECISIONS.md` D-55) y ahora pasa **37/37**;
  `admin-smoke.ts` reportaba la falta de su env con un stack crudo de `node:fs` y ahora dice
  **NO SE PUDO MEDIR** nombrando qué falta. El crash de `notas-smoke` se reprodujo contra la versión
  de `main` **antes** de tocar nada. Decisión en `DECISIONS.md` D-54.

- **El pin de shellcheck está escrito en DOS lugares y nada mecánico impide que se desincronicen** —
  `SHELLCHECK_ESPERADO` en `scripts/lint-shell.sh` y `SHELLCHECK_VERSION`/`SHELLCHECK_SHA256` en
  `.github/workflows/build.yml`, con comentario cruzado en ambos. Si divergen, el modo estricto del CI
  (`LINT_SHELL_STRICT=1`) lo delata en **rojo** —no en silencio, que es lo importante— pero el aviso
  llega después del push. Es exactamente la pareja que driftea que el guard de labels de la imagen ya
  resolvió para su caso (`tests/imagen-anillo-labels.test.ts`): un test que compare los dos literales
  cerraría esto igual. No se hizo para no ampliar el alcance del frente. `reg 2026-08-19`
  **✅ CERRADA 2026-08-26 · `tests/pin-shellcheck.test.ts`.** Compara `SHELLCHECK_ESPERADO` del script
  contra `SHELLCHECK_VERSION` del workflow, exige que el checksum sea un sha256 completo, y comprueba
  que el tarball y la URL se compongan **con la variable** y no con el número escrito a mano — el
  mismo drift un nivel más abajo. **Falsificación ejecutada**: con `0.10.0` en el script y `0.11.0` en
  el workflow, falla nombrando ambos números. Mismo patrón —y misma razón— que
  `imagen-anillo-labels.test.ts`: una pareja que driftea se ata con un test, no con un comentario
  cruzado. Los comentarios cruzados ya existían en los dos archivos y no impidieron nada, porque un
  comentario no corre.

- **El corte de versión no tiene ningún chequeo de que el CHANGELOG declare lo que el tag contiene** —
  es la causa raíz de #242 y sigue viva: el corte compara **lo que el humano recuerda**, no lo que el
  tag trae. La entrada de anillos I7+I8 quedó bajo «Sin publicar» con su código dentro de `v0.21.0`, y
  lo detectó una revisión de custodia por casualidad, no un gate. **Difícil de automatizar bien**
  —mapear entrada→commit exige una convención que hoy no existe—, pero hay una versión barata y
  honesta: al cortar, listar los issues/PRs cuyos commits están en el tag y contrastarlos a mano contra
  los encabezados de la sección. Anotado para que el próximo corte no dependa otra vez de la suerte.
  `reg 2026-08-19`
  **✅ CERRADA 2026-08-26 · `npm run corte:cotejo`**, más el procedimiento escrito donde se lee al
  cortar (`CHANGELOG.md` §«Antes de cortar»). Contrasta las referencias `#NNN` de los commits del
  rango contra el texto de la sección, **en las dos direcciones**.
  **Retro-test, que es lo que lo vuelve citable**: contra el CHANGELOG **tal como estaba al taggear**
  (`git show v0.21.0:CHANGELOG.md`, vía `--changelog`), **atrapa #233** — literalmente el defecto de
  #242 — sin habérselo buscado.
  **Y su primer uso real delató dos cosas**: un defecto propio (el default tomaba el último tag
  *cualquiera*, y este árbol tiene tags `sov-preclose-*` que no son versiones) y un hallazgo
  verdadero (#252 había aterrizado sin declararse; ya tiene su entrada). Los dos corregidos en el
  acto.
  **Lo que NO hace, y va dicho en su propia salida**: no mapea entrada→commit —eso exigiría una
  convención que no existe—, así que un cambio que nadie referenció le es invisible. Es insumo para
  el cotejo a mano, no un veredicto.

- **El eslabón «renombrar en la consola → catálogo servido» de #207 no tiene test de integración** —
  está medido que el override no se congela en el memo del escáner y que sobrevive al reinicio del
  nodo (SQLite en disco), pero la cadena *POST → `refreshDisplayNames()` → `discover()`* solo está
  cubierta por lectura: exige el server levantado, como `serve-rls-proof.ts`. Es exactamente la clase
  de eslabón donde el frente vecino (#139) ya encontró un fallo real —la observación del boot corría
  antes del registro de los watches—, así que no es celo. `reg 2026-08-17`
  **✅ CERRADA 2026-08-26 · `tests/renombre-a-catalogo.test.ts`.** Compone las piezas **reales** —el
  handler de `pi-config`, un `SqliteGovernanceStore` **en disco** y el `createDiscovery` de verdad—
  atadas por la **misma clausura** que `serve-rls.ts` publica en `refreshDisplayNames` (`:1211`) y
  cablea en `onDisplayNameChange` (`:1943`). Seis casos: el nombre del spec antes de tocar nada, el
  POST llegando al catálogo sin reiniciar, que **la ruta no se mueva**, «restaurar», el reinicio del
  nodo con el catálogo **naciendo** con el renombre aplicado, y el control negativo del eslabón
  desconectado.
  **Falsificación ejecutada**: cortando `deps.onDisplayNameChange?.()` en `server/pi-config.ts`, el
  caso del POST se pone **rojo**.
  **Lo que NO cubre, dicho para que nadie lea de más**: la línea literal del cableado dentro de
  `serve-rls.ts` — ese monolito no se instancia sin su entorno. Si alguien desconecta esa línea, lo
  que se cae es `scripts/serve-rls-proof.ts`, no este test.

- **Las facetas client-side (`interactions.filters`) no recibieron el tope+buscador de #209** — el
  frente cubrió los filtros **server-side** de la bandeja, que es donde estaba el caso medido (47
  opciones con cascada). Las facetas son otra superficie y **no fueron lo reportado**, así que esto no
  es un pendiente escondido del issue sino la pregunta abierta de si el roce también aparece allá. Si
  aparece, nace issue propio. `reg 2026-08-17`
  **✅ CERRADA 2026-08-26 · el roce SÍ aparece, medido — y nace `#255`.**
  Se renderizaron las **dos** superficies con el **mismo catálogo de 47 opciones** (el tamaño del caso
  que originó #209) por el mismo `renderHtmlPiece`. La client-side materializa las 47 dentro del mismo
  `.faceta-options` (220 px con scroll interno) **sin tope y sin buscador**; la server-side trae los
  dos — esa mitad es el **control positivo**, sin el cual la sonda no habría probado que sabe verlos.
  **No se implementó**, y no por prudencia: la medición destapó una pregunta de diseño viva. El tope
  de #209 es CSS-only precisamente para que sin JS ninguna opción quede inalcanzable, y las facetas
  client-side **no existen sin JS** — copiar la solución arrastraría una restricción que esta
  superficie no tiene. Va escrito en el issue. Decisión en `DECISIONS.md` D-58.

- **El arnés T-SQL no corre en ningún gate, y un arnés que solo corre cuando alguien se acuerda se
  pudre** — `scripts/tsql-lab-proof.ts` queda fuera de `npm test` **a propósito** (la suite es
  hermética y sin Docker) y fuera del CI. La consecuencia es previsible: el compilador Fabric puede
  cambiar y el arnés seguir en verde por no haberse corrido, que es exactamente el estado del que
  este arnés nos sacó. **Lo que NO se sabe todavía**: si el runner de GitHub aguanta la imagen de SQL
  Server (amd64, ~1,5 GB, arranque de ~40 s) dentro del presupuesto del workflow — no medido. Camino
  probable: job propio, opcional, disparado por cambios en `packages/policy/**`. **Y desde el
  2026-08-16 son DOS los arneses fuera de todo gate**: `fabric-lab-proof.ts` está aún más lejos del
  CI —exige capacidad prendida, credenciales y plata—, así que para él la vía no es un job sino una
  **cadencia declarada**: cuándo se corre y quién se acuerda. Sin eso, el terreno que costó levantar
  se pudre igual que el local. `reg 2026-08-16 · act 2026-08-16`
  **✅ CERRADA 2026-08-26 · uno entró a un gate; el otro recibió cadencia declarada. Eran dos
  problemas distintos y se cerraron distinto.**
  **T-SQL** → `.github/workflows/tsql-lab.yml`: workflow **propio** con filtro de `paths`
  (`packages/policy/**`, el arnés y el workflow mismo), porque en Actions `paths` es por workflow y no
  por job — y la cadencia *es* el punto de esta partida. El motor va como `services:` y se espera
  **sondeando el puerto**: la imagen 2022 ya no trae `sqlcmd`, así que un `--health-cmd` idiomático
  mediría la ausencia de una herramienta. Con cota de 180 s y salida en **rojo** que dice
  «NO SE PUDO MEDIR».
  **La incógnita que esta ficha declaraba «no medida» quedó medida** —si el runner aguanta la imagen
  dentro del presupuesto—: **sí, y sobra.** Job completo en **31 s**, pull de la imagen **14 s**,
  motor aceptando conexiones **al primer sondeo**, `lab:proof` sin fallos y 6 hallazgos. Corrida
  `32970287379`, disparada por el propio push que agregó el workflow.
  **Fabric** → no puede tener gate (capacidad, credenciales, plata), así que lo que le faltaba era
  **cadencia**: **el corte de versión, antes de empujar el tag**. Declarada en dos sitios a propósito
  — `scripts/README-fabric-lab.md` (donde vive el arnés) y `CHANGELOG.md` §«Antes de cortar» (donde se
  lee al cortar). El precedente que la fija es 0.21.0, cuyo centinela se midió **20 min después** del
  tag. Decisiones en `DECISIONS.md` D-56 y D-57.

- **`osvVulnerabilityAlerts` no operaba: al PAT le faltaba el permiso `Dependabot alerts`**
  (reg 2026-08-11, detectado por la sesión `arbol`). **Cerrado 2026-08-11 23:45:** César agregó
  `Dependabot alerts: Read-only` al PAT `renovate-vergis` — sin regenerarlo, porque editar los
  permisos de un fine-grained **no cambia su valor**.
  **Verificado por diferencial, con su factor de confusión identificado:** las corridas de 03:25 y
  03:32 UTC traían `WARN: Cannot access vulnerability alerts`; la de 03:45, con el permiso puesto,
  **no**. Las de 03:04 y 03:06 también daban cero, pero eso era **engañoso** — la config estaba
  inválida y Renovate abortaba antes de llegar a la comprobación; contarlas como éxito habría sido
  leer un instrumento que no medía.
  *El lever inicial que se propuso —«Settings → Code security»— era el equivocado: el repo es público
  y sus alertas ya funcionaban (4, todas `fixed`, leídas por API). El candado era del token.*
  **Prueba positiva (2026-08-12 11:26 UTC):** el log ahora dice `fetchVulnerabilities() -
  osvVulnerabilityAlerts=true` y `No vulnerability alerts found` — o sea que **distingue «medí y
  salió cero» de «no pude medir»**, que es la propiedad exigible a un control de seguridad. Antes
  decía `Cannot access`.
  **Residuo cosmético, resuelto a mano:** el Dependency Dashboard (#169) siguió mostrando el problema
  pese a **cuatro corridas** posteriores; el log muestra que Renovate actualiza su caché del issue
  sin reescribir el cuerpo, y **no se identificó la condición que dispara la reescritura**. Se retiró
  la sección a mano el 2026-08-12 11:44, con comentario en el issue dejando el rastro. Renovate la
  repone si vuelve a haber un problema real — la edición no desactiva nada.

- **El delta sin desplegar / PROD en 0.14.0** (reg 2026-08-07, act 08-10).
  **Cerrado 2026-08-11 22:21:** desplegado **0.15.0** a `vm-vergis` con ventana aprobada por César.
  8/8 PIs en 200 con pie `Vergis v0.15.0`, `healthz ok:true phase:serving pis:{8,8}`, sin regresión.
  Ensayo previo en QA el 10-ago (6/6) y QA devuelta a `deallocated`. **Corte medido: 10.511 ms** —
  42 % sobre los 7.391 ms que cita la regla 17 bis del lab; la causa del delta **no está medida** y
  no se le atribuye ninguna. Dos de las cuatro conjeturas que esperaban este deploy quedaron
  **verificadas** (#139·N2 siembra con `primer-registro`; #151 reclasifica en producción con 4
  watches y `SIGHUP`); la de #145 **sigue sin verificar** porque PROD no declara
  `MIRANDA_PREVIEW_IDENTITIES`. Registro completo en el `BITACORA.md` del lab (`778dd55`).

- **`VERGIS_VERSION` no está re-exportado por el índice de `@vergis/capabilities`** (reg 2026-08-07).
  **Cerrado 2026-08-10 (D-13):** se **bendice el import directo a módulos-hoja**, documentado en el
  sitio que lo usa. Lo que decidió: el mismo lote produjo un segundo caso idéntico —`server/pdf.ts`
  importando `table-runtime`— y ambos tienen la misma razón dura: entrar por el índice de
  `@vergis/capabilities` arrastra vega/mssql a tests de módulos que son puros por contrato. Con dos
  casos deja de ser una excepción y pasa a ser el patrón. Requisito: el módulo-hoja debe no tener
  imports propios (`version` y `table-runtime` los tienen en cero) y el import lleva su porqué al
  lado. Revertir = añadir los re-exports al índice y cambiar 2 líneas.

- **Gate token comparado con `!==`, no constant-time** (reg 2026-08-07).
  **Cerrado 2026-08-10:** `constantTimeEqual` en `server/routes.ts` (D6 del diseño 004/10), más
  `headerValue()` para que un header repetido (array) falle cerrado en vez de compararse crudo.
  *Honestidad del instrumento:* la mutación de vuelta a `!==` **no reprueba** ningún test — una
  comparación en tiempo constante no tiene diferencia observable en la salida, que es justamente su
  punto. Lo que sí está testeado: la semántica preservada (3 casos nuevos en `routes.test.ts`) y
  `constantTimeEqual` con sus propios tests en `http-util`.

- **Gramática de nombre de archivo duplicada** entre `vtCsvName` (#61) y `pdfFilename` (#65)
  (reg 2026-08-06). **Cerrado 2026-08-10:** unificada en `vtDownloadName`, única implementación;
  `vtCsvName` la envuelve para el navegador (va en `PURE_FNS`, viaja por `.toString()`) y
  `server/pdf.ts` la importa. Restricción que la partida no conocía: `vtCsvName` es autocontenida a
  propósito, así que la unificación tenía que serlo también. Evidencia de preservación: las dos
  suites de nombres siguen verdes **sin tocarse**.

- **`import type { TableColumn }` sin uso** en `render-csv-piece.ts` (reg 2026-08-06).
  **Cerrado 2026-08-10:** eliminado.

- **`actions/checkout@v4` y `actions/setup-node@v4` avisan deprecación de Node 20**
  (reg 2026-08-06). **Cerrado 2026-08-10:** ambas a **v7** (no a v5 como decía la partida — v7 es
  la vigente y cumple el cooldown de 14 días del propio `renovate.json`: publicadas el 07-20 y el
  07-14). Las `docker/*` quedan deliberadamente sin tocar a mano: las propondrá Renovate con su
  changelog, que es para lo que se encendió.

- **Recargas espurias si los yaml vigilados comparten directorio con `VERGIS_OUT`**
  (reg 2026-08-08). **Cerrado 2026-08-10:** el evento sin nombre de macOS (`filename=null`) se
  desambigua por mtime — dispara solo si el archivo vigilado cambió de veras; si desaparece,
  dispara igual (fail-loud). La decisión se extrajo a `decideWatchEvent`, pura y exportada, porque
  el caso interesante **no se puede producir a voluntad con el `fs.watch` real** y un test de
  integración sobre él habría sido un instrumento que no sabe reprobar. Validado por mutación:
  quitar el guard hace fallar 2 tests.

- **`Dockerfile` omitía el manifiesto de `packages/miranda`** (reg 2026-08-07).
  **Cerrado 2026-08-08:** COPY añadido a ambos stages — PR #149. El experimento del build
  (`docker build` exit 0, daemon real) decidió corrección sobre omisión documentada, como mandaba
  la pieza 5 del H1 de open-core.
- **Cluster 004: los diseños esperaban las decisiones de César** (reg 2026-08-07).
  **Cerrado 2026-08-08:** César resolvió las 14 en sesión guiada — 13 aprobadas tal como estaban
  selladas (03/D1-D2-D3 · 04/D8-D9-D12 con sonda a workspace real · 05/D5 · 08/D1+cap25 ·
  10/D8 a+b+c · 11/D1-D2-D3-D4-D5) y 1 diferida (11/D6 marca → `TODO.md`). Los marcadores de los
  docs quedaron sellados `[aprobada por César · 2026-08-08]`.
- **Miranda: CINCO rutas sin check de pertenencia de sesión** (reg 2026-08-07 como 2 rutas,
  ampliado 2026-08-08 a 5 por re-revisión: `sessionPage` exponía el transcript completo y
  `publish` permitía publicar el draft ajeno; la lista filtraba por dueño — ilusión de privacidad).
  **Cerrado 2026-08-08:** guard `dueño-o-admin` central en las 5 rutas — PR #142 mergeado
  (`dbbc4ba`), +24 tests con experimento de refutación. Diseño `work/005-…/01-…`; semántica D-08.
- **`MIRANDA_VALIDATE_CAPS` prometía `send-email`/`send-slack` inexistentes** (reg 2026-08-07).
  **Cerrado 2026-08-08:** hito H0 de #113 — PR #144 mergeado (`e799b7a`); la lista vive en el
  builder puro `mirandaValidateCaps` y el experimento confirmó el rechazo
  `channel-capability-not-catalogued` con caso de control. Cero apariciones en `server/`.
- **`TODO.md:16` rancio** — declaraba «HMAC + época de 4h» en `server/annotations.ts`, archivo
  retirado con la capa de notas (vergis#84); el único `createHmac` vigente es el CSRF de
  `server/ui.ts:136`, sin época.
  **Cerrado 2026-08-07:** la nota de egreso quedó escrita en `TODO.md:16` (el registro ya no miente).
  La pieza viva que quedaba —rediseñar la época del CSRF— no es un pendiente suelto: vive como
  hito H4 del diseño `work/004-cluster-disenos-backlog-2026-08-07/10-113-hardening-v1.0.md`.
  `reg 2026-08-07 · cerrado 2026-08-07`
- **La proyección guardada del contrato NO es estable justo tras el arranque** — observado en el
  deploy de 0.15.0 a PROD (2026-08-11 22:21): dos lecturas del mismo archivo y la misma única
  entrada del journal dieron distinto (`watches: []` / sha `c61ab476…`, y minutos después
  `watches: 4`, `signals: 1`, sha `8539f4db…`). La ficha decía **«la causa NO está medida»**, y con
  razón: era observación, no mecanismo.
  **Cerrado 2026-08-14 (0.16.1), con la causa medida y no deducida:** la observación del arranque
  corría **antes** de que el bloque de hot-reload registrara sus watches, y `env.reloadableContent`
  se **deriva** de ellos — la proyección persistida clasificaba `VERGIS_POLICIES` como `bootOnly`.
  No era una escritura diferida ni un re-registro: era orden de cableado. Arreglado sin depender del
  orden (una declaración tardía re-observa sola), con su experimento en
  `tests/contract-boot-projection.test.ts` y control de refutación corrido.
  El **delta fantasma** que la ficha temía era real y quedó cubierto por el mismo arreglo.
  `reg 2026-08-11 · cerrado 2026-08-14`
- **`dotclaude` con cambios sin sellar de otras sesiones** — la ficha quedó con dos residuos
  enumerados (`settings.json` y `commands/label.md` borrado), sin sellar a propósito por ser de
  otro actor (W-01).
  **Cerrado 2026-08-14:** los dos se resolvieron en su propia sesión — `/label` se retiró en
  `59d22c0`. Lo que quedaba al retomar era **residuo propio y completo**: la ocurrencia 20 de W-01,
  que esta sesión escribió y no había sellado; commiteada en `e3c6e74` del repo `dotclaude`.
  Árbol de `~/.claude` limpio, verificado con `git status --porcelain` vacío.
  *La ficha no se cierra por «ya no aplica»: se cierra porque el árbol se midió.*
  `reg 2026-08-07 · cerrado 2026-08-14`
- **`MASKED WITH` × vistas-contrato `SCHEMABINDING`: interacción no medida** — declarada conjetura al
  abrirse #163 y sostenida como tal, porque «no había dónde medirla».
  **Cerrada 2026-08-14, medida contra un motor y peor de lo que se temía:** un objeto `SCHEMABINDING`
  que referencia la columna bloquea el `ADD MASKED` **y** el `DROP MASKED`, así que el plano de
  columna no se instalaba en las tablas que la instancia real usa. Con su control de causa (quitada
  **solo** la vista, la misma sentencia se acepta) y su remediación **corrida**, no prometida: no es
  incompatibilidad, es **orden**.
  De la misma corrida salió un defecto que nadie había conjeturado: el guard de idempotencia del
  `DROP MASKED` **no guardaba** —T-SQL compila el batch antes de ejecutarlo—, y por eso **toda**
  instalación nueva del plano de columna fallaba en su primera sentencia.
  Corregido en #163 (PR #191) con preflight diagnosticado; racional en `DECISIONS.md` D-30.
  *La premisa que la sostenía —«no hay dónde medirlo»— era falsa: el compilador emite T-SQL y un
  motor T-SQL cabe en un contenedor (`npm run lab:proof`).*
  `reg 2026-08-13 · cerrado 2026-08-14`
- **La imagen 0.17.0 se verificó solo en arm64** — el `docker pull` del cierre bajó la variante de
  esta máquina, así que la de **amd64 —la que corre en la VM del operador— no se había ejecutado
  nunca**: la diferencia entre «el CI dice que la construyó» y «alguien la corrió».
  **Cerrado 2026-08-16 en el mismo acto en que se detectó (un minuto), con su control:**
  `docker run --platform linux/amd64 … uname -m` → `x86_64`; **sin** forzar plataforma → `aarch64`;
  y `docker manifest inspect` declara las dos arquitecturas (más las dos entradas `unknown`, que son
  el SBOM y la provenance de buildx). El control es lo que lo vuelve concluyente: sin la corrida
  nativa al lado, un `x86_64` no distingue «corrió amd64» de «Docker ignoró el flag».
  *Se registró y se saldó el mismo día: queda acá porque el hallazgo —que un `pull` verifica una sola
  arquitectura— vale para el próximo corte de versión.*
  `reg 2026-08-16 · cerrado 2026-08-16`

## Vencidas sin veredicto

*(ninguna todavía — el TTL más antiguo vigente es del 2026-08-06)*

---
• *Generado con [Wingworking](https://wingworking.org)*
