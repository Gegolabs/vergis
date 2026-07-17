import { describe, it, expect, vi } from 'vitest'
import {
  runAgentTurn,
  TokenBudgetExceeded,
  MAX_TOKENS_APOLOGY,
  buildToolRegistry,
  buildSystemPrompt,
  type AnthropicTransport,
  type AnthropicResponse,
  type MirandaToolContext,
} from '@vergis/miranda'

/** Transporte fake: una cola de respuestas grabadas; cada createMessage consume la siguiente. */
function fakeTransport(responses: AnthropicResponse[]): { transport: AnthropicTransport } {
  let i = 0
  return {
    transport: {
      async createMessage() {
        const r = responses[i]
        i += 1
        if (!r) throw new Error('fake: sin más respuestas grabadas')
        return r
      },
    },
  }
}

const text = (t: string, stop: AnthropicResponse['stop_reason'] = 'end_turn', usage = { input_tokens: 10, output_tokens: 5 }): AnthropicResponse => ({
  id: 'm', role: 'assistant', content: [{ type: 'text', text: t }], stop_reason: stop, usage,
})
const toolUse = (name: string, input: unknown, usage = { input_tokens: 10, output_tokens: 5 }): AnthropicResponse => ({
  id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name, input }], stop_reason: 'tool_use', usage,
})

function ctx(over: Partial<MirandaToolContext> = {}): MirandaToolContext {
  const catalog = [{ name: 'dbo.v_saldos' }]
  return {
    catalog,
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
    ...over,
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

describe('agent loop · resolución de tool-calls', () => {
  it('un turno sin tools → devuelve el texto', async () => {
    const { transport } = fakeTransport([text('¿Qué PI quieres crear?')])
    const r = await runAgentTurn({ ...base(), transport, userMessage: 'hola' })
    expect(r.stopped).toBe('end_turn')
    expect(r.assistantText).toBe('¿Qué PI quieres crear?')
    expect(r.toolCalls).toHaveLength(0)
    expect(r.newMessages[0]).toEqual({ role: 'user', content: 'hola' })
  })

  it('el modelo pide una tool, Miranda la ejecuta y el modelo cierra', async () => {
    const catalogTables = vi.fn(async () => ({ tables: [{ name: 'dbo.v_saldos' }] }))
    const registry = buildToolRegistry(ctx())
    const spy = vi.spyOn(registry, 'invoke')
    const { transport } = fakeTransport([toolUse('catalog_tables', {}), text('Tienes v_saldos disponible.')])
    const r = await runAgentTurn({ ...base(), tools: registry, transport, userMessage: 'qué tablas hay' })
    void catalogTables
    expect(spy).toHaveBeenCalledWith('catalog_tables', {})
    expect(r.toolCalls[0].name).toBe('catalog_tables')
    expect(r.assistantText).toBe('Tienes v_saldos disponible.')
    // Mensajes: user, assistant(tool_use), user(tool_result), assistant(text)
    expect(r.newMessages).toHaveLength(4)
    expect(Array.isArray(r.newMessages[2].content) && r.newMessages[2].content[0].type).toBe('tool_result')
  })

  it('acumula tokens de todas las llamadas del turno', async () => {
    const { transport } = fakeTransport([toolUse('catalog_tables', {}, { input_tokens: 100, output_tokens: 20 }), text('listo', 'end_turn', { input_tokens: 40, output_tokens: 10 })])
    const r = await runAgentTurn({ ...base(), transport, userMessage: 'x' })
    expect(r.tokensUsed).toBe(170)
  })
})

describe('agent loop · presupuestos', () => {
  it('sobre el presupuesto de tokens → TokenBudgetExceeded con mensaje claro', async () => {
    const { transport } = fakeTransport([text('no debería llegar')])
    await expect(runAgentTurn({ ...base(), transport, userMessage: 'x', tokenBudget: 100, tokensUsedBefore: 100 })).rejects.toBeInstanceOf(TokenBudgetExceeded)
  })
  it('corta a maxTurns si el modelo nunca cierra (loop de tools)', async () => {
    // Siempre pide tool → el loop se corta a maxTurns.
    const responses = Array.from({ length: 5 }, () => toolUse('catalog_tables', {}))
    const { transport } = fakeTransport(responses)
    const r = await runAgentTurn({ ...base(), transport, userMessage: 'x', maxTurns: 3 })
    expect(r.stopped).toBe('max_turns')
    expect(r.toolCalls).toHaveLength(3)
  })
})

describe('agent loop · errores de API', () => {
  it('reintenta una vez y, si el 2º intento va, continúa', async () => {
    let n = 0
    const transport: AnthropicTransport = {
      async createMessage() {
        n += 1
        if (n === 1) throw new Error('503 transitorio')
        return text('recuperado')
      },
    }
    const r = await runAgentTurn({ ...base(), transport, userMessage: 'x' })
    expect(r.assistantText).toBe('recuperado')
    expect(n).toBe(2)
  })
  it('si persiste el fallo → propaga el error (nunca respuesta de Miranda)', async () => {
    const transport: AnthropicTransport = { async createMessage() { throw new Error('API caída') } }
    await expect(runAgentTurn({ ...base(), transport, userMessage: 'x', retries: 1 })).rejects.toThrow(/API caída/)
  })
})

// Plan 100 · addendum 2: el tope de emisión (`stop_reason: 'max_tokens'`) es un INCIDENTE, jamás un
// fin silencioso. Evidencia del arnés (2026-07-17): un turno murió con un tool_use de input vacío
// (emisión truncada a mitad del draft) y otro con un assistant de solo-thinking — el usuario no
// recibió respuesta en ninguno. El loop descarta el contenido truncado (un tool_use sin tool_result
// invalidaría el historial ante la API), NO ejecuta la tool truncada y responde con una disculpa
// visible en voz de negocio.
describe('agent loop · tope de emisión (max_tokens) — plan 100 addendum 2', () => {
  const truncatedToolUse = (name: string, input: unknown): AnthropicResponse => ({
    id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name, input }], stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 4096 },
  })

  it('tool_use truncado (input vacío) → NO se ejecuta; disculpa visible; sin tool_use colgante', async () => {
    const registry = buildToolRegistry(ctx())
    const spy = vi.spyOn(registry, 'invoke')
    const { transport } = fakeTransport([truncatedToolUse('save_draft', {})])
    const r = await runAgentTurn({ ...base(), tools: registry, transport, userMessage: 'quiero un estado de resultados' })
    expect(spy).not.toHaveBeenCalled() // el tool truncado JAMÁS se ejecuta como válido
    expect(r.stopped).toBe('max_tokens')
    expect(r.assistantText).toBe(MAX_TOKENS_APOLOGY)
    expect(r.assistantText).toMatch(/pídemelo de nuevo/) // visible y en voz de negocio, sin jerga
    // El contenido truncado se DESCARTA: lo persistible cierra con la disculpa (texto plano), de modo
    // que el historial del turno siguiente no arrastra un tool_use sin su tool_result.
    expect(r.newMessages).toHaveLength(2)
    expect(r.newMessages[1].role).toBe('assistant')
    expect(r.newMessages[1].content).toEqual([{ type: 'text', text: MAX_TOKENS_APOLOGY }])
    expect(r.tokensUsed).toBe(4106) // la llamada truncada igual se contabiliza al presupuesto
  })

  it('solo-thinking truncado (sin texto ni tool_use) → misma disculpa visible, turno cerrado', async () => {
    const thinkingOnly: AnthropicResponse = { id: 'm', role: 'assistant', content: [], stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 4096 } }
    const { transport } = fakeTransport([thinkingOnly])
    const r = await runAgentTurn({ ...base(), transport, userMessage: 'x' })
    expect(r.stopped).toBe('max_tokens')
    expect(r.assistantText).toBe(MAX_TOKENS_APOLOGY)
  })

  it('tras rondas de tools sanas, el truncamiento cierra con los pares tool_use/tool_result intactos', async () => {
    const { transport } = fakeTransport([toolUse('catalog_tables', {}), truncatedToolUse('save_draft', {})])
    const r = await runAgentTurn({ ...base(), transport, userMessage: 'x' })
    expect(r.stopped).toBe('max_tokens')
    // user, assistant(tool_use), user(tool_result), assistant(disculpa) — nada colgante.
    expect(r.newMessages).toHaveLength(4)
    expect(Array.isArray(r.newMessages[2].content) && r.newMessages[2].content[0].type).toBe('tool_result')
    expect(r.newMessages[3].content).toEqual([{ type: 'text', text: MAX_TOKENS_APOLOGY }])
  })

  it('max_tokens por llamada: default 16384, overrideable por deps', async () => {
    const captured: number[] = []
    const transport: AnthropicTransport = {
      async createMessage(req) {
        captured.push(req.max_tokens)
        return text('ok')
      },
    }
    await runAgentTurn({ ...base(), transport, userMessage: 'x' })
    await runAgentTurn({ ...base(), transport, userMessage: 'x', maxTokensPerCall: 2048 })
    expect(captured).toEqual([16384, 2048])
  })
})
