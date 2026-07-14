import { describe, it, expect, vi } from 'vitest'
import {
  runSelfCheck,
  publishSpec,
  PublishBlocked,
  type AnthropicTransport,
  type AnthropicResponse,
  type PublishStore,
} from '@vergis/miranda'
import { SqliteGovernanceStore } from '@vergis/capabilities'

/** Transporte fake que responde con un tool_use emit_qc_report del contenido dado. */
function judgeTransport(report: unknown): AnthropicTransport {
  return {
    async createMessage(): Promise<AnthropicResponse> {
      return {
        id: 'm', role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'emit_qc_report', input: report }],
        stop_reason: 'tool_use', usage: { input_tokens: 50, output_tokens: 20 },
      }
    },
  }
}

const goodDraft = 'mira_version: "1.0"\nidentity:\n  id: saldos\n  display_name: Saldos\n  classification: internal'
const intent = JSON.stringify({ titulo: 'Saldos', pregunta_de_negocio: '¿cuánto?', audiencia: 'finanzas', grano: 'empresa' })

describe('WP5 · self-check (juez separado)', () => {
  it('draft bueno → APROBADA, sin brechas', async () => {
    const r = await runSelfCheck({ transport: judgeTransport({ veredicto: 'APROBADA', brechas: [] }), model: 'm', draftYaml: goodDraft, intentSummary: intent, probeContext: 'perfil clasificacion: TC(7)' })
    expect(r.veredicto).toBe('APROBADA')
    expect(r.brechas).toEqual([])
  })
  it('filtro literal roto vs perfil → M detectada', async () => {
    const r = await runSelfCheck({
      transport: judgeTransport({ veredicto: 'NO_APROBABLE', brechas: [{ id: 'M1', sev: 'M', brecha: "filtro 'TC' no calza con 'TC ' del perfil", donde: 'data.saldos.sql', recomendacion: 'usar el valor real con espacio' }] }),
      model: 'm', draftYaml: goodDraft, intentSummary: intent, probeContext: "perfil: 'TC ' (con espacio)",
    })
    expect(r.brechas[0].sev).toBe('M')
  })
  it('medida sin reconciliación → M', async () => {
    const r = await runSelfCheck({ transport: judgeTransport({ veredicto: 'APROBABLE', brechas: [{ id: 'M2', sev: 'M', brecha: 'medida sin probe de reconciliación', donde: 'medidas[0]', recomendacion: 'agregar una probe' }] }), model: 'm', draftYaml: goodDraft, intentSummary: intent })
    expect(r.brechas[0].sev).toBe('M')
  })
  it('veredicto/severidad fuera de vocabulario → se normaliza (NO_REVISABLE / i)', async () => {
    const r = await runSelfCheck({ transport: judgeTransport({ veredicto: 'PERFECTO', brechas: [{ id: 'x', sev: 'CRITICA', brecha: 'a', donde: 'b', recomendacion: 'c' }] }), model: 'm', draftYaml: goodDraft, intentSummary: intent })
    expect(r.veredicto).toBe('NO_REVISABLE')
    expect(r.brechas[0].sev).toBe('i')
  })
  it('si el juez no emite reporte estructurado → NO_REVISABLE con brecha B', async () => {
    const transport: AnthropicTransport = { async createMessage() { return { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'no usé la tool' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } } }
    const r = await runSelfCheck({ transport, model: 'm', draftYaml: goodDraft, intentSummary: intent })
    expect(r.veredicto).toBe('NO_REVISABLE')
    expect(r.brechas[0].sev).toBe('B')
  })
})

describe('WP6 · publish y su gate', () => {
  async function seededSession(state: string, opts: { qc?: unknown; draft?: string } = {}) {
    const gov = await SqliteGovernanceStore.open(null)
    await gov.createSession('s1', 'Saldos por empresa', 'ana@x.com')
    // Avanzar por la máquina de estados hasta `state`.
    const path: Record<string, string[]> = {
      borrador: ['borrador'],
      validado: ['borrador', 'validado'],
      autochequeado: ['borrador', 'validado', 'autochequeado'],
    }
    for (const st of path[state] ?? []) await gov.setMirandaState('s1', st as never)
    if (opts.draft) await gov.appendMirandaArtifact('s1', 'spec_draft', opts.draft)
    if (opts.qc !== undefined) await gov.appendMirandaArtifact('s1', 'qc_report', JSON.stringify(opts.qc))
    return gov
  }
  const deps = (gov: SqliteGovernanceStore, over: Partial<Parameters<typeof publishSpec>[1]> = {}) => ({
    store: gov,
    validateDraft: () => ({ ok: true as const }),
    writeSpec: vi.fn(async () => {}),
    now: () => '2026-07-14T00:00:00Z',
    ...over,
  })

  it('sesión autochequeada + qc sin B/M → asigna PI-101 y escribe el archivo', async () => {
    const gov = await seededSession('autochequeado', { draft: goodDraft, qc: { veredicto: 'APROBADA', brechas: [] } })
    const writeSpec = vi.fn(async (_filename: string, _content: string) => {})
    const r = await publishSpec('s1', deps(gov, { writeSpec }))
    expect(r.code).toBe('PI-101')
    expect(r.slug).toBe('pi-101')
    expect(writeSpec).toHaveBeenCalledOnce()
    const [filename, content] = writeSpec.mock.calls[0]
    expect(filename).toBe('pi101-saldos-por-empresa.yaml')
    expect(content).toContain('# PI-101 · Saldos por empresa')
    expect(content).toContain('code: PI-101') // identity.code inyectado
    expect((await gov.getMirandaSession('s1'))?.state).toBe('publicado')
    expect((await gov.getMirandaSession('s1'))?.piCode).toBe('PI-101')
  })

  it('rechaza si la sesión no está autochequeada', async () => {
    const gov = await seededSession('validado', { draft: goodDraft, qc: { veredicto: 'APROBADA', brechas: [] } })
    await expect(publishSpec('s1', deps(gov))).rejects.toBeInstanceOf(PublishBlocked)
  })

  it('rechaza si el último qc_report tiene una M abierta', async () => {
    const gov = await seededSession('autochequeado', { draft: goodDraft, qc: { veredicto: 'NO_APROBABLE', brechas: [{ id: 'M1', sev: 'M', brecha: 'x', donde: 'y', recomendacion: 'z' }] } })
    await expect(publishSpec('s1', deps(gov))).rejects.toThrow(/B\/M/)
  })

  it('rechaza si el draft no valida contra el DSL', async () => {
    const gov = await seededSession('autochequeado', { draft: 'basura', qc: { veredicto: 'APROBADA', brechas: [] } })
    await expect(publishSpec('s1', deps(gov, { validateDraft: () => ({ ok: false, error: 'schema' }) }))).rejects.toThrow(/no valida/)
  })

  it('el anuncio es no-fatal (un fallo no revierte la publicación)', async () => {
    const gov = await seededSession('autochequeado', { draft: goodDraft, qc: { veredicto: 'APROBADA', brechas: [] } })
    const r = await publishSpec('s1', deps(gov, { announce: async () => { throw new Error('slack caído') } }))
    expect(r.code).toBe('PI-101')
    expect((await gov.getMirandaSession('s1'))?.state).toBe('publicado')
  })
})
