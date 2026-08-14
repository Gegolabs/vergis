/**
 * Escudo de columna de Miranda (#163 · H9) — qué columnas del catálogo NO se sondean.
 *
 * La decisión del diseño (§4.4) es EXACTA y no se re-abre: **la columna existe, se nombra, y no se
 * sondea**. Ocultar su existencia protegería más, pero MIENTE SOBRE EL TERRENO, y un asistente de
 * catálogo que miente sobre el terreno envenena todo lo que se construya con lo que describa. Es la
 * misma línea del frente completo: mentimos el valor, jamás el esquema.
 *
 * La trampa que este módulo cierra: Miranda no sirve datos, los EXPLORA — muestras, perfiles de
 * valores distintos, probes libres — y lo hace en un canal (el transcript de una sesión de
 * especificación) donde nadie está mirando con ojos de autorización. Sin este escudo, la columna que
 * la política acaba de enmascarar en el serving sale en claro por la puerta de al lado.
 *
 * «No sondear» es literal y no admite matices: ni valores de ejemplo, ni top-N, ni conteos por valor,
 * ni mínimos/máximos, ni cardinalidades, ni nada derivado de las celdas. Ante la duda de si una
 * estadística revela el valor, NO se produce.
 */

/** Lo que se sabe del plano de columna de UN objeto del catálogo. */
export interface ColumnShield {
  /**
   * ¿Se pudo determinar la política de columna del objeto? `false` ⇒ **todo** el objeto se trata
   * como protegido. La duda no habilita el sondeo: un instrumento que confunde «medí y no hay regla»
   * con «no pude medir» produce datos con cara de verdad.
   */
  known: boolean
  /** Columnas con regla de columna declarada. Se NOMBRAN en la descripción; no se sondean. */
  columns: string[]
}

/** No se pudo determinar: el objeto entero queda protegido (fail-closed). */
export const UNKNOWN_SHIELD: ColumnShield = { known: false, columns: [] }

/** Determinado y sin reglas de columna: se sondea como siempre. */
export const OPEN_SHIELD: ColumnShield = { known: true, columns: [] }

const norm = (s: string): string => s.trim().toLowerCase()

/**
 * ¿Esta columna queda fuera del sondeo? Case-insensitive a propósito: SQL no distingue mayúsculas en
 * los identificadores y una comparación estricta dejaría pasar `RUT` cuando la regla dice `rut`.
 * Comparar de más protege; comparar de menos filtra el dato.
 */
export function isProtectedColumn(shield: ColumnShield | undefined, column: string): boolean {
  if (!shield || !shield.known) return true
  const c = norm(column)
  return shield.columns.some((x) => norm(x) === c)
}

/** ¿El objeto entero está bajo duda? (sin política determinable ⇒ nada de él se sondea). */
export function shieldUnknown(shield: ColumnShield | undefined): boolean {
  return !shield || !shield.known
}

/** Las columnas protegidas de un objeto, tal como se NOMBRAN en la descripción. */
export function protectedNames(shield: ColumnShield | undefined, columns: string[]): string[] {
  return columns.filter((c) => isProtectedColumn(shield, c))
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** ¿El SQL menciona este identificador como token? (`t.rut` sí; `rut_pais` no). */
function mentions(sql: string, ident: string): boolean {
  return new RegExp(`(?<![\\w$])${escapeRe(ident)}(?![\\w$])`, 'i').test(sql)
}

/**
 * Veto de una probe libre por el plano de columna. Devuelve el motivo (texto accionable para el
 * modelo) o `null` si la probe puede correr.
 *
 * Es DELIBERADAMENTE grueso, y el grosor es la política: acá no hay un parser de SQL, así que la
 * única forma honesta de decidir es sobre-bloquear. Tres reglas, en orden:
 *
 *   1. Un objeto referenciado sin escudo determinable veta la probe entera (fail-closed).
 *   2. `*` sobre un objeto con columnas protegidas veta: la estrella las trae sin nombrarlas. Se
 *      exceptúa `COUNT(*)`, que no proyecta ninguna celda.
 *   3. Mencionar el nombre de una columna protegida veta, esté donde esté — proyección, `WHERE`,
 *      `GROUP BY`, dentro de una función o de un agregado. Un `SUM(sueldo)` o un `MIN(rut)` es dato
 *      derivado de celdas que el sujeto no puede ver, y el IR no razona sobre cardinalidad (§4.3):
 *      el hueco se cierra no sirviendo la columna, no midiendo cuánto revela.
 *
 * El costo conocido: una columna protegida llamada `rut` veta también las probes que nombren un
 * `rut` de otra tabla del FROM. Bloquear de más es el lado correcto del error.
 */
export function probeVeto(sql: string, shields: { table: string; shield: ColumnShield }[]): string | null {
  const unknown = shields.filter((s) => shieldUnknown(s.shield)).map((s) => s.table)
  if (unknown.length > 0) {
    return `no se pudo determinar la política de columna de ${[...new Set(unknown)].join(', ')}; en la duda no se sondea (fail-closed).`
  }
  const protegidas = [...new Set(shields.flatMap((s) => s.shield.columns))]
  if (protegidas.length === 0) return null
  // `COUNT(*)` no proyecta celdas: se neutraliza antes de buscar la estrella.
  const bare = sql.replace(/count\s*\(\s*\*\s*\)/gi, 'count(1)')
  if (/\*/.test(bare)) {
    return `proyecta '*' sobre objeto(s) con columnas protegidas (${protegidas.join(', ')}): enumera las columnas que necesitas.`
  }
  const named = protegidas.filter((c) => mentions(bare, c))
  if (named.length > 0) {
    return `menciona columna(s) protegida(s): ${named.join(', ')}. Existen y se nombran, pero no se sondean — ni sus valores, ni estadísticas derivadas de ellos.`
  }
  return null
}

/** Nota para el modelo cuando un objeto trae columnas fuera del sondeo. */
export function shieldNote(shield: ColumnShield | undefined, protegidas: string[]): string | undefined {
  if (shieldUnknown(shield)) {
    return 'No se pudo determinar la política de columna de este objeto: NADA de él se sondea (fail-closed). El esquema se nombra igual.'
  }
  if (protegidas.length === 0) return undefined
  return `Columnas marcadas \`protegida\` (${protegidas.join(', ')}): la política declara regla de columna sobre ellas. EXISTEN y se nombran con su tipo, pero no se sondean — ni muestra, ni perfil, ni probes que las mencionen. No intentes rodearlo con alias, funciones ni agregados.`
}
