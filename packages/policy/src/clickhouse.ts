// Back-end ClickHouse del compilador (doc 9 §4, doc 10): Policy IR → enforcement.
//
// Materializa la RECETA validada por el PoC de Fase 0:
//   USING has(splitByChar(',', getSetting('vergis_claim_<claim>')), <column>)
// con un guard `!= ''` que endurece el default-deny (el PoC no lo tenía; acá cubre
// también filas con columna vacía). La inyección de claims es por custom setting
// (request-scoped), análogo a SESSION_CONTEXT — el Botler la escribe, jamás el consumidor.
//
// Incluye un EMULADOR SEMÁNTICO de la expresión generada: replica la semántica de
// ClickHouse (has/splitByChar/eq + guard) en TS, para property-testear el codegen
// contra el evaluador de referencia del IR SIN levantar un motor (doc 10 §9 #2, differential).

import { VergisError } from '@vergis/botler'
import {
  claimValues,
  isPublic,
  type ClaimSet,
  type Policy,
  type PolicyDecl,
  type Predicate,
} from './ir'

export const SETTINGS_PREFIX = 'vergis_'

/** Identificadores seguros (columna, claim, rol, tabla): evita inyección por nombre. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

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
  policy: Policy
}

function ident(kind: string, value: string): string {
  if (!SAFE_IDENT.test(value)) {
    throw new VergisError({
      error: 'policy/codegen',
      code: 'unsafe-identifier',
      path: kind,
      value,
      message: `'${value}' no es un identificador seguro para ${kind} (esperado ${SAFE_IDENT}).`,
      remediation: `Usar solo letras, dígitos y guion bajo en ${kind}.`,
    })
  }
  return value
}

/** Nombre del custom setting que transporta los valores permitidos de un claim. */
export function settingForClaim(claim: string): string {
  return `${SETTINGS_PREFIX}claim_${ident('claim', claim)}`
}

/** Expresión USING de un predicado (la receta ClickHouse), con guard de default-deny. */
function predicateExpr(pred: Predicate): string {
  const col = ident('column', pred.column)
  const setting = settingForClaim(pred.claim)
  const get = `getSetting('${setting}')`
  if (pred.op === 'eq') {
    return `(${get} != '' AND ${col} = ${get})`
  }
  // in (membresía)
  return `(${get} != '' AND has(splitByChar(',', ${get}), ${col}))`
}

/** Compila el IR a enforcement de ClickHouse. `public` no genera policy. */
export function compileClickHouse(policy: PolicyDecl, target: ClickHouseTarget): ClickHouseEnforcement | null {
  if (isPublic(policy)) return null // PI público: sin RLS de fila (solo gate)

  const db = ident('database', target.database)
  const table = ident('table', target.table)
  const role = ident('role', target.role)
  const policyName = ident('policyName', target.policyName ?? `pol_${table}`)

  const combiner = policy.combine === 'or' ? ' OR ' : ' AND '
  const using =
    policy.predicates.length === 0
      ? '0' // deny-all explícito (sin predicados)
      : policy.predicates.map(predicateExpr).join(combiner)

  const rowPolicySQL =
    `CREATE ROW POLICY ${policyName} ON ${db}.${table}\n` +
    `    FOR SELECT\n` +
    `    USING ${using}\n` +
    `    AS permissive\n` +
    `    TO ${role};`

  // Una inyección por claim distinto (varios predicados que usan el mismo claim comparten setting).
  const claims = [...new Set(policy.predicates.map((p) => p.claim))]
  const injections = claims.map((claim) => ({ setting: settingForClaim(claim), claim }))

  return {
    prefix: SETTINGS_PREFIX,
    customSettingsPrefixesXml: `<clickhouse><custom_settings_prefixes>${SETTINGS_PREFIX.replace(/_$/, '')}_</custom_settings_prefixes></clickhouse>`,
    rowPolicySQL,
    injections,
    policy,
  }
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

/** Evalúa la expresión generada con la semántica de ClickHouse, dado el mapa de settings. */
export function emulate(
  enforcement: ClickHouseEnforcement,
  settings: Record<string, string>,
  row: Record<string, unknown>,
): boolean {
  const { policy } = enforcement
  if (policy.predicates.length === 0) return false
  const evalPred = (pred: Predicate): boolean => {
    const setting = settingForClaim(pred.claim)
    const s = settings[setting] ?? '' // getSetting default ''
    if (s === '') return false // el guard `!= ''`
    const cell = row[pred.column] == null ? '' : String(row[pred.column])
    if (pred.op === 'eq') return cell === s
    return splitByChar(s).includes(cell)
  }
  const results = policy.predicates.map(evalPred)
  return policy.combine === 'or' ? results.some(Boolean) : results.every(Boolean)
}
