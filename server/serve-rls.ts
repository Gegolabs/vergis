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
 *
 * Publicación de jobs en el motor (issue #107 fase 2) — Vergis publica la CÁSCARA del job (el item
 * que apunta al código del convertidor), nunca el código. Ver `docs/gestion-de-dominio.md`:
 *  - VERGIS_JOB_TEMPLATES  ruta al manifiesto de plantillas de la instancia (`job-templates.yaml`;
 *                          sus partes se resuelven relativas a él). SOLO-ARRANQUE: fail-closed y
 *                          fatal si el manifiesto o una parte no valida. Sin el env, la sección de
 *                          publicación no existe.
 *  - VERGIS_AUTHORING_SP   `database_ref` de VERGIS_CONNECTIONS con el perfil de credencial para la
 *                          AUTORÍA (opcional). Sin él, se usa el mismo SP del intake. Declarado y
 *                          no resoluble ⇒ el arranque LANZA (config rota, no default silencioso).
 */
import { createServer } from 'node:http'
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// `watchPaths` ya no se llama directo: TODO watch pasa por `contract.watch` (instala + registra en una
// sola llamada — ver server/contract.ts), que es quien lo invoca.
import { swapRecordInPlace, reloadLiveList } from './hot-reload'
import { loadInstanceConfig, loadSlice, RELOADABLE_SLICES } from './instance-config'
import { type NavQuery } from './nav'
import { hostname, tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { runSpec } from '@vergis/cli'
import { AppendOnlyLog, withResultCache, DEFAULT_GATE_MAPPING, type Capability, type GateHeaders, type IdentityContext, type LogEventInput } from '@vergis/botler'
import { applyCtx, parseSpec as parseMiraSpec, validateSpec as validateMiraSpec, type MiraSpec, type ResolverComentarios } from '@vergis/mira'
import {
  createMiranda,
  createMirandaUnavailable,
  mirandaTransportFrom,
  mirandaDestination,
  mirandaValidateCaps,
  previewIdentityFor,
  resolvePolicyFor,
  type MirandaServerDeps,
} from './miranda'
import { buildSystemPrompt, type CatalogEntry, type SpecRef } from '@vergis/miranda'
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
  createFabricItemAuthoring,
  SqliteMasterDataStore,
  createDwhMasterDataStore,
  createDwhPublisher,
  SqliteGovernanceStore,
  createControlPlane,
  resolveControlPlaneConfig,
  controlHandoverFile,
  evaluarRelevo,
  openNotasStore,
  llaveDeFila,
  canonicalKey,
  canOpen,
  deriveIngestionMap,
  deriveEntityFreshness,
  processBelongsToDomain,
  classifyProcess,
  reconcilePlan,
  createAsOfProvider,
  deriveRevertPlan,
  executeRevertPlan,
  DEFAULT_INTAKE_WATCH_MS,
  INTAKE_WATCH_STATE_KEY,
  parseIntakeWatchState,
  type SlotAlertReason,
  type OneLakeEntry,
  type OneLakeListing,
  type RetiroRegistrado,
  type RevertRef,
  type PiAsOf,
  type GroupSeed,
  type SourcesConfig,
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
  type ControlLeaseReason,
  type NotasStore,
  type NotasRenderContext,
  type SqliteControlOptions,
  type SqliteNotasStore,
  type SqlConnectionProfile,
  type TokenSource,
  importIdentityMapFile,
} from '@vergis/capabilities'
import { createAdmin, dupLabel, type AdminHandler, type IntakeRunner, type JobsPublishOps, type JobTemplateBundle, type RunLogsOps } from './admin'
import { createFreshnessLoop } from './freshness-loop'
import { createIntakeLoop, slotVigilanciaDeProyeccion, summarizeIntakeWatch, type IntakeLoopDeps } from './intake-loop'
import { createSinks, fanout, forEvent, type Notification, type ReportSchedule } from './notify'
import { createReportLoop, REPORT_CHECK_MS } from './report'
import type { CargasOps, IntakeUploadEvent } from './admin-cargas'
import { computeBound, unionInjections, type DatasetCfg, type BoundDataset } from './engines/clickhouse'
import { verifyFabricServability, createFabricSourceStateOf, maskViewCandidates, unmaskProbeSchemas, type PiVerdict } from './engines/fabric'
import { fail } from './http-util'
import { createRequestHandler } from './routes'
import { createPdfClient, pdfFilename } from './pdf'
import { createDiscovery, type Report } from './discovery'
import { createIdentity, clavesNoNormalizadas, IdentityProjection, type IdentityMap } from './identity'
import { configFromEnv, configEnvKeys, decideDevIdentity, decideFreshStore, deprecatedEnvWarnings, parsePreviewIdentities, type PreviewIdentity } from './config'
import { createContractRegistry, createContractHandler, type ControlContract } from './contract'
import { VERGIS_VERSION } from '../packages/capabilities/src/version'
import { createBackgroundLoops } from './control-loops'
import { createContractJournal } from './contract-delta'
import { avatarMenu, csrfFactory } from './ui'
import { indexHtml as renderCatalog } from './catalog'
import { createPiConfig, type PiConfigHandler } from './pi-config'
import { createNotas, sinDrills, type CongeladoPi, type NotasHandler } from './notas'
import { purgarRetencion, PURGA_INTERVALO_MS } from './notas-settings'
import type { MirandaHandler } from './miranda'
import { checkDeploymentConfig, reportDeploymentConfig, configCheckMode } from './deployment-check'
import {
  explainDenial,
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
const contract = createContractRegistry({
  engine: ENGINE,
  hotReload: HOT_RELOAD,
  // Bloque `control` (#210 · I6): un CLOSURE sobre las piezas vivas —lease, registro de lazos, guard de
  // cada store—, no una copia. `controlContract` está declarada abajo (hoisting) y solo se invoca en el
  // GET, cuando el plano ya existe.
  control: () => controlContract(),
  // Bloque `miranda` (#266 · #265): una superficie opcional ahora puede quedar APAGADA sin tumbar el
  // nodo — si el contrato no lo dijera, la degradación sería silenciosa. Closure sobre la config viva.
  miranda: () => ({
    enabled: config.miranda.enabled,
    requested: config.miranda.enabled || config.miranda.disabledReason != null,
    ...(config.miranda.disabledReason ? { disabledReason: config.miranda.disabledReason } : {}),
    ...(config.miranda.enabled ? { model: config.miranda.model } : {}),
    ...(config.miranda.enabled ? { baseUrl: mirandaDestination(config.miranda) } : {}),
  }),
})
contract.envKeys(configEnvKeys())
// Nivel 2 (#139): el journal del delta entre versiones vive donde vive el único estado persistente de
// la instancia — el volumen de `VERGIS_OUT` (`config.outDir`, junto a `governance.sqlite`). La imagen es
// genérica e instance-agnóstica: la referencia de «qué corría antes acá» no puede viajar en ella.
const contractJournal = createContractJournal({ dir: config.outDir })
/** `process.env` que REGISTRA cada acceso en el contrato — para los módulos que reciben el env entero
 *  y leen dentro (instance-config resuelve nombres dinámicamente: declararlos acá sería declararlos). */
const contractEnv: NodeJS.ProcessEnv = new Proxy(process.env, {
  get(target, prop, receiver) {
    if (typeof prop === 'string') contract.env(prop)
    return Reflect.get(target, prop, receiver)
  },
})

// --- PLANO DE CONTROL DEL NODO (#210 · I4) -----------------------------------------------------
// EXACTAMENTE UN nodo escribe. Los stores embebidos se vuelcan COMPLETOS en cada persist, y los cinco
// lazos de fondo (re-ingesta, purga, frescura, intake, reporte) escriben sin depender del tráfico: está
// MEDIDO que dos nodos vivos sobre el mismo volumen alternan el archivo de gobierno entre sus dos
// mundos, sin que llegue una sola petición, y que ninguno de los dos lo nota. De ahí que el control sea
// un lease sobre el volumen (`control-lease.ts`) y que de él cuelguen tres cosas:
//
//   · los LAZOS — se arman al adquirir el control y se desarman al soltarlo (nunca al boot);
//   · el MODO de apertura de cada store embebido — escritura con control, LECTURA sin él;
//   · las MUTACIONES HTTP — 409 nombrando al activo cuando este nodo no controla (ver routes.ts).
//
// `VERGIS_CONTROL=single` devuelve el mundo del nodo suelto, idéntico al de siempre: sin archivo de
// lease, sin heartbeat, control permanente. El default DE LA CAJA es `lease`, porque un operador que
// levanta un segundo nodo con `single` pierde gobierno sin un log que se lo diga.
//
// El env se lee por `contractEnv` a propósito: así estas claves quedan registradas en `/contrato` sin
// declararlas dos veces.
const CONTROL_CONFIG = resolveControlPlaneConfig(contractEnv, config.outDir)
/**
 * El INTENT DE HANDOVER (`control.handover.json`, hermano del lease en el mismo volumen). Lo escribe
 * el operador del acto —la herramienta de anillos— para NOMBRAR al sucesor de un relevo, y este nodo
 * lo consume al entrar a `intentarRelevo`. Ver la doctrina completa en `control-lease.ts`.
 */
const CONTROL_HANDOVER_FILE = controlHandoverFile(config.outDir)
/** Anillo que ejecuta este proceso (versión + digest). Informativo: viaja en el lease y en `/contrato`. */
const RING_NAME = (contract.env('VERGIS_RING') ?? '').trim() || null
const RING_DIGEST = (contract.env('VERGIS_RING_DIGEST') ?? '').trim() || null
/** Identidad de este nodo como aspirante al lease: legible, y única por proceso. */
const CONTROL_HOLDER = `vergis@${hostname()}/${process.pid}`
/** Los lazos de fondo, declarados donde antes se armaban y armados solo con el control. */
const loops = createBackgroundLoops()
const plane = createControlPlane(CONTROL_CONFIG, {
  holder: CONTROL_HOLDER,
  ring: RING_NAME,
  // UN intento por llamada: al arrancar, «hay un titular vivo» no es un fallo a reintentar — es la
  // respuesta, y este nodo queda en standby. Reintentar es el trabajo del poller de relevo (abajo).
  maxAttempts: 1,
  onLost: (reason, detail) => void controlPerdido(reason, detail),
})
/**
 * Opciones del plano de escritura para CADA store embebido. La época viaja como PROVEEDOR (`plane.epoch`),
 * no como número: un relevo la sube y el próximo persist la estampa sin que nadie la copie a mano. El
 * modo lo decide el control — sin control se abre en LECTURA, que es lo que vuelve imposible (y no solo
 * improbable) que un standby vuelque su snapshot encima de lo que el activo escribió.
 */
const storeControl = (): SqliteControlOptions => ({
  epoch: plane.epoch,
  writer: CONTROL_HOLDER,
  mode: plane.hasControl() ? 'write' : 'read',
})
// SUELTA EN EL CAMINO DE EXCEPCIÓN (#228). Se registra ANTES de adquirir, porque lo que protege es
// justamente la ventana que se abre al adquirir: la adquisición tiene que ocurrir acá arriba —el modo de
// apertura de cada store y el gate de época dependen de ella— y la validación de configuración sigue
// lanzando MÁS ABAJO (VERGIS_DATASETS, VERGIS_CONNECTIONS, la verificación de conexiones, el bloque de
// gobierno del reporte…), incluso después de que el primer store ya abrió. Un `throw` de arranque no
// pasa por el release ordenado —que cuelga de SIGTERM/SIGUSR2— y dejaba el lease con un titular que ya
// no existe y sin marca de release: el sucesor tenía que esperar el stale window contado desde la última
// renovación del muerto (MEDIDO por el frente arbol: ≈11,5 s en el caso peor, declarándose `standby`
// siendo el único nodo vivo).
//
// El handler de `exit` es el ÚNICO lugar que cubre el camino de excepción entero sin depender de dónde
// esté el throw: Node lo corre también tras una excepción no capturada (y tras el rechazo no manejado de
// la evaluación de este módulo, que es la forma que toma un throw de arranque en un ESM con top-level
// await). Corre síncrono y sin otro turno de event loop, de ahí `releaseSync`. Es idempotente y no pisa
// a un sucesor: relee y solo escribe si el titular sigue siendo este nodo. Un SIGKILL o un corte de luz
// siguen fuera de alcance — para eso está el stale window.
process.on('exit', () => {
  try {
    plane.releaseSync()
  } catch (e) {
    // Un fallo al soltar no puede cambiar el código de salida ni tapar la causa real de la muerte.
    console.error(`[control] no se pudo soltar el control al salir: ${e instanceof Error ? e.message : String(e)}`)
  }
})
// ADQUISICIÓN, antes de abrir un solo store: el modo de apertura depende de ella, y el gate de época del
// store se negaría a abrir en escritura con la época de un titular anterior.
const CONTROL_AL_ARRANCAR = await plane.acquire()
if (CONTROL_AL_ARRANCAR) {
  console.log(
    `[control] control ADQUIRIDO (modo ${plane.mode} · época ${plane.status().epoch} · titular ${CONTROL_HOLDER}` +
      `${RING_NAME ? ` · anillo ${RING_NAME}` : ''}): este nodo escribe y corre los lazos.`,
  )
} else {
  const st = plane.status()
  console.warn(
    `[control] EN ESPERA (standby): el control lo tiene '${st.observedHolder ?? '(desconocido)'}' ` +
      `(época ${st.observedEpoch ?? '?'}${st.reason ? ` · ${st.reason}` : ''}). Este nodo SIRVE LECTURAS, ` +
      `abre sus stores en modo lectura, no arma un solo lazo y responde 409 a las mutaciones.`,
  )
}

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
// #207 · Mapa VIVO de nombres visibles sobrescritos (código de PI → nombre). Se siembra al arrancar
// desde el gobierno y lo refresca la propia consola al renombrar: por eso un renombre se ve en el
// acto y NO exige desplegar, que es el roce entero del issue. Es un espejo de lectura, no la verdad:
// la verdad está en `pi_display_name` del store, y este mapa se re-deriva de ahí.
const displayNameOverrides = new Map<string, string>()
/** Re-siembra el mapa desde el gobierno. Se asigna donde el store existe; hasta entonces es un no-op
 *  y el catálogo sirve los nombres del spec — nunca falla el serving por un renombre. */
let refreshDisplayNames: () => Promise<void> = async () => {}

const discovery = createDiscovery({
  store,
  engine: ENGINE as 'clickhouse' | 'fabric',
  servingCaps: SERVING_CAPS,
  specPaths,
  resolveBases: (t) => viewLineage.get(t),
  displayNameOverride: (code) => displayNameOverrides.get(code),
})
const discover = discovery.discover
const visibleFor = discovery.visibleFor

// --- DIAGNÓSTICO DE LA NEGACIÓN (#165 §3) ------------------------------------
// El sujeto denegado por la CARDINALIDAD de su claim y el sujeto SIN claim producen hoy el mismo
// resultado observable —cero filas—, y ninguno de los dos se distingue de «no hay datos». Esto no
// cambia ni el enforcement ni la visibilidad: emite la línea que le faltaba al operador.
//
// Se emite al armar el índice porque es el único punto per-request que ya conoce identidad Y el
// conjunto de PIs — y en push-down las filas no pasan por este proceso, así que un diagnóstico
// colgado del resultado no existiría allá. Éste es función de (política, claims): vale en los dos
// motores por igual.
//
// DEDUPE deliberado y su límite: un índice se pide muchas veces por sesión y el mismo hallazgo
// inundaría el log hasta volverlo inútil. La clave es (usuario, tabla, causa), y el conjunto vive
// en memoria del proceso: un restart vuelve a emitir cada hallazgo una vez, que es exactamente lo
// que se quiere de un aviso de configuración. NO se acota su tamaño porque su cota es el producto
// (identidades que entran) × (tablas gobernadas) — del orden del padrón de la instancia, no del
// tráfico.
const denialSeen = new Set<string>()
/**
 * Identidades que el gate autenticó en la vida de este proceso (#159, capacidad 1: «cuántas no
 * resuelven a ninguna entrada»). El store de gobierno NO puede responderlo solo — ahí vive el mapa,
 * no el registro de quién entró—, así que el universo lo aporta el canal de serving.
 *
 * SU LÍMITE, DICHO: es lo observado DESDE EL ÚLTIMO ARRANQUE, no el padrón de la organización. Una
 * identidad que nunca entró no aparece, y eso es correcto: la pregunta del issue es cuántas de las
 * que llegan quedan sin claims. La cota del conjunto es el padrón, no el tráfico.
 */
const identitiesSeen = new Set<string>()
function reportDenials(identity: IdentityContext, reports: Report[]): void {
  const who = identity.user ?? '(sin identidad)'
  if (identity.user) identitiesSeen.add(identity.user.toLowerCase())
  for (const { table, denials } of discovery.diagnoseFor(reports, identity.claims ?? {})) {
    for (const d of denials) {
      const key = `${who}|${table}|${d.kind}`
      if (denialSeen.has(key)) continue
      denialSeen.add(key)
      // Nombra el claim, JAMÁS su valor: los claims son datos de la persona (área, cargo, nodo).
      console.warn(`[vergis-rls] sin filas para '${who}' en '${table}' — ${explainDenial(d)}`)
    }
  }
}

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
// Perfil de credencial para la AUTORÍA de jobs (#107 fase 2 · D9): un `database_ref` del MISMO
// VERGIS_CONNECTIONS, para que el camino de serving no porte un token capaz de reescribir
// definiciones. Sin el env, la autoría usa el SP del intake (default pragmático sellado).
// Declarado-y-no-resoluble es CONFIG ROTA, no un default silencioso: fatal al arranque, nombrando
// env, perfil y los perfiles disponibles (molde fail-closed de `instance-config.ts`). Se valida acá
// —top-level, fuera del try de administración— porque adentro moriría como «administración
// deshabilitada», que es exactamente el silencio que esto evita.
const AUTHORING_SP_REF = (process.env['VERGIS_AUTHORING_SP'] ?? '').trim() || null
if (AUTHORING_SP_REF && !connections?.[AUTHORING_SP_REF]) {
  const disponibles = Object.keys(connections ?? {})
  throw new Error(
    `VERGIS_AUTHORING_SP declara el perfil '${AUTHORING_SP_REF}', que no existe en VERGIS_CONNECTIONS ` +
      `(perfiles: ${disponibles.length ? disponibles.join(', ') : 'ninguno'}).`,
  )
}
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
    // El ingest del ARRANQUE es escritura igual que el del lazo: un nodo sin control no lo hace (dos
    // TRUNCATE+INSERT concurrentes duplican filas). El standby sirve la réplica que dejó el activo, y
    // `ready` no depende de esto — la readiness es del bootstrap del esquema, no de la carga.
    if (plane.hasControl()) await ingestAll()
    else console.warn('[control] ingesta del arranque OMITIDA: este nodo no tiene el control (sirve la réplica del activo).')
    ready = true; lastErr = null
  }
  // LAZO 1 · re-ingesta. Se DECLARA acá y lo arma el control (#210 · I4): la ingesta es TRUNCATE+INSERT,
  // así que dos nodos ingestando el mismo dataset dejan filas duplicadas — el propio mutex de arriba lo
  // dice para este proceso, y entre procesos el único mutex posible es el lease.
  if (REFRESH_MS > 0)
    loops.register({
      name: 're-ingesta',
      everyMs: REFRESH_MS,
      tick: () => ingestAll().catch((e) => console.error('[vergis-rls] re-ingesta:', e)),
    })
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
    // VISTAS DE MÁSCARA (#163): las candidatas se derivan del policy store. Derivar el nombre por
    // convención NO es confiar en él — el gate exige además corroboración de `sys`. El porqué
    // completo y el límite vive con la función, en ./engines/fabric.
    const maskViews = maskViewCandidates(store)
    // CENTINELA DE DESENMASCARADO (#238): los schemas donde buscarlo salen del MISMO store — son
    // aquellos con reglas de columna, los únicos donde la capacidad de desenmascarar es precondición
    // de servir. Se calculan acá y no dentro del motor para que el sondeo viaje en la misma ola de
    // consultas del arranque en frío (#138·3), sin una segunda vuelta de descubrimiento.
    const unmaskSchemas = unmaskProbeSchemas(store)
    const { state, usedRefs, refErrors, inherited, viewLineage: lineage } = await verifyFabricServability({
      pis: reports.map((r) => ({ slug: r.slug, tables: r.tables, databaseRefs: r.databaseRefs })),
      store,
      maskViews,
      sourceStateOf: createFabricSourceStateOf(
        (input) => dwh.execute(input, { agent: 'vergis' }) as Promise<{ rows: Record<string, unknown>[] }>,
        unmaskSchemas,
      ),
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
// a partir de su email corporativo), se resuelve contra un mapa de referencia { email → claims } —
// el TRUST-BASE sobre el que se aplica toda política. Fail-closed: email no mapeado → sin claim → deny.
//
// PRECEDENCIA archivo ↔ store (issue #159, hito 2). El mapa dejó de ser un archivo desplegado y pasó
// a ser ESTADO DE GOBIERNO, administrable y con procedencia. La regla:
//
// 1. `VERGIS_IDENTITY_MAP` sigue siendo legítimo, y es la SEMILLA: al arrancar se lee sincrónicamente
//    a la proyección (el store abre después, async, y el server ya escucha — sin esta semilla habría
//    una ventana sirviendo sin trust-base) y se IMPORTA al store como `autoritativa` vía
//    `importIdentityMapFile`, que reconcilia PRESERVANDO los overrides humanos.
// 2. Desde ese import, la FUENTE es el store: la proyección se refresca desde él, y es lo que la
//    Administración edita. El archivo solo vuelve a mandar cuando cambia (watch → re-import).
// 3. Sin `VERGIS_IDENTITY_MAP` no hay migración: el store es la única fuente desde el primer arranque.
//
// Es idempotente entre reinicios (la clave es el email normalizado): una instancia viva arranca sin
// perder claims ni duplicarlos.
const IDENTITY_MAP_FILE = contract.env('VERGIS_IDENTITY_MAP') ? resolve(contract.env('VERGIS_IDENTITY_MAP') as string) : null
/** Proyección EN MEMORIA del mapa (ver ./identity): `identityFor` es SÍNCRONO —así lo consume
 *  routes.ts— y el store es async; el resolver no puede hacer un `await` por request. */
const identityProjection = new IdentityProjection()
/** Claves del archivo que estaban MUERTAS por no estar normalizadas — el aviso de alcance de abajo. */
let identityClavesRevividas: string[] = []
if (IDENTITY_MAP_FILE) {
  // Sin try: un mapa ilegible o mal formado TUMBA EL ARRANQUE con nombre (patrón #117). Degradar a
  // «sin directorio» sería servir con el trust-base ausente, que es autorizar mal en silencio.
  const map = JSON.parse(readFileSync(IDENTITY_MAP_FILE, 'utf8')) as IdentityMap
  identityClavesRevividas = clavesNoNormalizadas(map)
  const n = identityProjection.seedFromMap(map)
  console.log(`[vergis-rls] mapa de identidad: ${n} entrada(s) desde VERGIS_IDENTITY_MAP (${IDENTITY_MAP_FILE}) — semilla; la fuente pasa al store de gobierno.`)
}
/** ¿El trust-base quedó SIN proyección viva habiendo gobierno de identidad declarado? Entonces el
 *  nodo NO sirve (gate `isReady` abajo): sin claims del directorio la política deniega, y devolver
 *  cero filas mudas a todo el mundo es peor que un 503 que se ve, se explica y se repara con una
 *  recarga. No se lanza desde `identityFor` porque routes.ts lo invoca sin try/catch (sería una
 *  excepción no capturada, no un 503). `/contrato` y Administración siguen en pie para diagnosticar. */
let identityTrustBroken = false

// Identidad del gate + claims enriquecidos desde el directorio: extraído y testeado en ./identity.
// El 3er argumento (dev identity) es null salvo en dev sin gate real — imposible de activar en prod.
const identityFor = createIdentity(gateClaims, identityProjection, config.devIdentity).identityFor

// CAPA DE NOTAS (vergis#84): impresiones + anotaciones + comentarios + compartición. Store embebido
// propio (`VERGIS_NOTES_DB`), abierto no-fatal: si falla, la capa queda deshabilitada con log y el
// serving sigue intacto — una nota no vale una caída.
let notasStore: NotasStore | null = null
/** El MISMO store, con su tipo concreto: el relevo lo reabre y el contrato lee su plano de escritura. */
let notasSqlite: SqliteNotasStore | null = null
let notasHandler: NotasHandler | null = null
// Gobierno de PI (autorización de ARTEFACTO, frente A). FLAG-GUARDED: con VERGIS_PI_ACL apagado el
// índice/apertura siguen por acceso-a-datos (comportamiento vivo); encendido, gatean por la ACL del
// PI (rol owner/collaborator/viewer) compuesta con la RLS de datos (que NUNCA se salta).
let governance: SqliteGovernanceStore | null = null
/** Store de data maestra EMBEBIDO (camino local/clickhouse). En `engine=fabric` la data maestra vive en
 *  el DWH y este handle no existe — por eso es nullable y el relevo lo reabre solo si está. */
let mdSqlite: SqliteMasterDataStore | null = null
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
// Dueños semilla de PI: REGISTRO VIVO (issue #138·2). `const` + swap in-place — quien lo consulta lo
// hace por clave a call-time (bootstrap de un PI sin gobierno), así que mutarlo recarga sin re-cablear.
const piOwners: Record<string, string> = {}
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
  const visible = piAclEnabled && governance
    ? await Promise.all(all.map((r) => piManagementRole(r.code, identity.user))).then((roles) => all.filter((_, i) => canOpen(roles[i])))
    : visibleFor(all, claims)
  // Sobre lo VISIBLE: un PI que el consumidor no puede abrir no tiene por qué explicar sus filas.
  reportDenials(identity, visible)
  return visible
}
const renderIndexPage = async (visible: Report[], identity: IdentityContext): Promise<string> => {
  const idxTitle = (governance ? await governance.getSetting('index_title') : null) || INDEX_TITLE
  const emailLc = (identity.user ?? '').toLowerCase()
  const isAdmin = governance ? await governance.isAdmin(emailLc) : false
  let hasDomains = isAdmin
  if (!hasDomains && governance && domainsCfg.length) {
    const ug = await governance.groupsOf(emailLc)
    // Las dos vías de grupo son unión (#183): el default-steward-group abre todos los dominios; un
    // `group:<id>` en los `stewards:` de un dominio abre ese. Los mismos grupos alimentan a las dos.
    hasDomains = ug.some((g) => stewardGroups.includes(g)) || manageableDomains(domainsCfg, emailLc, false, ug).length > 0
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
    // El trust-base de identidad es parte de la readiness: sin proyección viva no se sirve dato
    // gobernado (ver `identityTrustBroken`). Una recarga exitosa lo repara sin restart.
    isReady: () => ready && !identityTrustBroken,
    getAdmin: () => admin,
    // CONTRATO OPERATIVO (issue #139). Getter en CALL-TIME (como `getAdmin`/`getPiConfig`): `governance`
    // se asigna en el bootstrap async del bloque de administración, así que capturarlo acá daría null
    // para siempre. Sin store de gobierno el handler responde 403 con su motivo (no se apaga la ruta:
    // «no hay Administración» es una respuesta operativa, un 404 no lo es).
    getContract: () => createContractHandler({
      registry: contract,
      journal: contractJournal,
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
    // PLANO DE CONTROL (#210 · I5): sin control, `healthz` declara `standby` (200, pero NO `serving`) y
    // toda mutación de las superficies de gestión responde 409 nombrando al activo.
    control: { hasControl: () => plane.hasControl(), activeHolder: () => activeHolderLabel() },
  }),
)


// ── CAPA DE NOTAS (vergis#84) — impresiones · anotaciones · comentarios · compartición ────────────
// Apertura NO-FATAL (mismo patrón que el resto de los stores embebidos): si el archivo no abre, la
// capa queda deshabilitada con log y el nodo sigue sirviendo sus PIs. Una nota no vale una caída.
try {
  notasSqlite = await openNotasStore(contract.env('VERGIS_OUT') ?? tmpdir(), storeControl())
  notasStore = notasSqlite
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
  // LAZO 2 · purga de retención. Declarado, no armado: purgar es borrar, y borrar desde dos nodos sobre
  // el mismo store es la peor versión del last-writer-wins. El primer tick sigue cayendo a los 5 s de
  // armar — tras el bootstrap del gobierno, no compitiendo con él.
  loops.register({ name: 'purga-retención', everyMs: PURGA_INTERVALO_MS, firstDelayMs: 5000, tick: purga })
} catch (e) {
  console.error(`[vergis-rls] capa de notas deshabilitada: ${e instanceof Error ? e.message : String(e)}`)
}

// ADMINISTRACIÓN (no-fatal): data maestra + usuarios y roles — única superficie de ESCRITURA
// gobernada. Independiente del motor de serving. Se habilita si la instancia declara entidades
// (VERGIS_MASTER_DATA) o admins semilla (VERGIS_ADMIN_SEED). El store de data maestra es Fabric en
// engine=fabric (la fuente única que el PI lee por JOIN) y SQLite embebido en local/clickhouse.
let admin: AdminHandler | null = null
/** Seam del log de auditoría administrativa (`admin-audit.log`) para consumidores FUERA del bloque de
 *  administración, donde el `AppendOnlyLog` es un const local. Abrir un segundo `AppendOnlyLog` sobre
 *  el mismo archivo partiría la cadena de hashes (seq/prevHash propios), así que se expone el append
 *  del ÚNICO log. Null si la administración no arrancó: quien lo use debe tolerar su ausencia. */
let auditAppend: ((e: LogEventInput) => void) | null = null
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
// ARREGLOS VIVOS (issue #138·2): los consumidores (fan-out de alertas, lazo del reporte) capturan
// ESTA referencia y la iteran a call-time — la recarga los repuebla por splice, sin re-cablear nada.
const alertSinks = createSinks(forEvent(INSTANCE_CFG.notify, 'alerts'))
const reportSinks = createSinks(forEvent(INSTANCE_CFG.notify, 'reports'))
/** Destinos del aviso a quien SUBIÓ un archivo (#162·§6.3). Sin ninguno suscrito, el resolver del
 *  lazo persiste y muestra el desenlace igual: el registro no depende del canal. */
const cargasSinks = createSinks(forEvent(INSTANCE_CFG.notify, 'cargas-usuario'))
/** ¿La instancia tiene bloque de gobierno? Gatea el reporte — y su invariante se RE-verifica en cada
 *  recarga del slice notify (D5 de #138·2): `report:` no puede aparecer donde no hay qué reportar. */
const HAS_GOV_BLOCK = !!(process.env['VERGIS_MASTER_DATA'] || ADMIN_SEED.length)
// El reporte lee la proyección del store de gobierno: sin bloque de gobierno no hay qué reportar.
if (INSTANCE_CFG.notify.report && !HAS_GOV_BLOCK)
  throw new Error('VERGIS_NOTIFY declara report: pero la instancia no tiene bloque de gobierno (VERGIS_MASTER_DATA o VERGIS_ADMIN_SEED).')
/** Cadencia VIVA del reporte (issue #138·2): `null` = reporte apagado. El lazo la consulta por tick. */
let liveReportSchedule: ReportSchedule | null = INSTANCE_CFG.notify.report ?? null

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
    const govStore = await SqliteGovernanceStore.open(
      GOVERNANCE_DB,
      {
        admins: ADMIN_SEED,
        groups: groupSeeds,
        sources: sourceReg.sources,
        tableSources: sourceReg.tableSources,
        processes: sourceReg.processes,
        processOutputs: sourceReg.processOutputs,
      },
      storeControl(),
    )
    // P-238 · el handle del store de gobierno se publica AQUÍ MISMO, no 25 líneas más abajo: cualquier
    // excepción en el medio dejaba a Miranda abriendo un SEGUNDO handle de escritura del mismo archivo
    // (`governance ?? open(...)`), y dos handles del mismo archivo son dos escritores. Publicarlo en el
    // acto de abrirlo cierra la ventana: si el `open` falla no hay handle que publicar, y si falla
    // cualquier cosa después, Miranda reusa este.
    governance = govStore
    // #207 · Ahora que el store existe, el refresco del mapa de nombres visibles es real. Se siembra
    // de inmediato para que el catálogo nazca con los renombres ya aplicados, sin esperar al primer
    // POST de la consola.
    refreshDisplayNames = async (): Promise<void> => {
      try {
        const rows = await govStore.listDisplayNames()
        displayNameOverrides.clear()
        for (const [code, name] of Object.entries(rows)) displayNameOverrides.set(code, String(name))
      } catch (e) {
        // Fail-safe: sin overrides se sirve el nombre del spec. Un renombre que no se ve es un roce;
        // un catálogo que no se sirve por culpa del renombre sería un incidente.
        console.warn(`[vergis-rls] no se pudieron leer los nombres visibles sobrescritos: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await refreshDisplayNames()
    const adminStore = govStore
    // Gobierno de PI (frente A): el store ya quedó publicado en `governance` al abrirlo (ver P-238 arriba).
    piAclEnabled = ['1', 'true', 'on'].includes((process.env['VERGIS_PI_ACL'] ?? '').toLowerCase())
    defaultCollabGroups = (process.env['VERGIS_DEFAULT_COLLABORATOR_GROUPS'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const defaultStewardGroups = (process.env['VERGIS_DEFAULT_STEWARD_GROUPS'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    stewardGroups = defaultStewardGroups // idem: el avatar del catálogo decide si mostrar «Gestión»
    Object.assign(piOwners, INSTANCE_CFG.piOwners) // registro vivo: se puebla, no se reasigna
    const useFabricStore = ENGINE === 'fabric' && connections
    const mdStore = useFabricStore
      ? createDwhMasterDataStore(connections)
      : await SqliteMasterDataStore.open(process.env['VERGIS_MASTER_DATA_DB'] ?? `${OUT}/master-data.sqlite`, entities, storeControl())
    if (!useFabricStore) mdSqlite = mdStore as SqliteMasterDataStore // el handle embebido que el relevo reabre
    // Audit log LONGEVO (vive todo el proceso): modo file-only (retain:false) — append() no acumula
    // en RAM (crecía sin cota, una entrada por evento admin); la fuente de verdad es el archivo.
    const auditLog = new AppendOnlyLog(`${OUT}/admin-audit.log`, undefined, { retain: false })
    auditAppend = (e) => auditLog.append(e)
    // Ejecutor de INGESTA: write a OneLake (staging) + run-now del pipeline + lectura de estado de las
    // corridas (jobs/instances). Usa las creds del SP de una conexión (VERGIS_INTAKE_SP, o la única si
    // hay una sola) — token AAD para storage/Fabric REST, no para SQL. Sin slots o sin conexiones, no se ofrece.
    const fabricWiring = ((): {
      runner?: IntakeRunner
      status?: (slot: IntakeSlot) => Promise<RunRecord[]>
      logOf?: (slot: IntakeSlot) => Promise<string | null>
      cargas?: CargasOps
      backfill?: (slot: IntakeSlot) => void
      engine?: IngestionEngineClient
      runLogs?: RunLogsOps
      tokens?: TokenSource
      tokensRef?: string
      /** Lecturas del vigilante del intake (#161/#162): landing, corridas del trigger, retiros y los
       *  logs por corrida (de donde el resolver saca el motivo por archivo). */
      watch?: {
        landing: (slot: IntakeSlot) => Promise<OneLakeListing>
        runs: (slot: IntakeSlot) => Promise<RunRecord[]>
        retiros: (slot: IntakeSlot) => Promise<RetiroRegistrado[]>
        runLogs: { list: (slot: IntakeSlot) => Promise<OneLakeEntry[]>; read: (slot: IntakeSlot, path: string) => Promise<string | null> }
      }
    } => {
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
        // ── Lecturas del VIGILANTE del intake (issue #161) ──────────────────────────────────────
        // Van acá porque necesitan el reader y el jobStatus del SP, que viven en este bloque. Son las
        // ÚNICAS lecturas del lazo: el render nunca las usa (lee la proyección).
        watch: {
          // `listOrAbsent`, no `list`: para el vigilante, «el directorio del landing no existe» con
          // cargas registradas es una CONTRADICCIÓN, no un landing vacío (§3.3).
          landing: (slot: IntakeSlot) => reader.listOrAbsent(slot.target, slot.target.path),
          runs: (slot: IntakeSlot) => jobStatus.listInstances(slot.trigger?.workspaceId ?? slot.target.workspaceId, slot.trigger!.processRef, 10),
          // Retiros manuales (§3.3): el audit log del nodo es file-only (`retain:false`, verificado en
          // `AppendOnlyLog`) — no es consultable en proceso. La evidencia consultable del retiro es el
          // respaldo que la propia acción escribe: `_retirado/<epochMs>-<archivo>` (verificado en la
          // op `retire` de la consola). El prefijo ES el instante del retiro; sin él no se puede fechar
          // el respaldo contra la carga, así que la entrada se descarta en vez de inventarle una fecha.
          retiros: async (slot: IntakeSlot): Promise<RetiroRegistrado[]> => {
            const listado = await reader.listOrAbsent(slot.target, `${parentDir(slot.target.path)}/_retirado`)
            if (listado.kind === 'absent') return []
            const out: RetiroRegistrado[] = []
            for (const e of listado.entries) {
              if (e.isDirectory) continue
              const base = e.path.replace(/^.*\//, '')
              const m = /^(\d{10,})-(.+)$/.exec(base)
              if (!m) continue
              out.push({ filename: m[2]!, at: new Date(Number(m[1])).toISOString() })
            }
            return out
          },
          // Logs POR CORRIDA del slot (#99), insumo del RESOLVER (#162): de ahí sale el motivo que el
          // job declaró por archivo. `slotRunLogsDir` es null con `log: false`, que es una DECLARACIÓN
          // del slot: ese slot no escribe logs por corrida, así que una corrida fallida suya de verdad
          // no reporta causa y su desenlace honesto es `sin-informe` (no es ceguera de la plataforma).
          runLogs: {
            list: (slot: IntakeSlot) => {
              const dir = slotRunLogsDir(slot)
              return dir ? reader.list(slot.target, dir) : Promise.resolve([])
            },
            read: (slot: IntakeSlot, path: string) => reader.read(slot.target, path),
          },
        },
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
                // Desenlace resuelto por el lazo (#162): la columna de la Actividad lo lee de acá.
                // Se copia TAL CUAL — el motivo ausente se queda ausente: la celda dice que el job no
                // lo declaró, y rellenarlo en el camino sería fabricar la causa que #162 evita.
                if (r.desenlace != null) ev.desenlace = r.desenlace
                if (r.desenlaceMotivo != null) ev.desenlaceMotivo = r.desenlaceMotivo
                if (r.desenlaceRunStartedAt != null) ev.desenlaceRunStartedAt = r.desenlaceRunStartedAt
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
        // El `TokenSource` del SP del intake, expuesto para que la autoría de jobs (#107 fase 2, D9)
        // reuse ESTE proveedor cuando no hay perfil separado declarado: una segunda instancia sobre
        // el mismo perfil abriría un segundo caché de tokens por scope, sin ganar nada.
        tokens,
        ...(ref ? { tokensRef: ref } : {}),
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
    const notifySinks = alertSinks // el arreglo VIVO: la recarga lo repuebla in-place
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
          // INCONDICIONAL (issue #138·2): el closure se instala haya destinos o no, porque el arreglo
          // es vivo y un destino que aparece en caliente debe empezar a recibir SIN reconstruir el lazo
          // en vuelo. Con cero destinos, `fanout` es un no-op — el costo de instalarlo siempre es nulo.
          notify: (n: Notification) => fanout(notifySinks, n, (l) => console.error(`[vergis-rls] ${l}`)),
          domains: domainsCfg,
          audit: (e) => auditLog.append(e),
          log: (l) => console.log(`[vergis-rls] ${l}`),
        },
        { reconcile: reconcileAuto, reconcileDebounceMs, publicUrl: INSTANCE_CFG.publicUrl },
      )
      // LAZO 3 · frescura. El que la medición pilló escribiendo el store en cada vuelta sin una sola
      // petición: observa el motor, proyecta, alerta y reconcilia cadencias. Todo eso es control.
      loops.register({ name: 'frescura', everyMs: freshnessPollMs, firstDelayMs: 10_000, tick: () => loop.tick() })
      console.log(
        `[vergis-rls] lazo de frescura declarado (cada ${Math.round(freshnessPollMs / 1000)}s · reconcile ${reconcileAuto ? 'on' : 'off'} · ` +
          `${notifySinks.length ? `avisos ${notifySinks.length} destino(s)` : 'avisos off'})`,
      )
    }
    // Lazo de VIGILANCIA DEL INTAKE (#161): observa el landing y las corridas del trigger de cada
    // slot → proyección local; alerta al operador con dedup por transición. Hermano del de frescura,
    // no fase suya: otra unidad observada (el slot), otras fuentes (almacenamiento + motor, con modos
    // de falla independientes) y sin reconciliación (por requisito: detectar y avisar).
    //
    // Se cablea con `fabricWiring.watch`, que existe con el SP del intake resuelto — el motor NO es
    // requisito: sin `engine` la parte de corridas se omite y la del landing vigila igual.
    const intakeWatchMs = Number(contract.env('VERGIS_INTAKE_WATCH_MS') ?? DEFAULT_INTAKE_WATCH_MS)
    if (fabricWiring.watch && intakeWatchMs > 0) {
      const watch = fabricWiring.watch
      const deps: IntakeLoopDeps = {
        slots: () => intakeSlots,
        landing: watch.landing,
        // Control positivo (§3.3): la plataforma predice el landing con lo que ELLA MISMA registró al
        // subir. Solo las cargas VIVIDAS y aceptadas: una rechazada nunca aterrizó, y una fila `retro`
        // es un archivo ya archivado en `_processed/` que el indexado retroactivo dedujo.
        uploads: async (slotId) =>
          (await govStore.listUploads(slotId, 200)).filter((r) => r.origen === 'upload' && r.ok).map((r) => ({ filename: r.filename, uploadedAt: r.uploadedAt, ok: r.ok })),
        retiros: watch.retiros,
        runLogs: watch.runLogs,
        store: govStore,
        // Fan-out INCONDICIONAL al arreglo VIVO de destinos, igual que el lazo de frescura: un destino
        // que aparece en caliente empieza a recibir sin reconstruir el lazo. Con cero destinos es no-op.
        notify: (n: Notification) => fanout(notifySinks, n, (l) => console.error(`[vergis-rls] ${l}`)),
        // Aviso a QUIEN SUBIÓ (#162): otro flujo, otros destinos, mismo puerto. Arreglo VIVO también.
        // El destinatario individual lo resuelve el sink de email sustituyendo `$uploader`.
        notifyUploader: (n: Notification) => fanout(cargasSinks, n, (l) => console.error(`[vergis-rls] ${l}`)),
        domains: domainsCfg,
        log: (l) => console.log(`[vergis-rls] ${l}`),
      }
      if (fabricWiring.engine) deps.runs = watch.runs
      const loop = createIntakeLoop(deps, { publicUrl: INSTANCE_CFG.publicUrl, pollMs: intakeWatchMs })
      // LAZO 4 · vigilancia de cargas. CONSUME archivos del landing: dos nodos vigilando el mismo slot
      // procesarían dos veces la misma carga. Declarado; lo arma el control.
      loops.register({ name: 'vigilancia-de-cargas', everyMs: intakeWatchMs, firstDelayMs: 20_000, tick: () => loop.tick() })
      console.log(
        `[vergis-rls] vigilancia de cargas declarada (cada ${Math.round(intakeWatchMs / 60_000)} min · ` +
          `${fabricWiring.engine ? 'landing + corridas' : 'solo landing: sin motor cableado'} · ` +
          `${notifySinks.length ? `avisos ${notifySinks.length} destino(s)` : 'avisos off'})`,
      )
    } else if (intakeSlots.length) {
      console.log(`[vergis-rls] vigilancia de cargas apagada (${intakeWatchMs > 0 ? 'sin SP de intake' : 'VERGIS_INTAKE_WATCH_MS=0'})`)
    }
    // Reporte periódico de lo ejecutado (issue #102): latido incondicional — se envía SIEMPRE a la
    // hora configurada, con novedades o sin ellas. Un día sin correo = señal de problema, por diseño.
    // Independiente del lazo de frescura y del motor.
    //
    // El LAZO se arma siempre que hay bloque de gobierno (issue #138·2): el interval de 60 s cuesta
    // nada y la cadencia se consulta POR TICK, así que `report:` puede aparecer, cambiar de hora o
    // desaparecer en caliente. Gatearlo por `report:` al boot obligaba a un restart para encenderlo.
    const reportCfg = INSTANCE_CFG.notify.report
    const tzHost = Intl.DateTimeFormat().resolvedOptions().timeZone
    const reportLoop = createReportLoop(
      {
        store: govStore,
        inputs: freshnessInputs,
        domains: domainsCfg.map((d) => ({ id: d.id, label: d.label })),
        sinks: reportSinks, // arreglo VIVO: la recarga lo repuebla in-place
        audit: (e) => auditLog.append(e as LogEventInput),
        log: (l) => console.log(`[vergis-rls] ${l}`),
      },
      { schedule: () => liveReportSchedule, timezone: tzHost, baseUrl: INSTANCE_CFG.publicUrl, freshnessPollMs, engineCabled: !!fabricWiring.engine },
    )
    // LAZO 5 · reporte periódico. Dos nodos con el lazo armado = dos correos del mismo latido, y el
    // destinatario no tiene forma de saber cuál es el bueno. Declarado; lo arma el control. El primer
    // tick a los 15 s hace el catch-up de la ventana perdida, igual que antes.
    loops.register({ name: 'reporte-periódico', everyMs: REPORT_CHECK_MS, firstDelayMs: 15_000, tick: () => reportLoop.tick() })
    console.log(
      reportCfg
        ? `[vergis-rls] reporte periódico activo (${reportCfg.every === 'weekly' ? `semanal ${reportCfg.weekday ?? 'monday'}` : 'diario'} ` +
            `a las ${reportCfg.at} ${reportCfg.timezone ?? tzHost} · ${reportSinks.length} destino(s))`
        : '[vergis-rls] reporte periódico en espera: sin `report:` declarado (el lazo está declarado; declararlo en el yaml lo enciende sin restart)',
    )
    // ── Publicación de jobs en el motor (#107 fase 2 · §5 del diseño) ──────────────────────────
    // Se construye SOLO si están las piezas que la vuelven ejercible: plantillas declaradas por la
    // instancia (`VERGIS_JOB_TEMPLATES`) Y credencial de autoría resuelta. El tercer requisito del
    // fail-closed —el registro de fuentes escribible, donde aterriza el `engine_ref` de D10— lo
    // cumple `sourcesAdmin: govStore`, que existe siempre dentro de este bloque; el admin lo
    // re-verifica igual (`publicaOn`). Falta cualquiera ⇒ `jobsPublish` queda `undefined` y NADA
    // cambia: cero forms, rutas mudas, contrato de regresión cero de fase 1.
    const jobsPublish = ((): JobsPublishOps | undefined => {
      // `LoadedJobTemplate` (config) y `JobTemplateBundle` (admin) son la MISMA forma
      // (`{ template, partFiles }`) — `admin.ts` la declara estructuralmente para no depender del
      // cargador de config. Esta asignación no convierte nada: el typecheck es quien lo verifica.
      const templates: JobTemplateBundle[] = INSTANCE_CFG.jobTemplates
      if (!templates.length) return undefined // sin nada publicable, la sección no existe
      // D9: el perfil separado si se declaró (ya validado al top-level: acá existe o el proceso no
      // llegó hasta acá), y si no, el MISMO SP del intake — default pragmático sellado por César.
      const tokens = AUTHORING_SP_REF ? credentialProviderFor(connections![AUTHORING_SP_REF], { label: `database_ref '${AUTHORING_SP_REF}'` }) : fabricWiring.tokens
      if (!tokens) return undefined // sin credencial resuelta no hay quién autore
      const perfil = AUTHORING_SP_REF ?? fabricWiring.tokensRef ?? '?'
      console.log(`[vergis-rls] publicación de jobs activa: ${templates.length} plantilla(s) · credencial del perfil '${perfil}'${AUTHORING_SP_REF ? ' (VERGIS_AUTHORING_SP)' : ' (el del intake)'}`)
      return {
        templates,
        authoring: createFabricItemAuthoring(tokens),
        // El ledger append-only vive en el MISMO db de gobierno (su tabla nace en el `open` del
        // store) y sus ops son puras; el store es quien las expone porque es el dueño del `persist`.
        ledger: {
          lastOk: (sel) => govStore.lastOkPublication(sel),
          record: (row) => govStore.recordPublication(row),
          pendingUnknown: () => govStore.pendingUnknownPublications(),
          resolveUnknown: (id, resolution) => govStore.resolveUnknownPublication(id, resolution),
          list: (opts) => govStore.listPublications(opts),
        },
      }
    })()
    // Superficies de vigilancia en la consola de Cargas (#161·§6.1 · issue #161 punto 2): el render
    // de H6 recibe acá los datos que le faltaban. La op lee SOLO la proyección persistida del
    // vigilante (`listSlotSnapshots`) y el veredicto que el lazo dejó en `platform_setting` — dos
    // lecturas del store de gobierno local: el request path no lista OneLake ni consulta el motor,
    // igual que el tile del dashboard de más abajo.
    //
    // Se ofrece solo con el lazo EFECTIVAMENTE corriendo (`watch` cableado y `pollMs > 0`), que es la
    // misma condición del `if` que lo instala: con el vigilante apagado la proyección es un recuerdo
    // que nadie refresca, y la consola tiene que renderizar exactamente la página de siempre.
    const cargasOps: CargasOps | undefined =
      fabricWiring.cargas && fabricWiring.watch && intakeWatchMs > 0
        ? {
            ...fabricWiring.cargas,
            vigilancia: async (slot: IntakeSlot) => {
              // Fail-safe (mismo criterio que el parser de #161): estado ilegible ⇒ sin razón del
              // lazo, no sin vigilancia. Se pierde el matiz de la contradicción, no el banner.
              const [snapshots, razones] = await Promise.all([
                govStore.listSlotSnapshots(),
                govStore
                  .getSetting(INTAKE_WATCH_STATE_KEY)
                  .then((raw) => parseIntakeWatchState(raw))
                  .catch(() => ({}) as Record<string, SlotAlertReason>),
              ])
              return slotVigilanciaDeProyeccion(
                slot,
                snapshots.find((s) => s.slotId === slot.id),
                intakeWatchMs,
                Date.now(),
                razones[slot.id],
              )
            },
          }
        : fabricWiring.cargas
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
      cargas: cargasOps,
      // Registro de cargas (issue #62): dedup por contenido, pre-check y el indexado retroactivo.
      intakeUploads: govStore,
      // MAPA DE IDENTIDAD (#159): el store de gobierno ES la superficie administrable, y la recarga
      // en caliente se dispara desde la propia pantalla — sin esto, corregir una entrada exigiría el
      // SIGHUP, o sea el acto que interrumpe el servicio, que es justo lo que el issue vino a matar.
      identityClaims: govStore,
      onIdentityChange: (reason) => void reloadIdentityClaims(reason),
      // El universo para «cuántas no resuelven»: lo observado por el gate desde este arranque. No es
      // el padrón de la organización, y por eso la pantalla lo rotula así en vez de dar un número
      // con más autoridad de la que tiene.
      observedIdentities: async () => [...identitiesSeen],
      intakeBackfill: fabricWiring.backfill,
      // Acceso al log de una corrida (issue #99): la página `/corrida` y sus enlaces «Ver log».
      runLogs: fabricWiring.runLogs,
      signoutRd: SIGNOUT_RD || undefined,
      piCount: discover().length,
      // Tile «Cargas» del dashboard (#161·§6.1): resumen del vigilante desde la PROYECCIÓN — el
      // request path no lista OneLake. Sin vigilante cableado no se ofrece: un tile que diga «0 en
      // alerta» donde nadie está mirando sería la mentira exacta que el issue combate.
      intakeWatch: fabricWiring.watch
        ? async (domainIds: string[]) =>
            summarizeIntakeWatch(
              intakeSlots.filter((s) => domainIds.includes(s.domain ?? '')),
              await govStore.listSlotSnapshots(),
              intakeWatchMs,
              Date.now(),
            )
        : undefined,
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
      // Publicación de jobs en el motor (#107 fase 2): dependencia OPCIONAL. `undefined` = la
      // sección no existe (sin plantillas o sin credencial de autoría) — fail-closed D4.
      jobsPublish,
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
      // La PERTENENCIA del proceso al dominio se valida acá (fail-closed), igual que en `runLogs.refOf`:
      // la ruta autoriza el DOMINIO de la URL, pero el `process` llega en el formulario — sin esta
      // validación un steward del dominio A pausaría un proceso del dominio B.
      pauseProcess: async (domainId: string, processId: string, paused: boolean, by: string) => {
        const engine = fabricWiring.engine
        if (!engine) throw new Error('Sin conexión al motor: no se puede pausar ni reanudar.')
        const fin = await freshnessInputs()
        if (!processBelongsToDomain(domainId, processId, fin.procs, fin.sources)) throw new Error(`Proceso desconocido en el dominio: ${processId}`)
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
      applyCadence: async (domainId: string, processId: string, by: string) => {
        const engine = fabricWiring.engine
        if (!engine) throw new Error('Sin conexión al motor: no se puede aplicar la cadencia.')
        const f = await freshnessInputs()
        // Misma validación de pertenencia que en `pauseProcess`, por la misma razón (fail-closed).
        if (!processBelongsToDomain(domainId, processId, f.procs, f.sources)) throw new Error(`Proceso desconocido en el dominio: ${processId}`)
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
        return r ? { code: r.code, name: r.name, specName: r.specName } : undefined
      },
      onDisplayNameChange: () => void refreshDisplayNames(),
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
    const govForMiranda = governance ?? (await SqliteGovernanceStore.open(GOVERNANCE_DB, { admins: ADMIN_SEED }, storeControl()))
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
    // Roster de identidades inspeccionables en preview (#110·1, D1) — config de instancia. Sin la env
    // NO existe la feature: ni `?as=`, ni links, ni campos nuevos en la tool (superficie cero). Con la
    // env, un roster ilegible o inválido ABORTA el arranque (el catch de abajo re-lanza): un roster a
    // medias haría «verificar la RLS» sobre una ficción.
    const previewRoster: PreviewIdentity[] = (() => {
      const p = config.miranda.previewIdentitiesPath
      if (!p) return []
      let raw: string
      try {
        raw = readFileSync(resolve(p), 'utf8')
      } catch (e) {
        throw new Error(`MIRANDA_PREVIEW_IDENTITIES apunta a un roster ilegible (${resolve(p)}): ${e instanceof Error ? e.message : String(e)}`)
      }
      return parsePreviewIdentities(raw)
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
    // La lista la construye `mirandaValidateCaps` (server/miranda.ts) — testeable desde afuera.
    const MIRANDA_VALIDATE_CAPS = mirandaValidateCaps(SERVING_CAPS)
    const PROBE_REF = contract.env('MIRANDA_PROBE_DB') ?? (connections ? Object.keys(connections)[0] : '')
    // Identidad simplificada de la probe (Fase 1: audiencia interna, dominios grant:all). TODO Fase 2:
    // ligar la probe a la identidad autoritativa del autor (claims), como el serving.
    const probeIdentityOf = (email: string | undefined): IdentityContext => ({ agent: 'miranda-probe', user: email })
    /** UN solo riel de render de preview: el draft se escribe a un tmp y pasa por `runSpec`. Lo único
     *  que varía entre «con tu RLS» y «como <etiqueta>» es la `identity` — mismas capabilities, mismo
     *  motor, misma RLS data-anchored. */
    const renderDraftWith = async (draftYaml: string, identity: IdentityContext): Promise<string> => {
      const tmp = join(OUT, `.miranda-preview-${randomBytes(8).toString('hex')}.yaml`)
      writeFileSync(tmp, draftYaml)
      try {
        const out = await runSpec({
          specPath: tmp,
          identity,
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
    }

    const mirandaDeps: MirandaServerDeps = {
      gov: govForMiranda,
      // #265: el destino sale de la config (`MIRANDA_API_BASE_URL`); sin ella, el default del transporte.
      transport: mirandaTransportFrom(config.miranda),
      model: config.miranda.model,
      systemPrompt,
      rubric,
      maxTurns: config.miranda.maxTurns,
      tokenBudget: config.miranda.tokenBudget,
      catalog,
      identityOf: (h) => ({ user: identityFor(h as GateHeaders).user }),
      hasScope: async (email) => (await govForMiranda.isAdmin(email)) || (await govForMiranda.isMember(config.miranda.scopeGroup, email)),
      isAdmin: async (email) => govForMiranda.isAdmin(email),
      probe: async (sql, email) => {
        const out = (await servingCap.execute({ database_ref: PROBE_REF, sql }, probeIdentityOf(email))) as { rows: Record<string, unknown>[] }
        return { rows: out.rows ?? [] }
      },
      // ESCUDO DE COLUMNA (#163·H9): sin esta dep, Miranda no sondea NADA (fail-closed total). Con
      // ella, una columna con regla de máscara se nombra pero no se muestrea — que es la decisión
      // §4.4 del diseño: mentimos el valor, jamás el esquema. La resolución tabla↔dataset es
      // deliberadamente conservadora: ante ambigüedad devuelve `undefined`, o sea no se sondea.
      policyFor: (t) => resolvePolicyFor(store, t),
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
      renderPreviewHtml: async (draftYaml, headers) => renderDraftWith(draftYaml, identityFor(headers as GateHeaders)),
      // Roster vacío ⇒ el dep NO se cablea: la ruta `?as=` y los links quedan invisibles (D1).
      previewIdentities: previewRoster.length ? previewRoster.map((i) => ({ label: i.label, user: i.user, claims: i.claims })) : undefined,
      renderPreviewHtmlAs: previewRoster.length
        ? async (draftYaml, label) => {
            const it = previewRoster.find((i) => i.label === label)
            if (!it) throw new Error(`Identidad de preview no declarada: '${label}'.`)
            // El IdentityContext del roster TAL CUAL — sin enriquecer desde IdentityMap. `agent` es el
            // mismo que produce el gate en un request real (`DEFAULT_GATE_MAPPING.agent`), para que el
            // render impersonado sea idéntico a lo que esa identidad vería de verdad.
            return renderDraftWith(draftYaml, previewIdentityFor(it, DEFAULT_GATE_MAPPING.agent ?? 'vergis'))
          }
        : undefined,
      // D4: cada render impersonado se audita al log administrativo (el actor real siempre queda).
      audit: (e) => auditAppend?.(e as LogEventInput),
      secret: CSRF_SECRET,
      brandTitle: INDEX_TITLE,
      announce: config.miranda.announceWebhook
        ? async (message: string) => {
            await fetch(config.miranda.announceWebhook!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: message }) })
          }
        : undefined,
    }
    miranda = createMiranda(mirandaDeps)
    console.log(
      `[vergis-rls] Miranda ACTIVA · modelo=${config.miranda.model} · destino=${mirandaDestination(config.miranda)} · catálogo=${catalog.length} objeto(s) · scope=${config.miranda.scopeGroup}`,
    )
  } catch (e) {
    console.error(`[vergis-rls] Miranda deshabilitada por error de arranque: ${e instanceof Error ? e.message : String(e)}`)
    throw e // el flag está ON: un fallo de arranque no debe degradar en silencio.
  }
} else if (config.miranda.disabledReason) {
  // ── MIRANDA DEGRADADA (issue #266) ───────────────────────────────────────────────────────────────
  // La instancia la PIDIÓ y la configuración no alcanza. Antes esto abortaba el proceso desde
  // `configFromEnv` y, con `restart: unless-stopped`, dejaba el nodo en crashloop: caían TODOS los PIs
  // por una superficie que usa un grupo. Ahora la superficie se apaga a sí misma y lo dice por tres
  // canales: este log, `/contrato` y un 503 en su propia ruta.
  console.warn(`[miranda] deshabilitada: ${config.miranda.disabledReason}`)
  contract.caveat(`Miranda pedida (MIRANDA_ENABLED) y APAGADA por configuración: ${config.miranda.disabledReason}`)
  const govForGate = governance
  miranda = createMirandaUnavailable({
    reason: config.miranda.disabledReason,
    identityOf: (h) => ({ user: identityFor(h as GateHeaders).user }),
    // Mismo gate de grupo que la Miranda viva. Sin store de gobierno nadie tiene scope: fail-closed —
    // la razón es superficie de operación y no se filtra a quien no le corresponde.
    hasScope: async (email) =>
      govForGate ? (await govForGate.isAdmin(email)) || (await govForGate.isMember(config.miranda.scopeGroup, email)) : false,
    brandTitle: INDEX_TITLE,
  })
}

// ── Mapa identidad→claims: MIGRACIÓN archivo → store, y el store como fuente (issue #159, hito 2) ──
// Va DESPUÉS del bloque de administración (necesita el store abierto) y ANTES de `listen`: el nodo no
// empieza a servir con un trust-base a medio migrar.
if (governance) {
  const govId = governance
  try {
    if (IDENTITY_MAP_FILE) {
      const res = await importIdentityMapFile(govId, IDENTITY_MAP_FILE, { updatedBy: 'boot:VERGIS_IDENTITY_MAP' })
      console.log(
        `[vergis-rls] mapa de identidad importado al store (${IDENTITY_MAP_FILE}): ${res.escritas} escrita(s) · ` +
          `${res.conservadas} conservada(s) por override humano · ${res.retiradas} retirada(s) que el archivo ya no trae.`,
      )
      if (res.invalidas.length)
        console.warn(`[vergis-rls] mapa de identidad: ${res.invalidas.length} clave(s) del archivo NO son una entrada válida y no se importaron.`)
      // AVISO DE ALCANCE (hallazgo del hito 1). El resolver por archivo indexa las claves TAL CUAL y
      // busca en minúscula: una clave con mayúsculas o espacios estaba en el mapa y NO aplicaba. El
      // store normaliza, así que la migración las REVIVE — es una corrección, pero es un cambio de
      // alcance de autorización observable: esas personas pueden empezar a ver filas que ayer no
      // veían. Se anuncia con el conteo, sin nombrar a nadie (el log no es lugar para un padrón).
      if (identityClavesRevividas.length)
        console.warn(
          `[vergis-rls] AVISO DE ALCANCE · mapa de identidad: ${identityClavesRevividas.length} clave(s) del archivo no estaban ` +
            `normalizadas (mayúsculas o espacios) y por eso NO aplicaban su claim con el resolver por archivo. Al importarlas al ` +
            `store quedan normalizadas y AHORA SÍ aplican: esas identidades pueden ver filas que antes no veían. Revísalas en ` +
            `Administración si el alcance no es el que corresponde.`,
        )
    }
    const r = await identityProjection.refresh(govId)
    if (!r.ok) throw new Error(r.error ?? 'la lectura del mapa no devolvió resultado')
    console.log(`[vergis-rls] mapa de identidad: ${r.entradas} entrada(s) vigentes desde el store de gobierno (fuente).`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    identityProjection.markFailed(msg)
    console.error(`[vergis-rls] mapa de identidad: la carga desde el store de gobierno FALLÓ: ${msg}`)
    contract.record({ reason: 'boot:identidad', ok: false, error: msg })
  }
}
// FAIL-CLOSED del arranque: si hay gobierno de identidad declarado (archivo o store) y NO quedó
// ninguna proyección viva, el nodo no sirve. Con la semilla del archivo cargada SÍ se sirve aunque el
// import al store haya fallado: hay trust-base vigente —el mismo de ayer— y convertir la migración en
// una caída nueva sería peor que quedarse un rato con el archivo mandando.
if ((IDENTITY_MAP_FILE || governance) && !identityProjection.state.cargada) {
  identityTrustBroken = true
  console.error(
    '[vergis-rls] SIN TRUST-BASE DE IDENTIDAD: el nodo responde 503 (fail-closed). Administración y /contrato siguen en pie; ' +
      'una recarga (SIGHUP) que consiga leer el mapa lo restablece sin restart.',
  )
}

const listening = () => {
  const r = discover()
  console.log(`[vergis-rls] engine=${ENGINE} · ${r.length} PI por-consumidor en ${HOST ? `${HOST}:${PORT}` : `:${PORT}`} · rutas: ${r.map((x) => '/' + x.slug).join(' ')}`)
}
if (HOST) server.listen(PORT, HOST, listening)
else server.listen(PORT, listening)

// Cierre graceful: `docker stop` envía SIGTERM. Cerrar el server drena los requests en vuelo antes de
// salir; el timeout evita colgar el shutdown si un request queda pegado. El RELEASE ORDENADO del control
// va primero: desarmar los lazos (esperando el tick en vuelo, que termina en un volcado) y solo entonces
// dejar la marca de release, para que el sucesor adquiera sin pagar el stale window.
process.on('SIGTERM', () => {
  console.log('[vergis-rls] SIGTERM — cerrando (drain de requests en vuelo)…')
  const t = setTimeout(() => process.exit(0), 10_000)
  t.unref()
  void soltarControl('SIGTERM').finally(() => {
    server.close(() => {
      clearTimeout(t)
      process.exit(0)
    })
  })
})
contract.signal({ signal: 'SIGTERM', action: 'suelta el control (release ordenado) y cierra drenando los requests en vuelo' })

// SIGUSR2 = «SUELTA EL CONTROL Y QUEDA EN STANDBY» (#210 · §4.1). Es la señal del handover de una
// promoción: el nodo activo deja de escribir y de correr lazos, pero SIGUE SIRVIENDO — el conmutador
// mueve el tráfico después, en su propio paso. Nada se reinicia y nada se cae: el corte de servicio que
// esta ley quiere eliminar no ocurre porque el proceso no se va.
process.on('SIGUSR2', () => {
  console.log('[control] SIGUSR2 — soltando el control y quedando en standby (el serving no se interrumpe)…')
  void soltarControl('SIGUSR2')
})
contract.signal({ signal: 'SIGUSR2', action: 'suelta el plano de control y queda en standby (sin interrumpir el serving)' })

// ── El armado inicial de los lazos y el poller de relevo ───────────────────────────────────────────
// Los lazos se declararon durante el arranque (cinco `loops.register`); recién acá se arman, y solo si
// este nodo tiene el control. Un standby los deja declarados y desarmados: eso es lo que dice de sí
// mismo en el log y en `/contrato`, en vez de callar.
if (plane.hasControl()) {
  loops.arm()
  console.log(`[control] lazos ARMADOS (${loops.names().length}): ${loops.names().join(', ') || '(ninguno declarado)'}`)
} else {
  console.warn(
    `[control] lazos DESARMADOS (${loops.names().length} declarado(s): ${loops.names().join(', ') || 'ninguno'}) — ` +
      `este nodo no tiene el control. Ni observa, ni reconcilia, ni consume archivos, ni purga, ni reporta.`,
  )
}

/** Etiqueta del titular observado, para el 409 de las mutaciones y para el log. */
function activeHolderLabel(): string {
  const st = plane.status()
  if (st.held) return `este mismo nodo (${st.holder}, época ${st.epoch})`
  if (!st.observedHolder) return 'desconocido (el archivo de lease no declara titular)'
  return `'${st.observedHolder}' (época ${st.observedEpoch ?? '?'})`
}

/** Los stores embebidos vivos, con el nombre por el que se los nombra en el contrato y en el log. */
function embeddedStores(): { name: string; reopen: (c: SqliteControlOptions) => Promise<void>; status: () => ReturnType<SqliteGovernanceStore['controlStatus']> }[] {
  const out: { name: string; reopen: (c: SqliteControlOptions) => Promise<void>; status: () => ReturnType<SqliteGovernanceStore['controlStatus']> }[] = []
  if (governance) out.push({ name: 'gobierno', reopen: (c) => governance!.reopen(c), status: () => governance!.controlStatus() })
  if (notasSqlite) out.push({ name: 'notas', reopen: (c) => notasSqlite!.reopen(c), status: () => notasSqlite!.controlStatus() })
  if (mdSqlite) out.push({ name: 'data-maestra', reopen: (c) => mdSqlite!.reopen(c), status: () => mdSqlite!.controlStatus() })
  return out
}

/**
 * Reabre los stores embebidos desde disco con el plano de escritura de AHORA. Devuelve el nombre del
 * store que falló, o `null` si todos reabrieron. No lanza: quien la llama decide, y en el camino de
 * tomar el control la decisión es soltarlo de vuelta — cero controladores antes que uno que escribe
 * sobre un snapshot rancio.
 */
async function reabrirStores(): Promise<string | null> {
  for (const st of embeddedStores()) {
    try {
      await st.reopen(storeControl())
    } catch (e) {
      console.error(`[control] no se pudo reabrir el store '${st.name}': ${e instanceof Error ? e.message : String(e)}`)
      return st.name
    }
  }
  return null
}

/**
 * Hasta cuándo este nodo NO vuelve a aspirar al control (epoch ms). Lo fija el release explícito, y sin
 * él el handover no existe: MEDIDO en el arnés de dos nodos — el propio nodo que acababa de soltar
 * volvía a tomar el lease en la misma vuelta de su poller (la marca de release está justamente ahí para
 * que el sucesor no espere el stale window, y el que la dejó la ve primero). `SIGUSR2` significa «queda
 * en standby», así que se respeta una ventana de gracia del ancho del stale window: más que la cadencia
 * de poll del candidato, y menos que el timeout de una promoción. Pasada la ventana, si el candidato
 * nunca llegó a tomarlo, este nodo re-adquiere — que es el camino de vuelta que el diseño pide cuando la
 * promoción expira.
 */
let noAspirarHasta = 0

/** Suelta el control de forma ordenada: lazos desarmados (esperando el tick en vuelo) → release. */
let soltando: Promise<void> | null = null
function soltarControl(motivo: string): Promise<void> {
  if (soltando) return soltando
  soltando = (async () => {
    try {
      if (!plane.hasControl()) {
        console.log(`[control] ${motivo}: este nodo ya estaba en standby (nada que soltar).`)
        return
      }
      noAspirarHasta = Date.now() + CONTROL_CONFIG.staleMs
      await loops.disarm()
      console.log(`[control] ${motivo}: lazos desarmados (tick en vuelo esperado).`)
      // Los stores embebidos NO acumulan escrituras: cada operación termina en su propio volcado, así
      // que el «persist final» del release ordenado ES esperar el tick en vuelo — no hay buffer que
      // vaciar. Reabrir en modo LECTURA es lo que garantiza que de acá en adelante este proceso no
      // pueda volcar nada, ni por un camino que se nos haya pasado.
      await plane.release()
      const falló = await reabrirStores()
      if (falló) {
        console.error(
          `[control] ${motivo}: el control quedó soltado pero el store '${falló}' NO se pudo reabrir en modo lectura. ` +
            `Su handle sigue en escritura: un volcado suyo fallaría ruidoso contra el fencing, no en silencio.`,
        )
      }
      console.log(
        `[control] ${motivo}: control SOLTADO (época ${plane.status().epoch} conservada en la marca de release). Standby. ` +
          `Este nodo no vuelve a aspirar al control por ${CONTROL_CONFIG.staleMs} ms, para que el sucesor lo tome.`,
      )
    } finally {
      soltando = null
    }
  })()
  return soltando
}

/** Se invoca cuando el lease se pierde SIN haberlo soltado (relevo ajeno, archivo ilegible, reloj raro). */
let atendiendoPerdida = false
async function controlPerdido(reason: ControlLeaseReason, detail: string): Promise<void> {
  if (atendiendoPerdida) return
  atendiendoPerdida = true
  try {
    console.error(`[control] CONTROL PERDIDO (${reason}): ${detail}. Desarmando lazos y pasando a standby.`)
    await loops.disarm()
    const falló = await reabrirStores()
    if (falló) console.error(`[control] el store '${falló}' no se pudo reabrir en modo lectura tras perder el control.`)
  } finally {
    atendiendoPerdida = false
  }
}

/**
 * POLLER DE RELEVO — el único camino por el que un standby toma el control: cuando el activo dejó una
 * marca de release (promoción ordenada) o cuando dejó de renovar (crash). El lease decide si corresponde;
 * acá solo se pregunta, y se falla hacia CERO controladores: si los stores no reabren, se suelta.
 */
let intentandoRelevo = false
/** Última abstención por intent ajeno que se logueó: el poll corre cada 2 s y no debe inundar el log. */
let intentAjenoLogueado = ''
async function intentarRelevo(): Promise<void> {
  if (intentandoRelevo || plane.hasControl()) return
  // EL INTENT ORDENA LA FILA; JAMÁS OTORGA EL CONTROL. Quien no es el sucesor nombrado se abstiene
  // mientras el intent esté vigente; el nombrado aspira YA, saltándose la ventana de gracia que se
  // impone a sí mismo el nodo que acaba de soltar. Adquirir sigue pasando por `acquire()` entero
  // (marca de release, stale window, época, fencing): nada de eso se toca acá.
  //
  // ALCANCE — cierre PARCIAL de #232, por diseño: `releaseSync()` deja `{holder:'', epoch}` y
  // `#attempt()` concede ese archivo al PRIMERO que llegue sin mirar quién, así que el intent ordena
  // la fila SOLO entre quienes pasan por `intentarRelevo`; la marca de release sigue siendo subasta
  // abierta para cualquier camino que no pase por ahí. No es un hueco por tapar: convertir el intent
  // en autoridad exigiría meterlo dentro de `acquire()`, y eso es justamente lo que no se hace.
  const decision = evaluarRelevo({ file: CONTROL_HANDOVER_FILE, self: RING_NAME, noAspirarHasta })
  if (decision.verdict === 'ilegible') console.warn(`[control] intent de handover ilegible: ${decision.detail}. Rige el protocolo de siempre.`)
  if (!decision.aspirar) {
    if (decision.verdict === 'ajeno' && decision.detail !== intentAjenoLogueado) {
      intentAjenoLogueado = decision.detail ?? ''
      console.log(`[control] relevo: este nodo NO aspira — ${decision.detail}`)
    }
    return
  }
  intentAjenoLogueado = ''
  if (decision.saltaGracia) console.log(`[control] relevo DIRIGIDO: ${decision.detail} — se aspira sin esperar la ventana de gracia.`)
  intentandoRelevo = true
  try {
    if (!(await plane.acquire())) return
    console.log(`[control] RELEVO: control adquirido con la época ${plane.status().epoch}. Reabriendo stores desde disco…`)
    const falló = await reabrirStores()
    if (falló) {
      console.error(`[control] RELEVO ABORTADO: el store '${falló}' no reabrió en escritura. Se suelta el control y se vuelve a standby.`)
      await plane.release()
      return
    }
    loops.arm()
    console.log(`[control] RELEVO completo: lazos ARMADOS (${loops.names().join(', ') || 'ninguno declarado'}).`)
  } finally {
    intentandoRelevo = false
  }
}
if (plane.mode === 'lease') {
  // EL WATCH DEL INTENT — el camino rápido. La aparición (o el cambio) de `control.handover.json`
  // dispara el relevo de inmediato, sin esperar el tick del poll. Va por `contract.watch` como todos
  // los demás watches del proceso: instalar y registrar en una sola llamada, y así queda visible en
  // `/contrato`. NO cuelga de `VERGIS_HOT_RELOAD`: esto es del plano de control, no de la recarga de
  // configuración — apagar el hot-reload de specs no debe dejar el relevo dirigido sin su camino rápido.
  contract.watch(
    { envs: [], reloads: 'intent de handover: despierta el relevo dirigido (el intent nombra al sucesor; no otorga el control)' },
    [CONTROL_HANDOVER_FILE],
    () => void intentarRelevo(),
  )
  // EL POLL DE RESPALDO. Cadencia = la de renovación: un poll es leer un JSON chico, y esperar más
  // alargaría el hueco de control tras un crash sin comprar nada. Ahora lee TAMBIÉN el intent, así que
  // un evento de watch perdido —inotify no propagado por un bind-mount, ráfaga comida— enlentece el
  // protocolo hasta el próximo tick, no lo rompe. El timer va `unref`: un standby esperando su turno
  // no es razón para que el proceso no pueda terminar.
  const relevo = setInterval(() => void intentarRelevo(), Math.max(500, CONTROL_CONFIG.renewMs))
  relevo.unref?.()
}

/** El bloque `control` de `/contrato` (#210 · I6) — derivado de las piezas vivas, no declarado. */
function controlContract(): ControlContract {
  const st = plane.status()
  return {
    mode: plane.mode,
    lease: {
      holder: st.holder,
      epoch: st.epoch,
      renewedAt: st.lastRenewAt ?? null,
      held: st.held,
      ...(st.observedHolder !== undefined ? { observedHolder: st.observedHolder } : {}),
      ...(st.observedEpoch !== undefined ? { observedEpoch: st.observedEpoch } : {}),
      ...(st.reason ? { reason: st.reason } : {}),
      ...(st.reasonDetail ? { reasonDetail: st.reasonDetail } : {}),
      file: st.file,
    },
    // El digest lo declara la INSTALACIÓN (la herramienta de anillos): mientras no lo haga, `null` es la
    // ausencia honesta — inventarlo desde la imagen sería afirmar una identidad que nadie verificó.
    ring: { version: VERGIS_VERSION, digest: RING_DIGEST, name: RING_NAME },
    loops: { armed: loops.armed(), detail: loops.status() },
    store: embeddedStores().flatMap((s) => {
      const cs = s.status()
      if (!cs) return []
      return [
        {
          name: s.name,
          file: cs.file,
          mode: cs.mode,
          schemaSupported: cs.schemaSupported,
          fileVersion: cs.fileVersion,
          epoch: cs.epoch,
          fileEpoch: cs.fileEpoch,
          degraded: cs.degraded,
          ...(cs.degradedReason ? { degradedReason: cs.degradedReason } : {}),
        },
      ]
    }),
  }
}

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
const identityArtifacts = (): { source: string; path: string }[] => (IDENTITY_MAP_FILE ? [{ source: 'identidad', path: IDENTITY_MAP_FILE }] : [])

/**
 * Recarga del MAPA DE IDENTIDAD (issue #159, hito 2). Dos caminos, un solo swap:
 *
 * · `desdeArchivo` — el watch de `VERGIS_IDENTITY_MAP` disparó: se re-importa el archivo al store
 *   (reconciliación que PRESERVA los overrides humanos) y luego se proyecta desde el store. Sin store
 *   de gobierno, el archivo se proyecta directo — es lo único que hay.
 * · sin él — la fuente es el store (edición en Administración, SIGHUP, recarga de gobierno).
 *
 * NUNCA lanza y NUNCA degrada lo vigente: el swap de la proyección ocurre solo con el mapa completo
 * ya construido (validate-before-swap en `IdentityProjection`), y una recarga fallida conserva la
 * proyección viva y lo grita. Si el trust-base estaba roto y esta recarga lo repara, el nodo vuelve a
 * servir sin restart — que es la promesa entera de la capacidad 4 del issue.
 */
async function reloadIdentityClaims(reason: string, opts: { desdeArchivo?: boolean } = {}): Promise<void> {
  try {
    if (opts.desdeArchivo && IDENTITY_MAP_FILE && !governance) {
      // Parsear ANTES de tocar la proyección: un archivo roto conserva el mapa vigente.
      const map = JSON.parse(readFileSync(IDENTITY_MAP_FILE, 'utf8')) as IdentityMap
      const revividas = clavesNoNormalizadas(map)
      const n = identityProjection.seedFromMap(map)
      if (revividas.length)
        console.warn(`[hot-reload] AVISO DE ALCANCE · mapa de identidad (${reason}): ${revividas.length} clave(s) sin normalizar ahora SÍ aplican su claim.`)
      console.log(`[hot-reload] mapa de identidad (${reason}): ${n} entrada(s) desde el archivo (sin store de gobierno).`)
      contract.record({ reason: `identidad:${reason}`, ok: true }, identityArtifacts())
    } else if (governance) {
      if (opts.desdeArchivo && IDENTITY_MAP_FILE) {
        const res = await importIdentityMapFile(governance, IDENTITY_MAP_FILE, { updatedBy: `${reason}:VERGIS_IDENTITY_MAP` })
        console.log(`[hot-reload] mapa de identidad re-importado (${reason}): ${res.escritas} escrita(s) · ${res.conservadas} conservada(s) por override · ${res.retiradas} retirada(s).`)
      }
      const r = await identityProjection.refresh(governance)
      if (!r.ok) throw new Error(r.error ?? 'lectura del mapa sin resultado')
      console.log(`[hot-reload] mapa de identidad (${reason}): ${r.entradas} entrada(s) vigentes desde el store.`)
      contract.record({ reason: `identidad:${reason}`, ok: true }, opts.desdeArchivo ? identityArtifacts() : undefined)
    } else {
      return // ni archivo ni store: no hay directorio que recargar
    }
    if (identityTrustBroken && identityProjection.state.cargada) {
      identityTrustBroken = false
      console.log(`[hot-reload] trust-base de identidad restablecido (${reason}): el nodo vuelve a servir sin restart.`)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Sin artefactos en el record: los hashes previos sobreviven y `/contrato` muestra el archivo del
    // disco como `pending` — «hay algo ahí que este nodo NO tomó».
    console.error(`[hot-reload] recarga del mapa de identidad falló (${reason}); proyección vigente conservada (${identityProjection.size} entrada(s)): ${msg}`)
    contract.record({ reason: `identidad:${reason}`, ok: false, error: msg })
  }
}

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

// ── Config de INSTANCIA recargable (issue #138·2) ────────────────────────────────────────────────
// Rutas de los slices recargables, DERIVADAS de qué envs hay realmente (mismo criterio que
// `domainGovTargets`): un env que no aporta ruta no se declara vigilado ni se recarga.
const NOTIFY_PATH = contract.env('VERGIS_NOTIFY') ? resolve(contract.env('VERGIS_NOTIFY') as string) : null
const PI_OWNERS_PATH = contract.env('VERGIS_PI_OWNERS') ? resolve(contract.env('VERGIS_PI_OWNERS') as string) : null
const SOURCES_PATH = contract.env('VERGIS_SOURCES') ? resolve(contract.env('VERGIS_SOURCES') as string) : null
const instanceArtifacts = (): { source: string; path: string }[] => [
  ...(NOTIFY_PATH ? [{ source: 'notify', path: NOTIFY_PATH }] : []),
  ...(PI_OWNERS_PATH ? [{ source: 'pi-owners', path: PI_OWNERS_PATH }] : []),
  ...(SOURCES_PATH ? [{ source: 'sources', path: SOURCES_PATH }] : []),
]

/**
 * Recarga la config de instancia POR ARCHIVO (D4 de #138·2): cada slice se re-parsea con su propio
 * parser y hace validate-before-swap por su cuenta — un `notify.yaml` roto NO impide que un
 * `sources.yaml` sano entre. NUNCA lanza: los errores de arranque tumban el proceso, una recarga jamás.
 *
 * Cada slice deja su propio `contract.record`: el sano registra su artefacto (hash del que entró), el
 * roto registra `ok:false` SIN artefactos — así el hash previo sobrevive y `/contrato` muestra el
 * archivo de disco como `pending` («no tomé lo que hay ahí»).
 */
function reloadInstanceSlices(reason: string): void {
  // ── notify: destinos de aviso + cadencia del reporte ──
  if (NOTIFY_PATH) {
    try {
      const next = loadSlice(contractEnv, RELOADABLE_SLICES.notify) ?? { destinations: [] }
      // D5: los invariantes de BOOT se re-verifican en la recarga, y su incumplimiento RECHAZA EL
      // SLICE (no el proceso). Ambos dependen de env/wiring, que no pueden aparecer en caliente.
      if (next.destinations.length > 0 && !INSTANCE_CFG.publicUrl)
        throw new Error('declara destinos pero falta VERGIS_PUBLIC_URL (los avisos llevan enlaces absolutos); es una env: exige restart.')
      if (next.report && !HAS_GOV_BLOCK)
        throw new Error('declara report: pero la instancia no tiene bloque de gobierno (VERGIS_MASTER_DATA o VERGIS_ADMIN_SEED).')
      // `createSinks` LANZA ante `passEnv` ausente o `caFile` ilegible (#100/#102) — construir ANTES
      // de tocar los arreglos vivos es lo que convierte ese throw en «se conserva lo vigente».
      const nextAlerts = createSinks(forEvent(next, 'alerts'))
      const nextReports = createSinks(forEvent(next, 'reports'))
      const nextCargas = createSinks(forEvent(next, 'cargas-usuario'))
      alertSinks.splice(0, alertSinks.length, ...nextAlerts)
      reportSinks.splice(0, reportSinks.length, ...nextReports)
      cargasSinks.splice(0, cargasSinks.length, ...nextCargas)
      liveReportSchedule = next.report ?? null
      console.log(
        `[hot-reload] avisos (${reason}): ${alertSinks.length} destino(s) de alerta · ${reportSinks.length} de reporte · ${cargasSinks.length} de cargas-usuario · ` +
          `reporte ${liveReportSchedule ? `${liveReportSchedule.every} a las ${liveReportSchedule.at}` : 'apagado'}`,
      )
      contract.record({ reason, ok: true }, [{ source: 'notify', path: NOTIFY_PATH }])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[hot-reload] recarga de avisos falló (${reason}); destinos vigentes conservados: VERGIS_NOTIFY (${NOTIFY_PATH}): ${msg}`)
      contract.record({ reason, ok: false, error: `notify: ${msg}` })
    }
  }
  // ── pi-owners: dueños semilla, swap del registro vivo ──
  if (PI_OWNERS_PATH) {
    try {
      const next = loadSlice(contractEnv, RELOADABLE_SLICES.piOwners) ?? {}
      const diff = swapRecordInPlace(piOwners, next)
      if (diff.added.length || diff.changed.length || diff.removed.length)
        console.log(`[hot-reload] dueños de PI (${reason}): +${diff.added.length} · ${diff.changed.length} cambiados · -${diff.removed.length} (${Object.keys(piOwners).length} declarados)`)
      contract.record({ reason, ok: true }, [{ source: 'pi-owners', path: PI_OWNERS_PATH }])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[hot-reload] recarga de dueños de PI falló (${reason}); mapa vigente conservado: VERGIS_PI_OWNERS (${PI_OWNERS_PATH}): ${msg}`)
      contract.record({ reason, ok: false, error: `pi-owners: ${msg}` })
    }
  }
  // ── sources: re-siembra del registro de fuentes (la MISMA proyección de open(), D1) ──
  if (SOURCES_PATH && governance) {
    const store = governance
    void (async (): Promise<void> => {
      try {
        // `?? { sources: [] }` es inalcanzable acá (SOURCES_PATH no-nulo ⇒ el env está declarado); va
        // por totalidad del tipo, no por conducta esperada.
        const next: SourcesConfig = loadSlice(contractEnv, RELOADABLE_SLICES.sources) ?? { sources: [] }
        // `reseed` valida TODO antes del primer write: una semilla rota no deja el store a medias.
        // Los lectores (frescura, as-of, vistas) re-leen el store por tick/request: nada que re-cablear.
        await store.reseed({ sources: next.sources, tableSources: next.tableSources, processes: next.processes, processOutputs: next.processOutputs })
        console.log(`[hot-reload] registro de fuentes re-sembrado (${reason}): ${(await store.listSources()).length} fuente(s) · ${(await store.listProcesses()).length} proceso(s)`)
        contract.record({ reason, ok: true }, [{ source: 'sources', path: SOURCES_PATH }])
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`[hot-reload] re-siembra de fuentes falló (${reason}); registro vigente conservado: VERGIS_SOURCES (${SOURCES_PATH}): ${msg}`)
        contract.record({ reason, ok: false, error: `sources: ${msg}` })
      }
    })()
  }
}

function reloadGovernance(reason: string): void {
  // El mapa identidad→claims es gobierno como cualquier otro (issue #159): entra en la recarga
  // completa. Es async y no bloquea al resto — su swap es atómico y no hay orden que respetar con las
  // políticas (el resolver lee la proyección por request, no al cargar la política).
  void reloadIdentityClaims(reason)
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
  ...instanceArtifacts(),
  ...identityArtifacts(),
])
// Mapa identidad→claims (issue #159): lo que un operador tiene que saber para no equivocarse de
// palanca — dónde vive la verdad, qué hace el archivo, y qué NO se puede recargar.
contract.caveat(
  'El mapa identidad→claims vive en el STORE de gobierno y se administra desde la plataforma. VERGIS_IDENTITY_MAP es una ' +
    'SEMILLA: se importa al arrancar (y cuando el archivo cambia) como procedencia `autoritativa`, reconciliando — los ' +
    'overrides inscritos a mano SOBREVIVEN a la regeneración, y una entrada autoritativa que el archivo ya no trae se retira.',
)
if (!HAS_GOV_BLOCK && IDENTITY_MAP_FILE)
  contract.caveat(
    'Sin bloque de gobierno (VERGIS_MASTER_DATA/VERGIS_ADMIN_SEED) el mapa de identidad solo vive en memoria desde el archivo: ' +
      'se recarga en caliente, pero no hay administración, ni overrides, ni procedencia por entrada.',
  )
if (identityClavesRevividas.length)
  contract.caveat(
    `Mapa de identidad · CAMBIO DE ALCANCE: ${identityClavesRevividas.length} clave(s) del archivo no estaban normalizadas ` +
      '(mayúsculas o espacios) y NO aplicaban su claim con el resolver por archivo; al importarse al store quedan normalizadas ' +
      'y ahora sí aplican. Esas identidades pueden ver filas que antes no veían.',
  )
// Caveats de la config de instancia (issue #138·2) — colocados donde el operador pregunta, en la
// misma superficie que le dice qué se recarga y qué no.
contract.caveat(
  'VERGIS_MASTER_DATA y VERGIS_DATASETS son de ARRANQUE aunque sean archivos: arrastran esquema/DDL y ' +
    'superficies cableadas al abrir el proceso (el binding de admin y stores se fija al arrancar). Cambiarlos exige restart.',
)
if (SOURCES_PATH)
  contract.caveat(
    'La re-siembra de VERGIS_SOURCES es un PISO declarativo, no un espejo: lo gestionado in-app gana y nunca se pisa, ' +
      'los ids dados de baja in-app no resucitan, y retirar una fuente del yaml NO la borra del registro (la baja es in-app).',
  )
if (PI_OWNERS_PATH)
  contract.caveat(
    'Un dueño cambiado en VERGIS_PI_OWNERS aplica solo a los PI que aún no tienen gobierno: el traspaso de dueño de un PI ya ' +
      'bootstrapeado es una operación in-app, y la semilla no la pisa.',
  )
if (NOTIFY_PATH)
  contract.caveat(
    'Un destino de aviso que aparece por recarga se estrena con las transiciones FUTURAS: el estado de dedup vive en el lazo, ' +
      'no en los destinos — no hay replay de alertas ya en curso. VERGIS_PUBLIC_URL y los secretos (passEnv) son env: no pueden ' +
      'aparecer en caliente, y una recarga que los exija se rechaza conservando lo vigente.',
  )
if (NOTIFY_PATH)
  contract.caveat(
    'Cambiar la HORA del reporte en caliente puede producir UN latido extra el día del cambio: la hora nueva define un ' +
      'período que bajo la anterior no existía, y el registro de envíos no lo tiene marcado. Coherente con el at-least-once ' +
      'del lazo — un latido duplicado es inocuo, uno perdido sería una falsa alarma.',
  )
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
  // Config de INSTANCIA (issue #138·2): UN watch para los tres archivos, con recarga POR ARCHIVO
  // adentro. El debounce de `watchPaths` ya coalesce las ráfagas y las recargas son idempotentes, así
  // que re-correr los tres ante el toque de uno es barato — mismo criterio que el watch de dominio.
  // El slice `sources` solo se vigila si hay bloque de gobierno: sin store no hay dónde sembrarlo.
  const instanceTargets = [...(NOTIFY_PATH ? [NOTIFY_PATH] : []), ...(PI_OWNERS_PATH ? [PI_OWNERS_PATH] : []), ...(SOURCES_PATH && governance ? [SOURCES_PATH] : [])]
  if (instanceTargets.length) {
    contract.watch(
      {
        // DERIVADAS de qué archivos hay realmente — y ES ESTE registro el que las mueve de `bootOnly`
        // a `reloadableContent` en el snapshot: la clasificación del contrato se deriva de los watches
        // instalados, nunca de una lista que declarar aparte.
        envs: [
          ...(NOTIFY_PATH ? ['VERGIS_NOTIFY'] : []),
          ...(PI_OWNERS_PATH ? ['VERGIS_PI_OWNERS'] : []),
          ...(SOURCES_PATH && governance ? ['VERGIS_SOURCES'] : []),
        ],
        reloads:
          'config de instancia, por archivo: destinos de aviso y cadencia del reporte · dueños semilla de PI ' +
          '(solo aplican a PIs aún sin gobierno: el traspaso de dueño es in-app) · re-siembra del registro de fuentes ' +
          '(lo gestionado in-app gana; la semilla nunca remueve)',
      },
      instanceTargets,
      () => reloadInstanceSlices('watch:instancia'),
    )
  }
  // D7: la promesa de SIGHUP es «fuerza la recarga COMPLETA». Con la config de instancia recargable,
  // seguir recargando solo el gobierno la volvería mentira — y SIGHUP es la vía manual del operador
  // cuyo watch se perdió (bind-mount con inotify no propagado).
  // Mapa identidad→claims (issue #159, capacidad 4): el archivo se vigila y su cambio re-importa al
  // store + re-proyecta. La edición EN LA PLATAFORMA no pasa por acá (no hay archivo que tocar): la
  // recarga completa —SIGHUP y `reloadGovernance`— re-lee el store, que es la fuente.
  if (IDENTITY_MAP_FILE) {
    contract.watch(
      {
        envs: ['VERGIS_IDENTITY_MAP'],
        reloads: 'mapa identidad→claims: re-import del archivo al store de gobierno (preserva los overrides humanos) + swap de la proyección viva',
      },
      [IDENTITY_MAP_FILE],
      () => void reloadIdentityClaims('watch:identidad', { desdeArchivo: true }),
    )
  }
  process.on('SIGHUP', () => {
    reloadGovernance('SIGHUP') // incluye el mapa de identidad (re-lee el store)
    reloadInstanceSlices('SIGHUP')
  })
  contract.signal({
    signal: 'SIGHUP',
    action:
      'fuerza la recarga completa: gobierno (equivale a watch:policies) + mapa identidad→claims (re-lee el store) + config de instancia (avisos, dueños de PI, fuentes)',
  })
  console.log(
    `[hot-reload] activo · specs=${specTargets.join(',')} · policies=${POLICY_PATHS.length} · gobierno-dominio=${domainGovTargets.length} · ` +
      `instancia=${instanceTargets.length} · identidad=${identityProjection.size} entrada(s)${IDENTITY_MAP_FILE ? ' (semilla: VERGIS_IDENTITY_MAP)' : ''} ` +
      `(SIGHUP fuerza la recarga completa)`,
  )
}

// La huella de ESTA versión en el journal (#139 N2). Obligatoria al boot aunque nadie consulte
// `/contrato` jamás: si solo se persistiera en el GET, una instancia que no consulta no dejaría
// referencia para el próximo despliegue — y el delta que importa es justo el del despliegue siguiente.
//
// VA AL FINAL DEL CABLEADO, y no es estilo: `snapshot()` deriva `env.reloadableContent` de los watches
// REGISTRADOS, así que observar antes del bloque de hot-reload persistía un contrato que declaraba
// `VERGIS_POLICIES` como `bootOnly` — «esto exige reiniciar» cuando ya no, el error de costo asimétrico
// que este issue existe para matar. Medido, con la convergencia posterior que confundía al lector:
// `tests/contract-boot-projection.test.ts`.
contractJournal.observe(contract.snapshot())

// Y el orden deja de ser la garantía: cualquier declaración TARDÍA —un bootstrap async, un watch que
// alguien agregue debajo de esta línea— re-observa. El journal une proyecciones y no toca disco si la
// huella no cambió, así que esto es gratis cuando no hay nada nuevo.
contract.onRegister(() => contractJournal.observe(contract.snapshot()))
