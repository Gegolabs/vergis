/**
 * Implementación Fabric de la COSTURA `IngestionEngineClient` (ver `ingestion-observability.ts`): leer
 * el run-history de un proceso y empujar/leer su schedule. Es "la conexión" que cierra el frente B.
 *
 * Dos lados, mismo Service Principal (`TokenSource` / `SCOPE_FABRIC`, el del intake):
 *  · LECTURA de corridas  → reusa `createFabricJobStatus.listInstances` (endpoint `jobs/instances`).
 *  · SCHEDULE (get/set)   → API de Job Scheduler de Fabric (`jobs/{jobType}/schedules`).
 *
 * Un proceso se ejecuta como un ITEM del motor (pipeline/SJD/notebook); el `EngineRef`
 * (workspace+item+jobType) es lo que conecta el proceso de gobierno con su item Fabric. Un proceso sin
 * `EngineRef` no es observable: `listRunHistory` → [], `getScheduleSeconds` → null, `set` → lanza.
 */
import { SCOPE_FABRIC, type TokenSource } from './aad-token'
import { createFabricJobStatus } from './intake-onelake'
import type { EngineRef } from './governance-store'
import type { IngestionEngineClient, RunRecord } from './ingestion-observability'

type FetchLike = typeof fetch
type Clock = () => number

const FABRIC_API = 'https://api.fabric.microsoft.com/v1'
const RUN_HISTORY_TOP = 10

/** Forma (parcial) de un schedule de Fabric — solo lo que consumimos. */
interface FabricSchedule {
  id: string
  enabled?: boolean
  configuration?: {
    type?: 'Cron' | 'Daily' | 'Weekly'
    interval?: number // minutos (solo Cron)
  }
}

/** segundos → minutos de intervalo Cron (mínimo 1; los redondeos coarse de demanda ya son múltiplos de 60). */
// floor, no round: redondear hacia arriba dejaría el schedule MENOS frecuente que la cadencia
// requerida (90s → 2min). Hacia abajo es más frecuente — nunca incumple la demanda. Mínimo 1 min.
const secondsToIntervalMinutes = (seconds: number): number => Math.max(1, Math.floor(seconds / 60))

/** configuración de schedule de Fabric → segundos aproximados (Cron exacto; Daily/Weekly aproximado). */
function scheduleToSeconds(s: FabricSchedule): number | null {
  const cfg = s.configuration
  if (!cfg) return null
  if (cfg.type === 'Cron' && typeof cfg.interval === 'number') return cfg.interval * 60
  if (cfg.type === 'Daily') return 86_400
  if (cfg.type === 'Weekly') return 604_800
  return null
}

/** Cliente de schedule de Fabric (Job Scheduler API). Get/set idempotente del intervalo de un item. */
export interface FabricScheduler {
  getScheduleSeconds(engine: EngineRef): Promise<number | null>
  setScheduleSeconds(engine: EngineRef, seconds: number): Promise<void>
}

export function createFabricScheduler(tokens: TokenSource, opts: { fetch?: FetchLike; now?: Clock } = {}): FabricScheduler {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now

  const schedulesUrl = (e: EngineRef): string =>
    `${FABRIC_API}/workspaces/${encodeURIComponent(e.workspaceId)}/items/${encodeURIComponent(e.itemId)}/jobs/${encodeURIComponent(e.jobType)}/schedules`

  async function listSchedules(e: EngineRef): Promise<FabricSchedule[]> {
    const { token } = await tokens.getToken(SCOPE_FABRIC)
    const res = await doFetch(schedulesUrl(e), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`fabric-scheduler: list falló (${res.status}) para item '${e.itemId}': ${text.slice(0, 300)}`)
    }
    const body = (await res.json().catch(() => ({}))) as { value?: FabricSchedule[] }
    return body.value ?? []
  }

  /** Cuerpo de un schedule Cron que corre cada `seconds`, desde ahora hasta lejos en el futuro, en UTC. */
  function cronBody(seconds: number): unknown {
    const start = new Date(now())
    const end = new Date(now() + 50 * 365 * 86_400_000) // ~50 años
    const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, '') // Fabric espera sin milis ni 'Z'
    return {
      enabled: true,
      configuration: {
        type: 'Cron',
        interval: secondsToIntervalMinutes(seconds),
        startDateTime: iso(start),
        endDateTime: iso(end),
        localTimeZoneId: 'UTC',
      },
    }
  }

  return {
    async getScheduleSeconds(engine): Promise<number | null> {
      const all = await listSchedules(engine)
      const active = all.find((s) => s.enabled) ?? all[0]
      return active ? scheduleToSeconds(active) : null
    },

    async setScheduleSeconds(engine, seconds): Promise<void> {
      const { token } = await tokens.getToken(SCOPE_FABRIC)
      const existing = await listSchedules(engine)
      const target = existing.find((s) => s.enabled) ?? existing[0]
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      const body = JSON.stringify(cronBody(seconds))
      // PATCH si ya hay un schedule (idempotente); POST si es el primero.
      const res = target
        ? await doFetch(`${schedulesUrl(engine)}/${encodeURIComponent(target.id)}`, { method: 'PATCH', headers, body, signal: AbortSignal.timeout(30_000) })
        : await doFetch(schedulesUrl(engine), { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) })
      if (!res.ok && res.status !== 201 && res.status !== 202) {
        const text = await res.text().catch(() => '')
        throw new Error(`fabric-scheduler: set falló (${res.status}) para item '${engine.itemId}': ${text.slice(0, 300)}`)
      }
    },
  }
}

/** Resuelve el `EngineRef` de un proceso por su id (snapshot del registro de procesos). */
export type EngineResolver = (processRef: string) => Promise<EngineRef | undefined>

/**
 * Ensambla el `IngestionEngineClient` concreto sobre Fabric: el run-history (vía `jobs/instances`) y el
 * schedule (vía Job Scheduler API), resolviendo `processRef` → `EngineRef` con el registro de procesos.
 * Un proceso sin `EngineRef` no es observable (devuelve vacío/null; `set` lanza con mensaje claro).
 */
export function createFabricEngineClient(
  tokens: TokenSource,
  resolveEngine: EngineResolver,
  opts: { fetch?: FetchLike; now?: Clock } = {},
): IngestionEngineClient {
  const status = createFabricJobStatus(tokens, opts)
  const scheduler = createFabricScheduler(tokens, opts)
  return {
    async listRunHistory(processRef): Promise<RunRecord[]> {
      const e = await resolveEngine(processRef)
      if (!e) return []
      return status.listInstances(e.workspaceId, e.itemId, RUN_HISTORY_TOP)
    },
    async getScheduleSeconds(processRef): Promise<number | null> {
      const e = await resolveEngine(processRef)
      if (!e) return null
      return scheduler.getScheduleSeconds(e)
    },
    async setScheduleSeconds(processRef, seconds): Promise<void> {
      const e = await resolveEngine(processRef)
      if (!e) throw new Error(`fabric-engine: el proceso '${processRef}' no tiene engine_ref; no se puede fijar schedule.`)
      await scheduler.setScheduleSeconds(e, seconds)
    },
  }
}
