/**
 * @vergis/miranda — Miranda, el agente conversacional que autora specs de PI (cluster 077 del lab).
 * «Mira sirve, Miranda conversa.» La superficie HTTP vive en el server (`server/miranda.ts`); este
 * paquete es el motor: tools, loop del agente, self-check QC① y publicación.
 */
export const MIRANDA_VERSION = '0.1.0'

export { guardProbeSql, referencedTables, SqlGuardError, type SqlGuardOptions, type GuardedProbe } from './tools/sql-guard'
export { buildToolRegistry, type ToolRegistry, type ToolDefinition } from './tools/registry'
export { repr, type ToolResult } from './tools/tools'
export type { MirandaToolContext, CatalogEntry, SpecRef } from './tools/context'
export { validateIntentSummary, normalizeIntent, type IntentSummary } from './intent'
export { hasBlockingGaps, VEREDICTOS, SEVERIDADES, type Veredicto, type Severidad, type Brecha, type SelfCheckResult } from './qc'
export {
  fetchAnthropicTransport,
  usageTotal,
  type AnthropicTransport,
  type AnthropicRequest,
  type AnthropicResponse,
  type AnthropicMessage,
  type AnthropicContentBlock,
  type ToolUseBlock,
  type TextBlock,
  type ToolResultBlock,
} from './transport'
export { buildSystemPrompt, MIRANDA_HARD_RULES, type SystemPromptOptions } from './prompt'
export { runAgentTurn, TokenBudgetExceeded, MaxTurnsExceeded, type AgentDeps, type AgentTurnResult, type AgentEvent } from './agent'
