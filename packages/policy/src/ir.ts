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
//
// El IR tiene DOS planos ortogonales, y conviene no confundirlos al leer este archivo:
//   · FILA — los predicados de arriba deciden QUÉ FILAS ve el sujeto. Semántica intacta.
//   · COLUMNA — las reglas de columna (`ColumnRule`, #163 H1) deciden, sobre las filas que la
//     política YA dejó pasar, qué CELDAS vienen sustituidas por la máscara.
// El segundo plano no puede abrir ni cerrar filas: se aplica después del filtro, jamás dentro de él.

import { VergisError } from '@vergis/botler'

/**
 * Claims del consumidor: claim → valor(es). Los aporta el gate; los inyecta el Botler.
 *
 * MODELO DECLARADO (issue #165 §1): **el claim de un sujeto es un CONJUNTO, posiblemente unitario** —
 * no un escalar con una lista como detalle de transporte. Una persona con dos nodos legítimos del
 * criterio (doble dependencia, matriz, proyecto transversal, interinato) es un sujeto VÁLIDO del
 * modelo. `in` y el jerárquico producen la UNIÓN; `eq` declara que ese criterio no admite
 * pertenencia múltiple y por eso niega ante dos valores (ver `evalPredicate`). La negación es
 * correcta —abrir sería over-grant, elegir sería inferir identidad— y `./diagnose` la vuelve
 * distinguible de «sin claim» y de «sin datos», que es lo que le faltaba.
 */
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

/**
 * Valor que sustituye la celda enmascarada. **Estable y parte del contrato**: el codegen de cada
 * back-end debe emitir EXACTAMENTE esto para que el differential test contra el oráculo cierre, y
 * cambiarlo cambia lo que ve un humano en un PI ya desplegado.
 *
 * Es un literal legible como «no te corresponde» (diseño §4.1) y no una cadena vacía ni un `null`:
 * esos dos son indistinguibles de «el dato no existe», y el punto de enmascarar en vez de ocultar
 * es justamente que la ausencia no se confunda con un bug.
 */
export const MASK_VALUE = '•••'

/** Única acción del vocabulario de columna. No hay `hide`, `hash`, `truncate` ni condiciones. */
export type ColumnAction = 'mask'

/**
 * Regla de COLUMNA (#163 H1): `columna × claim × acción`. Vocabulario **fijo y cerrado**, del mismo
 * tamaño que el de fila y por la misma razón (charter §4, "flexibilidad = motor de authz disfrazado").
 *
 * Se lee así: *la columna `column` va enmascarada para todo sujeto que NO traiga el claim `claim`*.
 * No hay operador porque no hay nada que comparar: la regla mira la PRESENCIA del claim, no su valor
 * — comparar valores acá sería reimplementar el plano de fila sobre celdas, con dos semánticas de
 * pertenencia que divergirían en la primera corrección.
 *
 * Lo que deliberadamente NO expresa, y no es un olvido:
 *   · condiciones («enmascara si region ≠ X») — eso es el motor de authz disfrazado;
 *   · razonamiento sobre agregados o cardinalidad (diseño §4.3) — un `SUM` sobre una columna
 *     enmascarada NO es asunto del IR, y quien necesite cerrar ese hueco lo cierra no sirviendo la
 *     columna a ese sujeto, no metiendo inferencia acá.
 */
export interface ColumnRule {
  /** Columna de la entidad que se protege. */
  column: string
  /** Claim que HABILITA verla en claro. Sin él (ausente o vacío) → máscara. */
  claim: string
  /** Única acción soportada. Cualquier otro valor es una regla malformada. */
  action: ColumnAction
}

/**
 * Declaración de reglas de columna. Vive aparte de `Policy` porque es ORTOGONAL al plano de fila:
 * un PI público (`grant: all`) puede tener una columna sensible sin dejar de ser público, y esa es
 * exactamente la instancia que el diseño nombra como driver (§6).
 *
 * **Opcional por contrato**: `undefined` es «esta política no dice nada de columnas», y el evaluador
 * se comporta bit a bit como antes de que este plano existiera.
 */
export interface ColumnMasking {
  columnRules?: ColumnRule[]
}

/** Una policy declarada: predicados combinados, fail-closed por construcción. */
export interface Policy extends ColumnMasking {
  predicates: Predicate[]
  combine: Combine
  /** Único modo soportado: sin match → 0 filas. Una policy declarada nunca abre por omisión. */
  default: 'deny'
}

/** Marca explícita de PI sin restricción de fila (opción E del doc 8: solo gatea el reporte). */
export interface PublicPolicy extends ColumnMasking {
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
    // `eq` DECLARA que el criterio no admite pertenencia múltiple: exactamente un valor permitido,
    // igual a la celda. Con dos valores niega — y niega a la persona con doble pertenencia legítima,
    // no a un intruso (issue #165). Es fail-closed deliberado: abrir sería over-grant y desempatar
    // sería inferir identidad. `./diagnose` existe para que esa negación se pueda explicar.
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

// === PLANO DE COLUMNA (#163 H1) ==============================================

/**
 * Valida una regla de columna. **Fail-closed y ruidoso**: una regla malformada LANZA, como el resto
 * del front-end del compilador, y jamás degrada a «sin máscara». El modo de falla que esto cierra es
 * el peor de todos en authz: una `action` con un typo que sirve la columna en claro y no deja rastro.
 */
export function validateColumnRule(rule: ColumnRule, index = 0): void {
  const path = `audience.columns[${index}]`
  const fail = (code: string, value: unknown, message: string, remediation: string) => {
    throw new VergisError({ error: 'policy/spec-invalid', code, path, value, message, remediation })
  }
  if (rule == null || typeof rule !== 'object') {
    fail('column-rule-shape', rule, 'una regla de columna debe ser un objeto', 'declara `{ column, claim, action: "mask" }`')
  }
  if (typeof rule.column !== 'string' || rule.column.length === 0) {
    fail('column-rule-column', rule.column, 'una regla de columna exige `column` (string no vacío)', 'nombra la columna a proteger')
  }
  if (typeof rule.claim !== 'string' || rule.claim.length === 0) {
    fail('column-rule-claim', rule.claim, 'una regla de columna exige `claim` (string no vacío)', 'nombra el claim que habilita ver la columna en claro')
  }
  if (rule.action !== 'mask') {
    fail('column-rule-action', rule.action, `acción no soportada: el vocabulario de columna es cerrado y su única acción es 'mask'`, `usa action: "mask"`)
  }
}

/** Las reglas de columna declaradas por una policy (de fila o pública). `[]` si no declara ninguna. */
export function columnRules(policy: PolicyDecl): ColumnRule[] {
  return (policy as ColumnMasking).columnRules ?? []
}

/**
 * Las columnas que van ENMASCARADAS para estos claims. Función de (policy, claims) solamente — no
 * mira filas, igual que `./diagnose`, y por eso se puede computar antes de tocar el motor: es lo que
 * permitirá a H4 reportar «columna X enmascarada para N sujetos» al desplegar, y no por request.
 *
 * **La ausencia no abre**: sin el claim (ausente, vacío, o solo con cadenas vacías) la columna va
 * enmascarada. Es el mismo default-deny del plano de fila, aplicado a la celda.
 */
export function maskedColumns(policy: PolicyDecl, claims: ClaimSet): Set<string> {
  const out = new Set<string>()
  columnRules(policy).forEach((rule, i) => {
    validateColumnRule(rule, i) // fail-closed: una regla ilegible no se salta, rompe
    if (claimValues(claims, rule.claim).length === 0) out.add(rule.column)
  })
  return out
}

/**
 * Sustituye en la fila las celdas de las columnas enmascaradas. **Conserva la forma**: recorre las
 * claves de la fila en su orden y no agrega ninguna — una regla sobre una columna que la fila no
 * trae no inventa la columna. Mentimos el valor, jamás el esquema (diseño §4.1).
 */
export function maskRow(row: Record<string, unknown>, masked: ReadonlySet<string>): Record<string, unknown> {
  if (masked.size === 0) return row
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(row)) out[k] = masked.has(k) ? MASK_VALUE : row[k]
  return out
}

/**
 * Filtra un store completo según la policy y unos claims, y enmascara las celdas que la policy
 * declaró sensibles para esos claims (utilidad para tests/aserciones — el oráculo del compilador).
 *
 * Los dos planos se aplican EN ORDEN y no se mezclan: primero el filtro de fila (semántica intacta),
 * después la máscara sobre lo que sobrevivió. Una política sin reglas de columna devuelve las MISMAS
 * referencias de fila que recibió — no una copia—: la extensión es conservadora por construcción, no
 * por parecido.
 */
export function applyPolicy(
  policy: PolicyDecl,
  claims: ClaimSet,
  rows: Record<string, unknown>[],
  refs: ReferenceData = {},
): Record<string, unknown>[] {
  const visible = rows.filter((r) => evalPolicy(policy, claims, r, refs))
  const masked = maskedColumns(policy, claims)
  if (masked.size === 0) return visible
  return visible.map((r) => maskRow(r, masked))
}
