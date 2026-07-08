# Frente 01 · Capa `server/`

**Ámbito:** serve-rls.ts (916 LOC), admin.ts (972 LOC), hot-reload.ts, multipart.ts, pi-config.ts, sql-tables.ts, nav.ts, ui.ts, catalog.ts.

---

## Tanda Opus 4.8 — cortada

El agente de este frente en Opus fue **terminado por el safeguard de ciberseguridad de Opus 4.8** a mitad de la revisión (estaba verificando empíricamente una evasión de gate de autorización vía comentarios SQL en `sql-tables`). No entregó informe. Es el motivo por el que se re-corrió todo en Fable 5 y por el que este frente se dividió en dos agentes (serve-rls/hot-reload y admin/multipart).

Señal parcial rescatada antes del corte: se estaba verificando si `escapeHtml` escapa la comilla simple (hay valores interpolados dentro de strings JS en handlers `onsubmit`/`onchange`) — hallazgo que el frente de render confirmó de forma independiente (ver `03-render.md`, hallazgo 5).

---

## Segunda corrida — Opus 4.8 (el override a Fable no surtió efecto)

> El parámetro `model: "fable"` **no fue honrado** por el harness: este segundo pase corrió otra vez en Opus 4.8 (confirmado porque el agente hermano de admin/multipart volvió a chocar con el *safeguard de ciberseguridad de Opus*). No es contraste de motor Fable vs Opus, sino una **segunda opinión independiente en el mismo motor** — útil para ver qué hallazgos son estables entre corridas y cuáles aparecen solo en una.

### serve-rls / hot-reload / nav / ui / catalog — concluido

He terminado la revisión. Leí completos los 5 archivos pedidos y verifiqué cada hallazgo contra el código de los paquetes de los que dependen (`botler/result-cache.ts`, `botler/gate.ts`, `botler/botler.ts`, `capabilities/clickhouse-store.ts`, `capabilities/execute-sql-dwh.ts`, `capabilities/governance-store.ts`, `cli/run.ts`, `tests/serve-rls.test.ts`).

# Revisión defensiva — Vergis `server/` (post ronda 3)

El patrón dominante: **las invariantes fail-closed que el arranque establece no se preservan en el ciclo de hot-reload** (la feature más nueva). Los tres hallazgos altos son variantes de eso.

## Severidad ALTA

**[ALTA] · corrección/seguridad · `server/serve-rls.ts:215-226` + `:893-906` — hot-hardening de policy en engine=clickhouse es un no-op silencioso (fuga).**
`BOUND` (con `compileClickHouse(policy, …)`) se computa UNA vez al arranque desde el store inicial. `reloadGovernance` repuebla `store` y re-llama `bootstrapAll()`, pero `bootstrapAll` re-ejecuta `bootstrapClickHouse(ADMIN, b.schema, b.enforcement)` con la **enforcement vieja** (verificado: `clickhouse-store.ts:99-106` aplica `enforcement.rowPolicySQL` verbatim; con `enforcement: null` no crea policy). Endurecer en caliente `grant: all` → `rls` deja la tabla **sin ROW POLICY**: se sigue sirviendo todo, mientras el log imprime "gobierno recargado (N políticas)". El comentario de `:888-891` solo cubre las inyecciones (claim nuevo → deny), no este caso, que es fuga, no deny. *Mejora:* recomputar `BOUND` desde el store nuevo dentro de `reloadGovernance` antes del re-bootstrap (y log ruidoso si el cambio exige inyecciones nuevas → eso sí requiere restart). **Esfuerzo M.**

**[ALTA] · robustez/seguridad · `server/serve-rls.ts:272-299` + `:905` — en fabric, el fail-closed check del re-bootstrap se ignora si falla.**
Al arranque, `ready` no se pone hasta que `bootstrapAll` verifica SECURITY POLICY nativa por tabla. Pero en `reloadGovernance` el re-bootstrap es `void bootstrapAll().catch(console.error)`: si una tabla gobernada nueva (policy recién añadida en caliente + spec que la lee) NO tiene SECURITY POLICY en la fuente, el error solo se loguea, `ready` sigue `true`, `discover()` ya sirve el PI (la tabla sí tiene entrada en el store) y el push-down devuelve **todas las filas**. *Mejora:* si el re-bootstrap falla, revertir el swap del store y el rebuild de specs; o mantener un set de "tablas verificadas" (actualizado solo en bootstrap exitoso) y gatear discover/render con él. **Esfuerzo M.**

**[ALTA] · corrección/seguridad · `server/serve-rls.ts:146-176` vs `:403-415` + `packages/cli/src/run.ts:28-36` — TOCTOU entre el gate de gobernanza y el SQL que se ejecuta (fabric).**
El gate fail-closed corre sobre el contenido leído en el discovery cacheado; pero `runSpec`→`loadSpec` re-lee la spec de disco por mtime en cada render. Una spec editada que agrega `FROM schema.tabla_no_gobernada` ejecuta el SQL **nuevo** bajo el `Report` **viejo**: ventana de 200 ms (debounce) en el mejor caso, e **indefinida si `fs.watch` no dispara** — notorio en bind mounts de Docker, que es exactamente cómo se montan las specs en la VM. En fabric, tabla sin SECURITY POLICY = todas las filas. (En clickhouse no aplica: solo existen tablas gobernadas en el store.) *Mejora:* fijar el contenido — capturar el mtime en el discovery y en `renderReport` re-gatear si `statSync(specPath).mtimeMs` difiere; o pasar el spec ya parseado del discovery a `runSpec`. **Esfuerzo S-M.**

## Severidad MEDIA

**[MEDIA] · corrección · `serve-rls.ts:307-311` + `:893-906`, `packages/botler/src/result-cache.ts` — `reloadGovernance` NO invalida el result-cache (verificado, era la pregunta explícita).**
`withResultCache` no expone `clear()` ni el server guarda un handle para invalidar. Tras endurecer una policy en caliente (o cambiar la SECURITY POLICY en la fuente), los hits siguen sirviendo las filas de la política vieja hasta vencer el TTL. Acotado (TTL corto, opt-in), pero el endurecimiento es justo el momento en que no quieres stale. *Mejora:* añadir `clear()` a `CachedCapability` y llamarlo al final de `reloadGovernance`. **Esfuerzo S.**

**[MEDIA] · robustez · `serve-rls.ts:464-480` y `server/ui.ts:134-148` — `readJsonBody`/`readForm` no cortan el stream al exceder el límite.**
Al superar el límite rechazan la promesa pero el listener `data` sigue acumulando en el string hasta que el cliente termine (el "límite de 64KB" no limita memoria; solo lo acota el `requestTimeout` de 300 s de Node). Misma falla duplicada en dos archivos. *Mejora:* al exceder, `req.removeAllListeners('data')` + `req.destroy()`; extraer un `readBody(req, limit)` compartido. **Esfuerzo S.**

**[MEDIA] · robustez · `serve-rls.ts:893-916` + `:230-252` — `bootstrapAll`/`ingestAll` sin exclusión mutua.**
SIGHUP + watch de policies + timer `REFRESH_MS` pueden solapar corridas. El ingest es `TRUNCATE` + `INSERT` (`clickhouse-store.ts:124-128`): dos corridas intercaladas (T1, T2, I1, I2) dejan **filas duplicadas** hasta el próximo refresh. *Mejora:* coalescer con una promesa in-flight (si hay bootstrap corriendo, encolar a lo sumo uno). **Esfuerzo S.**

**[MEDIA] · robustez · `server/hot-reload.ts:44-50` + `serve-rls.ts:913` — watchers de ARCHIVOS mueren tras un save atómico.**
`fs.watch` sobre un archivo (los `POLICY_PATHS` y `SPECS_LIST`) queda mirando el inode viejo tras el rename de vim/VSCode: el hot-reload de políticas deja de disparar **silenciosamente** después de la primera edición. SIGHUP es el fallback, pero nada avisa que hace falta. *Mejora:* observar `dirname(p)` filtrando por basename, o re-armar el watcher al recibir evento `rename`. **Esfuerzo S.**

**[MEDIA] · robustez · `serve-rls.ts:884` + `:244-251`, `clickhouse-store.ts:27-44` — arranque sin reintento perpetuo y `chExec` sin timeout.**
Fabric: `bootstrapAll` sin retry — un fallo transitorio de SQL al arrancar deja `ready=false` para siempre (healthz 503 hasta restart manual). ClickHouse: 60 intentos × 2 s y muere igual. Además `chExec` usa `fetch` sin `AbortSignal` → un socket colgado durante bootstrap/ingesta deja todo pendiente sin error ni log. *Mejora:* backoff indefinido en el bootstrap de fondo + `AbortSignal.timeout(...)` en `chExec`. **Esfuerzo S-M.**

**[MEDIA] · hardening · `server/catalog.ts:39,44` y `serve-rls.ts:501-504` — HTML sin escapar en el catálogo y en `fail()`.**
`indexHtml` interpola `r.code`, `r.name` y `title` crudos (`escapeHtml` está importado pero solo se usa en la columna de gobierno). El título es **editable in-app** (governance setting `index_title`) → XSS almacenado de un admin hacia todos los consumidores; `display_name` de spec, ídem para quien autora specs. `fail()` interpola `msg` (mensajes de error arbitrarios, p. ej. `out.fallback.reason`) sin escapar. *Mejora:* `escapeHtml` en los tres campos y en el `msg` de `fail()`. **Esfuerzo S.**

**[MEDIA] · hardening · `serve-rls.ts:379-381` + `:483-499` — tokens de anotación eternos: revocación no corta la escritura.**
`annSign` es HMAC(pi|email|key) sin timestamp; con `VERGIS_ANNOTATION_SECRET` fijo en producción, un consumidor cuyo acceso se revocó (ACL de PI o claims) puede seguir escribiendo anotaciones para siempre con tokens de páginas viejas. Además la escritura no re-verifica `canOpen` cuando `VERGIS_PI_ACL` está encendido. *Mejora:* época en el material del HMAC (validez de horas) y/o re-chequear `canOpen` en el POST. **Esfuerzo S.**

**[MEDIA] · robustez · `serve-rls.ts:501-504` + `:541` — `fail()` sin guard de `headersSent` y sin shutdown graceful.**
Si `admin.tryHandle` (o un render) falla tras haber empezado a responder, el `res.writeHead` dentro del `.catch` lanza `ERR_HTTP_HEADERS_SENT` → rechazo no manejado → en Node 22 **tumba el proceso**. Tampoco hay manejador SIGTERM (`server.close` + cierre de stores): un `docker stop` corta requests en vuelo. *Mejora:* `if (res.headersSent) { res.destroy(); return }` en `fail()` + hook SIGTERM. **Esfuerzo S.**

## Severidad BAJA

**[BAJA] · mantenibilidad · `serve-rls.ts` (916 LOC) — corte en módulos para hacerlo testeable.**
Hoy importar el archivo levanta el server (top-level `await` + `listen`); `tests/serve-rls.test.ts` prueba `runSpec`, no el routing/identidad/discovery del server. Corte concreto, mecánico y sin cambio de comportamiento:
- `server/config.ts` — todos los `process.env` en un solo lugar, tipados y validados (resuelve también el punto NaN de abajo).
- `server/identity.ts` — parsing de `VERGIS_GATE_CLAIMS` + `IDENTITY_MAP` + `identityFor` (líneas 319-352).
- `server/discovery.ts` — `slugify/specPaths/discoverRaw/canAccess/visibleFor` como factory `createDiscovery({store, servingCaps, engine})` → `{discover, rebuild}` (líneas 109-189).
- `server/engines/clickhouse.ts` y `server/engines/fabric.ts` — factories que devuelven `{servingCap, bootstrapAll, recompile(store)}` (líneas 191-300; `recompile` es donde vive el fix del hallazgo alto #1).
- `server/http-util.ts` — `readBody` compartido + `fail` con guard (absorbe el `readForm` de `ui.ts`).
- `server/routes.ts` — `createRequestHandler(deps)` puro con dependencias inyectadas (`discover`, `identityFor`, `render`, `admin`, `piConfig`, `readyRef`) → el router entero se testea con req/res fakes.
- `server/main.ts` — composición + `createServer` + `listen` + wiring de hot-reload/señales; `serve-rls.ts` queda como entry de compatibilidad.
**Esfuerzo L.**

**[BAJA] · duplicación · `ui.ts:70,74,88`, `catalog.ts:56`** — el script de theme-init está copiado 3 veces (más `THEME_TOGGLE_JS` inline en `page()`); las CSS vars `:root{--bg…}` duplicadas entre `PAGE_CSS` y el CSS inline del catálogo; y en las páginas de admin corren DOS listeners idénticos de cierre del avatar (`shellNav:89` + el `closeJs` de `avatarMenu:120`). Extraer constantes compartidas. **Esfuerzo S.**

**[BAJA] · corrección · `serve-rls.ts:135-172`** — `discoverRaw` no detecta slugs duplicados (dos specs con el mismo `identity.code` → la segunda es inalcanzable en silencio; `all.find` toma la primera). Warn al detectar colisión. **Esfuerzo S.**

**[BAJA] · robustez · `serve-rls.ts:102,315-317`** — envs numéricos sin validar: `PORT=abc` → `listen(NaN)` lanza tarde y feo; `VERGIS_INTERACTIVE_MAX_ROWS` NaN se pasa a Mira sin chequeo. Validar en el config con mensaje claro. **Esfuerzo S.**

**[BAJA] · hardening · `serve-rls.ts:533-537`** — `/healthz` expone los slugs de todos los PIs y `lastErr` (internals) sin autenticación — los probes suelen excluirse del SSO en el proxy. Reducir a `{ok, engine}`. **Esfuerzo S.**

**[BAJA] · hardening · `serve-rls.ts:491`, `ui.ts:131`** — comparación de token HMAC y CSRF con `!==` en vez de `timingSafeEqual`. Impracticable de explotar por red, pero es el estándar. **Esfuerzo S.**

**[BAJA] · rendimiento · `serve-rls.ts:572-604`** — el índice `/` con governance hace por request: `listGroups` + N×(`getPiGovernance`+`listGrants`) + (con ACL) N×`piManagementRole` + `groupsOf`. Todo SQLite local, tolerable, pero es el único trabajo repetido no cacheado que queda: micro-caché de 5-30 s invalidada en los writes de admin. También `renderReport` construye un `Botler` nuevo y re-registra capabilities por request — churn aceptable, anotado. **Esfuerzo S-M.**

## ¿Qué verifiqué que está BIEN resuelto? (no lo reporto como hallazgo)

- **Swap del store en `reloadGovernance` es atómico** para los requests: no hay `await` entre `clear()` y el bucle de `set()` (:901-902), y las clausuras capturan la misma referencia — correcto.
- **Validate-before-swap** en el scanner (`hot-reload.ts:76-84`) y en la carga de políticas (parsea TODO en un Map temporal antes de tocar el vigente) — correcto.
- **Claim nuevo sin inyección → fail-closed en fabric**: `execute-sql-dwh` reinyecta el set COMPLETO por request con `''` para claims ausentes y valores parametrizados (`execute-sql-dwh.ts:119-128`) — deny, no fuga, y está documentado.
- **Result-cache particionado por identidad**: la clave incluye capability+params+user+claims normalizados vía sha256 canónico (`result-cache.ts:49-58`) — sin cross-consumer.
- **Timeouts de query**: el Botler aborta capabilities a 120 s con `AbortSignal` y ambos conectores honran la cancelación (`request.cancel()` en mssql con `requestTimeout` 60 s; `signal` en el fetch de CH) — el render está acotado.
- **Trabajo por request** (punto 4 del encargo): en gran parte ya resuelto — discovery memoizado con invalidación on-change (`createCachedScanner`), spec cacheado por mtime y schema por ruta en `runSpec`, validador AJV reusado. Solo queda el bloque de gobierno del índice (hallazgo bajo).
- **Gate fail-closed de fabric** con tablas sin esquema (unqualified) y tablas sin política — bien, con comentarios que explican el porqué.
- **`bootstrapPi` con dueño vacío no crea grants basura** (`governance-store.ts:384-386`) — la preocupación del comentario de `piGovSummary` está cubierta.
- **Audit log file-only** (`retain:false`) — no crece en RAM; superficie POST única gateada por HMAC; CSRF en las superficies de formulario.

## Evaluación general

El código está en buen estado tras las tres rondas: el camino caliente por-request (identidad → discovery cacheado → render con RLS enforcing) es sólido, fail-closed y con cancelación bien hecha hasta los conectores. Lo que queda por endurecer se concentra casi todo en **el ciclo de vida del hot-reload**: el arranque establece invariantes fuertes (enforcement compilada, verificación de RLS nativa, gate de gobernanza sobre el contenido servible) que `reloadGovernance` no re-establece — recarga el store y la visibilidad, pero no la enforcement (CH), no aborta el serving si la verificación falla (fabric), y no invalida el result-cache. Los tres altos + el primer medio se arreglan en el mismo frente y con el mismo principio: *un reload que no puede re-probar las invariantes del arranque debe revertirse, no loguearse*. El segundo frente, menor pero valioso, es el corte en módulos: 916 LOC con efectos de módulo hacen que el router jamás se haya testeado directo, y el corte propuesto es mecánico.

### admin / multipart / pi-config / sql-tables — cortado de nuevo

El agente de esta mitad **volvió a ser terminado por el safeguard de Opus 4.8** (mismo patrón que la primera corrida: la revisión de la evasión de gate por comentarios SQL en `sql-tables` y del escape de comilla simple en handlers inline del panel admin dispara el filtro de ciber de Opus). Este frente **no tiene informe automatizado**; queda pendiente de revisión manual o de un motor sin ese gate.

---

• *Generado con [Wingworking](https://wingworking.org)*
