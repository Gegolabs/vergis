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
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { watchPaths } from './hot-reload'
import { type NavQuery } from './nav'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { runSpec } from '@vergis/cli'
import { AppendOnlyLog, withResultCache, type Capability, type GateHeaders, type IdentityContext } from '@vergis/botler'
import { type AnnotationContext } from '@vergis/mira'
import {
  bootstrapClickHouse,
  createIngestClickHouse,
  createExecuteSqlClickHouse,
  createExecuteSqlDwh,
  renderHtmlPiece,
  renderCsvPiece,
  publicarArtefacto,
  openAnnotationStore,
  parseMasterDataConfig,
  parseDomainsConfig,
  manageableDomains,
  parseIntakeConfig,
  createTokenProvider,
  createOneLakeIntake,
  createFabricJobs,
  createFabricJobStatus,
  createFabricEngineClient,
  SqliteMasterDataStore,
  createDwhMasterDataStore,
  createDwhPublisher,
  SqliteGovernanceStore,
  canOpen,
  deriveIngestionMap,
  deriveEntityFreshness,
  classifyProcess,
  reconcilePlan,
  freshnessAlerts,
  diffAlertState,
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
  type AnnotationStore,
  type SqlConnectionProfile,
} from '@vergis/capabilities'
import { createAdmin, type AdminHandler, type IntakeRunner } from './admin'
import { computeBound, unionInjections, type DatasetCfg, type BoundDataset } from './engines/clickhouse'
import { fail, readJsonBody } from './http-util'
import { annSign as annSignHmac, verifyAnnToken } from './annotations'
import { createRequestHandler } from './routes'
import { createDiscovery, type Report } from './discovery'
import { createIdentity } from './identity'
import { configFromEnv } from './config'
import { avatarMenu } from './ui'
import { indexHtml as renderCatalog } from './catalog'
import { createPiConfig, type PiConfigHandler } from './pi-config'
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
// números — antes `PORT=abc` daba `listen(NaN)` tarde y feo). El secreto de anotación se maneja aparte.
const config = configFromEnv(process.env, () => '')
const PORT = config.port
const REFRESH_MS = config.refreshMs

// Auto-chequeo de coherencia del despliegue (contrato Producto→Infra). Corre ANTES de leer specs,
// políticas o config de gobierno: si un env referencia un path no montado, o el gobierno se pide con
// un store efímero, se avisa RUIDOSAMENTE (y en modo strict se aborta) en vez de degradar en silencio
// —el modo de falla del incidente del avatar (2026-07)—. Ver deploy/compose.reference.yml.
reportDeploymentConfig(checkDeploymentConfig(process.env), configCheckMode(process.env))

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
// Descubrimiento (memoizado) + gate de gobernanza fail-closed: extraído y testeado en ./discovery.
// `discovery.rebuild()` (validate-before-swap) lo fuerza tras un hot-reload de gobierno.
const discovery = createDiscovery({ store, engine: ENGINE as 'clickhouse' | 'fabric', servingCaps: SERVING_CAPS, specPaths })
const discover = discovery.discover
const visibleFor = discovery.visibleFor

// --- Setup del CONECTOR según el motor --------------------------------------
const connections = process.env['VERGIS_CONNECTIONS']
  ? (JSON.parse(process.env['VERGIS_CONNECTIONS']) as Record<string, SqlConnectionProfile>)
  : null

let ready = false
let lastErr: string | null = null
let servingCap: Capability // la Capability de query enforcing (el conector)
let bootstrapAll: () => Promise<void>

if (ENGINE === 'clickhouse') {
  // --- Motor B: replica gobernada en ClickHouse (bootstrap + ingesta + ROW POLICY) ---
  const CH_URL = process.env['VERGIS_CH_URL'] ?? 'http://clickhouse:8123'
  const ADMIN = { url: CH_URL, user: process.env['VERGIS_CH_ADMIN_USER'] ?? 'default', password: process.env['VERGIS_CH_ADMIN_PASS'] }
  const CONSUMER_USER = process.env['VERGIS_CH_CONSUMER_USER'] ?? 'botler'
  const TARGET_ROLE = process.env['VERGIS_CH_TARGET_ROLE'] ?? 'consumer_role'

  const DATASETS: DatasetCfg[] = process.env['VERGIS_DATASETS']
    ? ((parseYaml(readFileSync(resolve(process.env['VERGIS_DATASETS']), 'utf8')) as { datasets?: DatasetCfg[] }).datasets ?? [])
    : []
  if (DATASETS.length === 0) throw new Error('engine=clickhouse: falta VERGIS_DATASETS (datasets del nodo).')

  // BOUND es mutable: se RECOMPUTA desde el store en cada bootstrap (ver A11 abajo). Al arranque se
  // computa una vez para derivar las inyecciones del canal de serving (su alta necesita restart).
  let BOUND: BoundDataset[] = computeBound(DATASETS, store, TARGET_ROLE)
  const UNION_INJECTIONS = unionInjections(BOUND)
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
  const dwh = createExecuteSqlDwh(connections, { injections })
  servingCap = dwh

  // FAIL-CLOSED: cada tabla gobernada que sirva un PI DEBE tener RLS nativa habilitada en la fuente.
  // Sin eso, push-down devolvería todas las filas (fuga). Si falta, no se marca ready.
  bootstrapAll = async () => {
    const needed = new Set<string>()
    for (const r of discover()) for (const t of r.tables) {
      const pol = store.get(t)
      // INVARIANTE: toda tabla SERVIDA (gobernada O pública) debe tener artefacto nativo. Una pública
      // se manifiesta con su SECURITY POLICY allow-all (doc 018) → "sin artefacto" = sin gobierno (fuga),
      // no "público". Las que no tienen entrada en el store ya no se sirven (canServe → deny).
      if (pol) needed.add(t)
    }
    const sysSql =
      `SELECT OBJECT_SCHEMA_NAME(pr.target_object_id) AS sch, OBJECT_NAME(pr.target_object_id) AS tbl ` +
      `FROM sys.security_policies p JOIN sys.security_predicates pr ON pr.object_id = p.object_id WHERE p.is_enabled = 1`
    const protectedTables = new Set<string>()
    for (const ref of Object.keys(connections)) {
      const out = (await dwh.execute({ database_ref: ref, sql: sysSql }, { agent: 'vergis' })) as { rows: { sch: string; tbl: string }[] }
      for (const row of out.rows) protectedTables.add(`${row.sch}.${row.tbl}`)
    }
    const missing = [...needed].filter((t) => !protectedTables.has(t))
    if (missing.length) {
      throw new Error(
        `Fail-closed (engine=fabric): estas tablas servidas NO tienen artefacto SECURITY POLICY en la fuente ` +
          `(gobernada → predicado-filtro; pública → allow-all): ${missing.join(', ')}. ` +
          `Aplica la SECURITY POLICY (deploy/fabric-pushdown/, regenerada desde la política) antes de servir.`,
      )
    }
    console.log(`[vergis-rls] push-down OK: ${[...needed].length} tabla(s) gobernada(s) con RLS nativa verificada.`)
    ready = true; lastErr = null
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
const gateClaims = (process.env['VERGIS_GATE_CLAIMS'] ?? 'groups:x-forwarded-groups')
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
const GATE_SECRET = process.env['VERGIS_GATE_SECRET'] ?? ''

// RESOLVER DE IDENTIDAD desde un DIRECTORIO (charter §4–§5): cuando el claim del criterio no viaja
// en la cabecera del gate sino que se deriva de la identidad autenticada (p.ej. el ÁREA del viewer
// a partir de su email corporativo), se resuelve contra un mapa de referencia. VERGIS_IDENTITY_MAP
// apunta a un JSON { email → { claim: valor(es) } } (trust-base; lo produce un proceso admin —
// p.ej. reconciliación AAD↔directorio de personas). Fail-closed: email no mapeado → sin claim → deny.
const IDENTITY_MAP: Record<string, Record<string, string | string[]>> | null = process.env['VERGIS_IDENTITY_MAP']
  ? (JSON.parse(readFileSync(resolve(process.env['VERGIS_IDENTITY_MAP']), 'utf8')) as Record<string, Record<string, string | string[]>>)
  : null

// Identidad del gate + claims enriquecidos desde el directorio: extraído y testeado en ./identity.
const identityFor = createIdentity(gateClaims, IDENTITY_MAP).identityFor

// ANOTACIONES — enriquecimiento de la capa de viz. Store embebido (SQLite) reemplazable por externo.
// Lectura: solo se fusionan anotaciones sobre las filas RLS-filtradas que el usuario ya ve.
// Escritura: gateada por token HMAC firmado por-render — el token prueba que el server renderizó
// ESA clave para ESA identidad (= era visible). Forjar una clave no-visible no produce token válido.
let annStore: AnnotationStore | null = null
// Gobierno de PI (autorización de ARTEFACTO, frente A). FLAG-GUARDED: con VERGIS_PI_ACL apagado el
// índice/apertura siguen por acceso-a-datos (comportamiento vivo); encendido, gatean por la ACL del
// PI (rol owner/collaborator/viewer) compuesta con la RLS de datos (que NUNCA se salta).
let governance: SqliteGovernanceStore | null = null
let domainsCfg: DomainDecl[] = [] // dominios declarados (para gatear «Gestión» en el avatar del catálogo)
let stewardGroups: string[] = [] // default-steward-groups (idem)
let piConfig: PiConfigHandler | null = null
let piAclEnabled = false
let piOwners: Record<string, string> = {}
let defaultCollabGroups: string[] = []
// Secreto HMAC de los tokens de anotación. Sin `VERGIS_ANNOTATION_SECRET` se genera uno aleatorio por
// arranque: sirve para dev, pero en producción los tokens de las páginas ya abiertas NO sobreviven un
// restart (la escritura de anotación falla hasta recargar) y varias réplicas no comparten la firma.
const ANN_SECRET = process.env['VERGIS_ANNOTATION_SECRET'] ?? randomBytes(32).toString('hex')
if (!process.env['VERGIS_ANNOTATION_SECRET']) {
  console.warn(
    '[vergis-rls] VERGIS_ANNOTATION_SECRET no definido: se generó un secreto aleatorio. Los tokens de ' +
      'anotación NO sobreviven un restart ni se comparten entre réplicas. Define el env en producción.',
  )
}
// Época del token de anotación: bucket de 4h. Un token deja de valer cuando el bucket cambia, así
// una identidad cuyo acceso se revocó no puede escribir con tokens de páginas viejas para siempre.
const ANN_EPOCH_MS = 4 * 3600_000
const annEpoch = (t = Date.now()): string => String(Math.floor(t / ANN_EPOCH_MS))
const annSign = (piId: string, email: string, key: string): string => annSignHmac(ANN_SECRET, piId, email, key, annEpoch())

// La navegación multi-vista (`?page=` + `?ctx.*`, con acumulación de repetidos para multi-select)
// vive en ./nav.ts — extraída para testearla sin los efectos de módulo de este archivo.

async function renderReport(report: Report, headers: GateHeaders, nav: NavQuery = {}): Promise<string> {
  const identity = identityFor(headers)
  const email = (identity.user ?? '').toLowerCase()
  // El contexto de anotaciones se pasa solo si el store está listo; Mira lo aplica a la 1ª tabla.
  const annotations: AnnotationContext | undefined = annStore
    ? {
        piId: report.slug,
        label: 'Anotaciones',
        endpoint: `/${report.slug}/annotations`,
        resolve: async (keys: string[]) => {
          const m = await annStore!.get(report.slug, keys)
          const out: Record<string, { value: string; token: string }> = {}
          for (const k of keys) out[k] = { value: m.get(k)?.value ?? '', token: annSign(report.slug, email, k) }
          return out
        },
      }
    : undefined
  const out = await runSpec({
    specPath: report.specPath,
    identity,
    baseDir: process.env['VERGIS_OUT'] ?? tmpdir(),
    // HARDENING (charter §2b): catálogo de serving = solo el conector enforcing + render/publish.
    // SIN starters (no `static-data` ni vías crudas) → imposible servir dato no-gobernado.
    registerStarters: false,
    extraCapabilities: [servingCap, renderHtmlPiece, renderCsvPiece, publicarArtefacto],
    annotations,
    page: nav.page,
    ctx: nav.ctx,
    interactiveMaxRows: INTERACTIVE_MAX_ROWS,
  })
  if (!out.ok) throw new Error(out.fallback?.reason ?? 'render falló')
  return out.html ?? ''
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

/** POST /<slug>/annotations — upsert de una anotación; gateado por token HMAC. */
async function handleAnnotationWrite(report: Report, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!annStore) return fail(res, 503, 'Anotaciones no disponibles')
  const identity = identityFor(req.headers as GateHeaders)
  const email = (identity.user ?? '').toLowerCase()
  const body = (await readJsonBody(req)) as { key?: unknown; token?: unknown; value?: unknown }
  const key = String(body.key ?? '')
  const token = String(body.token ?? '')
  const value = String(body.value ?? '')
  // Verifica contra la época actual y la anterior (no cortar en el borde del bucket).
  if (!verifyAnnToken(ANN_SECRET, report.slug, email, key, token, [annEpoch(), annEpoch(Date.now() - ANN_EPOCH_MS)])) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'token inválido (registro no visible para esta identidad)' }))
    return
  }
  await annStore.upsert(report.slug, key, value, email || undefined)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}

// Branding del índice — parametrizado por instancia (genérico por defecto, no horneado al beta).
const INDEX_TITLE = process.env['VERGIS_INDEX_TITLE'] ?? 'Productos de Información'
// Destino del «Cerrar sesión» tras el sign_out de oauth2-proxy. La instancia lo apunta al endpoint de
// logout del IdP (AAD) para un logout COMPLETO (cierra también la sesión de Microsoft). Vacío = interno.
const SIGNOUT_RD = process.env['VERGIS_SIGNOUT_RD'] ?? ''
const INDEX_LOGO = (() => {
  const p = process.env['VERGIS_INDEX_LOGO']
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
  const avatar = avatarMenu({ email: emailLc, isAdmin, hasDomains, signoutRd: SIGNOUT_RD || '/' })
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
    getPiConfig: () => piConfig,
    discover,
    identityFor,
    renderReport,
    handleAnnotationWrite,
    indexReports,
    renderIndexPage,
    canOpenPi,
  }),
)

// Store de anotaciones (no-fatal: si falla, el feature queda inhabilitado, no rompe el serving).
try {
  annStore = await openAnnotationStore(process.env['VERGIS_OUT'] ?? tmpdir())
  console.log('[vergis-rls] anotaciones: store embebido listo')
} catch (e) {
  console.error(`[vergis-rls] anotaciones deshabilitadas: ${e instanceof Error ? e.message : String(e)}`)
}

// ADMINISTRACIÓN (no-fatal): data maestra + usuarios y roles — única superficie de ESCRITURA
// gobernada. Independiente del motor de serving. Se habilita si la instancia declara entidades
// (VERGIS_MASTER_DATA) o admins semilla (VERGIS_ADMIN_SEED). El store de data maestra es Fabric en
// engine=fabric (la fuente única que el PI lee por JOIN) y SQLite embebido en local/clickhouse.
let admin: AdminHandler | null = null
const ADMIN_SEED = (process.env['VERGIS_ADMIN_SEED'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const OUT = (process.env['VERGIS_OUT'] ?? tmpdir()).replace(/\/$/, '')
if (process.env['VERGIS_MASTER_DATA'] || ADMIN_SEED.length) {
  try {
    const entities = process.env['VERGIS_MASTER_DATA']
      ? parseMasterDataConfig(parseYaml(readFileSync(resolve(process.env['VERGIS_MASTER_DATA']), 'utf8')))
      : []
    const groupSeeds: GroupSeed[] = process.env['VERGIS_GROUPS']
      ? ((parseYaml(readFileSync(resolve(process.env['VERGIS_GROUPS']), 'utf8')) as { groups?: GroupSeed[] }).groups ?? [])
      : []
    // Gestión de DOMINIO: dominios declarados (etiqueta + stewards) y slots de ingesta de la instancia.
    const domains: DomainDecl[] = process.env['VERGIS_DOMAINS']
      ? parseDomainsConfig(parseYaml(readFileSync(resolve(process.env['VERGIS_DOMAINS']), 'utf8')))
      : []
    domainsCfg = domains // expuesto a module-level para el avatar del catálogo (¿gestiona dominios?)
    const intakeSlots: IntakeSlot[] = process.env['VERGIS_INTAKE']
      ? parseIntakeConfig(parseYaml(readFileSync(resolve(process.env['VERGIS_INTAKE']), 'utf8')))
      : []
    // Registro de fuentes de la instancia (frente B · frescura): fuentes (oferta + dominio), mapeos
    // tabla→fuente, procesos (con engine_ref al item del motor) y proceso→salidas. Declarativo: se
    // re-siembra en cada arranque (idempotente). Sin el archivo, el registro queda vacío (no hay frescura).
    const sourceReg = process.env['VERGIS_SOURCES']
      ? (parseYaml(readFileSync(resolve(process.env['VERGIS_SOURCES']), 'utf8')) as {
          sources?: { id: string; label: string; oferta: string; domain?: string; connectedBy?: string }[]
          tableSources?: { tableRef: string; sourceId: string }[]
          processes?: { id: string; label: string; sourceId: string; engine?: { workspaceId: string; itemId: string; jobType: string } }[]
          processOutputs?: { processId: string; tableRef: string }[]
        })
      : {}
    const govStore = await SqliteGovernanceStore.open(process.env['VERGIS_GOVERNANCE_DB'] ?? `${OUT}/governance.sqlite`, {
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
    piOwners = process.env['VERGIS_PI_OWNERS']
      ? (parseYaml(readFileSync(resolve(process.env['VERGIS_PI_OWNERS']), 'utf8')) as { owners?: Record<string, string> }).owners ?? {}
      : {}
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
    const fabricWiring = ((): { runner?: IntakeRunner; status?: (slot: IntakeSlot) => Promise<RunRecord[]>; engine?: IngestionEngineClient } => {
      if (!connections) return {}
      const refs = Object.keys(connections)
      const ref = process.env['VERGIS_INTAKE_SP'] ?? (refs.length === 1 ? refs[0] : undefined)
      const sp = ref ? connections[ref] : undefined
      if (!sp) {
        if (intakeSlots.length) console.error('[vergis-rls] ingesta/frescura deshabilitadas: define VERGIS_INTAKE_SP (hay varias conexiones).')
        return {}
      }
      const tokens = createTokenProvider({ tenantId: sp.tenantId, clientId: sp.clientId, clientSecret: sp.clientSecret })
      const jobStatus = createFabricJobStatus(tokens)
      // Engine client (frente B · frescura): resuelve processRef → engine_ref con el registro de procesos.
      const engine = createFabricEngineClient(tokens, async (processRef) => (await govStore.listProcesses()).find((p) => p.id === processRef)?.engine)
      if (!intakeSlots.length) return { engine }
      const onelake = createOneLakeIntake(tokens)
      const jobs = createFabricJobs(tokens)
      return {
        runner: { put: (t, f, b) => onelake.put(t, f, b), runNow: (tr, t) => jobs.runNow(tr, t) },
        status: (slot) => jobStatus.listInstances(slot.trigger?.workspaceId ?? slot.target.workspaceId, slot.trigger!.processRef, 5),
        engine,
      }
    })()
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
    // Monitor de frescura (alerta autónoma): cada `VERGIS_FRESHNESS_POLL_MS` lee el run-history de los
    // procesos observables, detecta fallidas/faltantes y empuja a Slack SOLO en transiciones (dedup por
    // estado). Config-gated: off salvo que se definan webhook + intervalo. No mantiene vivo el proceso.
    const freshnessSlack = process.env['VERGIS_FRESHNESS_SLACK_WEBHOOK'] ?? ''
    const freshnessPollMs = Number(process.env['VERGIS_FRESHNESS_POLL_MS'] ?? 0)
    if (fabricWiring.engine && freshnessSlack && freshnessPollMs > 0) {
      const engine = fabricWiring.engine
      const postSlack = async (text: string): Promise<void> => {
        try {
          await fetch(freshnessSlack, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
        } catch (e) {
          console.error('[vergis-rls] freshness slack:', e instanceof Error ? e.message : e)
        }
      }
      let alertState: Record<string, 'failed' | 'missed'> = {}
      const tick = async (): Promise<void> => {
        try {
          const f = await freshnessInputs()
          const reqOf = new Map(deriveIngestionMap(f.mapInput).map((m) => [m.processId, m.requiredCadenceSeconds]))
          const procs = await Promise.all(
            f.procs
              .filter((p) => p.engine)
              .map(async (p) => ({
                processId: p.id,
                runs: await engine.listRunHistory(p.id).catch(() => [] as RunRecord[]),
                requiredCadenceSeconds: reqOf.get(p.id) ?? Number.POSITIVE_INFINITY,
              })),
          )
          const { notify, recovered, next } = diffAlertState(alertState, freshnessAlerts(procs, Date.now()))
          alertState = next
          for (const a of notify) await postSlack(`:warning: *Frescura* — proceso \`${a.processId}\` ${a.reason === 'failed' ? 'falló' : 'atrasada (no corre a tiempo)'}${a.lastError ? ` — ${a.lastError}` : ''}`)
          for (const pid of recovered) await postSlack(`:white_check_mark: *Frescura* — proceso \`${pid}\` recuperado`)
        } catch (e) {
          console.error('[vergis-rls] freshness monitor:', e instanceof Error ? e.message : e)
        }
      }
      const timer = setInterval(() => void tick(), freshnessPollMs)
      timer.unref?.()
      console.log(`[vergis-rls] monitor de frescura activo (cada ${Math.round(freshnessPollMs / 1000)}s → Slack)`)
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
      // Frescura por entidad de un dominio (vista de dominio): proyección por entidad enriquecida con
      // run-history + schedule + salud (vía engine client). Scope por dominio = dominio de la fuente del
      // proceso productor. Tolerante a fallos del motor (no se cae la página).
      domainFreshness: async (domainId: string) => {
        const f = await freshnessInputs()
        const rows = deriveEntityFreshness(f.mapInput)
        const domainOfSource = new Map(f.sources.map((s) => [s.id, s.domain]))
        const procById = new Map(f.procs.map((p) => [p.id, p]))
        const inDomain = rows.filter((r) => {
          const proc = r.processId ? procById.get(r.processId) : undefined
          return proc != null && domainOfSource.get(proc.sourceId) === domainId
        })
        const engine = fabricWiring.engine
        const cache = new Map<string, { runs: RunRecord[] | 'error'; schedule: number | null }>()
        const enrich = async (processId: string): Promise<{ runs: RunRecord[] | 'error'; schedule: number | null }> => {
          const hit = cache.get(processId)
          if (hit) return hit
          let runs: RunRecord[] | 'error' = []
          let schedule: number | null = null
          if (engine) {
            try { runs = await engine.listRunHistory(processId) } catch { runs = 'error' }
            try { schedule = await engine.getScheduleSeconds(processId) } catch { schedule = null }
          }
          const v = { runs, schedule }
          cache.set(processId, v)
          return v
        }
        return Promise.all(
          inDomain.map(async (r) => {
            const proc = r.processId ? procById.get(r.processId) : undefined
            if (!r.processId || !engine || !proc?.engine) return { ...r, engine: false }
            const { runs, schedule } = await enrich(r.processId)
            const health = runs !== 'error' && r.requiredCadenceSeconds != null ? classifyProcess(runs, r.requiredCadenceSeconds, Date.now()) : undefined
            return { ...r, engine: true, engineJobType: proc.engine.jobType, engineItemId: proc.engine.itemId, runs, health, actualScheduleSeconds: schedule }
          }),
        )
      },
      // Driver del reconciliador («aplicar cadencia»): empuja la cadencia derivada del proceso al schedule
      // del motor (one-way, idempotente). Devuelve el plan (set/noop) para feedback.
      applyCadence: async (processId: string, by: string) => {
        const engine = fabricWiring.engine
        if (!engine) throw new Error('Sin conexión al motor: no se puede aplicar la cadencia.')
        const map = deriveIngestionMap((await freshnessInputs()).mapInput)
        const row = map.find((m) => m.processId === processId)
        if (!row) throw new Error(`Proceso desconocido: ${processId}`)
        const actual = await engine.getScheduleSeconds(processId)
        const plan = reconcilePlan(row.requiredCadenceSeconds, actual)
        if (plan.action === 'set') await engine.setScheduleSeconds(processId, row.requiredCadenceSeconds)
        auditLog.append({ type: 'frescura-aplicar-cadencia', process: processId, by, desiredSeconds: row.requiredCadenceSeconds, action: plan.action })
        return plan
      },
      identityOf: (h) => identityFor(h as GateHeaders),
      audit: (e) => auditLog.append(e),
      secret: ANN_SECRET,
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
      secret: ANN_SECRET,
      brandTitle: INDEX_TITLE,
    })
    console.log(`[vergis-rls] administración: ${entities.length} entidad(es) · ${ADMIN_SEED.length} admin semilla · ACL PI ${piAclEnabled ? 'ON' : 'off'} · store=${useFabricStore ? 'fabric' : 'sqlite'}`)
  } catch (e) {
    console.error(`[vergis-rls] administración deshabilitada: ${e instanceof Error ? e.message : String(e)}`)
  }
}
server.listen(PORT, () => {
  const r = discover()
  console.log(`[vergis-rls] engine=${ENGINE} · ${r.length} PI por-consumidor en :${PORT} · rutas: ${r.map((x) => '/' + x.slug).join(' ')}`)
})

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
const HOT_RELOAD = (process.env['VERGIS_HOT_RELOAD'] ?? '1') !== '0'
function reloadGovernance(reason: string): void {
  const next = new Map<string, PolicyDecl>()
  try {
    loadPolicyStoreInto(next)
  } catch (e) {
    console.error(`[hot-reload] recarga de políticas falló (${reason}); store vigente conservado: ${e instanceof Error ? e.message : String(e)}`)
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
  // Fail-closed en el reload: si el re-bootstrap falla (fabric: falta SECURITY POLICY nativa para una
  // tabla recién gobernada; CH: recompilación/ingesta fallida), NO se sigue sirviendo con las
  // invariantes viejas — ready=false → healthz 503 hasta que un reload exitoso lo restablezca.
  void bootstrapAll().catch((e) => {
    ready = false
    lastErr = e instanceof Error ? e.message : String(e)
    console.error(`[hot-reload] re-bootstrap (${reason}) falló → ready=false (fail-closed): ${lastErr}`)
  })
}
if (HOT_RELOAD) {
  const specTargets = SPECS_DIR ? [resolve(SPECS_DIR)] : SPECS_LIST.map((p) => resolve(p))
  watchPaths(specTargets, () => {
    const r = discovery.rebuild()
    console.log(r.ok ? `[hot-reload] specs recargadas: ${discover().length} PI servible(s)` : `[hot-reload] rebuild de specs falló (se conserva el previo): ${r.error}`)
  })
  if (POLICY_PATHS.length) watchPaths(POLICY_PATHS.map((p) => resolve(p)), () => reloadGovernance('watch:policies'))
  process.on('SIGHUP', () => reloadGovernance('SIGHUP'))
  console.log(`[hot-reload] activo · specs=${specTargets.join(',')} · policies=${POLICY_PATHS.length} (SIGHUP fuerza recarga de gobierno)`)
}
