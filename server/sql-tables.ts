// Extracción de las tablas que referencia un SQL — la ÚNICA fuente del GATE DE GOBERNANZA fail-closed
// del push-down (serve-rls): toda tabla que un PI toca debe tener política, o el PI no se sirve. En
// Fabric una tabla SIN política devuelve TODAS sus filas (el motor no niega por omisión), así que una
// tabla que esta función NO vea se serviría sin verificar → fuga. Por eso cubre las tres formas
// idiomáticas de T-SQL/Fabric que la extracción ingenua se saltaba:
//   · corchetes:       FROM [dbo].[fct_cartera]
//   · comillas dobles: FROM "schema"."tabla"
//   · comma-joins:     FROM dbo.a, dbo.b     (la 2ª tabla escapaba a la regex vieja)
// La salida se normaliza a `schema.tabla` SIN corchetes/comillas y en MINÚSCULA — consistente con las
// claves del policy store (convención del proyecto; T-SQL/Fabric es case-insensitive por colación).
//
// Referencias de UNA sola parte (`FROM dim_area`): el policy store se indexa por `schema.tabla`, así
// que una single-part NO es verificable contra política → el gate debe tratarla como NO GOBERNABLE
// (fail-closed: el PI se omite con warn), no dejarla pasar sin verificar. EXCEPCIÓN: los nombres
// declarados en un `WITH <nombre> AS (` (CTEs) son tablas virtuales de la propia query — se excluyen.

/** Un identificador SQL: entre corchetes, entre comillas dobles, o desnudo. */
const IDENT = String.raw`(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_]\w*)`
/** Referencia a tabla CON esquema: dos o más partes punteadas (schema.tabla, db.schema.tabla). */
const REF = new RegExp(`^${IDENT}(?:\\s*\\.\\s*${IDENT})+`)
/** Referencia de UNA sola parte (sin punto): no verificable contra el policy store. */
const SINGLE = new RegExp(`^${IDENT}(?!\\s*\\.)`)
/** Inicio de una región de tablas: tras FROM o JOIN. */
const HEADS = /\b(?:from|join)\b/gi
/**
 * Fin de la región de tablas de un FROM/JOIN: el siguiente keyword de cláusula, un paréntesis (subquery)
 * o un `;`. Recortar la región a las tablas evita capturar columnas calificadas (`t.col`) del SELECT o
 * del ON/WHERE como si fueran tablas (falsos positivos que rechazarían specs válidas).
 */
const BOUNDARY = /\b(?:where|group|order|having|union|limit|offset|on|inner|left|right|full|cross|outer|join|select|values)\b|[;()]/i
/** Nombre declarado por un CTE: `WITH <nombre> AS (` o `, <nombre> AS (`. */
const CTE_DECL = new RegExp(String.raw`(?:\bwith\b|,)\s*(${IDENT})\s+as\s*\(`, 'gi')

/** Análisis de tablas de un SQL: las verificables (con esquema) y las NO verificables (single-part). */
export interface SqlTablesAnalysis {
  /** Referencias `schema.tabla` (normalizadas, sin repetir) — verificables contra el policy store. */
  tables: string[]
  /** Referencias de UNA parte (no-CTE), normalizadas — NO gobernables: el gate debe rechazarlas. */
  unqualified: string[]
}

/** Normaliza una referencia: quita corchetes/comillas por parte, colapsa espacios, minúscula. */
function normalizeTable(ref: string): string {
  return ref
    .split('.')
    .map((part) => part.trim().replace(/^[[\"]|[\]\"]$/g, '').trim().toLowerCase())
    .join('.')
}

/** Nombres de CTE declarados en el SQL (normalizados) — tablas virtuales, exentas del gate. */
function cteNamesOf(sql: string): Set<string> {
  const out = new Set<string>()
  CTE_DECL.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CTE_DECL.exec(sql))) out.add(normalizeTable(m[1]))
  return out
}

/**
 * Analiza las referencias de tabla de los FROM/JOIN de un SQL. Cada región FROM/JOIN se corta en el
 * siguiente keyword/paréntesis y se separa por comas (comma-joins): la PRIMERA referencia de cada
 * parte es la tabla (lo que siga — alias, `AS x` — se ignora). Con esquema → `tables`; una sola
 * parte y no-CTE → `unqualified` (el gate del push-down las trata como no-gobernables, fail-closed).
 */
export function analyzeSqlTables(sql: string): SqlTablesAnalysis {
  const ctes = cteNamesOf(sql)
  const tables: string[] = []
  const unqualified: string[] = []
  HEADS.lastIndex = 0
  let head: RegExpExecArray | null
  while ((head = HEADS.exec(sql))) {
    const rest = sql.slice(head.index + head[0].length)
    const bound = BOUNDARY.exec(rest)
    const region = bound ? rest.slice(0, bound.index) : rest
    const parts = region.split(',')
    for (const [i, part] of parts.entries()) {
      const ref = part.trim()
      if (!ref) continue
      const qualified = REF.exec(ref)
      if (qualified) {
        tables.push(normalizeTable(qualified[0]))
        continue
      }
      const single = SINGLE.exec(ref)
      if (single) {
        // Ident PEGADO (sin espacio) a un `(` — la región cortó justo en el paréntesis: es una
        // FUNCIÓN de tabla (`FROM numbers(5)`, `STRING_SPLIT(...)`), no una tabla resoluble en el
        // policy store — se exime. Con espacio antes del `(` NO se exime (p.ej. el hint legacy
        // `FROM t (NOLOCK)` sigue fail-closed). Solo aplica al último tramo, donde vive el corte.
        const isFnCall =
          i === parts.length - 1 && bound?.[0] === '(' && single[0].length === ref.length && part.trimEnd().length === part.length
        const name = normalizeTable(single[0])
        if (!isFnCall && !ctes.has(name)) unqualified.push(name)
      }
    }
  }
  return { tables: [...new Set(tables)], unqualified: [...new Set(unqualified)] }
}

/** Tablas (schema.tabla, normalizadas y sin repetir) que un SQL referencia en sus FROM/JOIN. */
export function tablesOf(sql: string): string[] {
  return analyzeSqlTables(sql).tables
}
