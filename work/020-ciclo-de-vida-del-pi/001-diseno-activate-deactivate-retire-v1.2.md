# Diseño · El ciclo de vida de un Let: `activate`, `deactivate` y `retire`

| Campo | Valor |
|--|--|
| Prindex | 020 · 001 |
| Versión | v1.2 |
| Fecha | 2026-09-30 |
| Origen | Issue [#392](https://github.com/Gegolabs/vergis/issues/392), trabajo 5 del diseño aprobado `roble/lab/work/288-diseno-plugins-vergis-custos-mira-v1.1.md` (tabla de `mira:status`, criterio 3). Parte de #387 |
| Estado | **Propuesta.** Responde a los dos juicios de Fable 5.1: la v1.0 y la v1.1 fueron **rechazadas** con alcance acotado ([acta v1.0](001-diseno-activate-deactivate-retire--JUICIO-fable-v1.0.md) · [acta v1.1](001-diseno-activate-deactivate-retire--JUICIO-fable-v1.1.md); [v1.0](001-diseno-activate-deactivate-retire-v1.0.md) y [v1.1](001-diseno-activate-deactivate-retire-v1.1.md) se conservan). Incorpora las decisiones de César del 2026-09-30 sobre P-1, P-3 y P-4. Pendiente de un nuevo juicio y de **una** confirmación de César (§«¿Qué falta que confirme César?»). Lo marcado **(decidido)** no lo reabre el ejecutor; lo marcado 🙋 es la propuesta pendiente de confirmar |
| De | 🤖 Simón Alero, agente de César Obach · **modelo del autor: Claude Opus 5.5** |
| Ejecutor | Un subagente con este documento como único contexto, en un worktree propio sobre `main` (≥ 0.41.0). No necesita la conversación que lo originó |
| Versión del Producto | Capacidad nueva ⇒ sube la Y en el próximo corte. Las filas de `docs/capacidades.md` toman el próximo `CAP-NN` libre al momento del PR (no se reserva acá) |

---

## ¿Qué decide este documento?

Qué significan `activate`, `deactivate` y `retire` —y con ellos `status`— para un Let hospedado por el nodo de Vergis: el Botlet de un Producto de Información (PI) servido por Mira, y por construcción cualquier otro Let (hoy también los de Daftar). Fija:

- una **máquina de estados** con sus transiciones prohibidas;
- el **orden de los chequeos** en el router y qué ve cada quien en cada estado;
- qué pasa con el gobierno, los permisos, las notas y el registro;
- **dónde vive** el estado, cómo se migra y cómo convive con el plano de control y la vuelta atrás;
- la **clase del acto** de cada verbo, su gate y su ceremonia;
- cómo lo consume `mira:status`, qué verbos nuevos necesita `vergis-ops` y qué cambia en `smoke`, `marks` y `botler-rollout`;
- un plan de implementación verificable paso a paso.

La tesis en una línea: **el ciclo de vida es del Botler, no de Mira ni del archivo del spec.** El spec dice *qué es* el Let (`specialize`); el estado de ciclo de vida dice *si está en servicio*, lo cambia un acto con actor y motivo, y toda invocación queda en el log append-only. Hoy el Producto solo tiene un sustituto implícito —que el archivo esté o no esté en el directorio—, que no distingue «suspendido» de «retirado» de «se perdió el archivo», y no deja rastro de quién lo hizo.

## ¿Qué cambió por el segundo juicio?

Cada hallazgo del acta de la v1.1, re-verificado contra el código en `ee31be9` antes de resolverlo, más las decisiones de César del 2026-09-30.

| Hallazgo | Re-verificación | Resolución en esta versión |
|--|--|--|
| **B3** · sembrar `activo` lo no servible deja al candidato `degraded` en el relevo y `promote` aborta | **Medido** (corrida en §«¿Qué se midió para este diseño?»): con `fake-docker.sh` modificado para que el candidato quede `degraded` al tomar el control, `botler-rollout promote 0.42.0` sale 1 con «el candidato NO llegó a 'serving' (fase: degraded)… promoción ABORTADA en el handover. El borde volvió a apuntar a 'vergis-0-41-0'»; el control (candidato `serving`) sale 0 | **Siembra por servibilidad (decidido):** lo que `discover()` deja pasar entra `activo`; lo que solo `parsed()` conoce entra `especializado` con `healthReason` = el motivo del descubrimiento, la misma regla de P-1. Y un invariante nuevo: **sin marca de siembra, un código sin fila se trata como la siembra lo dejaría**, así que sembrar nunca cambia `lets.total` ni `lets.serving`. Pasos 7a y 7c; el knob `on_control` entra al fixture como regresión permanente |
| **M7** · en `especializado`, quien no tiene acceso aprendía más (403) que quien lo tiene (404) | `canOpenPi` = `piManagementRole(...).then(canOpen)` (`serve-rls.ts:1314-1315`), `canOpen = r != null` (`packages/capabilities/src/pi-authz.ts:56`) | El router resuelve el rol **una vez** y, en `especializado`, todo lo que no sea gestor recibe el 404 de un código inexistente **antes** del 403. Control negativo nuevo en el paso 4 |
| **M8** · un 409 de standby habría escrito en un log que dos anillos comparten | `VERGIS_OUT` es el volumen `./governance` compartido (`deploy/compose.reference.yml:107, 151`); `AppendOnlyLog` arranca cada proceso en `seq=0` sin retomar el archivo (`packages/botler/src/log.ts:25-27`) | **(decidido)** El 409 de standby **no** escribe: se responde antes de tocar el log, y el rechazo lo ve el activo cuando el CLI reintenta contra él. Toda otra invocación se registra en el activo. La cadena que el paso 6 verifica es la de **un** proceso (i9). Control negativo en el paso 6 |
| **M9** y la mitad abierta de **M5** · el plugin no hereda `--acepto-reexponer` | `rollout.mjs:97-99`: el plugin arma su lista de flags y rechaza a propósito `--no-schema-gate` | **(decidido)** El plugin **no** ejerce `--acepto-reexponer`, con el precedente y la redacción de `rollout.mjs:99`: re-exponer un Let suspendido o retirado es decisión del operador a mano, con `botler-rollout`, gritándola en pantalla. Hereda la **negativa**, no el override. Paso 7b |
| Mitad abierta de **M1** y **m9** · `smoke` leía `/contrato` con la identidad de sondeo | `/contrato` exige admin (`server/contract.ts:495-507`); `contract.mjs:10, 23, 88-91` ya usa `VO_ADMIN` = `RINGS_ADMIN_EMAIL` | `smoke` lee el estado de `/contrato` con `VO_ADMIN` y sigue sondeando con la identidad de sondeo. Por coherencia, los verbos `let` usan la **misma** identidad admin (`RINGS_ADMIN_EMAIL`) y no un campo nuevo en `vergis-ops.json` |
| **m10** · `piManagementRole` siembra el gobierno de un retirado nunca accedido | `serve-rls.ts:1199-1206` | Se siembra igual: es inocuo (dueño y visibilidad), y la congelación de un retirado es de las **escrituras** de `/<slug>/config`. En standby, esa siembra perezosa cae en un handle de lectura y se ignora, como hoy |
| **m11** · `replacedBy` podía apuntar a un `especializado` | — | Al retirar, el sucesor debe estar `activo` o `inactivo`; al desactivar, `activo`. La página resuelve la cadena y **enlaza solo si termina en un `activo`** |
| **m12** · el enlace al sucesor revelaba un código sin comprobar acceso | — | La página comprueba `canOpenPi` **del sucesor**; si no pasa, no muestra ni el enlace ni el código |
| **m13** · «byte a byte» | `fail()` es determinista (`server/http-util.ts:66-73`); los encabezados llevan `Date` | Se escribe «mismo status y mismo cuerpo» |
| **m14** · la medición contra 0.41.0 tropieza con el gate de época | `SqliteEpochFencedError` (`packages/capabilities/src/sqlite.ts:147`) | El paso 2 abre el archivo con una época ≥ la registrada, leída antes en modo `read`, y separa en el reporte un fence de un fallo de esquema |
| **m15** · orden del `forbidden` y del hash | — | El paso 6 fija el orden: 409 de standby → leer los bytes crudos (tope 16 KiB) → `paramsSha256` sobre ellos → rol → `forbidden` → parsear. Un cuerpo malformado de un no-admin da `forbidden`, no `rejected` |
| **i7** · el rol se resolvía dos veces | — | Una sola llamada a `piManagementRole` por petición; de ella salen `canOpen` y «gestor» |
| **i8** · precedente contrario del journal del contrato | `server/contract.ts:476, 509`: «un 403 JAMÁS escribe el journal» | Citado en §«¿Qué queda en el log?», junto al porqué de la diferencia |
| **i9** · la cadena es por proceso | `log.ts:25-27` | Dicho en §«¿Qué queda en el log?» y en el paso 6 |
| **i10** · el test de la siembra cambia de signo | — | Paso 7a: un spec no servible queda `especializado` con su motivo |
| Nuevo, del autor · sin store de gobierno no hay ciclo de vida | Sin store, `piManagementRole` devuelve `owner` para todos (`serve-rls.ts:1200`) y la tabla no existe | **(decidido)** Sin store de gobierno, todo Let se trata con la regla de siembra virtual (servible → `activo`, solo parseado → `especializado`), que es lo que el nodo hace hoy, y `status` dice «ciclo de vida no disponible: sin store de gobierno». La API responde 503 |
| **P-1, P-3, P-4** | Decisiones de César, 2026-09-30 | Pasan a §«¿Qué decidió César?»; se quitan los 🙋 del cuerpo |
| **P-2** | César: «de acuerdo con terminal, pero debe existir otro reversible, ¿no crees?» | Los dos jueces y el mantenedor responden que el reversible ya existe y es `deactivate` (la hibernación del canon, línea 1293). Se **propone** `--replaced-by` opcional en `deactivate`, para que la página 503 apunte al sucesor sin cerrar el código. 🙋 Pendiente de confirmar con César |

## ¿Qué cambió por el primer juicio?

Cada hallazgo del acta de la v1.0, re-verificado contra el código en `ee31be9` antes de resolverlo. El segundo juicio los dio a todos por cerrados; lo que quedó a medias (M1, M5) se resuelve en la tabla de arriba.

| Hallazgo | Re-verificación | Resolución en esta versión |
|--|--|--|
| **B1** · el gate de ciclo de vida iba antes de `canOpenPi`: filtraba existencia y metadatos de PIs privados; y el paso 3 (`served()`) contradecía el 4 (existencia) | Confirmado: hoy el router va existencia (`routes.ts:426`) → `piBlocked` (`:427-428`) → `canOpenPi` (`:430-433`); el PDF igual (`:388-392`). `canOpenPi` usa solo `report.code` (`serve-rls.ts:1314-1315`) | Orden fijo **(decidido)**: existencia sobre `lets()` → `canOpenPi` → rol de gestión → ciclo de vida → `piBlocked`. Quien no pasa `canOpenPi` recibe **el mismo 403 de hoy, byte a byte**, en todo estado. El router usa `lets()` para existencia y `served()` solo para índice y conteos. Control negativo con una identidad sin acceso en el paso 4. §«¿En qué orden decide el router?» |
| **B2** · la siembra y la guarda asumían un store que no es el real (modo `read` sin control; `SCHEMA_VERSION`) | Confirmado: `storeControl()` abre en `read` sin control (`serve-rls.ts:372-376`); un persist en `read` se ignora (`sqlite.ts:375-383`); `reabrirStores()` reabre con el modo del instante (`serve-rls.ts:2979-2990`), llamado en el relevo (`:3080-3088`); `SCHEMA_VERSION = 1` (`governance-store.ts:74`); convención aditiva en `CHANGELOG.md:174, 439, 496` | Paso 2: migración **aditiva**, `CREATE TABLE IF NOT EXISTS`, **no** sube `SCHEMA_VERSION`, medida abriendo y escribiendo el archivo migrado con **0.41.0**. Paso 7a: la siembra cuelga de **tener el store en escritura** (arranque con control, `serve-rls.ts:403`, y relevo, `:3082`), con test que arranca sin control y verifica cero filas antes del relevo. §«¿Cómo convive con el plano de control?» |
| **M1** · `smoke` y `marks` iban a sondear Lets no activos | Confirmado: `smoke.mjs:43-60` inventaría del directorio en disco y reconcilia con `lets.total` (`:94-99`) | Paso 8b: `smoke` toma el estado de `/contrato` `lets[]` y sondea solo `activo`; `marks ruta` de un Let no activo sale «no corrí». Control negativo incluido |
| **M2** · `retire` como `destructive` arrastra la ceremonia de corte | Confirmado: `CUTTING` (`classify.mjs:15`); `gate()` mide con poller en clases que cortan (`exec.mjs:23-26`); `enforceGate` exige `--impact` con `approval` y poller con `window` (`classify.mjs:85-102`) | **(decidido)** `retire` se queda `destructive` y **hereda la ceremonia entera, a propósito**: `--approval` o `--window`, `--impact` siempre, poller si el gate es `window`. Más la custodia del nodo: solo admin, motivo y confirmación tecleando el código. §«¿Qué ceremonia tiene `retire`?» |
| **M3** · el log se apartaba del no-repudio del canon | Confirmado: canon 1117 y 1716; el log es file-only (`serve-rls.ts:1695-1698`), sin coste de RAM | Toda invocación de la API se registra con `result`: `changed` · `noop` · `rejected` · `forbidden`. El paso 6 lo prueba con el 403 **escribiendo** una entrada `forbidden`. El motivo se guarda en texto y se declara la desviación de la línea 1718 con su porqué. §«¿Qué queda en el log?» |
| **M4** · P11 usaba el `\b` ciego que P2 denuncia | Confirmado: `git grep -n "new Botler" -- server packages` → `packages/cli/src/run.ts:137` | P11 reescrita con la búsqueda sin `\b`: la clase se instancia en el CLI, no en el servidor |
| **M5** · la guarda de vuelta atrás vivía solo en el CLI | Confirmado: `cmd_rollback` delega en `cmd_promote` (`botler-rollout:887-900`); `lets_block` y `serving_ok` ya parsean `/healthz` (`:231-255`) | Paso 7b: la guarda vive en **`botler-rollout`** (`cmd_promote`), leyendo las claves planas nuevas de `lets`; el CLI la hereda. Control negativo en `tests/deploy-anillos.test.ts` con `fake-docker.sh` |
| **M6** · la siembra desde `discover()` dejaba fuera los specs no servibles | Confirmado: `discovery.ts:152-177` hace `continue` antes de agregar | La siembra toma los códigos **parseados** (antes del gate de servibilidad). Consecuencia declarada en el CHANGELOG. Paso 3 y paso 7a. **El segundo juicio (B3) refinó el estado:** lo no servible entra `especializado`, no `activo` |
| **m1** · forma de la `Report` de un Let sin spec | `canOpenPi` y `piManagementRole` solo leen `code` (`serve-rls.ts:1200-1205, 1314-1315`) | Forma mínima fijada en el paso 3 (`LetRef`), con `specPath: null` y `name` desde la tabla |
| **m2** · «se siembra al descubrirlo» era inexacto | Confirmado: `bootstrapPi` es perezoso (`serve-rls.ts:1200-1218`) | Frase corregida en la tabla de datos |
| **m3** · cadena de `replacedBy` | — | `replacedBy` debe apuntar a un Let no retirado al retirar, y la página 410 resuelve la cadena al servirse, con tope y guarda de ciclo |
| **m4** · dos promesas sin paso (Miranda y enlaces del menú) | `writeSpec` de Miranda: `serve-rls.ts:2734-2737`; menú en la config de instancia (`VERGIS_MENU`, `instance-config.ts:202`) | Paso 3b (Miranda se niega) y paso 5 (`/contrato` publica los enlaces del menú que apuntan a cada Let) |
| **m5** · el paso 4 usaba páginas que construía el 9 | — | El paso 4 entrega las páginas mínimas (texto); el 9, la superficie |
| **m6** · `/healthz` con cero Lets activos | `serving_ok` (`botler-rollout:245-255`): `total=0, serving=0` satisface el predicado | Declarado en el paso 5 como coherente, con el porqué; claves nuevas **planas** dentro de `lets` |
| **m7** · el CHANGELOG solo nombraba «quitar el spec» | — | El paso 10 nombra también el cambio de `identity.code` y la publicación que borra un archivo |
| **m8** · impresiones compartidas de un Let retirado | `CAP-80`, `CAP-82` | Escrito con esas palabras en la tabla de datos: `retire` no revoca lo ya compartido |
| **i1** · filtración preexistente de `piBlocked` antes de `canOpenPi` | Confirmado (`routes.ts:427-428`) | El orden de B1 la cierra: `piBlocked` pasa después de `canOpenPi`. Declarado en el CHANGELOG |
| **i3** · el CAS en `sql.js` prueba lecturas rancias entre `await`s, no procesos | — | Dicho en el paso 2 |
| **i2, i4, i5, i6** | — | Sin cambio: confirman lo escrito |

## ¿Qué premisas se verificaron?

Medidas el 2026-09-30 contra `origin/main` en `ee31be9` (0.41.0) y contra el manifiesto unificado de la trilogía (AgencyDomains v1.2). Toda búsqueda de ausencia usa `git grep -w` o `-P`, nunca `\b` con `-E` (ver P2).

| # | Premisa | Estado | Evidencia |
|--|--|--|--|
| P1 | El Producto no implementa `activate`, `deactivate` ni `retire` para un Let | ✅ | `git grep -n -i -w -E "activate\|deactivate\|retire\|retired" -- server packages plugins deploy`: todas las líneas son del retiro de archivos de carga o de anillos (P3). `git grep -i -w -E "lifecycle\|inactivo\|retirado\|especializado"` tampoco encuentra un Let |
| P2 | El comando de verificación del encargo (`git grep -i -E "\b(activate\|deactivate\|retire)"`) prueba la ausencia | ❌ **instrumento ciego** | En esta máquina (`git 2.50.1 Apple Git-155`) `\b` no funciona en el ERE de `git grep -E`: `git grep -c -i -E "\bretire" -- server` devuelve **0**, y `git grep -c -i -w "retire" -- server` devuelve **4 archivos** |
| P3 | La palabra `retire` ya tiene dos acepciones en el Producto | ✅ | (a) Retirar un archivo de una casilla de carga: `server/admin.ts:2210-2214` (audit `intake-retire`), `server/admin-cargas.ts:115`, `server/cargar.ts:836-842`. (b) Retirar un anillo: `deploy/rollout/botler-rollout` (`cmd_retire`, `:937`), `CAP-141` en `docs/capacidades.md:279`, `vergis-ops exec rollout retire` |
| P4 | El canon nombra los verbos pero no define su semántica | ✅ | `grep -n -i -E "activate\|deactivate\|retire"` sobre el manifiesto: solo las líneas 1391 y 1395 |
| P5 | El nodo descubre los Lets releyendo los specs; un spec que aparece se sirve y uno que desaparece deja de existir (404) | ✅ | `server/serve-rls.ts:456-458` (`specPaths()`: `*.ya?ml` del nivel superior de `VERGIS_SPECS_DIR`, o la lista `VERGIS_SPECS`); `server/discovery.ts:104-190`; `server/routes.ts:426` |
| P6 | El hot-reload de specs existe y lo declara el contrato | ✅ | `server/serve-rls.ts:3588-3603` |
| P7 | La desaparición de un spec no deja rastro en el log append-only | ✅ | `serve-rls.ts:3594-3597` registra solo un conteo en `/contrato`. `git grep -n -E "type: '(spec\|pi\|let)[-a-z]*'" -- server packages` → solo los `pi-governance-write` de `server/pi-config.ts` |
| P8 | `/healthz` cuenta como `lets.total` a todo Let descubierto, y el predicado canónico exige `lets.serving == lets.total` | ✅ | `serve-rls.ts:1409-1422`; `server/routes.ts:174-190`; `CAP-177`; `botler-rollout:245-255` (`serving_ok`) |
| P9 | El gobierno por PI vive en `governance.sqlite`, indexado por `pi_code`, con precedente de estado por PI editable en caliente y auditado | ✅ | `packages/capabilities/src/governance-store.ts:777-812`; renombre #207 en `server/pi-config.ts:120-130` y `serve-rls.ts:465-471, 1668-1680`; pausa de procesos en `governance-store.ts:1344` (`paused_at`) |
| P10 | Existe un log append-only encadenado por hash, file-only, y el nodo lo usa para los actos de gobierno | ✅ | `packages/botler/src/log.ts:9-50`; `serve-rls.ts:1695-1698`; `CAP-159` |
| P11 | La clase `Botler` no se instancia en el **servidor** | ✅ | `git grep -n "new Botler" -- server packages` → un único resultado, `packages/cli/src/run.ts:137`, que es el CLI `vergis run`, no el nodo. El servidor usa `AppendOnlyLog` directo (`serve-rls.ts:1697`, `server/consola.ts:99`) |
| P12 | El menú de la instancia (`VERGIS_MENU`, el `menu.yaml` de CLI) no lista PIs: sus enlaces los declara la instancia | ✅ | `server/menu-config.ts:1-12` |
| P13 | `pi-owners.yaml` (`VERGIS_PI_OWNERS`) solo siembra el gobierno de un PI, y lo hace **perezosamente** en su primer acceso | ✅ | `server/instance-config.ts:226`; `serve-rls.ts:1200-1218` (`bootstrapPi` si no hay `pi_governance`), `:1689` |
| P14 | Los comentarios se anclan a la entidad (cruzan PIs) y las impresiones al slug del PI | ✅ | `docs/capa-de-notas.md:24-29, 64`; `packages/capabilities/src/notas-store.ts:253-255` |
| P15 | Vocabulario cerrado de clases; un gate sin declarar vale `approval`; las clases que cortan exigen impacto y, con `window`, poller | ✅ | `plugins/vergis/lib/classify.mjs:11-15, 85-102`; `exec.mjs:23-26` |
| P16 | `vergis-ops` habla con el nodo desde dentro del anillo, forjando la identidad | ✅ | `smoke.mjs:5-7, 29-33`; `contract.mjs:24-25`; `health.mjs:17` |
| P17 | Un nodo en espera rechaza toda mutación con 409 | ✅ | `CAP-178`; `serve-rls.ts:1428-1431` |
| P18 | El store de gobierno es un archivo compartido entre anillos; **sin control se abre en lectura** y un persist se ignora; al relevar se reabre en escritura; tiene gate de esquema | ✅ | `serve-rls.ts:1571` (`${OUT}/governance.sqlite`); `serve-rls.ts:372-376` (`storeControl`); `packages/capabilities/src/sqlite.ts:88-92, 375-383` (persist ignorado en `read`), `:128-145` (`SqliteSchemaTooNewError`); `serve-rls.ts:2964-2990` (`embeddedStores`, `reabrirStores`), `:3080-3088` (relevo), `:403` (`CONTROL_AL_ARRANCAR`); `governance-store.ts:74` (`SCHEMA_VERSION = 1`) |
| P19 | La casa migra el store de gobierno de forma aditiva sin subir `SCHEMA_VERSION`, y mide el rollback abriendo el archivo migrado con la versión anterior | ✅ | `CHANGELOG.md:174` («La migración es **aditiva** y no sube `SCHEMA_VERSION`… una versión anterior abierta sobre el archivo migrado (rollback) sigue escribiendo»), `:437-440` («0.34.0 abre y escribe el archivo migrado (medido)»), `:496` |
| P20 | Los Lets de otras familias pasan por el mismo router y los mismos gates | ✅ | `server/routes.ts:417-437` |
| P21 | Hay entregas programadas por PI que habría que suspender | ❌ | `grep -c -i -E "slug\|piCode" server/notify.ts` → 0. El único envío periódico, `ReportSchedule` (`notify.ts:105-113`), no nombra PIs. Lo único por PI en segundo plano es la **demanda de frescura** (`serve-rls.ts:2058-2068`) |
| P22 | El plugin `mira` existe | ❌ | `ls plugins/`: solo `vergis` |
| P23 | El nodo expone un servidor MCP | ❌ | `git grep -l -i "mcp" -- server packages`: 0 resultados |
| P24 | `discover()` tiene 33 usos en el servidor | ✅ | `git grep -n "discover()" -- server \| wc -l` → 33 |
| P25 | `smoke` inventaría los Lets desde el disco y los reconcilia con `lets.total` | ✅ | `plugins/vergis/lib/smoke.mjs:43-60, 94-99` |
| P26 | `botler-rollout rollback` pasa por `cmd_promote`, y la herramienta se corre también directo en el host | ✅ | `botler-rollout:887-900`; `deploy/rollout/RUNBOOK.md:156`; `deploy/rollout/README.md:82` |
| P27 | Miranda publica escribiendo el archivo del spec en el directorio | ✅ | `serve-rls.ts:2734-2737` (`writeSpec`) |
| P28 | `/contrato` es superficie de administración, y el plugin ya la lee con una identidad admin | ✅ | `server/contract.ts:495-507` (403 sin rol admin); `plugins/vergis/lib/contract.mjs:10, 23, 88-91` (`VO_ADMIN` = `RINGS_ADMIN_EMAIL`) |
| P29 | El plugin no pasa flags arbitrarios a `botler-rollout`, y rechaza a propósito los que re-exponen | ✅ | `plugins/vergis/lib/rollout.mjs:97-99` (solo `--timeout`; `--no-schema-gate` «no se ejerce desde el plugin») |
| P30 | `admin-audit.log` está en el volumen compartido por los anillos, y su cadena empieza de cero en cada proceso | ✅ | `deploy/compose.reference.yml:107, 151`; `packages/botler/src/log.ts:25-27` (`seq = 0`, `prevHash = GENESIS`, sin retomar el archivo) |
| P31 | Un candidato que queda `degraded` al tomar el control hace abortar `botler-rollout promote` | ✅ **medido** | §«¿Qué se midió para este diseño?» |
| P32 | `piManagementRole` resuelve el rol y siembra el gobierno si falta; sin store devuelve `owner` | ✅ | `serve-rls.ts:1199-1206`; `canOpen = r != null` en `packages/capabilities/src/pi-authz.ts:56` |

## ¿Qué se midió para este diseño?

**La corrida que habría refutado B3** (Norma 7), hecha por el autor el 2026-09-30 sobre `ee31be9`, sin commitear código:

- **Instrumento.** Una copia de `tests/fixtures/anillos/fake-docker.sh` con dos cambios: (a) un campo `on_control` por contenedor: al tomar el control, el contenedor pasa a esa fase en vez de `serving`; (b) el relevo continuo del mundo falso reconoce como dueño del control a un contenedor `degraded`, no solo a uno `serving`. Sin (b), el mundo falso le devolvía el control al anillo viejo y la promoción abortaba por **otro** camino («el control lo tomó '0.41.0'»): el instrumento modelaba «tener el control» como «estar `serving`», que en el nodo real no es cierto. Se corrigió antes de creerle.
- **Test.** Una copia del arnés de `tests/deploy-anillos.test.ts` con dos casos: instalar y promover 0.41.0, instalar 0.42.0 y promoverlo.
- **Resultado.**
  - Control, candidato sin `on_control`: `promote` sale **0**, el borde apunta a `vergis-0-42-0`.
  - B3, candidato con `on_control=degraded`: `promote` sale **1**, con «el candidato NO llegó a 'serving' (fase: degraded). El borde YA apunta a él…» y «promoción ABORTADA en el handover. El borde volvió a apuntar a 'vergis-0-41-0'»; el registro queda con `active: 0.41.0`.
- **Conclusión.** El mecanismo de B3 es real: un candidato que el relevo deja `degraded` no puede promoverse. La siembra por servibilidad (paso 7a) lo evita porque sembrar no cambia los conteos (invariante del paso 7a). El knob `on_control` entra al fixture en el paso 7c como regresión permanente.
- **Artefactos** (fuera del repo): el diff del fixture y el test, en el scratchpad de la sesión que escribió este diseño. El paso 7c los reproduce dentro del repo.

## ¿Qué dice el canon?

Fuente: el manifiesto unificado de la trilogía, parte AgencyDomains v1.2 (`agencydomains-org/twin/src/trilogia/_dist/Trilogia-MundoAgentivo-agentes-es.md`). Se cita por línea.

**Los verbos, sin definición** (línea 1391):

> «**Configurar el spec es operar**: para un platafórmico el spec es el input operacional. El agente evoluciona el spec **operando** (verbo `specialize`); la **cristalización** a registro versionado **sigue, no precede**; la proveniencia la da el append-log. **Verbos del API de operación**: `specialize` · `invoke`/`schedule` (discreta) · `read`/`subscribe` (continua) · `status`/`activate`/`deactivate`/`retire`.»

**Los estados que el canon enumera** (línea 1395, la prueba de vida):

> «**vida** — ¿tiene ciclo de vida que gestionar (activo · caído · degradado · retirado; `status`/`activate`/`deactivate`/`retire`; madurez) o solo una versión? Un `PI` pasa las tres → Botlet; Mira es el proto-Botlet (el motor)…»

**De quién es el ciclo de vida** (línea 1096):

> «**El Botler es genérico por definición (MUST)**: gestiona ciclo de vida, aislamiento y ejecución de *cualquier* Botlet **sin entender su dominio**.»

**Dónde se valida** (línea 1098):

> «Invoca el punto de validación que el tipo (o su proto-Botlet en G1) provee, le entrega el **contexto genérico** que controla (catálogo de Capabilities, identidad, políticas del AgencyDomain) y actúa sobre el veredicto — acepta, rechaza, registra en el append-only log.»

**Las dos superficies** (líneas 1388-1389): el ciclo de vida del **código fuente** es «Nivel-Botler», cadencia «Releases (Producto)»; la **operación** —«Especializar/manifestar/consumir/controlar cada Botlet»— es «Por-Botlet», cadencia «Fluida (Instancia)».

**Las propiedades de la Capa 4** (líneas 1117-1119): «**No-repudio** — toda acción registrada con identidad, contexto y resultado» · «**Reversibilidad cuando aplica**» · «**Política antes de ejecución** — la política se evalúa **antes**, no después».

**El log** (líneas 1716-1718): «Registro inmutable, encadenado criptográficamente, de toda acción… **Contenido mínimo de cada trace**: identidad del agente, capability invocada, tool ejecutado, **hash de parámetros y resultado** (no el contenido crudo — los datos sensibles viven en almacén separado con su propia política de retención), timestamp, contexto, y `previous_log_hash`». Y (línea 1365): «el append-only log **MUST** registrar el proto-Botlet de origen de cada Botlet instanciado».

**Una analogía, no una norma sobre Lets** (líneas 1287-1294): la sexta fase del ciclo de vida del **agente**: «**Decommissioning** — … "decommissioned" ≠ "olvidado": el registro permite reconstruir auditablemente que el agente existió, qué hizo y por qué dejó de existir.» Se usa aquí solo como criterio para `retire`.

**Lo que el canon no dice** (buscado con `grep` sobre el manifiesto entero): no define el efecto de ninguno de los cuatro verbos, no da una máquina de estados del Let, no nombra un estado «inactivo» ni «especializado», y no dice si `retire` es reversible. Se interpreta —y es interpretación— que la lista de la línea 1395 **mezcla dos ejes**: `activo` y `retirado` se **declaran**; `caído` y `degradado` se **observan**. Este diseño los separa y los compone en `status`.

## ¿Qué significa cada verbo?

### ¿Cuáles son los dos ejes del estado de un Let?

| Eje | ¿Quién lo fija? | Valores | ¿Dónde se ve? |
|--|--|--|--|
| **Ciclo de vida** (declarado) | Un acto con actor y motivo (`activate` · `deactivate` · `retire`), el alta implícita al descubrir un spec nuevo, y la siembra de la migración | `especializado` · `activo` · `inactivo` · `retirado` | `status`, `/contrato`, la configuración del PI |
| **Salud** (observada) | El nodo, en cada verificación | `sirviendo` · `bloqueado` (con motivo: `piBlocked`, `serve-rls.ts:1399-1408`, o no servible en el descubrimiento) · `sin-spec` (el archivo no está o no parsea) · `pendiente` | `status`, `/contrato`, `/healthz` (solo conteos) |

`status` devuelve **los dos**. El `caído` y el `degradado` del canon son un `activo` cuya salud no es `sirviendo`. **(decidido)**

La identidad del Let es su `identity.code` (el mismo `pi_code` que ya indexa el gobierno, P9). El slug se deriva de él y no cambia (`discovery.ts:228-230`).

### ¿Cuál es la máquina de estados?

```
                  spec nuevo descubierto
                          │  (alta implícita; queda en el log)
                          ▼
                   ┌──────────────┐   retire    ┌────────────┐
                   │ especializado├────────────►│            │
                   └──────┬───────┘             │            │
                 activate │                     │            │
                          ▼                     │            │
                   ┌──────────────┐   retire    │ retirado   │
          ┌───────►│    activo    ├────────────►│ (terminal) │
          │        └──────┬───────┘             │            │
 activate │    deactivate │                     │            │
          │               ▼                     │            │
          │        ┌──────────────┐   retire    │            │
          └────────┤   inactivo   ├────────────►│            │
                   └──────────────┘             └────────────┘
```

| Desde \ verbo | `activate` | `deactivate` | `retire` |
|--|--|--|--|
| `especializado` | → `activo`, **si** el punto de validación acepta | ❌ 409 «no está activo: nada que desactivar» | → `retirado` |
| `activo` | 200 «ya estaba activo» (`noop`) | → `inactivo` | → `retirado` |
| `inactivo` | → `activo`, **si** el punto de validación acepta | 200 (`noop`) | → `retirado` |
| `retirado` | ❌ 409 «retirado es terminal» | ❌ 409 | 200 (`noop`) |

Todas las celdas, incluidas las de `noop` y las de 409, dejan una entrada en el log (§«¿Qué queda en el log?»).

**El punto de validación de `activate`** (canon, línea 1098): el nodo exige que el Let tenga spec, que parsee bajo su proto, que su familia esté registrada y que pase el gate de servibilidad del descubrimiento (`discovery.ts:147-177`). Si no, 409 con el motivo. Un Let activado nace, en `fabric`, en salud `pendiente` hasta su verificación por PI —el fail-closed que ya existe (`serve-rls.ts:1399-1407`)—. `activate` no espera la verificación: la dispara. **(decidido)**

**Transiciones que no pasan por un verbo** **(decidido)**:

| Hecho | Efecto |
|--|--|
| Aparece un spec parseable con un código que el nodo nunca vio | Alta en `especializado` (P-1, decidido por César), con entrada `let-lifecycle` `from: null` |
| Desaparece el spec de un Let `activo` | El estado **no cambia**; la salud pasa a `sin-spec`; `/healthz` lo cuenta como no servido y el nodo degrada (P-4, decidido por César) |
| Desaparece el spec de un Let `inactivo` o `retirado` | La salud `sin-spec` se ve en `status`, sin degradar el nodo |
| Aparece un spec cuyo código está `retirado` | **No se sirve.** Aviso nombrado en el log de arranque o recarga y en `/contrato`: «el código X está retirado desde F; usar otro `identity.code`» |
| Un spec cambia su `identity.code` | Para el nodo son dos Lets: el código viejo queda `sin-spec` en su estado, el nuevo nace `especializado`. Si el viejo estaba `activo`, es el mismo caso que borrar su spec (P-4) |

### ¿En qué orden decide el router?

Para toda ruta de un Let —`/<slug>`, `/<slug>/…` (Daftar incluido), `/<slug>/pdf`, `/<slug>/comentarios`, `/<slug>/imprimir`, `/<slug>/notas`, `/<slug>/config`— el orden es uno solo **(decidido)**:

1. **Existencia, sobre `lets()`.** Un código que el nodo no conoce ni por spec ni por fila → 404, como hoy.
2. **Rol, una sola vez.** `piManagementRole(code, user)` (`serve-rls.ts:1199-1206`) se llama **una** vez por petición, y de su resultado salen los dos veredictos: `puedeAbrir` = `canOpen(rol)` con `VERGIS_PI_ACL` encendido, o verdadero con la ACL apagada (lo mismo que hace `canOpenPi`, `serve-rls.ts:1314-1315`); y `esGestor` = `canCollaborate(rol)`. Sin store de gobierno, el rol es `owner` para todos (`:1200`) y no hay ciclo de vida (§«¿Cómo convive con el plano de control?»).
3. **`especializado` y no gestor → 404**, con el mismo status y el mismo cuerpo que un código inexistente. Va **antes** del 403 a propósito: para quien no es gestor, un `especializado` no existe, tenga o no acceso. Sin esta regla, quien no tiene acceso recibiría 403 («existe») y el consumidor con acceso 404 («no existe»): el que tiene menos derechos aprendería más.
4. **`puedeAbrir` falso → el 403 de hoy**, con el mismo status y el mismo cuerpo en todo estado (`fail()` es determinista, `server/http-util.ts:66-73`; solo el encabezado `Date` varía): sin fecha, sin motivo, sin dueño, sin sucesor. El 403 ya revela hoy que el código existe; el ciclo de vida no revela nada más. Quien no tiene acceso se detiene aquí en todo estado, así que tampoco la latencia distingue estados.
5. **Ciclo de vida:** la tabla de abajo.
6. **`piBlocked`:** 503 con motivo, como hoy, pero ahora solo para quien pasó el paso 4.

«Consumidor» es quien pasa el paso 4. «Gestor» es el dueño o colaborador del PI o un admin de plataforma (`isAdmin` devuelve `owner`, `serve-rls.ts:1204`). Con `VERGIS_PI_ACL` apagado, todo usuario autenticado es consumidor: es la conducta que esa instalación ya eligió.

Consecuencia que se declara: el paso 6 después del 4 cierra una filtración que existe hoy (el motivo de un PI bloqueado se le mostraba a quien no tenía acceso, `routes.ts:427-428`).

### ¿Qué ve cada quien en cada estado?

| | `especializado` | `activo` | `inactivo` | `retirado` |
|--|--|--|--|--|
| Índice `/` (catálogo) | No aparece | Aparece (como hoy) | No aparece | No aparece |
| Sin acceso (paso 4) | **404** de código inexistente (paso 3) | 403 de hoy | 403 de hoy | 403 de hoy |
| Consumidor | **404** idéntico al de un código inexistente | Como hoy | **503** con página: «**Suspendido** desde ‹fecha›. ‹motivo›. Responde: ‹dueño›» y, si hay (🙋 P-2), «Lo reemplaza: ‹enlace al sucesor›» | **410 Gone** con página: «**Retirado** el ‹fecha›. ‹motivo›.» y, si hay, «Lo reemplaza: ‹enlace al sucesor›» |
| Gestor | Se sirve con una franja «Especializado — no visible para consumidores» (vista previa) | Como hoy | Se sirve con una franja «Suspendido — no visible para consumidores» | 410 como el consumidor; la configuración del PI queda legible |
| Enlaces del `menu.yaml` que apunten al slug | El `menu.yaml` no se toca (es de la instancia, P12); el enlace lleva a la respuesta de la fila que corresponda. `/contrato` y `status` avisan de todo enlace del menú que apunte a un Let no `activo` | | | |

**El sucesor (decidido).**

- Al **retirar**, `replacedBy` es opcional y debe nombrar un Let `activo` o `inactivo`. Al **desactivar** (🙋 P-2, propuesta), es opcional y debe nombrar un Let `activo`: se manda a la gente a algo que funciona.
- La página 503 o 410 **resuelve la cadena al servirse**: sigue `replacedBy` a través de Lets `retirado` o `inactivo` (tope de 10 saltos, guarda de ciclo) y **enlaza solo si termina en un `activo`**. Nunca enlaza a un `especializado` ni a un 404.
- Antes de mostrar el enlace, la página comprueba el acceso del visitante **al sucesor** (el mismo veredicto del paso 4, para el código del sucesor). Si no lo tiene, no muestra ni el enlace ni el código.
- La fila del retirado no se edita: su gobierno está congelado. La cadena se resuelve al servir, no reescribiendo filas.

Por qué así **(decidido)**:

- `especializado` responde **404** a todo el que no es gestor, tenga o no acceso, porque para él el Let todavía no existe; decirle «existe pero no está listo» filtraría trabajo en curso.
- `inactivo` responde **503** porque es exactamente «no disponible ahora, volverá», y la página dice por qué y a quién preguntar. Esconderlo tras un 404 repetiría la falla muda que `discovery.ts:80-86` rechaza por escrito.
- `retirado` responde **410** porque es permanente, y la página es el «decommissioned ≠ olvidado» del canon.
- El gestor ve la vista previa de `especializado` e `inactivo` porque es quien verifica antes de activar o repara antes de reactivar.

### ¿Qué pasa con los datos, los permisos y las notas?

| Recurso | `especializado` | `activo` | `inactivo` | `retirado` |
|--|--|--|--|--|
| **Dato del PI** | Mira no tiene dato propio: lee la fuente con RLS. Ningún estado borra nada en la fuente | | | |
| **Gobierno del PI** (`pi_governance`, `pi_grant`, `pi_demanda`, `pi_display_name`) | Se siembra perezosamente en el primer acceso de índice o gestión (`bootstrapPi`, como hoy) y es editable | Editable | Editable | **Se conserva, congelado**: toda escritura en `/<slug>/config` responde 409 «retirado» |
| **Permisos del dato (Custos, `@vergis/policy`)** | Sin cambio: la RLS se ancla a la tabla, no al PI (`CAP-85`). El ciclo de vida no toca políticas ni grants de la fuente | | | |
| **Comentarios** (anclados a la entidad, P14) | Solo el gestor, en la vista previa | Como hoy | Consumidor: 503; gestor: como hoy | 410. **Los hilos no se borran**: siguen visibles desde cualquier otro PI que muestre la misma entidad |
| **Impresiones** (`impresion.pi_slug`) | Solo el gestor | Como hoy | Consumidor: no se imprimen nuevas; las existentes siguen en «Mis impresiones» | No se imprimen nuevas. **`retire` no revoca las impresiones ya hechas ni las ya compartidas** (`CAP-80`): fueron autorizadas al imprimirse y siguen visibles en `/impresiones` hasta su retención (`CAP-82`) |
| **Demanda de frescura** (`serve-rls.ts:2058-2068`) | No demanda | Demanda | **No demanda** | No demanda |
| **Datadoc** («quién lee cada tabla») | No figura | Figura | Figura, marcado «suspendido» | No figura |
| **Miranda** | Lista y edita el spec | Como hoy | Lista y edita el spec | No lo lista; **se niega a publicar** un spec con ese código |
| **`/healthz`** | Fuera de `lets.total` | Dentro | Fuera | Fuera |

### ¿Qué queda en el log?

**Toda invocación que llega al nodo que tiene el control** escribe **una** entrada en `${VERGIS_OUT}/admin-audit.log`, el `AppendOnlyLog` encadenado y file-only de P10, con su resultado **(decidido)**. Es el no-repudio del canon (líneas 1117 y 1716): identidad, contexto y resultado de toda acción, incluidas las que no cambian nada y las que se niegan.

**La excepción, y por qué (decidido): el 409 de un nodo en standby no escribe.** El log vive en el volumen que los anillos comparten y su cadena es por proceso (P30): si el standby escribiera, intercalaría su cadena con la del activo en el mismo archivo, que es un sustrato compartido escrito por dos actores. El nodo que responde 409 no es el que custodia el log; el acto se registra en el activo cuando el CLI reintenta contra él. Es la misma conducta de hoy: los 409 de standby no auditan.

**El orden dentro del handler (decidido):** (1) sin control → 409, sin tocar el log; (2) leer los bytes crudos del cuerpo, con tope de 16 KiB; (3) `paramsSha256` sobre esos bytes; (4) resolver el rol → si no alcanza, entrada `forbidden` y 403; (5) recién entonces parsear el JSON → si no parsea o faltan campos, entrada `rejected` y 400; (6) la máquina de estados. Así un cuerpo malformado de quien no tiene el rol da `forbidden`, no `rejected`.

**Lo que la cadena garantiza, y lo que no.** `AppendOnlyLog` empieza cada proceso en `seq=0` y `prevHash` génesis, sin retomar el archivo (P30): la cadena verifica **por corrida de un proceso**. Es preexistente y este diseño no lo cambia; el paso 6 verifica eso y no afirma más.

**Un precedente de la casa va en el sentido contrario, para otro artefacto:** el journal del contrato «un 403 JAMÁS escribe» (`server/contract.ts:476, 509`). Ese journal es observabilidad de configuración, y un 403 no cambia nada que observar. El `admin-audit.log` es el registro de no-repudio del canon, y ahí el intento denegado es justamente lo que hay que poder reconstruir.

```json
{ "type": "let-lifecycle", "verb": "retire", "let": "PI-12", "proto": "mira",
  "result": "changed", "from": "activo", "to": "retirado",
  "by": "ops@instancia", "via": "vergis-ops", "reason": "Reemplazado por PI-40",
  "replacedBy": "PI-40", "specSha256": "…", "paramsSha256": "…" }
```

| `result` | Cuándo | `from` / `to` |
|--|--|--|
| `changed` | Transición efectiva | Estado de partida y de llegada |
| `noop` | Verbo repetido (celdas 200 de la máquina) | Iguales |
| `rejected` | Transición prohibida (409) o punto de validación que no acepta; lleva `rejection` con el motivo | `to` ausente |
| `forbidden` | La identidad no tiene el rol que el verbo exige (403) | `to` ausente |
| — | Nodo sin control (409) | **No se escribe** |

- `proto` cumple el MUST de la línea 1365.
- `specSha256` fija qué spec estaba en juego sin copiarlo; `paramsSha256` es el hash del cuerpo de la petición, como pide la línea 1718.
- Las transiciones implícitas llevan `by: "nodo"` y `via: "descubrimiento"` o `via: "siembra"`.
- **Desviación declarada de la línea 1718:** el `reason` se guarda en claro además de su hash. Su porqué: el motivo **no es dato sensible** —se le muestra a todo consumidor en la página 503 o 410—, y sin él el log no permite reconstruir «por qué dejó de existir», que es lo que la línea 1294 pide del retiro. El resto del `admin-audit.log` ya guarda valores en claro (`pi-config.ts:129`); acotar el log de la casa a hashes es un cambio transversal fuera de este diseño.

## ¿Dónde vive el estado?

### ¿Qué alternativas hay?

| | Alternativa | A favor | En contra |
|--|--|--|--|
| **A** | Un campo del spec (`lifecycle: inactive`) | Viaja con el spec; visible en el repo del operador | **Mezcla `specialize` con operar el ciclo de vida**. Obliga a cada proto a parsear el campo, y el Botler tendría que entender el spec de cada familia (contra la línea 1096). La siguiente publicación del spec desde el repo del operador reactivaría en silencio. `retire` exigiría conservar el archivo para siempre. Sin actor en el registro |
| **B** | La presencia del archivo en el directorio (lo que hay hoy) | Cero cambio | Solo dos estados. Borrar confunde «suspendido», «retirado» y «se perdió el archivo». Sin actor, sin motivo, sin página para el enlace viejo, gobierno huérfano. Rompe la paridad repo↔VM cada vez que se suspende algo |
| **C** | Un archivo de gobierno de la instalación (`lets.yaml`, recargado en caliente) | Declarativo; revisable en el repo del operador | El actor es «quien publicó». El nodo **no puede** hacer cumplir «retirado es terminal» sin memoria propia. Una API de operación que la Cognición invoque por MCP necesita un verbo imperativo, no editar un YAML |
| **D** | **Una tabla del store de gobierno** (`let_lifecycle`), escrita solo por una API de operación del nodo, con la máquina de estados en `packages/botler` | La forma del canon: verbo imperativo, por-Let, fluido, con proveniencia en el append-log. Actor y motivo por construcción. El nodo hace cumplir las transiciones prohibidas. Sigue el precedente del renombre (#207) y de la pausa de procesos. El spec no se toca | El estado no está en el repo del operador (se mitiga: `/contrato` y `vergis-ops let status --json` lo exportan). Un anillo de una versión anterior no conoce la tabla (se mitiga con la guarda del paso 7b) |

### ¿Cuál se recomienda, y por qué?

**D (decidido).** El criterio de excelencia pide el camino ideal y no el que menos cambia, y el ideal lo describe el canon: el Botler genérico gestiona el ciclo de vida de cualquier Let sin entender su dominio, por un API de operación, con la proveniencia en el append-log. A y B lo contradicen de frente; C no puede sostener la terminalidad de `retire` sin convertirse en D con un archivo delante.

La forma concreta:

- **La máquina de estados es código del Botler**: `packages/botler/src/lifecycle.ts`, pura, sin I/O. Daftar y cualquier familia futura la heredan sin una línea propia.
- **La persistencia es del nodo**: la tabla `let_lifecycle` en el store de gobierno, detrás de un puerto (`LetLifecycleStore`) que `packages/botler` declara y `packages/capabilities` implementa.
- **El nombre de la tabla es genérico** (`let_…`, no `pi_…`) porque el sujeto es el Let; la llave es el `identity.code`.

### ¿Cómo convive con el plano de control?

El store de gobierno no es un archivo que cualquier anillo escriba (P18), y el diseño se apoya en eso **(decidido)**:

- **Solo el anillo con el control escribe.** Sin control, el store está abierto en `read` y un persist se ignora (`sqlite.ts:375-383`). La API de operación responde 409 en standby (P17) **antes** de intentar escribir, así que nunca llega a un persist ignorado.
- **La siembra y el alta implícita escriben solo con el store en escritura.** Se ejecutan en `alTenerElStoreEnEscritura()`, que se llama en los dos puntos donde eso empieza a ser cierto: el arranque con control (`CONTROL_AL_ARRANCAR`, `serve-rls.ts:403`, después de abrir el gobierno) y el relevo, tras `reabrirStores()` exitoso (`serve-rls.ts:3082-3088`). Un standby que descubre un spec nuevo **no** lo da de alta: el alta la hace el activo al descubrirlo, o el standby cuando releve.
- **La siembra es por servibilidad, y nunca cambia los conteos.** Lo que `discover()` deja pasar se siembra `activo`; lo que solo `parsed()` conoce se siembra `especializado`, con `healthReason` = el motivo por el que el descubrimiento lo omite. Es la regla de P-1 aplicada al día uno, y preserva exactamente lo que hoy ve el consumidor: lo servible se sirve, lo no servible da 404. Se descarta sembrar lo no servible como `activo`, porque deja al candidato `degraded` en el relevo y hace abortar la promoción (medido, P31). Se descarta también sembrarlo `inactivo`, porque cambiaría el 404 de hoy por un 503 que revela existencia y motivo.
- **Regla virtual: sin marca de siembra, un código sin fila se trata como la siembra lo dejaría.** Mientras `platform_setting.lets_lifecycle_seeded_at` no exista —un candidato en standby, o un anillo que todavía no releva—, `lets()` le asigna a cada código sin fila el estado que la siembra le daría. Por eso un nodo nuevo responde lo mismo **antes y después** de sembrar, y `/healthz` no cambia en el instante del relevo: la siembra solo persiste lo que ya se estaba respondiendo. Con la marca presente, un código sin fila es un spec nuevo y nace `especializado` (P-1).
- **Sin store de gobierno no hay ciclo de vida.** Si el store no abrió, `lets()` aplica la regla virtual para siempre —que es lo que el nodo hace hoy—, la API de operación responde 503 «ciclo de vida no disponible: sin store de gobierno», y `status` lo dice. Nada se degrada por su ausencia.
- **Un standby lee un snapshot.** Lo abrió en `read` y no ve los cambios del activo hasta reabrir. Es la conducta preexistente de todo el gobierno, y no afecta al consumidor: el borde solo rutea a `phase=serving`, y un standby no lo es.
- **La migración es aditiva y no sube `SCHEMA_VERSION`** (convención P19): `CREATE TABLE IF NOT EXISTS let_lifecycle`. Un anillo 0.41.0 abre y escribe el archivo migrado sin tropezar (se mide en el paso 2), y lo único que hace es **ignorar** la tabla: volvería a servir lo que no está `activo`. Eso lo previene la guarda del paso 7b. Subir `SCHEMA_VERSION` se descarta: un anillo anterior que relevara no podría abrir el store en escritura y el nodo quedaría sin controlador, que es peor que la re-exposición y no tiene guarda posible.

## ¿Qué clase de acto es cada verbo y qué gate le toca?

Vocabulario cerrado del contrato (`classify.mjs:11`, P15). La clase la fija el verbo: estos actos no publican un archivo, así que `classifyPath` no aplica, igual que `service.mjs` fija la suya **(decidido)**.

| Verbo | Clase | Gate en la instalación (`governance.gates`) | Por qué |
|--|--|--|--|
| `status` | `read` | el de `read` | No cambia nada |
| `activate` | `content` | el de `content` | En caliente, sin corte, reversible con un acto (`deactivate`). Es el mismo riesgo que publicar un spec, que ya es `content` |
| `deactivate` | `content` | el de `content` | En caliente y reversible con un acto. **No** es `service-interrupting`: esa clase nombra un corte **colateral** de rutas por recargar un servicio; aquí el corte de **un** Let es el objeto del acto y el Let sale de `lets.total`. El CLI declara el impacto antes de actuar (visibilidad y cuántos grants pierden acceso) |
| `retire` | `destructive` | el de `destructive` | Irreversible por diseño |

### ¿Qué ceremonia tiene `retire`?

**`retire` se queda `destructive` y hereda la ceremonia entera de la clase, a propósito (decidido).** La clase no se elige por cuánto corta sino por si se puede deshacer, y `retire` es el único de los cuatro verbos que no se deshace. Lo que eso significa, por gate (`classify.mjs:85-102`, `exec.mjs:23-26`):

| Gate declarado para `destructive` | Lo que exige `vergis-ops let retire` |
|--|--|
| `approval` (y también si no hay gate declarado) | `--approval "<quién · cuándo · sus palabras>"` de `governance.approver`, y `--impact` |
| `window` | `--window` de `governance.window_approver`, `--impact` **y el poller corriendo**. Aquí el poller no mide un corte del nodo: mide que el retiro **no** lo produjo (`lets.serving == lets.total` se sostiene antes y después, porque el Let sale del total). Es la evidencia de que el acto no tuvo daño colateral |
| `operator` o `free` | Lo decide quien ejecuta; el CLI igual exige `--impact` para dejarlo escrito |

El `--impact` de `retire` se redacta por lo que es: «PI-12 deja de servirse para siempre; N grants y visibilidad V pierden acceso; lo reemplaza PI-40». El CLI lo propone leyendo `/contrato` y el operador lo confirma.

Y el nodo custodia la irreversibilidad **aunque el gate de la instalación sea laxo**, porque la web no pasa por el CLI:

- solo un admin de plataforma puede retirar (P-3, decidido por César);
- `reason` obligatorio;
- el cuerpo trae `confirm` igual al código del Let (en la web, se teclea el código); si no coincide, `rejected`.

## ¿Cómo lo usa `mira:status`?

`mira:status` (diseño 288) deja de responder «no disponible» y usa cuatro verbos nuevos del CLI, genéricos del Botler —por eso bajo el sustantivo `let`, no `mira`—:

| Verbo de `vergis-ops` | Qué hace | Contra qué |
|--|--|--|
| `let status [<slug>] [--json]` | Tabla por Let: código, familia, estado declarado (fecha, actor, motivo), salud observada y avisos (enlace del menú a un Let no activo, código retirado con spec presente, `activo` sin spec) | `GET /contrato` → bloque `lets` |
| `let activate <slug> [--reason <t>]` | Transición a `activo` | `POST /admin/api/lets/<code>/activate` |
| `let deactivate <slug> --reason <t> [--replaced-by <slug>]` | Transición a `inactivo`; el motivo es obligatorio porque lo lee el consumidor. `--replaced-by` (🙋 P-2, propuesta) hace que la página 503 apunte al sucesor sin cerrar el código | `POST /admin/api/lets/<code>/deactivate` |
| `let retire <slug> --reason <t> [--replaced-by <slug>]` | Transición a `retirado`, con la ceremonia de §«¿Qué ceremonia tiene `retire`?» | `POST /admin/api/lets/<code>/retire` |

Cómo corren, siguiendo lo que el CLI ya hace (P16):

- Desde dentro del anillo activo, con la **misma identidad admin que el plugin ya usa para `/contrato`**: `VO_ADMIN` = `RINGS_ADMIN_EMAIL` (P28, `contract.mjs:88-91`), y el `x-gate-token` si la instalación lo usa. No hace falta un campo nuevo en `vergis-ops.json`. El nodo exige que sea admin de plataforma.
- El endpoint es JSON y exige `content-type: application/json` más un encabezado propio (`x-vergis-op: 1`), que un navegador no envía entre sitios sin preflight. Así no hace falta el CSRF de formulario, que el CLI no puede calcular.
- Aplican el gate de su clase antes de llamar, y leen `status` después: el acto se da por hecho solo si `/contrato` muestra el estado nuevo.
- En un nodo en espera responden lo que responde el nodo: 409 nombrando al activo.

`smoke` y `marks` pasan a respetar el estado:

- `smoke` lee el estado de cada Let de `/contrato` `lets[]` **con la identidad admin `VO_ADMIN`** (P28: `/contrato` exige admin, y la identidad de sondeo es un consumidor) y **sondea solo los `activo`, con la identidad de sondeo de siempre**. El inventario de specs en disco se cruza con esa lista, y la reconciliación contra `lets.total` cierra porque los dos cuentan lo mismo. Si `/contrato` no responde, sale «no pude medir», nunca verde. Contra un nodo anterior sin bloque `lets[]`, conserva la conducta de hoy.
- `marks ruta <slug>` de un Let no `activo` reporta el estado y sale «no corrí» (código 2): no hay gráfico que contar.
- Para verificar un `especializado` antes de activarlo, se usa la vista previa con una identidad gestora de `probe_identities`.

La misma API la usa la superficie web: una sección «Ciclo de vida» en `/<slug>/config` y una lista en `/admin/lets`.

**Quién puede cada verbo** (P-3, decidido por César el 2026-09-30): `activate` y `deactivate`, el dueño del PI o un admin de plataforma; `retire`, solo un admin de plataforma. Un colaborador es gestor para la vista previa, pero no ejerce verbos.

## ¿Cómo se implementa?

Los gates del repo (`npm run typecheck`, `npm test`, `npm run build`) corren verdes al final de **cada** paso. Donde dice «control negativo», el test tiene que **fallar** con la línea clave revertida; el ejecutor lo comprueba una vez y lo declara en el PR.

| # | Paso | ¿Cuándo quedó? | Prueba |
|--|--|--|--|
| 1 | `packages/botler/src/lifecycle.ts`: tipos `LetState`, `LetVerb`, `LetResult` (`changed` · `noop` · `rejected` · `forbidden`), la tabla de transiciones y `transition(from, verb) → { to } \| { noop } \| { rejected, motivo }`. Exportado desde `index.ts`. Sin I/O | La tabla del documento y la del código coinciden celda por celda | Test tabular de las 12 celdas. **Control negativo**: `transition('retirado', 'activate')` es `rejected`; si se cambia a `to: 'activo'`, el test falla |
| 2 | Tabla `let_lifecycle(let_code PK, proto, state, name, since, by, reason, replaced_by, spec_sha256, health_reason)` con `CREATE TABLE IF NOT EXISTS` en `governance-store.ts`. **No** sube `SCHEMA_VERSION` (queda en 1). Métodos `getLet`, `listLets`, `setLetState(code, expectedFrom, to, meta)` con compare-and-set sobre `expectedFrom`. Puerto `LetLifecycleStore` en `packages/botler` | (a) El CAS rechaza al segundo escritor. (b) **0.41.0 abre y escribe el archivo migrado** | (a) Test del store: dos `setLetState` desde el mismo `expectedFrom` intercalados entre `await`s; uno gana y el otro recibe `GovernanceConflict`. En `sql.js` esto prueba lecturas rancias dentro de un proceso, no concurrencia entre procesos (la hay una sola por el plano de control). **Control negativo**: sin `WHERE state = ?` gana el segundo. (b) Medición de rollback, como la casa (P19): crear un `governance.sqlite` con la rama; `git worktree add wt/v0.41.0 v0.41.0`, instalar y construir allí; abrir ese archivo primero en modo `read` para leer su época, y luego con el `SqliteGovernanceStore` de 0.41.0 en modo `write` con un proveedor de época **≥** la leída (sin eso salta `SqliteEpochFencedError`, `sqlite.ts:147`, que no es un fallo de esquema); escribir un grant y persistir. Debe abrir sin `SqliteSchemaTooNewError` y el grant quedar en disco. El reporte distingue los dos errores por su `code`. **Control negativo**: con `SCHEMA_VERSION = 2` en la rama, la misma corrida falla con `ERR_SCHEMA_TOO_NEW`. El resultado va al PR y al CHANGELOG; el worktree `wt/v0.41.0` se retira al terminar |
| 3 | Descubrimiento. (a) Se separa el escaneo en dos salidas: `parsed()` —todo spec cuyo proto lo reconoce y parsea, **antes** del gate de servibilidad de `discovery.ts:152-177`, con el motivo de omisión si lo hay— y `discover()` —los servibles, como hoy—. (b) `lets()` = unión de `parsed()` y las filas de `let_lifecycle`, con forma mínima `LetRef = { code, slug, proto, name, specPath: string \| null, lifecycle, health, healthReason? }`; un Let sin spec toma `proto` y `name` de su fila. (c) **Regla virtual** de §«¿Cómo convive con el plano de control?»: sin marca de siembra (o sin store), un código sin fila toma el estado que la siembra le daría; con la marca, `especializado`. (d) `served()` = los `activo` servibles. (e) Se clasifican los 33 usos de `discover()` (P24) con esta regla y la tabla va al PR: **existencia y gates del router** → `lets()`; **índice y conteos** (`healthSummary`, índice) → `served()`; **despacho y render** → el `Report` servible del Let; **gestionar y previsualizar** (`/<slug>/config`, `resolvePi` de notas) → todo menos `retirado`; **frescura** (`serve-rls.ts:2062`) → `served()`; **datadoc** → `activo` + `inactivo`; **Miranda** `listSpecs` y `readSpec` → todo menos `retirado`; **colisión de estáticos** (`:306`, `:3418`) → todos los códigos, incluidos los retirados | Ningún uso de `discover()` queda sin clasificar | Tests de `discovery.ts` con store falso: un `inactivo` sale de `served()` y sigue en `lets()`; un `retirado` sin spec aparece en `lets()` con `specPath: null`; un spec no servible aparece en `parsed()` con su motivo y no en `discover()`; un `retirado` con spec presente no se sirve y emite el aviso. **Regla virtual**: sin marca, un servible sin fila es `activo` y un no servible sin fila es `especializado`; con marca, ambos son `especializado` |
| 3b | Miranda: `writeSpec` (`serve-rls.ts:2734-2737`) parsea el código del contenido con el registro de protos y **se niega** si está `retirado`, con el mensaje «el código X está retirado desde F; usar otro `identity.code`» | Publicar un código retirado no escribe el archivo | Test: `writeSpec` de un código retirado lanza y el directorio no cambia. **Control negativo**: sin la guarda, el archivo aparece |
| 4 | Router (`server/routes.ts`), rutas de página, subrutas, PDF (`:384-392`) y notas: el orden de seis pasos de §«¿En qué orden decide el router?», con **una sola** llamada a `piManagementRole` por petición, y las respuestas de §«¿Qué ve cada quien?». Las páginas 503 y 410 son **mínimas** en este paso (texto con fecha, motivo, dueño y el sucesor resuelto con la comprobación de acceso); su diseño es del paso 9. Escrituras en `/<slug>/config` de un `retirado` → 409 | La matriz estado × {sin acceso, consumidor, gestor} responde como el documento | Un test por celda; se compara **status y cuerpo** (no encabezados: `Date` varía). **Control negativo 1 (B1)**: con `VERGIS_PI_ACL` encendido, una identidad sin acceso pide `/<slug>` de un PI privado `inactivo`: recibe 403 con el mismo cuerpo que el 403 del mismo PI en `activo`, sin fecha, motivo ni dueño; si el ciclo de vida va antes del acceso, recibe 503 con esos datos y el test falla. Lo mismo para `retirado` y para `/<slug>/pdf`. **Control negativo 2 (M7)**: una identidad sin acceso pide un PI privado `especializado` y recibe 404 con el mismo cuerpo que un código inexistente; si el 403 va antes que la regla del `especializado`, recibe 403 y el test falla. **Control negativo 3**: un consumidor pide `/<slug>` de un `inactivo` y un espía verifica que la Capability de serving **no se invocó**. **Control negativo 4 (m12)**: la 410 de un retirado cuyo sucesor es privado no muestra el código del sucesor a quien no tiene acceso a él. Test de conteo: `piManagementRole` se llama una vez por petición |
| 5 | `/healthz`: `lets.total` y `lets.serving` cuentan solo `activo` (un `activo` sin spec o bloqueado cuenta en `total` y no en `serving`). Claves nuevas **planas** dentro del objeto `lets` —`inactive`, `specialized`, `retired`—, presentes **solo cuando son > 0** (el patrón de `stores.degraded`, `routes.ts:181-190`), para que `lets_block` (`botler-rollout:231`, que recorta con `[^}]*`) las lea. `/contrato` gana el bloque `lets[]` `{ code, proto, state, since, by, reason, replacedBy, health, healthReason, menuLinks[] }`, donde `menuLinks` son las entradas de `VERGIS_MENU` cuyo `href` relativo tiene como primer segmento el slug | Con un Let desactivado de N, el predicado `HTTP 200 ∧ phase=serving ∧ lets.serving == lets.total` sigue verdadero | Test de `routes`. **Control negativo**: si `total` sigue contando todos los descubiertos, el predicado da falso y el test falla. Segundo test: un `activo` sin spec degrada (`phase=degraded`, P-4). Tercero: con **cero** Lets activos, `total=0, serving=0`, `phase=serving`; se deja escrito como conducta **coherente**: el nodo está sano y el predicado mide salud, no contenido; un anillo con cero Lets activos es promovible, igual que hoy un nodo con el directorio vacío |
| 6 | API de operación: `POST /admin/api/lets/<code>/{activate,deactivate,retire}` (JSON, `x-vergis-op: 1`), con el orden del handler de §«¿Qué queda en el log?» (409 de standby sin log → bytes crudos con tope → `paramsSha256` → rol → `forbidden` → parseo → máquina). Permisos de P-3, punto de validación en `activate`, `reason` obligatorio en `deactivate` y `retire`, `confirm` en `retire`, `replacedBy` según §«El sucesor». Sin store de gobierno, 503. Toda invocación que llega al nodo con control escribe una entrada `let-lifecycle` con su `result`. El descubrimiento escribe el alta implícita (`via: "descubrimiento"`) solo con el store en escritura | Las entradas tienen los campos de §«¿Qué queda en el log?» y la cadena del proceso verifica | Test de integración: transición (`changed`), repetición (`noop`), prohibida (`rejected`), cadena verificada con `verifyChainLines` sobre las líneas de **este** proceso. **Control negativo 1 (M3)**: un no-admin intenta `retire` → 403 y **exactamente una entrada nueva** con `result: "forbidden"` y su identidad; si el handler corta antes de registrar, no hay entrada y el test falla. **Control negativo 2 (m15)**: el mismo no-admin con un cuerpo que no es JSON → `forbidden`, no `rejected`. **Control negativo 3 (M8)**: con el fixture del plano de control, un `POST …/deactivate` a un nodo **sin control** responde 409 y el archivo `admin-audit.log` **no cambia de tamaño**; si el handler registrara antes del 409, crecería y el test falla |
| 7a | Siembra por servibilidad. En `alTenerElStoreEnEscritura()` (arranque con control, `serve-rls.ts:403`; relevo, `:3082-3088`): si `platform_setting.lets_lifecycle_seeded_at` no existe, todo código de `discover()` sin fila entra `activo` y todo código que solo está en `parsed()` entra `especializado` con `health_reason`; una entrada `via: "siembra"` por Let; se escribe la marca. Desde la marca, los códigos nuevos nacen `especializado` (P-1) | Una instancia existente, al quedar con el control en la versión nueva, sirve exactamente los mismos PIs que antes, y **sembrar no cambia `/healthz`** | Test con el fixture del plano de control (`tests/store-reopen-relevo.test.ts`, `tests/standby-control.test.ts`), con dos specs servibles y uno no servible: el nodo arranca **sin control** → **cero filas y sin marca** leídas del archivo (control negativo: si la siembra corre al arrancar, las filas aparecen o se pierden en el persist ignorado, y el test lo detecta); su `/healthz` ya dice `total=2, serving=2` (regla virtual). Luego releva → filas `activo` para los dos servibles y `especializado` para el no servible, con su motivo, y marca presente, leídas del archivo; `/healthz` **idéntico** al de antes del relevo. **Control negativo (B3)**: si el no servible se siembra `activo`, `/healthz` pasa a `total=3, serving=2, phase=degraded` y el test falla |
| 7b | Guarda de vuelta atrás **en `botler-rollout`** (`cmd_promote`, que también sirve a `cmd_rollback`, P26). Antes del flip: si el `/healthz` del anillo activo trae `inactive`, `specialized` o `retired` > 0 en `lets`, el del anillo destino debe traer las mismas claves con los mismos valores; si no, se niega nombrando los conteos, salvo `--acepto-reexponer`. Un destino sin ciclo de vida no trae las claves; uno con snapshot rancio puede traer menos, y se niega igual: la guarda falla hacia el lado seguro. **El plugin hereda la negativa y no el override**: `vergis-ops exec rollout` no ejerce `--acepto-reexponer`, con el precedente y la redacción de `rollout.mjs:99` —«re-exponer un Let suspendido o retirado es decisión del operador a mano, con `botler-rollout`, gritándola en pantalla»— | Un rollback a un anillo sin ciclo de vida, con un Let inactivo, no hace el flip, ni desde la herramienta ni desde el plugin | Test en `tests/deploy-anillos.test.ts` con `fake-docker.sh` (su `healthz_body` gana un campo por contenedor para las claves de `lets`): activo con `"lets":{"total":2,"serving":2,"inactive":1}`, destino con `"lets":{"total":3,"serving":3}` → `rollback` sale con error y no escribe `active.caddy`. **Control negativo**: sin la guarda, el flip ocurre y el test falla. Con `--acepto-reexponer`, `botler-rollout` procede y lo grita. Test del plugin: `vergis-ops exec rollout rollback --acepto-reexponer` sale «no corrí» sin llamar a la herramienta |
| 7c | Regresión permanente de B3 en el fixture de anillos: `fake-docker.sh` gana el campo `on_control` (la fase que toma un contenedor al tomar el control; por defecto `serving`) y su relevo continuo reconoce como dueño del control a un contenedor `degraded`, no solo a uno `serving` (los dos cambios de §«¿Qué se midió para este diseño?») | La suite de anillos distingue un candidato que queda `degraded` de uno que queda `serving` | Test en `tests/deploy-anillos.test.ts`: candidato con `on_control=degraded` → `promote` sale distinto de 0 y `active.caddy` vuelve al anillo previo; sin `on_control` → sale 0. Es la corrida que midió B3, dentro del repo. **Control del instrumento**: sin el cambio del relevo continuo, el aborto sale por el camino equivocado («el control lo tomó…») y el test afirma el mensaje «NO llegó a 'serving'», así que falla |
| 8 | CLI: `vergis-ops let status\|activate\|deactivate\|retire` con su clase fija, el gate de la instalación, la ceremonia de `retire`, la identidad admin `VO_ADMIN` = `RINGS_ADMIN_EMAIL` (sin campo nuevo en `vergis-ops.json`) y la verificación posterior contra `/contrato` | `let retire` sin su evidencia no llama al nodo | Test en `deploy/rollout/bench/scripts/plugin-e2e.sh`: `let deactivate` + `let status` muestra `inactivo`; `let activate` lo devuelve. **Control negativo**: `let retire` con gate `approval` sin `--approval` sale «no corrí» y el log del nodo no tiene entrada nueva |
| 8b | `smoke` y `marks` (§«¿Cómo lo usa `mira:status`?»): el estado se lee de `/contrato` con `VO_ADMIN`; la sonda sigue con la identidad de sondeo | Un Let inactivo con spec en disco no se sondea y la reconciliación cierra | Test del plugin: con un spec `inactivo` en disco, `smoke` no lo pide y `hz_total == pis`. **Control negativo**: sin el filtro, lo sondea, cuenta 503 como «mal» y la reconciliación falla. Segundo: si `/contrato` responde 403 (identidad sin admin), `smoke` sale «no pude medir», no verde. `marks ruta` de un `inactivo` sale 2 |
| 9 | Superficie web: sección «Ciclo de vida» en `/<slug>/config` (estado, fecha, actor, motivo, sucesor y los botones que el rol permite; `retire` pide teclear el código) y lista `/admin/lets` con los dos ejes. Diseño definitivo de las páginas 503 y 410 | Un dueño suspende y reactiva desde la web; un admin retira tecleando el código | Tests de `pi-config` y `admin` con CSRF. **Control negativo**: un colaborador no ve «Suspender» ni «Retirar», y su POST forjado responde 403 y deja una entrada `forbidden` |
| 10 | Documentación y versión: filas nuevas en `docs/capacidades.md` (ciclo de vida del Let; API de operación; `lets[]` en `/contrato`; claves nuevas de `/healthz`; verbos `let` del CLI; guarda de `botler-rollout`), `docs/superficie-de-estado.md`, `deploy/rollout/RUNBOOK.md` y la entrada del CHANGELOG. **Qué exige** nombra: la migración aditiva sin subir `SCHEMA_VERSION` y su medición contra 0.41.0; **las dos poblaciones de la siembra** —los PIs servibles quedan `activo` y se siguen sirviendo; los specs presentes pero no servibles quedan `especializado` con su motivo y **ya no se sirven solos al arreglarlos: hace falta `activate`**—; que los PIs nuevos nacen `especializado` y publicar un spec ya no lo expone sin `activate` (P-1); que **quitar el spec de un Let activo, cambiar su `identity.code` o publicar con `parity --family specs` una familia que borra un archivo** degrada el nodo (P-4); la guarda de vuelta atrás y que el plugin no ejerce su override; el cambio de orden del router (un PI bloqueado ya no revela su motivo a quien no tiene acceso); y que los verbos `let` usan `RINGS_ADMIN_EMAIL` | El CHANGELOG nombra cada cambio de conducta visible para un operador | Revisión del PR contra esta lista |

Lo que **no** entra, y por qué: el servidor MCP del nodo (no existe, P23; la API HTTP es su base), la instanciación de la clase `Botler` en el servidor (trabajo del cluster 013), y el plugin `mira` (trabajo del diseño 288, P22).

## ¿Qué decidió César?

Decisiones del 2026-09-30, incorporadas al cuerpo del documento:

| # | Pregunta | Decisión | Dónde se aplica |
|--|--|--|--|
| P-1 | ¿Un PI nuevo nace `especializado` o `activo`? | **Nace `especializado`.** Publicar un spec ya no lo expone: hace falta `activate` | Máquina de estados; regla virtual y siembra (lo no servible de hoy también entra `especializado`); pasos 3, 7a y 10 |
| P-3 | ¿Quién puede cada verbo? | **`activate` y `deactivate`: el dueño del PI o un admin de plataforma. `retire`: solo un admin de plataforma** | §«¿Cómo lo usa `mira:status`?»; ceremonia de `retire`; pasos 6 y 9 |
| P-4 | ¿Quitar el spec de un PI `activo` degrada el nodo? | **Sí, degrada.** Vale igual para cambiar su `identity.code` y para una publicación que borre el archivo | Transiciones sin verbo; pasos 5 y 10 |
| P-2 | ¿`retire` es terminal? | **Sí, terminal.** César preguntó además si no debería existir otro verbo reversible; la respuesta está abajo | Máquina de estados |

## ¿Qué falta que confirme César?

**P-2 · ¿Se agrega `--replaced-by` opcional a `deactivate`?** 🙋 *Propuesta pendiente de confirmar.*

César aceptó que `retire` sea terminal y preguntó si no debería existir otro verbo reversible. Los dos jueces (Fable 5.1) y el mantenedor coinciden en que **el reversible ya existe y es `deactivate`**:

- `inactivo` es, funcionalmente, «fuera de servicio con vuelta atrás»: no está en el índice, no se sirve al consumidor, no cuenta en `/healthz`, no demanda frescura, el gestor lo previsualiza y `activate` lo devuelve pasando el punto de validación.
- Es el par del canon trasladado al Let: **`inactivo` es la hibernación** («pausa persistente: estado guardado, sin cómputo activo», línea 1293) y **`retirado` es el decommissioning** (línea 1294).
- Un cuarto estado «archivado» con 410 reversible solo cambiaría el código HTTP y la frase, y un 410 que después vuelve a 200 le rompe una promesa al consumidor y a todo lo que cachea o desindexa por 410. Por eso no se propone.

Lo que sí cubre el caso real detrás de la pregunta —«quiero mandar a la gente al sucesor sin cerrar la puerta todavía»— es una **opción**, no un estado ni un verbo: **`--replaced-by` opcional en `deactivate`**. La página 503 dice entonces «Suspendido desde F. Motivo. Lo reemplaza: ‹enlace›. Responde: ‹dueño›». El código sigue vivo, `activate` lo trae de vuelta, y cuando el sucesor se consolida se hace el `retire` con su ceremonia. Quedan dos verbos con dos promesas honestas: `deactivate` = «puede volver»; `retire` = «no vuelve».

*Recomendación: confirmar.* El diseño ya lo trae incorporado en las reglas del sucesor, la página 503, el CLI y la API. Si César no lo confirma, se quitan esas tres menciones y nada más cambia.

---

• *Generado con Wingworking*
