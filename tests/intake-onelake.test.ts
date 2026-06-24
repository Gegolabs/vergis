import { describe, it, expect } from 'vitest'
import { createOneLakeIntake, createFabricJobs, createFabricJobStatus, type TokenProvider } from '@vergis/capabilities'

const tokens: TokenProvider = { getToken: async () => 'BEARER123' }

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
