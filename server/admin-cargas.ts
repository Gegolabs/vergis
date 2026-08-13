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
import { escapeHtml, slotLogPath, slotRunLogsDir, isSidecarName, redactSecrets, type IntakeSlot, type RunRecord, type RunStatus, type OneLakeEntry, type ClaveAccion, type IntakeRevertRow, type RevertPlan, type RevertResult, type MedidaCalidad, type ArchivoVarado, type CargaDesenlace } from '@vergis/capabilities'

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
/** Amarillo del aviso que no es error: el mismo de la marca de contenido duplicado del timeline. */
const AVISO = 'color:var(--yellow,#d97706)'

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
  const n = v?.corridasSinLog ?? 0
  if (n < CORRIDAS_SIN_LOG_AVISO) return ''
  const dir = slotRunLogsDir(slot)
  return `<p class="msg err">⚠ Este slot no cumple el contrato <code>_logs/</code>: las últimas ${n} corridas terminadas no dejaron log correlacionable${dir ? ` en <code>${escapeHtml(dir)}</code>` : ''}. Sin log por corrida no hay causa por archivo: el desenlace de cada carga queda en «sin informe» y el usuario que subió no recibe motivo. Corregir el job para que escriba su log al terminar (<code>docs/contrato-ingesta-logs.md</code>).</p>`
}

/** Badge por desenlace (#162·§3.4). Familia visual de `badge(RunStatus)`: verde listo, rojo falla,
 *  amarillo lo que quedó a medias. */
const DESENLACE_BADGE: Record<CargaDesenlace, string> = {
  procesada: '<b style="color:var(--accent)">✓ Procesada</b>',
  saltada: `<b style="${AVISO}">⚠ Saltada</b>`,
  fallida: '<b style="color:var(--err)">✕ Falló</b>',
  'sin-informe': '<b style="color:var(--err)">✕ Sin informe</b>',
  varada: `<b style="${AVISO}">⚠ Varada</b>`,
}

/** Texto propio de la plataforma cuando NO hay motivo del job: describe el estado, jamás la causa. */
const SIN_INFORME_TEXTO = 'el proceso terminó sin reportar la causa'

/**
 * La celda DESENLACE de una carga (#162·§6.2).
 *
 * El motivo lo escribe un job de terreno: es texto no confiable que termina en HTML. Va escapado
 * (`escapeHtml`) y redactado (`redactSecrets`) — un log puede traer una cadena de conexión, y el
 * operador no tiene por qué recibirla en pantalla para leer «ancho inesperado: 28 columnas».
 *
 * El enlace a la corrida solo aparece si el `desenlace_run_started_at` calza con una corrida del
 * historial que se está mostrando: se enlaza una corrida que existe, no una que se supone.
 */
export function desenlaceCelda(h: IntakeUploadEvent, runs: RunRecord[] | 'error', hrefDeRun?: (r: RunRecord) => string | null): string {
  if (!h.desenlace) return ''
  const badge = DESENLACE_BADGE[h.desenlace] ?? escapeHtml(String(h.desenlace))
  const crudo = h.desenlaceMotivo ?? (h.desenlace === 'sin-informe' ? SIN_INFORME_TEXTO : '')
  const recortado = crudo.length > 300 ? crudo.slice(0, 300) + '…' : crudo
  const motivo = recortado ? `<div class="sub">${escapeHtml(redactSecrets(recortado))}</div>` : ''
  const corrida = h.desenlaceRunStartedAt && runs !== 'error' ? runs.find((r) => r.startedAt === h.desenlaceRunStartedAt) : undefined
  const href = corrida ? hrefDeRun?.(corrida) ?? null : null
  const link = href ? `<div><a class="sub" href="${escapeHtml(href)}">Ver corrida</a></div>` : ''
  return `${badge}${motivo}${link}`
}

/** ¿Alguna carga del historial trae desenlace? Decide si la Actividad muestra la columna: sin
 *  desenlaces la tabla es la de siempre, con las mismas columnas y los mismos colspan. */
export function hayDesenlace(history: IntakeUploadEvent[] | 'error'): boolean {
  return history !== 'error' && history.some((h) => !!h.desenlace)
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
export function timeline(history: IntakeUploadEvent[] | 'error', runs: RunRecord[] | 'error', limit = 30, diagnostico?: string | null, sinCambios?: boolean, runLogHrefOf?: (r: RunRecord) => string | null, reverts?: IntakeRevertRow[], revertFormOf?: (h: IntakeUploadEvent) => string, conDesenlace = false): { ts: string; html: string }[] {
  const items: { ts: string; html: string }[] = []
  // La columna extra va ANTES de la de acciones (que cierra la tabla). Vacía en las filas que no son
  // cargas: el desenlace es de la carga — una corrida no tiene uno, y fingirlo sería inventar dato.
  const vacia = conDesenlace ? '<td></td>' : ''
  if (history !== 'error') {
    for (const h of history) {
      // #63 · «Revertir esta carga» vive en la fila de la carga: es su unidad, no el archivo suelto.
      const accion = revertFormOf?.(h) ?? ''
      const desenlace = conDesenlace ? `<td>${desenlaceCelda(h, runs, runLogHrefOf)}</td>` : ''
      items.push({
        ts: h.ts,
        html: `<td>${when(h.ts)}</td><td>📤 Carga</td><td>${escapeHtml(h.filename)} <span class="sub">· ${kb(h.bytes)} · ${escapeHtml(h.by)}</span>${h.dupOf ? `<div class="sub" style="color:var(--yellow,#d97706)">⚠ contenido idéntico a ${escapeHtml(h.dupOf)} — re-procesarlo no cambia el dato</div>` : ''}</td>${desenlace}<td>${h.ok ? (h.triggered ? '<span class="sub">disparó conversión</span>' : '<span class="sub">recibido (land-only)</span>') : '<b style="color:var(--err)">rechazada</b>'}${accion ? ` ${accion}` : ''}</td>`,
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
      const generico = r.error ? escapeHtml(r.error.length > 240 ? r.error.slice(0, 240) + '…' : r.error) : ''
      const motivo = diag
        ? `<div style="color:var(--err)">${escapeHtml(diag)}</div>${generico ? `<div class="sub">${generico}</div>` : ''}`
        : generico ? `<div class="sub" style="color:var(--err)">${generico}</div>` : ''
      const href = runLogHrefOf?.(r) ?? null
      const verLog = href ? ` <a class="sub" href="${escapeHtml(href)}">Ver log</a>` : ''
      items.push({
        ts: r.startedAt,
        html: `<td>${when(r.startedAt)}</td><td>⚙️ Conversión</td><td>${badge(r.status)}${delta}${dur(r) ? ` <span class="sub">· ${dur(r)}</span>` : ''}${verLog}${motivo}</td>${vacia}<td></td>`,
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
      return `sin efecto: la clave «${c.clave}» fue pisada por una carga posterior («${baseName(c.vigente)}», ${when(c.vigenteAt)}) — para deshacerla, revertí esa carga primero`
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
  const back = `<p class="sub"><a href="${action}">← ${escapeHtml(domainLabel)} · Cargas</a></p>`
  const avisoHtml = aviso ? `<p class="msg err">${escapeHtml(aviso)}</p>` : ''
  const filas = plan.claves.length
    ? plan.claves.map((c) => `<li>${escapeHtml(textoDeClave(c))}</li>`).join('')
    : '<li>esta carga no tiene ninguna copia en el histórico procesado.</li>'
  const landing = plan.landing.length ? `<li>${escapeHtml(TEXTO_LANDING)}</li>` : ''
  const ref: Record<string, string> = plan.uploadId != null ? { upload: String(plan.uploadId) } : { archivo: plan.claves[0]?.revertido ?? '' }
  const form = plan.ejecutable
    ? postForm(action, token, { slot: slot.id, accion: 'revert-exec', hash: plan.hash, ...ref }, 'Revertir esta carga',
        'Esta acción modifica el dato del warehouse según el plan de arriba. ¿Confirmar?')
    : `<p class="sub">Nada que revertir: ninguna acción de este plan tiene efecto sobre el dato.</p>`
  return `${back}${avisoHtml}<h2>Revertir «${escapeHtml(plan.filename)}»</h2>
    <p class="sub">Slot <code>${escapeHtml(slot.id)}</code> · contenido <code>${escapeHtml(plan.sha256.slice(0, 12))}…</code>${plan.uploadId != null ? ` · carga #${plan.uploadId}` : ''}</p>
    <p><b>Qué va a pasar:</b></p>
    <ul>${filas}${landing}</ul>
    ${form}`
}

const csrf = (token: string): string => `<input type="hidden" name="_csrf" value="${token}">`
const postForm = (action: string, token: string, fields: Record<string, string>, label: string, confirmMsg?: string): string =>
  `<form method="post" action="${escapeHtml(action)}" style="display:inline"${confirmMsg ? ` onsubmit="return confirm('${escapeHtml(confirmMsg)}')"` : ''}>${csrf(token)}${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('')}<button class="add">${escapeHtml(label)}</button></form>`

/** El cuerpo HTML de la consola (se envuelve con adminPage en admin.ts). */
export function cargasBody(domainId: string, domainLabel: string, slots: SlotCargas[], token: string, uploadFormOf: (slot: IntakeSlot) => string, runLogHrefOf?: (slot: IntakeSlot, r: RunRecord) => string | null): string {
  const back = `<p class="sub"><a href="/admin/dominio/${escapeHtml(domainId)}">← ${escapeHtml(domainLabel)}</a></p>`
  if (!slots.length) {
    return `${back}<p class="sub">Este dominio no tiene slots de ingesta declarados (instancia: <code>intake/slots.yaml</code>).</p>`
  }
  const action = `/admin/dominio/${escapeHtml(domainId)}/cargas`
  // #63 · el botón por CARGA. Solo con id + sha + carga aceptada: sin identidad verificable no se
  // ofrece revertir (fail-closed) — para esas queda el camino por archivo desde Procesados.
  const revertFormOf = (s: IntakeSlot) => (h: IntakeUploadEvent): string =>
    h.id != null && h.sha256 && h.ok ? postForm(action, token, { slot: s.id, accion: 'revert-plan', upload: String(h.id) }, 'Revertir esta carga') : ''
  const secciones = slots.map((sc) => {
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
      : sc.runs === 'error' ? '<span class="sub">motor no respondió</span>' : '<span class="sub">sin corridas</span>'

    const rerun = s.trigger ? postForm(action, token, { slot: s.id, accion: 'rerun' }, 'Correr conversión de nuevo', 'La conversión re-procesará TODOS los archivos del landing. ¿Continuar?') : ''

    const logHtml = logText?.trim()
      ? `<details class="guia"><summary class="sub">${logAñejo ? 'Log de una corrida anterior' : 'Log de la última conversión'}</summary><pre class="sub" style="white-space:pre-wrap;overflow-x:auto;max-height:260px;overflow-y:auto">${escapeHtml((logText.length > 4000 ? '…' + logText.slice(-4000) : logText).trim())}</pre></details>`
      : ''

    // Los sidecars `<archivo>.meta.json` (issue #76) son metadata, no archivos de datos: no se listan.
    const landingRows = sc.landing === 'error'
      ? `<tr><td colspan="4" class="sub">No se pudo listar el landing (reintentá refrescando).</td></tr>`
      : sc.landing.filter((e) => !e.isDirectory && !isSidecarName(e.path)).map((e) => {
          const residuo = esResiduo(e, lastDone)
          // #161 · VARADO: nadie lo ha tomado a tiempo. Hermano del RESIDUO y distinto de él —
          // residuo es «anterior a la última corrida completada», varado es «excedió su edad
          // máxima» —, así que se marca aparte y en el amarillo de los avisos, no en el rojo del
          // residuo. La edad viene de la clasificación (`ArchivoVarado.ageMinutes`): acá no se
          // computa ninguna, y por eso la marca es fiel a lo que el vigilante midió aunque su
          // última medida no sea de este instante (lo dice su banner).
          const varado = varadoDe(baseName(e.path))
          const marcaVarado = varado
            ? ` <b style="${AVISO}">⚠ VARADO</b><div class="sub" style="${AVISO}">hace ${edad(varado.ageMinutes)} en el landing sin que ninguna corrida lo tomara${medidaVieja ? ' (según la última medida buena del vigilante)' : ''}</div>`
            : ''
          return `<tr${residuo ? ' style="color:var(--err)"' : ''}><td>${escapeHtml(baseName(e.path))}</td><td>${kb(e.size)}</td><td>${when(e.lastModified)}${residuo ? ' <b>⚠ residuo</b><div class="sub">anterior a la última conversión: se RE-PROCESARÁ en la próxima corrida</div>' : ''}${marcaVarado}</td><td>${postForm(action, token, { slot: s.id, accion: 'retire', archivo: baseName(e.path) }, 'Retirar', `Retirar «${baseName(e.path)}» del landing (va a _retirado/, reversible). ¿Continuar?`)}</td></tr>`
        }).join('') || `<tr><td colspan="4" class="sub">Landing vacío — nada pendiente de procesar.</td></tr>`

    const archivedRows = sc.archived === 'error'
      ? `<tr><td colspan="4" class="sub">No se pudo listar el archivo de procesados.</td></tr>`
      : sc.archived.filter((e) => !e.isDirectory && !isSidecarName(e.path)).slice(0, 60).map((e) =>
          `<tr><td>${escapeHtml(e.path.replace(/^.*_processed\//, ''))}</td><td>${kb(e.size)}</td><td>${when(e.lastModified)}</td><td>${postForm(action, token, { slot: s.id, accion: 'restore', archivo: e.path }, 'Reactivar', `Copiar «${baseName(e.path)}» de vuelta al landing para re-procesarlo. ¿Continuar?`)} ${postForm(action, token, { slot: s.id, accion: 'revert-plan', archivo: e.path }, 'Revertir')}</td></tr>`,
        ).join('') || `<tr><td colspan="4" class="sub">Sin procesados archivados todavía.</td></tr>`

    // #162 · la columna DESENLACE aparece cuando hay alguno resuelto (sin ellos: tabla intacta).
    const conDesenlace = hayDesenlace(sc.history)
    const thDesenlace = conDesenlace ? '<th>Desenlace</th>' : ''
    const colsActividad = conDesenlace ? 5 : 4

    return `<h2>${escapeHtml(s.label)} <span class="sub c">${escapeHtml(s.id)}</span></h2>
    ${vigilante}${avisoLogs}${coherencia}
    <p><b>Última conversión:</b> ${estado} ${rerun ? `<span style="margin-left:12px">${rerun}</span>` : ''}</p>
    ${logHtml}
    <h3 class="sub">Subir archivos</h3>
    ${uploadFormOf(s)}
    <h3 class="sub">Actividad</h3>
    <table><thead><tr><th>Cuándo</th><th>Evento</th><th>Detalle</th>${thDesenlace}<th></th></tr></thead>
    <tbody>${timeline(sc.history, sc.runs, 30, titular, sinCambios, hrefDeRun, sc.reverts, revertFormOf(s), conDesenlace).map((i) => `<tr>${i.html}</tr>`).join('') || `<tr><td colspan="${colsActividad}" class="sub">Sin actividad registrada.</td></tr>`}</tbody></table>
    <h3 class="sub">Landing (por procesar)</h3>
    <table><thead><tr><th>Archivo</th><th>Tamaño</th><th>Recibido</th><th></th></tr></thead><tbody>${landingRows}</tbody></table>
    <h3 class="sub">Procesados (archivo histórico)</h3>
    <table><thead><tr><th>Archivo</th><th>Tamaño</th><th>Procesado</th><th></th></tr></thead><tbody>${archivedRows}</tbody></table>`
  }).join('<hr style="border:0;border-top:1px solid var(--border);margin:28px 0">')

  const guia = `<details class="guia"><summary>¿Cómo funciona el ciclo de una carga? (y cómo revertirla)</summary>
    <p class="sub">Subís archivos → aterrizan en el <b>landing</b> → la conversión corre (automática al subir, o con «Correr conversión de nuevo») → el resultado queda en «Actividad» con su log. Los pipelines procesan por clave (semana, OC): <b>retirar</b> un archivo del landing y re-correr revierte lo que ese archivo aportó; <b>reactivar</b> uno del histórico lo vuelve a materializar. Un archivo marcado <b style="color:var(--err)">⚠ residuo</b> quedó de una corrida anterior y se re-procesará — retiralo si no corresponde.</p>
    <p class="sub"><b>«Revertir esta carga»</b> (en cada carga de «Actividad», y por archivo en el histórico) deshace lo que esa carga materializó, clave por clave: primero muestra el <b>plan derivado</b> —qué clave vuelve a su versión anterior, cuál queda vacía, cuál no se toca porque una carga posterior la pisó— y recién con tu confirmación lo ejecuta. Nunca toca claves ajenas a la carga.</p>
  </details>`
  return `${back}<p class="sub">Operación de cargas del dominio: historial, estado y log de cada conversión, y el ciclo completo del landing (retirar / reactivar / re-correr).</p>${guia}${secciones}`
}
