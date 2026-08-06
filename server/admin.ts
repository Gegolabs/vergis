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
  canManageDomain,
  manageableDomains,
  slotMaxBytes,
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
  type ProcessHealth,
  type MasterDataEntity,
  type MasterDataRow,
  type MasterDataStore,
  type RunRecord,
  type RunStatus,
  type IntakeUploadStore,
  type IntakeUploadRow,
  type OneLakeEntry,
} from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'
import { shellNav, avatarMenu, THEME_TOGGLE_JS, send, redirect, readForm, requireCsrf, csrfFactory, CsrfError } from './ui'
import { NOTAS_SETTINGS, leerNotasSettings, validarRetencion, validarMaxSchedules } from './notas-settings'
import { readMultipart } from './multipart'
import { cargasBody, type CargasOps, type SlotCargas } from './admin-cargas'
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

/** Fila de Frescura por entidad enriquecida con el estado en vivo del motor (run-history + schedule + salud). */
export interface DomainEntityFreshness extends EntityFreshnessRow {
  /** ¿El proceso productor tiene engine_ref (es observable en el motor)? Si no, no hay corridas ni schedule. */
  engine: boolean
  /** Tipo de job del motor que ejecuta el proceso (Fabric: 'RunNotebook' | 'sparkjob' | 'Pipeline'…). */
  engineJobType?: string
  /** Item id del motor (para casar la entidad con su slot de ingesta: slot.trigger.processRef === este). */
  engineItemId?: string
  /** Últimas corridas del proceso (más reciente primero), o 'error' si el motor no respondió. */
  runs?: RunRecord[] | 'error'
  /** Salud derivada (fallida / faltante) a partir de las corridas y la cadencia requerida. */
  health?: ProcessHealth
  /** Schedule real del proceso en el motor (segundos); null si no tiene o no se pudo leer. */
  actualScheduleSeconds?: number | null
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
  /** Frescura por entidad de un dominio (vista de dominio): proyección por entidad + run-history + schedule + salud. Opcional. */
  domainFreshness?: (domainId: string) => Promise<DomainEntityFreshness[]>
  /** Driver del reconciliador: empuja la cadencia derivada de un proceso al schedule del motor. Opcional. */
  applyCadence?: (processId: string, by: string) => Promise<{ action: 'set' | 'noop'; desiredSeconds: number }>
  /** Nº de PIs servidos (para el tile del dashboard). Opcional. */
  piCount?: number
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
          send(res, 200, await cargasPage(deps, nav, domain, token, url.searchParams.get('msg') ?? undefined))
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
              msg = await handleCargasAccion(deps, slot, f, email)
            } catch (e) {
              msg = `Error: ${errMsg(e)}`
            }
          }
          redirect(res, `/admin/dominio/${domain.id}/cargas?msg=${encodeURIComponent(msg)}`)
          return true
        }
        // Log de UNA corrida (issue #99): fallida O exitosa — `Completed` no garantiza el dato.
        if (section === 'corrida' && deps.runLogs && req.method === 'GET') {
          send(res, 200, await corridaPage(deps, nav, domain, url.searchParams))
          return true
        }
        // Frescura del dominio (por entidad): vista + «aplicar cadencia» (reconciliador). Abierta a stewards.
        if (section === 'frescura' && deps.domainFreshness && req.method === 'GET') {
          send(res, 200, await domainFreshnessPage(deps, nav, domain, token, url.searchParams.get('msg') ?? undefined))
          return true
        }
        if (section === 'frescura' && deps.applyCadence && req.method === 'POST') {
          const f = await readForm(req)
          requireCsrf(f, token)
          let msg: string
          try {
            const plan = await deps.applyCadence(f['process'] ?? '', email)
            msg = plan.action === 'set' ? 'Cadencia aplicada al motor.' : 'El schedule ya estaba en la cadencia requerida.'
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
        send(res, 200, await sourcesPage(deps, nav))
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
  const uploads = files.filter((f) => f.field === 'file' && f.filename)
  if (uploads.length === 0) {
    redirect(res, `/admin/dominio/${domain.id}/frescura?msg=${encodeURIComponent('Error: no se adjuntó ningún archivo.')}`)
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
      redirect(res, `/admin/dominio/${domain.id}/frescura?msg=${encodeURIComponent('Error: ' + v.error)}`)
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
      redirect(res, `/admin/dominio/${domain.id}/frescura?msg=${encodeURIComponent('Error: ' + metaCheck.error)}`)
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
  redirect(res, `/admin/dominio/${domain.id}/frescura?msg=${encodeURIComponent(`${uploads.length} archivo(s) recibido(s).${aviso}${willTrigger ? ' La carga está corriendo — seguila en «Última corrida».' : ''}`)}`)
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
     }</ul>
     ${msg ? `<p class="msg err">${escapeHtml(msg)}</p>` : ''}
     ${settings}
     ${notasSettings}`,
  )
}

/** Fuentes (Gestión de PLATAFORMA): registro técnico — cada fuente, su oferta, su dominio y la topología
 * de procesos→entidades que alimenta. La frescura (brecha vs demanda, corridas, schedule) vive por dominio. */
async function sourcesPage(deps: AdminDeps, nav: Chrome): Promise<string> {
  const { sources, processes, outputs } = await deps.sourceRegistry!()
  const outsOf = (pid: string): string[] => outputs.filter((o) => o.processId === pid).map((o) => o.tableRef)
  const procsOf = (sid: string): ProcessRow[] => processes.filter((p) => p.sourceId === sid)
  const procCell = (p: ProcessRow): string => {
    const k = p.engine ? engineKind(p.engine.jobType) : null
    const motor = !k ? ' <span class="sub">· sin motor (no observable)</span>' : ` <span class="sub">· ${escapeHtml(k.label)}</span>${k.isNotebook ? ' <b style="color:var(--err)">⚠ migrar a Spark Job</b>' : ''}`
    return `<div><span class="c">${escapeHtml(p.id)}</span> ${escapeHtml(p.label)}${motor}<div class="sub">${outsOf(p.id).map(escapeHtml).join(', ') || '—'}</div></div>`
  }
  const rows = sources
    .map((s) => {
      const ps = procsOf(s.id)
      const cell = ps.length ? ps.map(procCell).join('') : '<span class="sub">—</span>'
      return `<tr><td><span class="c">${escapeHtml(s.id)}</span> ${escapeHtml(s.label)}</td><td>${escapeHtml(s.oferta)}</td><td>${s.domain ? escapeHtml(s.domain) : '<span class="sub">—</span>'}</td><td>${cell}</td><td class="sub">${escapeHtml(s.connectedBy ?? '—')}</td></tr>`
    })
    .join('')
  return adminPage(deps, nav,
    'Fuentes',
    `<p class="sub">Registro técnico de fuentes: cada fuente, su <b>oferta</b> (cada cuánto se actualiza), su dominio y los procesos de ingestión que alimenta. La <b>frescura</b> (brecha vs. demanda, corridas, schedule) se gestiona en cada dominio.</p>
     <table><thead><tr><th>Fuente</th><th>Oferta</th><th>Dominio</th><th>Procesos → entidades</th><th>Conectada por</th></tr></thead>
     <tbody>${rows || '<tr><td colspan="5" class="sub">Sin fuentes registradas.</td></tr>'}</tbody></table>`,
  )
}

/** Tipo de motor que corre el proceso, legible, + si es un Notebook (debe migrar a Spark Job). */
function engineKind(jobType?: string): { label: string; isNotebook: boolean } {
  const jt = (jobType ?? '').toLowerCase()
  if (jt.includes('notebook')) return { label: 'Notebook', isNotebook: true }
  if (jt === 'sparkjob') return { label: 'Spark Job', isNotebook: false }
  if (jt === 'pipeline') return { label: 'Pipeline', isNotebook: false }
  return { label: jobType || 'motor', isNotebook: false }
}

/** Celda de salud de una entidad: tipo de motor (Notebook/Spark Job) + última corrida + bandera de salud.
 * Si el proceso corre como Notebook, explicita la alerta de migración a Spark Job. */
function freshnessHealthCell(r: DomainEntityFreshness, runHref?: (r: DomainEntityFreshness) => string | null): string {
  if (!r.engine) return '<span class="sub">sin motor</span>'
  const k = engineKind(r.engineJobType)
  const kind = `<span class="sub">[${escapeHtml(k.label)}]</span>${k.isNotebook ? ' <b style="color:var(--err)">⚠ migrar a Spark Job</b>' : ''}`
  if (r.runs === 'error') return `${kind}<br><span class="sub">motor no respondió</span>`
  const runs = r.runs ?? []
  if (!runs.length) return `${kind}<br><span class="sub">sin corridas</span>`
  const flag = r.health?.failed ? ' · ✕ fallida' : r.health?.missed ? ' · ⚠️ atrasada' : ' · ✓'
  // #99 · el log de esta corrida, también cuando terminó bien: `Completed` no garantiza el dato.
  const href = runHref?.(r) ?? null
  const verLog = href ? ` · <a class="sub" href="${escapeHtml(href)}">Ver log</a>` : ''
  return `${kind}<br>${statusBadge(runs[0].status)} ${fmtWhen(runs[0].startedAt)}<span class="sub">${flag}</span>${verLog}${runErrorLine(runs[0])}`
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
      const opts = (f.options ?? []).map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')
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

/** Formulario compacto de carga manual de un slot (mismo write-path que el intake). */
function uploadForm(domainId: string, slot: IntakeSlot, token: string): string {
  return `<form method="post" action="/admin/dominio/${escapeHtml(domainId)}/intake/${escapeHtml(slot.id)}" enctype="multipart/form-data" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;max-width:320px">
       <input type="hidden" name="_csrf" value="${token}">
       <input type="file" name="file" multiple required>
       ${metaFieldsHtml(slot)}
       <button class="add">Subir</button>
       ${slot.accept ? `<div class="sub" style="flex-basis:100%">patrón: <code>${escapeHtml(slot.accept)}</code> · máx. ${Math.round(slotMaxBytes(slot) / (1024 * 1024))} MB c/u</div>` : ''}
     </form><script>${PRECHECK_JS}</script>`
}

/** Consola de CARGAS de un dominio (issue #58): arma los datos por slot (paralelo, tolerante a
 * fallos) y delega el render puro a admin-cargas. Gate de steward: lo aplica el ruteo del dominio. */
async function cargasPage(deps: AdminDeps, nav: Chrome, domain: DomainDecl, token: string, msg?: string): Promise<string> {
  const ops = deps.cargas!
  const slots = (deps.intakeSlots ?? []).filter((s) => (s.domain ?? '') === domain.id)
  // #56 · procesos registrados (para la coherencia trigger↔proceso). Tolerante: sin registro, no acusa.
  const engineIds = new Set<string>(
    deps.sourceRegistry ? (await deps.sourceRegistry().catch(() => ({ processes: [] as ProcessRow[] }))).processes.map((p) => p.engine?.itemId ?? '').filter(Boolean) : [],
  )
  const data: SlotCargas[] = await Promise.all(slots.map(async (slot) => ({
    slot,
    runs: await ops.runs(slot, 20).catch(() => 'error' as const),
    history: await ops.history(slot, 30).catch(() => 'error' as const),
    log: await ops.log(slot).catch(() => null),
    landing: await ops.landing(slot).catch(() => 'error' as const),
    archived: await ops.archived(slot).catch(() => 'error' as const),
    procesoRegistrado: !slot.trigger || engineIds.size === 0 || engineIds.has(slot.trigger.processRef),
  })))
  const feedback = msg ? `<p class="msg ${msg.startsWith('Error') ? 'err' : 'ok'}">${escapeHtml(msg)}</p>` : ''
  // #99 · «Ver log» por corrida, solo si la instancia cableó el acceso a los logs (sin él: cero cambio).
  const runLogHrefOf = deps.runLogs
    ? (s: IntakeSlot, r: RunRecord): string => `/admin/dominio/${domain.id}/corrida?slot=${encodeURIComponent(s.id)}&started=${encodeURIComponent(r.startedAt)}`
    : undefined
  return adminPage(deps, nav, `${domain.label} · Cargas`, feedback + cargasBody(domain.id, domain.label, data, token, (s) => uploadForm(domain.id, s, token), runLogHrefOf))
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

/** Despacha una acción POST de la consola de cargas. Devuelve el mensaje PRG. Todo auditado. */
async function handleCargasAccion(deps: AdminDeps, slot: IntakeSlot, f: Record<string, string>, by: string): Promise<string> {
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
  if (accion === 'revert') {
    // «Revertir esta carga» (issue #63): compensación derivada del layout `_processed/<clave>/` —
    // el directorio ES el ledger carga→clave. El archivo revertido va a _retirado/ (tag revertido);
    // si la clave tiene versión previa archivada, se reactiva y se re-corre (last-wins restaura).
    const ruta = f['archivo'] ?? ''
    if (!ruta || ruta.includes('..') || !/\/_processed\//.test('/' + ruta)) throw new ValidationError('Solo se revierten cargas del histórico _processed/.')
    if (!ops.revert) throw new ValidationError('La reversión no está disponible en esta instancia.')
    const r = await ops.revert(slot, ruta, by)
    deps.audit({ type: 'intake-revert', slot: slot.id, domain: slot.domain ?? '', filename: ruta, by, clave: r.clave, compensada: r.compensada, reactivado: r.reactivado ?? '' })
    if (r.compensada) {
      return `Carga revertida: «${ruta.split('/').pop()}» → _retirado/. Se reactivó la versión previa de la clave «${r.clave}» (${r.reactivado}) y la conversión está corriendo — el dato vuelve al estado anterior.`
    }
    return `Carga revertida: «${ruta.split('/').pop()}» → _retirado/. ⚠ La clave «${r.clave || '—'}» no tiene versión previa archivada: el dato materializado queda sin origen y su retiro del warehouse requiere compensación del pipeline (correr la conversión NO lo elimina).`
  }
  throw new ValidationError(`Acción desconocida: ${accion}`)
}

/** Faceta FRESCURA de un dominio (página propia): el contrato de frescura entity-anchored — brecha
 * demanda↔oferta · corridas · schedule + «aplicar cadencia» (refresco AUTOMÁTICO) · **carga de archivo**
 * (refresco MANUAL, plegado acá). Las dos caras de mantener la entidad fresca, en un solo lugar. */
async function domainFreshnessPage(deps: AdminDeps, nav: Chrome, domain: DomainDecl, token: string, msg?: string): Promise<string> {
  const title = `${domain.label} · Frescura`
  const back = `<p class="sub"><a href="/admin/dominio/${escapeHtml(domain.id)}">← ${escapeHtml(domain.label)}</a></p>`
  const rows = await deps.domainFreshness!(domain.id)
  const feedback = msg ? `<p class="msg ${msg.startsWith('Error') ? 'err' : 'ok'}">${escapeHtml(msg)}</p>` : ''
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
    if (!deps.runLogs || !r.processId || r.runs === 'error') return null
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
      const sched = !r.engine
        ? '<span class="sub">sin motor</span>'
        : r.actualScheduleSeconds != null
          ? escapeHtml(secondsToDuration(r.actualScheduleSeconds))
          : '<span class="sub">sin schedule</span>'
      const drift = r.engine && r.requiredCadenceSeconds != null && r.actualScheduleSeconds !== r.requiredCadenceSeconds
      const aplicar = drift && deps.applyCadence && r.processId
        ? `<form method="post" action="/admin/dominio/${escapeHtml(domain.id)}/frescura" style="display:inline"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="process" value="${escapeHtml(r.processId)}"><button class="add">Aplicar</button></form>`
        : ''
      const slot = slotFor(r)
      if (slot) matched.add(slot.id)
      const alimentar = slot ? uploadForm(domain.id, slot, token) + logDetails(slot.id) : '<span class="sub">automática</span>'
      const pis = r.dependentPis.map((p) => escapeHtml(p)).join(', ')
      return `<tr${warn ? ' style="color:var(--err)"' : ''}>
        <td><span class="c">${escapeHtml(r.entity)}</span>${r.processLabel ? `<div class="sub">${escapeHtml(r.processLabel)}</div>` : ''}${pis ? `<div class="sub">PIs: ${pis}</div>` : ''}</td>
        <td>${demanda}</td><td>${oferta}</td><td>${req}</td>
        <td>${sched}${aplicar ? `<div>${aplicar}</div>` : ''}</td>
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
  if (e instanceof MasterDataConflict || e instanceof AdminLockout) return 409
  return 500
}
