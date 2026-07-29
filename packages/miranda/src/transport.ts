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

/**
 * Marca de caché de la Messages API. Un bloque con `cache_control` cierra un PREFIJO cacheable:
 * el orden de render es `tools` → `system` → `messages`, así que la marca en el último bloque del
 * system cachea tools + system de una vez. Lo que va DESPUÉS del breakpoint (los mensajes del turno)
 * no se cachea — por eso el prefijo marcado debe ser estable entre turnos.
 */
export interface CacheControl {
  type: 'ephemeral'
}

/** Bloque de texto del system prompt (la forma en array, la única que admite `cache_control`). */
export interface SystemTextBlock {
  type: 'text'
  text: string
  cache_control?: CacheControl
}

export interface AnthropicRequest {
  model: string
  /** Texto plano, o la forma en ARRAY de bloques cuando se marca un breakpoint de caché. */
  system?: string | SystemTextBlock[]
  messages: AnthropicMessage[]
  tools?: ToolDefinition[]
  max_tokens: number
  /** Fuerza JSON/una tool concreta (self-check usa `tool_choice`). */
  tool_choice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string }
}

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  /** Tokens ESCRITOS al caché en esta llamada (se cobran ~1.25×). Ausente si no hubo caché. */
  cache_creation_input_tokens?: number
  /** Tokens SERVIDOS desde el caché (se cobran ~0.1×). Ausente si no hubo caché. */
  cache_read_input_tokens?: number
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

/**
 * Total de tokens de una respuesta. Con caché de prompt, `input_tokens` trae SOLO el remanente no
 * cacheado: el prompt completo es `input + cache_creation + cache_read`. Se suman los tres para que
 * el presupuesto de la sesión siga contando el mismo volumen que antes del caché (el caché abarata la
 * llamada, no acorta el prompt); ambos campos son opcionales y valen 0 cuando no hubo caché.
 */
export function usageTotal(u: AnthropicUsage): number {
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  )
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
