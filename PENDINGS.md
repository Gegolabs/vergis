# PENDINGS — detectados por el agente

Pendientes que **detectó el agente**, no encargó el humano. TTL 15 días desde `reg`: al vencer
pasan a `PENDINGS-done.md` §vencidas. Lo que César declare o confirme como pendiente vive en `TODO.md` (sin TTL);
la promoción PENDINGS→TODO se pide, no se toma.

> **La regla del TTL y las fichas con dependencia externa (adoptada 2026-08-22).** El TTL corre
> **sobre las abiertas `[ ]`**: mide el silencio del agente, no el del acreedor. Una ficha `[~]` con
> **dependencia externa nombrada** (pagada, esperando a un tercero) **no vence por plazo** — hereda
> la exención de la cobranza-con-rehén de `TODO.md`, y su TTL se cuenta desde la última
> **re-derivación contra el estado vivo**, no desde su `reg`.

## Operación / despliegue

- **0.20.1 está publicada y NO se ha avisado al operador** (*act 2026-08-18: la ficha decía 0.18.0 y
  que #197 seguía vivo; las tres versiones del 18-ago volvieron falsas ambas cosas*) — tags
  `v0.19.0`, `v0.20.0` y `v0.20.1` empujados con sus imágenes verificadas en el log del workflow.
  **Nada quedó sin publicar**; falta el aviso, y **el acto es de César**: comunicación saliente a un
  tercero, que ningún presupuesto cubre. Lo que ese aviso tiene que decir, y es más que antes:
  (a) **#197 quedó corregido** — la vista de máscara ya sirve y **discrimina** en Fabric desde
  0.19.0; (b) **cambio de contrato**: `FabricTarget.bindColumn` retirado (#164); (c) **una migración
  que no es opcional** para obtener el efecto de #164 —regenerar y re-aplicar la security policy de
  cada tabla `grant: all`— con su advertencia de **aviso apagado**: hasta re-aplicar, el compilador
  reporta cero dependencias mientras la columna sigue atada en el motor; (d) la fase **`standby`** de
  0.20.0, que da «sano» a un nodo que no sirve si el chequeo juzga por `r.ok`; (e) que **su producción
  corre 0.18.0** —verificado por el frente arbol contra la VM viva—, o sea sin ninguna de estas
  correcciones. `reg 2026-08-18`

- **Las imágenes hasta 0.20.0 inclusive están MUDAS: no traen changelog ni labels** — el arreglo de
  #229 entró después de ese corte, así que solo desde **0.20.1** la imagen contesta «¿qué exige
  esto?» sin salir de la VM. Medido contra el registry: `:0.18.0`, `:0.19.0` y `:0.20.0` devuelven
  `documentation` ausente. **Muerde justo en el salto vivo del operador** (0.18.0 → 0.20.x): para
  ese tramo el **repo sigue siendo la fuente** y la imagen no ayuda. Se extingue solo cuando la
  instancia corra ≥0.20.1. `reg 2026-08-18`

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

- **`tsconfig.json` no incluye `scripts/`, así que `npm run typecheck` NUNCA los chequeó** — descubierto
  al promover el control de premisa y el centinela al arnés (P9/P10): `scripts/fabric-lab-proof.ts` y
  `scripts/tsql-lab-proof.ts` están **fuera** del `include`, o sea que el gate del repo daba verde sobre
  ellos **por ausencia**, no por corrección. Se typechequearon aparte con un tsconfig temporal (verde),
  y el hueco quedó abierto a propósito: tocar el `include` afecta a los demás scripts a la vez y puede
  destapar errores preexistentes en archivos que nadie estaba mirando. Es de la familia del instrumento
  que no sabe reportar su propio fallo — **un gate que no mira un directorio no dice «no medí», dice
  «verde»**. Lo barato: agregar `scripts/` al `include` en su propia rama y ver qué sale. `reg 2026-08-19`

- **El pin de shellcheck está escrito en DOS lugares y nada mecánico impide que se desincronicen** —
  `SHELLCHECK_ESPERADO` en `scripts/lint-shell.sh` y `SHELLCHECK_VERSION`/`SHELLCHECK_SHA256` en
  `.github/workflows/build.yml`, con comentario cruzado en ambos. Si divergen, el modo estricto del CI
  (`LINT_SHELL_STRICT=1`) lo delata en **rojo** —no en silencio, que es lo importante— pero el aviso
  llega después del push. Es exactamente la pareja que driftea que el guard de labels de la imagen ya
  resolvió para su caso (`tests/imagen-anillo-labels.test.ts`): un test que compare los dos literales
  cerraría esto igual. No se hizo para no ampliar el alcance del frente. `reg 2026-08-19`

- **El corte de versión no tiene ningún chequeo de que el CHANGELOG declare lo que el tag contiene** —
  es la causa raíz de #242 y sigue viva: el corte compara **lo que el humano recuerda**, no lo que el
  tag trae. La entrada de anillos I7+I8 quedó bajo «Sin publicar» con su código dentro de `v0.21.0`, y
  lo detectó una revisión de custodia por casualidad, no un gate. **Difícil de automatizar bien**
  —mapear entrada→commit exige una convención que hoy no existe—, pero hay una versión barata y
  honesta: al cortar, listar los issues/PRs cuyos commits están en el tag y contrastarlos a mano contra
  los encabezados de la sección. Anotado para que el próximo corte no dependa otra vez de la suerte.
  `reg 2026-08-19`


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

- **El eslabón «renombrar en la consola → catálogo servido» de #207 no tiene test de integración** —
  está medido que el override no se congela en el memo del escáner y que sobrevive al reinicio del
  nodo (SQLite en disco), pero la cadena *POST → `refreshDisplayNames()` → `discover()`* solo está
  cubierta por lectura: exige el server levantado, como `serve-rls-proof.ts`. Es exactamente la clase
  de eslabón donde el frente vecino (#139) ya encontró un fallo real —la observación del boot corría
  antes del registro de los watches—, así que no es celo. `reg 2026-08-17`
- **Las facetas client-side (`interactions.filters`) no recibieron el tope+buscador de #209** — el
  frente cubrió los filtros **server-side** de la bandeja, que es donde estaba el caso medido (47
  opciones con cascada). Las facetas son otra superficie y **no fueron lo reportado**, así que esto no
  es un pendiente escondido del issue sino la pregunta abierta de si el roce también aparece allá. Si
  aparece, nace issue propio. `reg 2026-08-17`

- ~~**El arnés de Fabric mide la discriminación con el principal EQUIVOCADO, y así se coló #238**~~ —
  todas las comprobaciones de discriminación corrían como `admin` (`fabric-lab-proof.ts:232-233` y
  `:346-347`); el único sondeo que usaba el service principal era P5. El admin **siempre** tiene
  `UNMASK`, así que los verdes que cerraron #197 midieron una propiedad real sobre un sujeto que no
  es el que sirve. **Lo que faltaba no era un test más, era un control de premisa**: verificar el
  estado del sujeto **en el plano de datos** —no en el de control, que miente durante la staleness de
  revocación— antes de creerle a cualquier veredicto sobre `UNMASK`. `reg 2026-08-19`
  **CERRADA 2026-08-19 (PR #244):** el arnés tiene sondeo P9, que mide la discriminación con el
  principal que **sirve** y no concluye sin premisa: el estado del sujeto se mide **leyendo** la tabla
  y, si contradice el `FAB_SP_ROLE` declarado, el sondeo **se niega a concluir**. Las comprobaciones
  del admin se conservan a propósito, rotuladas REFERENCIA — el contraste admin-vs-SP es lo que hizo
  visible #238. El arnés estrena además un tercer estado, `⚠ NO MEDIDO` (antes «no pude medir» salía
  como hallazgo, indistinguible de un dato), con código de salida propio (3).
  **Y un defecto nuevo que el cierre destapó:** el test por desigualdad de JSON que la ficha daba por
  bueno **no habría atrapado #238** — la rama `ELSE` de la vista devuelve el literal del IR (`•••`) y
  el DDM devuelve el default del tipo (`XXXX`), así que las dos lecturas difieren sin que ninguna
  traiga el dato. P9 juzga si el claim concede el **valor real** (los ruts sintéticos, conocidos por
  construcción), no si las lecturas difieren.
  **Verificado de FORMA, no contra el motor:** `typecheck` verde, el SQL emitido revisado a mano
  (sale del compilador, `FAB_PROOF_PRINT_SQL=1 npm run fab:sql`) y la lógica de la premisa ejercitada
  con dobles. **Queda sin medir** hasta la primera corrida con la ventana de capacidad abierta.

- **La staleness de revocación de rol supera los 20 min** — cota medida el 2026-08-19: rol bajado a
  `Viewer` a las 13:50:47 UTC, y a las 14:11:40 el SP seguía leyendo **en claro**. El experimento que
  la esperaba **se negó a concluir**, que es lo correcto. Sigue sin medirse el techo y qué la termina.
  **Consecuencia práctica inmediata**: cualquier medición sobre el SP de laboratorio queda inválida
  durante una ventana de al menos 20 min después de tocarle el rol, así que **el experimento se
  planifica antes de tocar el plano de control, no después**. `reg 2026-08-19`

- **El DDL del centinela de #238 se midió contra Fabric DESPUÉS de taggear 0.21.0, no antes** — el
  orden estuvo mal y el resultado no lo arregla. La medición salió limpia (las 3 sentencias
  aceptadas, idempotentes, descubrimiento y máscara corroborados en `sys`, control positivo del
  instrumento en verde), pero **eso se supo 20 min después de empujar el tag**. Si Fabric hubiera
  rechazado una sentencia, la versión publicada habría traído DDL inejecutable — exactamente el modo
  de falla de #197, que este mismo emisor ya pagó una vez. **La regla que faltaba aplicar no es
  nueva**: un mecanismo no se publica sin el experimento que lo pone en riesgo, y «publicar» empieza
  en el tag, no en el aviso. El arnés del terreno (`fab:proof`) debería incluir el centinela para que
  esto no dependa de que alguien se acuerde. `reg 2026-08-19`
  **CERRADA 2026-08-19 (PR #244):** el centinela es el sondeo **P10** de `fab:proof`, con lo que midió
  el experimento suelto —las 3 sentencias emitidas, idempotencia real (crear-si-falta, una sola fila
  tras dos pasadas), el descubrimiento del serving, la corroboración en `sys`, el control positivo del
  instrumento con el admin y el estado `uninstrumented` honesto— más dos cosas que el experimento no
  medía: el **retiro verificado midiendo** (no se supone que `dropSQL` funcionó porque no dio error) y
  que el SQL del **emisor** y el del **serving** sean el mismo byte a byte. Su cabecera declara que
  este sondeo es la condición de cortar versión cuando el corte toca el centinela.
  **Verificado de FORMA:** ver la ficha de arriba. **Queda sin medir** hasta la primera corrida con la
  ventana abierta.

- **La conexión viva es una frontera de autorización, y el nodo sostiene un pool** — medido el
  2026-08-19 contra Fabric: una conexión ya abierta **nunca** vio el cambio de rol dentro de la
  ventana de sondeo (60 s tras conceder), mientras conexiones nuevas lo vieron en ≤11 s. **La
  autorización se fija al conectar.** Importa para el Producto y no solo para el arnés: el nodo de
  serving sostiene conexiones reusadas, así que **revocarle un privilegio a un principal no surte
  efecto sobre las conexiones que ya tenía abiertas** — y sumado a la staleness de revocación del
  servicio, la ventana de privilegio residual es más larga que cualquiera de las dos por separado.
  **No medido contra el Producto**, solo contra el arnés: cuánto viven las conexiones de su pool y si
  las recicla es la pregunta que decide si esto muerde. `reg 2026-08-19`

- **Revocar un rol de workspace en Fabric NO toma efecto de inmediato, y no se sabe qué lo destraba**
  — medido el 2026-08-16: subir el SP de `Viewer` a `Member` cambió el resultado en la **primera**
  lectura (t+0s); bajarlo de `Member` a `Viewer` **no tomó efecto en 6,5 minutos de sondeo continuo**
  (14 lecturas, el principal siguió viendo el valor real). La máscara se observó recién **después de
  recrear tabla y política**, así que hay dos candidatos —el tiempo o la re-aplicación del DDL— y
  **cuál de los dos NO está medido**.
  **ACOTADO el 2026-08-19 con el experimento del rol** (sin tocar DDL, tres vías en paralelo):
  conceder propaga en **≤11 s** a una conexión nueva; **revocar NO propaga en >300 s**, y **ni una
  conexión nueva ni un token de acceso nuevo la destraban** — o sea que la hipótesis del token
  cacheado, que era el tercer candidato, queda **refutada**. Sigue sin medirse **cuánto dura** y
  **qué la termina**: entre una lectura contaminada y una limpia pasaron ~4 h y una pausa de
  capacidad, y cuál de las dos la cortó se desconoce. Ya cobró su primera víctima documentada — el
  veredicto falso de P5 esa misma mañana. Importa por dos vías: (a) es un asimetría de seguridad
  —conceder privilegio es instantáneo, quitarlo no—; (b) **envenenó una medición de esta misma
  sesión**: el primer veredicto sobre `UNMASK` fue el opuesto al correcto y se publicó como hallazgo
  antes de que tres corridas seguidas lo desmintieran. El experimento que falta es barato: bajar el
  rol y sondear con TTL largo **sin** tocar el DDL. `reg 2026-08-16`
- **Ningún registro del repo declaraba dos capacidades Fabric vivas en el tenant propio** — al
  levantar el terreno aparecieron, *Active* en Chile Central, una capacidad **Trial FTL64**
  (`Trial-20260525T022032Z-…`, iniciada el 2026-05-25) y una **PP3 «Premium Per User - Reserved»**,
  con los workspaces `arbol-lab-smoke-test` y `arbol-lab-qw04`. **No se tocaron** y quedaron
  declaradas en `RESOURCES.md`. Consumen presupuesto o licencia y **la decisión de qué hacer con
  ellas es de César** (gasto). Se anota acá porque el hallazgo es del agente, no encargo suyo.
  `reg 2026-08-16`
- **Una consulta de instancia sigue abierta, y ya no es sobre la severidad de #197 sino sobre
  `UNMASK`** (*act 2026-08-19: la pregunta ya NO es si el mecanismo existe —se midió en terreno propio,
  y con `Viewer` el SP de laboratorio lee en claro—, sino qué ocurre en la instancia del cliente*) —
  lo que queda: **¿con qué rol de workspace corre el service principal de serving de la instancia?** Decide si el cinturón DDM le muerde (`Viewer`) o si lee la
  tabla en claro (`Member`), y por lo tanto si la rama «en claro» de la vista sirve de algo. Es la
  misma pregunta que P5 por otra vía, y **es una consulta contra la instancia, no un frente**.
  Conserva valor la otra mitad, con otro sentido: **¿algún PI nombra una `vw_mask_*`?** — ya no mide
  el daño, mide **a quién le sirve el arreglo**. `reg 2026-08-16 · act 2026-08-18`

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

- **El frente de authz dejó cuatro cosas sin medir — quedan DOS, y ya no por falta de terreno**
  (*encogido el 2026-08-14 con el arnés T-SQL local; la premisa «ninguna se puede medir sin terreno
  vivo» resultó falsa para la mitad*):
  (a) **¿el SP de serving tiene `UNMASK`?** — **CORREGIDA el 2026-08-16 contra Fabric real: el
  mecanismo que esta ficha daba por medido NO OCURRE en Fabric.** La disyuntiva «sin `UNMASK` la
  rama en claro devuelve el default / con `UNMASK` la vista discrimina» describe la semántica
  T-SQL. **Corregido otra vez el 2026-08-18: la disyuntiva VUELVE a aplicar en Fabric**, porque
  #197 quedó resuelto y la vista ya se consulta y discrimina desde 0.19.0 — o sea que cuál de las dos
  ramas ocurre **depende ahora sí** de si el SP tiene `UNMASK`, y eso sigue **sin medirse**. Lo que
  quedó medido: **`UNMASK` lo decide el ROL del workspace** — `Member` lee el valor real, `Viewer`
  lee la máscara. Queda un dato de instancia, y sigue siendo **una consulta, no un frente**: con qué
  rol corre el SP de serving. Mientras no se mida, lo prudente es asumir la rama degradada. (b) **RESUELTA y peor de lo que se temía**: el `ADD MASKED` no entra sobre una tabla
  con vista-contrato — es **orden**, no incompatibilidad, y el motor lo rechazaba sin nombrar al
  culpable. Corregido con preflight diagnosticado; ver #163 y `DECISIONS.md` D-30. (c) el **costo de
  enforcement** por columna sigue abierto, pero **ya no por falta de terreno**: el terreno Fabric
  propio existe (#186, `npm run fab:proof`) y el costo es una medición pendiente, no un frente.
  (d) el bit `is_schema_bound` **quedó medido el 2026-08-16 contra Fabric por driver real**:
  `sys.security_policies` devolvió `is_schema_bound: true` —booleano, el caso que el código ya
  acepta—. Vale para **este driver (`mssql`) y este SKU**; otro driver sigue sin medir.
  `reg 2026-08-13 · act 2026-08-16`
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

- **✅ RESUELTO (2026-08-18) — #164 medido en los dos motores y publicado en 0.19.0.** La ficha decía
  «hecha a MEDIAS, falta Fabric», y eso dejó de ser cierto: el `ADD FILTER PREDICATE` sin argumento se
  midió **aceptado en el SKU F2** con control positivo y verificando que la tabla siga sirviendo sus
  filas (no deny silencioso), y después el codegen se midió **con el SQL emitido** en los dos motores
  —SQL Server 2022 y Fabric— **con el control que el issue pedía y ninguna corrida había hecho**: con
  la policy instalada, el `ALTER` sobre una columna de negocio **se acepta**. `schemaDependencies` de
  un allow-all pasa a `[]`: la dependencia no se declara mejor, **se quita**. `bindColumn` retirado
  del contrato (D-40). Lo construido antes (`schemaDependencies` como mitigación) cumplió su papel de
  puente y ya no hace falta para el allow-all. Ver #164, PR #223.

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

- **`/ww:work` no consume `POLICIES.md`, y el Reglamento ya promete que sí** — al registrar el
  canónico se escribió en `ww:wingworking` que *«lo que cae bajo una política vigente deja de
  aparecer en el bloque Decisiones»*, y **ninguna skill implementa esa lectura**: verificado con
  `grep -rl POLICIES` sobre el plugin `ww`, el único archivo que lo nombra es el Reglamento mismo
  (más `ww:start`, que lo agrega a su Tier 2 de lectura). Hoy funciona en Vergis **por otra vía** —
  el `CLAUDE.md` del proyecto lo ancla y se inyecta en toda sesión—, así que la mitigación es local y
  la promesa es general: en un proyecto que declare `POLICIES.md` sin nombrarlo en su `CLAUDE.md`,
  la vista seguiría subiéndole al principal lo que él ya autorizó. **Es una afirmación del Reglamento
  que hoy no se cumple sola**, y se anota con esas palabras en vez de darla por hecha (Norma 6).
  Lo barato: que el Paso de enumeración de `/ww:work` lea `POLICIES.md` del proyecto y filtre.
  `reg 2026-08-18`



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
