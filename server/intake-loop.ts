/**
 * Lazo de vigilancia del INTAKE (issue #161 — detectar que una carga no completó y avisarle al
 * operador). LAZO HERMANO del de frescura, no una fase suya: la unidad observada es el SLOT (no el
 * proceso), las fuentes de la medida son dos con modos de falla independientes (el ALMACENAMIENTO
 * —listado del landing— y el MOTOR —corridas del trigger—), y no hay reconciliación: por requisito
 * de #161 el lazo detecta y avisa; decidir es de las personas.
 *
 * DOS fases por tick (la tercera, RESOLVER, llega con #162 entre medio):
 *  1 OBSERVAR — por slot: listado del landing + corridas del trigger, y se escribe la proyección
 *               (`IntakeWatchStore`). La observación de un slot es ATÓMICA: si cualquiera de las dos
 *               lecturas falla, se registra el ERROR y lo último conocido queda intacto. Fallar en
 *               medir es un ESTADO, no un vacío.
 *  2 ALERTAR  — dedup por transición, calcado del precedente verificado de `freshness-loop.ts`:
 *               hidratación del estado en el PRIMER TICK (no en el boot), persistencia SOLO en
 *               transición, parser fail-safe (`parseIntakeWatchState`). El aviso se COMPONE
 *               (`composeIntakeAlert`, #100) y sale por el puerto: el lazo NO conoce el canal.
 *
 * La regla que este lazo existe para sostener: **un vigilante que confunde «no hay» con «no veo» es
 * peor que ninguno**. Por eso `'sin-medida'` sale por el MISMO canal que las demás alertas —no es un
 * log— y por eso una lectura fallida clasifica sobre lo último conocido y jamás sobre `[]`.
 *
 * El render (consola de Cargas, tile del dashboard) lee SOLO la proyección: el request path jamás
 * lista OneLake.
 */
import {
  DEFAULT_INTAKE_WATCH_MS,
  DEFAULT_MAX_AGE_MINUTES,
  INTAKE_WATCH_STATE_KEY,
  classifySlot,
  expectedInLanding,
  intakeAlerts,
  parseIntakeWatchState,
  diffAlertState,
  type IntakeSlot,
  type IntakeWatchStore,
  type OneLakeEntry,
  type OneLakeListing,
  type PlatformSettingStore,
  type RetiroRegistrado,
  type RunRecord,
  type SlotAlert,
  type SlotAlertReason,
  type SlotObservation,
  type SlotProjection,
  type SlotWatchConfig,
  type SlotWatchInput,
  type CargaRegistrada,
} from '@vergis/capabilities'
import { composeIntakeAlert, composeIntakeRecovery, type IntakeAlertContext, type Notification } from './notify'

export interface IntakeLoopConfig {
  /** URL pública ya normalizada sin slash final: base de los enlaces profundos del aviso. */
  publicUrl: string
  /** Cadencia del lazo (ms). Es el insumo del umbral de `sin-medida` (3 × poll), no un timer: el
   *  timer lo instala el wiring. */
  pollMs?: number
}

export interface IntakeLoopDeps {
  /** Slots declarados. Función porque el arreglo es VIVO (hot-reload, #50): un slot agregado en
   *  caliente tiene que entrar a la vigilancia sin reconstruir el lazo. */
  slots: () => IntakeSlot[]
  /** Listado del landing del slot, DISTINGUIENDO la ausencia del directorio (`listOrAbsent`). */
  landing: (slot: IntakeSlot) => Promise<OneLakeListing>
  /** Corridas del trigger del slot. AUSENTE = no hay motor cableado: la parte de corridas se omite y
   *  la del landing vigila igual — el listado no necesita motor. */
  runs?: (slot: IntakeSlot) => Promise<RunRecord[]>
  /** Cargas registradas del slot (#62) — insumo del control positivo contra el vacío-con-éxito. */
  uploads?: (slotId: string) => Promise<CargaRegistrada[]>
  /** Retiros manuales del landing. `null` = NO SE PUDO SABER; entonces el control positivo se apaga
   *  para ese slot (una predicción que no descuenta los retiros fabrica contradicciones). */
  retiros?: (slot: IntakeSlot) => Promise<RetiroRegistrado[] | null>
  store: IntakeWatchStore & PlatformSettingStore
  /** Envío del aviso compuesto (#100) — el canal lo decide la config de instancia, no el lazo.
   *  undefined = fase 2 apagada: ni computa ni persiste estado (la proyección se escribe igual). */
  notify?: (n: Notification) => Promise<void>
  /** Dominios DECLARADOS: solo ellos tienen página, y por tanto solo ellos aportan label y enlace. */
  domains: { id: string; label: string }[]
  log: (line: string) => void
  now?: () => number
}

export interface IntakeLoop {
  /** Una vuelta. Re-entrada mientras hay una en vuelo = no-op (guard anti-solape). Nunca lanza. */
  tick(): Promise<void>
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createIntakeLoop(deps: IntakeLoopDeps, cfg: IntakeLoopConfig): IntakeLoop {
  const now = deps.now ?? Date.now
  const pollMs = cfg.pollMs ?? DEFAULT_INTAKE_WATCH_MS
  // El estado de alertas SOBREVIVE al reinicio: vive en el store de gobierno, no en RAM (sin eso,
  // cada restart re-notifica todo lo que siga roto). Se hidrata en el PRIMER TICK, no en el arranque:
  // el lazo no debe demorar el boot ni romperlo si el store todavía no responde.
  let alertState: Record<string, SlotAlertReason> = {}
  let hydrated = false
  // GUARD ANTI-SOLAPE. Además de evitar listados duplicados, es el invariante en el que se apoya el
  // store del desenlace (#162): `setUploadDesenlace` lee-y-escribe sin transacción porque el único
  // escritor es el resolver de ESTE lazo, y este guard garantiza que no hay dos resolviendo a la vez.
  let inFlight = false

  const tick = async (): Promise<void> => {
    if (inFlight) {
      deps.log('intake-loop: tick saltado (vuelta anterior en vuelo)')
      return
    }
    inFlight = true
    try {
      const nowMs = now()
      const nowIso = new Date(nowMs).toISOString()
      const slots = deps.slots()
      const vigilados = slots.filter((s) => watchConfigDe(s) != null)
      if (!vigilados.length) return

      // ── Fase 1 · observar ────────────────────────────────────────────────────────────────────
      const lote: SlotObservation[] = await Promise.all(vigilados.map((s) => observar(s)))
      await deps.store.recordSlotObservations(lote)
      const fallidas = lote.filter((o) => o.error != null)
      for (const o of fallidas) deps.log(`intake-loop: no se pudo observar '${o.slotId}' — ${o.error}`)

      // ── Fase 2 · alertar ─────────────────────────────────────────────────────────────────────
      let notificadas = 0
      if (deps.notify) {
        if (!hydrated) {
          alertState = parseIntakeWatchState(await deps.store.getSetting(INTAKE_WATCH_STATE_KEY))
          hydrated = true
        }
        // La proyección se lee DESPUÉS de escribir el lote: así `firstAttemptAt` ya está sembrado para
        // un slot ciego desde el primer tick (sin baseline, `sin-medida` no cruzaría el umbral jamás).
        const proyeccion = new Map<string, SlotProjection>()
        if (fallidas.length) {
          for (const s of await deps.store.listSlotSnapshots()) {
            const p: SlotProjection = { landing: s.landing, runs: s.runs }
            if (s.observedAt != null) p.observedAt = s.observedAt
            if (s.firstAttemptAt != null) p.firstAttemptAt = s.firstAttemptAt
            proyeccion.set(s.slotId, p)
          }
        }
        const entradas = await Promise.all(
          lote.map(async (obs) => {
            const slot = vigilados.find((s) => s.id === obs.slotId)!
            const input: SlotWatchInput = { slotId: obs.slotId, obs }
            const proj = proyeccion.get(obs.slotId)
            if (proj) input.projection = proj
            const esperados = await controlPositivo(slot, obs)
            if (esperados.length) input.expected = esperados
            return { input, config: watchConfigDe(slot)! }
          }),
        )
        const { notify, recovered, next } = diffAlertState(alertState, intakeAlerts(entradas, nowMs), (a: SlotAlert) => a.slotId)
        const cambio = JSON.stringify(next) !== JSON.stringify(alertState)
        alertState = next
        // Se escribe SOLO en transición: el estado casi nunca cambia y persistir cada vuelta sería
        // escritura pura sin información.
        if (cambio) await deps.store.setSetting(INTAKE_WATCH_STATE_KEY, JSON.stringify(next), 'intake-watch')
        for (const a of notify) await deps.notify(composeIntakeAlert({ ...contextoDe(a.slotId), ...evidencia(a) }))
        for (const sid of recovered) await deps.notify(composeIntakeRecovery(contextoDe(sid)))
        notificadas = notify.length + recovered.length
      }

      // El caso sano no loguea por vuelta: el log del lazo es señal, no latido.
      if (fallidas.length || notificadas)
        deps.log(`intake-loop: ${vigilados.length} slot(s) vigilado(s) · ${fallidas.length} sin medida · ${notificadas} alerta(s)`)
    } catch (e) {
      // El timer no debe morir por una vuelta mala.
      deps.log(`intake-loop: vuelta fallida — ${msg(e)}`)
    } finally {
      inFlight = false
    }
  }

  /** Observación ATÓMICA de un slot: o trae landing (+ corridas si hay motor), o trae error. */
  async function observar(slot: IntakeSlot): Promise<SlotObservation> {
    const observedAt = new Date(now()).toISOString()
    try {
      const [listing, runs] = await Promise.all([
        deps.landing(slot),
        slot.trigger && deps.runs ? deps.runs(slot) : Promise.resolve(undefined),
      ])
      // `absent` (el directorio del landing NO existe) se observa como listado VACÍO, no como error:
      // no hubo fallo de lectura. El caso peligroso —que el registro prediga archivos ahí— lo atrapa
      // el control positivo, que lo clasifica como contradicción y no como «landing vacío».
      const obs: SlotObservation = { slotId: slot.id, observedAt, landing: listing.kind === 'ok' ? listing.entries : [] }
      if (runs) obs.runs = runs
      return obs
    } catch (e) {
      return { slotId: slot.id, observedAt, error: msg(e) }
    }
  }

  /**
   * Control positivo de §3.3: qué archivos DEBERÍA traer el listado según el registro de cargas.
   *
   * Solo se computa cuando este tick leyó las corridas del slot (`obs.runs` presente). Sin ellas no
   * hay CORTE —la última corrida `Completed`, que archivó a `_processed/` lo procesado— y entonces
   * toda carga histórica seguiría «esperándose» para siempre: el primer drenaje legítimo produciría
   * una contradicción falsa. Vale para el slot land-only y para la instancia sin motor cableado.
   * [Es una restricción de ESTE hito sobre §3.3 del diseño, que pide el control también en land-only;
   * sin corte no existe predicción defendible, y una alerta falsa de «lente rota» es exactamente el
   * ruido que #161 quiere evitar.]
   */
  async function controlPositivo(slot: IntakeSlot, obs: SlotObservation): Promise<string[]> {
    if (obs.error != null || obs.runs == null || !deps.uploads) return []
    try {
      const cargas = await deps.uploads(slot.id)
      if (!cargas.length) return []
      // `null` = no se pudo saber qué se retiró. Sin ese descuento la predicción incluiría archivos
      // que un humano sacó a propósito: apagar el control es preferible a acusar una contradicción
      // que no existe.
      const retiros = deps.retiros ? await deps.retiros(slot) : []
      if (retiros == null) return []
      return expectedInLanding(cargas, obs.runs, retiros)
    } catch (e) {
      deps.log(`intake-loop: control positivo de '${slot.id}' no disponible — ${msg(e)}`)
      return []
    }
  }

  /** La evidencia del aviso, tal cual la trae la clasificación (sin re-computar nada). */
  function evidencia(a: SlotAlert): Evidencia {
    const out: Evidencia = { reason: a.reason, medida: a.medida }
    if (a.varados) out.varados = a.varados
    if (a.esperados) out.esperados = a.esperados
    if (a.run) out.run = a.run
    if (a.lastError != null) out.lastError = a.lastError
    return out
  }

  /** Contexto humano + enlazable del slot. Un slot que desapareció de la config (se recupera por
   *  ausencia) todavía tiene que poder avisarse: cae al id. */
  function contextoDe(slotId: string): { slotId: string; slotLabel: string; domainId?: string; domainLabel?: string; baseUrl: string } {
    const slot = deps.slots().find((s) => s.id === slotId)
    // Enlace SOLO con dominio DECLARADO: un slot tageado a un dominio que no está en `domains.yaml`
    // no tiene página, y un enlace a una ruta inexistente sería peor que no traer enlace.
    const decl = slot?.domain ? deps.domains.find((d) => d.id === slot.domain) : undefined
    const ctx: { slotId: string; slotLabel: string; domainId?: string; domainLabel?: string; baseUrl: string } = {
      slotId,
      slotLabel: slot?.label ?? slotId,
      baseUrl: cfg.publicUrl,
    }
    if (decl) {
      ctx.domainId = decl.id
      ctx.domainLabel = decl.label
    }
    return ctx
  }

  /** Umbrales del slot (§4.1). `null` = el slot NO se vigila. */
  function watchConfigDe(slot: IntakeSlot): SlotWatchConfig | null {
    return intakeWatchConfig(slot, pollMs)
  }

  return { tick }
}

/** Lo que la alerta clasificada aporta al aviso compuesto. */
type Evidencia = Pick<IntakeAlertContext, 'reason' | 'medida' | 'varados' | 'esperados' | 'run' | 'lastError'>

/**
 * Umbrales de vigilancia de un slot (§4.1 del diseño), PURA y exportada para el tile del dashboard y
 * los tests.
 *
 * - Slot con `trigger`: vigilado por edad con el default (la carga dispara la conversión, así que
 *   minutos después el landing debe drenar).
 * - Slot land-only: se vigila igual (la medida misma —`sin-medida`— no depende del ritmo de nadie),
 *   pero SIN edad máxima: el consumidor externo tiene su propio ritmo, que el producto no conoce, y
 *   un default inventado fabricaría varados falsos.
 *
 * [El bloque declarativo `watch:` por slot (§4.1: `max_age_minutes`, `max_run_minutes`, `watch:
 * false`) NO está implementado: `IntakeSlot` no lo declara y su parse no vive en este hito. Hasta que
 * exista, los umbrales son los defaults del producto y no hay opt-out por slot.]
 */
export function intakeWatchConfig(slot: IntakeSlot, pollMs: number): SlotWatchConfig | null {
  const cfg: SlotWatchConfig = { pollMs }
  if (slot.trigger) cfg.maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES
  return cfg
}

/** Resumen de la vigilancia para el tile del dashboard (§6.1): `N vigilados · M en alerta · K sin medir`. */
export interface IntakeWatchSummary {
  vigilados: number
  enAlerta: number
  sinMedir: number
}

/**
 * Resume la vigilancia LEYENDO SOLO LA PROYECCIÓN — PURA, sin I/O: el request path del dashboard
 * jamás lista OneLake (invariante de #105 heredada por §3.5).
 *
 * `sinMedir` cuenta al vigilante ciego con el mismo criterio del stale de frescura (`ahora −
 * observedAt > 3 × poll`, verificado `serve-rls.ts:1399`) MÁS los dos casos que no dependen del
 * reloj: nunca medido, y último intento fallido. Con el lazo apagado (`pollMs <= 0`) TODOS cuentan
 * como sin medir: una proyección que nadie refresca no es una medida, es un recuerdo.
 *
 * `enAlerta` excluye `'sin-medida'` a propósito: esa condición ya se cuenta —y se nombra— en
 * `sinMedir`, y sumarla dos veces haría leer «2 problemas» donde hay uno.
 *
 * El control positivo (§3.3) NO participa acá: predecir el landing exige el registro de cargas y las
 * corridas, que son lecturas del lazo. Un slot cuya única alerta es `'contradice-registro'` cuenta
 * en `sinMedir` (su medida no es fresca) pero no en `enAlerta`.
 */
export function summarizeIntakeWatch(
  slots: IntakeSlot[],
  snapshots: { slotId: string; landing: OneLakeEntry[]; runs: RunRecord[]; observedAt: string | null; firstAttemptAt: string | null; lastError: string | null }[],
  pollMs: number,
  nowMs: number,
): IntakeWatchSummary {
  const porSlot = new Map(snapshots.map((s) => [s.slotId, s]))
  let vigilados = 0
  let enAlerta = 0
  let sinMedir = 0
  for (const slot of slots) {
    const config = intakeWatchConfig(slot, pollMs)
    if (!config) continue
    vigilados++
    const s = porSlot.get(slot.id)
    const observedAt = s?.observedAt ?? null
    const stale = pollMs <= 0 || observedAt == null || nowMs - Date.parse(observedAt) > 3 * pollMs
    const ciego = stale || s?.lastError != null
    if (ciego) sinMedir++
    // La observación se RECONSTRUYE desde la proyección: si el último intento falló, se clasifica
    // como fallido (sobre lo último conocido), que es exactamente lo que el lazo hizo.
    const obs: SlotObservation = { slotId: slot.id, observedAt: observedAt ?? '' }
    if (s?.lastError != null || observedAt == null) obs.error = s?.lastError ?? 'sin observación'
    else {
      obs.landing = s?.landing ?? []
      if (s?.runs.length) obs.runs = s.runs
    }
    const input: SlotWatchInput = { slotId: slot.id, obs }
    if (s) {
      const proj: SlotProjection = { landing: s.landing, runs: s.runs }
      if (s.observedAt != null) proj.observedAt = s.observedAt
      if (s.firstAttemptAt != null) proj.firstAttemptAt = s.firstAttemptAt
      input.projection = proj
    }
    if (classifySlot(input, config, nowMs).alertas.some((a) => a.reason !== 'sin-medida')) enAlerta++
  }
  return { vigilados, enAlerta, sinMedir }
}
