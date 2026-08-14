// Binder del compilador: liga el Policy IR contra el schema del store, los claims disponibles y
// las jerarquías de referencia (doc 10 §2, charter §4–§5). Verifica existencia antes de generar
// enforcement; falla ruidoso (nunca arranca con una policy que referencia algo inexistente).

import { VergisError } from '@vergis/botler'
import { columnRules, isHierarchy, isPublic, type PolicyDecl } from './ir'

export interface BindContext {
  /** Columnas existentes en el store/dataset destino. */
  columns: string[]
  /** Claims que el gate (IdP) puede entregar. Vacío → no se valida el claim (puede no conocerse al compilar). */
  claims?: string[]
  /** Jerarquías de referencia disponibles en el trust-base (para predicados `descendant_of`). Vacío → no se valida `via`. */
  references?: string[]
}

function err(code: string, path: string, value: unknown, message: string, remediation: string): VergisError {
  return new VergisError({ error: 'policy/bind-failed', code, path, value, message, remediation })
}

/**
 * Liga las COLUMNAS ENMASCARADAS contra el schema (#163 H5).
 *
 * Sin esto, un typo en `columns[].column` no lo caza nadie: la regla apunta a una columna que no
 * existe, `maskRow` no inventa columnas (conserva la forma de la fila), y el resultado es que **no
 * se enmascara nada, en silencio** — el mismo fail-open del plano de fila pero sin el ruido, porque
 * una RLS mal ligada al menos niega filas y se nota. Se liga con el MISMO error que los predicados
 * (`unknown-column`): para el operador es la misma falta, y merece el mismo nombre.
 *
 * Corre también sobre policies PÚBLICAS: los dos planos son ortogonales y un `grant: all` con una
 * columna sensible es justo el caso que el diseño nombra como driver (§6).
 */
function bindColumnRules(policy: PolicyDecl, ctx: BindContext): void {
  columnRules(policy).forEach((rule, i) => {
    if (!ctx.columns.includes(rule.column)) {
      throw err(
        'unknown-column',
        `quality.audience.columns[${i}].column`,
        rule.column,
        `La regla de columna protege '${rule.column}', que no existe en el store: no enmascararía nada. Disponibles: ${ctx.columns.join(', ')}.`,
        `Corregir 'column' o declarar esa columna en el dataset.`,
      )
    }
    // El claim va contra los del gate igual que el de un predicado (#163 H7). Acá el modo de falla es
    // el opuesto al de fila y por eso se pasa por alto: un claim inexistente NO abre — enmascara
    // siempre, para todos. Pero un typo que enmascara todo para todos es igual de indeseable que uno
    // que no enmascara a nadie, y merece el mismo `unknown-claim` que el operador ya sabe leer.
    if (ctx.claims && ctx.claims.length > 0 && !ctx.claims.includes(rule.claim)) {
      throw err(
        'unknown-claim',
        `quality.audience.columns[${i}].claim`,
        rule.claim,
        `La regla de columna habilita '${rule.column}' con el claim '${rule.claim}', que el gate no entrega: la columna quedaría enmascarada para todo sujeto, siempre. Disponibles: ${ctx.claims.join(', ')}.`,
        `Corregir 'claim' o configurar el gate para emitir ese claim.`,
      )
    }
  })
}

/** Liga la policy al contexto; devuelve la misma policy si todo resuelve. Lanza si no. */
export function bindPolicy(policy: PolicyDecl, ctx: BindContext): PolicyDecl {
  bindColumnRules(policy, ctx)
  if (isPublic(policy)) return policy
  policy.predicates.forEach((pred, i) => {
    if (!ctx.columns.includes(pred.column)) {
      throw err(
        'unknown-column',
        `quality.audience.rls[${i}].column`,
        pred.column,
        `La policy referencia la columna '${pred.column}', que no existe en el store. Disponibles: ${ctx.columns.join(', ')}.`,
        `Corregir 'column' o declarar esa columna en el dataset.`,
      )
    }
    if (ctx.claims && ctx.claims.length > 0 && !ctx.claims.includes(pred.claim)) {
      throw err(
        'unknown-claim',
        `quality.audience.rls[${i}].claim`,
        pred.claim,
        `La policy referencia el claim '${pred.claim}', que el gate no entrega. Disponibles: ${ctx.claims.join(', ')}.`,
        `Corregir 'claim' o configurar el gate para emitir ese claim.`,
      )
    }
    if (isHierarchy(pred) && ctx.references && ctx.references.length > 0 && !ctx.references.includes(pred.via)) {
      throw err(
        'unknown-reference',
        `quality.audience.rls[${i}].via`,
        pred.via,
        `La policy recorre la jerarquía '${pred.via}', que no existe en el trust-base. Disponibles: ${ctx.references.join(', ')}.`,
        `Corregir 'via' o declarar esa jerarquía de referencia.`,
      )
    }
  })
  return policy
}
