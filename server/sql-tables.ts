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

/** Un identificador SQL: entre corchetes, entre comillas dobles, o desnudo. */
const IDENT = String.raw`(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_]\w*)`
/** Referencia a tabla CON esquema: dos o más partes punteadas (schema.tabla, db.schema.tabla). */
const REF = new RegExp(`${IDENT}(?:\\s*\\.\\s*${IDENT})+`, 'g')
/** Inicio de una región de tablas: tras FROM o JOIN. */
const HEADS = /\b(?:from|join)\b/gi
/**
 * Fin de la región de tablas de un FROM/JOIN: el siguiente keyword de cláusula, un paréntesis (subquery)
 * o un `;`. Recortar la región a las tablas evita capturar columnas calificadas (`t.col`) del SELECT o
 * del ON/WHERE como si fueran tablas (falsos positivos que rechazarían specs válidas).
 */
const BOUNDARY = /\b(?:where|group|order|having|union|limit|offset|on|inner|left|right|full|cross|outer|join|select|values)\b|[;()]/i

/** Normaliza una referencia a `schema.tabla`: quita corchetes/comillas, colapsa espacios, minúscula. */
function normalizeTable(ref: string): string {
  return ref
    .split('.')
    .map((part) => part.trim().replace(/^[[\"]|[\]\"]$/g, '').trim().toLowerCase())
    .join('.')
}

/** Tablas (schema.tabla, normalizadas y sin repetir) que un SQL referencia en sus FROM/JOIN. */
export function tablesOf(sql: string): string[] {
  const out: string[] = []
  HEADS.lastIndex = 0
  let head: RegExpExecArray | null
  while ((head = HEADS.exec(sql))) {
    const rest = sql.slice(head.index + head[0].length)
    const bound = BOUNDARY.exec(rest)
    const region = bound ? rest.slice(0, bound.index) : rest
    REF.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = REF.exec(region))) out.push(normalizeTable(m[0]))
  }
  return [...new Set(out)]
}
