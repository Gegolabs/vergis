import { createHash } from 'node:crypto'
import { canonicalJson } from './notas-store'
import {
  SqliteEvaluacionesStore,
  ausente,
  extraJson,
  parseExtra,
  type Extra,
  type IntentoIn,
  type SeccionIn,
  type RespuestaIn,
  type Seccion,
} from './evaluaciones-store'
import { VergisError } from '@vergis/botler'

/**
 * IMPORTADOR DE DAFTAR → store `evaluaciones` (doc 013 · H2), y su INVERSA.
 *
 * Daftar guarda tres familias de JSON en disco (`guides/`, `progress/`, `reports/`). Este módulo las
 * lleva al store sin interpretarlas y —lo que de verdad prueba que no se perdió nada—
 * **reconstruye el progreso original** desde el store: `exportarProgreso` es la contraparte exacta de
 * `importarDaftar`, y la suite compara el reconstruido contra el original con deep-equal.
 *
 * Por qué la inversa y no una lista de aserciones: una aserción prueba lo que su autor se acordó de
 * mirar. La reconstrucción prueba el complemento — TODO lo que el autor no miró. Una clave rara que
 * nadie modeló (`locked`, `last_reviewed`, un `review` con otra forma) hace fallar el round-trip sin
 * que nadie haya tenido que preverla.
 *
 * ── Lo que este módulo NO hace ─────────────────────────────────────────────────────────────────
 * No corrige, no normaliza, no completa. Si un progreso apunta a una guía que no está, se REPORTA
 * como huérfano y no se importa; si una guía ya publicada llega con otro contenido, se REPORTA como
 * conflicto y el instrumento queda intacto. Callar cualquiera de los dos casos convertiría un dato
 * roto en un dato con cara de sano.
 */

// ── Tipos del informe ──────────────────────────────────────────────────────────────────────────

export type EstadoImportacion = 'importado' | 'sin-cambios' | 'huerfano' | 'conflicto'

export interface FilaInforme {
  /** Id de la guía (= nombre del archivo sin `.json`), o del progreso cuando es huérfano. */
  id: string
  respuestas: number
  secciones: number
  revisiones: number
  estado: EstadoImportacion
  /** Por qué, cuando el estado es `huerfano` o `conflicto`. Nunca lleva contenido de una respuesta. */
  detalle?: string
}

export interface InformeImportacion {
  filas: FilaInforme[]
  instrumentos: { publicados: number; sinCambios: number; conflictos: number }
  progresos: { importados: number; sinCambios: number; huerfanos: number; conflictos: number }
  reportes: { guardados: number; sinCambios: number }
}

export interface ImportarDaftarInput {
  /** `id → JSON de la guía`. El id es el nombre del archivo sin `.json`. */
  guides: Record<string, unknown>
  /** `id → JSON del progreso`. */
  progress: Record<string, unknown>
  /** `id → JSON del reporte`. */
  reports: Record<string, unknown>
  store: SqliteEvaluacionesStore
  /** Instante de publicación de los instrumentos nuevos (ISO). */
  now: string
  /**
   * Texto exacto del archivo de cada guía, para el `sha256`. Sin él se usa el JSON canónico de la
   * guía: estable entre corridas (que es lo que la idempotencia necesita), pero no es el sha del
   * archivo — quien lo quiera, que lo pase.
   */
  guideText?: Record<string, string>
}

// ── Claves modeladas ───────────────────────────────────────────────────────────────────────────

/** Claves de un progreso de Daftar que tienen columna propia. El resto va a `extra`. */
const PROGRESO_MODELADAS = [
  'guideId',
  'currentSection',
  'totalSections',
  '_startedAt',
  '_finishedAt',
  'last_updated',
  'last_reviewed',
  'locked',
  'sections',
] as const

/** Claves de una sección de progreso que tienen columna propia. */
const SECCION_MODELADAS = ['answers', 'attempts', 'checked', 'score', 'review'] as const

/** Claves de una guía que tienen columna propia en `instrumento`. */
const GUIA_MODELADAS = [
  'title',
  'code',
  'subtitle',
  'subject',
  'group',
  'variant',
  'mode',
  'institution',
  'student',
  'department',
  'confidence',
  'invalidated',
  'invalidated_reason',
] as const

/** Claves de un reporte que tienen columna propia. */
const REPORTE_MODELADAS = [
  'id',
  'student',
  'title',
  'subtitle',
  'summary',
  'subject',
  'group',
  'sprint',
  'sprintOrder',
  'related_guides',
  'generated_at',
  'content_html',
] as const

const esObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** `sha256` en hex del texto dado. */
export function sha256De(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex')
}

/** Las claves de `obj` que no están en `modeladas`, verbatim. */
function noModeladas(obj: Record<string, unknown>, modeladas: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (!modeladas.includes(k)) out[k] = v
  return out
}

// ── Guía → instrumento ─────────────────────────────────────────────────────────────────────────

/** El total de ítems de una guía: la suma de los `exercises` de sus secciones. */
export function totalItemsDe(guia: Record<string, unknown>): number {
  const secs = guia['sections']
  if (!Array.isArray(secs)) return 0
  return secs.reduce<number>((n, s) => n + (esObjeto(s) && Array.isArray(s['exercises']) ? s['exercises'].length : 0), 0)
}

/** El total de secciones de una guía. */
export function totalSeccionesDe(guia: Record<string, unknown>): number {
  return Array.isArray(guia['sections']) ? guia['sections'].length : 0
}

// ── Progreso → intento ─────────────────────────────────────────────────────────────────────────

/**
 * Traduce un progreso de Daftar a la entrada del store, dejando en `extra` **todo** lo que no tiene
 * columna y, en `ausentes`, las claves modeladas que el original NO traía. Esas dos listas son lo que
 * hace posible reconstruirlo idéntico: una columna `NULL` no distingue «venía en null» de «no venía».
 *
 * Lanza `evaluaciones/seccion-no-numerica` si el dict `sections` trae una llave que no es un índice
 * entero: el modelo la guardaría en una columna `INTEGER` y la perdería. Fail-closed a propósito.
 */
export function progresoAIntento(prog: Record<string, unknown>, instrumentoId: string, estudiante: string): IntentoIn {
  const ausentes: string[] = []
  const extra: Record<string, unknown> = noModeladas(prog, PROGRESO_MODELADAS)
  const tiene = (k: string): boolean => Object.prototype.hasOwnProperty.call(prog, k)
  /** Clave modelada presente pero de un tipo que la columna no representa: se preserva en `extra`. */
  const desviar = (k: string): void => {
    extra[k] = prog[k]
    ausentes.push(k)
  }

  for (const k of PROGRESO_MODELADAS) if (!tiene(k)) ausentes.push(k)

  const num = (k: string): number => {
    const v = prog[k]
    if (typeof v === 'number') return v
    if (tiene(k)) desviar(k)
    return 0
  }
  const iso = (k: string): string | null => {
    const v = prog[k]
    if (typeof v === 'string' || v === null) return v
    if (tiene(k)) desviar(k)
    return null
  }

  const seccionActual = num('currentSection')
  const totalSecciones = num('totalSections')
  const iniciadoAt = iso('_startedAt')
  const terminadoAt = iso('_finishedAt')
  const actualizadoAt = iso('last_updated')
  const revisadoAt = iso('last_reviewed')

  let bloqueado = false
  if (tiene('locked')) {
    if (typeof prog['locked'] === 'boolean') bloqueado = prog['locked']
    else desviar('locked')
  }

  const secciones: SeccionIn[] = []
  const secsRaw = prog['sections']
  if (tiene('sections')) {
    if (!esObjeto(secsRaw)) desviar('sections')
    else {
      for (const [llave, valor] of Object.entries(secsRaw)) {
        if (!/^\d+$/.test(llave) || String(Number(llave)) !== llave) {
          throw new VergisError({
            error: 'unprocessable',
            code: 'evaluaciones/seccion-no-numerica',
            path: `progreso/${instrumentoId}/sections/${llave}`,
            message:
              `el progreso '${instrumentoId}' trae la sección '${llave}', que no es un índice entero. ` +
              `El modelo la guarda en una columna INTEGER y la perdería, así que no se importa.`,
            remediation: 'corrige el JSON en Daftar, o extiende el modelo antes de importar este progreso.',
          })
        }
        secciones.push(seccionASeccionIn(Number(llave), valor))
      }
      secciones.sort((a, b) => a.seccion - b.seccion)
    }
  }

  return {
    instrumentoId,
    estudiante,
    seccionActual,
    totalSecciones,
    iniciadoAt,
    terminadoAt,
    actualizadoAt,
    revisadoAt,
    bloqueado,
    secciones,
    extra: armarExtra(extra, ausentes),
  }
}

function seccionASeccionIn(indice: number, raw: unknown): SeccionIn {
  if (!esObjeto(raw)) {
    // Una sección que no es un objeto se conserva entera en `extra` bajo su forma original.
    return { seccion: indice, respuestas: [], extra: armarExtra({}, [...SECCION_MODELADAS], raw) }
  }
  const ausentes: string[] = []
  const extra: Record<string, unknown> = noModeladas(raw, SECCION_MODELADAS)
  const tiene = (k: string): boolean => Object.prototype.hasOwnProperty.call(raw, k)
  const desviar = (k: string): void => {
    extra[k] = raw[k]
    ausentes.push(k)
  }

  const respuestas: RespuestaIn[] = []
  if (!tiene('answers')) ausentes.push('answers')
  else if (!Array.isArray(raw['answers'])) desviar('answers')
  else (raw['answers'] as unknown[]).forEach((valor, indiceResp) => respuestas.push({ indice: indiceResp, valor }))

  let intentos: number | null = null
  if (tiene('attempts')) {
    if (typeof raw['attempts'] === 'number') intentos = raw['attempts']
    else desviar('attempts')
  }

  let revisada: boolean | null = null
  if (tiene('checked')) {
    if (typeof raw['checked'] === 'boolean') revisada = raw['checked']
    else desviar('checked')
  }

  let correctas: number | null = null
  let total: number | null = null
  if (tiene('score')) {
    const sc = raw['score']
    if (esObjeto(sc) && typeof sc['correct'] === 'number' && typeof sc['total'] === 'number' && Object.keys(sc).length === 2) {
      correctas = sc['correct']
      total = sc['total']
    } else desviar('score')
  }

  const revision = tiene('review') ? raw['review'] : undefined

  return {
    seccion: indice,
    respuestas,
    intentos,
    revisada,
    correctas,
    total,
    revision,
    extra: armarExtra(extra, ausentes),
  }
}

/** Empaqueta el par (no modelado, ausentes) en la forma que el store guarda en `extra_json`. */
function armarExtra(extra: Record<string, unknown>, ausentes: string[], crudo?: unknown): Extra {
  const e: Extra = {}
  const contenido = crudo === undefined ? extra : { ...extra, __crudo: crudo }
  if (Object.keys(contenido).length) e.extra = contenido
  if (ausentes.length) e.ausentes = [...ausentes]
  return e
}

// ── La inversa: store → progreso de Daftar ─────────────────────────────────────────────────────

/**
 * Reconstruye el JSON del progreso tal como Daftar lo escribió. Es la prueba de la ausencia de
 * pérdida: la suite lo compara con deep-equal contra el original de cada fixture, y el gate de §5 lo
 * corre contra los 55 progresos reales.
 *
 * Devuelve `null` si no hay intento para ese par (instrumento, estudiante).
 */
export function exportarProgreso(store: SqliteEvaluacionesStore, instrumentoId: string, estudiante: string): unknown | null {
  const it = store.intento(instrumentoId, estudiante)
  if (!it) return null
  const e = it.extra
  const extra = e.extra ?? {}
  const out: Record<string, unknown> = {}
  const poner = (clave: string, valor: unknown): void => {
    if (!ausente(e, clave)) out[clave] = valor
  }

  poner('guideId', it.instrumentoId)
  poner('currentSection', it.seccionActual)
  poner('totalSections', it.totalSecciones)
  poner('_startedAt', it.iniciadoAt ?? null)
  poner('_finishedAt', it.terminadoAt ?? null)
  poner('last_updated', it.actualizadoAt ?? null)
  poner('last_reviewed', it.revisadoAt ?? null)
  poner('locked', it.bloqueado)

  if (!ausente(e, 'sections')) {
    const secs: Record<string, unknown> = {}
    for (const s of it.secciones) secs[String(s.seccion)] = exportarSeccion(s)
    out['sections'] = secs
  }

  // Lo no modelado vuelve donde estaba. Va al final para que una clave desviada (modelada pero de un
  // tipo que la columna no representa) recupere su valor original tal cual.
  for (const [k, v] of Object.entries(extra)) out[k] = v
  return out
}

function exportarSeccion(s: Seccion): unknown {
  const e = s.extra
  const extra = { ...(e.extra ?? {}) }
  if ('__crudo' in extra) return extra['__crudo']
  const out: Record<string, unknown> = {}
  if (!ausente(e, 'answers')) out['answers'] = s.respuestas.map((r) => JSON.parse(r.valorJson) as unknown)
  if (s.intentos !== undefined) out['attempts'] = s.intentos
  if (s.revisada !== undefined) out['checked'] = s.revisada
  if (s.correctas !== undefined && s.total !== undefined) out['score'] = { correct: s.correctas, total: s.total }
  if (s.revisionJson !== undefined) out['review'] = JSON.parse(s.revisionJson) as unknown
  for (const [k, v] of Object.entries(extra)) out[k] = v
  return out
}

// ── El importador ──────────────────────────────────────────────────────────────────────────────

/**
 * Lleva las tres familias de JSON de Daftar al store. Idempotente: correrlo dos veces sobre el mismo
 * material deja todo en `sin-cambios` y no escribe nada la segunda vez. La comparación que decide
 * «sin cambios» para un progreso es el round-trip mismo (`exportarProgreso` contra el JSON entrante),
 * así que el criterio de idempotencia y el de no-pérdida son EL MISMO — no dos que puedan divergir.
 */
export function importarDaftar(input: ImportarDaftarInput): InformeImportacion {
  const { guides, progress, reports, store, now } = input
  const filas: FilaInforme[] = []
  const informe: InformeImportacion = {
    filas,
    instrumentos: { publicados: 0, sinCambios: 0, conflictos: 0 },
    progresos: { importados: 0, sinCambios: 0, huerfanos: 0, conflictos: 0 },
    reportes: { guardados: 0, sinCambios: 0 },
  }

  // ── 1 · Instrumentos ──
  const estudiantePorGuia = new Map<string, string>()
  const conflictivas = new Set<string>()
  const publicadas = new Set<string>()
  for (const id of Object.keys(guides).sort()) {
    const guia = guides[id]
    if (!esObjeto(guia)) {
      conflictivas.add(id)
      informe.instrumentos.conflictos += 1
      filas.push({ id, respuestas: 0, secciones: 0, revisiones: 0, estado: 'conflicto', detalle: 'la guía no es un objeto JSON' })
      continue
    }
    const estudiante = str(guia['student']) ?? ''
    estudiantePorGuia.set(id, estudiante)
    const sha = sha256De(input.guideText?.[id] ?? canonicalJson(guia))
    try {
      const nuevo = store.publicarInstrumento({
        id,
        titulo: str(guia['title']) ?? id,
        codigo: str(guia['code']),
        subtitulo: str(guia['subtitle']),
        materia: str(guia['subject']),
        grupo: str(guia['group']),
        variante: str(guia['variant']),
        modo: str(guia['mode']),
        institucion: str(guia['institution']),
        estudiante,
        departamento: str(guia['department']),
        confianza: guia['confidence'] === true,
        totalSecciones: totalSeccionesDe(guia),
        totalItems: totalItemsDe(guia),
        sha256: sha,
        publicadoAt: now,
        invalidado: guia['invalidated'] === true,
        invalidadoRazon: str(guia['invalidated_reason']),
        extra: { extra: noModeladas(guia, GUIA_MODELADAS) },
      })
      if (nuevo) {
        publicadas.add(id)
        informe.instrumentos.publicados += 1
      } else informe.instrumentos.sinCambios += 1
    } catch (e) {
      conflictivas.add(id)
      informe.instrumentos.conflictos += 1
      filas.push({
        id,
        respuestas: 0,
        secciones: 0,
        revisiones: 0,
        estado: 'conflicto',
        detalle: e instanceof VergisError ? e.structured.code : 'error al publicar el instrumento',
      })
    }
  }

  // ── 2 · Intentos ──
  for (const key of Object.keys(progress).sort()) {
    const prog = progress[key]
    const guiaId = esObjeto(prog) ? (str(prog['guideId']) ?? key) : key
    if (!esObjeto(prog)) {
      informe.progresos.conflictos += 1
      filas.push({ id: guiaId, respuestas: 0, secciones: 0, revisiones: 0, estado: 'conflicto', detalle: 'el progreso no es un objeto JSON' })
      continue
    }
    if (!estudiantePorGuia.has(guiaId)) {
      informe.progresos.huerfanos += 1
      filas.push({
        id: guiaId,
        respuestas: 0,
        secciones: 0,
        revisiones: 0,
        estado: 'huerfano',
        detalle: `no hay guía '${guiaId}' en el catálogo; el progreso no se importa`,
      })
      continue
    }
    if (conflictivas.has(guiaId)) {
      informe.progresos.conflictos += 1
      filas.push({ id: guiaId, respuestas: 0, secciones: 0, revisiones: 0, estado: 'conflicto', detalle: 'su instrumento quedó en conflicto' })
      continue
    }
    const estudiante = estudiantePorGuia.get(guiaId)!
    let intentoIn: IntentoIn
    try {
      intentoIn = progresoAIntento(prog, guiaId, estudiante)
    } catch (e) {
      informe.progresos.conflictos += 1
      filas.push({
        id: guiaId,
        respuestas: 0,
        secciones: 0,
        revisiones: 0,
        estado: 'conflicto',
        detalle: e instanceof VergisError ? e.structured.code : 'no se pudo traducir el progreso',
      })
      continue
    }
    const respuestas = intentoIn.secciones.reduce((n, s) => n + s.respuestas.length, 0)
    const revisiones = intentoIn.secciones.filter((s) => s.revision !== undefined).length
    const yaIgual = canonicalJson(exportarProgreso(store, guiaId, estudiante)) === canonicalJson(prog)
    if (yaIgual) {
      informe.progresos.sinCambios += 1
      filas.push({ id: guiaId, respuestas, secciones: intentoIn.secciones.length, revisiones, estado: 'sin-cambios' })
      continue
    }
    store.guardarIntento(intentoIn)
    informe.progresos.importados += 1
    filas.push({ id: guiaId, respuestas, secciones: intentoIn.secciones.length, revisiones, estado: 'importado' })
  }

  // ── 3 · Reportes ──
  for (const key of Object.keys(reports).sort()) {
    const rep = reports[key]
    if (!esObjeto(rep)) continue
    const id = str(rep['id']) ?? key
    const entrada = {
      id,
      estudiante: str(rep['student']),
      titulo: str(rep['title']),
      subtitulo: str(rep['subtitle']),
      resumen: str(rep['summary']),
      materia: str(rep['subject']),
      grupo: str(rep['group']),
      sprint: str(rep['sprint']),
      sprintOrden: typeof rep['sprintOrder'] === 'number' ? rep['sprintOrder'] : undefined,
      relacionados: Array.isArray(rep['related_guides']) ? (rep['related_guides'] as unknown[]) : [],
      generadoAt: str(rep['generated_at']),
      contenidoHtml: str(rep['content_html']),
      extra: { extra: noModeladas(rep, REPORTE_MODELADAS) },
    }
    // La forma en que el store DEVUELVE este reporte, para decidir «sin cambios» sin escribir.
    const esperado = { ...entrada, extra: parseExtra(extraJson(entrada.extra)) }
    const vigente = store.reporte(id)
    if (vigente && canonicalJson(vigente) === canonicalJson(esperado)) {
      informe.reportes.sinCambios += 1
      continue
    }
    store.guardarReporte(entrada)
    informe.reportes.guardados += 1
  }

  return informe
}

/**
 * Corre el round-trip contra cada progreso dado y devuelve **solo los ids** que difieren. Jamás
 * devuelve contenido: los progresos de Daftar los escriben menores de edad.
 */
export function verificarRoundTrip(
  store: SqliteEvaluacionesStore,
  progress: Record<string, unknown>,
  estudiantePorGuia: Map<string, string>,
): { verificados: number; omitidos: string[]; diferencias: string[] } {
  const diferencias: string[] = []
  const omitidos: string[] = []
  let verificados = 0
  for (const key of Object.keys(progress).sort()) {
    const prog = progress[key]
    const guiaId = esObjeto(prog) ? (str(prog['guideId']) ?? key) : key
    const estudiante = estudiantePorGuia.get(guiaId)
    if (estudiante === undefined) {
      omitidos.push(guiaId)
      continue
    }
    verificados += 1
    const vuelta = exportarProgreso(store, guiaId, estudiante)
    if (canonicalJson(vuelta) !== canonicalJson(prog)) diferencias.push(guiaId)
  }
  return { verificados, omitidos, diferencias }
}

/** El mapa `guía → estudiante` que la verificación necesita, derivado del catálogo de guías. */
export function estudiantesDe(guides: Record<string, unknown>): Map<string, string> {
  const m = new Map<string, string>()
  for (const [id, g] of Object.entries(guides)) if (esObjeto(g)) m.set(id, str(g['student']) ?? '')
  return m
}
