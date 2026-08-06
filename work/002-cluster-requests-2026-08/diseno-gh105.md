# Diseño · Issue #105 — Proyección `ingestion_run` + reconcile periódico con debounce (P-31 · parte 2)

**Rol:** documento de diseño ejecutable (contrato de delegación wingcoding). El ejecutor arranca en frío: todo lo que necesita está aquí o en las rutas exactas citadas. Repo: `/Users/cesar/wworkspace/productos/vergis` (monorepo TypeScript; `packages/capabilities` = librería; `server/` = módulos de `serve-rls`; `tests/` = vitest). Rama base: `main`.

**Issue:** [Gegolabs/vergis#105] — dos costuras a medias en el frente de Frescura: (1) el render de Frescura pega a Fabric en cada carga (sin proyección local del historial de corridas: latencia + acoplamiento — si el motor está caído, la vista de observabilidad se degrada con él); (2) el reconcile del schedule solo ocurre por acción humana («Aplicar cadencia») — falta el lazo periódico con debounce. Parte 1 (persistencia del estado de alertas) ya mergeada: #104, commit `b5e978f`.

**Coordinación con frentes hermanos (leer, no tocar):**

- **#99** (log de una corrida) ya diseñado en `work/002-cluster-requests-2026-08/diseno-gh99.md`: sirve logs desde OneLake `_logs/run-<ts>.txt`, correlación por timestamp; sus enlaces desde Frescura usan `runs[0].startedAt`. Este diseño es compatible: la proyección guarda el `startedAt` **tal cual lo entrega el motor** (misma cadena ISO), así el enlace de #99 sigue casando exacto.
- **#101** (estado de ingestas en la vista transversal de Fuentes) se diseñará DESPUÉS **consumiendo la proyección de este diseño**: el contrato de lectura queda sellado en D6 y es estable.
- **#62** agregará tablas de intake (hash de cargas) al GovernanceStore: los nombres de tabla de este diseño (`ingestion_run`, `ingestion_process_state`) no colisionan con ese espacio — `ingestion_run` además ya estaba reservado por nombre en el docstring del store (`governance-store.ts:36-37`).

---

## ¿Cuál es la realidad del código sobre la que se diseña?

Hechos verificados contra el código (2026-08-06, rama `main`, HEAD `ab6d8fc`):

1. **La vista de Frescura pega al motor en cada GET.** `domainFreshness` (`server/serve-rls.ts:1022-1055`) llama, por proceso del dominio, `engine.listRunHistory(processId)` + `engine.getScheduleSeconds(processId)` en el request path de `/admin/dominio/<id>/frescura` (`server/admin.ts:263-266` → `domainFreshnessPage` → `deps.domainFreshness`). Cada una es una llamada REST a Fabric con timeout de 30 s (`fabric-engine.ts:64,105`; `intake-onelake.ts:233`). Ante fallo, la fila muestra `runs: 'error'` → «motor no respondió» (`admin.ts:801`) — no hay memoria de lo último conocido.
2. **El reconcile solo corre por botón.** `applyCadence` (`serve-rls.ts:1058-1069`) — invocado únicamente desde el POST de Frescura (`admin.ts:267-279`) — hace `getScheduleSeconds` → `reconcilePlan` → `setScheduleSeconds` si `set`, y audita `frescura-aplicar-cadencia`.
3. **`reconcilePlan(desiredSeconds, actualSeconds)` es pura y está probada** (`packages/capabilities/src/ingestion-observability.ts:65-67`; `tests/ingestion-observability.test.ts:44-49`). Su docstring declara: «El *debounce* es operacional (el llamador lo aplica), no de esta función pura».
4. **Ya existe UN lazo periódico: el monitor de alertas de #104** (`serve-rls.ts:935-987`): `setInterval` config-gated por `VERGIS_FRESHNESS_SLACK_WEBHOOK` + `VERGIS_FRESHNESS_POLL_MS` (default 0 = apagado), con `unref()`. Cada tick lee el run-history de todos los procesos observables (¡las mismas llamadas que la vista!), clasifica con `freshnessAlerts`, dedupa con `diffAlertState` y persiste el estado en `platform_setting` clave `freshness.alert_state` **solo en transición**, hidratando **en el primer tick**. Ante fallo de lectura usa `[] as RunRecord[]` (`serve-rls.ts:968`) — lo que clasifica como `NoRuns` → `missed`.
5. **`RunRecord` no tiene id de instancia del motor** (`ingestion-observability.ts:17-23`): el mapeo de Fabric lo descarta (`intake-onelake.ts:239-244`) y puede producir `startedAt: ''` si `startTimeUtc` falta. `listRunHistory` recorta a `RUN_HISTORY_TOP = 10` (`fabric-engine.ts:22,134`).
6. **La conversión segundos↔schedule de Fabric NO es identidad.** `secondsToIntervalMinutes = max(1, floor(s/60))` (`fabric-engine.ts:37`) y `scheduleToSeconds` devuelve `interval*60` (`fabric-engine.ts:40-47`). Consecuencia aritmética: un `desired` que no sea múltiplo de 60 (p. ej. 90) se escribe como 1 min y se lee de vuelta como 60 → `reconcilePlan(90, 60) = set` **para siempre**: sin debounce, un lazo periódico empujaría PATCH al motor en cada vuelta, a perpetuidad. Este es el mecanismo concreto que exige el debounce; el test T2-c4 lo encoda como el experimento que lo refutaría (Norma 7).
7. **El GovernanceStore es SQLite (sql.js) con persist atómico de archivo COMPLETO**: `persistSqliteDb` escribe `db.export()` entero a `.tmp` + `rename` (`packages/capabilities/src/sqlite.ts:36-48`). Cada método del store llama `this.persist()` (`governance-store.ts:394-396`). Corolario de diseño: la escritura de la proyección debe ser **por lote** (una llamada, un persist por vuelta), no un persist por proceso. El patrón de migración de columnas es `ensureColumns` (`governance-store.ts:267-274`).
8. **El patrón de timers del server**: `setInterval(...).unref()` + primer disparo con `setTimeout(..., 5000).unref()` tras el bootstrap (purga de retención, `serve-rls.ts:710-712`; monitor, `serve-rls.ts:984-986`).
9. **`deriveIngestionMap` excluye procesos event-driven** y da `requiredCadenceSeconds` por proceso (`freshness.ts:126-157`); el monitor usa `Infinity` para procesos fuera del mapa (`serve-rls.ts:969`). `freshnessInputs()` (`serve-rls.ts:920-934`) arma el insumo desde el govStore + demandas.
10. **El render**: `freshnessHealthCell` (`admin.ts:797-806`) pinta tipo de motor + última corrida + bandera; `domainFreshnessPage` (`admin.ts:915-1025`) pinta schedule (`admin.ts:966-970`), botón «Aplicar» cuando hay drift (`admin.ts:971-974` — OJO: con `actualScheduleSeconds: null` el drift da `true` y el botón aparece **sin saber el schedule real**), y los slots huérfanos con `intakeStatus` en vivo (`admin.ts:992-1004`). La variante `runs: 'error'` de `DomainEntityFreshness` solo la consume `admin.ts:801` — ningún test la asserta para filas de entidad (verificado por grep en `tests/admin-frescura-routes.test.ts`).
11. **Tests**: las rutas de Frescura se prueban montando `createAdmin` con deps mockeadas y `mockReq`/`mockRes` (`tests/admin-frescura-routes.test.ts:1-80`); las puras del frente en `tests/frescura-frente-b.test.ts`; el store en `tests/governance-store.test.ts`. El monitor inline de `serve-rls.ts` NO tiene test propio (es cierre dentro del arranque — por eso este diseño lo extrae a módulo).

Conjeturas etiquetadas:

- **[Conjetura C1]** 5 min de poll (default sellado en D9) es cadencia suficiente para la observabilidad y aceptable para Fabric (rate limits de `jobs/instances` + `schedules` con ~decenas de procesos). No verificado contra motor vivo → parámetro por env + gate manual G-M1.
- **[Conjetura C2]** La lentitud percibida de la vista hoy proviene de las llamadas seriadas al motor. El issue lo afirma; no se midió aquí. El diseño no depende de la medición: desacoplar el request path del motor es el objetivo en sí (disponibilidad), no solo la latencia.

---

## ¿Cuáles son las decisiones de diseño? (selladas, con racional)

**D1 — La proyección vive en el GovernanceStore como DOS tablas: `ingestion_run` (corridas) + `ingestion_process_state` (schedule observado + marca de observación + último error).**
Racional: (a) el docstring del store ya reservaba `ingestion_run` como fase siguiente (hecho 7 / `governance-store.ts:36-37`) — es SU lugar: observabilidad de ingestión es estado de gobierno, no dato de negocio; (b) separar corridas (N filas por proceso, con retención) del estado puntual del proceso (1 fila: schedule + staleness) evita columnas repetidas y hace el snapshot O(1); (c) los nombres no colisionan con las tablas de intake de #62.

**D2 — Identidad de corrida = `(process_id, started_at)`; el upsert actualiza `status`/`ended_at`/`error` en sitio.**
Una corrida `InProgress` observada en el tick N y `Completed` en el N+1 es LA MISMA fila (misma PK) — la proyección converge sin duplicar. Corridas con `startedAt` vacío se ignoran (no hay clave posible — hecho 5). Racional: `RunRecord` no trae id de instancia del motor (hecho 5); `startedAt` es el identificador natural que ya usa el enlace de #99, y guardarlo **tal cual** (misma cadena ISO del motor) mantiene ese enlace exacto.

**D3 — Retención: 60 corridas por proceso, podadas por el PROPIO store en la escritura.**
`INGESTION_RUN_RETENTION = 60`. A diferencia de #99 (donde el producto no poda porque el directorio es de otro escritor), acá la tabla es del store: podar en `recordObservations` es seguro y mantiene el archivo SQLite acotado (el persist vuelca el archivo completo — hecho 7). 60 es coherente con `RUN_LOG_RETENTION` de #99: mismo horizonte de historia consultable.

**D4 — API de escritura POR LOTE y observación atómica por proceso.**
`recordObservations(obs[])`: una llamada, un `persist()` por vuelta del lazo (hecho 7 hace caro lo contrario). La observación de un proceso es atómica: el lazo lee runs Y schedule juntos; si **cualquiera** de las dos lecturas falla, se registra el error del proceso y NO se escriben datos parciales de esa vuelta — lo último conocido queda intacto. Racional: semántica simple y honesta; nunca un snapshot con runs de las 10:00 y schedule de las 10:05 mezclados sin marca.

**D5 — La proyección registra solo lo OBSERVADO, nunca lo prometido.**
Tras un `setScheduleSeconds` exitoso (del lazo o del botón manual), NO se escribe el `desired` como schedule proyectado: se **re-observa** (`getScheduleSeconds`) y se registra lo leído. Racional: el motor puede redondear (hecho 6) — registrar la promesa fabricaría un dato falso que además ocultaría el drift permanente; registrar lo leído es el corolario de instrumentos de la Norma 7 aplicado al store.

**D6 — Contrato de lectura SELLADO para consumidores (Frescura hoy; la vista transversal #101 mañana): `listRunSnapshots()`.**
Devuelve, por proceso presente en la proyección: corridas (más reciente primero, hasta un límite pedido), schedule observado (`null` = el item no tiene schedule — distinto de «no observado»), `observedAt` de la última observación exitosa (`null` = proyección fría), y `lastError`/`lastErrorAt` del último intento fallido. Con eso #101 responde «última corrida, desenlace, timestamps, schedule» por proceso **sin tocar el motor**. Este contrato (nombres y semántica de la interfaz `IngestionRunStore` de abajo) es estable: #101 lo consume tal cual.

**D7 — Un ÚNICO lazo de control, extraído a módulo testeable: `server/freshness-loop.ts` (`createFreshnessLoop`), que ABSORBE el monitor de #104 y agrega observación + reconcile.**
Hoy el monitor ya hace el pull periódico del run-history (hecho 4) y la vista repite esas mismas llamadas por su lado (hecho 1). Criterio de excelencia: si nada existiera, se diseñaría UN lazo con tres fases — (1) **observar** el motor y escribir la proyección, (2) **alertar** sobre lo observado (la lógica de #104, movida, no duplicada), (3) **reconciliar** el schedule con debounce. El monitor inline de `serve-rls.ts:935-987` se REEMPLAZA por el wiring del módulo nuevo. Los tres invariantes de #104 se preservan EXACTOS como regla dura: hidratación del estado en el primer tick (no en el arranque), persistencia del estado **solo en transición**, `parseAlertState` fail-safe. Las funciones puras de `ingestion-observability.ts` no se tocan.

**D8 — El render lee SOLO la proyección; el request path jamás toca el motor. La staleness es un dato de primera clase, visible.**
`domainFreshness` (wiring) pasa a leer `listRunSnapshots()` — mapeo síncrono, cero llamadas REST en el GET. `DomainEntityFreshness` pierde la variante `runs: 'error'` (criterio de excelencia: esa variante modelaba «no pude leer AHORA», que ya no existe en el request path; solo la consumía `admin.ts:801` y ningún test — hecho 10) y gana `projection?: { observedAt, stale, lastError, off }`. Estados y textos sellados del render (en `freshnessHealthCell` / `domainFreshnessPage`; los tests los observan):

- Proyección **fría** (nunca observada), lazo activo, sin error: `esperando el primer refresco del motor`.
- Proyección **fría** + `lastError`: `el motor no respondió al refresco — sin datos aún (se reintenta solo)`.
- Con datos y **fresca** (edad ≤ 3× el poll, sin `lastError`): la celda actual sin línea extra (cero ruido en el caso sano).
- Con datos y `lastError` (el último intento falló): `⚠ el último refresco falló — datos de ⟨fmtWhen(observedAt)⟩`.
- Con datos y **stale** (edad > 3× el poll): `⚠ datos de ⟨fmtWhen(observedAt)⟩ — el refresco no está corriendo`.
- Lazo **apagado** (`off`): `refresco apagado — datos de ⟨fmtWhen(observedAt)⟩` (o `refresco apagado — sin datos` si fría).

Además: con proyección fría, la columna «Schedule motor» muestra `—` (no `sin schedule` — eso afirmaría algo no observado) y el botón «Aplicar» NO se ofrece (hoy aparece con schedule desconocido — hecho 10; drift solo se afirma sobre schedule observado).

**D9 — Defaults: el lazo nace ENCENDIDO (poll 5 min) cuando hay motor; las alertas Slack siguen gated por webhook; el reconcile automático nace encendido con su apagador.**
`VERGIS_FRESHNESS_POLL_MS` default pasa de `0` a `300_000` (solo aplica si hay `engine`; `0` explícito apaga el lazo). `VERGIS_FRESHNESS_SLACK_WEBHOOK` ausente ⇒ fase de alertas apagada (sin computar ni persistir estado — como hoy), pero observación y reconcile corren igual. `VERGIS_RECONCILE_AUTO=off` apaga solo la fase 3 (default: encendida). `VERGIS_RECONCILE_DEBOUNCE_MS` default `21_600_000` (6 h). Racional: la proyección es la memoria del producto — no puede depender de que alguien configure Slack; y el issue pide precisamente cerrar el lazo sin depender del botón. Pre-launch: el default correcto, no el default heredado.

**D10 — Debounce del reconcile: no re-empujar el MISMO `desired` al MISMO proceso dentro de la ventana (default 6 h); un `desired` que CAMBIA se empuja de inmediato.**
Estado en memoria del lazo: `lastPush: Map<processId, { desiredSeconds, atMs }>`. Se empuja si `plan.action === 'set'` Y (sin push previo, O `desired` distinto del último empujado, O ventana vencida). Racional: el caso convergente empuja UNA vez y la vuelta siguiente da `noop` solo (el debounce ni participa); el caso divergente-perpetuo (redondeo del motor — hecho 6) queda acotado a un reintento cada 6 h en vez de un PATCH cada 5 min; un cambio de demanda (nuevo `desired`) no espera. El drift manual en el motor (alguien cambió el schedule allá) se corrige en la vuelta siguiente porque `actual` cambia y `desired` sigue igual que el último push… con ventana vencida — y si está dentro de la ventana, el botón «Aplicar» manual sigue disponible para corregir ya. Trade-off aceptado y declarado: cadencias reales son horas/días.

**D11 — Ante fallo de lectura, las ALERTAS clasifican sobre lo último conocido de la proyección (no sobre `[]`).**
Hoy el monitor usa `[]` en el catch (hecho 4), lo que fabrica `missed` cuando el motor está caído — falso positivo. Con proyección, el lazo clasifica con las corridas proyectadas: un motor caído NO dispara `missed` fabricado, y el `missed` REAL dispara igual aunque el motor siga caído, porque la edad se computa contra el reloj sobre corridas viejas (`classifyProcess` usa `nowMs`). El motor caído se ve por el log del lazo y por la staleness en la vista. Es la parte «la proyección SIRVE lo último conocido» aplicada también al alertador.

**D12 — «Aplicar cadencia» manual convive sin acoplarse al lazo.**
El botón queda igual (ruta, CSRF, audit `frescura-aplicar-cadencia`); su wiring gana la re-observación de D5 (tras `set`, get + `recordObservations` de ese proceso) para que la página refleje el schedule real de inmediato. NO comparte el mapa de debounce del lazo: en el peor caso (redondeo), el lazo emite un PATCH redundante e idempotente una vez y luego debouncea. Racional: cero acoplamiento entre el request path y el estado interno del lazo.

**D13 — Fuera de alcance declarado (sin scope creep):** `intakeStatus`/`intakeLog` de slots (las líneas de slots huérfanos y el «Log de la última conversión» siguen leyendo en vivo, tolerantes a fallo como hoy — su rediseño de acceso a logs es #99), la consola de Cargas completa (`admin-cargas.ts`), y cualquier columna nueva en `/admin/sources` (eso es #101, que consumirá D6). La proyección cubre los **procesos registrados con `engine_ref`** — exactamente lo que hoy pega al motor desde las filas de entidad.

**Cero preguntas abiertas.** Ambigüedad no prevista ⇒ resolver con el principio: fail-closed honesto (nunca afirmar lo no observado), aditivo, y sin tocar las reglas duras.

---

## ¿Qué contratos y tipos exactos se introducen?

### `packages/capabilities/src/governance-store.ts` (TOCAR)

DDL nuevo (en `open()`, junto al resto — hecho 7):

```sql
CREATE TABLE IF NOT EXISTS ingestion_run (
  process_id TEXT NOT NULL,
  started_at TEXT NOT NULL,   -- ISO tal cual lo entrega el motor (clave del enlace de #99)
  ended_at TEXT,
  status TEXT NOT NULL,       -- RunStatus
  error TEXT,
  PRIMARY KEY (process_id, started_at)
);
CREATE TABLE IF NOT EXISTS ingestion_process_state (
  process_id TEXT PRIMARY KEY,
  schedule_seconds INTEGER,   -- null = el item no tiene schedule (OBSERVADO como ausente)
  observed_at TEXT,           -- última observación EXITOSA; null = proyección fría
  last_error TEXT,            -- último intento fallido (si el más reciente falló); null si el último fue bueno
  last_error_at TEXT
);
```

El índice de `ingestion_run` es su PK compuesta (`process_id, started_at`) — cubre la consulta canónica (igualdad por proceso + orden por `started_at` DESC); no se crea índice adicional.

Tipos e interfaz (se agrega a `GovernanceStore extends …`):

```ts
/** Retención de la proyección de corridas (filas por proceso). Poda el propio store al escribir. */
export const INGESTION_RUN_RETENTION = 60

/** Observación de UN proceso en una vuelta del lazo (#105). Atómica: o trae runs+schedule, o trae error. */
export interface ProcessObservation {
  processId: string
  /** ISO del instante de la observación. */
  observedAt: string
  /** Corridas leídas del motor (con `startedAt` no vacío; las vacías se ignoran al escribir). */
  runs?: RunRecord[]
  /** Schedule leído (segundos; null = el item no tiene). Presente si la observación fue exitosa. */
  scheduleSeconds?: number | null
  /** La observación falló: se registra el error y NO se tocan runs/schedule proyectados. */
  error?: string
}

/** Lo último conocido de un proceso (#105) — el contrato de lectura de Frescura y de la vista #101. */
export interface IngestionRunSnapshot {
  processId: string
  /** Corridas conocidas, más reciente primero (hasta `runsPerProcess`). */
  runs: RunRecord[]
  /** Schedule observado (null = sin schedule). Solo significativo con observedAt != null. */
  scheduleSeconds: number | null
  /** Última observación exitosa (ISO). null = proyección fría (nunca se observó). */
  observedAt: string | null
  /** Error del intento MÁS RECIENTE si falló; null si el último intento fue exitoso. */
  lastError: string | null
  lastErrorAt: string | null
}

/** Proyección local del historial de corridas + schedule por proceso (issue #105). */
export interface IngestionRunStore {
  /** Escritura POR LOTE (un persist). Éxito: upsert de runs por (process_id, started_at) + poda a
   *  INGESTION_RUN_RETENTION + estado (schedule, observed_at, last_error=null). Error: solo
   *  last_error/last_error_at (lo último conocido queda intacto). */
  recordObservations(obs: ProcessObservation[]): Promise<void>
  /** Snapshots de TODOS los procesos con estado u corridas proyectadas. runsPerProcess default 10. */
  listRunSnapshots(opts?: { runsPerProcess?: number }): Promise<IngestionRunSnapshot[]>
}
```

Semántica exacta de `recordObservations` (por cada `ProcessObservation`):

1. `error` presente ⇒ upsert en `ingestion_process_state` de SOLO `last_error`/`last_error_at` (preservando `schedule_seconds`/`observed_at` existentes vía `ON CONFLICT … DO UPDATE SET last_error=…, last_error_at=…`). Nada más.
2. Éxito ⇒ por cada run con `startedAt` no vacío: `INSERT INTO ingestion_run … ON CONFLICT(process_id, started_at) DO UPDATE SET ended_at=excluded.ended_at, status=excluded.status, error=excluded.error`. Luego poda: `DELETE FROM ingestion_run WHERE process_id = ? AND started_at NOT IN (SELECT started_at FROM ingestion_run WHERE process_id = ? ORDER BY started_at DESC LIMIT 60)`. Luego upsert del estado: `schedule_seconds`, `observed_at`, `last_error=NULL`, `last_error_at=NULL`.
3. UN `this.persist()` al final del lote (no por proceso).

`listRunSnapshots`: `SELECT` de `ingestion_process_state` LEFT-unido con las corridas (top `runsPerProcess` por proceso, orden `started_at DESC`); procesos con corridas pero sin fila de estado (no debería ocurrir, pero fail-safe) salen con `observedAt: null`.

### `packages/capabilities/src/index.ts` (TOCAR — exports)

- Al bloque `export type { SourceRow, ProcessRow, … } from './governance-store'` (línea 113) agregar `IngestionRunStore, IngestionRunSnapshot, ProcessObservation`.
- Nuevo export de valor: `INGESTION_RUN_RETENTION` (junto a `SqliteGovernanceStore`, línea 98).

### `server/freshness-loop.ts` (NUEVO — el lazo, testeable con motor fake)

```ts
/**
 * Lazo de control de Frescura (issue #105 — P-31 parte 2). UN lazo, tres fases por tick:
 *  1 OBSERVAR  — leer run-history + schedule de cada proceso observable y escribir la proyección
 *                (`ingestion_run`) POR LOTE. Ante fallo por proceso: error registrado, lo último
 *                conocido intacto (la proyección SIRVE lo último conocido).
 *  2 ALERTAR   — la lógica de #104 MOVIDA acá (misma semántica: hidratar estado en el primer tick,
 *                persistir SOLO en transición, parseAlertState fail-safe). Clasifica sobre lo
 *                observado o, si la lectura falló, sobre lo último conocido (no sobre []).
 *  3 RECONCILIAR — reconcilePlan(desired, actual) con DEBOUNCE: no re-empujar el mismo desired al
 *                mismo proceso dentro de la ventana (el motor puede redondear a minutos y no
 *                converger jamás — fabric-engine.ts:37/40-47); un desired que cambia empuja ya.
 *                Tras un set exitoso se RE-OBSERVA el schedule y se registra lo leído, nunca lo
 *                prometido.
 * El render de Frescura lee SOLO la proyección: el request path jamás toca el motor.
 */
import type { LogEventInput } from '@vergis/botler'
import {
  deriveIngestionMap, freshnessAlerts, diffAlertState, parseAlertState, reconcilePlan,
  FRESHNESS_ALERT_STATE_KEY,
  type IngestionEngineClient, type RunRecord, type ProcessRow, type DeriveMapInput,
  type IngestionRunStore, type ProcessObservation, type PlatformSettingStore,
} from '@vergis/capabilities'

export interface FreshnessLoopConfig {
  /** Fase 3 encendida (VERGIS_RECONCILE_AUTO). */
  reconcile: boolean
  /** Ventana de debounce del re-push (VERGIS_RECONCILE_DEBOUNCE_MS). */
  reconcileDebounceMs: number
}

export interface FreshnessLoopDeps {
  engine: IngestionEngineClient
  store: IngestionRunStore & PlatformSettingStore
  /** El MISMO freshnessInputs del wiring (procs + insumo del mapa). */
  inputs: () => Promise<{ procs: ProcessRow[]; mapInput: DeriveMapInput }>
  /** Push de alerta (Slack). undefined = fase 2 apagada (sin webhook): ni computa ni persiste estado. */
  postAlert?: (text: string) => Promise<void>
  audit: (e: LogEventInput) => void
  log: (line: string) => void
  now?: () => number
}

export function createFreshnessLoop(deps: FreshnessLoopDeps, cfg: FreshnessLoopConfig): {
  /** Una vuelta. Re-entrada mientras hay una en vuelo = no-op (guard anti-solape). Nunca lanza. */
  tick(): Promise<void>
}
```

Algoritmo exacto de `tick()` (los tests lo observan):

1. **Guard**: `if (inFlight) return` (con log `frescura-loop: tick saltado (vuelta anterior en vuelo)`); `inFlight = true` / `finally { inFlight = false }`. Todo el cuerpo en `try/catch` con `log` del error (nunca lanza — el timer no debe morir).
2. `const { procs, mapInput } = await deps.inputs()`; `observables = procs.filter((p) => p.engine)`; `nowIso = new Date(now()).toISOString()`.
3. **Fase 1 — observar**: por proceso observable (en `Promise.all`): `runs = await engine.listRunHistory(p.id)` y `sched = await engine.getScheduleSeconds(p.id)`; ambos OK ⇒ `{ processId, observedAt: nowIso, runs, scheduleSeconds: sched }`; cualquiera lanza ⇒ `{ processId, observedAt: nowIso, error: msg }`. Luego `await store.recordObservations(lote)` (una llamada).
4. **Fase 2 — alertar** (solo si `deps.postAlert`): hidratar `alertState` desde `parseAlertState(await store.getSetting(FRESHNESS_ALERT_STATE_KEY))` en el primer tick; `reqOf` desde `deriveIngestionMap(mapInput)`; para cada observable, las corridas de clasificación = las observadas en fase 1 si fue exitosa, o las del snapshot proyectado si falló (D11 — tomar `listRunSnapshots` UNA vez antes de la fase si hubo fallos); `freshnessAlerts` + `diffAlertState`; persistir con `setSetting(…, 'freshness-monitor')` SOLO si cambió; postear notify/recovered con los mismos textos de hoy (`serve-rls.ts:978-979`, copiados tal cual).
5. **Fase 3 — reconciliar** (solo si `cfg.reconcile`): para cada observación EXITOSA cuyo proceso está en el mapa (`reqOf.get(id)` definido): `plan = reconcilePlan(desired, scheduleSeconds)`; si `set` y el debounce lo permite (D10): `await engine.setScheduleSeconds(id, desired)` (catch ⇒ log, sin tumbar la vuelta), registrar `lastPush`, auditar `{ type: 'frescura-reconcile', process: id, by: 'frescura-loop', desiredSeconds: desired, action: 'set' }`, log de la corrección; luego re-observar el schedule (`getScheduleSeconds`, catch ⇒ omitir) y acumular en un segundo lote `recordObservations` (solo `scheduleSeconds`, D5).
6. **Log de cierre**: solo si hubo novedad (errores de observación, pushes, alertas) — el caso sano no loguea por vuelta.

### `server/serve-rls.ts` (TOCAR — wiring)

1. **Reemplazar el bloque del monitor** (`serve-rls.ts:935-987`) por el wiring del lazo (dentro del mismo `if` de administración, tras `freshnessInputs`):

```ts
// Lazo de frescura (#105): observa el motor → proyección local; alerta (#104, movida); reconcilia
// el schedule con debounce. La vista lee SOLO la proyección — el motor nunca en el request path.
const freshnessSlack = process.env['VERGIS_FRESHNESS_SLACK_WEBHOOK'] ?? ''
const freshnessPollMs = Number(process.env['VERGIS_FRESHNESS_POLL_MS'] ?? 300_000)
const reconcileAuto = (process.env['VERGIS_RECONCILE_AUTO'] ?? 'on').toLowerCase() !== 'off'
const reconcileDebounceMs = Number(process.env['VERGIS_RECONCILE_DEBOUNCE_MS'] ?? 21_600_000)
if (fabricWiring.engine && freshnessPollMs > 0) {
  const postSlack = freshnessSlack ? async (text: string): Promise<void> => { …igual que hoy (serve-rls.ts:942-948)… } : undefined
  const loop = createFreshnessLoop(
    { engine: fabricWiring.engine, store: govStore, inputs: freshnessInputs, postAlert: postSlack,
      audit: (e) => auditLog.append(e), log: (l) => console.log(`[vergis-rls] ${l}`) },
    { reconcile: reconcileAuto, reconcileDebounceMs },
  )
  setInterval(() => void loop.tick(), freshnessPollMs).unref?.()
  setTimeout(() => void loop.tick(), 10_000).unref?.() // primer tick tras el bootstrap (patrón purga)
  console.log(`[vergis-rls] lazo de frescura activo (cada ${Math.round(freshnessPollMs / 1000)}s · reconcile ${reconcileAuto ? 'on' : 'off'} · alertas ${freshnessSlack ? 'Slack' : 'off'})`)
}
```

2. **`domainFreshness` deja de tocar el motor** (`serve-rls.ts:1022-1055` se reescribe): mismo filtrado por dominio; luego `const snaps = new Map((await govStore.listRunSnapshots()).map((s) => [s.processId, s]))` y mapeo síncrono:

```ts
return inDomain.map((r) => {
  const proc = r.processId ? procById.get(r.processId) : undefined
  if (!r.processId || !fabricWiring.engine || !proc?.engine) return { ...r, engine: false }
  const s = snaps.get(r.processId)
  const observedAt = s?.observedAt ?? null
  const runs = observedAt ? (s?.runs ?? []) : []
  const health = observedAt && r.requiredCadenceSeconds != null ? classifyProcess(runs, r.requiredCadenceSeconds, Date.now()) : undefined
  const off = freshnessPollMs <= 0
  const stale = off || (observedAt != null && Date.now() - Date.parse(observedAt) > 3 * freshnessPollMs)
  return { ...r, engine: true, engineJobType: proc.engine.jobType, engineItemId: proc.engine.itemId,
    runs, health, actualScheduleSeconds: observedAt ? (s?.scheduleSeconds ?? null) : null,
    projection: { observedAt, stale, lastError: s?.lastError ?? null, off } }
})
```

(`freshnessPollMs`/`reconcileAuto` se declaran ANTES de `createAdmin` para que este closure los vea; el bloque del lazo puede quedar después — solo el `const` debe preceder.)

3. **`applyCadence` gana la re-observación (D5/D12)**: tras `if (plan.action === 'set') await engine.setScheduleSeconds(…)`, agregar:

```ts
if (plan.action === 'set') {
  const re = await engine.getScheduleSeconds(processId).catch(() => undefined)
  if (re !== undefined) await govStore.recordObservations([{ processId, observedAt: new Date().toISOString(), scheduleSeconds: re, runs: [] }])
}
```

(un lote con `runs: []` NO borra corridas: el upsert de runs es aditivo y la poda conserva las 60 más nuevas — con lote vacío de runs solo actualiza el estado. El ejecutor implementa `recordObservations` de modo que `runs: []` exitoso actualice schedule/observed_at sin tocar `ingestion_run`.)

4. **Comentario de cabecera de env** (`serve-rls.ts:20-30` aprox.): documentar `VERGIS_FRESHNESS_POLL_MS` (default 300000; 0 = lazo apagado), `VERGIS_RECONCILE_AUTO` (on/off), `VERGIS_RECONCILE_DEBOUNCE_MS` (default 21600000), y que `VERGIS_FRESHNESS_SLACK_WEBHOOK` gatea SOLO las alertas.

### `server/admin.ts` (TOCAR — tipo + render)

```ts
/** Estado de la proyección de corridas (#105) de la fila. Presente cuando engine=true y hay proyección. */
export interface FreshnessProjectionMeta {
  /** Última observación exitosa del motor (ISO). null = proyección fría. */
  observedAt: string | null
  /** Lo mostrado supera 3× el poll del lazo, o el lazo está apagado. */
  stale: boolean
  /** El intento de refresco más reciente falló (se muestra lo último conocido). */
  lastError: string | null
  /** El lazo está apagado en esta instancia (poll = 0). */
  off: boolean
}
// DomainEntityFreshness:
//   runs?: RunRecord[]                      ← se ELIMINA la variante | 'error' (D8; solo la usaba
//                                             admin.ts:801 — se reescribe; ningún test la asserta)
//   projection?: FreshnessProjectionMeta    ← NUEVO
```

`freshnessHealthCell(r)` (`admin.ts:797-806`) se reescribe con los estados/textos sellados de D8 (usar el `fmtWhen` existente para `observedAt`; el caso sano queda IGUAL que hoy — regresión cero observable en los tests vigentes, cuyas fixtures no traen `projection`). `domainFreshnessPage`: columna schedule con proyección fría ⇒ `—`; botón «Aplicar» solo con `(!r.projection || r.projection.observedAt != null)` además de las condiciones de hoy (`admin.ts:971-974`). La variante `'error'` de slots huérfanos y Cargas (`admin.ts:860-864,992-1004`) NO se toca (D13 — es otro tipo, `CargasOps`/`intakeStatus`).

### `docs/frescura-oferta-demanda.md` (TOCAR — una fila de estado)

Actualizar la tabla «8 · Estado de implementación» (líneas ~96-108): la fila del monitor pasa a describir el lazo (`freshness-loop.ts`: observación → proyección `ingestion_run` + alertas + reconcile con debounce; alertas gated por webhook) y se agrega fila del reconcile periódico. Sin rastros evolutivos: se describe el estado, no la historia.

---

## ¿Qué tareas, con qué territorio y qué «hecho cuando»?

Orden: T1 → T2 → T3 → T4 → T5. T2 depende de T1 (tipos del store). T3 depende de T1+T2. T4 solo de T1 (tipos) y puede correr en paralelo con T3. Toda edición cae DENTRO del territorio de su tarea.

### T1 — Proyección en el GovernanceStore

**Territorio:** tocar `packages/capabilities/src/governance-store.ts`, tocar `packages/capabilities/src/index.ts` (solo exports), tocar `tests/governance-store.test.ts` (agregar casos).
**Hecho cuando:** `npx vitest run tests/governance-store.test.ts` verde, cubriendo como mínimo: lote exitoso puebla snapshot (runs más reciente primero + schedule + observedAt, lastError null); corrida `InProgress` re-observada `Completed` actualiza LA MISMA fila (no duplica); corridas con `startedAt` vacío se ignoran; poda a 60 por proceso (insertar 70 → quedan las 60 más nuevas); observación con `error` conserva runs/schedule previos y llena `lastError`/`lastErrorAt`; observación exitosa posterior limpia `lastError`; lote con `runs: []` exitoso actualiza schedule/observedAt sin tocar corridas; `runsPerProcess` limita; round-trip por archivo (`open(file)` → escribir → `close` → `open(file)` → snapshot intacto — patrón de persistencia ya usado en ese test); proyección fría = proceso ausente del listado.

### T2 — El lazo (`createFreshnessLoop`)

**Territorio:** crear `server/freshness-loop.ts`, crear `tests/freshness-loop.test.ts`.
**Hecho cuando:** `npx vitest run tests/freshness-loop.test.ts` verde. El test usa `SqliteGovernanceStore.open(null)` real + un `IngestionEngineClient` FAKE (in-memory, con corridas/schedules programables y modo «caído» por proceso) + `now` inyectado, y cubre como mínimo:

1. Un tick puebla la proyección (runs + schedule por proceso observable); un segundo tick con corrida nueva la agrega y actualiza la `InProgress` a `Completed`.
2. Motor caído en el tick 2 ⇒ el snapshot conserva lo del tick 1 + `lastError`; **y las alertas no fabrican `missed`** (proceso sano reciente + motor caído ⇒ cero notificaciones — D11).
3. Motor caído Y reloj avanzado más allá de la cadencia ⇒ SÍ notifica `missed` (la edad corre sobre lo proyectado).
4. **El experimento del debounce (Norma 7):** motor fake que redondea a minutos (set 90 → get devuelve 60) ⇒ primer tick empuja UNA vez; ticks siguientes dentro de la ventana NO empujan (contar sets del fake); reloj avanzado más allá de `reconcileDebounceMs` ⇒ empuja de nuevo.
5. Drift convergente (set 7200 → get devuelve 7200) ⇒ un solo set; la vuelta siguiente es `noop` sin intervención del debounce. Tras el set, el schedule proyectado es lo RE-OBSERVADO (60 en el caso del fake redondeador, no 90 — D5).
6. `desired` cambia dentro de la ventana ⇒ empuja de inmediato.
7. `cfg.reconcile: false` ⇒ jamás llama `setScheduleSeconds`.
8. Sin `postAlert` ⇒ no lee ni escribe `freshness.alert_state` (fase 2 apagada), pero proyección y reconcile corren.
9. Semántica #104 preservada: primera transición notifica, repetición no, recuperación notifica; `setSetting` de estado llamado SOLO en transición (contar llamadas); estado hidratado desde el store en el primer tick (sembrar un estado previo y verificar que lo ya-avisado no re-notifica).
10. Guard anti-solape: con un engine cuya promesa se controla a mano, `tick()` re-entrante retorna sin efectos.
11. Un fallo del propio lazo (p. ej. `inputs()` lanza) NO propaga (tick resuelve; log recibido).

### T3 — Wiring de producción

**Territorio:** tocar `server/serve-rls.ts` (reemplazo del bloque monitor 935-987; reescritura de `domainFreshness`; re-observación en `applyCadence`; consts de env; comentario de cabecera), tocar `docs/frescura-oferta-demanda.md` (fila de estado).
**Hecho cuando:** `npm run typecheck` y `npm run build` verdes, y `npx vitest run tests/serve-rls.test.ts tests/acceptance.test.ts` verde (esos tests no cablean Fabric: sin `engine` el lazo no arranca y nada cambia — regresión cero).

### T4 — Render honesto de la proyección

**Territorio:** tocar `server/admin.ts` (`FreshnessProjectionMeta`, `DomainEntityFreshness`, `freshnessHealthCell`, `domainFreshnessPage` — columna schedule y gating del botón), tocar `tests/admin-frescura-routes.test.ts` (agregar casos; los existentes NO se modifican).
**Hecho cuando:** `npx vitest run tests/admin-frescura-routes.test.ts` verde, con casos nuevos que observan el SÍNTOMA en el HTML: fila con `projection` fresca ⇒ sin línea de staleness (idéntica a hoy); `projection.stale: true` ⇒ contiene `datos de` y `el refresco no está corriendo`; `lastError` con datos ⇒ `el último refresco falló`; proyección fría con lazo activo ⇒ `esperando el primer refresco del motor` Y la celda de schedule muestra `—` Y NO aparece el botón «Aplicar» de ese proceso; `off: true` ⇒ `refresco apagado`; fixtures existentes (sin `projection`) siguen pasando sin editar sus asserts.

### T5 — Juez completo

**Hecho cuando:** `npm run typecheck && npm test && npm run build` — los tres verdes, con TODOS los tests nuevos incluidos en `npm test`.

### G-M1 — Gate diferido/manual (motor vivo — NO es de CI; se declara, no bloquea el merge)

Requiere la instancia GH (Fabric vivo; skill `mira-ops`): (1) verificar que el lazo puebla la proyección y que `/admin/dominio/<id>/frescura` carga sin tocar el motor (medir con Fabric lento/caído: la vista sirve lo último conocido con su marca); (2) provocar un drift real de schedule y ver al lazo corregirlo en una vuelta (audit `frescura-reconcile`); (3) confirmar que el caso sano no spamea PATCH (log del lazo callado); (4) validar [Conjetura C1] (5 min de poll vs rate limits) observando errores 429/throttling en el log — si aparece, subir `VERGIS_FRESHNESS_POLL_MS` en la instancia (parámetro, no rediseño).

---

## ¿Qué NO se toca? (reglas duras)

- **`packages/capabilities/src/ingestion-observability.ts` queda EXACTAMENTE igual**: `reconcilePlan`, `classifyProcess`, `freshnessAlerts`, `diffAlertState`, `parseAlertState`, `FRESHNESS_ALERT_STATE_KEY`, `RunRecord` — el lazo las compone, no las modifica.
- **Los tres invariantes de #104 se preservan** al mover el monitor: hidratación en el primer tick, persistencia del estado SOLO en transición, `parseAlertState` fail-safe. Los textos de Slack se copian tal cual (`serve-rls.ts:978-979`).
- **No tocar el territorio de #99**: `run-logs.ts`, `admin-corrida.ts`, `slotRunLogsDir`, la columna `logs:` de procesos (si ya existen al implementar); ni el formato de `startedAt` proyectado (misma cadena del motor — el enlace de #99 casa exacto).
- **No tocar** `fabric-engine.ts`, `intake-onelake.ts`, `intake.ts`, `admin-cargas.ts`, `freshness.ts`, miranda*, notas*, master-data*, `packages/policy`, engines de serving.
- **No crear tablas fuera de `ingestion_run` + `ingestion_process_state`** (espacio de #62 respetado).
- `intakeStatus`/`intakeLog` de slots siguen en vivo (D13) — sus catch y textos actuales intactos (`admin.ts:992-1004,939-953`).
- No modificar tests existentes salvo AGREGAR casos; los asserts vigentes no se reescriben.
- Sin dependencias npm nuevas. UI en español; los textos sellados de D8 se usan tal cual.
- El lazo JAMÁS mantiene vivo el proceso (`unref`) ni revienta el boot: todo su arranque es no-fatal.

## ¿Quién juzga?

`npm run typecheck && npm test && npm run build` — los tres verdes, incluyendo `tests/freshness-loop.test.ts` nuevo y los casos agregados en `tests/governance-store.test.ts` y `tests/admin-frescura-routes.test.ts`. El síntoma (la vista sirve lo último conocido con el motor caído; el schedule converge sin botón; el debounce frena el re-push) lo observan T2/T4 con motor fake; su confirmación contra Fabric vivo es G-M1 (diferido, declarado).

## ¿Qué riesgos quedan y cómo los acota el diseño?

| Riesgo | Acotación |
|---|---|
| Reconcile automático empuja schedules «solos» a producción del motor | Idempotente (`reconcilePlan` noop al converger) + debounce (D10) + audit `frescura-reconcile` por push + apagador `VERGIS_RECONCILE_AUTO=off` + el caso perpetuo (redondeo) acotado a 1 push/6 h y encodado en test (T2-c4). |
| Motor caído leído como «no hay corridas» (falso `missed`, vista vacía) | La proyección sirve lo último conocido con `lastError` y staleness visible (D8); las alertas clasifican sobre lo proyectado (D11); test T2-c2/c3 distingue ambos casos. |
| Datos rancios mostrados como frescos | `stale` sellado (3× poll, o lazo apagado) con texto propio; proyección fría es un estado con sus palabras, nunca «sin corridas» (D8). |
| Crecimiento del archivo SQLite (persist de archivo completo) | Retención 60/proceso podada en la escritura (D3) + escritura por lote, un persist por vuelta (D4). |
| Doble escritor sobre el estado de alertas (¿dos lazos?) | Hay UN solo lazo por proceso server (el bloque monitor se REEMPLAZA, no se suma); guard anti-solape dentro del lazo (T2-c10). |
| Cambio de default (poll on) sorprende a una instancia | Log de arranque explícito con cadencia y fases; `0` apaga; documentado en cabecera de env y en `docs/frescura-oferta-demanda.md` (T3). |
| «Aplicar» manual y lazo pisándose | Ambos convergen al mismo `desired` derivado e idempotente; el manual re-observa y registra (D5/D12); a lo sumo un PATCH redundante. |
| Snapshot de un proceso recién registrado (proyección fría) rompe la vista | Fría es primer estado de todos los procesos: render sellado (`esperando el primer refresco…`, schedule `—`, sin botón) + test T4. |

---

*Diseño: Fable 5 (rol diseñador, ww:wingcoding) · 2026-08-06 · Issue #105 · Toda afirmación de mecanismo está verificada contra el código citado o etiquetada [Conjetura]; el mecanismo del debounce (redondeo no convergente) queda puesto en riesgo por el test T2-c4; los gates que exigen motor vivo están declarados como G-M1.*
