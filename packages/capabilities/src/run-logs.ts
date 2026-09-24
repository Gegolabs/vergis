/**
 * Logs POR CORRIDA de un proceso de ingestión (issue #99) — lógica PURA.
 *
 * CONTRATO DE INGESTA (lado escritor — código de terreno, p. ej. el SJD de la instancia):
 * al FINAL de cada corrida (éxito, aborto `✖ ABORTADO` o `✖ ERROR no controlado` — el mismo
 * punto donde escribe su `_ingest_log.txt`), el proceso escribe ADEMÁS su log completo, inmutable,
 * en `<dir>/run-<YYYYMMDDTHHMMSSZ>.txt`, donde el timestamp es el ARRANQUE del script en UTC y
 * `<dir>` default es `Files/code/_logs`. RETENCIÓN: el escritor conserva los últimos
 * RUN_LOG_RETENTION archivos y poda el resto — el producto solo LEE (jamás poda: dos escritores
 * sobre el mismo directorio es una carrera).
 *
 * La correlación corrida↔archivo es por timestamp con ventana (no por id de instancia del motor):
 * el script arranca DESPUÉS del startTimeUtc del job instance y escribe ANTES de (o apenas tras)
 * su endTimeUtc — los márgenes absorben cola/boot/skew. [Los márgenes contra motor vivo: gate
 * manual del despliegue; sin confirmar aún.]
 *
 * GRAMÁTICA POR-ARCHIVO (issue #162, lado escritor). Lo de arriba hace que el log EXISTA y sea
 * atribuible a una corrida; esto hace que su causa sea atribuible a un ARCHIVO. Por cada archivo
 * de datos que la corrida encontró en el landing, el log lleva EXACTAMENTE UNA línea de desenlace,
 * con el prefijo de canal `[intake]` y el marcador de la familia ya normativa (`✖`, `⚠`, `✔`):
 *
 *     [intake] ✔ procesado: <archivo>
 *     [intake] ⚠ saltado: <archivo> — <motivo>
 *     [intake] ✖ fallido: <archivo> — <motivo>
 *
 * El `<archivo>` es el basename tal como aterrizó. El `<motivo>` es UNA línea, autocontenida y en
 * términos del dato — qué se esperaba y qué se encontró («ancho inesperado: 28 columnas (se
 * esperaban 48)») —, sin jerga del motor ni stack traces: el resto del log sigue siendo libre y es
 * donde eso vive. El motivo llega TEXTUAL al usuario que subió el archivo, así que la legibilidad
 * es obligación del escritor: el producto no parafrasea ni fabrica causas que nadie declaró.
 *
 * ORDEN: las líneas de desenlace van ANTES de la línea de cierre del aborto (`✖ ABORTADO` /
 * `✖ ERROR no controlado`), que sigue siendo la ÚLTIMA `✖` del log — así el titular de la corrida
 * (`diagnosticoDeFalla`, que se queda con la última `✖`) sigue siendo el de la corrida y no el del
 * último archivo. Es un requisito del escritor, no una preferencia de estilo.
 *
 * Un log sin estas líneas sigue siendo válido: el producto degrada al desenlace por corrida y DICE
 * que el job no declaró desenlace por archivo. El contrato completo, citable a la instancia que
 * escribe los jobs, vive en `docs/contrato-ingesta-logs.md`.
 */
import type { OneLakeEntry } from './intake-onelake'
import type { RunRecord } from './ingestion-observability'

/** Directorio default de logs por corrida (relativo al Lakehouse). */
export const RUN_LOG_DIR_DEFAULT = 'Files/code/_logs'
/** Retención que el contrato exige al escritor (archivos). El producto la DECLARA, no la aplica. */
export const RUN_LOG_RETENTION = 60

/** Margen hacia atrás: el script puede escribir su nombre con un reloj ligeramente adelantado. */
const MARGEN_ANTES_MS = 120_000
/** Margen hacia adelante respecto del fin de la corrida. */
const MARGEN_DESPUES_MS = 300_000
/** Sin `endedAt`, la ventana se cierra a 24 h del arranque. */
const VENTANA_ABIERTA_MS = 86_400_000

const RUN_LOG_RE = /^run-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.(?:txt|log)$/i

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Nombre canónico del log de una corrida arrancada en `startedAtIso` (lado escritor / tests). */
export function runLogFileName(startedAtIso: string): string {
  const ms = Date.parse(startedAtIso)
  if (!Number.isFinite(ms)) throw new Error(`run-logs: ISO inválido '${startedAtIso}'.`)
  const d = new Date(ms)
  const ts =
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  return `run-${ts}.txt`
}

/** Epoch ms del timestamp de un nombre `run-YYYYMMDDTHHMMSSZ.txt|.log` (case-insensitive; el
 *  nombre puede venir con path — se toma el basename). null si no sigue la convención. */
export function parseRunLogTimestamp(name: string): number | null {
  const base = String(name ?? '').replace(/^.*\//, '')
  const m = RUN_LOG_RE.exec(base)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m as unknown as string[]
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  if (!Number.isFinite(ms)) return null
  // Rechaza fechas imposibles (p.ej. mes 13) que Date.UTC normalizaría en silencio.
  const back = new Date(ms)
  if (back.getUTCMonth() + 1 !== Number(mo) || back.getUTCDate() !== Number(d)) return null
  return ms
}

/** Resolución del log de UNA corrida contra el listado del directorio `_logs/`. */
export type RunLogResolution =
  | { kind: 'match'; entry: OneLakeEntry }
  | { kind: 'en-curso' }
  | { kind: 'purgado' }
  | { kind: 'sin-log' }

/** Ventana sellada (D3): candidato si ts ∈ [startedAt−120 s, endedAt+300 s] (sin endedAt:
 *  [startedAt−120 s, startedAt+86 400 s]). Gana el de menor |ts − startedAt|; empate → más reciente. */
export function resolveRunLog(run: RunRecord, entries: OneLakeEntry[]): RunLogResolution {
  const started = Date.parse(run.startedAt)
  const ended = run.endedAt ? Date.parse(run.endedAt) : NaN
  const conTs: { entry: OneLakeEntry; ts: number }[] = []
  for (const e of entries ?? []) {
    if (!e || e.isDirectory) continue
    const ts = parseRunLogTimestamp(e.path)
    if (ts == null) continue
    conTs.push({ entry: e, ts })
  }

  if (Number.isFinite(started)) {
    const desde = started - MARGEN_ANTES_MS
    const hasta = Number.isFinite(ended) ? ended + MARGEN_DESPUES_MS : started + VENTANA_ABIERTA_MS
    const candidatos = conTs.filter((c) => c.ts >= desde && c.ts <= hasta)
    if (candidatos.length) {
      let mejor = candidatos[0]!
      for (const c of candidatos.slice(1)) {
        const dc = Math.abs(c.ts - started)
        const dm = Math.abs(mejor.ts - started)
        if (dc < dm || (dc === dm && c.ts > mejor.ts)) mejor = c
      }
      return { kind: 'match', entry: mejor.entry }
    }
  }

  if (run.status === 'InProgress' || run.status === 'NotStarted') return { kind: 'en-curso' }

  if (Number.isFinite(started) && conTs.length) {
    const masViejo = Math.min(...conTs.map((c) => c.ts))
    if (masViejo > started + MARGEN_DESPUES_MS) return { kind: 'purgado' }
  }

  return { kind: 'sin-log' }
}

/** Corridas que el contrato del escritor SÍ cubre: el log se escribe al final de toda corrida que
 *  llegó a correr (éxito o aborto). `Cancelled`/`Deduped` pueden no haber arrancado el script jamás
 *  —contarlas como incumplimiento sería fabricar una acusación—, y `InProgress`/`NotStarted` aún no
 *  terminaron. Las cuatro se SALTAN: ni cuentan ni cortan. */
const TERMINADAS: ReadonlySet<string> = new Set(['Completed', 'Failed'])

/**
 * Corridas TERMINADAS consecutivas —desde la más reciente hacia atrás— cuya resolución de log es
 * `'sin-log'` (#162·§5). El insumo del aviso de incumplimiento del contrato `_logs/`.
 *
 * Reglas, cada una con su porqué:
 *  · **Cuenta solo `'sin-log'`.** `'match'` corta: la conducta reciente cumple. `'purgado'` TAMBIÉN
 *    corta, y sin acusar: significa que el log más viejo retenido es posterior a la ventana de esa
 *    corrida, así que no se puede afirmar que no se escribió — la ausencia de medida no es evidencia
 *    de falta. `'en-curso'` no aplica a corridas terminadas (`resolveRunLog` solo lo devuelve para
 *    `InProgress`/`NotStarted`, verificado arriba en este mismo archivo).
 *  · **Consecutivas desde la más reciente**: es lo que distingue conducta de accidente, y es lo que
 *    el aviso redacta («las últimas N corridas terminadas no dejaron log»).
 *  · **El orden lo impone esta función**, no el llamador: las corridas se ordenan por `startedAt`
 *    descendente antes de recorrer. Un arreglo que llegue en otro orden (o mezclado) daría un conteo
 *    distinto, y eso sería una acusación que depende de quién llamó.
 */
export function contarCorridasSinLog(runs: RunRecord[], entries: OneLakeEntry[]): number {
  const ordenadas = [...(runs ?? [])]
    .filter((r): r is RunRecord => r != null)
    .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0))
  let n = 0
  for (const run of ordenadas) {
    if (!TERMINADAS.has(run.status)) continue
    if (resolveRunLog(run, entries ?? []).kind !== 'sin-log') break
    n++
  }
  return n
}

const REDACTADO = '«…redactado…»'
const CLAVES = 'client_secret|clientsecret|password|pwd|accountkey|sharedaccesskey|sas|secret|token'
const PAR_RE = new RegExp(`\\b(${CLAVES})(\\s*["']?\\s*[=:]\\s*["']?)([^\\s;,"']+)`, 'gi')
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g

/** Defensa en profundidad (D9): enmascara secretos obvios con `«…redactado…»`. */
export function redactSecrets(text: string): string {
  if (!text) return text
  return text.replace(JWT_RE, REDACTADO).replace(PAR_RE, (_m, k: string, sep: string) => `${k}${sep}${REDACTADO}`)
}

/** Desenlace que el job declaró para UN archivo del landing (gramática por-archivo, issue #162). */
export type FileOutcome = {
  /** Basename tal como el job lo nombró (si escribió un path, se toma el basename). */
  file: string
  outcome: 'procesado' | 'saltado' | 'fallido'
  /** Motivo textual del job. Ausente si el job no lo declaró — la ausencia se dice, no se rellena.
   *  Cuando la línea trae el sufijo estructurado `⟦…⟧` (#346) y calza, el motivo va SIN el sufijo. */
  motivo?: string
  /** Código estable del desenlace (#346): `familia` o `familia/especifico`. Solo en `saltado`/
   *  `fallido`, y solo si el sufijo calzó entero. La familia NO se valida acá: el lector no conoce el
   *  catálogo de la instancia — un código de familia desconocida se persiste y lo trata quien muestra. */
  codigo?: string
  /** Datos del caso que acompañan al código (#346). Un valor PELADO con comas es una lista
   *  (`faltan=58,88` ⇒ `['58','88']`); un solo par de comillas es un escalar, aunque traiga comas
   *  (`vigente="Control, v2.xlsx"`); dos o más elementos entrecomillados separados por coma son una
   *  lista (`faltan="folio","rut receptor"` ⇒ `['folio','rut receptor']`). Ausente si el sufijo no
   *  trae ninguno. */
  params?: Record<string, string | string[]>
}

/** Marcador ↔ palabra: el par tiene que calzar. Un `✔ fallido:` no es del contrato, es ruido. */
const OUTCOME_POR_MARCADOR: Record<string, FileOutcome['outcome']> = {
  '✔': 'procesado',
  '⚠': 'saltado',
  '✖': 'fallido',
}

/** `<marcador> <palabra>: <resto>`, ya sin prefijos de canal. El selector de variación es opcional:
 *  el emisor que use la forma emoji del marcador (⚠️) lo escribe detrás. */
const OUTCOME_RE = /^(✔|⚠|✖)️?\s+(procesado|saltado|fallido)\s*:\s*(.+)$/

/** Separador archivo↔motivo: raya (U+2014). El corte es en la PRIMERA — el motivo puede traer más. */
const SEP_MOTIVO = '—'

/**
 * Tolerancia al guion ASCII **con espacios a ambos lados** (#194). La raya no está en el teclado y
 * la ASCII sí, así que el escritor la equivoca fácil; antes, esa línea calzaba a medias y el lector
 * devolvía `file: "x.xlsx - motivo"` — un archivo **inventado** y la causa **perdida**, sin una sola
 * señal. Fabricar un dato y descartar la causa es exactamente el defecto que este contrato existe
 * para cerrar, ocurriendo dentro del contrato mismo.
 *
 * Dos precauciones que definen la forma del arreglo:
 *
 *  1. **Exige los espacios.** Un guion pelado NO separa: los nombres reales de esta familia vienen
 *     cargados de guiones (`oc-17473580-distributions-details-11-08-2026.xlsx`) y cortar por el
 *     primero los destrozaría. El separador es ` - `, no `-`.
 *  2. **La raya manda.** Solo se busca el ASCII cuando NO hay raya en la línea, de modo que un motivo
 *     que contenga ` - ` jamás le gane el corte al separador canónico.
 *
 * Se eligió tolerar en vez de rechazar la línea: rechazarla también pierde el desenlace —y el
 * desenlace es un hecho observado—, mientras que tolerar recupera archivo, resultado y motivo.
 */
const SEP_MOTIVO_ASCII = ' - '

/**
 * Un corte ASCII solo vale si lo que queda a su izquierda TERMINA en una extensión de archivo
 * (#269·P26). Los nombres reales de las planillas traen « - » adentro (`20260921 - Recepción y
 * Facturación Vitro.xlsx`), y cortar en el primero convertía el archivo en `20260921`: el desenlace
 * se atribuía a un nombre que nadie subió y la carga verdadera quedaba sin declaración. La raya
 * canónica (U+2014) no tiene ese problema porque ningún nombre la trae; el guion ASCII sí.
 */
const TERMINA_EN_EXTENSION = /\.[A-Za-z0-9]{2,5}$/

/** Índice y largo del separador archivo↔motivo, o `-1` si la línea no declara motivo. */
function cortaMotivo(resto: string): { corte: number; largo: number } {
  const raya = resto.indexOf(SEP_MOTIVO)
  if (raya >= 0) return { corte: raya, largo: SEP_MOTIVO.length }
  // Todos los « - » candidatos, en orden: gana el PRIMERO cuya izquierda es un nombre de archivo
  // completo. Si ninguno lo es, la línea no declara motivo y el cuerpo entero es el archivo.
  for (let i = resto.indexOf(SEP_MOTIVO_ASCII); i >= 0; i = resto.indexOf(SEP_MOTIVO_ASCII, i + 1)) {
    if (TERMINA_EN_EXTENSION.test(resto.slice(0, i).trimEnd())) return { corte: i, largo: SEP_MOTIVO_ASCII.length }
  }
  return { corte: -1, largo: 0 }
}

/**
 * SUFIJO ESTRUCTURADO de la línea de desenlace (#346) — el código estable y los datos del caso:
 *
 *     [intake] ✖ fallido: <archivo> — <motivo técnico> ⟦<codigo> <clave>=<valor> …⟧
 *
 * Va AL FINAL de la línea, tras un espacio, entre U+27E6/U+27E7. Por qué al final y no dentro del
 * marcador (`✖ fallido[COD]:`): el lector anterior a #346 no reconocería esa línea y el desenlace
 * ENTERO desaparecería si el job se despliega antes que el Producto; al final, el lector viejo lo deja
 * como texto dentro del motivo — degrada a texto visible, no a pérdida.
 *
 * Se extrae ANCLADO AL FINAL y ANTES de cortar archivo↔motivo: así una raya `—` dentro de un valor
 * entrecomillado no puede ganarle el corte al separador canónico (el corte ocurre sobre lo que queda).
 *
 * Todo o nada: si el sufijo no calza la gramática COMPLETA (comillas sin cerrar, `⟦` sin cerrar,
 * código con mayúscula, valor pelado con espacio), NO existe — la línea se lee como antes de #346 y el
 * texto queda dentro del motivo, sin código. Es la regla rectora del contrato aplicada al sufijo: un
 * código a medias sería un desenlace adivinado.
 *
 * Un valor tiene tres formas, probadas en este orden:
 *
 * 1. LISTA ENTRECOMILLADA — dos o más elementos entrecomillados separados por coma, sin espacios entre
 *    ellos: `faltan="folio","rut receptor"` → `['folio', 'rut receptor']`. Es la única forma de llevar
 *    una lista cuyos elementos traen espacios o comas; cada elemento se devuelve TEXTUAL, sin las
 *    comillas (ni se recorta ni se descarta uno vacío: lo entrecomillado es exacto por definición).
 * 2. ESCALAR ENTRECOMILLADO — `vigente="a, b.xlsx"` → `'a, b.xlsx'`. Un solo par de comillas es
 *    siempre escalar, aunque traiga comas (`filas="2,65"` → `'2,65'`).
 * 3. PELADO — `n=3` → `'3'`; con coma es lista: `faltan=58,88` → `['58', '88']`.
 *
 * La forma 1 va primero para que la alternancia no se quede con el primer elemento como escalar y deje
 * el resto sin calzar; como exige al menos dos elementos, un `"x"` solo nunca la toma. Una lista con
 * una comilla sin cerrar (`a="x","y`) no calza ninguna forma y, por todo o nada, no hay sufijo.
 */
const CODIGO_SRC = '[a-z][a-z0-9-]*(?:/[a-z][a-z0-9-]*)?'
const VALOR_LISTA_SRC = '"[^"⟧]*"(?:,"[^"⟧]*")+'
const PARAM_SRC = `[a-z][a-z0-9_]*=(?:${VALOR_LISTA_SRC}|"[^"⟧]*"|[^\\s"⟧]+)`
const SUFIJO_RE = new RegExp(`\\s⟦(${CODIGO_SRC})((?:\\s+${PARAM_SRC})*)\\s*⟧\\s*$`)
const PARAM_RE = new RegExp(`([a-z][a-z0-9_]*)=(?:(${VALOR_LISTA_SRC})|"([^"⟧]*)"|([^\\s"⟧]+))`, 'g')
/** Gramática de un código de desenlace (#346), exportada para quien valida catálogos de guías. */
export const DESENLACE_CODIGO_RE = new RegExp(`^${CODIGO_SRC}$`)

/** Separa el sufijo `⟦…⟧` del resto. `null` si no hay sufijo que calce (la línea queda como está).
 *  Una clave repetida dentro del sufijo: gana la ÚLTIMA — la misma regla que dos líneas del mismo
 *  archivo, y por la misma razón (el escritor declara su valor final). */
export function extraerSufijoDesenlace(resto: string): { resto: string; codigo: string; params?: Record<string, string | string[]> } | null {
  const m = SUFIJO_RE.exec(resto)
  if (!m) return null
  const params: Record<string, string | string[]> = {}
  for (const p of (m[2] ?? '').matchAll(PARAM_RE)) {
    const clave = p[1]!
    // Lista entrecomillada: ningún elemento puede traer `"`, así que `","` separa sin ambigüedad.
    if (p[2] !== undefined) params[clave] = p[2].slice(1, -1).split('","')
    else if (p[3] !== undefined) params[clave] = p[3]
    else {
      const crudo = p[4]!
      params[clave] = crudo.includes(',') ? crudo.split(',').map((x) => x.trim()).filter(Boolean) : crudo
    }
  }
  const out: { resto: string; codigo: string; params?: Record<string, string | string[]> } = { resto: resto.slice(0, m.index).trimEnd(), codigo: m[1]! }
  if (Object.keys(params).length) out.params = params
  return out
}

/**
 * Desenlaces por archivo declarados en el texto de un log de corrida — PURO, sin IO.
 *
 * Reglas, todas por el mismo principio: una línea que no calza la gramática NO EXISTE (jamás se
 * adivina un desenlace a partir de texto libre — fabricar causas es el defecto que este contrato
 * existe para cerrar).
 *
 * - Prefijos de canal adicionales se toleran y se descartan (`[ingest] [intake] ✔ …`), igual que en
 *   `diagnosticoDeFalla` de `admin-cargas.ts`; el `[intake]` del contrato es uno de ellos.
 * - El par marcador↔palabra debe calzar, y la palabra va en minúsculas exactas.
 * - `saltado`/`fallido` sin motivo SÍ cuentan: el desenlace es un hecho observado y perderlo sería
 *   peor que reportarlo sin causa — queda con `motivo` ausente, y quien lo presente dice que el job
 *   no lo declaró. En `procesado` el motivo no es parte de la gramática y se ignora si aparece.
 * - Dos líneas para el mismo archivo: gana la ÚLTIMA (un reintento dentro de la misma corrida
 *   declara su resultado final); el orden de salida es el de la primera aparición de cada archivo.
 * - El motivo se devuelve TEXTUAL: pasa por `redactSecrets` al RENDERIZAR, no acá — un parser que
 *   redacta impide comparar con la fuente.
 */
export function parseRunFileOutcomes(logText: string): FileOutcome[] {
  if (!logText) return []
  const orden: string[] = []
  const porArchivo = new Map<string, FileOutcome>()
  for (const raw of String(logText).split('\n')) {
    const linea = raw.replace(/^\s*(?:\[[^\]]*\]\s*)*/, '').trim()
    const m = OUTCOME_RE.exec(linea)
    if (!m) continue
    const [, marcador, palabra, resto] = m as unknown as string[]
    const outcome = OUTCOME_POR_MARCADOR[marcador!]
    if (!outcome || outcome !== palabra) continue
    // #346 · el sufijo se extrae PRIMERO y solo en `saltado`/`fallido` (en `procesado` no es parte de
    // la gramática: esa línea se lee exactamente como antes).
    const sufijo = outcome !== 'procesado' ? extraerSufijoDesenlace(resto!) : null
    const cuerpo = sufijo ? sufijo.resto : resto!
    // #269·P26 · el corte ASCII exige que la izquierda sea un nombre de archivo completo (ver
    // `cortaMotivo`), también en `procesado`: así `20260921 - Recepción….xlsx` queda entero y un
    // `z.xlsx - nota` que el escritor agregó tras un ✔ sigue leyéndose `z.xlsx` (el texto se descarta:
    // `procesado` no lleva motivo).
    const { corte, largo } = cortaMotivo(cuerpo)
    const file = (corte >= 0 ? cuerpo.slice(0, corte) : cuerpo).trim().replace(/^.*[/\\]/, '')
    if (!file) continue
    const motivo = corte >= 0 ? cuerpo.slice(corte + largo).trim() : ''
    const fo: FileOutcome = { file, outcome }
    if (motivo && outcome !== 'procesado') fo.motivo = motivo
    if (sufijo) {
      fo.codigo = sufijo.codigo
      if (sufijo.params) fo.params = sufijo.params
    }
    if (!porArchivo.has(file)) orden.push(file)
    porArchivo.set(file, fo)
  }
  return orden.map((f) => porArchivo.get(f)!)
}

/** Lo que UNA corrida declaró de UN archivo conocido (#269·§3.2 regla 2). */
export interface DeclaracionDeArchivo {
  outcome: FileOutcome['outcome']
  motivo?: string
  codigo?: string
  params?: Record<string, string | string[]>
}

/**
 * La declaración que un log hace de UN archivo cuyo nombre ya se conoce (el de la carga registrada) —
 * PURA. Es la lectura que usa el resolvedor de estado (#269, D14) y la razón de que exista aparte de
 * `parseRunFileOutcomes`: el lector general tiene que ADIVINAR dónde termina el nombre y empieza el
 * motivo; quien pregunta por un nombre conocido no adivina nada — compara.
 *
 * Una línea es de este archivo si, tras el marcador `✔ procesado:` / `⚠ saltado:` / `✖ fallido:`, su
 * cuerpo (sin el sufijo `⟦…⟧`) es el nombre, o empieza con el nombre seguido de fin, espacio o raya.
 * Un prefijo de ruta (`Files/intake/x/<nombre>`) se tolera: el contrato dice basename, pero el escritor
 * que pone la ruta sigue declarando el mismo archivo.
 *
 * Varias líneas del mismo archivo en el mismo log: gana la ÚLTIMA (misma regla que el lector general).
 * `undefined` = el log no nombra este archivo — y eso NO es evidencia de nada sobre él (§3.2).
 */
export function declaracionDeArchivo(logText: string, filename: string): DeclaracionDeArchivo | undefined {
  if (!logText || !filename) return undefined
  const nombre = String(filename).replace(/^.*[/\\]/, '')
  let ultima: DeclaracionDeArchivo | undefined
  for (const raw of String(logText).split('\n')) {
    const linea = raw.replace(/^\s*(?:\[[^\]]*\]\s*)*/, '').trim()
    const m = OUTCOME_RE.exec(linea)
    if (!m) continue
    const [, marcador, palabra, resto] = m as unknown as string[]
    const outcome = OUTCOME_POR_MARCADOR[marcador!]
    if (!outcome || outcome !== palabra) continue
    const sufijo = outcome !== 'procesado' ? extraerSufijoDesenlace(resto!) : null
    const cuerpo = (sufijo ? sufijo.resto : resto!).trim()
    const i = cuerpo.indexOf(nombre)
    if (i < 0) continue
    // Lo que precede al nombre tiene que ser nada o una ruta (termina en separador, sin raya).
    const antes = cuerpo.slice(0, i)
    if (antes && (!/[/\\]$/.test(antes) || antes.includes(SEP_MOTIVO))) continue
    const despues = cuerpo.slice(i + nombre.length)
    if (despues && !/^(\s|—)/.test(despues)) continue
    const d: DeclaracionDeArchivo = { outcome }
    const motivo = despues.replace(/^\s*(?:—|-)?\s*/, '').trim()
    if (motivo && outcome !== 'procesado') d.motivo = motivo
    if (sufijo) {
      d.codigo = sufijo.codigo
      if (sufijo.params) d.params = sufijo.params
    }
    ultima = d
  }
  return ultima
}
