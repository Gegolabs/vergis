# Acta de juicio · diseño 020·001 v1.0 — ciclo de vida del Let (`activate` / `deactivate` / `retire`)

| Campo | Valor |
|--|--|
| Documento juzgado | `wt/diseno-392/work/020-ciclo-de-vida-del-pi/001-diseno-activate-deactivate-retire-v1.0.md` (rama `docs/392-ciclo-de-vida-pi`, commit `ee00e92` sobre `ee31be9` = 0.41.0) |
| Autor | Claude Opus 5.5 (declarado en el doc) |
| Juez | Fable 5.1 (`claude-fable-5-1`), con `criterio-senior`; canon cargado vía skill `trilogia` (manifiesto unificado, AgencyDomains v1.2, 2046 líneas) |
| Fecha | 2026-09-30 |
| Contexto | Issue #392 (leído con `gh issue view 392 --json`), diseño 288 v1.1 (líneas 50, 73, 124, 181) |
| Método | Cada premisa re-derivada contra archivo:línea en `main`; las de ausencia re-buscadas con `git grep -w` (nunca `\b`); el canon citado por línea del manifiesto |

## 1. Premisas — confirmadas, refutadas, no verificadas

| # | Veredicto | Evidencia del juez |
|--|--|--|
| P1 | ✅ confirmada | `git grep -n -i -w -E "activate\|deactivate\|retire\|retired" -- server packages plugins deploy`: 30 líneas, todas del retiro de archivos de carga (`admin.ts:2210-2214`, `admin-cargas.ts:115`, `cargar.ts:836-842`, `serve-rls.ts:1829,1953`) o del retiro de anillos (`botler-rollout`, `rollout.mjs`, `exec.mjs`, `upgrade/SKILL.md`). Ninguna es un Let. Búsqueda extra: `git grep -i -w -E "lifecycle\|inactive\|inactivo\|retirado\|especializado"` — solo intake, revert, policy `bindcolumn-retirado`, datadoc poda. Confirmada la ausencia |
| P2 | ✅ confirmada | `git grep -c -i -E "\bretire" -- server` → rc=1, cero archivos. Con `-w` → 4 archivos. El instrumento del encargo es ciego, como dice el doc |
| P3 | ✅ | `admin.ts:2210-2214` (`intake-retire`), `admin-cargas.ts:115`, `cargar.ts:836-842`; `capacidades.md:279` (CAP-141), `rollout.mjs:159-161` |
| P4 | ✅ | `grep -n -i -E "activate\|deactivate\|retire"` sobre el manifiesto: solo líneas 1391 y 1395. Citas textuales coinciden |
| P5 | ✅ | `serve-rls.ts:456-458` (`specPaths`: `*.ya?ml` del nivel superior; también admite lista `VERGIS_SPECS`, no solo directorio — matiz omitido, sin efecto en el diseño); `discovery.ts:104-190`; `routes.ts:426` |
| P6 | ✅ | `serve-rls.ts:3588-3603` |
| P7 | ✅ | `serve-rls.ts:3594-3597` registra solo `servableLets` (conteo). `git grep -n -E "type: '(spec\|pi\|let)[-a-z]*'"` → solo `pi-governance-write` en `pi-config.ts:129,148,156,165,171` |
| P8 | ✅ | `serve-rls.ts:1409-1422` (`total: all.length`); `routes.ts:174-190`; CAP-177 en `capacidades.md:335` |
| P9 | ✅ | `governance-store.ts:777-809` (DDL de `pi_governance`, `pi_grant`, `pi_demanda`, `pi_display_name`, `platform_setting`); `pi-config.ts:120-130`; `serve-rls.ts:465-471, 1668-1680` |
| P10 | ✅ | `log.ts:25-50`; `serve-rls.ts:1697-1698`; CAP-159 en `capacidades.md:302` |
| P11 | ⚠️ **conclusión cierta, evidencia falsa** | El doc dice `git grep -n -E "new Botler\b" -- server packages`: 0 resultados. Ese `\b` es **el mismo instrumento ciego que P2 denuncia**. Sin `\b`: `packages/cli/src/run.ts:137` `const botler = new Botler({…})` — dentro del alcance `packages` declarado. La conclusión «no se instancia en el servidor» se sostiene (el CLI no es el servidor: `serve-rls.ts:1697` y `consola.ts:99` usan `AppendOnlyLog` directo), pero la premisa como está escrita («0 resultados en server packages») es falsa. Norma 6 |
| P12 | ✅ | `menu-config.ts:1-12` |
| P13 | ✅ | `instance-config.ts:226`; `serve-rls.ts:1200-1218` (`bootstrapPi` si no hay `pi_governance`) |
| P14 | ✅ | `capa-de-notas.md:24-29, 64`; `notas-store.ts:253-255` (`impresion.pi_slug`) |
| P15 | ✅ | `classify.mjs:11-15`; `enforceGate` (`classify.mjs:85-102`): sin gate declarado rige `approval` |
| P16 | ✅ | `smoke.mjs:5-7, 29-33`; `contract.mjs:24-25`; `health.mjs:17` |
| P17 | ✅ | CAP-178 `capacidades.md:336`; `serve-rls.ts:1428-1431` |
| P18 | ✅ **pero incompleta** | `serve-rls.ts:1571` (`${OUT}/governance.sqlite`); `compose.reference.yml:107,151` (`./governance:/governance` persistente); `rollout/README.md:176`. **Lo que la premisa omite y el diseño necesita:** el store se abre en modo `read` cuando el anillo no tiene el control (`serve-rls.ts:372-376` `storeControl`; `sqlite.ts:88-92`: un persist sobre handle de lectura **se ignora**), y tiene gate de esquema `ERR_SCHEMA_TOO_NEW` (`sqlite.ts:131-145`, `governance-store.ts:74 SCHEMA_VERSION = 1`). Ver B2 |
| P19 | ✅ | `routes.ts:417-437` |
| P20 | ✅ (ausencia confirmada) | `grep -n -i -E "slug\|piCode" server/notify.ts` → 0 líneas en mi corrida (el doc cita `:399, :535, :689` como enlaces de casillas; no los encontré con ese patrón, pero la conclusión —nada por PI— se sostiene por ausencia). Frescura: `serve-rls.ts:2058-2068` ✅ |
| P21 | ✅ | `ls plugins/` → solo `vergis` |
| P22 | ✅ | `git grep -l -i "mcp" -- server packages` → rc=1 |
| P23 | ✅ | `git grep -n "discover()" -- server \| wc -l` → 33 |

**Canon:** las siete citas (líneas 1096, 1098, 1117-1119, 1287-1294, 1365, 1388-1391, 1395, 1716-1718) son textuales. La lectura «la lista de 1395 mezcla dos ejes (declarado/observado)» es una interpretación razonable y está etiquetada como tal. Lo que el doc dice que el canon **no** dice (efecto de los verbos, máquina de estados, «inactivo», reversibilidad de `retire`) lo confirmo con el mismo grep.

## 2. Veredicto

**RECHAZA (v1.0)** — con alcance acotado: dos hallazgos bloqueantes en secciones marcadas «(decidido)» (§«¿Qué ve el consumidor?»/paso 4 y paso 7), que un ejecutor en frío no puede resolver y uno de los cuales filtra existencia y metadatos de PIs privados. **Las cuatro preguntas a César (§9) son válidas y no dependen de los hallazgos**: pueden subir tal cual en la v1.1 que corrija B1 y B2. El resto del diseño —tesis, dos ejes, alternativa D, máquina de estados, log— es sólido y está bien anclado al código y al canon.

## 3. Hallazgos

### B — bloqueantes

**B1 · El gate de ciclo de vida, en el orden que el paso 4 fija, contradice la definición de «consumidor» y filtra existencia y metadatos de PIs privados.**
Evidencia: el router hoy va existencia (`routes.ts:426`) → `piBlocked` 503 (`:427-428`) → `canOpenPi` 403 (`:430-433`). El paso 4 pone el gate «después de existencia y antes de `piBlocked`», o sea **antes de `canOpenPi`**. Pero §Consumidor define consumidor como «quien pasaría `canOpenPi`» y promete que quien no lo pasaría «recibe lo mismo que hoy (403 o ausencia)». Con el orden del paso 4, un identity **sin acceso** a un PI privado `inactivo` recibe la página 503 con fecha, motivo y **dueño**; a uno `retirado`, la 410 con motivo y sucesor. Eso es existencia + metadatos de un PI que para esa persona no debía existir. Además la fila «gestor» exige resolver el rol (`piManagementRole`) **antes** de decidir la respuesta — que es exactamente lo que el orden propuesto pospone.
Segunda inconsistencia en la misma cadena: el paso 3 manda «servir y contar (router…) → `served()` = solo `activo`», y el paso 4 dice «después de existencia». Si la existencia del router se evalúa sobre `served()`, un `inactivo`/`retirado`/`especializado` da **404** siempre y las respuestas 503/410/franja son inalcanzables; si se evalúa sobre `lets()`, hace falta una `Report` para un Let sin spec (ver m1). El doc no dice cuál.
Recomendación: (a) orden: existencia sobre `lets()` → `canOpenPi`/rol → gate de ciclo de vida → `piBlocked`; quien no pasa `canOpenPi` recibe **exactamente** lo de hoy para todo estado (403, y 404 si se decide no revelar); (b) reescribir el paso 3 para que el router use `lets()` en existencia y `served()` solo en el despacho; (c) el control negativo del paso 4 debe incluir «un identity sin acceso pide `/<slug>` de un `inactivo` privado y recibe 403 sin fecha/motivo/dueño en el cuerpo».

**B2 · La siembra y la guarda de vuelta atrás (paso 7) están construidas sobre un modelo del store que no es el real.**
Evidencia: (i) `storeControl()` (`serve-rls.ts:372-376`) abre los stores en `mode: 'read'` cuando el anillo **no tiene el control**, y en ese modo «un persist … se ignora, se cuenta en el estado y se avisa una vez en el log» (`sqlite.ts:88-92, 378-381`). Un anillo de la versión nueva **arranca en standby** (RUNBOOK de anillos; `botler-rollout:670-673`). Por tanto «al primer arranque de la versión nueva, todo código descubierto sin fila entra `activo`» y «se marca `platform_setting.lets_lifecycle_seeded_at`» **no ocurre**: el persist se descarta en silencio, la marca no queda, y el anillo hereda el store en escritura solo al relevar (`serve-rls.ts:1694`: «el handle embebido que el relevo reabre»). La siembra tiene que colgar del **relevo** (adquisición del control), no del arranque, y decirlo. (ii) El store tiene gate de esquema: `SCHEMA_VERSION = 1` (`governance-store.ts:74`) y `SqliteSchemaTooNewError` (`sqlite.ts:131-145`: «no se abre en escritura»). El paso 2 crea una tabla y **no dice si sube `SCHEMA_VERSION`**. Si la sube, un anillo viejo que releva **no puede abrir el store en escritura** — no «vuelve a servir los inactivos» (7b): se queda sin controlador, que es peor y no es lo que la guarda protege. Si no la sube (convención de la casa: CHANGELOG líneas 174, 439, 496 — «migración aditiva, no sube SCHEMA_VERSION, no rompe rollback, medido»), entonces 7b es el mecanismo correcto **y el diseño debe declararlo con esas palabras y medirlo como la casa lo mide** (abrir el archivo migrado con la versión anterior). (iii) El test del paso 7 («store vacío», «mismos slugs») no pone en riesgo ninguno de los dos mecanismos: pasa verde con la siembra ignorada en standby y con `SCHEMA_VERSION` subida.
Recomendación: paso 2 declara «no sube `SCHEMA_VERSION`» (aditiva, `CREATE TABLE IF NOT EXISTS`); paso 7a se dispara al adquirir el control y su test arranca el nodo **sin control** (fixture del plano), releva, y verifica la fila `activo` y la marca **después** del relevo, más el control negativo «antes del relevo, cero filas»; paso 7b agrega la medición «0.41.0 abre y escribe el archivo migrado». Norma 7: hoy el mecanismo está publicado sin la corrida que lo refutaría.

### M — mayores

**M1 · `mira:status` promete que `smoke` y `marks` «miden solo los Lets `activo`», y ningún paso del plan los toca.**
Evidencia: `smoke.mjs:43-59` deriva el inventario **del directorio de specs en disco** (`readdirSync(DIR)`), y `:13, :96-99, :182-184` lo reconcilia contra `hz.lets.total`. Con el paso 5 (`total` = solo activos) y specs de Lets `inactivo`/`especializado` presentes en disco, `smoke` (a) sondea Lets no activos y cuenta 503/404 como «mal», y (b) declara «medición a medias» por inventario ≠ total. El paso 8 solo agrega los verbos `let`. Recomendación: paso 8 (o uno nuevo) hace que `smoke`/`marks` tomen el inventario de `/contrato` `lets[]` (o de `/healthz` + filtro por estado), con control negativo «un Let `inactivo` con spec en disco no se sondea y la reconciliación cierra».

**M2 · Clasificar `retire` como `destructive` arrastra la ceremonia de corte que el propio diseño dice que no aplica.**
Evidencia: `classify.mjs:15` `CUTTING = {boot, service-interrupting, destructive}`; `exec.mjs:24-26`: para clases `CUTTING`, `measured = pollerRunning(...)`; `enforceGate` (`classify.mjs:93-95, 101`): con gate `window` exige `--impact`, `--window` **y poller corriendo**; con `approval` exige `--impact` «qué Lets caen y por cuánto». Retirar **un** Let bajo `window` pediría arrancar el poller del nodo entero. El doc argumenta para `deactivate` que «el corte de un Let es el objeto mismo del acto, no toca el nodo» — el mismo argumento vale para `retire`, y la clase elegida lo contradice mecánicamente. Recomendación: decidir y escribir una de dos: (a) mantener `destructive` y declarar que `retire` hereda `--impact` y la medición cuando el gate es `window` (aceptable: es irreversible), o (b) `content` en el CLI con la irreversibilidad custodiada por el nodo (solo admin + motivo + confirmación) — y en ambos casos decir por qué. Hoy el ejecutor lo descubriría al correr `plugin-e2e.sh`.

**M3 · El log se aparta del canon que cita, sin declararlo, y es ambiguo sobre qué rechazo se registra.**
Evidencia: canon línea 1117 «**No-repudio** — toda acción registrada con identidad, contexto y resultado»; línea 1716 «registro … de toda acción». El diseño: «los actos idempotentes **no** escriben: una entrada es un cambio» (§Log) y el control negativo del paso 6 «no-admin intenta `retire` → 403 y **ninguna** entrada». Un intento de `retire` por quien no puede es justamente lo que el no-repudio existe para dejar escrito. Además «un rechazo escribe `let-lifecycle-rejected`» (§Log) vs «403 y ninguna entrada» (paso 6): ¿el 403 no es rechazo? Recomendación: registrar toda invocación con `result` (`changed` / `noop` / `rejected:<motivo>` / `forbidden`) — el log ya es file-only sin coste de RAM (`serve-rls.ts:1695-1697`) — o declarar la desviación del canon con su porqué. Alinear paso 6 con §Log.

**M4 · P11 usa el instrumento ciego que P2 refuta** (detalle en la tabla). La conclusión sobrevive; la premisa no. Corregir la evidencia a `git grep -n "new Botler" -- server packages` → `packages/cli/src/run.ts:137` (CLI, no servidor). Norma 6: una justificación con evidencia falsa cierra la pregunta con la respuesta equivocada aunque acierte.

**M5 · La guarda de vuelta atrás (7b) vive en el CLI, y la herramienta de anillos se corre también directo en el host.**
Evidencia: `deploy/rollout/RUNBOOK.md:156` y `README.md:82` documentan `botler-rollout retire/rollback` directo; `botler-rollout:523-559` ya lee `/healthz` (sin identidad). Un `botler-rollout rollback` a mano no pasa por `rollout.mjs`. Recomendación: como el paso 5 ya publica `lets.inactive/specialized/retired` en `/healthz` solo cuando son > 0, la guarda puede vivir **en `botler-rollout`** leyendo ese bloque (sin auth, mismo predicado que ya parsea con `lets_block`), y el CLI heredarla. Control negativo en la suite de anillos (`tests/fixtures/anillos/fake-docker.sh` ya existe para esto).

**M6 · La siembra (7a) solo cubre lo que `discover()` deja pasar, y eso cambia en silencio la conducta de PIs preexistentes.**
Evidencia: `discovery.ts:147-177` hace `continue` (omite) specs no servibles (capability fuera del catálogo, tabla sin esquema). Un spec presente pero no servible en el momento de la siembra no recibe fila; cuando el operador lo arregla, nace `especializado` (bajo P-1) y **deja de servirse hasta un `activate` explícito** — un PI que ayer existía y hoy no aparece, sin acto de nadie. Recomendación: sembrar desde los códigos **parseados** (`discoverRaw` antes del gate), no desde los servibles; y que el CHANGELOG lo nombre.

### m — menores

- **m1 ·** Forma de la `Report` de un Let sin spec (`retirado` sin archivo, `activo` sin spec): `canOpenPi(report, …)` (`routes.ts:97`) y `piManagementRole(code, …)` necesitan al menos `code`, `slug`, `proto`; el paso 3 dice «unión» sin fijar la forma mínima. Fijarla.
- **m2 ·** «Gobierno del PI: se siembra al descubrirlo (como hoy)» es inexacto: `bootstrapPi` es perezoso, en el primer acceso de índice/gestión (`serve-rls.ts:1200-1218`), no al descubrir. Sin efecto en el diseño; corregir la frase.
- **m3 ·** Cadena de `replacedBy`: A→B, luego B retirado →C; la 410 de A enlaza a una 410. El gobierno de A está «congelado» (409), así que no se puede actualizar. Resolver transitivamente al servir la página, o permitir editar solo `replaced_by` en un retirado.
- **m4 ·** Dos promesas sin paso: «Miranda se niega a publicar un código retirado» (§Transiciones, §Datos) y «`status` avisa de todo enlace del menú que apunte a un Let no activo» (§Consumidor, §mira:status). Ni el paso 3 (solo clasifica `listSpecs`) ni el 5/8 las implementan ni dan la fuente del dato (parsear `href` de `VERGIS_MENU` contra slugs). Agregarlas o quitarlas del contrato.
- **m5 ·** El paso 4 responde con «página propia» de 503/410 que recién construye el paso 9. Para ejecutar en frío: el paso 4 entrega la página mínima (texto), el 9 la superficie.
- **m6 ·** `/healthz` con todos los Lets desactivados: `total=0, serving=0` → `phase=serving` y predicado verdadero (`predicate.mjs`: `!blk || blk[1]===blk[2]`; `botler-rollout:251-253`). Es coherente (el nodo está sano), pero un anillo «promovible con cero Lets» conviene decirlo en el paso 5. Y mantener las claves nuevas **planas** dentro de `lets`: `lets_block` (`botler-rollout:231`) recorta con `[^}]*`.
- **m7 ·** P-4: cambiar `identity.code` de un spec es el mismo caso que borrarlo (el código viejo queda `activo` sin spec → nodo `degraded`). El CHANGELOG del paso 10 nombra «quitar el spec»; debe nombrar también el renombre de código y la publicación por `parity --family specs` que elimina un archivo.
- **m8 ·** Impresiones: `retire` no revoca impresiones ya compartidas (siguen visibles vía `/impresiones` hasta CAP-82). Es defendible (fueron autorizadas al imprimir), pero conviene escribirlo con esas palabras en la tabla de datos.

### i — informativos

- **i1 ·** Filtración preexistente, no del diseño: hoy `piBlocked` responde 503 **con motivo** antes de `canOpenPi` (`routes.ts:427-428`). B1 no debe repetir el patrón; y vale abrir issue aparte.
- **i2 ·** P-3 tiene precedente resoluble por diseño: `pi-config.ts:120-122` («cambiar visibilidad o compartir sigue siendo exclusivo del dueño»). La recomendación del doc ya lo sigue; sigue siendo legítimo subirla a César porque es autoridad, no mecánica.
- **i3 ·** El test de CAS del paso 2 en `sql.js` (un proceso, un hilo) prueba lecturas rancias entre `await`s, no concurrencia de procesos; el control negativo sigue siendo válido. Decirlo evita que el ejecutor busque una concurrencia que no existe.
- **i4 ·** `x-vergis-op: 1` + JSON: razonamiento correcto (encabezado propio ⇒ preflight; sin CORS en el nodo no hay cross-site). El riesgo real —identidad forjada por `x-forwarded-*` desde dentro del anillo— es preexistente (P16) y está declarado en `vergis-ops.schema.json:113`.
- **i5 ·** Máquina de estados: completa para los tres verbos; no hay vuelta de `activo` a `especializado` (correcto: `inactivo` lo cubre); `especializado`→`deactivate` en 409 es consistente. Los repetidos están bien definidos. Concurrencia entre anillos: solo el que tiene el control escribe (modo `read` en el resto), así que el CAS del paso 2 es suficiente **una vez corregido B2**.
- **i6 ·** Alternativas A/B/C: razones de descarte correctas y verificables (A: obligaría a cada proto a parsear el campo, `discovery.ts:147-177` lee el spec vía el proto; C: sin memoria propia no hay terminalidad). D es la ideal para pre-launch; el precedente `ingestion_process.paused_at` existe (`governance-store.ts:1344`).

## 4. Preguntas a César (§9)

| Pregunta | ¿Es suya? | Nota |
|--|--|--|
| P-1 nace `especializado` o `activo` | Sí | Cambia la práctica del operador (CAP-162: publicar = servir). Bien planteada; agregar el efecto de M6 si no se corrige |
| P-2 `retire` terminal | Sí | Irreversible; el canon no lo fija. Bien planteada |
| P-3 quién puede cada verbo | Sí (autoridad) | Ver i2 |
| P-4 quitar spec degrada el nodo | Sí | Bien planteada; incluir el renombre de código (m7) |

No sobra ninguna. **No falta ninguna que sea de César**: lo que falta (B1, B2, M2, M3) lo resuelve el diseño, no él.

## 5. Riesgo del veredicto

B2(i) quedó **medido en código**, no inferido: `embeddedStores()` registra `gobierno` con `reopen: (c) => governance.reopen(c)` (`serve-rls.ts:2964-2969`) y `reabrirStores()` (`:2979-2984`) lo reabre con `storeControl()` de ese instante — es decir, el gobierno se abre en `read` mientras no hay control y pasa a `write` solo al relevar. Una siembra «al primer arranque» en standby se descarta.

Lo que menos verifiqué: el recorrido completo de las 33 llamadas a `discover()` contra la regla del paso 3 (las clasifiqué por contexto de línea, no leyendo cada función entera). Si alguna «servir y contar» resultara ser «gestionar», el hallazgo cambia de M a m, no de signo. El lector lo nota en la tabla que el paso 3 exige en el PR.

---

• *Fable 5.1 · juez · 2026-09-30*
