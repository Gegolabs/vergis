# Acta de juicio · diseño 020·001 v1.3 — ciclo de vida del Let (cuarta pasada)

| Campo | Valor |
|--|--|
| Documento juzgado | `wt/diseno-392/work/020-ciclo-de-vida-del-pi/001-diseno-activate-deactivate-retire-v1.3.md` |
| Autor | Claude Opus 5.5 (declarado en el doc) |
| Juez | Fable 5.1 (`claude-fable-5-1`), con `criterio-senior` |
| Fecha | 2026-09-30 |
| Base de código | `origin/main` = `ce2396b` (0.42.0). Toda cita re-verificada ahí, en el worktree `wt/juez-392d` (retirado al terminar) |
| Actas anteriores | v1.0 (RECHAZA) · v1.1 (RECHAZA) · v1.2 (RECHAZA acotado, sin bloqueantes: M10–M14, m16–m21, i11–i14) |
| Método | Cada resolución re-verificada contra archivo:línea en `ce2396b`, no contra lo que la v1.3 dice. **El supuesto del paso 7a se corrió** (§4): nodo real con un spec de Daftar y un spec de Mira no servible, más su control. Artefactos en `scratchpad/exp7a/` |

## 1. Veredicto

**APRUEBA CON OBSERVACIONES.** Los catorce hallazgos del tercer juicio están cerrados contra `ce2396b`; el supuesto del paso 7a **se sostiene** (lo medí: el nodo arranca en 3 s sin motor de datos con un spec de Daftar servible y uno de Mira no servible, y el control con un spec de Mira servible muere por `falta VERGIS_DATASETS`); las decisiones de César siguen fieles y P-2 sigue siendo una sola pregunta acotada. Ningún hallazgo nuevo reabre una decisión ni la arquitectura.

Quedan **dos mayores mecánicos** (M15, M16) y cinco menores. Los llamo mayores por lo que producirían si se ignoran —un dueño no-admin que no puede desactivar, contra P-3, sin que ningún test del plan lo atrape; y una tabla «decidida» que hoy dice otra cosa—, no por lo que cuesta cerrarlos: cada uno es una frase y un test, y ninguno cambia un concepto. **Condición de la aprobación:** el ejecutor no codifica el paso 6 sin M15 y M16 aplicados; el autor los asienta en una v1.3.1 (cambio de forma, Z) sin quinto juicio, o el ejecutor los aplica en la implementación y los declara en el PR con esas palabras.

## 2. Hallazgos del tercer juicio — ¿la v1.3 los cierra?

| # | Estado | Evidencia del juez (`ce2396b`) |
|--|--|--|
| **M10** P22 falsa; `mira:status` fuera del plan | ✅ cerrado | `grep -c -i "no disponible" plugins/mira/skills/status/SKILL.md` → **2**; `scripts/plugin-lockstep.ts`, `tests/plugin-corte.test.ts` y `plugins/vergis/bin/vergis-ops` existen. P22 reescrita; paso 8c con control (`grep` → 0); «lo que no entra» ya no nombra a `mira`; ejecutor parte de `ce2396b` |
| **M11** vista previa de un `especializado` no servible | ✅ cerrado | «Solo hay vista previa de lo servible» **(decidido)**, con `discovery.ts:150-158` (cap fuera del catálogo, `continue` en :157) y `:163-172` (fabric, tablas sin esquema, `continue` en :166) — verificadas. Tabla «¿Qué ve cada quien?» actualizada; control negativo 5 del paso 4 con espía sobre la Capability de serving |
| **M12** sin store todos eran gestor | ✅ cerrado | Sección nueva «¿Qué pasa sin store de gobierno?». `serve-rls.ts:1200` (`if (!governance) return 'owner'`) y el cuerpo exacto del 403 de `/contrato` (`contract.ts:495-497`: «El contrato operativo requiere la Administración habilitada (no hay store de gobierno).») verificados; `let status` lo traduce por cuerpo. Control negativo 6 del paso 4; quinto test del paso 5. Queda una inconsistencia de redacción con el paso 3(c) y con una fila vieja (m23) |
| **M13** guarda por conteos negaba el rollback | ✅ cerrado | Marcador `"lifecycle": 1` de nivel superior; `jnum` (`botler-rollout:82`) busca la clave por regex sobre el cuerpo entero, así que lo lee sin recorte; `lets_block` (`:231`) sigue leyendo solo el bloque. `promote` se niega sin marcador salvo `--acepto-reexponer`; **`rollback` nunca se niega y grita**. Cinco tests en 7b, y la corrida que refutaría la lectura de P34 va al PR. Lo que re-expone y si el operador se entera: ver i16. Falta decir cómo `cmd_promote` sabe que es rollback (m24) |
| **M14** control del instrumento de 7c no discriminaba | ✅ cerrado | 7c afirma `expect(r.err).not.toMatch(/el control lo tomó/)`; el `warn` vive en `insistir_handover`, `botler-rollout:311-319` (verificado). §«¿Qué se midió?» corregida: «aborta por la misma salida» |
| **m16** «una sola llamada» vs sucesor | ✅ | «una vez por código y por petición»; test cuenta por código |
| **m17** arnés inexistente | ✅ | P35 dice con esas palabras que no existe; 7a construye `tests/helpers/nodo.ts` sobre `lease-arranque-fallido.test.ts:33-71` (verificado: spawnea `serve-rls.ts` con `VERGIS_SPECS_DIR`/`VERGIS_OUT`). El supuesto quedó etiquetado — y ahora medido (§4, i15) |
| **m18** tres casos del handler | ⚠ **a medias** | El orden correcto está en la línea del paso 6 y en la prosa que sigue a la tabla; pero **la tabla misma está corrompida** (M16) |
| **m19** `smoke` 200-sin-bloque vs 403 | ✅ | Frase y tres tests en 8b |
| **m20** enlace a `activo` sin spec o bloqueado | ✅ | **(decidido)**: `bloqueado` se enlaza, `sin-spec` no |
| **m21** un 403 sembraba gobierno | ✅ | `rolSinSembrar`; `piManagementRole` siembra en `serve-rls.ts:1201-1203` (verificado). Control negativo 4 del paso 6 |
| **i11** citas del CHANGELOG | ✅ | `CHANGELOG.md:224` («La migración es **aditiva** y no sube `SCHEMA_VERSION`»), `:487-490` («0.34.0 abre y escribe el archivo migrado (medido)»), `:546`; `deploy/rollout/README.md:183` — todas calzan en `ce2396b` |
| **i12** reproducción de B3 | ✅ | Citada en §«¿Qué se midió?» |
| **i13** `VO_ADMIN` en `smoke` | ✅ | P36; 8b copia `contract.mjs:88-91` |
| **i14** `x-vergis-op` sin precedente | ✅ | `git grep -c -i x-vergis-op -- server` → 0 (verificado); el handler lleva el comentario |

**Abiertos del tercer juicio:** m18, solo por la tabla (M16).

## 3. Hallazgos nuevos de la v1.3

### B — bloqueantes

Ninguno.

### M — mayores (mecánicos)

**M15 · `POST /admin/api/lets/<code>/…` cae dentro del gate de `admin.tryHandle`, que no deja pasar a un dueño no-admin; y sin store no llega a ningún handler.** `routes.ts:225-229` despacha todo `/admin/*` a `admin.tryHandle` **solo si `admin` existe**; `admin.ts:436-459` resuelve `isAdmin` y, si no es admin y no gestiona ningún dominio, responde **403 HTML** «No gestionas ninguna plataforma ni dominio» y audita `admin-access-denied` — antes de cualquier subruta. Un dueño de PI que no es admin de plataforma (el actor que P-3 autoriza para `activate`/`deactivate`) nunca llegaría al handler. Y sin store, `admin` es `null` (`serve-rls.ts:1562`; se asigna en el bloque de gobierno, `:1635`), así que `/admin/api/lets/...` cae al router de PIs, busca el slug `admin` y responde **404** «Producto de Información no encontrado», no el 503 que la sección sin store promete. **Ningún test del plan lo atraparía:** el control negativo 4 del paso 6 usa un no-dueño; el e2e del paso 8 corre con `RINGS_ADMIN_EMAIL` (admin); el paso 9 va por `/<slug>/config`, no por la API. El error de criterio se propagaría en silencio.
Corrección (una frase y un test): el handler de la API se monta en el despacho de `routes.ts` **antes** de `admin.tryHandle` e independiente de que `admin` exista (como `/healthz` y `/contrato`), con su propio gate de rol (`rolSinSembrar`) y el chequeo 0 (sin store → 503). Test positivo en el paso 6: un **dueño no-admin** hace `deactivate` → 200 `changed`; control negativo: montado dentro de `admin.tryHandle`, recibe 403 HTML y el test falla. Segundo: sin store, `POST …/deactivate` → 503 JSON, no 404.

**M16 · La tabla de ocho chequeos del handler está corrompida.** En §«¿Qué queda en el log?», las filas 4, 5 y 6 contienen el texto íntegro de los **pasos 4, 5 y 6 del plan** (router, `/healthz`, API de operación) en lugar de los chequeos «rol → 403 `forbidden` (sí, log)», «cuerpo > 16 KiB → 413 `rejected`» y «JSON inválido → 400 `rejected`». Es la tabla que m18 pidió y está marcada **(decidido)**. El orden correcto sobrevive en la línea del paso 6 («sin store 503 → sin control 409 → bytes crudos y hash → código inexistente 404 → rol sin sembrar → tamaño 413 → parseo 400 → máquina») y en la prosa siguiente («un cuerpo malformado o gigante de quien no tiene el rol da `forbidden`»), así que el ejecutor puede reconstruirla — pero un documento para arrancar en frío no puede tener su tabla decidida diciendo otra cosa.
Corrección: reescribir las filas 4–6 con los tres chequeos y su columna de log (`forbidden` sí · `rejected` sí · `rejected` sí).

### m — menores

- **m22 · `total = serving = activos` en `clickhouse` contradice P-4.** Paso 5 dice que un `activo` sin spec «cuenta en `total` y no en `serving`» y que degrada (segundo test), pero para `clickhouse` fija `total = serving = activos`. Con esa fórmula un `activo` sin spec en `clickhouse` no degrada. Debe ser `total = activos`, `serving = activos con spec servible` (la servibilidad global sigue en `ready`, como hoy `healthSummary`, `serve-rls.ts:1409-1418`). **No rompe el predicado ni el poller** (verificado): `serving_ok` (`botler-rollout:245-255`) acepta el bloque si `total == serving`, y sin bloque solo exige que no haya `total` suelto; `lets_block` recorta `[^}]*` y las claves nuevas son planas. Hoy un nodo `clickhouse` con un Let de Daftar ya publica el bloque (lo vi en §4: `"lets":{"total":1,"serving":1}`).
- **m23 · Dos redacciones viejas contradicen la sección sin store.** Paso 3(c): «sin marca de siembra **(o sin store)**, un código sin fila toma el estado que la siembra le daría» — sin store `lets()` = `discover()` y lo no servible no entra. Y la fila «Nuevo, del autor · sin store de gobierno» de la tabla del segundo juicio conserva «todo Let se trata con la regla de siembra virtual… que es lo que el nodo hace hoy» (la afirmación que M12 refutó). Alinear ambas con «¿Qué pasa sin store de gobierno?».
- **m24 · `cmd_promote` no sabe que es un rollback.** `cmd_rollback` (`botler-rollout:887-900`) delega en `cmd_promote` con los mismos flags y sin señal alguna. Para las dos conductas de 7b (negar en `promote`, proceder gritando en `rollback`) el ejecutor necesita una señal —una variable que `cmd_rollback` ponga antes de delegar, o un flag interno— y el doc debe nombrarla. Precedente de forma y ubicación: el gate de esquema del pre-flight (`:368-398`), que ya distingue el caso sin store con `--no-schema-gate`.
- **m25 · El chequeo 3 (404 `rejected`) va antes del rol y revela lo que el router esconde.** Cualquier usuario autenticado que llame a la API con un código `especializado` recibe 403 `forbidden` (existe), y con uno inexistente 404: distingue lo que el paso 3 del orden del router se esmera en ocultar (M7). Además puede escribir entradas `rejected` en el log a voluntad. Propuesta: para quien no es gestor del código, un código inexistente y un `especializado` responden igual (404) y la entrada se registra igual (`rejected` con `rejection: "código inexistente"` en un caso, `forbidden` en el otro — el log sí puede saber; la respuesta no). Es menor porque exige un sondeo deliberado por un usuario ya autenticado, pero es la misma clase de fuga que M7.
- **m26 · El paso 7a nombra un fixture de Daftar que el proto real rechaza.** El YAML de `tests/discovery.test.ts:301` (`daftar_version` + `identity`) es de un proto ficticio; el proto real exige `estudiantes` no vacío (`packages/daftar/src/spec.ts:46-51`). El arnés necesita el YAML completo (el de §4 sirve). Y el nodo evalúa `NODO_SIN_MOTOR_DE_DATOS` **una vez** al arrancar (`serve-rls.ts:634`, comentario «agregar una spec de Mira en caliente… es un restart»): el arnés no puede `activate` un spec de Mira que se vuelva servible después; el punto de validación se prueba en los tests unitarios con dependencias falsas, no en el arnés. Decirlo en 7a.

### i — informativos

- **i15 · El supuesto del paso 7a se sostiene — medido por el juez** (§4). El doc puede quitar «se asume, sin verificar» y citar la corrida. Condiciones que la corrida fija: engine `clickhouse` (el default, `serve-rls.ts:215`); el no servible lo es **por capability** (`execute-sql-dwh` bajo `clickhouse` cae en `discovery.ts:157`); el store de gobierno se enciende con `VERGIS_ADMIN_SEED` (`serve-rls.ts:1628, 1635`) y `governance.sqlite` aparece en `VERGIS_OUT` al arrancar con control.
- **i16 · Qué re-expone un rollback y si el operador se entera.** Al volver a un anillo sin marcador, el destino sirve todo spec presente en el directorio: los `inactivo` y `retirado` con spec (el retiro no borra el archivo) y los `especializado` **servibles** (nuevos sin activar). Los no servibles siguen 404. El grito llega al operador también por el plugin: `rollout.mjs:43-48` recoge cada línea de la herramienta y `:111-112` las imprime con `| `. Dos consecuencias que el paso 10 debería nombrar: (a) al re-promover la versión con ciclo de vida, la tabla y la marca siguen (migración aditiva), así que los estados vuelven solos; (b) un spec publicado **durante** la ventana de rollback nace `especializado` al re-promover (marca presente) y **deja de servirse** hasta `activate` — el grito del rollback puede avisarlo.
- **i17 · `verifyChainLines` existe** (`packages/botler/src/log.ts:86`, exportado en `index.ts:3`); `AppendOnlyLog` se crea dentro del bloque de gobierno (`serve-rls.ts:1697`), como dice el chequeo 0.
- **i18 · El 409 de standby y el 503 sin store son ortogonales al montaje de M15** — el orden de ocho chequeos no cambia; solo cambia dónde vive el handler.

## 4. Lo que se corrió (supuesto del paso 7a)

Sobre `ce2396b` (checkout principal, limpio, mismo commit), `node_modules/.bin/tsx server/serve-rls.ts` con `VERGIS_OUT` y `VERGIS_SPECS_DIR` en el scratchpad, `VERGIS_ADMIN_SEED=admin@test`, `VERGIS_DATASETS=` (vacío), sin `VERGIS_ENGINE` (default `clickhouse`). Specs: `d.yaml` = Daftar real (`daftar_version`, `identity.code: estudios`, un estudiante); `m.yaml` = `deploy/rollout/bench/specs/pi-01.yaml` con `capability: execute-sql-dwh` (fuera del catálogo de `clickhouse`). Control: mismo `d.yaml` y el `pi-01.yaml` original (`execute-sql-ch`, servible).

| Corrida | Resultado | Log (claves) | `VERGIS_OUT` |
|--|--|--|--|
| **Experimento** (Daftar servible + Mira no servible) | `/healthz` a los **3 s**: `{"ok":true,"engine":"clickhouse","phase":"serving","lets":{"total":1,"serving":1}}`; proceso vivo | «control ADQUIRIDO (modo lease · época 1)» · «'…/m.yaml' no servible bajo engine=clickhouse (capability fuera del catálogo: execute-sql-dwh) — omitido» · «ningún Let descubierto consume datos gobernados (estudios:daftar): el nodo arranca SIN motor de datos» · «1 PI por-consumidor en :18392 · rutas: /estudios» | `governance.sqlite`, `master-data.sqlite`, `control.lease.json`, `contrato` |
| **Control** (Daftar + Mira servible) | Muere; `/healthz` no responde | «control ADQUIRIDO» · `Error: engine=clickhouse: falta VERGIS_DATASETS (datasets del nodo).` | — |

Lectura: el spec de Mira no servible no obliga al nodo a exigir datasets, porque `NODO_SIN_MOTOR_DE_DATOS` se calcula sobre `discover()` (`serve-rls.ts:634`), que ya lo omitió; el control demuestra que el instrumento sabe reprobar. El arnés de 7a es viable tal como está descrito, con las condiciones de i15 y m26. Artefactos: `scratchpad/exp7a/{specs,specs-ctl,exp.log,ctl.log}`.

## 5. Las decisiones de César

Sin cambio respecto del acta v1.2: P-1, P-3 y P-4 fieles; P-2 sigue siendo una sola pregunta (`--replaced-by` en `deactivate`) con sus menciones 🙋 localizadas. M15 no toca P-3: la hace cumplible.

## 6. Riesgo del veredicto

- M15 está leído en código (`routes.ts:225-229`, `admin.ts:436-459`, `serve-rls.ts:1562, 1635`), no corrido con un dueño no-admin contra un handler que no existe todavía. La corrida que lo refutaría es el test positivo que M15 pide; si el ejecutor monta el handler dentro de `admin.tryHandle` y ese test pasa, M15 estaba mal leído.
- m22 y m25 son lecturas del doc contra el código, sin corrida; sus refutadores son los tests que proponen.
- i15 está **medido** (§4).

---

• *Fable 5.1 · juez · cuarta pasada · 2026-09-30*
