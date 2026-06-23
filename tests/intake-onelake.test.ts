import { describe, it, expect } from 'vitest'
import { createOneLakeIntake, createFabricJobs, type TokenProvider } from '@vergis/capabilities'

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
