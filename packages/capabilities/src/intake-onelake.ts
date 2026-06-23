/**
 * Write-path del intake a OneLake + disparo (run-now) del pipeline en Fabric.
 *
 * OneLake es ADLS Gen2: se escribe por el protocolo DFS (create → append → flush) contra
 * `https://onelake.dfs.fabric.microsoft.com/{workspaceId}/{lakehouseId}/{path}/{filename}`. El crudo
 * aterriza en `Files/...` (landing zone / staging) — NUNCA en `Tables/`; el pipeline existente lee de
 * ahí y produce Bronze→Silver (Mira intermedia, no reemplaza el transform).
 *
 * El run-now dispara el pipeline por Fabric REST. Ambos usan bearer del SP vía `TokenProvider`.
 */
import { SCOPE_ONELAKE, SCOPE_FABRIC, type TokenProvider } from './aad-token'
import type { IntakeTarget, IntakeTrigger } from './intake'

type FetchLike = typeof fetch

const ONELAKE_HOST = 'https://onelake.dfs.fabric.microsoft.com'
const FABRIC_API = 'https://api.fabric.microsoft.com/v1'

/** Aterriza un archivo crudo en la landing zone OneLake de un Lakehouse. */
export interface OneLakeIntake {
  put(target: IntakeTarget, filename: string, bytes: Uint8Array): Promise<void>
}

const joinPath = (target: IntakeTarget, filename: string): string =>
  `${target.path.replace(/^\/+|\/+$/g, '')}/${filename}`

export function createOneLakeIntake(tokens: TokenProvider, opts: { fetch?: FetchLike } = {}): OneLakeIntake {
  const doFetch = opts.fetch ?? fetch

  async function auth(): Promise<Record<string, string>> {
    const token = await tokens.getToken(SCOPE_ONELAKE)
    return { authorization: `Bearer ${token}` }
  }

  return {
    async put(target, filename, bytes): Promise<void> {
      const rel = encodeURI(joinPath(target, filename))
      const base = `${ONELAKE_HOST}/${encodeURIComponent(target.workspaceId)}/${encodeURIComponent(target.lakehouseId)}/${rel}`
      const headers = await auth()
      const len = bytes.byteLength

      // 1) crear el archivo (vacío). Idempotente: overwrite del mismo nombre.
      const created = await doFetch(`${base}?resource=file`, { method: 'PUT', headers })
      if (!created.ok) throw await dfsError('crear', created, base)

      // 2) append de los bytes desde la posición 0.
      const appended = await doFetch(`${base}?action=append&position=0`, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        body: bytes as unknown as RequestInit['body'],
      })
      if (!appended.ok) throw await dfsError('append', appended, base)

      // 3) flush (commit) hasta la longitud escrita.
      const flushed = await doFetch(`${base}?action=flush&position=${len}`, { method: 'PATCH', headers })
      if (!flushed.ok) throw await dfsError('flush', flushed, base)
    },
  }
}

async function dfsError(stage: string, res: Response, url: string): Promise<Error> {
  const text = await res.text().catch(() => '')
  return new Error(`onelake-intake: ${stage} falló (${res.status}) en ${url.replace(/\?.*$/, '')}: ${text.slice(0, 300)}`)
}

/** Dispara pipelines de Fabric (run-now) — land-and-trigger del intake. */
export interface FabricJobs {
  runNow(trigger: IntakeTrigger, target?: IntakeTarget): Promise<void>
}

export function createFabricJobs(tokens: TokenProvider, opts: { fetch?: FetchLike } = {}): FabricJobs {
  const doFetch = opts.fetch ?? fetch
  return {
    async runNow(trigger, target): Promise<void> {
      const ws = trigger.workspaceId ?? target?.workspaceId
      if (!ws) throw new Error('fabric-jobs: run-now sin workspaceId (ni en trigger ni en target).')
      const jobType = trigger.jobType ?? 'Pipeline'
      const token = await tokens.getToken(SCOPE_FABRIC)
      const url = `${FABRIC_API}/workspaces/${encodeURIComponent(ws)}/items/${encodeURIComponent(trigger.processRef)}/jobs/instances?jobType=${encodeURIComponent(jobType)}`
      const res = await doFetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
      // 202 Accepted es el éxito esperado (job encolado).
      if (!res.ok && res.status !== 202) {
        const text = await res.text().catch(() => '')
        throw new Error(`fabric-jobs: run-now falló (${res.status}) para item '${trigger.processRef}': ${text.slice(0, 300)}`)
      }
    },
  }
}
