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
import { SETTINGS_PREFIX, ident, settingForClaim } from './codegen-common'
import {
  columnRules,
  isHierarchy,
  isPublic,
  maskRow,
  validateColumnRule,
  MASK_VALUE,
  type ClaimSet,
  type ColumnRule,
  type Policy,
  type PolicyDecl,
  type Predicate,
  type ReferenceData,
} from './ir'

/**
 * Collation binaria forzada en las comparaciones del predicado. Sin ella, en una BD con collation
 * case-insensitive (Azure SQL default `SQL_Latin1_General_CP1_CI_AS`) el claim `ventas` matchearía
 * filas `VENTAS` — MÁS permisivo que el evaluador de referencia (`===`, case-sensitive) y que
 * ClickHouse. `BIN2` hace la comparación byte-a-byte, alineando el motor con la semántica de referencia.
 */
const COLLATE_BIN = 'COLLATE Latin1_General_100_BIN2'

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
  /**
   * Proyección COMPLETA y ORDENADA de la tabla servida — condición para emitir la VISTA DE MÁSCARA
   * (#163 H6). No es prolijidad: la vista tiene que reproducir la MISMA forma que la tabla (mismas
   * columnas, mismos tipos, mismo orden, diseño §4.1) y T-SQL no sabe proyectar «todo menos una
   * columna»: `SELECT *` no se puede sobreescribir columna por columna. Sin esta declaración el
   * emisor **no puede** construir la proyección, y entonces NO emite la vista (ver `maskView`).
   */
  tableColumns?: string[]
  /** Nombre de la vista de máscara; default derivado de la tabla (`vw_mask_<tabla>`). */
  maskViewName?: string
  /** Columna a la que bindear el predicado allow-all de una policy PÚBLICA (la función la ignora).
   *  Requerida solo para `grant: all` (que no declara dimensión); para gobernadas se ignora. */
  bindColumn?: string
  /**
   * Envuelve `setupSQL` en una transacción (`SET XACT_ABORT ON; BEGIN TRANSACTION; … COMMIT;`) para que
   * el DROP+CREATE sea ATÓMICO: el DDL toma locks Sch-M hasta el commit → una query concurrente BLOQUEA
   * en vez de ver la tabla SIN policy (ventana sin RLS) entre el DROP y el CREATE. Default `false` =
   * sentencias sueltas (contrato clásico). **Activar SOLO si el aplicador corre todas las sentencias de
   * `setupSQL` en LA MISMA sesión y en orden** (una transacción T-SQL abarca batches de una sesión; si el
   * aplicador usa conexión-por-sentencia, el BEGIN quedaría sin COMMIT y la instalación se revertiría). */
  transactional?: boolean
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
  policy: PolicyDecl
  /**
   * Columnas de la tabla que la SECURITY POLICY toma REHÉN (issue #164).
   *
   * `WITH SCHEMABINDING` convierte cada columna referenciada por el predicado en una **dependencia
   * dura**: mientras la policy exista, esa columna no se puede alterar ni retirar. Para una policy
   * gobernada eso es semántico —la columna es el criterio— pero para `grant: all` es **andamiaje**:
   * la función ignora su argumento y la columna elegida es un accidente del aplicador.
   *
   * Declararlas acá es la mitigación mínima del camino 3 del issue: la dependencia deja de ser un
   * descubrimiento —un `ALTER` rechazado en producción— y pasa a ser un dato que el gate de
   * regresión de terreno puede leer ANTES de intentar el cambio. **No resuelve #164**: la
   * dependencia sigue existiendo. La vuelve visible, que es lo que se podía hacer sin medir contra
   * un endpoint vivo si Fabric admite un predicado sin columna.
   */
  schemaDependencies: string[]
  /**
   * La VISTA DE MÁSCARA emitida (#163 H6), o `null` si no se emitió.
   *
   * Es el artefacto que hace que la máscara **honre al sujeto**: evalúa el claim de cada
   * `ColumnRule` contra `SESSION_CONTEXT` en la PROYECCIÓN, por request, con el mismo transporte que
   * el `FILTER PREDICATE` de fila. Se emite cuando hay reglas de columna Y el target declaró
   * `tableColumns` (sin la proyección declarada no se puede conservar la forma; ver `FabricTarget`).
   *
   * **Se emite y se declara; no se sirve solo.** Que el consumidor consulte esta vista en vez de la
   * tabla es decisión de arquitectura/instancia (qué objeto nombra el spec), no de este emisor.
   */
  maskView: FabricMaskView | null
}

/** La vista de máscara emitida: su nombre, su forma y su DDL. */
export interface FabricMaskView {
  /** Nombre simple de la vista (identificador validado). */
  name: string
  /** Referencia calificada `[schema].[vista]` — lo que tendría que nombrar el serving. */
  qualifiedName: string
  /** Proyección exacta de la vista, en orden (la misma de la tabla: la forma no cambia). */
  columns: string[]
  /** Columnas con `CASE` de máscara, en orden de declaración. */
  maskedColumns: string[]
  /** Claims que habilitan cada columna enmascarada (todos deben estar presentes para ver en claro). */
  claimsByColumn: Record<string, string[]>
  /** `CREATE VIEW …` (una sola sentencia: T-SQL exige que `CREATE VIEW` encabece su batch). */
  createSQL: string
  /** `DROP VIEW IF EXISTS …` — encabeza el teardown (la vista es el consumidor más externo). */
  dropSQL: string
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
      `(${read} <> N'' AND @${col} ${COLLATE_BIN} IN (` +
      `SELECT ${desc} FROM ${ref} WHERE ${anc} ${COLLATE_BIN} IN (SELECT value FROM STRING_SPLIT(${read}, N','))))`
    )
  }
  if (pred.op === 'eq') {
    // Guard de cardinalidad: un claim multi-valor viaja como 'a,b'; sin `CHARINDEX(N',', ...) = 0`
    // una celda que contenga 'a,b' pasaría (over-grant). La referencia `eq` exige UN valor.
    return `(${read} <> N'' AND CHARINDEX(N',', ${read}) = 0 AND @${col} ${COLLATE_BIN} = ${read})`
  }
  // in (membresía): STRING_SPLIT del valor delimitado por coma (el `splitByChar`/`has` de ClickHouse)
  return `(${read} <> N'' AND @${col} ${COLLATE_BIN} IN (SELECT value FROM STRING_SPLIT(${read}, N',')))`
}

// --- PLANO DE COLUMNA (#163 H2): Dynamic Data Masking nativo ----------------
//
// La primitiva es `ALTER COLUMN … ADD MASKED WITH (FUNCTION = 'default()')` (DDM). Se eligió por lo
// que NO exige: no toca la proyección. El SQL que llega al motor lo escribe el consumidor de la
// capability (`execute-sql-dwh` manda `params.sql` verbatim); el compilador jamás ve un `SELECT`, así
// que una máscara «en la proyección» sería authz que depende de que el llamador coopere — el mismo
// razonamiento por el que el back-end ClickHouse declara la capacidad NO soportada. DDM vive en la
// COLUMNA: se aplique el `SELECT` que se aplique, la celda sale enmascarada.
//
// LA BRECHA MEDIDA, y va acá porque quien lea este emisor tiene que verla antes de creerle:
// **DDM discrimina por PRINCIPAL (permiso `UNMASK`), y Vergis no transporta al sujeto como
// principal.** `packages/capabilities/src/execute-sql-dwh.ts` abre UN pool por `database_ref` con UN
// Service Principal y distingue a los consumidores SOLO por `SESSION_CONTEXT` (reinyectado por
// request). Consecuencias, las dos verificables leyendo ese archivo:
//   1. La máscara instalada acá NO puede variar por claim: es DDL de specialize-time y `UNMASK` es
//      del lector, no de la sesión. Sirve enmascarado a TODOS los consumidores por igual — el claim
//      de la `ColumnRule` queda INERTE en este back-end. Es sobre-enmascaramiento (nunca fuga), pero
//      NO es la semántica del oráculo, y el differential test de `tests/policy.test.ts` lo asienta
//      como brecha explícita en vez de esconderla.
//   2. Si ese Service Principal tuviera `UNMASK` (p. ej. por ser `db_owner`), DDM sería un NO-OP y la
//      columna se serviría EN CLARO con el gobierno declarado. **No está medido** — es exactamente el
//      gate que `PENDINGS.md` ya declara conjetura (`MASKED WITH` × vistas-contrato). Mientras no se
//      mida, este emisor NO garantiza fail-closed en el motor: garantiza que el artefacto se emite,
//      se revierte y se declara.
// Lo que fija la brecha de (1) sin volver a discutir el diseño es un mecanismo que se evalúe POR
// REQUEST —una expresión sobre `SESSION_CONTEXT` en la proyección, es decir una vista— y eso cambia
// el objeto que se sirve: decisión de arquitectura, no de este emisor.

/** Función de máscara de DDM. `default()` sustituye por el default DEL TIPO (0 en numéricos, 'XXXX'
 *  en texto): conserva el tipo de la columna. Castear a texto para tener un literal único cambiaría
 *  el ESQUEMA, que es justo lo que el diseño §4.1 prohíbe (mentimos el valor, jamás el esquema). */
const MASK_FUNCTION = 'default()'

/**
 * Columnas que la policy declara enmascaradas, validadas y sin repetir (orden de aparición).
 *
 * **Fail-closed y ruidoso**: `validateColumnRule` LANZA ante una regla malformada — una `action` con
 * un typo jamás degrada a «esta columna va en claro». Y los nombres pasan por `ident`: el DDL se
 * construye por interpolación (ningún motor parametriza identificadores), así que una columna llamada
 * `x; DROP TABLE y` tiene que morir acá y no en el terreno. El `claim` no llega al DDL de DDM (ver la
 * brecha arriba) y se valida igual: el día que el mecanismo lo transporte, el guard ya está puesto.
 */
function maskedColumnsOf(policy: PolicyDecl): string[] {
  const out: string[] = []
  columnRules(policy).forEach((rule, i) => {
    validateColumnRule(rule, i)
    ident('columnRule.claim', rule.claim)
    const col = ident('columnRule.column', rule.column)
    if (!out.includes(col)) out.push(col)
  })
  return out
}

/** Retira la máscara de una columna. Guardado por `sys.masked_columns` porque `DROP MASKED` sobre una
 *  columna SIN máscara es un error: sin el guard, el teardown (que también encabeza el setup, que es
 *  como este emisor es idempotente) fallaría en la PRIMERA instalación y dejaría la tabla sin policy. */
function dropMaskedSQL(qTable: string, column: string): string {
  // El `ALTER` va DENTRO de `EXEC(...)` y no colgando del `IF`. Motivo medido, no estilístico: T-SQL
  // **compila el batch entero antes de ejecutarlo**, y `DROP MASKED` se valida en compilación — así
  // que sobre una columna sin máscara el batch falla ANTES de evaluar el `IF`, y el guard no guarda
  // nada. Como este statement encabeza también el setup (tira-y-recrea), la consecuencia era que
  // **toda instalación nueva** de una policy con reglas de columna fallaba en su primera sentencia.
  // `EXEC` difiere la compilación al momento de ejecutar, que es cuando el guard ya decidió.
  // (Medido en `scripts/tsql-lab-proof.ts`, con su control: con la máscara puesta sí la quita.)
  return (
    `IF EXISTS (SELECT 1 FROM sys.masked_columns WHERE object_id = OBJECT_ID(N'${qTable}') AND name = N'${column}')\n` +
    `    EXEC(N'ALTER TABLE ${qTable} ALTER COLUMN [${column}] DROP MASKED;');`
  )
}

/** Instala la máscara sobre la columna. */
function addMaskedSQL(qTable: string, column: string): string {
  return `ALTER TABLE ${qTable} ALTER COLUMN [${column}] ADD MASKED WITH (FUNCTION = '${MASK_FUNCTION}');`
}

/**
 * PREFLIGHT del plano de columna: diagnostica ANTES de intentar la máscara.
 *
 * Un objeto `SCHEMABINDING` que referencia la columna la deja **inmutable**: ni `ADD MASKED` ni
 * `DROP MASKED` pasan mientras exista. Es el caso de las **vistas-contrato**, que la instancia real
 * usa. El motor lo rechaza con «one or more objects access this column», que no nombra al culpable
 * ni dice qué hacer — y un aplicador que solo ve ese texto no puede distinguirlo de un problema de
 * permisos.
 *
 * Lo medido, y por eso la remediación es concreta y no un «revise su esquema»: **no es una
 * incompatibilidad, es el ORDEN**. La máscara sobre una columna libre se acepta, y crear después la
 * vista-contrato sobre esa columna YA enmascarada también. Lo que no se puede es alterar la columna
 * con el objeto ya atado.
 *
 * Se emite RAISERROR severidad 16 —falla ruidosa— y no un aviso: el plano de FILA ya quedó instalado
 * (va antes en `setupSQL`), así que lo que este error corta es exactamente el plano de columna. Un
 * install parcial y silencioso es lo que produjo este defecto en primer lugar.
 */
function maskPreflightSQL(qTable: string, columns: string[]): string {
  // Se buscan SOLO las dependencias A NIVEL DE COLUMNA de las columnas que se van a enmascarar.
  //
  // La versión ingenua sumaba también la dependencia de objeto (`referenced_minor_id = 0`), y el
  // arnés la refutó de inmediato: **la propia SECURITY POLICY de fila es `SCHEMABINDING`** y deja su
  // fila de objeto, así que el preflight se disparaba contra el artefacto que el mismo setup acababa
  // de instalar — un falso positivo que habría roto toda instalación con reglas de columna.
  // Medido: un objeto schema-bound registra una fila por CADA columna que referencia (`secpol` ata
  // solo la columna del predicado; una vista-contrato ata las de su proyección). Con eso alcanza y
  // sobra para distinguir «ata la columna que voy a enmascarar» de «toca esta tabla».
  const dependeDeAlgunaColumna = (alias: string) =>
    columns
      .map((c) => `${alias}.referenced_minor_id = COLUMNPROPERTY(OBJECT_ID(N'${qTable}'), N'${c}', 'ColumnId')`)
      .join(`\n           OR `)
  return (
    `IF EXISTS (\n` +
    `    SELECT 1 FROM sys.sql_expression_dependencies d\n` +
    `    WHERE d.referenced_id = OBJECT_ID(N'${qTable}') AND d.is_schema_bound_reference = 1\n` +
    `      AND (${dependeDeAlgunaColumna('d')})\n` +
    `)\n` +
    `BEGIN\n` +
    `    DECLARE @vergis_bound NVARCHAR(MAX) = (\n` +
    `        SELECT STRING_AGG(QUOTENAME(OBJECT_SCHEMA_NAME(x.referencing_id)) + N'.' + QUOTENAME(OBJECT_NAME(x.referencing_id)), N', ')\n` +
    `        FROM (SELECT DISTINCT e.referencing_id FROM sys.sql_expression_dependencies e\n` +
    `              WHERE e.referenced_id = OBJECT_ID(N'${qTable}') AND e.is_schema_bound_reference = 1\n` +
    `                AND (${dependeDeAlgunaColumna('e')})) x\n` +
    `    );\n` +
    `    RAISERROR(N'vergis: no se puede instalar el plano de columna sobre ${qTable}: la(s) columna(s) ${columns.map((c) => `[${c}]`).join(', ')} están atadas por objeto(s) SCHEMABINDING (%s). No es incompatibilidad sino ORDEN: la máscara se aplica ANTES de crear ese objeto, y el objeto se recrea después. El plano de FILA ya quedó instalado.', 16, 1, @vergis_bound);\n` +
    `END`
  )
}

// --- PLANO DE COLUMNA (#163 H6): la VISTA DE MÁSCARA, evaluada POR REQUEST ---
//
// POR QUÉ HAY DOS MECANISMOS, y qué cubre cada uno (no es redundancia, es defensa en profundidad):
//
//   · DDM (`ADD MASKED WITH`, arriba) vive en la COLUMNA y discrimina por el permiso `UNMASK` del
//     PRINCIPAL. Cubre el rodeo: quien esquive la vista y consulte la tabla directa —o abra el
//     endpoint con otra herramienta— sigue viendo la máscara si su principal no tiene `UNMASK`.
//     Lo que NO puede hacer es honrar el claim, porque Vergis no transporta al sujeto como
//     principal (la brecha medida arriba: UN Service Principal por `database_ref`).
//   · LA VISTA vive en la PROYECCIÓN y discrimina por SESSION_CONTEXT, que es el ÚNICO canal por el
//     que el sujeto llega al motor (`execute-sql-dwh` reinyecta todas las settings del nodo en cada
//     request). Es lo que vuelve efectivo el claim de la `ColumnRule`: un predicado de fila no puede
//     reescribir una celda — solo la proyección puede.
//
// CÓMO INTERACTÚAN, dicho sin adornos: la vista LEE la columna base, así que si el principal del pool
// NO tiene `UNMASK`, el `THEN` de la rama en claro devuelve igual el default de DDM y el sujeto con
// claim tampoco ve el valor. Es decir: **los dos mecanismos componen en la dirección segura (gana el
// más restrictivo), y la vista solo discrimina de verdad si el principal tiene `UNMASK`.** Si ese
// Service Principal lo tiene o no **NO ESTÁ MEDIDO** — es el mismo gate que `PENDINGS.md` ya declara
// conjetura (`MASKED WITH` × vistas-contrato). Lo que este emisor garantiza es lo que se puede
// garantizar sin motor vivo: que el artefacto se emite, se revierte y se declara.
//
// LO QUE LA VISTA **NO** HACE: no se schemabindea. `WITH SCHEMABINDING` tomaría rehén TODA la
// proyección (issue #164, y sería mucho peor que el rehén de la security policy) y además bloquearía
// el `ALTER COLUMN … ADD MASKED` de DDM sobre la columna que la vista lee. Sin schemabinding, los dos
// mecanismos son instalables y reversibles de forma independiente.
//
// Y NO CAMBIA EL PLANO DE FILA: la vista se apoya en la tabla, y la SECURITY POLICY está atada a la
// TABLA — leer a través de la vista sigue pasando por el `FILTER PREDICATE`. La vista no filtra nada.

/**
 * Centinela TIPADO de una celda enmascarada. El criterio es el de `default()` de DDM —el default DEL
 * TIPO— por la razón del diseño §4.1: la vista tiene que devolver el MISMO tipo que la tabla, y un
 * literal de texto en una columna `INT` cambiaría el esquema, que es justo lo que no se miente.
 *
 * | Familia | Centinela |
 * |---|---|
 * | texto (`CHAR`, `NCHAR`, `VARCHAR`, `NVARCHAR`, `TEXT`, `NTEXT`, `SYSNAME`) | `MASK_VALUE` (`•••`) |
 * | numérica (`TINYINT`…`BIGINT`, `DECIMAL`, `NUMERIC`, `FLOAT`, `REAL`, `MONEY`, `BIT`) | `0` |
 * | fecha/hora (`DATE`, `DATETIME`, `DATETIME2`, `SMALLDATETIME`, `DATETIMEOFFSET`) | `1900-01-01` |
 * | `TIME` | `00:00:00` |
 * | binaria (`BINARY`, `VARBINARY`) | `0x00` |
 * | `UNIQUEIDENTIFIER` | el GUID nulo |
 * | **cualquier otra** | **LANZA** |
 *
 * TRAMPA del centinela de texto: en una columna NO Unicode (`VARCHAR`/`CHAR`) con collation que no
 * sea UTF-8, `•` no tiene representación y el motor devuelve `?`. Sigue siendo máscara —jamás el
 * valor— pero deja de ser el literal legible; se elige igual porque tener DOS centinelas de texto
 * partiría el contrato del oráculo por un detalle de collation.
 *
 * FAIL-CLOSED ante un tipo que no se sabe mapear: se LANZA. La alternativa —proyectar la columna sin
 * `CASE`— la serviría EN CLARO, que es el único desenlace inadmisible; y sustituirla por `NULL`
 * mentiría «el dato no existe» (por eso `MASK_VALUE` no es vacío ni nulo, ver `ir.ts`).
 */
const TEXT_TYPES = new Set(['CHAR', 'NCHAR', 'VARCHAR', 'NVARCHAR', 'TEXT', 'NTEXT', 'SYSNAME'])
const NUMERIC_TYPES = new Set([
  'BIT', 'TINYINT', 'SMALLINT', 'INT', 'INTEGER', 'BIGINT',
  'DECIMAL', 'NUMERIC', 'FLOAT', 'REAL', 'MONEY', 'SMALLMONEY',
])
const DATE_TYPES = new Set(['DATE', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'DATETIMEOFFSET'])
const BINARY_TYPES = new Set(['BINARY', 'VARBINARY'])

function maskSentinel(column: string, rawType: string): string {
  const type = columnType(rawType) // misma validación de forma que el parámetro del predicado
  const base = type.replace(/\(.*$/, '').trim().toUpperCase()
  // `MASK_VALUE` es una constante del IR (no dato del usuario) y no contiene comillas: interpolarla
  // es seguro. Si algún día llevara `'`, el escape iría acá — y el test de anti-inyección lo vería.
  if (TEXT_TYPES.has(base)) return `CAST(N'${MASK_VALUE}' AS ${type})`
  if (NUMERIC_TYPES.has(base)) return `CAST(0 AS ${type})`
  if (DATE_TYPES.has(base)) return `CAST('1900-01-01' AS ${type})`
  if (base === 'TIME') return `CAST('00:00:00' AS ${type})`
  if (BINARY_TYPES.has(base)) return `CAST(0x00 AS ${type})`
  if (base === 'UNIQUEIDENTIFIER') return `CAST('00000000-0000-0000-0000-000000000000' AS ${type})`
  throw new VergisError({
    error: 'policy/codegen',
    code: 'mask-sentinel-unknown-type',
    path: `columnTypes.${column}`,
    value: rawType,
    message: `No hay centinela tipado para '${rawType}' (columna '${column}'), y servirla sin máscara sería servirla en claro.`,
    remediation: `Declarar la columna con un tipo de familia soportada (texto, numérica, fecha/hora, binaria, uniqueidentifier), o retirar la regla de columna.`,
  })
}

/** Claims que habilitan cada columna enmascarada, en orden de declaración y sin repetir.
 *  VARIAS reglas sobre la MISMA columna se combinan con AND —hacen falta TODOS los claims para verla
 *  en claro—: es exactamente lo que hace `maskedColumns` del oráculo (basta que UNA regla no traiga
 *  su claim para enmascarar). Cualquier otra combinación abriría de más. */
function claimsByMaskedColumn(policy: PolicyDecl): Map<string, string[]> {
  const out = new Map<string, string[]>()
  columnRules(policy).forEach((rule: ColumnRule, i: number) => {
    validateColumnRule(rule, i)
    const col = ident('columnRule.column', rule.column)
    const claim = ident('columnRule.claim', rule.claim)
    const prev = out.get(col) ?? []
    if (!prev.includes(claim)) prev.push(claim)
    out.set(col, prev)
  })
  return out
}

/**
 * Construye la vista de máscara. `null` cuando no hay reglas de columna (la ausencia no cambia NADA:
 * ni un byte del SQL) o cuando el target no declaró `tableColumns` — sin la proyección declarada la
 * vista no se puede emitir conservando la forma, y **no emitirla no abre nada**: quien consulte la
 * tabla queda con DDM, que enmascara para todos (dirección segura, sobre-enmascara).
 */
function buildMaskView(
  policy: PolicyDecl,
  target: FabricTarget,
  schema: string,
  table: string,
  qTable: string,
): FabricMaskView | null {
  const byColumn = claimsByMaskedColumn(policy)
  if (byColumn.size === 0 || target.tableColumns === undefined) return null
  const columns = target.tableColumns.map((c) => ident('tableColumns', c))
  // Una regla sobre una columna que la proyección declarada NO trae es una declaración rancia o un
  // typo, y el typo es el modo de falla caro: la columna que se quería proteger se serviría en claro
  // y nadie lo notaría. Rompe. (El oráculo tolera la regla huérfana porque no conoce el esquema —
  // acá sí se conoce, y por eso acá se exige.)
  for (const col of byColumn.keys()) {
    if (!columns.includes(col)) {
      throw new VergisError({
        error: 'policy/codegen',
        code: 'mask-view-column-not-projected',
        path: 'tableColumns',
        value: col,
        message: `La regla de columna protege '${col}', que no está en la proyección declarada de '${table}'.`,
        remediation: `Agregar '${col}' a target.tableColumns (con su tipo en columnTypes) o corregir la regla.`,
      })
    }
  }
  const name = ident('maskViewName', target.maskViewName ?? `vw_mask_${table}`)
  const qView = `[${schema}].[${name}]`
  const projection = columns.map((col) => {
    const claims = byColumn.get(col)
    if (claims === undefined) return `        [${col}]`
    // MISMO transporte que el predicado de fila: `SESSION_CONTEXT` + guard `<> ''`. El claim se honra
    // por PRESENCIA (igual que en el IR): su VALOR no se compara con nada y jamás se interpola — lo
    // único que viaja al SQL es el NOMBRE del setting, que es identificador validado.
    const guard = claims.map((c) => `${sessionRead(c)} <> N''`).join(' AND ')
    // El tipo de una columna ENMASCARADA es obligatorio, y NO cae al default `NVARCHAR(4000)` como el
    // parámetro del predicado: las dos ramas del `CASE` tienen que dar el MISMO tipo que la tabla, y
    // asumir texto sobre una columna `INT` haría que el motor intentara convertir el centinela a `INT`
    // en cada request (precedencia de tipos de T-SQL) — un error de ejecución, en producción, por una
    // suposición del compilador. Se exige el dato en vez de suponerlo.
    const declared = target.columnTypes?.[col]
    if (declared === undefined) {
      throw new VergisError({
        error: 'policy/codegen',
        code: 'mask-view-column-type-missing',
        path: `columnTypes.${col}`,
        value: undefined,
        message: `La vista de máscara necesita el tipo SQL de '${col}' para emitir un centinela del MISMO tipo que la columna.`,
        remediation: `Declarar target.columnTypes['${col}'] con el tipo real de la columna (p. ej. NVARCHAR(50), INT, DATE).`,
      })
    }
    const sentinel = maskSentinel(col, declared)
    return `        CASE WHEN ${guard} THEN [${col}] ELSE ${sentinel} END AS [${col}]`
  })
  return {
    name,
    qualifiedName: qView,
    columns,
    maskedColumns: [...byColumn.keys()],
    claimsByColumn: Object.fromEntries(byColumn),
    createSQL: `CREATE VIEW ${qView}\nAS\n    SELECT\n${projection.join(',\n')}\n    FROM ${qTable};`,
    dropSQL: `DROP VIEW IF EXISTS ${qView};`,
  }
}

/**
 * Compila el IR a enforcement de Fabric / Azure SQL (push-down). `public` no genera policy
 * (solo gatea el reporte; sin RLS de fila).
 */
export function compileFabric(policy: PolicyDecl, target: FabricTarget): FabricEnforcement {
  const schema = ident('schema', target.schema ?? 'dbo')
  const table = ident('table', target.table)
  const fnName = ident('functionName', target.functionName ?? `fn_pol_${table}`)
  const polName = ident('policyName', target.policyName ?? `secpol_${table}`)
  const q = (name: string) => `[${schema}].[${name}]`
  const qTable = `[${schema}].[${table}]`
  // Plano de COLUMNA. Se calcula ANTES de la bifurcación pública/gobernada porque los dos planos son
  // ortogonales: un PI `grant: all` puede tener una columna sensible sin dejar de ser público — y esa
  // es justo la instancia que el diseño nombra como driver (§6).
  const maskedCols = maskedColumnsOf(policy)
  const maskView = buildMaskView(policy, target, schema, table, qTable)
  // Teardown SIMÉTRICO e inverso al setup: primero la vista (el consumidor más externo), después las
  // máscaras, después la security policy y al final la función (la función no se puede tirar antes que
  // la policy: SCHEMABINDING).
  // Sin reglas de columna esta lista es EXACTAMENTE la de siempre — la ausencia de reglas no cambia
  // ningún byte del SQL, que es la promesa que fijan los tests de SQL exacto.
  const teardownSQL = [
    ...(maskView ? [maskView.dropSQL] : []),
    ...maskedCols.map((c) => dropMaskedSQL(qTable, c)),
    `DROP SECURITY POLICY IF EXISTS ${q(polName)};`,
    `DROP FUNCTION IF EXISTS ${q(fnName)};`,
  ]
  // Idempotencia por tira-y-recrea, igual que el resto del emisor: el setup arranca con el teardown
  // completo (que ya desinstala vista y máscaras) y las vuelve a poner al final. La vista va ÚLTIMA:
  // se apoya en la tabla ya gobernada, y `CREATE VIEW` tiene que encabezar su batch en T-SQL — por eso
  // viaja como UNA sentencia suelta de `setupSQL`, nunca concatenada a otra.
  // El preflight encabeza el plano de columna: diagnostica el bloqueo por SCHEMABINDING con los
  // objetos nombrados, en vez de dejar que el motor devuelva «one or more objects access this column».
  // Sin reglas de columna no se emite ni una línea — la promesa de «la ausencia de reglas no mueve un
  // byte del SQL» sigue intacta, y hay un test que la sostiene.
  const maskSetup =
    maskedCols.length === 0
      ? []
      : [maskPreflightSQL(qTable, maskedCols), ...maskedCols.map((c) => addMaskedSQL(qTable, c)), ...(maskView ? [maskView.createSQL] : [])]
  // Claims que solo aparecen en reglas de COLUMNA: hay que inyectarlos igual. No es cosmético — es la
  // misma nuance de no-fuga del pool (doc 10 §5): un claim que el nodo NO inyecta no se reescribe en
  // cada request, así que el `SESSION_CONTEXT` de OTRO consumidor sobreviviría en la conexión reusada
  // y DESENMASCARARÍA la columna para quien no trae el claim. Se inyectan siempre que haya reglas,
  // exista o no la vista: el canal tiene que quedar en estado conocido ('' → máscara).
  const columnClaims = [...new Set(columnRules(policy).map((r) => ident('columnRule.claim', r.claim)))]
  // Envuelve el DROP+CREATE en una transacción cuando el target lo pide (ver FabricTarget.transactional):
  // cierra la ventana sin RLS entre el DROP y el CREATE. Off por default → contrato de sentencias sueltas.
  const wrapSetup = (stmts: string[]): string[] =>
    target.transactional ? ['SET XACT_ABORT ON;\nBEGIN TRANSACTION;', ...stmts, 'COMMIT;'] : stmts

  // PÚBLICO (grant: all) → artefacto ALLOW-ALL: la policy EXISTE y permite TODA fila (función
  // SIN `WHERE`). Así "público" se manifiesta en el motor y "sin policy" = sin gobierno (no público).
  // Necesita una columna para el bindeo sintáctico del FILTER PREDICATE — la función la ignora.
  if (isPublic(policy)) {
    if (!target.bindColumn) {
      throw new VergisError({
        error: 'policy/compile',
        code: 'public-no-bindcolumn',
        path: 'bindColumn',
        message: `La policy pública de '${table}' necesita 'bindColumn' (columna existente) para el FILTER PREDICATE allow-all.`,
        remediation: `Pasar target.bindColumn (cualquier columna de la tabla; la función la ignora).`,
      })
    }
    const bindCol = ident('bindColumn', target.bindColumn)
    const colType = columnType(target.columnTypes?.[bindCol] ?? DEFAULT_COLUMN_TYPE)
    const createFunctionPub =
      `CREATE FUNCTION ${q(fnName)}(@${bindCol} ${colType})\n` +
      `    RETURNS TABLE\n    WITH SCHEMABINDING\n    AS RETURN\n` +
      `        SELECT 1 AS vergis_allowed;` // SIN WHERE → allow-all (apertura explícita gobernada)
    const createPolicyPub =
      `CREATE SECURITY POLICY ${q(polName)}\n` +
      `    ADD FILTER PREDICATE ${q(fnName)}(${bindCol}) ON ${qTable}\n    WITH (STATE = ON);`
    return {
      prefix: SETTINGS_PREFIX,
      setupSQL: wrapSetup([...teardownSQL, createFunctionPub, createPolicyPub, ...maskSetup]),
      teardownSQL,
      // Pública: sin claim de FILA que inyectar — pero los planos son ortogonales, y un PI público con
      // columna sensible sí necesita el claim de la regla en cada request (ver la nota de arriba).
      injections: columnClaims.map((claim) => ({ setting: settingForClaim(claim), claim })),
      policy,
      maskView,
      // ANDAMIAJE, no criterio: la función ignora este argumento (issue #164). Se declara para que
      // el gate de regresión de terreno sepa que esta columna está atada antes de intentar el ALTER.
      // Las enmascaradas se suman por la MISMA finalidad y por un lazo distinto: este enforcement es
      // dueño de un atributo de esa columna (su máscara), así que retirarla o alterarla exige pasar
      // por acá. Sin esta declaración la dependencia volvería a descubrirse en producción.
      schemaDependencies: [...new Set([bindCol, ...maskedCols])],
    }
  }

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

  return {
    prefix: SETTINGS_PREFIX,
    // Idempotente: tirar lo previo (policy antes que función por la dependencia de SCHEMABINDING) y recrear.
    setupSQL: wrapSetup([...teardownSQL, createFunction, createPolicy, ...maskSetup]),
    teardownSQL,
    injections: [...new Set([...policy.predicates.map((p) => p.claim), ...columnClaims])].map((claim) => ({
      setting: settingForClaim(claim),
      claim,
    })),
    policy,
    maskView,
    // Acá la dependencia SÍ es semántica: son las columnas que la política usa como criterio. Las
    // enmascaradas se suman (ver la nota del caso público): su máscara es propiedad de este artefacto.
    schemaDependencies: [...new Set([...columns, ...maskedCols])],
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
  if (isPublic(policy)) return true // allow-all: toda fila pasa
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
    if (pred.op === 'eq') return !s.includes(',') && cell === s // guard de cardinalidad (multi-valor → deny)
    return stringSplit(s).includes(cell)
  }
  const results = policy.predicates.map(evalPred)
  return policy.combine === 'or' ? results.some(Boolean) : results.every(Boolean)
}

/** Las columnas que el enforcement compilado sirve enmascaradas (las del `ADD MASKED WITH` emitido). */
export function fabricMaskedColumns(enforcement: FabricEnforcement): string[] {
  return maskedColumnsOf(enforcement.policy)
}

/**
 * Emulación de la FILA SERVIDA (no solo del filtro): aplica el plano de fila con `emulateFabric` y
 * después sustituye las celdas que DDM enmascara. Es el camino del differential test contra el
 * oráculo (`applyPolicy`), que compara filas Y celdas.
 *
 * **NORMALIZACIÓN A CENTINELA, y por qué no es trampa**: el motor NO devuelve `MASK_VALUE`. `default()`
 * devuelve el default DEL TIPO —`0` en un `INT`, `XXXX` en texto—, así que el valor de máscara es del
 * BACK-END y no del IR; no existe un literal único que el oráculo pueda predecir sin conocer el tipo
 * SQL de cada celda, y forzarlo (casteando la columna a texto) cambiaría el ESQUEMA. Este emulador
 * traduce «esta celda vino enmascarada por el motor» al centinela del oráculo, que es lo que permite
 * sostener **un solo oráculo** para los dos back-ends. Lo que la normalización afirma es la POSICIÓN
 * de la máscara (qué celdas), jamás su contenido: si algún día un test comparara el literal del motor,
 * este emulador NO es la fuente para eso.
 *
 * **Y no enmascara por claims**: DDM es DDL de specialize-time y discrimina por `UNMASK` del principal,
 * que en Vergis es uno solo para todos los consumidores (ver la nota del plano de columna arriba). Por
 * eso acá no se miran los `settings`: el motor enmascara para todo sujeto. Modelarlo condicionado al
 * claim sería un emulador que describe algo que el SQL emitido no hace — el modo de falla exacto que
 * un differential test existe para atrapar, y que lo volvería un test que se aprueba a sí mismo.
 */
export function emulateFabricRows(
  enforcement: FabricEnforcement,
  settings: Record<string, string>,
  rows: Record<string, unknown>[],
  refs: ReferenceData = {},
): Record<string, unknown>[] {
  const visible = rows.filter((r) => emulateFabric(enforcement, settings, r, refs))
  const masked = new Set(fabricMaskedColumns(enforcement))
  if (masked.size === 0) return visible // sin reglas: ni una copia — el emisor tampoco cambió nada
  // `maskRow` es el del oráculo a propósito: conserva la forma y no inventa la clave de una columna
  // que la fila no trae. Una divergencia de forma entre motor y oráculo no puede nacer de acá.
  return visible.map((r) => maskRow(r, masked))
}

// --- Emulación de la VISTA DE MÁSCARA (#163 H6) -----------------------------

/**
 * Columnas que la VISTA sirve enmascaradas EN ESTE REQUEST. Es la lectura de la condición emitida —
 * `CASE WHEN <SESSION_CONTEXT del claim> <> N'' [AND …] THEN col ELSE centinela END`— evaluada sobre
 * el mismo mapa de settings que el prelude manda al motor: una columna va en claro si TODOS sus
 * claims llegaron con valor, y enmascarada si a alguno le tocó '' (ausente o vacío).
 */
export function fabricMaskViewColumns(enforcement: FabricEnforcement, settings: Record<string, string>): Set<string> {
  const out = new Set<string>()
  const view = enforcement.maskView
  if (!view) return out
  for (const col of view.maskedColumns) {
    const claims = view.claimsByColumn[col] ?? []
    if (claims.some((c) => (settings[settingForClaim(c)] ?? '') === '')) out.add(col)
  }
  return out
}

/**
 * Emulación de la fila SERVIDA POR LA VISTA: filtro de fila (que sigue viniendo de la SECURITY POLICY
 * sobre la tabla — la vista no filtra) + sustitución de las celdas cuyo `CASE` cayó en la rama del
 * centinela para los settings de ESTE request. Es el camino del differential test contra `applyPolicy`
 * y el único de los dos emuladores que puede honrar el claim, porque es el único cuyo SUT lo mira.
 *
 * **Contra `emulateFabricRows`, y por qué conviven**: aquél emula DDM, que enmascara para TODOS
 * (la brecha medida del hito 2); éste emula la vista, que enmascara por sujeto. Sirviendo la TABLA
 * manda el primero; sirviendo la VISTA manda el segundo, con la salvedad —**no medida**— de que si el
 * Service Principal del pool no tiene `UNMASK`, DDM también aplasta la rama en claro de la vista y lo
 * servido vuelve a ser lo que emula `emulateFabricRows`. Los dos resultados están en la dirección
 * segura respecto del oráculo (enmascaran igual o de más; nunca de menos).
 *
 * **NORMALIZACIÓN A CENTINELA** — misma razón que en `emulateFabricRows`, y misma disciplina: el motor
 * devuelve el centinela TIPADO (`0`, `1900-01-01`, `•••`…), que depende del tipo SQL y no del IR. Este
 * emulador afirma la POSICIÓN de la máscara (qué celdas), jamás su contenido.
 *
 * Sin vista emitida devuelve lo que se serviría al consultar la TABLA: DDM si hay reglas, las filas
 * filtradas tal cual si no hay ninguna.
 */
export function emulateFabricMaskView(
  enforcement: FabricEnforcement,
  settings: Record<string, string>,
  rows: Record<string, unknown>[],
  refs: ReferenceData = {},
): Record<string, unknown>[] {
  if (!enforcement.maskView) return emulateFabricRows(enforcement, settings, rows, refs)
  const visible = rows.filter((r) => emulateFabric(enforcement, settings, r, refs))
  const masked = fabricMaskViewColumns(enforcement, settings)
  if (masked.size === 0) return visible
  return visible.map((r) => maskRow(r, masked))
}
