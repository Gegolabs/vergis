import { randomUUID, createHash } from 'node:crypto'
import { openSqliteDb, persistSqliteDb, type SqlDb } from './sqlite'

/**
 * `NotasStore` — el store de la CAPA DE NOTAS (vergis#84): la familia de lo que una persona dice
 * SOBRE lo que ve. Dos especies, un solo modelo:
 *
 *  - **impresión** — el objeto congelado: lo que se vio, tal como se vio (filas + forma + recorte +
 *    procedencia + watermark + autoría). Nace de un «Imprimir» deliberado o de la materialización
 *    perezosa que dispara la primera anotación.
 *  - **anotación** — nota anclada a una impresión (a una celda, fila, agregado, elemento o a la
 *    impresión entera). Su autorización se resolvió AL IMPRIMIR: el congelado ya nació RLS-filtrado.
 *  - **comentario** — nota anclada a un REGISTRO gobernado (`entity_ref` + llave de negocio), no a
 *    una impresión. Permanente, público en su alcance, y unifica lo dicho sobre ese registro ENTRE
 *    PIs. Su gate se verifica AL ESCRIBIR contra el dato, jamás contra un token por fila.
 *
 * Reglas que el modelo hace cumplir por construcción:
 *  - El motor JAMÁS lee una nota: nada de acá entra a una query, filtro, KPI o cruce.
 *  - La compartición es un acto gobernado, auditado y revocable — el registro ES la fuente de
 *    «compartidas conmigo» (control y funcionalidad en una sola pieza).
 *  - Una referencia que no resuelve se MARCA (`ref_rota`), jamás se borra: el trabajo humano
 *    sobrevive al cambio del dato.
 *  - La voz nace en el modelo (`contenido_tipo`, `audio_ref`) sin función: v1 solo escribe texto.
 *
 * Impl. embebida (SQLite vía WASM, sin binarios nativos) sobre `sqlite.ts`; la interfaz es el seam
 * para swappear a Postgres sin tocar el resto.
 */

// ── Modelo ─────────────────────────────────────────────────────────────────────────────────────
export type NotaEspecie = 'anotacion' | 'comentario'
export type NotaContenidoTipo = 'texto' | 'voz'
export type NotaObjetivoTipo = 'celda' | 'fila' | 'agregado' | 'elemento' | 'impresion'
/** Canal de entrega. v1/v2-enlace: nada viaja como contenido — solo el enlace (decisión A6). */
export type EntregaCanal = 'enlace'

export interface Impresion {
  id: string
  piSlug: string
  /** Email del emisor, en minúscula. */
  owner: string
  createdAt: string
  /** Se refresca con cada nota; es la base de la retención (A7). */
  lastActivity: string
  page?: string
  /** Parámetros de navegación, canónico (claves ordenadas). */
  ctxJson?: string
  /** Procedencia: `identity.version` del spec (si existe) + hash corto del spec. */
  specVersion?: string
  /** Frescura del dato al imprimir (ISO). */
  watermark?: string
  /** sha256(piSlug|page|ctxJson|watermark|specVersion) — la regla D4 de identidad del sustrato. */
  substrateHash: string
  /** `true` = «Imprimir» deliberado; `false` = materialización perezosa. */
  explicita: boolean
  /** Congelado completo: árbol resuelto + título + tema + comentarios visibles. */
  frozenJson: string
}

export interface Nota {
  id: string
  especie: NotaEspecie
  autor: string
  createdAt: string
  editedAt?: string
  contenidoTipo: NotaContenidoTipo
  contenido: string
  /** NULL en v1 (la voz llega en v2; el modelo nace sabiendo). */
  audioRef?: string
  /** Hilo append: NULL = nota raíz. */
  parentId?: string
  /** Ancla de una ANOTACIÓN (requerido si `especie='anotacion'`). */
  impresionId?: string
  objetivoTipo?: NotaObjetivoTipo
  /** Referencia dentro del congelado (dataset+key+campo, id de elemento…). */
  objetivoJson?: string
  /** Ancla de un COMENTARIO: tabla gobernada normalizada `schema.tabla`. */
  entityRef?: string
  /** Valores de la llave de negocio, canónico (claves ordenadas). */
  llaveJson?: string
  /** Comentario de celda: el campo. Ausente = comentario de fila. */
  campo?: string
  /** Referencia no resuelta: se marca, jamás se borra. */
  refRota: boolean
}

export interface Comparticion {
  id: string
  impresionId: string
  emisor: string
  receptor: string
  createdAt: string
  revocadaAt?: string
}

export interface Entrega {
  id: string
  impresionId: string
  destinatario: string
  canal: EntregaCanal
  enviadoAt?: string
  enviadoPor?: string
}

/** Datos del sustrato de una impresión: lo que define su identidad (D4) + el congelado. */
export interface AbrirImpresionInput {
  piSlug: string
  owner: string
  page?: string
  /** Parámetros de navegación (se canonizan acá: claves ordenadas). */
  ctx?: Record<string, unknown>
  specVersion?: string
  watermark?: string
  /** El congelado: se serializa tal cual. */
  frozen: unknown
  /** `true` = «Imprimir» deliberado. */
  explicita?: boolean
}

export interface CrearNotaInput {
  especie: NotaEspecie
  autor: string
  contenido: string
  contenidoTipo?: NotaContenidoTipo
  audioRef?: string
  parentId?: string
  impresionId?: string
  objetivoTipo?: NotaObjetivoTipo
  objetivo?: unknown
  entityRef?: string
  llave?: Record<string, unknown>
  campo?: string
}

/** Resumen de lo comentado sobre una llave (lo que el marcador de la tabla necesita). */
export interface ComentarioResumen {
  /** Llave canónica (la misma que `canonicalKey` produce). */
  llave: string
  /** Total de comentarios sobre esa llave (fila + celdas). */
  count: number
  /** Conteo por campo comentado; la clave `''` agrupa los comentarios de FILA. */
  porCampo: Record<string, number>
}

export class NotasConflict extends Error {}

export interface NotasStore {
  /** Abre (o reutiliza) la impresión del sustrato. Dedupe por `substrate_hash`+`owner` dentro de
   *  `sessionWindowMs`: misma vista, mismo watermark y misma sesión ⇒ la MISMA impresión (D4). */
  abrirImpresion(input: AbrirImpresionInput, opts?: { sessionWindowMs?: number; now?: number }): Promise<Impresion>
  getImpresion(id: string): Promise<Impresion | null>
  listImpresiones(owner: string): Promise<Impresion[]>
  /** Impresiones compartidas VIGENTES con este correo (una compartición revocada no aparece). */
  listCompartidasCon(email: string): Promise<{ impresion: Impresion; comparticion: Comparticion }[]>
  /** Borra la impresión en cascada (notas + comparticiones + entregas). */
  borrarImpresion(id: string): Promise<void>
  crearNota(input: CrearNotaInput): Promise<Nota>
  getNota(id: string): Promise<Nota | null>
  /** Notas de una impresión (raíces y respuestas, en orden de creación). */
  notasDe(impresionId: string): Promise<Nota[]>
  /** Edita el contenido — SOLO el autor (otro ⇒ NotasConflict). */
  editarNota(id: string, autor: string, contenido: string): Promise<Nota>
  /** Borra — SOLO el autor. Una nota CON respuestas se marca vacía (el hilo no se rompe). */
  borrarNota(id: string, autor: string): Promise<{ vaciada: boolean }>
  /** El hilo de una nota: su raíz + toda la descendencia, en orden de creación. */
  hiloDe(notaId: string): Promise<Nota[]>
  /** Comentarios sobre estas llaves de una entidad — el insumo de los marcadores. */
  comentariosDe(entityRef: string, llaves: Record<string, unknown>[]): Promise<ComentarioResumen[]>
  /** Comentarios (el hilo completo) sobre UNA llave de una entidad. */
  comentariosDeLlave(entityRef: string, llave: Record<string, unknown>): Promise<Nota[]>
  /** Marca una referencia como no resuelta. Jamás borra. */
  marcarRefRota(notaId: string): Promise<void>
  compartir(impresionId: string, emisor: string, receptor: string): Promise<Comparticion>
  revocar(impresionId: string, emisor: string, receptor: string): Promise<void>
  /** Comparticiones de una impresión (incluidas las revocadas: el registro es auditoría). */
  comparticionesDe(impresionId: string): Promise<Comparticion[]>
  /** ¿Este correo tiene compartición VIGENTE sobre la impresión? */
  tieneComparticionVigente(impresionId: string, email: string): Promise<boolean>
  /** Registro de entrega (estructura D13; sin escritores en v1). */
  registrarEntrega(impresionId: string, destinatario: string, canal: EntregaCanal, enviadoPor?: string): Promise<Entrega>
  entregasDe(impresionId: string): Promise<Entrega[]>
  /** Purga por retención: borra las impresiones con `last_activity` anterior al corte. Devuelve los ids. */
  purgarPorRetencion(cutoffIso: string): Promise<string[]>
  close(): Promise<void>
}

// ── Helpers puros ──────────────────────────────────────────────────────────────────────────────

/** Ventana de sesión de trabajo por defecto (regla D4): 12 h. */
export const SESSION_WINDOW_MS = 12 * 60 * 60 * 1000

const now = (): string => new Date().toISOString()
const normalizar = (email: string): string => email.trim().toLowerCase()

/** JSON canónico: claves ordenadas en todo nivel — dos objetos equivalentes producen el MISMO texto. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** Llave de negocio canónica (el índice D6 y los marcadores se indexan por esta cadena). */
export function canonicalKey(llave: Record<string, unknown>): string {
  return canonicalJson(llave)
}

/**
 * Llave de negocio de una fila, según las columnas declaradas en el `anchor`.
 *
 * Los valores se COERCIONAN A STRING a propósito: la misma llave se construye en el servidor (desde
 * las filas servidas) y en el navegador (desde el payload de la tabla), y un `4021` numérico contra
 * un `"4021"` textual produciría dos llaves distintas para el mismo registro — el marcador
 * aparecería, o no, según por dónde se pregunte. La coerción a texto lo hace determinista.
 */
export function llaveDeFila(row: Record<string, unknown>, key: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of [...key].sort()) out[k] = row[k] == null ? '' : String(row[k])
  return out
}

/** Normaliza una referencia de entidad gobernada a `schema.tabla` en minúscula (misma convención
 *  que `server/sql-tables.ts`: es la que unifica el comentario ENTRE PIs). */
export function normalizeEntityRef(ref: string): string {
  return ref
    .split('.')
    .map((p) => p.trim().replace(/^[["']|[\]"']$/g, '').trim().toLowerCase())
    .filter(Boolean)
    .join('.')
}

/** Hash del SUSTRATO (regla D4): nueva vista, nuevo watermark o spec distinto ⇒ impresión nueva. */
export function substrateHash(parts: {
  piSlug: string
  page?: string
  ctxJson?: string
  watermark?: string
  specVersion?: string
}): string {
  const s = [parts.piSlug, parts.page ?? '', parts.ctxJson ?? '', parts.watermark ?? '', parts.specVersion ?? ''].join('|')
  return createHash('sha256').update(s).digest('hex')
}

// ── DDL ────────────────────────────────────────────────────────────────────────────────────────
const IMPRESION_DDL = `CREATE TABLE IF NOT EXISTS impresion (
  id TEXT PRIMARY KEY,
  pi_slug TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  page TEXT,
  ctx_json TEXT,
  spec_version TEXT,
  watermark TEXT,
  substrate_hash TEXT NOT NULL,
  explicita INTEGER NOT NULL DEFAULT 0,
  frozen_json TEXT NOT NULL
);`
const NOTA_DDL = `CREATE TABLE IF NOT EXISTS nota (
  id TEXT PRIMARY KEY,
  especie TEXT NOT NULL CHECK (especie IN ('anotacion','comentario')),
  autor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  contenido_tipo TEXT NOT NULL CHECK (contenido_tipo IN ('texto','voz')),
  contenido TEXT NOT NULL,
  audio_ref TEXT,
  parent_id TEXT,
  impresion_id TEXT,
  objetivo_tipo TEXT CHECK (objetivo_tipo IN ('celda','fila','agregado','elemento','impresion')),
  objetivo_json TEXT,
  entity_ref TEXT,
  llave_json TEXT,
  campo TEXT,
  ref_rota INTEGER NOT NULL DEFAULT 0
);`
const NOTA_LLAVE_DDL = `CREATE TABLE IF NOT EXISTS nota_llave (
  nota_id TEXT NOT NULL, llave TEXT NOT NULL, valor TEXT NOT NULL,
  PRIMARY KEY (nota_id, llave)
);`
const COMPARTICION_DDL = `CREATE TABLE IF NOT EXISTS comparticion (
  id TEXT PRIMARY KEY, impresion_id TEXT NOT NULL,
  emisor TEXT NOT NULL, receptor TEXT NOT NULL,
  created_at TEXT NOT NULL, revocada_at TEXT
);`
const ENTREGA_DDL = `CREATE TABLE IF NOT EXISTS entrega (
  id TEXT PRIMARY KEY, impresion_id TEXT NOT NULL,
  destinatario TEXT NOT NULL, canal TEXT NOT NULL CHECK (canal IN ('enlace')),
  enviado_at TEXT, enviado_por TEXT
);`
// Índices de los accesos calientes: dedupe de impresión, «mis impresiones», marcadores por llave.
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_impresion_owner ON impresion (owner, last_activity)`,
  `CREATE INDEX IF NOT EXISTS idx_impresion_substrate ON impresion (substrate_hash, owner)`,
  `CREATE INDEX IF NOT EXISTS idx_nota_impresion ON nota (impresion_id)`,
  `CREATE INDEX IF NOT EXISTS idx_nota_entidad ON nota (entity_ref, llave_json)`,
  `CREATE INDEX IF NOT EXISTS idx_nota_parent ON nota (parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_comparticion_receptor ON comparticion (receptor)`,
]

// ── Impl. SQLite ───────────────────────────────────────────────────────────────────────────────
export class SqliteNotasStore implements NotasStore {
  private constructor(
    private db: SqlDb,
    private file: string | null,
  ) {}

  /** `file` null → DB en memoria (tests). Si el archivo existe, se carga. */
  static async open(file: string | null): Promise<SqliteNotasStore> {
    const db = await openSqliteDb(file)
    db.run(IMPRESION_DDL)
    db.run(NOTA_DDL)
    db.run(NOTA_LLAVE_DDL)
    db.run(COMPARTICION_DDL)
    db.run(ENTREGA_DDL)
    for (const ix of INDEXES) db.run(ix)
    return new SqliteNotasStore(db, file)
  }

  private persist(): void {
    persistSqliteDb(this.db, this.file)
  }

  private rows(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const out: Record<string, unknown>[] = []
    while (stmt.step()) out.push(stmt.getAsObject())
    stmt.free()
    return out
  }

  // ── Impresiones ──
  async abrirImpresion(input: AbrirImpresionInput, opts: { sessionWindowMs?: number; now?: number } = {}): Promise<Impresion> {
    const owner = normalizar(input.owner)
    const ctxJson = input.ctx && Object.keys(input.ctx).length ? canonicalJson(input.ctx) : undefined
    const hash = substrateHash({ piSlug: input.piSlug, page: input.page, ctxJson, watermark: input.watermark, specVersion: input.specVersion })
    const nowMs = opts.now ?? Date.now()
    const windowMs = opts.sessionWindowMs ?? SESSION_WINDOW_MS
    const ts = new Date(nowMs).toISOString()
    // Dedupe (D4): misma vista + mismo watermark + misma sesión de trabajo ⇒ la MISMA impresión.
    // Una explícita nueva SIEMPRE nace: «Imprimir» es un acto deliberado, no una reutilización.
    if (!input.explicita) {
      const cutoff = new Date(nowMs - windowMs).toISOString()
      const hit = this.rows(
        `SELECT * FROM impresion WHERE substrate_hash = ? AND owner = ? AND last_activity >= ? ORDER BY last_activity DESC LIMIT 1`,
        [hash, owner, cutoff],
      )[0]
      if (hit) {
        this.db.run(`UPDATE impresion SET last_activity = ? WHERE id = ?`, [ts, String(hit['id'])])
        this.persist()
        return { ...impresionRow(hit), lastActivity: ts }
      }
    }
    const imp: Impresion = {
      id: randomUUID(),
      piSlug: input.piSlug,
      owner,
      createdAt: ts,
      lastActivity: ts,
      page: input.page,
      ctxJson,
      specVersion: input.specVersion,
      watermark: input.watermark,
      substrateHash: hash,
      explicita: input.explicita === true,
      frozenJson: JSON.stringify(input.frozen ?? null),
    }
    this.db.run(
      `INSERT INTO impresion (id, pi_slug, owner, created_at, last_activity, page, ctx_json, spec_version, watermark, substrate_hash, explicita, frozen_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [imp.id, imp.piSlug, imp.owner, imp.createdAt, imp.lastActivity, imp.page ?? null, imp.ctxJson ?? null, imp.specVersion ?? null, imp.watermark ?? null, imp.substrateHash, imp.explicita ? 1 : 0, imp.frozenJson],
    )
    this.persist()
    return imp
  }

  async getImpresion(id: string): Promise<Impresion | null> {
    const r = this.rows(`SELECT * FROM impresion WHERE id = ?`, [id])[0]
    return r ? impresionRow(r) : null
  }

  async listImpresiones(owner: string): Promise<Impresion[]> {
    return this.rows(`SELECT * FROM impresion WHERE owner = ? ORDER BY last_activity DESC`, [normalizar(owner)]).map(impresionRow)
  }

  async listCompartidasCon(email: string): Promise<{ impresion: Impresion; comparticion: Comparticion }[]> {
    const rs = this.rows(
      `SELECT c.id AS c_id, c.impresion_id AS c_impresion_id, c.emisor AS c_emisor, c.receptor AS c_receptor,
              c.created_at AS c_created_at, c.revocada_at AS c_revocada_at, i.*
         FROM comparticion c JOIN impresion i ON i.id = c.impresion_id
        WHERE c.receptor = ? AND c.revocada_at IS NULL
        ORDER BY c.created_at DESC`,
      [normalizar(email)],
    )
    return rs.map((r) => ({
      impresion: impresionRow(r),
      comparticion: {
        id: String(r['c_id']),
        impresionId: String(r['c_impresion_id']),
        emisor: String(r['c_emisor']),
        receptor: String(r['c_receptor']),
        createdAt: String(r['c_created_at']),
        revocadaAt: r['c_revocada_at'] == null ? undefined : String(r['c_revocada_at']),
      },
    }))
  }

  async borrarImpresion(id: string): Promise<void> {
    // Cascada explícita (sql.js no aplica FKs por defecto): notas, sus llaves, comparticiones, entregas.
    this.db.run(`DELETE FROM nota_llave WHERE nota_id IN (SELECT id FROM nota WHERE impresion_id = ?)`, [id])
    this.db.run(`DELETE FROM nota WHERE impresion_id = ?`, [id])
    this.db.run(`DELETE FROM comparticion WHERE impresion_id = ?`, [id])
    this.db.run(`DELETE FROM entrega WHERE impresion_id = ?`, [id])
    this.db.run(`DELETE FROM impresion WHERE id = ?`, [id])
    this.persist()
  }

  // ── Notas ──
  async crearNota(input: CrearNotaInput): Promise<Nota> {
    const especie = input.especie
    if (especie === 'anotacion' && !input.impresionId) {
      throw new NotasConflict('Una anotación exige una impresión (impresionId).')
    }
    if (especie === 'comentario' && !input.entityRef) {
      throw new NotasConflict('Un comentario exige una entidad gobernada (entityRef).')
    }
    const contenidoTipo: NotaContenidoTipo = input.contenidoTipo ?? 'texto'
    const entityRef = input.entityRef ? normalizeEntityRef(input.entityRef) : undefined
    const llaveJson = input.llave && Object.keys(input.llave).length ? canonicalKey(input.llave) : undefined
    if (especie === 'comentario' && !llaveJson) {
      throw new NotasConflict('Un comentario exige la llave de negocio del registro (llave).')
    }
    const nota: Nota = {
      id: randomUUID(),
      especie,
      autor: normalizar(input.autor),
      createdAt: now(),
      contenidoTipo,
      contenido: input.contenido,
      audioRef: input.audioRef,
      parentId: input.parentId,
      impresionId: input.impresionId,
      objetivoTipo: input.objetivoTipo,
      objetivoJson: input.objetivo === undefined ? undefined : canonicalJson(input.objetivo),
      entityRef,
      llaveJson,
      campo: input.campo,
      refRota: false,
    }
    this.db.run(
      `INSERT INTO nota (id, especie, autor, created_at, edited_at, contenido_tipo, contenido, audio_ref, parent_id,
                         impresion_id, objetivo_tipo, objetivo_json, entity_ref, llave_json, campo, ref_rota)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [nota.id, nota.especie, nota.autor, nota.createdAt, null, nota.contenidoTipo, nota.contenido, nota.audioRef ?? null, nota.parentId ?? null,
       nota.impresionId ?? null, nota.objetivoTipo ?? null, nota.objetivoJson ?? null, nota.entityRef ?? null, nota.llaveJson ?? null, nota.campo ?? null],
    )
    // Índice D6 («¿qué se ha dicho sobre la empleada 4021?»): se puebla en AMBAS especies.
    for (const [llave, valor] of Object.entries(input.llave ?? {})) {
      this.db.run(`INSERT OR REPLACE INTO nota_llave (nota_id, llave, valor) VALUES (?,?,?)`, [nota.id, llave, String(valor ?? '')])
    }
    // Toda nota refresca la actividad de su impresión: la retención cuenta desde el último uso.
    if (nota.impresionId) this.db.run(`UPDATE impresion SET last_activity = ? WHERE id = ?`, [nota.createdAt, nota.impresionId])
    this.persist()
    return nota
  }

  async getNota(id: string): Promise<Nota | null> {
    const r = this.rows(`SELECT * FROM nota WHERE id = ?`, [id])[0]
    return r ? notaRow(r) : null
  }

  async notasDe(impresionId: string): Promise<Nota[]> {
    return this.rows(`SELECT * FROM nota WHERE impresion_id = ? ORDER BY created_at ASC`, [impresionId]).map(notaRow)
  }

  async editarNota(id: string, autor: string, contenido: string): Promise<Nota> {
    const nota = await this.getNota(id)
    if (!nota) throw new NotasConflict('La nota no existe.')
    if (nota.autor !== normalizar(autor)) throw new NotasConflict('Solo el autor puede editar su nota.')
    const ts = now()
    this.db.run(`UPDATE nota SET contenido = ?, edited_at = ? WHERE id = ?`, [contenido, ts, id])
    if (nota.impresionId) this.db.run(`UPDATE impresion SET last_activity = ? WHERE id = ?`, [ts, nota.impresionId])
    this.persist()
    return { ...nota, contenido, editedAt: ts }
  }

  async borrarNota(id: string, autor: string): Promise<{ vaciada: boolean }> {
    const nota = await this.getNota(id)
    if (!nota) throw new NotasConflict('La nota no existe.')
    if (nota.autor !== normalizar(autor)) throw new NotasConflict('Solo el autor puede borrar su nota.')
    const hijas = this.rows(`SELECT id FROM nota WHERE parent_id = ?`, [id]).length
    if (hijas > 0) {
      // Con respuestas colgando: se VACÍA, no se borra — el hilo no se rompe (D14).
      this.db.run(`UPDATE nota SET contenido = '', edited_at = ? WHERE id = ?`, [now(), id])
      this.persist()
      return { vaciada: true }
    }
    this.db.run(`DELETE FROM nota_llave WHERE nota_id = ?`, [id])
    this.db.run(`DELETE FROM nota WHERE id = ?`, [id])
    this.persist()
    return { vaciada: false }
  }

  async hiloDe(notaId: string): Promise<Nota[]> {
    let root = await this.getNota(notaId)
    if (!root) return []
    // Subir hasta la raíz (el hilo es la conversación completa, se entre por donde se entre). El
    // guard del ASCENSO es propio: reusar el del descenso haría que el descenso saltara los nodos
    // por los que se subió (el hilo saldría con un solo elemento).
    const subiendo = new Set<string>([root.id])
    while (root.parentId) {
      const parent = await this.getNota(root.parentId)
      if (!parent || subiendo.has(parent.id)) break
      subiendo.add(parent.id)
      root = parent
    }
    const vistos = new Set<string>([root.id])
    const out: Nota[] = [root]
    let frontera = [root.id]
    while (frontera.length) {
      const hijos = frontera.flatMap((pid) => this.rows(`SELECT * FROM nota WHERE parent_id = ? ORDER BY created_at ASC`, [pid]).map(notaRow))
      const nuevos = hijos.filter((h) => !vistos.has(h.id))
      for (const h of nuevos) vistos.add(h.id)
      out.push(...nuevos)
      frontera = nuevos.map((h) => h.id)
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  async comentariosDe(entityRef: string, llaves: Record<string, unknown>[]): Promise<ComentarioResumen[]> {
    const ref = normalizeEntityRef(entityRef)
    const wanted = new Set(llaves.map(canonicalKey))
    if (wanted.size === 0) return []
    const out = new Map<string, ComentarioResumen>()
    // Solo viajan las llaves ANOTADAS (render escaso): se consulta por entidad y se filtra contra
    // las llaves de las filas YA servidas bajo RLS — nunca se expone una llave que el lector no vio.
    for (const r of this.rows(`SELECT llave_json, campo FROM nota WHERE especie = 'comentario' AND entity_ref = ?`, [ref])) {
      const llave = String(r['llave_json'] ?? '')
      if (!wanted.has(llave)) continue
      const campo = r['campo'] == null ? '' : String(r['campo'])
      const hit = out.get(llave) ?? { llave, count: 0, porCampo: {} }
      hit.count += 1
      hit.porCampo[campo] = (hit.porCampo[campo] ?? 0) + 1
      out.set(llave, hit)
    }
    return [...out.values()]
  }

  async comentariosDeLlave(entityRef: string, llave: Record<string, unknown>): Promise<Nota[]> {
    return this.rows(
      `SELECT * FROM nota WHERE especie = 'comentario' AND entity_ref = ? AND llave_json = ? ORDER BY created_at ASC`,
      [normalizeEntityRef(entityRef), canonicalKey(llave)],
    ).map(notaRow)
  }

  async marcarRefRota(notaId: string): Promise<void> {
    this.db.run(`UPDATE nota SET ref_rota = 1 WHERE id = ?`, [notaId])
    this.persist()
  }

  // ── Compartición ──
  async compartir(impresionId: string, emisor: string, receptor: string): Promise<Comparticion> {
    const imp = await this.getImpresion(impresionId)
    if (!imp) throw new NotasConflict('La impresión no existe.')
    const em = normalizar(emisor)
    const rc = normalizar(receptor)
    if (imp.owner !== em) throw new NotasConflict('Solo el dueño de la impresión puede compartirla.')
    if (!rc) throw new NotasConflict('Falta el receptor.')
    if (rc === em) throw new NotasConflict('La impresión ya es tuya: no hace falta compartirla contigo.')
    // Re-compartir tras revocar: se REACTIVA el registro vigente (el rastro de la revocación queda).
    const vig = this.rows(`SELECT * FROM comparticion WHERE impresion_id = ? AND receptor = ? AND revocada_at IS NULL`, [impresionId, rc])[0]
    if (vig) return comparticionRow(vig)
    const c: Comparticion = { id: randomUUID(), impresionId, emisor: em, receptor: rc, createdAt: now() }
    this.db.run(`INSERT INTO comparticion (id, impresion_id, emisor, receptor, created_at, revocada_at) VALUES (?,?,?,?,?,NULL)`, [c.id, c.impresionId, c.emisor, c.receptor, c.createdAt])
    this.persist()
    return c
  }

  async revocar(impresionId: string, emisor: string, receptor: string): Promise<void> {
    const imp = await this.getImpresion(impresionId)
    if (!imp) throw new NotasConflict('La impresión no existe.')
    if (imp.owner !== normalizar(emisor)) throw new NotasConflict('Solo el dueño de la impresión puede revocar.')
    // Revocación HACIA ADELANTE: el receptor pierde acceso; sus notas ya escritas persisten.
    this.db.run(`UPDATE comparticion SET revocada_at = ? WHERE impresion_id = ? AND receptor = ? AND revocada_at IS NULL`, [now(), impresionId, normalizar(receptor)])
    this.persist()
  }

  async comparticionesDe(impresionId: string): Promise<Comparticion[]> {
    return this.rows(`SELECT * FROM comparticion WHERE impresion_id = ? ORDER BY created_at ASC`, [impresionId]).map(comparticionRow)
  }

  async tieneComparticionVigente(impresionId: string, email: string): Promise<boolean> {
    return this.rows(`SELECT id FROM comparticion WHERE impresion_id = ? AND receptor = ? AND revocada_at IS NULL`, [impresionId, normalizar(email)]).length > 0
  }

  // ── Entrega (estructura D13; sin escritores en v1) ──
  async registrarEntrega(impresionId: string, destinatario: string, canal: EntregaCanal, enviadoPor?: string): Promise<Entrega> {
    const e: Entrega = { id: randomUUID(), impresionId, destinatario: normalizar(destinatario), canal, enviadoAt: now(), enviadoPor: enviadoPor ? normalizar(enviadoPor) : undefined }
    this.db.run(`INSERT INTO entrega (id, impresion_id, destinatario, canal, enviado_at, enviado_por) VALUES (?,?,?,?,?,?)`, [e.id, e.impresionId, e.destinatario, e.canal, e.enviadoAt ?? null, e.enviadoPor ?? null])
    this.persist()
    return e
  }

  async entregasDe(impresionId: string): Promise<Entrega[]> {
    return this.rows(`SELECT * FROM entrega WHERE impresion_id = ? ORDER BY enviado_at ASC`, [impresionId]).map((r) => ({
      id: String(r['id']),
      impresionId: String(r['impresion_id']),
      destinatario: String(r['destinatario']),
      canal: String(r['canal']) as EntregaCanal,
      enviadoAt: r['enviado_at'] == null ? undefined : String(r['enviado_at']),
      enviadoPor: r['enviado_por'] == null ? undefined : String(r['enviado_por']),
    }))
  }

  // ── Retención (A7) ──
  async purgarPorRetencion(cutoffIso: string): Promise<string[]> {
    const ids = this.rows(`SELECT id FROM impresion WHERE last_activity < ?`, [cutoffIso]).map((r) => String(r['id']))
    for (const id of ids) await this.borrarImpresion(id)
    return ids
  }

  async close(): Promise<void> {
    this.persist()
    this.db.close()
  }
}

function impresionRow(r: Record<string, unknown>): Impresion {
  return {
    id: String(r['id']),
    piSlug: String(r['pi_slug']),
    owner: String(r['owner']),
    createdAt: String(r['created_at']),
    lastActivity: String(r['last_activity']),
    page: r['page'] == null ? undefined : String(r['page']),
    ctxJson: r['ctx_json'] == null ? undefined : String(r['ctx_json']),
    specVersion: r['spec_version'] == null ? undefined : String(r['spec_version']),
    watermark: r['watermark'] == null ? undefined : String(r['watermark']),
    substrateHash: String(r['substrate_hash']),
    explicita: Number(r['explicita']) === 1,
    frozenJson: String(r['frozen_json']),
  }
}

function notaRow(r: Record<string, unknown>): Nota {
  return {
    id: String(r['id']),
    especie: String(r['especie']) as NotaEspecie,
    autor: String(r['autor']),
    createdAt: String(r['created_at']),
    editedAt: r['edited_at'] == null ? undefined : String(r['edited_at']),
    contenidoTipo: String(r['contenido_tipo']) as NotaContenidoTipo,
    contenido: String(r['contenido'] ?? ''),
    audioRef: r['audio_ref'] == null ? undefined : String(r['audio_ref']),
    parentId: r['parent_id'] == null ? undefined : String(r['parent_id']),
    impresionId: r['impresion_id'] == null ? undefined : String(r['impresion_id']),
    objetivoTipo: r['objetivo_tipo'] == null ? undefined : (String(r['objetivo_tipo']) as NotaObjetivoTipo),
    objetivoJson: r['objetivo_json'] == null ? undefined : String(r['objetivo_json']),
    entityRef: r['entity_ref'] == null ? undefined : String(r['entity_ref']),
    llaveJson: r['llave_json'] == null ? undefined : String(r['llave_json']),
    campo: r['campo'] == null ? undefined : String(r['campo']),
    refRota: Number(r['ref_rota']) === 1,
  }
}

function comparticionRow(r: Record<string, unknown>): Comparticion {
  return {
    id: String(r['id']),
    impresionId: String(r['impresion_id']),
    emisor: String(r['emisor']),
    receptor: String(r['receptor']),
    createdAt: String(r['created_at']),
    revocadaAt: r['revocada_at'] == null ? undefined : String(r['revocada_at']),
  }
}

/**
 * Selector del store por entorno (la costura del swap): `VERGIS_NOTES_DB` → archivo SQLite embebido;
 * sin él, `<baseDir>/notas.sqlite`.
 */
export async function openNotasStore(baseDir: string): Promise<NotasStore> {
  const file = process.env['VERGIS_NOTES_DB'] ?? `${baseDir.replace(/\/$/, '')}/notas.sqlite`
  return SqliteNotasStore.open(file)
}
