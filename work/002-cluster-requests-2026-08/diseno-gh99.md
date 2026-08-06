# Diseño · Issue #99 — Acceso al log de una corrida de ingestión (fallida y exitosa)

**Rol:** documento de diseño ejecutable (contrato de delegación wingcoding). El ejecutor arranca en frío: todo lo que necesita está aquí o en las rutas exactas citadas. Repo: `/Users/cesar/wworkspace/productos/vergis` (monorepo TypeScript; `packages/capabilities` = librería; `server/` = módulos de `serve-rls`; `tests/` = vitest).

**Issue:** [Gegolabs/vergis#99] — cuando una corrida de ingestión termina (en CUALQUIER desenlace), el producto muestra el estado pero no da acceso al log. El log del éxito importa tanto como el del fallo: `Completed` no garantiza que los datos quedaron bien (caso GH 2026-08-03: SJD verde que escribió de menos; su log de éxito traía el DELETE/INSERT con conteos). Fuera de alcance: consola de logs con búsqueda/filtros/agregación.

---

## ¿Cuál es la realidad del código sobre la que se diseña?

Hechos verificados contra el código (2026-08-06, rama `main` limpia):

1. **Ya existe UN log, pero es mutable y solo de la última conversión.** El proceso de conversión (SJD en Fabric — código de terreno, NO vive en este repo) escribe su propio log en OneLake en `slotLogPath(slot)` — default `Files/code/_ingest_log.txt`, sobreescrito en cada corrida (`packages/capabilities/src/intake.ts:109-112, 257-260`). El producto lo lee con `OneLakeReader.read` (cola ≤ 64 KB — `packages/capabilities/src/intake-onelake.ts:127-136`) y lo muestra en Cargas (`server/admin-cargas.ts:227-229`) y Frescura (`server/admin.ts:939-953`). Sobre ese único archivo se construyeron #55 (mostrarlo), #85 (línea `✖` como titular de falla) y #86 (detección de log añejo por mtime).
2. **El historial de corridas viene de Fabric `jobs/instances`** (`createFabricJobStatus.listInstances`, `packages/capabilities/src/intake-onelake.ts:227-250`), mapeado al tipo agnóstico `RunRecord { startedAt, endedAt?, status, error? }` (`packages/capabilities/src/ingestion-observability.ts:17-23`). **`RunRecord` no tiene id de instancia** — el mapeo descarta cualquier id que el motor devuelva.
3. **Dos superficies listan corridas**, ambas en Administración con gate de dominio (admin ∨ steward, `server/admin.ts:210-221`):
   - **Cargas** (`/admin/dominio/<id>/cargas`, `server/admin-cargas.ts`): timeline con hasta 20 corridas por slot.
   - **Frescura** (`/admin/dominio/<id>/frescura`, `server/admin.ts:912-1025`): por entidad, muestra solo la última corrida (`freshnessHealthCell`, `server/admin.ts:797-806`), vía `DomainEntityFreshness.runs`.
4. **Los procesos registrados en `sources.yaml`** tienen `engine: { workspaceId, itemId, jobType }` (`EngineRef`, `packages/capabilities/src/governance-store.ts:112-119`) pero **NO declaran ningún lakehouse ni ubicación de log**. Los slots sí (target `workspaceId + lakehouseId`).
5. **Solo existe implementación Fabric** de la costura `IngestionEngineClient` (`packages/capabilities/src/fabric-engine.ts`). En instancias ClickHouse no hay run-history: `fabricWiring` requiere `connections` Fabric (`server/serve-rls.ts:804-812`), así que hoy en ClickHouse no se lista ninguna corrida — no hay superficie que enlazar.
6. El wiring completo de Cargas/Frescura vive en `server/serve-rls.ts:804-917` (fabricWiring) y `988-1074` (deps de `createAdmin`).
7. Los tests de estas superficies simulan el handler HTTP completo con `mockReq`/`mockRes` (`tests/admin-cargas.test.ts`, `tests/admin-frescura-routes.test.ts`) — es el patrón a seguir.

Conjeturas etiquetadas (no verificadas contra motor vivo):

- **[Conjetura C1]** La API pública de Fabric para leer el *driver log* crudo de una corrida de SJD/pipeline es incómoda o inexistente para pipelines. No se verificó porque el diseño **no depende de ella** (ver D1).
- **[Conjetura C2]** El patrón de URL del portal Fabric `https://app.fabric.microsoft.com/groups/<workspaceId>` abre el workspace. No verificado contra portal vivo → gate manual (ver D10 y Gate G-M1).
- **[Conjetura C3]** El `startTimeUtc` del job instance de Fabric precede en segundos-minutos al arranque real del script (cola + boot de sesión Spark). Se asume; los márgenes de correlación (D3) lo absorben y el gate manual G-M1 lo mide.

---

## ¿Cuáles son las decisiones de diseño? (selladas, con racional)

**D1 — La fuente del log es el LOG DEL CONTRATO (escrito por el propio proceso en OneLake), no el log crudo del motor.**
Racional: (a) es la vista saneada que pide el issue *por construcción* — el proceso escribe lo que el operador necesita (DELETE/INSERT con conteos, verificación, `✖` de aborto), no cadenas de conexión ni muestras crudas; (b) es agnóstico de motor: cualquier engine cuyo proceso pueda escribir un archivo tiene log, sin depender de APIs de driver-log por motor ([Conjetura C1] queda irrelevante); (c) toda la maquinaria de lectura ya existe (`OneLakeReader`) y el contrato de log ya es una convención viva del producto (#55/#85/#86). El enlace profundo a la consola del motor queda como complemento (D10), nunca como única vía.

**D2 — Del archivo único mutable a un DIRECTORIO de logs por corrida: `_logs/run-<ts>.txt`, aditivo.**
El contrato de ingesta se extiende: al FINAL de cada corrida (éxito, aborto o `✖ ERROR no controlado` — el mismo punto donde hoy escribe `_ingest_log.txt`), el proceso escribe ADEMÁS un archivo inmutable `run-<YYYYMMDDTHHMMSSZ>.txt` (timestamp UTC del arranque del script) en el directorio de logs por corrida. Para slots, ese directorio se deriva del log ya declarado: hermano `_logs/` del `slotLogPath` (default → `Files/code/_logs`). `_ingest_log.txt` y todo lo construido sobre él (#55/#85/#86) **no se toca**: la convención nueva es aditiva y la vieja sigue siendo «el log de la última conversión». Racional: regresión cero mientras el terreno migra; una sola fuente de verdad por corrida sin re-plomería de lo existente.

**D3 — Correlación corrida ↔ archivo por timestamp con ventana sellada; sin depender del id de instancia del motor.**
El nombre del archivo lleva el arranque del script; el `RunRecord` lleva `startedAt`/`endedAt` del motor. Regla (función pura, testeada): un archivo es candidato de una corrida si su timestamp `ts` cumple `ts ≥ startedAt − 120 s` **y** (`endedAt` presente → `ts ≤ endedAt + 300 s`; ausente → `ts ≤ startedAt + 86 400 s`). Entre candidatos gana el de menor `|ts − startedAt|`; empate → el más reciente. Racional: el script arranca DESPUÉS del `startTimeUtc` del instance ([Conjetura C3]: los márgenes absorben skew de reloj y cola) y escribe ANTES de terminar; el id de instancia de Fabric no se necesita (la forma actual del mapeo ya lo descarta — hecho 2 — y depender de él exigiría verificar más superficie de API).

**D4 — Los procesos declaran su ubicación de logs en `sources.yaml` (`logs:`); los slots la derivan de lo ya declarado.**
`ProcessRow` gana `logs?: ProcessLogsRef { lakehouseId; workspaceId?; dir? }` (workspace default = `engine.workspaceId`; dir default = `Files/code/_logs`), persistido en `ingestion_process` con `ensureColumns` (patrón existente, `governance-store.ts:343`). Los slots NO cambian su YAML: su directorio sale de `slotLogPath` (D2); `log: false` ⇒ sin logs por corrida tampoco. Racional: la ubicación es un dato de despliegue del proceso — declararla una vez donde ya se declara el `engine_ref`, con defaults que hacen que el caso típico no escriba nada nuevo.

**D5 — Una superficie: la página de corrida `/admin/dominio/<id>/corrida?slot=<slotId>|proc=<processId>&started=<ISO>`, enlazada desde toda corrida listada.**
Cada fila de conversión del timeline de Cargas y la «Última corrida» de Frescura (incluida la celda de slots huérfanos) enlazan «Ver log» a esa página, que muestra UNA corrida: estado + duración + error del motor + su log (o el estado de ausencia, D7). Racional: el pedido es «desde cada corrida listada, llegar a su log» — un destino único evita duplicar render en dos vistas y mantiene el fuera-de-alcance (no es consola de búsqueda). La ruta calza en el regex de dominio existente (`admin.ts:210`: sección `[a-z]+`), con identificadores por query string (patrón ya usado con `msg`).

**D6 — Authz: el mismo gate de dominio (admin ∨ steward), y la resolución valida PERTENENCIA al dominio.**
La ruta vive dentro del bloque `di` de `admin.ts` (tras `canMng`), y `refOf` devuelve `null` salvo que el slot tenga `slot.domain === domainId` o el proceso pertenezca a una fuente con `source.domain === domainId`. Racional: la consideración de seguridad del issue («se rige por el control de acceso de Administración»); sin la validación de pertenencia, un steward del dominio A leería logs del dominio B fabricando la URL — fail-closed con test negativo.

**D7 — La ausencia de log es un ESTADO, con cinco palabras distintas.**
La página siempre dice algo verdadero y distinto por causa: (1) `sin-convencion` — el slot/proceso no declara ubicación de logs; (2) `motor-fallo` — no se pudo consultar el almacén de logs (listado o lectura lanzó): «reintenta», NUNCA se confunde con «no hay log»; (3) `en-curso` — corrida `InProgress`/`NotStarted` sin archivo aún: «el log se escribe al final»; (4) `purgado` — sin match y la corrida es más vieja que el archivo más antiguo retenido; (5) `sin-log` — sin match dentro de la ventana retenida: «el proceso murió antes de escribir su log, o aún no adopta logs por corrida». Racional: pedido explícito del issue («si el motor no arrancó, no hay log; decirlo con esas palabras») + Norma 7 corolario de instrumentos: distinguir «medí y no hay» de «no pude medir».

**D8 — Retención declarada: 60 corridas, la poda el ESCRITOR; el producto solo lee.**
El contrato manda al proceso conservar los últimos 60 archivos de `_logs/` y podar el resto. El producto NO poda (un GET sin efectos; dos escritores sobre el mismo directorio es una carrera) y declara en la página: «Retención: los logs de las últimas 60 corridas — los poda el propio proceso». El estado `purgado` (D7) se deriva de lo observado (archivo más viejo presente), no de la promesa. Racional: pedido 3 del issue («retención declarada; un enlace a un log purgado es peor que no ofrecerlo») sin darle al producto permisos ni responsabilidades de escritura.

**D9 — Saneo en dos capas y truncado sellado.**
Capa 1: la fuente ES el log del contrato (D1). Capa 2 (defensa en profundidad): `redactSecrets(text)` — función pura que enmascara patrones de secreto obvios (pares `client_secret|password|pwd|accountkey|sharedaccesskey|secret = <valor>` en formato clave=valor o JSON, y tokens con forma JWT `eyJ…`) antes del render. Lectura con la cola de 64 KB que ya impone `OneLakeReader.read`; el render lo muestra completo (≤ 64 KB) en `<pre>` con scroll y aviso «(truncado: se muestra el final)» si `entry.size` supera lo leído. Racional: la consideración del issue sobre ampliar superficie; 64 KB ya es el tope del reader existente — no se inventa otro.

**D10 — Enlace profundo al motor: nivel workspace, marcado como complemento, verificación manual.**
Cuando el ref es Fabric, la página ofrece «Abrir la consola del motor (Fabric) ↗» → `https://app.fabric.microsoft.com/groups/<workspaceId>` ([Conjetura C2]; gate manual G-M1 lo verifica en la instancia GH). Racional: el issue lo pide como complemento; el patrón de URL por-corrida no es derivable sin verificar contra el portal — el nivel workspace es el escalón honesto mientras tanto.

**D11 — Costura engine-agnóstica `RunLogsOps`; ClickHouse queda en ausencia declarada.**
La dependencia de `admin.ts` es una interfaz (`refOf`/`list`/`read`/`runsOf`); la única implementación que se cablea es la de Fabric/OneLake. En instancias ClickHouse hoy no se lista ninguna corrida (hecho 5) — no hay enlace que mostrar; cuando ClickHouse gane run-history deberá traer su `RunLogsOps` o sus corridas enlazarán a la página en estado `sin-convencion`. Racional: no fabricar una implementación para un motor que aún no lista corridas; la costura deja el enchufe listo.

**Cero preguntas abiertas.** Cualquier ambigüedad que el ejecutor detecte se resuelve con el principio: fail-closed visible, aditivo, y sin tocar lo listado en Reglas duras.

---

## ¿Qué contratos y tipos exactos se introducen?

### `packages/capabilities/src/run-logs.ts` (NUEVO — lógica pura)

```ts
/**
 * Logs POR CORRIDA de un proceso de ingestión (issue #99) — lógica PURA.
 *
 * CONTRATO DE INGESTA (lado escritor — código de terreno, p. ej. el SJD de la instancia):
 * al FINAL de cada corrida (éxito, aborto `✖ ABORTADO` o `✖ ERROR no controlado` — el mismo
 * punto donde escribe su `_ingest_log.txt`), el proceso escribe ADEMÁS su log completo, inmutable,
 * en `<dir>/run-<YYYYMMDDTHHMMSSZ>.txt`, donde el timestamp es el ARRANQUE del script en UTC y
 * `<dir>` default es `Files/code/_logs`. RETENCIÓN: el escritor conserva los últimos
 * RUN_LOG_RETENTION archivos y poda el resto — el producto solo LEE (jamás poda: dos escritores
 * sobre el mismo directorio es una carrera).
 *
 * La correlación corrida↔archivo es por timestamp con ventana (no por id de instancia del motor):
 * el script arranca DESPUÉS del startTimeUtc del job instance y escribe ANTES de (o apenas tras)
 * su endTimeUtc — los márgenes absorben cola/boot/skew. [Los márgenes contra motor vivo: gate
 * manual del despliegue; sin confirmar aún.]
 */
import type { OneLakeEntry } from './intake-onelake'
import type { RunRecord } from './ingestion-observability'

/** Directorio default de logs por corrida (relativo al Lakehouse). */
export const RUN_LOG_DIR_DEFAULT = 'Files/code/_logs'
/** Retención que el contrato exige al escritor (archivos). El producto la DECLARA, no la aplica. */
export const RUN_LOG_RETENTION = 60

/** Nombre canónico del log de una corrida arrancada en `startedAtIso` (lado escritor / tests). */
export function runLogFileName(startedAtIso: string): string
// `run-` + ISO compactado a `YYYYMMDDTHHMMSSZ` + `.txt`. Lanza si el ISO no parsea.

/** Epoch ms del timestamp de un nombre `run-YYYYMMDDTHHMMSSZ.txt|.log` (case-insensitive; el
 *  nombre puede venir con path — se toma el basename). null si no sigue la convención. */
export function parseRunLogTimestamp(name: string): number | null

/** Resolución del log de UNA corrida contra el listado del directorio `_logs/`. */
export type RunLogResolution =
  | { kind: 'match'; entry: OneLakeEntry }
  | { kind: 'en-curso' }  // corrida sin endedAt y status InProgress|NotStarted, sin archivo aún
  | { kind: 'purgado' }   // sin match y la corrida es MÁS VIEJA que el archivo más antiguo presente
  | { kind: 'sin-log' }   // sin match dentro de la ventana retenida (murió antes de escribir, o
                          // el proceso aún no adopta el contrato; con dir vacío la página matiza)

/** Ventana sellada (D3): candidato si ts ∈ [startedAt−120 s, endedAt+300 s] (sin endedAt:
 *  [startedAt−120 s, startedAt+86 400 s]). Gana el de menor |ts − startedAt|; empate → más reciente. */
export function resolveRunLog(run: RunRecord, entries: OneLakeEntry[]): RunLogResolution
// Reglas de precedencia internas: si hay match → 'match' SIEMPRE (aunque esté en curso).
// Sin match: (status 'InProgress'|'NotStarted') → 'en-curso';
// si existe algún entry con timestamp parseable y min(ts) > startedAt+300 s → 'purgado';
// resto → 'sin-log'. Entradas sin timestamp parseable o isDirectory se ignoran.

/** Defensa en profundidad (D9): enmascara secretos obvios con `«…redactado…»`.
 *  Patrones (case-insensitive): (client_secret|clientsecret|password|pwd|accountkey|
 *  sharedaccesskey|sas|secret|token)\s*[=:]\s*[^\s;,"']+  y  eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+ */
export function redactSecrets(text: string): string
```

### `packages/capabilities/src/intake.ts` (TOCAR — un helper)

```ts
/** Directorio de logs POR CORRIDA del slot (issue #99): hermano `_logs/` del log declarado.
 *  Default (`Files/code/_ingest_log.txt`) → `Files/code/_logs`. null si `log: false`. */
export const slotRunLogsDir = (slot: IntakeSlot): string | null => {
  const p = slotLogPath(slot)
  if (!p) return null
  return `${p.includes('/') ? p.replace(/\/[^/]*$/, '') : p}/_logs`
}
```

### `packages/capabilities/src/governance-store.ts` (TOCAR)

```ts
/** Dónde escribe un proceso sus logs POR CORRIDA (issue #99). El workspace default es el del engine. */
export interface ProcessLogsRef {
  lakehouseId: string
  workspaceId?: string
  /** Default RUN_LOG_DIR_DEFAULT. */
  dir?: string
}
// ProcessRow gana:  logs?: ProcessLogsRef
// GovernanceSeed.processes[] gana:  logs?: ProcessLogsRef
// upsertProcess(id, label, sourceId, engine?, logs?)  — COALESCE igual que engine (un upsert sin
//   logs NO borra el ref registrado); valida logs.lakehouseId no-vacío (lanza).
// DDL: ensureColumns(db, 'ingestion_process', ['logs_workspace TEXT', 'logs_lakehouse TEXT', 'logs_dir TEXT'])
// listProcesses(): si logs_lakehouse != null → row.logs = { lakehouseId, workspaceId?, dir? }
```

### `packages/capabilities/src/index.ts` (TOCAR — exports)

- Línea 85 (bloque intake): agregar `slotRunLogsDir`.
- Bloque governance (línea 110): agregar `ProcessLogsRef` a los types.
- Nuevo: `export { RUN_LOG_DIR_DEFAULT, RUN_LOG_RETENTION, runLogFileName, parseRunLogTimestamp, resolveRunLog, redactSecrets } from './run-logs'` y `export type { RunLogResolution } from './run-logs'`.

### `server/admin.ts` (TOCAR — dependencia y ruta)

```ts
/** Ubicación resuelta del almacén de logs por corrida (OneLake: filesystem workspace + lakehouse). */
export interface RunLogRef { workspaceId: string; lakehouseId: string; dir: string }

/** Origen de una corrida: slot de ingesta o proceso registrado — SIEMPRE anclado a un dominio. */
export interface RunLogSource { domainId: string; slotId?: string; processId?: string }

// AdminDeps gana:
/** Acceso a los logs POR CORRIDA (issue #99). Opcional: sin él no se ofrecen enlaces «Ver log». */
runLogs?: {
  /** Dónde escribe logs el productor. null = no declara, o el slot/proceso NO pertenece al dominio
   *  (fail-closed: la pertenencia se valida acá, no en la página). */
  refOf(src: RunLogSource): Promise<RunLogRef | null>
  /** Entradas del directorio de logs (no recursivo). `[]` si el dir no existe. Lanza si el motor no responde. */
  list(ref: RunLogRef): Promise<OneLakeEntry[]>
  /** Contenido (cola ≤64 KB), null si el archivo no existe. Lanza si el motor no responde. */
  read(ref: RunLogRef, path: string): Promise<string | null>
  /** Corridas del productor (para ubicar por startedAt la corrida pedida). Lanza si el motor no responde. */
  runsOf(src: RunLogSource): Promise<RunRecord[]>
}
```

Ruta (dentro del bloque `di`, junto a `cargas`/`frescura`, `admin.ts:241-279`):

```ts
// Log de UNA corrida (issue #99): fallida O exitosa — `Completed` no garantiza el dato.
if (section === 'corrida' && deps.runLogs && req.method === 'GET') {
  send(res, 200, await corridaPage(deps, nav, domain, url.searchParams))
  return true
}
```

`corridaPage` (función local en `admin.ts`, patrón `cargasPage`): arma el `CorridaView` y delega el render puro a `admin-corrida.ts`:

1. `slotId = params.get('slot') ?? undefined`, `processId = params.get('proc') ?? undefined`, `started = params.get('started') ?? ''`. Exactamente uno de slot/proc; si no → view con `resolucion: { kind: 'sin-convencion' }` y sin corrida.
2. Título y href de volver: slot → label del slot (de `deps.intakeSlots`, filtrado por `domain.id`) y `/admin/dominio/<id>/cargas`; proceso → `processId` y `/admin/dominio/<id>/frescura`.
3. `runs = await deps.runLogs.runsOf({...}).catch(() => 'error')`; `'error'` → `motor-fallo`. `run = runs.find(r => r.startedAt === started) ?? null` (match EXACTO del ISO que puso el enlace).
4. `ref = await refOf({...})` → null ⇒ `sin-convencion`.
5. `entries = await list(ref)` (catch ⇒ `motor-fallo`). `run == null` ⇒ view sin corrida (la página lo dice: «corrida no encontrada en el historial del motor — el historial retiene pocas corridas»). Si hay run: `res = resolveRunLog(run, entries)`.
6. `kind:'match'` ⇒ `texto = await read(ref, entry.path)` (catch ⇒ `motor-fallo`; null ⇒ degradar a `sin-log`); `truncado = entry.size > texto.length`.
7. Enlace a consola del motor: `https://app.fabric.microsoft.com/groups/${ref.workspaceId}` (D10).

**Enlaces desde Frescura** (mismo archivo): `freshnessHealthCell(r)` (línea 797) gana segundo parámetro opcional `runHref?: (r: DomainEntityFreshness) => string | null`; con href y `runs[0]`, añade ` · <a href="…">Ver log</a>` tras la bandera. `domainFreshnessPage` lo pasa solo si `deps.runLogs && r.processId`: `/admin/dominio/<id>/corrida?proc=<processId>&started=<encodeURIComponent(runs[0].startedAt)>`. Ídem `slotRunLine` (línea 998, slots huérfanos): con `deps.runLogs` y `st[0]`, enlace con `slot=<s.id>`.

### `server/admin-corrida.ts` (NUEVO — render puro, patrón `admin-cargas.ts`)

```ts
/**
 * Página de UNA corrida de ingestión (issue #99) — datos → HTML, PURO.
 * La ausencia de log es un ESTADO, no un vacío: cinco palabras distintas (D7).
 * El log mostrado es el del CONTRATO (lo escribe el propio proceso), pasado por redactSecrets.
 */
import { escapeHtml, redactSecrets, RUN_LOG_RETENTION, type RunRecord } from '@vergis/capabilities'

export type CorridaResolucion =
  | { kind: 'sin-convencion' }
  | { kind: 'motor-fallo'; detalle: string }
  | { kind: 'match'; nombre: string; lastModified: string; texto: string; truncado: boolean }
  | { kind: 'en-curso' }
  | { kind: 'purgado' }
  | { kind: 'sin-log'; dirVacio: boolean }

export interface CorridaView {
  domainId: string
  titulo: string            // label del slot o id del proceso
  volverHref: string        // Cargas o Frescura
  volverLabel: string
  run: RunRecord | null     // null = corrida no hallada en el historial del motor
  resolucion: CorridaResolucion
  consolaMotorHref?: string // D10 (complemento)
}

export function corridaBody(v: CorridaView): string
```

Render (usar helpers locales `badge/when/dur` — copiar el patrón de `admin-cargas.ts:75-98`; los helpers de ese módulo NO se exportan, y el módulo nuevo mantiene los suyos locales por la misma razón anti-ciclo):

- Cabecera: `← volver`, título, línea de corrida (`badge(status) · when(startedAt) · dur`, y `run.error` como detalle `sub`).
- Por `kind` (textos EXACTOS — los tests los observan):
  - `sin-convencion`: «Este origen no declara logs por corrida. Slots: se derivan de su `log:`; procesos: declara `logs:` en `sources.yaml`.»
  - `motor-fallo`: «No se pudo consultar el almacén de logs (el motor no respondió). Esto no significa que el log no exista — reintenta refrescando.» + detalle `sub`.
  - `en-curso`: «La corrida está en curso: el log se escribe al final. Refresca cuando termine.»
  - `purgado`: «El log de esta corrida ya fue purgado por retención.»
  - `sin-log` (`dirVacio: false`): «El proceso no alcanzó a escribir el log de esta corrida (murió antes de escribir, o el motor no llegó a arrancarlo).» / (`dirVacio: true`): agrega «Este proceso aún no escribe logs por corrida (contrato `_logs/`).»
  - `match`: `<pre>` con `escapeHtml(redactSecrets(texto))`, scroll (`max-height:420px;overflow:auto;white-space:pre-wrap`), encabezado `sub` con `nombre · lastModified` y, si `truncado`, «(truncado: se muestra el final)».
- `run == null`: «Corrida no encontrada en el historial del motor (el historial retiene pocas corridas).» y NO se intenta resolver log.
- Pie SIEMPRE: «Retención: los logs de las últimas 60 corridas — los poda el propio proceso.» (usar `RUN_LOG_RETENTION`, no el literal) + enlace consola motor si viene.

### `server/admin-cargas.ts` (TOCAR — enlaces)

- `timeline(history, runs, limit, diagnostico, runLogHrefOf?)`: quinto parámetro opcional `runLogHrefOf?: (r: RunRecord) => string | null`. En las filas de Conversión, si devuelve href: ` <a class="sub" href="…">Ver log</a>` en la celda de detalle. Firmas existentes intactas (parámetro opcional al final: los tests actuales compilan sin cambio).
- `cargasBody(domainId, domainLabel, slots, token, uploadFormOf, runLogHrefOf?)`: sexto parámetro opcional `runLogHrefOf?: (slot: IntakeSlot, r: RunRecord) => string | null`; se lo pasa parcializado al `timeline` de cada slot y añade el mismo enlace en la línea «Última conversión» (junto a `estado`).
- `cargasPage` (`admin.ts:851-869`) lo provee solo si `deps.runLogs`: `(slot, r) => '/admin/dominio/' + domain.id + '/corrida?slot=' + encodeURIComponent(slot.id) + '&started=' + encodeURIComponent(r.startedAt)`.

### `server/serve-rls.ts` (TOCAR — wiring y parse)

1. Parse de `sources.yaml` (línea 768-775): el shape de `processes` gana `logs?: { lakehouseId: string; workspaceId?: string; dir?: string }`; pasa al seed (`SqliteGovernanceStore.open`) tal cual.
2. `fabricWiring` (línea 804): el objeto devuelto gana `runLogs?: AdminDeps['runLogs']`, construido con `reader`, `jobStatus`, `engine`, `govStore`, `intakeSlots` (todo ya en scope):

```ts
runLogs: {
  refOf: async ({ domainId, slotId, processId }) => {
    if (slotId) {
      const slot = intakeSlots.find((s) => s.id === slotId && (s.domain ?? '') === domainId)
      const dir = slot ? slotRunLogsDir(slot) : null
      return slot && dir ? { workspaceId: slot.target.workspaceId, lakehouseId: slot.target.lakehouseId, dir } : null
    }
    if (processId) {
      const [procs, sources] = await Promise.all([govStore.listProcesses(), govStore.listSources()])
      const p = procs.find((x) => x.id === processId)
      if (!p?.logs || sources.find((s) => s.id === p.sourceId)?.domain !== domainId) return null
      const workspaceId = p.logs.workspaceId ?? p.engine?.workspaceId
      return workspaceId ? { workspaceId, lakehouseId: p.logs.lakehouseId, dir: p.logs.dir ?? RUN_LOG_DIR_DEFAULT } : null
    }
    return null
  },
  list: (ref) => reader.list({ workspaceId: ref.workspaceId, lakehouseId: ref.lakehouseId }, ref.dir),
  read: (ref, path) => reader.read({ workspaceId: ref.workspaceId, lakehouseId: ref.lakehouseId }, path),
  runsOf: async ({ slotId, processId, domainId }) => {
    if (slotId) {
      const slot = intakeSlots.find((s) => s.id === slotId && (s.domain ?? '') === domainId)
      return slot?.trigger ? jobStatus.listInstances(slot.trigger.workspaceId ?? slot.target.workspaceId, slot.trigger.processRef, 20) : []
    }
    return processId ? engine.listRunHistory(processId) : []
  },
},
```

3. `createAdmin({...})` (línea 988): `runLogs: fabricWiring.runLogs`.

---

## ¿Cómo se declara en la instancia? (referencia para el ejecutor y el terreno)

```yaml
# sources.yaml — proceso agendado (sin slot) que ahora declara dónde deja sus logs por corrida
processes:
  - id: p_finanzas
    label: Ingesta Finanzas
    sourceId: sap
    engine: { workspaceId: WS-GUID, itemId: SJD-GUID, jobType: sparkjob }
    logs: { lakehouseId: LH-GUID }        # dir default Files/code/_logs; workspace default = engine
```

Los slots no cambian: `_logs/` se deriva del `log:` ya declarado (D2/D4).

---

## ¿Qué tareas, con qué territorio y qué «hecho cuando»?

Orden de ejecución: T1 → T2 → T3 → T4 → T5 → T6 → T7. Toda edición cae DENTRO del territorio listado de su tarea; nada fuera.

### T1 — Lógica pura de logs por corrida

**Territorio:** crear `packages/capabilities/src/run-logs.ts`, crear `tests/run-logs.test.ts`, tocar `packages/capabilities/src/index.ts` (solo exports).
**Contenido:** los tipos/funciones de la sección de contratos, con las reglas selladas de D3/D7/D9 (márgenes −120 s/+300 s/+86 400 s; precedencias; regex de redacción).
**Hecho cuando:** `npx vitest run tests/run-logs.test.ts` verde, cubriendo como mínimo: roundtrip `runLogFileName`↔`parseRunLogTimestamp` (y basename con path, `.log`, case); match exacto y en el borde de la ventana; dos archivos candidatos → gana el más cercano al arranque; dos corridas contiguas → cada una resuelve su propio archivo (la ambigüedad no cruza); `en-curso`; `purgado` (corrida más vieja que el archivo más antiguo); `sin-log`; `redactSecrets` enmascara `client_secret=…`, `Password: …`, un JWT `eyJ…`, y NO toca conteos normales («INSERT 7626 filas» queda intacto).

### T2 — Helper del slot

**Territorio:** tocar `packages/capabilities/src/intake.ts` (agregar `slotRunLogsDir` junto a `slotLogPath`, línea ~260), tocar `tests/intake.test.ts` (agregar casos).
**Hecho cuando:** `npx vitest run tests/intake.test.ts` verde, con casos: default → `Files/code/_logs`; `log: Files/x/mi.log` → `Files/x/_logs`; `log: false` → null.

### T3 — Persistencia del `logs:` del proceso

**Territorio:** tocar `packages/capabilities/src/governance-store.ts` (`ProcessLogsRef`, `GovernanceSeed`, `upsertProcess` — firma con 5.º parámetro opcional y COALESCE, `ensureColumns`, `listProcesses`, y el loop de semilla de `processes` en `open()` pasa `p.logs`), tocar `tests/governance-store.test.ts`.
**Hecho cuando:** `npx vitest run tests/governance-store.test.ts` verde, con casos: upsert con `logs` → `listProcesses()` lo devuelve (con defaults ausentes tal cual, sin inventar dir); upsert posterior SIN `logs` no lo borra; `logs` sin `lakehouseId` lanza; seed por `GovernanceSeed.processes[].logs` persiste.

### T4 — Página de corrida (la superficie del síntoma)

**Territorio:** crear `server/admin-corrida.ts`, crear `tests/admin-corrida.test.ts`, tocar `server/admin.ts` (interface `runLogs` + `RunLogRef`/`RunLogSource`, ruta `corrida`, función `corridaPage`).
**Hecho cuando:** `npx vitest run tests/admin-corrida.test.ts` verde. El test monta `createAdmin` con `runLogs` mockeado (patrón `tests/admin-cargas.test.ts`: `mockReq`/`mockRes`) y observa el SÍNTOMA en el HTML devuelto por GET:
- **Éxito con log:** corrida `Completed` cuyo log contiene `DELETE fct_saldos WHERE semana='W28': 7580 filas` y `INSERT: 7626 filas` → la página los muestra (el usuario LEE los conteos del éxito — el caso GH del issue).
- **Falla con log:** corrida `Failed` con `✖ ABORTADO: archivo sin filas de datos` en el log → visible en la página.
- **Redacción:** un log con `client_secret=abc123` NO expone `abc123` (aparece `redactado`).
- Los cinco estados de D7, cada uno con su texto distintivo (asserts sobre las frases selladas).
- `runsOf` o `list` que lanzan → texto de `motor-fallo` (y NUNCA el de `sin-log`).
- Authz: usuario no-steward → 403; steward del dominio → 200; `refOf` que devuelve null por pertenencia → página en `sin-convencion` (nunca el log de otro dominio).
- Retención declarada presente («las últimas 60 corridas»).

### T5 — Enlaces desde Cargas y Frescura

**Territorio:** tocar `server/admin-cargas.ts` (params opcionales de `timeline`/`cargasBody`), tocar `server/admin.ts` (`cargasPage` pasa `runLogHrefOf`; `freshnessHealthCell` + `domainFreshnessPage` + `slotRunLine`), tocar `tests/admin-cargas.test.ts` y `tests/admin-frescura-routes.test.ts` (agregar casos; los existentes NO se modifican — regresión cero).
**Hecho cuando:** `npx vitest run tests/admin-cargas.test.ts tests/admin-frescura-routes.test.ts` verde, con casos nuevos: con `runLogs` presente, el GET de Cargas contiene `href="/admin/dominio/cartera/corrida?slot=saldos&amp;started=` (o su encoding real) en las filas de conversión Y en «Última conversión»; el GET de Frescura contiene `corrida?proc=p_sap&amp;started=`; SIN `runLogs`, ninguna página contiene `"/corrida?"` (regresión cero observable).

### T6 — Wiring de producción

**Territorio:** tocar `server/serve-rls.ts` (parse de `logs:` en sources.yaml; `runLogs` en `fabricWiring`; pasar `runLogs` a `createAdmin`). Imports nuevos desde `@vergis/capabilities`: `slotRunLogsDir`, `RUN_LOG_DIR_DEFAULT`.
**Hecho cuando:** `npm run typecheck` y `npm run build` verdes, y `npx vitest run tests/serve-rls.test.ts tests/acceptance.test.ts` verde (sin regresión: esos tests no cablean Fabric, `runLogs` queda undefined y nada cambia).

### T7 — Juez completo

**Hecho cuando:** `npm run typecheck && npm test && npm run build` — los tres verdes, con TODOS los tests nuevos incluidos en `npm test`.

### G-M1 — Gate diferido/manual (motor vivo — NO es de CI; se declara, no bloquea el merge)

Requiere la instancia GH (Fabric vivo) y trabajo de TERRENO fuera de este repo (skill `mira-ops`): (1) el SJD de la instancia adopta el contrato escritor de `run-logs.ts` (escribir `run-<ts>.txt` + poda a 60); (2) `sources.yaml` de la instancia declara `logs:` en sus procesos; (3) verificación del síntoma real: abrir `/admin/dominio/<id>/corrida?...` desde una corrida exitosa y LEER el DELETE/INSERT con conteos; ídem desde una fallida y leer el `✖`; (4) medir los márgenes de D3 contra corridas reales ([Conjetura C3]) y (5) verificar el enlace del portal ([Conjetura C2]). Si (4) refuta los márgenes, se ajustan las constantes en `run-logs.ts` con el dato medido — son un parámetro sellado por diseño, no por medición todavía.

---

## ¿Qué NO se toca? (reglas duras)

- **NADA de `_ingest_log.txt`**: `slotLogPath`, `DEFAULT_INGEST_LOG`, `diagnosticoDeFalla`, `LOG_ANEJO_TITULAR`, la sección «Log de la última conversión» y su mecánica #55/#85/#86. La convención nueva es aditiva (D2).
- **Sin escrituras a OneLake desde el producto** en este frente: `runLogs` es solo lectura (`list`/`read`). El producto no poda, no crea, no mueve archivos de `_logs/` (D8).
- **Sin dependencias nuevas de producción** (ADR-001; política supply-chain). Nada de npm install.
- No tocar: `packages/policy`, `server/engines/fabric.ts` (motor C), `server/engines/clickhouse.ts`, `packages/capabilities/src/execute-sql-dwh.ts`, `execute-sql-ch.ts`, `fabric-engine.ts`, `ingestion-observability.ts` (`RunRecord` queda EXACTAMENTE igual — la correlación no necesita id, D3), miranda*, notas*, master-data*.
- No modificar tests existentes salvo AGREGAR casos (T5); los asserts vigentes no se reescriben.
- UI en español; los textos sellados de D7 se usan tal cual (los tests los observan).
- La ruta nueva vive DENTRO del gate de dominio existente; ningún camino responde contenido de log antes de `canMng` (D6).

## ¿Quién juzga?

`npm run typecheck && npm test && npm run build` — los tres verdes, incluyendo `tests/run-logs.test.ts` y `tests/admin-corrida.test.ts` nuevos y los casos agregados en `tests/intake.test.ts`, `tests/governance-store.test.ts`, `tests/admin-cargas.test.ts`, `tests/admin-frescura-routes.test.ts`. El síntoma (el usuario VE el log de una corrida exitosa y de una fallida desde el producto) lo observan los tests de T4/T5 a nivel de handler HTTP; su confirmación contra motor vivo es G-M1 (diferido, declarado).

## ¿Qué riesgos quedan y cómo los acota el diseño?

| Riesgo | Acotación |
|---|---|
| Correlación errónea: mostrar el log de OTRA corrida como si fuera esta | Ventana sellada + «más cercano al arranque» (D3), test de ambigüedad con corridas contiguas (T1), y la página muestra nombre + mtime del archivo — el operador puede cotejar. G-M1 mide los márgenes reales. |
| Terreno no migrado (SJD aún no escribe `_logs/`) | Estados honestos (`sin-log` con matiz de dir vacío, D7); cero regresión en las superficies existentes (regla dura + asserts de T5). |
| Log con secretos ampliando superficie | Doble capa D9: la fuente es el log del contrato (no el driver-log), + `redactSecrets` testeado. Authz D6 con test negativo cross-dominio. |
| Motor caído leído como «no hay log» | `motor-fallo` es un estado propio, con texto que dice «no significa que no exista» (D7); test que lo distingue de `sin-log` (T4). El instrumento sabe reportar su propio fallo. |
| Enlace roto a log purgado (lo que el issue llama «peor que no ofrecerlo») | El enlace lleva a la PÁGINA, no al archivo: la página resuelve y declara `purgado`. Nunca hay un href a un blob que puede no estar. |
| Payload grande en la página | Cola de 64 KB del reader existente + `<pre>` con scroll + aviso de truncado (D9). |
| URL del portal Fabric incorrecta ([C2]) | Marcada complemento, gate manual G-M1; un enlace workspace-level errado no bloquea el camino principal (el log en el producto). |

---

*Diseño: Fable 5 (rol diseñador, ww:wingcoding) · 2026-08-06 · Issue #99 · Toda afirmación de mecanismo está verificada contra el código citado o etiquetada [Conjetura]; los gates que exigen motor vivo están declarados como G-M1.*
