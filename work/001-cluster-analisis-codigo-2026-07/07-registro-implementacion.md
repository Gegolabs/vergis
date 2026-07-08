# Registro de implementación — sesión 2026-07-07

> **Qué es esto.** El registro DETALLADO de todo lo que se implementó en la sesión del 2026-07-07 a
> partir del análisis del cluster `work/001`. Documenta cada commit, cada archivo de producción tocado,
> el impacto, y cómo se verificó. Complementa el `00-consolidado.md` (que es el PLAN) con el REGISTRO
> DE EJECUCIÓN. Motivo del detalle: los cambios son extensos (32 archivos de producción) y tocan el
> camino de enforcement RLS — alto impacto potencial, hay que poder auditarlos.

## Resumen ejecutivo

- **Alcance:** 25 commits propios + 1 merge, **66 archivos** (+3158/−323). 32 de código de producción
  (incluidos **7 módulos nuevos** del refactor de `serve-rls.ts`), 14 de tests (7 nuevos), infra/config.
- **Verificación:** cada commit pasó `npm run typecheck && npm test && npm run build`. Estado final en
  `main`: **typecheck limpio · 488 tests verdes (60 archivos) · build de esbuild OK**. Los tests
  pasaron de **393 → 488** (+95).
- **Entregado:** todo mergeado a `main` (`c858d6f`) y pusheado a `origin`. La rama
  `feat/052-r3-features-dsl` también en el remoto.
- **Un merge no trivial:** `origin/main` había avanzado con el `#49 (deployment-check)` que tocaba
  `serve-rls.ts`; Git auto-resolvió el overlap (adiciones no chocantes) y se verificó el estado
  combinado (488 tests) ANTES de pushear.

## Cómo se verificó (importante para confiar en el impacto)

- **`typecheck`** (`tsc --noEmit`) en cada commit.
- **`npm test`** (vitest) — la suite hermética. Cubre policy (differential + oráculo), mira/DSL, botler,
  render, table-runtime, y ahora los 7 módulos nuevos del server (config, identity, discovery,
  http-util, engines/clickhouse, annotations, **routes** — el router que tenía CERO tests).
- **`npm run build`** (esbuild bundlea `serve-rls.ts`) — la ÚNICA red que atrapa errores en el binario
  RLS de punta a punta, porque los tests no lo importan entero. Se corrió tras CADA cambio a `serve-rls`.
- **Lo que NO se pudo verificar** (marcado abajo): cambios que necesitan un motor Fabric/ClickHouse
  vivo. NINGUNO de esos se hizo — quedaron en la Ola 2 del pendiente (ver `NEXT.md`).

---

## Los commits, por fase

### Fase 1 — Olas 1-4 del análisis (primer ciclo)
- **`993d523` Ola 1 — hardening de seguridad barato.** 14 fixes S: escapeHtml escapa `'`
  (raíz — cubre admin/pi-config/catalog); traversal de intake (`validateUpload` + encoding DFS por
  segmento); persist SQLite atómico (tmp+rename, protege el store de gobierno); evict de pool mssql
  envenenado (×3 conectores); rechazo de `dataset` duplicado en policy store; `COLLATE` binario en
  Fabric; `.env` fuera del build context; 8080 a loopback; CSV formula-injection; publicar-artefacto
  acotado al baseDir; deleteGroup limpia grants; setGrant guard del último dueño; catalog escapa
  code/name/index_title.
- **`67e4e84` Ola 2 — fronteras, divergencias de policy, resiliencia.** `expectString` en la frontera
  de render; guard de cardinalidad `eq` (CH+Fabric, con test); CH idempotente (`CREATE ROW POLICY OR
  REPLACE`); contrato insert/update de master-data DWH; `setDemanda` con `durationToSeconds`;
  `result-cache.clear()` API; timeouts (`AbortSignal.timeout`) en todos los fetch.
- **`b2c4372` Olas 3-4 — validación DSL (A13), CI/infra, anti prototype-pollution.** A13 (datasets
  pelados `agg.dataset`/`table.data` validados y recuperados); Dockerfile cache order; compose
  HEALTHCHECK+logging+mem_limit; CI permisos por job + concurrency; Renovate pin extends; `engines`
  + bump 0.3.0 + CHANGELOG; `normalizeCtx` con `Object.create(null)`.

### Fase 2 — cola no-serve-rls
- **`28ce006` validaciones fail-loud del DSL y policy store.** control.source campo; watermark_field
  global; capability de channels; `delivery.render:[]` vacío; coexistencia entities+policies.
- **`0f2370a` resiliencia en datos.** dedupe de token AAD; `Math.floor` en intervalo Fabric; no filtrar
  NDJSON al log de CH; `bootstrapPi` idempotente; `setGrant` a grupo inexistente.
- **`100a5e7` render NaN/locale + test flaky.** NaN guards (semáforo/formatValue); `localeCompare('es')`;
  estabilización del test de `watchPaths` (settle+polling).
- **`1e098c0` tests.** negativos de `verifyChain` (adulteración); casos de `multipart`.

### Fase 3 — tier A (runtime embebido verificable)
- **`5d28e6f` comparador transitivo, formateadores, searchable.** `vtApply` decide numérico/léxico una
  vez por columna (era no-transitivo); `vtFormat` unificado (Date + delegación de `formatValue`);
  `searchable` acota la búsqueda global (excluye tokens ocultos).
- **`f3fe890` selector robusto al quitar chip** (itera `.value` en vez de selector con escaping frágil).

### Fase 4 — refactor `createApp()` (7 pasos)
- **`6cdfafc` config.ts** · `configFromEnv()` puro + validación NaN. 10 tests.
- **`32b667b` identity.ts** · `createIdentity()` (fail-closed del directorio). 6 tests.
- **`3277a86` discovery.ts** · `createDiscovery()` + **el gate de gobernanza fail-closed, testeado por
  1ª vez**. 10 tests.
- **`a23fa96` http-util.ts** · `readBody`/`fail` + 3 fixes diferidos (corte de stream, `headersSent`,
  escape). 6 tests.
- **`ee2ec98` engines/clickhouse.ts** · `computeBound` puro + la corrección **A11** demostrada. 4 tests.
- **`aae0663` annotations.ts** · gate HMAC + **A15** adversarial. 6 tests.
- **`8c45b80` routes.ts** · `createRequestHandler` — el router, con 12 tests (antes 0).
- **`0511577`** landea **A11** (hot-reload recompute BOUND + invalidar cache + fail-closed) + `/healthz`
  reducido + `fail`/`readJsonBody` de http-util, en `serve-rls`.
- **`73528d5`** landea **A10** (gate secret opt-in `x-gate-token`).
- **`cab510d`** serve-rls USA createDiscovery/createIdentity (elimina drift; 916→~800 LOC).
- **`430c044`** escapar href en `buildSidebar` de admin.ts (el frente ex-bloqueado por el safeguard).

### Fase 5 — Ola 1 del segundo ciclo
- **`091dae1` endurecimiento de serve-rls + config.** Época en el HMAC de anotaciones (bucket 4h);
  mutex del ingest (cola FIFO, sin filas duplicadas); retry indefinido con backoff del bootstrap;
  watchers que sobreviven el save atómico; SIGTERM graceful; slugs duplicados; `configFromEnv`
  cableado (numéricos).

*(Los `docs(...)` intermedios materializan el consolidado, el checklist de admin y el diseño del
refactor — sin código.)*

---

## Archivos de producción tocados — por impacto

### `server/` (12 archivos; 7 NUEVOS = el refactor)
| Archivo | Nuevo | Naturaleza del cambio | Riesgo |
|---------|:---:|-----------------------|--------|
| `config.ts` | ✅ | `configFromEnv()` puro con validación NaN | bajo (testeado) |
| `identity.ts` | ✅ | `createIdentity()` (gate→identidad+claims) | bajo (testeado) |
| `discovery.ts` | ✅ | `createDiscovery()` + gate fail-closed + slug-dup | **medio** (RLS-crítico, pero testeado) |
| `http-util.ts` | ✅ | `readBody`/`fail` con corte de stream + guards | bajo (testeado) |
| `engines/clickhouse.ts` | ✅ | `computeBound`/`unionInjections` (A11) | bajo (testeado) |
| `annotations.ts` | ✅ | gate HMAC + época (A15) | bajo (testeado) |
| `routes.ts` | ✅ | `createRequestHandler` (router) | **medio** (dispatch, ahora testeado) |
| `serve-rls.ts` | — | **reestructurado**: usa los 7 módulos; A11/A10 landeados; healthz/fail; época HMAC; mutex ingest; retry; SIGTERM; config. 916→~800 LOC | **ALTO** (el binario RLS; verificado con build, pero sin test de integración de todo-el-server) |
| `admin.ts` | — | href escapado en buildSidebar | bajo |
| `catalog.ts` | — | escapa code/name/index_title (XSS almacenado) | bajo |
| `hot-reload.ts` | — | watchers de archivo vía directorio (save atómico) | bajo (testeado, +test rename-replace) |

### `packages/capabilities/src/` (14 archivos)
| Archivo | Cambio | Verificación |
|---------|--------|--------------|
| `markdown.ts` | escapeHtml escapa `'` (fix raíz) | tests |
| `sqlite.ts` | persist atómico (tmp+rename) | tests |
| `annotation-store.ts` | persist atómico | tests |
| `intake.ts` | `validateUpload` rechaza `?#%..`/control | tests |
| `intake-onelake.ts` | encoding DFS por segmento + timeouts | typecheck/build |
| `render-csv-piece.ts` | neutralización de formula injection | tests |
| `publicar-artefacto.ts` | acotado al baseDir (traversal) | tests |
| `governance-store.ts` | deleteGroup grants, setGrant guard, setDemanda, bootstrapPi idempotente, grant a grupo inexistente | tests |
| `master-data-store.ts` | evict de pool + contrato insert/update DWH (A12) | tests (contrato DWH sin motor) |
| `master-data-publish.ts` | evict de pool | tests |
| `execute-sql-dwh.ts` | evict de pool | tests |
| `aad-token.ts` | dedupe in-flight + timeout | tests |
| `fabric-engine.ts` | `Math.floor` intervalo + timeouts | tests |
| `clickhouse-store.ts` | no filtrar NDJSON al log + timeout | typecheck/build (sin motor) |
| `render-html-piece.ts` | NaN guards + localeCompare + `formatValue` delega en vtFormat | tests |
| `table-runtime.ts` | comparador transitivo + vtFormat + searchable + selector robusto | tests (`new Function` valida sintaxis del runtime embebido) |

### `packages/policy/src/` (4)
| Archivo | Cambio |
|---------|--------|
| `store.ts` | rechaza dataset duplicado + coexistencia entities/policies |
| `entities.ts` | rechaza dataset duplicado |
| `clickhouse.ts` | guard de cardinalidad `eq` + `CREATE ROW POLICY OR REPLACE` |
| `fabric.ts` | `COLLATE` binario + guard de cardinalidad `eq` |

### `packages/mira/src/` (2) · `packages/botler/src/` (1)
| Archivo | Cambio |
|---------|--------|
| `dsl/validate.ts` | A13 (datasets pelados) + 4 validaciones fail-loud (control.source, watermark global, channels, render vacío) |
| `mira.ts` | `expectString` frontera de render + `normalizeCtx` anti prototype-pollution |
| `botler/result-cache.ts` | API `clear()` para invalidar en hot-reload |

### Infra/config
`.dockerignore` (.env fuera), `docker-compose.yml` (loopback+healthcheck+logging+mem_limit),
`Dockerfile` (cache order), `.github/workflows/build.yml` (permisos por job + concurrency),
`renovate.json` (pin extends), `package.json` (engines + 0.3.0), `CHANGELOG.md` (0.3.0).

---

## Impacto en producción — qué vigilar

- **`serve-rls.ts` fue reestructurado profundamente.** Compila y bundlea, pero NO hay test de
  integración de todo-el-server (es el hueco conocido; por eso el refactor extrajo la lógica a módulos
  testeados). Al desplegar, **verificar en vivo**: el índice per-consumidor, la apertura de un PI con
  RLS, la escritura de anotación (POST /slug/annotations), `/healthz`, el hot-reload (SIGHUP).
- **Cambios de comportamiento observable (intencionales):**
  - `/healthz` ahora devuelve solo `{ok, engine}` (antes exponía slugs + lastErr).
  - Token de anotación tiene **época de 4h**: una página abierta >~8h necesita recargar para escribir.
  - `VERGIS_GATE_SECRET` (nuevo, opt-in): si se define, exige header `x-gate-token`.
  - `PORT`/`VERGIS_REFRESH_MS`/`VERGIS_DATA_CACHE_TTL_MS`/`VERGIS_INTERACTIVE_MAX_ROWS` no numéricos
    ahora **abortan el arranque** con mensaje claro (antes toleraban NaN).
  - Fabric: predicados con `COLLATE Latin1_General_100_BIN2` → matching case-SENSITIVE (antes CI en
    Azure SQL default). **Si alguna política dependía del matching case-insensitive, cambia.**
  - Specs con el mismo `identity.code` ahora logean colisión de slug (la 2ª ya era inalcanzable).
  - `delivery.render:[]` vacío, `agg.dataset`/`table.data` colgantes, y varios typos de DSL que antes
    pasaban en silencio ahora **fallan la validación** (fail-loud). **Revisar que ningún spec en
    producción dependiera de ese silencio.**
- **Sin cambios de esquema de datos.** Ningún cambio toca DDL en producción (los de Ola 2 quedaron
  pendientes justamente para verificarlos con motor).

## Estado y pendiente

- **Hecho y en `main`:** todo lo de arriba.
- **Pendiente:** las Olas 2-4 del segundo ciclo — detalladas en **`NEXT.md`** (raíz del repo) y en la
  sección "Segundo ciclo" de `00-consolidado.md`. Resumen: datos sobre motor vivo (Ola 2, necesita
  Fabric/CH), estructura+tooling (Ola 3, incluye el wrap final de createApp), infra/D1-D4 (Ola 4).
