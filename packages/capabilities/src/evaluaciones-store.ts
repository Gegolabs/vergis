import {
  openSqliteDb,
  persistSqliteDb,
  sqliteControlStatus,
  type SqlDb,
  type SqliteControlOptions,
  type SqliteControlStatus,
} from './sqlite'
import { canonicalJson } from './notas-store'
import { VergisError } from '@vergis/botler'

/**
 * `evaluaciones` — el store embebido del EVALUADOR (doc 013 del cluster «Botler genérico», H2).
 *
 * Persiste lo que un instrumento evaluativo produce, en el orden en que el dominio lo produce:
 *
 *  - **instrumento** — la guía PUBLICADA. Es **inmutable por id**: re-publicar el mismo id con otro
 *    contenido (otro `sha256`) es un CONFLICTO, no un upsert — un instrumento que cambia bajo los
 *    pies invalida en silencio todo intento ya rendido contra él. Retirarlo pone `retirado_at`;
 *    nunca se borra.
 *  - **intento** — lo que un estudiante lleva hecho contra un instrumento. Uno por
 *    `(instrumento, estudiante)`: un re-take de verdad nace como instrumento nuevo.
 *  - **intento_seccion** — el estado por sección (intentos, revisada, puntaje, revisión del corrector).
 *    `checked`/`score` AUSENTES se guardan `NULL`, jamás `0`: la ausencia es información.
 *  - **respuesta** — el valor que el estudiante dio, guardado **verbatim como JSON canónico**. Nada se
 *    interpreta. La confianza S·C·A se DERIVA a columna propia solo cuando el valor tiene la forma
 *    `{choice, conf}`, para que «los errores marcados S» salga de una columna indexable.
 *  - **reporte** — el artefacto de devolución, conservado como está.
 *
 * ── El contrato de la ausencia de pérdida ──────────────────────────────────────────────────────
 * Un progreso importado tiene que poder RECONSTRUIRSE idéntico (ver `evaluaciones-import.ts`
 * `exportarProgreso`). Para eso no basta con guardar los valores: hay que guardar qué claves
 * **estaban** y cuáles **no**, porque una columna `NULL` no distingue «la clave venía en null» de
 * «la clave no venía». Ese registro vive en `extra_json`, que en este store es SIEMPRE un objeto
 * canónico de dos llaves reservadas:
 *
 *     { "extra": { …claves no modeladas, verbatim… }, "ausentes": [ …claves modeladas que faltaban… ] }
 *
 * Un `extra_json` vacío es `{}`. Quien exporta emite cada clave modelada salvo que esté en
 * `ausentes`, y luego mezcla `extra`. El round-trip de la suite es lo que obliga a que nada quede
 * afuera: el test 8 se pone rojo si una sola clave se cae.
 *
 * Impl. SQLite embebida (sql.js/WASM) sobre `sqlite.ts`, con el mismo patrón de `notas-store.ts`:
 * `open`/`reopen` validate-before-swap, `controlStatus()` y `persist()` tras cada mutación.
 */

// ── Modelo ─────────────────────────────────────────────────────────────────────────────────────

/** Confianza declarada por el estudiante al responder: **S**é · **C**reo · **A**divino. */
export type Confianza = 'S' | 'C' | 'A'

/** Las dos llaves reservadas de un `extra_json`: lo no modelado y las claves modeladas ausentes. */
export interface Extra {
  /** Claves que el modelo no tiene columna para guardar, verbatim. */
  extra?: Record<string, unknown>
  /** Claves modeladas que NO venían en el original: al exportar se omiten. */
  ausentes?: string[]
}

export interface Instrumento {
  id: string
  titulo: string
  codigo?: string
  subtitulo?: string
  materia?: string
  grupo?: string
  variante?: string
  /** `practice` | `exam` en Daftar; el store no lo restringe (otro evaluador puede traer otros). */
  modo?: string
  institucion?: string
  /** Del JSON de la guía, por ahora: H4 lo muda al directorio de identidad. */
  estudiante?: string
  departamento?: string
  /** La guía declara `confidence: true` ⇒ sus respuestas piden confianza S·C·A. */
  confianza: boolean
  totalSecciones: number
  totalItems: number
  /** SHA-256 del texto del archivo JSON tal cual — la llave de la inmutabilidad. */
  sha256: string
  publicadoAt: string
  retiradoAt?: string
  invalidado: boolean
  invalidadoRazon?: string
  extra: Extra
}

export type PublicarInstrumentoInput = Omit<Instrumento, 'retiradoAt' | 'extra'> & { extra?: Extra }

export interface RespuestaIn {
  indice: number
  /** El valor tal cual vino (string, null, objeto…). Se guarda como JSON canónico. */
  valor: unknown
}

export interface SeccionIn {
  seccion: number
  respuestas: RespuestaIn[]
  intentos?: number | null
  /** `checked` de Daftar. */
  revisada?: boolean | null
  correctas?: number | null
  total?: number | null
  /** `review` del corrector, verbatim (dos formas conocidas en Daftar). */
  revision?: unknown
  extra?: Extra
}

export interface IntentoIn {
  instrumentoId: string
  estudiante: string
  seccionActual: number
  totalSecciones: number
  iniciadoAt?: string | null
  terminadoAt?: string | null
  actualizadoAt?: string | null
  revisadoAt?: string | null
  bloqueado?: boolean
  secciones: SeccionIn[]
  extra?: Extra
}

export interface Respuesta {
  indice: number
  valorJson: string
  confianza?: Confianza
}

export interface Seccion {
  seccion: number
  respuestas: Respuesta[]
  intentos?: number
  revisada?: boolean
  correctas?: number
  total?: number
  revisionJson?: string
  extra: Extra
}

export interface Intento {
  id: string
  instrumentoId: string
  estudiante: string
  seccionActual: number
  totalSecciones: number
  iniciadoAt?: string
  terminadoAt?: string
  actualizadoAt?: string
  revisadoAt?: string
  bloqueado: boolean
  secciones: Seccion[]
  extra: Extra
}

export interface Reporte {
  id: string
  estudiante?: string
  titulo?: string
  subtitulo?: string
  resumen?: string
  materia?: string
  grupo?: string
  sprint?: string
  sprintOrden?: number
  relacionados: unknown[]
  generadoAt?: string
  contenidoHtml?: string
  extra: Extra
}

export type ReporteIn = Omit<Reporte, 'extra' | 'relacionados'> & { relacionados?: unknown[]; extra?: Extra }

// ── Errores ────────────────────────────────────────────────────────────────────────────────────

/**
 * Se intentó re-publicar un id ya publicado con OTRO contenido. No es un upsert: los intentos ya
 * rendidos apuntan a este id, y cambiarle el instrumento debajo los vuelve incomparables.
 */
export function instrumentoInmutable(id: string, shaVigente: string, shaNuevo: string): VergisError {
  return new VergisError({
    error: 'conflict',
    code: 'evaluaciones/instrumento-inmutable',
    path: `instrumento/${id}`,
    value: { sha256Vigente: shaVigente, sha256Nuevo: shaNuevo },
    message:
      `el instrumento '${id}' ya está publicado con sha256 ${shaVigente} y se intentó publicarlo con ` +
      `${shaNuevo}. Un instrumento es inmutable por id: los intentos rendidos contra él dejarían de ser comparables.`,
    remediation:
      'publica el contenido nuevo con un id nuevo (una versión: `…-v2`) y retira el anterior con `retirarInstrumento`.',
  })
}

// ── Helpers de `extra_json` ────────────────────────────────────────────────────────────────────

const EXTRA_VACIO = '{}'

/** Serializa el par (no modelado, ausentes) en su forma canónica; `{}` cuando ambos están vacíos. */
export function extraJson(e: Extra | undefined): string {
  const extra = e?.extra && Object.keys(e.extra).length ? e.extra : undefined
  const ausentes = e?.ausentes && e.ausentes.length ? [...e.ausentes].sort() : undefined
  if (!extra && !ausentes) return EXTRA_VACIO
  const obj: Record<string, unknown> = {}
  if (extra) obj['extra'] = extra
  if (ausentes) obj['ausentes'] = ausentes
  return canonicalJson(obj)
}

/** Lee un `extra_json` de vuelta. Tolera `NULL` y texto inválido (devuelve el vacío). */
export function parseExtra(raw: unknown): Extra {
  if (raw == null) return {}
  try {
    const v = JSON.parse(String(raw)) as Record<string, unknown>
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Extra = {}
    if (v['extra'] && typeof v['extra'] === 'object') out.extra = v['extra'] as Record<string, unknown>
    if (Array.isArray(v['ausentes'])) out.ausentes = (v['ausentes'] as unknown[]).map(String)
    return out
  } catch {
    return {}
  }
}

/** `true` si la clave modelada no venía en el original y por lo tanto no se emite al exportar. */
export function ausente(e: Extra, clave: string): boolean {
  return e.ausentes?.includes(clave) === true
}

/**
 * La confianza que se DERIVA de un valor de respuesta. Solo la forma `{choice, conf}` cuenta: un
 * string, un `null` y un mapa palabra→categoría no declaran confianza, y confundirlos con `'A'`
 * («adivino») fabricaría un dato que el estudiante nunca dio.
 */
export function confianzaDe(valor: unknown): Confianza | undefined {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return undefined
  const conf = (valor as Record<string, unknown>)['conf']
  if (!('choice' in (valor as Record<string, unknown>))) return undefined
  if (conf === 'S' || conf === 'C' || conf === 'A') return conf
  return undefined
}

// ── DDL ────────────────────────────────────────────────────────────────────────────────────────
const INSTRUMENTO_DDL = `CREATE TABLE IF NOT EXISTS instrumento (
  id TEXT PRIMARY KEY,
  titulo TEXT NOT NULL,
  codigo TEXT,
  subtitulo TEXT,
  materia TEXT,
  grupo TEXT,
  variante TEXT,
  modo TEXT,
  institucion TEXT,
  estudiante TEXT,
  departamento TEXT,
  confianza INTEGER NOT NULL DEFAULT 0,
  total_secciones INTEGER NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  publicado_at TEXT NOT NULL,
  retirado_at TEXT,
  invalidado INTEGER NOT NULL DEFAULT 0,
  invalidado_razon TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}'
);`
const INTENTO_DDL = `CREATE TABLE IF NOT EXISTS intento (
  id TEXT PRIMARY KEY,
  instrumento_id TEXT NOT NULL,
  estudiante TEXT NOT NULL,
  seccion_actual INTEGER NOT NULL DEFAULT 0,
  total_secciones INTEGER NOT NULL DEFAULT 0,
  iniciado_at TEXT,
  terminado_at TEXT,
  actualizado_at TEXT,
  revisado_at TEXT,
  bloqueado INTEGER NOT NULL DEFAULT 0,
  extra_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (instrumento_id, estudiante)
);`
const INTENTO_SECCION_DDL = `CREATE TABLE IF NOT EXISTS intento_seccion (
  intento_id TEXT NOT NULL,
  seccion INTEGER NOT NULL,
  intentos INTEGER,
  revisada INTEGER,
  correctas INTEGER,
  total INTEGER,
  revision_json TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (intento_id, seccion)
);`
const RESPUESTA_DDL = `CREATE TABLE IF NOT EXISTS respuesta (
  intento_id TEXT NOT NULL,
  seccion INTEGER NOT NULL,
  indice INTEGER NOT NULL,
  valor_json TEXT NOT NULL,
  confianza TEXT CHECK (confianza IN ('S','C','A')),
  PRIMARY KEY (intento_id, seccion, indice)
);`
const REPORTE_DDL = `CREATE TABLE IF NOT EXISTS reporte (
  id TEXT PRIMARY KEY,
  estudiante TEXT,
  titulo TEXT,
  subtitulo TEXT,
  resumen TEXT,
  materia TEXT,
  grupo TEXT,
  sprint TEXT,
  sprint_orden INTEGER,
  relacionados_json TEXT NOT NULL DEFAULT '[]',
  generado_at TEXT,
  contenido_html TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}'
);`
// Índices de los accesos que el evaluador hace de verdad: el catálogo del estudiante, los intentos
// de un instrumento, y las respuestas de un intento (que se leen sección por sección).
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_instrumento_estudiante ON instrumento (estudiante, retirado_at)`,
  `CREATE INDEX IF NOT EXISTS idx_intento_instrumento ON intento (instrumento_id)`,
  `CREATE INDEX IF NOT EXISTS idx_intento_estudiante ON intento (estudiante)`,
  `CREATE INDEX IF NOT EXISTS idx_intento_seccion_intento ON intento_seccion (intento_id)`,
  `CREATE INDEX IF NOT EXISTS idx_respuesta_intento ON respuesta (intento_id, seccion)`,
  `CREATE INDEX IF NOT EXISTS idx_respuesta_confianza ON respuesta (confianza)`,
  `CREATE INDEX IF NOT EXISTS idx_reporte_estudiante ON reporte (estudiante)`,
]

/**
 * Versión del esquema de este store, escrita como `PRAGMA user_version`. Toda migración que altere el
 * esquema la incrementa EN EL MISMO COMMIT; abrir un archivo con una versión mayor se niega.
 * El `Dockerfile` la declara en `vergis.schema.stores` y `tests/imagen-anillo-labels.test.ts` lo coteja.
 */
export const EVALUACIONES_SCHEMA_VERSION = 1

// ── Impl. SQLite ───────────────────────────────────────────────────────────────────────────────

export class SqliteEvaluacionesStore {
  private constructor(
    private db: SqlDb,
    private file: string | null,
  ) {}

  /** `file` null → DB en memoria (tests). Si el archivo existe, se carga. */
  static async open(file: string | null, control: SqliteControlOptions = {}): Promise<SqliteEvaluacionesStore> {
    return new SqliteEvaluacionesStore(await SqliteEvaluacionesStore.openDb(file, control), file)
  }

  /**
   * Reabre el store DESDE DISCO con otras opciones de plano de control y recién entonces cambia el
   * handle vivo (validate-before-swap), igual que `SqliteNotasStore.reopen`. Lo usa el relevo.
   */
  async reopen(control: SqliteControlOptions = {}): Promise<void> {
    const fresh = await SqliteEvaluacionesStore.openDb(this.file, control)
    const previo = this.db
    this.db = fresh
    try {
      previo.close()
    } catch {
      /* cerrar el handle viejo es higiene, no parte del contrato del swap */
    }
  }

  private static async openDb(file: string | null, control: SqliteControlOptions): Promise<SqlDb> {
    const db = await openSqliteDb(file, { ...control, schemaVersion: EVALUACIONES_SCHEMA_VERSION })
    db.run(INSTRUMENTO_DDL)
    db.run(INTENTO_DDL)
    db.run(INTENTO_SECCION_DDL)
    db.run(RESPUESTA_DDL)
    db.run(REPORTE_DDL)
    for (const ix of INDEXES) db.run(ix)
    return db
  }

  private persist(): void {
    persistSqliteDb(this.db, this.file)
  }

  /** Estado del plano de escritura de este store (esquema, época, degradado). */
  controlStatus(): SqliteControlStatus | undefined {
    return sqliteControlStatus(this.db)
  }

  async close(): Promise<void> {
    this.persist()
    this.db.close()
  }

  private rows(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const out: Record<string, unknown>[] = []
    while (stmt.step()) out.push(stmt.getAsObject())
    stmt.free()
    return out
  }

  // ── Instrumentos ──

  /**
   * Publica un instrumento. Idempotente por (id, sha256): re-publicar el mismo contenido es un no-op
   * que devuelve `false`. Con otro sha lanza `evaluaciones/instrumento-inmutable`.
   */
  publicarInstrumento(input: PublicarInstrumentoInput): boolean {
    const vigente = this.rows(`SELECT sha256 FROM instrumento WHERE id = ?`, [input.id])[0]
    if (vigente) {
      const sha = String(vigente['sha256'])
      if (sha === input.sha256) return false
      throw instrumentoInmutable(input.id, sha, input.sha256)
    }
    this.db.run(
      `INSERT INTO instrumento (id, titulo, codigo, subtitulo, materia, grupo, variante, modo, institucion,
         estudiante, departamento, confianza, total_secciones, total_items, sha256, publicado_at, retirado_at,
         invalidado, invalidado_razon, extra_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.id,
        input.titulo,
        input.codigo ?? null,
        input.subtitulo ?? null,
        input.materia ?? null,
        input.grupo ?? null,
        input.variante ?? null,
        input.modo ?? null,
        input.institucion ?? null,
        input.estudiante ?? null,
        input.departamento ?? null,
        input.confianza ? 1 : 0,
        input.totalSecciones,
        input.totalItems,
        input.sha256,
        input.publicadoAt,
        null,
        input.invalidado ? 1 : 0,
        input.invalidadoRazon ?? null,
        extraJson(input.extra),
      ],
    )
    this.persist()
    return true
  }

  /** Retira un instrumento: deja de estar vigente y JAMÁS se borra (los intentos lo siguen citando). */
  retirarInstrumento(id: string, at: string): boolean {
    const hit = this.rows(`SELECT id FROM instrumento WHERE id = ?`, [id])[0]
    if (!hit) return false
    this.db.run(`UPDATE instrumento SET retirado_at = ? WHERE id = ?`, [at, id])
    this.persist()
    return true
  }

  instrumento(id: string): Instrumento | null {
    const r = this.rows(`SELECT * FROM instrumento WHERE id = ?`, [id])[0]
    return r ? instrumentoRow(r) : null
  }

  instrumentos(filtro: { estudiante?: string; vigentes?: boolean } = {}): Instrumento[] {
    const cond: string[] = []
    const params: unknown[] = []
    if (filtro.estudiante !== undefined) {
      cond.push('estudiante = ?')
      params.push(filtro.estudiante)
    }
    if (filtro.vigentes === true) cond.push('retirado_at IS NULL')
    if (filtro.vigentes === false) cond.push('retirado_at IS NOT NULL')
    const where = cond.length ? ` WHERE ${cond.join(' AND ')}` : ''
    return this.rows(`SELECT * FROM instrumento${where} ORDER BY id`, params).map(instrumentoRow)
  }

  // ── Intentos ──

  /**
   * Guarda el intento COMPLETO de `(instrumento, estudiante)`, reemplazando atómicamente sus
   * secciones y respuestas — que es exactamente lo que Daftar hace en cada POST de progreso: manda el
   * estado entero, no un delta. Reemplazar en vez de mezclar evita el modo de falla silencioso de
   * dejar respuestas de un guardado anterior que el estudiante ya borró.
   */
  guardarIntento(input: IntentoIn): Intento {
    const previo = this.rows(`SELECT id FROM intento WHERE instrumento_id = ? AND estudiante = ?`, [
      input.instrumentoId,
      input.estudiante,
    ])[0]
    const id = previo ? String(previo['id']) : intentoId(input.instrumentoId, input.estudiante)
    this.db.run(`DELETE FROM respuesta WHERE intento_id = ?`, [id])
    this.db.run(`DELETE FROM intento_seccion WHERE intento_id = ?`, [id])
    this.db.run(`DELETE FROM intento WHERE id = ?`, [id])
    this.db.run(
      `INSERT INTO intento (id, instrumento_id, estudiante, seccion_actual, total_secciones, iniciado_at,
         terminado_at, actualizado_at, revisado_at, bloqueado, extra_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.instrumentoId,
        input.estudiante,
        input.seccionActual,
        input.totalSecciones,
        input.iniciadoAt ?? null,
        input.terminadoAt ?? null,
        input.actualizadoAt ?? null,
        input.revisadoAt ?? null,
        input.bloqueado ? 1 : 0,
        extraJson(input.extra),
      ],
    )
    for (const s of input.secciones) {
      this.db.run(
        `INSERT INTO intento_seccion (intento_id, seccion, intentos, revisada, correctas, total, revision_json, extra_json)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          id,
          s.seccion,
          s.intentos ?? null,
          s.revisada == null ? null : s.revisada ? 1 : 0,
          s.correctas ?? null,
          s.total ?? null,
          s.revision === undefined ? null : canonicalJson(s.revision),
          extraJson(s.extra),
        ],
      )
      for (const a of s.respuestas) {
        this.db.run(`INSERT INTO respuesta (intento_id, seccion, indice, valor_json, confianza) VALUES (?,?,?,?,?)`, [
          id,
          s.seccion,
          a.indice,
          canonicalJson(a.valor),
          confianzaDe(a.valor) ?? null,
        ])
      }
    }
    this.persist()
    return this.intentoPorId(id)!
  }

  intento(instrumentoId: string, estudiante: string): Intento | null {
    const r = this.rows(`SELECT id FROM intento WHERE instrumento_id = ? AND estudiante = ?`, [instrumentoId, estudiante])[0]
    return r ? this.intentoPorId(String(r['id'])) : null
  }

  intentoPorId(id: string): Intento | null {
    const r = this.rows(`SELECT * FROM intento WHERE id = ?`, [id])[0]
    if (!r) return null
    return { ...intentoRow(r), secciones: this.seccionesDe(id) }
  }

  intentosDe(estudiante: string): Intento[] {
    return this.rows(`SELECT * FROM intento WHERE estudiante = ? ORDER BY instrumento_id`, [estudiante]).map((r) => ({
      ...intentoRow(r),
      secciones: this.seccionesDe(String(r['id'])),
    }))
  }

  private seccionesDe(intentoId: string): Seccion[] {
    const secs = this.rows(`SELECT * FROM intento_seccion WHERE intento_id = ? ORDER BY seccion`, [intentoId])
    const resp = this.rows(`SELECT * FROM respuesta WHERE intento_id = ? ORDER BY seccion, indice`, [intentoId])
    return secs.map((r) => {
      const seccion = Number(r['seccion'])
      return {
        seccion,
        intentos: r['intentos'] == null ? undefined : Number(r['intentos']),
        revisada: r['revisada'] == null ? undefined : Number(r['revisada']) === 1,
        correctas: r['correctas'] == null ? undefined : Number(r['correctas']),
        total: r['total'] == null ? undefined : Number(r['total']),
        revisionJson: r['revision_json'] == null ? undefined : String(r['revision_json']),
        extra: parseExtra(r['extra_json']),
        respuestas: resp
          .filter((a) => Number(a['seccion']) === seccion)
          .map((a) => ({
            indice: Number(a['indice']),
            valorJson: String(a['valor_json']),
            confianza: a['confianza'] == null ? undefined : (String(a['confianza']) as Confianza),
          })),
      }
    })
  }

  /**
   * Borra el intento de un par (instrumento, estudiante) con sus secciones y respuestas. Es el
   * `reset` de Daftar —«el estudiante empieza de cero»— y por eso SÍ borra en un store que por lo
   * demás no borra nada: un intento reseteado no es historia que preservar, es trabajo que el propio
   * dueño del catálogo declara nulo. El instrumento no se toca (sigue publicado). Devuelve `false` si
   * no había intento (idempotente).
   */
  borrarIntento(instrumentoId: string, estudiante: string): boolean {
    const previo = this.rows(`SELECT id FROM intento WHERE instrumento_id = ? AND estudiante = ?`, [instrumentoId, estudiante])[0]
    if (!previo) return false
    const id = String(previo['id'])
    this.db.run(`DELETE FROM respuesta WHERE intento_id = ?`, [id])
    this.db.run(`DELETE FROM intento_seccion WHERE intento_id = ?`, [id])
    this.db.run(`DELETE FROM intento WHERE id = ?`, [id])
    this.persist()
    return true
  }

  /** Cierra el intento a más escritura del estudiante (el `locked` de Daftar). */
  bloquear(intentoId: string, bloqueado = true): boolean {
    const hit = this.rows(`SELECT id FROM intento WHERE id = ?`, [intentoId])[0]
    if (!hit) return false
    this.db.run(`UPDATE intento SET bloqueado = ? WHERE id = ?`, [bloqueado ? 1 : 0, intentoId])
    this.persist()
    return true
  }

  /** Guarda la revisión del corrector sobre una sección, verbatim (dos formas conocidas en Daftar). */
  guardarRevision(intentoId: string, seccion: number, revision: unknown, revisadoAt?: string): boolean {
    const hit = this.rows(`SELECT seccion FROM intento_seccion WHERE intento_id = ? AND seccion = ?`, [intentoId, seccion])[0]
    if (!hit) return false
    this.db.run(`UPDATE intento_seccion SET revision_json = ? WHERE intento_id = ? AND seccion = ?`, [
      revision === undefined ? null : canonicalJson(revision),
      intentoId,
      seccion,
    ])
    if (revisadoAt) this.db.run(`UPDATE intento SET revisado_at = ? WHERE id = ?`, [revisadoAt, intentoId])
    this.persist()
    return true
  }

  // ── Reportes ──

  guardarReporte(r: ReporteIn): void {
    this.db.run(
      `INSERT INTO reporte (id, estudiante, titulo, subtitulo, resumen, materia, grupo, sprint, sprint_orden,
         relacionados_json, generado_at, contenido_html, extra_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET estudiante=excluded.estudiante, titulo=excluded.titulo, subtitulo=excluded.subtitulo,
         resumen=excluded.resumen, materia=excluded.materia, grupo=excluded.grupo, sprint=excluded.sprint,
         sprint_orden=excluded.sprint_orden, relacionados_json=excluded.relacionados_json,
         generado_at=excluded.generado_at, contenido_html=excluded.contenido_html, extra_json=excluded.extra_json`,
      [
        r.id,
        r.estudiante ?? null,
        r.titulo ?? null,
        r.subtitulo ?? null,
        r.resumen ?? null,
        r.materia ?? null,
        r.grupo ?? null,
        r.sprint ?? null,
        r.sprintOrden ?? null,
        canonicalJson(r.relacionados ?? []),
        r.generadoAt ?? null,
        r.contenidoHtml ?? null,
        extraJson(r.extra),
      ],
    )
    this.persist()
  }

  reporte(id: string): Reporte | null {
    const r = this.rows(`SELECT * FROM reporte WHERE id = ?`, [id])[0]
    return r ? reporteRow(r) : null
  }

  reportes(estudiante?: string): Reporte[] {
    return estudiante === undefined
      ? this.rows(`SELECT * FROM reporte ORDER BY id`).map(reporteRow)
      : this.rows(`SELECT * FROM reporte WHERE estudiante = ? ORDER BY id`, [estudiante]).map(reporteRow)
  }
}

// ── Filas → modelo ─────────────────────────────────────────────────────────────────────────────

const txt = (v: unknown): string | undefined => (v == null ? undefined : String(v))

function instrumentoRow(r: Record<string, unknown>): Instrumento {
  return {
    id: String(r['id']),
    titulo: String(r['titulo']),
    codigo: txt(r['codigo']),
    subtitulo: txt(r['subtitulo']),
    materia: txt(r['materia']),
    grupo: txt(r['grupo']),
    variante: txt(r['variante']),
    modo: txt(r['modo']),
    institucion: txt(r['institucion']),
    estudiante: txt(r['estudiante']),
    departamento: txt(r['departamento']),
    confianza: Number(r['confianza']) === 1,
    totalSecciones: Number(r['total_secciones']),
    totalItems: Number(r['total_items']),
    sha256: String(r['sha256']),
    publicadoAt: String(r['publicado_at']),
    retiradoAt: txt(r['retirado_at']),
    invalidado: Number(r['invalidado']) === 1,
    invalidadoRazon: txt(r['invalidado_razon']),
    extra: parseExtra(r['extra_json']),
  }
}

function intentoRow(r: Record<string, unknown>): Omit<Intento, 'secciones'> {
  return {
    id: String(r['id']),
    instrumentoId: String(r['instrumento_id']),
    estudiante: String(r['estudiante']),
    seccionActual: Number(r['seccion_actual']),
    totalSecciones: Number(r['total_secciones']),
    iniciadoAt: txt(r['iniciado_at']),
    terminadoAt: txt(r['terminado_at']),
    actualizadoAt: txt(r['actualizado_at']),
    revisadoAt: txt(r['revisado_at']),
    bloqueado: Number(r['bloqueado']) === 1,
    extra: parseExtra(r['extra_json']),
  }
}

function reporteRow(r: Record<string, unknown>): Reporte {
  let relacionados: unknown[] = []
  try {
    const v = JSON.parse(String(r['relacionados_json'] ?? '[]')) as unknown
    if (Array.isArray(v)) relacionados = v
  } catch {
    /* un JSON ilegible se reporta como lista vacía; el original vive en la columna */
  }
  return {
    id: String(r['id']),
    estudiante: txt(r['estudiante']),
    titulo: txt(r['titulo']),
    subtitulo: txt(r['subtitulo']),
    resumen: txt(r['resumen']),
    materia: txt(r['materia']),
    grupo: txt(r['grupo']),
    sprint: txt(r['sprint']),
    sprintOrden: r['sprint_orden'] == null ? undefined : Number(r['sprint_orden']),
    relacionados,
    generadoAt: txt(r['generado_at']),
    contenidoHtml: txt(r['contenido_html']),
    extra: parseExtra(r['extra_json']),
  }
}

/**
 * Id determinista del intento a partir de su par único. Determinista y no aleatorio a propósito: dos
 * importaciones del mismo progreso tienen que producir el MISMO id, o «idempotente» sería mentira.
 */
function intentoId(instrumentoId: string, estudiante: string): string {
  return `${instrumentoId}::${estudiante}`
}

/**
 * Selector del store por entorno (la costura del swap): `VERGIS_EVALUACIONES_DB` → archivo SQLite
 * embebido; sin él, `<baseDir>/evaluaciones.sqlite`.
 */
export async function openEvaluacionesStore(
  baseDir: string,
  control: SqliteControlOptions = {},
): Promise<SqliteEvaluacionesStore> {
  const file = process.env['VERGIS_EVALUACIONES_DB'] ?? `${baseDir.replace(/\/$/, '')}/evaluaciones.sqlite`
  return SqliteEvaluacionesStore.open(file, control)
}
