/**
 * Write-path del intake a OneLake + disparo (run-now) del pipeline en Fabric.
 *
 * OneLake es ADLS Gen2: se escribe por el protocolo DFS (create → append → flush) contra
 * `https://onelake.dfs.fabric.microsoft.com/{workspaceId}/{lakehouseId}/{path}/{filename}`. El crudo
 * aterriza en `Files/...` (landing zone / staging) — NUNCA en `Tables/`; el pipeline existente lee de
 * ahí y produce Bronze→Silver (Mira intermedia, no reemplaza el transform).
 *
 * El run-now dispara el pipeline por Fabric REST. Ambos usan bearer del SP vía `TokenSource`.
 */
import { SCOPE_ONELAKE, SCOPE_FABRIC, type TokenSource } from './aad-token'
import { sidecarName, type IntakeTarget, type IntakeTrigger } from './intake'
import type { RunRecord, RunStatus } from './ingestion-observability'

type FetchLike = typeof fetch

const ONELAKE_HOST = 'https://onelake.dfs.fabric.microsoft.com'
const FABRIC_API = 'https://api.fabric.microsoft.com/v1'

/** Aterriza un archivo crudo en la landing zone OneLake de un Lakehouse. */
export interface OneLakeIntake {
  /**
   * Aterriza el archivo. Con `sidecar` (JSON de metadata, issue #76) lo escribe como
   * `<filename>.meta.json` en el mismo path y **ANTES** que el archivo, de modo que el SJD nunca vea un
   * archivo de datos sin su sidecar. El disparo del trigger ocurre después de todos los `put` (lo hace
   * el caller): así el orden es sidecar → archivo → trigger.
   */
  put(target: IntakeTarget, filename: string, bytes: Uint8Array, sidecar?: string): Promise<void>
}

/**
 * Ruta relativa DFS, codificada POR SEGMENTO con `encodeURIComponent`. `encodeURI` no escapa `?`/`#`,
 * lo que dejaba que un filename con esos caracteres cortara el path o inyectara query params en la
 * request autenticada. El filename se trata como hoja (un solo segmento) — nunca como sub-ruta.
 */
const encodedRelPath = (target: IntakeTarget, filename: string): string =>
  [...target.path.replace(/^\/+|\/+$/g, '').split('/'), filename].map(encodeURIComponent).join('/')

export function createOneLakeIntake(tokens: TokenSource, opts: { fetch?: FetchLike } = {}): OneLakeIntake {
  const doFetch = opts.fetch ?? fetch

  async function auth(): Promise<Record<string, string>> {
    const { token } = await tokens.getToken(SCOPE_ONELAKE)
    return { authorization: `Bearer ${token}` }
  }

  async function writeFile(target: IntakeTarget, filename: string, bytes: Uint8Array, headers: Record<string, string>): Promise<void> {
    const rel = encodedRelPath(target, filename)
    const base = `${ONELAKE_HOST}/${encodeURIComponent(target.workspaceId)}/${encodeURIComponent(target.lakehouseId)}/${rel}`
    const len = bytes.byteLength

    // 1) crear el archivo (vacío). Idempotente: overwrite del mismo nombre.
    const created = await doFetch(`${base}?resource=file`, { method: 'PUT', headers, signal: AbortSignal.timeout(30_000) })
    if (!created.ok) throw await dfsError('crear', created, base)

    // 2) append de los bytes desde la posición 0.
    const appended = await doFetch(`${base}?action=append&position=0`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: bytes as unknown as RequestInit['body'],
      signal: AbortSignal.timeout(30_000),
    })
    if (!appended.ok) throw await dfsError('append', appended, base)

    // 3) flush (commit) hasta la longitud escrita.
    const flushed = await doFetch(`${base}?action=flush&position=${len}`, { method: 'PATCH', headers, signal: AbortSignal.timeout(30_000) })
    if (!flushed.ok) throw await dfsError('flush', flushed, base)
  }

  return {
    async put(target, filename, bytes, sidecar): Promise<void> {
      const headers = await auth()
      // Orden garantizado: el sidecar aterriza ANTES que el archivo. Si el sidecar falla, el archivo no
      // se escribe (el SJD no verá un archivo huérfano); si el archivo falla tras el sidecar, queda un
      // sidecar sin archivo — inocuo (el SJD procesa archivos, no sidecars sueltos).
      if (sidecar != null) await writeFile(target, sidecarName(filename), new TextEncoder().encode(sidecar), headers)
      await writeFile(target, filename, bytes, headers)
    },
  }
}

async function dfsError(stage: string, res: Response, url: string): Promise<Error> {
  const text = await res.text().catch(() => '')
  return new Error(`onelake-intake: ${stage} falló (${res.status}) en ${url.replace(/\?.*$/, '')}: ${text.slice(0, 300)}`)
}

/** Entrada de un listado del Lakehouse (relativa al lakehouse, p. ej. `Files/intake/oc/x.xlsx`). */
export interface OneLakeEntry {
  path: string
  isDirectory: boolean
  size: number
  /** ISO-8601 (del `Last-Modified` DFS). */
  lastModified: string
}

/**
 * Resultado de un listado que NO aplana la ausencia del directorio (#161·§3.3).
 *
 * `list()` mapea 404 → `[]`, así que un `[]` significa a la vez «el directorio está vacío» y «el
 * directorio no existe»: para la consola de cargas da igual (no hay nada que mostrar), pero para el
 * vigilante del intake NO — «el landing no existe» con cargas registradas es una CONTRADICCIÓN, no
 * un landing vacío. El error sigue lanzando en ambas variantes: fallar en medir ya es un estado
 * propio (`SlotObservation.error`), y aplanarlo acá lo borraría.
 */
export type OneLakeListing = { kind: 'ok'; entries: OneLakeEntry[] } | { kind: 'absent' }

/** Operaciones de ARCHIVOS del Lakehouse para la consola de cargas (#55/#57/#58): leer el log,
 * listar el landing, retirar/reactivar archivos (copy+remove — el rename DFS es quisquilloso). */
export interface OneLakeReader {
  /** Contenido del archivo, o null si no existe (404). Otros fallos lanzan. */
  read(target: Pick<IntakeTarget, 'workspaceId' | 'lakehouseId'>, path: string, opts?: { maxBytes?: number }): Promise<string | null>
  /** Bytes crudos del archivo, o null si no existe. */
  readBytes(target: Pick<IntakeTarget, 'workspaceId' | 'lakehouseId'>, path: string): Promise<Uint8Array | null>
  /** Entradas bajo `dir` (no recursivo salvo opts.recursive). `[]` si el dir no existe. */
  list(target: Pick<IntakeTarget, 'workspaceId' | 'lakehouseId'>, dir: string, opts?: { recursive?: boolean }): Promise<OneLakeEntry[]>
  /** Copia intra-lakehouse (read → create/append/flush). */
  copy(target: Pick<IntakeTarget, 'workspaceId' | 'lakehouseId'>, from: string, to: string): Promise<void>
  /** Borra un archivo. No-op silencioso si no existe. */
  remove(target: Pick<IntakeTarget, 'workspaceId' | 'lakehouseId'>, path: string): Promise<void>
}

/**
 * El listado que distingue la ausencia. Va en su PROPIA interfaz, no dentro de `OneLakeReader`:
 * agregarlo allá obligaría a re-implementarlo a todo fake existente de la consola de cargas, que no
 * lo necesita. `createOneLakeReader` devuelve las dos, y el vigilante del intake pide esta.
 */
export interface OneLakeListingReader {
  /** Igual que `list`, pero distingue «el directorio no existe» (`absent`) de «está vacío»
   *  (`{ kind: 'ok', entries: [] }`). Ver `OneLakeListing`. */
  listOrAbsent(target: Pick<IntakeTarget, 'workspaceId' | 'lakehouseId'>, dir: string, opts?: { recursive?: boolean }): Promise<OneLakeListing>
}

export function createOneLakeReader(tokens: TokenSource, opts: { fetch?: FetchLike } = {}): OneLakeReader & OneLakeListingReader {
  const doFetch = opts.fetch ?? fetch
  const auth = async (): Promise<Record<string, string>> => ({ authorization: `Bearer ${(await tokens.getToken(SCOPE_ONELAKE)).token}` })
  const enc = (p: string): string => p.replace(/^\/+|\/+$/g, '').split('/').map(encodeURIComponent).join('/')
  const base = (t: Pick<IntakeTarget, 'workspaceId' | 'lakehouseId'>): string =>
    `${ONELAKE_HOST}/${encodeURIComponent(t.workspaceId)}/${encodeURIComponent(t.lakehouseId)}`

  async function readBytes(target: Pick<IntakeTarget, 'workspaceId' | 'lakehouseId'>, path: string): Promise<Uint8Array | null> {
    const url = `${base(target)}/${enc(path)}`
    const res = await doFetch(url, { headers: await auth(), signal: AbortSignal.timeout(30_000) })
    if (res.status === 404) return null
    if (!res.ok) throw await dfsError('leer', res, url)
    return new Uint8Array(await res.arrayBuffer())
  }

  // Un solo camino de código para las dos variantes de listado: `list` es esta función con la
  // ausencia aplanada a `[]`. Así la forma existente no puede divergir de la que distingue.
  async function listOrAbsent(
    target: Pick<IntakeTarget, 'workspaceId' | 'lakehouseId'>,
    dir: string,
    o: { recursive?: boolean } = {},
  ): Promise<OneLakeListing> {
    // ADLS list: el FILESYSTEM es el workspace; `directory` lleva el lakehouse como primer segmento.
    const dirWithLh = `${target.lakehouseId}/${dir.replace(/^\/+|\/+$/g, '')}`
    const url = `${ONELAKE_HOST}/${encodeURIComponent(target.workspaceId)}?resource=filesystem&recursive=${o.recursive ? 'true' : 'false'}&directory=${encodeURIComponent(dirWithLh)}`
    const res = await doFetch(url, { headers: await auth(), signal: AbortSignal.timeout(30_000) })
    if (res.status === 404) return { kind: 'absent' }
    if (!res.ok) throw await dfsError('listar', res, url)
    const body = (await res.json().catch(() => ({}))) as { paths?: { name?: string; isDirectory?: string | boolean; contentLength?: string | number; lastModified?: string }[] }
    const lhPrefix = `${target.lakehouseId}/`
    const entries = (body.paths ?? []).map((p) => ({
      path: (p.name ?? '').startsWith(lhPrefix) ? (p.name ?? '').slice(lhPrefix.length) : p.name ?? '',
      isDirectory: p.isDirectory === true || p.isDirectory === 'true',
      size: Number(p.contentLength ?? 0),
      lastModified: p.lastModified ? new Date(p.lastModified).toISOString() : '',
    }))
    return { kind: 'ok', entries }
  }

  return {
    async read(target, path, o = {}): Promise<string | null> {
      const url = `${base(target)}/${enc(path)}`
      const res = await doFetch(url, { headers: await auth(), signal: AbortSignal.timeout(30_000) })
      if (res.status === 404) return null
      if (!res.ok) throw await dfsError('leer', res, url)
      const text = await res.text()
      // Cola del archivo (el diagnóstico vive al final): tope defensivo para logs largos.
      const max = o.maxBytes ?? 64 * 1024
      return text.length > max ? text.slice(-max) : text
    },
    readBytes,
    async list(target, dir, o = {}): Promise<OneLakeEntry[]> {
      const r = await listOrAbsent(target, dir, o)
      return r.kind === 'ok' ? r.entries : []
    },
    listOrAbsent,
    async copy(target, from, to): Promise<void> {
      const bytes = await readBytes(target, from)
      if (!bytes) throw new Error(`onelake-intake: copy — el origen '${from}' no existe.`)
      const dst = `${base(target)}/${enc(to)}`
      const headers = await auth()
      const created = await doFetch(`${dst}?resource=file`, { method: 'PUT', headers, signal: AbortSignal.timeout(30_000) })
      if (!created.ok) throw await dfsError('crear', created, dst)
      const appended = await doFetch(`${dst}?action=append&position=0`, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        body: bytes as unknown as RequestInit['body'],
        signal: AbortSignal.timeout(30_000),
      })
      if (!appended.ok) throw await dfsError('append', appended, dst)
      const flushed = await doFetch(`${dst}?action=flush&position=${bytes.byteLength}`, { method: 'PATCH', headers, signal: AbortSignal.timeout(30_000) })
      if (!flushed.ok) throw await dfsError('flush', flushed, dst)
    },
    async remove(target, path): Promise<void> {
      const url = `${base(target)}/${enc(path)}`
      const res = await doFetch(url, { method: 'DELETE', headers: await auth(), signal: AbortSignal.timeout(30_000) })
      if (res.status === 404) return
      if (!res.ok) throw await dfsError('borrar', res, url)
    },
  }
}

/** Dispara pipelines de Fabric (run-now) — land-and-trigger del intake. */
export interface FabricJobs {
  runNow(trigger: IntakeTrigger, target?: IntakeTarget): Promise<void>
}

export function createFabricJobs(tokens: TokenSource, opts: { fetch?: FetchLike } = {}): FabricJobs {
  const doFetch = opts.fetch ?? fetch
  return {
    async runNow(trigger, target): Promise<void> {
      const ws = trigger.workspaceId ?? target?.workspaceId
      if (!ws) throw new Error('fabric-jobs: run-now sin workspaceId (ni en trigger ni en target).')
      const jobType = trigger.jobType ?? 'Pipeline'
      const { token } = await tokens.getToken(SCOPE_FABRIC)
      const url = `${FABRIC_API}/workspaces/${encodeURIComponent(ws)}/items/${encodeURIComponent(trigger.processRef)}/jobs/instances?jobType=${encodeURIComponent(jobType)}`
      const res = await doFetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
      // 202 Accepted es el éxito esperado (job encolado).
      if (!res.ok && res.status !== 202) {
        const text = await res.text().catch(() => '')
        throw new Error(`fabric-jobs: run-now falló (${res.status}) para item '${trigger.processRef}': ${text.slice(0, 300)}`)
      }
    },
  }
}

/**
 * Lado de LECTURA del mismo endpoint `jobs/instances` que `runNow` dispara: el historial de corridas
 * de un item Fabric (un SJD/pipeline). Mapea la respuesta nativa al `RunRecord` agnóstico de la
 * observabilidad, para que la UI muestre «Procesando → Listo/Falló» sin conocer la forma de Fabric.
 */
export interface FabricJobStatus {
  /** Últimas corridas del item (más reciente primero), recortadas a `top`. */
  listInstances(workspaceId: string, itemId: string, top?: number): Promise<RunRecord[]>
}

/** Forma (parcial) de un *job instance* de Fabric — solo los campos que consumimos. */
interface FabricJobInstance {
  status?: string
  startTimeUtc?: string
  endTimeUtc?: string | null
  failureReason?: { message?: string; errorCode?: string } | null
}

const RUN_STATUSES: ReadonlySet<string> = new Set<RunStatus>([
  'Completed', 'Failed', 'InProgress', 'NotStarted', 'Cancelled', 'Deduped',
])
const toRunStatus = (s: string | undefined): RunStatus => (s && RUN_STATUSES.has(s) ? (s as RunStatus) : 'NotStarted')

export function createFabricJobStatus(tokens: TokenSource, opts: { fetch?: FetchLike } = {}): FabricJobStatus {
  const doFetch = opts.fetch ?? fetch
  return {
    async listInstances(workspaceId, itemId, top = 5): Promise<RunRecord[]> {
      const { token } = await tokens.getToken(SCOPE_FABRIC)
      const url = `${FABRIC_API}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/jobs/instances`
      const res = await doFetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`fabric-job-status: listInstances falló (${res.status}) para item '${itemId}': ${text.slice(0, 300)}`)
      }
      const body = (await res.json().catch(() => ({}))) as { value?: FabricJobInstance[] }
      const runs: RunRecord[] = (body.value ?? []).map((j) => {
        const rec: RunRecord = { startedAt: j.startTimeUtc ?? '', status: toRunStatus(j.status) }
        if (j.endTimeUtc) rec.endedAt = j.endTimeUtc
        if (j.failureReason?.message) rec.error = j.failureReason.message
        return rec
      })
      // Orden defensivo (no asumimos el orden del backend): más reciente primero.
      runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      return runs.slice(0, Math.max(0, top))
    },
  }
}
