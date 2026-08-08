import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createMiranda, previewIdentityFor, type MirandaServerDeps } from '../server/miranda'
import { csrfFactory } from '../server/ui'
import { SqliteGovernanceStore } from '@vergis/capabilities'
import type { AnthropicTransport, AnthropicResponse } from '@vergis/miranda'

// #110·1 — preview de RLS con dos identidades reales. Lo que estos tests miden:
//  · sin roster, `?as=` y `/compare` NO existen y la tool no gana campos (superficie cero, D1);
//  · con roster, etiqueta no declarada ⇒ 404 y etiqueta válida ⇒ render por el riel impersonado;
//  · el guard de pertenencia (005·01) también cubre `?as=` — sesión ajena ⇒ 403 sin render;
//  · cada render impersonado audita con el ACTOR real (D4);
//  · la identidad suplantada son los claims del roster TAL CUAL, sin enriquecer (D1/D2).
// Arnés: patrón de `tests/miranda-ownership.test.ts` (copiado, no importado).

const SECRET = 'test-secret'
const OWNER = 'ana@x.com'
const OTHER = 'eva@x.com'
const ROSTER = [
  { label: 'gerente-norte', user: 'persona.norte@inst.test', claims: { groups: ['gerencia'], area: ['Norte'] } },
  { label: 'vendedor-sur', user: 'persona.sur@inst.test', claims: { groups: ['ventas'], area: ['Sur'] } },
]

function mkReq(url: string, method = 'GET'): IncomingMessage {
  const req = Readable.from(['']) as unknown as IncomingMessage
  req.url = url
  req.method = method
  req.headers = {}
  return req
}
function mkRes() {
  const calls: { status: number; body: string } = { status: 0, body: '' }
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))
  const res = {
    writeHead: (code: number) => {
      calls.status = code
    },
    end: (b?: string) => {
      calls.body = b ?? ''
      resolveDone()
    },
  } as unknown as ServerResponse
  return { res, calls, done }
}
const textResp = (t: string): AnthropicResponse => ({ id: 'm', role: 'assistant', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })

async function build(over: Partial<MirandaServerDeps> = {}) {
  const gov = await SqliteGovernanceStore.open(null)
  const renderPreviewHtml = vi.fn(async () => '<html>PREVIEW-TUYA</html>')
  const renderPreviewHtmlAs = vi.fn(async (_yaml: string, label: string) => `<html>PREVIEW-COMO-${label}</html>`)
  const audit = vi.fn()
  const deps: MirandaServerDeps = {
    gov,
    transport: { createMessage: vi.fn(async () => textResp('ok')) } as unknown as AnthropicTransport,
    model: 'm',
    systemPrompt: 'sys',
    maxTurns: 5,
    tokenBudget: 100_000,
    catalog: [{ name: 'dbo.v_saldos' }],
    identityOf: () => ({ user: OWNER }),
    hasScope: async () => true,
    isAdmin: async () => false,
    probe: async () => ({ rows: [] }),
    columnsOf: async () => [],
    validateDraft: () => ({ ok: true }),
    listSpecs: () => [],
    readSpec: () => null,
    writeSpec: async () => {},
    renderPreviewHtml,
    secret: SECRET,
    ...over,
  }
  return { gov, deps, handler: createMiranda(deps), spies: { renderPreviewHtml, renderPreviewHtmlAs, audit } }
}
/** Deps CON roster: el par (identidades + render impersonado) que la instancia cablea. */
async function buildWithRoster(over: Partial<MirandaServerDeps> = {}) {
  const renderPreviewHtmlAs = vi.fn(async (_yaml: string, label: string) => `<html>PREVIEW-COMO-${label}</html>`)
  const audit = vi.fn()
  const built = await build({ previewIdentities: ROSTER, renderPreviewHtmlAs, audit, ...over })
  return { ...built, spies: { ...built.spies, renderPreviewHtmlAs, audit } }
}

async function seedDraft(gov: SqliteGovernanceStore, id: string, owner = OWNER) {
  await gov.createSession(id, 'Saldos', owner)
  await gov.appendMirandaArtifact(id, 'spec_draft', 'mira_version: "1.0"')
}

describe('#110·1 · sin roster ⇒ la feature no existe (D1)', () => {
  it('`?as=` se comporta como si el parámetro no existiera (render con TU RLS)', async () => {
    const { gov, handler, spies } = await build()
    await seedDraft(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1?as=gerente-norte'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toBe('<html>PREVIEW-TUYA</html>')
    expect(spies.renderPreviewHtml).toHaveBeenCalledTimes(1)
  })
  it('`/compare` no existe (404 de ruta)', async () => {
    const { gov, handler } = await build()
    await seedDraft(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1/compare?a=me&b=gerente-norte'), res)
    await done
    expect(calls.status).toBe(404)
    expect(calls.body).toContain('Ruta no encontrada')
  })
  it('el panel de sesión ofrece SOLO el link de siempre', async () => {
    const { gov, handler } = await build()
    await seedDraft(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), res)
    await done
    expect(calls.body).toContain('/miranda/preview/s1')
    expect(calls.body).not.toContain('?as=')
    expect(calls.body).not.toContain('Comparar')
  })
  it('la tool `render_preview` NO expone `identities` ni `compare_url`', async () => {
    const { gov, deps } = await build()
    await seedDraft(gov, 's1')
    const out = await callRenderPreview(deps, 's1')
    expect(out).toEqual({ url: '/miranda/preview/s1' })
  })
})

describe('#110·1 · con roster ⇒ `?as=` rinde por el riel impersonado', () => {
  it('etiqueta válida ⇒ render con esa etiqueta (y NO con la identidad del request)', async () => {
    const { gov, handler, spies } = await buildWithRoster()
    await seedDraft(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1?as=vendedor-sur'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toBe('<html>PREVIEW-COMO-vendedor-sur</html>')
    expect(spies.renderPreviewHtmlAs).toHaveBeenCalledWith('mira_version: "1.0"', 'vendedor-sur')
    expect(spies.renderPreviewHtml).not.toHaveBeenCalled()
  })
  it('etiqueta NO declarada ⇒ 404 con mensaje, sin render alguno', async () => {
    const { gov, handler, spies } = await buildWithRoster()
    await seedDraft(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1?as=ceo@empresa.com'), res)
    await done
    expect(calls.status).toBe(404)
    expect(calls.body).toContain('no está declarada')
    expect(spies.renderPreviewHtmlAs).not.toHaveBeenCalled()
    expect(spies.renderPreviewHtml).not.toHaveBeenCalled()
  })
  it('sin `as` ⇒ conducta de siempre (tu RLS)', async () => {
    const { gov, handler, spies } = await buildWithRoster()
    await seedDraft(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1'), res)
    await done
    expect(calls.body).toBe('<html>PREVIEW-TUYA</html>')
    expect(spies.renderPreviewHtmlAs).not.toHaveBeenCalled()
  })
  it('cada render impersonado se audita con el ACTOR real (D4)', async () => {
    const { gov, handler, spies } = await buildWithRoster()
    await seedDraft(gov, 's1')
    const { res, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1?as=gerente-norte'), res)
    await done
    expect(spies.audit).toHaveBeenCalledWith({ type: 'miranda-preview-as', session: 's1', actor: OWNER, as: 'gerente-norte' })
  })
  it('el render con TU identidad no audita evento de impersonación', async () => {
    const { gov, handler, spies } = await buildWithRoster()
    await seedDraft(gov, 's1')
    const { res, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1'), res)
    await done
    expect(spies.audit).not.toHaveBeenCalled()
  })
})

describe('#110·1 · el guard de pertenencia (005·01) cubre también `?as=`', () => {
  it('sesión ajena con `?as=` ⇒ 403, sin render ni auditoría', async () => {
    const { gov, handler, spies } = await buildWithRoster({ identityOf: () => ({ user: OTHER }) })
    await seedDraft(gov, 's1', OWNER)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1?as=gerente-norte'), res)
    await done
    expect(calls.status).toBe(403)
    expect(calls.body).toContain('otra persona')
    expect(spies.renderPreviewHtmlAs).not.toHaveBeenCalled()
    expect(spies.audit).not.toHaveBeenCalled()
  })
  it('sesión ajena en `/compare` ⇒ 403', async () => {
    const { gov, handler, spies } = await buildWithRoster({ identityOf: () => ({ user: OTHER }) })
    await seedDraft(gov, 's1', OWNER)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1/compare?a=me&b=gerente-norte'), res)
    await done
    expect(calls.status).toBe(403)
    expect(spies.renderPreviewHtmlAs).not.toHaveBeenCalled()
  })
})

describe('#110·1 · comparador de dos identidades', () => {
  it('dos iframes a `?as=` + banda que nombra identidades y claims', async () => {
    const { gov, handler, spies } = await buildWithRoster()
    await seedDraft(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1/compare?a=gerente-norte&b=vendedor-sur'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toContain('src="/miranda/preview/s1?as=gerente-norte"')
    expect(calls.body).toContain('src="/miranda/preview/s1?as=vendedor-sur"')
    expect(calls.body).toContain('persona.norte@inst.test')
    expect(calls.body).toContain('area=Norte')
    expect(calls.body).toContain('area=Sur')
    // Cero lógica de datos propia: la página no renderiza nada, los iframes lo piden después.
    expect(spies.renderPreviewHtmlAs).not.toHaveBeenCalled()
  })
  it('`me` es una opción válida y apunta a la preview sin `as`', async () => {
    const { gov, handler } = await buildWithRoster()
    await seedDraft(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1/compare?a=me&b=vendedor-sur'), res)
    await done
    expect(calls.body).toContain('src="/miranda/preview/s1"')
    expect(calls.body).toContain('Tu identidad')
  })
  it('etiqueta no declarada en `a` o `b` ⇒ 404', async () => {
    const { gov, handler } = await buildWithRoster()
    await seedDraft(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1/compare?a=me&b=nadie'), res)
    await done
    expect(calls.status).toBe(404)
    expect(calls.body).toContain('no está declarada')
  })
})

describe('#110·1 · panel y tool con roster', () => {
  it('el panel lista «tu RLS» + una etiqueta por identidad + comparar', async () => {
    const { gov, handler } = await buildWithRoster()
    await seedDraft(gov, 's1')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), res)
    await done
    expect(calls.body).toContain('/miranda/preview/s1?as=gerente-norte')
    expect(calls.body).toContain('/miranda/preview/s1?as=vendedor-sur')
    expect(calls.body).toContain('/miranda/preview/s1/compare')
    expect(calls.body).toContain('Comparar')
  })
  it('la tool devuelve `{url, identities, compare_url}` — sin claims', async () => {
    const { gov, deps } = await buildWithRoster()
    await seedDraft(gov, 's1')
    const out = (await callRenderPreview(deps, 's1')) as { url: string; identities: { label: string; url: string }[]; compare_url: string }
    expect(out.url).toBe('/miranda/preview/s1')
    expect(out.identities).toEqual([
      { label: 'gerente-norte', url: '/miranda/preview/s1?as=gerente-norte' },
      { label: 'vendedor-sur', url: '/miranda/preview/s1?as=vendedor-sur' },
    ])
    expect(out.compare_url).toBe('/miranda/preview/s1/compare?a=me&b=gerente-norte')
    expect(JSON.stringify(out)).not.toContain('gerencia')
    expect(JSON.stringify(out)).not.toContain('inst.test')
  })
})

describe('#110·1 · la identidad suplantada es la del roster TAL CUAL (D1/D2)', () => {
  it('user y claims exactos, sin enriquecer, con el agent del gate real', () => {
    const id = previewIdentityFor(ROSTER[0], 'vergis')
    expect(id).toEqual({ agent: 'vergis', user: 'persona.norte@inst.test', claims: { groups: ['gerencia'], area: ['Norte'] } })
  })
  it('claims vacíos se pasan vacíos (fail-closed: la política inyecta vacío ⇒ cero filas)', () => {
    expect(previewIdentityFor({ user: 'x@y.z' }, 'vergis')).toEqual({ agent: 'vergis', user: 'x@y.z', claims: {} })
  })
})

/**
 * Ejercita la tool `render_preview` por el camino REAL: un turno del agente donde el modelo (fake)
 * la invoca. Así se mide la salida que de verdad llega al modelo — el contexto de tools es privado
 * de `createMiranda`, y reconstruirlo en el test mediría una copia, no el producto.
 */
async function callRenderPreview(deps: MirandaServerDeps, sessionId: string): Promise<unknown> {
  const toolUse: AnthropicResponse = {
    id: 'm',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'render_preview', input: {} }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  let turno = 0
  const transport = { createMessage: vi.fn(async () => (turno++ === 0 ? toolUse : textResp('listo'))) } as unknown as AnthropicTransport
  const handler = createMiranda({ ...deps, transport })
  const body = new URLSearchParams({ _csrf: csrfFactory(SECRET)(OWNER), text: 'muéstrame la preview' }).toString()
  const req = Readable.from([body]) as unknown as IncomingMessage
  req.url = `/miranda/api/s/${sessionId}/message`
  req.method = 'POST'
  req.headers = {}
  const { res, done } = mkRes()
  await handler.tryHandle(req, res)
  await done
  let captured: unknown
  for (const r of await deps.gov.listMirandaMessages(sessionId)) {
    if (r.role !== 'tool') continue
    for (const b of JSON.parse(r.content) as { type: string; content?: string }[]) {
      if (b.type === 'tool_result' && typeof b.content === 'string') captured = JSON.parse(b.content)
    }
  }
  return captured
}
