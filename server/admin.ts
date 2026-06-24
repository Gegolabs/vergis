/**
 * Ambiente de ADMINISTRACIÓN de Vergis — superficie de ESCRITURA gobernada (primera del sistema).
 *
 * Distingue DOS clases de gestión (ver `docs/gestion-de-dominio.md`):
 *  · GESTIÓN DE PLATAFORMA — transversal: Usuarios y Roles · Grupos de Mira · Settings. Solo admins.
 *    Una sola entrada (`/admin/plataforma`) que adentro despliega sus opciones.
 *  · GESTIÓN DE DOMINIO — por dominio: Ingesta de archivos · Data Maestra · Fuentes & Frescura.
 *    Un área por dominio (`/admin/dominio/<id>`), accesible a los STEWARDS del dominio (+ admin).
 *
 * El home (`/admin`) es un DASHBOARD de salud: lista los dominios que el usuario puede gestionar y —si
 * es admin— la entrada de Plataforma. El gate de `/admin` es «admin O steward de algún dominio».
 *
 * GOBIERNO: autz de ACCIÓN (distinta de la RLS de filas). Escrituras por POST con token CSRF firmado
 * por-identidad; cada mutación se asienta en el log append-only de auditoría (quién · qué · cuándo).
 * Independiente del motor de datos: la Administración no sirve dato gobernado, lo edita/ingesta.
 */
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
  type AdminStore,
  type DomainDecl,
  type GroupStore,
  type IntakeSlot,
  type IntakeTarget,
  type IntakeTrigger,
  type PlatformSettingStore,
  type IngestionMapRow,
  type MasterDataEntity,
  type MasterDataRow,
  type MasterDataStore,
  type RunRecord,
  type RunStatus,
} from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'
import { shellNav, THEME_TOGGLE_JS, send, redirect, readForm, requireCsrf, csrfFactory, CsrfError } from './ui'
import { readMultipart } from './multipart'

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
  put(target: IntakeTarget, filename: string, bytes: Buffer): Promise<void>
  runNow?(trigger: IntakeTrigger, target?: IntakeTarget): Promise<void>
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
  /** Grupos gestionados por Mira (sección «Grupos»). Opcional. */
  groupStore?: GroupStore
  /** Publish-on-write: tras editar una entidad maestra, publica sus proyecciones `__replica`. Opcional. */
  onWrite?: (entity: MasterDataEntity) => Promise<void>
  /** Mapa de ingestión derivado (frente B): cadencia requerida por proceso. Opcional. */
  ingestionMap?: () => Promise<IngestionMapRow[]>
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
      const bare: Chrome = { sidebar: buildSidebar(deps, [], 'gestion', 'home'), avatar: buildAvatar(deps, email, false, false) }
      send(res, 403, adminPage(deps, bare, 'Acceso restringido', `<p class="msg err">No gestionas ninguna plataforma ni dominio.</p><p>Sesión actual: <code>${escapeHtml(email || '(anónima)')}</code>. ¿No eres tú? <a href="/oauth2/sign_out?rd=%2Fadmin">Inicia sesión con otra cuenta</a>.</p><p><a href="/">← Volver al catálogo</a></p>`))
      return true
    }
    const token = csrf(email)
    const url = new URL(req.url ?? '/', 'http://localhost')
    // Scope (Gestión de dominios · Configuración de plataforma · Perfil) + item activo, según la ruta.
    let scope = 'gestion'
    let active = 'home'
    const dmActive = path.match(/^\/admin\/dominio\/([a-z][a-z0-9_-]*)/)
    if (path === '/admin/perfil') { scope = 'perfil'; active = '' }
    else if (path === '/admin/plataforma' || path.startsWith('/admin/settings')) { scope = 'config'; active = 'plat' }
    else if (path.startsWith('/admin/roles')) { scope = 'config'; active = 'roles' }
    else if (path.startsWith('/admin/groups')) { scope = 'config'; active = 'groups' }
    else if (path.startsWith('/admin/sources')) { scope = 'config'; active = 'sources' }
    else if (dmActive) active = `dom:${dmActive[1]}`
    else {
      const emActive = path.match(/^\/admin\/e\/([a-z][a-z0-9_]*)/)
      if (emActive) {
        const e = entityById(emActive[1])
        active = e?.domain ? `dom:${e.domain}` : 'home'
      }
    }
    const nav: Chrome = { sidebar: buildSidebar(deps, manageable, scope, active), avatar: buildAvatar(deps, email, isAdmin, manageable.length > 0) }
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

      // ── GESTIÓN DE DOMINIO · /admin/dominio/<id>[/intake/<slot>] ──────────
      const di = path.match(/^\/admin\/dominio\/([a-z][a-z0-9_-]*)(?:\/intake\/([a-z][a-z0-9_]*))?$/)
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
        const slotId = di[2]
        if (!slotId && req.method === 'GET') {
          const okN = url.searchParams.get('ok')
          const ran = url.searchParams.get('run') === '1'
          const n = okN ? Math.max(1, parseInt(okN, 10) || 1) : 0
          const feedback = okN
            ? { ok: `${n} ${n === 1 ? 'archivo recibido' : 'archivos recibidos'}.${ran ? ' La conversión está corriendo — seguila abajo en «Últimas cargas».' : ''}` }
            : undefined
          send(res, 200, await domainPage(deps, nav, domain, token, isAdmin, feedback))
          return true
        }
        if (slotId && req.method === 'POST') {
          await handleIntake(deps, nav, domain, slotId, req, res, token, email)
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
      // Mapa de fuentes e ingestión (vista global; gestión de plataforma por ahora)
      if (deps.ingestionMap && path === '/admin/sources' && req.method === 'GET') {
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
    send(res, 400, await domainPage(deps, nav, domain, token, true, { error: 'No se adjuntó ningún archivo.' }))
    return
  }
  // Validar TODOS antes de aterrizar ninguno: o entra el lote completo o ninguno (atomicidad — evita
  // dejar la semana a medio cargar). El SJD failure-safe espera el set consistente, no archivos sueltos.
  for (const u of uploads) {
    const v = validateUpload(slot, u.filename, u.bytes.length)
    if (!v.ok) {
      deps.audit({ type: 'intake', slot: slot.id, domain: domain.id, filename: u.filename, bytes: u.bytes.length, by, ok: false, error: v.error })
      send(res, 400, await domainPage(deps, nav, domain, token, true, { error: v.error }))
      return
    }
  }
  // UN SOLO disparo por LOTE (no uno por archivo: N triggers = N corridas = throttling de capacidad).
  const willTrigger = !!(slot.trigger && deps.intake.runNow)
  // Aterriza cada crudo en la landing zone OneLake (staging). El pipeline/SJD lee de ahí y transforma.
  for (const u of uploads) {
    await deps.intake.put(slot.target, u.filename, u.bytes)
    deps.audit({ type: 'intake', slot: slot.id, domain: domain.id, filename: u.filename, bytes: u.bytes.length, by, ok: true, triggered: willTrigger })
  }
  if (willTrigger) await deps.intake.runNow!(slot.trigger!, slot.target)
  redirect(res, `/admin/dominio/${domain.id}?ok=${uploads.length}${willTrigger ? '&run=1' : ''}`)
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

/** Menú lateral — navegación del SCOPE activo (Gestión de dominios · Configuración de plataforma). */
function buildSidebar(deps: AdminDeps, manageable: DomainDecl[], scope: string, active: string): string {
  const item = (href: string, label: string, on: boolean): string =>
    `<a href="${href}" class="${on ? 'on' : ''}">${escapeHtml(label)}</a>`
  let s = `<span class="bca">${escapeHtml(deps.brandTitle ?? 'Vergis')} · Admin</span>`
  s += `<a href="/" class="catlink">↩ Catálogo de PIs</a>`
  if (scope === 'config') {
    s += item('/admin/plataforma', 'Resumen', active === 'plat')
    s += `<div class="grp">Configuración</div>`
    s += item('/admin/roles', 'Usuarios y Roles', active === 'roles')
    if (deps.groupStore) s += item('/admin/groups', 'Grupos de Mira', active === 'groups')
    if (deps.ingestionMap) s += item('/admin/sources', 'Mapa de Fuentes', active === 'sources')
  } else {
    s += item('/admin', 'Inicio', active === 'home')
    if (manageable.length) {
      s += `<div class="grp">Dominios</div>`
      s += manageable.map((d) => item(`/admin/dominio/${d.id}`, d.label, active === `dom:${d.id}`)).join('')
    }
  }
  return s
}

/** Avatar (arriba-derecha, siempre) → menú de identidad: Perfil · Gestión · Configuración · salir. */
function buildAvatar(deps: AdminDeps, email: string, isAdmin: boolean, hasDomains: boolean): string {
  const local = (email.split('@')[0] || '?')
  const initials = (local.split(/[._-]/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('') || local[0] || '?').toUpperCase()
  const it = (href: string, label: string): string => `<a href="${href}">${escapeHtml(label)}</a>`
  let m = `<div class="avhead">${escapeHtml(email || '(anónima)')}${isAdmin ? ' · admin' : ''}</div>`
  m += it('/', 'Catálogo de PIs')
  m += `<div class="sep"></div>`
  m += it('/admin/perfil', 'Perfil')
  if (hasDomains) m += it('/admin', 'Gestión')
  if (isAdmin) m += it('/admin/plataforma', 'Configuración')
  m += `<div class="sep"></div>`
  m += `<button type="button" onclick="${THEME_TOGGLE_JS}">◐ Cambiar tema</button>`
  m += `<a href="/oauth2/sign_out?rd=%2Fadmin">Cerrar sesión</a>`
  return `<details class="avm"><summary class="av" title="${escapeHtml(email)}">${escapeHtml(initials)}</summary><div class="avmenu">${m}</div></details>`
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
    `<p class="sub">Sesión: <code>${escapeHtml(email || '(anónima)')}</code>${isAdmin ? ' · <span class="tag">admin</span>' : ''}</p>
     <h2>Salud de la plataforma</h2>
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
/** Duración de una corrida terminada (vacío si sigue corriendo o sin datos). */
function fmtDuration(r: RunRecord): string {
  if (!r.endedAt) return ''
  const a = Date.parse(r.startedAt)
  const b = Date.parse(r.endedAt)
  if (Number.isNaN(a) || Number.isNaN(b)) return ''
  const s = Math.max(0, Math.round((b - a) / 1000))
  return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`
}
function runLine(r: RunRecord): string {
  const dur = fmtDuration(r)
  return `<li><span class="c">${statusBadge(r.status)}</span> ${fmtWhen(r.startedAt)}${dur ? ` <span class="sub">· ${dur}</span>` : ''}${r.error ? `<div class="sub">${escapeHtml(r.error)}</div>` : ''}</li>`
}
/** Panel «Últimas cargas» de un slot con trigger (vacío si el slot no dispara conversión). */
function renderCargas(slot: IntakeSlot, st: RunRecord[] | 'error' | undefined): string {
  if (!slot.trigger || st === undefined) return ''
  if (st === 'error') return '<p class="sub">No se pudo consultar el estado de la conversión (reintentá refrescando).</p>'
  if (st.length === 0) return '<p class="sub">Sin cargas todavía.</p>'
  return `<div class="cargas"><b class="sub">Últimas cargas</b><ul class="cards">${st.map(runLine).join('')}</ul></div>`
}

/** Área de un DOMINIO: Ingesta · Data Maestra · Fuentes & Frescura · (próximamente) las demás facetas. */
async function domainPage(
  deps: AdminDeps,
  nav: Chrome,
  domain: DomainDecl,
  token: string,
  isAdmin: boolean,
  feedback?: { ok?: string; error?: string },
): Promise<string> {
  const slots = (deps.intakeSlots ?? []).filter((s) => (s.domain ?? '') === domain.id)
  const entities = deps.entities.filter((e) => (e.domain ?? '') === domain.id)

  // Estado de conversión (frente B · observabilidad): últimas corridas del SJD/pipeline por slot con
  // trigger. Tolerante a fallos: si Fabric no responde, la pantalla sigue sirviendo (avisa, no se cae).
  const statusBySlot = new Map<string, RunRecord[] | 'error'>()
  if (deps.intakeStatus) {
    await Promise.all(slots.filter((s) => s.trigger).map(async (s) => {
      try { statusBySlot.set(s.id, await deps.intakeStatus!(s)) } catch { statusBySlot.set(s.id, 'error') }
    }))
  }

  const guia = `<details class="guia"><summary>¿Cómo cargar? (orden recomendado)</summary>
       <ol class="sub">
         <li>Seleccioná los archivos de la <b>misma semana</b> — podés subir clientes y proveedores juntos (selección múltiple).</li>
         <li>Verificá que cada nombre siga el patrón indicado en el slot.</li>
         <li>Subí. La conversión corre sola; su estado aparece abajo en «Últimas cargas» (Procesando → Listo).</li>
       </ol>
       <p class="sub">No mezcles semanas en una misma carga: subí una semana, esperá «Listo» y recién la siguiente.</p>
     </details>`

  const ingesta = deps.intake && slots.length
    ? `<h2>Ingesta de archivos</h2>
       <p class="sub">Subí los archivos acá y Mira los ubica en su destino (staging). La conversión los procesa.</p>
       ${guia}
       ${slots.map((s) => `
         <form method="post" action="/admin/dominio/${escapeHtml(domain.id)}/intake/${escapeHtml(s.id)}" enctype="multipart/form-data" class="grid">
           <input type="hidden" name="_csrf" value="${token}">
           <div class="fld"><span>${escapeHtml(s.label)}${s.accept ? ` · patrón: <code>${escapeHtml(s.accept)}</code>` : ''}</span>
             <input type="file" name="file" multiple required></div>
           <div class="sub">${escapeHtml(s.description ?? '')}${s.description ? ' · ' : ''}Podés subir varios · Máx. ${Math.round(slotMaxBytes(s) / (1024 * 1024))} MB c/u${s.trigger ? ' · dispara la conversión al subir' : ' · el pipeline lo toma en su próxima corrida'}</div>
           <div class="actions"><button class="add">Subir</button></div>
         </form>
         ${renderCargas(s, statusBySlot.get(s.id))}`).join('')}`
    : ''

  const maestra = entities.length
    ? `<h2>Data Maestra</h2><ul class="cards">${entities.map((e) => `<li><a href="/admin/e/${escapeHtml(e.id)}">${escapeHtml(e.label)}</a>${e.description ? `<div class="sub">${escapeHtml(e.description)}</div>` : ''}</li>`).join('')}</ul>`
    : ''

  const fuentes = deps.ingestionMap && isAdmin
    ? `<h2>Fuentes & Frescura</h2><ul class="cards"><li><a href="/admin/sources"><span class="c">fuentes</span> Mapa de Fuentes e Ingestión</a><div class="sub">Oferta de cada fuente y cadencia requerida derivada de las demandas.</div></li></ul>`
    : ''

  // Facetas previstas del dominio (roadmap visible, deshabilitadas) — ver work/041 §4.
  const proximamente = `<h2>Próximamente</h2><ul class="cards">${[
    ['catálogo', 'Catálogo / diccionario del dominio'],
    ['linaje', 'Linaje fuente→tabla→proceso→PI'],
    ['calidad', 'Calidad de datos (validaciones)'],
    ['rls', 'Política de autorización / RLS del dominio'],
    ['identidad', 'Mapa de identidad del dominio'],
    ['pis', 'Catálogo de PIs del dominio'],
  ].map(([c, l]) => `<li class="ro"><span class="c">${c}</span> ${escapeHtml(l)}</li>`).join('')}</ul>`

  return adminPage(deps, nav,
    domain.label,
    `${feedback?.ok ? `<p class="msg ok">${escapeHtml(feedback.ok)}</p>` : ''}
     ${feedback?.error ? `<p class="msg err">${escapeHtml(feedback.error)}</p>` : ''}
     ${domain.description ? `<p class="sub">${escapeHtml(domain.description)}</p>` : ''}
     ${ingesta}
     ${maestra}
     ${fuentes}
     ${proximamente}`,
  )
}

/** Gestión de PLATAFORMA: Usuarios y Roles · Grupos · Settings (una entrada que despliega todo). */
async function platformPage(deps: AdminDeps, nav: Chrome, token: string): Promise<string> {
  const curTitle = deps.settingStore ? (await deps.settingStore.getSetting('index_title')) ?? '' : ''
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
     ${settings}`,
  )
}

async function sourcesPage(deps: AdminDeps, nav: Chrome): Promise<string> {
  const map = await deps.ingestionMap!()
  const rows = map
    .map(
      (r) => `<tr${r.unsatisfiable ? ' style="color:var(--err)"' : ''}><td><span class="c">${escapeHtml(r.processId)}</span> ${escapeHtml(r.label)}</td><td>${escapeHtml(r.oferta)}</td><td><b>${escapeHtml(r.requiredCadence)}</b>${r.unsatisfiable ? ' ⚠️' : ''}</td><td>${r.dependentPis.map((p) => escapeHtml(p)).join(', ') || '<span class="sub">—</span>'}</td></tr>`,
    )
    .join('')
  return adminPage(deps, nav,
    'Mapa de Fuentes e Ingestión',
    `<p class="sub">Cadencia requerida = el PI más exigente que depende del proceso marca el paso, con piso en la oferta. ⚠️ = alguna demanda exige más fresco que la oferta (insatisfacible).</p>
     <table><thead><tr><th>Proceso</th><th>Oferta (fuente)</th><th>Cadencia requerida</th><th>PIs que dependen</th></tr></thead>
     <tbody>${rows || '<tr><td colspan="4" class="sub">Sin procesos de ingestión registrados.</td></tr>'}</tbody></table>`,
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
