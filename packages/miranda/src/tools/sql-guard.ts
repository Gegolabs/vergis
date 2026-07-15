/**
 * Guardia de probes SQL de Miranda. Una probe es una lectura EXPLORATORIA sobre el catálogo (allowlist
 * de instancia): un único `SELECT`, sin efectos, con `TOP 500` FORZADO server-side. Todo lo demás se
 * rechaza. NO es un regex ingenuo: bloquea multi-statement (`;`), CTEs (`WITH`), comment-smuggling
 * (`--`, `/* *​/`), DML/DDL (INSERT/UPDATE/DELETE/MERGE/DROP/ALTER/…), `SELECT … INTO`, procedimientos
 * (`EXEC`, `sp_*`, `xp_*`), lecturas fuera de catálogo (OPENROWSET/OPENQUERY/BULK) y tablas que no estén
 * en el allowlist. El `TOP` del usuario se descarta y se reemplaza por `TOP 500` (nunca se confía en él).
 *
 * Es defensa en PROFUNDIDAD, no la única: la RLS data-anchored filtra las filas aguas abajo igual. Pero
 * un agente no debe poder pedir barridos ni tocar objetos que la instancia no expuso.
 */

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SqlGuardError'
  }
}

export interface SqlGuardOptions {
  /** Nombres de objetos que una probe puede tocar (tabla/vista), p.ej. `dbo.v_saldos` o `v_saldos`. */
  allowlist: string[]
  /** Tope de filas forzado (default 500). */
  topLimit?: number
}

/** Palabras prohibidas (whole-word, case-insensitive) — cualquiera aborta la probe. */
const FORBIDDEN = [
  'insert', 'update', 'delete', 'merge', 'drop', 'alter', 'create', 'truncate',
  'grant', 'revoke', 'exec', 'execute', 'into', 'openrowset', 'openquery',
  'openjson', 'opendatasource', 'bulk', 'waitfor', 'shutdown', 'reconfigure', 'kill',
]

/** Último segmento de un nombre calificado, sin corchetes/comillas: `dbo.v_saldos` → `v_saldos`. */
function leaf(name: string): string {
  const bare = name.replace(/[[\]"`]/g, '').trim().toLowerCase()
  const parts = bare.split('.')
  return parts[parts.length - 1]
}

/** Extrae los objetos referenciados tras FROM/JOIN (ignora subqueries y funciones de tabla). */
export function referencedTables(sql: string): string[] {
  const out: string[] = []
  const re = /\b(?:from|join)\s+(\[?[a-zA-Z_][\w$]*\]?(?:\s*\.\s*\[?[a-zA-Z_][\w$]*\]?)*)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) out.push(m[1].replace(/\s+/g, ''))
  return out
}

export interface GuardedProbe {
  /** SQL saneado, con `TOP N` forzado. */
  sql: string
  /** Objetos del catálogo que la probe toca (ya verificados contra el allowlist). */
  tables: string[]
}

/**
 * Valida y sanea una probe. Lanza `SqlGuardError` con motivo accionable si no pasa; devuelve el SQL
 * reescrito con `TOP N` forzado si pasa.
 */
export function guardProbeSql(raw: string, opts: SqlGuardOptions): GuardedProbe {
  const topLimit = opts.topLimit ?? 500
  const allowLeaves = new Set(opts.allowlist.map(leaf))
  if (typeof raw !== 'string' || !raw.trim()) throw new SqlGuardError('Probe vacía.')
  let s = raw.trim().replace(/;+\s*$/, '') // un `;` final es tolerable (se quita); en medio, no

  if (/--/.test(s) || /\/\*/.test(s)) {
    throw new SqlGuardError('Comentarios SQL no permitidos en una probe (posible comment-smuggling): quita `--` y `/* */`.')
  }
  if (/;/.test(s)) throw new SqlGuardError('Solo se permite UNA sentencia por probe (encontrado `;`).')
  if (!/^select\b/i.test(s)) {
    throw new SqlGuardError('Una probe debe ser un único `SELECT` (no se permiten `WITH`/CTE, DML ni DDL).')
  }
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(s)) {
      throw new SqlGuardError(`Palabra clave no permitida en una probe: \`${kw.toUpperCase()}\`. Una probe solo lee (SELECT).`)
    }
  }
  // Objetos referenciados ⊆ allowlist (por hoja del nombre calificado).
  const refs = referencedTables(s)
  if (refs.length === 0) throw new SqlGuardError('La probe no referencia ninguna tabla del catálogo (falta FROM).')
  const outside = refs.filter((t) => !allowLeaves.has(leaf(t)))
  if (outside.length > 0) {
    throw new SqlGuardError(`Objeto(s) fuera del catálogo permitido: ${[...new Set(outside)].join(', ')}. Catálogo: ${opts.allowlist.join(', ')}.`)
  }
  // Forzar TOP N: descartar cualquier TOP del usuario y reinyectar el nuestro (nunca confiar en el suyo).
  const head = s.match(/^select\s+(distinct\s+)?/i)!
  const distinct = head[1] ? 'DISTINCT ' : ''
  let rest = s.slice(head[0].length)
  rest = rest.replace(/^top\s*\(?\s*\d+\s*\)?\s*(percent\b\s*)?/i, '') // quita TOP n / TOP (n) / TOP n PERCENT
  const guarded = `SELECT ${distinct}TOP ${topLimit} ${rest}`.trim()
  return { sql: guarded, tables: [...new Set(refs.map((t) => t.toLowerCase()))] }
}
