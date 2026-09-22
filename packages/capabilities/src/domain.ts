/**
 * Dominio — concepto de primera clase para la GESTIÓN DE DOMINIO en el ambiente de Administración.
 *
 * Un dominio es un área de datos del negocio (Personas, Cartera/Finanzas, Comercial…) que posee su
 * producto de datos de punta a punta. La superficie de Administración distingue dos clases de gestión:
 *  · Gestión de PLATAFORMA — transversal (Usuarios y Roles, Grupos, Settings) → solo admins.
 *  · Gestión de DOMINIO — por dominio (Ingesta, Data Maestra, Fuentes & Frescura) → stewards + admin.
 *
 * Modelo *datamesh*, SIN registro central que driftee: cada ARTEFACTO (entidad maestra, slot de
 * ingesta, fuente) declara su `domain`; la composición del dominio se DERIVA de eso. Este `domains.yaml`
 * de instancia aporta solo lo que no se infiere: etiqueta legible + STEWARDS (quién lo gestiona).
 */

import { requireRootKey } from './config-root'

export interface DomainDecl {
  /** Slug estable, usado en rutas (`/admin/dominio/<id>`) y como tag en los artefactos. */
  id: string
  /** Nombre legible para la UI (p.ej. `Cartera / Finanzas`). */
  label: string
  description?: string
  /**
   * Quién puede gestionar el dominio sin ser admin de plataforma, normalizado a minúsculas. Dos
   * formas, y la entrada DECLARA cuál es (issue #183): un correo (`ana@x.cl`) o un grupo de Mira con
   * prefijo explícito (`group:analistas`). No se infiere por la forma del texto — un id de grupo
   * puede parecerse a cualquier cosa, y una autorización no se decide con una heurística.
   * El admin de plataforma es override (gestiona cualquier dominio).
   */
  stewards?: string[]
  /**
   * Las CONEXIONES (`database_ref` de `VERGIS_CONNECTIONS`) en que este dominio se realiza — el
   * mapeo que el Datadoc (`CAP-197`) necesita para agrupar por dominio lo que mide por conexión.
   *
   * Vive ACÁ y no en el registro de escritores porque «el dominio X se realiza en los Datahouses Y»
   * es un hecho DEL DOMINIO: un dominio sin un solo escritor declarado tiene que poder decir cuáles
   * son sus conexiones igual. Opcional: sin él, la conexión se presenta como dominio técnico
   * rotulado por su `database_ref` — nada se infiere por parecido de nombre.
   *
   * Una conexión pertenece **a lo sumo a un dominio**: dos dominios que la reclaman es un error del
   * archivo (fatal, como un `id` duplicado), porque no hay respuesta correcta que elegir en silencio.
   * La EXISTENCIA de la conexión no se valida acá (el parser es puro y no ve `VERGIS_CONNECTIONS`):
   * el consumidor la marca «conexión desconocida» donde se note.
   */
  connections?: string[]
}

const SLUG_RE = /^[a-z][a-z0-9_-]*$/
/** Un `database_ref` admisible — el mismo alfabeto con que se nombran las conexiones. */
const REF_RE = /^[A-Za-z0-9_-]+$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
/** Prefijo que declara que una entrada de `stewards:` nombra un GRUPO de Mira, no una persona. */
export const STEWARD_GROUP_PREFIX = 'group:'

/** El id del grupo si la entrada nombra uno; `null` si nombra una persona. Nunca adivina. */
export function stewardGroupId(entry: string): string | null {
  return entry.startsWith(STEWARD_GROUP_PREFIX) ? entry.slice(STEWARD_GROUP_PREFIX.length) : null
}

/** Valida y normaliza la config declarativa de dominios (`{ domains: [...] }`). */
export function parseDomainsConfig(doc: unknown): DomainDecl[] {
  const raw = requireRootKey(doc, 'domains', 'domains')
  if (!Array.isArray(raw)) throw new Error('domains: `domains` debe ser una lista.')
  const seen = new Set<string>()
  // Conexión → dominio que ya la reclamó: la unicidad es ENTRE dominios, así que el acumulador vive
  // fuera del map y el mensaje puede nombrar a los dos dominios en disputa.
  const refOwner = new Map<string, string>()
  return raw.map((d, i) => {
    const o = (d ?? {}) as Record<string, unknown>
    const id = String(o['id'] ?? '')
    if (!SLUG_RE.test(id)) throw new Error(`domains: dominio #${i} con id inválido '${id}' (esperado [a-z][a-z0-9_-]*).`)
    if (seen.has(id)) throw new Error(`domains: id de dominio duplicado '${id}'.`)
    seen.add(id)
    const out: DomainDecl = { id, label: String(o['label'] ?? id) }
    if (o['description'] != null) out.description = String(o['description'])
    if (o['stewards'] != null) {
      if (!Array.isArray(o['stewards'])) throw new Error(`domains: '${id}'.stewards debe ser una lista de correos y grupos.`)
      // Se valida la FORMA de cada entrada acá y se falla ruidoso: una entrada que no es ni correo ni
      // `group:<slug>` quedaría como autorización silenciosamente muerta — nadie la cumple nunca y
      // nadie se entera. La EXISTENCIA del grupo NO se valida acá (el store no está en el parseo): un
      // grupo inexistente resuelve a cero miembros, que es fail-closed y no tumba el archivo.
      out.stewards = o['stewards']
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean)
        .map((s) => {
          const gid = stewardGroupId(s)
          if (gid !== null) {
            if (!SLUG_RE.test(gid)) {
              throw new Error(`domains: '${id}'.stewards declara un grupo con id inválido '${gid}' (esperado [a-z][a-z0-9_-]*).`)
            }
            return s
          }
          if (!EMAIL_RE.test(s)) {
            throw new Error(
              `domains: '${id}'.stewards tiene una entrada inválida '${s}': se espera un correo ` +
                `(ana@dominio.cl) o un grupo de Mira con prefijo explícito (${STEWARD_GROUP_PREFIX}<id>).`,
            )
          }
          return s
        })
    }
    if (o['connections'] != null) {
      if (!Array.isArray(o['connections']))
        throw new Error(`domains: '${id}'.connections debe ser una lista de database_ref de VERGIS_CONNECTIONS.`)
      const refs: string[] = []
      for (const raw of o['connections']) {
        const ref = String(raw ?? '').trim()
        if (!REF_RE.test(ref))
          throw new Error(`domains: '${id}'.connections tiene una entrada inválida '${ref}' (esperado [A-Za-z0-9_-]+, el database_ref de VERGIS_CONNECTIONS).`)
        const duenno = refOwner.get(ref)
        // La unicidad es ENTRE dominios. Repetirla dentro del MISMO es redundancia, no ambigüedad:
        // se deduplica en silencio. Entre dos dominios no hay respuesta correcta que elegir solo.
        if (duenno != null && duenno !== id)
          throw new Error(`domains: la conexión '${ref}' ya fue reclamada por el dominio '${duenno}' — una conexión pertenece a lo sumo a un dominio.`)
        refOwner.set(ref, id)
        if (!refs.includes(ref)) refs.push(ref)
      }
      out.connections = refs
    }
    return out
  })
}

/** El dominio que reclama esta conexión, o `null`. Índice invertido de `connections` (D1 de CAP-197). */
export function domainOfConnection(domains: readonly DomainDecl[], ref: string): DomainDecl | null {
  return domains.find((d) => (d.connections ?? []).includes(ref)) ?? null
}

/**
 * ¿Puede esta identidad gestionar el dominio? Admin override O steward declarado — por correo, o por
 * pertenecer a un grupo que el dominio nombra (issue #183).
 *
 * `groups` son los grupos de ESTA identidad, que el llamador resuelve **por request** contra el store
 * (`groupsOf`): así un alta o baja en `/admin/grupos` surte efecto sin reiniciar ni recargar el YAML.
 * La membresía no se consulta acá adrede — este módulo decide autorización y no habla con el store.
 *
 * Fail-closed en los dos bordes que importan: sin `groups` (llamador que no los resolvió), un grupo
 * inexistente o un grupo vacío resuelven todos a **ningún acceso**. Una lista de stewards que no
 * resuelve a nadie NO abre el dominio.
 */
export function canManageDomain(domain: DomainDecl, email: string | undefined, isAdmin: boolean, groups: string[] = []): boolean {
  if (isAdmin) return true
  const e = (email ?? '').trim().toLowerCase()
  if (!e) return false
  const mine = new Set(groups.map((g) => g.trim().toLowerCase()).filter(Boolean))
  return (domain.stewards ?? []).some((s) => {
    const gid = stewardGroupId(s)
    return gid === null ? s === e : mine.has(gid)
  })
}

/** Los dominios que esta identidad puede gestionar (admin → todos). Ver `canManageDomain` por `groups`. */
export function manageableDomains(domains: DomainDecl[], email: string | undefined, isAdmin: boolean, groups: string[] = []): DomainDecl[] {
  return domains.filter((d) => canManageDomain(d, email, isAdmin, groups))
}
