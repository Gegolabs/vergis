// Front-end del compilador: la declaración `audience` del spec (doc 3 §6.1) → Policy IR.
// Parsea + valida la gramática; rechaza lo malformado con VergisError accionable.
// Fail-closed: ante la duda, NUNCA produce una policy abierta.

import { VergisError } from '@vergis/botler'
import type { Combine, Policy, PolicyDecl, Predicate, PredicateOp } from './ir'

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

function err(code: string, path: string, value: unknown, message: string, remediation: string): VergisError {
  return new VergisError({ error: 'policy/spec-invalid', code, path, value, message, remediation })
}

/**
 * `quality.audience` → PolicyDecl.
 *
 * - ausente / `rls` ausente → `public` (compat doc 3 §6.1: un PI restringido MUST declarar `rls`).
 * - `rls: public`           → `public`.
 * - `rls: [ {column, claim, op} ]` → Policy con `default: deny`.
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
      `Declarar 'rls: public' (PI sin RLS) o 'rls: [{column, claim, op}]'.`,
    )
  }

  const predicates: Predicate[] = audience.rls.map((p, i) => parsePredicate(p, i))
  const combine = parseCombine(audience.combine)

  // default: solo 'deny' (fail-closed). 'public' se expresa con `rls: public`, no con default.
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
    throw err('predicate-malformed', path, p, `Cada predicado debe ser un objeto {column, claim, op}.`, `Corregir el predicado ${i}.`)
  }
  const o = p as Record<string, unknown>
  const column = o.column
  const claim = o.claim
  const op = o.op ?? 'in'

  if (typeof column !== 'string' || column.length === 0) {
    throw err('predicate-column', `${path}.column`, column, `'column' debe ser el nombre (string) de una columna del store.`, `Declarar 'column'.`)
  }
  if (typeof claim !== 'string' || claim.length === 0) {
    throw err('predicate-claim', `${path}.claim`, claim, `'claim' debe ser el nombre (string) de un claim de identidad.`, `Declarar 'claim'.`)
  }
  if (typeof op !== 'string' || !OPS.includes(op as PredicateOp)) {
    throw err('predicate-op', `${path}.op`, op, `'op' debe ser uno de: ${OPS.join(', ')}.`, `Usar 'in' (membresía) o 'eq' (escalar).`)
  }
  return { column, claim, op: op as PredicateOp }
}

function parseCombine(c: unknown): Combine {
  if (c == null) return 'and'
  if (typeof c !== 'string' || !COMBINES.includes(c as Combine)) {
    throw err('combine-invalid', 'quality.audience.combine', c, `'combine' debe ser 'and' u 'or'.`, `Usar 'and' (default) u 'or'.`)
  }
  return c as Combine
}
