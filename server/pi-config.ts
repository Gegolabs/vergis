/**
 * Configuración por-PI — la superficie donde el DUEÑO/COLABORADOR de un PI gestiona su gobierno
 * (NO el admin de plataforma): visibilidad (público/privado), lista de compartido (grants a usuarios
 * y grupos de Mira) y la demanda de frescura. Gateada por el ROL del PI, no por rol admin:
 *  · ver la página y la lista de compartido  → canOpen (cualquiera con acceso)
 *  · editar la demanda                        → canCollaborate (colaborador+)
 *  · visibilidad / compartir / ownership      → canGovern (solo dueño)
 *
 * Es ortogonal a la RLS de datos (que sigue filtrando filas al renderizar el PI).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  escapeHtml,
  canOpen,
  canCollaborate,
  canGovern,
  GovernanceConflict,
  isDemandaWithinCeiling,
  demandaCeilingSeconds,
  secondsToDuration,
  type GovernanceStore,
  type PiRole,
  type PrincipalType,
} from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'
import { page, send, redirect, readForm, requireCsrf, csrfFactory, CsrfError } from './ui'

export interface PiConfigDeps {
  gov: GovernanceStore
  /** slug → { code, name, specName } del PI servible, o undefined si no existe/!servible.
   *  `name` es el EFECTIVO (con override); `specName` el que trae el YAML — la consola necesita los
   *  dos para poder decir que un nombre está sobrescrito y contra qué (#207). */
  resolve: (slug: string) => { code: string; name: string; specName?: string } | undefined
  identityOf: (headers: IncomingMessage['headers']) => { user?: string }
  /** Rol efectivo de gestión (incluye bootstrap + override admin); lo provee el server. */
  roleOf: (code: string, email: string | undefined) => Promise<PiRole | null>
  /** Ofertas de las fuentes de los insumos del PI (para el techo de la demanda). Opcional. */
  ceilingFor?: (code: string) => Promise<string[]>
  audit: (event: LogEventInput) => void
  /** #207 · Aviso de que un nombre visible cambió: el serving refresca su mapa de overrides SIN
   *  reiniciar. Sin esto, renombrar seguiría exigiendo un despliegue — que es el issue entero. */
  onDisplayNameChange?: () => void
  secret: string
  brandTitle?: string
}

export interface PiConfigHandler {
  tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}

const ROLE_LABEL: Record<PiRole, string> = { owner: 'Dueño', collaborator: 'Colaborador', viewer: 'Visor' }

export function createPiConfig(deps: PiConfigDeps): PiConfigHandler {
  const csrf = csrfFactory(deps.secret)
  const pg = (title: string, body: string) => page(`${deps.brandTitle ?? 'Vergis'} · Configuración`, title, body)

  async function tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '')
    const m = path.match(/^\/([^/]+)\/config(?:\/(visibility|grant|grant\/remove|demanda|nombre))?$/)
    if (!m) return false
    const target = deps.resolve(m[1].toLowerCase())
    if (!target) {
      send(res, 404, pg('No encontrado', `<p class="msg err">Producto de Información no encontrado.</p>`))
      return true
    }
    const email = (deps.identityOf(req.headers).user ?? '').toLowerCase()
    const role = await deps.roleOf(target.code, email)
    if (!canOpen(role)) {
      send(res, 403, pg('Acceso restringido', `<p class="msg err">No tienes acceso a la configuración de <code>${escapeHtml(target.code)}</code>.</p><p>Sesión actual: <code>${escapeHtml(email || '(anónima)')}</code>. ¿No eres tú? <a href="/oauth2/sign_out?rd=%2F">Inicia sesión con otra cuenta</a>.</p><p><a href="/">← Volver al catálogo</a></p>`))
      return true
    }
    const token = csrf(email)
    const op = m[2]

    try {
      if (!op && req.method === 'GET') {
        send(res, 200, await configPage(deps, target, role, token))
        return true
      }
      if (op && req.method === 'POST') {
        const f = await readForm(req)
        requireCsrf(f, token)
        await handleWrite(deps, target.code, role, op, f, email)
        redirect(res, `/${m[1].toLowerCase()}/config`)
        return true
      }
      send(res, 404, pg('No encontrado', `<p class="msg err">Ruta no encontrada.</p>`))
      return true
    } catch (e) {
      const code = e instanceof CsrfError ? 403 : e instanceof Forbidden ? 403 : e instanceof GovernanceConflict ? 409 : e instanceof ValidationError ? 400 : 500
      send(res, code, await configPage(deps, target, role, token, errMsg(e)).catch(() => pg('Error', `<p class="msg err">${escapeHtml(errMsg(e))}</p>`)))
      return true
    }
  }

  return { tryHandle }
}

class Forbidden extends Error {}
class ValidationError extends Error {}

/** Reenvía errores de validación del store (correo/duración inválidos) como ValidationError → 400. */
async function asValidation<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (e) {
    if (e instanceof GovernanceConflict) throw e // conflicto → 409
    throw new ValidationError(e instanceof Error ? e.message : String(e))
  }
}

async function handleWrite(
  deps: PiConfigDeps,
  code: string,
  role: PiRole | null,
  op: string,
  f: Record<string, string>,
  by: string,
): Promise<void> {
  // #207 · Renombrar es el mismo tipo de acto que fijar la demanda —ajusta cómo se presenta el PI,
  // no quién lo ve—, así que va con el mismo gate: colaborador o dueño. Cambiar visibilidad o
  // compartir sigue siendo exclusivo del dueño.
  if (op === 'nombre') {
    if (!canCollaborate(role)) throw new Forbidden('Solo colaboradores/dueños editan el nombre visible.')
    const restaurar = (f['restaurar'] ?? '') !== ''
    const nuevo = restaurar ? null : (f['display_name'] ?? '')
    await asValidation(deps.gov.setDisplayName(code, nuevo, by))
    deps.onDisplayNameChange?.()
    deps.audit({ type: 'pi-governance-write', op: 'nombre', pi: code, value: nuevo ?? '(restaurado del spec)', by })
    return
  }
  if (op === 'demanda') {
    if (!canCollaborate(role)) throw new Forbidden('Solo colaboradores/dueños editan la demanda.')
    const maxAge = f['max_age'] ?? ''
    await asValidation(
      (async () => {
        if (deps.ceilingFor) {
          const ofertas = await deps.ceilingFor(code)
          if (ofertas.length && !isDemandaWithinCeiling(maxAge, ofertas)) {
            throw new Error(
              `La demanda ${maxAge.toUpperCase()} es más fresca que la fuente más lenta de sus insumos. Máximo exigible: ${secondsToDuration(demandaCeilingSeconds(ofertas))}.`,
            )
          }
        }
        await deps.gov.setDemanda(code, maxAge, by)
      })(),
    )
    deps.audit({ type: 'pi-governance-write', op: 'demanda', pi: code, value: maxAge.toUpperCase(), by })
    return
  }
  // visibility / grant / grant-remove → solo dueño
  if (!canGovern(role)) throw new Forbidden('Solo el dueño puede cambiar visibilidad o compartir.')
  if (op === 'visibility') {
    const v = f['visibility'] === 'publico' ? 'publico' : 'privado'
    await deps.gov.setVisibility(code, v)
    deps.audit({ type: 'pi-governance-write', op: 'visibility', pi: code, value: v, by })
    return
  }
  if (op === 'grant') {
    const ptype = (f['principal_type'] === 'group' ? 'group' : 'user') as PrincipalType
    const principal = f['principal'] ?? ''
    const grole = f['role'] as PiRole
    if (!principal.trim()) throw new ValidationError('Indica un correo o grupo.')
    await asValidation(deps.gov.setGrant(code, ptype, principal, grole, by))
    deps.audit({ type: 'pi-governance-write', op: 'grant-set', pi: code, principal: principal.trim().toLowerCase(), ptype, role: grole, by })
    return
  }
  if (op === 'grant/remove') {
    const ptype = (f['principal_type'] === 'group' ? 'group' : 'user') as PrincipalType
    await deps.gov.removeGrant(code, ptype, f['principal'] ?? '')
    deps.audit({ type: 'pi-governance-write', op: 'grant-remove', pi: code, principal: (f['principal'] ?? '').trim().toLowerCase(), ptype, by })
    return
  }
}

async function configPage(
  deps: PiConfigDeps,
  target: { code: string; name: string; specName?: string },
  role: PiRole | null,
  token: string,
  msg?: string,
): Promise<string> {
  const gov = await deps.gov.getPiGovernance(target.code)
  const grants = await deps.gov.listGrants(target.code)
  const demanda = await deps.gov.getDemanda(target.code)
  const nombre = await deps.gov.getDisplayName(target.code)
  const groups = await deps.gov.listGroups()
  const owner = canGovern(role)
  const collab = canCollaborate(role)
  const vis = gov?.visibility ?? 'privado'

  const grantRows = grants
    .map((g) => {
      const removable = owner && !(g.role === 'owner' && grants.filter((x) => x.role === 'owner').length <= 1)
      return `<tr><td>${g.principalType === 'group' ? '👥' : '👤'} ${escapeHtml(g.principal)}</td><td>${escapeHtml(ROLE_LABEL[g.role])}</td><td class="r">${
        removable
          ? `<form method="post" action="/${target.code.toLowerCase()}/config/grant/remove" onsubmit="return confirm('¿Quitar a ${escapeHtml(g.principal)}?')"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="principal_type" value="${g.principalType}"><input type="hidden" name="principal" value="${escapeHtml(g.principal)}"><button class="del">Quitar</button></form>`
          : '<span class="sub">—</span>'
      }</td></tr>`
    })
    .join('')

  const groupOptions = groups.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.label)}</option>`).join('')

  const shareForm = owner
    ? `<h2>Agregar al compartido</h2>
       <form method="post" action="/${target.code.toLowerCase()}/config/grant" class="row">
         <input type="hidden" name="_csrf" value="${token}">
         <select name="principal_type" onchange="this.form.querySelector('[name=principal]').placeholder=this.value==='group'?'id de grupo':'correo@dominio'">
           <option value="user">Usuario</option><option value="group">Grupo</option>
         </select>
         <input name="principal" placeholder="correo@dominio" list="grouplist">
         <datalist id="grouplist">${groupOptions}</datalist>
         <select name="role"><option value="collaborator">Colaborador</option><option value="viewer">Visor</option><option value="owner">Dueño</option></select>
         <button class="add">Compartir</button>
       </form>
       <p class="sub">Colaborador = mismos privilegios de gestión que tú (comparte config full; los datos siguen por RLS). Visor = solo lectura.</p>`
    : ''

  const visForm = `<h2>Visibilidad</h2>
    <form method="post" action="/${target.code.toLowerCase()}/config/visibility" class="row${owner ? '' : ' ro'}">
      <input type="hidden" name="_csrf" value="${token}">
      <label><input type="radio" name="visibility" value="privado" ${vis === 'privado' ? 'checked' : ''} ${owner ? '' : 'disabled'}> Privado</label>
      <label><input type="radio" name="visibility" value="publico" ${vis === 'publico' ? 'checked' : ''} ${owner ? '' : 'disabled'}> Público</label>
      ${owner ? '<button class="add">Guardar</button>' : '<span class="sub">solo el dueño</span>'}
    </form>
    <p class="sub">Público = cualquiera autenticado lo abre; <b>los datos siguen filtrados por RLS</b> (no es bypass).</p>`

  // #207 · El override es EXPLÍCITO y visible: se dice que está sobrescrito, contra qué nombre del
  // spec, y quién lo hizo. Un override mudo convierte el YAML en una fuente que miente para el que
  // lo lee. La RUTA no aparece acá porque no se mueve: el slug sale de `identity.code`, no del
  // nombre, así que los enlaces ya repartidos en Jira y correos siguen sirviendo.
  const specName = target.specName ?? ''
  const sobrescrito = !!nombre
  const nomForm = `<h2>Nombre visible</h2>
    <form method="post" action="/${target.code.toLowerCase()}/config/nombre" class="row${collab ? '' : ' ro'}">
      <input type="hidden" name="_csrf" value="${token}">
      <input name="display_name" value="${escapeHtml(nombre?.displayName ?? specName)}" maxlength="120" placeholder="Nombre con que se ve el PI" ${collab ? '' : 'readonly'}>
      ${collab ? '<button class="add">Guardar</button>' : '<span class="sub">solo colaboradores</span>'}
    </form>
    ${
      sobrescrito
        ? `<p class="sub"><b>Este nombre está sobrescrito.</b> El del spec es «${escapeHtml(specName)}»${
            nombre?.updatedBy ? ` · lo cambió ${escapeHtml(nombre.updatedBy)}` : ''
          }${nombre?.updatedAt ? ` el ${escapeHtml(String(nombre.updatedAt).slice(0, 10))}` : ''}.${
            collab
              ? ` <form method="post" action="/${target.code.toLowerCase()}/config/nombre" class="inline"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="restaurar" value="1"><button class="del">Restaurar el del spec</button></form>`
              : ''
          }</p>`
        : `<p class="sub">Sale del spec (<code>identity.display_name</code>). Editarlo acá lo sobrescribe sin desplegar; <b>la URL no cambia</b> — el enlace sale de <code>identity.code</code>.</p>`
    }`

  const demForm = `<h2>Demanda de frescura</h2>
    <form method="post" action="/${target.code.toLowerCase()}/config/demanda" class="row${collab ? '' : ' ro'}">
      <input type="hidden" name="_csrf" value="${token}">
      <input name="max_age" value="${escapeHtml(demanda?.maxAge ?? '')}" placeholder="PT1H · P1D · P1W" ${collab ? '' : 'readonly'}>
      ${collab ? '<button class="add">Guardar</button>' : '<span class="sub">solo colaboradores</span>'}
    </form>
    <p class="sub">Cada cuánto el negocio necesita el dato fresco (duración ISO-8601). Techo: ≤ la oferta más fina de sus fuentes.</p>`

  return pgOf(deps)(
    `${target.name}`,
    `<p><a href="/${target.code.toLowerCase()}">← Volver al PI</a> · <span class="tag">${escapeHtml(ROLE_LABEL[role!] ?? '—')}</span></p>
     ${msg ? `<p class="msg err">${escapeHtml(msg)}</p>` : ''}
     ${nomForm}
     ${visForm}
     <h2>Compartido con</h2>
     <table><thead><tr><th>Principal</th><th>Rol</th><th></th></tr></thead><tbody>${grantRows || `<tr><td colspan="3" class="sub">Sin compartir.</td></tr>`}</tbody></table>
     ${shareForm}
     ${demForm}`,
  )
}

const pgOf = (deps: PiConfigDeps) => (title: string, body: string) => page(`${deps.brandTitle ?? 'Vergis'} · Configuración`, title, body)

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
