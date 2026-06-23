/**
 * Autorización de ARTEFACTO de un PI — la capa que decide quién puede abrir/configurar un PI, OrtogONAL
 * a la RLS de filas (Custos). Se exige AND: acceso al artefacto Y la RLS sigue filtrando filas dentro.
 * Ser dueño/colaborador NUNCA eleva el acceso a datos por encima del grant propio (regla bedrock,
 * "config compartida full; datos siempre por RLS").
 *
 * Roles anidados: Visor ⊂ Colaborador ⊂ Dueño.
 *  · Visor       → abre y ve (datos por su propia RLS).
 *  · Colaborador → + edita contenido y la demanda.
 *  · Dueño       → + gobierna: visibilidad, lista de compartido, otorgar ownership. Multi-dueño.
 */

export type PiRole = 'owner' | 'collaborator' | 'viewer'
export type PiVisibility = 'publico' | 'privado'
export type PrincipalType = 'user' | 'group'

export interface PiGrant {
  principalType: PrincipalType
  /** correo (user) o id de grupo de Mira (group), normalizado a minúsculas. */
  principal: string
  role: PiRole
  grantedBy?: string
  grantedAt?: string
}

const RANK: Record<PiRole, number> = { viewer: 1, collaborator: 2, owner: 3 }
export const rankOf = (r: PiRole | null): number => (r ? RANK[r] : 0)
export const higher = (a: PiRole | null, b: PiRole | null): PiRole | null => (rankOf(a) >= rankOf(b) ? a : b)

export interface EffectiveRoleArgs {
  /** null = PI sin registro de gobierno (no bootstrapeado) → default-deny. */
  visibility: PiVisibility | null
  grants: PiGrant[]
  email: string | undefined
  /** grupos de Mira a los que pertenece la identidad (de GovernanceStore.groupsOf). */
  groups: string[]
}

/**
 * Rol efectivo de una identidad sobre un PI, componiendo visibilidad + grants (por usuario y por
 * grupo de Mira). Público otorga un piso de Visor a cualquiera autenticado; privado parte de nada.
 * Toma el rol MÁS ALTO entre el piso y todos los grants que matchean.
 */
export function effectiveRole(args: EffectiveRoleArgs): PiRole | null {
  const e = (args.email ?? '').trim().toLowerCase()
  if (!e) return null // sin identidad autenticada → nada
  const groupSet = new Set(args.groups.map((g) => g.toLowerCase()))
  let role: PiRole | null = args.visibility === 'publico' ? 'viewer' : null
  for (const g of args.grants) {
    const matches = g.principalType === 'user' ? g.principal.toLowerCase() === e : groupSet.has(g.principal.toLowerCase())
    if (matches) role = higher(role, g.role)
  }
  return role
}

export const canOpen = (r: PiRole | null): boolean => r != null
export const canCollaborate = (r: PiRole | null): boolean => rankOf(r) >= RANK.collaborator
export const canGovern = (r: PiRole | null): boolean => r === 'owner'
