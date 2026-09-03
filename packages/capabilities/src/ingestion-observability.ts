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
  /** `set` empujar la cadencia · `noop` ya converge · `vigilar` alimentación manual: no se programa (#279). */
  action: 'set' | 'noop' | 'vigilar'
  desiredSeconds: number
}

/**
 * Reconciliador (control loop): el schedule del motor (`actualSeconds`) debe converger a la cadencia
 * derivada (`desiredSeconds`). `noop` si ya coinciden; `set` si no. El *debounce* es operacional (el
 * llamador lo aplica), no de esta función pura.
 *
 * `manualFed` (#279) es el tercer camino y gana sobre los otros dos: el proceso lo alimenta una carga
 * manual (land-and-trigger), así que un schedule correría sobre nada. La cadencia requerida se
 * **vigila** —las fases de observación y alerta la usan igual para decir «atrasada»— pero no se
 * programa. Se devuelve `vigilar` y no `noop` a propósito: `noop` diría «ya está como debe estar», y
 * el feedback de la página tiene que decir la verdad de por qué no se hizo nada.
 */
export function reconcilePlan(desiredSeconds: number, actualSeconds: number | null, manualFed = false): ReconcilePlan {
  if (manualFed) return { action: 'vigilar', desiredSeconds }
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
 *
 * GENÉRICA sobre la razón (`R`) y sobre la alerta (`A`) porque el dedup por transición no es de
 * frescura: es del PATRÓN de lazo, y la vigilancia del intake (#161) lo necesita con sus propias
 * razones (`SlotAlertReason`, en `intake-observability.ts`) y su propia clave (`slotId`). La firma
 * cerrada a `Record<string,'failed'|'missed'>` + `ProcessAlert[]` no typechequeaba con ellas.
 *
 * COMPATIBLE HACIA ATRÁS: `keyOf` es opcional y su default lee `processId`, así que los llamadores
 * de frescura siguen escribiéndose igual y siguen infiriendo `ProcessAlert[]` / `'failed'|'missed'`.
 * El default hace un cast porque el sistema de tipos no puede expresar «si `A` tiene `processId`»;
 * el cast es SEGURO para todo llamador que no pase `keyOf` — quien no tiene `processId` está
 * obligado por el propio uso a pasarlo (una clave `undefined` colapsaría todas las alertas en una
 * sola entrada, y el test de la vigilancia lo cubre).
 */
export function diffAlertState<R extends string, A extends { reason: R }>(
  prev: Record<string, R>,
  current: A[],
  keyOf: (a: A) => string = (a) => (a as unknown as { processId: string }).processId,
): { notify: A[]; recovered: string[]; next: Record<string, R> } {
  const next: Record<string, R> = {}
  const notify: A[] = []
  for (const a of current) {
    next[keyOf(a)] = a.reason
    if (prev[keyOf(a)] !== a.reason) notify.push(a)
  }
  const recovered = Object.keys(prev).filter((pid) => !(pid in next))
  return { notify, recovered, next }
}

/** Clave de `platform_setting` donde vive el estado de alertas de frescura entre reinicios. */
export const FRESHNESS_ALERT_STATE_KEY = 'freshness.alert_state'

/**
 * Lee el estado de alertas persistido. El dedup del monitor (`diffAlertState`) solo funciona si el
 * estado previo SOBREVIVE al reinicio: en RAM, cada restart re-notifica todo lo que siga fallando —
 * ruido que además entrena a ignorar la alerta.
 *
 * Fail-safe por diseño: si el valor está corrupto o es de una forma vieja, se devuelve `{}` en vez de
 * propagar. El costo de equivocarse es una notificación de más (recuperable); el de reventar el
 * monitor, quedarse ciego.
 */
export function parseAlertState(raw: string | null): Record<string, 'failed' | 'missed'> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, 'failed' | 'missed'> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === 'failed' || val === 'missed') out[k] = val
    }
    return out
  } catch {
    return {}
  }
}

// ─── Corte as-of de un PI (issue #108): la fecha hasta la que el dato servido está GARANTIZADO ───────

/** Detalle del corte por dominio (lo que el tooltip del header despliega). */
export interface AsOfDetail {
  /** Dominio de la fuente; null si la fuente no declara dominio. */
  domainId: string | null
  /** Label legible del dominio (de la config de dominios); el id si no está declarado. */
  label: string
  /** Última ingesta exitosa del dominio = la MÁS ANTIGUA de sus procesos involucrados (ISO). */
  lastSuccessAt: string
}

/** Corte as-of derivado de la ingesta: el mínimo garantizado + su detalle por dominio. */
export interface PiAsOf {
  /** ISO del corte garantizado; null si no se puede afirmar (algún insumo de fecha desconocida). */
  cutoff: string | null
  detail: AsOfDetail[]
}

/** Etiqueta del grupo cuando la fuente no declara dominio. */
export const SIN_DOMINIO_LABEL = '(sin dominio)'

/**
 * Corte as-of de un PI a partir de la INGESTA (fallback de plataforma de #108 · D1.2): la fecha de la
 * última ingesta exitosa MÁS ANTIGUA entre los procesos que producen las tablas del PI.
 *
 * Racional del mínimo: cada tabla está al día de SU ingesta; el conjunto solo puede **garantizar** el
 * mínimo — cifras posteriores al proceso más atrasado pueden faltar.
 *
 * Regla dura: si ALGÚN proceso involucrado no tiene última corrida exitosa conocida, `cutoff` es
 * `null` (un corte garantizado no se puede afirmar con un insumo ciego — el mínimo de lo conocido
 * sería una mentira). El `detail` sí trae lo que sí se conoce.
 *
 * PURA: sin motor, sin store, sin reloj.
 */
export function deriveAsOfIngesta(input: {
  /** Tablas que lee el PI (derivadas del SQL del spec). */
  tables: string[]
  processOutputs: { processId: string; tableRef: string }[]
  processes: { id: string; sourceId: string }[]
  sources: { id: string; domain?: string }[]
  /** dominio id → label legible. */
  domainLabels: Record<string, string>
  /** proceso → ISO de su última corrida exitosa; null/ausente = desconocida. */
  lastSuccessByProcess: Record<string, string | null>
}): PiAsOf {
  const wanted = new Set(input.tables)
  const involved = new Set<string>()
  for (const po of input.processOutputs) if (wanted.has(po.tableRef)) involved.add(po.processId)
  if (involved.size === 0) return { cutoff: null, detail: [] }

  const sourceOf = new Map(input.processes.map((p) => [p.id, p.sourceId]))
  const domainOf = new Map(input.sources.map((s) => [s.id, s.domain]))

  // Agrupación por dominio: por dominio se muestra el MÍNIMO de sus procesos conocidos.
  const byDomain = new Map<string, { domainId: string | null; label: string; lastSuccessAt: string }>()
  let anyUnknown = false
  let min: string | null = null
  for (const processId of [...involved].sort()) {
    const iso = input.lastSuccessByProcess[processId] ?? null
    if (iso == null) {
      anyUnknown = true
      continue
    }
    if (min == null || Date.parse(iso) < Date.parse(min)) min = iso
    const sourceId = sourceOf.get(processId)
    const domainId = (sourceId != null ? domainOf.get(sourceId) : undefined) ?? null
    const key = domainId ?? ''
    const label = domainId == null ? SIN_DOMINIO_LABEL : (input.domainLabels[domainId] ?? domainId)
    const prev = byDomain.get(key)
    if (!prev || Date.parse(iso) < Date.parse(prev.lastSuccessAt)) byDomain.set(key, { domainId, label, lastSuccessAt: iso })
  }
  // Orden estable y legible: dominios declarados por label, y el residuo «(sin dominio)» al final.
  const detail = [...byDomain.values()].sort((a, b) =>
    a.domainId == null || b.domainId == null
      ? (a.domainId == null ? 1 : 0) - (b.domainId == null ? 1 : 0)
      : a.label.localeCompare(b.label, 'es'),
  )
  return { cutoff: anyUnknown ? null : min, detail }
}

/**
 * Proveedor del corte as-of por PI, con caché TTL sobre el run-history del motor.
 *
 * El serving consulta esto POR REQUEST: la caché (por proceso, TTL corto) evita que cada render
 * dispare N llamadas REST al motor. Un fallo/timeout del motor deja ese proceso en `null` — que por
 * la regla de `deriveAsOfIngesta` se traduce en «corte no disponible» (fail-visible, #108 · D5), y se
 * cachea el `null` por el mismo TTL para no martillar una API caída.
 *
 * Sin `engine` (modo clickhouse, administración deshabilitada, CLI suelto) devuelve el corte vacío sin
 * llamar a nada.
 */
export function createAsOfProvider(deps: {
  engine: IngestionEngineClient | undefined
  loadTopology: () => Promise<{
    processOutputs: { processId: string; tableRef: string }[]
    processes: { id: string; sourceId: string }[]
    sources: { id: string; domain?: string }[]
    domainLabels: Record<string, string>
  }>
  now?: () => number
  /** Vida de la entrada de caché por proceso. Default 60 s. */
  ttlMs?: number
  /** Tope de espera por llamada al motor. Default 3 s. */
  timeoutMs?: number
}): (tables: string[]) => Promise<PiAsOf> {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? 60_000
  const timeoutMs = deps.timeoutMs ?? 3_000
  const cache = new Map<string, { at: number; value: string | null }>()

  const lastSuccessOf = async (processId: string, engine: IngestionEngineClient): Promise<string | null> => {
    const hit = cache.get(processId)
    if (hit && now() - hit.at < ttlMs) return hit.value
    let value: string | null = null
    try {
      const runs = await withTimeout(engine.listRunHistory(processId), timeoutMs)
      // La cadencia no importa acá: solo interesa la última exitosa (Infinity la vuelve irrelevante).
      value = classifyProcess(runs, Number.POSITIVE_INFINITY, now()).lastSuccessAt
    } catch {
      value = null // motor caído/lento → insumo ciego → corte no disponible (D5)
    }
    cache.set(processId, { at: now(), value })
    return value
  }

  return async (tables: string[]): Promise<PiAsOf> => {
    const engine = deps.engine
    if (!engine) return { cutoff: null, detail: [] }
    let topo: Awaited<ReturnType<typeof deps.loadTopology>>
    try {
      topo = await deps.loadTopology()
    } catch {
      return { cutoff: null, detail: [] }
    }
    const wanted = new Set(tables)
    const involved = [...new Set(topo.processOutputs.filter((po) => wanted.has(po.tableRef)).map((po) => po.processId))]
    if (involved.length === 0) return { cutoff: null, detail: [] }
    const values = await Promise.all(involved.map((pid) => lastSuccessOf(pid, engine)))
    const lastSuccessByProcess: Record<string, string | null> = {}
    involved.forEach((pid, i) => { lastSuccessByProcess[pid] = values[i] ?? null })
    return deriveAsOfIngesta({ tables, ...topo, lastSuccessByProcess })
  }
}

/** Race con un temporizador: una llamada colgada del motor no puede colgar un render. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    if (typeof (t as unknown as { unref?: () => void }).unref === 'function') (t as unknown as { unref: () => void }).unref()
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))) },
    )
  })
}

/** Costura con el motor de ejecución (Fabric u otro). La impl. concreta se inyecta. */
export interface IngestionEngineClient {
  /** Historial de corridas de un proceso (Fabric: *item job instances*). */
  listRunHistory(processRef: string): Promise<RunRecord[]>
  /** Schedule actual del proceso en segundos (null si no tiene). */
  getScheduleSeconds(processRef: string): Promise<number | null>
  /** Fija/actualiza el schedule del proceso (one-way Mira→motor; idempotente). */
  setScheduleSeconds(processRef: string, seconds: number): Promise<void>
  /** Habilita/deshabilita el schedule del proceso SIN tocar su configuración (pausa/reanudación, #107).
   *  `enabled=false` sin schedule: no-op. `enabled=true` sin schedule: lanza (para habilitar con una
   *  cadencia se usa `setScheduleSeconds`, que la escribe con `enabled: true`). */
  setScheduleEnabled(processRef: string, enabled: boolean): Promise<void>
}
