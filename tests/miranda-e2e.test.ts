import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createMiranda, type MirandaServerDeps } from '../server/miranda'
import { csrfFactory } from '../server/ui'
import { SqliteGovernanceStore } from '@vergis/capabilities'
import { parseSpec, validateSpec } from '@vergis/mira'
import type { AnthropicTransport, AnthropicResponse } from '@vergis/miranda'

// E2E LOCAL sin red: transport FAKE con una conversación grabada recorre explorando→publicado, y el
// YAML final se valida con el validador REAL del DSL (dsl/parse + dsl/validate).

const SECRET = 's'
const EMAIL = 'claudio@ratio.cl'
const token = csrfFactory(SECRET)(EMAIL)
const schema = JSON.parse(readFileSync(resolve('schema/mira-spec.schema.json'), 'utf8')) as object

const GOOD_SPEC = `mira_version: "1.0"
identity:
  id: saldos-empresa
  display_name: "Saldos por empresa"
  classification: internal
piece:
  layout: rows
  elements:
    - markdown_block:
        content: "# Saldos por empresa"
    - table:
        data: data.saldos
        columns:
          - {field: empresa, label: Empresa}
          - {field: saldo, label: Saldo, format: int_0}
data:
  saldos:
    capability: execute-sql-dwh
    params:
      database_ref: fabric
      sql: "SELECT empresa, saldo FROM dbo.v_saldos"
    shape:
      type: rows
      fields:
        empresa: string
        saldo: integer
quality:
  audience:
    rls: public
delivery:
  render:
    - {format: html, target: web}
`

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
  const calls = { status: 0, body: '', headers: {} as Record<string, string> }
  let done!: () => void
  const p = new Promise<void>((r) => (done = r))
  const res = { writeHead: (c: number, h?: Record<string, string>) => { calls.status = c; if (h) calls.headers = h }, end: (b?: string) => { calls.body = b ?? ''; done() } } as unknown as ServerResponse
  return { res, calls, p }
}

describe('WP7 · e2e explorando→publicado (sin red)', () => {
  it('recorre el ciclo completo y publica un YAML que pasa dsl/validate', async () => {
    const gov = await SqliteGovernanceStore.open(null)
    const writeSpec = vi.fn(async (_f: string, _c: string) => {})
    // Guion: turno 1 (elicita + resumen), turno 2 (draft + self-check[juez] + cierre).
    const transport = scriptedTransport([
      // turno 1
      tu('catalog_tables', {}),
      tu('update_intent_summary', { titulo: 'Saldos por empresa', pregunta_de_negocio: '¿Cuánto saldo por empresa?', audiencia: 'Finanzas', grano: 'empresa', vistas: [{ nombre: 'Saldos por empresa', forma: 'tabla', piezas: ['tabla'] }] }),
      txt('Te propongo ese resumen. Valídalo cuando quieras.'),
      // turno 2
      tu('save_draft', { yaml: GOOD_SPEC }),
      tu('run_self_check', {}),
      tu('emit_qc_report', { veredicto: 'APROBADA', brechas: [] }), // llamada del JUEZ (mismo transport)
      txt('Sin brechas. Puedes publicar.'),
    ])
    const deps: MirandaServerDeps = {
      gov,
      transport,
      model: 'm',
      systemPrompt: 'sys',
      maxTurns: 10,
      tokenBudget: 500000,
      catalog: [{ name: 'dbo.v_saldos' }],
      identityOf: () => ({ user: EMAIL }),
      hasScope: async () => true,
      probe: async () => ({ rows: [{ empresa: 'ACME', saldo: 10 }] }),
      columnsOf: async () => [{ name: 'empresa', type: 'nvarchar' }, { name: 'saldo', type: 'int' }],
      validateDraft: (yaml) => {
        try {
          validateSpec(parseSpec(yaml), { capabilities: ['execute-sql-dwh', 'publicar-artefacto'], schema })
          return { ok: true }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
      listSpecs: () => [],
      readSpec: () => null,
      writeSpec,
      renderPreviewHtml: async () => '<html>PREVIEW</html>',
      secret: SECRET,
    }
    const h = createMiranda(deps)
    await gov.createSession('e2e', 'Saldos por empresa', EMAIL)

    // Turno 1
    let r = mkRes()
    await h.tryHandle(mkReq('/miranda/api/s/e2e/message', 'POST', { _csrf: token, text: 'quiero saldos por empresa' }), r.res)
    await r.p
    expect((await gov.getMirandaSession('e2e'))?.state).toBe('borrador') // update_intent_summary lo movió
    const intentArt = await gov.latestMirandaArtifact('e2e', 'intent_summary')
    expect(intentArt).not.toBeNull()
    // El resumen extendido lleva la forma por vista (guard anti-F-01).
    expect(JSON.parse(intentArt!.content).vistas).toEqual([{ nombre: 'Saldos por empresa', forma: 'tabla', piezas: ['tabla'] }])

    // Validar intención
    r = mkRes()
    await h.tryHandle(mkReq('/miranda/api/s/e2e/validate-intent', 'POST', { _csrf: token }), r.res)
    await r.p
    expect((await gov.getMirandaSession('e2e'))?.state).toBe('validado')

    // Turno 2 (draft + self-check)
    r = mkRes()
    await h.tryHandle(mkReq('/miranda/api/s/e2e/message', 'POST', { _csrf: token, text: 'compón el spec y chequéalo' }), r.res)
    await r.p
    expect(await gov.latestMirandaArtifact('e2e', 'spec_draft')).not.toBeNull()
    const qc = await gov.latestMirandaArtifact('e2e', 'qc_report')
    expect(JSON.parse(qc!.content).veredicto).toBe('APROBADA')
    expect((await gov.getMirandaSession('e2e'))?.state).toBe('autochequeado')

    // Publicar
    r = mkRes()
    await h.tryHandle(mkReq('/miranda/api/s/e2e/publish', 'POST', { _csrf: token }), r.res)
    await r.p
    expect(r.calls.status).toBe(200)
    expect(r.calls.body).toContain('PI-101')
    expect((await gov.getMirandaSession('e2e'))?.state).toBe('publicado')
    expect((await gov.getMirandaSession('e2e'))?.piCode).toBe('PI-101')

    // El YAML publicado pasa el validador REAL (servible).
    const [filename, content] = writeSpec.mock.calls[0]
    expect(filename).toBe('pi101-saldos-por-empresa.yaml')
    expect(deps.validateDraft(content)).toEqual({ ok: true })
    expect(content).toContain('code: PI-101')
  })
})
