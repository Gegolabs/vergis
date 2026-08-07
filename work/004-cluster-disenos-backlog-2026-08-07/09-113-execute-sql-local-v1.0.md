# Diseño · `execute-sql-local` — Motor L: ejecución contra un motor local, para desarrollo y pruebas sin nube (#113)

**Frente:** issue #113, viñeta «**`execute-sql-local`** — ejecución contra un motor local, para desarrollo y pruebas sin nube» (cuerpo del issue, verificado vía `gh api repos/Gegolabs/vergis/issues/113`; sin comentarios).
**Horizonte:** largo plazo → arquitectura decidida + primer hito ejecutable.

---

## 1 · Estado actual verificado

### ¿Qué motores existen y cómo son enforcing?

- El nodo sirve con **UN** conector enforcing por motor — el **catálogo de serving** es un `Set` de exactamente una capability de query: `execute-sql-dwh` si `engine=fabric`, `execute-sql-ch` si `clickhouse` (`server/serve-rls.ts:196-198`). Un spec cuya data-capability no esté en ese catálogo **se omite** (no-bypass) (`server/discovery.ts:79-83`; doctrina en `docs/arquitectura-multi-reporte.md:93-104`).
- **Motor C (fabric, push-down):** `execute-sql-dwh` es enforcing porque reinyecta el set COMPLETO de claims vía `sp_set_session_context` en cada request y la SECURITY POLICY nativa de la fuente filtra (`packages/capabilities/src/execute-sql-dwh.ts:41-54, 117-126`). La servibilidad se verifica **por PI** contra la fuente; sin RLS nativa ni herencia el PI queda 503 (`server/serve-rls.ts:366-394`).
- **Motor B (clickhouse, réplica gobernada):** `execute-sql-ch` inyecta claims como settings request-scoped y la ROW POLICY emitida por `@vergis/policy` filtra (`packages/capabilities/src/execute-sql-ch.ts:1-14, 104-126`). El bootstrap compila el enforcement por dataset — **fail-closed: dataset sin política en el store lanza y el nodo no arranca** (`server/engines/clickhouse.ts:35-46`). Los datasets se declaran en `VERGIS_DATASETS` con `table`, `columns` y `seed` inline **o** `ingest` desde un DWH (`server/engines/clickhouse.ts:17-23`; la rama de seed en `server/serve-rls.ts:318-325`).
- Caveat vigente de ambos motores: las inyecciones de claims se fijan **al arranque**; un claim nuevo en una política requiere restart (fail-closed, no fuga) (`server/serve-rls.ts:295-299` y `358-362`).

### ¿Qué existe ya para construir un motor local?

- **sql.js (SQLite/WASM) ya es dependencia de producción** (`package.json:32`, `packages/capabilities/package.json:13`) y tiene módulo de apertura/persistencia propio, explícitamente «sin binarios nativos» (`packages/capabilities/src/sqlite.ts:1-34`). Lo consumen los stores embebidos: notas, data maestra, gobierno (`notas-store.ts`, `master-data-store.ts`; backend SQLite del `GovernanceStore` en `docs/gobierno-permisos.md` §2).
- **El evaluador de referencia del IR de policy** — `evalPolicy`/`applyPolicy`, puro, total, default-deny — es «la semántica canónica del IR… el oráculo contra el que se prueba todo codegen» (`packages/policy/src/ir.ts:10-13, 137-152`). Los codegen CH y Fabric se property-testean diferencialmente contra él (`packages/policy/src/clickhouse.ts:11`, `fabric.ts:20-21`; ADR: `docs/adr-001-lenguaje-y-supply-chain.md:29`). Los predicados jerárquicos evalúan contra `ReferenceData` (cierres ancestro/descendiente) (`ir.ts:80-115`).
- **El arnés de dev con identidad inyectable existe y es fail-safe por construcción:** `decideDevIdentity` solo activa `VERGIS_DEV_IDENTITY` cuando NO hay señal de gate real (`VERGIS_GATE_SECRET`); con gate presente se ignora siempre (`server/config.ts:130-172`; tabla de comportamiento en `docs/gobierno-permisos.md` §«identidad de desarrollo»). El mismo patrón gobierna `--fresh` (`server/config.ts:174-210`).
- El tipo `Engine` es la unión `'clickhouse' | 'fabric'` (`server/config.ts:21`; validación en `serve-rls.ts:150`).
- **Los specs nombran su conector**: `data.<entry>.capability: execute-sql-ch` (p. ej. `examples/rls-areas.yaml:31`) — un spec ya está escrito para un motor concreto, con el dialecto SQL de ese motor. No existe hoy contrato de portabilidad de un spec entre motores.
- **La suite hermética ya cubre el render con RLS sin nube ni Docker**: fake transport + emulador de la policy compilada, end-to-end por `runSpec` (`tests/serve-rls.test.ts:1-8`). La corrida VIVA contra ClickHouse real es un script Docker bajo demanda (`scripts/serve-rls-proof.ts`, citado ahí mismo). Lo que la suite **no** da: el proceso servidor completo corriendo con un motor real detrás — para eso hoy hace falta Docker (CH) o nube (Fabric).

### ¿Qué demostraron los experimentos de esta sesión? (Norma 7)

Corridas con el sql.js del árbol (`node@22`, script en scratchpad, 2026-08-07) — cada una habría refutado el mecanismo de haber salido distinta:

1. `ATTACH ':memory:' AS vergis` + `CREATE TABLE vergis.dim_area …` + `SELECT … FROM vergis.dim_area GROUP BY …` → **funciona**: el SQL calificado `schema.tabla` de los specs corre sin reescritura.
2. JOIN entre dos schemas attachados (`vergis.dim_area` × `trust.closure`) → **funciona**.
3. Ciclo `DETACH` / re-`ATTACH` (mundo efímero por request) → **funciona**; el schema re-attachado nace vacío.
4. Referencia a un schema no attachado → **error ruidoso** (`no such table: vergis2.x`) — fail-closed, no silencio.
5. Parámetros bindeados `@nombre` (el contrato del drill-through, `execute-sql-dwh.ts:18-27`) vía `prepare`/`bind({'@ctx_area': …})` → **funciona**.

---

## 2 · Decisiones selladas

### D1 — El motor es SQLite vía sql.js (ya en el árbol); DuckDB descartado

**Racional (supply-chain, ADR-001):** cero dependencias nuevas — sql.js ya es dep de producción con módulo de apertura propio (verificado arriba), y ADR-001 hace de cada dependencia nueva una decisión documentada y presume «0 install scripts / sin binarios nativos» en producción (`docs/adr-001-lenguaje-y-supply-chain.md:47, 81, 87`). DuckDB para Node se distribuye como addon nativo (N-API) con binarios por plataforma —conocimiento público general, **no verificado contra el registry en esta sesión**—, es decir: una superficie de supply-chain nueva del tipo que el ADR evita, a cambio de un dialecto que tampoco es el de producción. Y ese es el punto decisivo: **producción ya tiene DOS dialectos divergentes** (SQL de ClickHouse y T-SQL de Fabric), así que ningún motor local compra paridad de dialecto con «prod» en general — el mejor SQL de DuckDB no paga su costo. Hermético además en CI: WASM puro, sin red ni Docker.

### D2 — Enforcing por «réplica efímera por consumidor»: el evaluador de referencia ES el motor de filtrado

La tensión central del frente: SQLite no tiene RLS nativa, y la doctrina del catálogo es «enforcing o no se sirve» (charter §2b vía `serve-rls.ts:196-198, 512-515`). Resolución — el Motor L es **enforcing**, con este mecanismo:

Por cada request de datos, el conector construye un **mundo SQLite efímero** que contiene, para cada dataset del nodo, **exactamente las filas que `applyPolicy` (el evaluador de referencia, `ir.ts:145-152`) autoriza para los claims del consumidor** — y ninguna más. El SQL del spec corre verbatim contra ese mundo (schemas attachados con su nombre: experimento 1). La fila no autorizada **no existe** en el motor que ejecuta la query.

Por qué esta forma y no las alternativas:

- **No post-filtrado de resultados:** una query agrega (`SUM`, `GROUP BY`) sobre filas base; filtrar el resultado agregado ≠ filtrar las filas base — divergiría de la semántica de ROW POLICY/SECURITY POLICY. La réplica efímera filtra en la fila BASE antes de la query, igual que los motores de producción.
- **No un tercer codegen (Policy → WHERE de SQLite):** sería una tercera superficie de traducción que exigiría su propia batería diferencial contra el oráculo, con su propio riesgo de drift. Aquí no hay traducción: el filtro **es** el oráculo — la semántica canónica por construcción. Bonus: el filtrado opera sobre las filas semilla crudas (JS), las mismas contra las que corren los property tests — cero drift de coerción de tipos entre almacenamiento y evaluación.
- **Fail-closed en cada eslabón:** claims vacíos → `applyPolicy` deny → 0 filas (`ir.ts:118-131`); dataset sin política → el bootstrap aborta (mismo contrato que `computeBound`, `engines/clickhouse.ts:40-42`) y el conector además lo defiende por request (una política removida en caliente vuelve a error, no a fuga); tabla fuera de los datasets → `no such table`, error ruidoso (experimento 4).

**Trade-off declarado:** el filtro corre en el proceso Node — la frontera de confianza del ADR («el motor de base de datos, no el proceso Node», `adr-001:27`) no aplica al Motor L. Ese es el precio estructural de «sin nube», y es lo que D3 confina.

### D3 — Confinamiento estructural: el Motor L jamás arranca detrás de un gate real `[propuesta — revocable por César]`

`VERGIS_ENGINE=local` ∧ `VERGIS_GATE_SECRET` presente → **el arranque aborta** con error nombrado (no warning). Misma señal fail-safe que ya gobierna `decideDevIdentity` y `--fresh` (`server/config.ts:164-172, 204-210`): la presencia del secreto del gate marca un despliegue real, y un motor cuyo enforcement vive en el proceso no se para detrás de él. La decisión es pura y testeable (`decideLocalEngine(env)`), tercera fila de la misma familia.

Es **defensa en profundidad, no la fuente del enforcement**: el conector es enforcing por D2 igual; esta regla solo hace estructuralmente imposible el despliegue que nadie diseñó.

*Alternativa descartada:* permitir Motor L con gate real «bajo su responsabilidad» (flag de override). Descartada porque contradice la doctrina fail-closed del proyecto: los overrides de seguridad no existen en ningún otro punto del árbol (ni `--fresh` ni dev-identity los tienen).

### D4 — Alcance SQL: dialecto SQLite, divergencia declarada; sin aliasing de conectores

Los specs del Motor L declaran `capability: execute-sql-local` y escriben su SQL en dialecto SQLite. **No se promete** que un spec de dev corra en producción sin reescritura — y no es una renuncia nueva: los specs ya nombran su conector (`examples/rls-areas.yaml:31`) y producción ya vive con dos dialectos; la portabilidad inter-motor nunca fue contrato. Se descarta explícitamente el aliasing (registrar el conector local bajo los nombres `execute-sql-ch`/`execute-sql-dwh` para servir specs de prod): serviría el nombre pero mentiría el dialecto — cualquier SQL no trivial rompería en runtime, que es la peor forma de descubrir la divergencia.

**Lo que el Motor L promete es la MECÁNICA del producto** — RLS por consumidor, render, interacciones, drill-through (binds `@ctx_*`: experimento 5), notas, gobierno, admin — no el SQL final de un spec de producción. El QC de dialecto de producción sigue donde está: las probes de Miranda contra el motor real y las corridas vivas.

### D5 — Datos semilla: el contrato de datasets de CH, menos `ingest`, más `fixture`

`VERGIS_DATASETS` con la misma forma que el Motor B (`table: 'db.tabla'`, `columns`, `seed` inline — `engines/clickhouse.ts:17-23`), con dos diferencias:

- **`fixture: <ruta>.json|csv`** como alternativa a `seed` para volúmenes que no caben cómodos inline (se cargan al arranque; mismo fail-closed de parseo fatal que la config de instancia, `arquitectura-multi-reporte.md` §instance-config).
- **`ingest` (desde DWH) es error de config en Motor L**: «sin nube» es la definición del motor; declarar un ingest ahí es una contradicción que se nombra al arranque, no se degrada.

Los **cierres jerárquicos** (`via` de los predicados Nivel-2) son datasets normales: el `ReferenceData` del evaluador se deriva de las tablas que las políticas nombran como `via` (`ir.ts:80-115`), leyendo sus filas semilla. Una política que nombra un `via` sin dataset correspondiente → error de arranque (fail-closed, análogo al binder `unknown-reference`, `packages/policy/src/binder.ts:43-49`).

### D6 — Claims leídos por request: el Motor L no hereda el caveat del restart

En B y C las inyecciones de claims se fijan al arranque (caveat registrado: claim nuevo ⇒ restart; `serve-rls.ts:295-299, 358-362`). El Motor L no tiene inyecciones que fijar: `applyPolicy` consulta el policy store (referencia viva, hot-reload incluido) y los claims del consumidor **en cada request**. Un claim o política nueva aplica a la request siguiente sin restart. El contrato operativo del Motor L no registra ese caveat — es una propiedad del mecanismo, no una mejora prometida aparte.

### D7 — Posicionamiento honesto del frente: qué agrega sobre la suite hermética (y qué no)

La suite ya prueba render-con-RLS sin nube (`tests/serve-rls.test.ts:1-8`), y el oráculo + property tests ya sostienen la equivalencia de semántica RLS (`adr-001:29`). El Motor L **no agrega garantía de corrección** — no es un instrumento de verificación y este diseño no lo vende como tal. Lo que agrega es lo que los tests no pueden dar por naturaleza:

1. **El producto entero corriendo** — `git clone && npm i && npm run dev:local` → navegador: catálogo, PIs, admin, notas, Miranda, con identidades conmutables por `VERGIS_DEV_IDENTITY`/headers. Hoy eso exige Docker (CH) o nube (Fabric).
2. **Desarrollo de superficies del servidor** (rutas, nav, SSR de gestión, flujos de admin) contra un motor vivo, con loop de segundos.
3. **Demo y onboarding sin infraestructura** — la puerta natural del corte open-core (frente 11 de este cluster): un quickstart que no pide cuenta cloud.
4. **E2E hermético del PROCESO servidor en CI** — arrancar `serve-rls.ts` de verdad y golpearlo por HTTP con dos identidades, sin Docker (hoy la prueba de proceso vivo es el script Docker bajo demanda).

Si César juzga que 1–4 no pagan el frente, el recorte honesto es cerrarlo como «cubierto por la suite» — pero la evidencia es que el punto 1 hoy no existe por ninguna vía sin Docker/nube.

---

## 3 · Arquitectura y contratos

### ¿Dónde vive cada pieza?

```
packages/capabilities/src/execute-sql-local.ts   ← la Capability (conector enforcing, Motor L)
server/engines/local.ts                          ← lógica PURA del binding local (espejo de engines/clickhouse.ts)
server/config.ts                                 ← Engine + 'local' · decideLocalEngine (gate estructural D3)
server/serve-rls.ts                              ← rama de setup del Motor L (SERVING_CAPS, bootstrap, health)
examples/local/                                  ← instancia de ejemplo completa del arnés
```

### `execute-sql-local` — contrato de la Capability

```ts
/** Tipos de columna del mundo local (afinidades SQLite: TEXT/INTEGER/REAL; fechas = TEXT ISO). */
export type LocalColumnType = 'string' | 'integer' | 'float' | 'date'

export interface LocalDataset {
  /** `db.tabla` — se attacha el schema `db` y se crea `tabla` (experimento 1). */
  table: string
  columns: Record<string, LocalColumnType>
  /** Filas semilla YA cargadas (seed inline o fixture resuelto por el server). */
  rows: Record<string, unknown>[]
}

export interface LocalEngineDeps {
  datasets: LocalDataset[]
  /** Referencia VIVA al policy store (hot-reload incluido). undefined → throw por request (fail-closed). */
  policyFor: (table: string) => PolicyDecl | undefined
  /** Cierres jerárquicos derivados de los datasets nombrados por `via` (D5). */
  referenceData: () => ReferenceData
}

export function createExecuteSqlLocal(deps: LocalEngineDeps, opts?: { name?: string }): Capability
// name = 'execute-sql-local'
// execute(params, identity, signal):
//   params: { sql: string; params?: Record<string, string|number>; database_ref?: string }
//     - `database_ref` se ACEPTA y SE IGNORA (paridad de shape con el canal de serving: la ruta de
//       probes pasa un ref — serve-rls.ts:1480-1486; el Motor L no tiene perfiles de conexión).
//     - `params` → binds `@nombre` (drill-through; experimento 5). Bindeados, nunca concatenados.
//   → { rows: Record<string, unknown>[] }
```

**Semántica de `execute` (el mecanismo D2, paso a paso):**

1. `signal?.aborted` → throw temprano (sql.js es síncrono: no hay cancelación mid-query; se declara — escala dev).
2. Para cada dataset: `policy = policyFor(table)`; **sin política → throw** con mensaje que nombra la tabla (fail-closed por request, cubre la remoción en caliente).
3. `visible = applyPolicy(policy, identity.claims ?? {}, rows, referenceData())` — el oráculo filtra las filas semilla crudas.
4. Mundo efímero: `new SQL.Database()` → por cada schema `db` distinto: `ATTACH ':memory:' AS db` → `CREATE TABLE db.tabla (…)` → insertar SOLO `visible`.
5. `prepare(sql)` + binds `@nombre` → filas como objetos (patrón `selectAll`, `sqlite.ts:51-56`) → `close()` del mundo (nada persiste).

**Semántica de error:** todos los fallos lanzan con prefijo `execute-sql-local:` y causa nombrada (tabla sin política, schema/tabla inexistente, SQL inválido, fixture no parseable en el server). Nunca se responde parcial.

**Autorización:** idéntica al resto del catálogo — los claims llegan en `identity.claims`, puestos por el gate/dev-identity vía el Botler; el consumidor jamás los controla (mismo contrato que `execute-sql-ch.ts:5-7`).

### `server/engines/local.ts` — lógica pura (testeable sin server)

```ts
export interface LocalDatasetCfg {
  table: string                              // 'db.tabla' (valida forma, como computeBound)
  columns: Record<string, LocalColumnType>
  seed?: Record<string, unknown>[]
  fixture?: string                           // ruta .json | .csv
  // `ingest` NO existe en este tipo: declararlo en el YAML es error nombrado (D5).
}

/** Espejo de computeBound (engines/clickhouse.ts:35-46): fail-closed, dataset sin política LANZA. */
export function computeLocalBound(
  datasets: LocalDatasetCfg[],
  store: Map<string, PolicyDecl>,
  loadFixture: (path: string) => Record<string, unknown>[],   // seam inyectable (FS real en el server)
): LocalDataset[]

/** Deriva ReferenceData de las tablas que las políticas del store nombran como `via`.
 *  `via` sin dataset → lanza (fail-closed, análogo a binder unknown-reference). */
export function deriveReferenceData(
  store: Map<string, PolicyDecl>,
  datasets: LocalDataset[],
): ReferenceData
```

### `server/config.ts` — el gate estructural (D3)

```ts
export type Engine = 'clickhouse' | 'fabric' | 'local'    // config.ts:21 + validación serve-rls.ts:150

/** Tercera fila de la familia decideDevIdentity/decideFreshStore (config.ts:164-210). */
export type LocalEngineDecision =
  | { mode: 'not-local' }        // engine ≠ local: sin efecto alguno
  | { mode: 'ok' }               // local ∧ sin gate real
  | { mode: 'refused-gate' }     // local ∧ VERGIS_GATE_SECRET presente → el ARRANQUE ABORTA
export function decideLocalEngine(env: Env): LocalEngineDecision
```

### Rama del Motor L en `serve-rls.ts`

- `SERVING_CAPS = new Set(['execute-sql-local'])` cuando `engine=local` (extiende `serve-rls.ts:198`). El descubrimiento no cambia: para `engine ≠ fabric` el gate por-tabla vive en el bootstrap (`discovery.ts:88-101`), y en local el bootstrap es `computeLocalBound` (aborta sin política) + la defensa por request del conector.
- **Bootstrap local:** cargar `VERGIS_DATASETS` (mismo env que B; clave raíz requerida, mismo patrón de error de `serve-rls.ts:280-289`), `computeLocalBound`, `deriveReferenceData`, construir el conector. Sin retry loop (no hay red), sin ingesta, sin timer de refresh: `ready = true` en frío.
- **Hot-reload de gobierno:** `bootstrapAll` local re-ejecuta `computeLocalBound` sobre el store nuevo (paridad con A11); el filtrado por request ya lee el store vivo (D6).
- `healthz` responde `engine: 'local'`; el estado es global como en B (una réplica conceptual), no por-PI.
- **Arranque:** `decideLocalEngine` en modo `refused-gate` → `throw` antes de escuchar (D3), con mensaje que nombra ambos envs.

### Instancia de ejemplo (`examples/local/`)

`specs/` (≥1 PI con RLS por membresía y 1 con predicado jerárquico, `capability: execute-sql-local`, SQL SQLite) · `datasets.yaml` (seeds + un cierre jerárquico) · `policies.yaml` · `README` de 10 líneas. Script `dev:local` en `package.json`:

```
VERGIS_ENGINE=local HOST=127.0.0.1 VERGIS_DEV_IDENTITY='dev@local:Producción' \
VERGIS_DATASETS=examples/local/datasets.yaml VERGIS_POLICIES=examples/local/policies.yaml \
VERGIS_SPECS_DIR=examples/local/specs tsx server/serve-rls.ts --fresh
```

(`--fresh` funciona porque dev-identity está activa y no hay gate — `config.ts:204-210`.)

---

## 4 · Plan de construcción

> Elaborado para ejecución por Opus en frío. Gates transversales de todo hito: `npm run typecheck` y `npm test` verdes, **cero dependencias nuevas** (el diff de `package-lock.json` no agrega paquetes), sin tocar producción.

### H1 — El conector enforcing (capabilities)

**Territorio:** `packages/capabilities/src/execute-sql-local.ts` (nuevo) · export en `packages/capabilities/src/index.ts` (junto a `index.ts:144-147`) · `tests/execute-sql-local.test.ts` (nuevo).

**Contenido:** la Capability según §3, reutilizando `openSqliteDb`-infra de `sqlite.ts` para la inicialización WASM (el mundo efímero usa `new SQL.Database()` directo, sin archivo).

**Tests (el juez):**
1. Sin claims → 0 filas (default-deny) aunque la tabla tenga datos.
2. Dos identidades → conjuntos de filas EXACTAMENTE iguales a `applyPolicy` directo sobre las semillas (diferencial contra el oráculo: prueba la mecánica de ensamblaje — tipos, encoding, naming calificado — no la semántica, que es idéntica por construcción).
3. **Agregación:** `SELECT SUM(x) FROM db.t` difiere entre identidades según sus filas visibles (la razón de descartar el post-filtrado, D2).
4. Predicado jerárquico con cierre seeded → visibilidad por descendencia.
5. Tabla sin política → throw nombrando la tabla; tabla fuera de datasets → error `no such table` propagado.
6. Binds `@ctx_*` (drill-through) filtran DENTRO de lo autorizado.
7. Diferencial cruzado: para predicados de membresía, filas(Motor L) ≡ filas(fake CH con `emulate`) con los mismos claims (puente con el arnés de `tests/serve-rls.test.ts:35-38`).

**Hecho cuando:** `npx vitest run tests/execute-sql-local.test.ts` verde + gates transversales.

### H2 — El motor `local` en el servidor

**Territorio:** `server/engines/local.ts` (nuevo) · `server/config.ts` (`Engine` + `decideLocalEngine`) · `server/serve-rls.ts` (validación de engine `:150`, `SERVING_CAPS :198`, rama de setup junto a `:270-395`) · `tests/engines-local.test.ts`, ampliaciones de `tests/config.test.ts`.

**Tests:** `computeLocalBound` fail-closed (sin política lanza; fixture no parseable lanza; `ingest` declarado lanza) · `deriveReferenceData` (via sin dataset lanza) · `decideLocalEngine` (las tres celdas de la tabla, en particular `refused-gate`) · discovery con `engine='local'` sirve specs `execute-sql-local` y omite los demás.

**Hecho cuando:** suite verde y el arranque manual con `examples/local` (H3 embrionario: un spec + un dataset mínimos creados aquí) responde `/healthz` con `engine: local` y aborta si se agrega `VERGIS_GATE_SECRET=x` al env.

### H3 — El arnés y el juez de proceso vivo

**Territorio:** `examples/local/` completo (§3) · script `dev:local` en `package.json` · `tests/serve-rls-local-e2e.test.ts` (nuevo) · actualización de `docs/arquitectura-multi-reporte.md` (Motor L junto a B y C) y `docs/gobierno-permisos.md` (tabla del gate estructural, junto a las de dev-identity/--fresh).

**El e2e hermético (lo que la suite no tenía):** arranca el proceso `serve-rls.ts` real en puerto efímero con la instancia de ejemplo, SIN Docker ni red externa; hace fetch del PI con dos identidades (headers forjados — válido porque no hay gate, `gobierno-permisos.md` §dev-identity) y asserta que los HTML difieren en las filas esperadas; verifica además que el catálogo (`visibleFor`) segmenta.

**Hecho cuando:** `npx vitest run tests/serve-rls-local-e2e.test.ts` verde en un entorno sin Docker; `npm run dev:local` deja el producto navegable en `127.0.0.1:8080` con identidades conmutables.

---

## 5 · Destranque

**Este frente no tiene bloqueo técnico.** A diferencia de sus hermanos de #113, no espera API de terceros ni scope externo: todo su terreno está en el árbol y sus dos riesgos de mecanismo quedaron medidos en esta sesión (experimentos §1). El disparador es **priorización de César**, y los eventos que naturalmente lo suben:

- la apertura del corte open-core (frente 11 del cluster): el quickstart sin nube es su puerta de entrada;
- un segundo desarrollador u onboarding externo;
- una demo comercial sin infraestructura del cliente.

**Sensible a envejecer (re-verificar al destrabar):**

- `serve-rls.ts` está en refactor `createApp()` (A14 — `discovery.ts:2-3`, `config.ts:4-6`): las anclas de línea de la rama de setup (`:150, :198, :270-395`) se moverán; el corte de módulos de este diseño (engines/local puro + rama de plumbing) es justo el del refactor, así que el diseño sobrevive — las anclas no.
- Los frentes 03 (config recargable, #138·2) y 01 (#139 delta de contrato) tocan `server/config.ts`: reconciliar `decideLocalEngine` y las claves de env nuevas con lo que hayan sellado.
- El contrato `DatasetCfg` de B podría evolucionar (fixture files le servirían también); si B adopta `fixture`, unificar el tipo base en vez de duplicarlo.
- Verificar que `sql.js` siga en el árbol con el mismo módulo `sqlite.ts` (si la capa de notas migrara de backend, el argumento «cero deps nuevas» de D1 se re-pesa — seguiría siendo cierto que sql.js es la opción sin binarios nativos, pero ya no sería gratis).

---

## 6 · Riesgos y no-metas

### Riesgos

| Riesgo | Tratamiento |
|---|---|
| El enforcement corre en el proceso Node (sin motor detrás como frontera) | Declarado en D2; confinado por D3 (jamás con gate real). Es un motor de desarrollo por contrato, no una promesa de producción. |
| Dialecto SQLite acostumbra mal a autores de specs de prod | El nombre `execute-sql-local` hace la divergencia explícita en el spec (D4); docs del arnés lo declaran; el QC de dialecto real sigue en Miranda/corridas vivas. |
| Costo O(filas) por request (filtrado + inserción del mundo efímero) | Escala dev declarada (semillas de miles de filas, no millones). Memoización por hash de claims es una optimización disponible, NO se construye en H1-H3 (evitar ingeniería sin síntoma). |
| sql.js es síncrono: una query pesada bloquea el event loop; sin cancelación mid-query | Declarado en el contrato (§3, paso 1). Aceptable a escala dev; no se disfraza. |
| Drift entre `LocalDatasetCfg` y `DatasetCfg` de B | Tipos separados HOY (contratos distintos: `ingest` prohibido vs permitido); nota de unificación en Destranque si B adopta `fixture`. |

### No-metas

- **No es un motor de producción** ni pretende serlo — ni con datos «poco sensibles».
- **No es QC de SQL de producción** ni sustituye las probes de Miranda o las corridas vivas (`scripts/serve-rls-proof.ts`).
- **No agrega garantía de corrección de RLS** — esa la sostienen el oráculo y los property tests existentes (D7).
- **Sin aliasing** de `execute-sql-ch`/`execute-sql-dwh` (D4).
- **Sin ingesta desde DWH** en Motor L (D5) — «sin nube» es definición, no limitación.
- **Sin persistencia del mundo de datos local** (efímero por diseño); los stores de gobierno/notas/data-maestra persisten aparte, como siempre, y son independientes del motor.

---

**Versión:** v1.0
• 🤖 Claude (Fable) · diseño del frente 09-113-execute-sql-local · cluster 004
