# Consolidado · Análisis de código Vergis — plan de acción

> Dedup de los 6 frentes (01-server + 01-admin-checklist, 02-datos, 03-render, 04-mira-policy, 05-infra, 06-tests), rankeado por severidad × esfuerzo y organizado en olas de ejecución. Base: `feat/052-r3-features-dsl`, v0.2.2, tras 3 rondas previas (work/052 R1–R3).

## Veredicto

El repo está en **buen estado tras tres rondas**: camino caliente por-request fail-closed, RLS parametrizada correcta en los tres backends, caché por identidad sin cross-consumer, supply-chain de runtime limpio. Ningún hallazgo exige rediseño. Lo que queda se concentra en **cinco patrones**, todos de esfuerzo S/M salvo la testabilidad del binario:

1. **Un hueco de escape central** — `escapeHtml` no cubre la comilla simple; lo heredan varios sitios con handlers inline. Fix de una línea que cierra una clase entera.
2. **Ciclo de vida del hot-reload** — el arranque establece invariantes fuertes que `reloadGovernance` no re-establece (enforcement CH, verificación Fabric, result-cache).
3. **Durabilidad y atomicidad** — escritura no atómica del único archivo de gobierno; caminos destructivos sin swap.
4. **Divergencias entre los 3 backends de policy** que el differential testing no ve (collation, eq multi-valor, idempotencia).
5. **La calidad se detiene en el borde del binario** — `serve-rls.ts` es inimportable → cero tests de la superficie de seguridad más grande.

## Supuestos de despliegue que hay que CONFIRMAR contra el ambiente real

Seis hallazgos dependen de supuestos, no de bugs. Confirmarlos vale más que cualquier fix:

- **(D1) ClickHouse solo alcanzable por la red interna de compose.** El usuario data-plane es `no_password` y los claims son settings auto-asignables → alcance de red al puerto HTTP = bypass total de RLS. Toda la seguridad CH descansa aquí. (02·5)
- **(D2) oauth2-proxy SIEMPRE delante del server.** `gate.ts` confía en `X-Forwarded-*` sin verificar procedencia → puerto expuesto = claims arbitrarios. (04·5, y el 8080 en 0.0.0.0 de 05·2 lo materializa)
- **(D3) Autoría de master-data en Fabric Warehouse con PK `NOT ENFORCED`** → INSERT duplicado no falla. (02·4)
- **(D4) Server como proceso único** contra los SQLite → el modelo load-at-open/full-write es last-writer-wins sin lock. (02·11)

## Fixes raíz (un cambio cierra varios hallazgos)

- **`escapeHtml` escapa `'`→`&#39;`** (en `@vergis/capabilities` + los escapers embebidos `vtEsc`/`esc`): cierra el hueco de render (03·1) Y el de los handlers inline de admin (checklist·principal). Complementar con `JSON.stringify` para las *claves* en handlers. **S.**
- **`createMssqlPoolFactory(profiles,{requestTimeout})`**: extrae la fábrica de pools mssql triplicada e incorpora de una vez el fix de caché envenenada (02·2) + el timeout (02·8) + el drift 60s/120s (02·16). **S/M.**
- **`reloadGovernance` re-establece invariantes**: recomputar `BOUND` desde el store nuevo, revertir el swap si la verificación Fabric falla, e invalidar el result-cache. Cierra los 3 ALTA de serve-rls + el MEDIO del cache (01, 06·3, 04·20). **M.**
- **`createApp(config)/configFromEnv()`** (refactor de serve-rls): habilita testear routing/authz/anotaciones/hot-reload → convierte 3 ALTA de tests en trabajo de una tarde (06·1,2,6). **L**, pero desbloquea varios S.

## Severidad ALTA (dedup)

| # | Hallazgo | Frente(s) | Esf. | Dep |
|---|----------|-----------|------|-----|
| A1 | `escapeHtml` no escapa `'` → inyección JS en handlers inline (`onsubmit`/`onchange`) | render 03·1 · admin checklist | **S** | — |
| A2 | Filename de intake: `encodeURI` no escapa `?#`, `validateUpload` no bloquea `..` → traversal / inyección de query en DFS | datos 02·3 · admin checklist | **S** | — |
| A3 | `persistSqliteDb` no atómico → corrupción del único store de gobierno (admins/ACLs/grupos) | datos 02·1 | **S** | — |
| A4 | Caché de pool mssql envenenada por fallo transitorio → outage permanente hasta restart | datos 02·2 | **S** | — |
| A5 | Policy store: `dataset` duplicado = last-wins silencioso → un `grant: all` accidental pisa la RLS | mira 04·3 | **S** | — |
| A6 | Fabric sin `COLLATE` explícito → en BD case-insensitive concede MÁS filas que la referencia | mira 04·4 | **S** | — |
| A7 | `.env` no excluido del build context → secreto del SP horneado en capa/caché de build | infra 05·1 | **S** | — |
| A8 | Puerto 8080 publicado en `0.0.0.0` → esquiva oauth2-proxy y puentea el firewall de la VM | infra 05·2 | **S** | D2 |
| A9 | Casts de salida de render sin validar → anulan el backstop anti-página-en-blanco (200 vacío) | mira 04·1 | **S** | — |
| A10 | `gate.ts` confía en `X-Forwarded-*` sin verificar procedencia → bypass total si se expone | mira 04·5 | **S/M** | D2 |
| A11 | Hot-reload no re-establece invariantes fail-closed (3 variantes: CH no-op, Fabric ignora fallo, TOCTOU spec) | serve-rls 01 | **M** | — |
| A12 | master-data DWH no honra contrato insert/update → duplicados / no-op silencioso | datos 02·4 | **M** | D3 |
| A13 | DSL: `agg.dataset`/`table.data` sin prefijo escapan validación Y recuperación → widget en 0 silencioso | mira 04·2 | **M** | — |
| A14 | `serve-rls.ts` inimportable, CERO tests (la mayor superficie de seguridad) | tests 06·1 | **L** | — |
| A15 | Gate de escritura de anotaciones (HMAC) sin test adversarial (token forjado/otra identidad) | tests 06·2 | **S/M** | A14 |
| A16 | `verifyChain` sin test negativo (log adulterado → debe dar `false`) | tests 06·3 | **S** | — |
| A17 | `execute-sql-dwh` sin tests (reinyección de `SESSION_CONTEXT` anti-fuga) | tests 06·4 | **M** | — |

## Severidad MEDIA (agrupada por tema; ver el frente para el detalle)

- **Hot-reload / ciclo de vida del server (01):** `readJsonBody`/`readForm` no cortan el stream al exceder límite · `bootstrapAll`/`ingestAll` sin exclusión mutua (SIGHUP+watch+timer → filas duplicadas) · watchers de archivo mueren tras save atómico (hot-reload silenciosamente muerto) · arranque sin retry perpetuo + `chExec` sin timeout · `fail()` sin guard `headersSent` (tumba el proceso en Node 22) y sin SIGTERM graceful · tokens de anotación eternos (revocación no corta la escritura).
- **Datos / durabilidad (02):** `setDemanda` acepta `'PT'` que después revienta `durationToSeconds` → 500 en Frescura · `deleteGroup` no limpia `pi_grant` → un grupo recreado hereda accesos viejos · master-data-publish destructivo sin staging · `TRUNCATE`+`INSERT` de CH sirve 0 filas como verdad · semilla se re-aplica en cada `open()` (miembros borrados reaparecen) · `setGrant` puede degradar al último dueño (anti-lockout solo en `removeGrant`) · AAD token sin dedupe de adquisiciones concurrentes.
- **Render (03):** drift de 3 formateadores (`percent` se rompe al filtrar) · `searchable:false` no-op y busca campos ocultos (incl. tokens) · 2+ tablas: vistas guardadas se pisan · **CSV sin mitigación de formula injection** · `publicar-artefacto` escribe fuera del baseDir (traversal) · `localeCompare` sin locale → HTML no reproducible · comparador no transitivo en columnas mixtas · re-render total por keystroke sin debounce.
- **Policy / DSL (04):** `eq` multi-valor diverge de la referencia (over-grant) · Fabric setup sin transacción → ventana sin RLS en re-deploy · CH enforcement no idempotente · channels/renders no catalogados en validate · frescura global no valida `watermark_field` · campo de `control.source` no validado · `delivery.render:[]` vacío → página en blanco · coexistencia `policies`+`entities` = silencio.
- **Infra (05):** GitHub Actions por tag mutable (no SHA) · vitest 2.x con **critical** en la cadena dev · imagen base sin digest · sin `HEALTHCHECK` (pese a `/healthz`) · permisos de token a nivel workflow · sin límites de recursos ni rotación de logs.
- **Tests (06):** hot-reload bajo concurrencia sin test · `bootstrapClickHouse` sin test hermético · multipart cubre un solo malformado.

## Plan de ejecución (olas)

### Ola 1 · Seguridad barata de alto retorno — *sprint corto, todo S*
Los cinco quick-wins primero (cada uno cierra un hueco real, todos de una línea a un puñado): **A7** (`.env` a `.dockerignore`), **A1** (`escapeHtml` escapa `'`), **A3** (`persistSqliteDb` atómico), **A5** (rechazar `dataset` duplicado), **A8** (`8080` a `127.0.0.1`). Sumar el resto de S de seguridad: **A2** (encoding/traversal de filename), **A4** (pool cache), **A6** (COLLATE Fabric), CSV formula-injection (03·8), `publicar-artefacto` (03·17), `deleteGroup`→grants (02·6), `setGrant` último dueño (02·7), escapar `index_title`/`fail()` en catálogo (01), `/healthz` reducido. **Confirmar D1 y D2 con infra** — son el mayor riesgo latente y no cuestan código.

### Ola 2 · Hot-reload, fronteras y resiliencia — *S/M, un frente coherente*
El fix raíz de **`reloadGovernance`** (recomputar BOUND + revertir swap si falla + invalidar cache) cierra **A11** + result-cache de un golpe. Junto: **A9** (`expectString` en frontera de render) + **A10** (secreto proxy→server, fail-closed) + `createMssqlPoolFactory` con timeouts (raíz de A4 + fetch sin timeout) + **A12** (contrato DWH) + `eq` multi-valor (04·6) + Fabric en transacción (04·7) + CH idempotente + `setDemanda` valida con `durationToSeconds`.

### Ola 3 · Testabilidad y CI — *habilitadores*
El refactor **A14** (`createApp(config)`/`configFromEnv()`) desbloquea **A15** (test adversarial de anotaciones), **A16** (negativo de `verifyChain`), **A17** (`execute-sql-dwh`) y los tests de hot-reload/multipart. En paralelo, endurecer CI: pin de Actions por SHA + digest de imagen base, `vitest`→3/4 (mata el critical), lint (Biome/eslint) + coverage, escaneo de imagen (Trivy), `HEALTHCHECK`, rotación de logs y `mem_limit` en compose.

### Ola 4 · Deuda estructural y correcciones menores — *continuo*
Cortes modulares con costura ya visible (serve-rls → `createApp`+módulos; `render-html-piece` 957 LOC; `mira.ts` 638 LOC). Unificar los formateadores y los espejos server/cliente vía el patrón `PURE_FNS` que el repo ya inventó (aplica solo a la mitad). `codegen-common.ts` en policy (elimina la triplicación que causa las divergencias 04·4/6). Alinear el schema JSON con el validador. Las BAJAs de cada frente. **Bump a 0.3.0 + entrada de CHANGELOG antes del merge/tag** (05·13).

## Orden recomendado en una frase

Ola 1 (seguridad barata + confirmar D1/D2) → Ola 2 (hot-reload + fronteras) → Ola 3 (testabilidad, empezando por el refactor de serve-rls que paga solo) → Ola 4 (estructura, en el flujo normal de features). Con las Olas 1-2 cerradas, el repo queda honestamente sólido para producción bajo los supuestos D1-D4 declarados.

---

• *Generado con [Wingworking](https://wingworking.org)*

---

## Ola 1 — estado de implementación (2026-07-07)

**Implementado y verificado** (typecheck limpio · 393/393 tests verdes):

| Fix | Archivo(s) |
|-----|-----------|
| A1 · `escapeHtml` escapa `'` (raíz: cubre admin/pi-config/catalog) | `capabilities/markdown.ts` |
| A2 · filename: rechaza `?#%..`/control + encoding DFS por segmento | `capabilities/intake.ts`, `capabilities/intake-onelake.ts` |
| A3 · persist SQLite atómico (tmp+rename) | `capabilities/sqlite.ts`, `capabilities/annotation-store.ts` |
| A4 · evict de pool mssql en fallo (anti-outage permanente) | `capabilities/execute-sql-dwh.ts`, `master-data-store.ts`, `master-data-publish.ts` |
| A5 · rechaza `dataset` duplicado (last-wins) | `policy/store.ts`, `policy/entities.ts` |
| A6 · `COLLATE Latin1_General_100_BIN2` en predicados Fabric | `policy/fabric.ts` (+ 3 aserciones DDL en tests) |
| A7 · `.env`/contexto fuera del build | `.dockerignore` |
| A8 · `8080` a loopback | `docker-compose.yml` |
| CSV formula-injection | `capabilities/render-csv-piece.ts` |
| publicar-artefacto acotado al baseDir | `capabilities/publicar-artefacto.ts` |
| deleteGroup limpia `pi_grant` | `capabilities/governance-store.ts` |
| setGrant: guard del último dueño | `capabilities/governance-store.ts` |
| catalog: escapa `code`/`name`/`index_title` (XSS almacenado) | `server/catalog.ts` |

**Pendiente — bloqueado por el cyber safeguard (requiere `serve-rls.ts`, que corta al leerse).** Aplicar manualmente o vía Cyber Verification Program:

- [ ] **`fail()` (≈`serve-rls.ts:501-504`)** — envuelve el `msg` interpolado con `escapeHtml(msg)` (hoy mete mensajes de error arbitrarios sin escapar en el HTML). Añadir de paso el guard `if (res.headersSent) { res.destroy(); return }` (hallazgo MEDIA de 01).
- [ ] **`/healthz` (≈`serve-rls.ts:533-537`)** — reducir el payload a `{ ok, engine }`; hoy expone los slugs de todos los PIs y `lastErr` sin autenticación (los probes se excluyen del SSO).

**Pendiente — no es código (confirmar con infra):** D1 (aislación de red de ClickHouse) y D2 (oauth2-proxy siempre delante). Son el mayor riesgo latente.

---

## Ola 2 — estado de implementación (2026-07-07)

**Implementado y verificado** (typecheck limpio · 396/396 tests verdes, +3 del guard eq):

| Fix | Archivo(s) |
|-----|-----------|
| A9 · `expectString` en la frontera de render (cierra el 200-en-blanco por cast sin validar) | `mira/mira.ts` |
| A12 · contrato insert/update en la impl. DWH (chequeo de existencia + `rowsAffected`) | `capabilities/master-data-store.ts` |
| eq multi-valor · guard de cardinalidad `position`/`CHARINDEX` (codegen + emulador + test) | `policy/clickhouse.ts`, `policy/fabric.ts`, `tests/policy.test.ts` |
| CH idempotente · `CREATE ROW POLICY OR REPLACE` | `policy/clickhouse.ts` |
| setDemanda · valida con `durationToSeconds` (rechaza `PT`/`P0D`) | `capabilities/governance-store.ts` |
| result-cache · API `clear()` para invalidar en hot-reload | `botler/result-cache.ts` |
| timeouts de red · `AbortSignal.timeout` en todos los fetch (AAD/CH/OneLake/Fabric) | `capabilities/aad-token.ts`, `clickhouse-store.ts`, `fabric-engine.ts`, `intake-onelake.ts` |

**Pendiente — bloqueado por el cyber safeguard (requiere `serve-rls.ts`).** Aplicar manual / vía Cyber Verification Program:

- [ ] **A11 · `reloadGovernance` re-establece invariantes** — recomputar `BOUND` desde el store nuevo (fuga de policy CH en caliente), revertir el swap si la verificación Fabric falla, y **llamar `servingCap.clear()`** (la API ya existe en result-cache) para invalidar el caché tras endurecer una policy. Es el fix raíz que cierra los 3 ALTA de serve-rls + el result-cache.
- [ ] **A10 · gate headers** — secreto compartido proxy→server (header validado contra env, fail-closed) o binding a loopback; el enforcement se cablea en el request handler de `serve-rls.ts`.
- [ ] MEDIA de hot-reload en serve-rls: `readJsonBody`/`readForm` cortan el stream al exceder límite · mutex en `bootstrapAll`/`ingestAll` · re-armar watchers tras save atómico · handler `SIGTERM` graceful.

**Deferido a Ola 4 (complejidad DDL, no bloqueado):**

- [ ] **Fabric setup en transacción (04·7)** — hoy `[DROP policy, DROP fn, CREATE fn, CREATE policy]` deja una ventana sin RLS entre el DROP y el CREATE. Requiere envolver en transacción o patrón `ALTER`/create-new-then-swap, con cambio de estructura de `setupSQL` (y sus tests exactos) — mejor hacerlo junto al corte de `codegen-common.ts`.

---

## Ola 3 y 4 — estado de implementación (2026-07-07)

**Implementado y verificado** (typecheck limpio · 398/398 tests, +2 de A13):

| Fix | Ola | Archivo(s) |
|-----|-----|-----------|
| A13 · validación DSL de `agg.dataset`/`table.data` pelados (typo ya no da 0 en silencio) + recolector compartido en `uniqueDatasets` | 2 (spillover) | `mira/dsl/validate.ts`, `mira/mira.ts`, `tests/validate-guards.ts` |
| Dockerfile · manifests-first en el build stage (cache de deps) | 3 | `Dockerfile` |
| compose · `HEALTHCHECK` (usa `/healthz`) + rotación de logs + `mem_limit` + `init` | 3 | `docker-compose.yml` |
| CI · permisos mínimos por job + `concurrency` (sin cancelar tags) | 3 | `.github/workflows/build.yml` |
| Renovate · pin de Actions e imagen por digest | 3 | `renovate.json` |
| package.json · `engines: node>=22` + bump a **0.3.0** + CHANGELOG | 3 | `package.json`, `CHANGELOG.md` |
| 04·14 · `normalizeCtx` con `Object.create(null)` (anti prototype-pollution) | 4 | `mira/mira.ts` |

**Deferido con fundamento (no bloqueado, pero merece su propio pase):**

- **Ola 3 que necesita `npm install`/red:** subir `vitest` a 3/4 (mata el critical del audit dev), `@vitest/coverage-v8`, config de lint (Biome/eslint) — instalar + posible migración + puede aflorar muchos hallazgos. El pin efectivo de SHA/digest lo hará Renovate ahora que los `extends` están puestos (abre PR).
- **`tsconfig` `noUncheckedIndexedAccess`** — activarlo aflora errores por todo el codebase (es su propósito); es un mini-proyecto de tipos, no un flag suelto.
- **Ola 4 estructural (el grueso):** cortes de `render-html-piece.ts` (957 LOC), `mira.ts` (638), `codegen-common.ts` en policy; unificación de formateadores/espejos vía `PURE_FNS`; alinear el schema JSON con el validador. Son refactors amplios de "mover sin cambiar comportamiento" que piden revisión dedicada, no un barrido a ciegas.
- **Cola de BAJAs** de los frentes 02/03/04 (NaN guards, `searchable`, `CSS.escape`, CSV BOM, a11y, comparador transitivo, debounce, etc.) — contenidas pero numerosas; se pueden ir tomando de a lotes.

---

## Barrido de la cola no-serve-rls (2026-07-07)

Seis lotes más, todos verificados (typecheck limpio · 408/408 tests, +14 nuevos):

- **`28ce006` · Validaciones DSL/policy fail-loud:** campo de `control.source`, watermark_field global, capability de channels, `delivery.render:[]` vacío, coexistencia entities+policies.
- **`0f2370a` · Datos/resiliencia:** dedupe de token AAD, `Math.floor` en intervalo Fabric, no filtrar NDJSON al log de CH, `bootstrapPi` idempotente, `setGrant` a grupo inexistente.
- **`100a5e7` · Render + flaky:** guards NaN (semáforo/formatValue), `localeCompare('es')` server-side, y el test flaky de `watchPaths` estabilizado (settle + polling).
- **`1e098c0` · Tests:** negativos de `verifyChain` (adulteración detectada) y casos de `multipart`.

### Lo que queda (por tier de riesgo)

**A · Refactors estructurales + runtime embebido — piden pase dedicado con revisión.** Partir `render-html-piece.ts` (957 LOC), `mira.ts` (638), `codegen-common.ts`; **unificar los formateadores** (03·2, el drift `percent`/fecha) y las MEDIA de render que viven en el runtime serializado (`PURE_FNS`): `searchable`, colisión de vistas guardadas, comparador transitivo, debounce, `CSS.escape`. *Por qué no en este barrido:* un error en el runtime serializado rompe el cliente en silencio y los tests no cubren esos caminos de browser — mover a ciegas es peor que no mover.

**B · Datos M sobre DDL/SQL vivo — no verificable herméticamente.** `master-data-publish` con swap, `TRUNCATE+INSERT` de CH → `EXCHANGE TABLES`, semilla re-aplicada, Fabric setup en transacción (04·7). *Por qué no:* cambian flujos SQL contra Fabric/ClickHouse reales que la suite no ejercita; sin motor no puedo confirmar el cambio.

**C · Bloqueado por el safeguard:** todo lo de `serve-rls.ts` (A11 hot-reload, A10 gate, `fail()`/`healthz`, A14 refactor, A15 test) — Cyber Verification Program o edición manual.

**D · No es código:** confirmar D1 (red de ClickHouse) y D2 (oauth2-proxy delante).

**BAJAs sueltas restantes:** CSV BOM (como opción), a11y de teclado, string-sniffing de features, `setVisibility` no-op, `appendFileSync` async, log de página desconocida, validación de identificadores en el DDL de CH.

---

## Tier A (refactor + runtime embebido) — avance con cautela (2026-07-07)

Clave del tier A: el runtime de tabla vive en **funciones TS exportadas y testeadas** (`vtApply`,
`vtFormat`, …) que se serializan al browser vía `toString` — su LÓGICA sí es verificable. Solo el
*glue* del DOM (`vtBootstrap`, event handlers) es un string embebido no testeable behavioralmente
(aunque un test corre `new Function(TABLE_RUNTIME_SOURCE)` y captura errores de sintaxis).

**Hecho y verificado** (411/411 tests, +4):

- **`5d28e6f`** · comparador transitivo de `vtApply` (decide numérico/léxico una vez por columna);
  unificación de formateadores (`vtFormat` + delegación de `formatValue` → sin drift percent/fecha);
  `searchable` (búsqueda global acotada a columnas mostradas, excluye tokens/keys ocultos).
- **`f3fe890`** · selector de chip robusto (itera y compara `.value` en vez de un selector con
  escaping frágil).

**Deferido con fundamento — el resto del tier A:**

- **Runtime embebido browser-only (no testeable behavioralmente):** debounce de la búsqueda (perf,
  cambia timing de eventos) y la colisión de «vistas guardadas» con 2 tablas (namespacing de
  localStorage). El `new Function` capta sintaxis, no comportamiento — un error ahí rompe el cliente
  en silencio.
- **Cortes de archivo (mover sin cambiar comportamiento):** `render-html-piece.ts` (957 LOC),
  `mira.ts` (638), `codegen-common.ts`. Riesgo real de ciclos de import y de romper la serialización
  del runtime; bajo retorno directo. Merecen un pase dedicado con revisión, idealmente junto al corte
  de `serve-rls.ts` (que además destraba lo del safeguard).

---

## Segundo ciclo — pendiente en 4 olas (2026-07-07)

El PRIMER ciclo (Olas 1-4 del consolidado original + la cola no-serve-rls + tier A + el refactor
createApp sustantivo) está HECHO. Lo que resta arranca como un **ciclo nuevo, Olas 1-4**, agrupado por
lo que cada una habilita:

### Ola 1 · Endurecimiento de serve-rls + config — ✅ HECHA (commit `091dae1`)
Época del HMAC · mutex del ingest · retry con backoff · watchers atómicos · SIGTERM · slugs duplicados · configFromEnv (numéricos). Pendiente menor: timingSafeEqual (BAJA impráctico), micro-caché del índice, migración completa de env.

*(original:)* — *ahora, sin motor ni install, riesgo acotado*
- Cablear `configFromEnv()` en serve-rls (activa la validación NaN; hoy config.ts está testeado pero sin usar).
- **MEDIA:** mutex en `bootstrapAll`/`ingestAll` · re-armar watchers tras save atómico (`hot-reload.ts`) · época en el HMAC de anotaciones (token no-eterno) · retry perpetuo del bootstrap (fabric sin retry).
- **BAJA:** handler `SIGTERM` graceful · detección de slugs duplicados · `timingSafeEqual` en HMAC/CSRF · micro-caché del índice.

### Ola 2 · Datos sobre motor vivo — *necesita Fabric/ClickHouse para verificar*
- `master-data-publish` con staging + swap · `TRUNCATE+INSERT` de CH → `EXCHANGE TABLES` · semilla re-aplicada en cada `open()` · Fabric setup en transacción (ventana sin RLS en re-deploy).

### Ola 3 · Estructura, runtime embebido y tooling — *pase dedicado / npm install*
- Wrap final `createApp()` (app.ts/main.ts) + cortes de `render-html-piece.ts`/`mira.ts`/`codegen-common.ts` + dedup de themes.
- Runtime embebido browser-only: debounce de búsqueda · colisión de vistas guardadas con 2 tablas.
- Tooling: `vitest`→3/4 (mata el critical dev) · lint · coverage · `noUncheckedIndexedAccess`.
- Cola de BAJAs: a11y de teclado · string-sniffing de features · CSV BOM · regex de ruta duplicada en admin · `appendFileSync` async · log de página desconocida · validación de identificadores en DDL de CH · alinear schema JSON con el validador.

### Ola 4 · Infra + entrega — *no es código*
- Confirmar **D1** (red de ClickHouse) · **D2** (oauth2-proxy delante) · **D3** (PK NOT ENFORCED) · **D4** (proceso único).
- Push de `feat/052-r3-features-dsl` + PR.
