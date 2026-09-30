# Acta de juicio · diseño 020·001 v1.2 — ciclo de vida del Let (tercera pasada)

| Campo | Valor |
|--|--|
| Documento juzgado | `wt/diseno-392/work/020-ciclo-de-vida-del-pi/001-diseno-activate-deactivate-retire-v1.2.md` |
| Autor | Claude Opus 5.5 (declarado en el doc) |
| Juez | Fable 5.1 (`claude-fable-5-1`), con `criterio-senior` |
| Fecha | 2026-09-30 |
| Base de código | `origin/main` = `35ca860` (incluye #393, los tres plugins). El doc cita `ee31be9`; cada cita se re-verificó en `35ca860` |
| Actas anteriores | v1.0 (RECHAZA: 2 B, 6 M, 8 m, 6 i) · v1.1 (RECHAZA: 1 B, 3 M, 7 m, 4 i) |
| Método | Cada resolución re-verificada contra archivo:línea en `35ca860`, no contra lo que la v1.2 dice. **B3 se reprodujo** con un fixture propio en `wt/juez-392c` (retirado al terminar); el script y los dos fixtures quedan en `scratchpad/b3/` |

## 1. Veredicto

**RECHAZA (v1.2) — alcance acotado, sin bloqueantes.** Los dieciocho hallazgos del segundo juicio están cerrados; B3 está **medido de verdad** (lo reproduje: exit 1, «NO llegó a 'serving' (fase: degraded)», borde y registro de vuelta a 0.41.0; control exit 0). Las decisiones de César (P-1, P-3, P-4) están reflejadas con fidelidad y P-2 queda como pregunta bien acotada.

Lo que rechaza son **cinco mayores nuevos**, ninguno de arquitectura, todos de la clase «el ejecutor en frío produciría lo equivocado»: una premisa que #393 volvió falsa y deja un paso fuera del plan (M10); la vista previa de un `especializado` no servible, que como está escrita puede saltarse el fail-closed del descubrimiento (M11); la conducta sin store, donde todo usuario es gestor (M12); la guarda 7b, que bloquea el rollback de emergencia con un override cuyo nombre miente en ese caso (M13); y el control del instrumento de 7c, que **no discrimina** — lo medí (M14). Una v1.3 que cierre esos cinco, con las m, es aprobable.

## 2. Hallazgos del segundo juicio — ¿la v1.2 los cierra?

| # | Estado | Evidencia del juez (`35ca860`) |
|--|--|--|
| **B3** siembra `activo` de lo no servible aborta la promoción | ✅ **cerrado y medido** | Reproducido (§4): fixture con `on_control` + relevo que reconoce `degraded` como titular → `promote 0.42.0` exit 1, «el candidato NO llegó a 'serving' (fase: degraded)», «promoción ABORTADA en el handover. El borde volvió a apuntar a 'vergis-0-41-0'», `active.caddy` → 0-41-0, `rings.json` `active: 0.41.0`; control sin `on_control` → exit 0, borde a 0-42-0. La siembra por servibilidad (7a) más la regla virtual cierran el mecanismo: sembrar no cambia los conteos. 7c la deja como regresión permanente — pero su **control del instrumento está mal escrito** (M14) |
| **M7** en `especializado` el sin-acceso aprendía más | ✅ cerrado | Paso 3 del orden (404 antes del 403, rol resuelto una vez; `canOpen`/`canCollaborate` en `pi-authz.ts:56-57`). Control negativo 2 del paso 4. Borde nuevo: sin store, todos son gestor (M12) |
| **M8** 409 de standby escribía el log compartido | ✅ cerrado | «(decidido) el 409 de standby no escribe»; fila «—» en la tabla de `result`; control negativo 3 del paso 6 (tamaño del archivo). `VERGIS_OUT` compartido y `seq=0` por proceso confirmados (`compose.reference.yml:107,151`; `log.ts:25-27`) |
| **M9** + mitad de **M5** override no heredado | ✅ cerrado | `rollout.mjs:97-99` sigue igual en `35ca860` (#393 no tocó `lib/`). El plugin no ejerce `--acepto-reexponer`, con el precedente citado. Test del plugin en 7b. Consecuencia no vista: M13 |
| Mitad de **M1** + **m9** identidad admin para `/contrato` | ✅ cerrado | `contract.ts:495-507` exige admin; `contract.mjs:23, 88-91` ya usa `VO_ADMIN=RINGS_ADMIN_EMAIL`. `smoke.mjs:123` hoy no exporta `VO_ADMIN` al `exec`: el ejecutor copia el patrón de `contract.mjs:88-91` (i13) |
| **m10** bootstrap de un retirado | ✅ cerrado | Declarado inocuo; en standby cae en handle de lectura (`sqlite.ts:375-383`) |
| **m11** `replacedBy` a un `especializado` | ✅ cerrado | Reglas del sucesor: `activo`/`inactivo` al retirar, `activo` al desactivar; enlace solo si la cadena termina en `activo`. Borde nuevo: `activo` sin spec (m20) |
| **m12** enlace al sucesor sin comprobar acceso | ✅ cerrado | «comprueba el acceso del visitante al sucesor»; control negativo 4 del paso 4. Choca con «una sola llamada a `piManagementRole` por petición» (m16) |
| **m13** «byte a byte» | ✅ cerrado | «mismo status y mismo cuerpo»; `fail()` determinista (`http-util.ts:66-73`) |
| **m14** gate de época en la medición | ✅ cerrado | Paso 2: época leída en `read`, proveedor ≥, reporte distingue `code` (`sqlite.ts:128-150`: `SQLITE_SCHEMA_TOO_NEW` vs `SQLITE_EPOCH_FENCED`) |
| **m15** orden `forbidden`/hash | ✅ cerrado | Orden fijado en §«¿Qué queda en el log?» y paso 6, control negativo 2. Faltan tres casos del mismo handler (m18) |
| **i7** rol dos veces | ✅ cerrado | Paso 2 del orden; test de conteo en el paso 4 (ver m16) |
| **i8** precedente del journal | ✅ cerrado | Citado con `contract.ts:476, 509` (verificado: «un 403 JAMÁS escribe el journal») |
| **i9** cadena por proceso | ✅ cerrado | Dicho en §log y paso 6 |
| **i10** signo del test de 7a | ✅ cerrado | «`especializado` con su motivo» |

**Abiertos del segundo juicio: ninguno.**

## 3. Hallazgos nuevos de la v1.2

### B — bloqueantes

Ninguno.

### M — mayores

**M10 · P22 es falsa en `main` y deja un paso fuera del plan.** `35ca860` (#393) trae `plugins/mira/` con `skills/status/SKILL.md`, cuyo frontmatter y cuya sección «`activate` · `deactivate` · `retire`» dicen «**No disponible.** El Producto aún no define qué significa `<verbo>` … (#392)». El doc dice «P22 ❌ `ls plugins/`: solo `vergis`» y «Lo que **no** entra: … el plugin `mira` (trabajo del diseño 288, P22)» — y §«¿Cómo lo usa `mira:status`?» describe justamente lo que esa skill tiene que pasar a decir. Sin un paso, el ejecutor entrega el Producto con `mira:status` respondiendo «no disponible» a una capacidad que existe, y con la skill citando #392 como abierto. Además `Ejecutor: … sobre main (≥ 0.41.0)` debe ser `≥ 35ca860` (0.42.0), y el CLI ahora también se invoca por `plugins/vergis/bin/vergis-ops` (wrapper nuevo de #393).
Corrección: premisa P22 reescrita (existe, y su `status` dice «no disponible»); paso nuevo (8c o dentro de 8): `plugins/mira/skills/status/SKILL.md` (frontmatter + sección de los tres verbos, que pasan a invocar `vergis-ops let …`) y `plugins/mira/CHANGELOG.md`, bajo el lockstep de `scripts/plugin-lockstep.ts` y `tests/plugin-corte.test.ts`; quitar «el plugin `mira`» de lo que no entra. Control: `grep -n "No disponible" plugins/mira/skills/status/SKILL.md` → 0.

**M11 · La vista previa de un `especializado` no servible no está definida, y la lectura literal de la tabla salta el fail-closed del descubrimiento.** La tabla «¿Qué ve cada quien?» dice, para gestor en `especializado`: «Se sirve con una franja … (vista previa)». Pero un código que solo `parsed()` conoce **no tiene `Report` servible**: `discover()` lo omitió por caps fuera del catálogo (`discovery.ts:150-154`) o, en fabric, por tablas sin esquema no verificables contra el policy store (`:163-166`, «fail-closed»). El paso 3(e) dice «despacho y render → el `Report` servible del Let», que para este caso no existe: el ejecutor tiene dos frases y ninguna regla. Si construye la vista previa desde `parsed()`, sirve a un gestor (dueño, colaborador — no necesariamente admin de datos) un spec que el descubrimiento rechazó por gobierno. Sería B si se ejecuta la tabla al pie de la letra.
Corrección: la vista previa existe **solo si el Let es servible** (`discover()` lo contiene); un `especializado`/`inactivo` no servible responde al gestor una página con `healthReason` y **no invoca** serving. Control negativo: gestor pide `/<slug>` de un `especializado` no servible → página con motivo, y el espía verifica que la Capability de serving no se llamó. Conecta con el punto de validación de `activate` (mismo gate).

**M12 · «Sin store de gobierno … es lo que el nodo hace hoy» es falso con el orden del router, porque sin store todos son gestor.** `piManagementRole` devuelve `owner` sin store (`serve-rls.ts:1200`), así que `esGestor = canCollaborate('owner')` es verdadero para **todo** usuario. Con la regla virtual, un spec no servible es `especializado`; el paso 3 (404 al no gestor) nunca dispara; todos caen en la vista previa de M11. Hoy sin store ese spec da 404 a todos. La sección está marcada **(decidido)**. Además, sin store `/contrato` responde 403 «requiere la Administración habilitada (no hay store de gobierno)» (`contract.ts:495-497`), no un bloque `lets[]`: `let status` tiene que mapear ese 403 al mensaje que el doc promete.
Corrección: sin store, **el ciclo de vida no participa del router**: `lets()` = `served()` = `discover()`, sin paso 3 ni 5 (exactamente hoy), la API 503 y `let status` traduce el 403 de `/contrato`. Control negativo: sin store, un spec no servible da 404 a un usuario cualquiera; con la v1.2 literal, daría vista previa.

**M13 · La guarda 7b, con el snapshot del standby, bloquea el rollback de emergencia y fuerza un override que en ese caso miente.** El destino de un promote/rollback es un standby, y su `/healthz` cuenta desde el store abierto en `read` al arrancar — un snapshot (P18; el doc lo dice: «no ve los cambios del activo hasta reabrir»). Cualquier `deactivate`/`retire` posterior al arranque del destino hace que el activo traiga `inactive:1` y el destino no, y la guarda «se niega igual». Consecuencias: (a) el **rollback** —el camino de emergencia— queda negado desde el plugin, que no ejerce el override; (b) el único paso adelante es `--acepto-reexponer` a mano, cuyo nombre afirma algo falso: ese destino conoce la tabla y **reabrirá en escritura en el relevo** (`reabrirStores`, `serve-rls.ts:3082`) — no re-expone nada; (c) el flujo normal `install` → `deactivate` → `promote` también se niega. La igualdad de conteos no es el predicado correcto porque el conteo del standby es rancio **por diseño**.
Corrección: la guarda pregunta si el destino **conoce el ciclo de vida**, no si sus conteos calzan: un marcador de capacidad (p. ej. `lets.lifecycle: 1` en `/healthz` de todo nodo con la tabla, o la versión/`capacidades` de `/contrato` del candidato, que el pre-flight ya lee con `RINGS_ADMIN_EMAIL`). Sin marcador y con no-activos > 0 en el activo → se niega (el anillo 0.41.0 re-expondría); con marcador → procede. Control negativo: destino con marcador y snapshot rancio → `promote` sale 0; destino sin marcador → se niega. `--acepto-reexponer` queda solo para el caso sin marcador.

**M14 · El control del instrumento de 7c no discrimina — medido.** El paso 7c dice: «sin el cambio del relevo continuo, el aborto sale por el camino equivocado («el control lo tomó…») y el test afirma el mensaje «NO llegó a 'serving'», así que falla». Corrí las dos variantes (§4): **sin** el cambio del relevo, stderr trae `el control lo tomó '0.41.0'` **y también** `el candidato NO llegó a 'serving' (fase: degraded)` y `promoción ABORTADA`. La razón está en `botler-rollout:311-319`: «el control lo tomó» es un `warn` dentro del bucle de `insistir_handover`, no una salida distinta; el aborto es el mismo. Un test que afirma «NO llegó a 'serving'» pasa con y sin el arreglo del instrumento — y §«¿Qué se midió?» dice «abortaba por otro camino», que es inexacto. Norma 7, corolario de los instrumentos.
Corrección: el control del instrumento afirma `expect(r.err).not.toMatch(/el control lo tomó/)`; sin el cambio (b) del fixture, ese `warn` aparece y el test falla. Y corregir la frase de §medición: «abortaba por la misma salida, con el `warn` "el control lo tomó" delatando que el mundo falso devolvió el control al viejo».

### m — menores

- **m16 ·** «Una sola llamada a `piManagementRole` por petición» (paso 2 y test de conteo del paso 4) choca con la comprobación de acceso **al sucesor** (m12), que es otro código. Escribir «una vez por código por petición»; el test de conteo cuenta por código.
- **m17 ·** El test de 7a nombra «el fixture del plano de control (`tests/store-reopen-relevo.test.ts`, `tests/standby-control.test.ts`)». Ninguno arranca un nodo: `standby-control` prueba `createRequestHandler` con deps falsas; `store-reopen-relevo` prueba el store solo. El arnés que 7a necesita (nodo con specs en disco, lease, `/healthz`, lectura del `governance.sqlite`, relevo) no existe; el precedente más cercano es `tests/lease-arranque-fallido.test.ts:33-71` (spawnea `server/serve-rls.ts` con `VERGIS_SPECS_DIR`/`VERGIS_OUT` y `ControlLease`). Decirlo con esas palabras para que el ejecutor en frío no busque un fixture que no está.
- **m18 ·** El orden del handler no dice: (0) sin store → 503, ¿antes o después del 409?; código inexistente → 404 con `result` ¿`rejected`? ¿sin entrada?; cuerpo > 16 KiB → ¿413, `rejected`? Fijar los tres.
- **m19 ·** `smoke` «contra un nodo anterior sin bloque `lets[]` conserva la conducta de hoy» debe distinguir **200 sin bloque** (nodo anterior) de **403** (`RINGS_ADMIN_EMAIL` sin rol, o sin store): el segundo es «no pude medir», y ya lo dice el segundo test de 8b — solo falta que la frase no lo contradiga.
- **m20 ·** «enlaza solo si termina en un `activo`»: un `activo` sin spec (P-4) o `bloqueado` es un enlace a un 503. Decidir: se enlaza igual (el 503 explica) o se exige `activo ∧ sirviendo`.
- **m21 ·** `paramsSha256` sobre bytes crudos y `forbidden` antes de parsear: el `piManagementRole` del paso (4) **bootstrapea** gobierno para un 403 (m10 lo declara inocuo para retirados; vale igual acá). Decir que un intento denegado sobre un código sin gobierno lo siembra, o resolver el rol sin sembrar en la API.

### i — informativos

- **i11 ·** Citas verificadas en `35ca860`: todo `server/`, `packages/`, `deploy/rollout/botler-rollout`, `deploy/compose.reference.yml` y `plugins/vergis/lib/*` están intactos desde `ee31be9` (#393 no los tocó); las líneas del doc valen. Las tres citas del `CHANGELOG.md` (174, 437-440, 496) están **+50** en `35ca860` (224, 487-490, ~546) porque #393 insertó su entrada; el doc dice `ee31be9`, así que no es error, pero la v1.3 debería re-anclar.
- **i12 ·** Reproducción de B3 por el juez, sobre `35ca860`, sin vitest: `scratchpad/b3/corrida.sh` con `fake-docker-oncontrol.sh` (los dos cambios del doc) y `fake-docker-sinfix.sh` (solo `on_control`, sin el relevo). Resultados en §4.
- **i13 ·** `RINGS_ADMIN_EMAIL` es variable del host de `botler-rollout` (`:47`; `README.md:67`), y `contract.mjs:88-91` la exporta como `VO_ADMIN` al `docker exec`; `smoke.mjs:123` hoy exporta solo `VERGIS_OPS_GATE_TOKEN` y `VO_CFG`. El paso 8b copia ese patrón; no hace falta un campo nuevo, como el doc dice.
- **i14 ·** `x-vergis-op: 1` como sustituto del CSRF de formulario no tiene precedente en `server/` (`git grep -i x-vergis-op` → 0); `admin.ts` usa `requireCsrf`. La justificación (preflight CORS por encabezado propio + `content-type: application/json`) es correcta; conviene dejarla en el código con esas palabras para que nadie la «arregle» agregando CSRF de formulario.

## 4. Lo que se corrió (B3 y el control del instrumento)

Sobre `35ca860`, `sh deploy/rollout/botler-rollout` con `RINGS_DOCKER` apuntando a un fixture copiado de `tests/fixtures/anillos/fake-docker.sh` y el mismo entorno del arnés (`RINGS_PROMOTE_TIMEOUT=8`, `--timeout 4`). Secuencia: `install 0.41.0` → `promote 0.41.0` → `install 0.42.0` → (`on_control=degraded` en el candidato) → `promote 0.42.0`.

| Corrida | Fixture | exit | stderr (claves) | `active.caddy` | `rings.json` |
|--|--|--|--|--|--|
| Control | con relevo que reconoce `degraded`, sin `on_control` | **0** | — | `vergis-0-42-0` | `active: 0.42.0` |
| B3 | ídem, `on_control=degraded` | **1** | «NO llegó a 'serving' (fase: degraded)» · «ABORTADA en el handover. El borde volvió a apuntar a 'vergis-0-41-0'» | `vergis-0-41-0` | `active: 0.41.0` |
| Control del instrumento | solo `on_control`, relevo sin cambio | **1** | «el control lo tomó '0.41.0'» (×2) **y** «NO llegó a 'serving' (fase: degraded)» · «ABORTADA» | `vergis-0-41-0` | `active: 0.41.0` |

Lectura: B3 es real y 7c la fija como regresión. Pero la tercera fila muestra que el discriminante que 7c propone («el test afirma NO llegó a 'serving', así que falla») **no falla**: el mensaje aparece en las dos variantes del instrumento. El discriminante correcto es la ausencia del `warn` «el control lo tomó».

## 5. Las decisiones de César

| Pregunta | Decisión | ¿Fiel en la v1.2? |
|--|--|--|
| P-1 | Nace `especializado` | Sí: máquina, alta implícita `from: null`, regla virtual con marca, 7a, CHANGELOG del paso 10 |
| P-3 | `activate`/`deactivate` dueño o admin; `retire` solo admin | Sí: §«Quién puede cada verbo», custodia de `retire`, pasos 6 y 9 con su control negativo (colaborador → 403 + `forbidden`) |
| P-4 | Quitar el spec de un `activo` degrada | Sí: transiciones sin verbo, paso 5 (segundo test), CHANGELOG nombra las tres formas (borrar, renombrar `identity.code`, `parity --family specs`) |
| P-2 | Terminal; «¿otro reversible?» | Bien acotada: una sola pregunta (`--replaced-by` en `deactivate`), tres menciones 🙋 localizadas, y «si no se confirma se quitan y nada más cambia». La respuesta de fondo (el reversible es `deactivate`; `inactivo`=hibernación, `retirado`=decommissioning, línea 1293-1294) coincide con la del acta v1.1 |

## 6. Riesgo del veredicto

- M11/M12 dependen de que el ejecutor lea la tabla antes que el paso 3(e); un ejecutor cuidadoso podría no renderizar lo no servible. Aun así, dos frases contradictorias en un doc «para arrancar en frío» son defecto del doc, no del ejecutor, y la sección sin store está marcada **(decidido)** con una afirmación falsa.
- M13 está leído en código (`serve-rls.ts:372-376, 2979-2990, 3082`; P18 del propio doc), no corrido con dos nodos reales. La corrida que lo refutaría: dos nodos del arnés de m17, `deactivate` en el activo después de arrancar el standby, `GET /healthz` al standby → si trae `inactive:1` sin reabrir, M13 está mal leído.
- M14 está **medido** (§4, tercera fila).

---

• *Fable 5.1 · juez · tercera pasada · 2026-09-30*
