/**
 * Observabilidad y reconciliación de ingestión (frente B — ver `docs/frescura-oferta-demanda.md`).
 *
 * LÓGICA PURA (testeable, agnóstica de motor): clasifica la salud de un proceso a partir de su historial
 * de corridas + su cadencia requerida (detecta **fallidas** y **faltantes/viejas**), y deriva el plan de
 * **reconciliación** del schedule (deseado vs real).
 *
 * El acceso al motor (leer run-history / empujar schedule) es la COSTURA `IngestionEngineClient`. La
 * impl. concreta (Fabric *job instances* / schedules vía REST) se inyecta. NOTA: la observabilidad
 * **viva** requiere que los procesos de ingestión corran como **pipelines del motor** (con historial y
 * schedule) — no como scripts manuales; mientras un dominio se materialice con un script suelto, no hay
 * run-history que observar ni schedule que reconciliar.
 */

export type RunStatus = 'Completed' | 'Failed' | 'InProgress' | 'NotStarted' | 'Cancelled' | 'Deduped'

export interface RunRecord {
  /** ISO-8601. */
  startedAt: string
  endedAt?: string
  status: RunStatus
  error?: string
}

export interface ProcessHealth {
  lastStatus: RunStatus | 'NoRuns'
  lastSuccessAt: string | null
  /** Segundos desde la última corrida exitosa (null si nunca). */
  ageSeconds: number | null
  /** La última corrida terminó en fallo. */
  failed: boolean
  /** No hay corrida exitosa reciente: antigüedad > cadencia requerida (o nunca corrió). */
  missed: boolean
}

/** Salud de un proceso = su historial + su cadencia requerida, a un instante `nowMs`. */
export function classifyProcess(runs: RunRecord[], requiredCadenceSeconds: number, nowMs: number): ProcessHealth {
  const sorted = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  const lastStatus: RunStatus | 'NoRuns' = sorted[0]?.status ?? 'NoRuns'
  const lastSuccess = sorted.find((r) => r.status === 'Completed')
  const lastSuccessAt = lastSuccess?.endedAt ?? lastSuccess?.startedAt ?? null
  const ageSeconds = lastSuccessAt == null ? null : Math.max(0, Math.round((nowMs - Date.parse(lastSuccessAt)) / 1000))
  const failed = lastStatus === 'Failed'
  const missed = ageSeconds == null || ageSeconds > requiredCadenceSeconds
  return { lastStatus, lastSuccessAt, ageSeconds, failed, missed }
}

/** ¿Hay que notificar? (fallida o faltante). Devuelve la razón, o null si está sana. */
export function alertReason(h: ProcessHealth): 'failed' | 'missed' | null {
  if (h.failed) return 'failed'
  if (h.missed) return 'missed'
  return null
}

export interface ReconcilePlan {
  action: 'set' | 'noop'
  desiredSeconds: number
}

/**
 * Reconciliador (control loop): el schedule del motor (`actualSeconds`) debe converger a la cadencia
 * derivada (`desiredSeconds`). `noop` si ya coinciden; `set` si no. El *debounce* es operacional (el
 * llamador lo aplica), no de esta función pura.
 */
export function reconcilePlan(desiredSeconds: number, actualSeconds: number | null): ReconcilePlan {
  return { action: actualSeconds === desiredSeconds ? 'noop' : 'set', desiredSeconds }
}

// ─── Alerta autónoma (push ante fallida/faltante, con dedup por transición) ──────────────────────────
export interface ProcessAlert {
  processId: string
  reason: 'failed' | 'missed'
  /** Antigüedad de la última corrida exitosa (s); null si nunca. */
  ageSeconds: number | null
  /** Mensaje de error de la última corrida (solo cuando reason='failed'). */
  lastError?: string
}

/** Alertas ACTUALES = procesos cuya salud es fallida/faltante, a partir de su historial + cadencia requerida. */
export function freshnessAlerts(
  procs: { processId: string; runs: RunRecord[]; requiredCadenceSeconds: number }[],
  nowMs: number,
): ProcessAlert[] {
  const out: ProcessAlert[] = []
  for (const p of procs) {
    const reason = alertReason(classifyProcess(p.runs, p.requiredCadenceSeconds, nowMs))
    if (!reason) continue
    const ageSeconds = classifyProcess(p.runs, p.requiredCadenceSeconds, nowMs).ageSeconds
    const last = [...p.runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
    const alert: ProcessAlert = { processId: p.processId, reason, ageSeconds }
    if (reason === 'failed' && last?.error) alert.lastError = last.error
    out.push(alert)
  }
  return out
}

/**
 * Transición de estado de alertas: qué NOTIFICAR (nueva o cambió de razón) y qué se RECUPERÓ, dado el
 * estado previo. Evita re-notificar lo que ya estaba avisado (el push solo dispara en transiciones).
 */
export function diffAlertState(
  prev: Record<string, 'failed' | 'missed'>,
  current: ProcessAlert[],
): { notify: ProcessAlert[]; recovered: string[]; next: Record<string, 'failed' | 'missed'> } {
  const next: Record<string, 'failed' | 'missed'> = {}
  const notify: ProcessAlert[] = []
  for (const a of current) {
    next[a.processId] = a.reason
    if (prev[a.processId] !== a.reason) notify.push(a)
  }
  const recovered = Object.keys(prev).filter((pid) => !(pid in next))
  return { notify, recovered, next }
}

/** Costura con el motor de ejecución (Fabric u otro). La impl. concreta se inyecta. */
export interface IngestionEngineClient {
  /** Historial de corridas de un proceso (Fabric: *item job instances*). */
  listRunHistory(processRef: string): Promise<RunRecord[]>
  /** Schedule actual del proceso en segundos (null si no tiene). */
  getScheduleSeconds(processRef: string): Promise<number | null>
  /** Fija/actualiza el schedule del proceso (one-way Mira→motor; idempotente). */
  setScheduleSeconds(processRef: string, seconds: number): Promise<void>
}
