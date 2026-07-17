/**
 * Loop del agente de Miranda (tool-use sobre la Messages API). Un mensaje del usuario dispara un ciclo:
 * el modelo piensa, pide tools, Miranda las ejecuta (registry) y le devuelve los resultados, hasta que
 * el modelo cierra el turno (`end_turn`) o se agota el presupuesto de turnos. Presupuesto de tokens por
 * sesión: se rechaza sobre el tope con mensaje claro. Un fallo de la API se reintenta una vez; si
 * persiste, se propaga como error del sistema (nunca como respuesta de Miranda).
 *
 * PURO respecto de la red: recibe el `AnthropicTransport` inyectado → se testea con un fake.
 */
import type { AnthropicTransport, AnthropicMessage, AnthropicContentBlock, ToolResultBlock } from './transport'
import { usageTotal } from './transport'
import type { ToolRegistry } from './tools/registry'

export class TokenBudgetExceeded extends Error {
  constructor(
    public used: number,
    public budget: number,
  ) {
    super(`El presupuesto de esta sesión se agotó (${used}/${budget}); pide al administrador ampliarlo o inicia una sesión nueva.`)
    this.name = 'TokenBudgetExceeded'
  }
}
export class MaxTurnsExceeded extends Error {
  constructor(public turns: number) {
    super(`Miranda alcanzó el máximo de ${turns} turnos internos en este mensaje.`)
    this.name = 'MaxTurnsExceeded'
  }
}

export interface AgentEvent {
  type: 'assistant' | 'tool_use' | 'tool_result' | 'api_retry' | 'stop'
  detail?: unknown
}

export interface AgentDeps {
  transport: AnthropicTransport
  model: string
  system: string
  tools: ToolRegistry
  /** Historial previo de la conversación (mensajes ya persistidos). */
  history: AnthropicMessage[]
  /** Mensaje nuevo del usuario. */
  userMessage: string
  maxTurns: number
  /** Presupuesto de tokens de la sesión y lo ya gastado (para cortar). */
  tokenBudget: number
  tokensUsedBefore: number
  /** `max_tokens` por llamada (default 16384: los pasos de entrega-primero emiten thinking + un draft
   *  YAML completo en una sola llamada — 4096 se agotaba a mitad de la emisión; no hay presupuesto de
   *  thinking aparte en el transport, todo comparte este tope). */
  maxTokensPerCall?: number
  onEvent?: (e: AgentEvent) => void
  /** Persistencia INCREMENTAL (plan 103 etapa 1): se invoca con CADA mensaje nuevo del turno (assistant /
   *  tool_result / disculpa) apenas se produce — NO con el mensaje inicial del usuario (ya persistido por
   *  el llamador). `tokens` es el gasto de esa llamada (0 para el mensaje de tool_result). Se `await`ea
   *  para respetar el orden de persistencia. Ausente ⇒ comportamiento clásico (el llamador persiste al
   *  final). Un fallo del callback NO se traga: lo maneja el llamador. */
  onMessage?: (m: AnthropicMessage, meta: { tokens: number }) => void | Promise<void>
  /** Reintentos ante fallo de la API (default 1). */
  retries?: number
}

export interface AgentTurnResult {
  /** Texto final que se muestra al usuario. */
  assistantText: string
  /** Mensajes NUEVOS de este turno (user + assistant/tool), para persistir en el store. */
  newMessages: AnthropicMessage[]
  /** Tokens gastados en este turno. */
  tokensUsed: number
  /** Tools ejecutadas (nombre + input + resultado). */
  toolCalls: { name: string; input: unknown; result: Record<string, unknown> }[]
  stopped: 'end_turn' | 'max_turns' | 'max_tokens'
}

/** Disculpa visible cuando la emisión se trunca por `max_tokens` (voz de negocio, sin jerga). */
export const MAX_TOKENS_APOLOGY = 'Se me cortó la preparación de esto a medio camino — pídemelo de nuevo y lo retomo.'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Extrae el texto plano de una respuesta del modelo (concatena los bloques `text`). */
function textOf(content: AnthropicContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** Corre UN turno del usuario a través del loop tool-use. */
export async function runAgentTurn(deps: AgentDeps): Promise<AgentTurnResult> {
  const maxTokensPerCall = deps.maxTokensPerCall ?? 16384
  const retries = deps.retries ?? 1
  const emit = (e: AgentEvent): void => deps.onEvent?.(e)

  const newMessages: AnthropicMessage[] = [{ role: 'user', content: deps.userMessage }]
  const toolCalls: AgentTurnResult['toolCalls'] = []
  let tokensUsed = 0

  const overBudget = (): boolean => deps.tokensUsedBefore + tokensUsed >= deps.tokenBudget
  if (overBudget()) throw new TokenBudgetExceeded(deps.tokensUsedBefore + tokensUsed, deps.tokenBudget)

  for (let turn = 0; turn < deps.maxTurns; turn += 1) {
    if (overBudget()) throw new TokenBudgetExceeded(deps.tokensUsedBefore + tokensUsed, deps.tokenBudget)

    const messages = [...deps.history, ...newMessages]
    // Llamada al modelo con 1 reintento (backoff). Un fallo persistente se propaga (error del sistema).
    let resp
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        resp = await deps.transport.createMessage({
          model: deps.model,
          system: deps.system,
          messages,
          tools: deps.tools.definitions,
          max_tokens: maxTokensPerCall,
        })
        break
      } catch (e) {
        lastErr = e
        if (attempt < retries) {
          emit({ type: 'api_retry', detail: attempt + 1 })
          await sleep(300 * (attempt + 1))
        }
      }
    }
    if (!resp) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))

    tokensUsed += usageTotal(resp.usage)
    const content = resp.content as AnthropicContentBlock[]

    // Tope de emisión (`max_tokens`) = INCIDENTE, jamás fin silencioso (arnés 2026-07-17, plan 100
    // addendum 2): la emisión quedó TRUNCADA — un tool_use aquí puede traer input vacío/parcial y NO
    // debe ejecutarse como válido, y un assistant de solo-thinking dejaría al usuario sin respuesta.
    // Se registra el evento, se DESCARTA el contenido truncado (persistir un tool_use sin su
    // tool_result invalidaría el historial ante la API en el turno siguiente) y se responde con una
    // disculpa VISIBLE en voz de negocio. El llamador persiste esto como un cierre normal → el
    // marcador de turno se limpia por su camino de siempre (la sesión no queda colgada).
    const callTokens = usageTotal(resp.usage)
    if (resp.stop_reason === 'max_tokens') {
      emit({ type: 'stop', detail: 'max_tokens' })
      const apology: AnthropicMessage = { role: 'assistant', content: [{ type: 'text', text: MAX_TOKENS_APOLOGY }] }
      newMessages.push(apology)
      await deps.onMessage?.(apology, { tokens: callTokens })
      return { assistantText: MAX_TOKENS_APOLOGY, newMessages, tokensUsed, toolCalls, stopped: 'max_tokens' }
    }

    const assistantMsg: AnthropicMessage = { role: 'assistant', content }
    newMessages.push(assistantMsg)
    await deps.onMessage?.(assistantMsg, { tokens: callTokens })
    emit({ type: 'assistant', detail: textOf(content) })

    if (resp.stop_reason !== 'tool_use') {
      emit({ type: 'stop', detail: resp.stop_reason })
      return { assistantText: textOf(content), newMessages, tokensUsed, toolCalls, stopped: 'end_turn' }
    }

    // Resolver TODAS las tool_use de este mensaje y devolver los tool_result en UN mensaje de usuario.
    const toolUses = content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use')
    const results: ToolResultBlock[] = []
    for (const tu of toolUses) {
      emit({ type: 'tool_use', detail: { name: tu.name, input: tu.input } })
      const result = await deps.tools.invoke(tu.name, tu.input)
      toolCalls.push({ name: tu.name, input: tu.input, result })
      emit({ type: 'tool_result', detail: { name: tu.name, result } })
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: 'error' in result,
      })
    }
    const toolMsg: AnthropicMessage = { role: 'user', content: results }
    newMessages.push(toolMsg)
    await deps.onMessage?.(toolMsg, { tokens: 0 })
  }

  // Se agotaron los turnos internos: cortamos con lo último que dijo Miranda (o una nota).
  const lastAssistant = [...newMessages].reverse().find((m) => m.role === 'assistant')
  const lastText = lastAssistant && Array.isArray(lastAssistant.content) ? textOf(lastAssistant.content) : ''
  emit({ type: 'stop', detail: 'max_turns' })
  return {
    assistantText: lastText || `He alcanzado el máximo de pasos para este mensaje. Cuéntame cómo seguir o pídeme que retome.`,
    newMessages,
    tokensUsed,
    toolCalls,
    stopped: 'max_turns',
  }
}
