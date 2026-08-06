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
   * Quién puede gestionar el dominio sin ser admin de plataforma. Correos (normalizados a minúsculas).
   * El admin de plataforma es override (gestiona cualquier dominio). Grupos de Mira como stewards =
   * extensión futura.
   */
  stewards?: string[]
}

const SLUG_RE = /^[a-z][a-z0-9_-]*$/

/** Valida y normaliza la config declarativa de dominios (`{ domains: [...] }`). */
export function parseDomainsConfig(doc: unknown): DomainDecl[] {
  const raw = requireRootKey(doc, 'domains', 'domains')
  if (!Array.isArray(raw)) throw new Error('domains: `domains` debe ser una lista.')
  const seen = new Set<string>()
  return raw.map((d, i) => {
    const o = (d ?? {}) as Record<string, unknown>
    const id = String(o['id'] ?? '')
    if (!SLUG_RE.test(id)) throw new Error(`domains: dominio #${i} con id inválido '${id}' (esperado [a-z][a-z0-9_-]*).`)
    if (seen.has(id)) throw new Error(`domains: id de dominio duplicado '${id}'.`)
    seen.add(id)
    const out: DomainDecl = { id, label: String(o['label'] ?? id) }
    if (o['description'] != null) out.description = String(o['description'])
    if (o['stewards'] != null) {
      if (!Array.isArray(o['stewards'])) throw new Error(`domains: '${id}'.stewards debe ser una lista de correos.`)
      out.stewards = o['stewards'].map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    }
    return out
  })
}

/** ¿Puede esta identidad gestionar el dominio? Admin override O steward declarado. */
export function canManageDomain(domain: DomainDecl, email: string | undefined, isAdmin: boolean): boolean {
  if (isAdmin) return true
  const e = (email ?? '').trim().toLowerCase()
  if (!e) return false
  return (domain.stewards ?? []).includes(e)
}

/** Los dominios que esta identidad puede gestionar (admin → todos). */
export function manageableDomains(domains: DomainDecl[], email: string | undefined, isAdmin: boolean): DomainDecl[] {
  return domains.filter((d) => canManageDomain(d, email, isAdmin))
}
