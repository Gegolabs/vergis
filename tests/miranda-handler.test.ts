import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createMiranda, type MirandaServerDeps } from '../server/miranda'
import { csrfFactory } from '../server/ui'
import { SqliteGovernanceStore } from '@vergis/capabilities'
import type { AnthropicTransport, AnthropicResponse } from '@vergis/miranda'

const SECRET = 'test-secret'
const EMAIL = 'ana@x.com'
const token = csrfFactory(SECRET)(EMAIL)

function mkReq(url: string, method = 'GET', body?: Record<string, string>): IncomingMessage {
  const payload = body ? new URLSearchParams(body).toString() : ''
  const req = Readable.from([payload]) as unknown as IncomingMessage
  req.url = url
  req.method = method
  req.headers = {}
  return req
}
function mkRes() {
  const calls: { status: number; body: string; headers: Record<string, string> } = { status: 0, body: '', headers: {} }
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))
  const res = {
    writeHead: (code: number, headers?: Record<string, string>) => {
      calls.status = code
      if (headers) calls.headers = headers
    },
    end: (b?: string) => {
      calls.body = b ?? ''
      resolveDone()
    },
  } as unknown as ServerResponse
  return { res, calls, done }
}

const textResp = (t: string): AnthropicResponse => ({ id: 'm', role: 'assistant', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } })

async function build(over: Partial<MirandaServerDeps> = {}, transport?: AnthropicTransport) {
  const gov = await SqliteGovernanceStore.open(null)
  const tp: AnthropicTransport = transport ?? { async createMessage() { return textResp('¿Qué PI quieres crear?') } }
  const deps: MirandaServerDeps = {
    gov,
    transport: tp,
    model: 'm',
    systemPrompt: 'sys',
    maxTurns: 5,
    tokenBudget: 100000,
    catalog: [{ name: 'dbo.v_saldos' }],
    identityOf: () => ({ user: EMAIL }),
    hasScope: async () => true,
    isAdmin: async () => false,
    probe: async () => ({ rows: [] }),
    columnsOf: async () => [],
    validateDraft: () => ({ ok: true }),
    listSpecs: () => [],
    readSpec: () => null,
    writeSpec: async () => {},
    renderPreviewHtml: async () => '<html>PREVIEW</html>',
    secret: SECRET,
    ...over,
  }
  return { gov, handler: createMiranda(deps), deps }
}

describe('WP4 · scope gate', () => {
  it('sin scope → 403 en cualquier ruta /miranda', async () => {
    const { handler } = await build({ hasScope: async () => false })
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda'), res)
    await done
    expect(calls.status).toBe(403)
    expect(calls.body).toContain('scope')
  })
  it('ruta ajena → tryHandle devuelve false', async () => {
    const { handler } = await build()
    const { res } = mkRes()
    expect(await handler.tryHandle(mkReq('/otra'), res)).toBe(false)
  })
})

describe('WP4 · ciclo básico', () => {
  it('GET /miranda lista (vacía) para el usuario con scope', async () => {
    const { handler } = await build()
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toContain('Nueva sesión')
  })
  it('POST /miranda/api/new crea sesión y redirige', async () => {
    const { gov, handler } = await build()
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/new', 'POST', { _csrf: token, title: 'Saldos' }), res)
    await done
    expect(calls.status).toBe(303)
    expect(calls.headers.location).toMatch(/^\/miranda\/s\//)
    const sessions = await gov.listMirandaSessions(EMAIL)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('Saldos')
  })
  it('CSRF inválido → 403', async () => {
    const { handler } = await build()
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/new', 'POST', { _csrf: 'malo', title: 'x' }), res)
    await done
    expect(calls.status).toBe(403)
  })
  it('POST message corre un turno y persiste user+assistant', async () => {
    const { gov, handler } = await build(undefined, { async createMessage() { return textResp('Empecemos por la fuente.') } })
    await gov.createSession('s1', 'Saldos', EMAIL)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: token, text: 'quiero saldos por empresa' }), res)
    await done
    expect(calls.status).toBe(303)
    const msgs = await gov.listMirandaMessages('s1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(await gov.mirandaSessionTokens('s1')).toBe(10)
  })
})

describe('WP4 · validate-intent y preview', () => {
  it('validate-intent sin resumen → 400; con resumen y borrador → validado', async () => {
    const { gov, handler } = await build()
    await gov.createSession('s1', 'x', EMAIL)
    await gov.setMirandaState('s1', 'borrador')
    // sin resumen aún
    let r = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/validate-intent', 'POST', { _csrf: token }), r.res)
    await r.done
    expect(r.calls.status).toBe(400)
    // con resumen
    await gov.appendMirandaArtifact('s1', 'intent_summary', JSON.stringify({ titulo: 'x', pregunta_de_negocio: 'y', audiencia: 'z', grano: 'g' }))
    r = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/validate-intent', 'POST', { _csrf: token }), r.res)
    await r.done
    expect(r.calls.status).toBe(303)
    expect((await gov.getMirandaSession('s1'))?.state).toBe('validado')
  })
  it('GET preview sirve el draft por el riel de render (RLS real)', async () => {
    const renderPreviewHtml = vi.fn(async () => '<html>PREVIEW-RLS</html>')
    const { gov, handler } = await build({ renderPreviewHtml })
    await gov.createSession('s1', 'x', EMAIL)
    await gov.appendMirandaArtifact('s1', 'spec_draft', 'mira_version: "1.0"')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toBe('<html>PREVIEW-RLS</html>')
    expect(renderPreviewHtml).toHaveBeenCalled()
  })
})

describe('WP4 · publish desde el handler', () => {
  it('autochequeado + qc sin B/M → publica y escribe la spec', async () => {
    const writeSpec = vi.fn(async () => {})
    const { gov, handler } = await build({ writeSpec })
    await gov.createSession('s1', 'Saldos empresa', EMAIL)
    await gov.setMirandaState('s1', 'borrador')
    await gov.setMirandaState('s1', 'validado')
    await gov.setMirandaState('s1', 'autochequeado')
    await gov.appendMirandaArtifact('s1', 'spec_draft', 'mira_version: "1.0"')
    await gov.appendMirandaArtifact('s1', 'qc_report', JSON.stringify({ veredicto: 'APROBADA', brechas: [] }))
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/publish', 'POST', { _csrf: token }), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toContain('PI-101')
    expect(writeSpec).toHaveBeenCalled()
  })
  it('publish con qc M abierta → 409', async () => {
    const { gov, handler } = await build()
    await gov.createSession('s1', 'x', EMAIL)
    await gov.setMirandaState('s1', 'borrador')
    await gov.setMirandaState('s1', 'validado')
    await gov.setMirandaState('s1', 'autochequeado')
    await gov.appendMirandaArtifact('s1', 'spec_draft', 'mira_version: "1.0"')
    await gov.appendMirandaArtifact('s1', 'qc_report', JSON.stringify({ veredicto: 'NO_APROBABLE', brechas: [{ id: 'M1', sev: 'M', brecha: 'x', donde: 'y', recomendacion: 'z' }] }))
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/publish', 'POST', { _csrf: token }), res)
    await done
    expect(calls.status).toBe(409)
  })
})
