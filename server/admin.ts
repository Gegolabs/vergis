/**
 * Ambiente de ADMINISTRACIÓN de Vergis — superficie de ESCRITURA gobernada (primera del sistema).
 *
 * Dos secciones:
 *  · Gestión de Data Maestra — CRUD de las filas de cada entidad declarada (catálogos sin fuente
 *    externa: Empresas Relacionadas, etc.). La fuente única que los PIs consumen por JOIN.
 *  · Usuarios y Roles — quién es admin (rol de aplicación), sembrado de config y gestionado in-app.
 *
 * GOBIERNO: toda ruta exige rol admin (autz de ACCIÓN, distinta de la RLS de filas). Las escrituras
 * van por formularios POST protegidos con token CSRF firmado por-identidad. Cada mutación se asienta
 * en el log append-only de auditoría (quién · qué · cuándo) — la operación de roles, también.
 *
 * Es independiente del motor de datos: funciona aunque el gate de gobernanza del serving aún no esté
 * listo (la Administración no sirve dato gobernado, lo edita).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  coerceRow,
  escapeHtml,
  pkColumn,
  AdminLockout,
  MasterDataConflict,
  GovernanceConflict,
  type AdminStore,
  type GroupStore,
  type IngestionMapRow,
  type MasterDataEntity,
  type MasterDataRow,
  type MasterDataStore,
} from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'
import { page, send, redirect, readForm, requireCsrf, csrfFactory, CsrfError } from './ui'

const adminPage = (deps: AdminDeps, title: string, body: string): string =>
  page(`${deps.brandTitle ?? 'Vergis'} · Administración`, title, body)

export interface AdminDeps {
  entities: MasterDataEntity[]
  mdStore: MasterDataStore
  adminStore: AdminStore
  /** Grupos gestionados por Mira (sección «Grupos»). Opcional. */
  groupStore?: GroupStore
  /** Publish-on-write: tras editar una entidad maestra, publica sus proyecciones `__replica`. Opcional. */
  onWrite?: (entity: MasterDataEntity) => Promise<void>
  /** Mapa de ingestión derivado (frente B): cadencia requerida por proceso. Opcional. */
  ingestionMap?: () => Promise<IngestionMapRow[]>
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

  const entityById = (id: string): MasterDataEntity | undefined => deps.entities.find((e) => e.id === id)

  async function tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/admin'
    if (path !== '/admin' && !path.startsWith('/admin/')) return false

    const email = (deps.identityOf(req.headers).user ?? '').toLowerCase()
    if (!(await deps.adminStore.isAdmin(email))) {
      deps.audit({ type: 'admin-access-denied', user: email || '(anónimo)', path })
      send(res, 403, adminPage(deps, 'Acceso restringido', `<p class="msg err">No tienes rol de administrador. Identidad: <code>${escapeHtml(email || '(anónima)')}</code></p><p><a href="/">← Volver</a></p>`))
      return true
    }
    const token = csrf(email)
    const url = new URL(req.url ?? '/', 'http://localhost')

    try {
      // ── GET landing ──────────────────────────────────────────────────────
      if (path === '/admin' && req.method === 'GET') {
        send(res, 200, landing(deps))
        return true
      }
      // ── Usuarios y Roles ─────────────────────────────────────────────────
      if (path === '/admin/roles' && req.method === 'GET') {
        send(res, 200, await rolesPage(deps, token))
        return true
      }
      if (path === '/admin/roles/add' && req.method === 'POST') {
        const f = await readForm(req)
        requireCsrf(f, token)
        try {
          const added = await deps.adminStore.add(f['email'] ?? '', email)
          if (added) deps.audit({ type: 'admin-roles-write', op: 'add', target: (f['email'] ?? '').toLowerCase(), by: email })
          redirect(res, '/admin/roles')
        } catch (e) {
          send(res, 400, await rolesPage(deps, token, errMsg(e)))
        }
        return true
      }
      if (path === '/admin/roles/remove' && req.method === 'POST') {
        const f = await readForm(req)
        requireCsrf(f, token)
        try {
          await deps.adminStore.remove(f['email'] ?? '')
          deps.audit({ type: 'admin-roles-write', op: 'remove', target: (f['email'] ?? '').toLowerCase(), by: email })
          redirect(res, '/admin/roles')
        } catch (e) {
          send(res, e instanceof AdminLockout ? 409 : 400, await rolesPage(deps, token, errMsg(e)))
        }
        return true
      }
      // ── Grupos de Mira ───────────────────────────────────────────────────
      if (deps.groupStore && (path === '/admin/groups' || path.startsWith('/admin/groups/'))) {
        if (await handleGroups(deps, deps.groupStore, path, req, res, token, email)) return true
      }
      // ── Mapa de fuentes e ingestión (frente B) ───────────────────────────
      if (deps.ingestionMap && path === '/admin/sources' && req.method === 'GET') {
        send(res, 200, await sourcesPage(deps))
        return true
      }
      // ── Data maestra: /admin/e/<id>[/insert|update|delete] ───────────────
      const m = path.match(/^\/admin\/e\/([a-z][a-z0-9_]*)(?:\/(insert|update|delete))?$/)
      if (m) {
        const entity = entityById(m[1])
        if (!entity) {
          send(res, 404, adminPage(deps, 'No encontrado', `<p class="msg err">Entidad desconocida: <code>${escapeHtml(m[1])}</code></p>`))
          return true
        }
        const op = m[2]
        if (!op && req.method === 'GET') {
          const editPk = url.searchParams.get('edit') ?? undefined
          send(res, 200, await entityPage(deps, entity, token, editPk))
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
      send(res, 404, adminPage(deps, 'No encontrado', `<p class="msg err">Ruta no encontrada.</p><p><a href="/admin">← Administración</a></p>`))
      return true
    } catch (e) {
      send(res, statusForError(e), adminPage(deps, 'Error', `<p class="msg err">${escapeHtml(errMsg(e))}</p><p><a href="/admin">← Administración</a></p>`))
      return true
    }
  }

  return { tryHandle }
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
function landing(deps: AdminDeps): string {
  const items = deps.entities
    .map((e) => `<li><a href="/admin/e/${e.id}"><span class="c">${escapeHtml(e.id)}</span> ${escapeHtml(e.label)}</a>${e.description ? `<div class="sub">${escapeHtml(e.description)}</div>` : ''}</li>`)
    .join('')
  return adminPage(deps,
    'Administración',
    `<h2>Gestión de Data Maestra</h2><ul class="cards">${items || '<li class="sub">No hay entidades declaradas.</li>'}</ul>
     <h2>Acceso</h2><ul class="cards"><li><a href="/admin/roles"><span class="c">roles</span> Usuarios y Roles</a><div class="sub">Quién puede administrar.</div></li>${
       deps.groupStore ? `<li><a href="/admin/groups"><span class="c">grupos</span> Grupos de Mira</a><div class="sub">Grupos para compartir PIs (no grupos AAD).</div></li>` : ''
     }${
       deps.ingestionMap ? `<li><a href="/admin/sources"><span class="c">fuentes</span> Mapa de Fuentes e Ingestión</a><div class="sub">Oferta de cada fuente y cadencia requerida derivada de las demandas.</div></li>` : ''
     }</ul>`,
  )
}

async function sourcesPage(deps: AdminDeps): Promise<string> {
  const map = await deps.ingestionMap!()
  const rows = map
    .map(
      (r) => `<tr${r.unsatisfiable ? ' style="color:var(--err)"' : ''}><td><span class="c">${escapeHtml(r.processId)}</span> ${escapeHtml(r.label)}</td><td>${escapeHtml(r.oferta)}</td><td><b>${escapeHtml(r.requiredCadence)}</b>${r.unsatisfiable ? ' ⚠️' : ''}</td><td>${r.dependentPis.map((p) => escapeHtml(p)).join(', ') || '<span class="sub">—</span>'}</td></tr>`,
    )
    .join('')
  return adminPage(deps,
    'Mapa de Fuentes e Ingestión',
    `<p><a href="/admin">← Administración</a></p>
     <p class="sub">Cadencia requerida = el PI más exigente que depende del proceso marca el paso, con piso en la oferta. ⚠️ = alguna demanda exige más fresco que la oferta (insatisfacible).</p>
     <table><thead><tr><th>Proceso</th><th>Oferta (fuente)</th><th>Cadencia requerida</th><th>PIs que dependen</th></tr></thead>
     <tbody>${rows || '<tr><td colspan="4" class="sub">Sin procesos de ingestión registrados.</td></tr>'}</tbody></table>`,
  )
}

// ─── Grupos de Mira ──────────────────────────────────────────────────────────
async function handleGroups(
  deps: AdminDeps,
  groups: GroupStore,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  by: string,
): Promise<boolean> {
  if (path === '/admin/groups' && req.method === 'GET') {
    send(res, 200, await groupsPage(deps, groups, token))
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
      send(res, e instanceof GovernanceConflict ? 409 : 400, await groupsPage(deps, groups, token, errMsg(e)))
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
      send(res, 200, await groupMembersPage(deps, groups, gid, token))
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
        send(res, 400, await groupMembersPage(deps, groups, gid, token, errMsg(e)))
      }
      return true
    }
  }
  return false
}

async function groupsPage(deps: AdminDeps, groups: GroupStore, token: string, msg?: string): Promise<string> {
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
  return adminPage(deps,
    'Grupos de Mira',
    `<p><a href="/admin">← Administración</a></p>
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

async function groupMembersPage(deps: AdminDeps, groups: GroupStore, gid: string, token: string, msg?: string): Promise<string> {
  const list = await groups.listGroups()
  const g = list.find((x) => x.id === gid.toLowerCase())
  if (!g) return adminPage(deps, 'No encontrado', `<p class="msg err">Grupo desconocido: <code>${escapeHtml(gid)}</code></p><p><a href="/admin/groups">← Grupos</a></p>`)
  const members = await groups.listMembers(gid)
  const rows = members
    .map(
      (m) => `<tr><td>${escapeHtml(m.email)}</td><td class="r"><form method="post" action="/admin/groups/${escapeHtml(gid)}/remove"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="email" value="${escapeHtml(m.email)}"><button class="del">Quitar</button></form></td></tr>`,
    )
    .join('')
  return adminPage(deps,
    `Grupo · ${g.label}`,
    `<p><a href="/admin/groups">← Grupos</a> · <span class="c">${escapeHtml(g.id)}</span>${g.seed ? ' <span class="tag">semilla</span>' : ''}</p>
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

async function rolesPage(deps: AdminDeps, token: string, msg?: string): Promise<string> {
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
  return adminPage(deps,
    'Usuarios y Roles',
    `<p><a href="/admin">← Administración</a></p>
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

async function entityPage(deps: AdminDeps, entity: MasterDataEntity, token: string, editPk?: string): Promise<string> {
  const pk = pkColumn(entity)
  const rows = await deps.mdStore.list(entity)
  const editing = editPk != null ? rows.find((r) => String(r[pk.name]) === editPk) : undefined

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

  return adminPage(deps,
    entity.label,
    `<p><a href="/admin">← Administración</a></p>
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
