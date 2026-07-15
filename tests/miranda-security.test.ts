import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAnthropicTransport, buildSystemPrompt, MIRANDA_HARD_RULES, guardProbeSql, SqlGuardError } from '@vergis/miranda'

afterEach(() => vi.unstubAllGlobals())

describe('WP7 seguridad · la API key jamás en el body/transcript', () => {
  it('fetchAnthropicTransport pone la key en la cabecera x-api-key, nunca en el body', async () => {
    const KEY = 'sk-ant-secreto-de-prueba'
    const fetchMock = vi.fn(async () => ({ ok: true, async json() { return { id: 'm', role: 'assistant', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } } }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const tp = fetchAnthropicTransport({ apiKey: KEY })
    await tp.createMessage({ model: 'm', messages: [{ role: 'user', content: 'hola' }], max_tokens: 10 })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY)
    expect(String(init.body)).not.toContain(KEY) // la key no viaja en el payload
  })
})

describe('WP7 seguridad · el system prompt no filtra secretos', () => {
  it('buildSystemPrompt (y las reglas duras) no contienen tokens tipo sk-', () => {
    const sys = buildSystemPrompt({ dslDoc: 'DSL de ejemplo' })
    expect(sys).not.toMatch(/sk-[a-z0-9]/i)
    expect(MIRANDA_HARD_RULES).toContain('authz-blind')
    expect(MIRANDA_HARD_RULES).toContain('PROHIBIDO')
  })
})

describe('WP7 seguridad · fuzz de la guardia SQL', () => {
  const ALLOW = ['dbo.v_saldos']
  const payloads = [
    "SELECT * FROM dbo.v_saldos WHERE 1=1; DROP TABLE dbo.v_saldos",
    "SELECT * FROM dbo.v_saldos UNION SELECT * FROM sys.tables",
    "SELECT * FROM dbo.v_saldos; EXEC xp_cmdshell 'dir'",
    "select * from dbo.v_saldos into #t",
    "SELECT * FROM dbo.v_saldos /*!*/ WHERE 1=1",
    "SELECT * FROM master.dbo.sysusers",
    "SELECT * FROM dbo.v_saldos WHERE x = (SELECT name FROM sys.databases)",
    "WITH e AS (SELECT 1) SELECT * FROM dbo.v_saldos",
    "SELECT * FROM dbo.v_saldos; SELECT SLEEP(10)",
    "UPDATE dbo.v_saldos SET saldo=0 WHERE 1=1",
  ]
  it('todo payload malicioso se rechaza', () => {
    for (const p of payloads) {
      expect(() => guardProbeSql(p, { allowlist: ALLOW }), p).toThrow(SqlGuardError)
    }
  })
  it('las lecturas legítimas siempre salen con TOP forzado ≤ 500', () => {
    const g = guardProbeSql('SELECT empresa FROM dbo.v_saldos WHERE saldo > 0 ORDER BY empresa', { allowlist: ALLOW })
    expect(g.sql).toMatch(/^SELECT TOP 500 /)
  })
})
