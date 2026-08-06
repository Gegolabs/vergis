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
import { readFileSync } from 'node:fs'
import { requireRootKey, type ProcessHealth } from '@vergis/capabilities'
import { sendSmtp, type MailMessage, type SmtpConnectConfig } from './smtp'

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
export type NotifyDestinationType = 'slack-webhook' | 'webhook' | 'email-smtp'

/**
 * A qué FLUJO se suscribe un destino (issue #102). El routing por tipo de mensaje vive en la CONFIG
 * y se aplica en el WIRING (`forEvent`): el `Notification` sigue sin saber por dónde sale.
 */
export type NotifyEvent = 'alerts' | 'reports'

export interface WebhookDestination {
  id: string
  type: 'slack-webhook' | 'webhook'
  url: string
  /** Default ['alerts'] — la semántica de #100, intacta. */
  events: NotifyEvent[]
}
/** Relay de submission de la instancia. La contraseña vive en el ENTORNO, jamás en el YAML. */
export interface EmailSmtpDecl {
  host: string
  port: number
  /** default 'starttls' */
  tls?: 'starttls' | 'implicit' | 'none'
  /** Ruta a un PEM con la CA privada del relay. */
  caFile?: string
  user?: string
  /** Nombre de la env con la contraseña (requerido si hay `user`). */
  passEnv?: string
  /** default 'plain' */
  authMethod?: 'plain' | 'login'
}
export interface EmailDestination {
  id: string
  type: 'email-smtp'
  events: NotifyEvent[]
  smtp: EmailSmtpDecl
  /** Remitente (configurable por instancia). Acepta `Nombre <a@b>`. */
  from: string
  /** Destinatarios (lista configurable por instancia). */
  to: string[]
}
export type NotifyDestination = WebhookDestination | EmailDestination

export type ReportWeekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
/** Cadencia del reporte periódico (issue #102). Su presencia ENCIENDE el latido. */
export interface ReportSchedule {
  /** Hora local del envío, HH:MM. Default '07:00'. */
  at: string
  /** IANA. Ausente = timezone del host, resuelta en el boot y logueada. */
  timezone?: string
  every: 'daily' | 'weekly'
  /** Solo con weekly (default 'monday'); presente con daily LANZA. */
  weekday?: ReportWeekday
}
export interface NotifyConfig {
  destinations: NotifyDestination[]
  report?: ReportSchedule
}

const TIPOS: NotifyDestinationType[] = ['slack-webhook', 'webhook', 'email-smtp']
const EVENTOS: NotifyEvent[] = ['alerts', 'reports']
const TLS_MODOS = ['starttls', 'implicit', 'none'] as const
const WEEKDAYS: ReportWeekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

/**
 * Valida `{ destinations: [...] }`. LANZA ante forma inválida (boot fail-closed, patrón `domains`):
 * un destino mal declarado rompe el arranque con mensaje claro, nunca se ignora en silencio.
 * La clave raíz sigue el contrato de #117 (`requireRootKey`): un notify.yaml declarado que perdió
 * `destinations:` es un archivo roto y NO arranca — el sistema que avisa fallos no puede
 * desactivarse por evaporación silenciosa; «cero destinos» se declara con `destinations: []`.
 */
export function parseNotifyConfig(doc: unknown): NotifyConfig {
  const raw = requireRootKey(doc, 'notify', 'destinations')
  if (!Array.isArray(raw)) throw new Error('notify: `destinations` debe ser una lista — para declarar «no hay», usa `destinations: []`.')
  const seen = new Set<string>()
  const destinations = raw.map((d, i): NotifyDestination => {
    const o = (d ?? {}) as Record<string, unknown>
    const type = String(o['type'] ?? '')
    if (!TIPOS.includes(type as NotifyDestinationType)) throw new Error(`notify: destino #${i} con type inválido '${type}' (esperado ${TIPOS.join(' | ')}).`)
    const id = o['id'] != null ? String(o['id']).trim() : `${type}-${i + 1}`
    if (!id) throw new Error(`notify: destino #${i} con id vacío.`)
    if (seen.has(id)) throw new Error(`notify: id de destino duplicado '${id}'.`)
    seen.add(id)
    const events = parseEvents(o['events'], i)
    if (type === 'email-smtp') return { id, type, events, ...parseEmail(o, id) }
    const url = String(o['url'] ?? '').trim()
    if (!/^https?:\/\//.test(url)) throw new Error(`notify: destino #${i} sin url válida (esperado http:// o https://).`)
    return { id, type: type as 'slack-webhook' | 'webhook', url, events }
  })

  const report = doc != null && typeof doc === 'object' && 'report' in doc ? parseReport((doc as Record<string, unknown>)['report']) : undefined

  // Validación CRUZADA fail-closed (D2): una promesa sin emisor y un emisor sin receptor son ambos
  // config contradictoria. Se rompe el boot con el nombre, no se descubre el día que no llegó nada.
  const suscritos = destinations.filter((d) => d.events.includes('reports'))
  if (report && !suscritos.length) throw new Error("notify: report declarado pero ningún destino se suscribe a 'reports'.")
  if (!report && suscritos.length) throw new Error(`notify: el destino '${suscritos[0]!.id}' se suscribe a 'reports' pero no hay bloque report.`)

  return report ? { destinations, report } : { destinations }
}

function parseEvents(raw: unknown, i: number): NotifyEvent[] {
  if (raw == null) return ['alerts'] // el default conserva EXACTA la semántica de #100
  const lista = Array.isArray(raw) ? raw.map((e) => String(e)) : []
  if (!lista.length || lista.some((e) => !EVENTOS.includes(e as NotifyEvent)))
    throw new Error(`notify: destino #${i} con events inválido '${Array.isArray(raw) ? lista.join(',') : String(raw)}' (esperado lista no vacía de ${EVENTOS.join(' | ')}).`)
  return lista as NotifyEvent[]
}

function parseEmail(o: Record<string, unknown>, id: string): { smtp: EmailSmtpDecl; from: string; to: string[] } {
  const s = (o['smtp'] ?? {}) as Record<string, unknown>
  const host = String(s['host'] ?? '').trim()
  if (!host) throw new Error(`notify: destino '${id}' sin smtp.host.`)
  const port = Number(s['port'])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`notify: destino '${id}' con smtp.port inválido '${String(s['port'])}' (entero 1–65535).`)
  const tls = s['tls'] == null ? 'starttls' : String(s['tls'])
  if (!(TLS_MODOS as readonly string[]).includes(tls)) throw new Error(`notify: destino '${id}' con smtp.tls inválido '${tls}' (esperado ${TLS_MODOS.join(' | ')}).`)
  const user = s['user'] != null ? String(s['user']).trim() : undefined
  const passEnv = s['passEnv'] != null ? String(s['passEnv']).trim() : undefined
  if (user && !passEnv) throw new Error(`notify: destino '${id}' declara smtp.user sin smtp.passEnv (la contraseña vive en el entorno, no en el YAML).`)
  if (user && tls === 'none') throw new Error(`notify: destino '${id}' declara auth sobre tls 'none' (credenciales en claro).`)
  const authMethod = s['authMethod'] == null ? 'plain' : String(s['authMethod'])
  if (authMethod !== 'plain' && authMethod !== 'login') throw new Error(`notify: destino '${id}' con smtp.authMethod inválido '${authMethod}' (esperado plain | login).`)
  const caFile = s['caFile'] != null ? String(s['caFile']).trim() : undefined
  const from = String(o['from'] ?? '').trim()
  if (!from) throw new Error(`notify: destino '${id}' sin from.`)
  const to = Array.isArray(o['to']) ? o['to'].map((t) => String(t).trim()).filter(Boolean) : []
  if (!to.length || to.some((t) => !t.includes('@'))) throw new Error(`notify: destino '${id}' con to inválido (lista no vacía de direcciones con '@').`)
  const smtp: EmailSmtpDecl = { host, port, tls: tls as EmailSmtpDecl['tls'], authMethod: authMethod as 'plain' | 'login' }
  if (caFile) smtp.caFile = caFile
  if (user) smtp.user = user
  if (passEnv) smtp.passEnv = passEnv
  return { smtp, from, to }
}

function parseReport(raw: unknown): ReportSchedule {
  const o = (raw ?? {}) as Record<string, unknown>
  const at = o['at'] != null ? String(o['at']).trim() : '07:00'
  const m = /^(\d{2}):(\d{2})$/.exec(at)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`notify: report.at inválido '${at}' (esperado HH:MM en 24 h).`)
  const every = o['every'] != null ? String(o['every']) : 'daily'
  if (every !== 'daily' && every !== 'weekly') throw new Error(`notify: report.every inválido '${every}' (esperado daily | weekly).`)
  const sched: ReportSchedule = { at, every }
  if (o['weekday'] != null) {
    const wd = String(o['weekday'])
    if (every === 'daily') throw new Error('notify: report.weekday solo aplica a weekly.')
    if (!WEEKDAYS.includes(wd as ReportWeekday)) throw new Error(`notify: report.weekday inválido '${wd}' (esperado ${WEEKDAYS.join(' | ')}).`)
    sched.weekday = wd as ReportWeekday
  } else if (every === 'weekly') {
    sched.weekday = 'monday'
  }
  if (o['timezone'] != null) {
    const tz = String(o['timezone']).trim()
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
    } catch {
      throw new Error(`notify: report.timezone inválida '${tz}' (esperado una zona IANA, p. ej. America/Santiago).`)
    }
    sched.timezone = tz
  }
  return sched
}

/** Config filtrada a los destinos suscritos al flujo (el bloque report se conserva). PURA. */
export function forEvent(cfg: NotifyConfig, ev: NotifyEvent): NotifyConfig {
  const destinations = cfg.destinations.filter((d) => d.events.includes(ev))
  return cfg.report ? { destinations, report: cfg.report } : { destinations }
}

/** Tipo del fetch inyectable (tests); default el global. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>

/** Envío SMTP inyectable (tests); default el cliente real de `./smtp`. */
export type SmtpSendLike = (cfg: SmtpConnectConfig, mail: MailMessage) => Promise<void>

/**
 * Sinks desde la config. Ninguno captura errores: el aislamiento es del despachante (`fanout` para
 * las alertas; el lazo del reporte sink por sink — necesita saber quién entregó).
 *
 * El destino email resuelve EN CREACIÓN (boot) su contraseña (`passEnv`) y su CA (`caFile`): un
 * secreto ausente o un PEM ilegible tumban el arranque nombrando la variable o la ruta — no la
 * madrugada del primer envío.
 */
export function createSinks(cfg: NotifyConfig, fetchImpl?: FetchLike, sendMail?: SmtpSendLike): NotificationSink[] {
  const post: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init))
  const enviar: SmtpSendLike = sendMail ?? ((c, m) => sendSmtp(c, m))
  return cfg.destinations.map((d): NotificationSink => {
    if (d.type === 'email-smtp') {
      const smtpCfg: SmtpConnectConfig = { host: d.smtp.host, port: d.smtp.port, tls: d.smtp.tls ?? 'starttls' }
      if (d.smtp.caFile) {
        try {
          smtpCfg.ca = [readFileSync(d.smtp.caFile, 'utf8')]
        } catch (e) {
          throw new Error(`notify: destino '${d.id}': no se pudo leer smtp.caFile '${d.smtp.caFile}' (${e instanceof Error ? e.message : String(e)}).`)
        }
      }
      if (d.smtp.user) {
        const nombre = d.smtp.passEnv!
        const pass = process.env[nombre]
        if (!pass) throw new Error(`notify: destino '${d.id}': la variable ${nombre} no está definida.`)
        smtpCfg.auth = { user: d.smtp.user, pass, method: d.smtp.authMethod ?? 'plain' }
      }
      return {
        id: d.id,
        send: async (n) => {
          await enviar(smtpCfg, { from: d.from, to: d.to, subject: renderEmailSubject(n), text: renderEmailText(n) })
        },
      }
    }
    const body = d.type === 'slack-webhook' ? (n: Notification): string => JSON.stringify({ text: renderSlackText(n) }) : (n: Notification): string => JSON.stringify(n)
    return {
      id: d.id,
      send: async (n) => {
        await post(d.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(n) })
      },
    }
  })
}

/** Subject del email: `⚠ ` + title si el aviso es warning; el title tal cual si no. */
export function renderEmailSubject(n: Notification): string {
  return n.severity === 'warning' ? `⚠ ${n.title}` : n.title
}

/** Cuerpo del email: texto plano — título, líneas y los enlaces como `⟨label⟩: ⟨url⟩`. */
export function renderEmailText(n: Notification): string {
  const cuerpo = `${n.title}\n\n${n.lines.join('\n')}`
  if (!n.links.length) return cuerpo
  return `${cuerpo}\n\n${n.links.map((l) => `${l.label}: ${l.url}`).join('\n')}\n`
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
