// Policy IR — el lenguaje intermedio del compilador de policy (doc 10 §2–§3).
//
// Deliberadamente PEQUEÑO, TOTAL y DECLARATIVO — NO Turing-completo. Un predicado
// relaciona UNA columna del store con UN claim de identidad vía un operador mínimo.
// Lo que no cabe acá no entra al compilador (guardrail doc 8/10: "flexibilidad en el
// control = motor de autorización disfrazado"). Es la condición para ser auditable.
//
// Acá vive además el EVALUADOR DE REFERENCIA: la semántica canónica del IR, pura y
// total. Es el oráculo contra el que se prueba todo codegen (doc 10 §9 #1–#2).

/** Claims del consumidor: claim → valor(es). Los aporta el gate; los inyecta el Botler. */
export type ClaimSet = Record<string, string[] | string | undefined>

export type PredicateOp = 'in' | 'eq'

export interface Predicate {
  /** Columna del store que segmenta. */
  column: string
  /** Claim de identidad que trae lo permitido. */
  claim: string
  /** `in` → row[column] ∈ claims[claim] · `eq` → row[column] == claims[claim] (escalar). */
  op: PredicateOp
}

export type Combine = 'and' | 'or'

/** Una policy declarada: predicados combinados, fail-closed por construcción. */
export interface Policy {
  predicates: Predicate[]
  combine: Combine
  /** Único modo soportado: sin match → 0 filas. Una policy declarada nunca abre por omisión. */
  default: 'deny'
}

/** Marca explícita de PI sin restricción de fila (opción E del doc 8: solo gatea el reporte). */
export interface PublicPolicy {
  public: true
}

export type PolicyDecl = Policy | PublicPolicy

export function isPublic(p: PolicyDecl): p is PublicPolicy {
  return (p as PublicPolicy).public === true
}

/**
 * Normaliza un claim a lista de strings, descartando vacíos (default-deny si está
 * ausente/vacío). Filtrar el string vacío mantiene la referencia ALINEADA con el
 * codegen ClickHouse, donde el encoding por coma + guard `!= ''` no distingue ''
 * de "sin claim" (un valor '' no es un valor).
 */
export function claimValues(claims: ClaimSet, claim: string): string[] {
  const v = claims[claim]
  if (v == null) return []
  const arr = Array.isArray(v) ? v.map(String) : [String(v)]
  return arr.filter((x) => x.length > 0)
}

function cellToStr(v: unknown): string {
  return v == null ? '' : String(v)
}

/** Evaluación de referencia de UN predicado: ¿la fila es visible para esos claims? */
export function evalPredicate(pred: Predicate, claims: ClaimSet, row: Record<string, unknown>): boolean {
  const cell = cellToStr(row[pred.column])
  const allowed = claimValues(claims, pred.claim)
  if (pred.op === 'eq') {
    // escalar: exactamente un valor permitido, igual a la celda
    return allowed.length === 1 && allowed[0] === cell
  }
  // in: membresía
  return allowed.includes(cell)
}

/**
 * Evaluación de referencia de la policy completa — semántica canónica del IR.
 * `public` → todo visible. Sin predicados → deny. Combinación and/or.
 * Default-deny es inherente: un claim ausente da `allowed=[]` → ningún predicado `in`/`eq` matchea.
 */
export function evalPolicy(policy: PolicyDecl, claims: ClaimSet, row: Record<string, unknown>): boolean {
  if (isPublic(policy)) return true
  if (policy.predicates.length === 0) return false // deny-all explícito
  const results = policy.predicates.map((p) => evalPredicate(p, claims, row))
  return policy.combine === 'or' ? results.some(Boolean) : results.every(Boolean)
}

/** Filtra un store completo según la policy y unos claims (utilidad para tests/aserciones). */
export function applyPolicy(
  policy: PolicyDecl,
  claims: ClaimSet,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.filter((r) => evalPolicy(policy, claims, r))
}
