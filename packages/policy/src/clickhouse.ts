// Back-end ClickHouse del compilador (doc 9 §4, doc 10): Policy IR → enforcement.
//
// Materializa la RECETA validada por el PoC de Fase 0:
//   USING has(splitByChar(',', getSetting('vergis_claim_<claim>')), <column>)
// con un guard `!= ''` que endurece el default-deny (el PoC no lo tenía; acá cubre
// también filas con columna vacía). La inyección de claims es por custom setting
// (request-scoped), análogo a SESSION_CONTEXT — el Botler la escribe, jamás el consumidor.
//
// Cubre SOLO el plano de FILA. El plano de COLUMNA (#163) es capacidad NO SOPORTADA en este
// back-end y se rechaza al compilar (ver `assertNoColumnRules`): no hay dónde sustituir una celda
// sin sacar la autorización del motor. Fail-closed — jamás se sirve la columna en claro.
//
// Incluye un EMULADOR SEMÁNTICO de la expresión generada: replica la semántica de
// ClickHouse (has/splitByChar/eq + guard) en TS, para property-testear el codegen
// contra el evaluador de referencia del IR SIN levantar un motor (doc 10 §9 #2, differential).

import { VergisError } from '@vergis/botler'
import {
  claimValues,
  columnRules,
  isHierarchy,
  isPublic,
  type ClaimSet,
  type Policy,
  type PolicyDecl,
  type Predicate,
  type ReferenceData,
} from './ir'
import { SETTINGS_PREFIX, ident, settingForClaim } from './codegen-common'

/** Identificador calificado (p.ej. `db.tabla` de una jerarquía de referencia): cada parte segura. */
function qualifiedIdent(kind: string, value: string): string {
  return value.split('.').map((part) => ident(kind, part)).join('.')
}

export interface ClickHouseTarget {
  /** Base de datos del store. */
  database: string
  /** Tabla servida (sobre la que se crea la policy). */
  table: string
  /** Rol del consumidor al que aplica la policy (TO). */
  role: string
  /** Nombre de la policy; default derivado de la tabla. */
  policyName?: string
}

export interface ClickHouseEnforcement {
  /** Prefijo de custom settings a habilitar en el server (config.d). */
  prefix: string
  /** Snippet de config para habilitar el prefijo. */
  customSettingsPrefixesXml: string
  /** El `CREATE ROW POLICY` (specialize-time, una vez). */
  rowPolicySQL: string
  /** Qué setting se inyecta desde qué claim (request-time, por consumidor). */
  injections: { setting: string; claim: string }[]
  /** El IR compilado (para emulación/aserciones). */
  policy: PolicyDecl
}

/** Expresión USING de un predicado (la receta ClickHouse), con guard de default-deny. */
function predicateExpr(pred: Predicate): string {
  const col = ident('column', pred.column)
  const setting = settingForClaim(pred.claim)
  const get = `getSetting('${setting}')`
  if (isHierarchy(pred)) {
    // Nivel-2 (charter §4b): row[column] ∈ descendientes del nodo del viewer en la jerarquía `via`.
    // Subquery al cierre con el nodo del viewer inyectado (lista por coma → soporta multi-nodo).
    const via = qualifiedIdent('via', pred.via)
    const anc = ident('ancestor', pred.ancestor)
    const desc = ident('descendant', pred.descendant)
    return `(${get} != '' AND ${col} IN (SELECT ${desc} FROM ${via} WHERE has(splitByChar(',', ${get}), ${anc})))`
  }
  if (pred.op === 'eq') {
    // Guard de cardinalidad: un claim multi-valor se inyecta como 'a,b'; sin el `position(...) = 0`
    // una celda que contenga literalmente 'a,b' pasaría (over-grant). La referencia `eq` exige UN valor.
    return `(${get} != '' AND position(${get}, ',') = 0 AND ${col} = ${get})`
  }
  // in (membresía)
  return `(${get} != '' AND has(splitByChar(',', ${get}), ${col}))`
}

/**
 * PLANO DE COLUMNA (#163 H3): **este back-end NO lo soporta, y por eso ROMPE.**
 *
 * El diseño (§4.1) dejaba dos salidas: enmascarar en la proyección, o declarar la capacidad no
 * soportada — fail-closed. Se declara no soportada, y el porqué está en lo que este back-end emite,
 * que es exactamente DOS cosas y ninguna puede sustituir el valor de una celda:
 *
 *   1. `rowPolicySQL` — un `CREATE ROW POLICY ... FOR SELECT USING <expr>`. La expresión es un
 *      PREDICADO booleano por fila: decide si la fila pasa, no qué valor lleva. ClickHouse no tiene
 *      equivalente de `MASKED WITH` (lo más cercano, `GRANT SELECT(col)`, RETIRA la columna — cambia
 *      la forma del resultado, que es justo lo que §4.1 descarta: mentimos el valor, jamás el esquema).
 *   2. `injections` — nombres/valores de custom settings. Transportan el claim; no tocan la proyección.
 *
 * **Y la proyección no es nuestra.** El SQL que llega al motor lo escribe el consumidor de la
 * capability (`packages/capabilities/src/execute-sql-ch.ts` manda `params.sql` verbatim al transporte;
 * el compilador nunca ve ni emite un `SELECT`). Enmascarar «en la proyección» exigiría reescribir SQL
 * arbitrario del consumidor, o pedirle que recorte columnas él — las dos mueven la autorización FUERA
 * del motor y al plano equivocado: authz que depende de que el llamador coopere no es authz.
 *
 * La trampa que esto cierra es la de siempre en el plano de columna: si el compilador ignorara las
 * reglas y emitiera el mismo `CREATE ROW POLICY` de siempre, la entidad se serviría **en claro**, con
 * el gobierno declarado y sin señal de que no se aplicó. Servir en claro no es una degradación
 * aceptable: es el fallo. Por eso el PI no se sirve.
 *
 * Alternativas reales para quien tope con esto: servir esa entidad por un back-end que sí enmascare
 * (Fabric, `MASKED WITH`), o no cargar la columna al store de ClickHouse. Nunca «sacar la regla».
 */
function assertNoColumnRules(policy: PolicyDecl, table: string): void {
  const rules = columnRules(policy)
  if (rules.length === 0) return // el caso normal: sin reglas, este back-end no cambia en nada
  const columns = [...new Set(rules.map((r) => r.column))]
  throw new VergisError({
    error: 'policy/compile',
    code: 'column-masking-unsupported',
    path: 'audience.columns',
    value: columns,
    message:
      `El back-end ClickHouse no sabe enmascarar columnas (${columns.join(', ')}): su enforcement es ` +
      `ROW POLICY (filtro de FILA) más inyección de claims, y la proyección la escribe el consumidor, ` +
      `no el compilador. La tabla '${table}' NO se sirve: la alternativa a la máscara no es servir la ` +
      `columna en claro.`,
    remediation:
      `Servir esta entidad por un back-end con enmascaramiento nativo (Fabric, MASKED WITH), o no ` +
      `cargar la columna sensible al store ClickHouse. Retirar la regla de columna serviría el dato en claro.`,
  })
}

/** Compila el IR a enforcement de ClickHouse. `public` (grant: all) → ROW POLICY ALLOW-ALL
 *  (`USING 1`): la policy EXISTE y permite toda fila — espejo del allow-all de Fabric. */
export function compileClickHouse(policy: PolicyDecl, target: ClickHouseTarget): ClickHouseEnforcement {
  const db = ident('database', target.database)
  const table = ident('table', target.table)
  const role = ident('role', target.role)
  const policyName = ident('policyName', target.policyName ?? `pol_${table}`)
  const xml = `<clickhouse><custom_settings_prefixes>${SETTINGS_PREFIX.replace(/_$/, '')}_</custom_settings_prefixes></clickhouse>`
  const rowPolicy = (using: string) =>
    // `OR REPLACE`: idempotente (re-especializar la misma tabla no falla por "already exists"),
    // simétrico con el setup drop-and-recreate de Fabric.
    `CREATE ROW POLICY OR REPLACE ${policyName} ON ${db}.${table}\n    FOR SELECT\n    USING ${using}\n    AS permissive\n    TO ${role};`

  // Antes que nada, y ANTES de la rama pública: un PI público con una columna sensible es
  // precisamente el driver que nombra el diseño (§6), y sería el que más silenciosamente fugaría.
  assertNoColumnRules(policy, `${db}.${table}`)

  // PÚBLICO (grant: all) → ROW POLICY allow-all (`USING 1`); la policy existe y permite toda fila.
  if (isPublic(policy)) {
    return { prefix: SETTINGS_PREFIX, customSettingsPrefixesXml: xml, rowPolicySQL: rowPolicy('1'), injections: [], policy }
  }

  const combiner = policy.combine === 'or' ? ' OR ' : ' AND '
  const using =
    policy.predicates.length === 0
      ? '0' // deny-all explícito (sin predicados)
      : policy.predicates.map(predicateExpr).join(combiner)

  // Una inyección por claim distinto (varios predicados que usan el mismo claim comparten setting).
  const claims = [...new Set(policy.predicates.map((p) => p.claim))]
  const injections = claims.map((claim) => ({ setting: settingForClaim(claim), claim }))

  return { prefix: SETTINGS_PREFIX, customSettingsPrefixesXml: xml, rowPolicySQL: rowPolicy(using), injections, policy }
}

/**
 * Request-time: calcula los valores de los settings a inyectar desde los claims del
 * consumidor. Lo invoca el Botler (jamás el consumidor). Fail-closed:
 *  - valores vacíos se descartan (un claim vacío = sin claim → deny);
 *  - un valor con coma se RECHAZA (rompería el encoding delimitado por coma).
 */
export function requestSettings(enforcement: ClickHouseEnforcement, claims: ClaimSet): Record<string, string> {
  return settingsForInjections(enforcement.injections, claims)
}

/**
 * Igual que `requestSettings` pero sobre una lista de inyecciones arbitraria — para servir VARIAS
 * tablas/políticas con UN solo canal: el nodo inyecta la UNIÓN de los claims de todas sus políticas.
 */
export function settingsForInjections(
  injections: { setting: string; claim: string }[],
  claims: ClaimSet,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const inj of injections) {
    const values = claimValues(claims, inj.claim).filter((v) => v.length > 0)
    for (const v of values) {
      if (v.includes(',')) {
        throw new VergisError({
          error: 'policy/inject',
          code: 'claim-value-has-comma',
          path: inj.claim,
          value: v,
          message: `El valor de claim '${v}' contiene coma; rompería el encoding del setting.`,
          remediation: 'Normalizar los valores del claim (sin comas) en el IdP, o usar otro encoding.',
        })
      }
    }
    out[inj.setting] = values.join(',')
  }
  return out
}

// --- Emulador semántico (differential testing, sin motor vivo) --------------

/** splitByChar(',', s) de ClickHouse. */
function splitByChar(s: string): string[] {
  return s === '' ? [] : s.split(',') // guard `!= ''` ya cubre el caso vacío en la expr
}

/** Evalúa la expresión generada con la semántica de ClickHouse, dado el mapa de settings.
 *  `refs` aporta los cierres de las jerarquías (`via`) para los predicados Nivel-2 (subquery). */
export function emulate(
  enforcement: ClickHouseEnforcement,
  settings: Record<string, string>,
  row: Record<string, unknown>,
  refs: ReferenceData = {},
): boolean {
  const { policy } = enforcement
  if (isPublic(policy)) return true // allow-all: toda fila pasa
  if (policy.predicates.length === 0) return false
  const evalPred = (pred: Predicate): boolean => {
    const setting = settingForClaim(pred.claim)
    const s = settings[setting] ?? '' // getSetting default ''
    if (s === '') return false // el guard `!= ''`
    const cell = row[pred.column] == null ? '' : String(row[pred.column])
    if (isHierarchy(pred)) {
      // subquery al cierre: descendientes de los nodos del viewer (s, lista por coma)
      const ancestors = new Set(splitByChar(s))
      const closure = refs[pred.via] ?? []
      const visible = new Set(
        closure
          .filter((r) => ancestors.has(String((r as Record<string, unknown>)[pred.ancestor] ?? r.ancestor)))
          .map((r) => String((r as Record<string, unknown>)[pred.descendant] ?? r.descendant)),
      )
      return visible.has(cell)
    }
    if (pred.op === 'eq') return !s.includes(',') && cell === s // guard de cardinalidad (multi-valor → deny)
    return splitByChar(s).includes(cell)
  }
  const results = policy.predicates.map(evalPred)
  return policy.combine === 'or' ? results.some(Boolean) : results.every(Boolean)
}
