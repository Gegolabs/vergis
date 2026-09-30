# Acta de juicio · diseño 020·001 v1.1 — ciclo de vida del Let (segunda pasada)

| Campo | Valor |
|--|--|
| Documento juzgado | `wt/diseno-392/work/020-ciclo-de-vida-del-pi/001-diseno-activate-deactivate-retire-v1.1.md` |
| Autor | Claude Opus 5.5 (declarado en el doc) |
| Juez | Fable 5.1 (`claude-fable-5-1`), con `criterio-senior`; canon cargado vía `trilogia` (manifiesto unificado, AgencyDomains v1.2) |
| Fecha | 2026-09-30 |
| Base de código | `origin/main` = `ee31be9` (0.41.0), árbol limpio |
| Primera pasada | `001-diseno-activate-deactivate-retire--JUICIO-fable-v1.0.md` (RECHAZA: 2 B, 6 M, 8 m, 6 i) |
| Método | Cada resolución re-verificada contra archivo:línea en `ee31be9`, no contra lo que la v1.1 dice del código. Los mecanismos nuevos se leyeron en código y se nombra la corrida que los refutaría (Norma 7): ninguno se corrió en esta pasada |

## 1. Veredicto

**RECHAZA (v1.1) — con alcance acotado, otra vez.** Los dieciséis hallazgos de la primera acta están cerrados o cerrados a medias con detalle menor; **ninguno sigue abierto**. Lo que rechaza es **un bloqueante nuevo que la propia resolución de M6 introduce** (B3: la siembra deja `activo` a los specs no servibles y eso pone al candidato en `degraded` justo en el relevo, con lo que `botler-rollout promote` aborta y vuelve atrás — la versión que trae el ciclo de vida no puede promoverse en una instalación con un spec roto en disco), y tres mayores nuevos (M7 · M8 · M9), dos de ellos en secciones marcadas **(decidido)**. Las respuestas de César a P-1, P-3 y P-4 calzan con lo escrito; la de P-2 se responde en §5 y **no exige un cuarto estado ni un verbo nuevo**.

El resto —tesis, dos ejes, alternativa D, máquina de estados, log con `result`, migración aditiva, siembra al tener el control, guarda en `botler-rollout`— está bien anclado y compone.

## 2. Hallazgos de la primera acta — ¿la v1.1 los cierra?

| # | Estado | Evidencia del juez (archivo:línea en `ee31be9`) |
|--|--|--|
| **B1** orden del router | ✅ **cerrado** (con un borde nuevo: M7) | Hoy: existencia `routes.ts:426` → `piBlocked` 503 `:427-428` → `canOpenPi` 403 `:430-433`; PDF igual `:388-392`. `canOpenPi` = `piManagementRole(report.code, …).then(canOpen)` (`serve-rls.ts:1314-1315`), y `canOpen` es `r != null` (`pi-authz.ts:56`). El orden nuevo (existencia sobre `lets()` → `canOpenPi` → rol → ciclo de vida → `piBlocked`) y el control negativo del paso 4 (cuerpo del 403 idéntico en `inactivo`/`retirado`, también para `/pdf`) cierran lo que B1 pedía. `fail()` (`http-util.ts:66-73`) produce un cuerpo determinista: la comparación de cuerpos es realizable (m13 sobre la palabra «byte a byte») |
| **B2** store real (`read` sin control; `SCHEMA_VERSION`) | ✅ **cerrado** | `storeControl()` abre `read` sin control (`serve-rls.ts:372-376`); persist en `read` se ignora y se cuenta (`sqlite.ts:375-383`); `embeddedStores()`/`reabrirStores()` (`:2964-2990`) reabren con el modo del instante en el relevo (`:3080-3088`); `CONTROL_AL_ARRANCAR` (`:403`); `SCHEMA_VERSION = 1` (`governance-store.ts:74`); convención aditiva y medición contra la versión anterior en `CHANGELOG.md:174, 437-440, 496`. El paso 2 declara «no sube», el 7a cuelga de `alTenerElStoreEnEscritura()` en los dos puntos correctos, y el test arranca sin control y verifica cero filas antes del relevo leyendo el archivo. Nota m14 sobre el gate de época en la medición |
| **M1** `smoke`/`marks` sondean no activos | ⚠️ **cerrado a medias** | `smoke.mjs:43-60` inventaría del disco; `:94-99` reconcilia con `lets.total`. El paso 8b lo corrige. Lo que falta: `/contrato` **exige rol de administrador** (`contract.ts:495-507`) y `smoke` pide con la identidad de sondeo, que es un consumidor (`smoke.mjs:30-34`, `cfg.identity`). La lectura del estado necesita la identidad de admin (`VO_ADMIN`, como ya hace `contract.mjs:24`). Ver m9 |
| **M2** `retire` como `destructive` | ✅ **cerrado** | `CUTTING` (`classify.mjs:15`); `gate()` mide con poller en clases que cortan (`exec.mjs:23-26`); `enforceGate` (`classify.mjs:85-102`). La v1.1 elige (a) —hereda la ceremonia entera— y lo dice con su porqué (irreversibilidad, no tamaño del corte). Decisión legítima y escrita |
| **M3** log vs no-repudio | ✅ **cerrado** (consecuencia nueva: M8) | Canon 1117 y 1716 confirmados por línea; el log es file-only (`serve-rls.ts:1697`, `log.ts:9-19`). `result` con cuatro valores, el 403 escribe `forbidden`, desviación de la línea 1718 declarada con porqué. Cierra M3. Lo que abre: el archivo es compartido entre anillos (M8) |
| **M4** P11 con `\b` | ✅ **cerrado** | `packages/cli/src/run.ts:137` `const botler = new Botler({…})`; el servidor usa `AppendOnlyLog` directo (`serve-rls.ts:1697`, `consola.ts:99`). Premisa reescrita con evidencia verdadera |
| **M5** guarda solo en el CLI | ⚠️ **cerrado a medias** | `cmd_rollback` delega en `cmd_promote` (`botler-rollout:887-900`); `lets_block` recorta con `[^}]*` (`:231`); `serving_ok` (`:245-255`). La guarda en `cmd_promote` es el lugar correcto. Lo que no calza: «`vergis-ops exec rollout` la hereda sin código propio» es cierto para la **negativa** y falso para el **override** `--acepto-reexponer`: `cmd_promote` muere con flag desconocido (`botler-rollout:693-700`, `-*) die`) y el plugin arma su propia lista de flags (`rollout.mjs:98`, solo `--timeout`; `:99` rechaza a propósito `--no-schema-gate`). Ver M9 |
| **M6** siembra desde `discover()` | ✅ **cerrado como se pidió — y la resolución introduce B3** | `discovery.ts:152-177` hace `continue` antes de agregar (confirmado). Sembrar desde `parsed()` cierra M6. Pero el efecto de dejar `activo` lo no servible no es solo «degrada hasta que se arregle»: **bloquea la promoción de la versión** (§3 B3) |
| **m1** forma de `Report` sin spec | ✅ cerrado | `LetRef` fijado en el paso 3; `canOpenPi`/`piManagementRole` solo usan `code` (`serve-rls.ts:1199-1205, 1314`) |
| **m2** «se siembra al descubrirlo» | ✅ cerrado | `bootstrapPi` perezoso (`serve-rls.ts:1200-1203`); frase corregida |
| **m3** cadena de `replacedBy` | ✅ cerrado | Resolución al servir, tope 10, guarda de ciclo. Bordes nuevos en m11/m12 |
| **m4** Miranda y enlaces del menú | ✅ cerrado | `writeSpec` (`serve-rls.ts:2734-2737`) → paso 3b con control negativo; `VERGIS_MENU` recargable (`instance-config.ts:224`) → `menuLinks[]` en `/contrato` (paso 5) |
| **m5** páginas del paso 4 vs 9 | ✅ cerrado | Paso 4 entrega texto mínimo; 9 la superficie |
| **m6** `/healthz` con cero activos | ✅ cerrado | `serving_ok` con `total=0, serving=0` satisface (`botler-rollout:251-253`); declarado coherente; claves planas dentro de `lets` |
| **m7** renombre de `identity.code` | ✅ cerrado | Tabla «Transiciones que no pasan por un verbo» y paso 10 |
| **m8** impresiones compartidas | ✅ cerrado | Escrito con `CAP-80`/`CAP-82` en la tabla de datos |
| **i1** filtración de `piBlocked` | ✅ cerrado | El orden nuevo la cierra; CHANGELOG lo nombra |
| **i3** CAS en `sql.js` | ✅ cerrado | Dicho en el paso 2 |
| **i2, i4, i5, i6** | — | Sin cambio requerido |

**Abiertos de la primera acta: ninguno.** Cerrados a medias: M1 (identidad admin para `/contrato`) y M5 (el override no se hereda por el plugin).

## 3. Hallazgos nuevos de la v1.1

### B — bloqueantes

**B3 · La siembra desde `parsed()` con estado `activo` impide promover la versión en cualquier instalación que tenga un spec no servible en disco.**
Mecanismo, leído en código: (1) el paso 7a siembra `activo` todo código parseado, «incluido uno no servible». (2) El paso 5 cuenta ese Let en `lets.total` y no en `lets.serving`. (3) `/healthz` pasa a `phase=degraded` cuando `total - serving > 0` (`routes.ts:175-181`). (4) La siembra corre **en el relevo** (`alTenerElStoreEnEscritura()`, `serve-rls.ts:3082-3088`), o sea **después** del flip del borde (`cmd_promote`, orden declarado en `botler-rollout:747-765`: intent → flip → SIGUSR2 → relevo). (5) `insistir_handover` solo devuelve 0 con `phase=serving` (`botler-rollout:304-311`); con `degraded` agota el presupuesto (10 s por defecto), `volver_atras` devuelve el tráfico al anillo viejo y `promote` muere con «promoción ABORTADA en el handover» (`:760-765`). El pre-flight no lo ve venir: antes del relevo el candidato es `standby` y sus conteos salen de un store sin filas. Resultado: la instalación queda en 0.41.0 con el store ya migrado y sembrado (el candidato persistió durante su control breve), y cada reintento repite el aborto hasta que alguien arregle o borre el spec **a mano, en la versión vieja**, que es exactamente la práctica que este diseño viene a reemplazar.
Hoy un spec no servible se **omite** (`discovery.ts:152-177`) y el consumidor recibe 404: no degrada el nodo ni frena la promoción; solo un PI verificado en rojo (fabric) la frena, y eso es conducta declarada (`botler-rollout:249-254`). El CHANGELOG del paso 10 dice «por eso ahora degradan el nodo hasta que se arreglen» sin decir que degradan **en el instante del relevo de la promoción**.
Corrida que lo refuta: `tests/deploy-anillos.test.ts` con `fake-docker.sh` emitiendo, para el candidato tras el SIGUSR2, `{"phase":"degraded","lets":{"total":3,"serving":2}}` → `promote` debe salir con error y `active.caddy` volver al previo. Si sale verde, el mecanismo descrito acá está mal leído.
Recomendación: sembrar **por servibilidad**: lo que `discover()` deja pasar entra `activo`; lo que solo `parsed()` conoce entra **`especializado`** (`via: "siembra"`, con `healthReason` = el motivo del descubrimiento). Preserva byte a byte lo que hoy ve el consumidor (404), no degrada, `let status` lo lista con su motivo, y arreglar el spec exige un `activate` —que es la misma regla de P-1 para un PI nuevo. M6 quedaba cerrado porque el Let existe en la tabla desde el día uno; lo único que cambia respecto de la v1.1 es que no se sirve solo al arreglarse. Alternativa descartable: `inactivo` (cambiaría el 404 de hoy por un 503 que revela existencia y motivo). El CHANGELOG nombra las dos poblaciones.

### M — mayores

**M7 · En `especializado`, quien no tiene acceso aprende más que quien lo tiene** (sección «(decidido)»).
Con el orden nuevo, una identidad sin acceso a un PI privado `especializado` recibe **403** en el paso 2 («el código existe»), y un consumidor con acceso recibe **404** en el paso 4 («no existe»). La tabla «¿Qué ve cada quien?» lo escribe así. El diseño justifica el 404 del consumidor con «decirle que existe filtraría trabajo en curso» — y se lo dice, sin querer, a la identidad con menos derechos. Hoy no pasa: un spec en disco se sirve o se omite, no hay estado intermedio. Es el patrón de B1 en el sentido inverso.
Corrección sin romper B1: `canOpenPi` **ya** resuelve el rol (`serve-rls.ts:1314-1315`, `canOpen(role)`), así que el router resuelve el rol **una vez** y decide: `especializado ∧ ¬gestor → 404` **antes** de aplicar `canOpen`; después sigue el orden de B1 para los otros tres estados. Control negativo: identidad sin acceso pide un `especializado` privado y recibe el 404 de un código inexistente, cuerpo idéntico.

**M8 · «Toda invocación escribe una entrada» choca con un log que dos anillos comparten y cuya cadena es por proceso.**
`admin-audit.log` vive en `${VERGIS_OUT}` (`serve-rls.ts:1697`), y `VERGIS_OUT` es el volumen `./governance` **compartido** por los anillos (`deploy/compose.reference.yml:107, 151`; `deploy/rollout/ring.args.example:54`). `AppendOnlyLog` arranca cada proceso con `seq=0` y `prevHash=GENESIS` y no retoma del archivo (`log.ts:26-27, 40-49`). La protección de P18 (store en `read`) **no cubre el log**: es un `appendFileSync`, y un standby lo escribe igual. El diseño manda registrar toda invocación, incluida la que en standby responde 409 (P17), y la tabla de `result` no tiene valor para ese caso. Si el standby escribe su `let-lifecycle` en el mismo archivo, intercala su cadena con la del activo — un sustrato compartido escrito por dos actores (W-01). Hoy los 409 de standby no auditan (el orden es 409 antes de cualquier escritura), así que esta sería la **primera** escritura de un standby al log.
Corrección: declarar que el 409 de standby **no** escribe entrada (el nodo que responde no es el que custodia el log; el rechazo lo verá el activo cuando el CLI reintente contra él) o que escribe en un archivo propio del anillo; y que la cadena que el paso 6 verifica es la de **un** proceso (i9). Corrida que lo refuta: dos nodos del fixture del plano de control, `POST …/deactivate` al standby, y `verifyChainLines` sobre el archivo: si la cadena verifica, no hay problema.

**M9 · La afirmación «`vergis-ops exec rollout` la hereda sin código propio» es falsa para `--acepto-reexponer`** (Norma 6).
`rollout.mjs` no pasa flags arbitrarios: arma su lista (`:98`, solo `--timeout`) y **rechaza a propósito** `--no-schema-gate` (`:99`: «existe para instancias sin bloque de gobierno, y esa decisión es del operador a mano, con la herramienta, gritándola en pantalla»). La negativa de la guarda sí se hereda (vive en `cmd_promote`); el override, no. Decidir y escribir: (recomendado) el plugin **no** ejerce `--acepto-reexponer`, con el precedente de `rollout.mjs:99` y la misma redacción —re-exponer un Let suspendido es una decisión del operador a mano—; o plumbear el flag con su gate. El test del paso 7b («con `--acepto-reexponer` procede y lo registra») es del `botler-rollout`, y hay que decir que no existe camino por el plugin.

### m — menores

- **m9 ·** `smoke` necesita la identidad de admin para leer `/contrato` (`contract.ts:495-507`): la de sondeo es un consumidor (`smoke.mjs:30-34`). Decir que la lectura del estado usa `VO_ADMIN` (como `contract.mjs:24`) y que la sonda sigue con la identidad de sondeo.
- **m10 ·** `piManagementRole` **bootstrapea** el gobierno si no existe (`serve-rls.ts:1200-1203`). Con `retirado` en el paso 2, un Let retirado nunca accedido recibiría su `pi_governance` recién nacido, en un estado cuyo gobierno el diseño declara «congelado». Declarar: o se bootstrapea igual (inocuo: siembra dueño y visibilidad; la congelación es de las **escrituras de `/config`**), o no y entonces el rol sale solo de filas existentes. Lo primero es más simple y no rompe el 410 de un retirado público.
- **m11 ·** `replacedBy` «no retirado» admite `especializado`: la 410 enlazaría a un 404. Exigir `activo` o `inactivo` al retirar, y que la resolución de la cadena salte los no visibles.
- **m12 ·** El enlace al sucesor en la 410 se muestra a quien pasó `canOpenPi` del **retirado**, no del sucesor: revela el código de un PI al que quizá no tiene acceso. Es del mismo tamaño que el 403 de hoy; declararlo, o comprobar `canOpenPi` del sucesor antes de enlazar.
- **m13 ·** «El mismo 403 de hoy, byte a byte» — el cuerpo sí (`fail()` es determinista, `http-util.ts:66-73`); los encabezados llevan `Date`. Escribir «mismo status y mismo cuerpo». La cronometría no distingue estados para quien no tiene acceso: se detiene en el paso 2 en todos.
- **m14 ·** La medición del paso 2 abre el archivo migrado con 0.41.0 en `write`: además del gate de esquema hay **gate de época** (`SqliteEpochFencedError`, `sqlite.ts:128-137`; `control_meta`, `:196-206`). El test debe pasar una época ≥ la del archivo, o el ejecutor confundirá un fence con un fallo de esquema. Y el worktree de medición va en `wt/v0.41.0` como el doc dice (convención del repo).
- **m15 ·** El paso 6 debe decir que el `forbidden` se escribe **antes** de parsear el cuerpo (un cuerpo malformado de un no-admin no debe cambiar el `result`), y que `paramsSha256` se calcula sobre los bytes crudos. Volumen: la API vive dentro del anillo tras el token del gate (P16) y solo POST; no es superficie pública. Riesgo de volumen bajo; el de filtración se acota a `by` y `reason`, que el log ya guarda en claro (`pi-config.ts:129`).

### i — informativos

- **i7 ·** El paso 3 del orden («rol de gestión») ya está dentro del paso 2: `canOpenPi` es `piManagementRole → canOpen`. Resolver el rol una vez y derivar los dos veredictos; dos llamadas son dos `bootstrapPi` potenciales y dos lecturas.
- **i8 ·** Precedente de la casa en sentido contrario para **otro** artefacto: el journal del contrato «un 403 JAMÁS escribe» (`contract.ts:476, 509`). La desviación del audit log está justificada por el canon (1117) y declarada; solo conviene citar el precedente para que nadie la lea como descuido.
- **i9 ·** La cadena de `admin-audit.log` se reinicia en cada arranque del proceso (`log.ts:26-27`, sin retomar del archivo): «la cadena verifica» es por corrida del proceso, preexistente. El test del paso 6 (`verifyChainLines` en proceso) es válido; no afirmar más.
- **i10 ·** Con B3 corregido por servibilidad, el segundo test del paso 7a («un spec no servible queda `activo`») cambia de signo: queda `especializado` con `healthReason`.

## 4. Las respuestas de César (2026-09-30)

| Pregunta | Respuesta | ¿Calza con la v1.1? |
|--|--|--|
| P-1 | Nace `especializado` | Sí: es el default recomendado y la tabla de transiciones ya lo escribe. Con B3 corregido, la siembra sigue la misma regla para lo no servible |
| P-3 | `activate`/`deactivate` dueño o admin; `retire` solo admin | Sí: es la recomendación literal (§«Quién puede cada verbo»); el control negativo del paso 9 (colaborador sin «Retirar», POST forjado → 403 + `forbidden`) ya lo mide |
| P-4 | Quitar el spec de un `activo` degrada | Sí: tabla de transiciones, paso 5 (segundo test) y CHANGELOG. Vale igual para el renombre de código y para `parity --family specs` |
| P-2 | «De acuerdo con terminal, pero debe existir otro reversible, ¿no crees?» | §5 |

## 5. Opinión sobre P-2 — ¿hace falta un cuarto estado o verbo?

**No. El reversible ya existe y se llama `deactivate`; lo que le falta al diseño para cubrir lo que César describe es una opción, no un estado.**

**Lo que el canon dice, por línea.** Los verbos son una enumeración cerrada por su forma —«**Verbos del API de operación**: `specialize` · `invoke`/`schedule` · `read`/`subscribe` · `status`/`activate`/`deactivate`/`retire`» (1391)— y los estados también: «activo · caído · degradado · retirado» (1395). No hay MUST sobre la lista, pero tampoco hay «entre otros»: Vergis es la implementación de referencia (línea 23 del manifiesto), y un verbo que Vergis inventa deja de ser referencia de algo. El canon **no** define la reversibilidad de `retire`; lo que sí fija es la propiedad de Capa 4 «**Reversibilidad cuando aplica**» (1118): la reversibilidad es de los actos donde aplica, no una promesa universal. Y donde el canon usa «archivado» (1294, decommissioning del agente: «estado **archivado o eliminado según política**») lo usa como **política de retención del estado** de algo ya retirado, no como una fase del ciclo de vida de la que se vuelve. La fase es terminal —«decommissioned ≠ olvidado» habla de reconstruir, no de resucitar.

**Lo que el diseño ya tiene.** `inactivo` es, funcionalmente, «retirado de servicio con vuelta atrás»: no está en el índice, no se sirve al consumidor, no cuenta en `/healthz`, no demanda frescura, el gestor lo previsualiza y `activate` lo devuelve con el punto de validación. Es exactamente el par `hibernación`/`decommissioning` del canon (1293-1294) trasladado al Let: `inactivo` es la hibernación; `retirado`, el decommissioning.

**Qué diferencia vería el consumidor con un cuarto estado «archivado» (410 reversible).** Ninguna que se pueda **verificar**. Contra `inactivo`, un `archivado` solo cambiaría **el código HTTP y la frase**: 503 «suspendido, volverá, responde X» contra 410 «retirado, lo reemplaza Y». Todo lo demás —no índice, no servicio, no salud, gobierno editable, comentarios e impresiones— sería idéntico. Y un 410 que después vuelve a 200 es una promesa rota al consumidor y a todo lo que cachea o desindexa por 410 (el código significa «permanente»; por eso el diseño lo eligió para `retirado`). Un estado cuya única diferencia observable es una **afirmación falsa** no merece una fila en la máquina.

**Lo que sí vale la pena agregar, sin verbo ni estado nuevo.** El caso real detrás de la pregunta es «quiero mandar a la gente al sucesor sin cerrar la puerta todavía». Eso se cubre con **`replacedBy` opcional en `deactivate`**: la página 503 dice «Suspendido desde F. Motivo. Lo reemplaza: ‹enlace›. Responde: dueño». El código sigue vivo, `activate` lo trae de vuelta, y cuando el sucesor se consolida se hace el `retire` con la ceremonia entera. Dos verbos, dos promesas honestas: `deactivate` = «puede volver»; `retire` = «no vuelve». Y la protección contra el retiro por error no es la reversibilidad: es lo que el diseño ya custodia —solo admin, motivo, `confirm` tecleado, gate `destructive`— más la regla de que se retira lo que ya estuvo `inactivo` un tiempo, si César quiere endurecerla (la máquina lo permite: `activo → retire` es legal, pero nada obliga a usarlo).

**Si aun así se quisiera «resucitar» un retirado**, el camino honesto no es un verbo nuevo sino que `retire` deje de ser terminal (`retirado → activate` por admin, con el log explicando la resurrección) — y eso es justamente lo que César acaba de acordar que no quiere. La otra puerta, un código nuevo con `--replaced-by`, ya está en el diseño.

**Respuesta que propongo a P-2:** «Sí: `retire` es terminal. El reversible ya existe y es `deactivate`. Lo único que se agrega es `--replaced-by` opcional en `deactivate`, para que la página de un Let suspendido pueda apuntar al sucesor sin cerrar el código.»

## 6. Riesgo del veredicto

B3 está **leído en código, no corrido**: cinco eslabones (`routes.ts:175-181` · `serve-rls.ts:3082-3088` · `botler-rollout:747-765` · `:304-311` · `:760-765`), cada uno verificado por lectura, sin una corrida que los encadene. La corrida que lo refutaría está nombrada en B3 y cuesta un fixture de `fake-docker.sh`. Si esa corrida sale verde, B3 baja a M (sigue siendo cierto que la siembra degrada la instalación, pero no que bloquea la promoción) y el veredicto pasa a APRUEBA CON OBSERVACIONES.

M8 depende de que el diseño de veras pretenda que el **standby** escriba el 409: el texto es ambiguo (la tabla de `result` no tiene ese caso). Si el autor responde «el 409 de standby no se registra», M8 se cierra con una línea.

Lo que menos verifiqué: que `alTenerElStoreEnEscritura()` en el relevo corra **antes** de que `/healthz` pueda responder `serving` (si corriera después, el candidato pasaría el `insistir_handover` y se degradaría un segundo más tarde — B3 cambiaría de forma: promoción exitosa a un nodo `degraded`, que `serving_ok` frena en la **siguiente** promoción). En cualquiera de las dos formas, la instalación con un spec roto queda mal parada; solo cambia en qué paso.

---

• *Fable 5.1 · juez · segunda pasada · 2026-09-30*
