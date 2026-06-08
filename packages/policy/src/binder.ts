// Binder del compilador: liga el Policy IR contra el schema del store, los claims disponibles y
// las jerarquías de referencia (doc 10 §2, charter §4–§5). Verifica existencia antes de generar
// enforcement; falla ruidoso (nunca arranca con una policy que referencia algo inexistente).

import { VergisError } from '@vergis/botler'
import { isHierarchy, isPublic, type PolicyDecl } from './ir'

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

/** Liga la policy al contexto; devuelve la misma policy si todo resuelve. Lanza si no. */
export function bindPolicy(policy: PolicyDecl, ctx: BindContext): PolicyDecl {
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
