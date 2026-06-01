// Back-end Fabric / Azure SQL del compilador (doc 9 §4, doc 10) — el MOTOR C (push-down):
// Policy IR → enforcement NATIVO de la fuente, sin replicar (premisa B1). Cuando la fuente
// es un lakehouse con RLS (Fabric SQL endpoint, Azure SQL), la política se hace cumplir AHÍ.
//
// Materializa el patrón validado por el probe del 2026-06-01 contra `lh_qw04` real:
//   - specialize-time (DDL, una vez): un PREDICADO (inline TVF, WITH SCHEMABINDING) que lee
//     SESSION_CONTEXT('vergis_claim_<claim>') + guard `<> ''` + STRING_SPLIT (membresía) o
//     igualdad escalar, combinado AND/OR; y una SECURITY POLICY que lo ata como FILTER
//     PREDICATE a la tabla. Es el `CREATE ROW POLICY` de ClickHouse, en dialecto T-SQL.
//   - request-time (por consumidor): `sp_set_session_context` inyecta el claim ANTES de la
//     query. Es el query-param HTTP de ClickHouse, en dialecto T-SQL.
//
// NUANCE DE SEGURIDAD (doc 10 §5, crítico): SESSION_CONTEXT PERSISTE en la conexión. Con un
// pool, una conexión reusada arrastra el claim del consumidor anterior → fuga. Por eso NO se
// usa `@read_only` (haría imposible resetear); en su lugar `execute-sql-dwh` reinyecta TODAS
// las settings del nodo en CADA request (con '' para claims ausentes), sobreescribiendo
// cualquier residuo → request-scoped + default-deny. Ver `sessionContextPrelude`.
//
// Incluye un EMULADOR SEMÁNTICO de la expresión generada (STRING_SPLIT/eq + guard), para
// property-testear el codegen contra el evaluador de referencia del IR SIN motor vivo
// (doc 10 §9 #2, differential) — el mismo oráculo que el back-end ClickHouse.

import { VergisError } from '@vergis/botler'
import { settingsForInjections } from './clickhouse'
import {
  isHierarchy,
  isPublic,
  type ClaimSet,
  type Policy,
  type PolicyDecl,
  type Predicate,
  type ReferenceData,
} from './ir'

export const SETTINGS_PREFIX = 'vergis_'

/** Identificadores seguros (columna, claim, schema, tabla, nombres): evita inyección por nombre. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Tipo SQL por defecto del parámetro del predicado (la celda se compara contra NVARCHAR). */
const DEFAULT_COLUMN_TYPE = 'NVARCHAR(4000)'

export interface FabricTarget {
  /** Schema de la tabla servida (Fabric/Azure SQL); default `dbo`. */
  schema?: string
  /** Tabla sobre la que se crea la security policy. */
  table: string
  /** Tipo SQL del parámetro del predicado por columna; default `NVARCHAR(4000)`. */
  columnTypes?: Record<string, string>
  /** Nombre de la función predicado; default derivado de la tabla. */
  functionName?: string
  /** Nombre de la security policy; default derivado de la tabla. */
  policyName?: string
}

export interface FabricEnforcement {
  /** Prefijo de las custom settings (transportadas vía SESSION_CONTEXT). */
  prefix: string
  /** DDL idempotente para instalar el predicado + la security policy (specialize-time). En orden. */
  setupSQL: string[]
  /** DDL para desinstalar (DROP policy → DROP function). En orden; reversible. */
  teardownSQL: string[]
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

/** El tipo de columna debe ser un tipo SQL plausible: letras/dígitos/_ y opcional `(n)` o `(n,m)`. */
function columnType(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/.test(value)) {
    throw new VergisError({
      error: 'policy/codegen',
      code: 'unsafe-column-type',
      path: 'columnTypes',
      value,
      message: `'${value}' no es un tipo SQL seguro para el parámetro del predicado.`,
      remediation: `Usar un tipo como NVARCHAR(4000), INT, BIGINT.`,
    })
  }
  return value
}

/** Nombre del custom setting que transporta los valores permitidos de un claim. */
export function settingForClaim(claim: string): string {
  return `${SETTINGS_PREFIX}claim_${ident('claim', claim)}`
}

/** Lee el SESSION_CONTEXT de un claim como NVARCHAR(MAX). */
function sessionRead(claim: string): string {
  return `CAST(SESSION_CONTEXT(N'${settingForClaim(claim)}') AS NVARCHAR(MAX))`
}

/** Referencia T-SQL calificada `[schema].[tabla]` de la jerarquía `via` (default al schema del target). */
function qualifyRef(via: string, schema: string): string {
  const parts = via.split('.')
  if (parts.length === 2) return `[${ident('via.schema', parts[0])}].[${ident('via.table', parts[1])}]`
  return `[${schema}].[${ident('via', via)}]`
}

/** Cláusula WHERE de un predicado en T-SQL, con guard de default-deny (`<> ''`). */
function predicateClause(pred: Predicate, schema: string): string {
  const col = ident('column', pred.column)
  const read = sessionRead(pred.claim)
  if (isHierarchy(pred)) {
    // Nivel-2 (charter §4b): @column ∈ descendientes del nodo del viewer en la jerarquía `via`.
    const ref = qualifyRef(pred.via, schema)
    const anc = ident('ancestor', pred.ancestor)
    const desc = ident('descendant', pred.descendant)
    return (
      `(${read} <> N'' AND @${col} IN (` +
      `SELECT ${desc} FROM ${ref} WHERE ${anc} IN (SELECT value FROM STRING_SPLIT(${read}, N','))))`
    )
  }
  if (pred.op === 'eq') {
    return `(${read} <> N'' AND @${col} = ${read})`
  }
  // in (membresía): STRING_SPLIT del valor delimitado por coma (el `splitByChar`/`has` de ClickHouse)
  return `(${read} <> N'' AND @${col} IN (SELECT value FROM STRING_SPLIT(${read}, N',')))`
}

/**
 * Compila el IR a enforcement de Fabric / Azure SQL (push-down). `public` no genera policy
 * (solo gatea el reporte; sin RLS de fila).
 */
export function compileFabric(policy: PolicyDecl, target: FabricTarget): FabricEnforcement | null {
  if (isPublic(policy)) return null

  const schema = ident('schema', target.schema ?? 'dbo')
  const table = ident('table', target.table)
  const fnName = ident('functionName', target.functionName ?? `fn_pol_${table}`)
  const polName = ident('policyName', target.policyName ?? `secpol_${table}`)
  const q = (name: string) => `[${schema}].[${name}]`
  const qTable = `[${schema}].[${table}]`

  // Columnas DISTINTAS referenciadas → parámetros del predicado (en orden estable de aparición).
  const columns = [...new Set(policy.predicates.map((p) => ident('column', p.column)))]
  const paramDecls = columns.map((c) => `@${c} ${columnType(target.columnTypes?.[c] ?? DEFAULT_COLUMN_TYPE)}`).join(', ')
  const predicateArgs = columns.join(', ')

  const combiner = policy.combine === 'or' ? ' OR ' : ' AND '
  const whereExpr =
    policy.predicates.length === 0
      ? '1 = 0' // deny-all explícito (sin predicados)
      : policy.predicates.map((p) => predicateClause(p, schema)).join(combiner)

  const createFunction =
    `CREATE FUNCTION ${q(fnName)}(${paramDecls})\n` +
    `    RETURNS TABLE\n` +
    `    WITH SCHEMABINDING\n` +
    `    AS RETURN\n` +
    `        SELECT 1 AS vergis_allowed\n` +
    `        WHERE ${whereExpr};`

  const createPolicy =
    `CREATE SECURITY POLICY ${q(polName)}\n` +
    `    ADD FILTER PREDICATE ${q(fnName)}(${predicateArgs}) ON ${qTable}\n` +
    `    WITH (STATE = ON);`

  const teardownSQL = [
    `DROP SECURITY POLICY IF EXISTS ${q(polName)};`,
    `DROP FUNCTION IF EXISTS ${q(fnName)};`,
  ]

  return {
    prefix: SETTINGS_PREFIX,
    // Idempotente: tirar lo previo (policy antes que función por la dependencia de SCHEMABINDING) y recrear.
    setupSQL: [...teardownSQL, createFunction, createPolicy],
    teardownSQL,
    injections: [...new Set(policy.predicates.map((p) => p.claim))].map((claim) => ({ setting: settingForClaim(claim), claim })),
    policy,
  }
}

// --- Request-time: inyección por SESSION_CONTEXT ----------------------------

export interface SessionContextPrelude {
  /** Batch `EXEC sp_set_session_context ...` a anteponer a la query (un statement por inyección). */
  sql: string
  /** Parámetros a bindear (el VALOR del claim viaja parametrizado → injection-safe). */
  params: { name: string; value: string }[]
}

/**
 * Calcula el prelude `sp_set_session_context` para los claims del consumidor. Lo invoca el
 * Botler (vía `execute-sql-dwh`), jamás el consumidor.
 *
 * SEGURIDAD (la nuance del doc 10 §5): se emite UN statement por CADA inyección del nodo,
 * incluidas las de claim ausente (valor ''). Reinyectar TODO en cada request sobreescribe el
 * SESSION_CONTEXT que pudiera quedar de un consumidor previo en una conexión del pool → no
 * fuga, y el '' dispara el guard `<> ''` de la policy → default-deny. NO se usa `@read_only`
 * (impediría el reseteo en el próximo request sobre la misma conexión).
 *
 * El nombre del setting (@key) es identificador validado → literal seguro; el VALOR va
 * parametrizado (`@vergis_sc_N`) → el claim nunca se concatena al SQL (injection-safe, como
 * el query-param de ClickHouse).
 */
export function sessionContextPrelude(
  injections: { setting: string; claim: string }[],
  claims: ClaimSet,
): SessionContextPrelude {
  // Reusa el cálculo del back-end ClickHouse: una entrada por inyección (incl. vacías), rechaza comas.
  const values = settingsForInjections(injections, claims)
  const lines: string[] = []
  const params: { name: string; value: string }[] = []
  injections.forEach((inj, i) => {
    const setting = settingForClaim(inj.claim) // re-valida el identificador
    const paramName = `vergis_sc_${i}`
    lines.push(`EXEC sys.sp_set_session_context @key = N'${setting}', @value = @${paramName};`)
    params.push({ name: paramName, value: values[inj.setting] ?? '' })
  })
  return { sql: lines.join('\n'), params }
}

// --- Emulador semántico (differential testing, sin motor vivo) --------------

/** STRING_SPLIT(s, ',') de T-SQL (sin filas para cadena vacía; el guard `<> ''` ya la corta). */
function stringSplit(s: string): string[] {
  return s === '' ? [] : s.split(',')
}

/** Evalúa la expresión generada con la semántica de T-SQL, dado el mapa de settings.
 *  `refs` aporta los cierres de las jerarquías (`via`) para los predicados Nivel-2 (subquery). */
export function emulateFabric(
  enforcement: FabricEnforcement,
  settings: Record<string, string>,
  row: Record<string, unknown>,
  refs: ReferenceData = {},
): boolean {
  const { policy } = enforcement
  if (policy.predicates.length === 0) return false
  const evalPred = (pred: Predicate): boolean => {
    const s = settings[settingForClaim(pred.claim)] ?? '' // SESSION_CONTEXT ausente → NULL → CAST '' por el guard
    if (s === '') return false // el guard `<> ''`
    const cell = row[pred.column] == null ? '' : String(row[pred.column])
    if (isHierarchy(pred)) {
      const ancestors = new Set(stringSplit(s))
      const closure = refs[pred.via] ?? []
      const visible = new Set(
        closure
          .filter((r) => ancestors.has(String((r as Record<string, unknown>)[pred.ancestor] ?? r.ancestor)))
          .map((r) => String((r as Record<string, unknown>)[pred.descendant] ?? r.descendant)),
      )
      return visible.has(cell)
    }
    if (pred.op === 'eq') return cell === s
    return stringSplit(s).includes(cell)
  }
  const results = policy.predicates.map(evalPred)
  return policy.combine === 'or' ? results.some(Boolean) : results.every(Boolean)
}
