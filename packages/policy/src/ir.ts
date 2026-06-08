// Policy IR — el lenguaje intermedio del compilador de policy (doc 10 §2–§3, charter §4).
//
// Deliberadamente PEQUEÑO, TOTAL y DECLARATIVO — NO Turing-completo. Un predicado relaciona el dato
// con la identidad del consumidor mediante un VOCABULARIO FIJO Y AUDITABLE de relaciones (charter §4):
//   · Nivel-1 · pertenencia:  row[column] ∈ claim            (op `in`) · row[column] == claim (op `eq`)
//   · Nivel-2 · jerárquico:   row[column] es DESCENDIENTE del nodo del viewer en una JERARQUÍA nombrada
// El criterio NO es universal: lo declara LA POLÍTICA. La jerarquía (`via`) es CUALQUIER estructura de
// referencia del trust-base (productos, geografía, cuentas, organigrama…), no algo hardcodeado.
// Lo que no está en el vocabulario, no entra (guardrail: "flexibilidad = motor de authz disfrazado").
//
// Acá vive el EVALUADOR DE REFERENCIA: la semántica canónica del IR, pura y total. Es el oráculo
// contra el que se prueba todo codegen (doc 10 §9). Para los predicados jerárquicos toma los datos
// de la jerarquía (closure) como insumo — el dato de referencia gobernado (trust-base, charter §5).

/** Claims del consumidor: claim → valor(es). Los aporta el gate; los inyecta el Botler. */
export type ClaimSet = Record<string, string[] | string | undefined>

export type PredicateOp = 'in' | 'eq'

/** Predicado de PERTENENCIA (Nivel-1): un atributo de la fila vs un claim. */
export interface MembershipPredicate {
  kind: 'membership'
  /** Columna del store que segmenta. */
  column: string
  /** Claim de identidad que trae lo permitido. */
  claim: string
  /** `in` → row[column] ∈ claims[claim] · `eq` → row[column] == claims[claim] (escalar). */
  op: PredicateOp
}

/**
 * Predicado JERÁRQUICO (Nivel-2): la fila pasa si su nodo (`column`) es DESCENDIENTE del nodo del
 * viewer (`claim`) en una jerarquía de referencia (`via`). La jerarquía es una relación de CIERRE
 * (closure) con columnas ancestro/descendiente — dato de referencia gobernado (trust-base). El
 * compilador la traduce a un subquery nativo (charter §4b "join al cierre"). `via` es CUALQUIER
 * jerarquía: el motor solo "recorre el árbol que la política apunta".
 */
export interface HierarchyPredicate {
  kind: 'hierarchy'
  rel: 'descendant_of'
  /** Columna de la fila con su nodo en la jerarquía (object_column del charter §4). */
  column: string
  /** Claim con el nodo del viewer (subject). El conjunto visible depende de quién mira. */
  claim: string
  /** Dataset de cierre que define la jerarquía (trust-base). Cualquiera; la política lo nombra. */
  via: string
  /** Columna ancestro del cierre (default `ancestor`). */
  ancestor: string
  /** Columna descendiente del cierre (default `descendant`). */
  descendant: string
}

export type Predicate = MembershipPredicate | HierarchyPredicate

export function isHierarchy(p: Predicate): p is HierarchyPredicate {
  return p.kind === 'hierarchy'
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
 * Datos de referencia (trust-base) para evaluar predicados jerárquicos: por cada jerarquía (`via`),
 * las parejas (ancestro, descendiente) del cierre. El evaluador y los emuladores los consultan; en
 * producción viven como dato gobernado en el motor (subquery), no acá.
 */
export type ClosureRow = { ancestor: string; descendant: string }
export type ReferenceData = Record<string, ClosureRow[]>

/**
 * Normaliza un claim a lista de strings, descartando vacíos (default-deny si está ausente/vacío).
 * Filtrar el string vacío mantiene la referencia ALINEADA con el codegen (encoding por coma + guard).
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

/** Descendientes (en la jerarquía `via`) de un conjunto de nodos ancestro. */
function descendantsOf(refs: ReferenceData, via: string, ancestors: string[], descendantCol: string, ancestorCol: string): Set<string> {
  const closure = refs[via] ?? []
  const anc = new Set(ancestors)
  const out = new Set<string>()
  for (const r of closure) {
    // El cierre canónico tiene columnas `ancestor`/`descendant`; permitimos override de nombres.
    const a = String((r as Record<string, unknown>)[ancestorCol] ?? r.ancestor)
    const d = String((r as Record<string, unknown>)[descendantCol] ?? r.descendant)
    if (anc.has(a)) out.add(d)
  }
  return out
}

/** Evaluación de referencia de UN predicado: ¿la fila es visible para esos claims? */
export function evalPredicate(pred: Predicate, claims: ClaimSet, row: Record<string, unknown>, refs: ReferenceData = {}): boolean {
  const cell = cellToStr(row[pred.column])
  const allowed = claimValues(claims, pred.claim)
  if (allowed.length === 0) return false // sin claim → default-deny (vale para todos los ops)
  if (isHierarchy(pred)) {
    const visible = descendantsOf(refs, pred.via, allowed, pred.descendant, pred.ancestor)
    return visible.has(cell)
  }
  if (pred.op === 'eq') {
    // escalar: exactamente un valor permitido, igual a la celda
    return allowed.length === 1 && allowed[0] === cell
  }
  return allowed.includes(cell) // in: membresía
}

/**
 * Evaluación de referencia de la policy completa — semántica canónica del IR.
 * `public` → todo visible. Sin predicados → deny. Combinación and/or. Default-deny inherente.
 */
export function evalPolicy(policy: PolicyDecl, claims: ClaimSet, row: Record<string, unknown>, refs: ReferenceData = {}): boolean {
  if (isPublic(policy)) return true
  if (policy.predicates.length === 0) return false // deny-all explícito
  const results = policy.predicates.map((p) => evalPredicate(p, claims, row, refs))
  return policy.combine === 'or' ? results.some(Boolean) : results.every(Boolean)
}

/** Filtra un store completo según la policy y unos claims (utilidad para tests/aserciones). */
export function applyPolicy(
  policy: PolicyDecl,
  claims: ClaimSet,
  rows: Record<string, unknown>[],
  refs: ReferenceData = {},
): Record<string, unknown>[] {
  return rows.filter((r) => evalPolicy(policy, claims, r, refs))
}
