// Contratos núcleo del Botler (doc 1 del cluster 006).
// El Botler es runtime genérico: define las interfaces, no el dominio.

export type BotletId = string

/**
 * Claims del consumidor: claim → valor(es). Los entrega el gate (oauth2-proxy/AAD);
 * el Botler los porta en la identidad e inyecta hacia el motor (doc 10 §5). El consumidor
 * JAMÁS los controla. Estructuralmente idéntico al `ClaimSet` de `@vergis/policy` (que no
 * puede importarse acá: policy depende de botler, no al revés).
 */
export type ClaimSet = Record<string, string[] | string | undefined>

export interface IdentityContext {
  agent: string
  user?: string
  /** Grupos/atributos del consumidor (los del gate). Canal por el que viaja la identidad
   *  hasta la inyección de RLS; el consumidor no puede escribirlos. */
  claims?: ClaimSet
}

/** Error estructurado y accionable — principio Agent First (canon §6). */
export interface StructuredError {
  error: string
  code: string
  path?: string
  value?: unknown
  message: string
  remediation?: string
}

export class VergisError extends Error {
  readonly structured: StructuredError
  constructor(structured: StructuredError) {
    super(structured.message)
    this.name = 'VergisError'
    this.structured = structured
  }
}

/** Capability (Capa 4). Solo se invoca a través del Botler — nunca por bypass. */
export interface Capability {
  readonly name: string
  execute(params: unknown, identity: IdentityContext): Promise<unknown>
}

/** Handle controlado que el Botler entrega a un Botlet para actuar sin saltarse la gobernanza. */
export interface BotletHost {
  readonly identity: IdentityContext
  capabilityCall(ref: string, params: unknown, identity?: IdentityContext): Promise<unknown>
  log(event: LogEventInput): void
}

export interface InvocationContext {
  identity: IdentityContext
  trigger: 'on-demand' | 'scheduled' | 'push'
  params?: Record<string, unknown>
}

export interface InvocationResult {
  ok: boolean
  botletId: BotletId
  output?: unknown
  fallback?: { reason: string; recovery: RecoveryAction }
  error?: StructuredError
}

/** Botlet — unidad genérica que el Botler hospeda. El Botler NO conoce su dominio. */
export interface Botlet {
  readonly id: BotletId
  readonly type: string
  /** Validación de dominio (la especialización vive en el Botlet, no en el Botler). Lanza VergisError si es inválida. */
  validate(ctx: { capabilities: string[] }): void
  invoke(ctx: InvocationContext, host: BotletHost): Promise<unknown>
}

export type RecoveryAction =
  | 'execute-manually'
  | 'mark-for-regeneration'
  | 'escalate-to-human'
  | 'degrade'

export interface FailureContext {
  error: string
  stage: string
  partial?: unknown
}

export type FailureHandler = (
  botletId: BotletId,
  failure: FailureContext,
) => RecoveryAction | Promise<RecoveryAction>

export interface LogEventInput {
  type: string
  [k: string]: unknown
}

export interface LogEntry extends LogEventInput {
  seq: number
  ts: string
  prevHash: string
  hash: string
}
