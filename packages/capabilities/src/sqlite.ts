import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import initSqlJs from 'sql.js'

/**
 * Apertura/persistencia de SQLite embebido (sql.js / WASM, sin binarios nativos) — la base común
 * de los stores embebidos del nodo (anotaciones, data maestra local, lista de admins). El WASM se
 * localiza por resolución de módulos (robusto en dev con tsx y en el bundle de dist/).
 *
 * ── El plano de escritura único ────────────────────────────────────────────────────────────────
 * Un store embebido se vuelca COMPLETO en cada persist (`export()` + rename atómico), así que el
 * modelo de operación admite **exactamente un escritor** por archivo. Esa condición la garantiza el
 * plano de control del nodo; acá vive lo que la hace *verificable* en vez de confiada:
 *
 * - **Gate de versión de esquema** (`schemaVersion` + `PRAGMA user_version`): un archivo escrito por
 *   una versión de esquema MÁS NUEVA que la soportada no se abre en escritura — se niega nombrando
 *   ambas versiones. Fail-closed: la incompatibilidad se descubre al abrir, no aguas abajo.
 * - **Respaldo pre-migración**: la primera apertura en escritura por una versión más nueva que la
 *   registrada en el archivo lo copia a `<archivo>.pre-<versión>.bak`. Es recuperación de desastre,
 *   NO el camino de vuelta atrás: restaurar un respaldo descarta escrituras posteriores, y eso solo
 *   lo decide una persona.
 * - **Fencing de escritura concurrente**: antes del rename se verifica que el archivo vigente siga
 *   siendo el que dejó el último persist de ESTE handle. Si no lo es, otro escritor pasó por ahí: el
 *   persist se aborta con error ruidoso y el handle queda `degraded` en vez de volcar encima. La
 *   época del plano de control se estampa en `control_meta` en cada persist, y abrir en escritura con
 *   una época MENOR que la del archivo se niega.
 *
 *   **La señal es el CONTENIDO, no los metadatos del FS** (#299). Los metadatos siguen ahí como vía
 *   rápida —si inodo, tamaño y mtime son los mismos, nada se movió y no se lee nada—, pero cuando se
 *   mueven sin cambiar el tamaño el veredicto lo da el **hash de los bytes**, no el inodo. El motivo
 *   está medido: con `VERGIS_OUT` en un bind-mount de macOS, el `statSync` posterior al propio rename
 *   devuelve un inodo DISTINTO con el mismo tamaño y el mismo mtime al microsegundo, y el guard
 *   declaraba escritura ajena sobre su propia escritura (`deploy/carga/CORRIDAS.md` §3, brazo A:
 *   819 ok / 4.181 fallos; brazo B con volumen nombrado, 5.000/5.000).
 *
 *   Lo que se pierde al no creerle al inodo es NADA que el guard existiera para atrapar: el único
 *   caso que el contenido no distingue es que el otro escritor haya dejado bytes IDÉNTICOS, y ahí no
 *   hay nada suyo que este volcado pueda borrar. Todo lo demás sigue detectado, y en particular el
 *   adversario real —otro nodo del plano de control— es imposible que empate: cada persist estampa
 *   `control_meta` con su `writer` y su `written_at`, así que dos volcados distintos difieren siempre
 *   en bytes aunque coincidan en tamaño, mtime e inodo.
 *
 * `openSqliteDb(file)` sin opciones devuelve un handle **crudo** (sin gate ni fencing) — es la vía
 * de bajo nivel para tests y utilitarios. Los stores del nodo abren siempre con opciones.
 *
 * Lo que este mecanismo NO cubre: los logs append-only en modo archivo (p. ej. la auditoría de
 * administración) no son volcados completos sino *append* que se entrelaza — otro modo de operación,
 * con su propio tratamiento, ajeno a este guard.
 */

export interface SqlStmt {
  bind: (v: unknown[]) => void
  step: () => boolean
  getAsObject: () => Record<string, unknown>
  reset: () => void
  free: () => void
}

export interface SqlDb {
  run: (sql: string, params?: unknown[]) => void
  exec: (sql: string) => { columns: string[]; values: unknown[][] }[]
  prepare: (s: string) => SqlStmt
  export: () => Uint8Array
  close: () => void
}

// ─── Contrato del plano de control de escritura ────────────────────────────────────────────────

/** Época del plano de control: un número, o un proveedor que lo lee al momento de usarlo. */
export type EpochProvider = number | (() => number)

export interface SqliteControlOptions {
  /**
   * Época del plano de control que se estampa en cada persist. El plano de control la provee (y la
   * incrementa en cada relevo); el default 0 es el del nodo único (`VERGIS_CONTROL=single`) y el de
   * los tests, donde no hay relevo posible.
   */
  epoch?: EpochProvider
  /** Identidad del escritor que queda registrada en `control_meta`. Default: `pid:<pid>`. */
  writer?: string
  /** Fencing de escritura concurrente. Default `true`. `false` = comportamiento sin protección. */
  fencing?: boolean
  /** Respaldo `<archivo>.pre-<versión>.bak` al adoptar un archivo de esquema anterior. Default `true`. */
  backupOnUpgrade?: boolean
  /**
   * `write` (default) aplica el gate de esquema, estampa versión y época, y arma el fencing.
   * `read` abre un handle de **inspección**: no estampa nada, no aplica el gate (expone la versión y
   * la época del archivo para que quien compare decida) y **jamás escribe** — un persist sobre un
   * handle de lectura se ignora, se cuenta en el estado y se avisa una vez en el log.
   */
  mode?: 'write' | 'read'
}

export interface SqliteOpenOptions extends SqliteControlOptions {
  /** Versión de esquema que soporta el código que abre. Se escribe como `PRAGMA user_version`. */
  schemaVersion: number
}

/** Estado consultable del guard de un handle: lo que un reporte de salud necesita saber. */
export interface SqliteControlStatus {
  file: string
  mode: 'write' | 'read'
  /** Versión de esquema que soporta este código. */
  schemaSupported: number
  /** Versión que traía el archivo al abrirse (0 = archivo anterior al esquema declarado). */
  fileVersion: number
  /** Época del plano de control con la que se abrió / se estampó el último persist. */
  epoch: number
  /** Época que traía el archivo al abrirse. */
  fileEpoch: number
  writer: string
  fencing: boolean
  /** `true` = este handle detectó otro escritor y dejó de poder volcar con seguridad. */
  degraded: boolean
  degradedReason?: string
  persists: number
  lastPersistAt?: string
  /** Volcados pedidos a un handle de lectura y descartados (deberían ser 0). */
  readOnlyPersistsIgnored: number
  /** Ruta del respaldo pre-migración, si esta apertura lo creó. */
  backupCreated?: string
}

const ERR_SCHEMA_TOO_NEW = 'SQLITE_SCHEMA_TOO_NEW'
const ERR_EPOCH_FENCED = 'SQLITE_EPOCH_FENCED'
const ERR_CONCURRENT_WRITE = 'SQLITE_CONCURRENT_WRITE'

/** El archivo lo escribió un esquema más nuevo que el soportado: no se abre en escritura. */
export class SqliteSchemaTooNewError extends Error {
  readonly code = ERR_SCHEMA_TOO_NEW
  constructor(
    readonly file: string,
    readonly fileVersion: number,
    readonly schemaSupported: number,
  ) {
    super(
      `esquema no soportado en '${file}': el archivo declara la versión ${fileVersion} y este código ` +
        `soporta hasta la ${schemaSupported}. Abrirlo en escritura degradaría el archivo, así que no se abre.`,
    )
    this.name = 'SqliteSchemaTooNewError'
  }
}

/** La época del plano de control es anterior a la registrada en el archivo: no se abre en escritura. */
export class SqliteEpochFencedError extends Error {
  readonly code = ERR_EPOCH_FENCED
  constructor(
    readonly file: string,
    readonly epoch: number,
    readonly fileEpoch: number,
  ) {
    super(
      `época de control obsoleta en '${file}': este handle trae la época ${epoch} y el archivo ya fue ` +
        `escrito por la época ${fileEpoch}. El control pasó a otro nodo; no se abre en escritura.`,
    )
    this.name = 'SqliteEpochFencedError'
  }
}

/** Otro escritor tocó el archivo desde el último persist de este handle: el volcado se aborta. */
export class SqliteConcurrentWriteError extends Error {
  readonly code = ERR_CONCURRENT_WRITE
  constructor(
    readonly file: string,
    readonly detail: string,
  ) {
    super(`escritura concurrente detectada en '${file}': ${detail}. El volcado se aborta sin tocar el archivo.`)
    this.name = 'SqliteConcurrentWriteError'
  }
}

interface Fingerprint {
  ino: number
  size: number
  mtimeMs: number
  /** Hash de los bytes del archivo tal como los dejó (o los leyó) este handle. La señal del guard. */
  hash: string
}

interface Guard {
  file: string
  mode: 'write' | 'read'
  epochOf: () => number
  fencing: boolean
  status: SqliteControlStatus
  /** Huella del archivo tal como lo dejó este handle. `null` = el archivo no existía. */
  seen: Fingerprint | null
}

const guards = new WeakMap<SqlDb, Guard>()
/** Handles que detectaron un escritor concurrente. Condición terminal: se conserva para reportarla. */
const degradedGuards = new Set<Guard>()

const CONTROL_META_DDL = `CREATE TABLE IF NOT EXISTS control_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL DEFAULT 0,
  writer TEXT,
  written_at TEXT
);`

interface FsStamp {
  ino: number
  size: number
  mtimeMs: number
}

const hashOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Metadatos del archivo vigente. `null` = no existe. NO decide por sí solo: ver `persistSqliteDb`. */
const stampOf = (file: string): FsStamp | null => {
  try {
    const s = statSync(file)
    return { ino: Number(s.ino), size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

/** Huella = metadatos del archivo vigente + el hash de los bytes que se sabe que tiene. */
const withHash = (st: FsStamp | null, hash: string): Fingerprint | null => (st === null ? null : { ...st, hash })

const describe = (f: Fingerprint | FsStamp | null): string =>
  f === null ? 'ausente' : `ino=${f.ino} size=${f.size} mtime=${f.mtimeMs}`

const resolveEpoch = (e: EpochProvider | undefined): number => {
  const v = typeof e === 'function' ? e() : (e ?? 0)
  if (!Number.isFinite(v)) throw new TypeError(`época de control inválida: ${String(v)}`)
  return Math.trunc(v)
}

const readUserVersion = (db: SqlDb): number => {
  const res = db.exec('PRAGMA user_version')
  const raw = res[0]?.values?.[0]?.[0]
  return typeof raw === 'number' ? raw : 0
}

const hasTable = (db: SqlDb, name: string): boolean =>
  db.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${name}'`).length > 0

const readFileEpoch = (db: SqlDb): number => {
  if (!hasTable(db, 'control_meta')) return 0
  const raw = db.exec('SELECT MAX(epoch) FROM control_meta')[0]?.values?.[0]?.[0]
  return typeof raw === 'number' ? raw : 0
}

const stampControlMeta = (db: SqlDb, epoch: number, writer: string): void => {
  db.run(CONTROL_META_DDL)
  db.run(
    `INSERT INTO control_meta (id, epoch, writer, written_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, writer = excluded.writer, written_at = excluded.written_at`,
    [epoch, writer, new Date().toISOString()],
  )
}

/**
 * Arma el guard del handle: gate de esquema, respaldo pre-migración, gate de época y huella inicial.
 * Lanza (sin dejar el handle registrado) cuando el archivo es de un esquema más nuevo o de una época
 * posterior — los dos casos en que abrir en escritura haría daño.
 */
function attachControlGuard(db: SqlDb, file: string, opts: SqliteOpenOptions, fileHash: string | undefined): void {
  const supported = opts.schemaVersion
  if (!Number.isInteger(supported) || supported < 0) {
    throw new TypeError(`schemaVersion debe ser un entero >= 0 (recibido: ${String(supported)})`)
  }
  const mode = opts.mode ?? 'write'
  const existed = existsSync(file)
  const fileVersion = readUserVersion(db)
  const fileEpoch = readFileEpoch(db)
  const epoch = resolveEpoch(opts.epoch)
  if (mode === 'write') {
    // Los dos casos en que abrir para escribir haría daño: el archivo lo escribió un esquema más
    // nuevo, o una época posterior del plano de control. Un handle de lectura los expone sin negarse.
    if (fileVersion > supported) throw new SqliteSchemaTooNewError(file, fileVersion, supported)
    if (epoch < fileEpoch) throw new SqliteEpochFencedError(file, epoch, fileEpoch)
  }

  const writer = opts.writer ?? `pid:${process.pid}`
  const status: SqliteControlStatus = {
    file,
    mode,
    schemaSupported: supported,
    fileVersion,
    epoch,
    fileEpoch,
    writer,
    fencing: mode === 'write' && (opts.fencing ?? true),
    degraded: false,
    persists: 0,
    readOnlyPersistsIgnored: 0,
  }

  if (mode === 'write') {
    // Cinturón de respaldo: solo al ADOPTAR un archivo de esquema anterior, y solo una vez por
    // versión destino (idempotente). `fileVersion === 0` es el archivo anterior al esquema declarado.
    if (existed && fileVersion < supported && (opts.backupOnUpgrade ?? true)) {
      const bak = `${file}.pre-${supported}.bak`
      if (!existsSync(bak)) {
        copyFileSync(file, bak)
        status.backupCreated = bak
      }
    }
    // `PRAGMA user_version` no admite binds; `supported` está validado como entero.
    db.run(`PRAGMA user_version = ${supported}`)
    stampControlMeta(db, epoch, writer)
  }

  guards.set(db, {
    file,
    mode,
    epochOf: () => resolveEpoch(opts.epoch),
    fencing: status.fencing,
    status,
    // La huella inicial describe los MISMOS bytes que cargó este handle: releer el archivo abriría
    // una ventana en la que la huella habla de un contenido distinto del que la DB tiene en memoria.
    seen: fileHash === undefined ? null : withHash(stampOf(file), fileHash),
  })
}

function markDegraded(guard: Guard, reason: string): void {
  guard.status.degraded = true
  guard.status.degradedReason = reason
  degradedGuards.add(guard)
  console.error(`[store] ESCRITURA CONCURRENTE en '${guard.file}': ${reason}. Este nodo queda degradado.`)
}

/** Estado del guard de un handle (undefined si se abrió crudo o en memoria). */
export function sqliteControlStatus(db: SqlDb): SqliteControlStatus | undefined {
  return guards.get(db)?.status
}

/** Handles que detectaron un escritor concurrente — la base de un reporte de salud `degraded`. */
export function sqliteDegradedStores(): SqliteControlStatus[] {
  return [...degradedGuards].map((g) => g.status)
}

/** `true` si algún store embebido de este proceso quedó degradado por escritura concurrente. */
export function sqliteAnyDegraded(): boolean {
  return degradedGuards.size > 0
}

/** Abre una DB SQLite. `file` null → en memoria (tests). Si el archivo existe, se carga. */
export async function openSqliteDb(file: string | null, opts?: SqliteOpenOptions): Promise<SqlDb> {
  const sqlJsDist = dirname(createRequire(import.meta.url).resolve('sql.js'))
  const SQL = await initSqlJs({ locateFile: (f: string) => `${sqlJsDist}/${f}` })
  const bytes = file && existsSync(file) ? readFileSync(file) : undefined
  // ⚠ El hash se toma ANTES de construir la Database. sql.js adopta el buffer como el archivo de su
  // VFS en memoria: todo lo que se escriba después (el `PRAGMA user_version` y el sello de
  // `control_meta` del propio guard) MUTA estos mismos bytes, y hashearlos después describiría un
  // contenido que el archivo en disco nunca tuvo. Medido: el guard se declaraba a sí mismo ajeno.
  const fileHash = bytes === undefined ? undefined : hashOf(bytes)
  const db = new SQL.Database(bytes) as unknown as SqlDb
  if (file && opts) {
    try {
      attachControlGuard(db, file, opts, fileHash)
    } catch (e) {
      db.close()
      throw e
    }
  }
  return db
}

/**
 * Vuelca la DB a su archivo (no-op si es en memoria). Volumen bajo → escritura inmediata.
 * Escritura ATÓMICA: escribe a un tmp propio del proceso y hace `rename` (atómico en POSIX sobre el
 * mismo FS). Un crash/OOM/disco-lleno a mitad de write deja el tmp a medias, nunca el archivo
 * vigente — este es el único registro de admins/ACLs/grupos y no hay journal ni respaldo.
 *
 * Con guard armado (ver cabecera): antes del rename se verifica que el archivo vigente sea el que
 * este handle dejó. Si no lo es, el volcado se ABORTA con `SqliteConcurrentWriteError` y el handle
 * queda degradado — vale mucho más un error ruidoso que un volcado que borra lo del otro.
 */
export function persistSqliteDb(db: SqlDb, file: string | null): void {
  if (!file) return
  const guard = guards.get(db)
  if (guard && guard.mode === 'read') {
    // Un handle de inspección no escribe. Se cuenta y se avisa UNA vez: pedirle un volcado es un error
    // de programación, y callarlo sería la pérdida silenciosa que este módulo existe para eliminar.
    guard.status.readOnlyPersistsIgnored += 1
    if (guard.status.readOnlyPersistsIgnored === 1) {
      console.warn(`[store] volcado ignorado en '${file}': el handle se abrió en modo lectura.`)
    }
    return
  }
  if (guard && guard.fencing) {
    const seen = guard.seen
    const actual = stampOf(file)
    // La pregunta del guard es una sola: ¿el archivo vigente tiene el CONTENIDO que dejó este handle?
    // Los metadatos son la vía rápida para responderla sin leer, no la respuesta.
    //
    //   · aparición/desaparición del archivo → drift sin más (no hay contenido que comparar)
    //   · tamaño distinto                    → drift sin leer (bytes distintos, garantizado)
    //   · inodo + tamaño + mtime iguales     → sin drift, sin leer (nada se movió)
    //   · lo demás (mismo tamaño, inodo o mtime movidos) → AMBIGUO: lo resuelve el hash de los bytes.
    //
    // Esa última rama es la que el bind-mount de macOS dispara contra la propia escritura del handle
    // (#299): mismo tamaño, mismo mtime, inodo distinto. Leer el archivo cuesta un read del tamaño del
    // store, y se paga solo cuando los metadatos se movieron — no en el camino sano.
    const drift = ((): string | null => {
      if (seen === null) return actual === null ? null : `apareció un archivo donde este handle no dejó ninguno`
      if (actual === null) return `el archivo que dejó este handle (${describe(seen)}) ya no está`
      if (actual.size !== seen.size || actual.ino !== seen.ino || actual.mtimeMs !== seen.mtimeMs) {
        if (actual.size !== seen.size) {
          return `el archivo vigente (${describe(actual)}) no es el que dejó este handle (${describe(seen)})`
        }
        const hash = ((): string | null => {
          try {
            return hashOf(readFileSync(file))
          } catch {
            return null
          }
        })()
        if (hash !== seen.hash) {
          return (
            `el contenido vigente de ${describe(actual)} no es el que dejó este handle ` +
            `(${describe(seen)}, sha256 ${seen.hash.slice(0, 12)}…; vigente ${hash === null ? 'ilegible' : `${hash.slice(0, 12)}…`})`
          )
        }
        return null
      }
      return null
    })()
    if (drift !== null) {
      markDegraded(guard, drift)
      throw new SqliteConcurrentWriteError(file, drift)
    }
  }
  if (guard && guard.mode === 'write') {
    const epoch = guard.epochOf()
    guard.status.epoch = epoch
    stampControlMeta(db, epoch, guard.status.writer)
  }
  mkdirSync(dirname(file), { recursive: true })
  // tmp propio del proceso: dos escritores que compartieran el mismo tmp se corromperían el volcado
  // entre sí, y el rename entregaría un archivo íntegro con contenido mezclado.
  const tmp = `${file}.${process.pid}.tmp`
  const bytes = Buffer.from(db.export())
  writeFileSync(tmp, bytes)
  renameSync(tmp, file)
  if (guard) {
    // El hash sale de los bytes que este proceso acaba de escribir, no de releer el archivo: releerlo
    // costaría un read por persist y, en el sustrato de #299, sería preguntarle al FS que miente.
    guard.seen = withHash(stampOf(file), hashOf(bytes))
    guard.status.persists += 1
    guard.status.lastPersistAt = new Date().toISOString()
  }
}

/** Lee todas las filas de un prepared SELECT (sin params) como objetos. */
export function selectAll(db: SqlDb, sql: string): Record<string, unknown>[] {
  const res = db.exec(sql)
  if (res.length === 0) return []
  const { columns, values } = res[0]
  return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])))
}
