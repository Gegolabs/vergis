import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createMiranda, type MirandaServerDeps } from '../server/miranda'
import { csrfFactory } from '../server/ui'
import { SqliteGovernanceStore } from '@vergis/capabilities'
import type { AnthropicTransport, AnthropicResponse, CatalogEntry } from '@vergis/miranda'

// Plan 094 · WP3: e2e fake-transport con catálogo MULTI-NIVEL. El flujo funciona con fuentes de varios
// niveles y, cuando la intención pide un dato de una fuente aún no servible (nivel 2), el data_request
// queda registrado CON su nivel y acción de cierre (handoff accionable).

const SECRET = 's'
const EMAIL = 'especificador@consultora.test'
const token = csrfFactory(SECRET)(EMAIL)

const MULTINIVEL: CatalogEntry[] = [
  { name: 'dbo.v_saldos', nivel: 'gestionado', dominio: 'Finanzas', description: 'saldos de cartera por empresa' },
  { name: 'SAP-B1-contable', nivel: 'conectado', sistema: 'SAP Business One', dominio: 'Ventas', description: 'movimientos del libro mayor' },
]

const tu = (name: string, input: unknown): AnthropicResponse => ({ id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }], stop_reason: 'tool_use', usage: { input_tokens: 8, output_tokens: 4 } })
const txt = (t: string): AnthropicResponse => ({ id: 'm', role: 'assistant', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 4 } })

function scriptedTransport(queue: AnthropicResponse[]): AnthropicTransport {
  let i = 0
  return { async createMessage() { const r = queue[i++]; if (!r) throw new Error('script agotado'); return r } }
}
function mkReq(url: string, method = 'GET', body?: Record<string, string>): IncomingMessage {
  const req = Readable.from([body ? new URLSearchParams(body).toString() : '']) as unknown as IncomingMessage
  req.url = url
  req.method = method
  req.headers = {}
  return req
}
function mkRes() {
  const calls = { status: 0, body: '' }
  let done!: () => void
  const p = new Promise<void>((r) => (done = r))
  const res = { writeHead: (c: number) => { calls.status = c }, end: (b?: string) => { calls.body = b ?? ''; done() } } as unknown as ServerResponse
  return { res, calls, p }
}

function deps(gov: SqliteGovernanceStore, transport: AnthropicTransport): MirandaServerDeps {
  return {
    gov,
    transport,
    model: 'm',
    systemPrompt: 'sys',
    maxTurns: 10,
    tokenBudget: 500000,
    catalog: MULTINIVEL,
    configuredRefs: [],
    identityOf: () => ({ user: EMAIL }),
    hasScope: async () => true,
    probe: async () => ({ rows: [{ empresa: 'ACME', saldo: 10 }] }),
    columnsOf: async () => [{ name: 'empresa', type: 'nvarchar' }],
    validateDraft: () => ({ ok: true }),
    listSpecs: () => [],
    readSpec: () => null,
    writeSpec: vi.fn(async () => {}),
    renderPreviewHtml: async () => '<html>PREVIEW</html>',
    secret: SECRET,
  }
}

describe('WP3 · e2e multi-nivel + data_request con nivel/acción', () => {
  it('el data_request de una fuente nivel-2 lleva nivel y acción de cierre', async () => {
    const gov = await SqliteGovernanceStore.open(null)
    // Turno: Miranda mira el catálogo, ve que el balance contable vive en una fuente conectada aún no
    // servible, y registra el handoff con nivel=conectado + acción=curar; luego habla en voz de negocio.
    const transport = scriptedTransport([
      tu('catalog_tables', {}),
      tu('create_data_request', { descripcion: 'balance contable consolidado desde el sistema contable', tablas_faltantes: ['SAP-B1-contable'], nivel: 'conectado', accion_de_cierre: 'curar' }),
      txt('El balance de cartera te lo tengo al momento; el contable puedo prepararlo, es cuestión de horas.'),
    ])
    const h = createMiranda(deps(gov, transport))
    await gov.createSession('n1', 'Balance consolidado', EMAIL)

    const r = mkRes()
    await h.tryHandle(mkReq('/miranda/api/s/n1/message', 'POST', { _csrf: token, text: 'quiero un balance consolidado de todas las empresas de SAP' }), r.res)
    await r.p
    await h.whenIdle()

    const art = await gov.latestMirandaArtifact('n1', 'data_request')
    expect(art).not.toBeNull()
    const payload = JSON.parse(art!.content) as { nivel?: string; accionDeCierre?: string; tablasFaltantes?: string[] }
    expect(payload.nivel).toBe('conectado')
    expect(payload.accionDeCierre).toBe('curar')
    expect(payload.tablasFaltantes).toEqual(['SAP-B1-contable'])
  })

  it('probe/describe contra la fuente nivel-2 se rechaza; contra la gestionada, procede', async () => {
    const gov = await SqliteGovernanceStore.open(null)
    // Miranda intenta describir la fuente nivel-2 (rechazo), luego la gestionada (procede), luego responde.
    const transport = scriptedTransport([
      tu('describe_table', { name: 'SAP-B1-contable' }),
      tu('describe_table', { name: 'dbo.v_saldos' }),
      txt('Listo, exploré lo servible.'),
    ])
    const h = createMiranda(deps(gov, transport))
    await gov.createSession('n2', 'x', EMAIL)
    const r = mkRes()
    await h.tryHandle(mkReq('/miranda/api/s/n2/message', 'POST', { _csrf: token, text: 'describe las fuentes' }), r.res)
    await r.p
    await h.whenIdle()
    // El turno completó (llegó al texto final) pese al rechazo de la fuente nivel-2 — se manejó como error de tool.
    const msgs = await gov.listMirandaMessages('n2')
    const joined = msgs.map((m) => m.content).join(' ')
    expect(joined).toMatch(/no está en la capa de datos servible/i) // el rechazo quedó en el transcript de tools
  })
})
