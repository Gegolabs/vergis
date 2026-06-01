// Policy store — la capa de POLÍTICAS DE DATOS (germen del policy store de Custos, charter §6).
//
// Principio data-anchored llevado a su forma pura (charter §2a): la política vive ATADA AL DATO
// (dataset/tabla), NO en el reporte. El PI es ciego a la autorización — solo dice qué dato muestra;
// hereda lo que el dato traiga. La accesibilidad la deciden SOLO estas políticas:
//   · rls: [...]   → filtra filas por claim (default-deny inherente).
//   · grant: all   → apertura EXPLÍCITA y gobernada ("accesible hasta que se diga lo contrario").
//   · sin entrada  → DENY (la tabla no recibe acceso; ver bootstrap).
//
// NO existe un flag `public` en el reporte: abrir es una política explícita, revisable, no un
// atributo que el autor del spec se auto-otorga.

import { VergisError } from '@vergis/botler'
import { parseAudience } from './frontend'
import type { PolicyDecl } from './ir'

/** Una entrada del store: ata una política a un dataset/tabla del dato gobernado. */
export interface DataPolicyDecl {
  /** Identificador del dato gobernado (p.ej. la tabla del store: `qw04.areas`). */
  dataset: string
  /** Predicados de fila (membresía/igualdad por claim). Mutuamente excluyente con `grant`. */
  rls?: unknown
  /** Apertura explícita: `all` = todas las filas visibles (posture gobernada). */
  grant?: unknown
  combine?: unknown
  default?: unknown
  [k: string]: unknown
}

export interface PolicyStoreDoc {
  policies?: DataPolicyDecl[]
}

function err(code: string, path: string, value: unknown, message: string, remediation: string): VergisError {
  return new VergisError({ error: 'policy/store-invalid', code, path, value, message, remediation })
}

/**
 * Parsea un documento de policy store a un mapa `dataset → PolicyDecl`. Fail-closed: una entrada
 * malformada lanza; lo que no está en el mapa queda **sin política** (el bootstrap lo niega).
 */
export function parsePolicyStore(doc: PolicyStoreDoc | undefined): Map<string, PolicyDecl> {
  const out = new Map<string, PolicyDecl>()
  const list = doc?.policies
  if (!Array.isArray(list)) return out
  list.forEach((entry, i) => {
    const path = `policies[${i}]`
    if (typeof entry?.dataset !== 'string' || entry.dataset.length === 0) {
      throw err('dataset-missing', `${path}.dataset`, entry?.dataset, `Cada política debe atar a un 'dataset' (string).`, `Declarar 'dataset'.`)
    }
    const hasGrant = entry.grant != null
    const hasRls = entry.rls != null
    if (hasGrant && hasRls) {
      throw err('grant-and-rls', path, entry, `Una política no puede tener 'grant' y 'rls' a la vez.`, `Usar 'rls: [...]' (filtra) o 'grant: all' (abre), no ambos.`)
    }
    if (hasGrant) {
      if (entry.grant !== 'all') {
        throw err('grant-unsupported', `${path}.grant`, entry.grant, `'grant' solo soporta 'all' (apertura explícita).`, `Usar 'grant: all' o quitar la entrada (sin entrada = deny).`)
      }
      // apertura explícita gobernada → sin restricción de fila (PublicPolicy del IR)
      out.set(entry.dataset, { public: true })
      return
    }
    if (!hasRls) {
      throw err('no-decision', path, entry, `La política de '${entry.dataset}' no declara 'rls' ni 'grant'. La omisión es deny — no declares la entrada si quieres negar.`, `Declarar 'rls: [...]' o 'grant: all'.`)
    }
    // reusa el parser de predicados (rls + default deny). 'public' como literal NO existe acá.
    if (entry.rls === 'public') {
      throw err('public-removed', `${path}.rls`, entry.rls, `'public' no existe como política. La apertura es 'grant: all', explícita y gobernada.`, `Usar 'grant: all'.`)
    }
    const policy = parseAudience({ rls: entry.rls, combine: entry.combine, default: entry.default })
    out.set(entry.dataset, policy)
  })
  return out
}

export type { PolicyDecl }
