import { AppendOnlyLog } from './log'
import {
  VergisError,
  type Botlet,
  type BotletHost,
  type BotletId,
  type Capability,
  type FailureHandler,
  type IdentityContext,
  type InvocationContext,
  type InvocationResult,
  type RecoveryAction,
} from './types'

export interface BotlerConfig {
  logPath?: string
  identity?: IdentityContext
  agencyDomainId?: string
  /** Reloj inyectable para reproducibilidad en tests. */
  clock?: () => string
  /** Timeout por capability-call en ms (una Capability colgada no cuelga la invocación). Default 120 000. */
  capabilityTimeoutMs?: number
}

const DEFAULT_CAPABILITY_TIMEOUT_MS = 120_000

export interface BotletInfo {
  id: BotletId
  type: string
  registeredAt: string
  source: string
}

/**
 * Botler v0.1 — runtime genérico de Capa 3 (subconjunto del doc 1 §7).
 * Single-process, single-Botler. Hospeda Botlets, intermedia Capabilities,
 * mantiene el append-only log y garantiza el fallback agéntico.
 * No entiende el dominio de los Botlets que ejecuta (§5).
 */
export class Botler {
  private readonly capabilities = new Map<string, Capability>()
  private readonly botlets = new Map<BotletId, Botlet>()
  private readonly info = new Map<BotletId, BotletInfo>()
  private failureHandler: FailureHandler | null = null
  private started = false
  private readonly identity: IdentityContext
  readonly log: AppendOnlyLog

  constructor(private readonly config: BotlerConfig = {}) {
    this.log = new AppendOnlyLog(config.logPath, config.clock)
    this.identity = config.identity ?? { agent: 'vergis' }
  }

  // --- 7.1 ciclo de vida ---
  start(): void {
    if (this.started) return // idempotente (§4.1 / propiedad 15)
    this.started = true
    this.log.append({ type: 'botler-start', agencyDomain: this.config.agencyDomainId ?? 'vergis-lab' })
  }

  stop(): void {
    if (!this.started) return
    this.log.append({ type: 'botler-stop' })
    this.started = false
  }

  health(): { status: string; botlets: number; capabilities: number } {
    return {
      status: this.started ? 'ok' : 'stopped',
      botlets: this.botlets.size,
      capabilities: this.capabilities.size,
    }
  }

  // --- catálogo de Capabilities (§4.7) ---
  registerCapability(cap: Capability): void {
    this.capabilities.set(cap.name, cap)
    this.log.append({ type: 'capability-register', capability: cap.name })
  }

  capabilityNames(): string[] {
    return [...this.capabilities.keys()]
  }

  // --- 7.2 registro de Botlets ---
  register(botlet: Botlet, source = 'unknown'): BotletId {
    // §4.2: validar la spec contra su tipo antes de aceptar; el dominio lo valida el Botlet.
    try {
      botlet.validate({ capabilities: this.capabilityNames() })
    } catch (e) {
      const reason =
        e instanceof VergisError
          ? e.structured
          : { error: 'botler/register-failed', code: 'validation-error', message: String(e) }
      this.log.append({ type: 'botlet-register-rejected', botletId: botlet.id, botletType: botlet.type, reason })
      throw e
    }
    this.botlets.set(botlet.id, botlet)
    this.info.set(botlet.id, {
      id: botlet.id,
      type: botlet.type,
      registeredAt: (this.config.clock ?? (() => new Date().toISOString()))(),
      source,
    })
    this.log.append({ type: 'botlet-register', botletId: botlet.id, botletType: botlet.type, source })
    return botlet.id
  }

  list(): BotletInfo[] {
    return [...this.info.values()]
  }

  get(id: BotletId): BotletInfo | undefined {
    return this.info.get(id)
  }

  // --- 7.4 fallback agéntico ---
  onBotletFailure(handler: FailureHandler): void {
    this.failureHandler = handler
  }

  // --- 7.5 Capabilities ---
  async capabilityCall(ref: string, params: unknown, identity: IdentityContext): Promise<unknown> {
    const cap = this.capabilities.get(ref)
    if (!cap) {
      const err = new VergisError({
        error: 'botler/capability-call',
        code: 'capability-not-found',
        path: ref,
        message: `Capability '${ref}' no registrada en el Botler.`,
        remediation: `Registrar la Capability '${ref}' antes de invocarla.`,
      })
      this.log.append({ type: 'capability-call', capability: ref, ok: false, error: err.structured })
      throw err
    }
    // §4.7: política antes de ejecución (v0.1: passthrough mínimo, registrado).
    this.log.append({ type: 'policy-check', capability: ref, identity: identity.agent, decision: 'allow' })
    const timeoutMs = this.config.capabilityTimeoutMs ?? DEFAULT_CAPABILITY_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const data = await Promise.race([
        cap.execute(params, identity),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new VergisError({
                error: 'botler/capability-call',
                code: 'capability-timeout',
                path: ref,
                message: `Capability '${ref}' superó el timeout de ${timeoutMs} ms.`,
                remediation: 'Revisar la Capability o ajustar capabilityTimeoutMs del Botler.',
              }),
            )
          }, timeoutMs)
          timer.unref?.()
        }),
      ])
      this.log.append({ type: 'capability-call', capability: ref, ok: true })
      return data
    } catch (e) {
      this.log.append({ type: 'capability-call', capability: ref, ok: false, error: String(e) })
      throw e
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // --- 7.3 invocación ---
  async invoke(botletId: BotletId, ctx: InvocationContext): Promise<InvocationResult> {
    const botlet = this.botlets.get(botletId)
    if (!botlet) {
      throw new VergisError({
        error: 'botler/invoke',
        code: 'botlet-not-found',
        path: botletId,
        message: `Botlet '${botletId}' no registrado.`,
      })
    }
    this.log.append({ type: 'invoke', botletId, trigger: ctx.trigger, identity: ctx.identity.agent })
    const host: BotletHost = {
      identity: ctx.identity,
      capabilityCall: (ref, params, identity) => this.capabilityCall(ref, params, identity ?? ctx.identity),
      log: (event) => {
        this.log.append(event)
      },
    }
    try {
      const output = await botlet.invoke(ctx, host)
      this.log.append({ type: 'invoke-result', botletId, ok: true })
      return { ok: true, botletId, output }
    } catch (e) {
      // §4.4: garantía de fallback agéntico — el proceso nunca se detiene.
      const failure = {
        error: e instanceof Error ? e.message : String(e),
        stage: 'invoke',
        partial: (e as { partial?: unknown })?.partial,
      }
      let recovery: RecoveryAction = 'escalate-to-human'
      if (this.failureHandler) recovery = await this.failureHandler(botletId, failure)
      this.log.append({ type: 'agentic-fallback', botletId, cause: failure.error, recovery })
      return {
        ok: false,
        botletId,
        fallback: { reason: failure.error, recovery },
        error: e instanceof VergisError ? e.structured : undefined,
      }
    }
  }
}
