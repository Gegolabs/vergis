// Binder del compilador: liga el Policy IR contra el schema del store y los claims
// disponibles (doc 10 §2, etapa Binder). Verifica existencia de columna y de claim
// antes de generar enforcement; falla ruidoso (nunca arranca con una policy que
// referencia una columna inexistente).

import { VergisError } from '@vergis/botler'
import { isPublic, type PolicyDecl } from './ir'

export interface BindContext {
  /** Columnas existentes en el store/dataset destino. */
  columns: string[]
  /** Claims que el gate (IdP) puede entregar. Si está vacío, no se valida el claim (puede no conocerse al compilar). */
  claims?: string[]
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
  })
  return policy
}
