/**
 * Consola de CARGAS por dominio (issue #58, compone #53/#55/#56/#57) — `/admin/dominio/<id>/cargas`.
 *
 * La vivencia completa de la operación de carga, por slot:
 *   · ACTIVIDAD: línea de tiempo que correlaciona cargas de archivos (audit log: quién/cuándo/tamaño)
 *     con corridas de conversión (jobs/instances: estado/duración/motivo) — el historial PRO.
 *   · LOG de la última conversión (#55) y estado con motivo (#53).
 *   · LANDING: archivos activos, con marca de RESIDUO (#57: anteriores a la última corrida completada
 *     → se re-procesarán) y acción de RETIRO (a `_retirado/`, reversible).
 *   · ARCHIVO (`_processed/`): lo ya procesado, con acción de REACTIVAR (copiar de vuelta al landing)
 *     — el rollback honesto: retirar + re-correr revierte pipelines por-clave; reactivar re-materializa.
 *   · RE-RUN: correr la conversión de nuevo (run-now del trigger).
 *   · COHERENCIA (#56): aviso ruidoso si el trigger del slot no está registrado como proceso.
 *   · VIGILANCIA (#161/#162): banner del vigilante con la CALIDAD de la medida, marca de VARADO en el
 *     landing, desenlace por carga en Actividad y aviso de incumplimiento del contrato `_logs/`.
 *
 * Este módulo es PURO (datos → HTML): el fetch de datos y los POST (CSRF + steward + audit) viven en
 * admin.ts / serve-rls. Helpers de render locales a propósito (evita ciclo de imports con admin.ts).
 *
 * Corolario para lo de #161/#162: acá NO se clasifica nada. La edad que vuelve VARADO a un archivo y
 * la calidad de la medida las decide `classifySlot` (`intake-observability.ts`) en el lazo; esta
 * página recibe el veredicto ya tomado (`SlotCargas.vigilancia`) y lo dibuja. Todos los campos nuevos
 * son OPCIONALES: una instancia sin vigilante renderiza exactamente la página de antes.
 */
import { escapeHtml, slotLogPath, slotRunLogsDir, isSidecarName, redactSecrets, type IntakeSlot, type RunRecord, type RunStatus, type OneLakeEntry, type ClaveAccion, type IntakeRevertRow, type RevertPlan, type RevertResult, type MedidaCalidad, type ArchivoVarado, type CargaDesenlace, type DesenlaceParams, type DesenlaceCodigoConteo, type GuiaDecl, type GuiaResuelta, LINEA_ACTOR, resolverGuia, familiaDe, guiasDelSlot, DEFAULT_MAX_RUN_MINUTES } from '@vergis/capabilities'
import type { IntakeIntentoRow } from '../packages/capabilities/src/governance-store'
import { nombreSinSello } from '../packages/capabilities/src/intake-observability'
import { slotProcessedDir } from '../packages/capabilities/src/intake'
import { chip as chipHtml, type Tono } from './ui'

/** Evento de carga del audit log (type=intake). */
export interface IntakeUploadEvent {
  ts: string
  filename: string
  bytes: number
  by: string
  ok: boolean
  triggered: boolean
  /** Id de la carga en el registro (#62): el ancla de «Revertir esta carga» (#63). Sin él, no hay botón. */
  id?: number
  /** SHA-256 del contenido (issue #62): identidad de la carga, independiente del nombre. */
  sha256?: string
  /** Si el contenido es idéntico a una carga previa del slot: `<filename> · <ts>` de aquella. */
  dupOf?: string
  /** #162 · desenlace resuelto de esta carga (columna del registro). Ausente = todavía pendiente. */
  desenlace?: CargaDesenlace
  /** #162 · motivo TEXTUAL que el job declaró en `_logs/`. Ausente = no lo declaró — no se rellena. */
  desenlaceMotivo?: string
  /** #162 · `startedAt` de la corrida que cubrió la carga: ancla del enlace a esa corrida. */
  desenlaceRunStartedAt?: string
  /** #346 · código estable que el job declaró (sufijo `⟦…⟧`). Ausente = sin código: la celda es la de siempre. */
  desenlaceCodigo?: string
  /** #346 · datos del caso que la guía interpola. */
  desenlaceParams?: DesenlaceParams
  /** #269·V7 · el motivo del RECHAZO en la puerta (solo `ok: false`). */
  error?: string
  /** #269·D1 · el estado es final. Ausente = lo escribió la versión anterior (o no hay estado). */
  desenlaceFinal?: boolean
  /** #269·D1 · lo que cada corrida declaró de esta carga, en orden. */
  intentos?: IntakeIntentoRow[]
  /** #269·§4.2 · instante del acto que cerró la carga (retiro, re-subida, deshacer). */
  actoAt?: string
  /** Instante en que la plataforma escribió el estado. */
  desenlaceAt?: string
}

/**
 * Lo que el vigilante del intake (#161) sabe de UN slot, ya clasificado por `classifySlot`.
 *
 * Existe para que el operador distinga «no hay novedad» de «no pude medir»: por eso `medida` es
 * obligatoria acá y `SlotCargas.vigilancia` entera es opcional — sin vigilante no hay banner, no hay
 * media verdad.
 */
export interface SlotVigilancia {
  /** Calidad de la ÚLTIMA clasificación del lazo (§3.1 del diseño). */
  medida: MedidaCalidad
  /** ISO de la última observación EXITOSA. Ausente = jamás se midió bien (medida `'ninguna'`). */
  observedAt?: string
  /** Error del intento más reciente, si falló. */
  lastError?: string
  lastErrorAt?: string
  /** Archivos varados con su edad, tal como los devolvió la clasificación. La página NO los deriva. */
  varados?: ArchivoVarado[]
  /** `'contradice-registro'`: basenames que el registro esperaba ver y el listado no trae (§3.3). */
  esperados?: string[]
  /** #162·§5 · corridas TERMINADAS consecutivas sin log correlacionable en `_logs/`. Alimenta el
   *  aviso de incumplimiento del contrato; ausente = la instancia no mide esto. */
  corridasSinLog?: number
  /** #269·§4.1 · nombres del registro que calzan con este tipo Y con otro (medido tras la recarga). */
  ambiguos?: { nombre: string; slots: string[] }[]
  /** #269·0.35.1 · pares de casillas cuyos patrones se pisan con certeza (incluye esta). */
  pisan?: [string, string][]
}

/**
 * El log de la última conversión, CON la marca de cuándo se escribió (issue #86).
 *
 * El contenido solo no basta: si el job murió antes de escribir, el archivo que se lee es el de la
 * corrida ANTERIOR. `lastModified` (ISO, del listado de OneLake) permite detectarlo. Es opcional a
 * propósito — fail-safe: sin mtime no se afirma añejez y todo se comporta como antes.
 */
export interface CargaLog {
  text: string
  lastModified?: string
}

/** Operaciones de la consola — las inyecta el wiring (serve-rls) y las consume admin.ts. */
export interface CargasOps {
  history(slot: IntakeSlot, limit: number): Promise<IntakeUploadEvent[]>
  runs(slot: IntakeSlot, top: number): Promise<RunRecord[]>
  log(slot: IntakeSlot): Promise<CargaLog | null>
  landing(slot: IntakeSlot): Promise<OneLakeEntry[]>
  archived(slot: IntakeSlot): Promise<OneLakeEntry[]>
  rerun(slot: IntakeSlot, by: string): Promise<void>
  retire(slot: IntakeSlot, filename: string, by: string): Promise<void>
  restore(slot: IntakeSlot, archivedPath: string, by: string): Promise<void>
  // ── «Revertir esta carga» (issue #63): dos fases, plan sellado por hash ──
  /** Reversiones ya registradas del slot, recientes primero (alimentan la fila ↩️ del timeline). */
  reverts?(slot: IntakeSlot, limit: number): Promise<IntakeRevertRow[]>
  /**
   * #161 · lo que el vigilante sabe del slot, LEÍDO DE SU PROYECCIÓN. Ausente = instancia sin
   * vigilante cableado (o con el lazo apagado): la página es la de siempre, sin banner ni marcas.
   *
   * El wiring que la implementa NO lista OneLake ni consulta el motor: esta op existe para traer el
   * veredicto ya medido por el lazo, no para medir en el request path.
   */
  vigilancia?(slot: IntakeSlot): Promise<SlotVigilancia | null>
  /**
   * #346 · conteo por código de los desenlaces declarados por el job (`fallida`/`saltada`) del slot,
   * subidos desde `desdeIso`. Alimenta la señal de cobertura y el orden de «Errores frecuentes».
   * Ausente = la instancia no la cablea: ni señal ni orden por frecuencia (la página lista igual).
   */
  codigos?(slot: IntakeSlot, desdeIso: string): Promise<DesenlaceCodigoConteo[]>
  /** #269·V6 · lo que las corridas declararon de las cargas de ESTE slot desde `desdeIso` (del registro
   *  de intentos, sin leer logs): cada corrida dice qué tomó de este tipo. */
  intentos?(slot: IntakeSlot, desdeIso: string): Promise<(IntakeIntentoRow & { filename: string })[]>
  /** Deriva el plan de compensación SIN mutar nada: qué le pasa a cada clave de la carga. */
  revertPlan?(slot: IntakeSlot, ref: { uploadId?: number; archivedPath?: string }): Promise<RevertPlan>
  /** Ejecuta el plan CONFIRMADO. `ok:false` = el estado del slot cambió: devuelve el plan fresco. */
  revertExec?(slot: IntakeSlot, planHash: string, ref: { uploadId?: number; archivedPath?: string }, by: string):
    Promise<{ ok: true; result: RevertResult } | { ok: false; plan: RevertPlan }>
}

/** Todo lo que la página necesita de UN slot, ya fetcheado (tolerante: 'error' no rompe la página). */
export interface SlotCargas {
  slot: IntakeSlot
  runs: RunRecord[] | 'error'
  history: IntakeUploadEvent[] | 'error'
  log: CargaLog | null
  landing: OneLakeEntry[] | 'error'
  archived: OneLakeEntry[] | 'error'
  /** #63: reversiones registradas del slot (filas ↩️ del timeline). Ausente = la instancia no las tiene. */
  reverts?: IntakeRevertRow[]
  /** #56: ¿el processRef del trigger está registrado como proceso (con engine_ref)? */
  procesoRegistrado: boolean
  /** #161: lo que el vigilante sabe del slot. Ausente = instancia sin vigilante cableado ⇒ la página
   *  es la de siempre, sin banner ni marcas de varado (regresión cero por construcción). */
  vigilancia?: SlotVigilancia
  /** #346 · catálogo de guías de la instancia (lista viva). Ausente = la instancia no cableó guías:
   *  la celda Desenlace y el encabezado del slot son los de siempre (regresión cero por construcción).
   *  Presente (aunque vacío) = las guías genéricas del Producto aplican a todo desenlace con código. */
  guias?: readonly GuiaDecl[]
  /** #346 · conteo por código de los últimos 30 días (señal de cobertura del operador). */
  codigos30?: DesenlaceCodigoConteo[]
  /** #269·V6 · intentos del slot por corrida (qué tomó cada una). Ausente = no se cablea: sin línea. */
  intentosDeCorridas?: (IntakeIntentoRow & { filename: string })[]
  /** #269·V12 · ¿hay un destino suscrito a `cargas-operador`? Decide la línea de aviso. */
  hayDestinoOperador?: boolean
}

// ─── Helpers de render (locales: sin ciclo con admin.ts) ────────────────────
function badge(s: RunStatus): string {
  switch (s) {
    case 'Completed': return '<b style="color:var(--accent)">✓ Listo</b>'
    case 'Failed': return '<b style="color:var(--err)">✕ Falló</b>'
    case 'InProgress': return '⏳ Procesando'
    case 'NotStarted': return '⏳ En cola'
    case 'Cancelled': return '⊘ Cancelada'
    case 'Deduped': return '⊘ Omitida'
    default: return escapeHtml(s)
  }
}
function when(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const d = new Date(t)
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`
}
function dur(r: RunRecord): string {
  if (!r.endedAt) return ''
  const ms = Date.parse(r.endedAt) - Date.parse(r.startedAt)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}
const baseName = (p: string): string => p.split('/').pop() ?? p
/** Edad en minutos → texto operativo. Los minutos los computó la clasificación; acá solo se leen. */
function edad(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}
/** Amarillo del aviso que no es error (#269·§5: el token `--warn`, antes un `--yellow` sin definir). */
const AVISO = 'color:var(--warn)'

// ─── Vigilancia del intake (#161/#162) ──────────────────────────────────────

/**
 * Corridas terminadas consecutivas SIN log correlacionable a partir de las cuales el slot se declara
 * incumpliendo el contrato `_logs/` (#162·§5, que pide «N corridas» sin fijar N).
 *
 * El 3 es decisión de este hito, no del diseño: es el mismo número que `SIN_MEDIDA_TICKS` (3× el
 * poll, precedente del stale de frescura) y el criterio es el mismo — una vez es un accidente, tres
 * seguidas es una conducta. Sin evidencia de campo sobre cuál es el N que no genera ruido; si el
 * operador lo reporta, se ajusta acá.
 */
export const CORRIDAS_SIN_LOG_AVISO = 3

/**
 * El BANNER del vigilante: qué tan confiable es lo que la página muestra de este slot (#161·§6.1).
 *
 * La razón de ser de esta línea es que el operador distinga «no hay novedad» de «no pude medir». Por
 * eso `'fresca'` es sobria (no hay nada que hacer) y solo las medidas que invalidan la vista gritan.
 * `'contradice-registro'` afirma LA CONTRADICCIÓN y nunca su causa: la plataforma sabe que puso esos
 * archivos ahí y el almacenamiento dice que no están — por qué (permisos, borrado a mano, path mal
 * configurado) no lo sabe nadie desde acá, y escribirlo sería fabricar la causa.
 */
export function vigilanciaBanner(v: SlotVigilancia | undefined): string {
  if (!v) return ''
  const medido = v.observedAt ? ` <span class="sub">· medido ${when(v.observedAt)}</span>` : ''
  const err = v.lastError ? `: ${escapeHtml(redactSecrets(v.lastError).slice(0, 300))}` : ''
  switch (v.medida) {
    case 'fresca':
      return `<p class="sub">👁 Vigilancia del slot: al día${v.observedAt ? ` · medido ${when(v.observedAt)}` : ''}.</p>`
    case 'ultima-conocida':
      return `<p class="sub" style="${AVISO}">⚠ El vigilante no pudo medir este slot en su último intento${v.lastErrorAt ? ` (${when(v.lastErrorAt)})` : ''}${err}. Lo que la vigilancia afirma abajo viene de su última medida buena${v.observedAt ? ` (${when(v.observedAt)})` : ''}, no de ahora.</p>`
    case 'contradice-registro': {
      const lista = (v.esperados ?? []).map((f) => `<b>${escapeHtml(f)}</b>`).join(', ')
      return `<p class="msg err">⚠ El listado del landing CONTRADICE el registro de cargas${medido}. La plataforma registra ${lista ? `${lista} como ${(v.esperados ?? []).length === 1 ? 'carga vigente' : 'cargas vigentes'} de este slot` : 'cargas vigentes de este slot'} y el listado no ${(v.esperados ?? []).length === 1 ? 'la trae' : 'trae ninguna'}. No se concluye que el landing esté vacío ni que esas cargas se hayan procesado — la causa de la discrepancia no se puede determinar desde acá.</p>`
    }
    case 'ninguna':
      return `<p class="sub" style="${AVISO}">⚠ El vigilante todavía no ha logrado observar este slot: no hay medida sobre la que afirmar nada${err}.</p>`
  }
}

/**
 * Aviso de incumplimiento del contrato `_logs/` (#162·§5).
 *
 * El Producto no puede forzar al escritor de la instancia a escribir su log; puede volver el
 * incumplimiento visible y ruidoso donde el operador ya mira — misma familia que el aviso de
 * coherencia #56. Sin log por corrida no hay causa por archivo: los desenlaces caen a «sin informe»,
 * que es la verdad, y esa verdad es cara.
 */
export function avisoContratoLogs(slot: IntakeSlot, v: SlotVigilancia | undefined): string {
  // TRES estados, no dos (#200). El `?? 0` anterior colapsaba «no se midió» sobre «se midió y
  // cumple»: los dos salían como silencio, y el silencio caía del lado optimista. En un tablero cuyo
  // propósito es que las cargas dejen de fallar sin que nadie se entere, ésa es la lectura más cara.
  //
  // El aviso de no-medición tiene DOS fronteras, y las dos son deliberadas — cada una la exige un
  // test que existía antes que este arreglo:
  //
  //  · **Sin `v`** no es «sin medición», es **instancia sin vigilante cableado**: ahí la consola
  //    tiene que ser la página de siempre (regresión cero, criterio 4 del hito). Con el vigilante
  //    encendido el dep siempre entrega un `SlotVigilancia`, y el caso «nunca observado» ya tiene
  //    su estado propio con su banner: `medida: 'ninguna'`.
  //  · **Sin directorio `_logs/`** (`log: false`) el slot **no participa del contrato**: su cuenta
  //    está ausente con razón, y avisar sería acusar de no medir algo que nadie prometió medir.
  //
  // Lo que queda en medio —slot dentro del contrato, con vigilancia, y sin cuenta— es el hueco que
  // nadie reportaba, y es el que este aviso cubre.
  const dir = slotRunLogsDir(slot)
  if (!dir || v === undefined) return ''
  const n = v.corridasSinLog
  if (n === undefined) {
    const err = v.lastError ? ` El último intento de medición falló: ${escapeHtml(v.lastError)}.` : ''
    return `<p class="sub" style="${AVISO}">⚠ Sin medición del contrato <code>_logs/</code> en este slot: no se ha observado si sus corridas dejan log, así que <b>no se afirma que cumpla</b>.${err}</p>`
  }
  if (n < CORRIDAS_SIN_LOG_AVISO) return ''
  return `<p class="msg err">⚠ Este slot no cumple el contrato <code>_logs/</code>: las últimas ${n} corridas terminadas no dejaron log correlacionable en <code>${escapeHtml(dir)}</code>. Sin log por corrida no hay causa por archivo: el desenlace de cada carga queda en «sin informe» y el usuario que subió no recibe motivo. Corregir el job para que escriba su log al terminar (<code>docs/contrato-ingesta-logs.md</code>).</p>`
}

/** Texto propio de la plataforma cuando NO hay motivo del job: describe el estado, jamás la causa. */
const SIN_INFORME_TEXTO = 'No sabemos qué pasó con este archivo: el proceso de carga no lo informó.'

/** Contexto de la celda de estado de una carga (#269·§4.2) que la fila sola no sabe. */
export interface ContextoEstado {
  /** El archivo sigue en el landing (se reintenta solo). Ausente = no se sabe: no se afirma. */
  enLanding?: boolean
  /** Hay una corrida en curso que arrancó con el archivo ya subido (o lo estaba cuando se subió). */
  enCurso?: boolean
  /** La línea de aviso ya decidida (`lineaDeAviso`): «Le avisamos…», «Avísale a…» o nada. */
  aviso?: string | null
  /** Título legible de un intento (la guía de su código, o su motivo): el «primer intento». */
  tituloDeIntento?: (i: IntakeIntentoRow) => string
  /** #269·P2 · minutos que lleva esperando sin estado y la edad máxima del tipo: «Lleva … esperando». */
  esperaMin?: number
  edadMaximaMin?: number
  /** #269·P2 · cómo se escribe una fecha. Default: UTC rotulado (vista técnica); la página de carga
   *  pasa `<time>` para la zona del navegador. Devuelve HTML. */
  fecha?: (iso: string | undefined) => string
}

/**
 * #269·V12 · La LÍNEA DE AVISO: qué pasa del lado de la plataforma cuando el problema no es del
 * archivo. Dice la verdad o no se dibuja — «Le avisamos al equipo» solo si hay un destino suscrito al
 * flujo `cargas-operador`; si no, a quién avisar (`contacto`); sin ninguno de los dos, nada (antes la
 * frase salía sin condición y nadie recibía ningún aviso: P15).
 */
export function lineaDeAviso(ctx: { equipoAvisado?: boolean; contacto?: string }): string | null {
  if (ctx.equipoAvisado) return 'Le avisamos al equipo de la plataforma.'
  if (ctx.contacto) return `Avísale a ${ctx.contacto}.`
  return null
}

/** Fecha corta de la consola técnica (UTC rotulado). */
const fechaCorta = (iso: string | undefined): string => (iso ? when(iso) : '')

/** El estado de UNA carga como lo ve una persona (#269·§4.2): tono, etiqueta del chip, frase (HTML) y
 *  si se le ofrece «Retirar este archivo». */
export interface EstadoVisible {
  tono: Tono
  etiqueta: string
  frase: string
  retirable: boolean
}

/** Edad en minutos, dicha para una persona («3 horas», «2 días»). */
function edadLegible(min: number): string {
  const m = Math.max(0, Math.floor(min))
  if (m < 60) return `${m} minuto${m === 1 ? '' : 's'}`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} hora${h === 1 ? '' : 's'}`
  const d = Math.floor(h / 24)
  return `${d} días`
}

/**
 * El ESTADO VISIBLE de una carga (#269·§4.2, la tabla «Cada carga, por estado»): un solo origen de
 * textos para la página del archivo y la consola técnica. Nada de esto adivina: cada frase sale de un
 * estado que el resolvedor escribió con su evidencia, y la línea de aviso solo si es cierta. El bloque
 * de la guía (título, qué pasó, qué hacer) y el motivo del proceso los dibuja quien llama.
 */
export function estadoVisible(h: IntakeUploadEvent, ctx: ContextoEstado = {}, guia?: GuiaResuelta | null): EstadoVisible {
  const f = ctx.fecha ?? ((x: string | undefined) => escapeHtml(fechaCorta(x)))
  const aviso = ctx.aviso ? ` ${escapeHtml(ctx.aviso)}` : ''
  const espera = ctx.enLanding ? ' Mientras tanto, este archivo sigue en espera y se vuelve a intentar solo.' : ''
  const e = (tono: Tono, etiqueta: string, frase: string, retirable = false): EstadoVisible => ({ tono, etiqueta, frase, retirable })
  if (!h.ok) return e('error', '✕ No se recibió', escapeHtml(motivoDeRechazo(h.error)))
  const final = h.desenlaceFinal === true
  if ((!h.desenlace || !final) && ctx.enCurso) return e('curso', '⏳ Cargando', 'Se está cargando.')
  const operador = (): EstadoVisible => e('atencion', '⚠ Problema de la plataforma', `No es por tu archivo: el proceso de carga tuvo un problema propio. No lo corrijas ni lo vuelvas a subir.${aviso}`)
  switch (h.desenlace) {
    case undefined: {
      const lleva = ctx.esperaMin != null && ctx.edadMaximaMin != null && ctx.esperaMin > ctx.edadMaximaMin ? ` Lleva ${edadLegible(ctx.esperaMin)} esperando.` : ''
      return e('espera', 'Recibido', `Lo recibimos. Empieza a cargarse en unos minutos.${lleva}`, ctx.enLanding !== false)
    }
    case 'procesada': {
      const primero = (h.intentos ?? []).find((i) => i.origen === 'declaracion' && i.resultado !== 'procesada')
      const cuandoIso = h.desenlaceRunStartedAt ?? h.desenlaceAt
      const cuando = cuandoIso ? ` el ${f(cuandoIso)}` : ''
      const intento = primero && ctx.tituloDeIntento ? ` En el primer intento: ${escapeHtml(ctx.tituloDeIntento(primero))}.` : ''
      return e('ok', '✓ Cargado', `Los datos quedaron en la plataforma${cuando}.${intento}`)
    }
    case 'fallida':
      if (guia?.actor === 'operador') return operador()
      if (guia?.actor === 'nadie') return e('espera', '⏸ En espera', '')
      if (guia) return e('error', '✕ Hay que corregir algo', espera.trim(), ctx.enLanding === true)
      return e('error', '✕ No se pudo cargar', `El proceso de carga lo rechazó con este mensaje:${espera}`, ctx.enLanding === true)
    case 'saltada':
      if (guia?.actor === 'operador') return operador()
      if (guia?.familia === 'volumen-anomalo') return e('atencion', '⚠ Detenido por precaución', '', ctx.enLanding === true)
      if (guia?.actor === 'nadie') return e('espera', '⏸ En espera', '')
      if (guia) return e('atencion', '⏸ No se cargó', espera.trim(), ctx.enLanding === true)
      return e('atencion', '⏸ No se cargó', `El proceso de carga no lo cargó y no dijo por qué.${ctx.enLanding ? ' Sigue en espera y se volverá a intentar.' : ''}${aviso}`)
    case 'sin-informe':
      return e('atencion', '⚠ Sin informe', `${SIN_INFORME_TEXTO}${aviso}`)
    case 'retirada':
      return e('espera', 'Retirado', `Se retiró${h.actoAt ? ` el ${f(h.actoAt)}` : ''}; no se cargó.`)
    case 'reemplazada':
      return e('espera', 'Reemplazado', `Lo reemplazó la carga${h.actoAt ? ` de ${f(h.actoAt)}` : ''} con el mismo nombre; esta versión no se cargó.`)
    case 'deshecha':
      return e('espera', 'Deshecho', `Se cargó${h.desenlaceRunStartedAt ? ` el ${f(h.desenlaceRunStartedAt)}` : ''} y se deshizo${h.actoAt ? ` el ${f(h.actoAt)}` : ''}.`)
    case 'varada':
      // Legado (< 0.35.0): la edad dejó de ser un estado (#269·§3.1); solo se lee lo ya escrito.
      return e('atencion', '⚠ En espera', 'Lleva mucho tiempo esperando a que el proceso de carga lo tome.', ctx.enLanding === true)
    default:
      return e('espera', String(h.desenlace), '')
  }
}

/**
 * El CHIP y la FRASE de una carga (#269·§4.2), ya en HTML: lo que usa la columna Estado de la consola
 * técnica. Sale de `estadoVisible`, el mismo origen de textos que la página del archivo.
 */
export function chipDeCarga(h: IntakeUploadEvent, ctx: ContextoEstado = {}, guia?: GuiaResuelta | null): { chip: string; frase: string } {
  const v = estadoVisible(h, ctx, guia)
  return { chip: chipHtml(v.tono, v.etiqueta), frase: v.frase }
}

/**
 * El motivo de un RECHAZO en la puerta, dicho para quien subió (#269·V7). El texto de la validación es
 * del operador («no coincide con el patrón esperado «X»»); acá se dice lo mismo sin jerga. Un motivo
 * que no se reconoce se muestra tal cual — ya es texto humano (la validación de metadata lo es).
 */
export function motivoDeRechazo(error: string | undefined, ctx?: { otroTipo?: string | null }): string {
  if (!error) return 'No se recibió (el motivo no quedó registrado).'
  const patron = /no coincide con el patrón esperado «(.+)»/.exec(error)
  // #269·§4.2 · con contexto (la página del archivo): si el nombre corresponde a OTRO tipo, se dice
  // cuál; si no corresponde a ninguno, la frase de la tabla. Sin contexto, lo que se sabe.
  if (patron && ctx) return ctx.otroTipo ? `Este archivo corresponde a «${ctx.otroTipo}», no a este tipo de archivo.` : 'Este nombre no corresponde a ningún archivo que puedas subir.'
  if (patron) return `El nombre no calza con el que espera este tipo de archivo («${patron[1]}»).`
  const tam = /\((\d+) bytes\) excede el máximo del slot \((\d+) bytes\)/.exec(error)
  if (tam) return `Pesa ${(Number(tam[1]) / 1048576).toFixed(1)} MB y el máximo es ${Math.round(Number(tam[2]) / 1048576)} MB.`
  return error
}

/** Largo desde el que la celda SIN guía recorta el motivo (el recorte de siempre, #162). */
const MOTIVO_RECORTE = 300

/**
 * El plegado «Detalle técnico» (#346): el motivo COMPLETO del job —sin recorte, escapado y redactado—
 * y, si lo hubo, el código. El texto técnico no se borra ni se acorta: pasa a segundo plano.
 */
function detalleTecnico(motivo: string | undefined, codigo?: string): string {
  if (!motivo && !codigo) return ''
  const m = motivo ? `<div class="sub" style="white-space:pre-wrap">${escapeHtml(redactSecrets(motivo))}</div>` : ''
  const c = codigo ? `<div class="sub">código: <code>${escapeHtml(codigo)}</code></div>` : ''
  return `<details class="guia"><summary class="sub">Detalle técnico</summary>${m}${c}</details>`
}

/** Clase visual de la línea de actor: el operador en rojo sobrio (la falla es de la plataforma, no
 *  del archivo), el usuario en amarillo de aviso, «nadie» en gris. */
const ESTILO_ACTOR: Record<GuiaResuelta['actor'], string> = {
  usuario: AVISO,
  operador: 'color:var(--err)',
  nadie: '',
}

/**
 * La celda DESENLACE de una carga (#162·§6.2 · #346).
 *
 * El motivo lo escribe un job de terreno: es texto no confiable que termina en HTML. Va escapado
 * (`escapeHtml`) y redactado (`redactSecrets`) — un log puede traer una cadena de conexión, y el
 * operador no tiene por qué recibirla en pantalla para leer «ancho inesperado: 28 columnas».
 *
 * **Con guía (#346)** — el job declaró un código y la guía se resolvió —: insignia, la línea de ACTOR
 * (quién tiene que moverse), el título y el qué pasó de la guía, el qué hacer numerado, y el motivo
 * técnico COMPLETO plegado en «Detalle técnico» con el código. La guía también es texto no confiable
 * (la escribe la instancia y la interpolan datos del job): va escapada igual.
 *
 * **Sin guía** — sin código, o un código de familia desconocida —: la celda de siempre (insignia +
 * motivo recortado a 300). La única diferencia aditiva: si el recorte se comió algo, el motivo
 * completo queda a un clic en «Detalle técnico». En el caso que originó #346 lo que el recorte se
 * comía era justo lo accionable («Pedir el maestro actualizado», pasado el carácter 300 de 508).
 *
 * El enlace a la corrida solo aparece si el `desenlace_run_started_at` calza con una corrida del
 * historial que se está mostrando: se enlaza una corrida que existe, no una que se supone.
 */
export function desenlaceCelda(h: IntakeUploadEvent, runs: RunRecord[] | 'error', hrefDeRun?: (r: RunRecord) => string | null, guia?: GuiaResuelta | null, ctx: ContextoEstado = {}): string {
  if (!h.ok) {
    const c = chipDeCarga(h, ctx)
    return `${c.chip}<div class="sub">${c.frase}</div>`
  }
  // #269·V10 · sin estado todavía («Recibido») o con una corrida en curso («Cargando»): la celda ya no
  // queda vacía durante los minutos en que la carga todavía no tiene resultado.
  if (!h.desenlace || (ctx.enCurso && h.desenlaceFinal !== true)) {
    const c = chipDeCarga(h, ctx, guia)
    return `${c.chip}<div class="sub">${c.frase}</div>`
  }
  const estado = chipDeCarga(h, ctx, guia)
  const badge = estado.chip
  const corrida = h.desenlaceRunStartedAt && runs !== 'error' ? runs.find((r) => r.startedAt === h.desenlaceRunStartedAt) : undefined
  const href = corrida ? hrefDeRun?.(corrida) ?? null : null
  const link = href ? `<div><a class="sub" href="${escapeHtml(href)}">Ver corrida</a></div>` : ''
  if (guia) {
    const t = (x: string): string => escapeHtml(redactSecrets(x))
    const estilo = ESTILO_ACTOR[guia.actor]
    const actor = `<div class="sub"${estilo ? ` style="${estilo}"` : ''}><b>${escapeHtml(LINEA_ACTOR[guia.actor])}</b></div>`
    const pasos = `<ol class="sub" style="margin:4px 0 4px 18px;padding:0">${guia.queHacer.map((p) => `<li>${t(p)}</li>`).join('')}</ol>`
    const frase = estado.frase ? `<div class="sub">${estado.frase}</div>` : ''
    return `${badge}${actor}<div><b>${t(guia.titulo)}</b></div><div class="sub">${t(guia.quePaso)}</div>${pasos}${frase}${detalleTecnico(h.desenlaceMotivo, guia.codigo)}${historiaDeIntentos(h, ctx)}${link}`
  }
  const frase = estado.frase ? `<div class="sub">${estado.frase}</div>` : ''
  const crudo = h.desenlaceMotivo ?? ''
  const recortado = crudo.length > MOTIVO_RECORTE ? crudo.slice(0, MOTIVO_RECORTE) + '…' : crudo
  const motivo = recortado ? `<div class="sub">${escapeHtml(redactSecrets(recortado))}</div>` : ''
  const detalle = h.desenlaceMotivo && h.desenlaceMotivo.length > MOTIVO_RECORTE ? detalleTecnico(h.desenlaceMotivo) : ''
  return `${badge}${frase}${motivo}${detalle}${historiaDeIntentos(h, ctx)}${link}`
}

/** «Ver lo que pasó» (#269·§4.2): una línea por intento, sin motivo técnico, plegada. Solo si hay más
 *  de lo que el estado ya dice (dos intentos o más, o un acto sobre un intento). */
export function historiaDeIntentos(h: IntakeUploadEvent, ctx: ContextoEstado = {}): string {
  const intentos = (h.intentos ?? []).filter((i) => i.origen === 'declaracion')
  const acto = h.desenlace === 'retirada' || h.desenlace === 'reemplazada' || h.desenlace === 'deshecha'
  if (intentos.length < 2 && !(acto && intentos.length)) return ''
  const linea = (i: IntakeIntentoRow): string =>
    `<li>${escapeHtml(fechaCorta(i.runStartedAt ?? i.observadoAt))} · ${i.resultado === 'procesada' ? 'se cargó' : `no se cargó${ctx.tituloDeIntento ? `: ${escapeHtml(ctx.tituloDeIntento(i))}` : ''}`}</li>`
  const cierre = h.desenlace === 'retirada' ? `<li>${escapeHtml(fechaCorta(h.actoAt))} · se retiró</li>` : h.desenlace === 'reemplazada' ? `<li>${escapeHtml(fechaCorta(h.actoAt))} · lo reemplazó otra carga</li>` : h.desenlace === 'deshecha' ? `<li>${escapeHtml(fechaCorta(h.actoAt))} · se deshizo</li>` : ''
  return `<details class="guia"><summary class="sub">Ver lo que pasó</summary><ul class="sub" style="margin:4px 0 4px 18px;padding:0">${intentos.map(linea).join('')}${cierre}</ul></details>`
}

/**
 * La guía de UNA carga (#346), o `null` si no corresponde: solo `fallida`/`saltada` (los desenlaces
 * que el job declara por archivo) con un código cuya familia existe, y solo si la instancia cableó el
 * catálogo. `sin-informe` y `varada` no tienen declaración del job: no hay código que resolver.
 */
export function guiaDeCarga(slot: IntakeSlot, h: IntakeUploadEvent, catalogo: readonly GuiaDecl[] | undefined): GuiaResuelta | null {
  if (!catalogo || !h.desenlaceCodigo) return null
  if (h.desenlace !== 'fallida' && h.desenlace !== 'saltada') return null
  return resolverGuia(slot, h.desenlaceCodigo, h.desenlaceParams, catalogo, h.filename)
}

/** URL de la página «Errores frecuentes» de UNA casilla (#346). Misma raíz y mismo gate que Cargas. */
export const erroresHref = (domainId: string, slotId: string): string =>
  `/admin/dominio/${encodeURIComponent(domainId)}/errores/${encodeURIComponent(slotId)}`

/**
 * La SEÑAL DE COBERTURA del operador (#346): de los desenlaces declarados por el job en los últimos
 * 30 días, cuántos llegaron sin código, cuántos con código pero sin guía redactada por la instancia
 * (cayeron a la genérica del Producto) y cuántos con un código de familia desconocida (se mostraron
 * como sin código). Nombra los códigos: así la lista de errores frecuentes se completa con datos.
 * Silenciosa cuando no hay nada que reportar o cuando la instancia no cablea el conteo.
 */
export function coberturaGuias(slot: IntakeSlot, conteos: DesenlaceCodigoConteo[] | undefined, catalogo: readonly GuiaDecl[] | undefined): string {
  if (!conteos || !catalogo) return ''
  let sinCodigo = 0
  const genericos: string[] = []
  const desconocidos: string[] = []
  let nGen = 0
  let nDesc = 0
  for (const c of conteos) {
    if (c.codigo == null) {
      sinCodigo += c.n
      continue
    }
    if (!familiaDe(c.codigo, catalogo)) {
      nDesc += c.n
      desconocidos.push(c.codigo)
      continue
    }
    const g = resolverGuia(slot, c.codigo, undefined, catalogo)
    if (g && !g.deInstancia) {
      nGen += c.n
      genericos.push(c.codigo)
    }
  }
  if (!sinCodigo && !nGen && !nDesc) return ''
  const cods = (xs: string[]): string => xs.map((x) => `<code>${escapeHtml(x)}</code>`).join(', ')
  const partes: string[] = []
  if (sinCodigo) partes.push(`${sinCodigo} sin código (el job no lo declaró)`)
  if (nGen) partes.push(`${nGen} con código sin guía de la instancia — usaron la genérica: ${cods(genericos)}`)
  if (nDesc) partes.push(`${nDesc} con código de familia desconocida — se mostraron sin guía: ${cods(desconocidos)}`)
  return `<p class="sub">📘 Guías de carga · últimos 30 días: ${partes.join(' · ')}.</p>`
}

/** ¿Alguna carga del historial trae desenlace? Decide si la Actividad muestra la columna: sin
 *  desenlaces la tabla es la de siempre, con las mismas columnas y los mismos colspan. */
export function hayDesenlace(history: IntakeUploadEvent[] | 'error', conVigilante = false): boolean {
  if (history === 'error') return false
  // #269·V10 · con el vigilante corriendo, toda carga tiene estado que mostrar —«Recibido» también es
  // un estado—, así que la columna aparece con cualquier carga. SIN vigilante nadie resuelve estados:
  // decir «Recibido · empieza a cargarse en unos minutos» sería una promesa sin nadie detrás, y la
  // página es la de siempre (la columna solo con algún estado ya escrito).
  return conVigilante ? history.length > 0 : history.some((h) => !!h.desenlace)
}

/** Inicio de la última corrida COMPLETADA (frontera del residuo, #57). */
export function lastCompletedStart(runs: RunRecord[] | 'error'): number | null {
  if (runs === 'error') return null
  const done = runs.filter((r) => r.status === 'Completed').map((r) => Date.parse(r.startedAt)).filter((t) => !Number.isNaN(t))
  return done.length ? Math.max(...done) : null
}

/** ¿El archivo es RESIDUO? (anterior a la última corrida completada → la próxima corrida lo re-procesa). */
export function esResiduo(entry: OneLakeEntry, lastCompleted: number | null): boolean {
  if (lastCompleted == null) return false
  const t = Date.parse(entry.lastModified)
  return !Number.isNaN(t) && t < lastCompleted
}

/**
 * El DIAGNÓSTICO de la falla, extraído del log de la conversión.
 *
 * Convención del contrato de ingesta (misma familia que el marcador `[delta] sin cambios en el dato`):
 * ante un aborto, la última línea del log lleva el marcador `✖` (U+2716) tras el prefijo de canal —
 * `✖ ABORTADO: <motivo>` o `✖ ERROR no controlado: <Tipo>: <mensaje>`. Las líneas informativas usan
 * `⚠` o `✔`, nunca `✖`, así que el marcador identifica la causa real sin ambigüedad.
 *
 * Devuelve la última línea marcada, ya sin el prefijo de canal (`[…] `) y truncada, o `null` si el log
 * no trae ninguna. Recorre el log COMPLETO: el recorte a 4.000 chars de la vista es solo de display.
 */
export function diagnosticoDeFalla(log: string | null): string | null {
  if (!log) return null
  let found: string | null = null
  for (const raw of log.split('\n')) {
    const linea = raw.replace(/^\s*(?:\[[^\]]*\]\s*)*/, '').trim()
    if (linea.startsWith('✖')) found = linea
  }
  if (!found) return null
  return found.length > 300 ? found.slice(0, 300) + '…' : found
}

/**
 * Titular de la falla cuando el log quedó añejo (issue #86): el job no alcanzó a escribirlo, así que
 * lo único honesto que puede decirse es que murió antes — no el `✖` de la corrida anterior.
 */
export const LOG_ANEJO_TITULAR = 'El job murió sin alcanzar a escribir su log'

/**
 * Línea de tiempo fusionada: cargas + corridas, más reciente primero.
 *
 * `diagnostico` es el TITULAR de la falla más reciente (la línea `✖` del log, o el aviso de log añejo
 * de #86): lo decide la página, que es la que conoce la frescura del log.
 *
 * `sinCambios` (issue #62) es la señal de «delta neto cero» de la última corrida — misma disciplina
 * que el diagnóstico: el log pertenece a la ÚLTIMA conversión, así que solo `runs[0]` puede llevarla.
 *
 * `runLogHrefOf` (issue #99) da el destino del «Ver log» de CADA corrida (no solo la última). Ausente
 * (o devolviendo null) ⇒ ninguna fila enlaza: la instancia sin logs por corrida no cambia en nada.
 *
 * `conDesenlace` (issue #162) agrega la columna DESENLACE — la decide `hayDesenlace(history)`: con el
 * registro sin resolver todavía, la tabla conserva sus cuatro columnas exactas de siempre.
 */
export function timeline(history: IntakeUploadEvent[] | 'error', runs: RunRecord[] | 'error', limit = 30, diagnostico?: string | null, sinCambios?: boolean, runLogHrefOf?: (r: RunRecord) => string | null, reverts?: IntakeRevertRow[], revertFormOf?: (h: IntakeUploadEvent) => string, conDesenlace = false, guiaDe?: (h: IntakeUploadEvent) => GuiaResuelta | null, ctxDe?: (h: IntakeUploadEvent) => ContextoEstado, tomoDe?: (r: RunRecord) => string): { ts: string; html: string }[] {
  const items: { ts: string; html: string }[] = []
  // La columna extra va ANTES de la de acciones (que cierra la tabla). Vacía en las filas que no son
  // cargas: el desenlace es de la carga — una corrida no tiene uno, y fingirlo sería inventar dato.
  const vacia = conDesenlace ? '<td></td>' : ''
  if (history !== 'error') {
    for (const h of history) {
      // #63 · «Revertir esta carga» vive en la fila de la carga: es su unidad, no el archivo suelto.
      const accion = revertFormOf?.(h) ?? ''
      const desenlace = conDesenlace ? `<td>${desenlaceCelda(h, runs, runLogHrefOf, guiaDe?.(h) ?? null, ctxDe?.(h) ?? {})}</td>` : ''
      items.push({
        ts: h.ts,
        html: `<td>${when(h.ts)}</td><td>📤 Carga</td><td>${escapeHtml(h.filename)} <span class="sub">· ${kb(h.bytes)} · ${escapeHtml(h.by)}</span>${h.dupOf ? `<div class="sub" style="${AVISO}">⚠ contenido idéntico a ${escapeHtml(h.dupOf)} — re-procesarlo no cambia el dato</div>` : ''}</td>${desenlace}<td>${h.ok ? (h.triggered ? '<span class="sub">disparó conversión</span>' : '<span class="sub">recibido (land-only)</span>') : (conDesenlace ? '' : `<b style="color:var(--err)">rechazada</b>${h.error ? `<div class="sub">${escapeHtml(motivoDeRechazo(h.error))}</div>` : ''}`)}${accion ? ` ${accion}` : ''}</td>`,
      })
    }
  }
  // #63 · la reversión es un evento de primera clase del ciclo: se ve donde se vive la carga. (La
  // conversión compensatoria aparece sola como fila ⚙️: es una corrida real del job.)
  for (const r of reverts ?? []) {
    const detalle = r.resumen.map((c) => `<div class="sub">${escapeHtml(textoDeClave(c))}</div>`).join('')
    items.push({
      ts: r.at,
      html: `<td>${when(r.at)}</td><td>↩️ Reversión</td><td>${escapeHtml(r.filename)} revertida <span class="sub">· ${escapeHtml(r.byUser)}</span>${detalle}${r.landingRetirado ? `<div class="sub">${escapeHtml(TEXTO_LANDING)}</div>` : ''}</td>${vacia}<td></td>`,
    })
  }
  if (runs !== 'error') {
    for (const [i, r] of runs.entries()) {
      // El log pertenece a la ÚLTIMA conversión: el diagnóstico solo puede rotularse sobre runs[0].
      const diag = i === 0 && r.status === 'Failed' && diagnostico ? diagnostico : null
      const delta = i === 0 && r.status === 'Completed' && sinCambios ? ' <span class="sub">· sin cambios en el dato</span>' : ''
      // #269·V6 · el estado genérico del MOTOR (`state=[dead]`) va PLEGADO: en un proceso compartido
      // por varios tipos de archivo, esa línea suelta se leía como la falla de ESTE tipo.
      const generico = r.error ? escapeHtml(r.error.length > 240 ? r.error.slice(0, 240) + '…' : r.error) : ''
      const motor = generico ? `<details class="guia"><summary class="sub">Estado del motor</summary><div class="sub">${generico}</div></details>` : ''
      const motivo = diag ? `<div style="color:var(--err)">${escapeHtml(diag)}</div>${motor}` : motor
      const tomo = tomoDe?.(r) ?? ''
      const href = runLogHrefOf?.(r) ?? null
      const verLog = href ? ` <a class="sub" href="${escapeHtml(href)}">Ver log</a>` : ''
      items.push({
        ts: r.startedAt,
        html: `<td>${when(r.startedAt)}</td><td>⚙️ Conversión</td><td>${badge(r.status)}${delta}${dur(r) ? ` <span class="sub">· ${dur(r)}</span>` : ''}${verLog}${tomo}${motivo}</td>${vacia}<td></td>`,
      })
    }
  }
  return items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, limit)
}

// ─── «Revertir esta carga» (issue #63): los textos del plan, sellados ───────
// Una acción destructiva sobre el dato se confirma leyendo lo que va a pasar CLAVE POR CLAVE — incluido
// lo que NO va a pasar y por qué. El mismo texto sirve al plan y al registro en el timeline.
export const TEXTO_LANDING = 'la copia en el landing se retira (no se re-procesará)'

export function textoDeClave(c: ClaveAccion): string {
  switch (c.accion) {
    case 'rematerializar':
      return `la clave «${c.clave}» vuelve a su versión anterior: se re-materializa «${baseName(c.previa)}»`
    case 'vaciar':
      return `la clave «${c.clave}» queda VACÍA — esta carga la introdujo (DELETE sin INSERT; lo ejecuta el convertidor)`
    case 'no-compensable':
      return `la clave «${c.clave}» NO se puede vaciar desde acá: el convertidor de esta instancia no declara soporte de reversión (revert_delete) — la clave no se toca`
    case 'pisada':
      return `sin efecto: la clave «${c.clave}» fue pisada por una carga posterior («${baseName(c.vigente)}», ${when(c.vigenteAt)}) — para deshacerla, deshaz esa carga primero`
    case 'sin-clave':
      return `«${c.revertido}» está archivado sin clave: no se puede derivar compensación — no se toca`
  }
}

/**
 * La página de CONFIRMACIÓN del plan (fase 1 de dos). Es lo que el `confirm()` estático no podía ser:
 * el detalle derivado de qué pasa con cada clave. Sin acciones con efecto no hay form — solo la
 * explicación y la vuelta.
 */
export function revertPlanBody(domainId: string, domainLabel: string, slot: IntakeSlot, plan: RevertPlan, token: string, aviso?: string): string {
  const action = `/admin/dominio/${escapeHtml(domainId)}/cargas`
  // #178 · el «volver» apunta a la casilla desde la que se entró, no al tope de la consola.
  const back = `<p class="sub"><a href="${escapeHtml(cargasHref(domainId, slot.id))}">← ${escapeHtml(domainLabel)} · ${escapeHtml(slot.label)}</a></p>`
  const avisoHtml = aviso ? `<p class="msg err">${escapeHtml(aviso)}</p>` : ''
  const filas = plan.claves.length
    ? plan.claves.map((c) => `<li>${escapeHtml(textoDeClave(c))}</li>`).join('')
    : '<li>esta carga no tiene ninguna copia en el histórico procesado.</li>'
  const landing = plan.landing.length ? `<li>${escapeHtml(TEXTO_LANDING)}</li>` : ''
  const ref: Record<string, string> = plan.uploadId != null ? { upload: String(plan.uploadId) } : { archivo: plan.claves[0]?.revertido ?? '' }
  const form = plan.ejecutable
    ? postForm(action, token, { slot: slot.id, accion: 'revert-exec', hash: plan.hash, ...ref }, 'Deshacer esta carga',
        'Esta acción modifica el dato del warehouse según el plan de arriba. ¿Confirmar?')
    : `<p class="sub">Nada que revertir: ninguna acción de este plan tiene efecto sobre el dato.</p>`
  return `${back}${avisoHtml}<h2>Deshacer «${escapeHtml(plan.filename)}»</h2>
    <p class="sub">Slot <code>${escapeHtml(slot.id)}</code> · contenido <code>${escapeHtml(plan.sha256.slice(0, 12))}…</code>${plan.uploadId != null ? ` · carga #${plan.uploadId}` : ''}</p>
    <p><b>Qué va a pasar:</b></p>
    <ul>${filas}${landing}</ul>
    ${form}`
}

/** Margen hacia atrás para decir «Cargando»: una corrida en curso que arrancó poco antes de la subida
 *  también puede estar tomando el archivo (#269·P27). */
const CORRIDA_EN_CURSO_MS = 30 * 60_000

/** «Vigente: «archivo», recibido el …» (#269·§4.2) para un slot cuyo proceso no archiva. */
function vigenteLinea(landing: OneLakeEntry[] | 'error'): string {
  if (landing === 'error') return ''
  const datos = landing.filter((e) => !e.isDirectory && !isSidecarName(e.path)).sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified))
  const v = datos[0]
  return v ? `<p class="sub">Vigente: «${escapeHtml(baseName(v.path))}», recibido el ${when(v.lastModified)}.</p>` : ''
}

/**
 * La SEÑAL DE CONTRATO del slot (#269·§3.1, V12, §4.1): lo que la plataforma sabe que no calza con el
 * contrato, dicho en la vista técnica — nunca en la del usuario. Cuatro hechos, cada uno de su fuente:
 *  · cargas que salieron del landing sin declaración ni retiro («sin informe», sin corrida);
 *  · cargas declaradas «no cargadas» cuya copia está igual en lo procesado (P30: gana la declaración);
 *  · falta `contacto` y no hay destino `cargas-operador`: el usuario no sabe a quién avisar;
 *  · nombres del registro que calzan con este tipo Y con otro (medido tras la última recarga).
 */
export function señalDeContrato(slot: IntakeSlot, sc: Pick<SlotCargas, 'history' | 'archived' | 'vigilancia'>, enLanding: Set<string> | null, hayDestinoOperador: boolean): string {
  const partes: string[] = []
  const hist = sc.history === 'error' ? [] : sc.history
  const fuera = hist.filter((h) => h.ok && h.desenlace === 'sin-informe' && h.desenlaceFinal === false && !h.desenlaceRunStartedAt)
  if (fuera.length)
    partes.push(`${fuera.length === 1 ? 'Una carga salió' : `${fuera.length} cargas salieron`} del landing sin que el proceso las declarara ni pasaran por <code>_retirado/</code> (salió fuera de contrato): ${fuera.map((h) => `<b>${escapeHtml(h.filename)}</b>`).join(', ')}.`)
  if (sc.archived !== 'error' && enLanding) {
    const archivados = sc.archived.filter((e) => !e.isDirectory && !isSidecarName(e.path))
    const contra = hist.filter((h) => h.ok && (h.desenlace === 'saltada' || h.desenlace === 'fallida') && !enLanding.has(h.filename) &&
      archivados.some((e) => nombreSinSello(baseName(e.path)) === h.filename && Date.parse(e.lastModified) >= Date.parse(h.ts) - 5_000))
    if (contra.length)
      partes.push(`El proceso archivó ${contra.length === 1 ? 'un archivo que declaró' : `${contra.length} archivos que declaró`} no cargado${contra.length === 1 ? '' : 's'}: ${contra.map((h) => `<b>${escapeHtml(h.filename)}</b>`).join(', ')}. Manda lo declarado; revisar el proceso.`)
  }
  if (!slot.contacto && !hayDestinoOperador)
    partes.push('Falta declarar <code>contacto</code>: los usuarios no saben a quién avisar cuando la plataforma no sabe qué pasó con su archivo.')
  const pisan = sc.vigilancia?.pisan ?? []
  if (pisan.length)
    partes.push(`Los patrones de estas casillas se pisan: ${pisan.map(([a, b]) => `<code>${escapeHtml(a)}</code> / <code>${escapeHtml(b)}</code>`).join('; ')}. La subida con casilla acepta igual (el usuario eligió y el patrón de su casilla calza); lo que se pierde es poder enrutar por nombre.`)
  const amb = sc.vigilancia?.ambiguos ?? []
  if (amb.length)
    partes.push(`${amb.length === 1 ? 'Un nombre' : `${amb.length} nombres`} del registro calza${amb.length === 1 ? '' : 'n'} con este tipo y con otro: ${amb.slice(0, 5).map((a) => `«${escapeHtml(a.nombre)}» (${a.slots.map((x) => `<code>${escapeHtml(x)}</code>`).join(', ')})`).join('; ')}${amb.length > 5 ? '; …' : ''}. Se aceptan en la casilla elegida; revisar los patrones.`)
  if (!partes.length) return ''
  // Aviso, no error: nada de esto rompe la página ni la carga — es lo que el operador tiene que corregir.
  return `<div class="sub" style="${AVISO}"><b>⚠ Señal de contrato</b><ul style="margin:4px 0 0 18px;padding:0">${partes.map((p) => `<li>${p}</li>`).join('')}</ul></div>`
}

const csrf = (token: string): string => `<input type="hidden" name="_csrf" value="${token}">`
const postForm = (action: string, token: string, fields: Record<string, string>, label: string, confirmMsg?: string): string =>
  `<form method="post" action="${escapeHtml(action)}" style="display:inline"${confirmMsg ? ` onsubmit="return confirm('${escapeHtml(confirmMsg)}')"` : ''}>${csrf(token)}${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('')}<button class="add">${escapeHtml(label)}</button></form>`

/** URL de UNA casilla (issue #178): el ancla enlazable que antes no existía. */
export const cargasHref = (domainId: string, slotId: string): string =>
  `/admin/dominio/${encodeURIComponent(domainId)}/cargas?slot=${encodeURIComponent(slotId)}`

/**
 * El aviso que nombra la casilla correcta (issue #178·§3).
 *
 * Se dibuja donde el usuario aterriza tras el rechazo, y solo con candidatos ya filtrados por
 * `slotsQueAceptan` — es decir, slots cuyo `accept` DECLARADO matchea el nombre real del archivo.
 * Sin candidatos devuelve vacío: el mensaje de error queda como está y no se inventa un destino.
 *
 * Los ids de los candidatos viajan en la URL del redirect; el label y el href los resuelve la página
 * contra su propia declaración de slots. Por eso el mensaje de error nunca transporta HTML.
 */
export function destinoAviso(domainId: string, candidatos: IntakeSlot[]): string {
  if (!candidatos.length) return ''
  const links = candidatos.map((s) => `<a href="${escapeHtml(cargasHref(domainId, s.id))}"><b>${escapeHtml(s.label)}</b></a>`)
  return candidatos.length === 1
    ? `<div>Este archivo va en ${links[0]}.</div>`
    : `<div>Este archivo va en una de estas casillas: ${links.join(' · ')}.</div>`
}

/**
 * La BARRA DE PESTAÑAS de las casillas del dominio (issue #178·§1).
 *
 * Es el inventario visible: con más de una casilla, «no existe la otra casilla» deja de ser una
 * lectura posible de la página. Con una sola no se dibuja — el dominio de una casilla se ve como
 * siempre. El orden es el de declaración en `slots.yaml`: la página no reordena nada.
 */
export function pestañasCasillas(domainId: string, slots: IntakeSlot[], activoId: string): string {
  if (slots.length < 2) return ''
  const items = slots.map((s) => s.id === activoId
    ? `<b class="on" title="${escapeHtml(s.id)}">${escapeHtml(s.label)}</b>`
    : `<a href="${escapeHtml(cargasHref(domainId, s.id))}" title="${escapeHtml(s.id)}">${escapeHtml(s.label)}</a>`)
  return `<nav class="tabs" aria-label="Casillas de carga">${items.join('')}</nav>`
}

/**
 * El cuerpo HTML de la consola (se envuelve con adminPage en admin.ts).
 *
 * `slots` es el inventario COMPLETO del dominio (la barra de pestañas) y `activo` la única casilla
 * cuyo bloque se dibuja (#178): el historial sigue pegado a su slot, pero el de una casilla ya no
 * entierra a las otras varias pantallas más abajo. Por eso los datos caros —Actividad, Landing,
 * Procesados, vigilancia— se fetchean solo para la casilla activa.
 */
export function cargasBody(domainId: string, domainLabel: string, slots: IntakeSlot[], activo: SlotCargas | null, token: string, uploadFormOf: (slot: IntakeSlot) => string, runLogHrefOf?: (slot: IntakeSlot, r: RunRecord) => string | null): string {
  const back = `<p class="sub"><a href="/admin/dominio/${escapeHtml(domainId)}">← ${escapeHtml(domainLabel)}</a></p>`
  if (!slots.length || !activo) {
    return `${back}<p class="sub">Este dominio no tiene slots de ingesta declarados (instancia: <code>intake/slots.yaml</code>).</p>`
  }
  const action = `/admin/dominio/${escapeHtml(domainId)}/cargas`
  // #63 · el botón por CARGA. Solo con id + sha + carga aceptada: sin identidad verificable no se
  // ofrece revertir (fail-closed) — para esas queda el camino por archivo desde Procesados.
  const revertFormOf = (s: IntakeSlot) => (h: IntakeUploadEvent): string =>
    h.id != null && h.sha256 && h.ok ? postForm(action, token, { slot: s.id, accion: 'revert-plan', upload: String(h.id) }, 'Deshacer esta carga') : ''
  const seccion = ((sc: SlotCargas): string => {
    const s = sc.slot
    const lastDone = lastCompletedStart(sc.runs)
    const last = sc.runs !== 'error' && sc.runs.length ? sc.runs[0] : null

    // #161 · lo que dice el vigilante de este slot: primero la calidad de la medida (¿se puede creer
    // lo que sigue?), después los incumplimientos de contrato, después lo declarativo (#56).
    const vig = sc.vigilancia
    const varadosPorNombre = new Map((vig?.varados ?? []).map((v) => [v.file, v]))
    const varadoDe = (name: string): ArchivoVarado | undefined => varadosPorNombre.get(name)
    const medidaVieja = vig?.medida === 'ultima-conocida'
    const vigilante = vigilanciaBanner(vig)
    const avisoLogs = avisoContratoLogs(s, vig)

    // #56 · coherencia declarativa: trigger sin proceso registrado = sin observabilidad de entidad.
    const coherencia = s.trigger && !sc.procesoRegistrado
      ? `<p class="msg err">⚠ El trigger de este slot (<code>${escapeHtml(s.trigger.processRef)}</code>) no está registrado como proceso en <a href="/admin/sources">Fuentes</a> → la entidad no aparece en Frescura ni la vigila el monitor. Registrarlo en <code>sources.yaml</code>.</p>`
      : ''

    const logText = sc.log?.text ?? null

    // El archivo de log NO se tocó en esta corrida (su mtime es anterior al inicio) ⇒ lo que se lee es
    // de la corrida ANTERIOR y nada suyo describe a esta. Sin mtime (`undefined` o no parseable) la
    // comparación es falsa y no se afirma añejez (fail-safe).
    const logDeOtraCorrida = !!last && !!sc.log?.lastModified && Date.parse(sc.log.lastModified) < Date.parse(last.startedAt)

    // #62 (capa «delta neto cero»): el pipeline emite `[delta] sin cambios en el dato` en su log
    // cuando la corrida dejó el dato idéntico (convención del contrato de ingesta) → badge honesto.
    // El marcador de un log añejo pertenece a otra corrida: atribuírselo a esta sería mentir.
    const sinCambios = last?.status === 'Completed' && !logDeOtraCorrida && !!logText && logText.includes('[delta] sin cambios en el dato')

    // #86 · degradación honesta: el job falló sin alcanzar a escribir su log ⇒ su `✖` no describe esta
    // falla y no se titula con él.
    const logAñejo = last?.status === 'Failed' && logDeOtraCorrida

    // #85 · el MOTIVO real manda: con la corrida fallida, la línea `✖` del log es el titular y el
    // estado genérico del job (`state=[dead]`) degrada a detalle. El gate por `Failed` es duro: el log
    // puede conservar una línea `✖` de una corrida anterior a una que sí completó.
    const diag = last?.status === 'Failed' && !logAñejo ? diagnosticoDeFalla(logText) : null
    const titular = logAñejo ? LOG_ANEJO_TITULAR : diag
    const motivoLast = titular
      ? `<div style="color:var(--err)">${escapeHtml(titular)}</div>${last?.error ? `<div class="sub">${escapeHtml(last.error.slice(0, 300))}</div>` : ''}`
      : last?.error ? `<div class="sub" style="color:var(--err)">${escapeHtml(last.error.slice(0, 300))}</div>` : ''
    // #99 · el log de ESTA corrida (éxito o falla), a un clic de donde se ve su estado.
    const hrefDeRun = runLogHrefOf ? (r: RunRecord): string | null => runLogHrefOf(s, r) : undefined
    const verLogLast = last && hrefDeRun?.(last) ? ` <a class="sub" href="${escapeHtml(hrefDeRun(last)!)}">Ver log</a>` : ''
    const estado = last
      ? `${badge(last.status)}${sinCambios ? ' <span class="sub">· sin cambios en el dato</span>' : ''} ${when(last.startedAt)}${dur(last) ? ` <span class="sub">· ${dur(last)}</span>` : ''}${verLogLast}${motivoLast}`
      : sc.runs === 'error'
        ? '<span class="sub">motor no respondió</span>'
        // #269·V5 · «sin corridas» con cargas procesadas se leía como «nunca corrió»: el motor poda.
        : s.trigger ? '<span class="sub">sin corridas: el motor no conserva corridas de este proceso con más de unas semanas</span>' : '<span class="sub">sin corridas</span>'

    // ── #269 · lo que la columna Estado necesita saber de cada carga, y lo que dice la señal de contrato ──
    const enLanding = sc.landing !== 'error' ? new Set(sc.landing.filter((e) => !e.isDirectory && !isSidecarName(e.path)).map((e) => baseName(e.path))) : null
    const enCurso = sc.runs !== 'error' ? sc.runs.filter((r) => r.status === 'InProgress' || r.status === 'NotStarted') : []
    const aviso = lineaDeAviso({ ...(sc.hayDestinoOperador ? { equipoAvisado: true } : {}), ...(s.contacto ? { contacto: s.contacto } : {}) })
    const tituloDeIntento = (i: IntakeIntentoRow): string => {
      const g = i.codigo && sc.guias ? resolverGuia(s, i.codigo, i.params, sc.guias) : null
      if (g) return g.titulo
      if (i.motivo) return i.motivo.length > 120 ? i.motivo.slice(0, 120) + '…' : i.motivo
      return 'sin motivo declarado'
    }
    const ctxDe = (h: IntakeUploadEvent): ContextoEstado => {
      const c: ContextoEstado = { aviso, tituloDeIntento }
      if (enLanding) c.enLanding = enLanding.has(h.filename)
      const subida = Date.parse(h.ts)
      // Una corrida en curso que arrancó con el archivo ya subido, o que ya corría cuando se subió
      // (#269·P27: la 190 la tomó una corrida que arrancó 15 s antes).
      // i3 (juez P1) · el mismo criterio que el resolvedor: una no terminada más vieja que el umbral de
      // corrida colgada no está tomando nada.
      const ahora = Date.now()
      if (enCurso.some((r) => Date.parse(r.startedAt) >= subida - CORRIDA_EN_CURSO_MS && ahora - Date.parse(r.startedAt) <= DEFAULT_MAX_RUN_MINUTES * 60_000)) c.enCurso = true
      return c
    }
    const intentosPorCorrida = new Map<string, { procesada: number; saltada: number; fallida: number }>()
    for (const i of sc.intentosDeCorridas ?? []) {
      if (!i.runStartedAt) continue
      const x = intentosPorCorrida.get(i.runStartedAt) ?? { procesada: 0, saltada: 0, fallida: 0 }
      if (i.resultado === 'procesada' || i.resultado === 'saltada' || i.resultado === 'fallida') x[i.resultado]++
      intentosPorCorrida.set(i.runStartedAt, x)
    }
    const tomoDe = sc.intentosDeCorridas ? (r: RunRecord): string => {
      const x = intentosPorCorrida.get(r.startedAt)
      if (!x) return ''
      const n = x.procesada + x.saltada + x.fallida
      const partes = [x.procesada ? `✔ ${x.procesada}` : '', x.saltada ? `⚠ ${x.saltada}` : '', x.fallida ? `✖ ${x.fallida}` : ''].filter(Boolean)
      return `<div class="sub">tomó ${n} archivo${n === 1 ? '' : 's'} de este tipo: ${partes.join(' · ')}</div>`
    } : undefined
    // Sin vigilante no hay estados que contrastar con el contrato: la página es la de siempre.
    const señal = sc.vigilancia ? señalDeContrato(s, sc, enLanding, sc.hayDestinoOperador === true) : ''
    const vigente = slotProcessedDir(s) == null

    const rerun = s.trigger ? postForm(action, token, { slot: s.id, accion: 'rerun' }, 'Correr conversión de nuevo', 'La conversión re-procesará TODOS los archivos del landing. ¿Continuar?') : ''

    const logHtml = logText?.trim()
      ? `<details class="guia"><summary class="sub">${logAñejo ? 'Log de una corrida anterior' : 'Log de la última conversión'}</summary><pre class="sub" style="white-space:pre-wrap;overflow-x:auto;max-height:260px;overflow-y:auto">${escapeHtml((logText.length > 4000 ? '…' + logText.slice(-4000) : logText).trim())}</pre></details>`
      : ''

    // Los sidecars `<archivo>.meta.json` (issue #76) son metadata, no archivos de datos: no se listan.
    const landingRows = sc.landing === 'error'
      ? `<tr><td colspan="4" class="sub">No se pudo listar el landing (vuelve a cargar la página).</td></tr>`
      : sc.landing.filter((e) => !e.isDirectory && !isSidecarName(e.path)).map((e) => {
          // #269·V6 · un slot cuyo proceso NO archiva (`processed: false`) deja su archivo en el landing
          // a propósito: es el VIGENTE, no un residuo ni un varado.
          const residuo = !vigente && esResiduo(e, lastDone)
          // #161 · VARADO: nadie lo ha tomado a tiempo. Hermano del RESIDUO y distinto de él —
          // residuo es «anterior a la última corrida completada», varado es «excedió su edad
          // máxima» —, así que se marca aparte y en el amarillo de los avisos, no en el rojo del
          // residuo. La edad viene de la clasificación (`ArchivoVarado.ageMinutes`): acá no se
          // computa ninguna, y por eso la marca es fiel a lo que el vigilante midió aunque su
          // última medida no sea de este instante (lo dice su banner).
          const varado = vigente ? undefined : varadoDe(baseName(e.path))
          const marcaVarado = varado
            ? ` <b style="${AVISO}">⚠ VARADO</b><div class="sub" style="${AVISO}">hace ${edad(varado.ageMinutes)} en el landing sin que ninguna corrida lo tomara${medidaVieja ? ' (según la última medida buena del vigilante)' : ''}</div>`
            : ''
          return `<tr${residuo ? ' style="color:var(--err)"' : ''}><td>${escapeHtml(baseName(e.path))}</td><td>${kb(e.size)}</td><td>${when(e.lastModified)}${residuo ? ' <b>⚠ residuo</b><div class="sub">anterior a la última conversión: se RE-PROCESARÁ en la próxima corrida</div>' : ''}${marcaVarado}</td><td>${postForm(action, token, { slot: s.id, accion: 'retire', archivo: baseName(e.path) }, 'Retirar', `Retirar «${baseName(e.path)}» del landing (va a _retirado/, reversible). ¿Continuar?`)}</td></tr>`
        }).join('') || `<tr><td colspan="4" class="sub">Landing vacío — nada pendiente de procesar.</td></tr>`

    const archivedRows = sc.archived === 'error'
      ? `<tr><td colspan="4" class="sub">No se pudo listar el archivo de procesados.</td></tr>`
      : sc.archived.filter((e) => !e.isDirectory && !isSidecarName(e.path)).slice(0, 60).map((e) =>
          `<tr><td>${escapeHtml(e.path.replace(/^.*_processed\//, ''))}</td><td>${kb(e.size)}</td><td>${when(e.lastModified)}</td><td>${postForm(action, token, { slot: s.id, accion: 'restore', archivo: e.path }, 'Reactivar', `Copiar «${baseName(e.path)}» de vuelta al landing para re-procesarlo. ¿Continuar?`)} ${postForm(action, token, { slot: s.id, accion: 'revert-plan', archivo: e.path }, 'Deshacer')}</td></tr>`,
        ).join('') || `<tr><td colspan="4" class="sub">Sin procesados archivados todavía.</td></tr>`

    // #162 · la columna DESENLACE aparece cuando hay alguno resuelto (sin ellos: tabla intacta).
    const conDesenlace = hayDesenlace(sc.history, sc.vigilancia !== undefined)
    const thDesenlace = conDesenlace ? '<th>Desenlace</th>' : ''
    const colsActividad = conDesenlace ? 5 : 4

    // #346 · con catálogo de guías cableado: enlace a «Errores frecuentes» y señal de cobertura.
    const errores = sc.guias ? ` <a class="sub" href="${escapeHtml(erroresHref(domainId, s.id))}">Errores frecuentes</a>` : ''
    const cobertura = coberturaGuias(s, sc.codigos30, sc.guias)

    return `<h2>${escapeHtml(s.label)} <span class="sub c">${escapeHtml(s.id)}</span>${errores}</h2>
    ${vigilante}${avisoLogs}${coherencia}${cobertura}${señal}
    <p><b>Última conversión:</b> ${estado} ${rerun ? `<span style="margin-left:12px">${rerun}</span>` : ''}</p>
    ${logHtml}
    ${uploadFormOf(s)}
    <h3 class="sub">Actividad</h3>
    <table><thead><tr><th>Cuándo</th><th>Evento</th><th>Detalle</th>${thDesenlace}<th></th></tr></thead>
    <tbody>${timeline(sc.history, sc.runs, 30, titular, sinCambios, hrefDeRun, sc.reverts, revertFormOf(s), conDesenlace, sc.guias ? (h) => guiaDeCarga(s, h, sc.guias) : undefined, ctxDe, tomoDe).map((i) => `<tr>${i.html}</tr>`).join('') || `<tr><td colspan="${colsActividad}" class="sub">Sin actividad registrada.</td></tr>`}</tbody></table>
    <h3 class="sub">${vigente ? 'Vigente (el proceso lo lee del landing: no archiva)' : 'Landing (por procesar)'}</h3>
    ${vigente ? vigenteLinea(sc.landing) : ''}
    <table><thead><tr><th>Archivo</th><th>Tamaño</th><th>Recibido</th><th></th></tr></thead><tbody>${landingRows}</tbody></table>
    ${vigente ? '' : `<h3 class="sub">Procesados (archivo histórico)</h3>
    <table><thead><tr><th>Archivo</th><th>Tamaño</th><th>Procesado</th><th></th></tr></thead><tbody>${archivedRows}</tbody></table>`}`
  })(activo)

  const guia = `<details class="guia"><summary>¿Cómo funciona el ciclo de una carga?</summary>
    <p class="sub">Cuando alguien sube un archivo, queda en el landing y se dispara la conversión. Cada corrida declara en su log qué hizo con cada archivo: lo cargó, lo dejó en espera o lo rechazó. Lo cargado se archiva en «Procesados». Lo rechazado o en espera sigue en el landing y se reintenta en cada corrida del mismo proceso. <b>Retirar</b> saca un archivo del landing a <code>_retirado/</code> sin tocar datos; es el único camino que la plataforma reconoce para sacar un archivo sin cargarlo. <b>Reactivar</b> devuelve al landing una copia archivada. <b>Deshacer esta carga</b> revierte, clave por clave, lo que una carga dejó en el warehouse, y antes muestra el plan. Un archivo marcado ⚠ residuo es anterior a la última corrida completada y se volverá a procesar: retíralo si no corresponde.</p>
  </details>
`
  const pestañas = pestañasCasillas(domainId, slots, activo.slot.id)
  const enlace = slots.length > 1
    ? `<p class="sub">Cada casilla tiene su propia dirección: la de esta es <code>${escapeHtml(cargasHref(domainId, activo.slot.id))}</code> — se puede enlazar a quien deba usarla.</p>`
    : ''
  return `${back}<p class="sub">Operación de cargas del dominio: historial, estado y log de cada conversión, y el ciclo completo del landing (retirar / reactivar / re-correr).</p>${guia}${pestañas}${enlace}${seccion}`
}

/**
 * La página «ERRORES FRECUENTES» de UNA casilla (#346): las guías que aplican al slot, ordenadas por
 * cuántas veces apareció su código en el registro en los últimos 90 días, cada una con su actor,
 * título, qué pasó y qué hacer. Se puede consultar ANTES de que algo falle.
 *
 * Qué se lista: las guías de la instancia que aplican al slot (aunque su código no haya ocurrido) y
 * las guías —de la instancia o genéricas del Producto— de todo código que SÍ ocurrió. Las genéricas del
 * Producto que nunca ocurrieron en el slot no se listan: trece guías abstractas no ayudan a nadie.
 * Varios códigos que caen en la misma guía suman su frecuencia (`GuiaResuelta.clave`).
 *
 * `conteos` ausente o `'error'`: sin orden por frecuencia (se dice), la lista va en orden declarado.
 */
export function erroresFrecuentesBody(domainId: string, domainLabel: string, slot: IntakeSlot, catalogo: readonly GuiaDecl[], conteos: DesenlaceCodigoConteo[] | 'error' | undefined): string {
  const back = `<p class="sub"><a href="${escapeHtml(cargasHref(domainId, slot.id))}">← ${escapeHtml(domainLabel)} · ${escapeHtml(slot.label)}</a></p>`
  const porClave = new Map<string, { guia: GuiaResuelta; n: number; orden: number; codigos: string[] }>()
  let orden = 0
  const sumar = (codigo: string, n: number): void => {
    const g = resolverGuia(slot, codigo, undefined, catalogo, undefined, '…')
    if (!g) return
    const prev = porClave.get(g.clave)
    if (prev) {
      prev.n += n
      if (!prev.codigos.includes(codigo)) prev.codigos.push(codigo)
    } else porClave.set(g.clave, { guia: g, n, orden: orden++, codigos: [codigo] })
  }
  for (const c of guiasDelSlot(slot, catalogo)) sumar(c, 0)
  if (conteos && conteos !== 'error') for (const c of conteos) if (c.codigo) sumar(c.codigo, c.n)
  const items = [...porClave.values()].sort((a, b) => b.n - a.n || a.orden - b.orden)
  const nota = conteos === undefined || conteos === 'error'
    ? '<p class="sub">No se pudo contar cuántas veces ocurrió cada error: la lista va en el orden en que la instancia declaró sus guías.</p>'
    : '<p class="sub">Ordenadas por cuántas veces ocurrieron en esta casilla en los últimos 90 días.</p>'
  const t = (x: string): string => escapeHtml(x)
  const cuerpo = items.length
    ? items.map(({ guia, n }) => {
        const estilo = ESTILO_ACTOR[guia.actor]
        const veces = conteos && conteos !== 'error' ? `<span class="sub"> · ${n === 0 ? 'no ha ocurrido en 90 días' : n === 1 ? 'ocurrió 1 vez en 90 días' : `ocurrió ${n} veces en 90 días`}</span>` : ''
        return `<li style="margin-bottom:12px"><div><b>${t(guia.titulo)}</b>${veces}</div><div class="sub"${estilo ? ` style="${estilo}"` : ''}>${escapeHtml(LINEA_ACTOR[guia.actor])}</div><div class="sub">${t(guia.quePaso)}</div><ol class="sub" style="margin:4px 0 4px 18px;padding:0">${guia.queHacer.map((p) => `<li>${t(p)}</li>`).join('')}</ol></li>`
      }).join('')
    : ''
  const lista = items.length
    ? `<ul style="list-style:none;padding:0">${cuerpo}</ul>`
    : '<p class="sub">Esta casilla todavía no tiene guías: ni la instancia declaró guías para ella ni ha ocurrido un error con código.</p>'
  return `${back}<h2>Errores frecuentes · ${escapeHtml(slot.label)}</h2>
    <p class="sub">Qué significa cada rechazo de esta carga y qué hacer. Si tu archivo no entra, el detalle de ese caso aparece en <a href="${escapeHtml(cargasHref(domainId, slot.id))}">Cargas</a>, en la columna Desenlace.</p>
    ${nota}${lista}`
}
