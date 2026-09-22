/**
 * MEDIR UNA CONEXIÓN para el Datadoc (`CAP-197`) — la introspección del esquema de un Datahouse, y
 * nada más: recibe un `execute` y devuelve el modelo medido. No toca disco, no arma páginas, no
 * decide cuándo correr. Por eso se puede poner en riesgo con un `execute` falso que registra cada
 * SQL emitido, que es lo único que demuestra la regla del §D6.
 *
 * ── READ-ONLY, y la protección es de ACÁ ────────────────────────────────────────────────────────
 * El conector del nodo (`createExecuteSqlDwh`) **no tiene guard de solo lectura** — verificado: no
 * hay un solo `readOnly` en su código. Así que el generador pone el suyo: `guardSoloLectura` corre
 * sobre CADA consulta antes de tocar la red, todas las consultas son literales de este módulo (las
 * base se guardan al CARGAR el módulo, así que un verbo de escritura introducido por una edición
 * futura tumba el import, no una corrida de producción) y el único identificador interpolado —el
 * `[schema].[tabla]` del `COUNT_BIG`— se valida por parte contra `/^[A-Za-z0-9_]+$/`.
 *
 * ── LOS CONTEOS DE FILAS, que es donde esto puede filtrar ────────────────────────────────────────
 * Un catálogo describe el esquema, no sirve datos — pero `COUNT(*)` sobre una tabla gobernada **sí
 * es** información que la RLS protege: cuántos registros hay del área que no me corresponde. La
 * regla, entonces, es no preguntar: el `COUNT_BIG` se emite **solo** sobre tablas sin política o con
 * política demostradamente allow-all. A una tabla `filtrada` o `indeterminada` no se le emite la
 * consulta, y la página dice «no medidas».
 *
 * Que la protección sea **no preguntar** y no **confiar en la respuesta** es deliberado: si el
 * Service Principal del nodo estuviera exento del predicado —algo NO VERIFICADO en Fabric—, la
 * respuesta vendría sin filtrar y el catálogo publicaría el número entero. La identidad sin claims
 * con que corre el generador es defensa en profundidad, no la regla.
 *
 * ── ⚠ LA CLASIFICACIÓN ES POR FORMA COMPLETA, JAMÁS POR SUBSTRING ────────────────────────────────
 * **Medido el 2026-09-21 contra el compilador** (`packages/policy/src/fabric.ts`): el literal
 * `SELECT 1 AS vergis_allowed` se emite en **las dos** ramas — la allow-all, sin `WHERE` (línea 699),
 * y la **filtrada**, con `WHERE <predicado>` (línea 742, fijada por `tests/policy.test.ts:234`). Un
 * `/select\s+1\s+as\s+vergis_allowed/i` —el regex que el generador de instancia usa hoy— matchea las
 * dos, así que clasificaría **toda tabla con RLS real como abierta y publicaría su `COUNT`**. Acá se
 * compara el CUERPO COMPLETO del `RETURN`, normalizado, contra la forma exacta: cualquier otra cosa
 * —incluida una que empiece igual— es `filtrada`. El test que lo mide usa el fixture de la rama
 * filtrada y **falla si sale `abierta`**.
 */

import { SYS_VIEW_LINEAGE_SQL } from './engines/fabric'

/** Cómo se ejecuta una consulta contra una conexión. Es la forma del `dwh` del nodo. */
export type EjecutarSql = (input: { database_ref: string; sql: string }) => Promise<{ rows: Record<string, unknown>[] }>

/** El veredicto de gobierno de una tabla base — el que decide si se le pide el conteo. */
export type ClaseGobierno = 'no gobernada' | 'abierta' | 'filtrada' | 'indeterminada'

/** Una política de RLS localizada sobre un objeto. */
export interface PoliticaMedida {
  secpol: string
  habilitada: boolean
  /** El texto del predicado tal como `sys` lo devuelve. */
  predicado: string
  /** La función de predicado que el texto nombra, si se pudo localizar en `sys.sql_modules`. */
  funcion?: string
  /** Veredicto de ESTA política. El de la tabla es el peor de las suyas. */
  clase: Exclude<ClaseGobierno, 'no gobernada'>
}

export interface ColumnaMedida {
  nombre: string
  ordinal: number
  /** Tipo ya formateado para leer: `nvarchar(50)`, `decimal(18,2)`, `date`. */
  tipo: string
  nulable: boolean
}

export interface ObjetoMedido {
  /** `schema.tabla`, en minúsculas — la llave con que el nodo indexa en todas partes. */
  ref: string
  schema: string
  nombre: string
  esVista: boolean
}

/** La medición COMPLETA de una conexión. Es lo que se serializa a `modelo/<ref>.json`. */
export interface ModeloConexion {
  ref: string
  /** Base de datos y endpoint, tomados del PERFIL de conexión (no de una consulta). */
  database: string
  server: string
  medidoEn: string
  ms: number
  objetos: ObjetoMedido[]
  /** `schema.tabla` → columnas, en orden ordinal. */
  columnas: Record<string, ColumnaMedida[]>
  /** `schema.tabla` de cada vista → su definición (para mostrarla). */
  vistasDef: Record<string, string>
  /** Linaje vista→base, de `sys`, no de un regex sobre la definición. */
  linaje: { vista: string; base: string; schemabound: boolean }[]
  /** `schema.tabla` → su gobierno medido. Solo tablas base con política aparecen con políticas. */
  gobierno: Record<string, { clase: ClaseGobierno; politicas: PoliticaMedida[] }>
  /** `schema.tabla` → filas. Solo las que la regla del §D6 permitió consultar. */
  conteos: Record<string, number>
  /** Esquemas que esta medición miró (la lista blanca efectiva). */
  esquemas: string[]
  /** Sub-errores: una consulta que falló NO invalida la conexión, se declara. */
  errores: string[]
}

/** Política de conteos: `abiertas` pide `COUNT_BIG` donde la RLS no filtra; `off` no pide ninguno. */
export type PoliticaConteos = 'abiertas' | 'off'

export interface OpcionesMedicion {
  /** Lista BLANCA de esquemas. Default `['dbo']`. */
  esquemas?: readonly string[]
  conteos?: PoliticaConteos
  now?: () => Date
}

// ── Guard de solo lectura ────────────────────────────────────────────────────────────────────────

/** Verbos que una consulta del generador no puede contener. Lista cerrada, con `\b` en los dos bordes. */
const PROHIBIDAS =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|DENY|EXEC|EXECUTE|BACKUP|RESTORE|INTO|BULK|OPENROWSET|SHUTDOWN)\b/i

/**
 * Devuelve el SQL si es de solo lectura; lanza si no. Pela comentarios y literales antes de mirar
 * (un `-- DROP` en un comentario no es un verbo, y un `'DELETE'` dentro de un string tampoco), exige
 * que empiece en `SELECT`/`WITH` y que sea UNA sola sentencia.
 */
export function guardSoloLectura(sqlCrudo: string): string {
  const q = String(sqlCrudo)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .trim()
    .replace(/;\s*$/, '')
  if (!/^(SELECT|WITH)\b/i.test(q)) throw new Error(`datadoc: consulta no-SELECT rechazada: ${q.slice(0, 80)}`)
  if (q.includes(';')) throw new Error('datadoc: una sola sentencia por consulta.')
  const m = PROHIBIDAS.exec(q)
  if (m) throw new Error(`datadoc: palabra prohibida «${m[1]}» — el generador del Datadoc es de solo lectura.`)
  return sqlCrudo
}

// ── Las consultas ────────────────────────────────────────────────────────────────────────────────

const IDENT_RE = /^[A-Za-z0-9_]+$/

/** Lista blanca de esquemas como literal SQL `N'a', N'b'`. Cada nombre validado; jamás dato ajeno. */
function listaEsquemas(esquemas: readonly string[]): string {
  for (const s of esquemas) if (!IDENT_RE.test(s)) throw new Error(`datadoc: esquema inválido '${s}' (esperado [A-Za-z0-9_]+).`)
  return esquemas.map((s) => `N'${s}'`).join(', ')
}

/**
 * Objetos del catálogo, **por lista blanca de esquemas**.
 *
 * Lista blanca y no lista negra, y esto está MEDIDO (2026-09-21): el warehouse `wh_finanzas` de la
 * instancia trae un esquema `queryinsights` con 6 vistas —el historial de consultas de Fabric, con
 * el texto SQL de todos los usuarios— que un `NOT IN ('sys','INFORMATION_SCHEMA')` deja pasar y el
 * catálogo publicaría como entidades con sus columnas. No es fuga de datos: es un contrato falso en
 * la página. Y el conjunto de esquemas de plataforma que puede aparecer NO se conoce de antemano (un
 * lakehouse puede traer otros), así que enumerar lo que ENTRA es lo único que cierra.
 */
export const qTablas = (esquemas: readonly string[]): string =>
  guardSoloLectura(
    `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA IN (${listaEsquemas(esquemas)})`,
  )

export const qColumnas = (esquemas: readonly string[]): string =>
  guardSoloLectura(
    `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, ` +
      `NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS ` +
      `WHERE TABLE_SCHEMA IN (${listaEsquemas(esquemas)})`,
  )

/** Definiciones de vistas (para mostrar) y de funciones de predicado (para clasificar el gobierno). */
export const Q_MODULOS = guardSoloLectura(
  `SELECT SCHEMA_NAME(o.schema_id) AS sch, o.name AS obj, o.type AS tipo, m.definition AS def ` +
    `FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id`,
)

/** Políticas de seguridad con su predicado y su objetivo. */
export const Q_SECPOL = guardSoloLectura(
  `SELECT pol.name AS secpol, pol.is_enabled AS habilitada, SCHEMA_NAME(o.schema_id) AS sch, ` +
    `o.name AS objetivo, pr.predicate_definition AS predicado ` +
    `FROM sys.security_policies pol JOIN sys.security_predicates pr ON pol.object_id = pr.object_id ` +
    `JOIN sys.objects o ON o.object_id = pr.target_object_id`,
)

/**
 * Linaje vista→base. REUSA la consulta del motor (`server/engines/fabric.ts`), no una copia: dos
 * implementaciones de la misma pregunta son dos respuestas esperando a divergir.
 */
export const Q_LINAJE = guardSoloLectura(SYS_VIEW_LINEAGE_SQL)

/** `SELECT COUNT_BIG(*)` de una tabla. Los dos identificadores se validan por parte. */
export function qConteo(schema: string, tabla: string): string {
  if (!IDENT_RE.test(schema) || !IDENT_RE.test(tabla))
    throw new Error(`datadoc: identificador no contable '${schema}.${tabla}' (esperado [A-Za-z0-9_]+ por parte).`)
  return guardSoloLectura(`SELECT COUNT_BIG(*) AS n FROM [${schema}].[${tabla}]`)
}

// Guard al CARGAR el módulo sobre las formas base: si una edición futura mete un verbo de escritura
// en cualquiera de ellas, el import falla acá — no en una corrida contra un almacén real.
void [qTablas(['dbo']), qColumnas(['dbo']), Q_MODULOS, Q_SECPOL, Q_LINAJE, qConteo('dbo', 'x')]

// ── Clasificación del gobierno ───────────────────────────────────────────────────────────────────

/** La forma EXACTA que hace a un predicado allow-all. Cualquier otra cosa es filtro. */
const CUERPO_ALLOW_ALL = /^SELECT\s+1\s+AS\s+vergis_allowed$/i

/**
 * ¿La definición de esta función de predicado es allow-all, o filtra?
 *
 * Compara el CUERPO COMPLETO del `RETURN` —pelado de comentarios, con los espacios colapsados y sin
 * el `;` final— contra la forma exacta. **Nunca por substring**: la rama filtrada del compilador
 * emite el mismo literal seguido de `WHERE`, y un substring las confundiría (ver la cabecera).
 *
 * Fail-closed por construcción: una definición cuyo `AS RETURN` no se localiza se mide entera, y
 * entera nunca es la forma exacta ⇒ `filtrada`. Ante la duda, no se publica el conteo.
 */
export function clasificarPredicado(definicion: string): 'abierta' | 'filtrada' {
  const sinComentarios = String(definicion ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
  const m = /\bAS\s+RETURN\b([\s\S]*)$/i.exec(sinComentarios)
  const cuerpo = (m ? m[1] : sinComentarios)
    .replace(/\s+/g, ' ')
    // Se recortan TODOS los `;` finales, no uno: un `;` extra pegado al que el compilador ya emite
    // no cambia el sentido del predicado, y dejar la comparación sensible a eso la volvería frágil
    // hacia el lado equivocado — clasificaría como `filtrada` algo que sí es allow-all.
    .replace(/[;\s]+$/, '')
    .trim()
  return CUERPO_ALLOW_ALL.test(cuerpo) ? 'abierta' : 'filtrada'
}

/**
 * El nombre de la función que un `predicate_definition` invoca — genérico, sin convención de nombre.
 *
 * El generador de instancia buscaba `fn_pol*`, que es SU convención: el Producto no puede suponer
 * cómo se llaman las funciones de un almacén que no aplicó. Se extrae el identificador invocado.
 */
export function funcionDelPredicado(predicado: string): string | null {
  const s = String(predicado ?? '')
  const conEsquema = /\[?([A-Za-z0-9_]+)\]?\s*\.\s*\[?([A-Za-z0-9_]+)\]?\s*\(/.exec(s)
  if (conEsquema) return `${conEsquema[1].toLowerCase()}.${conEsquema[2].toLowerCase()}`
  const solo = /\[?([A-Za-z0-9_]+)\]?\s*\(/.exec(s)
  return solo ? solo[1].toLowerCase() : null
}

/** El veredicto de una tabla es el PEOR de sus políticas: basta una filtrada para no preguntar. */
function peor(clases: readonly Exclude<ClaseGobierno, 'no gobernada'>[]): ClaseGobierno {
  if (!clases.length) return 'no gobernada'
  if (clases.includes('filtrada')) return 'filtrada'
  if (clases.includes('indeterminada')) return 'indeterminada'
  return 'abierta'
}

// ── La medición ──────────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (v == null ? '' : String(v))
const num = (v: unknown): number | null => (v == null ? null : Number(v))
const ref = (schema: unknown, nombre: unknown): string => `${str(schema).toLowerCase()}.${str(nombre).toLowerCase()}`

/** Tipo legible de una columna: `nvarchar(50)`, `nvarchar(max)`, `decimal(18,2)`, `date`. */
function tipoDe(fila: Record<string, unknown>): string {
  const base = str(fila['DATA_TYPE']).toLowerCase()
  const largo = num(fila['CHARACTER_MAXIMUM_LENGTH'])
  if (largo != null) return `${base}(${largo === -1 ? 'max' : largo})`
  if (base === 'decimal' || base === 'numeric') return `${base}(${num(fila['NUMERIC_PRECISION']) ?? '?'},${num(fila['NUMERIC_SCALE']) ?? '?'})`
  return base
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Mide UNA conexión. Pura respecto del disco y del reloj del proceso (recibe `now`): lo que devuelve
 * es el modelo, y quien la llama decide dónde guardarlo.
 *
 * **Un sub-error no invalida la conexión.** Si `sys.security_policies` está denegada al Service
 * Principal, el gobierno de todas las tablas queda `indeterminada` —y por lo tanto sin conteos—, el
 * error queda en `errores[]` y la página lo declara. Lanzar entero convertiría un permiso faltante en
 * un Datahouse ausente, que es una afirmación más fuerte y falsa.
 */
export async function medirConexion(
  execute: EjecutarSql,
  conexion: { ref: string; server: string; database: string },
  opts: OpcionesMedicion = {},
): Promise<ModeloConexion> {
  const esquemas = [...(opts.esquemas?.length ? opts.esquemas : ['dbo'])]
  const conteos: PoliticaConteos = opts.conteos ?? 'abiertas'
  const ahora = opts.now ?? ((): Date => new Date())
  const t0 = Date.now()
  const errores: string[] = []
  const correr = async (sql: string): Promise<Record<string, unknown>[]> => {
    const r = await execute({ database_ref: conexion.ref, sql: guardSoloLectura(sql) })
    return r?.rows ?? []
  }

  const modelo: ModeloConexion = {
    ref: conexion.ref,
    database: conexion.database,
    server: conexion.server,
    medidoEn: ahora().toISOString(),
    ms: 0,
    objetos: [],
    columnas: {},
    vistasDef: {},
    linaje: [],
    gobierno: {},
    conteos: {},
    esquemas,
    errores,
  }

  // El catálogo de objetos es la única consulta que NO puede fallar: sin objetos no hay entidades que
  // describir, y devolver un modelo vacío diciendo «medido» sería peor que declarar el fallo.
  modelo.objetos = (await correr(qTablas(esquemas)))
    .map((t) => ({
      ref: ref(t['TABLE_SCHEMA'], t['TABLE_NAME']),
      schema: str(t['TABLE_SCHEMA']).toLowerCase(),
      nombre: str(t['TABLE_NAME']).toLowerCase(),
      esVista: str(t['TABLE_TYPE']).toUpperCase() === 'VIEW',
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref))

  try {
    for (const c of await correr(qColumnas(esquemas))) {
      const k = ref(c['TABLE_SCHEMA'], c['TABLE_NAME'])
      ;(modelo.columnas[k] ??= []).push({
        nombre: str(c['COLUMN_NAME']),
        ordinal: Number(c['ORDINAL_POSITION'] ?? 0),
        tipo: tipoDe(c),
        nulable: str(c['IS_NULLABLE']).toUpperCase() === 'YES',
      })
    }
    for (const cols of Object.values(modelo.columnas)) cols.sort((a, b) => a.ordinal - b.ordinal)
  } catch (e) {
    errores.push(`INFORMATION_SCHEMA.COLUMNS: ${errMsg(e)}`)
  }

  // Definiciones: vistas (para mostrar) y funciones (para clasificar). `sys.objects.type` viene con
  // padding fijo — se recorta antes de comparar.
  const definiciones = new Map<string, string>()
  try {
    for (const m of await correr(Q_MODULOS)) {
      const k = ref(m['sch'], m['obj'])
      const tipo = str(m['tipo']).trim().toUpperCase()
      const def = str(m['def'])
      definiciones.set(k, def)
      if (tipo === 'V') modelo.vistasDef[k] = def
    }
  } catch (e) {
    errores.push(`sys.sql_modules: ${errMsg(e)}`)
  }

  let secpolOk = true
  const politicasPorTabla = new Map<string, PoliticaMedida[]>()
  try {
    for (const p of await correr(Q_SECPOL)) {
      const objetivo = ref(p['sch'], p['objetivo'])
      const predicado = str(p['predicado'])
      const fn = funcionDelPredicado(predicado)
      // La función puede venir calificada (`dbo.fn_x`) o pelada: se busca con esquema y, si no está,
      // por nombre en cualquier esquema medido. Sin definición ⇒ `indeterminada`, jamás `abierta`.
      let def: string | undefined
      let nombreFn: string | undefined
      if (fn) {
        if (definiciones.has(fn)) {
          def = definiciones.get(fn)
          nombreFn = fn
        } else {
          const soloNombre = fn.includes('.') ? fn.slice(fn.indexOf('.') + 1) : fn
          for (const [k, d] of definiciones) {
            if (k.slice(k.indexOf('.') + 1) === soloNombre) {
              def = d
              nombreFn = k
              break
            }
          }
        }
      }
      const entrada: PoliticaMedida = {
        secpol: str(p['secpol']),
        habilitada: p['habilitada'] === true || p['habilitada'] === 1 || str(p['habilitada']) === '1',
        predicado,
        clase: def != null ? clasificarPredicado(def) : 'indeterminada',
      }
      if (nombreFn) entrada.funcion = nombreFn
      const lista = politicasPorTabla.get(objetivo) ?? []
      lista.push(entrada)
      politicasPorTabla.set(objetivo, lista)
    }
  } catch (e) {
    secpolOk = false
    errores.push(`sys.security_policies: ${errMsg(e)}`)
  }

  for (const o of modelo.objetos) {
    if (o.esVista) continue
    const pols = politicasPorTabla.get(o.ref) ?? []
    // Sin el barrido de políticas no se sabe si esta tabla tiene una: `indeterminada`, no «sin
    // política». Es la diferencia entre «medí y no hay» y «no pude medir», y decide si se pregunta
    // el conteo — confundirlas produciría un número con cara de verdad.
    modelo.gobierno[o.ref] = secpolOk ? { clase: peor(pols.map((p) => p.clase)), politicas: pols } : { clase: 'indeterminada', politicas: [] }
  }

  try {
    const vistos = new Set<string>()
    for (const l of await correr(Q_LINAJE)) {
      const vista = ref(l['vsch'], l['vname'])
      const base = ref(l['bsch'], l['bname'])
      const k = `${vista}\u0000${base}`
      if (vistos.has(k)) continue
      vistos.add(k)
      modelo.linaje.push({ vista, base, schemabound: l['bound'] === true || l['bound'] === 1 })
    }
  } catch (e) {
    errores.push(`sys.sql_expression_dependencies (linaje): ${errMsg(e)}`)
  }

  // ── Conteos: SOLO donde la RLS no filtra, y solo si la política de conteos lo permite ──────────
  if (conteos === 'abiertas') {
    for (const o of modelo.objetos) {
      if (o.esVista) continue
      const clase = modelo.gobierno[o.ref]?.clase ?? 'indeterminada'
      // ⚠ La condición es una LISTA BLANCA de clases, no una negación: una clase nueva que alguien
      // agregue mañana queda FUERA por defecto, en vez de colarse al lado seguro sin que nadie mire.
      if (clase !== 'no gobernada' && clase !== 'abierta') continue
      try {
        const filas = await correr(qConteo(o.schema, o.nombre))
        const n = num(filas[0]?.['n'])
        if (n != null) modelo.conteos[o.ref] = n
      } catch (e) {
        errores.push(`COUNT ${o.ref}: ${errMsg(e)}`)
      }
    }
  }

  modelo.ms = Date.now() - t0
  return modelo
}
