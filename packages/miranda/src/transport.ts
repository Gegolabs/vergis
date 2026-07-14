/**
 * Transporte hacia la Messages API de Anthropic — la ÚNICA frontera con el modelo. Es una interfaz
 * (`AnthropicTransport`) para que el loop del agente y el self-check sean testeables con un transporte
 * FAKE (fixtures grabadas), sin red. La implementación real (`fetchAnthropicTransport`) usa `fetch` y
 * jamás se ejerce en tests. La API key entra por env (config) y NUNCA se registra en transcripts ni logs.
 */
import type { ToolDefinition } from './tools/registry'

export interface TextBlock {
  type: 'text'
  text: string
}
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}
export type AnthropicContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicRequest {
  model: string
  system?: string
  messages: AnthropicMessage[]
  tools?: ToolDefinition[]
  max_tokens: number
  /** Fuerza JSON/una tool concreta (self-check usa `tool_choice`). */
  tool_choice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string }
}

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
}

export interface AnthropicResponse {
  id: string
  role: 'assistant'
  content: (TextBlock | ToolUseBlock)[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null
  usage: AnthropicUsage
}

export interface AnthropicTransport {
  createMessage(req: AnthropicRequest, signal?: AbortSignal): Promise<AnthropicResponse>
}

/** Total de tokens de una respuesta (input + output). */
export function usageTotal(u: AnthropicUsage): number {
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
}

export interface FetchTransportOptions {
  apiKey: string
  baseUrl?: string
  anthropicVersion?: string
}

/**
 * Transporte real vía `fetch`. NO se usa en tests (la corrida de implementación corre todo con fake).
 * La key viaja en la cabecera `x-api-key`; nunca se loguea. Un error HTTP se propaga como Error (el
 * loop lo reintenta una vez y, si persiste, lo muestra como error del sistema — no como respuesta de
 * Miranda).
 */
export function fetchAnthropicTransport(opts: FetchTransportOptions): AnthropicTransport {
  const base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const version = opts.anthropicVersion ?? '2023-06-01'
  return {
    async createMessage(req, signal) {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': version,
        },
        body: JSON.stringify(req),
        signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        // No incluir cabeceras/key en el mensaje; el body de error de Anthropic no lleva secretos.
        throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`)
      }
      return (await res.json()) as AnthropicResponse
    },
  }
}
