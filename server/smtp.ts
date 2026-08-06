/**
 * Cliente SMTP de SUBMISSION (issue #102) — envía un mensaje a UN relay configurado por la
 * instancia. Minimal y honesto: EHLO → [STARTTLS] → [AUTH PLAIN|LOGIN] → MAIL/RCPT/DATA → QUIT,
 * texto plano UTF-8 en base64, subject RFC 2047. Cero dependencias (node:net / node:tls).
 *
 * Lo que NO es (fuera de alcance del issue: el canal lo provee la instancia): no resuelve MX, no
 * encola ni reintenta la entrega, no firma DKIM, no procesa rebotes. Un relay caído es un error
 * REPORTADO (SmtpError con fase y código), jamás un éxito silencioso ni un cuelgue sin nombre.
 */
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomUUID } from 'node:crypto'

export interface SmtpAuth {
  user: string
  pass: string
  /** default 'plain' */
  method?: 'plain' | 'login'
}
export interface SmtpConnectConfig {
  host: string
  port: number
  /** starttls (587, upgrade tras EHLO) | implicit (465, TLS desde el byte cero) | none (relay local). */
  tls: 'starttls' | 'implicit' | 'none'
  /** CA(s) PEM adicionales (relay con CA privada). Ausente = store del sistema. */
  ca?: string[]
  auth?: SmtpAuth
  /** Timeout por respuesta del servidor (default 15_000) y de la sesión completa (default 60_000). */
  commandTimeoutMs?: number
  sessionTimeoutMs?: number
}
export interface MailMessage {
  from: string
  to: string[]
  subject: string
  text: string
}

export class SmtpError extends Error {
  constructor(
    message: string,
    public phase: string,
    public code?: number,
  ) {
    super(message)
    this.name = 'SmtpError'
  }
}

const CRLF = '\r\n'
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000
const DEFAULT_SESSION_TIMEOUT_MS = 60_000

interface Reply {
  code: number
  /** Líneas crudas de la respuesta (multilínea incluida). */
  lines: string[]
}

/**
 * Conversación con el servidor: lectura por líneas con parser de multilínea, un solo lector en
 * vuelo, y muerte NOMBRADA (error, cierre o timeout) — jamás una promesa colgada ni un éxito
 * inventado. La fase vigente viaja en el error: el operador sabe DÓNDE se rompió.
 */
class Conversation {
  private sock: Socket | null = null
  private buf = ''
  private acc: string[] = []
  private queue: Reply[] = []
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null
  private dead: Error | null = null
  private done = false
  phase = 'connect'

  constructor(private readonly commandTimeoutMs: number) {}

  attach(sock: Socket): void {
    this.sock = sock
    sock.on('data', this.onData)
    sock.on('error', this.onError)
    sock.on('close', this.onClose)
  }

  /** Suelta el socket vigente conservando lo ya leído (upgrade a TLS). */
  detach(): Socket {
    const s = this.sock
    if (!s) throw new SmtpError('smtp[interno]: no hay socket que soltar', this.phase)
    s.removeListener('data', this.onData)
    s.removeListener('error', this.onError)
    s.removeListener('close', this.onClose)
    this.sock = null
    return s
  }

  private onData = (chunk: Buffer): void => {
    this.buf += chunk.toString('utf8')
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '')
      this.buf = this.buf.slice(idx + 1)
      this.acc.push(line)
      const m = /^(\d{3})([ -]?)/.exec(line)
      if (!m) continue
      if (m[2] === '-') continue // continuación: seguir acumulando hasta la línea `NNN␣`
      const reply: Reply = { code: Number(m[1]), lines: this.acc }
      this.acc = []
      this.deliver(reply)
    }
  }

  private onError = (e: Error): void => {
    this.fail(new SmtpError(`smtp[${this.phase}]: ${e.message}`, this.phase))
  }

  private onClose = (): void => {
    if (this.done) return
    this.fail(new SmtpError(`smtp[${this.phase}]: el servidor cerró la conexión`, this.phase))
  }

  private deliver(r: Reply): void {
    const w = this.waiter
    if (w) {
      this.waiter = null
      clearTimeout(w.timer)
      w.resolve(r)
    } else {
      this.queue.push(r)
    }
  }

  private fail(e: Error): void {
    if (this.dead) return
    this.dead = e
    const w = this.waiter
    if (w) {
      this.waiter = null
      clearTimeout(w.timer)
      w.reject(e)
    }
  }

  /** Aborta la sesión desde fuera (timeout global). */
  abort(e: Error): void {
    this.fail(e)
    this.sock?.destroy()
  }

  write(line: string): void {
    if (this.dead) throw this.dead
    this.sock?.write(line + CRLF)
  }

  writeRaw(data: string): void {
    if (this.dead) throw this.dead
    this.sock?.write(data)
  }

  async read(): Promise<Reply> {
    const q = this.queue.shift()
    if (q) return q
    if (this.dead) throw this.dead
    return await new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        this.fail(new SmtpError(`smtp[${this.phase}]: timeout esperando respuesta`, this.phase))
        reject(new SmtpError(`smtp[${this.phase}]: timeout esperando respuesta`, this.phase))
      }, this.commandTimeoutMs)
      this.waiter = { resolve, reject, timer }
    })
  }

  /** Lee y exige uno de los códigos esperados; cualquier otro es SmtpError con la línea del server. */
  async expect(codes: number[]): Promise<Reply> {
    const r = await this.read()
    if (!codes.includes(r.code)) {
      // La fase de auth NUNCA lleva la línea del servidor ni nada del diálogo: un relay puede
      // devolver el usuario en su rechazo, y esa cadena termina en logs y correos.
      const detalle = this.phase === 'auth' ? '' : ` — ${r.lines.join(' | ')}`
      throw new SmtpError(`smtp[${this.phase}]: respuesta ${r.code}${detalle}`, this.phase, r.code)
    }
    return r
  }

  /** El desenlace ya está decidido: un cierre posterior deja de ser un error. */
  markDone(): void {
    this.done = true
  }

  close(): void {
    this.done = true
    this.sock?.destroy()
  }
}

/** `=?utf-8?B?…?=` si contiene algo fuera de ASCII imprimible; tal cual si no. */
export function encodeHeaderWord(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(s)) return s
  return `=?utf-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

/** Dot-stuffing RFC 5321: línea que empieza con '.' → '..'. */
export function dotStuff(text: string): string {
  return text.replace(/^\./gm, '..')
}

/** angle-addr para el envelope: `Nombre <a@b>` → `a@b`; sin ángulos → tal cual (trim). */
export function envelopeAddr(s: string): string {
  const m = /<([^>]*)>/.exec(s)
  return (m ? m[1]! : s).trim()
}

const DIAS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MESES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dd = (n: number): string => String(n).padStart(2, '0')

/** Date RFC 5322 en UTC: `Thu, 06 Aug 2026 12:00:00 +0000`. */
function rfc5322Date(nowMs: number): string {
  const d = new Date(nowMs)
  return (
    `${DIAS[d.getUTCDay()]}, ${dd(d.getUTCDate())} ${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${dd(d.getUTCHours())}:${dd(d.getUTCMinutes())}:${dd(d.getUTCSeconds())} +0000`
  )
}

/**
 * MIME sellado (CRLF): From/To/Subject(RFC2047)/Date(RFC5322)/Message-ID/MIME-Version/
 * Content-Type text/plain charset=utf-8/Content-Transfer-Encoding base64 + cuerpo base64 en 76 cols.
 */
export function buildMime(mail: MailMessage, nowMs: number): string {
  const b64 = Buffer.from(mail.text, 'utf8').toString('base64')
  const cuerpo = (b64.match(/.{1,76}/g) ?? ['']).join(CRLF)
  const dominio = envelopeAddr(mail.from).split('@')[1] ?? 'vergis'
  const headers = [
    `From: ${mail.from.includes('<') ? mail.from : `<${mail.from}>`}`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${encodeHeaderWord(mail.subject)}`,
    `Date: ${rfc5322Date(nowMs)}`,
    `Message-ID: <${randomUUID()}@${dominio}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ]
  return headers.join(CRLF) + CRLF + CRLF + cuerpo + CRLF
}

/** Envía UN mensaje. Resuelve solo tras el 250 final del DATA; cualquier otra cosa lanza SmtpError. */
export async function sendSmtp(cfg: SmtpConnectConfig, mail: MailMessage, nowMs?: number): Promise<void> {
  const conv = new Conversation(cfg.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
  const sessionMs = cfg.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS
  const sessionTimer = setTimeout(() => conv.abort(new SmtpError(`smtp[sesión]: timeout de sesión (${sessionMs} ms)`, 'sesión')), sessionMs)
  sessionTimer.unref?.()
  try {
    // 1 — conectar y esperar el saludo.
    const sock = await abrir(cfg)
    conv.attach(sock)
    await conv.expect([220])

    // 2 — EHLO.
    conv.phase = 'ehlo'
    conv.write('EHLO vergis')
    await conv.expect([250])

    // 3 — STARTTLS: upgrade y EHLO de nuevo (las capacidades cambian tras el upgrade).
    if (cfg.tls === 'starttls') {
      conv.phase = 'starttls'
      conv.write('STARTTLS')
      await conv.expect([220])
      const plano = conv.detach()
      const seguro = await upgrade(plano, cfg)
      conv.attach(seguro)
      conv.phase = 'ehlo'
      conv.write('EHLO vergis')
      await conv.expect([250])
    }

    // 4 — AUTH (nunca loguea ni propaga credenciales).
    if (cfg.auth) {
      conv.phase = 'auth'
      const { user, pass } = cfg.auth
      if ((cfg.auth.method ?? 'plain') === 'login') {
        conv.write('AUTH LOGIN')
        await conv.expect([334])
        conv.write(Buffer.from(user, 'utf8').toString('base64'))
        await conv.expect([334])
        conv.write(Buffer.from(pass, 'utf8').toString('base64'))
        await conv.expect([235])
      } else {
        conv.write(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')}`)
        await conv.expect([235])
      }
    }

    // 5 — sobre y datos.
    conv.phase = 'mail'
    conv.write(`MAIL FROM:<${envelopeAddr(mail.from)}>`)
    await conv.expect([250])
    conv.phase = 'rcpt'
    for (const to of mail.to) {
      conv.write(`RCPT TO:<${envelopeAddr(to)}>`)
      await conv.expect([250, 251])
    }
    conv.phase = 'data'
    conv.write('DATA')
    await conv.expect([354])
    conv.writeRaw(dotStuff(buildMime(mail, nowMs ?? Date.now())) + `.${CRLF}`)
    await conv.expect([250])

    // 6 — QUIT best-effort: el mensaje YA está aceptado; lo que pase acá no cambia el desenlace.
    conv.phase = 'quit'
    conv.markDone()
    try {
      conv.write('QUIT')
    } catch {
      /* la sesión ya se cerró: el 250 del DATA es el contrato */
    }
  } catch (e) {
    conv.abort(e instanceof Error ? e : new SmtpError(String(e), 'desconocida'))
    throw e
  } finally {
    clearTimeout(sessionTimer)
    conv.close()
  }
}

/** Conexión inicial: TLS desde el byte cero (implicit) o texto plano. */
async function abrir(cfg: SmtpConnectConfig): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const fallo = (e: Error): void => reject(new SmtpError(`smtp[connect]: ${e.message}`, 'connect'))
    if (cfg.tls === 'implicit') {
      const s = tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host, ...(cfg.ca ? { ca: cfg.ca } : {}) })
      s.once('secureConnect', () => {
        s.removeListener('error', fallo)
        resolve(s)
      })
      s.once('error', fallo)
    } else {
      const s = netConnect({ host: cfg.host, port: cfg.port })
      s.once('connect', () => {
        s.removeListener('error', fallo)
        resolve(s)
      })
      s.once('error', fallo)
    }
  })
}

/** Upgrade STARTTLS sobre el socket ya establecido. */
async function upgrade(socket: Socket, cfg: SmtpConnectConfig): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const fallo = (e: Error): void => reject(new SmtpError(`smtp[starttls]: ${e.message}`, 'starttls'))
    const s = tlsConnect({ socket, servername: cfg.host, ...(cfg.ca ? { ca: cfg.ca } : {}) })
    s.once('secureConnect', () => {
      s.removeListener('error', fallo)
      resolve(s)
    })
    s.once('error', fallo)
  })
}
