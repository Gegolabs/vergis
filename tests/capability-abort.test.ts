// Cancelación por timeout (work/052 §4): el Promise.race del Botler no cancelaba a la capability
// perdedora — una query colgada seguía ocupando la conexión. Ahora el Botler pasa un AbortSignal a
// `execute(params, identity, signal)` y lo aborta al vencer el timeout; las capabilities de query
// (fetch de ClickHouse, request de mssql) lo honran soltando el recurso.
import { describe, expect, it } from 'vitest'
import { Botler, VergisError, type Capability, type IdentityContext } from '@vergis/botler'
import { createExecuteSqlClickHouse, type ChQueryRequest } from '@vergis/capabilities'

describe('Botler · AbortSignal en el timeout de capabilities', () => {
  it('capability lenta → al timeout, el signal recibido quedó ABORTADO', async () => {
    let seen: AbortSignal | undefined
    const slow: Capability = {
      name: 'slow-query',
      execute(_params: unknown, _identity: IdentityContext, signal?: AbortSignal): Promise<unknown> {
        seen = signal
        // Simula un fetch colgado que honra la señal: nunca resuelve por sí solo, rechaza al abortar.
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    }
    const botler = new Botler({ capabilityTimeoutMs: 30 })
    botler.start()
    botler.registerCapability(slow)
    await expect(botler.capabilityCall('slow-query', {}, { agent: 'test' })).rejects.toMatchObject({
      structured: { code: 'capability-timeout' },
    })
    expect(seen).toBeDefined()
    expect(seen!.aborted).toBe(true) // la perdedora fue CANCELADA, no abandonada corriendo
    expect(seen!.reason).toBeInstanceOf(VergisError)
  })

  it('capability rápida → el signal NO se aborta', async () => {
    let seen: AbortSignal | undefined
    const fast: Capability = {
      name: 'fast',
      async execute(_p: unknown, _i: IdentityContext, signal?: AbortSignal): Promise<unknown> {
        seen = signal
        return { rows: [] }
      },
    }
    const botler = new Botler({ capabilityTimeoutMs: 1000 })
    botler.start()
    botler.registerCapability(fast)
    await botler.capabilityCall('fast', {}, { agent: 'test' })
    expect(seen?.aborted).toBe(false)
  })

  it('execute-sql-ch propaga el signal hasta el transporte (que lo pasa al fetch)', async () => {
    let got: ChQueryRequest | undefined
    const cap = createExecuteSqlClickHouse(
      { url: 'http://x:8123', user: 'botler' },
      null,
      { transport: async (req) => { got = req; return { rows: [] } } },
    )
    const ac = new AbortController()
    await cap.execute({ sql: 'SELECT 1' }, { agent: 'test' }, ac.signal)
    expect(got?.signal).toBe(ac.signal)
  })
})
