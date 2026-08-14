/**
 * Ambiente de ADMINISTRACIÓN de Vergis — superficie de ESCRITURA gobernada (primera del sistema).
 *
 * Distingue DOS clases de gestión (ver `docs/gestion-de-dominio.md`):
 *  · GESTIÓN DE PLATAFORMA — transversal: Usuarios y Roles · Grupos de Mira · Fuentes · Settings. Solo
 *    admins. Una sola entrada (`/admin/plataforma`) que adentro despliega sus opciones. «Fuentes» es el
 *    registro técnico (conectar fuentes + su oferta); la frescura NO vive acá.
 *  · GESTIÓN DE DOMINIO — por dominio: Ingesta de archivos · Data Maestra · Frescura (por entidad).
 *    Un área por dominio (`/admin/dominio/<id>`), accesible a los STEWARDS del dominio (+ admin).
 *
 * El home (`/admin`) es un DASHBOARD de salud: lista los dominios que el usuario puede gestionar y —si
 * es admin— la entrada de Plataforma. El gate de `/admin` es «admin O steward de algún dominio».
 *
 * GOBIERNO: autz de ACCIÓN (distinta de la RLS de filas). Escrituras por POST con token CSRF firmado
 * por-identidad; cada mutación se asienta en el log append-only de auditoría (quién · qué · cuándo).
 * Independiente del motor de datos: la Administración no sirve dato gobernado, lo edita/ingesta.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  coerceRow,
  escapeHtml,
  pkColumn,
  AdminLockout,
  MasterDataConflict,
  GovernanceConflict,
  AuthoringDenied,
  AuthoringError,
  AuthoringUnknown,
  canonicalDefinitionSha256,
  definitionsEquivalent,
  derivePublishPlan,
  renderTemplate,
  canManageDomain,
  manageableDomains,
  slotMaxBytes,
  slotsQueAceptan,
  validateUpload,
  validateMeta,
  buildSidecar,
  secondsToDuration,
  resolveRunLog,
  type AdminStore,
  type DomainDecl,
  type GroupStore,
  type IntakeSlot,
  type IntakeTarget,
  type IntakeTrigger,
  type PlatformSettingStore,
  type IngestionMapRow,
  type EntityFreshnessRow,
  type SourceRow,
  type ProcessRow,
  type SourceRegistryStore,
  type ProcessHealth,
  type MasterDataEntity,
  type MasterDataRow,
  type MasterDataStore,
  type RunRecord,
  type RunStatus,
  type IntakeUploadStore,
  type IntakeUploadRow,
  type OneLakeEntry,
  type RevertPlan,
  type ItemAuthoringClient,
  type JobTemplate,
  type PublicationInput,
  type PublicationRow,
  type PublishOutcome,
  type PublishParams,
  type PublishPlan,
  type RenderedDefinition,
} from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'
import { shellNav, avatarMenu, THEME_TOGGLE_JS, send, redirect, readForm, requireCsrf, csrfFactory, CsrfError } from './ui'
import { NOTAS_SETTINGS, leerNotasSettings, validarRetencion, validarMaxSchedules } from './notas-settings'
import { readMultipart } from './multipart'
import { cargasBody, revertPlanBody, cargasHref, destinoAviso, type CargasOps, type SlotCargas } from './admin-cargas'
import { corridaBody, type CorridaResolucion, type CorridaView } from './admin-corrida'

/** Chrome de la página: sidebar (navegación del scope activo) + avatar (menú de identidad). */
interface Chrome {
  sidebar: string
  avatar: string
}

const brandOf = (deps: AdminDeps): string => `${deps.brandTitle ?? 'Vergis'} · Administración`
const adminPage = (deps: AdminDeps, chrome: Chrome, title: string, body: string): string =>
  shellNav(brandOf(deps), title, chrome.sidebar, chrome.avatar, body)

/** Write-path del intake (a OneLake) + disparo del pipeline. Lo inyecta el wiring. */
export interface IntakeRunner {
  /** `sidecar` (issue #76): JSON de metadata que aterriza como `<filename>.meta.json` ANTES del archivo. */
  put(target: IntakeTarget, filename: string, bytes: Buffer, sidecar?: string): Promise<void>
  runNow?(trigger: IntakeTrigger, target?: IntakeTarget): Promise<void>
}

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

/** Fila de Frescura por entidad enriquecida con lo último OBSERVADO del motor (corridas + schedule + salud). */
export interface DomainEntityFreshness extends EntityFreshnessRow {
  /** ¿El proceso productor tiene engine_ref (es observable en el motor)? Si no, no hay corridas ni schedule. */
  engine: boolean
  /** Tipo de job del motor que ejecuta el proceso (Fabric: 'RunNotebook' | 'sparkjob' | 'Pipeline'…). */
  engineJobType?: string
  /** Item id del motor (para casar la entidad con su slot de ingesta: slot.trigger.processRef === este). */
  engineItemId?: string
  /** Últimas corridas conocidas del proceso (más reciente primero), según la proyección local. */
  runs?: RunRecord[]
  /** Salud derivada (fallida / faltante) a partir de las corridas y la cadencia requerida. */
  health?: ProcessHealth
  /** Schedule observado del proceso en el motor (segundos); null si no tiene o aún no se observó. */
  actualScheduleSeconds?: number | null
  /** Pausa explícita del proceso (#107): el steward la puso, el lazo la respeta. */
  paused?: { at: string; by?: string }
  /** Edad y salud del refresco que alimenta esta fila (#105): lo mostrado es lo último conocido. */
  projection?: FreshnessProjectionMeta
}

/** Estado observado de UN proceso de ingestión (issue #101) — leído de la proyección local (#105),
 *  jamás del motor en el request path. Lo arma el wiring; el render solo pinta. */
export interface ProcessIngestionState {
  processId: string
  /** Corridas conocidas, más reciente primero ([] con proyección fría). */
  runs: RunRecord[]
  /** Schedule observado (null = sin schedule). Solo significativo con projection.observedAt != null. */
  scheduleSeconds: number | null
  /** Salud (classifyProcess) — undefined si el proceso no tiene cadencia requerida (event-driven /
   *  sin demanda) o la proyección está fría. */
  health?: ProcessHealth
  /** Meta de la proyección (#105): observedAt / stale / lastError / off. */
  projection: FreshnessProjectionMeta
}

/** Ubicación resuelta del almacén de logs por corrida (OneLake: filesystem workspace + lakehouse). */
export interface RunLogRef {
  workspaceId: string
  lakehouseId: string
  dir: string
}

/** Origen de una corrida: slot de ingesta o proceso registrado — SIEMPRE anclado a un dominio. */
export interface RunLogSource {
  domainId: string
  slotId?: string
  processId?: string
}

/** Acceso a los logs POR CORRIDA (issue #99). Sin esta dependencia no se ofrecen enlaces «Ver log». */
export interface RunLogsOps {
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

/**
 * Una plantilla de job declarada por la instancia CON el contenido de sus partes ya leído del disco
 * (issue #107 fase 2, D3). Es la forma que produce `server/instance-config.ts` (`LoadedJobTemplate`);
 * acá se declara estructuralmente para que `admin.ts` no dependa del cargador de config.
 */
export interface JobTemplateBundle {
  template: JobTemplate
  /** `path` de la parte → contenido crudo del archivo declarado. */
  partFiles: Record<string, string>
}

/**
 * Puerto del ledger APPEND-ONLY de publicaciones (D6). Lo cablea el wiring sobre el db de gobierno
 * (las ops puras viven en `packages/capabilities/src/job-publication.ts`); acá entra como puerto para
 * que la ruta no sepa de SQL ni de persistencia.
 */
export interface JobPublicationLedger {
  /** Última publicación `ok` del proceso. `null` = Vergis nunca publicó este destino. */
  lastOk(sel: { processId: string }): Promise<PublicationRow | null>
  /** Registra UN intento (cualquiera de los cuatro desenlaces) y devuelve su id. */
  record(row: PublicationInput): Promise<number>
  /** Las `desconocida` que esperan el «Re-verificar» de D7. */
  pendingUnknown(): Promise<PublicationRow[]>
  /** Resuelve una `desconocida` con el desenlace MEDIDO (fila nueva; la original no se muta). */
  resolveUnknown(
    id: number,
    resolution: { outcome: Exclude<PublishOutcome, 'desconocida'>; detail?: string; itemId?: string; byUser?: string },
  ): Promise<number>
  /** Historial para la UI, recientes primero. */
  list(opts?: { limit?: number }): Promise<PublicationRow[]>
}

/**
 * Publicación de jobs en el motor (#107 fase 2). Dependencia OPCIONAL y fail-closed en tres capas
 * (D4): sin esta dep, o sin plantillas declaradas, o sin `sourcesAdmin` (que es donde aterriza el
 * `engine_ref` de D10), la sección no existe y sus rutas no responden.
 */
export interface JobsPublishOps {
  /** Plantillas de la instancia. Vacío ⇒ la sección no existe (no hay nada publicable). */
  templates: JobTemplateBundle[]
  /** Cliente de autoría del motor (mismo SP del intake o el perfil separado de D9). */
  authoring: ItemAuthoringClient
  ledger: JobPublicationLedger
}

// ─── Mapa identidad→claims (#159): el trust-base, administrado desde la plataforma ──────────
/**
 * Procedencia de una entrada del mapa. `autoritativa-ambigua` **no es un error**: es la identidad que
 * la fuente SÍ trajo y que no resolvió a un valor único (#165·§4, la persona con dos fichas activas).
 * Se muestra como el ESTADO que es — «ninguna» tiene que ser visible, no un hueco.
 */
type AdminIdentityOrigin = 'autoritativa' | 'override' | 'autoritativa-ambigua'

interface AdminIdentityEntry {
  email: string
  claims: Record<string, string[]>
  origin: AdminIdentityOrigin
  updatedBy?: string
  updatedAt?: string
}

/**
 * Lo que esta superficie necesita del `IdentityClaimStore` de capabilities, declarado acá y por
 * estructura: el tipo del store todavía no se re-exporta desde `@vergis/capabilities`, y cablear un
 * `SqliteGovernanceStore` satisface esta forma sin conversión. Si el paquete lo exporta, esto se
 * reemplaza por el import — la forma es la misma a propósito.
 */
export interface IdentityClaimsAdmin {
  listIdentityClaims(): Promise<AdminIdentityEntry[]>
  getIdentityClaims(email: string): Promise<AdminIdentityEntry | null>
  upsertIdentityClaims(
    email: string,
    input: { claims: Record<string, string | string[]>; origin: AdminIdentityOrigin; updatedBy?: string },
  ): Promise<void>
  deleteIdentityClaims(email: string): Promise<void>
  unresolvedIdentities(emails: string[]): Promise<string[]>
}

export interface AdminDeps {
  entities: MasterDataEntity[]
  mdStore: MasterDataStore
  adminStore: AdminStore
  /** Dominios declarados (gestión de dominio). Opcional. */
  domains?: DomainDecl[]
  /** Grupos de Mira cuyos miembros son STEWARDS de TODOS los dominios (default-steward-groups). */
  domainStewardGroups?: string[]
  /** Slots de ingesta declarados (instancia). Opcional. */
  intakeSlots?: IntakeSlot[]
  /** Ejecutor del intake (write a OneLake + run-now). Opcional (sin él, la Ingesta no se ofrece). */
  intake?: IntakeRunner
  /** Estado de las últimas corridas de conversión de un slot (frente B · observabilidad). Opcional. */
  intakeStatus?: (slot: IntakeSlot) => Promise<RunRecord[]>
  /** Log de la última conversión del slot (issue #55): reconfirma una carga (filas, semana, commit)
   * sin acceso a Fabric. null = sin log (slot sin convención de log o archivo inexistente). Opcional. */
  intakeLog?: (slot: IntakeSlot) => Promise<string | null>
  /** Consola de cargas (issue #58): historial + landing + retiro/reactivación + re-run. Opcional. */
  cargas?: CargasOps
  /** Acceso a los logs POR CORRIDA (issue #99). Opcional: sin él no se ofrecen enlaces «Ver log». */
  runLogs?: RunLogsOps
  /** Registro de cargas (issue #62): dedup por contenido + pre-check. Sin él, ambos degradan a no-op. */
  intakeUploads?: IntakeUploadStore
  /** Dispara (fire-and-forget) el indexado retroactivo de `_processed/` del slot si aún no corrió.
   * Lo implementa el wiring: ni la subida ni el pre-check esperan por él. Opcional. */
  intakeBackfill?: (slot: IntakeSlot) => void
  /** Grupos gestionados por Mira (sección «Grupos»). Opcional. */
  groupStore?: GroupStore
  /** Publish-on-write: tras editar una entidad maestra, publica sus proyecciones `__replica`. Opcional. */
  onWrite?: (entity: MasterDataEntity) => Promise<void>
  /** Mapa de ingestión derivado (frente B): cadencia requerida por proceso. Opcional. */
  ingestionMap?: () => Promise<IngestionMapRow[]>
  /** Registro de fuentes (vista Fuentes en Plataforma): fuentes + procesos + salidas (topología). Opcional. */
  sourceRegistry?: () => Promise<{ sources: SourceRow[]; processes: ProcessRow[]; outputs: { processId: string; tableRef: string }[] }>
  /** Escritura del registro de fuentes (#107). Sin él, `/admin/sources` queda GET-only (solo lectura). */
  sourcesAdmin?: SourceRegistryStore
  /** Publicación de jobs en el motor (#107 fase 2). Sin él, la sección no existe (D4, fail-closed). */
  jobsPublish?: JobsPublishOps
  /** Mapa identidad→claims como estado de gobierno (#159). Sin él la sección NO existe (404): una
   * instancia que todavía sirve el mapa desde un archivo no gana una pantalla que no escribe nada. */
  identityClaims?: IdentityClaimsAdmin
  /** Identidades que el gate autenticó (para «cuántas no resuelven»). El store NO las tiene: acá vive
   * el mapa, no el registro de quién entró. Sin esta dep la sección omite el bloque — un conteo sobre
   * un universo que nadie midió sería un número fabricado, y este es el trust-base. Opcional. */
  observedIdentities?: () => Promise<string[]>
  /** Aviso de que el mapa de identidad cambió DESDE ESTA PANTALLA (#159, capacidad 4). Sin esto la
   * corrección persistiría en el store pero el resolver seguiría con la proyección vieja hasta un
   * SIGHUP o una recarga de gobierno — o sea la pantalla cumpliría a medias justo lo que el issue
   * vino a arreglar: que corregir NO exija el acto que interrumpe el servicio. */
  onIdentityChange?: (reason: string) => void
  /** Estado por proceso para la vista de Fuentes (issue #101). Opcional: sin él, la vista es el
   * registro puro (sin columnas de estado) — instancias sin motor. */
  processStates?: () => Promise<ProcessIngestionState[]>
  /** Frescura por entidad de un dominio (vista de dominio): proyección por entidad + run-history + schedule + salud. Opcional. */
  domainFreshness?: (domainId: string) => Promise<DomainEntityFreshness[]>
  /** Driver del reconciliador: empuja la cadencia derivada de un proceso al schedule del motor. Opcional. */
  applyCadence?: (processId: string, by: string) => Promise<{ action: 'set' | 'noop'; desiredSeconds: number }>
  /** Pausa/reanudación de un proceso (#107): motor primero, store después. Lo implementa el wiring. */
  pauseProcess?: (processId: string, paused: boolean, by: string) => Promise<void>
  /** Nº de PIs servidos (para el tile del dashboard). Opcional. */
  piCount?: number
  /** Resumen de la vigilancia del intake (#161) para el tile «Cargas» del dashboard, acotado a los
   *  dominios que el usuario gestiona. Lee SOLO la proyección — nunca OneLake en el request path.
   *  Opcional: sin él (instancia sin vigilante) el dashboard queda idéntico a como estaba. */
  intakeWatch?: (domainIds: string[]) => Promise<{ vigilados: number; enAlerta: number; sinMedir: number }>
  /** Settings de plataforma (título del catálogo, etc.). Opcional. */
  settingStore?: PlatformSettingStore
  /** Identidad del consumidor desde las cabeceras del gate. */
  identityOf: (headers: IncomingMessage['headers']) => { user?: string }
  /** Sumidero de auditoría (append-only log del nodo). */
  audit: (event: LogEventInput) => void
  /** Secreto para el token CSRF (mismo origen que el de anotaciones del nodo). */
  secret: string
  brandTitle?: string
  /** Destino del «Cerrar sesión» (rd del sign_out). La instancia lo apunta al logout del IdP para un
   * logout completo. Default: `/admin` (logout solo de oauth2-proxy). */
  signoutRd?: string
}

export interface AdminHandler {
  /** Atiende la ruta si es /admin*. Devuelve true si la manejó (ya respondió), false si no aplica. */
  tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}

export function createAdmin(deps: AdminDeps): AdminHandler {
  const csrf = csrfFactory(deps.secret)
  const allDomains = deps.domains ?? []

  const entityById = (id: string): MasterDataEntity | undefined => deps.entities.find((e) => e.id === id)
  const domainById = (id: string): DomainDecl | undefined => allDomains.find((d) => d.id === id)

  async function tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/admin'
    if (path !== '/admin' && !path.startsWith('/admin/')) return false

    const email = (deps.identityOf(req.headers).user ?? '').toLowerCase()
    const isAdmin = await deps.adminStore.isAdmin(email)
    // Steward de TODOS los dominios si pertenece a un default-steward-group (p.ej. Centro de Excelencia).
    let stewardAll = false
    if (deps.domainStewardGroups?.length && deps.groupStore && email) {
      const ug = await deps.groupStore.groupsOf(email)
      stewardAll = ug.some((g) => deps.domainStewardGroups!.includes(g))
    }
    const canMng = (d: DomainDecl): boolean => isAdmin || stewardAll || canManageDomain(d, email, false)
    const manageable = isAdmin || stewardAll ? allDomains : manageableDomains(allDomains, email, isAdmin)
    if (!isAdmin && manageable.length === 0) {
      deps.audit({ type: 'admin-access-denied', user: email || '(anónimo)', path })
      const bare: Chrome = { sidebar: buildSidebar(deps, [], 'gestion', 'home', false), avatar: buildAvatar(deps, email, false, false) }
      send(res, 403, adminPage(deps, bare, 'Acceso restringido', `<p class="msg err">No gestionas ninguna plataforma ni dominio.</p><p>Sesión actual: <code>${escapeHtml(email || '(anónima)')}</code>. ¿No eres tú? <a href="/oauth2/sign_out?rd=%2Fadmin">Inicia sesión con otra cuenta</a>.</p><p><a href="/">← Volver al catálogo</a></p>`))
      return true
    }
    const token = csrf(email)
    const url = new URL(req.url ?? '/', 'http://localhost')
    // Scope (Gestión de dominios · Configuración de plataforma · Perfil) + item activo, según la ruta.
    let scope = 'gestion'
    let active = 'home'
    // `active` codifica el nodo del árbol: home · dom:<id> · dom:<id>/<faceta> · dom:<id>/maestra/<entidad>.
    const dmActive = path.match(/^\/admin\/dominio\/([a-z][a-z0-9_-]*)(?:\/([a-z]+))?$/)
    if (path === '/admin/perfil') { scope = 'perfil'; active = '' }
    else if (path === '/admin/plataforma' || path.startsWith('/admin/settings')) { scope = 'config'; active = 'plat' }
    else if (path.startsWith('/admin/roles')) { scope = 'config'; active = 'roles' }
    else if (path.startsWith('/admin/groups')) { scope = 'config'; active = 'groups' }
    else if (path.startsWith('/admin/sources')) { scope = 'config'; active = 'sources' }
    else if (path.startsWith('/admin/identidades')) { scope = 'config'; active = 'identidades' }
    else if (dmActive) active = dmActive[2] ? `dom:${dmActive[1]}/${dmActive[2]}` : `dom:${dmActive[1]}`
    else {
      const emActive = path.match(/^\/admin\/e\/([a-z][a-z0-9_]*)/)
      if (emActive) {
        const e = entityById(emActive[1])
        active = e?.domain ? `dom:${e.domain}/maestra/${e.id}` : 'home'
      }
    }
    const nav: Chrome = { sidebar: buildSidebar(deps, manageable, scope, active, isAdmin), avatar: buildAvatar(deps, email, isAdmin, manageable.length > 0) }
    const denyPlatform = (): boolean => {
      send(res, 403, adminPage(deps, nav, 'Solo plataforma', `<p class="msg err">Esta sección es de gestión de plataforma (solo administradores).</p>`))
      return true
    }

    try {
      // ── HOME · dashboard de salud ────────────────────────────────────────
      if (path === '/admin' && req.method === 'GET') {
        send(res, 200, await dashboard(deps, nav, email, isAdmin, manageable))
        return true
      }
      // ── Perfil (personal · siempre accesible) ────────────────────────────
      if (path === '/admin/perfil' && req.method === 'GET') {
        send(res, 200, perfilPage(deps, nav, email, isAdmin, manageable))
        return true
      }

      // ── GESTIÓN DE DOMINIO · /admin/dominio/<id> = MENÚ; /<id>/ingesta y /<id>/intake/<slot> ──
      // El home del dominio es un menú de facetas (tarjetas); cada operación vive en su propia página.
      const di = path.match(/^\/admin\/dominio\/([a-z][a-z0-9_-]*)(?:\/([a-z]+)(?:\/([a-z][a-z0-9_]*)(?:\/(precheck))?)?)?$/)
      if (di) {
        const domain = domainById(di[1])
        if (!domain) {
          send(res, 404, adminPage(deps, nav, 'No encontrado', `<p class="msg err">Dominio desconocido: <code>${escapeHtml(di[1])}</code></p>`))
          return true
        }
        if (!canMng(domain)) {
          deps.audit({ type: 'admin-access-denied', user: email || '(anónimo)', path })
          send(res, 403, adminPage(deps, nav, 'Acceso restringido', `<p class="msg err">No gestionas el dominio <code>${escapeHtml(domain.id)}</code>.</p>`))
          return true
        }
        const section = di[2]
        const slotId = di[3]
        if (!section && req.method === 'GET') {
          send(res, 200, await domainPage(deps, nav, domain))
          return true
        }
        if (section === 'maestra' && req.method === 'GET') {
          send(res, 200, maestraPage(deps, nav, domain))
          return true
        }
        // La carga de archivos se plegó dentro de Frescura (refresco manual). Redirige para no romper enlaces.
        if (section === 'ingesta' && req.method === 'GET') {
          redirect(res, `/admin/dominio/${domain.id}/frescura`)
          return true
        }
        // Pre-check de duplicados (issue #62): CONSULTIVO — viaja con hashes, no con archivos, y se
        // responde antes de que los bytes salgan del browser. Jamás rechaza por duplicado.
        if (section === 'intake' && slotId && di[4] === 'precheck' && req.method === 'POST') {
          await handlePrecheck(deps, domain, slotId, req, res, token)
          return true
        }
        if (section === 'intake' && slotId && !di[4] && req.method === 'POST') {
          await handleIntake(deps, nav, domain, slotId, req, res, token, email)
          return true
        }
        // Consola de CARGAS (issue #58): historial + landing + retiro/reactivación + re-run. Stewards.
        if (section === 'cargas' && deps.cargas && req.method === 'GET') {
          send(res, 200, await cargasPage(deps, nav, domain, token, url.searchParams))
          return true
        }
        if (section === 'cargas' && deps.cargas && req.method === 'POST') {
          const f = await readForm(req)
          requireCsrf(f, token)
          const slot = (deps.intakeSlots ?? []).find((s) => s.id === (f['slot'] ?? '') && (s.domain ?? '') === domain.id)
          let msg: string
          if (!slot) msg = 'Error: slot desconocido.'
          else {
            try {
              const r = await handleCargasAccion(deps, slot, f, email)
              if (typeof r !== 'string') {
                // #63 · excepción puntual al PRG: la confirmación de una reversión ES una página (el
                // plan derivado). Los errores siguen cayendo al redirect con su `msg`.
                send(res, 200, adminPage(deps, nav, `${domain.label} · Revertir carga`, revertPlanBody(domain.id, domain.label, slot, r.plan, token, r.aviso)))
                return true
              }
              msg = r
            } catch (e) {
              msg = `Error: ${errMsg(e)}`
            }
          }
          // #178 · la acción vuelve a la casilla sobre la que se ejecutó (retirar en B no aterriza en A).
          const volver = slot ? cargasHref(domain.id, slot.id) : `/admin/dominio/${domain.id}/cargas`
          redirect(res, `${volver}${slot ? '&' : '?'}msg=${encodeURIComponent(msg)}`)
          return true
        }
        // Log de UNA corrida (issue #99): fallida O exitosa — `Completed` no garantiza el dato.
        if (section === 'corrida' && deps.runLogs && req.method === 'GET') {
          send(res, 200, await corridaPage(deps, nav, domain, url.searchParams))
          return true
        }
        // Frescura del dominio (por entidad): vista + «aplicar cadencia» (reconciliador). Abierta a stewards.
        if (section === 'frescura' && deps.domainFreshness && req.method === 'GET') {
          send(res, 200, await domainFreshnessPage(deps, nav, domain, token, url.searchParams.get('msg') ?? undefined, url.searchParams.get('destino')))
          return true
        }
        // Un solo POST para las acciones por proceso de Frescura: `accion` rutea. Ausente = «aplicar»
        // (la conducta de siempre: los forms ya publicados no llevan el campo).
        if (section === 'frescura' && (deps.applyCadence ?? deps.pauseProcess) && req.method === 'POST') {
          const f = await readForm(req)
          requireCsrf(f, token)
          const accion = (f['accion'] ?? '').trim()
          let msg: string
          try {
            if (accion === 'pausar' || accion === 'reanudar') {
              if (!deps.pauseProcess) throw new ValidationError('La pausa de procesos no está disponible en esta instancia.')
              await deps.pauseProcess(f['process'] ?? '', accion === 'pausar', email)
              msg = accion === 'pausar' ? 'Proceso pausado.' : 'Proceso reanudado.'
            } else if (!deps.applyCadence) {
              throw new ValidationError('Aplicar cadencia no está disponible en esta instancia.')
            } else {
              const plan = await deps.applyCadence(f['process'] ?? '', email)
              msg = plan.action === 'set' ? 'Cadencia aplicada al motor.' : 'El schedule ya estaba en la cadencia requerida.'
            }
          } catch (e) {
            msg = `Error: ${errMsg(e)}`
          }
          redirect(res, `/admin/dominio/${domain.id}/frescura?msg=${encodeURIComponent(msg)}`)
          return true
        }
      }

      // ── GESTIÓN DE PLATAFORMA (solo admin) ───────────────────────────────
      if (path === '/admin/plataforma' && req.method === 'GET') {
        if (!isAdmin) return denyPlatform()
        send(res, 200, await platformPage(deps, nav, token))
        return true
      }
      if (path === '/admin/roles' && req.method === 'GET') {
        if (!isAdmin) return denyPlatform()
        send(res, 200, await rolesPage(deps, nav, token))
        return true
      }
      if (path === '/admin/roles/add' && req.method === 'POST') {
        if (!isAdmin) return denyPlatform()
        const f = await readForm(req)
        requireCsrf(f, token)
        try {
          const added = await deps.adminStore.add(f['email'] ?? '', email)
          if (added) deps.audit({ type: 'admin-roles-write', op: 'add', target: (f['email'] ?? '').toLowerCase(), by: email })
          redirect(res, '/admin/roles')
        } catch (e) {
          send(res, 400, await rolesPage(deps, nav, token, errMsg(e)))
        }
        return true
      }
      if (path === '/admin/roles/remove' && req.method === 'POST') {
        if (!isAdmin) return denyPlatform()
        const f = await readForm(req)
        requireCsrf(f, token)
        try {
          await deps.adminStore.remove(f['email'] ?? '')
          deps.audit({ type: 'admin-roles-write', op: 'remove', target: (f['email'] ?? '').toLowerCase(), by: email })
          redirect(res, '/admin/roles')
        } catch (e) {
          send(res, e instanceof AdminLockout ? 409 : 400, await rolesPage(deps, nav, token, errMsg(e)))
        }
        return true
      }
      // Settings de plataforma de la CAPA DE NOTAS (A7): retención + límites, validados con el
      // MISMO parser que los consume (un valor inválido se rechaza acá, no al momento de purgar).
      if (deps.settingStore && path === '/admin/settings/notas' && req.method === 'POST') {
        if (!isAdmin) return denyPlatform()
        const f = await readForm(req)
        requireCsrf(f, token)
        try {
          const ret = (f['notas_retencion_impresiones'] ?? '').trim().toUpperCase()
          const max = (f['notas_max_schedules_usuario'] ?? '').trim()
          const anti = (f['notas_anti_cementerio'] ?? 'off').trim().toLowerCase() === 'on' ? 'on' : 'off'
          validarRetencion(ret)
          validarMaxSchedules(max)
          await deps.settingStore.setSetting(NOTAS_SETTINGS.retencionImpresiones.key, ret, email)
          await deps.settingStore.setSetting(NOTAS_SETTINGS.maxSchedulesUsuario.key, max, email)
          await deps.settingStore.setSetting(NOTAS_SETTINGS.antiCementerio.key, anti, email)
          deps.audit({ type: 'platform-setting', key: 'notas', value: `${ret}·${max}·${anti}`, by: email })
          redirect(res, '/admin/plataforma')
        } catch (e) {
          send(res, 400, await platformPage(deps, nav, token, errMsg(e)))
        }
        return true
      }
      // Settings de plataforma (título del catálogo)
      if (deps.settingStore && path === '/admin/settings' && req.method === 'POST') {
        if (!isAdmin) return denyPlatform()
        const f = await readForm(req)
        requireCsrf(f, token)
        const val = (f['index_title'] ?? '').trim()
        await deps.settingStore.setSetting('index_title', val, email)
        deps.audit({ type: 'platform-setting', key: 'index_title', value: val, by: email })
        redirect(res, '/admin/plataforma')
        return true
      }
      // Grupos de Mira
      if (deps.groupStore && (path === '/admin/groups' || path.startsWith('/admin/groups/'))) {
        if (!isAdmin) return denyPlatform()
        if (await handleGroups(deps, nav, deps.groupStore, path, req, res, token, email)) return true
      }
      // Fuentes (registro técnico): gestión de PLATAFORMA — conectar fuentes + su oferta + topología.
      if (deps.sourceRegistry && path === '/admin/sources' && req.method === 'GET') {
        if (!isAdmin) return denyPlatform()
        send(res, 200, await sourcesPage(deps, nav, token, url.searchParams.get('msg') ?? undefined, url.searchParams.get('edit') ?? undefined, url.searchParams.get('editp') ?? undefined))
        return true
      }
      // ── Publicación de jobs en el motor (#107 fase 2) — DOS FASES con plan sellado por hash (D5) ──
      // Va ANTES de la gestión del registro porque comparte el prefijo `/admin/sources/`: sin esta
      // guarda, `publish-plan` caería en `handleSourcesWrite` como «operación desconocida».
      if (path === '/admin/sources/publish-plan' || path === '/admin/sources/publish-exec' || path === '/admin/sources/publish-reverify') {
        // Fail-closed (D4): sin publisher cableado la ruta NO existe (404), y solo entonces; el 403 por
        // rol se decide después, para que un no-admin no aprenda si la instancia publica o no.
        if (!publicaOn(deps) || req.method !== 'POST') {
          send(res, 404, adminPage(deps, nav, 'No encontrado', `<p class="msg err">Ruta no encontrada.</p>`))
          return true
        }
        if (!isAdmin) return denyPlatform()
        const f = await readForm(req)
        requireCsrf(f, token)
        try {
          if (path === '/admin/sources/publish-reverify') {
            const msg = await reverificarPublicacion(deps, f, email)
            redirect(res, `/admin/sources?msg=${encodeURIComponent(msg)}`)
            return true
          }
          const ctx = await derivarPublicacion(deps, f)
          if (path === '/admin/sources/publish-plan') {
            deps.audit({ type: 'jobs-publish', op: 'publish-plan', process: ctx.proc.id, template: `${ctx.tpl.template.id}@${ctx.tpl.template.version}`, sha: ctx.rendered.sha256, by: email })
            send(res, 200, adminPage(deps, nav, 'Publicar el job', publishPlanBody(ctx, token)))
            return true
          }
          // publish-exec: el hash sella el plan CONFIRMADO. Si el estado cambió, no se ejecuta nada.
          const hash = (f['hash'] ?? '').trim()
          if (!hash) throw new ValidationError('Falta el sello del plan confirmado.')
          if (hash !== ctx.plan.hash) {
            send(res, 409, adminPage(deps, nav, 'Publicar el job', publishPlanBody(ctx, token, 'El estado cambió desde que viste este plan — revisalo de nuevo.')))
            return true
          }
          const out = await ejecutarPublicacion(deps, ctx, email)
          if (out.outcome === 'ok') {
            redirect(res, `/admin/sources?msg=${encodeURIComponent(out.msg)}`)
            return true
          }
          // Los otros tres desenlaces YA quedaron en el ledger: la página los muestra con su detalle
          // crudo (el `errorCode` de Fabric, el `operationId` del LRO) en vez de esconderlos tras un PRG.
          send(res, 200, await sourcesPage(deps, nav, token, `Error: ${out.msg}`))
          return true
        } catch (e) {
          send(res, statusForError(e), await sourcesPage(deps, nav, token, `Error: ${errMsg(e)}`))
          return true
        }
      }
      // Gestión in-app del registro (#107): alta/edición/baja de fuentes, procesos, salidas y mapeos.
      // TODAS son de plataforma (solo admin): un steward no gestiona el registro transversal.
      if (deps.sourceRegistry && deps.sourcesAdmin && path.startsWith('/admin/sources/') && req.method === 'POST') {
        if (!isAdmin) return denyPlatform()
        const f = await readForm(req)
        requireCsrf(f, token)
        try {
          const msg = await handleSourcesWrite(deps, deps.sourcesAdmin, path.slice('/admin/sources/'.length), f, email)
          redirect(res, `/admin/sources?msg=${encodeURIComponent(msg)}`)
        } catch (e) {
          // Todo lo que puede fallar acá es entrada del cliente: la valida la ruta (dominio declarado,
          // fuente existente, tripleta del motor) o el store (slug, oferta). 409 solo el conflicto de
          // dependientes; el resto se re-renderiza con 400 para que el admin corrija sin perder la vista.
          send(res, e instanceof GovernanceConflict ? 409 : 400, await sourcesPage(deps, nav, token, `Error: ${errMsg(e)}`))
        }
        return true
      }

      // ── Mapa identidad→claims (#159) ─────────────────────────────────────
      // Gestión de PLATAFORMA, y la más sensible del producto: lo que acá se escribe es el TRUST-BASE
      // sobre el que se aplica TODA política de datos. Mismos gates que Fuentes —admin-only, CSRF por
      // identidad, auditoría por escritura— y por la misma razón: un steward no toca lo transversal.
      if (deps.identityClaims && path === '/admin/identidades' && req.method === 'GET') {
        if (!isAdmin) return denyPlatform()
        send(res, 200, await identidadesPage(deps, nav, token, url.searchParams.get('msg') ?? undefined, url.searchParams.get('edit') ?? undefined))
        return true
      }
      if (deps.identityClaims && path.startsWith('/admin/identidades/') && req.method === 'POST') {
        if (!isAdmin) return denyPlatform()
        const f = await readForm(req)
        requireCsrf(f, token)
        try {
          const msg = await handleIdentityWrite(deps, deps.identityClaims, path.slice('/admin/identidades/'.length), f, email)
          // Recarga en caliente TRAS la escritura, no antes: si la escritura falló, no hay nada que
          // reproyectar y avisar igual haría releer el store para nada.
          deps.onIdentityChange?.('admin:identidades')
          redirect(res, `/admin/identidades?msg=${encodeURIComponent(msg)}`)
        } catch (e) {
          // Todo lo que falla acá es entrada del cliente (email inválido, claim sin valor, operación
          // desconocida): se re-renderiza la vista con el error para corregir sin perderla de vista.
          send(res, statusForError(e), await identidadesPage(deps, nav, token, `Error: ${errMsg(e)}`))
        }
        return true
      }

      // ── Data maestra: /admin/e/<id>[/insert|update|delete] ───────────────
      const m = path.match(/^\/admin\/e\/([a-z][a-z0-9_]*)(?:\/(insert|update|delete))?$/)
      if (m) {
        const entity = entityById(m[1])
        if (!entity) {
          send(res, 404, adminPage(deps, nav, 'No encontrado', `<p class="msg err">Entidad desconocida: <code>${escapeHtml(m[1])}</code></p>`))
          return true
        }
        // Autz: admin O steward del dominio de la entidad (entidad sin dominio → solo admin).
        const entDomain = entity.domain ? domainById(entity.domain) : undefined
        const canEdit = entDomain ? canMng(entDomain) : isAdmin
        if (!canEdit) {
          deps.audit({ type: 'admin-access-denied', user: email || '(anónimo)', path })
          send(res, 403, adminPage(deps, nav, 'Acceso restringido', `<p class="msg err">No gestionas la entidad <code>${escapeHtml(entity.id)}</code>.</p>`))
          return true
        }
        const op = m[2]
        if (!op && req.method === 'GET') {
          const editPk = url.searchParams.get('edit') ?? undefined
          send(res, 200, await entityPage(deps, nav, entity, token, editPk))
          return true
        }
        if (op && req.method === 'POST') {
          const f = await readForm(req)
          requireCsrf(f, token)
          await handleEntityWrite(deps, entity, op, f, email)
          // publish-on-write: publica las proyecciones tras la edición (no-fatal: la autoría ya se
          // escribió; si la publicación falla, el dato queda en Mira y se republica luego).
          if (deps.onWrite) {
            try {
              await deps.onWrite(entity)
              deps.audit({ type: 'master-data-publish', entity: entity.id, by: email, ok: true })
            } catch (e) {
              deps.audit({ type: 'master-data-publish', entity: entity.id, by: email, ok: false, error: e instanceof Error ? e.message : String(e) })
            }
          }
          redirect(res, `/admin/e/${entity.id}`)
          return true
        }
      }
      send(res, 404, adminPage(deps, nav, 'No encontrado', `<p class="msg err">Ruta no encontrada.</p>`))
      return true
    } catch (e) {
      send(res, statusForError(e), adminPage(deps, nav, 'Error', `<p class="msg err">${escapeHtml(errMsg(e))}</p>`))
      return true
    }
  }

  return { tryHandle }
}

// ─── Ingesta de archivos (gestión de dominio) ────────────────────────────────
/**
 * Cómo se NOMBRA la carga original en el aviso de duplicado (issue #62).
 *
 * Formato ya en producción para las cargas vividas (`<filename> · <YYYY-MM-DD HH:MM> UTC`): el audit
 * log lo trae escrito así desde 0.7.0 y no se re-formatea. Para una fila derivada del indexado
 * retroactivo de `_processed/` lo único que se sabe es que el archivo YA fue procesado, y eso dice.
 */
export function dupLabel(row: Pick<IntakeUploadRow, 'filename' | 'uploadedAt' | 'origen'>): string {
  const cuando = `${row.uploadedAt.slice(0, 16).replace('T', ' ')} UTC`
  return row.origen === 'retro' ? `${row.filename} · procesado el ${cuando}` : `${row.filename} · ${cuando}`
}

const SHA_RE = /^[0-9a-f]{64}$/

/**
 * Pre-check de duplicados por hash (issue #62): el browser calcula el SHA-256 de cada archivo y
 * pregunta ANTES de subir. Consultivo por contrato — sin store responde `{dups:[]}` y el form se
 * envía sin aviso previo; el server siempre recalcula el sha con sus propios bytes al recibir.
 */
async function handlePrecheck(
  deps: AdminDeps,
  domain: DomainDecl,
  slotId: string,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  const slot = (deps.intakeSlots ?? []).find((s) => s.id === slotId && (s.domain ?? '') === domain.id)
  const json = (code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const f = await readForm(req)
  requireCsrf(f, token) // CSRF inválido → CsrfError → 403 (catch del tryHandle)
  if (!slot) {
    json(404, { dups: [] })
    return
  }
  if (!deps.intakeUploads) {
    json(200, { dups: [] })
    return
  }
  deps.intakeBackfill?.(slot) // primer contacto con el slot: indexa `_processed/` en background
  const shas = [...new Set((f['shas'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => SHA_RE.test(s)))].slice(0, 50)
  const dups: { sha256: string; filename: string; uploadedAt: string; origen: string }[] = []
  for (const sha of shas) {
    const prev = await deps.intakeUploads.findUploadBySha(slot.id, sha).catch(() => null)
    if (prev) dups.push({ sha256: sha, filename: prev.filename, uploadedAt: prev.uploadedAt, origen: prev.origen })
  }
  json(200, { dups })
}

async function handleIntake(
  deps: AdminDeps,
  nav: Chrome,
  domain: DomainDecl,
  slotId: string,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  by: string,
): Promise<void> {
  const slot = (deps.intakeSlots ?? []).find((s) => s.id === slotId && (s.domain ?? '') === domain.id)
  if (!slot || !deps.intake) {
    send(res, deps.intake ? 404 : 503, adminPage(deps, nav, 'Ingesta', `<p class="msg err">${deps.intake ? `Slot desconocido: <code>${escapeHtml(slotId)}</code>` : 'La ingesta no está habilitada en esta instancia.'}</p>`))
    return
  }
  const { fields, files } = await readMultipart(req, 60 * 1024 * 1024) // headroom para lotes
  requireCsrf(fields, token) // CSRF inválido → CsrfError → 403 (catch del tryHandle)
  // #178 · el desenlace de la carga vuelve a la pantalla donde el usuario ESTABA. El form declara su
  // origen con un valor ACOTADO (`origen=cargas`), nunca con una URL: un campo de formulario no elige
  // el destino de un redirect. Sin el campo —los forms de Frescura, un cliente viejo— el destino es
  // Frescura, exactamente como antes: lo que nace en Frescura sigue muriendo en Frescura.
  const enCargas = fields['origen'] === 'cargas'
  const volver = (msg: string, destinos: IntakeSlot[] = []): string => {
    // Los candidatos viajan como IDS de slot; el label y el enlace los resuelve la página que aterriza.
    const d = destinos.length ? `&destino=${encodeURIComponent(destinos.map((s) => s.id).join(','))}` : ''
    const base = enCargas ? cargasHref(domain.id, slot.id) + '&' : `/admin/dominio/${domain.id}/frescura?`
    return `${base}msg=${encodeURIComponent(msg)}${d}`
  }
  const uploads = files.filter((f) => f.field === 'file' && f.filename)
  if (uploads.length === 0) {
    redirect(res, volver('Error: no se adjuntó ningún archivo.'))
    return
  }
  deps.intakeBackfill?.(slot) // el indexado retroactivo de `_processed/` converge solo, en background
  // Identidad del CONTENIDO (issue #62): el sha se calcula una vez por archivo y acompaña a la carga
  // en todos sus registros — incluidos los rechazos, que también son historia del slot.
  const shas = uploads.map((u) => createHash('sha256').update(u.bytes).digest('hex'))
  const uploadRow = (i: number, ok: boolean, extra: Partial<Omit<IntakeUploadRow, 'id'>> = {}): Omit<IntakeUploadRow, 'id'> => ({
    slotId: slot.id, filename: uploads[i]!.filename, sha256: shas[i]!, bytes: uploads[i]!.bytes.length,
    uploadedBy: by, uploadedAt: new Date().toISOString(), ok, triggered: false, origen: 'upload', ...extra,
  })
  const registrar = async (row: Omit<IntakeUploadRow, 'id'>): Promise<number | undefined> =>
    deps.intakeUploads ? await deps.intakeUploads.recordUpload(row).catch(() => undefined) : undefined
  // Validar TODOS antes de aterrizar ninguno: o entra el lote completo o ninguno (atomicidad — evita
  // dejar la semana a medio cargar). El SJD failure-safe espera el set consistente, no archivos sueltos.
  for (const [i, u] of uploads.entries()) {
    const v = validateUpload(slot, u.filename, u.bytes.length)
    if (!v.ok) {
      await registrar(uploadRow(i, false, { error: v.error }))
      deps.audit({ type: 'intake', slot: slot.id, domain: domain.id, filename: u.filename, bytes: u.bytes.length, by, ok: false, error: v.error })
      // #178 · el rechazo por PATRÓN es el único con destino computable: qué otra casilla del dominio
      // aceptaría este archivo, según su `accept` declarado. Si ninguna, la lista va vacía y el mensaje
      // queda como está — no se adivina un destino. Si varias, se listan todas.
      const destinos = v.reason === 'accept'
        ? slotsQueAceptan((deps.intakeSlots ?? []).filter((s) => (s.domain ?? '') === domain.id), u.filename, slot.id)
        : []
      redirect(res, volver('Error: ' + v.error, destinos))
      return
    }
  }
  // Metadata requerida del slot (issue #76): la subida DEBE traer los campos declarados — la validación
  // aquí es la que manda (la del browser es cortesía). Un campo requerido sin valor, o un valor que no
  // calza el tipo, rechaza el LOTE completo (misma atomicidad). Los campos llegan como `meta_<id>`.
  // Un campo con `from_filename` (#95) se resuelve POR ARCHIVO desde su nombre: un lote puede traer
  // `Listado EasyDoc VH.xlsx` y `Listado SAP COVH.xlsx` y cada uno lleva su propio sidecar.
  const submittedMeta: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) if (k.startsWith('meta_')) submittedMeta[k.slice('meta_'.length)] = v
  const metaPorArchivo: { values: Record<string, string>; verify?: Record<string, string> }[] = []
  for (const [i, u] of uploads.entries()) {
    const metaCheck = validateMeta(slot, submittedMeta, u.filename)
    if (!metaCheck.ok) {
      await registrar(uploadRow(i, false, { error: metaCheck.error }))
      deps.audit({ type: 'intake', slot: slot.id, domain: domain.id, filename: u.filename, bytes: u.bytes.length, by, ok: false, error: metaCheck.error })
      redirect(res, volver('Error: ' + metaCheck.error))
      return
    }
    metaPorArchivo.push({ values: metaCheck.values, ...(metaCheck.verify ? { verify: metaCheck.verify } : {}) })
  }
  // UN SOLO disparo por LOTE (no uno por archivo: N triggers = N corridas = throttling de capacidad).
  const willTrigger = !!(slot.trigger && deps.intake.runNow)
  // Sidecar (issue #76): solo si el slot declara `meta` — sin `meta` NO se escribe sidecar y el flujo es
  // idéntico al de siempre (regresión cero). Un solo `uploadedAt` para todo el lote (misma subida).
  const hasMeta = (slot.meta?.length ?? 0) > 0
  const uploadedAt = new Date().toISOString()
  // Aterriza cada crudo en la landing zone OneLake (staging). El pipeline/SJD lee de ahí y transforma.
  const duplicados: string[] = []
  // Dedup por CONTENIDO (issue #62): el sha vs las cargas previas del slot en el registro — el NOMBRE
  // no participa (las copias re-descargadas llegan como «… (1) (1).xlsx»). Avisar, NUNCA bloquear:
  // re-procesar idéntico es legítimo (re-materialización); lo que se elimina es la sorpresa.
  // Check-then-insert POR ARCHIVO y en orden: dos idénticos del MISMO lote también se detectan.
  for (const [i, u] of uploads.entries()) {
    const sha256 = shas[i]!
    const previa = deps.intakeUploads ? await deps.intakeUploads.findUploadBySha(slot.id, sha256).catch(() => null) : null
    const dupOf = previa ? dupLabel(previa) : null
    if (dupOf) duplicados.push(`«${u.filename}» es idéntico a ${dupOf}`)
    const m = metaPorArchivo[i]!
    const sidecar = hasMeta ? buildSidecar(slot.id, m.values, by, uploadedAt, m.verify) : undefined
    await deps.intake.put(slot.target, u.filename, u.bytes, sidecar)
    await registrar(uploadRow(i, true, { uploadedAt, triggered: willTrigger, ...(previa ? { dupOfId: previa.id } : {}) }))
    deps.audit({ type: 'intake', slot: slot.id, domain: domain.id, filename: u.filename, bytes: u.bytes.length, by, ok: true, triggered: willTrigger, sha256, ...(dupOf ? { dupOf } : {}) })
  }
  if (willTrigger) await deps.intake.runNow!(slot.trigger!, slot.target)
  const aviso = duplicados.length ? ` ⚠ Contenido ya procesado antes: ${duplicados.join('; ')} — re-procesarlo no cambiará el dato.` : ''
  redirect(res, volver(`${uploads.length} archivo(s) recibido(s).${aviso}${willTrigger ? ' La carga está corriendo — seguila en «Última corrida».' : ''}`))
}

async function handleEntityWrite(
  deps: AdminDeps,
  entity: MasterDataEntity,
  op: string,
  f: Record<string, string>,
  by: string,
): Promise<void> {
  const pk = pkColumn(entity)
  if (op === 'delete') {
    const pkVal = f[pk.name] ?? ''
    await deps.mdStore.remove(entity, pkVal)
    deps.audit({ type: 'master-data-write', entity: entity.id, op: 'delete', pk: pkVal, by })
    return
  }
  const coerced = coerceRow(entity, f)
  if (!coerced.ok) throw new ValidationError(coerced.errors.join(' '))
  const values: MasterDataRow = coerced.values
  const pkVal = String(values[pk.name] ?? '')
  if (op === 'insert') {
    await deps.mdStore.insert(entity, values)
    deps.audit({ type: 'master-data-write', entity: entity.id, op: 'insert', pk: pkVal, by })
  } else {
    await deps.mdStore.update(entity, pkVal, values)
    deps.audit({ type: 'master-data-write', entity: entity.id, op: 'update', pk: pkVal, by })
  }
}

// ─── Render (SSR, mismo lenguaje visual que el índice) ───────────────────────

/** Menú lateral — ÁRBOL de navegación del SCOPE activo. En Gestión, el dominio activo se expande a sus
 * facetas (Ingesta · Data Maestra → entidades · Fuentes); en Configuración, las opciones de plataforma. */
function buildSidebar(deps: AdminDeps, manageable: DomainDecl[], scope: string, active: string, isAdmin: boolean): string {
  const lvl = (href: string, label: string, on: boolean, cls = ''): string =>
    `<a href="${escapeHtml(href)}" class="${[cls, on ? 'on' : ''].filter(Boolean).join(' ')}">${escapeHtml(label)}</a>`
  let s = `<span class="bca">${escapeHtml(deps.brandTitle ?? 'Vergis')} · Admin</span>`
  s += `<a href="/" class="catlink">↩ Catálogo de PIs</a>`
  if (scope === 'config') {
    s += lvl('/admin/plataforma', 'Resumen', active === 'plat')
    s += `<div class="grp">Configuración</div>`
    s += lvl('/admin/roles', 'Usuarios y Roles', active === 'roles')
    if (deps.groupStore) s += lvl('/admin/groups', 'Grupos de Mira', active === 'groups')
    if (deps.sourceRegistry) s += lvl('/admin/sources', 'Fuentes', active === 'sources')
    if (deps.identityClaims) s += lvl('/admin/identidades', 'Mapa de identidad', active === 'identidades')
  } else {
    s += lvl('/admin', 'Inicio', active === 'home')
    if (manageable.length) {
      s += `<div class="grp">Dominios</div>`
      for (const d of manageable) {
        const base = `dom:${d.id}`
        const inDomain = active === base || active.startsWith(`${base}/`)
        s += lvl(`/admin/dominio/${d.id}`, d.label, active === base) // nodo dominio
        if (!inDomain) continue
        // Sub-árbol del dominio ACTIVO: sus facetas. La carga de archivos se pliega dentro de Frescura.
        const ents = deps.entities.filter((e) => (e.domain ?? '') === d.id)
        if (ents.length) {
          const inMaestra = active === `${base}/maestra` || active.startsWith(`${base}/maestra/`)
          s += lvl(`/admin/dominio/${d.id}/maestra`, 'Data Maestra', active === `${base}/maestra`, 'l2')
          if (inMaestra) s += ents.map((e) => lvl(`/admin/e/${e.id}`, e.label, active === `${base}/maestra/${e.id}`, 'l3')).join('')
        }
        if (deps.domainFreshness) s += lvl(`/admin/dominio/${d.id}/frescura`, 'Frescura', active === `${base}/frescura`, 'l2')
        if (deps.cargas && (deps.intakeSlots ?? []).some((sl) => (sl.domain ?? '') === d.id)) {
          s += lvl(`/admin/dominio/${d.id}/cargas`, 'Cargas', active === `${base}/cargas`, 'l2')
        }
      }
    }
  }
  return s
}

/** Avatar (arriba-derecha, siempre) → menú de identidad: Perfil · Gestión · Configuración · salir.
 * Usa el componente compartido (`avatarMenu`) — el mismo marco del catálogo. */
function buildAvatar(deps: AdminDeps, email: string, isAdmin: boolean, hasDomains: boolean): string {
  return avatarMenu({ email, isAdmin, hasDomains, signoutRd: deps.signoutRd ?? '/admin' })
}

const tile = (n: string | number, label: string, warn = false): string =>
  `<div class="tile${warn ? ' warn' : ''}"><div class="n">${escapeHtml(String(n))}</div><div class="l">${escapeHtml(label)}</div></div>`

/** HOME · dashboard de salud: tiles + dominios que gestionas + (admin) entrada de Plataforma. */
async function dashboard(deps: AdminDeps, nav: Chrome, email: string, isAdmin: boolean, manageable: DomainDecl[]): Promise<string> {
  const entitiesOf = (domId: string) => deps.entities.filter((e) => (e.domain ?? '') === domId)
  const slotsOf = (domId: string) => (deps.intakeSlots ?? []).filter((s) => (s.domain ?? '') === domId)
  const domainCard = (d: DomainDecl): string => {
    const inv: string[] = []
    const ne = entitiesOf(d.id).length
    const ns = slotsOf(d.id).length
    if (ns) inv.push(`${ns} slot${ns === 1 ? '' : 's'} de ingesta`)
    if (ne) inv.push(`${ne} ${ne === 1 ? 'entidad' : 'entidades'} de data maestra`)
    return `<li><a href="/admin/dominio/${escapeHtml(d.id)}">${escapeHtml(d.label)} →</a><div class="sub">${escapeHtml(d.description ?? '')}${d.description && inv.length ? ' · ' : ''}${inv.join(' · ')}</div></li>`
  }
  const domainsSection = manageable.length
    ? `<h2>Dominios</h2><ul class="cards">${manageable.map(domainCard).join('')}</ul>`
    : ''

  // Fallback de plataforma: entidades sin dominio declarado (solo admin).
  const orphans = isAdmin ? deps.entities.filter((e) => !e.domain || !manageable.concat(deps.domains ?? []).some((d) => d.id === e.domain)) : []
  const orphanSection = orphans.length
    ? `<h2>Data Maestra (sin dominio)</h2><ul class="cards">${orphans.map((e) => `<li><a href="/admin/e/${escapeHtml(e.id)}">${escapeHtml(e.label)}</a>${e.description ? `<div class="sub">${escapeHtml(e.description)}</div>` : ''}</li>`).join('')}</ul>`
    : ''

  // Tiles de salud. Slots = los de dominios gestionables; ingestión = brecha de frescura (admin).
  const nslots = (deps.intakeSlots ?? []).filter((s) => manageable.some((d) => d.id === (s.domain ?? ''))).length
  const tiles: string[] = [tile(manageable.length, 'Dominios')]
  if (deps.piCount != null) tiles.push(tile(deps.piCount, 'PIs'))
  tiles.push(tile(nslots, nslots === 1 ? 'Slot ingesta' : 'Slots ingesta'))
  // Tile del VIGILANTE de cargas (#161·§6.1). Distingue lo que el requisito exige distinguir: «en
  // alerta» (se midió y algo está mal) de «sin medir» (no se pudo mirar) — un vigilante que confunde
  // «no hay» con «no veo» es peor que ninguno. Un fallo del resumen no tumba el dashboard.
  if (deps.intakeWatch && nslots) {
    try {
      const w = await deps.intakeWatch(manageable.map((d) => d.id))
      if (w.vigilados) {
        const detalle = [`${w.vigilados} vigilado${w.vigilados === 1 ? '' : 's'}`]
        if (w.enAlerta) detalle.push(`${w.enAlerta} en alerta`)
        if (w.sinMedir) detalle.push(`${w.sinMedir} sin medir`)
        const n = w.enAlerta ? `⚠️ ${w.enAlerta}` : w.sinMedir ? `👁 ${w.sinMedir}` : '✓'
        tiles.push(tile(n, `Cargas · ${detalle.join(' · ')}`, w.enAlerta > 0 || w.sinMedir > 0))
      }
    } catch {
      /* no-fatal */
    }
  }
  if (isAdmin && deps.ingestionMap) {
    try {
      const map = await deps.ingestionMap()
      const unsat = map.filter((r) => r.unsatisfiable).length
      tiles.push(unsat ? tile(`⚠️ ${unsat}`, 'Ingesta insatisf.', true) : tile(map.length ? '✓' : '—', 'Ingestión'))
    } catch {
      /* no-fatal */
    }
  }

  return adminPage(deps, nav,
    'Administración',
    `<h2>Salud de la plataforma</h2>
     <div class="tiles">${tiles.join('')}</div>
     ${domainsSection || (orphanSection ? '' : '<p class="sub">No gestionas ningún dominio.</p>')}
     ${orphanSection}`,
  )
}

/** Perfil (personal): quién eres, qué puedes (admin / steward de qué dominios), tema, salir. */
function perfilPage(deps: AdminDeps, nav: Chrome, email: string, isAdmin: boolean, manageable: DomainDecl[]): string {
  const roles: string[] = []
  if (isAdmin) roles.push('Administrador de plataforma')
  if (manageable.length) roles.push(`Steward de: ${manageable.map((d) => escapeHtml(d.label)).join(' · ')}`)
  return adminPage(deps, nav,
    'Perfil',
    `<table>
       <tr><th>Sesión</th><td><code>${escapeHtml(email || '(anónima)')}</code></td></tr>
       <tr><th>Permisos</th><td>${roles.length ? roles.join('<br>') : '<span class="sub">sin permisos de gestión</span>'}</td></tr>
     </table>
     <h2>Preferencias</h2>
     <p><button type="button" class="add" onclick="${THEME_TOGGLE_JS}">◐ Cambiar tema (claro/oscuro)</button></p>
     <h2>Sesión</h2>
     <p><a href="/oauth2/sign_out?rd=%2Fadmin">Cerrar sesión</a></p>`,
  )
}

// ─── Estado de conversión (render) ───────────────────────────────────────────
/** Etiqueta legible + símbolo (sin CSS extra) para un estado de corrida. */
function statusBadge(s: RunStatus): string {
  switch (s) {
    case 'Completed': return '✓ Listo'
    case 'Failed': return '✕ Falló'
    case 'InProgress': return '⏳ Procesando'
    case 'NotStarted': return '⏳ En cola'
    case 'Cancelled': return '⊘ Cancelada'
    case 'Deduped': return '⊘ Omitida (duplicada)'
    default: return s
  }
}
/** Motivo de falla de una corrida, listo para incrustar: escapado y recortado (los `failureReason`
 * de Fabric traen stacks largos; la primera parte es la que diagnostica). Vacío si no hay error. */
function runErrorLine(r: RunRecord | undefined): string {
  if (!r?.error) return ''
  const msg = r.error.length > 300 ? `${r.error.slice(0, 300)}…` : r.error
  return `<div class="sub" style="color:var(--err)">${escapeHtml(msg)}</div>`
}
/** Antigüedad legible de una corrida ('hace 2 min', o la fecha si es vieja). */
function fmtWhen(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `hace ${s}s`
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  return new Date(t).toISOString().slice(0, 10)
}
/** Home de un DOMINIO: MENÚ de facetas (una tarjeta por operación). Cada operación vive en su propia
 * página — el home no expande formularios, solo enruta (mismo patrón que la Gestión de Plataforma). */
async function domainPage(deps: AdminDeps, nav: Chrome, domain: DomainDecl): Promise<string> {
  const entities = deps.entities.filter((e) => (e.domain ?? '') === domain.id)

  // El home lista FACETAS (categorías), nunca ítems. Cada faceta abre su propia página y adentro
  // viven sus ítems (p.ej. Data Maestra → sus entidades). Una tarjeta por faceta.
  const maestra = entities.length
    ? `<li><a href="/admin/dominio/${escapeHtml(domain.id)}/maestra">Data Maestra</a><div class="sub">Entidades gobernadas del dominio (${entities.length}).</div></li>`
    : ''
  const frescura = deps.domainFreshness
    ? `<li><a href="/admin/dominio/${escapeHtml(domain.id)}/frescura">Frescura</a><div class="sub">Por entidad: qué tan fresca está vs. lo que demandan sus PIs, sus corridas y su cadencia — y <b>alimentarla</b> (subir archivo) o aplicar su cadencia.</div></li>`
    : ''
  const cargas = deps.cargas && (deps.intakeSlots ?? []).some((s) => (s.domain ?? '') === domain.id)
    ? `<li><a href="/admin/dominio/${escapeHtml(domain.id)}/cargas">Cargas</a><div class="sub">La operación completa de las cargas: historial y estado de cada conversión con su log, y el ciclo del landing — retirar, reactivar, re-correr.</div></li>`
    : ''

  const gestion = maestra || frescura || cargas
    ? `<h2>Gestión del dominio</h2><ul class="cards">${maestra}${frescura}${cargas}</ul>`
    : '<p class="sub">Este dominio aún no tiene facetas habilitadas.</p>'

  // Facetas previstas del dominio (roadmap visible, deshabilitadas) — ver work/041 §4.
  const proximamente = `<h2>Próximamente</h2><ul class="cards">${[
    'Catálogo / diccionario del dominio',
    'Linaje fuente→tabla→proceso→PI',
    'Calidad de datos (validaciones)',
    'Política de autorización / RLS del dominio',
    'Mapa de identidad del dominio',
    'Catálogo de PIs del dominio',
  ].map((l) => `<li class="ro">${escapeHtml(l)}</li>`).join('')}</ul>`

  return adminPage(deps, nav,
    domain.label,
    `${domain.description ? `<p class="sub">${escapeHtml(domain.description)}</p>` : ''}
     ${gestion}
     ${proximamente}`,
  )
}

/** Faceta DATA MAESTRA de un dominio (página propia): lista de entidades gobernadas → su editor. */
function maestraPage(deps: AdminDeps, nav: Chrome, domain: DomainDecl): string {
  const title = `${domain.label} · Data Maestra`
  const back = `<p class="sub"><a href="/admin/dominio/${escapeHtml(domain.id)}">← ${escapeHtml(domain.label)}</a></p>`
  const entities = deps.entities.filter((e) => (e.domain ?? '') === domain.id)
  if (entities.length === 0) {
    return adminPage(deps, nav, title, `${back}<p class="sub">Este dominio no tiene entidades de data maestra.</p>`)
  }
  const cards = entities
    .map((e) => `<li><a href="/admin/e/${escapeHtml(e.id)}">${escapeHtml(e.label)}</a>${e.description ? `<div class="sub">${escapeHtml(e.description)}</div>` : ''}</li>`)
    .join('')
  return adminPage(deps, nav, title, `${back}<h2>Data Maestra</h2><ul class="cards">${cards}</ul>`)
}


/** Gestión de PLATAFORMA: Usuarios y Roles · Grupos · Settings (una entrada que despliega todo). */
async function platformPage(deps: AdminDeps, nav: Chrome, token: string, msg?: string): Promise<string> {
  const curTitle = deps.settingStore ? (await deps.settingStore.getSetting('index_title')) ?? '' : ''
  const n = deps.settingStore ? await leerNotasSettings(deps.settingStore) : null
  // Capa de NOTAS (A7): la retención se APLICA hoy; el límite de envíos programados y el
  // anti-cementerio se declaran acá y se hacen cumplir cuando los envíos programados existan.
  const notasSettings = n
    ? `<h2>Notas</h2>
       <form method="post" action="/admin/settings/notas" class="grid">
         <input type="hidden" name="_csrf" value="${token}">
         <label class="fld"><span>Retención de impresiones (duración ISO-8601)</span>
           <input name="${NOTAS_SETTINGS.retencionImpresiones.key}" value="${escapeHtml(n.retencion)}" placeholder="P12M"></label>
         <label class="fld"><span>Envíos programados por usuario</span>
           <input name="${NOTAS_SETTINGS.maxSchedulesUsuario.key}" value="${escapeHtml(n.maxSchedules)}" placeholder="10"></label>
         <label class="fld"><input type="checkbox" name="${NOTAS_SETTINGS.antiCementerio.key}" value="on"${n.antiCementerio === 'on' ? ' checked' : ''}> Desactivar solos los envíos que nadie abre</label>
         <button class="add">Guardar</button>
       </form>
       <p class="sub">Una impresión vive desde su última actividad: anotarla o responder en ella la mantiene viva. Vencida, se borra con sus notas.</p>
       <p class="sub">El límite de envíos programados y el apagado automático se aplican cuando los envíos programados estén disponibles.</p>`
    : ''
  const settings = deps.settingStore
    ? `<h2>Catálogo</h2>
       <form method="post" action="/admin/settings" class="row">
         <input type="hidden" name="_csrf" value="${token}">
         <input name="index_title" value="${escapeHtml(curTitle)}" placeholder="Título del catálogo (p. ej. Productos de Información)" style="min-width:320px">
         <button class="add">Guardar</button>
       </form>
       <p class="sub">El título que se muestra en el índice de PIs. Vacío = el default de la instancia.</p>`
    : ''
  return adminPage(deps, nav,
    'Gestión de Plataforma',
    `<h2>Acceso</h2><ul class="cards"><li><a href="/admin/roles">Usuarios y Roles</a><div class="sub">Quién puede administrar.</div></li>${
       deps.groupStore ? `<li><a href="/admin/groups">Grupos de Mira</a><div class="sub">Grupos para compartir PIs (no grupos AAD).</div></li>` : ''
     }${
       deps.identityClaims ? `<li><a href="/admin/identidades">Mapa de identidad</a><div class="sub">Qué claims tiene cada identidad — el trust-base de la política de datos.</div></li>` : ''
     }</ul>
     ${msg ? `<p class="msg err">${escapeHtml(msg)}</p>` : ''}
     ${settings}
     ${notasSettings}`,
  )
}

/** Fuentes (Gestión de PLATAFORMA): registro técnico — cada fuente, su oferta, su dominio y la topología
 * de procesos→entidades que alimenta — MÁS el estado de sus ingestas cuando hay quien las observe (#101):
 * schedule observado y última corrida por proceso, leídos de la proyección local (#105), nunca del motor.
 * Sin `processStates` cableada (instancia sin motor) la vista es el registro puro: cero columnas fabricadas. */
async function sourcesPage(deps: AdminDeps, nav: Chrome, token?: string, msg?: string, editSource?: string, editProcess?: string): Promise<string> {
  // Una sola lectura de estado para TODA la tabla (cero awaits por fila). Si falla, la página no miente
  // ni revienta: degrada al registro puro con un aviso (el instrumento declara su propio fallo).
  const statesSafe = async (): Promise<{ map: Map<string, ProcessIngestionState> | null; aviso: boolean }> => {
    if (!deps.processStates) return { map: null, aviso: false }
    try {
      return { map: new Map((await deps.processStates()).map((s) => [s.processId, s])), aviso: false }
    } catch {
      return { map: null, aviso: true }
    }
  }
  const [{ sources, processes, outputs }, st] = await Promise.all([deps.sourceRegistry!(), statesSafe()])
  const states = st.map
  const conEstado = states != null
  const outsOf = (pid: string): string[] => outputs.filter((o) => o.processId === pid).map((o) => o.tableRef)
  const procsOf = (sid: string): ProcessRow[] => processes.filter((p) => p.sourceId === sid)
  // Gestión in-app (#107): los forms solo existen si hay con qué escribir. Sin `sourcesAdmin` la vista
  // es exactamente la de siempre (solo lectura) — regresión cero para instancias que gestionan por yaml.
  const gest = deps.sourcesAdmin != null && token != null
  const csrfIn = `<input type="hidden" name="_csrf" value="${token ?? ''}">`
  const post = (action: string, campos: string, label: string, cls: string, confirmar?: string): string =>
    `<form method="post" action="/admin/sources/${action}" style="display:inline"${confirmar ? ` onsubmit="return confirm('${confirmar}')"` : ''}>${csrfIn}${campos}<button class="${cls}">${label}</button></form>`
  const procedencia = (managed?: boolean): string => `<span class="sub">${managed ? 'gestionada in-app' : 'semilla (yaml)'}</span>`
  const procCell = (p: ProcessRow): string => {
    const k = p.engine ? engineKind(p.engine.jobType) : null
    // Con columnas de estado, «no observable» lo dice la columna de estado: repetirlo acá sería ruido.
    const motor = !k
      ? conEstado ? '' : ' <span class="sub">· sin motor (no observable)</span>'
      : ` <span class="sub">· ${escapeHtml(k.label)}</span>${k.isNotebook ? ' <b style="color:var(--err)">⚠ migrar a Spark Job</b>' : ''}`
    const outs = outsOf(p.id)
    const salidas = gest
      ? outs.map((t) => `${escapeHtml(t)} ${post('output-remove', `<input type="hidden" name="process" value="${escapeHtml(p.id)}"><input type="hidden" name="table" value="${escapeHtml(t)}">`, '×', 'del')}`).join(' ') || '—'
      : outs.map(escapeHtml).join(', ') || '—'
    const acciones = gest
      ? `<div class="sub">${
          p.pausedAt ? '⏸ pausado · ' : ''
        }<a class="edit" href="/admin/sources?editp=${encodeURIComponent(p.id)}">Editar</a> ${post('process-delete', `<input type="hidden" name="id" value="${escapeHtml(p.id)}">`, 'Eliminar', 'del', `¿Dar de baja el proceso ${escapeHtml(p.id)} del registro?`)}
          ${post('output-add', `<input type="hidden" name="process" value="${escapeHtml(p.id)}"><input name="table" placeholder="esquema.tabla" required>`, '+ salida', 'add')}</div>`
      : ''
    return `<div><span class="c">${escapeHtml(p.id)}</span> ${escapeHtml(p.label)}${motor}${gest ? ` · ${procedencia(p.managed)}` : ''}<div class="sub">${salidas}</div>${acciones}</div>`
  }
  // Sin observación del motor no se afirma nada del schedule: `—` (no «sin schedule», que afirmaría
  // haber mirado). Observado y vacío ⇒ «sin schedule»: la ausencia ES información.
  const schedCell = (s: ProcessIngestionState | undefined): string => {
    if (!s || !s.projection.observedAt) return '<span class="sub">—</span>'
    return s.scheduleSeconds != null ? escapeHtml(secondsToDuration(s.scheduleSeconds)) : '<span class="sub">sin schedule</span>'
  }
  const FRIA: FreshnessProjectionMeta = { observedAt: null, stale: false, lastError: null, off: false }
  const estadoCells = (src: SourceRow, p: ProcessRow): string => {
    if (!p.engine) return `<td><span class="sub">—</span></td><td><span class="sub">no observable (sin motor)</span></td>`
    const s = states!.get(p.id)
    const last = s?.runs[0]
    const runHref = deps.runLogs && src.domain && last
      ? `/admin/dominio/${encodeURIComponent(src.domain)}/corrida?proc=${encodeURIComponent(p.id)}&started=${encodeURIComponent(last.startedAt)}`
      : null
    return `<td>${schedCell(s)}</td><td>${runStateCell({ runs: s?.runs ?? [], health: s?.health, projection: s?.projection ?? FRIA, runHref })}</td>`
  }
  // Agrupación por dominio (D9): la pregunta es por instancia, pero se lee dominio a dominio. Las fuentes
  // sin dominio van al final; orden determinista dentro de cada grupo por id de fuente.
  const ordered = [...sources].sort((a, b) => {
    const da = a.domain ?? ''
    const db = b.domain ?? ''
    if (!da !== !db) return da ? -1 : 1
    return da.localeCompare(db) || a.id.localeCompare(b.id)
  })
  const rows = ordered
    .map((s) => {
      const ps = procsOf(s.id)
      const span = Math.max(1, ps.length) > 1 ? ` rowspan="${ps.length}"` : ''
      const domCell = s.domain
        ? `<a href="/admin/dominio/${encodeURIComponent(s.domain)}/frescura">${escapeHtml(s.domain)}</a>`
        : '<span class="sub">—</span>'
      const head = `<td${span}><span class="c">${escapeHtml(s.id)}</span> ${escapeHtml(s.label)}${gest ? `<div>${procedencia(s.managed)}</div>` : ''}</td><td${span}>${escapeHtml(s.oferta)}</td><td${span}>${domCell}</td>`
      const gestSource = gest
        ? `<div class="sub"><a class="edit" href="/admin/sources?edit=${encodeURIComponent(s.id)}">Editar</a> ${post('source-delete', `<input type="hidden" name="id" value="${escapeHtml(s.id)}">`, 'Eliminar', 'del', `¿Dar de baja la fuente ${escapeHtml(s.id)} del registro?`)}</div>`
        : ''
      const tail = `<td${span} class="sub">${escapeHtml(s.connectedBy ?? '—')}${gestSource}</td>`
      if (!ps.length) {
        const vacio = conEstado ? '<td><span class="sub">—</span></td><td><span class="sub">—</span></td>' : ''
        return `<tr>${head}<td><span class="sub">—</span></td>${vacio}${tail}</tr>`
      }
      return ps
        .map((p, i) => `<tr>${i === 0 ? head : ''}<td>${procCell(p)}</td>${conEstado ? estadoCells(s, p) : ''}${i === 0 ? tail : ''}</tr>`)
        .join('')
    })
    .join('')
  const bajada = conEstado
    ? `<p class="sub">Registro y estado de las fuentes: cada fuente, su <b>oferta</b>, su dominio y sus procesos de ingestión con su <b>última corrida</b>, su <b>schedule observado</b> y su salud. El detalle (brecha vs. demanda, corridas, cadencia) vive en la <b>Frescura</b> de cada dominio.</p>`
    : `<p class="sub">Registro técnico de fuentes: cada fuente, su <b>oferta</b> (cada cuánto se actualiza), su dominio y los procesos de ingestión que alimenta. La <b>frescura</b> (brecha vs. demanda, corridas, schedule) se gestiona en cada dominio.</p>`
  const aviso = st.aviso ? '<p class="msg err">⚠ No se pudo leer el estado de las ingestas — se muestra solo el registro.</p>' : ''
  const feedback = msg ? `<p class="msg ${msg.startsWith('Error') ? 'err' : 'ok'}">${escapeHtml(msg)}</p>` : ''
  const cols = conEstado
    ? '<th>Fuente</th><th>Oferta</th><th>Dominio</th><th>Proceso → entidades</th><th>Schedule</th><th>Última corrida</th><th>Conectada por</th>'
    : '<th>Fuente</th><th>Oferta</th><th>Dominio</th><th>Procesos → entidades</th><th>Conectada por</th>'
  // ── Forms de gestión (#107). Editar = el mismo form pre-poblado vía `?edit=`/`?editp=`. ──
  let gestion = ''
  if (gest) {
    const eS = editSource ? sources.find((s) => s.id === editSource) : undefined
    const eP = editProcess ? processes.find((p) => p.id === editProcess) : undefined
    const domOpts = (sel?: string): string =>
      `<option value="">(sin dominio)</option>${(deps.domains ?? []).map((d) => `<option value="${escapeHtml(d.id)}"${d.id === sel ? ' selected' : ''}>${escapeHtml(d.label)}</option>`).join('')}`
    const srcOpts = (sel?: string): string =>
      sources.map((s) => `<option value="${escapeHtml(s.id)}"${s.id === sel ? ' selected' : ''}>${escapeHtml(s.id)} · ${escapeHtml(s.label)}</option>`).join('')
    const mapeos = await deps.sourcesAdmin!.listTableSources()
    const mapRows = mapeos
      .map((m) => `<tr><td><span class="c">${escapeHtml(m.tableRef)}</span></td><td>${escapeHtml(m.sourceId)}</td><td class="r">${post('table-map-remove', `<input type="hidden" name="table" value="${escapeHtml(m.tableRef)}">`, 'Quitar', 'del')}</td></tr>`)
      .join('')
    gestion = `
      <h2>${eS ? `Editar la fuente <code>${escapeHtml(eS.id)}</code>` : 'Conectar una fuente'}</h2>
      <form method="post" action="/admin/sources/source" class="grid">${csrfIn}
        <label class="fld"><span>Id *</span><input name="id" value="${escapeHtml(eS?.id ?? '')}" pattern="[a-z][a-z0-9_-]*" required ${eS ? 'readonly' : ''}></label>
        <label class="fld"><span>Nombre *</span><input name="label" value="${escapeHtml(eS?.label ?? '')}" required></label>
        <label class="fld"><span>Oferta * (duración ISO-8601 o <code>evento</code>)</span><input name="oferta" value="${escapeHtml(eS?.oferta ?? '')}" placeholder="PT1H" required></label>
        <label class="fld"><span>Dominio</span><select name="domain">${domOpts(eS?.domain)}</select></label>
        <div class="actions"><button class="add">${eS ? 'Guardar cambios' : 'Conectar'}</button>${eS ? '<a class="cancel" href="/admin/sources">Cancelar</a>' : ''}</div>
      </form>
      <h2>${eP ? `Editar el proceso <code>${escapeHtml(eP.id)}</code>` : 'Registrar un proceso'}</h2>
      <form method="post" action="/admin/sources/process" class="grid">${csrfIn}
        <label class="fld"><span>Id *</span><input name="id" value="${escapeHtml(eP?.id ?? '')}" pattern="[a-z][a-z0-9_-]*" required ${eP ? 'readonly' : ''}></label>
        <label class="fld"><span>Nombre *</span><input name="label" value="${escapeHtml(eP?.label ?? '')}" required></label>
        <label class="fld"><span>Fuente *</span><select name="source" required>${srcOpts(eP?.sourceId)}</select></label>
        <label class="fld"><span>Workspace del motor</span><input name="engine_workspace" value="${escapeHtml(eP?.engine?.workspaceId ?? '')}"></label>
        <label class="fld"><span>Item del motor</span><input name="engine_item" value="${escapeHtml(eP?.engine?.itemId ?? '')}"></label>
        <label class="fld"><span>Tipo de job</span><input name="engine_job_type" value="${escapeHtml(eP?.engine?.jobType ?? '')}" placeholder="sparkjob"></label>
        <div class="actions"><button class="add">${eP ? 'Guardar cambios' : 'Registrar'}</button>${eP ? '<a class="cancel" href="/admin/sources">Cancelar</a>' : ''}</div>
      </form>
      <p class="sub">El proceso apunta a un item <b>ya publicado</b> en el motor: los tres campos del motor van juntos o ninguno. La baja solo saca el proceso del registro de Mira — el item del motor y su schedule no se tocan.</p>
      <h2>Mapeos tabla → fuente</h2>
      <table><thead><tr><th>Tabla</th><th>Fuente</th><th></th></tr></thead><tbody>${mapRows || '<tr><td colspan="3" class="sub">Sin mapeos.</td></tr>'}</tbody></table>
      <form method="post" action="/admin/sources/table-map" class="row">${csrfIn}
        <input name="table" placeholder="esquema.tabla" required>
        <select name="source" required>${srcOpts()}</select>
        <button class="add">Mapear</button>
      </form>`
  }
  const publicacion = token && publicaOn(deps) ? await jobsPublishSection(deps, token, processes) : ''
  return adminPage(deps, nav,
    'Fuentes',
    `${feedback}${bajada}${aviso}
     <table><thead><tr>${cols}</tr></thead>
     <tbody>${rows || `<tr><td colspan="${conEstado ? 7 : 5}" class="sub">Sin fuentes registradas.</td></tr>`}</tbody></table>
     ${gestion}${publicacion}`,
  )
}

/**
 * Sección «Publicación de jobs» (#107 fase 2): un form por plantilla declarada, el historial del
 * ledger y la cola de re-verificación de las `desconocida`.
 *
 * Publicar es acto de PLATAFORMA (D4): esta sección solo se pinta dentro de `/admin/sources`, que ya
 * es admin-only, y solo si `publicaOn` — sin plantillas, sin publisher o sin registro escribible no
 * aparece un solo form.
 */
async function jobsPublishSection(deps: AdminDeps, token: string, processes: ProcessRow[]): Promise<string> {
  const ops = deps.jobsPublish!
  const csrfIn = `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`
  const procOpts = processes
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.id)} · ${escapeHtml(p.label)}${p.engine ? ` (item ${escapeHtml(p.engine.itemId)})` : ' (sin item)'}</option>`)
    .join('')
  const forms = ops.templates
    .map((t) => {
      const campos = t.template.params
        .map((p) => `<label class="fld"><span>${escapeHtml(p.label)}${p.required ? ' *' : ''}</span><input name="${PUBLISH_PARAM_PREFIX}${escapeHtml(p.name)}"${p.required ? ' required' : ''}></label>`)
        .join('')
      return `<form method="post" action="/admin/sources/publish-plan" class="grid">${csrfIn}
        <input type="hidden" name="template" value="${escapeHtml(t.template.id)}">
        <label class="fld"><span>Proceso *</span><select name="process" required>${procOpts}</select></label>
        <label class="fld"><span>Workspace del motor (solo si el proceso aún no tiene item)</span><input name="workspace"></label>
        <label class="fld"><span>Nombre del item (al crear; por defecto, el id del proceso)</span><input name="item_name"></label>
        ${campos}
        <div class="actions"><button class="add">Ver el plan · ${escapeHtml(t.template.label)} <span class="sub">${escapeHtml(t.template.id)}@${escapeHtml(t.template.version)}</span></button></div>
      </form>`
    })
    .join('')
  const [historial, pendientes] = await Promise.all([ops.ledger.list({ limit: 20 }), ops.ledger.pendingUnknown()])
  const marca = (o: PublishOutcome): string =>
    o === 'ok' ? '<b style="color:var(--accent)">✓ ok</b>'
      : o === 'denegada' ? '<b style="color:var(--err)">⊘ denegada</b>'
        : o === 'fallida' ? '<b style="color:var(--err)">✕ fallida</b>'
          : '<b>? desconocida</b>'
  const filas = historial
    .map((r) => `<tr><td class="sub">${escapeHtml(fmtWhen(r.at))}</td><td><span class="c">${escapeHtml(r.processId)}</span></td>` +
      `<td>${escapeHtml(r.templateId)}@${escapeHtml(r.templateVersion)}</td><td>${escapeHtml(r.action)}</td>` +
      `<td><code>${escapeHtml(r.definitionSha256.slice(0, 12))}…</code></td><td>${marca(r.outcome)}</td><td class="sub">${escapeHtml(r.detail ?? '')}</td></tr>`)
    .join('')
  const colaHtml = pendientes.length
    ? `<p class="sub">Publicaciones con desenlace <b>desconocido</b> (el motor no confirmó): re-observá el item para resolverlas — Vergis nunca las da por publicadas.</p>` +
      pendientes
        .map((r) => `<form method="post" action="/admin/sources/publish-reverify" style="display:inline">${csrfIn}<input type="hidden" name="id" value="${r.id}">` +
          `<button class="add">Re-verificar #${r.id} · ${escapeHtml(r.processId)}</button></form> `)
        .join('')
    : ''
  return `<h2>Publicación de jobs</h2>
    <p class="sub">Publica en el motor la <b>cáscara</b> del job de un proceso a partir de una plantilla de la instancia. El <b>código</b> del convertidor no se toca: la plantilla solo lo apunta. Se muestra primero el plan y nada se escribe sin confirmarlo.</p>
    ${forms}
    <h2>Historial de publicaciones</h2>
    <table><thead><tr><th>Cuándo</th><th>Proceso</th><th>Plantilla</th><th>Acción</th><th>Definición</th><th>Desenlace</th><th>Detalle</th></tr></thead>
    <tbody>${filas || '<tr><td colspan="7" class="sub">Sin publicaciones.</td></tr>'}</tbody></table>
    ${colaHtml}`
}

/**
 * Escritura del registro de fuentes (#107) — gestión de PLATAFORMA, fail-closed en la ruta (defensa en
 * profundidad: el store valida slugs y oferta; acá se valida lo que el store NO puede saber —que el
 * dominio esté declarado, que la fuente exista, que la tripleta del motor esté completa, y que una baja
 * no deje dependientes colgando). Devuelve el mensaje de éxito para el PRG.
 */
async function handleSourcesWrite(deps: AdminDeps, store: SourceRegistryStore, op: string, f: Record<string, string>, by: string): Promise<string> {
  const val = (k: string): string => (f[k] ?? '').trim()
  const audit = (o: string, target: string, detalle: Record<string, unknown> = {}): void =>
    deps.audit({ type: 'sources-write', op: o, target, by, ...detalle })
  switch (op) {
    case 'source': {
      const id = val('id').toLowerCase()
      const domain = val('domain').toLowerCase()
      // Un dominio con typo dejaría la fuente huérfana de TODA vista de steward, en silencio.
      if (domain && !(deps.domains ?? []).some((d) => d.id === domain)) throw new ValidationError(`Dominio no declarado: '${domain}'.`)
      await store.upsertSource(id, val('label'), val('oferta'), { domain: domain || undefined, connectedBy: by, managed: true })
      audit('source-upsert', id, { oferta: val('oferta').toUpperCase(), domain: domain || null })
      return `Fuente ${id} guardada.`
    }
    case 'source-delete': {
      const id = val('id').toLowerCase()
      const [procs, maps] = await Promise.all([store.listProcesses(), store.listTableSources()])
      const depProcs = procs.filter((p) => p.sourceId === id).map((p) => p.id)
      const depMaps = maps.filter((m) => m.sourceId === id).map((m) => m.tableRef)
      if (depProcs.length || depMaps.length) {
        throw new GovernanceConflict(
          `No se puede dar de baja la fuente '${id}': la referencian ${[
            depProcs.length ? `los procesos ${depProcs.join(', ')}` : '',
            depMaps.length ? `los mapeos de ${depMaps.join(', ')}` : '',
          ].filter(Boolean).join(' y ')}.`,
        )
      }
      await store.deleteSource(id)
      audit('source-delete', id)
      return `Fuente ${id} dada de baja del registro.`
    }
    case 'process': {
      const id = val('id').toLowerCase()
      const sourceId = val('source').toLowerCase()
      if (!(await store.listSources()).some((s) => s.id === sourceId)) throw new ValidationError(`Fuente desconocida: '${sourceId}'.`)
      const ws = val('engine_workspace')
      const item = val('engine_item')
      const jt = val('engine_job_type')
      // Tripleta completa o nada: un engine_ref a medias es un proceso que se cree observable y no lo es.
      const partes = [ws, item, jt].filter(Boolean).length
      if (partes > 0 && partes < 3) throw new ValidationError('El motor se declara completo (workspace, item y tipo de job) o no se declara.')
      const engine = partes === 3 ? { workspaceId: ws, itemId: item, jobType: jt } : undefined
      await store.upsertProcess(id, val('label'), sourceId, engine, undefined, { managed: true })
      audit('process-upsert', id, { source: sourceId, engine: engine ? `${ws}/${item}/${jt}` : null })
      return `Proceso ${id} guardado.`
    }
    case 'process-delete': {
      const id = val('id').toLowerCase()
      await store.deleteProcess(id)
      audit('process-delete', id)
      return `Proceso ${id} dado de baja del registro (el item del motor no se tocó).`
    }
    case 'output-add': {
      const p = val('process').toLowerCase()
      const t = val('table')
      if (!t) throw new ValidationError('La salida necesita una tabla.')
      if (!(await store.listProcesses()).some((x) => x.id === p)) throw new ValidationError(`Proceso desconocido: '${p}'.`)
      await store.setProcessOutput(p, t)
      audit('output-add', p, { table: t })
      return `Salida ${t} agregada a ${p}.`
    }
    case 'output-remove': {
      const p = val('process').toLowerCase()
      const t = val('table')
      await store.removeProcessOutput(p, t)
      audit('output-remove', p, { table: t })
      return `Salida ${t} quitada de ${p}.`
    }
    case 'table-map': {
      const t = val('table')
      const s = val('source').toLowerCase()
      if (!t) throw new ValidationError('El mapeo necesita una tabla.')
      if (!(await store.listSources()).some((x) => x.id === s)) throw new ValidationError(`Fuente desconocida: '${s}'.`)
      await store.setTableSource(t, s)
      audit('table-map', t, { source: s })
      return `Tabla ${t} mapeada a ${s}.`
    }
    case 'table-map-remove': {
      const t = val('table')
      await store.deleteTableSource(t)
      audit('table-map-remove', t)
      return `Mapeo de ${t} quitado.`
    }
    default:
      throw new ValidationError(`Operación desconocida: '${op}'.`)
  }
}

// ─── Publicación de jobs en el motor (#107 fase 2 · §4-5 del diseño) ─────────
/**
 * FAIL-CLOSED EN TRES CAPAS (D4). La publicación existe solo si están las tres piezas:
 *  · `jobsPublish` cableado — hay credencial de autoría resuelta;
 *  · al menos UNA plantilla declarada por la instancia (`VERGIS_JOB_TEMPLATES`) — sin plantillas no
 *    hay nada publicable y la sección no existe;
 *  · `sourcesAdmin` — sin él no se puede escribir el `engine_ref` sobre el proceso (D10), y una
 *    publicación que el registro no puede recordar dejaría el motor y Vergis desalineados.
 * Falta cualquiera ⇒ cero forms y rutas inexistentes: el contrato de regresión cero de fase 1.
 */
function publicaOn(deps: AdminDeps): boolean {
  return deps.jobsPublish != null && deps.jobsPublish.templates.length > 0 && deps.sourcesAdmin != null
}

/** Prefijo de los campos de parámetro en el form (`p_<nombre>`): aísla los valores del render. */
const PUBLISH_PARAM_PREFIX = 'p_'

/**
 * Qué `jobType` de fase 1 le corresponde al item recién publicado (D10: publicar desemboca en la
 * cadena observar/agendar/pausar, que se mueve por `jobType`).
 *
 * `SparkJobDefinition → sparkjob` es HECHO MEDIDO: el hito cero agendó el item de prueba por
 * `…/jobs/sparkjob/schedules` (crudos en #107). El resto del mapa es **CONJETURA no medida** — se
 * mantiene porque es lo que la API pública documenta, y el caso desconocido degrada al `itemType`
 * crudo en vez de inventar un nombre.
 */
function jobTypeDeItemType(itemType: string): string {
  const t = itemType.toLowerCase()
  if (t === 'sparkjobdefinition') return 'sparkjob'
  if (t === 'datapipeline') return 'Pipeline' // conjetura
  if (t === 'notebook') return 'RunNotebook' // conjetura
  return itemType
}

/** Todo lo que una publicación necesita, ya derivado y consistente entre sí (plan + insumos). */
interface PublishContext {
  tpl: JobTemplateBundle
  proc: ProcessRow
  workspaceId: string
  /** Nombre del item a crear en el motor (irrelevante en un update). */
  displayName: string
  values: PublishParams
  rendered: RenderedDefinition
  plan: PublishPlan
}

/**
 * Deriva el plan de publicación desde el form (D5, fase 1 de dos). Es la ÚNICA derivación: `exec`
 * vuelve a llamarla y compara hashes, así el sello cubre exactamente los mismos insumos que se
 * mostraron.
 *
 * Δ2: `derivePublishPlan` es puro sobre shas — quien hace la red (el `getDefinition` del motor) y
 * quien canonicaliza es esta función.
 *
 * **La comparación se acota a las parts publicadas** (Δ6, hecho medido): el motor agrega parts
 * propias (`.platform`) al read-back. Comparar la definición completa marcaría drift eterno.
 */
async function derivarPublicacion(deps: AdminDeps, f: Record<string, string>): Promise<PublishContext> {
  const ops = deps.jobsPublish!
  const val = (k: string): string => (f[k] ?? '').trim()
  const tpl = ops.templates.find((t) => t.template.id === val('template'))
  if (!tpl) throw new ValidationError(`Plantilla desconocida: '${val('template')}'.`)
  const processId = val('process').toLowerCase()
  const proc = (await deps.sourcesAdmin!.listProcesses()).find((p) => p.id === processId)
  if (!proc) throw new ValidationError(`Proceso desconocido: '${processId}'.`)

  const values: PublishParams = {}
  for (const p of tpl.template.params) values[p.name] = val(PUBLISH_PARAM_PREFIX + p.name)
  // El render valida sus propias reglas (D11: requeridos presentes, sin claves de más). Sus fallos son
  // entrada del admin, no del sistema: viajan como 400 para que corrija sin perder la vista.
  let rendered: RenderedDefinition
  try {
    rendered = renderTemplate(tpl.template, tpl.partFiles, values)
  } catch (e) {
    throw new ValidationError(errMsg(e))
  }

  // El destino: si el proceso ya tiene `engine_ref`, MANDA ÉL (publicar no re-apunta un proceso a otro
  // workspace por un campo de form); si no lo tiene, el workspace se declara acá y el item nace.
  const workspaceId = proc.engine?.workspaceId ?? val('workspace')
  if (!workspaceId) throw new ValidationError('Falta el workspace del motor donde publicar.')
  const itemId = proc.engine?.itemId ?? null
  const displayName = val('item_name') || proc.id

  const publicados = new Set(rendered.parts.map((p) => p.path))
  let engineSha: string | null = null
  if (itemId) {
    const def = await ops.authoring.getDefinition(workspaceId, itemId)
    engineSha = def ? canonicalDefinitionSha256(def.parts.filter((p) => publicados.has(p.path))) : null
  }
  const lastOk = await ops.ledger.lastOk({ processId: proc.id })
  let plan: PublishPlan
  try {
    plan = derivePublishPlan({
      processId: proc.id,
      templateId: tpl.template.id,
      templateVersion: tpl.template.version,
      workspaceId,
      itemId,
      renderedSha: rendered.sha256,
      engineSha,
      lastOkSha: lastOk?.definitionSha256 ?? null,
      params: values,
    })
  } catch (e) {
    throw new ValidationError(errMsg(e))
  }
  return { tpl, proc, workspaceId, displayName, values, rendered, plan }
}

/**
 * La página de CONFIRMACIÓN del plan (D5, patrón `revertPlanBody` de #63): qué se va a hacer, sobre
 * qué destino, con qué plantilla y con qué definición — y el DRIFT declarado, jamás auto-corregido
 * (D6). El form de ejecución re-manda los mismos insumos + el `hash` que los sella.
 */
function publishPlanBody(ctx: PublishContext, token: string, aviso?: string): string {
  const { plan, tpl, proc } = ctx
  const back = `<p class="sub"><a href="/admin/sources">← Fuentes</a></p>`
  const avisoHtml = aviso ? `<p class="msg err">${escapeHtml(aviso)}</p>` : ''
  const puntos: string[] = [
    plan.action === 'create'
      ? `se <b>crea</b> el item «${escapeHtml(ctx.displayName)}» (${escapeHtml(tpl.template.itemType)}) en el workspace <code>${escapeHtml(plan.workspaceId)}</code>`
      : `se <b>actualiza</b> la definición del item <code>${escapeHtml(plan.itemId ?? '')}</code> del workspace <code>${escapeHtml(plan.workspaceId)}</code>`,
    `plantilla <code>${escapeHtml(tpl.template.id)}@${escapeHtml(tpl.template.version)}</code>`,
    `definición <code>${escapeHtml(plan.renderedSha.slice(0, 12))}…</code>`,
  ]
  if (plan.sinCambios) puntos.push('el motor ya tiene <b>exactamente</b> esta definición: publicar no cambiaría nada')
  if (plan.drift) {
    puntos.push(
      '⚠ <b>drift</b>: la definición que hay en el motor <b>no</b> es la última publicada desde Vergis — alguien la editó allá. ' +
        'Publicar la <b>reemplaza</b>; Vergis nunca la corrige por su cuenta.',
    )
  }
  // El caso que el drift booleano no cubre: el motor tiene definición y el ledger no tiene nada `ok`.
  // Pasa cuando el `engine_ref` de fase 1 apunta a un item PRE-EXISTENTE. No es drift (no hay contra
  // qué comparar) y es exactamente lo que el humano debe saber antes de sobrescribirlo.
  if (plan.engineSha !== null && plan.lastOkSha === null) {
    puntos.push('⚠ el item <b>ya existe</b> en el motor con una definición que <b>Vergis nunca publicó</b> — publicar la sobrescribe')
  }
  const paramRows = tpl.template.params
    .map((p) => `<tr><td><span class="c">${escapeHtml(p.name)}</span></td><td>${escapeHtml(ctx.values[p.name] ?? '')}</td></tr>`)
    .join('')
  const ocultos = [
    `<input type="hidden" name="process" value="${escapeHtml(proc.id)}">`,
    `<input type="hidden" name="template" value="${escapeHtml(tpl.template.id)}">`,
    `<input type="hidden" name="workspace" value="${escapeHtml(ctx.workspaceId)}">`,
    `<input type="hidden" name="item_name" value="${escapeHtml(ctx.displayName)}">`,
    `<input type="hidden" name="hash" value="${escapeHtml(plan.hash)}">`,
    ...tpl.template.params.map((p) => `<input type="hidden" name="${PUBLISH_PARAM_PREFIX}${escapeHtml(p.name)}" value="${escapeHtml(ctx.values[p.name] ?? '')}">`),
  ].join('')
  return `${back}${avisoHtml}<h2>Publicar el job de <code>${escapeHtml(proc.id)}</code></h2>
    <p><b>Qué va a pasar:</b></p>
    <ul>${puntos.map((p) => `<li>${p}</li>`).join('')}</ul>
    <table><thead><tr><th>Parámetro</th><th>Valor</th></tr></thead><tbody>${paramRows || '<tr><td colspan="2" class="sub">Sin parámetros.</td></tr>'}</tbody></table>
    <form method="post" action="/admin/sources/publish-exec" onsubmit="return confirm('Esta acción escribe la definición del job en el motor. ¿Confirmar?')">
      <input type="hidden" name="_csrf" value="${escapeHtml(token)}">${ocultos}
      <button class="add">Publicar en el motor</button>
    </form>`
}

/**
 * Ejecuta el plan confirmado (D5 fase 2) y sella su desenlace en el ledger (D6): los CUATRO desenlaces
 * dejan fila, incluido el que no se sabe.
 *
 * **`ok` SOLO por read-back (D7)**: se vuelve a leer la definición del motor y se compara
 * CANÓNICAMENTE (Δ1 — el motor normaliza lo que persiste) y solo sobre las parts publicadas (Δ6 — el
 * motor agrega las suyas). Un LRO que no culmina es `desconocida` con su `operationId`, jamás
 * «publicado».
 */
async function ejecutarPublicacion(deps: AdminDeps, ctx: PublishContext, by: string): Promise<{ outcome: PublishOutcome; msg: string }> {
  const ops = deps.jobsPublish!
  const { plan, tpl, proc, rendered } = ctx
  const publicados = new Set(rendered.parts.map((p) => p.path))
  let outcome: PublishOutcome
  let detail: string | undefined
  let itemId: string | undefined = plan.itemId ?? undefined
  try {
    if (plan.action === 'create') {
      const creado = await ops.authoring.createItem(ctx.workspaceId, {
        displayName: ctx.displayName,
        type: tpl.template.itemType,
        definition: { parts: rendered.parts },
      })
      itemId = creado.itemId
    } else {
      await ops.authoring.updateDefinition(ctx.workspaceId, itemId!, { parts: rendered.parts })
    }
    const back = await ops.authoring.getDefinition(ctx.workspaceId, itemId!)
    const leidas = back ? back.parts.filter((p) => publicados.has(p.path)) : []
    if (back && definitionsEquivalent(leidas, rendered.parts)) {
      outcome = 'ok'
    } else {
      outcome = 'fallida'
      detail = back
        ? 'read-back: la definición del motor NO es equivalente a la publicada'
        : 'read-back: el item no existe en el motor tras la escritura'
    }
  } catch (e) {
    if (e instanceof AuthoringDenied) {
      outcome = 'denegada'
      detail = e.errorCode ? `errorCode=${e.errorCode}` : errMsg(e)
    } else if (e instanceof AuthoringUnknown) {
      outcome = 'desconocida'
      detail = e.operationId ? `operationId=${e.operationId}` : errMsg(e)
    } else if (e instanceof AuthoringError) {
      outcome = 'fallida'
      detail = e.errorCode ? `errorCode=${e.errorCode}` : errMsg(e)
    } else {
      throw e
    }
  }
  await ops.ledger.record({
    processId: proc.id,
    templateId: tpl.template.id,
    templateVersion: tpl.template.version,
    workspaceId: ctx.workspaceId,
    ...(itemId ? { itemId } : {}),
    action: plan.action,
    definitionSha256: rendered.sha256,
    params: ctx.values,
    outcome,
    ...(detail ? { detail } : {}),
    byUser: by,
  })
  deps.audit({
    type: 'jobs-publish', op: 'publish-exec', process: proc.id, template: `${tpl.template.id}@${tpl.template.version}`,
    sha: rendered.sha256, outcome, by, ...(itemId ? { item: itemId } : {}), ...(detail ? { detail } : {}),
  })
  // D10: el create que culminó `ok` desemboca en la cadena de fase 1 — el proceso queda con su
  // `engine_ref` y desde ahí observar/agendar/pausar funcionan sin tocar nada más.
  if (outcome === 'ok' && plan.action === 'create' && itemId) {
    await deps.sourcesAdmin!.upsertProcess(
      proc.id, proc.label, proc.sourceId,
      { workspaceId: ctx.workspaceId, itemId, jobType: proc.engine?.jobType ?? jobTypeDeItemType(tpl.template.itemType) },
      proc.logs, { managed: true },
    )
  }
  const msgs: Record<PublishOutcome, string> = {
    ok: `Job de ${proc.id} publicado (${plan.action === 'create' ? 'item creado' : 'definición actualizada'}) y verificado por read-back.`,
    denegada: `El motor DENEGÓ la publicación de ${proc.id}${detail ? ` — ${detail}` : ''}.`,
    fallida: `La publicación de ${proc.id} falló${detail ? ` — ${detail}` : ''}.`,
    desconocida: `La publicación de ${proc.id} quedó DESCONOCIDA${detail ? ` — ${detail}` : ''}; re-verificala desde la lista.`,
  }
  return { outcome, msg: msgs[outcome] }
}

/**
 * «Re-verificar» una publicación `desconocida` (D7): re-observa el item por `getDefinition`, compara
 * canónicamente contra el sha que se intentó publicar y resuelve la fila con el desenlace MEDIDO.
 * Nunca adivina: si el motor no responde, la fila sigue desconocida.
 */
async function reverificarPublicacion(deps: AdminDeps, f: Record<string, string>, by: string): Promise<string> {
  const ops = deps.jobsPublish!
  const id = Number((f['id'] ?? '').trim())
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Id de publicación inválido.')
  const row = (await ops.ledger.pendingUnknown()).find((r) => r.id === id)
  if (!row) throw new ValidationError(`La publicación #${id} no está pendiente de re-verificación.`)
  if (!row.itemId) throw new ValidationError(`La publicación #${id} no dejó item conocido: no hay qué re-observar (buscá el item por nombre en el motor).`)
  const tpl = ops.templates.find((t) => t.template.id === row.templateId)
  if (!tpl) throw new ValidationError(`La plantilla '${row.templateId}' ya no está declarada: no se puede acotar la comparación a sus partes.`)
  const publicados = new Set(tpl.template.parts.map((p) => p.path))
  const def = await ops.authoring.getDefinition(row.workspaceId, row.itemId)
  const sha = def ? canonicalDefinitionSha256(def.parts.filter((p) => publicados.has(p.path))) : null
  const outcome: Exclude<PublishOutcome, 'desconocida'> = sha === row.definitionSha256 ? 'ok' : 'fallida'
  const detail = def
    ? outcome === 'ok' ? 'read-back: el motor tiene la definición publicada' : `read-back: el motor tiene otra definición (${sha?.slice(0, 12)}…)`
    : 'read-back: el item no existe en el motor'
  await ops.ledger.resolveUnknown(id, { outcome, detail, itemId: row.itemId, byUser: by })
  deps.audit({
    type: 'jobs-publish', op: 'publish-reverify', process: row.processId, template: `${row.templateId}@${row.templateVersion}`,
    sha: row.definitionSha256, outcome, by, item: row.itemId, detail,
  })
  if (outcome === 'ok' && row.action === 'create') {
    const proc = (await deps.sourcesAdmin!.listProcesses()).find((p) => p.id === row.processId)
    if (proc && !proc.engine) {
      await deps.sourcesAdmin!.upsertProcess(
        proc.id, proc.label, proc.sourceId,
        { workspaceId: row.workspaceId, itemId: row.itemId, jobType: jobTypeDeItemType(tpl.template.itemType) },
        proc.logs, { managed: true },
      )
    }
  }
  return `Publicación #${id} re-verificada: ${outcome === 'ok' ? 'el motor tiene la definición publicada' : detail}.`
}

/** Tipo de motor que corre el proceso, legible, + si es un Notebook (debe migrar a Spark Job). */
function engineKind(jobType?: string): { label: string; isNotebook: boolean } {
  const jt = (jobType ?? '').toLowerCase()
  if (jt.includes('notebook')) return { label: 'Notebook', isNotebook: true }
  if (jt === 'sparkjob') return { label: 'Spark Job', isNotebook: false }
  if (jt === 'pipeline') return { label: 'Pipeline', isNotebook: false }
  return { label: jobType || 'motor', isNotebook: false }
}

/** Estado del refresco que alimenta la fila (#105): lo que se muestra es lo último OBSERVADO, y su edad
 * es parte del dato. Vacío en el caso sano (proyección fresca, sin error): cero ruido cuando todo anda. */
function projectionNote(p: FreshnessProjectionMeta | undefined): string {
  if (!p) return ''
  if (p.off) return p.observedAt ? `refresco apagado — datos de ${fmtWhen(p.observedAt)}` : 'refresco apagado — sin datos'
  if (!p.observedAt) return p.lastError ? 'el motor no respondió al refresco — sin datos aún (se reintenta solo)' : 'esperando el primer refresco del motor'
  if (p.lastError) return `⚠ el último refresco falló — datos de ${fmtWhen(p.observedAt)}`
  if (p.stale) return `⚠ datos de ${fmtWhen(p.observedAt)} — el refresco no está corriendo`
  return ''
}

/** Render COMPARTIDO del estado de corridas de un proceso — Frescura por dominio (#105) y Fuentes (#101):
 * desenlace + edad + bandera de salud + error + «Ver log» (#99) + nota de proyección. Una sola fuente de
 * textos: las dos vistas dicen lo mismo con las mismas palabras por construcción.
 *
 * Bandera: `failed`/`missed` de `classifyProcess` cuando hay salud; sin salud (proceso sin cadencia
 * requerida: event-driven o sin demanda) se usa el MISMO criterio `failed` sobre la última corrida —
 * una corrida fallida nunca luce ✓. `⚠️ atrasada` solo existe donde hay cadencia contra la cual atrasarse. */
function runStateCell(s: {
  runs: RunRecord[]
  health?: ProcessHealth
  projection?: FreshnessProjectionMeta
  /** Enlace «Ver log» de la última corrida (#99); null/undefined = sin enlace. */
  runHref?: string | null
}): string {
  const nota = projectionNote(s.projection)
  const notaLine = nota ? `<div class="sub">${escapeHtml(nota)}</div>` : ''
  // Proyección fría: no se afirma «sin corridas» (sería afirmar algo no observado) — se dice que aún
  // no hubo refresco.
  if (s.projection && !s.projection.observedAt) return `<span class="sub">${escapeHtml(nota)}</span>`
  const runs = s.runs
  if (!runs.length) return `<span class="sub">sin corridas</span>${notaLine}`
  const flag = s.health?.failed
    ? ' · ✕ fallida'
    : s.health?.missed
      ? ' · ⚠️ atrasada'
      : !s.health && runs[0].status === 'Failed'
        ? ' · ✕ fallida'
        : ' · ✓'
  // #99 · el log de esta corrida, también cuando terminó bien: `Completed` no garantiza el dato.
  const verLog = s.runHref ? ` · <a class="sub" href="${escapeHtml(s.runHref)}">Ver log</a>` : ''
  return `${statusBadge(runs[0].status)} ${fmtWhen(runs[0].startedAt)}<span class="sub">${flag}</span>${verLog}${runErrorLine(runs[0])}${notaLine}`
}

/** Celda de salud de una entidad: tipo de motor (Notebook/Spark Job) + el estado compartido de corridas.
 * Si el proceso corre como Notebook, explicita la alerta de migración a Spark Job. */
function freshnessHealthCell(r: DomainEntityFreshness, runHref?: (r: DomainEntityFreshness) => string | null): string {
  if (!r.engine) return '<span class="sub">sin motor</span>'
  const k = engineKind(r.engineJobType)
  const kind = `<span class="sub">[${escapeHtml(k.label)}]</span>${k.isNotebook ? ' <b style="color:var(--err)">⚠ migrar a Spark Job</b>' : ''}`
  return `${kind}<br>${runStateCell({ runs: r.runs ?? [], health: r.health, projection: r.projection, runHref: runHref?.(r) ?? null })}`
}

/** Controles de la metadata requerida del slot (issue #76). Vacío si el slot no declara `meta`. */
function metaFieldsHtml(slot: IntakeSlot): string {
  if (!slot.meta?.length) return ''
  return slot.meta.map((f) => {
    const name = `meta_${escapeHtml(f.id)}`
    // #95 · el campo lo declara el NOMBRE del archivo: no se pide, se explica la convención. Si el
    // nombre no la cumple, la subida falla con el mismo texto — el usuario ve antes lo que se espera.
    if (f.fromFilename) {
      const pats = f.fromFilename.patterns.map((p) => `<code>${escapeHtml(p)}</code>`).join(' o ')
      const cods = f.fromFilename.catalog ? ` · códigos: ${Object.keys(f.fromFilename.catalog).map((c) => `<code>${escapeHtml(c)}</code>`).join(', ')}` : ''
      return `<div class="sub" style="flex-basis:100%">${escapeHtml(f.label)} se toma del nombre del archivo: ${pats}${cods}</div>`
    }
    const req = f.required ? ' required' : ''
    const mark = f.required ? ' <span style="color:var(--err)">*</span>' : ''
    let control: string
    if (f.type === 'enum') {
      // #109 · lo que viaja en el POST es el `value`; el texto visible antepone la etiqueta cuando la hay
      // («Hijuelas S.A. · 96835510-4»: se elige por nombre y se verifica el dato a la vista). Un enum
      // inline sin etiquetas (label = value) renderiza idéntico a antes.
      const opts = (f.options ?? [])
        .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label === o.value ? o.value : `${o.label} · ${o.value}`)}</option>`)
        .join('')
      control = `<select name="${name}"${req}><option value="">— elegir —</option>${opts}</select>`
    } else if (f.type === 'number') {
      control = `<input type="number" step="any" name="${name}"${req}>`
    } else if (f.type === 'rut') {
      // La validación real (DV) es server-side; el pattern del browser es solo forma (cortesía).
      control = `<input type="text" name="${name}" placeholder="12345678-9" pattern="[0-9]{1,8}-[0-9Kk]"${req}>`
    } else {
      control = `<input type="text" name="${name}"${req}>`
    }
    return `<label class="sub" style="flex-basis:100%">${escapeHtml(f.label)}${mark}<br>${control}</label>`
  }).join('')
}

/**
 * Pre-check de duplicados en el CLIENTE (issue #62), sin librerías: antes de que los bytes salgan del
 * browser calcula el SHA-256 de cada archivo (`crypto.subtle`), consulta el endpoint `/precheck` y —si
 * el contenido ya fue procesado— pregunta «¿Continuar?». Preguntar después de subir sería teatro: la
 * conversión ya estaría corriendo.
 *
 * FAIL-SAFE por contrato: sin `crypto.subtle`, con el fetch caído o lento (3 s), el form se envía SIN
 * aviso previo. El server recalcula el sha con sus propios bytes y el aviso post-hoc del redirect es
 * la red de seguridad. El pre-check nunca bloquea una carga: aceptar es siempre posible.
 */
const PRECHECK_JS = `(function(f){
  if(!f||f.dataset.pc)return; f.dataset.pc='1';
  f.addEventListener('submit',function(ev){
    if(f.dataset.go){f.dataset.go='';return}
    var inp=f.querySelector('input[type=file]'); var fs=inp&&inp.files?[].slice.call(inp.files):[];
    if(!fs.length||!(window.crypto&&crypto.subtle&&crypto.subtle.digest))return;
    ev.preventDefault();
    var send=function(){f.dataset.go='1';f.submit()};
    var hex=function(b){return [].map.call(new Uint8Array(b),function(x){return ('0'+x.toString(16)).slice(-2)}).join('')};
    Promise.all(fs.map(function(x){return x.arrayBuffer().then(function(b){return crypto.subtle.digest('SHA-256',b)}).then(hex)}))
      .then(function(shas){
        var body=new URLSearchParams(); body.set('_csrf',f._csrf.value); body.set('shas',shas.join(','));
        return fetch(f.action+'/precheck',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:body,signal:AbortSignal.timeout(3000)})
          .then(function(r){return r.json()}).then(function(j){
            var by={}; (j.dups||[]).forEach(function(d){by[d.sha256]=d});
            for(var i=0;i<shas.length;i++){var d=by[shas[i]]; if(!d)continue;
              var cuando=String(d.uploadedAt||'').slice(0,16).replace('T',' ')+' UTC';
              if(!confirm('«'+fs[i].name+'» es idéntico a «'+d.filename+'», procesado el '+cuando+'; re-procesarlo no cambiará el dato. ¿Continuar?'))return;
            }
            send();
          })
      }).catch(send);
  });
})(document.currentScript.previousElementSibling)`

/**
 * Formulario compacto de carga manual de un slot (mismo write-path que el intake).
 *
 * `origen` (#178) declara DÓNDE vive este formulario, para que el desenlace de la carga —recibido o
 * rechazado— vuelva a esa pantalla. Es un valor acotado que el handler compara contra `'cargas'`,
 * no una URL de retorno: el destino del redirect lo decide el server.
 */
function uploadForm(domainId: string, slot: IntakeSlot, token: string, origen?: 'cargas'): string {
  return `<form method="post" action="/admin/dominio/${escapeHtml(domainId)}/intake/${escapeHtml(slot.id)}" enctype="multipart/form-data" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;max-width:320px">
       <input type="hidden" name="_csrf" value="${token}">
       ${origen ? `<input type="hidden" name="origen" value="${origen}">` : ''}
       <input type="file" name="file" multiple required>
       ${metaFieldsHtml(slot)}
       <button class="add">Subir</button>
       ${slot.accept ? `<div class="sub" style="flex-basis:100%">patrón: <code>${escapeHtml(slot.accept)}</code> · máx. ${Math.round(slotMaxBytes(slot) / (1024 * 1024))} MB c/u</div>` : ''}
     </form><script>${PRECHECK_JS}</script>`
}

/** Consola de CARGAS de un dominio (issue #58): arma los datos de la casilla activa (#178, tolerante a
 * fallos) y delega el render puro a admin-cargas. Gate de steward: lo aplica el ruteo del dominio. */
async function cargasPage(deps: AdminDeps, nav: Chrome, domain: DomainDecl, token: string, params: URLSearchParams): Promise<string> {
  const ops = deps.cargas!
  const slots = (deps.intakeSlots ?? []).filter((s) => (s.domain ?? '') === domain.id)
  // #178 · la casilla ACTIVA: la del `?slot=`, y si el parámetro falta o nombra un slot que no existe,
  // la primera declarada — sin error. Una URL vieja (sin el parámetro) sigue abriendo una página válida.
  const activo = slots.find((s) => s.id === params.get('slot')) ?? slots[0]
  const msg = params.get('msg') ?? undefined
  // #56 · procesos registrados (para la coherencia trigger↔proceso). Tolerante: sin registro, no acusa.
  const engineIds = new Set<string>(
    deps.sourceRegistry ? (await deps.sourceRegistry().catch(() => ({ processes: [] as ProcessRow[] }))).processes.map((p) => p.engine?.itemId ?? '').filter(Boolean) : [],
  )
  // Los datos caros se piden SOLO para la casilla activa (#178): es la única cuyo bloque se dibuja.
  let data: SlotCargas | null = null
  if (activo) {
    const slot = activo
    data = {
      slot,
      runs: await ops.runs(slot, 20).catch(() => 'error' as const),
      history: await ops.history(slot, 30).catch(() => 'error' as const),
      log: await ops.log(slot).catch(() => null),
      landing: await ops.landing(slot).catch(() => 'error' as const),
      archived: await ops.archived(slot).catch(() => 'error' as const),
      // #63 · tolerante como los demás: sin registro de reversiones la Actividad simplemente no las muestra.
      reverts: ops.reverts ? await ops.reverts(slot, 30).catch(() => []) : [],
      procesoRegistrado: !slot.trigger || engineIds.size === 0 || engineIds.has(slot.trigger.processRef),
    }
    // #161 · el veredicto del vigilante (de su PROYECCIÓN: acá no se mide nada). Tolerante como los
    // demás y por la misma razón: la consola de cargas sigue sirviendo aunque la vigilancia no esté
    // — y sin `vigilancia` la página renderiza exactamente la de antes del vigilante.
    if (ops.vigilancia) {
      const v = await ops.vigilancia(slot).catch(() => null)
      if (v) data.vigilancia = v
    }
  }
  const feedback = cargaFeedback(deps, domain, msg, params.get('destino'))
  // #99 · «Ver log» por corrida, solo si la instancia cableó el acceso a los logs (sin él: cero cambio).
  const runLogHrefOf = deps.runLogs
    ? (s: IntakeSlot, r: RunRecord): string => `/admin/dominio/${domain.id}/corrida?slot=${encodeURIComponent(s.id)}&started=${encodeURIComponent(r.startedAt)}`
    : undefined
  return adminPage(deps, nav, `${domain.label} · Cargas`, feedback + cargasBody(domain.id, domain.label, slots, data, token, (s) => uploadForm(domain.id, s, token, 'cargas'), runLogHrefOf))
}

/**
 * El feedback de una carga: el mensaje + —si el rechazo tuvo destino computable— el enlace a la casilla
 * que SÍ acepta el archivo (#178·§3).
 *
 * `destino` llega como ids de slot en la URL: acá se resuelven contra la declaración del dominio, así
 * que un id inventado a mano en la barra de direcciones no produce ningún aviso. El mensaje viaja
 * escapado como siempre; el HTML del destino lo arma la página.
 */
function cargaFeedback(deps: AdminDeps, domain: DomainDecl, msg?: string, destino?: string | null): string {
  if (!msg) return ''
  const ids = new Set((destino ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  const candidatos = ids.size
    ? (deps.intakeSlots ?? []).filter((s) => (s.domain ?? '') === domain.id && ids.has(s.id))
    : []
  return `<p class="msg ${msg.startsWith('Error') ? 'err' : 'ok'}">${escapeHtml(msg)}${destinoAviso(domain.id, candidatos)}</p>`
}

/**
 * Página de UNA corrida (issue #99): resuelve el log del contrato y delega el render a admin-corrida.
 *
 * Fail-closed: la PERTENENCIA del slot/proceso al dominio la valida `runLogs.refOf` — sin ref no hay
 * lectura. Todo fallo del motor se declara como `motor-fallo`: «no pude medir» nunca se muestra como
 * «no hay log». El gate de dominio (admin ∨ steward) ya lo aplicó el ruteo.
 */
async function corridaPage(deps: AdminDeps, nav: Chrome, domain: DomainDecl, params: URLSearchParams): Promise<string> {
  const ops = deps.runLogs!
  const slotId = params.get('slot') ?? undefined
  const processId = params.get('proc') ?? undefined
  const started = params.get('started') ?? ''
  const title = `${domain.label} · Corrida`
  const page = (v: CorridaView): string => adminPage(deps, nav, title, corridaBody(v))

  // Exactamente uno de slot/proc: sin eso no hay origen que resolver.
  if ((!slotId && !processId) || (slotId && processId)) {
    return page({
      domainId: domain.id,
      titulo: 'Corrida',
      volverHref: `/admin/dominio/${domain.id}`,
      volverLabel: domain.label,
      run: null,
      resolucion: { kind: 'sin-convencion' },
    })
  }

  const slot = slotId ? (deps.intakeSlots ?? []).find((s) => s.id === slotId && (s.domain ?? '') === domain.id) : undefined
  const titulo = slotId ? slot?.label ?? slotId : processId!
  const volverHref = slotId ? `/admin/dominio/${domain.id}/cargas` : `/admin/dominio/${domain.id}/frescura`
  const volverLabel = slotId ? `${domain.label} · Cargas` : `${domain.label} · Frescura`
  const src: RunLogSource = slotId ? { domainId: domain.id, slotId } : { domainId: domain.id, processId }
  const base = { domainId: domain.id, titulo, volverHref, volverLabel }
  const fallo = (e: unknown): string => page({ ...base, run: null, resolucion: { kind: 'motor-fallo', detalle: errMsg(e) } })

  let runs: RunRecord[]
  try {
    runs = await ops.runsOf(src)
  } catch (e) {
    return fallo(e)
  }
  // Match EXACTO del ISO que puso el enlace: la corrida la identifica su arranque, no una ventana.
  const run = runs.find((r) => r.startedAt === started) ?? null

  let ref: RunLogRef | null
  try {
    ref = await ops.refOf(src)
  } catch (e) {
    return fallo(e)
  }
  const consolaMotorHref = ref ? `https://app.fabric.microsoft.com/groups/${encodeURIComponent(ref.workspaceId)}` : undefined
  if (!ref) return page({ ...base, run, resolucion: { kind: 'sin-convencion' } })
  if (!run) return page({ ...base, run: null, resolucion: { kind: 'sin-log', dirVacio: false }, consolaMotorHref })

  let entries: OneLakeEntry[]
  try {
    entries = await ops.list(ref)
  } catch (e) {
    return page({ ...base, run, resolucion: { kind: 'motor-fallo', detalle: errMsg(e) }, consolaMotorHref })
  }
  const dirVacio = !entries.some((e) => !e.isDirectory)
  const res = resolveRunLog(run, entries)
  let resolucion: CorridaResolucion
  if (res.kind === 'match') {
    let texto: string | null
    try {
      texto = await ops.read(ref, res.entry.path)
    } catch (e) {
      return page({ ...base, run, resolucion: { kind: 'motor-fallo', detalle: errMsg(e) }, consolaMotorHref })
    }
    // El archivo estaba en el listado pero ya no se lee: degradar, no inventar.
    resolucion = texto == null
      ? { kind: 'sin-log', dirVacio }
      : { kind: 'match', nombre: res.entry.path.split('/').pop() ?? res.entry.path, lastModified: res.entry.lastModified, texto, truncado: res.entry.size > texto.length }
  } else {
    resolucion = res.kind === 'sin-log' ? { kind: 'sin-log', dirVacio } : res
  }
  return page({ ...base, run, resolucion, consolaMotorHref })
}

/**
 * El ANCLA de una reversión (#63): la carga (`upload=<id>`) o un archivo del histórico (`archivo=`).
 *
 * El guard del archivo es el mismo de `restore`: anti-traversal y solo dentro de `_processed/` — una
 * ruta arbitraria del lakehouse jamás llega al motor.
 */
function revertRefDeForm(f: Record<string, string>): { uploadId?: number; archivedPath?: string } {
  const upload = (f['upload'] ?? '').trim()
  if (upload) {
    const id = Number(upload)
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Id de carga inválido.')
    return { uploadId: id }
  }
  const ruta = f['archivo'] ?? ''
  if (!ruta || ruta.includes('..') || !/\/_processed\//.test('/' + ruta)) throw new ValidationError('Solo se revierten cargas del histórico _processed/.')
  return { archivedPath: ruta }
}

/**
 * Despacha una acción POST de la consola de cargas. Todo auditado.
 *
 * Devuelve el mensaje PRG, **salvo** en la confirmación de una reversión (#63): ahí devuelve el plan
 * derivado para que el ruteo responda 200 con la página. Un plan no cabe en un `msg` de query string.
 */
async function handleCargasAccion(deps: AdminDeps, slot: IntakeSlot, f: Record<string, string>, by: string): Promise<string | { plan: RevertPlan; aviso?: string }> {
  const ops = deps.cargas!
  const accion = f['accion'] ?? ''
  if (accion === 'rerun') {
    if (!slot.trigger) throw new ValidationError('Este slot no dispara conversión (land-only).')
    await ops.rerun(slot, by)
    deps.audit({ type: 'intake-rerun', slot: slot.id, domain: slot.domain ?? '', by })
    return 'Conversión disparada — el resultado aparece en «Actividad» en ~1-3 min.'
  }
  if (accion === 'retire') {
    const archivo = f['archivo'] ?? ''
    if (!archivo || archivo.includes('/') || archivo.includes('..')) throw new ValidationError('Nombre de archivo inválido.')
    await ops.retire(slot, archivo, by)
    deps.audit({ type: 'intake-retire', slot: slot.id, domain: slot.domain ?? '', filename: archivo, by })
    return `«${archivo}» retirado del landing (respaldado en _retirado/). Corré la conversión para re-materializar sin él.`
  }
  if (accion === 'restore') {
    const ruta = f['archivo'] ?? ''
    if (!ruta || ruta.includes('..') || !/\/_processed\//.test('/' + ruta)) throw new ValidationError('Solo se reactivan archivos del histórico _processed/.')
    await ops.restore(slot, ruta, by)
    deps.audit({ type: 'intake-restore', slot: slot.id, domain: slot.domain ?? '', filename: ruta, by })
    return `«${ruta.split('/').pop()}» reactivado en el landing. Corré la conversión para materializarlo.`
  }
  // ── «Revertir esta carga» (issue #63): derivar el plan → confirmarlo → ejecutarlo ──
  // El mapeo carga→claves lo mantiene el convertidor en `_processed/<clave>/`: el plan se DERIVA de
  // ahí, no de un registro paralelo. Una acción destructiva sobre el dato se confirma leyendo, clave
  // por clave, qué va a pasar — incluido lo que no va a pasar y por qué.
  if (accion === 'revert-plan') {
    if (!ops.revertPlan) throw new ValidationError('La reversión no está disponible en esta instancia.')
    return { plan: await ops.revertPlan(slot, revertRefDeForm(f)) }
  }
  if (accion === 'revert-exec') {
    if (!ops.revertExec) throw new ValidationError('La reversión no está disponible en esta instancia.')
    const hash = (f['hash'] ?? '').trim()
    if (!hash) throw new ValidationError('Falta el sello del plan confirmado.')
    const ref = revertRefDeForm(f)
    const out = await ops.revertExec(slot, hash, ref, by)
    // Fail-closed: el slot cambió entre confirmar y ejecutar ⇒ no se ejecuta nada, se re-confirma.
    if (!out.ok) return { plan: out.plan, aviso: 'El estado del slot cambió desde que viste este plan — revisalo de nuevo.' }
    const r = out.result
    const claves = r.resumen.map((c) => `${c.clave}:${c.accion}`).join(',')
    deps.audit({
      type: 'intake-revert', slot: slot.id, domain: slot.domain ?? '', filename: r.filename, by,
      ...(r.uploadId != null ? { uploadId: r.uploadId } : {}), claves, landingRetirado: r.landingRetirado,
    })
    const hechos = r.resumen.filter((c) => c.accion === 'rematerializar' || c.accion === 'vaciar').map((c) => `«${c.clave}» ${c.accion === 'vaciar' ? 'queda vacía' : 'vuelve a su versión anterior'}`)
    const sinTocar = r.resumen.filter((c) => c.accion !== 'rematerializar' && c.accion !== 'vaciar')
    const detalle = hechos.length ? ` ${hechos.join('; ')}.` : ' Ninguna clave requería compensación.'
    const cola = r.convirtiendo ? ' La conversión compensatoria está corriendo — el resultado aparece en «Actividad» en ~1-3 min.' : ''
    const nota = sinTocar.length ? ` ${sinTocar.length} clave(s) quedaron SIN tocar (revisá el detalle en la fila ↩️ de Actividad).` : ''
    return `Reversión ejecutada: «${r.filename}».${detalle}${r.landingRetirado ? ' La copia del landing se retiró.' : ''}${cola}${nota}`
  }
  throw new ValidationError(`Acción desconocida: ${accion}`)
}

/** Faceta FRESCURA de un dominio (página propia): el contrato de frescura entity-anchored — brecha
 * demanda↔oferta · corridas · schedule + «aplicar cadencia» (refresco AUTOMÁTICO) · **carga de archivo**
 * (refresco MANUAL, plegado acá). Las dos caras de mantener la entidad fresca, en un solo lugar. */
async function domainFreshnessPage(deps: AdminDeps, nav: Chrome, domain: DomainDecl, token: string, msg?: string, destino?: string | null): Promise<string> {
  const title = `${domain.label} · Frescura`
  const back = `<p class="sub"><a href="/admin/dominio/${escapeHtml(domain.id)}">← ${escapeHtml(domain.label)}</a></p>`
  const rows = await deps.domainFreshness!(domain.id)
  // #178 · un rechazo nacido en un form de ESTA página vuelve acá, y trae su destino con él.
  const feedback = cargaFeedback(deps, domain, msg, destino)
  const notebooks = rows.filter((r) => r.engine && engineKind(r.engineJobType).isNotebook).map((r) => r.processLabel || r.processId).filter(Boolean)
  const migAlert = notebooks.length
    ? `<p class="msg err">⚠ ${notebooks.length === 1 ? 'Un proceso corre' : `${notebooks.length} procesos corren`} como <b>Notebook</b> (${escapeHtml([...new Set(notebooks)].join(', '))}). Debe migrar a <b>Spark Job</b> (Fabric-native, failure-safe) — ver el patrón de Finanzas.</p>`
    : ''
  // Slots de ingesta del dominio: la carga manual se pliega acá. Una entidad casa con su slot por el item
  // del motor (slot.trigger.processRef === engine_ref.itemId del proceso que la produce).
  const domSlots = deps.intake ? (deps.intakeSlots ?? []).filter((s) => (s.domain ?? '') === domain.id) : []
  // #56 · coherencia declarativa: un slot con trigger cuyo proceso NO está registrado en Fuentes queda
  // huérfano en silencio (sin fila de entidad, sin salud, sin monitor). Acusarlo acá, ruidosamente.
  let coherenciaAlert = ''
  if (deps.sourceRegistry && domSlots.some((s) => s.trigger)) {
    const engineIds = new Set(
      (await deps.sourceRegistry().catch(() => ({ processes: [] as ProcessRow[] }))).processes.map((p) => p.engine?.itemId ?? '').filter(Boolean),
    )
    const huerfanos = engineIds.size ? domSlots.filter((s) => s.trigger && !engineIds.has(s.trigger.processRef)) : []
    if (huerfanos.length) {
      coherenciaAlert = `<p class="msg err">⚠ ${huerfanos.length === 1 ? 'El slot' : 'Los slots'} ${huerfanos.map((s) => `<b>${escapeHtml(s.label)}</b> (dispara <code>${escapeHtml(s.trigger!.processRef)}</code>)`).join(', ')} no ${huerfanos.length === 1 ? 'tiene' : 'tienen'} su proceso registrado en <a href="/admin/sources">Fuentes</a> → sin fila de entidad, sin salud, sin monitor. Registrarlo en <code>sources.yaml</code>.</p>`
    }
  }
  // Log de la última conversión por slot (issue #55): la reconfirmación de una carga (filas, semana,
  // commit, archivado) legible sin acceso a Fabric. Tolerante a fallos: sin log → sin sección.
  const slotLogs = new Map<string, string>()
  if (deps.intakeLog) {
    await Promise.all(domSlots.map(async (s) => {
      const log = await deps.intakeLog!(s).catch(() => null)
      if (log?.trim()) slotLogs.set(s.id, log)
    }))
  }
  const logDetails = (slotId: string): string => {
    const log = slotLogs.get(slotId)
    if (!log) return ''
    const tail = log.length > 4000 ? `…${log.slice(-4000)}` : log
    return `<details class="guia"><summary class="sub">Log de la última conversión</summary><pre class="sub" style="white-space:pre-wrap;overflow-x:auto;max-height:260px;overflow-y:auto">${escapeHtml(tail.trim())}</pre></details>`
  }
  // #99 · destino del «Ver log» de la última corrida de la entidad. Sin `runLogs` cableado no hay enlace.
  const runLogHrefOfEntity = (r: DomainEntityFreshness): string | null => {
    if (!deps.runLogs || !r.processId) return null
    const last = (r.runs ?? [])[0]
    return last ? `/admin/dominio/${domain.id}/corrida?proc=${encodeURIComponent(r.processId)}&started=${encodeURIComponent(last.startedAt)}` : null
  }
  const slotFor = (r: DomainEntityFreshness): IntakeSlot | undefined =>
    r.engineItemId ? domSlots.find((s) => s.trigger?.processRef && s.trigger.processRef === r.engineItemId) : undefined
  if (!rows.length && !domSlots.length) {
    return adminPage(deps, nav, title, `${feedback}${back}<p class="sub">Este dominio aún no tiene entidades con fuente registrada. Conectá sus fuentes en <a href="/admin/sources">Fuentes</a> (plataforma) y asignales este dominio.</p>`)
  }
  const matched = new Set<string>()
  const body = rows
    .map((r) => {
      const warn = r.unsatisfiable || r.health?.failed || r.health?.missed
      const demanda = r.tightestDemand ? escapeHtml(r.tightestDemand) : '<span class="sub">sin demanda</span>'
      const oferta = r.oferta ? escapeHtml(r.oferta) : '<span class="sub">—</span>'
      const req = r.requiredCadence ? `<b>${escapeHtml(r.requiredCadence)}</b>${r.unsatisfiable ? ' ⚠️' : ''}` : '<span class="sub">—</span>'
      // Sin observación del motor no se afirma nada de su schedule: `—` (no «sin schedule», que
      // afirmaría haber mirado). Y sin schedule observado no hay drift que declarar → no se ofrece
      // «Aplicar»: el botón nacería de una comparación contra un dato que no existe.
      const observado = !r.projection || r.projection.observedAt != null
      const sched = !r.engine
        ? '<span class="sub">sin motor</span>'
        : !observado
          ? '<span class="sub">—</span>'
          : r.actualScheduleSeconds != null
            ? escapeHtml(secondsToDuration(r.actualScheduleSeconds))
            : '<span class="sub">sin schedule</span>'
      const drift = r.engine && observado && r.requiredCadenceSeconds != null && r.actualScheduleSeconds !== r.requiredCadenceSeconds
      // #107 · un proceso pausado no se «aplica»: la cadencia empujada lo re-habilitaría por la puerta
      // de atrás. La fila lo dice y ofrece Reanudar en su lugar.
      const accionForm = (accion: string, label: string, cls: string): string =>
        `<form method="post" action="/admin/dominio/${escapeHtml(domain.id)}/frescura" style="display:inline"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="process" value="${escapeHtml(r.processId!)}"><input type="hidden" name="accion" value="${accion}"><button class="${cls}">${label}</button></form>`
      const pausaNota = r.paused
        ? `<div class="sub">⏸ pausado${r.paused.by ? ` por ${escapeHtml(r.paused.by)}` : ''} · ${escapeHtml(fmtWhen(r.paused.at))}</div>`
        : ''
      const pausa = deps.pauseProcess && r.processId && r.engine
        ? r.paused
          ? `<div>${accionForm('reanudar', 'Reanudar', 'add')}</div>`
          : observado && r.actualScheduleSeconds != null
            ? `<div>${accionForm('pausar', 'Pausar', 'del')}</div>`
            : ''
        : ''
      const aplicar = drift && !r.paused && deps.applyCadence && r.processId
        ? `<form method="post" action="/admin/dominio/${escapeHtml(domain.id)}/frescura" style="display:inline"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="process" value="${escapeHtml(r.processId)}"><button class="add">Aplicar</button></form>`
        : ''
      const slot = slotFor(r)
      if (slot) matched.add(slot.id)
      const alimentar = slot ? uploadForm(domain.id, slot, token) + logDetails(slot.id) : '<span class="sub">automática</span>'
      const pis = r.dependentPis.map((p) => escapeHtml(p)).join(', ')
      return `<tr${warn ? ' style="color:var(--err)"' : ''}>
        <td><span class="c">${escapeHtml(r.entity)}</span>${r.processLabel ? `<div class="sub">${escapeHtml(r.processLabel)}</div>` : ''}${pis ? `<div class="sub">PIs: ${pis}</div>` : ''}</td>
        <td>${demanda}</td><td>${oferta}</td><td>${req}</td>
        <td>${sched}${pausaNota}${aplicar ? `<div>${aplicar}</div>` : ''}${pausa}</td>
        <td>${freshnessHealthCell(r, runLogHrefOfEntity)}</td>
        <td>${alimentar}</td></tr>`
    })
    .join('')
  // Slots del dominio sin entidad registrada (land-only, o cuya fuente/proceso aún no está en el registro):
  // su carga manual igual debe tener dónde — no se pierde.
  const orphanSlots = domSlots.filter((s) => !matched.has(s.id))
  // Estado de conversión por slot huérfano (mismo dato que «Última corrida» de las entidades): sin él,
  // quien sube acá queda a ciegas si el job disparado falla — solo vería el archivo «recibido».
  const orphanRuns = new Map<string, RunRecord[] | 'error'>()
  if (deps.intakeStatus) {
    await Promise.all(orphanSlots.filter((s) => s.trigger).map(async (s) => {
      orphanRuns.set(s.id, await deps.intakeStatus!(s).catch(() => 'error' as const))
    }))
  }
  const slotRunLine = (s: IntakeSlot): string => {
    const st = orphanRuns.get(s.id)
    if (st === undefined) return ''
    if (st === 'error') return '<div class="sub">No se pudo consultar el estado de la conversión (reintentá refrescando).</div>'
    if (!st.length) return '<div class="sub">Sin corridas todavía.</div>'
    const href = deps.runLogs ? `/admin/dominio/${domain.id}/corrida?slot=${encodeURIComponent(s.id)}&started=${encodeURIComponent(st[0].startedAt)}` : null
    const verLog = href ? ` · <a href="${escapeHtml(href)}">Ver log</a>` : ''
    return `<div class="sub">Última corrida: ${statusBadge(st[0].status)} ${fmtWhen(st[0].startedAt)}${verLog}</div>${runErrorLine(st[0])}`
  }
  const orphanSection = orphanSlots.length
    ? `<h2>Otras cargas</h2><p class="sub">Slots de ingesta del dominio sin entidad registrada en Frescura todavía (registrá su fuente/proceso en <a href="/admin/sources">Fuentes</a> para verlas por entidad).</p>
       <ul class="cards">${orphanSlots.map((s) => `<li><b>${escapeHtml(s.label)}</b>${s.description ? `<div class="sub">${escapeHtml(s.description)}</div>` : ''}${slotRunLine(s)}${uploadForm(domain.id, s, token)}${logDetails(s.id)}</li>`).join('')}</ul>`
    : ''
  const guia = domSlots.length
    ? `<details class="guia"><summary>¿Cómo alimentar manualmente?</summary>
         <p class="sub">Subí el/los archivo(s) en la fila de la entidad (columna «Alimentar»). Mira los aterriza en staging y dispara la conversión; el resultado aparece en «Última corrida». Respetá el patrón de nombre del slot. La carga manual es el gemelo del schedule automático: las dos producen una corrida fresca.</p>
       </details>`
    : ''
  const table = rows.length
    ? `<table><thead><tr><th>Entidad</th><th>Demanda</th><th>Oferta</th><th>Cadencia req.</th><th>Schedule motor</th><th>Última corrida</th><th>Alimentar</th></tr></thead>
       <tbody>${body}</tbody></table>`
    : ''
  return adminPage(deps, nav, title,
    `${feedback}${migAlert}${coherenciaAlert}${back}
     <p class="sub">Por entidad: la demanda más exigente de sus PIs vs. la oferta de su fuente → <b>cadencia requerida</b>. El refresco es de dos formas: <b>automático</b> (el «schedule motor»; «Aplicar» lo alinea a la cadencia requerida) y <b>manual</b> (subir archivo en «Alimentar»). «Última corrida» indica el tipo de motor (Notebook / Spark Job). ⚠️ = demanda insatisfacible, o entidad atrasada/fallida.</p>
     ${guia}
     ${table}
     ${orphanSection}`,
  )
}

// ─── Grupos de Mira ──────────────────────────────────────────────────────────
async function handleGroups(
  deps: AdminDeps,
  nav: Chrome,
  groups: GroupStore,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  by: string,
): Promise<boolean> {
  if (path === '/admin/groups' && req.method === 'GET') {
    send(res, 200, await groupsPage(deps, nav, groups, token))
    return true
  }
  if (path === '/admin/groups/create' && req.method === 'POST') {
    const f = await readForm(req)
    requireCsrf(f, token)
    try {
      await groups.createGroup(f['id'] ?? '', f['label'] ?? '')
      deps.audit({ type: 'admin-groups-write', op: 'create', group: (f['id'] ?? '').toLowerCase(), by })
      redirect(res, '/admin/groups')
    } catch (e) {
      send(res, e instanceof GovernanceConflict ? 409 : 400, await groupsPage(deps, nav, groups, token, errMsg(e)))
    }
    return true
  }
  if (path === '/admin/groups/delete' && req.method === 'POST') {
    const f = await readForm(req)
    requireCsrf(f, token)
    await groups.deleteGroup(f['id'] ?? '')
    deps.audit({ type: 'admin-groups-write', op: 'delete', group: (f['id'] ?? '').toLowerCase(), by })
    redirect(res, '/admin/groups')
    return true
  }
  const gm = path.match(/^\/admin\/groups\/([a-z][a-z0-9_-]*)(?:\/(add|remove))?$/)
  if (gm) {
    const gid = gm[1]
    const op = gm[2]
    if (!op && req.method === 'GET') {
      send(res, 200, await groupMembersPage(deps, nav, groups, gid, token))
      return true
    }
    if (op && req.method === 'POST') {
      const f = await readForm(req)
      requireCsrf(f, token)
      try {
        if (op === 'add') {
          await groups.addMember(gid, f['email'] ?? '', by)
          deps.audit({ type: 'admin-groups-write', op: 'add-member', group: gid, member: (f['email'] ?? '').toLowerCase(), by })
        } else {
          await groups.removeMember(gid, f['email'] ?? '')
          deps.audit({ type: 'admin-groups-write', op: 'remove-member', group: gid, member: (f['email'] ?? '').toLowerCase(), by })
        }
        redirect(res, `/admin/groups/${gid}`)
      } catch (e) {
        send(res, 400, await groupMembersPage(deps, nav, groups, gid, token, errMsg(e)))
      }
      return true
    }
  }
  return false
}

async function groupsPage(deps: AdminDeps, nav: Chrome, groups: GroupStore, token: string, msg?: string): Promise<string> {
  const list = await groups.listGroups()
  const rows = list
    .map(
      (g) => `<tr><td><a href="/admin/groups/${escapeHtml(g.id)}"><span class="c">${escapeHtml(g.id)}</span></a></td><td>${escapeHtml(g.label)}</td><td class="r">${
        g.seed
          ? '<span class="tag">semilla</span>'
          : `<form method="post" action="/admin/groups/delete" onsubmit="return confirm('¿Eliminar el grupo ${escapeHtml(g.id)}?')"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="id" value="${escapeHtml(g.id)}"><button class="del">Eliminar</button></form>`
      }</td></tr>`,
    )
    .join('')
  return adminPage(deps, nav,
    'Grupos de Mira',
    `<p class="sub"><a href="/admin/plataforma">← Plataforma</a></p>
     ${msg ? `<p class="msg err">${escapeHtml(msg)}</p>` : ''}
     <table><thead><tr><th>Id</th><th>Nombre</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="sub">Sin grupos.</td></tr>'}</tbody></table>
     <h2>Crear grupo</h2>
     <form method="post" action="/admin/groups/create" class="row">
       <input type="hidden" name="_csrf" value="${token}">
       <input name="id" placeholder="id_del_grupo" pattern="[a-z][a-z0-9_-]*">
       <input name="label" placeholder="Nombre visible">
       <button class="add">Crear</button>
     </form>`,
  )
}

async function groupMembersPage(deps: AdminDeps, nav: Chrome, groups: GroupStore, gid: string, token: string, msg?: string): Promise<string> {
  const list = await groups.listGroups()
  const g = list.find((x) => x.id === gid.toLowerCase())
  if (!g) return adminPage(deps, nav, 'No encontrado', `<p class="msg err">Grupo desconocido: <code>${escapeHtml(gid)}</code></p><p><a href="/admin/groups">← Grupos</a></p>`)
  const members = await groups.listMembers(gid)
  const rows = members
    .map(
      (m) => `<tr><td>${escapeHtml(m.email)}</td><td class="r"><form method="post" action="/admin/groups/${escapeHtml(gid)}/remove"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="email" value="${escapeHtml(m.email)}"><button class="del">Quitar</button></form></td></tr>`,
    )
    .join('')
  return adminPage(deps, nav,
    `Grupo · ${g.label}`,
    `<p class="sub"><a href="/admin/groups">← Grupos</a> · <span class="c">${escapeHtml(g.id)}</span>${g.seed ? ' <span class="tag">semilla</span>' : ''}</p>
     ${msg ? `<p class="msg err">${escapeHtml(msg)}</p>` : ''}
     <table><thead><tr><th>Miembro</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="2" class="sub">Sin miembros.</td></tr>'}</tbody></table>
     <h2>Agregar miembro</h2>
     <form method="post" action="/admin/groups/${escapeHtml(gid)}/add" class="row">
       <input type="hidden" name="_csrf" value="${token}">
       <input type="email" name="email" placeholder="correo@dominio" required>
       <button class="add">Agregar</button>
     </form>`,
  )
}

async function rolesPage(deps: AdminDeps, nav: Chrome, token: string, msg?: string): Promise<string> {
  const admins = await deps.adminStore.list()
  const rows = admins
    .map(
      (a) => `<tr><td>${escapeHtml(a.email)}</td><td>${a.seed ? '<span class="tag">semilla</span>' : escapeHtml(a.addedBy ?? '')}</td><td class="r">${
        a.seed
          ? '<span class="sub">—</span>'
          : `<form method="post" action="/admin/roles/remove" onsubmit="return confirm('¿Quitar a ${escapeHtml(a.email)}?')"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="email" value="${escapeHtml(a.email)}"><button class="del">Quitar</button></form>`
      }</td></tr>`,
    )
    .join('')
  return adminPage(deps, nav,
    'Usuarios y Roles',
    `<p class="sub"><a href="/admin/plataforma">← Plataforma</a></p>
     ${msg ? `<p class="msg err">${escapeHtml(msg)}</p>` : ''}
     <table><thead><tr><th>Correo</th><th>Origen</th><th></th></tr></thead><tbody>${rows}</tbody></table>
     <h2>Agregar administrador</h2>
     <form method="post" action="/admin/roles/add" class="row">
       <input type="hidden" name="_csrf" value="${token}">
       <input type="email" name="email" placeholder="correo@dominio" required>
       <button class="add">Agregar</button>
     </form>`,
  )
}

async function entityPage(deps: AdminDeps, nav: Chrome, entity: MasterDataEntity, token: string, editPk?: string): Promise<string> {
  const pk = pkColumn(entity)
  const rows = await deps.mdStore.list(entity)
  const editing = editPk != null ? rows.find((r) => String(r[pk.name]) === editPk) : undefined
  const back = entity.domain ? `/admin/dominio/${entity.domain}` : '/admin'

  const thead = entity.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('') + '<th></th>'
  const tbody = rows
    .map((r) => {
      const tds = entity.columns.map((c) => `<td>${escapeHtml(fmt(r[c.name]))}</td>`).join('')
      const pkRaw = String(r[pk.name])
      const pkv = escapeHtml(pkRaw)
      return `<tr>${tds}<td class="r">
        <a class="edit" href="/admin/e/${entity.id}?edit=${encodeURIComponent(pkRaw)}">Editar</a>
        <form method="post" action="/admin/e/${entity.id}/delete" onsubmit="return confirm('¿Eliminar ${pkv}?')">
          <input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="${pk.name}" value="${pkv}"><button class="del">Eliminar</button>
        </form></td></tr>`
    })
    .join('')

  const formTitle = editing ? `Editar registro <code>${escapeHtml(editPk!)}</code>` : 'Agregar registro'
  const action = editing ? `/admin/e/${entity.id}/update` : `/admin/e/${entity.id}/insert`
  const fields = entity.columns
    .map((c) => {
      const v = editing ? fmt(editing[c.name]) : ''
      const ro = editing && c.pk ? 'readonly' : ''
      if (c.type === 'bool') {
        const checked = editing && editing[c.name] ? 'checked' : ''
        return `<label class="fld"><span>${escapeHtml(c.label)}</span><input type="checkbox" name="${c.name}" value="1" ${checked}></label>`
      }
      return `<label class="fld"><span>${escapeHtml(c.label)}${c.required ? ' *' : ''}</span><input name="${c.name}" value="${escapeHtml(v)}" ${c.required ? 'required' : ''} ${ro}></label>`
    })
    .join('')

  return adminPage(deps, nav,
    entity.label,
    `<p class="sub"><a href="${back}">← ${escapeHtml(entity.domain ?? 'Administración')}</a></p>
     <table><thead><tr>${thead}</tr></thead><tbody>${tbody || `<tr><td colspan="${entity.columns.length + 1}" class="sub">Sin registros.</td></tr>`}</tbody></table>
     <h2>${formTitle}</h2>
     <form method="post" action="${action}" class="grid">
       <input type="hidden" name="_csrf" value="${token}">
       ${fields}
       <div class="actions"><button class="add">${editing ? 'Guardar cambios' : 'Agregar'}</button>${editing ? `<a class="cancel" href="/admin/e/${entity.id}">Cancelar</a>` : ''}</div>
     </form>`,
  )
}

const fmt = (v: unknown): string => (v == null ? '' : typeof v === 'boolean' ? (v ? 'Sí' : 'No') : String(v))


// ─── Mapa identidad→claims (#159 · §5 del diseño del cluster authz) ─────────
/**
 * La sintaxis con que un humano escribe los claims de UNA entrada: **una línea por claim**,
 * `clave: valor` o `clave: valor1, valor2` (el claim es un CONJUNTO, posiblemente unitario · #165).
 *
 * Se valida en vez de adivinar: una línea sin `:` es un error, no «una clave sin valores» — inferir
 * qué quiso decir el admin sobre el trust-base es exactamente lo que no se hace acá. Una clave
 * repetida también lanza: quedarse con la última perdería la otra en silencio.
 */
function parseClaimLines(texto: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const raw of (texto ?? '').split(/\r?\n/)) {
    const linea = raw.trim()
    if (!linea) continue
    const i = linea.indexOf(':')
    if (i < 0) throw new ValidationError(`Claim sin valor: '${linea}'. Se escribe una línea por claim, con el formato clave: valor1, valor2`)
    const clave = linea.slice(0, i).trim()
    const vals = linea.slice(i + 1).split(',').map((v) => v.trim()).filter(Boolean)
    if (!clave) throw new ValidationError(`Claim sin nombre: '${linea}'.`)
    if (!vals.length) throw new ValidationError(`El claim '${clave}' no trae ningún valor. Para dejar la identidad sin claims, borrá la línea entera.`)
    if (out[clave]) throw new ValidationError(`El claim '${clave}' aparece dos veces: escribí sus valores en una sola línea, separados por coma.`)
    out[clave] = vals
  }
  return out
}

/** El texto del textarea para una entrada existente (round-trip exacto de `parseClaimLines`). */
function claimLines(claims: Record<string, string[]>): string {
  return Object.entries(claims).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n')
}

/** Email de una entrada. Formato, no identidad: valida que la clave PUEDA coincidir con lo que el
 * gate autentica (el resolver busca por `user.toLowerCase()`); jamás corrige ni sugiere un parecido. */
const IDENTITY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function identityEmail(raw: string): string {
  const e = (raw ?? '').trim().toLowerCase()
  if (!e) throw new ValidationError('La entrada del mapa necesita un correo.')
  if (!IDENTITY_EMAIL_RE.test(e)) throw new ValidationError(`Correo inválido: '${e}'.`)
  return e
}

/**
 * Cómo se ve la procedencia de una entrada. Las tres se ven DISTINTO a propósito:
 *  · `autoritativa` — la trajo la fuente y resolvió;
 *  · `override` — la inscribió un humano; es lo único que sobrevive a la regeneración del mapa;
 *  · `autoritativa-ambigua` — la fuente la trajo y NO resolvió a un valor único. Es un ESTADO, no un
 *    error: se muestra como tal para que «ninguna» deje de ser indistinguible de «sin entrada».
 *    Desempatar sigue prohibido — la superficie muestra el empate, no lo resuelve.
 */
function procedenciaBadge(o: AdminIdentityOrigin): string {
  if (o === 'override') return '<span class="tag">override declarado</span>'
  if (o === 'autoritativa-ambigua') return '<b style="color:var(--err)">⚠ autoritativa · ambigua</b>'
  return '<span class="sub">autoritativa</span>'
}

/**
 * Administración del mapa identidad→claims (#159): ver el mapa vigente con su procedencia por
 * entrada, corregirlo e inscribir overrides declarados — sin tocar el host ni reiniciar nada.
 *
 * Lo que esta vista NO hace, y es requisito duro del issue: **no infiere identidad**. No autocompleta
 * ni sugiere claims por parecido de nombre o de correo. Una identidad que no resuelve queda sin
 * claims y la política decide fail-closed; la conveniencia de la UI no toca esa restricción.
 */
async function identidadesPage(deps: AdminDeps, nav: Chrome, token: string, msg?: string, edit?: string): Promise<string> {
  const store = deps.identityClaims!
  const entradas = await store.listIdentityClaims()
  const csrfIn = `<input type="hidden" name="_csrf" value="${token}">`
  const claimsCell = (e: AdminIdentityEntry): string => {
    const keys = Object.keys(e.claims)
    // Entrada SIN claims ≠ identidad SIN entrada: la primera se reconcilió y no resolvió, la segunda
    // nadie la reconcilió. Que se lean distinto es el punto de §4 de #165 aterrizado acá.
    if (!keys.length) return '<span class="sub">sin claims · presente en el mapa, no resolvió</span>'
    return keys.map((k) => `<div><span class="c">${escapeHtml(k)}</span> ${e.claims[k].map((v) => `<code>${escapeHtml(v)}</code>`).join(' ')}</div>`).join('')
  }
  const filas = entradas
    .map((e) => `<tr>
        <td>${escapeHtml(e.email)}</td>
        <td>${claimsCell(e)}</td>
        <td>${procedenciaBadge(e.origin)}</td>
        <td class="sub">${escapeHtml(e.updatedBy ?? '—')}${e.updatedAt ? `<div>${escapeHtml(fmtWhen(e.updatedAt))}</div>` : ''}</td>
        <td class="r"><a class="edit" href="/admin/identidades?edit=${encodeURIComponent(e.email)}">Editar</a>
          <form method="post" action="/admin/identidades/entry-delete" style="display:inline" onsubmit="return confirm('¿Sacar del mapa la entrada de ${escapeHtml(e.email)}?')">${csrfIn}<input type="hidden" name="email" value="${escapeHtml(e.email)}"><button class="del">Eliminar</button></form>
        </td></tr>`)
    .join('')

  // Capacidad 1 del issue: cuántas identidades AUTENTICADAS no resuelven. Solo si alguien aporta el
  // universo observado — sin él no se pinta un número inventado (el instrumento declara que no midió).
  let sinEntrada = ''
  if (deps.observedIdentities) {
    try {
      const noResuelven = await store.unresolvedIdentities(await deps.observedIdentities())
      sinEntrada = noResuelven.length
        ? `<h2>Identidades autenticadas sin entrada (${noResuelven.length})</h2>
           <p class="sub">Entraron por el gate y NO tienen entrada en el mapa: quedan sin claims y la política decide fail-closed. Inscribir una es un acto explícito — el mapa no adivina a quién se parecen.</p>
           <ul class="cards">${noResuelven.map((e) => `<li><a href="/admin/identidades?edit=${encodeURIComponent(e)}">${escapeHtml(e)}</a><div class="sub">inscribir un override</div></li>`).join('')}</ul>`
        : `<h2>Identidades autenticadas sin entrada</h2><p class="sub">Ninguna: todas las identidades observadas tienen entrada en el mapa.</p>`
    } catch {
      sinEntrada = `<p class="msg err">⚠ No se pudo leer el universo de identidades autenticadas — el mapa de arriba es correcto; este bloque no se pudo medir.</p>`
    }
  }

  const eE = edit ? entradas.find((x) => x.email === edit.trim().toLowerCase()) : undefined
  // Editar es el MISMO form pre-poblado vía `?edit=` (patrón de Fuentes). Con un `?edit=` que no está
  // en el mapa, el form queda con ese correo y claims vacíos: es el camino de alta del override.
  const emailPrefill = eE?.email ?? (edit ? edit.trim().toLowerCase() : '')
  const feedback = msg ? `<p class="msg ${msg.startsWith('Error') ? 'err' : 'ok'}">${escapeHtml(msg)}</p>` : ''
  return adminPage(deps, nav,
    'Mapa de identidad',
    `<p class="sub"><a href="/admin/plataforma">← Plataforma</a></p>
     ${feedback}
     <p class="sub">Qué claims tiene cada identidad: el <b>trust-base</b> sobre el que se aplica toda política de datos. Se administra acá, no por archivo desplegado. Una identidad <b>sin entrada</b> no aparece en esta tabla — queda sin claims y la política decide <b>fail-closed</b>; no se adivina por parecido de nombre ni de correo.</p>
     <table><thead><tr><th>Identidad</th><th>Claims</th><th>Procedencia</th><th>Actualizada por</th><th></th></tr></thead>
     <tbody>${filas || '<tr><td colspan="5" class="sub">El mapa está vacío: ninguna identidad tiene claims.</td></tr>'}</tbody></table>
     <p class="sub"><b>Procedencia:</b> <i>autoritativa</i> = la trajo la fuente · <i>override declarado</i> = lo inscribió un humano y sobrevive a la regeneración del mapa · <b style="color:var(--err)">⚠ autoritativa · ambigua</b> = la fuente la trajo y no resolvió a un valor único (doble pertenencia legítima). La ambigua <b>es un estado, no un error</b>, y no se desempata desde acá.</p>
     <h2>${eE ? `Corregir la entrada de <code>${escapeHtml(eE.email)}</code>` : 'Inscribir una entrada'}</h2>
     <form method="post" action="/admin/identidades/entry" class="grid">${csrfIn}
       <label class="fld"><span>Correo *</span><input type="email" name="email" value="${escapeHtml(emailPrefill)}" required ${eE ? 'readonly' : ''}></label>
       <label class="fld"><span>Claims (una línea por claim: <code>clave: valor1, valor2</code>)</span>
         <textarea name="claims" rows="4" placeholder="area: finanzas">${escapeHtml(eE ? claimLines(eE.claims) : '')}</textarea></label>
       <div class="actions"><button class="add">${eE ? 'Guardar como override' : 'Inscribir override'}</button>${eE ? '<a class="cancel" href="/admin/identidades">Cancelar</a>' : ''}</div>
     </form>
     <p class="sub">Toda escritura desde acá queda con procedencia <b>override</b>, y no es una etiqueta cosmética: el override es lo único que la regeneración del mapa <b>no</b> borra. Marcarla como autoritativa sería mentir sobre de dónde vino, y la corrección se perdería en la próxima regeneración — que es el defecto que esta pantalla existe para arreglar. Para devolverle una identidad a la fuente autoritativa, se da de baja el override: la próxima reconciliación la vuelve a traer.</p>
     ${sinEntrada}`,
  )
}

/**
 * Las escrituras del mapa. Dos operaciones y ninguna más: alta/corrección (que son la misma) y baja.
 * La procedencia NO es un campo del form: se deriva del acto —lo escribió un humano ⇒ `override`—
 * porque dejar elegir «autoritativa» permitiría inscribir a mano una entrada que se presenta como
 * venida de la fuente, y la auditoría posterior ya no podría separarlas.
 */
async function handleIdentityWrite(deps: AdminDeps, store: IdentityClaimsAdmin, op: string, f: Record<string, string>, by: string): Promise<string> {
  const audit = (o: string, target: string, detalle: Record<string, unknown> = {}): void =>
    deps.audit({ type: 'identity-map-write', op: o, target, by, ...detalle })
  switch (op) {
    case 'entry': {
      const email = identityEmail(f['email'] ?? '')
      const claims = parseClaimLines(f['claims'] ?? '')
      const previa = await store.getIdentityClaims(email)
      await store.upsertIdentityClaims(email, { claims, origin: 'override', updatedBy: by })
      audit('entry-upsert', email, {
        origin: 'override',
        // Qué había ANTES: sin esto, la auditoría no puede decir si un override pisó una entrada
        // autoritativa (que es el caso que un revisor querrá mirar) o inscribió una identidad nueva.
        previo: previa?.origin ?? null,
        claims: Object.entries(claims).map(([k, v]) => `${k}=${v.join('|')}`).join(' '),
      })
      return `Entrada ${email} guardada como override.`
    }
    case 'entry-delete': {
      const email = identityEmail(f['email'] ?? '')
      const previa = await store.getIdentityClaims(email)
      await store.deleteIdentityClaims(email)
      audit('entry-delete', email, { previo: previa?.origin ?? null })
      return `Entrada ${email} sacada del mapa (queda sin claims: la política decide fail-closed).`
    }
    default:
      throw new ValidationError(`Operación desconocida: '${op}'.`)
  }
}

// ─── Errores tipados (códigos accionables; HTTP helpers viven en ./ui) ───────
class ValidationError extends Error {}

function errMsg(e: unknown): string {
  if (e instanceof MasterDataConflict || e instanceof AdminLockout || e instanceof ValidationError || e instanceof CsrfError) return e.message
  return e instanceof Error ? e.message : String(e)
}

/** Códigos accionables: CSRF→403, validación→400 (cliente corrige), conflicto/lockout→409, resto→500. */
function statusForError(e: unknown): number {
  if (e instanceof CsrfError) return 403
  if (e instanceof ValidationError) return 400
  if (e instanceof MasterDataConflict || e instanceof AdminLockout || e instanceof GovernanceConflict) return 409
  return 500
}
