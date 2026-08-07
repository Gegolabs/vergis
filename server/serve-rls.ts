/**
 * Servidor RLS de Vergis — MULTI-PI por nodo, render POR CONSUMIDOR (charter §2a), con SELECTOR DE
 * CONECTOR (motor B ClickHouse | motor C Fabric push-down).
 *
 * Un nodo hospeda N Productos de Información (ruteados por `/<slug>`, índice en `/`). La autorización
 * vive ATADA AL DATO (policy store, autoría por entidad — charter §2c), no en los PIs, que son
 * AUTHZ-BLIND. El consumidor autentica una vez (gate); sus claims se inyectan en cada query; ve solo
 * su porción. Default-deny: dato sin política no se sirve.
 *
 * La LÓGICA DE NEGOCIO es agnóstica del motor; el motor es un CONECTOR (la Capability de query):
 *  - VERGIS_ENGINE=clickhouse (default): motor B. La fuente NO tiene RLS → se replica a un store
 *    ClickHouse (caja negra desechable) que el compilador gobierna con ROW POLICY; serve por
 *    `execute-sql-ch`. Requiere bootstrap + ingesta desde fuente.
 *  - VERGIS_ENGINE=fabric: motor C (push-down). La fuente (Fabric/Azure SQL) YA tiene la RLS nativa
 *    aplicada (SECURITY POLICY, fuera de banda) → NO se replica: serve por `execute-sql-dwh`
 *    enforcing (inyecta los claims con sp_set_session_context). Fail-closed: al arrancar verifica
 *    que cada tabla gobernada tenga RLS nativa habilitada; si falta, NO sirve.
 *
 * Lo elige la imagen con VERGIS_RLS=1 (Dockerfile). Config por entorno:
 *  - VERGIS_ENGINE      clickhouse (default) | fabric
 *  - VERGIS_SPECS_DIR / VERGIS_SPECS / VERGIS_SPEC   specs authz-blind (descubrimiento dinámico)
 *  - VERGIS_POLICIES    policy store (entidad-canónica o legacy por-tabla): política → dataset
 *  - VERGIS_CONNECTIONS perfiles SQL (Service Principal) — requerido en fabric; ingesta en clickhouse
 *  - [clickhouse] VERGIS_DATASETS · VERGIS_CH_URL · VERGIS_CH_ADMIN_USER/_PASS · VERGIS_CH_CONSUMER_USER · VERGIS_CH_TARGET_ROLE · VERGIS_REFRESH_MS
 *  - PORT
 *  - HOST                interfaz de escucha (opcional). Sin él, TODAS las interfaces (lo que el
 *                        contenedor necesita); con `HOST=127.0.0.1`, localhost-only (arnés de dev).
 *
 * Lazo de frescura (issue #105) — observa el motor, proyecta lo observado en el store de gobierno,
 * alerta y reconcilia el schedule. La vista de Frescura lee SOLO la proyección:
 *  - VERGIS_FRESHNESS_POLL_MS       cadencia del lazo (default 300000 = 5 min; `0` lo apaga). Solo
 *                                   arranca si hay motor cableado.
 *  - VERGIS_RECONCILE_AUTO          `off` apaga la corrección automática del schedule (default on).
 *  - VERGIS_RECONCILE_DEBOUNCE_MS   ventana de re-push del mismo desired (default 21600000 = 6 h).
 *
 * Avisos salientes (issue #100) y reporte periódico (issue #102) — el destino es declarativo, el
 * producto no conoce el canal:
 *  - VERGIS_NOTIFY      ruta al YAML de destinos (`slack-webhook` | `webhook` | `email-smtp` —el
 *                       relay de la instancia—, N simultáneos). Cada destino declara `events`
 *                       (`alerts` | `reports`; default `[alerts]`), y el bloque `report:` (hora,
 *                       timezone, cadencia) enciende el reporte periódico INCONDICIONAL: se envía
 *                       siempre, con novedades o sin ellas. Sin el env, avisos apagados y sin
 *                       reporte: observación y reconcile corren igual (la proyección es la memoria
 *                       del producto).
 *  - VERGIS_PUBLIC_URL  URL pública de la instancia, base de los enlaces profundos del aviso.
 *                       REQUERIDA si hay destinos declarados (si no, el arranque LANZA).
 */
import { createServer } from 'node:http'
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// `watchPaths` ya no se llama directo: TODO watch pasa por `contract.watch` (instala + registra en una
// sola llamada — ver server/contract.ts), que es quien lo invoca.
import { swapRecordInPlace, reloadLiveList } from './hot-reload'
import { loadInstanceConfig } from './instance-config'
import { type NavQuery } from './nav'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { runSpec } from '@vergis/cli'
import { AppendOnlyLog, withResultCache, type Capability, type GateHeaders, type IdentityContext, type LogEventInput } from '@vergis/botler'
import { applyCtx, parseSpec as parseMiraSpec, validateSpec as validateMiraSpec, type MiraSpec, type ResolverComentarios } from '@vergis/mira'
import { createMiranda, type MirandaServerDeps } from './miranda'
import { fetchAnthropicTransport, buildSystemPrompt, type CatalogEntry, type SpecRef } from '@vergis/miranda'
import {
  bootstrapClickHouse,
  createIngestClickHouse,
  createExecuteSqlClickHouse,
  createExecuteSqlDwh,
  renderHtmlPiece,
  renderCsvPiece,
  publicarArtefacto,
  requireRootKey,
  parseDomainsConfig,
  manageableDomains,
  parseIntakeConfig,
  credentialProviderFor,
  createOneLakeIntake,
  createOneLakeReader,
  slotLogPath,
  slotRunLogsDir,
  RUN_LOG_DIR_DEFAULT,
  isSidecarName,
  createFabricJobs,
  createFabricJobStatus,
  createFabricEngineClient,
  SqliteMasterDataStore,
  createDwhMasterDataStore,
  createDwhPublisher,
  SqliteGovernanceStore,
  openNotasStore,
  llaveDeFila,
  canonicalKey,
  canOpen,
  deriveIngestionMap,
  deriveEntityFreshness,
  classifyProcess,
  reconcilePlan,
  createAsOfProvider,
  deriveRevertPlan,
  executeRevertPlan,
  type RevertRef,
  type PiAsOf,
  type GroupSeed,
  type DomainDecl,
  type IntakeSlot,
  type RunRecord,
  type ProcessRow,
  type SourceRow,
  type EntityFreshnessRow,
  type ProcessHealth,
  type IngestionEngineClient,
  type MasterDataEntity,
  type PiRole,
  type NotasStore,
  type NotasRenderContext,
  type SqlConnectionProfile,
} from '@vergis/capabilities'
import { createAdmin, dupLabel, type AdminHandler, type IntakeRunner, type RunLogsOps } from './admin'
import { createFreshnessLoop } from './freshness-loop'
import { createSinks, fanout, forEvent, type Notification } from './notify'
import { createReportLoop, REPORT_CHECK_MS } from './report'
import type { CargasOps, IntakeUploadEvent } from './admin-cargas'
import { computeBound, unionInjections, type DatasetCfg, type BoundDataset } from './engines/clickhouse'
import { verifyFabricServability, SYS_SECURITY_POLICIES_SQL, SYS_VIEW_LINEAGE_SQL, type PiVerdict } from './engines/fabric'
import { fail } from './http-util'
import { createRequestHandler } from './routes'
import { createPdfClient, pdfFilename } from './pdf'
import { createDiscovery, type Report } from './discovery'
import { createIdentity } from './identity'
import { configFromEnv, configEnvKeys, decideDevIdentity, decideFreshStore, deprecatedEnvWarnings } from './config'
import { createContractRegistry, createContractHandler } from './contract'
import { avatarMenu, csrfFactory } from './ui'
import { indexHtml as renderCatalog } from './catalog'
import { createPiConfig, type PiConfigHandler } from './pi-config'
import { createNotas, sinDrills, type CongeladoPi, type NotasHandler } from './notas'
import { purgarRetencion, PURGA_INTERVALO_MS } from './notas-settings'
import type { MirandaHandler } from './miranda'
import { checkDeploymentConfig, reportDeploymentConfig, configCheckMode } from './deployment-check'
import {
  isPublic,
  parsePolicyStore,
  settingForClaim,
  type Policy,
  type PolicyDecl,
  type PolicyStoreDoc,
} from '@vergis/policy'

const ENGINE = (process.env['VERGIS_ENGINE'] ?? 'clickhouse').toLowerCase()
if (ENGINE !== 'clickhouse' && ENGINE !== 'fabric') throw new Error(`VERGIS_ENGINE inválido: '${ENGINE}' (clickhouse | fabric).`)
// Config VALIDADA de los env numéricos (lanza claro al arranque si PORT/REFRESH/TTL/MAX_ROWS no son
// números — antes `PORT=abc` daba `listen(NaN)` tarde y feo). El secreto CSRF se maneja aparte.
const config = configFromEnv(process.env, () => '')
// Envs retirados que siguen en despliegues vivos: se avisan y se ignoran (nunca se imprime su valor).
for (const w of deprecatedEnvWarnings(process.env)) console.warn(`[vergis-rls] ${w}`)
const PORT = config.port
// Interfaz de escucha: sin `HOST`, Node escucha en TODAS (lo que el contenedor necesita). Con `HOST`
// (p. ej. 127.0.0.1) el proceso queda atado a esa interfaz — el arnés de dev, localhost-only.
const HOST = config.host
const REFRESH_MS = config.refreshMs

// --- CONTRATO OPERATIVO consultable (`/contrato`, issue #139) ----------------
// Registro DERIVADO del estado vivo del proceso: los watches se instalan CON `contract.watch` (registrar
// y vigilar en una sola llamada — imposible que driften), las envs de arranque se leen CON `contract.env`,
// las recargas se anotan donde ocurren y los caveats viven colocados en el sitio que los posee. Nada de
// esto es un arreglo que alguien mantenga a mano. El registro JAMÁS afecta el serving (ver contract.ts).
const HOT_RELOAD = (process.env['VERGIS_HOT_RELOAD'] ?? '1') !== '0'
const contract = createContractRegistry({ engine: ENGINE, hotReload: HOT_RELOAD })
contract.envKeys(configEnvKeys())
/** `process.env` que REGISTRA cada acceso en el contrato — para los módulos que reciben el env entero
 *  y leen dentro (instance-config resuelve nombres dinámicamente: declararlos acá sería declararlos). */
const contractEnv: NodeJS.ProcessEnv = new Proxy(process.env, {
  get(target, prop, receiver) {
    if (typeof prop === 'string') contract.env(prop)
    return Reflect.get(target, prop, receiver)
  },
})

// Auto-chequeo de coherencia del despliegue (contrato Producto→Infra). Corre ANTES de leer specs,
// políticas o config de gobierno: si un env referencia un path no montado, o el gobierno se pide con
// un store efímero, se avisa RUIDOSAMENTE (y en modo strict se aborta) en vez de degradar en silencio
// —el modo de falla del incidente del avatar (2026-07)—. Ver deploy/compose.reference.yml.
reportDeploymentConfig(checkDeploymentConfig(process.env), configCheckMode(process.env))

// DEV IDENTITY (fail-safe) — aviso prominente al arranque. La decisión ya la tomó `decideDevIdentity`
// (jamás activa con gate real); acá solo se comunica. `active` en producción es imposible por diseño.
const devDecision = decideDevIdentity(process.env)
if (devDecision.mode === 'active') {
  console.warn(`⚠ DEV IDENTITY ACTIVA (${devDecision.identity.user}) — NO USAR EN PRODUCCIÓN`)
} else if (devDecision.mode === 'ignored-gate') {
  console.warn('VERGIS_DEV_IDENTITY ignorado: hay gate real (VERGIS_GATE_SECRET presente).')
} else if (devDecision.mode === 'invalid') {
  console.warn(`VERGIS_DEV_IDENTITY ignorado: valor inválido ('${devDecision.raw}') — usa 'email' o 'email:grupo1,grupo2'.`)
}

// El catálogo de serving (hardening, charter §2b): SOLO la Capability enforcing del motor activo.
// En fabric, `execute-sql-dwh` es enforcing PORQUE hay push-down (la RLS vive en la fuente).
const SERVING_CAPS = new Set([ENGINE === 'fabric' ? 'execute-sql-dwh' : 'execute-sql-ch'])

// --- Policy store (data-anchored, autoría por entidad — charter §2c) --------
const store = new Map<string, PolicyDecl>()
const POLICY_PATHS = (process.env['VERGIS_POLICIES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
/** Carga (o recarga) las políticas de `POLICY_PATHS` dentro de `target`. Lanza si algún archivo no parsea. */
function loadPolicyStoreInto(target: Map<string, PolicyDecl>): void {
  for (const p of POLICY_PATHS) {
    for (const [ds, pol] of parsePolicyStore(parseYaml(readFileSync(resolve(p), 'utf8')) as PolicyStoreDoc)) target.set(ds, pol)
  }
}
loadPolicyStoreInto(store)

// --- Productos de Información (specs authz-blind, ruteados por slug) ---------
// DESCUBRIMIENTO DINÁMICO re-escaneado por request. Solo specs SERVIBLES (todas sus data-capabilities
// en el catálogo de serving del motor activo) — los demás se omiten (no-bypass).
const SPECS_DIR = process.env['VERGIS_SPECS_DIR']
const SPECS_LIST = (process.env['VERGIS_SPECS'] ?? process.env['VERGIS_SPEC'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
if (!SPECS_DIR && SPECS_LIST.length === 0) throw new Error('Falta VERGIS_SPECS_DIR o VERGIS_SPECS.')
function specPaths(): string[] {
  if (SPECS_DIR) return readdirSync(resolve(SPECS_DIR)).filter((f) => !f.startsWith('.') && /\.ya?ml$/.test(f)).map((f) => join(resolve(SPECS_DIR), f)).sort()
  return SPECS_LIST.map((p) => resolve(p))
}
// Linaje vista→base observado en la fuente (issue #54) — referencia VIVA: la verificación del
// bootstrap la re-puebla; `canAccess` hereda por acá la política de las bases de una vista-contrato.
const viewLineage = new Map<string, string[]>()
// Descubrimiento (memoizado) + gate de gobernanza fail-closed: extraído y testeado en ./discovery.
// `discovery.rebuild()` (validate-before-swap) lo fuerza tras un hot-reload de gobierno.
const discovery = createDiscovery({ store, engine: ENGINE as 'clickhouse' | 'fabric', servingCaps: SERVING_CAPS, specPaths, resolveBases: (t) => viewLineage.get(t) })
const discover = discovery.discover
const visibleFor = discovery.visibleFor

// --- Setup del CONECTOR según el motor --------------------------------------
// VERGIS_CONNECTIONS acepta JSON inline (compat) o una RUTA a un archivo JSON (issue #50). El archivo
// es preferible: los perfiles llevan secretos y un env es legible en /proc y `docker inspect`; un
// archivo montado con permisos restrictivos no — y además habilita el hot-reload (abajo).
const CONNECTIONS_RAW = (process.env['VERGIS_CONNECTIONS'] ?? '').trim()
const CONNECTIONS_FILE = CONNECTIONS_RAW && !CONNECTIONS_RAW.startsWith('{') ? resolve(CONNECTIONS_RAW) : null
function parseConnections(): Record<string, SqlConnectionProfile> | null {
  if (!CONNECTIONS_RAW) return null
  const text = CONNECTIONS_FILE ? readFileSync(CONNECTIONS_FILE, 'utf8') : CONNECTIONS_RAW
  const parsed = JSON.parse(text) as Record<string, SqlConnectionProfile>
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('VERGIS_CONNECTIONS debe ser un objeto { database_ref: perfil }.')
  // Fail-closed EAGER (issue #66): un perfil cuya credencial no resuelve (modo desconocido, campo
  // faltante) revienta acá — en el arranque en frío aborta el proceso con el ref y el campo por
  // nombre; en hot-reload cae en el try/catch del watcher y el swap no ocurre (la config vigente
  // sigue viva). No hace red ni disco: solo valida la forma de la credencial.
  for (const [ref, p] of Object.entries(parsed)) credentialProviderFor(p, { label: `database_ref '${ref}'` })
  return parsed
}
// Referencia VIVA (mismo patrón que el policy store): el hot-reload muta este objeto IN-PLACE y todos
// los consumidores (conector, publisher, master-data) resuelven el perfil por database_ref a call-time.
const connections = parseConnections()
// CAVEAT colocado (no derivable) — el swap del perfil es in-place, pero un pool ya conectado no lo ve.
// Se registra ACÁ (y no dentro de `reloadDomainGovernance`) porque el operador pregunta ANTES de recargar:
// un caveat que solo aparece tras la primera recarga no responde la pregunta que motiva el contrato.
if (CONNECTIONS_FILE) {
  contract.caveat(
    'un pool SQL ya abierto conserva las credenciales previas hasta reciclarse: un perfil de conexión ' +
      'cambiado en caliente aplica a conexiones FUTURAS (las vivas siguen con el perfil anterior).',
  )
}

// `ready` es SOLO el gate del arranque en frío (nada evaluado aún). Después, la servibilidad es
// POR PI (issue #52): `piState` guarda el veredicto por slug (engine=fabric); en clickhouse la
// réplica es una sola y el estado sigue siendo global.
let ready = false
let lastErr: string | null = null
const piState = new Map<string, PiVerdict>()
let servingCap: Capability // la Capability de query enforcing (el conector)
let bootstrapAll: () => Promise<void>

if (ENGINE === 'clickhouse') {
  // --- Motor B: replica gobernada en ClickHouse (bootstrap + ingesta + ROW POLICY) ---
  const CH_URL = contract.env('VERGIS_CH_URL') ?? 'http://clickhouse:8123'
  const ADMIN = { url: CH_URL, user: contract.env('VERGIS_CH_ADMIN_USER') ?? 'default', password: contract.env('VERGIS_CH_ADMIN_PASS') }
  const CONSUMER_USER = contract.env('VERGIS_CH_CONSUMER_USER') ?? 'botler'
  const TARGET_ROLE = contract.env('VERGIS_CH_TARGET_ROLE') ?? 'consumer_role'

  // Clave raíz ausente vs «declara cero» (issue #117): un `datasets.yaml` decapitado y uno con
  // `datasets: []` son estados distintos y ambos son error acá — un nodo clickhouse sin datasets no
  // tiene sentido —, pero el mensaje dice cuál de los dos es para no mandar a buscar el error donde no está.
  const DATASETS: DatasetCfg[] = ((): DatasetCfg[] => {
    const declared = contract.env('VERGIS_DATASETS')
    if (!declared) throw new Error('engine=clickhouse: falta VERGIS_DATASETS (datasets del nodo).')
    const path = resolve(declared)
    const ctx = `engine=clickhouse: VERGIS_DATASETS (${path})`
    const raw = requireRootKey(parseYaml(readFileSync(path, 'utf8')) as unknown, ctx, 'datasets')
    if (!Array.isArray(raw)) throw new Error(`${ctx}: 'datasets' debe ser una lista.`)
    if (raw.length === 0) throw new Error(`${ctx}: 'datasets' está vacío — un nodo clickhouse necesita al menos un dataset.`)
    return raw as DatasetCfg[]
  })()

  // BOUND es mutable: se RECOMPUTA desde el store en cada bootstrap (ver A11 abajo). Al arranque se
  // computa una vez para derivar las inyecciones del canal de serving (su alta necesita restart).
  let BOUND: BoundDataset[] = computeBound(DATASETS, store, TARGET_ROLE)
  const UNION_INJECTIONS = unionInjections(BOUND)
  // CAVEAT colocado (no derivable): las inyecciones del canal de serving se fijan acá, al arranque.
  contract.caveat(
    'las inyecciones de claims del canal de serving (clickhouse) se fijan al arranque desde el store de ' +
      'políticas: un claim NUEVO en una política requiere restart — sin él queda fail-closed (deny), no fuga (work/045).',
  )
  const chProfile = { url: CH_URL, user: CONSUMER_USER, database: BOUND[0].schema.database }
  servingCap = createExecuteSqlClickHouse(chProfile, null, { injections: UNION_INJECTIONS })
  const ingestDwh = connections ? createExecuteSqlDwh(connections) : null

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // Mutex del ingest (cola FIFO): SIGHUP + watch de policies + timer REFRESH_MS + re-bootstrap pueden
  // solaparse, y el ingest es TRUNCATE+INSERT → dos corridas intercaladas dejan filas DUPLICADAS.
  // Serializarlo garantiza que nunca corran dos a la vez (el re-bootstrap y el timer comparten el lock).
  let ingestLock: Promise<void> = Promise.resolve()
  async function ingestAll(): Promise<void> {
    const prev = ingestLock
    let release!: () => void
    ingestLock = new Promise<void>((r) => (release = r))
    await prev.catch(() => {}) // esperar la corrida anterior; un fallo previo no bloquea la cola
    try {
      for (const b of BOUND) {
        const ingest = createIngestClickHouse(ADMIN, b.schema)
        let rows: Record<string, unknown>[] | null = null
        if (b.cfg.ingest && ingestDwh) {
          const out = (await ingestDwh.execute({ database_ref: b.cfg.ingest.database_ref, sql: b.cfg.ingest.sql }, { agent: 'vergis' })) as { rows: Record<string, unknown>[] }
          rows = out.rows
        } else if (b.cfg.seed) rows = b.cfg.seed
        if (rows) {
          const r = (await ingest.execute({ rows }, { agent: 'vergis' })) as { ingested: number }
          console.log(`[vergis-rls] ${b.schema.database}.${b.schema.table}: ${r.ingested} filas`)
        }
      }
    } finally {
      release()
    }
  }
  bootstrapAll = async () => {
    // A11: recomputar el enforcement DESDE EL STORE ACTUAL. En un hot-reload que endurece una policy
    // (grant:all → rls), reusar el BOUND del arranque dejaba la tabla sin ROW POLICY nueva (fuga);
    // recomputar acá aplica el endurecimiento en el re-bootstrap.
    BOUND = computeBound(DATASETS, store, TARGET_ROLE)
    for (let i = 0; i < 60; i += 1) {
      try { for (const b of BOUND) await bootstrapClickHouse(ADMIN, b.schema, b.enforcement); break }
      catch (e) { lastErr = e instanceof Error ? e.message : String(e); if (i === 59) throw e; await sleep(2000) }
    }
    await ingestAll()
    ready = true; lastErr = null
  }
  if (REFRESH_MS > 0) setInterval(() => void ingestAll().catch((e) => console.error('[vergis-rls] re-ingesta:', e)), REFRESH_MS)
} else {
  // --- Motor C: push-down a Fabric. La RLS nativa YA está aplicada en la fuente (fuera de banda).
  // No hay store, ni bootstrap, ni ingesta: se consulta la fuente directo, enforcing por SESSION_CONTEXT.
  if (!connections) throw new Error('engine=fabric: falta VERGIS_CONNECTIONS (perfiles SQL del Service Principal).')

  // Inyecciones del nodo = la UNIÓN de los claims de todas las políticas gobernadas (no-public).
  const injections = [
    ...new Map(
      [...store.values()]
        .filter((p): p is Policy => !isPublic(p))
        .flatMap((p) => p.predicates)
        .map((pred) => [settingForClaim(pred.claim), { setting: settingForClaim(pred.claim), claim: pred.claim }]),
    ).values(),
  ]
  // CAVEAT colocado (no derivable): la unión de inyecciones se computa acá, una vez, al arranque.
  contract.caveat(
    'las inyecciones de claims del canal de serving (fabric push-down) se fijan al arranque desde el store ' +
      'de políticas: un claim NUEVO en una política requiere restart — sin él queda fail-closed (deny), no fuga (work/045).',
  )
  const dwh = createExecuteSqlDwh(connections, { injections })
  servingCap = dwh

  // FAIL-CLOSED POR PI (issue #52): cada tabla gobernada que sirva un PI DEBE tener RLS nativa en la
  // fuente (sin eso, push-down devolvería todas las filas → fuga). La verificación es por PI y consulta
  // SOLO las conexiones en uso: un PI que no verifica no se sirve (503 con motivo en SU ruta) y los
  // demás siguen. La lógica pura vive en ./engines/fabric (testeada); acá solo el plumbing.
  bootstrapAll = async () => {
    const reports = discover()
    const { state, usedRefs, refErrors, inherited, viewLineage: lineage } = await verifyFabricServability({
      pis: reports.map((r) => ({ slug: r.slug, tables: r.tables, databaseRefs: r.databaseRefs })),
      store,
      sourceStateOf: async (ref) => {
        const prot = (await dwh.execute({ database_ref: ref, sql: SYS_SECURITY_POLICIES_SQL }, { agent: 'vergis' })) as { rows: { sch: string; tbl: string }[] }
        const lin = (await dwh.execute({ database_ref: ref, sql: SYS_VIEW_LINEAGE_SQL }, { agent: 'vergis' })) as { rows: { vsch: string; vname: string; bsch: string; bname: string }[] }
        const viewLineage = new Map<string, string[]>()
        for (const row of lin.rows) {
          const v = `${row.vsch}.${row.vname}`
          const b = `${row.bsch}.${row.bname}`
          const bases = viewLineage.get(v) ?? []
          if (!bases.includes(b)) viewLineage.set(v, [...bases, b])
        }
        return { protectedTables: new Set(prot.rows.map((row) => `${row.sch}.${row.tbl}`)), viewLineage }
      },
      previous: piState,
    })
    // Swap tras evaluar TODO (validate-before-swap): el estado vivo nunca queda a medias. El linaje
    // alimenta la visibilidad del índice (canAccess hereda la política de las bases, issue #54).
    piState.clear()
    for (const [slug, v] of state) piState.set(slug, v)
    viewLineage.clear()
    for (const [v, bases] of lineage) viewLineage.set(v, bases)
    for (const h of inherited) console.log(`[vergis-rls] herencia de gobierno (PI '${h.slug}'): ${h.view} ← ${h.bases.join(', ')} (política + secpol de la base).`)
    ready = true // frío superado: de acá en adelante el estado es por-PI
    const degraded = [...state].filter(([, v]) => !v.ok) as [string, { ok: false; reason: string }][]
    for (const [slug, v] of degraded) console.error(`[vergis-rls] PI '${slug}' NO servible (fail-closed): ${v.reason}`)
    for (const [ref, err] of refErrors) console.error(`[vergis-rls] conexión '${ref}' no verificable: ${err}`)
    console.log(`[vergis-rls] push-down: ${state.size - degraded.length}/${state.size} PI con RLS nativa verificada (${usedRefs.length} conexión(es) en uso).`)
    lastErr = degraded.length ? `${degraded.length} de ${state.size} PI no servibles` : null
    // Lanzar mantiene el RETRY con backoff del arranque (self-healing: al aplicar el artefacto o
    // revivir la conexión, la próxima pasada re-sirve sola). El estado por-PI YA quedó swapeado.
    if (degraded.length || refErrors.size) throw new Error(lastErr ?? `conexión(es) no verificables: ${[...refErrors.keys()].join(', ')}`)
  }
}

// Caché de RESULTADOS de datos por consumidor (work/052 §2.3) — OPT-IN por instancia: solo si
// VERGIS_DATA_CACHE_TTL_MS > 0 se envuelve el conector con `withResultCache` (default 0 = sin caché,
// cada render dispara las queries reales). La clave incluye params + user + claims normalizados →
// dos consumidores JAMÁS comparten entrada (la RLS no se relaja: un hit devuelve solo lo que esa
// misma identidad ya obtuvo del motor enforcing). El bootstrap NO pasa por acá (usa su handle directo).
const DATA_CACHE_TTL_MS = config.dataCacheTtlMs
if (DATA_CACHE_TTL_MS > 0) {
  servingCap = withResultCache(servingCap, { ttlMs: DATA_CACHE_TTL_MS })
  console.log(`[vergis-rls] data-cache por consumidor activo (TTL ${DATA_CACHE_TTL_MS} ms)`)
}

// Tope de filas materializables por `interactions.filters` (work/052 §2.5). Mira no lee env: se
// inyecta por runSpec. Sin definir → default de Mira (5000).
const INTERACTIVE_MAX_ROWS = config.interactiveMaxRows

// Mapeo claim→cabecera CONFIGURABLE: cada instancia trae sus claims en sus cabeceras (el criterio
// de la política decide qué claims importan: `groups`, `viewer_area`, etc.). Formato:
// VERGIS_GATE_CLAIMS="viewer_area:x-forwarded-area,groups:x-forwarded-groups" (default: groups).
// Las cabeceras del gate vienen latin1 → re-decodificar para acentos ("Producción").
const gateClaims = (contract.env('VERGIS_GATE_CLAIMS') ?? 'groups:x-forwarded-groups')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .reduce<Record<string, string>>((acc, pair) => {
    const [claim, header] = pair.split(':').map((s) => s.trim())
    if (claim && header) acc[claim] = header.toLowerCase()
    return acc
  }, {})

// A10 · Defensa en profundidad del gate (OPT-IN): con VERGIS_GATE_SECRET definido, se exige que cada
// request (salvo /healthz) traiga `x-gate-token` con ese valor — un secreto que SOLO el oauth2-proxy
// conoce y adjunta. Si el server queda expuesto sin el proxy delante (misconfig, puerto directo), los
// requests sin el token se rechazan → el consumidor no puede fabricar sus claims. Vacío = sin chequeo
// (comportamiento vivo: la protección sigue siendo que el proxy esté delante).
const GATE_SECRET = contract.env('VERGIS_GATE_SECRET') ?? ''

// RESOLVER DE IDENTIDAD desde un DIRECTORIO (charter §4–§5): cuando el claim del criterio no viaja
// en la cabecera del gate sino que se deriva de la identidad autenticada (p.ej. el ÁREA del viewer
// a partir de su email corporativo), se resuelve contra un mapa de referencia. VERGIS_IDENTITY_MAP
// apunta a un JSON { email → { claim: valor(es) } } (trust-base; lo produce un proceso admin —
// p.ej. reconciliación AAD↔directorio de personas). Fail-closed: email no mapeado → sin claim → deny.
const IDENTITY_MAP: Record<string, Record<string, string | string[]>> | null = process.env['VERGIS_IDENTITY_MAP']
  ? (JSON.parse(readFileSync(resolve(process.env['VERGIS_IDENTITY_MAP']), 'utf8')) as Record<string, Record<string, string | string[]>>)
  : null

// Identidad del gate + claims enriquecidos desde el directorio: extraído y testeado en ./identity.
// El 3er argumento (dev identity) es null salvo en dev sin gate real — imposible de activar en prod.
const identityFor = createIdentity(gateClaims, IDENTITY_MAP, config.devIdentity).identityFor

// CAPA DE NOTAS (vergis#84): impresiones + anotaciones + comentarios + compartición. Store embebido
// propio (`VERGIS_NOTES_DB`), abierto no-fatal: si falla, la capa queda deshabilitada con log y el
// serving sigue intacto — una nota no vale una caída.
let notasStore: NotasStore | null = null
let notasHandler: NotasHandler | null = null
// Gobierno de PI (autorización de ARTEFACTO, frente A). FLAG-GUARDED: con VERGIS_PI_ACL apagado el
// índice/apertura siguen por acceso-a-datos (comportamiento vivo); encendido, gatean por la ACL del
// PI (rol owner/collaborator/viewer) compuesta con la RLS de datos (que NUNCA se salta).
let governance: SqliteGovernanceStore | null = null
// Gobierno de dominio con referencia VIVA (issue #50): el admin y el catálogo leen ESTOS arreglos a
// request-time; el hot-reload los re-puebla in-place (splice) — un dominio o slot nuevo entra sin restart.
const domainsCfg: DomainDecl[] = [] // dominios declarados (también gatea «Gestión» en el avatar del catálogo)
// CORTE AS-OF (issue #108): el proveedor lo instala el bloque de administración (necesita el store de
// gobierno y el cliente del motor); hasta entonces —y en despliegues SIN administración— queda en null
// y el header dice «corte no disponible». Fail-visible: el serving nunca espera ni inventa una fecha.
let asOfFor: ((tables: string[]) => Promise<PiAsOf>) | null = null
const intakeSlotsCfg: IntakeSlot[] = [] // slots de ingesta declarados
const parseDomainsFile = (): DomainDecl[] => {
  const p = contract.env('VERGIS_DOMAINS')
  return p ? parseDomainsConfig(parseYaml(readFileSync(resolve(p), 'utf8'))) : []
}
const parseIntakeFile = (): IntakeSlot[] => {
  const p = contract.env('VERGIS_INTAKE')
  return p ? parseIntakeConfig(parseYaml(readFileSync(resolve(p), 'utf8'))) : []
}
let stewardGroups: string[] = [] // default-steward-groups (idem)
let piConfig: PiConfigHandler | null = null
// Miranda (cluster 077): null salvo que MIRANDA_ENABLED esté encendido (se construye más abajo).
let miranda: MirandaHandler | null = null
let piAclEnabled = false
let piOwners: Record<string, string> = {}
let defaultCollabGroups: string[] = []
// Secreto HMAC de los tokens CSRF de las superficies SSR de gestión (admin, config por-PI, Miranda).
// Sin `VERGIS_CSRF_SECRET` se genera uno aleatorio por arranque: sirve para dev, pero en producción
// los formularios ya abiertos NO sobreviven un restart y varias réplicas no comparten la firma.
const CSRF_SECRET = process.env['VERGIS_CSRF_SECRET'] ?? randomBytes(32).toString('hex')
if (!process.env['VERGIS_CSRF_SECRET']) {
  console.warn(
    '[vergis-rls] VERGIS_CSRF_SECRET no definido: se generó un secreto aleatorio. Los formularios de ' +
      'gestión ya abiertos NO sobreviven un restart ni se comparten entre réplicas. Define el env en producción.',
  )
}

// La navegación multi-vista (`?page=` + `?ctx.*`, con acumulación de repetidos para multi-select)
// vive en ./nav.ts — extraída para testearla sin los efectos de módulo de este archivo.

/**
 * Corre un PI bajo la identidad del request. Es el ÚNICO punto de render: sirve tanto la página del
 * PI como el congelado de una impresión (que no es otra cosa que este mismo resultado, guardado).
 * `notas` viaja solo cuando la capa de notas está disponible — sin ella el PI se sirve idéntico.
 */
async function runPi(
  report: Report,
  headers: GateHeaders,
  nav: NavQuery = {},
  notas?: { render?: NotasRenderContext; resolver?: ResolverComentarios },
  opts?: { print?: boolean },
): Promise<Awaited<ReturnType<typeof runSpec>>> {
  const identity = identityFor(headers)
  // Corte as-of por INGESTA: lo derivan la topología de procesos + el run-history del motor, con caché
  // (ver createAsOfProvider). Nunca tumba un render: a fallo devuelve el corte vacío.
  const asOf = asOfFor ? await asOfFor(report.tables).catch(() => undefined) : undefined
  const out = await runSpec({
    specPath: report.specPath,
    identity,
    baseDir: process.env['VERGIS_OUT'] ?? tmpdir(),
    // HARDENING (charter §2b): catálogo de serving = solo el conector enforcing + render/publish.
    // SIN starters (no `static-data` ni vías crudas) → imposible servir dato no-gobernado.
    registerStarters: false,
    extraCapabilities: [servingCap, renderHtmlPiece, renderCsvPiece, publicarArtefacto],
    notas,
    page: nav.page,
    ctx: nav.ctx,
    flt: nav.flt,
    interactiveMaxRows: INTERACTIVE_MAX_ROWS,
    asOf,
    // PAPEL (#65 · D4): el PDF es este MISMO render en modo print — misma identidad, misma RLS.
    print: opts?.print,
    // …y su contracara (#65 · D9): la URL de descarga que la bandeja ofrece. Sale del MISMO valor de
    // config que inyecta `renderPdf` en el router: sin sidecar no hay endpoint NI botón.
    pdfUrl: config.pdf.serviceUrl && !opts?.print ? `/${report.slug}/pdf` : undefined,
  })
  if (!out.ok) throw new Error(out.fallback?.reason ?? 'render falló')
  return out
}

async function renderReport(report: Report, headers: GateHeaders, nav: NavQuery = {}): Promise<string> {
  const out = await runPi(report, headers, nav, notasWiring(report, headers, nav))
  return out.html ?? ''
}

/**
 * «Descargar PDF» server-side (#65) — o `undefined` cuando la instancia no monta el sidecar. Ese
 * `undefined` ES el fail-closed: sin él el router no intercepta `/<slug>/pdf` y la URL responde el 404
 * de siempre. El mismo `config.pdf.serviceUrl` puebla el `pdfUrl` del render, así que botón y endpoint
 * no pueden desalinearse.
 *
 * El PDF va SIN capa de notas (D13): las notas tienen su propio artefacto congelado (`/impresiones`),
 * con otras garantías; marcadores vivos en un papel prometerían una interacción que no existe.
 */
const renderPdf = config.pdf.serviceUrl
  ? async (report: Report, headers: GateHeaders, nav: NavQuery): Promise<{ pdf: Uint8Array; filename: string }> => {
      const out = await runPi(report, headers, nav, undefined, { print: true })
      const convert = createPdfClient({ serviceUrl: config.pdf.serviceUrl, timeoutMs: config.pdf.timeoutMs })
      const filtered = !!nav.flt && Object.keys(nav.flt).length > 0
      return {
        pdf: await convert(out.html ?? ''),
        filename: pdfFilename(report.name, nav.page, new Date().toISOString().slice(0, 10), filtered),
      }
    }
  : undefined
if (config.pdf.serviceUrl) console.log(`[vergis-rls] PDF server-side activo → ${config.pdf.serviceUrl}`)

/**
 * Contexto de notas de un render: los endpoints + CSRF que la bandeja necesita, y el resolver de
 * comentarios para los marcadores. Null cuando el store no abrió (la capa queda deshabilitada sin
 * afectar el serving) o cuando no hay identidad — inferirla está prohibido.
 */
function notasWiring(
  report: Report,
  headers: GateHeaders,
  nav: NavQuery,
): { render?: NotasRenderContext; resolver?: ResolverComentarios } | undefined {
  if (!notasStore) return undefined
  const email = (identityFor(headers).user ?? '').trim().toLowerCase()
  if (!email) return undefined
  const store = notasStore
  const render: NotasRenderContext = {
    imprimirUrl: `/${report.slug}/imprimir`,
    notasUrl: `/${report.slug}/notas`,
    comentariosUrl: `/${report.slug}/comentarios`,
    impresionesUrl: '/impresiones',
    csrf: csrfFactory(CSRF_SECRET)(email),
    page: nav.page,
    ctx: nav.ctx,
  }
  // Render ESCASO y fail-closed: se preguntan solo las llaves de las filas ya RLS-filtradas, y solo
  // viajan las que tienen comentarios — el payload nunca delata la existencia de una fila no servida.
  const resolver: ResolverComentarios = async (entity, key, rows) => {
    const llaves = rows.map((r) => llaveDeFila(r, key))
    const resumen = await store.comentariosDe(entity, llaves)
    const out: Record<string, { count: number; porCampo: Record<string, number> }> = {}
    for (const r of resumen) out[r.llave] = { count: r.count, porCampo: r.porCampo }
    return out
  }
  return { render, resolver }
}

/**
 * Rol efectivo de gestión de una identidad sobre un PI (autz de ARTEFACTO). Bootstrapea el registro
 * de gobierno on-demand (dueño inicial del mapa de instancia — el dueño del ticket Jira — + grupos
 * colaboradores-default). El admin de plataforma es override (puede gestionar cualquier PI). null =
 * sin acceso al artefacto. La RLS de datos es independiente y siempre aplica al renderizar.
 */
async function piManagementRole(code: string, email: string | undefined): Promise<PiRole | null> {
  if (!governance) return 'owner' // sin store → no se gatea
  if (!(await governance.getPiGovernance(code))) {
    await governance.bootstrapPi(code, piOwners[code] ?? '', defaultCollabGroups)
  }
  if (await governance.isAdmin(email)) return 'owner' // override de plataforma (gestión)
  return governance.roleFor(code, email)
}

/** Resumen de gobierno de un PI para el CATÁLOGO: dueño + colaboradores (el líder técnico es un
 * colaborador más), resueltos a etiqueta legible. NO bootstrappea con dueño vacío (evita grants
 * basura): si no hay gobierno ni semilla de dueño, devuelve vacíos → el catálogo muestra «sin asignar».
 * Separa los colaboradores ESPECÍFICOS (se listan) de los grupos DEFAULT transversales (p.ej. Centro de
 * Excelencia, colabora en todos los PIs): éstos no se repiten por PI, solo se anotan en un tooltip. */
async function piGovSummary(code: string, glabel: Map<string, string>): Promise<{ owner: string; collaborators: string[]; defaultCollaborators: string[] }> {
  const empty = { owner: '', collaborators: [], defaultCollaborators: [] }
  if (!governance) return empty
  if (!(await governance.getPiGovernance(code))) {
    if (!piOwners[code]) return empty
    await governance.bootstrapPi(code, piOwners[code], defaultCollabGroups)
  }
  const grants = await governance.listGrants(code)
  // Los dueños sembrados por NOMBRE (sin correo aún) entran en minúscula (normEmail); se muestran
  // title-cased. Un principal con '@' es un correo real → se respeta tal cual.
  const titleCase = (s: string): string => s.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
  const nameOf = (g: { principalType: string; principal: string }): string =>
    g.principalType === 'group' ? glabel.get(g.principal) ?? g.principal : g.principal.includes('@') ? g.principal : titleCase(g.principal)
  const isDefaultGroup = (g: { principalType: string; principal: string }): boolean =>
    g.principalType === 'group' && defaultCollabGroups.includes(g.principal)
  const collab = grants.filter((g) => g.role === 'collaborator')
  return {
    owner: grants.filter((g) => g.role === 'owner').map(nameOf).join(', '),
    collaborators: collab.filter((g) => !isDefaultGroup(g)).map(nameOf),
    defaultCollaborators: collab.filter(isDefaultGroup).map(nameOf),
  }
}

// Branding del índice — parametrizado por instancia (genérico por defecto, no horneado al beta).
const INDEX_TITLE = process.env['VERGIS_INDEX_TITLE'] ?? 'Productos de Información'
// Destino del «Cerrar sesión» tras el sign_out de oauth2-proxy. La instancia lo apunta al endpoint de
// logout del IdP (AAD) para un logout COMPLETO (cierra también la sesión de Microsoft). Vacío = interno.
const SIGNOUT_RD = process.env['VERGIS_SIGNOUT_RD'] ?? ''
const INDEX_LOGO = (() => {
  const p = contract.env('VERGIS_INDEX_LOGO')
  if (!p) return ''
  try {
    const mime = p.endsWith('.svg') ? 'svg+xml' : 'png'
    return `data:image/${mime};base64,${readFileSync(resolve(p)).toString('base64')}`
  } catch { return '' }
})()

type GovByCode = Map<string, { owner: string; collaborators: string[]; defaultCollaborators: string[] }>
const indexHtml = (reports: Report[], title: string, avatar = '', gov?: GovByCode): string =>
  renderCatalog(
    reports.map((r) => {
      const g = gov?.get(r.code)
      return { code: r.code, slug: r.slug, name: r.name, owner: g?.owner ?? '', collaborators: g?.collaborators ?? [], defaultCollaborators: g?.defaultCollaborators ?? [] }
    }),
    title,
    { logoUrl: INDEX_LOGO || undefined, avatar },
  )

// Operaciones per-request que el router (`routes.ts`) inyecta. Viven acá porque cierran sobre el
// estado del server (governance/piAclEnabled/domainsCfg/…), leído a request-time. Lógica verbatim.
const indexReports = async (all: Report[], identity: IdentityContext): Promise<Report[]> => {
  const claims = identity.claims ?? {}
  if (!(piAclEnabled && governance)) return visibleFor(all, claims)
  const roles = await Promise.all(all.map((r) => piManagementRole(r.code, identity.user)))
  return all.filter((_, i) => canOpen(roles[i]))
}
const renderIndexPage = async (visible: Report[], identity: IdentityContext): Promise<string> => {
  const idxTitle = (governance ? await governance.getSetting('index_title') : null) || INDEX_TITLE
  const emailLc = (identity.user ?? '').toLowerCase()
  const isAdmin = governance ? await governance.isAdmin(emailLc) : false
  let hasDomains = isAdmin
  if (!hasDomains && governance && domainsCfg.length) {
    const ug = await governance.groupsOf(emailLc)
    hasDomains = ug.some((g) => stewardGroups.includes(g)) || manageableDomains(domainsCfg, emailLc, false).length > 0
  }
  // Entrada «Miranda» en el menú: solo si el flag está ON y la identidad tiene el scope (admin o grupo).
  const hasMiranda = config.miranda.enabled && governance ? isAdmin || (await governance.isMember(config.miranda.scopeGroup, emailLc)) : false
  const avatar = avatarMenu({ email: emailLc, isAdmin, hasDomains, hasMiranda, signoutRd: SIGNOUT_RD || '/' })
  const govByCode: GovByCode = new Map()
  if (governance) {
    const groups = await governance.listGroups()
    const glabel = new Map(groups.map((g) => [g.id, g.label]))
    await Promise.all(visible.map(async (r) => { govByCode.set(r.code, await piGovSummary(r.code, glabel)) }))
  }
  return indexHtml(visible, idxTitle, avatar, govByCode)
}
const canOpenPi = (report: Report, identity: IdentityContext): Promise<boolean> =>
  piAclEnabled && governance ? piManagementRole(report.code, identity.user).then(canOpen) : Promise.resolve(true)

const server = createServer(
  createRequestHandler({
    engine: ENGINE,
    gateSecret: GATE_SECRET,
    isReady: () => ready,
    getAdmin: () => admin,
    // CONTRATO OPERATIVO (issue #139). Getter en CALL-TIME (como `getAdmin`/`getPiConfig`): `governance`
    // se asigna en el bootstrap async del bloque de administración, así que capturarlo acá daría null
    // para siempre. Sin store de gobierno el handler responde 403 con su motivo (no se apaga la ruta:
    // «no hay Administración» es una respuesta operativa, un 404 no lo es).
    getContract: () => createContractHandler({
      registry: contract,
      isAdmin: ((gov) => (gov ? (email: string | undefined) => gov.isAdmin(email ?? '') : null))(governance),
      identityOf: (headers) => ({ user: identityFor(headers as GateHeaders).user }),
    }),
    getPiConfig: () => piConfig,
    getMiranda: () => miranda,
    getNotas: () => notasHandler,
    discover,
    identityFor,
    renderReport,
    renderPdf,
    indexReports,
    renderIndexPage,
    canOpenPi,
    // Servibilidad POR PI (issue #52, engine=fabric): motivo del bloqueo o null. Un PI descubierto
    // pero aún no verificado (spec recién añadida en caliente) queda fail-closed hasta la próxima
    // pasada de verificación. En clickhouse el estado sigue siendo global (gate `ready`).
    piBlocked: (report: Report): string | null => {
      if (ENGINE !== 'fabric') return null
      const v = piState.get(report.slug)
      if (!v) return 'pendiente de verificación de su RLS nativa (reintenta en unos segundos).'
      return v.ok ? null : v.reason
    },
    healthSummary: () =>
      ENGINE === 'fabric' ? { total: piState.size, serving: [...piState.values()].filter((v) => v.ok).length } : null,
  }),
)


// ── CAPA DE NOTAS (vergis#84) — impresiones · anotaciones · comentarios · compartición ────────────
// Apertura NO-FATAL (mismo patrón que el resto de los stores embebidos): si el archivo no abre, la
// capa queda deshabilitada con log y el nodo sigue sirviendo sus PIs. Una nota no vale una caída.
try {
  notasStore = await openNotasStore(contract.env('VERGIS_OUT') ?? tmpdir())
  const store = notasStore
  // Spec parseada por slug: la necesita el gate del comentario (para leer el `anchor` del dataset y
  // re-ejecutar su recuperación). Se lee a request-time desde el descubrimiento vivo — un spec
  // editado en caliente entra sin restart, igual que en el serving.
  const resolvePi = (slug: string): { code: string; name: string; slug: string; spec: MiraSpec } | undefined => {
    const r = discover().find((x) => x.slug === slug)
    if (!r) return undefined
    try {
      return { code: r.code, name: r.name, slug: r.slug, spec: parseMiraSpec(readFileSync(r.specPath, 'utf8')) as MiraSpec }
    } catch {
      return undefined
    }
  }
  notasHandler = createNotas({
    store,
    resolve: resolvePi,
    identityOf: (h) => ({ user: identityFor(h as GateHeaders).user }),
    canOpenPi: async (slug, h) => {
      const r = discover().find((x) => x.slug === slug)
      if (!r) return false
      return canOpenPi(r, identityFor(h as GateHeaders))
    },
    // EL GATE DEL COMENTARIO: se re-ejecuta la recuperación del dataset bajo la identidad del autor.
    // Lo que devuelve es exactamente lo que esa identidad ve — comentar una llave ausente es 403.
    retrieve: async (slug, dataset, ctx, headers) => {
      const r = discover().find((x) => x.slug === slug)
      if (!r) throw new Error(`Producto de Información no encontrado: ${slug}`)
      const spec = parseMiraSpec(readFileSync(r.specPath, 'utf8')) as MiraSpec
      const ds = spec.data?.[dataset]
      if (!ds) throw new Error(`El dataset '${dataset}' no existe en este Producto de Información.`)
      const params = applyCtx(ds.params, (ctx ?? {}) as Record<string, string | string[]>)
      const out = (await servingCap.execute(params, identityFor(headers as GateHeaders))) as { rows?: Record<string, unknown>[] }
      return out.rows ?? []
    },
    // Congelar = renderizar bajo la identidad del autor y quedarse con el árbol resuelto. El
    // congelado nace RLS-filtrado: por eso anotarlo después no vuelve a preguntar nada.
    congelar: async (slug, pageParam, ctx, headers) => {
      const r = discover().find((x) => x.slug === slug)
      if (!r) throw new Error(`Producto de Información no encontrado: ${slug}`)
      const nav: NavQuery = { page: pageParam, ctx }
      const out = await runPi(r, headers as GateHeaders, nav, notasWiring(r, headers as GateHeaders, nav))
      const spec = parseMiraSpec(readFileSync(r.specPath, 'utf8')) as MiraSpec
      const specVersion = [spec.identity?.['version'], createHash('sha256').update(readFileSync(r.specPath, 'utf8')).digest('hex').slice(0, 8)]
        .filter(Boolean)
        .join('·')
      return {
        piSlug: r.slug,
        piName: r.name,
        title: String(spec.identity?.display_name ?? r.name),
        page: pageParam,
        ctx,
        watermark: out.freshness?.watermark,
        specVersion,
        autor: (identityFor(headers as GateHeaders).user ?? '').toLowerCase(),
        resolved: out.resolved ?? { type: 'markdown_block', content: '(sin contenido)' },
      } satisfies CongeladoPi
    },
    // El congelado se re-renderiza SIN drills y SIN superficie de notas viva: es un documento, no una
    // vista. Navegar desde él a dato de hoy rompería la promesa de que lo que se ve es lo que se vio.
    renderCongelado: async (frozen) => {
      const out = (await renderHtmlPiece.execute(
        {
          piece: sinDrills(frozen.resolved),
          title: frozen.title,
          theme: frozen.theme,
          palette: frozen.palette,
          meta: { date: frozen.watermark ? new Date(frozen.watermark) : undefined, code: frozen.piSlug },
        },
        { agent: 'vergis-notas' },
      )) as { html?: string }
      return out.html ?? ''
    },
    avatarFor: async (email) => {
      const isAdmin = governance ? await governance.isAdmin(email) : false
      return avatarMenu({ email, isAdmin, hasDomains: isAdmin, signoutRd: SIGNOUT_RD || '/' })
    },
    audit: (e) => console.log(`[vergis-notas] ${JSON.stringify(e)}`),
    secret: CSRF_SECRET,
    brandTitle: INDEX_TITLE,
  })
  console.log('[vergis-rls] capa de notas: store embebido listo (/impresiones)')
  // RETENCIÓN (A7): al arranque y cada 24 h. La configuración vive en platform settings; el default
  // (P12M) está en código. Se loguea SIEMPRE lo purgado — borrar en silencio es como no borrar.
  const purga = async (): Promise<void> => {
    if (!governance) return // los settings viven en el store de gobierno; sin él, el default no se aplica solo
    try {
      const { corte, purgados } = await purgarRetencion(store, governance)
      if (purgados.length) console.log(`[vergis-notas] retención: ${purgados.length} impresión(es) purgada(s) con actividad anterior a ${corte} — ${purgados.join(', ')}`)
    } catch (e2) {
      console.error(`[vergis-notas] purga de retención falló: ${e2 instanceof Error ? e2.message : String(e2)}`)
    }
  }
  const timerPurga = setInterval(() => void purga(), PURGA_INTERVALO_MS)
  timerPurga.unref?.()
  setTimeout(() => void purga(), 5000).unref?.() // tras el bootstrap del gobierno, no compitiendo con él
} catch (e) {
  console.error(`[vergis-rls] capa de notas deshabilitada: ${e instanceof Error ? e.message : String(e)}`)
}

// ADMINISTRACIÓN (no-fatal): data maestra + usuarios y roles — única superficie de ESCRITURA
// gobernada. Independiente del motor de serving. Se habilita si la instancia declara entidades
// (VERGIS_MASTER_DATA) o admins semilla (VERGIS_ADMIN_SEED). El store de data maestra es Fabric en
// engine=fabric (la fuente única que el PI lee por JOIN) y SQLite embebido en local/clickhouse.
let admin: AdminHandler | null = null
const ADMIN_SEED = (process.env['VERGIS_ADMIN_SEED'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const OUT = (process.env['VERGIS_OUT'] ?? tmpdir()).replace(/\/$/, '')
/** Store de gobierno (SQLite): una sola expresión de la ruta para todos sus consumidores. */
const GOVERNANCE_DB = process.env['VERGIS_GOVERNANCE_DB'] ?? `${OUT}/governance.sqlite`

// `--fresh` (arnés de DESARROLLO): recrea el store de gobierno para no arrastrar sesiones de prueba
// entre corridas. Sin la bandera, el store se conserva (default de hoy). La decisión ya la tomó
// `decideFreshStore` — jamás borra sin identidad de dev activa ni con gate real presente; acá solo se
// ejecuta y se comunica. Borrar un store de producción es imposible por construcción.
{
  const fresh = decideFreshStore(process.argv.slice(2), process.env)
  if (fresh.mode === 'fresh') {
    let borrado = false
    for (const f of [GOVERNANCE_DB, `${GOVERNANCE_DB}-wal`, `${GOVERNANCE_DB}-shm`]) {
      try {
        unlinkSync(f)
        if (f === GOVERNANCE_DB) borrado = true
      } catch {
        /* no existía: el arranque lo crea igual */
      }
    }
    console.warn(`⚠ --fresh (DEV): store de gobierno ${borrado ? 'BORRADO' : 'inexistente'} → se recrea vacío (${GOVERNANCE_DB})`)
  } else if (fresh.mode === 'refused-gate') {
    console.warn('--fresh IGNORADO: hay gate real (VERGIS_GATE_SECRET presente). El store no se toca.')
  } else if (fresh.mode === 'refused-no-dev') {
    console.warn('--fresh IGNORADO: no hay identidad de dev activa (VERGIS_DEV_IDENTITY). Solo el arnés de desarrollo puede recrear el store.')
  }
}

// --- Config declarativa de instancia: FATAL y fuera del try de infra (issue #117) --------------
// Se valida TODA config declarada por env, incondicionalmente y ANTES del bloque de administración:
// un throw acá es top-level y tumba el proceso nombrando ENV + ruta + clave raíz. Dentro del try de
// abajo moriría como «administración deshabilitada» — un archivo roto degradando en silencio.
const INSTANCE_CFG = loadInstanceConfig(contractEnv)
if (INSTANCE_CFG.summary) console.log(`[vergis-rls] config de instancia: ${INSTANCE_CFG.summary}`)

// Sinks por flujo (issues #100/#102): la creación resuelve passEnv/caFile de los destinos email —
// config rota tumba el BOOT con nombre (patrón #117), no muere como «administración deshabilitada».
const alertSinks = createSinks(forEvent(INSTANCE_CFG.notify, 'alerts'))
const reportSinks = createSinks(forEvent(INSTANCE_CFG.notify, 'reports'))
// El reporte lee la proyección del store de gobierno: sin bloque de gobierno no hay qué reportar.
if (INSTANCE_CFG.notify.report && !(process.env['VERGIS_MASTER_DATA'] || ADMIN_SEED.length))
  throw new Error('VERGIS_NOTIFY declara report: pero la instancia no tiene bloque de gobierno (VERGIS_MASTER_DATA o VERGIS_ADMIN_SEED).')

if (process.env['VERGIS_MASTER_DATA'] || ADMIN_SEED.length) {
  try {
    const entities = INSTANCE_CFG.entities
    const groupSeeds: GroupSeed[] = INSTANCE_CFG.groupSeeds
    // Gestión de DOMINIO: dominios declarados (etiqueta + stewards) y slots de ingesta de la instancia.
    // Se cargan EN los arreglos vivos module-level (el hot-reload los re-puebla in-place, issue #50).
    domainsCfg.splice(0, domainsCfg.length, ...INSTANCE_CFG.domains)
    const domains = domainsCfg
    intakeSlotsCfg.splice(0, intakeSlotsCfg.length, ...INSTANCE_CFG.intakeSlots)
    const intakeSlots = intakeSlotsCfg
    // Registro de fuentes de la instancia (frente B · frescura): fuentes (oferta + dominio), mapeos
    // tabla→fuente, procesos (con engine_ref al item del motor) y proceso→salidas. Declarativo: se
    // re-siembra en cada arranque (idempotente). Sin el archivo, el registro queda vacío (no hay frescura).
    const sourceReg = INSTANCE_CFG.sourceReg
    const govStore = await SqliteGovernanceStore.open(GOVERNANCE_DB, {
      admins: ADMIN_SEED,
      groups: groupSeeds,
      sources: sourceReg.sources,
      tableSources: sourceReg.tableSources,
      processes: sourceReg.processes,
      processOutputs: sourceReg.processOutputs,
    })
    const adminStore = govStore
    // Gobierno de PI (frente A): expone el store al gate de artefacto + config de ACL (flag-guarded).
    governance = govStore
    piAclEnabled = ['1', 'true', 'on'].includes((process.env['VERGIS_PI_ACL'] ?? '').toLowerCase())
    defaultCollabGroups = (process.env['VERGIS_DEFAULT_COLLABORATOR_GROUPS'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const defaultStewardGroups = (process.env['VERGIS_DEFAULT_STEWARD_GROUPS'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    stewardGroups = defaultStewardGroups // idem: el avatar del catálogo decide si mostrar «Gestión»
    piOwners = INSTANCE_CFG.piOwners
    const useFabricStore = ENGINE === 'fabric' && connections
    const mdStore = useFabricStore
      ? createDwhMasterDataStore(connections)
      : await SqliteMasterDataStore.open(process.env['VERGIS_MASTER_DATA_DB'] ?? `${OUT}/master-data.sqlite`, entities)
    // Audit log LONGEVO (vive todo el proceso): modo file-only (retain:false) — append() no acumula
    // en RAM (crecía sin cota, una entrada por evento admin); la fuente de verdad es el archivo.
    const auditLog = new AppendOnlyLog(`${OUT}/admin-audit.log`, undefined, { retain: false })
    // Ejecutor de INGESTA: write a OneLake (staging) + run-now del pipeline + lectura de estado de las
    // corridas (jobs/instances). Usa las creds del SP de una conexión (VERGIS_INTAKE_SP, o la única si
    // hay una sola) — token AAD para storage/Fabric REST, no para SQL. Sin slots o sin conexiones, no se ofrece.
    const fabricWiring = ((): { runner?: IntakeRunner; status?: (slot: IntakeSlot) => Promise<RunRecord[]>; logOf?: (slot: IntakeSlot) => Promise<string | null>; cargas?: CargasOps; backfill?: (slot: IntakeSlot) => void; engine?: IngestionEngineClient; runLogs?: RunLogsOps } => {
      if (!connections) return {}
      const refs = Object.keys(connections)
      const ref = process.env['VERGIS_INTAKE_SP'] ?? (refs.length === 1 ? refs[0] : undefined)
      const sp = ref ? connections[ref] : undefined
      if (!sp) {
        if (intakeSlots.length) console.error('[vergis-rls] ingesta/frescura deshabilitadas: define VERGIS_INTAKE_SP (hay varias conexiones).')
        return {}
      }
      const tokens = credentialProviderFor(sp, { label: `database_ref '${ref}'` })
      const jobStatus = createFabricJobStatus(tokens)
      // Engine client (frente B · frescura): resuelve processRef → engine_ref con el registro de procesos.
      const engine = createFabricEngineClient(tokens, async (processRef) => (await govStore.listProcesses()).find((p) => p.id === processRef)?.engine)
      // El runner se construye aunque HOY no haya slots: los slots son un arreglo vivo (hot-reload,
      // issue #50) y uno agregado en caliente debe encontrar su ejecutor listo.
      const onelake = createOneLakeIntake(tokens)
      const jobs = createFabricJobs(tokens)
      const reader = createOneLakeReader(tokens)
      const parentDir = (p: string): string => (p.includes('/') ? p.replace(/\/[^/]*$/, '') : p)

      // ── Registro de cargas (issue #62): migración one-shot + indexado retroactivo ──
      // La fuente del historial pasa del audit log JSONL al GovernanceStore. Para que el timeline no
      // pierda la historia ya vivida, los eventos `type:'intake'` del log se importan UNA vez: la
      // condición es que la tabla esté vacía (idempotente entre reinicios). El `dupOf` viejo era un
      // string de aviso, no una referencia: no se re-resuelve a id.
      let migracion: Promise<void> | null = null
      const migrarCargasDesdeAuditLog = (): Promise<void> => {
        migracion ??= (async () => {
          const yaHay = await Promise.all(intakeSlots.map((s) => govStore.listUploads(s.id, 1)))
          if (yaHay.some((r) => r.length)) return
          let text: string
          try { text = readFileSync(`${OUT}/admin-audit.log`, 'utf8') } catch { return }
          const conocidos = new Set(intakeSlots.map((s) => s.id))
          for (const l of text.split('\n')) {
            const linea = l.trim()
            if (!linea) continue
            try {
              const e = JSON.parse(linea) as { type?: string; slot?: string; filename?: string; bytes?: number; by?: string; ok?: boolean; triggered?: boolean; ts?: string; sha256?: string }
              if (e.type !== 'intake' || !e.slot || !conocidos.has(e.slot) || !e.sha256) continue
              await govStore.recordUpload({
                slotId: e.slot, filename: e.filename ?? '', sha256: e.sha256, bytes: e.bytes ?? 0,
                uploadedBy: e.by ?? '', uploadedAt: e.ts ?? '', ok: e.ok !== false, triggered: e.triggered === true, origen: 'upload',
              })
            } catch { /* línea no-JSON del log, o store que rechazó la fila: se ignora */ }
          }
        })().catch(() => {}) // la migración jamás rompe una página: sin ella el historial arranca vacío
        return migracion
      }

      // Indexado retroactivo de `_processed/` (D3): lazy, UNA vez por slot, en background. Todo lo
      // procesado antes de que existiera el registro es invisible al dedup — esto lo hace visible sin
      // que nadie tenga que acordarse de correr un comando. Un archivo ilegible se cuenta y no aborta
      // el resto; si la pasada entera revienta NO se marca, y el próximo disparo la reintenta.
      const backfillEnCurso = new Set<string>()
      const backfill = (slot: IntakeSlot): void => {
        if (backfillEnCurso.has(slot.id)) return
        backfillEnCurso.add(slot.id)
        void (async () => {
          try {
            await migrarCargasDesdeAuditLog()
            if (await govStore.intakeBackfillDone(slot.id)) return
            const entries = await reader.list(slot.target, `${parentDir(slot.target.path)}/_processed`, { recursive: true })
            let files = 0
            let errores = 0
            for (const e of entries) {
              if (e.isDirectory || isSidecarName(e.path)) continue
              const filename = e.path.split('/').pop() ?? e.path
              try {
                const bytes = await reader.readBytes(slot.target, e.path)
                if (!bytes) { errores += 1; continue }
                const sha256 = createHash('sha256').update(bytes).digest('hex')
                // Idempotencia frente a re-lanzamientos y a la migración: mismo contenido + mismo nombre ya indexado.
                const ya = (await govStore.listUploads(slot.id, 1000)).some((r) => r.sha256 === sha256 && r.filename === filename)
                if (ya) continue
                await govStore.recordUpload({
                  slotId: slot.id, filename, sha256, bytes: bytes.byteLength,
                  uploadedBy: '(retro: _processed)', uploadedAt: e.lastModified, ok: true, triggered: false, origen: 'retro',
                })
                files += 1
              } catch { errores += 1 }
            }
            await govStore.markIntakeBackfillDone(slot.id, files, errores)
            auditLog.append({ type: 'intake-hash-backfill', slot: slot.id, files, errores })
          } catch (err) {
            console.error(`[vergis-rls] indexado retroactivo de _processed/ falló en el slot '${slot.id}': ${err instanceof Error ? err.message : String(err)}`)
          } finally {
            backfillEnCurso.delete(slot.id)
          }
        })()
      }

      return {
        runner: { put: (t, f, b, sc) => onelake.put(t, f, b, sc), runNow: (tr, t) => jobs.runNow(tr, t) },
        backfill,
        status: (slot) => jobStatus.listInstances(slot.trigger?.workspaceId ?? slot.target.workspaceId, slot.trigger!.processRef, 5),
        // Log de la última conversión del slot (issue #55): lo escribe el proceso en el landing;
        // Frescura lo expone para reconfirmar una carga sin acceso a Fabric. null = sin log.
        logOf: (slot) => {
          const p = slotLogPath(slot)
          return p ? reader.read(slot.target, p) : Promise.resolve(null)
        },
        // Consola de cargas (issue #58). El padre del dir del slot ancla las convenciones del ciclo:
        // `<padre>/_processed` (lo archivado por el pipeline) y `<padre>/_retirado` (retiros manuales).
        cargas: (() => {
          // #63 · el motor de reversión consume el reader (leer/copiar/borrar), el write-path (SOLO
          // para el manifiesto que el convertidor ejecuta), los jobs y el registro de cargas.
          const revertDeps = { reader, intake: onelake, jobs, uploads: govStore }
          const refDeRevert = (ref: { uploadId?: number; archivedPath?: string }): RevertRef =>
            ref.uploadId != null ? { uploadId: ref.uploadId } : { archivedPath: ref.archivedPath ?? '' }
          return {
            // El historial se lee del REGISTRO de cargas (issue #62), no del audit log: aquel es
            // evidencia encadenada, no índice consultable. La migración one-shot de más abajo
            // importa lo ya escrito para que el timeline no pierda historia al cambiar de fuente.
            // Las filas `origen:'retro'` (indexado de `_processed/`) NO son eventos de carga vividos:
            // participan del dedup, no de la Actividad.
            history: async (slot, limit) => {
              await migrarCargasDesdeAuditLog()
              const rows = await govStore.listUploads(slot.id, Math.max(limit * 2, limit))
              const out: IntakeUploadEvent[] = []
              for (const r of rows.filter((x) => x.origen === 'upload').slice(0, limit)) {
                // El `id` es el ancla de «Revertir esta carga» (#63): sin él la fila no ofrece el botón.
                const ev: IntakeUploadEvent = { id: r.id, ts: r.uploadedAt, filename: r.filename, bytes: r.bytes, by: r.uploadedBy ?? '', ok: r.ok, triggered: r.triggered, sha256: r.sha256 }
                // `dup_of` apunta por construcción a la carga original del contenido, que es
                // exactamente la que `findUploadBySha` resuelve (la más antigua ok=1 con ese sha).
                if (r.dupOfId != null) {
                  const orig = await govStore.findUploadBySha(slot.id, r.sha256)
                  if (orig) ev.dupOf = dupLabel(orig)
                }
                out.push(ev)
              }
              return out
            },
            runs: (slot, top) =>
              slot.trigger ? jobStatus.listInstances(slot.trigger.workspaceId ?? slot.target.workspaceId, slot.trigger.processRef, top) : Promise.resolve([]),
            // El log CON su mtime (issue #86): sin saber de cuándo es el archivo, el de una corrida
            // anterior se presentaría como diagnóstico de la actual. El `list` extra es tolerante —
            // si falla o la entry no aparece, `lastModified` queda undefined y nada se degrada.
            log: async (slot) => {
              const p = slotLogPath(slot)
              if (!p) return null
              const text = await reader.read(slot.target, p)
              if (text == null) return null
              let lastModified: string | undefined
              try {
                const base = p.split('/').pop() ?? p
                lastModified = (await reader.list(slot.target, parentDir(p)))
                  .find((e) => !e.isDirectory && (e.path === p || (e.path.split('/').pop() ?? '') === base))?.lastModified
              } catch { /* sin mtime: fail-safe, no se afirma añejez */ }
              return { text, lastModified }
            },
            landing: (slot) => reader.list(slot.target, slot.target.path),
            archived: (slot) => reader.list(slot.target, `${parentDir(slot.target.path)}/_processed`, { recursive: true }),
            rerun: async (slot) => {
              if (!slot.trigger) throw new Error('El slot no dispara conversión (land-only).')
              await jobs.runNow(slot.trigger, slot.target)
            },
            retire: async (slot, filename) => {
              const from = `${slot.target.path}/${filename}`
              await reader.copy(slot.target, from, `${parentDir(slot.target.path)}/_retirado/${Date.now()}-${filename}`)
              await reader.remove(slot.target, from)
            },
            restore: async (slot, archivedPath) => {
              const base = archivedPath.split('/').pop() ?? archivedPath
              await reader.copy(slot.target, archivedPath, `${slot.target.path}/${base}`)
            },
            // ── «Revertir esta carga» (issue #63) ──
            // El layout `_processed/<clave>/` ES el ledger carga→clave del contrato de ingesta: la
            // compensación se DERIVA de él (motor `intake-revert`), en dos fases selladas por hash.
            // El registro de reversiones sí es de Vergis: quién revirtió qué, y con qué resultado.
            reverts: (slot, limit) => govStore.listReverts(slot.id, limit),
            revertPlan: (slot, ref) => deriveRevertPlan(revertDeps, slot, refDeRevert(ref)),
            revertExec: async (slot, planHash, ref, by) => {
              // Guard de carrera: compensar mientras el convertidor procesa el landing pelearía con él.
              // Tolerante a propósito — si el motor no responde, «no pude medir» no bloquea la operación.
              if (slot.trigger) {
                const enCurso = await jobStatus
                  .listInstances(slot.trigger.workspaceId ?? slot.target.workspaceId, slot.trigger.processRef, 1)
                  .then((rs) => rs[0] && (rs[0].status === 'InProgress' || rs[0].status === 'NotStarted'))
                  .catch(() => false)
                if (enCurso) throw new Error('Hay una conversión en curso — esperá a que termine antes de revertir.')
              }
              const out = await executeRevertPlan(revertDeps, slot, planHash, refDeRevert(ref), by)
              if (!out.ok) return out
              // Se registra al COMPLETAR: una ejecución caída a medias converge en la re-entrada y
              // recién ahí queda escrita. El audit, en cambio, ya recibió el intento en admin.ts.
              await govStore.recordRevert({
                slotId: slot.id,
                ...(out.result.uploadId != null ? { uploadId: out.result.uploadId } : {}),
                filename: out.result.filename,
                byUser: by,
                at: new Date().toISOString(),
                resumen: out.result.resumen,
                landingRetirado: out.result.landingRetirado,
              })
              return out
            },
          } satisfies CargasOps
        })(),
        // Logs POR CORRIDA (issue #99): SOLO LECTURA sobre el directorio `_logs/` del contrato. La
        // pertenencia al dominio se valida acá (fail-closed): sin ella, un steward del dominio A leería
        // los logs del dominio B fabricando la URL.
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
          runsOf: async ({ domainId, slotId, processId }) => {
            if (slotId) {
              const slot = intakeSlots.find((s) => s.id === slotId && (s.domain ?? '') === domainId)
              return slot?.trigger
                ? jobStatus.listInstances(slot.trigger.workspaceId ?? slot.target.workspaceId, slot.trigger.processRef, 20)
                : []
            }
            return processId ? engine.listRunHistory(processId) : []
          },
        },
        engine,
      }
    })()
    // Proveedor del CORTE AS-OF del header (issue #108): una sola instancia (su caché por proceso vive
    // con ella) que `runPi` consulta por request. Sin `engine` —modo clickhouse, sin VERGIS_INTAKE_SP—
    // se instala igual y responde «no disponible»: la línea del header existe siempre.
    asOfFor = createAsOfProvider({
      engine: fabricWiring.engine,
      loadTopology: async () => {
        const [processes, processOutputs, sources] = await Promise.all([govStore.listProcesses(), govStore.listProcessOutputs(), govStore.listSources()])
        return {
          processOutputs,
          processes: processes.map((p) => ({ id: p.id, sourceId: p.sourceId })),
          sources: sources.map((s) => ({ id: s.id, domain: s.domain })),
          domainLabels: Object.fromEntries(domainsCfg.map((d) => [d.id, d.label])),
        }
      },
    })
    // Insumos compartidos del cálculo de frescura (registro de fuentes + specs + demandas). Reusado por
    // el mapa por proceso (reconciliador), la proyección por entidad (vista) y el «aplicar cadencia».
    const freshnessInputs = async () => {
      const [procs, outputs, sources] = await Promise.all([govStore.listProcesses(), govStore.listProcessOutputs(), govStore.listSources()])
      const reports = discover()
      const piTables = reports.map((r) => ({ piCode: r.code, tables: r.tables }))
      const piDemandas = (
        await Promise.all(
          reports.map(async (r) => {
            const d = await govStore.getDemanda(r.code)
            return d ? { piCode: r.code, maxAge: d.maxAge } : null
          }),
        )
      ).filter((x): x is { piCode: string; maxAge: string } => !!x)
      const mapInput = { sources: sources.map((s) => ({ id: s.id, oferta: s.oferta })), processes: procs, processOutputs: outputs, piTables, piDemandas }
      return { sources, procs, outputs, mapInput }
    }
    // Lazo de frescura (#105): observa el motor → proyección local; alerta (dedup por transición);
    // reconcilia el schedule con debounce. La vista lee SOLO la proyección — el motor nunca en el
    // request path. Nace encendido cuando hay motor: la memoria del producto no puede depender de que
    // alguien declare un destino de aviso (los destinos gatean SOLO los avisos). No mantiene vivo el
    // proceso.
    const notifySinks = alertSinks
    const freshnessPollMs = Number(contract.env('VERGIS_FRESHNESS_POLL_MS') ?? 300_000)
    const reconcileAuto = (contract.env('VERGIS_RECONCILE_AUTO') ?? 'on').toLowerCase() !== 'off'
    const reconcileDebounceMs = Number(contract.env('VERGIS_RECONCILE_DEBOUNCE_MS') ?? 21_600_000)
    if (fabricWiring.engine && freshnessPollMs > 0) {
      const loop = createFreshnessLoop(
        {
          engine: fabricWiring.engine,
          store: govStore,
          inputs: freshnessInputs,
          // Fan-out a los destinos declarados: un destino caído se loguea y no tumba el tick.
          ...(notifySinks.length ? { notify: (n: Notification) => fanout(notifySinks, n, (l) => console.error(`[vergis-rls] ${l}`)) } : {}),
          domains: domainsCfg,
          audit: (e) => auditLog.append(e),
          log: (l) => console.log(`[vergis-rls] ${l}`),
        },
        { reconcile: reconcileAuto, reconcileDebounceMs, publicUrl: INSTANCE_CFG.publicUrl },
      )
      setInterval(() => void loop.tick(), freshnessPollMs).unref?.()
      setTimeout(() => void loop.tick(), 10_000).unref?.() // primer tick tras el bootstrap (patrón de la purga)
      console.log(
        `[vergis-rls] lazo de frescura activo (cada ${Math.round(freshnessPollMs / 1000)}s · reconcile ${reconcileAuto ? 'on' : 'off'} · ` +
          `${notifySinks.length ? `avisos ${notifySinks.length} destino(s)` : 'avisos off'})`,
      )
    }
    // Reporte periódico de lo ejecutado (issue #102): latido incondicional — se envía SIEMPRE a la
    // hora configurada, con novedades o sin ellas. Un día sin correo = señal de problema, por diseño.
    // Independiente del lazo de frescura y del motor: se gatea SOLO por `report:` declarado.
    const reportCfg = INSTANCE_CFG.notify.report
    if (reportCfg) {
      const tzReporte = reportCfg.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      const reportLoop = createReportLoop(
        {
          store: govStore,
          inputs: freshnessInputs,
          domains: domainsCfg.map((d) => ({ id: d.id, label: d.label })),
          sinks: reportSinks,
          audit: (e) => auditLog.append(e as LogEventInput),
          log: (l) => console.log(`[vergis-rls] ${l}`),
        },
        { schedule: reportCfg, timezone: tzReporte, baseUrl: INSTANCE_CFG.publicUrl, freshnessPollMs, engineCabled: !!fabricWiring.engine },
      )
      setInterval(() => void reportLoop.tick(), REPORT_CHECK_MS).unref?.()
      setTimeout(() => void reportLoop.tick(), 15_000).unref?.() // catch-up al arrancar (ventana perdida)
      console.log(
        `[vergis-rls] reporte periódico activo (${reportCfg.every === 'weekly' ? `semanal ${reportCfg.weekday ?? 'monday'}` : 'diario'} ` +
          `a las ${reportCfg.at} ${tzReporte} · ${reportSinks.length} destino(s))`,
      )
    }
    admin = createAdmin({
      entities,
      mdStore,
      adminStore,
      domains,
      domainStewardGroups: defaultStewardGroups,
      intakeSlots,
      intake: fabricWiring.runner,
      intakeStatus: fabricWiring.status,
      intakeLog: fabricWiring.logOf,
      cargas: fabricWiring.cargas,
      // Registro de cargas (issue #62): dedup por contenido, pre-check y el indexado retroactivo.
      intakeUploads: govStore,
      intakeBackfill: fabricWiring.backfill,
      // Acceso al log de una corrida (issue #99): la página `/corrida` y sus enlaces «Ver log».
      runLogs: fabricWiring.runLogs,
      signoutRd: SIGNOUT_RD || undefined,
      piCount: discover().length,
      groupStore: govStore,
      settingStore: govStore,
      onWrite: connections
        ? (() => {
            const publisher = createDwhPublisher(connections)
            return async (entity: MasterDataEntity) => {
              if (!entity.targets?.length) return
              const rows = await mdStore.list(entity)
              for (const t of entity.targets) await publisher.publish(entity, rows, { database_ref: t.database_ref })
            }
          })()
        : undefined,
      ingestionMap: async () => deriveIngestionMap((await freshnessInputs()).mapInput),
      // Registro de fuentes (vista de Fuentes en Plataforma): fuentes + procesos + salidas (topología técnica).
      sourceRegistry: async () => {
        const [sources, processes, outputs] = await Promise.all([govStore.listSources(), govStore.listProcesses(), govStore.listProcessOutputs()])
        return { sources, processes, outputs }
      },
      // Gestión in-app del registro (#107): el registro deja de ser propiedad exclusiva del yaml. Lo
      // editado acá sobrevive a la re-siembra de `VERGIS_SOURCES` y lo dado de baja no resucita.
      sourcesAdmin: govStore,
      // Estado por proceso para la vista de Fuentes (#101): lo último conocido de la proyección (#105) +
      // salud con la MISMA clasificación de Frescura. Una lectura de proyección por GET; el motor, jamás.
      // Sin motor no se cablea: la vista queda como el registro puro (no se fabrican columnas de estado
      // donde no hay quien observe).
      processStates: fabricWiring.engine
        ? async () => {
            const f = await freshnessInputs()
            const reqOf = new Map(deriveIngestionMap(f.mapInput).map((m) => [m.processId, m.requiredCadenceSeconds]))
            const snaps = new Map((await govStore.listRunSnapshots()).map((s) => [s.processId, s]))
            const ahora = Date.now()
            const off = freshnessPollMs <= 0
            return f.procs
              .filter((p) => p.engine)
              .map((p) => {
                const s = snaps.get(p.id)
                const observedAt = s?.observedAt ?? null
                const runs = observedAt ? (s?.runs ?? []) : []
                const req = reqOf.get(p.id)
                const health = observedAt && req != null ? classifyProcess(runs, req, ahora) : undefined
                const stale = off || (observedAt != null && ahora - Date.parse(observedAt) > 3 * freshnessPollMs)
                return {
                  processId: p.id,
                  runs,
                  scheduleSeconds: observedAt ? (s?.scheduleSeconds ?? null) : null,
                  health,
                  projection: { observedAt, stale, lastError: s?.lastError ?? null, off },
                }
              })
          }
        : undefined,
      // Frescura por entidad de un dominio (vista de dominio): proyección por entidad enriquecida con
      // LO ÚLTIMO OBSERVADO del motor (#105) — corridas, schedule y salud salen de la proyección local
      // del store, no de una llamada al motor: el request path jamás pega a Fabric. Con el motor caído
      // la vista sigue sirviendo lo último conocido, marcado con su edad (`projection`).
      domainFreshness: async (domainId: string) => {
        const f = await freshnessInputs()
        const rows = deriveEntityFreshness(f.mapInput)
        const domainOfSource = new Map(f.sources.map((s) => [s.id, s.domain]))
        const procById = new Map(f.procs.map((p) => [p.id, p]))
        const inDomain = rows.filter((r) => {
          const proc = r.processId ? procById.get(r.processId) : undefined
          return proc != null && domainOfSource.get(proc.sourceId) === domainId
        })
        const snaps = new Map((await govStore.listRunSnapshots()).map((s) => [s.processId, s]))
        const ahora = Date.now()
        const off = freshnessPollMs <= 0
        return inDomain.map((r) => {
          const proc = r.processId ? procById.get(r.processId) : undefined
          if (!r.processId || !fabricWiring.engine || !proc?.engine) return { ...r, engine: false }
          const s = snaps.get(r.processId)
          const observedAt = s?.observedAt ?? null
          // Sin observación exitosa no se afirma NADA del motor: ni corridas, ni schedule.
          const runs = observedAt ? (s?.runs ?? []) : []
          const health = observedAt && r.requiredCadenceSeconds != null ? classifyProcess(runs, r.requiredCadenceSeconds, ahora) : undefined
          const stale = off || (observedAt != null && ahora - Date.parse(observedAt) > 3 * freshnessPollMs)
          return {
            ...r,
            engine: true,
            engineJobType: proc.engine.jobType,
            engineItemId: proc.engine.itemId,
            runs,
            health,
            actualScheduleSeconds: observedAt ? (s?.scheduleSeconds ?? null) : null,
            projection: { observedAt, stale, lastError: s?.lastError ?? null, off },
            ...(proc.pausedAt ? { paused: { at: proc.pausedAt, by: proc.pausedBy } } : {}),
          }
        })
      },
      // Pausa/reanudación de un proceso (#107). PAUSAR: el motor primero — si no acepta deshabilitar el
      // schedule, NADA se registra (jamás un «pausado» en el producto con el motor corriendo).
      // REANUDAR: se limpia el flag primero y se empuja la cadencia derivada; si el empuje falla, el lazo
      // converge en el tick siguiente (el proceso ya no está pausado) y la página muestra el estado real.
      pauseProcess: async (processId: string, paused: boolean, by: string) => {
        const engine = fabricWiring.engine
        if (!engine) throw new Error('Sin conexión al motor: no se puede pausar ni reanudar.')
        if (paused) {
          await engine.setScheduleEnabled(processId, false)
          await govStore.setProcessPaused(processId, true, by)
          auditLog.append({ type: 'frescura-pausa', process: processId, paused: true, by })
          return
        }
        await govStore.setProcessPaused(processId, false, by)
        auditLog.append({ type: 'frescura-pausa', process: processId, paused: false, by })
        const row = deriveIngestionMap((await freshnessInputs()).mapInput).find((m) => m.processId === processId)
        if (!row) return
        try {
          await engine.setScheduleSeconds(processId, row.requiredCadenceSeconds)
        } catch (e) {
          console.error('[vergis-rls] reanudar: no se pudo re-habilitar el schedule (el lazo converge):', e instanceof Error ? e.message : e)
        }
      },
      // Driver del reconciliador («aplicar cadencia»): empuja la cadencia derivada del proceso al schedule
      // del motor (one-way, idempotente). Devuelve el plan (set/noop) para feedback.
      applyCadence: async (processId: string, by: string) => {
        const engine = fabricWiring.engine
        if (!engine) throw new Error('Sin conexión al motor: no se puede aplicar la cadencia.')
        const f = await freshnessInputs()
        const map = deriveIngestionMap(f.mapInput)
        const row = map.find((m) => m.processId === processId)
        if (!row) throw new Error(`Proceso desconocido: ${processId}`)
        // #107 · aplicar cadencia a un pausado lo re-habilitaría (setScheduleSeconds escribe enabled:true).
        if (f.procs.find((p) => p.id === processId)?.pausedAt != null) throw new Error('El proceso está pausado — reanúdalo antes de aplicar cadencia.')
        const actual = await engine.getScheduleSeconds(processId)
        const plan = reconcilePlan(row.requiredCadenceSeconds, actual)
        if (plan.action === 'set') {
          await engine.setScheduleSeconds(processId, row.requiredCadenceSeconds)
          // Se RE-OBSERVA y se registra lo leído, nunca lo prometido (#105): el motor redondea el
          // schedule a minutos, y anotar el deseado fabricaría un dato falso que además taparía el
          // drift. Así la página refleja el schedule real apenas se recarga.
          const re = await engine.getScheduleSeconds(processId).catch(() => undefined)
          if (re !== undefined) await govStore.recordObservations([{ processId, observedAt: new Date().toISOString(), scheduleSeconds: re, runs: [] }])
        }
        auditLog.append({ type: 'frescura-aplicar-cadencia', process: processId, by, desiredSeconds: row.requiredCadenceSeconds, action: plan.action })
        return plan
      },
      identityOf: (h) => identityFor(h as GateHeaders),
      audit: (e) => auditLog.append(e),
      secret: CSRF_SECRET,
      brandTitle: INDEX_TITLE,
    })
    // Configuración por-PI (gateada por rol de PI, no admin): compartir/visibilidad/demanda.
    piConfig = createPiConfig({
      gov: govStore,
      resolve: (slug) => {
        const r = discover().find((x) => x.slug === slug)
        return r ? { code: r.code, name: r.name } : undefined
      },
      identityOf: (h) => identityFor(h as GateHeaders),
      roleOf: piManagementRole,
      ceilingFor: async (code) => {
        const r = discover().find((x) => x.code === code)
        return r ? govStore.ofertasForTables(r.tables) : []
      },
      audit: (e) => auditLog.append(e),
      secret: CSRF_SECRET,
      brandTitle: INDEX_TITLE,
    })
    console.log(`[vergis-rls] administración: ${entities.length} entidad(es) · ${ADMIN_SEED.length} admin semilla · ACL PI ${piAclEnabled ? 'ON' : 'off'} · store=${useFabricStore ? 'fabric' : 'sqlite'}`)
  } catch (e) {
    console.error(`[vergis-rls] administración deshabilitada: ${e instanceof Error ? e.message : String(e)}`)
  }
}
// ── MIRANDA (cluster 077) — el agente conversacional que autora specs. TODO detrás del flag ────────
// MIRANDA_ENABLED. Con el flag apagado nada de esto corre: `miranda` queda null → superficie cero.
if (config.miranda.enabled) {
  try {
    // Store: reusa el de gobierno si existe; si no, abre uno (Miranda necesita persistir sesiones).
    const govForMiranda = governance ?? (await SqliteGovernanceStore.open(GOVERNANCE_DB, { admins: ADMIN_SEED }))
    // Catálogo (allowlist de probes) — config de instancia (JSON: lista o {catalog:[…]}).
    const catalog: CatalogEntry[] = (() => {
      const p = config.miranda.catalogPath
      if (!p) return []
      try {
        const parsed = JSON.parse(readFileSync(resolve(p), 'utf8')) as CatalogEntry[] | { catalog?: CatalogEntry[] }
        return Array.isArray(parsed) ? parsed : (parsed.catalog ?? [])
      } catch (e) {
        console.error(`[vergis-rls] Miranda: catálogo no cargado (${e instanceof Error ? e.message : e}). Sin catálogo, las probes quedan sin objetos.`)
        return []
      }
    })()
    // Schema del DSL (para validar drafts) — mismos candidatos que runSpec.
    const mirandaSchema = (() => {
      for (const c of [resolve(dirname(fileURLToPath(import.meta.url)), '../schema/mira-spec.schema.json'), resolve(process.cwd(), 'schema/mira-spec.schema.json')]) {
        try {
          return JSON.parse(readFileSync(c, 'utf8')) as object
        } catch {
          /* siguiente candidato */
        }
      }
      return null
    })()
    // DSL doc + rúbrica QC① montados desde MIRANDA_RUBRIC_DIR (la instancia decide la versión).
    const readIf = (p: string): string | undefined => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    }
    const rubricDir = config.miranda.rubricDir
    const dslDoc = rubricDir ? readIf(join(resolve(rubricDir), 'dsl.md')) : undefined
    const rubric = rubricDir ? readIf(join(resolve(rubricDir), 'qc1.md')) : undefined
    const systemPrompt = buildSystemPrompt({ dslDoc })
    // Capacidades válidas de un draft (dato = conector enforcing; canales = render/publish/entrega).
    const MIRANDA_VALIDATE_CAPS = [...SERVING_CAPS, 'publicar-artefacto', 'render-html-piece', 'render-csv-piece', 'send-email', 'send-slack']
    const PROBE_REF = contract.env('MIRANDA_PROBE_DB') ?? (connections ? Object.keys(connections)[0] : '')
    // Identidad simplificada de la probe (Fase 1: audiencia interna, dominios grant:all). TODO Fase 2:
    // ligar la probe a la identidad autoritativa del autor (claims), como el serving.
    const probeIdentityOf = (email: string | undefined): IdentityContext => ({ agent: 'miranda-probe', user: email })

    const mirandaDeps: MirandaServerDeps = {
      gov: govForMiranda,
      transport: fetchAnthropicTransport({ apiKey: config.miranda.apiKey }),
      model: config.miranda.model,
      systemPrompt,
      rubric,
      maxTurns: config.miranda.maxTurns,
      tokenBudget: config.miranda.tokenBudget,
      catalog,
      identityOf: (h) => ({ user: identityFor(h as GateHeaders).user }),
      hasScope: async (email) => (await govForMiranda.isAdmin(email)) || (await govForMiranda.isMember(config.miranda.scopeGroup, email)),
      probe: async (sql, email) => {
        const out = (await servingCap.execute({ database_ref: PROBE_REF, sql }, probeIdentityOf(email))) as { rows: Record<string, unknown>[] }
        return { rows: out.rows ?? [] }
      },
      columnsOf: async (table) => {
        const [a, b] = table.includes('.') ? table.split('.') : [null, table]
        const sql = a
          ? `SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t ORDER BY ORDINAL_POSITION`
          : `SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION`
        const out = (await servingCap.execute({ database_ref: PROBE_REF, sql, params: a ? { s: a, t: b } : { t: b } }, probeIdentityOf(undefined))) as { rows: Record<string, unknown>[] }
        return (out.rows ?? []).map((r) => ({ name: String(r['name']), type: String(r['type']) }))
      },
      validateDraft: (yaml) => {
        if (!mirandaSchema) return { ok: false, error: 'Schema del DSL no disponible en el server.' }
        try {
          validateMiraSpec(parseMiraSpec(yaml), { capabilities: MIRANDA_VALIDATE_CAPS, schema: mirandaSchema })
          return { ok: true }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return { ok: false, error: msg }
        }
      },
      listSpecs: (): SpecRef[] => discover().map((r) => ({ code: r.code, name: r.name })),
      readSpec: (code) => {
        const r = discover().find((x) => x.code === code || x.slug === code.toLowerCase())
        if (!r) return null
        try {
          return readFileSync(r.specPath, 'utf8')
        } catch {
          return null
        }
      },
      writeSpec: async (filename, content) => {
        if (!SPECS_DIR) throw new Error('Miranda requiere VERGIS_SPECS_DIR para publicar (no hay directorio de specs).')
        writeFileSync(join(resolve(SPECS_DIR), filename), content)
      },
      renderPreviewHtml: async (draftYaml, headers) => {
        const tmp = join(OUT, `.miranda-preview-${randomBytes(8).toString('hex')}.yaml`)
        writeFileSync(tmp, draftYaml)
        try {
          const out = await runSpec({
            specPath: tmp,
            identity: identityFor(headers as GateHeaders),
            baseDir: OUT,
            registerStarters: false,
            extraCapabilities: [servingCap, renderHtmlPiece, renderCsvPiece, publicarArtefacto],
            interactiveMaxRows: INTERACTIVE_MAX_ROWS,
          })
          if (!out.ok) throw new Error(out.fallback?.reason ?? 'la preview no renderizó')
          return out.html ?? ''
        } finally {
          try {
            unlinkSync(tmp)
          } catch {
            /* noop */
          }
        }
      },
      secret: CSRF_SECRET,
      brandTitle: INDEX_TITLE,
      announce: config.miranda.announceWebhook
        ? async (message: string) => {
            await fetch(config.miranda.announceWebhook!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: message }) })
          }
        : undefined,
    }
    miranda = createMiranda(mirandaDeps)
    console.log(`[vergis-rls] Miranda ACTIVA · modelo=${config.miranda.model} · catálogo=${catalog.length} objeto(s) · scope=${config.miranda.scopeGroup}`)
  } catch (e) {
    console.error(`[vergis-rls] Miranda deshabilitada por error de arranque: ${e instanceof Error ? e.message : String(e)}`)
    throw e // el flag está ON: un fallo de arranque no debe degradar en silencio.
  }
}

const listening = () => {
  const r = discover()
  console.log(`[vergis-rls] engine=${ENGINE} · ${r.length} PI por-consumidor en ${HOST ? `${HOST}:${PORT}` : `:${PORT}`} · rutas: ${r.map((x) => '/' + x.slug).join(' ')}`)
}
if (HOST) server.listen(PORT, HOST, listening)
else server.listen(PORT, listening)

// Cierre graceful: `docker stop` envía SIGTERM. Cerrar el server drena los requests en vuelo antes de
// salir; el timeout evita colgar el shutdown si un request queda pegado.
process.on('SIGTERM', () => {
  console.log('[vergis-rls] SIGTERM — cerrando (drain de requests en vuelo)…')
  const t = setTimeout(() => process.exit(0), 10_000)
  t.unref()
  server.close(() => {
    clearTimeout(t)
    process.exit(0)
  })
})

// Bootstrap del motor de serving EN SEGUNDO PLANO: el server ya escucha. `healthz` responde 503 hasta
// `ready`; la Administración queda disponible sin esperar al motor. Retry INDEFINIDO con backoff: un
// fallo transitorio al arrancar (SQL/AAD/red) no debe dejar el server en 503 para siempre — se
// reintenta hasta que `ready` (fabric no tenía retry; CH moría tras 60 intentos).
void (async () => {
  let delay = 2000
  for (;;) {
    try {
      await bootstrapAll()
      return
    } catch (e) {
      console.error(`[vergis-rls] bootstrap falló (reintenta en ${delay / 1000}s): ${e instanceof Error ? e.message : String(e)}`)
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 60_000)
    }
  }
})()

// --- Hot-reload SIN restart (work/045) --------------------------------------
// Editar/añadir una spec ya es live (discover re-lee por request → ahora cacheado + invalidado on-change).
// El gap real era el policy store (se carga una vez al init): un PI nuevo sobre una tabla gobernada nueva
// necesitaba restart. `reloadGovernance` re-lee las políticas in-place (validate-before-swap), reconstruye
// el cache de specs y re-corre el gate de readiness. servingCap NO se reconstruye: un claim nuevo sin
// inyección queda fail-closed (deny), no fuga — su alta sigue necesitando restart (documentado en work/045).
// (`HOT_RELOAD` se define arriba, junto al registro del contrato operativo, que lo publica en `/contrato`.)

// Artefactos de gobierno EFECTIVAMENTE leídos por el proceso, por tipo — la lista se deriva de las
// MISMAS expresiones que el código usa para leerlos, así que no puede driftear. El contrato hashea
// cada uno al cargarlo y compara contra el disco en el GET: distinto ⇒ `pending` (el nodo no lo tomó).
const policyArtifacts = (): { source: string; path: string }[] => POLICY_PATHS.map((p) => ({ source: 'policies', path: resolve(p) }))
const specArtifacts = (): { source: string; path: string }[] => {
  try {
    return specPaths().map((p) => ({ source: 'specs', path: p }))
  } catch {
    return [] // el dir de specs no listable: el contrato no rompe nada (lo previo se conserva)
  }
}
const domainGovTargets = [
  ...(CONNECTIONS_FILE ? [CONNECTIONS_FILE] : []),
  ...(contract.env('VERGIS_DOMAINS') ? [resolve(contract.env('VERGIS_DOMAINS') as string)] : []),
  ...(contract.env('VERGIS_INTAKE') ? [resolve(contract.env('VERGIS_INTAKE') as string)] : []),
]
const domainArtifacts = (): { source: string; path: string }[] => domainGovTargets.map((p) => ({ source: 'dominio', path: p }))

/** Re-parsea conexiones + dominios + slots (issue #50) con validate-before-swap POR ARCHIVO: uno
 * malformado conserva su estado vigente y se loguea, los otros dos igual entran. Los swaps son
 * IN-PLACE sobre las referencias vivas que capturaron todos los consumidores. Sin secretos en logs:
 * de las conexiones solo se reportan conteos y refs, jamás perfiles. */
function reloadDomainGovernance(reason: string): void {
  if (CONNECTIONS_FILE && connections) {
    try {
      const diff = swapRecordInPlace(connections, parseConnections() ?? {})
      // El pool mssql de un ref YA conectado conserva sus credenciales hasta reciclarse (evict on
      // error) o un restart — el perfil cambiado aplica a conexiones futuras.
      for (const k of diff.changed) console.warn(`[hot-reload] conexión '${k}' cambió: un pool ya abierto conserva las credenciales previas hasta reciclarse.`)
      if (diff.added.length || diff.changed.length || diff.removed.length) {
        console.log(`[hot-reload] conexiones (${reason}): +${diff.added.length} nuevas · ${diff.changed.length} cambiadas · -${diff.removed.length} removidas (${Object.keys(connections).length} activas)`)
      }
    } catch (e) {
      console.error(`[hot-reload] recarga de conexiones falló (${reason}); perfiles vigentes conservados: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // Validate-before-swap (issue #50) endurecido por #117: con la clave raíz ausente el parser ahora
  // LANZA, así que el swap no ocurre y los dominios/slots vigentes sobreviven al archivo decapitado.
  reloadLiveList(domainsCfg, parseDomainsFile, 'dominios', reason)
  reloadLiveList(intakeSlotsCfg, parseIntakeFile, 'slots de ingesta', reason, console.log, console.error, 'slots')
}

function reloadGovernance(reason: string): void {
  // Primero el gobierno de dominio (conexiones/dominios/slots): el re-bootstrap de abajo ya debe ver
  // los perfiles nuevos para verificar un PI sobre un warehouse recién dado de alta (issue #50 + #52).
  reloadDomainGovernance(reason)
  const next = new Map<string, PolicyDecl>()
  try {
    loadPolicyStoreInto(next)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[hot-reload] recarga de políticas falló (${reason}); store vigente conservado: ${msg}`)
    // Sin artefactos: lo vigente se conserva y el contrato lo refleja solo (los artefactos previos no se
    // reemplazan, así que sus hashes siguen siendo los CARGADOS y el disco nuevo sale como `pending`).
    contract.record({ reason, ok: false, error: msg })
    return
  }
  store.clear()
  for (const [k, v] of next) store.set(k, v) // swap in-place tras parsear TODO ok (misma referencia que las clausuras capturaron)
  // Invalidar el result-cache: tras endurecer una policy, los hits cacheados servirían filas de la
  // política VIEJA hasta vencer el TTL. `clear()` existe si el conector está envuelto (withResultCache).
  const cached = servingCap as { clear?: () => void }
  if (typeof cached.clear === 'function') cached.clear()
  const r = discovery.rebuild()
  console.log(`[hot-reload] gobierno recargado (${reason}): ${store.size} política(s), ${discover().length} PI servible(s)${r.ok ? '' : ` · rebuild specs falló: ${r.error}`}`)
  // El contrato registra la recarga DONDE OCURRE, con los artefactos que acaban de entrar: sus hashes
  // son los EFECTIVAMENTE cargados, y el GET los compara contra el disco («¿tomaste mi archivo?»).
  contract.record(
    { reason, ok: true, ...(r.ok ? {} : { error: `rebuild de specs falló: ${r.error}` }), policies: store.size, servablePis: discover().length },
    [...policyArtifacts(), ...domainArtifacts(), ...(r.ok ? specArtifacts() : [])],
  )
  // Fail-closed en el reload, con radio de daño POR MOTOR (issue #52):
  // · clickhouse: la réplica es una sola → si el re-bootstrap falla NO se sigue sirviendo con las
  //   invariantes viejas — ready=false → healthz 503 hasta que un reload exitoso lo restablezca.
  // · fabric: el veredicto es POR PI y ya quedó swapeado dentro de bootstrapAll (el PI que no verifica
  //   se bloquea con motivo; los que ya servían y verifican siguen). Degradar el nodo entero acá era
  //   justamente el radio de daño que este issue elimina.
  void bootstrapAll().catch((e) => {
    const msg = e instanceof Error ? e.message : String(e)
    if (ENGINE === 'clickhouse') {
      ready = false
      lastErr = msg
      console.error(`[hot-reload] re-bootstrap (${reason}) falló → ready=false (fail-closed): ${msg}`)
      return
    }
    console.error(`[hot-reload] verificación por-PI (${reason}) con degradados: ${msg} — los PI sanos siguen sirviendo.`)
  })
}
// BOOT — el contrato registra el arranque con TODOS los artefactos que el proceso acaba de cargar
// (políticas, specs, gobierno de dominio). Desde acá, `/contrato` ya responde «¿tomaste mi archivo?»
// aunque nunca haya ocurrido una recarga.
contract.record({ reason: 'boot', ok: true, policies: store.size, servablePis: discover().length }, [
  ...policyArtifacts(),
  ...specArtifacts(),
  ...domainArtifacts(),
])

if (HOT_RELOAD) {
  const specTargets = SPECS_DIR ? [resolve(SPECS_DIR)] : SPECS_LIST.map((p) => resolve(p))
  // `contract.watch` instala el watch Y lo registra en una sola llamada: registrar y vigilar no pueden driftear.
  contract.watch(
    { envs: SPECS_DIR ? ['VERGIS_SPECS_DIR'] : ['VERGIS_SPECS'], reloads: 'specs: rebuild del descubrimiento + re-verificación por-PI (fabric)' },
    specTargets,
    () => {
      const r = discovery.rebuild()
      console.log(r.ok ? `[hot-reload] specs recargadas: ${discover().length} PI servible(s)` : `[hot-reload] rebuild de specs falló (se conserva el previo): ${r.error}`)
      contract.record(
        { reason: 'watch:specs', ok: r.ok, ...(r.ok ? {} : { error: r.error }), policies: store.size, servablePis: discover().length },
        r.ok ? specArtifacts() : undefined,
      )
      // fabric: un PI recién descubierto nace fail-closed («pendiente de verificación») — re-verificar
      // acá lo sirve sin esperar un reload de gobierno. Los degradados quedan logueados, el resto sigue.
      if (ENGINE === 'fabric' && r.ok && ready) {
        void bootstrapAll().catch((e) => console.error(`[hot-reload] verificación por-PI (watch:specs) con degradados: ${e instanceof Error ? e.message : String(e)}`))
      }
    },
  )
  if (POLICY_PATHS.length) {
    contract.watch(
      { envs: ['VERGIS_POLICIES'], reloads: 'gobierno completo: políticas (validate-before-swap) + rebuild specs + re-verificación' },
      POLICY_PATHS.map((p) => resolve(p)),
      () => reloadGovernance('watch:policies'),
    )
  }
  // Gobierno de dominio (issue #50): conexiones (si es archivo) + dominios + slots. La recarga es la
  // COMPLETA (reloadGovernance): un dominio nuevo llega con los tres a la vez y el re-bootstrap debe
  // verificar el PI nuevo contra el perfil nuevo — recargar solo el archivo tocado dejaría el alta a medias.
  if (domainGovTargets.length) {
    contract.watch(
      {
        // DERIVADO de qué archivos hay realmente: un env que no aporta ruta no se declara vigilado.
        envs: [
          ...(CONNECTIONS_FILE ? ['VERGIS_CONNECTIONS'] : []),
          ...(contract.env('VERGIS_DOMAINS') ? ['VERGIS_DOMAINS'] : []),
          ...(contract.env('VERGIS_INTAKE') ? ['VERGIS_INTAKE'] : []),
        ],
        reloads: 'gobierno completo (conexiones + dominios + slots) + re-verificación',
      },
      domainGovTargets,
      () => reloadGovernance('watch:dominio'),
    )
  }
  process.on('SIGHUP', () => reloadGovernance('SIGHUP'))
  contract.signal({ signal: 'SIGHUP', action: 'fuerza la recarga completa de gobierno (equivale a watch:policies)' })
  console.log(`[hot-reload] activo · specs=${specTargets.join(',')} · policies=${POLICY_PATHS.length} · gobierno-dominio=${domainGovTargets.length} (SIGHUP fuerza recarga de gobierno)`)
}
