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
//
// El PLANO DE COLUMNA (#163 H5) entra por la MISMA puerta y con la misma gramática que el de fila:
// la regla se declara en la ENTIDAD (`columns: [{column, claim, action}]`, donde `column` es el
// atributo canónico) y cada dataset dice qué COLUMNA FÍSICA lo realiza (`columns: {atributo:
// columna}`), exactamente como `governed_by` ↔ `dimensions`. Hasta el hito 4 este archivo IGNORABA
// `columns:` en silencio: alguien escribía la protección en la entidad —la forma que el charter
// prefiere—, el resolver no la leía, y la columna se servía en claro con el autor creyendo que la
// había protegido. Ese fail-open es el peor modo de falla de una capa de autorización porque no
// deja rastro, y es lo que el hito 5 cierra acá.
//
// El HITO 7 cierra la brecha que dejó el 5: la apertura de fila solo se sabía decir en el DATASET
// (`grant: all`), y un dataset abierto no realiza entidad — así que no había dónde colgar la regla de
// columna y la capacidad quedaba disponible solo en la forma legacy. Eso dejaba fuera el caso que
// ORIGINA el issue #163: la entidad `empleado` abierta por decisión del cliente, con `full_name` y
// `rut` adentro. Por eso la apertura sube al mismo sitio donde ya vive el resto del gobierno: una
// ENTIDAD puede declararse `grant: all` (fila abierta) y aun así declarar `columns` (celda protegida).
// Los datasets la realizan con `realizes` y mapean el atributo como siempre. Un solo sitio de autoría
// —el hito 5 rechazó la regla inline en el dataset justamente para no abrir un segundo—, la misma
// gramática, y `grant: all` conserva intacta su semántica de fila: apertura explícita y gobernada.

import { VergisError } from '@vergis/botler'
import { parseColumnRules } from './frontend'
import type { ColumnRule, Combine, Policy, PolicyDecl, Predicate, PredicateOp } from './ir'

const OPS: readonly PredicateOp[] = ['in', 'eq']
const COMBINES: readonly Combine[] = ['and', 'or']
const RELATIONS: Record<string, 'descendant_of'> = { descendant_of: 'descendant_of', subordinate_of: 'descendant_of' }

/**
 * Una dimensión gobernante de una entidad: el criterio de visibilidad sobre una dimensión. Puede ser
 * PERTENENCIA (Nivel-1: `op` in/eq) o JERÁRQUICO (Nivel-2: `relation: descendant_of` recorriendo la
 * jerarquía `via`). El criterio lo declara la política; no hay discriminador universal.
 */
export interface DimensionGovernance {
  /** Nombre canónico de la dimensión (p.ej. `area`). El mapeo la liga a una columna física por dataset. */
  dimension: string
  /** Claim del gate que trae el/los valor(es) o el nodo del viewer. */
  claim: string
  /** Pertenencia: `in` (default) o `eq`. Mutuamente excluyente con `relation`. */
  op?: unknown
  /** Jerárquico: `descendant_of` (o alias `subordinate_of`). Recorre la jerarquía `via`. */
  relation?: unknown
  /** Jerarquía de referencia (dataset de cierre del trust-base) — requerido con `relation`. */
  via?: unknown
  /** Columnas del cierre (default `ancestor`/`descendant`). */
  ancestor?: unknown
  descendant?: unknown
}

/** Gobierno parseado: pertenencia o jerárquico. */
type ParsedGovernance =
  | { kind: 'membership'; dimension: string; claim: string; op: PredicateOp }
  | { kind: 'hierarchy'; dimension: string; claim: string; rel: 'descendant_of'; via: string; ancestor: string; descendant: string }

/** Una entidad de negocio canónica con su política de gobierno (autoría única). */
export interface EntityDecl {
  entity: string
  /** Dimensiones que gobiernan la entidad. Vacío/ausente → error (usa `grant: all` para abrir). */
  governed_by?: DimensionGovernance[]
  /**
   * Apertura explícita de FILA a nivel de entidad (#163 H7): `all` = todo sujeto ve todas las filas.
   * Mutuamente excluyente con `governed_by` (no vacío): declarar las dos es pedir gobierno y apertura
   * a la vez, y cualquiera de las dos lecturas deja al autor creyendo lo contrario de lo que rige.
   *
   * NO es un atajo del `grant: all` del dataset: aquel abre un dataset que no realiza entidad; este
   * abre la ENTIDAD, que sigue siendo el sitio único de autoría y por eso puede además declarar
   * `columns`. Es la forma canónica de «abierto en filas, protegido en columnas» — el caso que origina
   * el issue, y que hasta el hito 6 solo se sabía decir en la forma legacy por-tabla.
   */
  grant?: unknown
  /** Combinación de los predicados de las dimensiones (default `and`). */
  combine?: unknown
  /**
   * Plano de COLUMNA (#163 H5): reglas `{column, claim, action: mask}` sobre ATRIBUTOS canónicos de
   * la entidad — no sobre columnas físicas. Cada dataset que la realiza mapea el atributo a su
   * columna (`columns: {atributo: columna}`), igual que `dimensions` con las dimensiones.
   * Ausente ≠ `[]`: la primera es «esta entidad no dice nada de columnas» y la policy sale bit a bit
   * como antes de que este plano existiera; la segunda es «declara cero», explícita.
   */
  columns?: unknown
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
  /**
   * atributo protegido de la entidad → columna física que lo realiza en ESTE dataset (#163 H5).
   * El mapeo es OBLIGATORIO y explícito para cada atributo protegido, incluso cuando el nombre
   * coincide — igual que `dimensions`. Un default por identidad («si no lo mapeas, se llama igual»)
   * convertiría un dataset con la columna renombrada en una regla que apunta a la nada: sin error y
   * sin máscara, que es el fail-open que este plano viene a cerrar.
   */
  columns?: Record<string, unknown>
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

function parseGovernance(g: unknown, entity: string, i: number): ParsedGovernance {
  const path = `entities[${entity}].governed_by[${i}]`
  if (typeof g !== 'object' || g == null || Array.isArray(g)) {
    throw err('governance-malformed', path, g, `Cada gobierno debe ser un objeto {dimension, claim, op|relation}.`, `Corregir el gobierno ${i} de '${entity}'.`)
  }
  const o = g as Record<string, unknown>
  if (typeof o.dimension !== 'string' || o.dimension.length === 0) {
    throw err('governance-dimension', `${path}.dimension`, o.dimension, `'dimension' debe ser el nombre (string) de una dimensión canónica.`, `Declarar 'dimension'.`)
  }
  if (typeof o.claim !== 'string' || o.claim.length === 0) {
    throw err('governance-claim', `${path}.claim`, o.claim, `'claim' debe ser el nombre (string) de un claim de identidad.`, `Declarar 'claim'.`)
  }
  // Jerárquico (Nivel-2) si declara `relation`; si no, pertenencia (Nivel-1).
  if (o.relation != null) {
    if (typeof o.relation !== 'string' || !(o.relation in RELATIONS)) {
      throw err('governance-relation', `${path}.relation`, o.relation, `'relation' debe ser del vocabulario: ${Object.keys(RELATIONS).join(', ')}.`, `Usar 'descendant_of'.`)
    }
    if (typeof o.via !== 'string' || o.via.length === 0) {
      throw err('governance-via', `${path}.via`, o.via, `'via' debe nombrar la jerarquía de referencia (cierre del trust-base).`, `Declarar 'via: <jerarquía>'.`)
    }
    const ancestor = o.ancestor ?? 'ancestor'
    const descendant = o.descendant ?? 'descendant'
    if (typeof ancestor !== 'string' || typeof descendant !== 'string') {
      throw err('governance-closure-cols', path, { ancestor, descendant }, `'ancestor'/'descendant' deben ser strings.`, `Omitir o declarar nombres válidos.`)
    }
    return { kind: 'hierarchy', dimension: o.dimension, claim: o.claim, rel: RELATIONS[o.relation], via: o.via, ancestor, descendant }
  }
  const op = o.op ?? 'in'
  if (typeof op !== 'string' || !OPS.includes(op as PredicateOp)) {
    throw err('governance-op', `${path}.op`, op, `'op' debe ser uno de: ${OPS.join(', ')}.`, `Usar 'in' (pertenencia) o 'eq' (escalar).`)
  }
  return { kind: 'membership', dimension: o.dimension, claim: o.claim, op: op as PredicateOp }
}

/**
 * Resuelve un store entidad-canónico a `Map<dataset → PolicyDecl>` — la MISMA estructura que el
 * store por-tabla. Fail-closed: entidad inexistente, dimensión sin mapear o gobierno ausente lanzan.
 */
export function resolveEntityStore(doc: EntityStoreDoc | undefined): Map<string, PolicyDecl> {
  const out = new Map<string, PolicyDecl>()
  const entities = new Map<string, EntityDecl>()
  /** entidad → reglas de columna sobre atributos CANÓNICOS (aún sin columna física). */
  const entityColumns = new Map<string, ColumnRule[] | undefined>()
  /** entidad → ¿declara apertura de fila (`grant: all`)? (#163 H7) */
  const entityOpen = new Map<string, boolean>()
  for (const e of doc?.entities ?? []) {
    if (typeof e?.entity !== 'string' || e.entity.length === 0) {
      throw err('entity-name', 'entities[].entity', e?.entity, `Cada entidad debe declarar 'entity' (string).`, `Declarar 'entity'.`)
    }
    if (entities.has(e.entity)) {
      throw err('entity-duplicate', `entities[${e.entity}]`, e.entity, `Entidad '${e.entity}' declarada más de una vez.`, `Unificar la declaración de '${e.entity}'.`)
    }
    entities.set(e.entity, e)
    // Se parsea AL REGISTRAR, no al realizar: una regla malformada en una entidad que ningún dataset
    // realiza todavía rompe igual, al cargar el store. Si se parseara perezosamente, el typo viviría
    // latente hasta que alguien mapee el dataset — y ese día el error aparece lejos de su causa.
    entityColumns.set(e.entity, parseEntityColumns(e))
    entityOpen.set(e.entity, parseEntityGrant(e)) // misma razón: la apertura malformada rompe al cargar
  }

  for (const [i, m] of (doc?.datasets ?? []).entries()) {
    const path = `datasets[${i}]`
    if (typeof m?.dataset !== 'string' || m.dataset.length === 0) {
      throw err('dataset-name', `${path}.dataset`, m?.dataset, `Cada mapeo debe atar a un 'dataset' (string).`, `Declarar 'dataset'.`)
    }
    if (out.has(m.dataset)) {
      throw err('dataset-duplicate', `${path}.dataset`, m.dataset, `El dataset '${m.dataset}' está mapeado más de una vez: el last-wins silencioso podría pisar la RLS con un 'grant: all' posterior.`, `Unificar el mapeo de '${m.dataset}' en una sola entrada.`)
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
      // Un `grant: all` no realiza entidad, así que no hay atributo canónico que mapear: su `columns`
      // sería un mapeo de nada. Ignorarlo repetiría exactamente el fail-open del hito — el autor cree
      // que protegió la columna del dataset abierto. Rompe y dice dónde SÍ se declara.
      if (m.columns != null) {
        throw err(
          'grant-columns-unsupported',
          `${path}.columns`,
          m.columns,
          `El dataset '${m.dataset}' abre con 'grant: all' y además mapea columnas protegidas. En la forma entidad-canónica la regla de columna se declara en la ENTIDAD y el dataset solo la mapea; un dataset sin 'realizes' no tiene entidad de la cual mapear.`,
          `Declarar la entidad con 'grant: all' + 'columns' y usar 'realizes' acá (así la fila sigue abierta y la columna queda protegida, en un solo sitio de autoría), o expresar este caso en la forma legacy por-tabla ('policies[].grant: all' + 'policies[].columns').`,
        )
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
    // Entidad ABIERTA (#163 H7): la fila no se restringe, pero la entidad sigue siendo el sitio de
    // autoría — así que sus `columns` se resuelven EXACTAMENTE por el mismo camino que las de una
    // entidad gobernada. Lo único que cambia es la policy de fila que sale: `{public: true}`, bit a
    // bit la del `grant: all` del dataset.
    if (entityOpen.get(entity.entity)) {
      // Mapear dimensiones a una entidad abierta es la ilusión más cara de esta forma: el autor
      // escribe `dimensions: {area: area}`, cree que la fila está filtrada por área, y no lo está.
      // No se ignora: rompe y nombra la contradicción.
      if (m.dimensions != null) {
        throw err(
          'entity-open-dimensions',
          `${path}.dimensions`,
          m.dimensions,
          `El dataset '${m.dataset}' mapea dimensiones a la entidad '${entity.entity}', que está declarada 'grant: all' (abierta por fila): ese mapeo no filtraría nada.`,
          `Quitar 'dimensions' del dataset, o quitar 'grant: all' de la entidad y declarar 'governed_by'.`,
        )
      }
      const rules = resolveColumnRules(entityColumns.get(entity.entity), m, entity.entity, path)
      out.set(m.dataset, rules === undefined ? { public: true } : { public: true, columnRules: rules })
      continue
    }
    const gov = entity.governed_by ?? []
    if (gov.length === 0) {
      throw err('entity-ungoverned', `entities[${entity.entity}].governed_by`, gov, `La entidad '${entity.entity}' no declara dimensiones de gobierno. Una entidad realizada debe gobernarse, abrirse ('grant: all' en la entidad) o el dataset usar 'grant: all'.`, `Declarar 'governed_by: [{dimension, claim, op}]', o abrir explícitamente con 'grant: all' en la entidad (apertura de fila, que admite 'columns').`)
    }
    const dimsMap = (m.dimensions ?? {}) as Record<string, unknown>
    const predicates: Predicate[] = gov.map((g, gi) => {
      const parsed = parseGovernance(g, entity.entity, gi)
      const column = dimsMap[parsed.dimension]
      if (typeof column !== 'string' || column.length === 0) {
        throw err(
          'dimension-unmapped',
          `${path}.dimensions.${parsed.dimension}`,
          column,
          `El dataset '${m.dataset}' realiza '${entity.entity}', gobernado por la dimensión '${parsed.dimension}', pero no mapea esa dimensión a una columna.`,
          `Declarar 'dimensions: { ${parsed.dimension}: <columna> }' en el dataset.`,
        )
      }
      if (parsed.kind === 'hierarchy') {
        return { kind: 'hierarchy', rel: parsed.rel, column, claim: parsed.claim, via: parsed.via, ancestor: parsed.ancestor, descendant: parsed.descendant }
      }
      return { kind: 'membership', column, claim: parsed.claim, op: parsed.op }
    })
    const combine = parseCombine(entity.combine, entity.entity)
    const policy: Policy = { predicates, combine, default: 'deny' }
    // `undefined` (la entidad no dice nada de columnas) sale SIN la clave: la policy es bit a bit la
    // de antes de que este plano existiera. `[]` («declara cero») sí viaja, como en el resto del
    // front-end — declarar cero es una afirmación del autor, no una omisión.
    const rules = resolveColumnRules(entityColumns.get(entity.entity), m, entity.entity, path)
    out.set(m.dataset, rules === undefined ? policy : { ...policy, columnRules: rules })
  }
  return out
}

/**
 * `entities[].columns` → reglas de columna sobre atributos CANÓNICOS (#163 H5).
 *
 * Delega en `parseColumnRules` del front-end a propósito: el vocabulario de columna y sus códigos de
 * error (`columns-malformed`, `column-rule-shape/column/claim/action`, `column-rule-unknown-key`) ya
 * quedaron fijados para el spec y para el store legacy. Reimplementarlos acá daría un segundo
 * dialecto del mismo error — dos mensajes para la misma falta, divergiendo en la primera corrección.
 * Lo único propio es el `path`, que acá sí se sabe exacto.
 */
function parseEntityColumns(e: EntityDecl): ColumnRule[] | undefined {
  return parseColumnRules(e.columns, `entities[${e.entity}].columns`)
}

/**
 * `entities[].grant` → ¿la entidad abre la fila? (#163 H7)
 *
 * Se valida al REGISTRAR la entidad, no al realizarla, por la misma razón que las reglas de columna:
 * un `grant: publico` (o `grant: true`) en una entidad que ningún dataset realiza todavía es un error
 * de autoría que debe aparecer al cargar el store, no el día lejano en que alguien mapee el dataset.
 *
 * Reusa el código `grant-unsupported` del dataset a propósito: es la MISMA falta —un valor fuera del
 * único soportado— y el `path` ya dice cuál de los dos sitios la cometió. Dos códigos para la misma
 * falta serían dos mensajes que divergen en la primera corrección.
 */
function parseEntityGrant(e: EntityDecl): boolean {
  if (e.grant == null) return false
  if (e.grant !== 'all') {
    throw err('grant-unsupported', `entities[${e.entity}].grant`, e.grant, `'grant' de una entidad solo soporta 'all' (apertura explícita de fila).`, `Usar 'grant: all' o declarar 'governed_by' (gobierno por dimensión).`)
  }
  // Gobierno Y apertura a la vez no tiene lectura única: si ganara `grant`, la RLS declarada no
  // aplicaría (fail-open silencioso); si ganara `governed_by`, la apertura no abriría. Rompe.
  // `governed_by: []` («declara cero») no contradice: no hay gobierno que quede sin efecto.
  const gov = e.governed_by
  if (Array.isArray(gov) ? gov.length > 0 : gov != null) {
    throw err(
      'entity-grant-and-governed',
      `entities[${e.entity}].grant`,
      { grant: e.grant, governed_by: gov },
      `La entidad '${e.entity}' declara 'grant: all' (fila abierta) y además 'governed_by' (fila gobernada). Las dos a la vez no tienen lectura única, y cualquiera que ganara dejaría al autor creyendo lo contrario de lo que rige.`,
      `Dejar 'governed_by' (gobernada por fila) o 'grant: all' (abierta). La protección de COLUMNA ('columns') convive con ambas.`,
    )
  }
  return true
}

/**
 * Liga las reglas canónicas de la entidad a las COLUMNAS FÍSICAS de un dataset (#163 H5) —
 * la contraparte de `dimensions` para el plano de columna.
 *
 * Fail-closed en las dos direcciones, y las dos cierran fail-opens distintos:
 *   · atributo protegido SIN mapear → rompe: la alternativa (default por identidad) produce una regla
 *     que apunta a una columna inexistente, que no enmascara nada y no avisa;
 *   · clave mapeada que la entidad NO protege → rompe: es un typo en el mapa, y su efecto silencioso
 *     es dejar el atributo real sin mapear... o peor, creerlo mapeado.
 */
function resolveColumnRules(rules: ColumnRule[] | undefined, m: DatasetMappingDecl, entity: string, path: string): ColumnRule[] | undefined {
  const raw = m.columns
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw err('column-map-malformed', `${path}.columns`, raw, `'columns' de un dataset es un MAPEO atributo → columna física, no una lista de reglas. Las reglas se declaran en la entidad.`, `Declarar 'columns: { <atributo>: <columna física> }'.`)
  }
  const map = (raw ?? {}) as Record<string, unknown>
  const protegidos = new Set((rules ?? []).map((r) => r.column))
  for (const k of Object.keys(map)) {
    if (!protegidos.has(k)) {
      throw err(
        'column-mapping-unknown',
        `${path}.columns.${k}`,
        map[k],
        `El dataset '${m.dataset}' mapea el atributo '${k}', que la entidad '${entity}' no declara como columna protegida. Protegidos: ${[...protegidos].join(', ') || '(ninguno)'}.`,
        `Corregir el nombre del atributo o declararlo en 'entities[${entity}].columns'.`,
      )
    }
  }
  if (rules === undefined) return undefined
  return rules.map((r) => {
    const column = map[r.column]
    if (typeof column !== 'string' || column.length === 0) {
      throw err(
        'column-unmapped',
        `${path}.columns.${r.column}`,
        column,
        `El dataset '${m.dataset}' realiza '${entity}', que protege el atributo '${r.column}', pero no mapea ese atributo a una columna física. Sin mapeo la regla no enmascararía nada — y en silencio.`,
        `Declarar 'columns: { ${r.column}: <columna física> }' en el dataset (explícito aunque el nombre coincida).`,
      )
    }
    return { column, claim: r.claim, action: 'mask' as const }
  })
}

function parseCombine(c: unknown, entity: string): Combine {
  if (c == null) return 'and'
  if (typeof c !== 'string' || !COMBINES.includes(c as Combine)) {
    throw err('combine-invalid', `entities[${entity}].combine`, c, `'combine' debe ser 'and' u 'or'.`, `Usar 'and' (default) u 'or'.`)
  }
  return c as Combine
}
