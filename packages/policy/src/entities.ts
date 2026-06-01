// Capa de AUTORÍA por entidad canónica (charter §2c) — el binding sube de la tabla física a la
// ENTIDAD DE NEGOCIO. La política se declara UNA vez contra la entidad (Empleado gobernado por la
// dimensión Área); un MAPEO semántico dice qué columna de cada dataset realiza cada dimensión.
//
// Este módulo NO es un motor nuevo: RESUELVE el catálogo de entidades + el mapeo al mismo
// `Map<dataset → PolicyDecl>` que el store por-tabla (store.ts) ya produce. Los back-ends
// (clickhouse.ts, fabric.ts) no cambian — siguen recibiendo `{column, claim, op}` por tabla; lo
// que cambia es de DÓNDE sale ese `column`: del mapeo semántico, no de una entrada por-tabla.
//
// Así, un cambio de gobierno de una entidad se edita en UN lugar (la entidad) y todo dataset que
// la realiza se regenera — sin replicar la regla por tabla.

import { VergisError } from '@vergis/botler'
import type { Combine, Policy, PolicyDecl, Predicate, PredicateOp } from './ir'

const OPS: readonly PredicateOp[] = ['in', 'eq']
const COMBINES: readonly Combine[] = ['and', 'or']

/** Una dimensión gobernante de una entidad: el discriminador + el claim que lo porta. */
export interface DimensionGovernance {
  /** Nombre canónico de la dimensión (p.ej. `area`). El mapeo la liga a una columna física. */
  dimension: string
  /** Claim del gate que trae los valores permitidos. */
  claim: string
  /** `in` (pertenencia, default) o `eq` (escalar). */
  op?: unknown
}

/** Una entidad de negocio canónica con su política de gobierno (autoría única). */
export interface EntityDecl {
  entity: string
  /** Dimensiones que gobiernan la entidad. Vacío/ausente → error (usa `grant: all` en el dataset para abrir). */
  governed_by?: DimensionGovernance[]
  /** Combinación de los predicados de las dimensiones (default `and`). */
  combine?: unknown
  [k: string]: unknown
}

/** El mapeo de un dataset físico a la entidad que realiza (o apertura explícita). */
export interface DatasetMappingDecl {
  /** Tabla física del store/fuente (p.ej. `pi04.asistencia`, `dbo.fct_asistencia_dia`). */
  dataset: string
  /** Entidad canónica que este dataset realiza. Mutuamente excluyente con `grant`. */
  realizes?: string
  /** dimensión canónica → columna física que la realiza en ESTE dataset. */
  dimensions?: Record<string, unknown>
  /** Apertura explícita gobernada (datos de referencia / trust base). `all` = sin restricción de fila. */
  grant?: unknown
  [k: string]: unknown
}

export interface EntityStoreDoc {
  entities?: EntityDecl[]
  datasets?: DatasetMappingDecl[]
}

function err(code: string, path: string, value: unknown, message: string, remediation: string): VergisError {
  return new VergisError({ error: 'policy/entity-store-invalid', code, path, value, message, remediation })
}

/** ¿El documento está en forma entidad-canónica? (vs el store legacy por-tabla `policies`). */
export function isEntityStore(doc: unknown): doc is EntityStoreDoc {
  const d = doc as EntityStoreDoc | undefined
  return !!d && (Array.isArray(d.entities) || Array.isArray(d.datasets))
}

function parseGovernance(g: unknown, entity: string, i: number): { dimension: string; claim: string; op: PredicateOp } {
  const path = `entities[${entity}].governed_by[${i}]`
  if (typeof g !== 'object' || g == null || Array.isArray(g)) {
    throw err('governance-malformed', path, g, `Cada gobierno debe ser un objeto {dimension, claim, op}.`, `Corregir el gobierno ${i} de '${entity}'.`)
  }
  const o = g as Record<string, unknown>
  if (typeof o.dimension !== 'string' || o.dimension.length === 0) {
    throw err('governance-dimension', `${path}.dimension`, o.dimension, `'dimension' debe ser el nombre (string) de una dimensión canónica.`, `Declarar 'dimension'.`)
  }
  if (typeof o.claim !== 'string' || o.claim.length === 0) {
    throw err('governance-claim', `${path}.claim`, o.claim, `'claim' debe ser el nombre (string) de un claim de identidad.`, `Declarar 'claim'.`)
  }
  const op = o.op ?? 'in'
  if (typeof op !== 'string' || !OPS.includes(op as PredicateOp)) {
    throw err('governance-op', `${path}.op`, op, `'op' debe ser uno de: ${OPS.join(', ')}.`, `Usar 'in' (pertenencia) o 'eq' (escalar).`)
  }
  return { dimension: o.dimension, claim: o.claim, op: op as PredicateOp }
}

/**
 * Resuelve un store entidad-canónico a `Map<dataset → PolicyDecl>` — la MISMA estructura que el
 * store por-tabla. Fail-closed: entidad inexistente, dimensión sin mapear o gobierno ausente lanzan.
 */
export function resolveEntityStore(doc: EntityStoreDoc | undefined): Map<string, PolicyDecl> {
  const out = new Map<string, PolicyDecl>()
  const entities = new Map<string, EntityDecl>()
  for (const e of doc?.entities ?? []) {
    if (typeof e?.entity !== 'string' || e.entity.length === 0) {
      throw err('entity-name', 'entities[].entity', e?.entity, `Cada entidad debe declarar 'entity' (string).`, `Declarar 'entity'.`)
    }
    if (entities.has(e.entity)) {
      throw err('entity-duplicate', `entities[${e.entity}]`, e.entity, `Entidad '${e.entity}' declarada más de una vez.`, `Unificar la declaración de '${e.entity}'.`)
    }
    entities.set(e.entity, e)
  }

  for (const [i, m] of (doc?.datasets ?? []).entries()) {
    const path = `datasets[${i}]`
    if (typeof m?.dataset !== 'string' || m.dataset.length === 0) {
      throw err('dataset-name', `${path}.dataset`, m?.dataset, `Cada mapeo debe atar a un 'dataset' (string).`, `Declarar 'dataset'.`)
    }
    const hasGrant = m.grant != null
    const hasRealizes = m.realizes != null
    if (hasGrant && hasRealizes) {
      throw err('grant-and-realizes', path, m, `Un dataset no puede tener 'grant' y 'realizes' a la vez.`, `Usar 'realizes: <entidad>' (gobernado) o 'grant: all' (abierto), no ambos.`)
    }
    if (hasGrant) {
      if (m.grant !== 'all') {
        throw err('grant-unsupported', `${path}.grant`, m.grant, `'grant' solo soporta 'all' (apertura explícita, datos de referencia).`, `Usar 'grant: all' o quitar la entrada (sin entrada = deny).`)
      }
      out.set(m.dataset, { public: true }) // apertura explícita gobernada (trust base)
      continue
    }
    if (!hasRealizes) {
      throw err('no-realizes', path, m, `El dataset '${m.dataset}' no declara 'realizes' ni 'grant'. La omisión es deny — no declares la entrada si quieres negar.`, `Declarar 'realizes: <entidad>' o 'grant: all'.`)
    }
    const entity = entities.get(m.realizes as string)
    if (!entity) {
      throw err('unknown-entity', `${path}.realizes`, m.realizes, `El dataset realiza la entidad '${m.realizes}', que no está en el catálogo. Disponibles: ${[...entities.keys()].join(', ') || '(ninguna)'}.`, `Declarar la entidad o corregir 'realizes'.`)
    }
    const gov = entity.governed_by ?? []
    if (gov.length === 0) {
      throw err('entity-ungoverned', `entities[${entity.entity}].governed_by`, gov, `La entidad '${entity.entity}' no declara dimensiones de gobierno. Una entidad realizada debe gobernarse (o el dataset usar 'grant: all').`, `Declarar 'governed_by: [{dimension, claim, op}]' o abrir el dataset con 'grant: all'.`)
    }
    const dimsMap = (m.dimensions ?? {}) as Record<string, unknown>
    const predicates: Predicate[] = gov.map((g, gi) => {
      const { dimension, claim, op } = parseGovernance(g, entity.entity, gi)
      const column = dimsMap[dimension]
      if (typeof column !== 'string' || column.length === 0) {
        throw err(
          'dimension-unmapped',
          `${path}.dimensions.${dimension}`,
          column,
          `El dataset '${m.dataset}' realiza '${entity.entity}', gobernado por la dimensión '${dimension}', pero no mapea esa dimensión a una columna.`,
          `Declarar 'dimensions: { ${dimension}: <columna> }' en el dataset.`,
        )
      }
      return { column, claim, op }
    })
    const combine = parseCombine(entity.combine, entity.entity)
    const policy: Policy = { predicates, combine, default: 'deny' }
    out.set(m.dataset, policy)
  }
  return out
}

function parseCombine(c: unknown, entity: string): Combine {
  if (c == null) return 'and'
  if (typeof c !== 'string' || !COMBINES.includes(c as Combine)) {
    throw err('combine-invalid', `entities[${entity}].combine`, c, `'combine' debe ser 'and' u 'or'.`, `Usar 'and' (default) u 'or'.`)
  }
  return c as Combine
}
