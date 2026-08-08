/**
 * Reporte periódico de lo ejecutado (issue #102) — el LATIDO de la instancia.
 *
 * Se envía SIEMPRE a la hora configurada: con novedades, sin novedades, y aun cuando los insumos
 * fallen (reporte de indisponibilidad). Un digest que solo llega cuando hay algo que contar tiene
 * el mismo punto ciego que intenta cerrar: un día sin correo se leería igual que un día tranquilo.
 * Enviándolo incondicionalmente, la AUSENCIA del correo pasa a ser la señal (sistema caído).
 *
 * Lee SOLO la proyección local (#105) y el registro de gobierno; el motor, jamás. Idempotencia por
 * período (platform_setting `report.last_sent`, persistido tras ≥1 destino exitoso: at-least-once —
 * un latido duplicado es inocuo, un latido perdido es una falsa alarma). Catch-up: si el proceso
 * estaba caído a la hora del envío, el primer tick posterior envía YA, con la ventana extendida
 * hasta el último envío registrado (cap 7 períodos) y el hueco declarado en el cuerpo.
 */
import {
  classifyProcess,
  deriveIngestionMap,
  INGESTION_RUN_RETENTION,
  type DeriveMapInput,
  type IngestionRunSnapshot,
  type IngestionRunStore,
  type PlatformSettingStore,
  type ProcessRow,
  type RunRecord,
  type RunStatus,
  type SourceRow,
} from '@vergis/capabilities'
import { fmtDur, type Notification, type NotificationSink, type ReportSchedule } from './notify'

export const REPORT_LAST_SENT_KEY = 'report.last_sent'
export const REPORT_CHECK_MS = 60_000
export const REPORT_RETRY_MS = 600_000
export const REPORT_MAX_CATCHUP_PERIODS = 7

export interface ReportLastSent {
  periodKey: string
  dueAt: string
  sentAt: string
  delivered: string[]
  failed: string[]
}

/** Fail-safe: basura o null ⇒ null (se trata como «nunca enviado»: a lo sumo UN duplicado, jamás un silencio). */
export function parseReportLastSent(raw: string | null): ReportLastSent | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== 'object' || typeof o['periodKey'] !== 'string' || !o['periodKey']) return null
    return {
      periodKey: o['periodKey'],
      dueAt: typeof o['dueAt'] === 'string' ? o['dueAt'] : '',
      sentAt: typeof o['sentAt'] === 'string' ? o['sentAt'] : '',
      delivered: Array.isArray(o['delivered']) ? o['delivered'].map(String) : [],
      failed: Array.isArray(o['failed']) ? o['failed'].map(String) : [],
    }
  } catch {
    return null
  }
}

// ── Aritmética de calendario (PURA, Intl; sin deps) ──────────────────────────────────────────────

const DIA_MS = 86_400_000
const WEEKDAY_IDX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const WEEKDAY_NUM: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
const dd = (n: number): string => String(n).padStart(2, '0')

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function partsFmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    fmtCache.set(tz, f)
  }
  return f
}

/** Partes wall-clock del instante en la tz (formatToParts, hour12:false). */
export function wallclock(tMs: number, tz: string): { y: number; m: number; d: number; hh: number; mm: number; weekday: number } {
  const p: Record<string, string> = {}
  for (const part of partsFmt(tz).formatToParts(new Date(tMs))) p[part.type] = part.value
  return {
    y: Number(p['year']),
    m: Number(p['month']),
    d: Number(p['day']),
    hh: Number(p['hour']),
    mm: Number(p['minute']),
    weekday: WEEKDAY_IDX[p['weekday'] ?? 'Sun'] ?? 0,
  }
}

/** Offset del tz en el instante: Date.UTC(wallclock(t)) − t. */
export function offsetAtMs(tMs: number, tz: string): number {
  const w = wallclock(tMs, tz)
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, 0, 0) - Math.floor(tMs / 60_000) * 60_000
}

/** Clave comparable del reloj local (minuto): YYYYMMDDhhmm. */
function localKey(tMs: number, tz: string): number {
  const w = wallclock(tMs, tz)
  return ((w.y * 100 + w.m) * 100 + w.d) * 10_000 + w.hh * 100 + w.mm
}

/**
 * Instante del `at` (HH:MM) del día civil (y,m,d) en tz. Doble pasada de offset (borde DST); hora
 * inexistente (salto de primavera) ⇒ el instante en que el reloj local la alcanza o pasa — buscado
 * por bisección al minuto, que es la única respuesta verdadera cuando esa hora NO existe.
 */
export function dueFor(y: number, m: number, d: number, at: string, tz: string): number {
  const [hh, mm] = at.split(':').map(Number) as [number, number]
  const objetivo = Date.UTC(y, m - 1, d, hh, mm, 0, 0)
  let t = objetivo - offsetAtMs(objetivo, tz)
  t = objetivo - offsetAtMs(t, tz)
  const clave = ((y * 100 + m) * 100 + d) * 10_000 + hh * 100 + mm
  if (localKey(t, tz) === clave) return t
  // Hora local inexistente: primer minuto cuyo reloj local ya alcanzó o pasó el objetivo.
  let lo = objetivo - 14 * 3_600_000
  let hi = objetivo + 14 * 3_600_000
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000
    if (localKey(mid, tz) >= clave) hi = mid
    else lo = mid + 60_000
  }
  return hi
}

/** Última ocurrencia programada ≤ nowMs (daily: hoy o ayer; weekly: el weekday de esta semana o la anterior). */
export function lastDueAt(nowMs: number, sched: Pick<ReportSchedule, 'at' | 'every' | 'weekday'>, tz: string): number {
  const paso = sched.every === 'weekly' ? 7 : 1
  let base = nowMs
  if (sched.every === 'weekly') {
    const objetivo = WEEKDAY_NUM[sched.weekday ?? 'monday'] ?? 1
    const delta = (wallclock(nowMs, tz).weekday - objetivo + 7) % 7
    base = nowMs - delta * DIA_MS
  }
  const w = wallclock(base, tz)
  const cand = dueFor(w.y, w.m, w.d, sched.at, tz)
  if (cand <= nowMs) return cand
  const prev = wallclock(base - paso * DIA_MS, tz)
  return dueFor(prev.y, prev.m, prev.d, sched.at, tz)
}

/** Ocurrencia anterior a un due: lastDueAt(dueMs − 1). El inicio de la ventana estándar. */
export function prevDueBefore(dueMs: number, sched: Pick<ReportSchedule, 'at' | 'every' | 'weekday'>, tz: string): number {
  return lastDueAt(dueMs - 1, sched, tz)
}

/** YYYY-MM-DD del due en la tz — la identidad del período (idempotencia). */
export function periodKeyOf(dueMs: number, tz: string): string {
  const w = wallclock(dueMs, tz)
  return `${w.y}-${dd(w.m)}-${dd(w.d)}`
}

/** `YYYY-MM-DD HH:MM` del instante en la tz (para humanos del reporte). */
export function fmtLocal(iso: string | number, tz: string): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(t)) return String(iso)
  const w = wallclock(t, tz)
  return `${w.y}-${dd(w.m)}-${dd(w.d)} ${dd(w.hh)}:${dd(w.mm)}`
}

// ── Composición (PURA) ───────────────────────────────────────────────────────────────────────────

export interface ReportProcessRow {
  processId: string
  label: string
  /** Dominio ENLAZABLE: solo si la fuente lo tagea Y está declarado (regla #100 D5). */
  domainId?: string
  domainLabel?: string
  /** engine_ref presente. */
  observable: boolean
  /** undefined = sin cadencia exigida (event-driven / sin demanda). */
  requiredCadenceSeconds?: number
  /** observedAt null (jamás observado). */
  fria: boolean
  /** Corridas cuyo startedAt cae en [winStart, due), más reciente primero. */
  runsInWindow: RunRecord[]
  /** classifyProcess(runs proyectadas COMPLETAS, req, dueMs) — solo si observable, no fría y req finito. */
  missed?: boolean
  lastSuccessAgeSeconds?: number | null
}

export interface ReportPeriod {
  periodKey: string
  fromIso: string
  toIso: string
  timezone: string
  every: 'daily' | 'weekly'
  /** Períodos cubiertos (1 = normal; >1 = ventana extendida por catch-up). */
  periodos: number
  primero: boolean
}

export interface ReportProjectionMeta {
  engineCabled: boolean
  /** freshnessPollMs <= 0 */
  lazoApagado: boolean
  /** max(observedAt) sobre los snapshots; null = nada observado. */
  maxObservedAt: string | null
  stale: boolean
}

export interface ComposeReportInput {
  periodo: ReportPeriod
  procesos: ReportProcessRow[]
  proyeccion: ReportProjectionMeta
  baseUrl: string
}

/** Arma las filas desde los insumos crudos (todo local). windowStartMs/dueMs en epoch. */
export function buildReportRows(args: {
  snapshots: IngestionRunSnapshot[]
  procs: ProcessRow[]
  sources: SourceRow[]
  domains: { id: string; label: string }[]
  map: { processId: string; requiredCadenceSeconds: number }[]
  winStartMs: number
  dueMs: number
}): ReportProcessRow[] {
  const snapOf = new Map(args.snapshots.map((s) => [s.processId, s]))
  const sourceOf = new Map(args.sources.map((s) => [s.id, s]))
  const domOf = new Map(args.domains.map((d) => [d.id, d.label]))
  const reqOf = new Map(args.map.map((m) => [m.processId, m.requiredCadenceSeconds]))

  return args.procs.map((p): ReportProcessRow => {
    const snap = snapOf.get(p.id)
    const observable = !!p.engine
    const fria = observable && (snap == null || snap.observedAt == null)
    const runs = snap?.runs ?? []
    const runsInWindow = runs
      .filter((r) => {
        const t = Date.parse(r.startedAt)
        return Number.isFinite(t) && t >= args.winStartMs && t < args.dueMs
      })
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    const req = reqOf.get(p.id)
    const row: ReportProcessRow = { processId: p.id, label: p.label, observable, fria, runsInWindow }
    // El dominio solo cuenta si está DECLARADO: un enlace a un dominio sin página nace muerto.
    const dom = sourceOf.get(p.sourceId)?.domain
    if (dom != null && domOf.has(dom)) {
      row.domainId = dom
      row.domainLabel = domOf.get(dom)!
    }
    if (req != null && Number.isFinite(req)) {
      row.requiredCadenceSeconds = req
      if (observable && !fria) {
        // La salud se computa sobre las corridas COMPLETAS, no sobre las de la ventana: la última
        // exitosa puede ser anterior al período y «no corrió debiendo» es acumulado.
        const h = classifyProcess(runs, req, args.dueMs)
        row.missed = h.missed
        row.lastSuccessAgeSeconds = h.ageSeconds
      }
    }
    return row
  })
}

const DESENLACE: Record<RunStatus, string> = {
  Completed: 'completó',
  Failed: 'falló',
  InProgress: 'en curso',
  NotStarted: 'en cola',
  Cancelled: 'cancelada',
  Deduped: 'omitida (duplicada)',
}

const SIN_PROCESOS = 'sin procesos de ingestión declarados'
const conDominio = (r: ReportProcessRow): string => (r.domainLabel ? `${r.domainLabel} · ${r.label}` : r.label)
const hrefSources = (baseUrl: string): string => `${baseUrl}/admin/sources`

export function composeOperationsReport(input: ComposeReportInput): Notification {
  const { periodo, procesos, proyeccion, baseUrl } = input
  const tz = periodo.timezone
  const ventanaSeg = (Date.parse(periodo.toIso) - Date.parse(periodo.fromIso)) / 1000

  const vivos = procesos.filter((p) => p.observable && !p.fria)
  const corrieron = vivos.filter((p) => p.runsInWindow.length > 0)
  const conFallo = corrieron.filter((p) => p.runsInWindow[0]!.status === 'Failed')
  const bien = corrieron.filter((p) => p.runsInWindow[0]!.status !== 'Failed')
  const ausentes = vivos.filter(
    (p) => p.runsInWindow.length === 0 && p.requiredCadenceSeconds != null && (p.requiredCadenceSeconds <= ventanaSeg || p.missed === true),
  )
  const enCadencia = vivos.filter((p) => p.runsInWindow.length === 0 && p.requiredCadenceSeconds != null && !ausentes.includes(p))
  const frios = procesos.filter((p) => p.observable && p.fria)
  const sinCadencia = vivos.filter((p) => p.runsInWindow.length === 0 && p.requiredCadenceSeconds == null)
  const noObservables = procesos.filter((p) => !p.observable)

  const c = corrieron.length
  const f = conFallo.length
  const a = ausentes.length

  const lines: string[] = [`período: ${fmtLocal(periodo.fromIso, tz)} → ${fmtLocal(periodo.toIso, tz)} (${tz})`]
  if (periodo.primero) lines.push('primer reporte de esta instancia')
  if (periodo.periodos > 1)
    lines.push(`ventana extendida: cubre ${periodo.periodos} períodos (${periodo.periodos - 1} envío(s) perdido(s) — la instancia estuvo caída o el envío falló)`)
  // La frescura de la propia proyección va DECLARADA: un reporte con datos rancios que no lo dice
  // es un dato falso. A lo sumo una línea, la más determinante.
  if (!proyeccion.engineCabled) lines.push('sin motor de ingestión cableado — no hay procesos observables')
  else if (proyeccion.lazoApagado) lines.push('⚠ la observación del motor está apagada — los datos pueden estar incompletos')
  else if (proyeccion.stale)
    lines.push(`⚠ última observación del motor: ${proyeccion.maxObservedAt ? fmtLocal(proyeccion.maxObservedAt, tz) : 'nunca'} — pueden faltar corridas recientes`)

  if (!procesos.length) {
    lines.push(SIN_PROCESOS)
  } else {
    if (f) {
      lines.push(`Con fallo (${f}):`)
      for (const p of conFallo) {
        const ultima = p.runsInWindow[0]!
        const err = ultima.error ? ` — ${ultima.error.slice(0, 200)}` : ''
        lines.push(`✗ ${conDominio(p)} — falló ${fmtLocal(ultima.startedAt, tz)} · ${p.runsInWindow.length} corrida(s) en el período${err}`)
      }
    }
    if (a) {
      lines.push(`No corrieron debiendo (${a}):`)
      for (const p of ausentes) {
        const age = p.lastSuccessAgeSeconds
        const ult = age == null ? 'nunca' : `hace ${fmtDur(age)}`
        lines.push(`${conDominio(p)} — cadencia requerida ${fmtDur(p.requiredCadenceSeconds!)} · última exitosa ${ult}`)
      }
    }
    if (bien.length) {
      lines.push(`Corrieron bien (${bien.length}):`)
      for (const p of bien) {
        const ultima = p.runsInWindow[0]!
        lines.push(`✓ ${conDominio(p)} — ${p.runsInWindow.length} corrida(s) · última ${fmtLocal(ultima.startedAt, tz)} ${DESENLACE[ultima.status]}`)
      }
    }
    if (enCadencia.length) lines.push(`Dentro de su cadencia, sin corrida en el período: ${enCadencia.map((p) => p.label).join(', ')}`)
    if (frios.length) lines.push(`Sin observación aún (proyección fría): ${frios.map((p) => p.label).join(', ')}`)
    if (sinCadencia.length) lines.push(`Sin cadencia exigida, sin corrida en el período: ${sinCadencia.map((p) => p.label).join(', ')}`)
    if (noObservables.length) lines.push(`No observables (sin motor): ${noObservables.map((p) => p.label).join(', ')}`)
  }

  const links = [{ label: 'Fuentes e ingestas', url: hrefSources(baseUrl) }]
  for (const p of conFallo) {
    if (!p.domainId) continue // sin dominio declarado no hay página de corrida: no se ofrece el enlace
    const started = p.runsInWindow[0]!.startedAt
    links.push({
      label: `Log — ${p.label}`,
      url: `${baseUrl}/admin/dominio/${p.domainId}/corrida?proc=${encodeURIComponent(p.processId)}&started=${encodeURIComponent(started)}`,
    })
  }

  const seccionDe = (p: ReportProcessRow): string => {
    if (conFallo.includes(p)) return 'con-fallo'
    if (ausentes.includes(p)) return 'no-corrio-debiendo'
    if (bien.includes(p)) return 'corrio-bien'
    if (enCadencia.includes(p)) return 'dentro-de-cadencia'
    if (frios.includes(p)) return 'proyeccion-fria'
    if (sinCadencia.includes(p)) return 'sin-cadencia-exigida'
    return 'no-observable'
  }

  const etiqueta = periodo.every === 'weekly' ? `semana del ${periodo.periodKey}` : periodo.periodKey
  return {
    severity: f + a > 0 || lines.some((l) => l.startsWith('⚠')) ? 'warning' : 'info',
    title: `Reporte de ingestión — ${etiqueta} — ${c} corrieron · ${f} con fallo · ${a} no corrieron debiendo`,
    lines,
    links,
    data: {
      event: 'reporte-operaciones',
      periodKey: periodo.periodKey,
      window: { from: periodo.fromIso, to: periodo.toIso, timezone: tz },
      counts: { corrieron: c, conFallo: f, ausentes: a, frios: frios.length, sinCadencia: sinCadencia.length, noObservables: noObservables.length },
      periodos: periodo.periodos,
      procesos: procesos.map((p) => ({
        processId: p.processId,
        seccion: seccionDe(p),
        corridas: p.runsInWindow.length,
        ultima: p.runsInWindow[0]?.startedAt ?? null,
      })),
    },
  }
}

/** El latido cuando los insumos fallan: jamás callar. */
export function composeReportUnavailable(periodo: ReportPeriod, detalle: string, baseUrl: string): Notification {
  const etiqueta = periodo.every === 'weekly' ? `semana del ${periodo.periodKey}` : periodo.periodKey
  return {
    severity: 'warning',
    title: `Reporte de ingestión — ${etiqueta} — sin datos (error interno)`,
    lines: [
      `período: ${fmtLocal(periodo.fromIso, periodo.timezone)} → ${fmtLocal(periodo.toIso, periodo.timezone)} (${periodo.timezone})`,
      '⚠ no se pudieron leer los insumos del reporte — se emite igual como latido',
      `detalle: ${detalle}`,
    ],
    links: [{ label: 'Fuentes e ingestas', url: hrefSources(baseUrl) }],
    data: { event: 'reporte-operaciones', periodKey: periodo.periodKey, error: detalle },
  }
}

// ── Lazo ─────────────────────────────────────────────────────────────────────────────────────────

export interface ReportLoopDeps {
  store: PlatformSettingStore & IngestionRunStore
  /** El MISMO freshnessInputs del wiring (ya devuelve sources). */
  inputs: () => Promise<{ sources: SourceRow[]; procs: ProcessRow[]; mapInput: DeriveMapInput }>
  domains: { id: string; label: string }[]
  sinks: NotificationSink[]
  audit: (e: { type: string; [k: string]: unknown }) => void
  log: (line: string) => void
  now?: () => number
}

export interface ReportLoopConfig {
  /**
   * La cadencia se consulta POR TICK (issue #138·2), no se captura al construir: `null` = reporte
   * apagado (el tick retorna temprano). Así `report:` puede aparecer, cambiar de hora o desaparecer
   * en caliente sin reconstruir el lazo — que es lo que exigiría un restart.
   */
  schedule: () => ReportSchedule | null
  /** Fallback de zona horaria cuando el schedule vigente no declara la suya (tz del host). */
  timezone: string
  baseUrl: string
  freshnessPollMs: number
  engineCabled: boolean
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createReportLoop(deps: ReportLoopDeps, cfg: ReportLoopConfig): { tick(): Promise<void> } {
  const now = deps.now ?? Date.now
  let lastSent: ReportLastSent | null = null
  let hydrated = false
  /** Último intento fallido en TODOS los destinos (en memoria: los intentos no se persisten). */
  let lastAttemptMs: number | null = null
  let inFlight = false

  return {
    async tick(): Promise<void> {
      if (inFlight) {
        deps.log('reporte: tick solapado, se omite')
        return
      }
      inFlight = true
      try {
        // La cadencia VIGENTE, resuelta acá y no en la construcción: sin ella el tick es un no-op
        // (reporte apagado). El interval de 60 s cuesta nada, así que el lazo se arma siempre y es
        // esta consulta —no un re-cableado— la que enciende o apaga el reporte.
        const schedule = cfg.schedule()
        if (!schedule) return
        const tz = schedule.timezone ?? cfg.timezone
        if (!hydrated) {
          lastSent = parseReportLastSent(await deps.store.getSetting(REPORT_LAST_SENT_KEY))
          hydrated = true
        }
        const dueMs = lastDueAt(now(), schedule, tz)
        const periodKey = periodKeyOf(dueMs, tz)
        if (lastSent?.periodKey === periodKey) return // ya enviado: el caso sano no loguea
        if (lastAttemptMs != null && now() - lastAttemptMs < REPORT_RETRY_MS) return

        // Ventana: del due anterior a este due; EXTENDIDA hacia atrás si hay envíos perdidos.
        let winStartMs = prevDueBefore(dueMs, schedule, tz)
        let periodos = 1
        const desdeUltimo = lastSent?.dueAt ? Date.parse(lastSent.dueAt) : NaN
        if (Number.isFinite(desdeUltimo)) {
          while (winStartMs > desdeUltimo && periodos < REPORT_MAX_CATCHUP_PERIODS) {
            winStartMs = prevDueBefore(winStartMs, schedule, tz)
            periodos++
          }
        }
        const periodo: ReportPeriod = {
          periodKey,
          fromIso: new Date(winStartMs).toISOString(),
          toIso: new Date(dueMs).toISOString(),
          timezone: tz,
          every: schedule.every,
          periodos,
          primero: lastSent == null,
        }

        let n: Notification
        try {
          const { sources, procs, mapInput } = await deps.inputs()
          const map = deriveIngestionMap(mapInput)
          const snapshots = await deps.store.listRunSnapshots({ runsPerProcess: INGESTION_RUN_RETENTION })
          const procesos = buildReportRows({ snapshots, procs, sources, domains: deps.domains, map, winStartMs, dueMs })
          const observados = snapshots.map((s) => s.observedAt).filter((o): o is string => o != null)
          const maxObservedAt = observados.length ? observados.reduce((mx, o) => (Date.parse(o) > Date.parse(mx) ? o : mx)) : null
          const hayObservables = procesos.some((p) => p.observable)
          const lazoApagado = cfg.freshnessPollMs <= 0
          const stale =
            cfg.engineCabled && !lazoApagado && hayObservables && (maxObservedAt == null || dueMs - Date.parse(maxObservedAt) > 3 * cfg.freshnessPollMs)
          n = composeOperationsReport({
            periodo,
            procesos,
            proyeccion: { engineCabled: cfg.engineCabled, lazoApagado, maxObservedAt, stale },
            baseUrl: cfg.baseUrl,
          })
        } catch (e) {
          n = composeReportUnavailable(periodo, msg(e), cfg.baseUrl)
        }

        // Despacho sink por sink (NO `fanout`, que aísla y traga): el lazo NECESITA saber quién
        // entregó para decidir si persiste el período como enviado.
        const delivered: string[] = []
        const failed: string[] = []
        for (const s of deps.sinks) {
          try {
            await s.send(n)
            delivered.push(s.id)
          } catch (e) {
            failed.push(s.id)
            deps.log(`reporte[${s.id}]: ${msg(e)}`)
          }
        }

        if (delivered.length) {
          const registro: ReportLastSent = { periodKey, dueAt: periodo.toIso, sentAt: new Date(now()).toISOString(), delivered, failed }
          await deps.store.setSetting(REPORT_LAST_SENT_KEY, JSON.stringify(registro), 'report-loop')
          lastSent = registro
          lastAttemptMs = null
          deps.audit({ type: 'reporte-operaciones', by: 'report-loop', periodKey, delivered, failed })
          deps.log(`reporte ${periodKey} enviado a ${delivered.join(',')}${failed.length ? ` · fallaron ${failed.join(',')}` : ''}`)
        } else {
          lastAttemptMs = now()
          deps.log(`reporte ${periodKey}: todos los destinos fallaron — reintento en ${REPORT_RETRY_MS / 60_000} min`)
        }
      } catch (e) {
        deps.log(`reporte: ${msg(e)}`)
      } finally {
        inFlight = false
      }
    },
  }
}
