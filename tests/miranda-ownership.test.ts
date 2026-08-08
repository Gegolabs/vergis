import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createMiranda, type MirandaServerDeps } from '../server/miranda'
import { csrfFactory } from '../server/ui'
import { SqliteGovernanceStore } from '@vergis/capabilities'
import type { AnthropicTransport, AnthropicResponse } from '@vergis/miranda'

// Guard de pertenencia (005·01): toda ruta con `sessionId` exige dueño-o-admin.
// Arnés: patrón de `tests/miranda-handler.test.ts` (copiado, no importado).

const SECRET = 'test-secret'
const OWNER = 'ana@x.com'
const OTHER = 'eva@x.com' // tiene scope `miranda`, NO es dueña
const tokenFor = (email: string) => csrfFactory(SECRET)(email)

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

async function build(over: Partial<MirandaServerDeps> = {}) {
  const gov = await SqliteGovernanceStore.open(null)
  const createMessage = vi.fn(async () => textResp('¿Qué PI quieres crear?'))
  const writeSpec = vi.fn(async () => {})
  const renderPreviewHtml = vi.fn(async () => '<html>PREVIEW-RLS</html>')
  const deps: MirandaServerDeps = {
    gov,
    transport: { createMessage } as unknown as AnthropicTransport,
    model: 'm',
    systemPrompt: 'sys',
    maxTurns: 5,
    tokenBudget: 100000,
    catalog: [{ name: 'dbo.v_saldos' }],
    identityOf: () => ({ user: OWNER }),
    hasScope: async () => true,
    isAdmin: async () => false,
    probe: async () => ({ rows: [] }),
    columnsOf: async () => [],
    validateDraft: () => ({ ok: true }),
    listSpecs: () => [],
    readSpec: () => null,
    writeSpec,
    renderPreviewHtml,
    secret: SECRET,
    ...over,
  }
  return { gov, handler: createMiranda(deps), spies: { createMessage, writeSpec, renderPreviewHtml } }
}

/** Sesión lista para publicar (autochequeado + draft + QC sin brechas). */
async function seedPublishable(gov: SqliteGovernanceStore, id: string, owner?: string) {
  await gov.createSession(id, 'Saldos', owner)
  await gov.setMirandaState(id, 'borrador')
  await gov.appendMirandaArtifact(id, 'intent_summary', JSON.stringify({ titulo: 'x', pregunta_de_negocio: 'y', audiencia: 'z', grano: 'g' }))
  await gov.appendMirandaArtifact(id, 'spec_draft', 'mira_version: "1.0"')
  await gov.appendMirandaArtifact(id, 'qc_report', JSON.stringify({ veredicto: 'APROBADA', brechas: [] }))
}
async function toAutochequeado(gov: SqliteGovernanceStore, id: string) {
  await gov.setMirandaState(id, 'validado')
  await gov.setMirandaState(id, 'autochequeado')
}

/** Las 5 rutas que reciben sessionId, con su forma de request. */
const routes = (id: string, token: string) => [
  { name: 'GET /miranda/s/:id', req: () => mkReq(`/miranda/s/${id}`) },
  { name: 'POST …/message', req: () => mkReq(`/miranda/api/s/${id}/message`, 'POST', { _csrf: token, text: 'hola' }) },
  { name: 'POST …/validate-intent', req: () => mkReq(`/miranda/api/s/${id}/validate-intent`, 'POST', { _csrf: token }) },
  { name: 'POST …/publish', req: () => mkReq(`/miranda/api/s/${id}/publish`, 'POST', { _csrf: token }) },
  { name: 'GET /miranda/preview/:id', req: () => mkReq(`/miranda/preview/${id}`) },
]

describe('005·01 · no-dueño con scope → 403 y cero efectos', () => {
  for (const r of routes('s1', tokenFor(OTHER))) {
    it(`${r.name} → 403 para no-dueño`, async () => {
      const { gov, handler, spies } = await build({ identityOf: () => ({ user: OTHER }) })
      await seedPublishable(gov, 's1', OWNER)
      await toAutochequeado(gov, 's1')
      const { res, calls, done } = mkRes()
      await handler.tryHandle(r.req(), res)
      await done
      expect(calls.status).toBe(403)
      expect(calls.body).toContain('otra persona')
      // Cero efectos.
      expect(await gov.listMirandaMessages('s1')).toHaveLength(0)
      expect((await gov.getMirandaSession('s1'))?.state).toBe('autochequeado')
      expect((await gov.getMirandaSession('s1'))?.piCode).toBeUndefined()
      expect(spies.writeSpec).not.toHaveBeenCalled()
      expect(spies.createMessage).not.toHaveBeenCalled()
      expect(spies.renderPreviewHtml).not.toHaveBeenCalled()
      expect(calls.body).not.toContain('PREVIEW-RLS')
    })
  }
})

describe('005·01 · dueño → conducta actual', () => {
  it('GET /miranda/s/:id → 200 con la sesión', async () => {
    const { gov, handler } = await build()
    await gov.createSession('s1', 'Saldos', OWNER)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toContain('Saldos')
  })
  it('POST …/message → 303 y persiste el turno', async () => {
    const { gov, handler, spies } = await build()
    await gov.createSession('s1', 'Saldos', OWNER)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: tokenFor(OWNER), text: 'hola' }), res)
    await done
    expect(calls.status).toBe(303)
    expect(spies.createMessage).toHaveBeenCalled()
    expect((await gov.listMirandaMessages('s1')).map((m) => m.role)).toEqual(['user', 'assistant'])
  })
  it('POST …/validate-intent → 303 y borrador→validado', async () => {
    const { gov, handler } = await build()
    await seedPublishable(gov, 's1', OWNER)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/validate-intent', 'POST', { _csrf: tokenFor(OWNER) }), res)
    await done
    expect(calls.status).toBe(303)
    expect((await gov.getMirandaSession('s1'))?.state).toBe('validado')
  })
  it('POST …/publish → 200 y escribe la spec', async () => {
    const { gov, handler, spies } = await build()
    await seedPublishable(gov, 's1', OWNER)
    await toAutochequeado(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/publish', 'POST', { _csrf: tokenFor(OWNER) }), res)
    await done
    expect(calls.status).toBe(200)
    expect(spies.writeSpec).toHaveBeenCalled()
  })
  it('GET /miranda/preview/:id → 200 con el render', async () => {
    const { gov, handler } = await build()
    await seedPublishable(gov, 's1', OWNER)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toBe('<html>PREVIEW-RLS</html>')
  })
})

describe('005·01 · admin no-dueño → pasa en las 5', () => {
  const adminDeps = { identityOf: () => ({ user: OTHER }), isAdmin: async () => true }
  it('GET /miranda/s/:id', async () => {
    const { gov, handler } = await build(adminDeps)
    await gov.createSession('s1', 'Saldos', OWNER)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toContain('Saldos')
  })
  it('POST …/message', async () => {
    const { gov, handler, spies } = await build(adminDeps)
    await gov.createSession('s1', 'Saldos', OWNER)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: tokenFor(OTHER), text: 'hola' }), res)
    await done
    expect(calls.status).toBe(303)
    expect(spies.createMessage).toHaveBeenCalled()
  })
  it('POST …/validate-intent', async () => {
    const { gov, handler } = await build(adminDeps)
    await seedPublishable(gov, 's1', OWNER)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/validate-intent', 'POST', { _csrf: tokenFor(OTHER) }), res)
    await done
    expect(calls.status).toBe(303)
    expect((await gov.getMirandaSession('s1'))?.state).toBe('validado')
  })
  it('POST …/publish', async () => {
    const { gov, handler, spies } = await build(adminDeps)
    await seedPublishable(gov, 's1', OWNER)
    await toAutochequeado(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/publish', 'POST', { _csrf: tokenFor(OTHER) }), res)
    await done
    expect(calls.status).toBe(200)
    expect(spies.writeSpec).toHaveBeenCalled()
  })
  it('GET /miranda/preview/:id', async () => {
    const { gov, handler } = await build(adminDeps)
    await seedPublishable(gov, 's1', OWNER)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toBe('<html>PREVIEW-RLS</html>')
  })
})

describe('005·01 · sesión sin createdBy = solo-admin (D2)', () => {
  it('no-admin → 403 aunque la sesión no tenga dueño', async () => {
    const { gov, handler } = await build()
    await gov.createSession('s1', 'Huérfana') // sin createdBy
    expect((await gov.getMirandaSession('s1'))?.createdBy).toBeUndefined()
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), res)
    await done
    expect(calls.status).toBe(403)
  })
  it('admin → 200', async () => {
    const { gov, handler } = await build({ isAdmin: async () => true })
    await gov.createSession('s1', 'Huérfana')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toContain('Huérfana')
  })
})

describe('005·01 · sesión inexistente → 404 en las 5', () => {
  for (const r of routes('no-existe', tokenFor(OWNER))) {
    it(`${r.name} → 404`, async () => {
      const { handler, spies } = await build()
      const { res, calls, done } = mkRes()
      await handler.tryHandle(r.req(), res)
      await done
      expect(calls.status).toBe(404)
      expect(spies.writeSpec).not.toHaveBeenCalled()
      expect(spies.createMessage).not.toHaveBeenCalled()
      expect(spies.renderPreviewHtml).not.toHaveBeenCalled()
    })
  }
})

describe('005·01 · comparación de dueño case-insensitive (D5)', () => {
  it('dueña `Ana@X.com` vs requester `ana@x.com` → pasa', async () => {
    const { gov, handler } = await build({ identityOf: () => ({ user: 'ana@x.com' }) })
    await gov.createSession('s1', 'Saldos', 'Ana@X.com')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toContain('Saldos')
  })
  it('store que devuelve el dueño sin normalizar → el guard normaliza ese lado también', async () => {
    // El store real normaliza al insertar; este proxy simula una fila legada con mayúsculas
    // para ejercitar la normalización del lado de la sesión (no solo la del requester).
    const real = await SqliteGovernanceStore.open(null)
    await real.createSession('s1', 'Saldos', 'ana@x.com')
    const gov = new Proxy(real, {
      get(t, p, r) {
        if (p === 'getMirandaSession') {
          return async (id: string) => {
            const s = await t.getMirandaSession(id)
            return s ? { ...s, createdBy: 'Ana@X.COM' } : null
          }
        }
        const v = Reflect.get(t, p, r) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    })
    const { handler } = await build({ gov, identityOf: () => ({ user: 'ana@x.com' }) })
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), res)
    await done
    expect(calls.status).toBe(200)
  })
})
