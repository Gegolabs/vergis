// Front-end del compilador: la declaración `audience` del spec (doc 3 §6.1, charter §4) → Policy IR.
// Parsea + valida la gramática del VOCABULARIO FIJO; rechaza lo malformado con VergisError accionable.
// Fail-closed: ante la duda, NUNCA produce una policy abierta.
//
// Cada predicado es de pertenencia (Nivel-1: {column, claim, op}) o jerárquico (Nivel-2:
// {relation: descendant_of, column, claim, via}). El criterio lo declara la política; no hay
// discriminador universal.

import { VergisError } from '@vergis/botler'
import type { Combine, HierarchyPredicate, MembershipPredicate, Policy, PolicyDecl, Predicate, PredicateOp } from './ir'

/** El bloque `quality.audience` tal como llega del DSL (sin tipar). */
export interface AudienceDecl {
  rls?: unknown
  combine?: unknown
  default?: unknown
  classification_constraint?: unknown
  [k: string]: unknown
}

const OPS: readonly PredicateOp[] = ['in', 'eq']
const COMBINES: readonly Combine[] = ['and', 'or']
// Relaciones jerárquicas del vocabulario. `subordinate_of` (charter) es alias de `descendant_of`.
const RELATIONS: Record<string, 'descendant_of'> = { descendant_of: 'descendant_of', subordinate_of: 'descendant_of' }

function err(code: string, path: string, value: unknown, message: string, remediation: string): VergisError {
  return new VergisError({ error: 'policy/spec-invalid', code, path, value, message, remediation })
}

/**
 * `quality.audience` → PolicyDecl.
 *
 * - ausente / `rls` ausente → `public`.
 * - `rls: public`           → `public`.
 * - `rls: [ ... ]`          → Policy (`default: deny`); cada item de pertenencia o jerárquico.
 */
export function parseAudience(audience: AudienceDecl | undefined): PolicyDecl {
  if (!audience || audience.rls == null) return { public: true }
  if (audience.rls === 'public') return { public: true }

  if (!Array.isArray(audience.rls)) {
    throw err(
      'rls-malformed',
      'quality.audience.rls',
      audience.rls,
      `audience.rls debe ser una lista de predicados o el literal 'public'.`,
      `Declarar 'rls: public' (PI sin RLS) o 'rls: [{column, claim, op}]' / '[{relation, column, claim, via}]'.`,
    )
  }

  const predicates: Predicate[] = audience.rls.map((p, i) => parsePredicate(p, i))
  const combine = parseCombine(audience.combine)

  const dflt = audience.default ?? 'deny'
  if (dflt !== 'deny') {
    throw err(
      'default-unsupported',
      'quality.audience.default',
      dflt,
      `audience.default solo soporta 'deny' (fail-closed). Una policy declarada no puede abrir por omisión.`,
      `Quitar 'default' (deny es el único modo) o usar 'rls: public' para un PI sin RLS de fila.`,
    )
  }

  const policy: Policy = { predicates, combine, default: 'deny' }
  return policy
}

function parsePredicate(p: unknown, i: number): Predicate {
  const path = `quality.audience.rls[${i}]`
  if (typeof p !== 'object' || p == null || Array.isArray(p)) {
    throw err('predicate-malformed', path, p, `Cada predicado debe ser un objeto {column, claim, op} o {relation, column, claim, via}.`, `Corregir el predicado ${i}.`)
  }
  const o = p as Record<string, unknown>
  const column = o.column ?? o.object_column // alias charter §4
  const claim = o.claim ?? o.subject // alias charter §4

  if (typeof column !== 'string' || column.length === 0) {
    throw err('predicate-column', `${path}.column`, column, `'column' debe ser el nombre (string) de una columna del store.`, `Declarar 'column'.`)
  }
  if (typeof claim !== 'string' || claim.length === 0) {
    throw err('predicate-claim', `${path}.claim`, claim, `'claim' debe ser el nombre (string) de un claim de identidad.`, `Declarar 'claim'.`)
  }

  // Jerárquico (Nivel-2) si declara `relation`; si no, pertenencia (Nivel-1).
  if (o.relation != null) {
    return parseHierarchy(o, column, claim, path)
  }
  const op = o.op ?? 'in'
  if (typeof op !== 'string' || !OPS.includes(op as PredicateOp)) {
    throw err('predicate-op', `${path}.op`, op, `'op' debe ser uno de: ${OPS.join(', ')}.`, `Usar 'in' (membresía) o 'eq' (escalar).`)
  }
  const pred: MembershipPredicate = { kind: 'membership', column, claim, op: op as PredicateOp }
  return pred
}

function parseHierarchy(o: Record<string, unknown>, column: string, claim: string, path: string): HierarchyPredicate {
  const relRaw = o.relation
  if (typeof relRaw !== 'string' || !(relRaw in RELATIONS)) {
    throw err('relation-invalid', `${path}.relation`, relRaw, `'relation' debe ser una del vocabulario: ${Object.keys(RELATIONS).join(', ')}.`, `Usar 'descendant_of' (jerárquico).`)
  }
  const via = o.via
  if (typeof via !== 'string' || via.length === 0) {
    throw err('relation-via', `${path}.via`, via, `'via' debe nombrar la jerarquía de referencia (dataset de cierre del trust-base).`, `Declarar 'via: <jerarquía>'.`)
  }
  const ancestor = o.ancestor ?? 'ancestor'
  const descendant = o.descendant ?? 'descendant'
  if (typeof ancestor !== 'string' || typeof descendant !== 'string') {
    throw err('relation-columns', `${path}`, { ancestor, descendant }, `'ancestor'/'descendant' (columnas del cierre) deben ser strings.`, `Omitir para usar 'ancestor'/'descendant', o declarar nombres válidos.`)
  }
  return { kind: 'hierarchy', rel: RELATIONS[relRaw], column, claim, via, ancestor, descendant }
}

function parseCombine(c: unknown): Combine {
  if (c == null) return 'and'
  if (typeof c !== 'string' || !COMBINES.includes(c as Combine)) {
    throw err('combine-invalid', 'quality.audience.combine', c, `'combine' debe ser 'and' u 'or'.`, `Usar 'and' (default) u 'or'.`)
  }
  return c as Combine
}
