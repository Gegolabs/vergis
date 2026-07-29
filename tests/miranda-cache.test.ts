// El system prompt de Miranda (identidad + reglas duras + DSL + rúbrica + voz, ~60k tokens) se
// ensambla UNA vez al arranque y viajaba entero en cada turno sin marca de caché. Es el prefijo
// estable por excelencia: se emite en la forma de array con `cache_control: {type:'ephemeral'}` en el
// último bloque, que —por el orden de render `tools` → `system` → `messages`— cierra un prefijo que
// abarca también las definiciones de tools. Lo variable del turno (historial + mensaje) va después.
import { describe, it, expect } from 'vitest'
import {
  runAgentTurn,
  buildToolRegistry,
  buildSystemPrompt,
  usageTotal,
  type AnthropicRequest,
  type AnthropicResponse,
  type AnthropicTransport,
  type MirandaToolContext,
} from '@vergis/miranda'

/** Transporte fake que además CAPTURA cada request, para inspeccionar cómo se construyó. */
function capturingTransport(responses: AnthropicResponse[]): {
  transport: AnthropicTransport
  requests: AnthropicRequest[]
} {
  const requests: AnthropicRequest[] = []
  let i = 0
  return {
    requests,
    transport: {
      async createMessage(req) {
        requests.push(req)
        const r = responses[i]
        i += 1
        if (!r) throw new Error('fake: sin más respuestas grabadas')
        return r
      },
    },
  }
}

const text = (t: string): AnthropicResponse => ({
  id: 'm', role: 'assistant', content: [{ type: 'text', text: t }],
  stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
})
const toolUse = (name: string, input: unknown): AnthropicResponse => ({
  id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name, input }],
  stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
})

function ctx(): MirandaToolContext {
  return {
    catalog: [{ name: 'dbo.v_saldos' }],
    isAllowed: () => true,
    runProbe: async () => ({ rows: [{ n: 1 }] }),
    columnsOf: async () => [],
    sampleRows: async () => [],
    profileColumn: async () => [],
    listSpecs: () => [],
    readSpec: () => null,
    validateDraft: () => ({ ok: true }),
    saveDraft: async () => ({ version: 1 }),
    updateIntent: async () => ({ version: 1 }),
    createDataRequest: async () => ({ ok: true }),
    renderPreview: async () => ({ url: '/x' }),
    runSelfCheck: async () => ({ veredicto: 'APROBADA', brechas: [] }),
  }
}

const base = () => ({
  model: 'claude-test',
  system: buildSystemPrompt(),
  tools: buildToolRegistry(ctx()),
  history: [],
  maxTurns: 10,
  tokenBudget: 500_000,
  tokensUsedBefore: 0,
})

describe('agent · prompt caching del system prompt', () => {
  it('el system viaja como array de bloques con cache_control ephemeral en el último', async () => {
    const { transport, requests } = capturingTransport([text('hola')])
    await runAgentTurn({ ...base(), transport, userMessage: 'hola' })

    const sys = requests[0]!.system
    expect(Array.isArray(sys)).toBe(true)
    const blocks = sys as Exclude<typeof sys, string | undefined>
    expect(blocks.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    // Un solo breakpoint (el tope de la API son 4).
    expect(blocks.filter((b) => b.cache_control).length).toBe(1)
  })

  it('el CONTENIDO del prompt no cambia: solo su estructura', async () => {
    const { transport, requests } = capturingTransport([text('hola')])
    await runAgentTurn({ ...base(), transport, userMessage: 'hola' })

    const blocks = requests[0]!.system as { type: 'text'; text: string }[]
    expect(blocks.map((b) => b.text).join('')).toBe(buildSystemPrompt())
    expect(blocks.every((b) => b.type === 'text')).toBe(true)
  })

  it('el prefijo marcado es IDÉNTICO entre turnos internos (si no, no hay hit de caché)', async () => {
    const { transport, requests } = capturingTransport([
      toolUse('catalog_tables', {}),
      text('listo'),
    ])
    await runAgentTurn({ ...base(), transport, userMessage: 'dame el catálogo' })

    expect(requests.length).toBeGreaterThan(1)
    const rendered = requests.map((r) => JSON.stringify({ system: r.system, tools: r.tools }))
    expect(new Set(rendered).size).toBe(1)
    // …y lo VARIABLE del turno crece después del breakpoint, en messages.
    expect(requests[1]!.messages.length).toBeGreaterThan(requests[0]!.messages.length)
  })

  it('usageTotal cuenta el prompt completo aunque venga del caché (presupuesto sin cambio)', () => {
    // Sin caché: el prompt entero llega como input_tokens.
    expect(usageTotal({ input_tokens: 60_000, output_tokens: 500 })).toBe(60_500)
    // Con caché: el mismo prompt se reparte entre input + creation + read → mismo total.
    expect(
      usageTotal({
        input_tokens: 200,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 59_800,
      }),
    ).toBe(60_500)
  })
})
