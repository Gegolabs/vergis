import { describe, it, expect } from 'vitest'
import { createOneLakeIntake, createOneLakeReader, createFabricJobs, createFabricJobStatus, type TokenSource } from '@vergis/capabilities'

const tokens: TokenSource = { getToken: async () => ({ token: 'BEARER123', expiresAt: Number.MAX_SAFE_INTEGER }) }

interface Call {
  url: string
  method: string
  auth?: string
  hasBody: boolean
}
function recorder(calls: Call[], status = 200) {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      auth: init?.headers?.['authorization'],
      hasBody: init?.body != null,
    })
    return { ok: status < 400, status, text: async () => '' } as unknown as Response
  }) as unknown as typeof fetch
}

describe('intake-onelake · write DFS + run-now', () => {
  it('put: secuencia create → append → flush con bearer y posiciones correctas', async () => {
    const calls: Call[] = []
    const intake = createOneLakeIntake(tokens, { fetch: recorder(calls) })
    const bytes = Buffer.from('hola mundo') // 10 bytes
    await intake.put({ workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' }, 'a b.xlsx', bytes)

    expect(calls).toHaveLength(3)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toContain('/WS/LH/Files/intake/saldos/a%20b.xlsx?resource=file')
    expect(calls[1].method).toBe('PATCH')
    expect(calls[1].url).toContain('?action=append&position=0')
    expect(calls[1].hasBody).toBe(true)
    expect(calls[2].method).toBe('PATCH')
    expect(calls[2].url).toContain(`?action=flush&position=${bytes.byteLength}`)
    expect(calls.every((c) => c.auth === 'Bearer BEARER123')).toBe(true)
  })

  it('put: error DFS → throw con etapa', async () => {
    const intake = createOneLakeIntake(tokens, { fetch: recorder([], 403) })
    await expect(intake.put({ workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' }, 'f.bin', Buffer.from('x'))).rejects.toThrow(/crear falló \(403\)/)
  })

  // Issue #76: el sidecar aterriza ANTES que el archivo (el SJD nunca ve un archivo sin su contexto).
  it('put con sidecar: escribe <archivo>.meta.json ANTES que el archivo', async () => {
    const calls: Call[] = []
    const intake = createOneLakeIntake(tokens, { fetch: recorder(calls) })
    await intake.put({ workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/f' }, 'extracto.xlsx', Buffer.from('datos'), '{"slot":"facturas"}')
    // 6 llamadas: create/append/flush del sidecar (primeras 3) y del archivo (últimas 3).
    expect(calls).toHaveLength(6)
    const createCalls = calls.filter((c) => c.url.includes('?resource=file')).map((c) => c.url)
    expect(createCalls[0]).toContain('/Files/f/extracto.xlsx.meta.json?resource=file') // sidecar primero
    expect(createCalls[1]).toContain('/Files/f/extracto.xlsx?resource=file') // archivo después
    const sidecarIdx = calls.findIndex((c) => c.url.includes('.meta.json?resource=file'))
    const fileIdx = calls.findIndex((c) => c.url.includes('/extracto.xlsx?resource=file'))
    expect(sidecarIdx).toBeLessThan(fileIdx)
  })

  it('put sin sidecar: comportamiento idéntico (3 llamadas, sin .meta.json)', async () => {
    const calls: Call[] = []
    const intake = createOneLakeIntake(tokens, { fetch: recorder(calls) })
    await intake.put({ workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/f' }, 'extracto.xlsx', Buffer.from('datos'))
    expect(calls).toHaveLength(3)
    expect(calls.some((c) => c.url.includes('.meta.json'))).toBe(false)
  })

  it('runNow: POST a jobs/instances con jobType y bearer; 202 es éxito', async () => {
    const calls: Call[] = []
    const jobs = createFabricJobs(tokens, { fetch: recorder(calls, 202) })
    await jobs.runNow({ processRef: 'ITEM1' }, { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/x' })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toContain('/workspaces/WS/items/ITEM1/jobs/instances?jobType=Pipeline')
    expect(calls[0].auth).toBe('Bearer BEARER123')
  })

  it('runNow: sin workspace (ni en trigger ni en target) → throw', async () => {
    const jobs = createFabricJobs(tokens, { fetch: recorder([]) })
    await expect(jobs.runNow({ processRef: 'X' })).rejects.toThrow(/workspaceId/)
  })
})

// Recorder que además sirve un body JSON (el estado consume `res.json()`).
function jsonFetch(value: unknown, status = 200): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string> }) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
    json: async () => value,
    _url: String(url),
    _auth: init?.headers?.['authorization'],
  })) as unknown as typeof fetch
}

describe('intake-onelake · estado de corridas (jobs/instances)', () => {
  it('listInstances: mapea status/tiempos/error, ordena por más reciente y recorta a top', async () => {
    const value = [
      { status: 'InProgress', startTimeUtc: '2026-06-24T10:00:00Z' },
      { status: 'Completed', startTimeUtc: '2026-06-24T09:00:00Z', endTimeUtc: '2026-06-24T09:02:00Z' },
      { status: 'Failed', startTimeUtc: '2026-06-24T08:00:00Z', endTimeUtc: '2026-06-24T08:01:00Z', failureReason: { message: 'boom' } },
    ]
    const status = createFabricJobStatus(tokens, { fetch: jsonFetch({ value }) })
    const runs = await status.listInstances('WS', 'SJD', 2)
    expect(runs).toHaveLength(2) // recortado a top=2
    expect(runs[0].status).toBe('InProgress') // más reciente primero
    expect(runs[0].endedAt).toBeUndefined()
    expect(runs[1].status).toBe('Completed')
    expect(runs[1].endedAt).toBe('2026-06-24T09:02:00Z')
  })

  it('listInstances: status desconocido → NotStarted; failureReason se propaga como error', async () => {
    const value = [
      { status: 'Weird', startTimeUtc: '2026-06-24T10:00:00Z' },
      { status: 'Failed', startTimeUtc: '2026-06-24T07:00:00Z', endTimeUtc: '2026-06-24T07:00:30Z', failureReason: { message: 'mezcla de semanas' } },
    ]
    const status = createFabricJobStatus(tokens, { fetch: jsonFetch({ value }) })
    const runs = await status.listInstances('WS', 'SJD')
    expect(runs[0].status).toBe('NotStarted')
    const failed = runs.find((r) => r.status === 'Failed')!
    expect(failed.error).toBe('mezcla de semanas')
  })

  it('listInstances: sin corridas (value vacío) → []', async () => {
    const status = createFabricJobStatus(tokens, { fetch: jsonFetch({}) })
    expect(await status.listInstances('WS', 'SJD')).toEqual([])
  })

  it('listInstances: error HTTP → throw', async () => {
    const status = createFabricJobStatus(tokens, { fetch: jsonFetch({}, 403) })
    await expect(status.listInstances('WS', 'SJD')).rejects.toThrow(/listInstances falló \(403\)/)
  })
})

// Issue #55: lectura del log de conversión desde el landing (OneLake DFS GET).
describe('intake-onelake · lectura (OneLakeReader)', () => {
  const target = { workspaceId: 'WS', lakehouseId: 'LH' }
  const fetchWith = (status: number, body: string) =>
    (async (url: string, init?: { headers?: Record<string, string> }) => {
      fetchWith.last = { url: String(url), auth: init?.headers?.['authorization'] }
      return { ok: status < 400, status, text: async () => body } as unknown as Response
    }) as unknown as typeof fetch
  fetchWith.last = { url: '', auth: undefined as string | undefined }

  it('read: GET con bearer y path codificado por segmento; devuelve el contenido', async () => {
    const reader = createOneLakeReader(tokens, { fetch: fetchWith(200, '[ingest] ✔ DONE commit W28: 7626 filas') })
    const out = await reader.read(target, 'Files/code/_ingest_log.txt')
    expect(out).toContain('7626 filas')
    expect(fetchWith.last.url).toBe('https://onelake.dfs.fabric.microsoft.com/WS/LH/Files/code/_ingest_log.txt')
    expect(fetchWith.last.auth).toBe('Bearer BEARER123')
  })

  it('read: 404 → null (sin log no es error); otro fallo HTTP → throw', async () => {
    expect(await createOneLakeReader(tokens, { fetch: fetchWith(404, '') }).read(target, 'Files/x.txt')).toBeNull()
    await expect(createOneLakeReader(tokens, { fetch: fetchWith(403, 'denied') }).read(target, 'Files/x.txt')).rejects.toThrow(/leer.*403/)
  })

  it('read: un log largo devuelve la COLA (el diagnóstico vive al final)', async () => {
    const body = 'INICIO-'.padEnd(100_000, 'x') + 'FINAL'
    const out = await createOneLakeReader(tokens, { fetch: fetchWith(200, body) }).read(target, 'Files/x.txt', { maxBytes: 1024 })
    expect(out).toHaveLength(1024)
    expect(out!.endsWith('FINAL')).toBe(true)
    expect(out).not.toContain('INICIO')
  })
})

describe('intake-onelake · listado que distingue la AUSENCIA del vacío (#161·§3.3)', () => {
  const target = { workspaceId: 'WS', lakehouseId: 'LH' }
  const listFetch = (status: number, body: unknown) =>
    (async () => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response) as unknown as typeof fetch
  const PATHS = { paths: [{ name: 'LH/Files/intake/oc/a.xlsx', contentLength: '12', lastModified: 'Wed, 13 Aug 2026 08:00:00 GMT' }] }

  it('listOrAbsent: 404 → absent; 200 vacío → ok con entries vacío (son estados DISTINTOS)', async () => {
    const ausente = await createOneLakeReader(tokens, { fetch: listFetch(404, {}) }).listOrAbsent(target, 'Files/intake/oc')
    expect(ausente).toEqual({ kind: 'absent' })
    const vacio = await createOneLakeReader(tokens, { fetch: listFetch(200, { paths: [] }) }).listOrAbsent(target, 'Files/intake/oc')
    expect(vacio).toEqual({ kind: 'ok', entries: [] })
  })

  it('listOrAbsent: 200 con entradas → ok, con el prefijo del lakehouse recortado y la fecha en ISO', async () => {
    const r = await createOneLakeReader(tokens, { fetch: listFetch(200, PATHS) }).listOrAbsent(target, 'Files/intake/oc')
    expect(r).toEqual({
      kind: 'ok',
      entries: [{ path: 'Files/intake/oc/a.xlsx', isDirectory: false, size: 12, lastModified: '2026-08-13T08:00:00.000Z' }],
    })
  })

  it('listOrAbsent: un error HTTP sigue LANZANDO (no se aplana a absent: no medir es otro estado)', async () => {
    await expect(createOneLakeReader(tokens, { fetch: listFetch(403, {}) }).listOrAbsent(target, 'Files/intake/oc')).rejects.toThrow(/listar.*403/)
  })

  it('list (firma existente) NO cambia: 404 y 200-vacío siguen dando ambos []', async () => {
    expect(await createOneLakeReader(tokens, { fetch: listFetch(404, {}) }).list(target, 'Files/intake/oc')).toEqual([])
    expect(await createOneLakeReader(tokens, { fetch: listFetch(200, { paths: [] }) }).list(target, 'Files/intake/oc')).toEqual([])
    expect(await createOneLakeReader(tokens, { fetch: listFetch(200, PATHS) }).list(target, 'Files/intake/oc')).toEqual([
      { path: 'Files/intake/oc/a.xlsx', isDirectory: false, size: 12, lastModified: '2026-08-13T08:00:00.000Z' },
    ])
  })
})
