/**
 * Lazo de control de Frescura (issue #105 — P-31 parte 2). UN lazo, tres fases por tick:
 *  1 OBSERVAR  — leer run-history + schedule de cada proceso observable y escribir la proyección
 *                (`ingestion_run`) POR LOTE. Ante fallo por proceso: error registrado, lo último
 *                conocido intacto (la proyección SIRVE lo último conocido).
 *  2 ALERTAR   — detección de fallidas/faltantes con dedup por transición: hidrata el estado en el
 *                primer tick, persiste SOLO en transición, `parseAlertState` fail-safe. Clasifica
 *                sobre lo observado o, si la lectura falló, sobre lo último conocido (no sobre []).
 *  3 RECONCILIAR — reconcilePlan(desired, actual) con DEBOUNCE: no re-empujar el mismo desired al
 *                mismo proceso dentro de la ventana (el motor redondea el schedule a minutos y un
 *                desired que no es múltiplo de 60 no converge JAMÁS — fabric-engine.ts); un desired
 *                que cambia empuja ya. Tras un set exitoso se RE-OBSERVA el schedule y se registra
 *                lo leído, nunca lo prometido: el motor puede haber redondeado.
 * El render de Frescura lee SOLO la proyección: el request path jamás toca el motor.
 *
 * PAUSA (#107): la pausa apaga la ALERTA y el RECONCILE, nunca la OBSERVACIÓN. Un proceso que un
 * steward pausó a propósito sigue siendo observable (sus corridas y su schedule se proyectan igual),
 * pero no produce `missed` —sería ruido que entrena a ignorar alertas— y el lazo jamás le re-habilita
 * el schedule que alguien apagó a mano.
 */
import type { LogEventInput } from '@vergis/botler'
import {
  deriveIngestionMap,
  freshnessAlerts,
  diffAlertState,
  parseAlertState,
  reconcilePlan,
  FRESHNESS_ALERT_STATE_KEY,
  type IngestionEngineClient,
  type RunRecord,
  type ProcessRow,
  type DeriveMapInput,
  type IngestionRunStore,
  type ProcessObservation,
  type PlatformSettingStore,
} from '@vergis/capabilities'

export interface FreshnessLoopConfig {
  /** Fase 3 encendida (VERGIS_RECONCILE_AUTO). */
  reconcile: boolean
  /** Ventana de debounce del re-push (VERGIS_RECONCILE_DEBOUNCE_MS). */
  reconcileDebounceMs: number
}

export interface FreshnessLoopDeps {
  engine: IngestionEngineClient
  store: IngestionRunStore & PlatformSettingStore
  /** El MISMO freshnessInputs del wiring (procs + insumo del mapa). */
  inputs: () => Promise<{ procs: ProcessRow[]; mapInput: DeriveMapInput }>
  /** Push de alerta (Slack). undefined = fase 2 apagada (sin webhook): ni computa ni persiste estado. */
  postAlert?: (text: string) => Promise<void>
  audit: (e: LogEventInput) => void
  log: (line: string) => void
  now?: () => number
}

export interface FreshnessLoop {
  /** Una vuelta. Re-entrada mientras hay una en vuelo = no-op (guard anti-solape). Nunca lanza. */
  tick(): Promise<void>
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createFreshnessLoop(deps: FreshnessLoopDeps, cfg: FreshnessLoopConfig): FreshnessLoop {
  const now = deps.now ?? Date.now
  // El estado de alertas SOBREVIVE al reinicio (P-31): vive en el store de gobierno, no en RAM. Se
  // hidrata en el PRIMER TICK (no en el arranque: el lazo no debe demorar el boot ni romperlo si el
  // store todavía no responde).
  let alertState: Record<string, 'failed' | 'missed'> = {}
  let hydrated = false
  // Debounce del reconcile: último `desired` empujado a cada proceso y cuándo.
  const lastPush = new Map<string, { desiredSeconds: number; atMs: number }>()
  let inFlight = false

  const tick = async (): Promise<void> => {
    if (inFlight) {
      deps.log('frescura-loop: tick saltado (vuelta anterior en vuelo)')
      return
    }
    inFlight = true
    try {
      const nowMs = now()
      const nowIso = new Date(nowMs).toISOString()
      const { procs, mapInput } = await deps.inputs()
      const observables = procs.filter((p) => p.engine)
      // Los pausados (#107) se observan igual; quedan fuera de las fases 2 y 3.
      const pausados = new Set(procs.filter((p) => p.pausedAt != null).map((p) => p.id))
      const reqOf = new Map(deriveIngestionMap(mapInput).map((m) => [m.processId, m.requiredCadenceSeconds]))

      // ── Fase 1 · observar ────────────────────────────────────────────────────────────────────
      // La observación de un proceso es ATÓMICA: si cualquiera de las dos lecturas falla, se registra
      // el error y no se escribe un snapshot mitad viejo mitad nuevo.
      const lote: ProcessObservation[] = await Promise.all(
        observables.map(async (p): Promise<ProcessObservation> => {
          try {
            const [runs, scheduleSeconds] = await Promise.all([deps.engine.listRunHistory(p.id), deps.engine.getScheduleSeconds(p.id)])
            return { processId: p.id, observedAt: nowIso, runs, scheduleSeconds }
          } catch (e) {
            return { processId: p.id, observedAt: nowIso, error: msg(e) }
          }
        }),
      )
      await deps.store.recordObservations(lote)
      const fallidas = lote.filter((o) => o.error != null)
      for (const o of fallidas) deps.log(`frescura-loop: no se pudo observar '${o.processId}' — ${o.error}`)

      // ── Fase 2 · alertar ─────────────────────────────────────────────────────────────────────
      let notificadas = 0
      if (deps.postAlert) {
        if (!hydrated) {
          alertState = parseAlertState(await deps.store.getSetting(FRESHNESS_ALERT_STATE_KEY))
          hydrated = true
        }
        // Con lecturas fallidas, la clasificación va sobre lo ÚLTIMO CONOCIDO: un motor caído no
        // fabrica `missed` (eso sería un falso positivo), y el `missed` REAL dispara igual porque la
        // edad se computa contra el reloj sobre las corridas viejas proyectadas.
        const proyectadas = fallidas.length
          ? new Map((await deps.store.listRunSnapshots()).map((s) => [s.processId, s.runs]))
          : new Map<string, RunRecord[]>()
        const clasificables = lote.filter((o) => !pausados.has(o.processId)).map((o) => ({
          processId: o.processId,
          runs: o.error != null ? (proyectadas.get(o.processId) ?? []) : (o.runs ?? []),
          requiredCadenceSeconds: reqOf.get(o.processId) ?? Number.POSITIVE_INFINITY,
        }))
        const { notify, recovered: recovNoPausa, next } = diffAlertState(alertState, freshnessAlerts(clasificables, nowMs))
        // Pausar no es «recuperarse»: un proceso pausado sale de la clasificación, así que su estado
        // previo se CONSERVA tal cual y no se anuncia recuperación que nadie observó. Al reanudarlo, el
        // dedup sigue valiendo (si seguía fallando no se re-notifica; si se arregló, ahí sí recupera).
        const recovered = recovNoPausa.filter((pid) => !pausados.has(pid))
        for (const pid of recovNoPausa) if (pausados.has(pid)) next[pid] = alertState[pid]
        const cambio = JSON.stringify(next) !== JSON.stringify(alertState)
        alertState = next
        // Se escribe SOLO en transición: el tick corre cada pocos minutos y el estado casi nunca
        // cambia; persistir en cada vuelta sería escritura pura sin información.
        if (cambio) await deps.store.setSetting(FRESHNESS_ALERT_STATE_KEY, JSON.stringify(next), 'freshness-monitor')
        for (const a of notify) await deps.postAlert(`:warning: *Frescura* — proceso \`${a.processId}\` ${a.reason === 'failed' ? 'falló' : 'atrasada (no corre a tiempo)'}${a.lastError ? ` — ${a.lastError}` : ''}`)
        for (const pid of recovered) await deps.postAlert(`:white_check_mark: *Frescura* — proceso \`${pid}\` recuperado`)
        notificadas = notify.length + recovered.length
      }

      // ── Fase 3 · reconciliar ─────────────────────────────────────────────────────────────────
      let empujados = 0
      if (cfg.reconcile) {
        const reobs: ProcessObservation[] = []
        for (const o of lote) {
          if (o.error != null) continue
          // El lazo JAMÁS re-habilita lo que un steward pausó (#107).
          if (pausados.has(o.processId)) continue
          const desired = reqOf.get(o.processId)
          if (desired == null) continue
          if (reconcilePlan(desired, o.scheduleSeconds ?? null).action !== 'set') continue
          const prev = lastPush.get(o.processId)
          const debounced = prev != null && prev.desiredSeconds === desired && nowMs - prev.atMs < cfg.reconcileDebounceMs
          if (debounced) continue
          try {
            await deps.engine.setScheduleSeconds(o.processId, desired)
          } catch (e) {
            deps.log(`frescura-loop: no se pudo fijar el schedule de '${o.processId}' — ${msg(e)}`)
            continue
          }
          lastPush.set(o.processId, { desiredSeconds: desired, atMs: nowMs })
          empujados++
          deps.audit({ type: 'frescura-reconcile', process: o.processId, by: 'frescura-loop', desiredSeconds: desired, action: 'set' })
          deps.log(`frescura-loop: schedule de '${o.processId}' corregido a ${desired}s`)
          // Se registra lo RE-OBSERVADO, nunca lo prometido: el motor puede redondear.
          const re = await deps.engine.getScheduleSeconds(o.processId).catch(() => undefined)
          if (re !== undefined) reobs.push({ processId: o.processId, observedAt: new Date(now()).toISOString(), scheduleSeconds: re, runs: [] })
        }
        if (reobs.length) await deps.store.recordObservations(reobs)
      }

      // El caso sano no loguea por vuelta: el log del lazo es señal, no latido.
      if (fallidas.length || empujados || notificadas)
        deps.log(`frescura-loop: ${observables.length} procesos · ${fallidas.length} sin respuesta · ${empujados} schedule(s) corregido(s) · ${notificadas} alerta(s)`)
    } catch (e) {
      // El timer no debe morir por una vuelta mala.
      deps.log(`frescura-loop: vuelta fallida — ${msg(e)}`)
    } finally {
      inFlight = false
    }
  }

  return { tick }
}
