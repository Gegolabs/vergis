# Plan · Consola SQL para Mira — superficie de Ingeniería sobre los Conectores registrados, data-anchored y sin bypass

| Campo | Valor |
|--|--|
| Objetivo | Una **Consola SQL** que un ingeniero abre desde el avatar, elige un Conector registrado, escribe T-SQL, lo ejecuta y ve el resultset — **viendo exactamente las filas y columnas que un PI de Mira le mostraría a él**, jamás más. Toda ejecución queda en un log append-only con su actor real. |
| Origen | Issue [#306](https://github.com/Gegolabs/vergis/issues/306) — expectativa escrita por César Obach (2026-09-07). Regla rectora del issue: *«la Consola acota, nunca amplía»* (data-anchored / no-bypass, MUST). |
| Ejecutor | Un subagente Opus con este documento como único contexto, en un worktree sobre `main` (0.32.0). Reparto Norma 8: este plan es el contrato; el ejecutor no reabre las decisiones marcadas **(decidido)**, y deja **sin implementar** lo marcado 🙋 (decisión humana pendiente). |
| Estado | **Diseño listo para ejecutar la Fase 1 (Producto).** La Fase 2 (instancia A.R.B.O.L.) tiene pendientes gated a César, listados al final. |
| Versión de este plan | 1.1 · 2026-09-21 — cierra la segunda mirada: P-1 y P-6 resueltas, ClickHouse sale por alcance y no por límite del motor (medido), y la sonda del gate (d) prueba con la clave real en el mismo batch |
| Versión | Entra en «Sin publicar» → corte **0.33.0** (capacidad ⇒ sube la Y). Fila nueva en `docs/capacidades.md` con el próximo `CAP-NN` libre al momento del PR (**no se reserva acá**; el último visto es `CAP-196`). |
| Motor cubierto en v1 | **Fabric / T-SQL** (`engine=fabric`). ClickHouse queda **fuera con su razón** (§10). |
| Alcance de escritura | **Solo lectura, absoluto**, garantizado por el **principal** de la conexión, no por un parser (§5). Escritura = fuera de alcance de v1. |

---

## ¿Cuál es la tesis, en cinco líneas?

1. **La Consola no ejecuta bajo la identidad técnica del nodo.** El Service Principal de serving es *Admin* de los workspaces de la instancia de referencia (`lab/RESOURCES.md:249`, «Admin de los ws de dominio, write OneLake») — bajo él, un `SELECT` ad-hoc es un bypass completo (puede `ALTER SECURITY POLICY … STATE = OFF`, leer sin máscara, escribir). Ejecuta bajo un **principal de consola, de solo lectura, propio de cada Conector**, con los claims del ingeniero inyectados por `SESSION_CONTEXT` **en modo `@read_only`** sobre una **conexión dedicada** que se descarta al terminar.
2. **La RLS del motor hace el trabajo, igual que para un PI.** El ingeniero ve las filas que su claim autoriza y las columnas con regla de columna **siempre enmascaradas**. Eso es *menos* de lo que un ingeniero espera de una consola — y es correcto: la Consola de Mira sirve para explorar *lo que un PI mostraría*, no para administrar la fuente (para eso está el SQL endpoint de Fabric bajo la identidad propia del ingeniero, con su auditoría propia).
3. **Ninguna garantía vive en un parser.** Lista negra de palabras, regex de tablas, detección de `sp_set_session_context`: son coladores (`EXEC('sp_set_'+'session_context')`, `OPENROWSET`, vistas). Lo que garantiza es el motor: permisos del principal + `@read_only` — y el nodo **mide** esas garantías al arrancar y no ofrece el Conector que no las cumple (fail-closed por Conector, misma doctrina que `verifyFabricServability`).
4. **Un Conector se ofrece en la Consola solo si su principal de consola no puede escribir, no puede desenmascarar y toda tabla que puede leer tiene política nativa.** Un warehouse con una tabla sin `SECURITY POLICY` no se ofrece entero, porque Fabric no permite acotar permisos a un Service Principal por objeto (medido, CHANGELOG 0.22.0 · E3) y una tabla sin política devuelve todas sus filas (`server/sql-tables.ts:1-4`).
5. **Toda ejecución queda en un `AppendOnlyLog` hash-encadenado** (`packages/botler/src/log.ts:25`) con actor, Conector, SQL íntegro, duración y desenlace; el historial de la vista **lee de ahí**, no de un almacén paralelo.

---

## ¿Qué hay hoy en el código y qué reutiliza este diseño? (anclas leídas, no supuestas)

| Pieza | Dónde | Qué se verificó (2026-09-21, `main` en 0.32.0) |
|--|--|--|
| Registro de Conectores | `server/serve-rls.ts:491-507` `parseConnections()`; perfil `SqlConnectionProfile` en `packages/capabilities/src/execute-sql-dwh.ts:11-16` | `VERGIS_CONNECTIONS` = `{ database_ref: perfil }`, JSON inline o ruta; cada perfil pasa por `credentialProviderFor` al parsear (fail-closed eager, #66). Referencia VIVA mutada in-place por hot-reload. |
| Cómo se inyecta la identidad hoy | `execute-sql-dwh.ts:92-134`; prelude en `packages/policy/src/fabric.ts:792-806` | Un pool **por `database_ref`** con **un** Service Principal; por request se antepone `EXEC sys.sp_set_session_context @key=…, @value=@vergis_sc_N` por cada inyección del nodo. **NO usa `@read_only`** — deliberado (`fabric.ts:13-16`): con pool, `read_only` impediría re-setear la conexión reusada. |
| Consecuencia para una consola | — | En el mismo batch, un SQL del usuario puede ejecutar **su propio** `EXEC sp_set_session_context` y sobreescribir el claim que el nodo acaba de inyectar. Con el pool de serving, además, dejaría el residuo para el siguiente consumidor (el nodo lo reinyecta todo en cada request, pero **dentro** del batch del atacante ya ganó). **Esto es un bypass de fila** si la consola reusara `execute-sql-dwh` tal cual. |
| RLS nativa (plano de fila) | `packages/policy/src/fabric.ts` (`compileFabric`); verificación por PI en `server/engines/fabric.ts:33-35` (`SYS_SECURITY_POLICIES_SQL`) | `SECURITY POLICY` + `FILTER PREDICATE` sobre `SESSION_CONTEXT('vergis_claim_<claim>')` con guard `<> ''` (default-deny). `grant: all` = artefacto allow-all (existe, permite todo); **sin política = sin gobierno = todas las filas** (el motor no niega por omisión). |
| Plano de columna | `fabric.ts:255-300` (DDM) y `:370-400` (vista de máscara) | Dos mecanismos: DDM en la columna (discrimina por permiso `UNMASK` del **principal**) + vista que discrimina por `SESSION_CONTEXT`. La vista **solo discrimina si el principal tiene `UNMASK`**; sin `UNMASK`, base y vista salen enmascaradas (sobre-enmascaramiento, nunca fuga). Doctrina vigente (CHANGELOG 0.22.0 · E3, #245): `GRANT UNMASK ON [tabla]([col]) TO [public]` — **a `public`, porque Fabric no permite `CREATE USER … FROM EXTERNAL PROVIDER` para un Service Principal (medido)**. |
| Centinela de desenmascarado | `server/engines/fabric.ts:63-80` (`UNMASK_PROBE_*`, `UnmaskCapability` = `capable · incapable · uninstrumented`) | Instrumento existente que sabe reportar su propio fallo. **Se reutiliza tal cual** para medir al principal de consola. |
| Gate de tablas del PI | `server/sql-tables.ts:1-12` | Regex que extrae tablas del SQL del spec para exigirles política. El propio comentario declara por qué existe: una tabla no vista «se serviría sin verificar → fuga». Es adecuado para un spec revisado; **no es adecuado para SQL adversarial** (no se reutiliza como garantía en la Consola). |
| Identidad / sesión | `packages/botler/src/gate.ts` (`identityFromHeaders`), `server/identity.ts` (`IdentityProjection`) | Claims desde cabeceras del gate + directorio; email → claims por lookup síncrono. **Jamás inferida.** |
| Rol de acción y scope | `packages/capabilities/src/admin-roles.ts` (admin), grupos en `governance-store.ts:102-106` (`isMember`, `groupsOf`); precedente Miranda: `server/config.ts:496` (`MIRANDA_SCOPE_GROUP`, default `miranda`), gate en `serve-rls.ts:2280,2384` (`isAdmin ∨ isMember(scopeGroup)`), menú en `server/ui.ts:134` | Existe el patrón «capacidad con scope = admin o miembro de un grupo de Mira declarado por env». No es política de datos: es autorización de **acción**, como `/admin`. |
| Superficie admin y su protección | `server/ui.ts:159-165` (`csrfFactory`, `requireCsrf`), `server/routes.ts:184-232` (orden de despacho; `/contrato` y `/admin` gateados por rol dentro del handler), `server/contract.ts:402-414` (`/contrato` → 403 sin rol admin), `routes.ts:123` `mutacionSinControl` (409 en standby) | Token CSRF HMAC por identidad; JSON POST con `_csrf` en el body (patrón `server/notas.ts:260,550`). |
| Log append-only | `packages/botler/src/log.ts:25` (`AppendOnlyLog`, modo `retain:false` para logs longevos); uso: `serve-rls.ts:1519` (`${OUT}/admin-audit.log`) | Hash-encadenado, archivo JSONL, lectura del archivo para mostrar (`serve-rls.ts:1573`). |
| Tope de filas y timeout | `packages/mira/src/mira.ts:33` (`DEFAULT_INTERACTIVE_MAX_ROWS = 5000`); `execute-sql-dwh.ts:79` (`requestTimeout: 60000`); `packages/botler/src/botler.ts:25` (`DEFAULT_CAPABILITY_TIMEOUT_MS = 120_000`); cancelación por `AbortSignal` → `request.cancel()` (`execute-sql-dwh.ts:100-108`, test `tests/capability-abort.test.ts`) | Existen los tres mecanismos; la Consola fija los suyos (§8). |
| Export CSV | `packages/capabilities/src/table-runtime.ts:786` (`vtCsvCell`), `:808` (separador `;`), botón «Descargar CSV (vista actual)» `:1028`; decisión #61 (César, 2026-07-13): **CSV con BOM + `;`, `.xlsx` real descartado** | Regla de celda única, compartida cliente/servidor (neutraliza formula injection). |
| Bandeja / inspector | `render-html-piece.ts:69-74,183` (`tray`, `faceta`, `tray-descargar`) | Los controles viven en la bandeja; el estilo va por convención de plataforma. |
| Arneses vivos | `scripts/tsql-lab-proof.ts` (SQL Server 2022 en Docker, `npm run lab:proof`), `scripts/fabric-lab-proof.ts` (SKU F2 propio, `npm run fab:proof`) | Helpers `seccion` · `ok` · `hallazgo` · `intentar(pool, batch)`. El de Docker refuta para toda la familia; solo el de Fabric afirma para Fabric. |

**Lo que NO existe hoy y este plan inaugura:** un principal de solo lectura por Conector · un log de auditoría de consultas ad-hoc · una superficie `/consola` · un scope `consola-sql`. **Lo que no existe y NO se inventa:** una política de escritura (`CRUDLEX` no aparece en el repo — `grep -rn CRUDLEX` devuelve cero; la política de datos vigente solo conoce `rls` / `grant: all` / `columns`, `packages/policy/src/store.ts:17-36`).

---

## ¿Bajo qué identidad se ejecuta la consulta? **(decidido)**

**Bajo un principal de consola propio de cada Conector**, declarado en el perfil como sub-credencial `consola`, **con los claims del ingeniero inyectados en `SESSION_CONTEXT` con `@read_only = 1`, en una conexión dedicada que se abre para la ejecución y se cierra al terminar**.

### ¿Por qué no la identidad del ingeniero (login SQL propio)?

Porque el ingeniero **no tiene** credencial SQL en el diseño de Vergis: el sujeto llega al motor **solo** por `SESSION_CONTEXT` (`fabric.ts:381`: «el ÚNICO canal por el que el sujeto llega al motor»). Transportarlo como principal exigiría que cada humano tuviera usuario en el warehouse — cambia la arquitectura de identidad del Producto y no lo pide nadie. Además la RLS de Vergis **ya** discrimina por `SESSION_CONTEXT`, no por principal: la identidad «real» del motor es irrelevante para la fila; lo que importa es **quién controla el `SESSION_CONTEXT`**.

### ¿Por qué no la identidad técnica del nodo (el SP de serving)?

Porque **es un bypass**, por tres vías independientes, cada una suficiente:

| Vía | Evidencia | Qué haría un SQL ad-hoc |
|--|--|--|
| Permisos del SP | `lab/RESOURCES.md:249`: Admin de los workspaces de dominio | `ALTER SECURITY POLICY … WITH (STATE = OFF)`, `DROP`, `INSERT`, `GRANT`. Write completo. |
| `SESSION_CONTEXT` sin `read_only` | `fabric.ts:13-16`, `execute-sql-dwh.ts:116-121` | `EXEC sp_set_session_context 'vergis_claim_groups', '<lo que quiera>'; SELECT …` en el mismo batch → filas ajenas. |
| Pool compartido | `execute-sql-dwh.ts:62-80` | Residuo de `SESSION_CONTEXT` en la conexión reusada (mitigado por la reinyección del nodo, pero la Consola no debe **depender** de que el próximo request limpie lo que ella ensució). |

### ¿Qué garantiza que el ingeniero no cambia sus propios claims dentro de su batch?

`sp_set_session_context … @read_only = 1`: a partir de ahí, un nuevo `sp_set_session_context` sobre la misma clave **falla** en el motor (SQL Server: error 15664, «Cannot set key … The key has been set as read_only for this session»). **No verificado en Fabric Warehouse ni en SQL endpoint de lakehouse** — es el experimento **C2** (§14): si Fabric ignorara `@read_only`, el diseño de fila cae y la Consola **no se implementa** hasta resolverlo. Y como `read_only` deja la clave fija por toda la sesión, la conexión **no puede volver a un pool**: se cierra (`pool.close()` de un `ConnectionPool` con `max: 1` creado por ejecución). El costo es un login AAD + TLS por ejecución; el token viene del caché del `CredentialProvider` (`aad-token.ts:106-122`), así que es un handshake, no una adquisición — se mide en **C3**.

### ¿Qué ve entonces el ingeniero?

Exactamente lo que vería en un PI **para su identidad**: sus filas, y las columnas con regla siempre enmascaradas (§6). Menos de lo que espera de una consola de administración — **y se le dice en la propia superficie** («Esta consola muestra lo que Mira mostraría *a ti*. Para administrar la fuente usa el SQL endpoint de Fabric con tu cuenta.»).

---

## ¿Qué se permite escribir, y qué lo garantiza? **(decidido: nada, y lo garantiza el principal)**

**Solo lectura absoluto en v1.** La garantía es el **permiso del principal de consola**, y el nodo la **mide** antes de ofrecer el Conector. Nada en el nodo intenta decidir si un texto «es un SELECT».

### ¿Por qué no una lista negra ni un parser?

Porque es un colador, y decirlo vale más que proponerlo: `EXEC('DR'+'OP TABLE x')`, `sp_executesql`, `OPENROWSET`, `SELECT … INTO`, `MERGE`, `INSERT … EXEC`, comentarios y colaciones. El comentario de `server/sql-tables.ts` es honesto sobre su alcance (specs revisadas por humanos); una consola recibe texto adversarial por definición. Un parser completo de T-SQL como garantía de seguridad es un proyecto aparte y **seguiría sin garantizar** lo que el motor sí garantiza en una línea: `DENY`/ausencia de permiso.

### ¿Qué garantiza el motor?

- **Rol de workspace `Viewer`** para el principal de consola: según la documentación de Fabric, `Viewer` puede leer datos vía T-SQL y no puede escribir ni alterar ítems. **Se asume; no medido en este repo** → experimento **C1**: bajo el principal de consola, `INSERT`, `CREATE TABLE`, `ALTER SECURITY POLICY … STATE = OFF` y `DROP` deben fallar **por permiso** (errores 229/262/15151), no por otra causa.
- **SQL endpoint de lakehouse**: es read-only por naturaleza para todo principal (no acepta DML/DDL). Igual se mide con C1; no se exime.
- **Medición al arranque (I3)**: `SELECT permission_name FROM sys.fn_my_permissions(NULL, 'DATABASE')` bajo el principal de consola; cualquier permiso fuera de la lista blanca `{CONNECT, SELECT, VIEW DEFINITION, VIEW DATABASE STATE, SHOWPLAN}` ⇒ el Conector **no se ofrece**, con el permiso ofensor nombrado en el log y en `/contrato`. Si `fn_my_permissions` no está soportado en el SKU (**no verificado**), el estado es `uninstrumented` ⇒ **no se ofrece** (un instrumento que no puede medir no se colapsa con «midió y salió bien», Norma 7).

### ¿Y la política de escritura que pide el issue («si el policy store concede escritura…»)?

**No existe tal política en el repo** (ver tabla de anclas). Inventarla es un acto que requiere autorización del dueño del producto → 🙋 pendiente **P-1**. Este plan no la propone a medias: v1 es solo lectura y lo declara en la superficie y en `/contrato`.

---

## ¿Qué se puede ver — tablas sin política y columnas enmascaradas? **(decidido: gate binario por Conector)**

El PI pasa por un gate por tabla (`sql-tables.ts` + `verifyFabricServability`): toda tabla que toca debe tener `SECURITY POLICY`. La Consola no puede hacerlo por tabla sin un parser, y Fabric no permite acotar permisos **por objeto** a un Service Principal (`CREATE USER … FROM EXTERNAL PROVIDER` no soportado: medido, CHANGELOG 0.22.0 · E3). Queda una sola unidad de decisión honesta: **el Conector entero**.

**Un Conector se ofrece en la Consola si y solo si, medido bajo su principal de consola al arrancar (y en cada re-verificación):**

| Condición | Cómo se mide | Si falla |
|--|--|--|
| **(a)** No puede escribir | `sys.fn_my_permissions` contra lista blanca (§5) | No se ofrece: «principal con permiso `X`» |
| **(b)** Toda tabla base legible tiene política nativa habilitada | `sys.tables` (todas, todos los schemas salvo `sys`/`INFORMATION_SCHEMA`) − `SYS_SECURITY_POLICIES_SQL` (`engines/fabric.ts:33-35`) = ∅. Las vistas heredan por linaje como hoy (`SYS_VIEW_LINEAGE_SQL`); una vista sobre tabla sin política cae por su base. El centinela `vergis_unmask_probe` **se excluye** de (b): es instrumento, no dato. | No se ofrece: «N tabla(s) sin política: `sch.tbl`, …» |
| **(c)** Si alguna política del store con tablas de este `database_ref` tiene `columnRules`, el principal de consola es **`incapable`** de desenmascarar | Centinela #238 leído bajo el principal de consola (`unmaskProbeReadSQL`); `capable` ⇒ fuga de columna por lectura de la tabla base; `uninstrumented` ⇒ fail-closed | No se ofrece: «principal con UNMASK y hay reglas de columna» / «centinela ausente» |
| **(d)** El motor honra `@read_only` | En una conexión dedicada: prelude read_only + intento de re-set de la misma clave ⇒ debe fallar | No se ofrece: «el motor no honra read_only» |

**Consecuencia declarada para columnas:** en la Consola las columnas con regla salen **siempre enmascaradas** (default de DDM: `0`/`xxxx`), aunque el claim del ingeniero las desenmascararía en el PI a través de la vista. Es sobre-enmascaramiento en la dirección segura y va dicho en la superficie. Refinarlo exige permisos por principal que Fabric no da hoy (pendiente **P-4**, experimento **C6**).

**Consecuencia declarada para la instancia:** un warehouse con tablas de staging sin política **no se ofrece entero** hasta que la instancia les aplique artefacto (allow-all si son abiertas, o una política deny — `work/018` del lab fija que «público» es artefacto, no ausencia). La razón exacta se publica en `/contrato.consola.conectores[ref].motivo`, para que el operador no tenga que adivinar.

**Lo que NO se hace:** ofrecer el Conector y «advertir». Una advertencia sobre una fuga es una fuga con cartel.

---

## ¿Quién puede abrirla? **(decidido el mecanismo; el nombre del grupo va como default de env)**

Mismo patrón que Miranda (`config.ts:496`, `serve-rls.ts:2280`): **scope = admin de plataforma ∨ miembro del grupo de Mira `VERGIS_CONSOLA_SCOPE_GROUP`** (default `consola-sql`). No es una política de datos nueva: es autorización de **acción** sobre una superficie de gestión, la misma familia que `/admin`, `/contrato` y `/miranda`. El grupo se declara en `VERGIS_GROUPS` (`groups: [{ id: consola-sql, members: […] }]`, `governance-config.ts:41`) o se gestiona in-app.

- Sin scope: **403** en toda ruta `/consola*`, sin revelar si la capacidad está encendida (mismo trato que Miranda: `docs/miranda.md:74`).
- Con scope y capacidad apagada o sin Conector ofrecible: **503** con la razón (solo a quien tiene scope).
- **No aparece en el avatar** sin scope (`ui.ts:134` es el precedente: `hasMiranda`).

**Visibilidad por Conector** («un usuario sin acceso a una fuente no la ve ni por URL directa», criterio del issue): en v1 el scope abre **todos** los Conectores ofrecibles; lo que cada uno muestra lo decide la RLS. Restringir *qué Conectores* ve cada ingeniero es una segunda capa de autorización de acción (p. ej. grupos `consola-sql:<ref>`) que **no se inventa acá** → 🙋 **P-2**. Si César la quiere en v1, el gate de I5 ya está escrito de modo que agregar `isMember(`consola-sql:${ref}`)` sea una línea.

---

## ¿Cuáles son los límites de ejecución? **(decidido; valores por env con default)**

| Límite | Env | Default | Mecanismo | Qué pasa al excederlo |
|--|--|--|--|--|
| Timeout por ejecución | `VERGIS_CONSOLA_TIMEOUT_MS` | `60000` (= `requestTimeout` de `execute-sql-dwh.ts:79`) | `AbortController` del handler → `request.cancel()` + `pool.close()` (patrón `execute-sql-dwh.ts:100-108`) | Respuesta `408` con `estado: timeout`; el log lo registra igual |
| Tope de filas | `VERGIS_CONSOLA_MAX_ROWS` | `5000` (= `DEFAULT_INTERACTIVE_MAX_ROWS`) | **Streaming** (`request.stream = true`, eventos `row`/`recordset`/`done` de mssql 12.5.4); al llegar a `max + 1` se llama `request.cancel()` y se responde `truncado: true` | El resultset muestra las primeras `max` filas y el aviso «truncado a N filas»; **el export exporta lo que se vio**, nunca más |
| Concurrencia por identidad | — | **1** en vuelo | `Map<email, AbortController>` en el handler | `409` «ya tienes una consulta en curso — cancélala o espera» |
| Concurrencia global | `VERGIS_CONSOLA_MAX_CONCURRENTES` | `4` | contador en el handler | `503` «consola saturada» |
| Tamaño del SQL | — | 64 KiB | `readBody` con límite duro (`server/http-util.ts:30`) | `413` |
| Tamaño de celda mostrado | — | 32 KiB por celda | recorte en el serializador de la respuesta, marcado `…` | La celda va recortada; el CSV también (lo que se vio) |
| Consulta colgada | — | — | El timeout la cancela; **cancelación explícita** `POST /consola/cancelar` aborta el controller de esa identidad | Estado `cancelado` en el log |
| Nodo en standby | — | — | `mutacionSinControl` (`routes.ts:123`) en `POST /consola/ejecutar` — la ejecución **escribe el log** en el volumen compartido; dos nodos escribiendo `consola-audit.log` es W-01 | `409` como toda mutación en standby |

**Por qué el tope es por streaming y no por `TOP N` inyectado:** envolver el SQL del usuario (`SELECT TOP N * FROM (<sql>) q`) rompe con multi-statement, `ORDER BY` sin `TOP`, CTEs y `;` — y sería el parser que este plan rechaza. El streaming corta en el cliente del motor sin tocar el texto.

---

## ¿Cómo se exporta el resultset? **(decidido CSV + JSON; XLSX es bifurcación 🙋)**

- **CSV**: **client-side**, desde el resultset ya recibido (≤ `max` filas), con la **misma regla de celda** `vtCsvCell` (`table-runtime.ts:786`), separador `;` y BOM UTF-8 — exactamente la resolución de #61. Sin path nuevo de datos: el export hereda la audiencia por construcción (exporta lo que se vio, truncado incluido).
- **JSON**: client-side, `[{col: valor}]`, `NULL` → `null`, fechas ISO. Trivial y útil para agentes.
- **XLSX**: el issue lo pide; **#61 (César, 2026-07-13) lo descartó** («habría exigido la primera dependencia gorda del producto y un endpoint server-side, sin demanda que lo justifique»). Es una decisión vigente que este issue **reabre**, y no se contradice por cuenta propia:

  | Opción | Qué implica | Recomendación |
  |--|--|--|
  | **A · Mantener #61** — CSV + JSON en v1 | Cero dependencias, cero endpoint nuevo. Excel abre el CSV con doble clic; caveat conocido (tipos inferidos) | **Recomendada.** La Consola es superficie de Ingeniería: quien la usa sabe abrir un CSV |
  | **B · Reabrir con escritor XLSX propio, client-side** | Un `.xlsx` es un ZIP con XML; el navegador tiene `CompressionStream('deflate-raw')` y un CRC32 son 20 líneas: ~200 líneas sin dependencia. Respeta tipos (`n`/`s`/`d`) y `NULL` (celda vacía). **No verificado**: soporte de `CompressionStream` en los navegadores de la instancia | Solo si César reabre #61 explícitamente; entonces se ejecuta como ítem I8 y se documenta en el CHANGELOG como reapertura |
  | **C · Dependencia (SheetJS u otra)** | Contradice #61 y ADR-001 (supply chain) | No |

  → 🙋 **P-3**. Hasta la decisión, el botón XLSX **no existe** (no un botón que dice «próximamente»).

---

## ¿Cómo se audita y de dónde sale el historial? **(decidido)**

**Un `AppendOnlyLog` propio, `${VERGIS_OUT}/consola-audit.log`**, modo `retain: false` (como `admin-audit.log`, `serve-rls.ts:1519`). No se comparte el archivo con la auditoría administrativa: son familias distintas, con volúmenes y lectores distintos, y un archivo por familia permite podar/rotar la consola sin tocar la cadena del admin.

**Una entrada por ejecución**, escrita **al terminar** (éxito, error, timeout o cancelación), y **una al iniciar** (`consola-inicio`) para que una caída del proceso a mitad de una consulta deje rastro:

```json
{"type":"consola-ejecucion","actor":"ana@gh.cl","ref":"finanzas","sql":"SELECT …","claims":["groups","viewer_area"],
 "inicio":"2026-09-21T15:03:11.204Z","duracionMs":812,"estado":"ok","filas":143,"truncado":false,
 "recordsets":1,"error":null,"seq":41,"ts":"…","prevHash":"…","hash":"…"}
```

- `actor` = `identity.user` del gate (jamás un campo del request). `claims` = **nombres** de los claims inyectados, **nunca sus valores** (los valores son datos de la persona: regla ya vigente en `serve-rls.ts:484`).
- `sql` íntegro, tal como se ejecutó (sin el prelude, que es del nodo y es reconstruible).
- `estado ∈ {ok, error, timeout, cancelado}`; `error` = mensaje del motor **sin sanitizar en exceso** (el issue lo pide; el mensaje ya no contiene el valor de claims porque nunca se concatenan).

**Historial** (`GET /consola/historial`): lee el archivo de atrás hacia adelante (últimas 500 líneas, filtro `actor == email`; un admin puede pasar `?actor=` para ver el de otro). Acciones: cargar en el editor, re-ejecutar (= cargar + ejecutar, con nueva entrada). **Favoritos con nombre** exigen estado mutable (tabla en `GovernanceStore`) → se difiere a v1.1 (**no bloquea el criterio de aceptación**, que pide historial y relanzar).

**Verificación de cadena**: **no existe hoy** un verificador offline sobre archivo (verificado: `verifyChain()` en `packages/botler/src/log.ts:60-70` recorre solo `this.entries`, que en modo `retain:false` está vacío; el único consumidor es `packages/cli/src/run.ts:198`, in-memory). `admin-audit.log` tampoco se verifica hoy. El ítem I9 agrega un `verifyChainLines(lines)` puro y un script que lo aplica a ambos logs.

---

## ¿Qué motor cubre v1, y por qué ClickHouse queda fuera?

**Solo `engine=fabric`.** En ClickHouse los claims viajan como **settings de request** por query-param HTTP (`execute-sql-ch.ts:56-60`), y una `SELECT … SETTINGS vergis_claim_groups='x'` del usuario compite por **el mismo canal**: el motor no distingue el setting que puso el nodo del que puso el texto. `readonly=1` bloquea *todo* cambio de settings — incluidos los del nodo por URL — y `readonly=2` los permite a ambos. **Medido el 2026-09-21** en un banco efímero (`clickhouse-server:24.8-alpine`), y corrige dos cosas que este plan afirmaba de menos y de más:

- **De menos:** un `SETTINGS PROFILE` con `CHANGEABLE_IN_READONLY` **tampoco separa los orígenes** — pasa el de la URL y el del texto (E5/E6). Dejaba de ser «se asume» y es hecho. Cierra además la puerta a «arreglar» por esa vía el serving actual de ClickHouse, no solo la Consola.
- **De más — y es lo que cambia el encuadre:** el canal exclusivo del nodo **existe y se demuestra en cinco minutos**. `CREATE USER <ing> SETTINGS readonly=1, vergis_claim_g='a' READONLY` da un claim que el propio usuario **no puede alterar** (`ACCESS_DENIED` a su `ALTER USER`), ni por texto ni por query-param, y solo el nodo lo cambia (E10); la vía por roles concedidos también aguanta (E7: `SET_NON_GRANTED_ROLE`). Lo que **no** existe es la vía que este plan imaginaba —un `readonly=1` sobre el usuario data-plane actual—, porque mataría el canal del nodo (E3).

Así que ClickHouse queda **fuera de la v1 por ALCANCE, no por límite del motor**: pasar de un usuario data-plane único (`execute-sql-ch.ts:56-60`, claims por query-param) a un usuario por identidad es **rediseño del transporte**, no un flag. Eso es lo que tiene que decir en `docs/consola-sql.md` y en `/contrato` (`consola.motor: 'fabric'`; con `engine=clickhouse` la capacidad reporta `disabledReason`).

---

## ¿Cuál es el contrato de configuración?

### Perfil de conexión (extiende `SqlConnectionProfile`, compatible hacia atrás)

```jsonc
{
  "finanzas": {
    "server": "…datawarehouse.fabric.microsoft.com", "database": "wh_finanzas",
    "auth": "secret", "tenantId": "…", "clientId": "<SP serving>", "clientSecret": "…",
    "consola": { "auth": "secret", "tenantId": "…", "clientId": "<SP consola, Viewer>", "clientSecret": "…" }
  },
  "personas": { "server": "…", "database": "lh_personas", "auth": "…" }   // sin `consola` ⇒ no se ofrece
}
```

- `consola` es un `CredentialSource` (`aad-token.ts:47-53`) que **hereda `server`/`database`/`port`** del perfil padre — el mismo Conector, otro principal. No puede declarar otro servidor (fail-closed al parsear: «`consola` no admite `server`/`database`»).
- `parseConnections()` (`serve-rls.ts:496`) valida también `consola` con `credentialProviderFor` (eager, #66). Un `consola` con `clientId` igual al del padre es **config rota** (mismo principal = bypass): fatal al arranque, nombrando el ref.
- Hot-reload del archivo (issue #50): el swap in-place ya cubre el sub-perfil; la Consola **re-verifica** el Conector tras cada swap (I3 se registra en el mismo watcher que hoy recarga conexiones).

### Env nuevas (todas en `server/config.ts`, validadas ahí; `DEGRADABLE_ENVS`, nunca fatales salvo lo dicho arriba)

| Env | Default | Semántica |
|--|--|--|
| `VERGIS_CONSOLA_ENABLED` | `0` | Apagada ⇒ **ni rutas ni menú ni sección en `/contrato` más allá de `enabled:false`** (superficie cero, patrón `PdfConfig`/`MirandaConfig`) |
| `VERGIS_CONSOLA_SCOPE_GROUP` | `consola-sql` | Grupo de Mira que concede el scope (además de admins) |
| `VERGIS_CONSOLA_TIMEOUT_MS` | `60000` | §8 |
| `VERGIS_CONSOLA_MAX_ROWS` | `5000` | §8 |
| `VERGIS_CONSOLA_MAX_CONCURRENTES` | `4` | §8 |

### Sección `consola` de `GET /contrato`

```jsonc
"consola": {
  "enabled": true, "motor": "fabric", "scopeGroup": "consola-sql",
  "limites": { "timeoutMs": 60000, "maxRows": 5000, "maxConcurrentes": 4 },
  "auditLog": { "path": "/governance/consola-audit.log", "exists": true },
  "conectores": {
    "finanzas": { "ofrecible": true,  "verificadoEn": "…", "principalDistinto": true },
    "personas": { "ofrecible": false, "motivo": "sin sub-perfil `consola`" },
    "crossdocking": { "ofrecible": false, "motivo": "2 tabla(s) sin política: dbo.stg_oc, dbo.stg_tiendas" }
  }
}
```

---

## ¿Cuál es el contrato HTTP?

Todas las rutas: scope obligatorio (403 sin él), `cache-control: no-store`, JSON `charset=utf-8`. Se despachan en `routes.ts` **junto a Miranda** (antes del gate global `ready`; el handler responde 503 por Conector no verificado — misma lógica que `piBlocked`).

| Ruta | Método | Qué hace | Respuestas |
|--|--|--|--|
| `/consola` | GET | Página SSR con el marco de la plataforma (`shellNav`, avatar, tema), bandeja + editor + resultset + historial. Incluye el token CSRF de la identidad | 200 · 403 · 503 (apagada / sin Conector ofrecible, con razón) |
| `/consola/conectores` | GET | Lista de Conectores **ofrecibles** para esta identidad: `[{ref, database, verificadoEn}]` | 200 |
| `/consola/<ref>/esquema` | GET | `INFORMATION_SCHEMA.TABLES` + `COLUMNS` **bajo el principal de consola** (así el árbol muestra solo lo que ese principal ve). Caché en memoria 60 s por ref | 200 · 404 (ref no ofrecible — indistinguible de inexistente) |
| `/consola/ejecutar` | POST `{_csrf, ref, sql}` | Ejecuta (I2) y registra (I6). Respuesta: `{estado, recordsets:[{columnas:[{nombre,tipo}], filas:[[…]]}], filas, truncado, duracionMs, error}` | 200 (incluye `estado: error` del motor con 200: el error SQL es un resultado, no una falla del nodo) · 403 · 404 · 408 · 409 (en vuelo / standby) · 413 · 503 |
| `/consola/cancelar` | POST `{_csrf}` | Aborta la consulta en vuelo de esta identidad | 200 `{cancelada: bool}` |
| `/consola/historial` | GET `?limite=&actor=` | Entradas del log del actor (admin: cualquiera) | 200 |

**Carga de scripts `.sql`**: client-side (`<input type=file>` → textarea). No sube nada al servidor. Multi-sentencia: el batch T-SQL ya admite `;` y devuelve varios recordsets; **`GO` no se soporta** (es del cliente `sqlcmd`, no del motor) y la superficie lo dice. «Bloques PL/SQL con `/`» no aplican a T-SQL (el propio issue lo anota).

**Ejecutar selección o todo**: `Ctrl+Enter` ejecuta la selección si la hay, si no el texto completo. Sin editor con resaltado ni autocompletado en v1 (§16).

---

## ¿Qué ítems se implementan? (severidad · Dónde · Problema · Fix)

Severidad: **B** bloqueante (sin esto la Consola es un bypass o no existe) · **M** mayor · **m** menor.

### I1 · B · Config y perfil `consola`
- **Dónde**: `server/config.ts` (nueva `ConsolaConfig` junto a `MirandaConfig`, `:113-140`; parseo en `configFromEnv`; clasificación en `DEGRADABLE_ENVS` `:351`) · `packages/capabilities/src/execute-sql-dwh.ts:11-16` (`SqlConnectionProfile.consola?: CredentialSource`) · `server/serve-rls.ts:496-507` (`parseConnections` valida `consola`; rechaza `server`/`database` dentro y `clientId` igual al padre).
- **Problema**: hoy no hay forma de declarar un principal distinto para el mismo Conector.
- **Fix**: el sub-perfil y su validación eager; `/contrato` declara la sección `consola` (I7).
- **Tests**: `tests/config.test.ts` (defaults, flag apagado ⇒ superficie cero, numéricos inválidos ⇒ error claro); test de `parseConnections` extraído a función pura si aún no lo es (`consola` con `server` ⇒ lanza; `clientId` duplicado ⇒ lanza; ausente ⇒ perfil válido sin consola).

### I2 · B · Capability `consola-sql` (ejecución con conexión dedicada, `read_only`, streaming, abort)
- **Dónde**: nuevo `packages/capabilities/src/consola-sql.ts` (exportado en `index.ts`); reutiliza `sessionContextPrelude` (`policy/fabric.ts:792`) **extendido** con opción `{ readOnly: true }` que emite `@read_only = 1` (la firma actual no lo emite: cambio aditivo, default `false`, con test de que el prelude de serving **no cambia ni un byte**).
- **Problema**: `execute-sql-dwh` usa pool compartido y prelude sin `read_only` — inadecuado para SQL adversarial (§4).
- **Fix**: `createConsolaSql(profiles, { injections, maxRows, timeoutMs })` con `execute({ ref, sql }, identity, signal)`:
  1. resuelve `profiles[ref].consola` (ausente ⇒ error `consola/sin-principal`);
  2. `new sql.ConnectionPool({ …perfil padre, authentication: consolaProvider.sqlAuth(), pool: { max: 1, min: 0 }, requestTimeout: timeoutMs })` → `connect()`;
  3. `request.stream = true`; bindea `@vergis_sc_N`; texto = `prelude(readOnly).sql + '\n' + sql`;
  4. acumula filas por recordset hasta `maxRows` total; al exceder: `request.cancel()`, `truncado = true`;
  5. `signal` → `request.cancel()`;
  6. **siempre** `pool.close()` en `finally` (la conexión con `read_only` no vuelve a ningún pool);
  7. devuelve `{ recordsets, filas, truncado, duracionMs }` o lanza con el error del motor.
- **Seam**: el constructor acepta `{ connect?: (cfg) => Promise<ConnectionPoolLike> }` para tests herméticos (un doble que emite eventos `row`/`done` y registra `cancel()`/`close()`).
- **Tests** (`tests/consola-sql.test.ts`): el prelude lleva `@read_only = 1` **para cada inyección** y los valores van bindeados (nunca en el texto) · `maxRows+1` filas ⇒ `cancel()` llamado y `truncado:true` con exactamente `maxRows` · `signal.abort()` ⇒ `cancel()` y `close()` · error del motor ⇒ `close()` igual · `ref` sin `consola` ⇒ error estructurado · **control negativo del seam**: un doble que no emite `done` y un `timeoutMs` corto ⇒ la promesa rechaza por timeout y `close()` se llamó (el instrumento sabe reportar que no pudo medir).

### I3 · B · Gate de ofrecibilidad por Conector (lógica pura + plumbing)
- **Dónde**: `server/engines/fabric.ts` (nuevo `verificarConectorConsola(ejecutar, { store, ref, tablasDelRef })` puro, con SQL constantes exportadas: `FN_MY_PERMISSIONS_SQL`, `SYS_TABLES_SQL`; reutiliza `SYS_SECURITY_POLICIES_SQL`, `SYS_VIEW_LINEAGE_SQL`, `UNMASK_PROBE_*`) · `server/serve-rls.ts` bloque fabric (`:686-750`): tras `bootstrapAll`, correr la verificación por cada ref con `consola`, guardar `consolaState: Map<ref, {ofrecible, motivo?, verificadoEn}>` (validate-before-swap, como `piState`).
- **Problema**: sin esto, un Conector con principal escritor, tabla sin política o `UNMASK` a `public` sería un bypass.
- **Fix**: las cuatro condiciones (a)(b)(c)(d) de §6, cada una con su veredicto y motivo; **cualquier `uninstrumented` ⇒ no ofrecible**. (d) se mide con I2 en modo sonda: prelude read_only sobre una clave `vergis_consola_probe` + `EXEC sp_set_session_context` de la misma clave ⇒ debe lanzar; si **no** lanza, el motor no honra `read_only` ⇒ no ofrecible.
- ⚠️ **Hueco de la sonda, hallado en la segunda mirada (2026-09-21):** la sonda prueba con una clave *propia* (`vergis_consola_probe`), y el ataque real es sobre **las claves que sí gobiernan** y **en el mismo batch** que el `SELECT`. C2 en `fab:proof` cubre el caso, pero C2 no es el gate por Conector al arrancar: un warehouse nuevo o una versión distinta de Fabric podría comportarse de otro modo y la sonda no lo vería. **La sonda usa la clave real que inyecta y hace el intento de re-set en el mismo batch que un `SELECT`, no en batches separados.** Que los dos modos difieran es conjetura; el refutador es correr la sonda de ambas formas contra un warehouse de QA.
- **Re-verificación**: en cada pasada del retry de `bootstrapAll` y tras cada hot-reload de conexiones; nunca en el request.
- **Tests** (`tests/consola-gate.test.ts`, puros con ejecutor fake): permiso `INSERT` ⇒ no ofrecible con motivo que lo nombra · tabla sin política ⇒ motivo la nombra · vista sobre tabla sin política ⇒ no ofrecible · centinela `capable` con `columnRules` ⇒ no ofrecible · centinela `capable` **sin** `columnRules` ⇒ ofrecible (la condición (c) es condicional) · centinela ausente con `columnRules` ⇒ no ofrecible (`uninstrumented`) · `fn_my_permissions` lanza ⇒ no ofrecible · re-set tras read_only **no** lanza ⇒ no ofrecible · todo verde ⇒ ofrecible con `verificadoEn`.

### I4 · B · Log de auditoría de la Consola
- **Dónde**: `server/consola.ts` (nuevo) abre `new AppendOnlyLog(`${OUT}/consola-audit.log`, undefined, { retain: false })`; lectura para historial con la misma técnica que `serve-rls.ts:1573`.
- **Fix**: entradas `consola-inicio` y `consola-ejecucion` (§9); el `actor` sale de la identidad del gate; `claims` = nombres.
- **Tests**: la entrada se escribe **también** en error/timeout/cancelación · nunca aparece un valor de claim en el archivo (test que inyecta un claim con valor centinela `ZZ-CLAIM-ZZ` y hace `grep` del archivo) · `verifyChain` sobre el archivo generado.

### I5 · B · Handler `server/consola.ts` (scope, CSRF, concurrencia, rutas)
- **Dónde**: nuevo módulo con la forma de `server/miranda.ts:248` (`createConsola(deps): { tryHandle }`); cableado en `serve-rls.ts` junto a Miranda (`:2267-2300`) y en `routes.ts` junto a `/miranda` (`:216-228`), con `mutacionSinControl` en los POST.
- **Deps**: `hasScope(email)` = `isAdmin ∨ isMember(scopeGroup)` · `csrf` de `csrfFactory(CSRF_SECRET)` · `consolaCap` (I2) · `estado()` (I3) · `esquema(ref)` · `auditLog` (I4) · `config.consola` · `identityFor(headers)` (la misma proyección que serving) · `avatarMenu` con `hasConsola`.
- **Fix**: rutas de §12; `Map<email, AbortController>` para 1-en-vuelo y cancelación; contador global; `requireCsrf` en POST; **la `ref` del request se valida contra `estado().get(ref)?.ofrecible === true` antes de tocar la capability** (404 si no).
- **Tests** (`tests/consola-handler.test.ts`, con `http` in-proc como `tests/admin-handler.test.ts`): sin scope ⇒ 403 en las seis rutas, **sin** revelar `enabled` · scope + apagada ⇒ 503 · CSRF inválido ⇒ 403 · ref no ofrecible ⇒ 404 · segunda ejecución de la misma identidad ⇒ 409 y la primera sigue · `cancelar` aborta el signal · standby ⇒ 409 en POST · el `actor` del log es el email del gate aunque el body traiga `actor: 'otro'`.

### I6 · M · Página y bandeja (UI SSR, sin dependencias)
- **Dónde**: `server/consola.ts` (HTML + JS inline, CSS por tokens de plataforma: `render-html-piece.ts:160-190` para clases `tray`/`faceta`) · `server/ui.ts:112-155` (`avatarMenu({ hasConsola })` → entrada «Consola SQL» tras Miranda).
- **Fix**: bandeja con Facetas **Conector** (select), **Esquema** (árbol tablas→columnas, clic inserta el identificador `[sch].[tbl]`), **Límites** (timeout/filas vigentes, leídos de `/contrato`), **Descargar** (CSV · JSON; XLSX solo si P-3 = B), **Historial**; editor `<textarea>` monoespaciado con `Ctrl+Enter`, «Cargar .sql»; resultset con pestañas por recordset, paginación client-side de 100 filas, tiempo, filas, aviso de truncado, error del motor en bloque `<pre>`; aviso fijo: «Esta consola muestra lo que Mira mostraría a ti…». Tema claro/oscuro por los tokens existentes.
- **Tests**: `tests/avatar-secciones.test.ts` (entrada presente solo con `hasConsola`) · test de que la página no contiene el token CSRF de otra identidad · `new Function` sobre el JS inline (sintaxis), como hacen los tests de `table-runtime`.

### I7 · M · Contrato operativo, novedades y catálogo
- **Dónde**: `server/contract.ts` (sección `consola` por **closure vivo**, como `control`/`miranda` `:217-232`) · `CHANGELOG.md` «Sin publicar» · `docs/capacidades.md` (fila `CAP-NN`, área Autorización o Superficies) · nuevo `docs/consola-sql.md` (qué es, identidad de ejecución, por qué no escribe, por qué columnas siempre enmascaradas, por qué un Conector no se ofrece, ClickHouse fuera, runbook de instancia).
- **Tests**: `tests/contract.test.ts` (sección ausente con flag apagado; con flag y sin Conector ofrecible, `conectores` trae motivos).

### I8 · m · XLSX client-side — **solo si P-3 = B**. Escritor propio (`table-runtime.ts` o módulo nuevo `xlsx-writer.ts` compartido con el export de PIs si César lo pide): tipos `n`/`s`/`d`, `NULL` = celda vacía, `inlineStr`, ZIP stored+deflate-raw, CRC32. Test: el archivo generado se abre con `unzip -t` y el `sheet1.xml` es XML válido; test de que un string `=1+1` sale como texto (misma neutralización que CSV).

### I9 · m · Verificación offline de la cadena
- **Dónde**: `packages/botler/src/log.ts` (`verifyChainLines(lines: string[]): { ok, rotoEn? }` puro) + `scripts/verify-audit-chain.ts` que lo aplica a `admin-audit.log` y `consola-audit.log`.
- **Test**: una línea alterada en medio ⇒ `rotoEn = seq`.

---

## ¿En qué orden se implementa, y por qué?

1. **I1 → I2 → I3** (config, capability, gate) — **antes que cualquier UI**, porque son las tres piezas que convierten la Consola en «no bypass»; se pueden probar herméticas y vivas sin servidor. Si **C2** (Fabric honra `@read_only`) falla, se detiene acá y no se escribió UI en vano.
2. **I4 → I5** (log, handler) — el handler exige el log para cablear la auditoría desde el primer request que ejecuta; un handler sin log «por ahora» es el defecto que la Norma 6 describe.
3. **I7** contrato — **antes** de la UI, porque la UI lee límites y Conectores de ahí y porque el operador de la Fase 2 necesita `/contrato` para configurar la instancia sin adivinar.
4. **I6** UI.
5. **I9**, y **I8** solo con decisión.
6. Pruebas vivas (§14) contra `tsql-lab` y `fab:proof` **antes del PR**; CI verde; `npm run typecheck` tras tocar cualquier `.ts` (regla dura 15 del lab).

---

## ¿Qué NO hacer?

- **No reusar `execute-sql-dwh` para ejecutar la consola** (pool compartido, prelude sin `read_only`): §4.
- **No implementar lista negra, regex de tablas ni «detector de `sp_set_session_context`»** como garantía. Puede existir un *aviso* de UX («parece que estás escribiendo DML; el principal es de solo lectura») pero **jamás** un gate.
- **No envolver el SQL** del usuario (`SELECT TOP N * FROM (…)`).
- **No ofrecer un Conector «con advertencia»** cuando falla una condición de §6.
- **No ejecutar bajo el perfil padre** si falta `consola` (ni «como fallback», ni «en dev»). Sin `consola` no hay Consola para ese ref.
- **No loguear valores de claims** ni el `clientSecret` ni el prelude con sus parámetros.
- **No agregar dependencias** (editor, grillas, xlsx): ADR-001.
- **No tocar `sessionContextPrelude` de serving** más que agregando la opción `readOnly` con default `false` y un test de byte-igualdad.
- **No inventar una política de escritura** ni un grupo por Conector: P-1/P-2 son de César.
- **No renumerar ni tocar `INDEX.md`, ni el `work/018`** del repo: este cluster es `019` y su registro en INDEX lo hace la sesión orquestadora al integrar.
- **No desplegar en la instancia**: Fase 2 es otra corrida, con sus gates (§17).

---

## ¿Cómo se valida — hermético y vivo, con controles negativos?

### Hermético (`npm test`, sin Docker)

Los tests listados en I1–I9. **Control negativo del arnés**: antes de confiar en el seam de I2, un test deliberadamente roto (el doble emite `done` sin `row` y el test espera 1 fila) debe **fallar**; se deja el test correcto y se registra en el PR que el control negativo se corrió (Norma 7, corolario de instrumentos).

### Vivo · SQL Server 2022 en Docker (`npm run lab:up && npm run lab:proof`, sección nueva «C · Consola»)

Terreno: la fixture existente (`dbo.areas` con policy de membresía + `rut` enmascarado) + una tabla **sin** política `dbo.zz_sin_politica` + un login `consola_lab` con **solo** `SELECT` en la base (y **sin** `UNMASK`), y otro `consola_lab_escritor` con `db_datawriter` (control positivo del gate).

| # | Corrida | Refuta si… | Esperado |
|--|--|--|--|
| **C1** | Bajo `consola_lab`: `INSERT INTO dbo.areas …`, `CREATE TABLE`, `ALTER SECURITY POLICY … STATE = OFF`, `DROP TABLE` | alguna **no** falla, o falla por otra causa | Las cuatro fallan por **permiso** (229/262/15151), no por sintaxis |
| **C2** | Prelude con `@read_only=1` para `vergis_claim_groups='Finanzas'` + `EXEC sp_set_session_context @key=N'vergis_claim_groups', @value=N'Producción'; SELECT area FROM dbo.areas` en el **mismo batch** | el SELECT devuelve filas de `Producción` | El batch **falla** (15664) y no devuelve filas; **control positivo**: mismo batch sin el re-set devuelve solo `Finanzas` |
| **C3** | 20 ejecuciones consecutivas de `SELECT 1` por I2 (conexión dedicada) | p95 > 3 s | Se registra p50/p95 en el PR; no es gate, es el costo declarado |
| **C4** | Gate I3 contra `consola_lab` con `dbo.zz_sin_politica` presente | ofrecible | **No ofrecible**, motivo nombra `dbo.zz_sin_politica`; tras aplicar allow-all a esa tabla ⇒ ofrecible |
| **C5** | Gate I3 contra `consola_lab_escritor` | ofrecible | **No ofrecible**, motivo nombra `INSERT` (o el primero de la lista) |
| **C6** | Bajo `consola_lab`, `SELECT rut FROM dbo.areas` y `SELECT rut FROM dbo.areas_mask` (vista) con claim `ve_pii` presente | alguna devuelve el RUT en claro | Ambas devuelven la máscara (`xxxx`): sobre-enmascaramiento medido. Luego `GRANT UNMASK ON dbo.areas(rut) TO consola_lab` ⇒ el gate (c) debe pasar a **no ofrecible** (`capable`) |
| **C7** | `maxRows = 3` con una tabla de 10 filas | llegan más de 3 o `truncado=false` | 3 filas, `truncado=true`, y `sys.dm_exec_requests` no muestra la sesión viva 2 s después (la cancelación liberó) |
| **C8** | `WAITFOR DELAY '00:00:10'; SELECT 1` con `timeoutMs = 2000` | la promesa tarda 10 s o la conexión queda abierta | Rechaza a ~2 s con `estado: timeout`; conexión cerrada; entrada en el log con `timeout` |
| **C9** | Batch multi-sentencia `SELECT 1; SELECT 2` | un solo recordset | Dos recordsets |

### Vivo · Fabric SKU F2 propio (`npm run fab:proof`, sección nueva «C · Consola»)

Las mismas C1, C2, C4, C6, C7 y C8 con un **segundo SP con rol `Viewer`** en el workspace del lab (crearlo es parte de la corrida y está documentado en `scripts/README-fabric-lab.md`). **Sin C2 verde en Fabric la Fase 1 no se mergea**: es la afirmación de mecanismo que sostiene todo el plano de fila, y el arnés de Docker solo refuta para la familia, no afirma para Fabric. Registrar en el PR qué se midió en Docker, qué en Fabric y qué **no** se midió (p. ej. SQL endpoint de lakehouse, si el lab no lo tiene).

### Lo que estas corridas NO miden (y va dicho)

- Permisos del SP de una instancia concreta (es Fase 2: el gate I3 los mide **en esa instancia** al arrancar).
- Propagación temporal de un cambio de rol de workspace (medido en #245: > 20 min para `Member`; para `Viewer` **no medido**).
- Comportamiento en el navegador real de la UI (el `new Function` valida sintaxis, no conducta); una pasada con los ojos es parte del cierre del PR.

---

## ¿Cuáles son los criterios de aceptación?

**Producto (Fase 1)**
- ☐ Con `VERGIS_CONSOLA_ENABLED=0`: `/consola*` → 404 de siempre, sin entrada de menú, `/contrato.consola = {enabled:false}`.
- ☐ Sin scope: 403 en las seis rutas; con scope: la página carga y lista **solo** Conectores ofrecibles.
- ☐ Una ejecución bajo un ref ofrecible devuelve solo las filas del claim del ingeniero (C2 positivo) y **ninguna** cuando el claim falta (default-deny).
- ☐ Un batch que intenta re-setear el `SESSION_CONTEXT` falla y no devuelve filas (C2).
- ☐ Un Conector con tabla sin política / principal escritor / `UNMASK` con reglas de columna / motor que no honra `read_only` **no se ofrece** y `/contrato` dice por qué (C4, C5, C6, test de gate).
- ☐ `INSERT`/DDL bajo el principal de consola fallan por permiso (C1).
- ☐ Tope de filas por streaming con cancelación efectiva (C7); timeout con cancelación efectiva (C8); 1 en vuelo por identidad; cancelación explícita funciona.
- ☐ Cada ejecución (ok/error/timeout/cancelada) deja **una** entrada `consola-ejecucion` con actor del gate, SQL íntegro, nombres de claims, duración y desenlace; la cadena verifica.
- ☐ Historial: cerrar sesión, volver, ver la ejecución y relanzarla (criterio del issue).
- ☐ Export CSV/JSON exporta lo visto (truncado incluido), con `vtCsvCell`, BOM y `;`.
- ☐ Columnas con regla siempre enmascaradas en la Consola, y la superficie lo dice.
- ☐ `npm run typecheck` y `npm test` verdes; C1–C9 corridas y registradas; **C2 verde en Fabric**.
- ☐ CHANGELOG «Sin publicar», `docs/capacidades.md`, `docs/consola-sql.md`, `/contrato` con la sección.
- ☐ El diff no contiene secretos (regla dura 16).

**Instancia (Fase 2, corrida aparte, gated)** — ver §17.

---

## ¿Cuáles son los riesgos y cómo se revierte?

| Riesgo | Señal | Mitigación / Reversión |
|--|--|--|
| Fabric no honra `@read_only` en `sp_set_session_context` | C2 rojo en `fab:proof` | **Bloqueante**: no se mergea. Alternativas a evaluar entonces (ninguna se implementa a ciegas): usuario por request no es posible (E3); habría que medir si `SESSION_CONTEXT` puede sustituirse por otro canal exclusivo del nodo |
| `sys.fn_my_permissions` no existe en el SKU | gate `uninstrumented` en toda instancia | Fail-closed (nadie ofrece nada). Sustituto a medir: sondas negativas transaccionales (`BEGIN TRAN; INSERT …; ROLLBACK`) **solo en warehouse** — se propone como experimento, no se implementa sin medirlo |
| Instancia con `GRANT UNMASK … TO public` y reglas de columna | Conector no ofrecible por (c) | Es el diseño. La instancia decide entre no ofrecer ese Conector o revisar la vía de `UNMASK` (P-4) |
| Costo del login por ejecución | C3 alto | Aceptable para una consola; si no, un pool **por identidad** con `read_only` es posible **solo** si las claves inyectadas no cambian entre requests de la misma persona — no se hace en v1 |
| Log crece sin cota | tamaño de `consola-audit.log` | Rotación es operación de instancia (igual que `admin-audit.log`); la cadena se verifica por segmento (I9). Documentado |
| Dos nodos escribiendo el log (blue-green) | W-01 | `mutacionSinControl` en los POST: solo el nodo con control ejecuta |
| Reversión del Producto | — | Flag `VERGIS_CONSOLA_ENABLED=0` apaga todo sin restart de imagen (la env sí exige recreate del contenedor: ventana 17 bis del lab); el sub-perfil `consola` ausente es inerte; ninguna migración de store (favoritos diferidos) ⇒ rollback de imagen limpio |

---

## ¿Qué queda pendiente de decisión humana? 🙋

| ID | Decisión | Recomendación del diseño | Bloquea |
|--|--|--|--|
| ~~**P-1**~~ | ¿Existe una política de **escritura** ad-hoc (el «CRUDLEX» del issue)? Hoy el policy store no la conoce | **CERRADA por segunda mirada (2026-09-21): v1 solo lectura.** La objeción «el ingeniero escribirá por otro lado sin auditoría» describe el presente, no una consecuencia: esa vía ya existe (T-SQL directo con token propio) y la Consola no la crea ni la agranda. Y una escritura «auditada» desde la Consola sería un **retroceso** frente al gobierno vigente del terreno, que exige reclamo y radio de impacto **antes** — **un log no es un gate**. Si algún día entra, entra con su doctrina, y esa pregunta sigue siendo de César | Nada de v1 |
| **P-2** | ¿Visibilidad **por Conector** (grupos `consola-sql:<ref>`) o scope único? | Scope único en v1; el gate de I5 deja el punto de extensión | Nada de v1 |
| **P-3** | ¿Reabrir #61 para XLSX? A (mantener CSV+JSON) · B (escritor propio client-side) · C (dependencia) | **A** | I8 |
| **P-4** | Doctrina de `UNMASK` en instancias con Consola: hoy `GRANT … TO public` (E3) hace no-ofrecible todo Conector con reglas de columna | Medir C6 en Fabric y, si se confirma, documentar en `gobierno-permisos.md` que **`public` y Consola son incompatibles** en el mismo warehouse; alternativa a medir: grupo Entra como usuario de base con el SP consola dentro (experimento, no verificado) | Fase 2 en warehouses con columnas |
| **P-5** | Nombre del grupo de scope (`consola-sql`) y quién entra en la instancia | El default; miembros los decide César | Fase 2 |
| ~~**P-6**~~ | ¿Consola sobre ClickHouse? | **CERRADA por segunda mirada (2026-09-21): fuera de v1 por alcance.** El canal exclusivo del nodo está **demostrado** (usuario por ingeniero con claim `READONLY` de perfil, o roles concedidos); lo que falta es rediseñar el transporte. La superficie y `/contrato` lo dicen así y **no** como limitación del motor | Nada de v1 |

---

## ¿Qué exige la Fase 2 (instancia A.R.B.O.L.), y qué está gated?

Corrida aparte, con `mira-ops` y las reglas duras del lab. Todo esto es **del operador**, no del ejecutor de la Fase 1:

1. 🙋 **Crear un SP `arbol-consola-sp`** en Entra (tenant GH) — infraestructura cloud nueva ⇒ OK explícito de César; secreto a Key Vault `arbol-secrets` como `sp-consola-password`; jamás en git/chat.
2. 🙋 Rol **`Viewer`** para ese SP en cada workspace cuyo Conector se ofrecerá (empezar por `ws-proyecto-arbol-finanzas`).
3. Sub-perfil `consola` en el JSON de conexiones de la VM (`/opt/mira`, vía KV en el deploy) — sin restart (hot-reload de conexiones, #50). Verificar en `/contrato.consola.conectores` el veredicto **antes** de anunciar nada.
4. Grupo `consola-sql` en `groups.yaml` con los miembros que César decida (P-5).
5. `VERGIS_CONSOLA_ENABLED=1` en `vergis.env` ⇒ **cambio de env ⇒ ventana 17 bis**.
6. Tablas sin política en los warehouses ofrecidos: aplicar artefacto (allow-all o deny) — cambio al terreno ⇒ práctica `c` (radio de impacto derivado, reclamo, gate a/08).
7. Si el warehouse tiene reglas de columna y `UNMASK` a `public`: esperar P-4.

---

## ¿Qué queda fuera de alcance de v1?

Gestión de Conectores, usuarios, roles o políticas desde la Consola · escritura (P-1) · ClickHouse (P-6) · editor con resaltado/autocompletado (sin dependencia no hay uno decente; un `<textarea>` con árbol de esquema clicable cubre el MVP) · favoritos con nombre (v1.1, tabla en `GovernanceStore`) · `GO` y bloques PL/SQL · gráficos, diseñador visual, edición inline · convertir la Consola en PI o en proto-Botlet · export server-side · XLSX (P-3).

---

• *Generado con Wingworking*
