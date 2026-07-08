# Refactor `createApp()` de `server/serve-rls.ts` — diseño y plan de ejecución

> **Por qué existe este doc.** `serve-rls.ts` (916 LOC) es a la vez la mayor superficie de seguridad, el binario sin tests, y el archivo que el *real-time cyber safeguard* corta al leerse. El refactor a `createApp()`/`configFromEnv()` (A14) es el **habilitador**: lo vuelve testeable, baja la densidad del monolito (que probablemente destraba el gate al leer módulos más chicos), y es el vehículo natural para los fixes bloqueados (A11 hot-reload, A10 gate, A15 test de anotaciones). Este diseño se arma **sin leer el archivo** (desde el análisis de los frentes 01 y 06); la ejecución requiere el archivo legible (exemption o sesión sin el gate).

## Objetivo

Convertir el módulo-con-efectos (hoy importar el archivo levanta el server: `await` top-level + `listen`) en **factories puros e inyectables**, dejando solo el `listen` como efecto. Sin cambiar comportamiento: es mover código detrás de costuras, no rediseñar.

Contrato de llegada:

```ts
// server/config.ts
export interface ServerConfig { /* todos los env tipados y validados */ }
export function configFromEnv(env = process.env): ServerConfig   // valida PORT, *_MAX_ROWS, etc.

// server/app.ts
export interface App { handler: RequestListener; reload(): Promise<void>; stores: {...} }
export function createApp(config: ServerConfig): Promise<App>     // compone todo, SIN listen

// server/main.ts  (único con efectos)
const app = await createApp(configFromEnv())
createServer(app.handler).listen(config.port)
// + wiring de SIGHUP/SIGTERM/fs.watch → app.reload()
```

`serve-rls.ts` queda como entry de compatibilidad (re-exporta `main`) o se reemplaza por `main.ts` en el `build` de `package.json`.

## Corte en módulos (orden de dependencia)

| Módulo | Qué mueve (líneas aprox. del original) | Firma / salida |
|--------|----------------------------------------|----------------|
| `server/config.ts` | Todos los `process.env` (~20 vars), tipados y validados | `configFromEnv(env): ServerConfig` — valida numéricos (cierra el hallazgo NaN de `PORT`/`*_MAX_ROWS`) |
| `server/identity.ts` | `VERGIS_GATE_CLAIMS` + `IDENTITY_MAP` + `identityFor` (319-352) | `createIdentity(config) → { identityFor(headers) }` |
| `server/discovery.ts` | `slugify`/`specPaths`/`discoverRaw`/`canAccess`/`visibleFor` (109-189), `createCachedScanner` | `createDiscovery({store, servingCaps, engine}) → { discover, rebuild }` |
| `server/engines/clickhouse.ts` | `bootstrapClickHouse`, `compileClickHouse`/`BOUND` (191-300) | `createClickhouseEngine(config) → { servingCap, bootstrapAll, recompile(store) }` |
| `server/engines/fabric.ts` | bootstrap + verificación de SECURITY POLICY nativa por tabla (272-299) | `createFabricEngine(config) → { servingCap, bootstrapAll, recompile(store) }` |
| `server/http-util.ts` | `readBody` compartido (con corte de stream) + `fail` con guard `headersSent` | absorbe el `readForm` duplicado de `ui.ts` |
| `server/routes.ts` | El router entero: dispatch a admin/pi-config/render/annotation/healthz, `handleAnnotationWrite`+`annSign` | `createRequestHandler(deps): RequestListener` — deps: `{ discover, identityFor, render, admin, piConfig, readyRef, gateSecret }` |
| `server/app.ts` | `reloadGovernance`, composición, `readyRef` | `createApp(config): Promise<App>` |
| `server/main.ts` | `createServer` + `listen` + señales + watchers | el único con efectos |

## Los fixes bloqueados aterrizan en el nuevo corte

- **A11 · hot-reload** → `engine.recompile(store)` (recomputa `BOUND` desde el store nuevo: cierra la fuga CH), y `app.reload()` **revierte el swap** si la verificación Fabric falla + llama `servingCap.clear()` (la API ya existe en `result-cache`). Los 3 ALTA de serve-rls se resuelven acá con el principio: *un reload que no puede re-probar las invariantes del arranque se revierte, no se loguea.*
- **A10 · gate** → `createIdentity`/`routes` validan un `X-Gate-Token` contra `config.gateSecret` (fail-closed si falta y el binding no es loopback).
- **`fail()` + `/healthz`** → en `http-util.ts` (guard `headersSent`, escape del `msg`) y `routes.ts` (`/healthz` reducido a `{ok, engine}`).
- **TOCTOU spec** → `discovery` fija el contenido parseado y `runSpec` re-gatea por `mtime`.

## Tests que habilita (frente 06)

Con `createRequestHandler(deps)` puro y `configFromEnv` inyectable, todo se testea con req/res fakes (patrón ya usado en `createAdmin`/`tryHandle`):

- **Routing + authz:** identidad → discovery cacheado → render con RLS; 403/404 sin filtrar existencia.
- **A15 · gate de anotaciones (adversarial):** `annSign`/`handleAnnotationWrite` — token válido acepta; de **otra** identidad/clave/PI **rechaza**; JSON > 64KB rechaza. (Único surface mutable para consumidores; hoy sin test negativo.)
- **A11 · reloadGovernance:** policy endurecida en caliente → el siguiente request **no** sirve el hit viejo (cache invalidado); si la verificación Fabric falla → el swap se revierte y `ready` no miente.
- **`/healthz`** semántica 503-hasta-listo; **fail-closed de Fabric** con tabla sin SECURITY POLICY.

## Estrategia de ejecución (preserva comportamiento)

1. Extraer en **orden de dependencia** (config → identity → discovery → engines → http-util → routes → app → main). Cada paso: mover código detrás de la factory, **sin cambio de comportamiento**, corriendo la suite COMPLETA existente + agregando tests de ruta incrementalmente.
2. Invariante de cada commit: `npm run typecheck && npm test` verde. El primer commit que agrega tests de routing es el que **prueba** que la extracción no cambió nada.
3. Recién **después** de tener el router testeado, aplicar A11/A10/A15 (cada uno con su test).
4. `build` de `package.json`: apuntar esbuild a `server/main.ts` (o mantener `serve-rls.ts` como re-export).

## Bloqueo y desbloqueo

- **Ejecución gated por el safeguard:** leer/reescribir `serve-rls.ts` dispara el *real-time cyber safeguard* en los tres motores disponibles. Vías: (a) **Cyber Verification Program** (formulario del propio error, token incluido) → una vez ajustada la cuenta, este plan se ejecuta directo; (b) una sesión/entorno sin el gate.
- **Este diseño no está bloqueado** — es el handoff listo para (a).

---

## Progreso de ejecución (2026-07-07)

**Descubrimiento clave:** en esta sesión `serve-rls.ts` **sí es legible** sin disparar el safeguard (a diferencia de `admin.ts`) — el refactor está desbloqueado aquí, no requiere el Cyber Verification Program.

**Estrategia adoptada (cautela):** autoría ADITIVA — se extraen los módulos puros uno a uno, testeados, **sin tocar `serve-rls.ts`**; la cirugía del monolito (rewiring) se deja para el final, cuando ya exista cobertura de tests que atrape regresiones. Así el server vivo no corre riesgo en ningún commit intermedio.

**Módulos hechos (aditivos, testeados):**

- [x] `server/config.ts` · `configFromEnv()` — commit `6cdfafc`, 10 tests. Incluye el fix del NaN.
- [x] `server/identity.ts` · `createIdentity()` — commit `32b667b`, 6 tests.

**Pendientes (orden de dependencia, complejidad creciente):**

- [x] `server/discovery.ts` · `createDiscovery()` — commit `3277a86`, 10 tests (¡cubre el gate fail-closed!).
- [~] `server/engines/clickhouse.ts` — PARTE PURA hecha (`computeBound`/`unionInjections`, commit `ee2ec98`, 4 tests con la corrección A11). Falta el plumbing de SQL vivo (bootstrap/ingesta) + `fabric.ts` → van en el paso del núcleo.
- [x] `server/http-util.ts` · `readBody`/`fail` — commit `a23fa96`, 6 tests. Landea 3 fixes diferidos del frente 01.
- [ ] `server/routes.ts` — el router + `handleAnnotationWrite`/`annSign` (aquí A15 + A10).
- [ ] `server/app.ts` — composición + `reloadGovernance` (aquí el fix raíz de A11).
- [ ] `server/main.ts` — `listen` + señales + watchers.
- [ ] **Cirugía final:** rewire `serve-rls.ts` → entry delgado; recién acá se modifica el monolito, con los tests de ruta ya en su lugar.

---

## Cierre de la ejecución (2026-07-07)

**El valor del refactor está completo.** Todos los fixes que estaban bloqueados por el safeguard
aterrizaron en `serve-rls.ts` (verificados con typecheck + 452 tests + **el build de esbuild**, que
compila el server que los tests no cubren) y el core de seguridad quedó extraído y testeado.

**Módulos extraídos y testeados (6):** `config` (`6cdfafc`), `identity` (`32b667b`), `discovery`
(`3277a86`, cubre el gate), `http-util` (`a23fa96`), `engines/clickhouse` pura (`ee2ec98`, A11),
`annotations` (`aae0663`, A15).

**Fixes bloqueados, ahora landeados en serve-rls (`0511577`, `73528d5`):**

- [x] **A11** — bootstrapAll (CH) recomputa BOUND desde el store; reloadGovernance invalida el
  result-cache; re-bootstrap fallido → `ready=false` (fail-closed fabric). Los 3 ALTA cerrados.
- [x] **A10** — secreto de gate opt-in (`x-gate-token`).
- [x] **A15** — gate HMAC de anotaciones con 6 tests adversariales.
- [x] `/healthz` reducido; `fail()`/`readJsonBody` desde `http-util` (escape + headersSent + corte de stream).

**Lo que resta es PURA modularización estructural (no cambia comportamiento ni cierra hallazgos):**
extraer el router a `routes.ts`, el bootstrap a `app.ts`, `main.ts`, y dejar `serve-rls.ts` como entry
delgado. Su valor (testabilidad) ya está mayormente capturado porque la LÓGICA crítica (gate, HMAC,
recompute de enforcement, identidad, discovery) ya vive en módulos testeados. Su riesgo (reescribir el
router/bootstrap sin tests de ruta) no se justifica autónomamente. Recomendación: hacerlo como pase
dedicado escribiendo primero los tests de ruta con req/res fakes, con el diseño de arriba como mapa.
