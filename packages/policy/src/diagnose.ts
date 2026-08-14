// Diagnóstico de la NEGACIÓN — issue #165 §3.
//
// El fail-closed del IR es correcto y NO se toca: un claim que el modelo no sabe resolver niega, y
// así debe seguir. Lo que este módulo agrega es la capacidad de DECIR POR QUÉ negó, que es una cosa
// distinta: hoy el sujeto denegado por la cardinalidad de su claim y el sujeto sin claim producen
// exactamente el mismo resultado observable —cero filas— y el operador no puede separarlos de "no
// hay datos". Es la misma disciplina que el resto de la plataforma ya exige en otro plano:
// «medí y salió negativo» ≠ «no pude medir».
//
// VIVE ACÁ, junto al evaluador de referencia, y no en el server, por una razón: la explicación de
// una negación es SEMÁNTICA DEL IR. Si viviera en el canal de serving, cada back-end tendría su
// propia versión de "por qué no ves nada" y divergirían en la primera corrección — que es justo el
// modo de falla que el compilador evita teniendo un solo oráculo.
//
// Lo que este módulo NO hace, deliberadamente:
//   · NO evalúa filas. Todo lo que diagnostica es función de (policy, claims) — se puede computar
//     ANTES de tocar el motor, y por eso sirve igual en push-down, donde las filas no pasan por acá.
//   · NO cambia ninguna decisión de autorización. Es observabilidad pura: quien lo llame decide qué
//     hacer con el hallazgo. Un diagnóstico que además negara sería una segunda implementación del
//     enforcement, con dos maneras de estar en desacuerdo consigo mismo.
import { claimValues, isHierarchy, isPublic, type ClaimSet, type PolicyDecl, type Predicate } from './ir'

/**
 * Por qué un predicado no puede dejar pasar NINGUNA fila, sea cual sea el dato.
 *
 * · `sin-claim` — el sujeto no trae valor para el claim que la política exige. Es el default-deny
 *   de siempre (`evalPredicate`: `allowed.length === 0` → false), y es la mitad esperada del modelo.
 * · `cardinalidad-eq` — el sujeto trae DOS O MÁS valores y el predicado es `eq`, que por contrato
 *   exige exactamente uno (`ir.ts`: `allowed.length === 1 && allowed[0] === cell`; el codegen Fabric
 *   replica el guard con `CHARINDEX(N',', ...) = 0`). Esta es la que hoy es indistinguible de la
 *   anterior, y la que golpea a la persona con doble pertenencia LEGÍTIMA — no a un intruso.
 */
export type ClaimDenialKind = 'sin-claim' | 'cardinalidad-eq'

export interface ClaimDenial {
  /** Índice del predicado en `policy.predicates` — para nombrar cuál, si hay varios. */
  predicate: number
  /** Columna de la fila que el predicado segmenta. */
  column: string
  /** Claim de identidad que el predicado exige. */
  claim: string
  kind: ClaimDenialKind
  /** Cuántos valores trajo el sujeto para ese claim (0 en `sin-claim`, ≥2 en `cardinalidad-eq`). */
  values: number
}

/** ¿Este predicado niega toda fila con estos claims, sin mirar el dato? `null` si no. */
function denialOf(pred: Predicate, claims: ClaimSet, index: number): ClaimDenial | null {
  const allowed = claimValues(claims, pred.claim)
  const base = { predicate: index, column: pred.column, claim: pred.claim, values: allowed.length }
  if (allowed.length === 0) return { ...base, kind: 'sin-claim' }
  // El jerárquico toma un CONJUNTO de ancestros y devuelve la unión de sus descendientes: la
  // cardinalidad no lo estorba. Solo `eq` exige unicidad.
  if (!isHierarchy(pred) && pred.op === 'eq' && allowed.length > 1) return { ...base, kind: 'cardinalidad-eq' }
  return null
}

/**
 * Los predicados que no pueden dejar pasar ninguna fila con estos claims.
 *
 * Devolver la lista COMPLETA —y no solo el primero— es deliberado: con `combine: 'and'` basta uno
 * para que no se vea nada, pero el operador que va a corregir necesita ver todos los que están mal,
 * no descubrirlos de a uno por corrida.
 */
export function diagnoseClaims(policy: PolicyDecl, claims: ClaimSet): ClaimDenial[] {
  if (isPublic(policy)) return []
  const out: ClaimDenial[] = []
  policy.predicates.forEach((p, i) => {
    const d = denialOf(p, claims, i)
    if (d) out.push(d)
  })
  return out
}

/**
 * ¿La policy niega TODA fila con estos claims, cualquiera sea el dato?
 *
 * Es un teorema sobre el oráculo, no una heurística: si esto devuelve `true`, `applyPolicy` con
 * CUALQUIER conjunto de filas devuelve `[]`. La property test diferencial lo fija (`diagnose.test.ts`),
 * y esa es la única razón por la que este predicado se puede usar para afirmarle algo a un operador.
 *
 * La aritmética sigue a `evalPolicy`, incluidos sus dos bordes:
 *   · `public` → nunca niega todo.
 *   · sin predicados → deny-all explícito, niega todo SIN que haya un claim que culpar.
 */
export function deniesAllRows(policy: PolicyDecl, claims: ClaimSet): boolean {
  if (isPublic(policy)) return false
  if (policy.predicates.length === 0) return true
  const dead = policy.predicates.map((p, i) => denialOf(p, claims, i) !== null)
  // `and` → un predicado muerto mata la conjunción. `or` → hacen falta todos.
  return policy.combine === 'or' ? dead.every(Boolean) : dead.some(Boolean)
}

/** Una línea legible por un humano de operaciones. Sin PII: nombra el claim, jamás su valor. */
export function explainDenial(d: ClaimDenial): string {
  return d.kind === 'sin-claim'
    ? `columna '${d.column}': el sujeto no trae el claim '${d.claim}' (default-deny)`
    : `columna '${d.column}': el claim '${d.claim}' trae ${d.values} valores y el predicado es 'eq', que exige exactamente uno — denegado por CARDINALIDAD, no por falta de permiso`
}
