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
import {
  redactSecrets,
  requireRootKey,
  SIN_MEDIDA_TICKS,
  type ArchivoVarado,
  type CargaDesenlace,
  type MedidaCalidad,
  type ProcessHealth,
  type RunRecord,
  type SlotAlertReason,
} from '@vergis/capabilities'
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
export type NotifyEvent = 'alerts' | 'reports' | 'cargas-usuario'

/**
 * Token del destinatario en el `to` de un destino email suscrito a `'cargas-usuario'` (#162·§6.3):
 * el wiring lo sustituye, POR AVISO, por el email de quien subió el archivo (`data.uploadedBy`). Las
 * direcciones literales que acompañen al token quedan como copia operativa.
 *
 * Existe porque el destinatario de este flujo NO es declarable en la config: cambia con cada carga.
 */
export const UPLOADER_TOKEN = '$uploader'

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
const EVENTOS: NotifyEvent[] = ['alerts', 'reports', 'cargas-usuario']
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

  // Validación cruzada del flujo al USUARIO (#162·§6.3), fail-closed en el BOOT y no en el envío: el
  // destinatario de este flujo es individual y se resuelve por aviso, así que una config que no lo
  // permite se descubriría recién la noche que a alguien le falla una carga y el correo no sale.
  for (const d of destinations) {
    const suscrito = d.events.includes('cargas-usuario')
    // Un canal COMPARTIDO no es «el usuario»: mandar ahí el aviso personal lo publica al equipo entero.
    if (suscrito && d.type === 'slack-webhook')
      throw new Error(`notify: el destino '${d.id}' se suscribe a 'cargas-usuario', que va dirigido a UNA persona; un canal Slack compartido no es un destinatario individual (usa email-smtp con ${UPLOADER_TOKEN}, o webhook).`)
    if (d.type !== 'email-smtp') continue
    const conToken = d.to.includes(UPLOADER_TOKEN)
    if (suscrito && !conToken)
      throw new Error(`notify: el destino '${d.id}' se suscribe a 'cargas-usuario' pero su to no incluye ${UPLOADER_TOKEN} (el aviso es para quien subió el archivo, y su dirección no se declara en la config).`)
    // El token sin la suscripción es la contradicción simétrica: un destino que promete resolver al
    // uploader y jamás recibe un aviso que lo traiga. Se rompe con nombre, no se ignora.
    if (!suscrito && conToken)
      throw new Error(`notify: el destino '${d.id}' declara ${UPLOADER_TOKEN} en su to pero no se suscribe a 'cargas-usuario'; ningún otro flujo sabe a quién resolverlo.`)
  }

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
  // El token `$uploader` (#162·§6.3) es una entrada legítima del `to`: no es una dirección, es la
  // promesa de resolver una por aviso. Que el destino esté suscrito al flujo que la trae se valida
  // cruzado en `parseNotifyConfig` — acá solo se admite la forma.
  if (!to.length || to.some((t) => t !== UPLOADER_TOKEN && !t.includes('@')))
    throw new Error(`notify: destino '${id}' con to inválido (lista no vacía de direcciones con '@', o el token ${UPLOADER_TOKEN}).`)
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
          await enviar(smtpCfg, { from: d.from, to: resolveTo(d.to, n, d.id), subject: renderEmailSubject(n), text: renderEmailText(n) })
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

/**
 * Destinatarios efectivos de UN aviso: sustituye `$uploader` por `data.uploadedBy` (#162·§6.3).
 *
 * LANZA si el token está y el aviso no trae un `uploadedBy` con forma de dirección. Es defensa en
 * profundidad, no la compuerta: el lazo ya no compone el aviso cuando el uploader no parsea como
 * email (se loguea y el desenlace se persiste igual). Lanzar es lo correcto igual: `fanout` lo
 * loguea con el id del destino, y la alternativa —mandarlo solo a las copias operativas— entregaría
 * a terceros un mensaje escrito para su dueño.
 */
export function resolveTo(to: string[], n: Notification, destinoId: string): string[] {
  if (!to.includes(UPLOADER_TOKEN)) return to
  const quien = typeof n.data['uploadedBy'] === 'string' ? (n.data['uploadedBy'] as string).trim() : ''
  if (!quien.includes('@')) throw new Error(`destino '${destinoId}': el aviso no trae uploadedBy con forma de dirección (${quien ? `'${quien}'` : 'ausente'}) y su to declara ${UPLOADER_TOKEN}.`)
  return to.map((t) => (t === UPLOADER_TOKEN ? quien : t))
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

// ── Composición de avisos de la VIGILANCIA DEL INTAKE (#161) — PURA, el lazo la invoca ───────────
/**
 * Contexto de un aviso del vigilante de cargas. Espejo de `FreshnessAlertContext`: el lazo trae todo
 * lo que el operador necesita para actuar (dominio, slot, evidencia y enlaces profundos) y esta
 * función solo REDACTA — no lee nada.
 *
 * La `medida` viaja SIEMPRE en el aviso, no solo en la superficie: el operador tiene que poder
 * distinguir «está roto» de «no lo pude mirar» sin abrir la consola. Es el requisito central de #161.
 */
export interface IntakeAlertContext {
  slotId: string
  slotLabel: string
  /** Dominio ENLAZABLE: id/label solo si el slot lo declara Y está declarado en domains.yaml. */
  domainId?: string
  domainLabel?: string
  reason: SlotAlertReason
  medida: MedidaCalidad
  /** `varados`: los archivos que excedieron la edad, con la suya. */
  varados?: ArchivoVarado[]
  /** `contradice-registro`: los archivos que el registro esperaba ver y el listado no trajo. */
  esperados?: string[]
  /** `contradice-registro` por el DIRECTORIO (diseño 009·§4.2): el landing respondió que NO EXISTE
   *  y la plataforma tiene registradas cargas ok en él. */
  landingAusente?: true
  /** ISO de la última carga vivida registrada, evidencia de la escritura propia. */
  ultimaCargaAt?: string
  /** `corrida-fallida` / `corrida-colgada`: la corrida en cuestión (base del enlace profundo). */
  run?: RunRecord
  /** Error de la lectura que falló (toda alerta emitida sobre lo último conocido lo lleva). */
  lastError?: string
  /** VERGIS_PUBLIC_URL normalizada (sin slash final). */
  baseUrl: string
}

/** Titular por razón. Sin jerga del motor: qué pasó, en una línea. */
const DESENLACE_INTAKE: Record<SlotAlertReason, string> = {
  varados: 'hay archivos sin procesar en la zona de aterrizaje',
  'corrida-fallida': 'la conversión falló',
  'corrida-colgada': 'la conversión no termina',
  'sin-medida': 'el vigilante no puede medir',
  'contradice-registro': 'el listado contradice el registro de cargas',
}

/** Cómo se rotula la calidad de la medida en el cuerpo. `fresca` no se rotula: es lo normal, y decirlo
 *  en cada aviso sería ruido que se aprende a saltar. */
const MEDIDA_LINEA: Record<MedidaCalidad, string | null> = {
  fresca: null,
  'ultima-conocida': 'medida: LO ÚLTIMO CONOCIDO — la lectura de este tick falló; lo de abajo sale de la proyección, no del estado de ahora',
  'contradice-registro': 'medida: DESMENTIDA — el listado llegó sin error pero contradice lo que la plataforma registró',
  ninguna: 'medida: NINGUNA — este slot nunca se ha podido medir',
}

const hrefCargas = (baseUrl: string, domainId: string): string => `${baseUrl}/admin/dominio/${domainId}/cargas`

export function composeIntakeAlert(ctx: IntakeAlertContext): Notification {
  const lines: string[] = []
  const rotulo = MEDIDA_LINEA[ctx.medida]
  if (rotulo) lines.push(rotulo)
  if (ctx.lastError) lines.push(`error de la lectura: ${ctx.lastError}`)
  if (ctx.reason === 'sin-medida')
    lines.push(`el vigilante lleva ${SIN_MEDIDA_TICKS} ticks o más sin poder observar este slot: lo que muestre la consola es lo último conocido, no el estado de ahora`)
  for (const v of ctx.varados ?? []) lines.push(`varado: ${v.file} (en el landing hace ${fmtDur(v.ageMinutes * 60)})`)
  if (ctx.landingAusente) {
    // Solo HECHOS observados: el 404 de ahora y las cargas que esta plataforma registró haber puesto
    // ahí. La causa (permisos del directorio, borrado, path reconfigurado) NO se nombra: la
    // plataforma no la sabe, y nombrar una causa no medida sería inventarla.
    lines.push(
      ctx.ultimaCargaAt
        ? `el directorio del landing NO EXISTE, y la plataforma registró cargas suyas en él (la última: ${ctx.ultimaCargaAt})`
        : 'el directorio del landing NO EXISTE, y la plataforma registró cargas suyas en él',
    )
    lines.push('NO se concluye «nadie subió nada»: lo que se contradice es el registro de la propia plataforma — hay que averiguar por qué')
  }
  if (ctx.esperados?.length) {
    lines.push(`el registro de cargas esperaba en el landing: ${ctx.esperados.join(', ')}`)
    // La alerta afirma la CONTRADICCIÓN, jamás su causa (permisos, borrado a mano, path mal
    // configurado): eso lo diagnostica una persona, y nombrar una causa no medida sería inventarla.
    lines.push('el listado no trajo ninguno de ellos — NO se concluye «landing vacío»: hay que averiguar por qué')
  }
  if (ctx.run) {
    lines.push(`última corrida: ${ctx.run.status}, iniciada ${ctx.run.startedAt}`)
    // El motivo es el que declaró el MOTOR (`failureReason`). El motivo POR ARCHIVO que el job escribe
    // en su log vive en el contrato `_logs/` y lo resuelve el resolver de #162: acá no se lee ningún
    // log — un lazo que abre archivos por cada corrida fallida paga I/O en cada vuelta.
    if (ctx.run.error) lines.push(`motivo del motor: ${ctx.run.error}`)
  }
  if (ctx.domainId == null) lines.push(SIN_ENLACES)

  const links: NotificationLink[] = []
  if (ctx.domainId != null) {
    if (ctx.run?.startedAt)
      links.push({
        label: 'Ver corrida',
        url: `${ctx.baseUrl}/admin/dominio/${ctx.domainId}/corrida?slot=${encodeURIComponent(ctx.slotId)}&started=${encodeURIComponent(ctx.run.startedAt)}`,
      })
    links.push({ label: 'Cargas del dominio', url: hrefCargas(ctx.baseUrl, ctx.domainId) })
  }

  return {
    severity: 'warning',
    title: `Cargas — ${ctx.domainLabel ?? SIN_DOMINIO} · ${ctx.slotLabel}: ${DESENLACE_INTAKE[ctx.reason]}`,
    lines,
    links,
    data: {
      event: 'intake-alert',
      slotId: ctx.slotId,
      reason: ctx.reason,
      medida: ctx.medida,
      varados: (ctx.varados ?? []).map((v) => ({ file: v.file, ageMinutes: v.ageMinutes })),
      esperados: ctx.esperados ?? [],
      landingAusente: ctx.landingAusente === true,
      ultimaCargaAt: ctx.ultimaCargaAt ?? null,
      lastError: ctx.lastError ?? null,
      domainId: ctx.domainId ?? null,
    },
  }
}

export function composeIntakeRecovery(ctx: { slotId: string; slotLabel: string; domainId?: string; domainLabel?: string; baseUrl: string }): Notification {
  return {
    severity: 'ok',
    title: `Cargas — ${ctx.domainLabel ?? SIN_DOMINIO} · ${ctx.slotLabel}: recuperado`,
    lines: ctx.domainId == null ? [SIN_ENLACES] : [],
    links: ctx.domainId == null ? [] : [{ label: 'Cargas del dominio', url: hrefCargas(ctx.baseUrl, ctx.domainId) }],
    data: { event: 'intake-recovery', slotId: ctx.slotId, domainId: ctx.domainId ?? null },
  }
}

// ── Aviso al USUARIO que subió el archivo (#162·§6.2) — PURO, el resolver del lazo lo invoca ─────
/**
 * Contexto del aviso a quien subió. Todo lo que trae es lo que ESA persona necesita para actuar: qué
 * archivo, qué pasó con él y qué puede hacer ahora.
 *
 * Lo que NO trae, y es la mitad del punto: ids del motor, rutas de almacenamiento ni estados internos
 * (`state=[dead]`). Ese detalle es del operador y sale por el flujo `'alerts'`.
 */
export interface CargaUserNoticeContext {
  /** Basename tal como lo subió. */
  filename: string
  /** Solo los desenlaces que se avisan. `procesada` no notifica (anti-ruido, §6.2). */
  desenlace: Exclude<CargaDesenlace, 'procesada'>
  /** Motivo POR ARCHIVO declarado por el job (gramática `_logs/`). Ausente = el job no lo declaró. */
  motivo?: string
  /** Titular de la corrida (última `✖` del log) cuando el job NO declaró motivo por archivo — se
   *  presenta rotulado como lo que es: lo que informó la conversión, no la causa de ESTE archivo. */
  titular?: string
  /** Dirección de quien subió: el sink de email la sustituye en `$uploader`. */
  uploadedBy: string
  uploadedAt: string
  /** Edad del archivo en el landing, en minutos. Solo la usa `varada`. */
  ageMinutes?: number
  slotId: string
  slotLabel: string
  uploadId?: number
  domainId?: string
  domainLabel?: string
  /** VERGIS_PUBLIC_URL normalizada (sin slash final). */
  baseUrl: string
}

/** Fecha legible por una persona, en UTC explícito: `2026-08-13 11:30 UTC`. El ISO crudo es del
 *  operador. Una fecha que no parsea se devuelve tal cual: inventarle una sería peor que mostrarla fea. */
export function fmtFechaUsuario(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const AVISADO_OPERADOR = 'El operador de la plataforma ya fue avisado, con el detalle técnico.'
const REINTENTAR = 'Cuando lo corrijas, puedes volver a subirlo desde la consola de Cargas.'

/**
 * Redacta el aviso al usuario. El marco lo pone la plataforma; el MOTIVO llega TEXTUAL del job — el
 * producto no parafrasea (parafrasear es fabricar causas, requisito duro 4 del diseño) y tampoco
 * rellena: cuando no hay motivo, lo que se dice es que no lo hay.
 *
 * El motivo pasa por `redactSecrets` porque lo escribe un job de terreno: un log puede traer una
 * cadena de conexión, y nadie necesita recibirla por correo para leer «ancho inesperado».
 */
export function composeCargaUserNotice(ctx: CargaUserNoticeContext): Notification {
  const archivo = `«${ctx.filename}»`
  const motivo = ctx.motivo ? redactSecrets(ctx.motivo) : undefined
  const titular = ctx.titular ? redactSecrets(ctx.titular) : undefined
  const lines: string[] = []
  let title: string

  if (ctx.desenlace === 'fallida') {
    title = `Tu archivo ${archivo} no pudo procesarse`
    if (motivo) lines.push(`Motivo: ${motivo}`)
    else {
      lines.push('La conversión falló y no declaró un motivo para este archivo en particular.')
      if (titular) lines.push(`Lo que informó la conversión: ${titular}`)
    }
    lines.push(REINTENTAR)
  } else if (ctx.desenlace === 'saltada') {
    title = `Tu archivo ${archivo} no se procesó: la conversión lo omitió`
    lines.push(motivo ? `Motivo: ${motivo}` : 'La conversión lo omitió sin declarar un motivo.')
    // Un archivo omitido no siempre es un archivo malo (un corte ya cargado, por ejemplo): pedirle
    // que «lo corrija» sería mandarlo a arreglar algo que puede estar bien.
    lines.push('Si esperabas que se procesara, avísale al equipo de la plataforma.')
  } else if (ctx.desenlace === 'sin-informe') {
    // El caso que este flujo existe para no maquillar: hubo una conversión, terminó mal y no dijo por
    // qué. Decirlo es lo único honesto — la plataforma NO tiene la causa y no la va a inventar.
    title = `Tu archivo ${archivo} no se procesó y el proceso no reportó la causa`
    lines.push('La conversión terminó sin informar qué pasó con tu archivo, así que no podemos decirte el motivo: sería inventarlo.')
    lines.push(AVISADO_OPERADOR)
  } else {
    title = `Tu archivo ${archivo} sigue sin procesarse`
    lines.push(
      ctx.ageMinutes != null
        ? `Lo recibimos hace ${fmtDur(ctx.ageMinutes * 60)} y ninguna conversión lo ha tomado todavía.`
        : 'Lo recibimos y ninguna conversión lo ha tomado todavía.',
    )
    lines.push(`${AVISADO_OPERADOR} No hace falta que lo vuelvas a subir.`)
  }
  lines.push(`Archivo recibido el ${fmtFechaUsuario(ctx.uploadedAt)} · ${ctx.slotLabel}`)

  return {
    severity: 'warning',
    title,
    lines,
    links: ctx.domainId != null ? [{ label: 'Ver mis cargas', url: hrefCargas(ctx.baseUrl, ctx.domainId) }] : [],
    data: {
      event: 'carga-usuario',
      // El sink de email lo sustituye en `$uploader`; el webhook genérico lo reenvía tal cual para que
      // el puente externo decida por dónde le llega a esa persona.
      uploadedBy: ctx.uploadedBy,
      desenlace: ctx.desenlace,
      filename: ctx.filename,
      motivo: ctx.motivo ?? null,
      slotId: ctx.slotId,
      uploadId: ctx.uploadId ?? null,
      domainId: ctx.domainId ?? null,
    },
  }
}
