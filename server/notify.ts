/**
 * Avisos salientes del producto (issue #100) — puerto de notificación DESACOPLADO del canal.
 *
 * El producto compone mensajes canal-agnósticos (`Notification`: estructura, no markup) y los envía
 * por N destinos declarados en la config de instancia (`VERGIS_NOTIFY` → YAML). Cada sink renderiza
 * a su forma: Slack (mrkdwn `{ text }`) o webhook genérico (el objeto JSON tal cual — contrato
 * declarado para puentear a cualquier canal sin que el producto lo conozca).
 *
 * Fan-out con aislamiento: un sink caído se loguea y no bloquea a los demás. Sin retry: at-most-once
 * (el dedup por transición del lazo de frescura hace el anti-ruido; un aviso perdido no se re-emite).
 * El reporte periódico (#102) REUSA este puerto componiendo sus propios `Notification`.
 */
import type { ProcessHealth } from '@vergis/capabilities'

export type NotificationSeverity = 'warning' | 'ok' | 'info'
export interface NotificationLink {
  label: string
  url: string
}
/** Mensaje canal-agnóstico: texto plano estructurado; el markup lo pone cada sink. */
export interface Notification {
  severity: NotificationSeverity
  /** Titular de una línea, sin markup. */
  title: string
  /** Cuerpo en líneas de texto plano. */
  lines: string[]
  links: NotificationLink[]
  /** Evento estructurado (los sinks de máquina lo reenvían tal cual). */
  data: Record<string, unknown>
}

export interface NotificationSink {
  id: string
  send(n: Notification): Promise<void>
}

// ── Config declarativa (VERGIS_NOTIFY → YAML) ────────────────────────────────────────────────────
export type NotifyDestinationType = 'slack-webhook' | 'webhook'
export interface NotifyDestination {
  id: string
  type: NotifyDestinationType
  url: string
}
export interface NotifyConfig {
  destinations: NotifyDestination[]
}

const TIPOS: NotifyDestinationType[] = ['slack-webhook', 'webhook']

/**
 * Valida `{ destinations: [...] }`. LANZA ante forma inválida (boot fail-closed, patrón `domains`):
 * un destino mal declarado rompe el arranque con mensaje claro, nunca se ignora en silencio.
 */
export function parseNotifyConfig(doc: unknown): NotifyConfig {
  const root = (doc ?? {}) as Record<string, unknown>
  const raw = root['destinations']
  if (raw == null) return { destinations: [] }
  if (!Array.isArray(raw)) throw new Error('notify: `destinations` debe ser una lista.')
  const seen = new Set<string>()
  const destinations = raw.map((d, i): NotifyDestination => {
    const o = (d ?? {}) as Record<string, unknown>
    const type = String(o['type'] ?? '')
    if (!TIPOS.includes(type as NotifyDestinationType)) throw new Error(`notify: destino #${i} con type inválido '${type}' (esperado ${TIPOS.join(' | ')}).`)
    const url = String(o['url'] ?? '').trim()
    if (!/^https?:\/\//.test(url)) throw new Error(`notify: destino #${i} sin url válida (esperado http:// o https://).`)
    const id = o['id'] != null ? String(o['id']).trim() : `${type}-${i + 1}`
    if (!id) throw new Error(`notify: destino #${i} con id vacío.`)
    if (seen.has(id)) throw new Error(`notify: id de destino duplicado '${id}'.`)
    seen.add(id)
    return { id, type: type as NotifyDestinationType, url }
  })
  return { destinations }
}

/** Tipo del fetch inyectable (tests); default el global. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>

/**
 * Sinks desde la config. Ninguno captura errores: el aislamiento es del `fanout` (un solo lugar donde
 * se decide qué se loguea y qué se traga).
 */
export function createSinks(cfg: NotifyConfig, fetchImpl?: FetchLike): NotificationSink[] {
  const post: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init))
  return cfg.destinations.map((d): NotificationSink => {
    const body = d.type === 'slack-webhook' ? (n: Notification): string => JSON.stringify({ text: renderSlackText(n) }) : (n: Notification): string => JSON.stringify(n)
    return {
      id: d.id,
      send: async (n) => {
        await post(d.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(n) })
      },
    }
  })
}

const ICONO: Record<NotificationSeverity, string> = {
  warning: ':warning:',
  ok: ':white_check_mark:',
  info: ':information_source:',
}

/** Render mrkdwn de Slack (exportada para tests). */
export function renderSlackText(n: Notification): string {
  const partes = [`${ICONO[n.severity]} *${n.title}*`, ...n.lines]
  if (n.links.length) partes.push(n.links.map((l) => `<${l.url}|${l.label}>`).join(' · '))
  return partes.join('\n')
}

/** Fan-out con aislamiento por sink (D3). Nunca lanza: un destino caído no tumba el tick. */
export async function fanout(sinks: NotificationSink[], n: Notification, log: (line: string) => void): Promise<void> {
  for (const s of sinks) {
    try {
      await s.send(n)
    } catch (e) {
      log(`notify[${s.id}]: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// ── Composición de avisos de frescura (PURA — el lazo la invoca) ─────────────────────────────────
export interface FreshnessAlertContext {
  processId: string
  processLabel: string
  /** Dominio ENLAZABLE: id/label solo si la fuente lo tagea Y está declarado en domains.yaml. */
  domainId?: string
  domainLabel?: string
  reason: 'failed' | 'missed'
  lastError?: string
  /** Salud clasificada (classifyProcess) al momento del aviso. */
  health: ProcessHealth
  requiredCadenceSeconds: number
  /** startedAt (ISO del motor, tal cual) de la corrida más reciente — para el enlace a la corrida. */
  lastRunStartedAt?: string
  /** VERGIS_PUBLIC_URL normalizada (sin slash final). */
  baseUrl: string
}

const SIN_DOMINIO = '(sin dominio)'
const SIN_ENLACES = 'enlaces no disponibles: el proceso no pertenece a un dominio declarado'
const hrefFrescura = (baseUrl: string, domainId: string): string => `${baseUrl}/admin/dominio/${domainId}/frescura`

export function composeFreshnessAlert(ctx: FreshnessAlertContext): Notification {
  const desenlace = ctx.reason === 'failed' ? 'la corrida falló' : 'atrasada (no corre a tiempo)'
  const lines: string[] = []
  if (ctx.lastError) lines.push(`motivo: ${ctx.lastError}`)
  const last = ctx.health.lastSuccessAt
  lines.push(last != null ? `última corrida exitosa: hace ${fmtDur(ctx.health.ageSeconds ?? 0)} (${last})` : 'nunca ha registrado una corrida exitosa')
  // La hora esperada se OMITE cuando la cadencia no es finita: un proceso fuera del mapa de ingestión
  // no tiene «antes de cuándo» que prometer — decir «Infinity» sería peor que callar.
  let expectedAt: string | null = null
  if (Number.isFinite(ctx.requiredCadenceSeconds)) {
    if (last != null) {
      expectedAt = new Date(Date.parse(last) + ctx.requiredCadenceSeconds * 1000).toISOString()
      lines.push(`se esperaba una corrida antes de: ${expectedAt} (cadencia requerida ${fmtDur(ctx.requiredCadenceSeconds)})`)
    } else {
      lines.push(`cadencia requerida: ${fmtDur(ctx.requiredCadenceSeconds)}`)
    }
  }
  if (ctx.domainId == null) lines.push(SIN_ENLACES)

  const links: NotificationLink[] = []
  if (ctx.domainId != null) {
    if (ctx.reason === 'failed' && ctx.lastRunStartedAt)
      links.push({
        label: 'Ver corrida',
        url: `${ctx.baseUrl}/admin/dominio/${ctx.domainId}/corrida?proc=${encodeURIComponent(ctx.processId)}&started=${encodeURIComponent(ctx.lastRunStartedAt)}`,
      })
    links.push({ label: 'Frescura del dominio', url: hrefFrescura(ctx.baseUrl, ctx.domainId) })
  }

  return {
    severity: 'warning',
    title: `Frescura — ${ctx.domainLabel ?? SIN_DOMINIO} · ${ctx.processLabel}: ${desenlace}`,
    lines,
    links,
    data: {
      event: 'freshness-alert',
      processId: ctx.processId,
      reason: ctx.reason,
      ageSeconds: ctx.health.ageSeconds,
      lastError: ctx.lastError ?? null,
      expectedAt,
      domainId: ctx.domainId ?? null,
    },
  }
}

export function composeFreshnessRecovery(ctx: { processId: string; processLabel: string; domainId?: string; domainLabel?: string; baseUrl: string }): Notification {
  return {
    severity: 'ok',
    title: `Frescura — ${ctx.domainLabel ?? SIN_DOMINIO} · ${ctx.processLabel}: recuperado`,
    lines: ctx.domainId == null ? [SIN_ENLACES] : [],
    links: ctx.domainId == null ? [] : [{ label: 'Frescura del dominio', url: hrefFrescura(ctx.baseUrl, ctx.domainId) }],
    data: { event: 'freshness-recovery', processId: ctx.processId, domainId: ctx.domainId ?? null },
  }
}

/**
 * Duración humana aproximada (exportada para tests). Los cortes son estrictos: 90 s se lee «90 s» y
 * 5400 s «90 min» — redondear ahí escondería la magnitud que el operador está mirando.
 */
export function fmtDur(seconds: number): string {
  if (seconds > 172_800) return `${Math.round(seconds / 86_400)} d`
  if (seconds > 5_400) return `${Math.round(seconds / 3_600)} h`
  if (seconds > 90) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds)} s`
}
