/**
 * Cliente SMTP de submission (issue #102, T1) — el protocolo ENTERO bajo CI contra servidores fake
 * in-process (`node:net` / `node:tls`), incluida la negociación TLS con certificado fixture.
 *
 * El instrumento se exige a sí mismo (Norma 7): un servidor mudo produce un timeout que NOMBRA la
 * fase, y un servidor que corta a mitad del DATA produce un error — jamás una resolución exitosa.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createServer as netServer, type Socket } from 'node:net'
import { createServer as tlsServer, TLSSocket } from 'node:tls'
import { buildMime, dotStuff, encodeHeaderWord, envelopeAddr, sendSmtp, SmtpError } from '../server/smtp'

const CERT = readFileSync(new URL('./fixtures/smtp-cert.pem', import.meta.url), 'utf8')
const KEY = readFileSync(new URL('./fixtures/smtp-key.pem', import.meta.url), 'utf8')

interface FakeOpts {
  mode?: 'none' | 'implicit' | 'starttls'
  authFail?: boolean
  /** El servidor enmudece tras el EHLO (el cliente debe timeoutear nombrando la fase). */
  muteAfterEhlo?: boolean
  /** El servidor cierra el socket a mitad del DATA. */
  dropDuringData?: boolean
}
interface Fake {
  port: number
  cmds: string[]
  message: string | null
  close(): Promise<void>
}

/** Servidor SMTP fake: máquina de estados por líneas, programable por opciones. */
async function startFake(opts: FakeOpts = {}): Promise<Fake> {
  const mode = opts.mode ?? 'none'
  const estado: { cmds: string[]; message: string | null } = { cmds: [], message: null }

  const sesion = (raw: Socket): void => {
    let sock: Socket = raw
    let buf = ''
    let inData = false
    let data = ''
    let loginStep = 0

    const write = (s: string): void => {
      sock.write(s + '\r\n')
    }

    const handle = (line: string): void => {
      if (inData) {
        if (opts.dropDuringData) {
          sock.destroy()
          return
        }
        if (line === '.') {
          inData = false
          estado.message = data
          write('250 2.0.0 OK: queued')
        } else {
          data += line + '\r\n'
        }
        return
      }
      estado.cmds.push(line)
      if (/^EHLO/i.test(line)) {
        if (opts.muteAfterEhlo) return
        sock.write('250-PIPELINING\r\n250-STARTTLS\r\n250 OK\r\n')
      } else if (/^STARTTLS$/i.test(line)) {
        write('220 2.0.0 Ready to start TLS')
        detach()
        const seguro = new TLSSocket(sock, { isServer: true, key: KEY, cert: CERT })
        sock = seguro
        attach()
      } else if (/^AUTH PLAIN/i.test(line)) {
        write(opts.authFail ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 Authentication successful')
      } else if (/^AUTH LOGIN$/i.test(line)) {
        loginStep = 1
        write('334 VXNlcm5hbWU6')
      } else if (loginStep === 1) {
        loginStep = 2
        write('334 UGFzc3dvcmQ6')
      } else if (loginStep === 2) {
        loginStep = 0
        write(opts.authFail ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 Authentication successful')
      } else if (/^MAIL FROM:/i.test(line) || /^RCPT TO:/i.test(line)) {
        write('250 2.1.0 Ok')
      } else if (/^DATA$/i.test(line)) {
        inData = true
        data = ''
        write('354 End data with <CR><LF>.<CR><LF>')
      } else if (/^QUIT$/i.test(line)) {
        write('221 2.0.0 Bye')
        sock.end()
      } else {
        write('502 5.5.2 Command not implemented')
      }
    }

    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        handle(line)
      }
    }
    const onErr = (): void => {
      /* el cliente cortó: el fake no tiene nada que decir */
    }
    const attach = (): void => {
      sock.on('data', onData)
      sock.on('error', onErr)
    }
    const detach = (): void => {
      sock.removeListener('data', onData)
      sock.removeListener('error', onErr)
    }

    attach()
    write('220 fake.vergis ESMTP ready')
  }

  const server = mode === 'implicit' ? tlsServer({ key: KEY, cert: CERT }, sesion) : netServer(sesion)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = server.address()
  const port = typeof dir === 'object' && dir ? dir.port : 0
  return {
    port,
    get cmds() {
      return estado.cmds
    },
    get message() {
      return estado.message
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/** Separa el mensaje capturado en headers (mapa) y cuerpo decodificado de base64. */
function leerMensaje(raw: string): { headers: Record<string, string>; body: string } {
  const [cabeza, ...resto] = raw.split('\r\n\r\n')
  const headers: Record<string, string> = {}
  for (const l of (cabeza ?? '').split('\r\n')) {
    const i = l.indexOf(':')
    if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim()
  }
  return { headers, body: Buffer.from(resto.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8') }
}

/** Decodifica un `=?utf-8?B?…?=` (roundtrip del subject). */
function decodeWord(s: string): string {
  const m = /^=\?utf-8\?B\?(.*)\?=$/.exec(s)
  return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : s
}

const TEXTO = 'Reporte de ingestión — 3 corrieron · 1 con fallo\nसin acentos no habría prueba: áéíóú ñ'
const SUBJECT = '⚠ Reporte de ingestión — 2026-08-06'

describe('smtp · composición del mensaje (puro)', () => {
  it('encodeHeaderWord deja ASCII imprimible tal cual y codifica lo demás en RFC 2047', () => {
    expect(encodeHeaderWord('Reporte de ingestion 2026-08-06')).toBe('Reporte de ingestion 2026-08-06')
    expect(decodeWord(encodeHeaderWord(SUBJECT))).toBe(SUBJECT)
    expect(encodeHeaderWord(SUBJECT).startsWith('=?utf-8?B?')).toBe(true)
  })

  it('dotStuff duplica el punto inicial de línea (RFC 5321) y envelopeAddr extrae el angle-addr', () => {
    expect(dotStuff('.peligro\nok')).toBe('..peligro\nok')
    expect(dotStuff('ok\r\n.\r\nfin')).toBe('ok\r\n..\r\nfin')
    expect(envelopeAddr('Vergis <v@x.cl>')).toBe('v@x.cl')
    expect(envelopeAddr('  v@x.cl ')).toBe('v@x.cl')
  })

  it('buildMime sella los headers y codifica el cuerpo en base64 de 76 columnas', () => {
    const mime = buildMime({ from: 'Vergis <v@x.cl>', to: ['a@b.cl', 'c@d.cl'], subject: SUBJECT, text: TEXTO }, Date.UTC(2026, 7, 6, 11, 30, 0))
    const { headers, body } = leerMensaje(mime)
    expect(headers['from']).toBe('Vergis <v@x.cl>')
    expect(headers['to']).toBe('a@b.cl, c@d.cl')
    expect(decodeWord(headers['subject']!)).toBe(SUBJECT)
    expect(headers['date']).toBe('Thu, 06 Aug 2026 11:30:00 +0000')
    expect(headers['mime-version']).toBe('1.0')
    expect(headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(headers['content-transfer-encoding']).toBe('base64')
    expect(headers['message-id']).toMatch(/^<.+@x\.cl>$/)
    expect(body).toBe(TEXTO)
    for (const l of mime.split('\r\n\r\n')[1]!.split('\r\n')) expect(l.length).toBeLessThanOrEqual(76)
  })
})

describe('smtp · diálogo con el relay', () => {
  it('happy path sin TLS ni auth: EHLO → MAIL → RCPT → DATA → QUIT, con el mensaje íntegro', async () => {
    const fake = await startFake()
    try {
      await sendSmtp({ host: '127.0.0.1', port: fake.port, tls: 'none' }, { from: 'Vergis <v@x.cl>', to: ['a@b.cl'], subject: SUBJECT, text: TEXTO })
    } finally {
      await fake.close()
    }
    expect(fake.cmds.map((c) => c.split(' ')[0])).toEqual(['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT'])
    expect(fake.cmds[1]).toBe('MAIL FROM:<v@x.cl>')
    expect(fake.cmds[2]).toBe('RCPT TO:<a@b.cl>')
    const { headers, body } = leerMensaje(fake.message!)
    expect(decodeWord(headers['subject']!)).toBe(SUBJECT)
    expect(body).toBe(TEXTO)
  })

  it('dos destinatarios producen dos RCPT TO', async () => {
    const fake = await startFake()
    try {
      await sendSmtp({ host: '127.0.0.1', port: fake.port, tls: 'none' }, { from: 'v@x.cl', to: ['a@b.cl', 'Otro <c@d.cl>'], subject: 'x', text: 'y' })
    } finally {
      await fake.close()
    }
    expect(fake.cmds.filter((c) => c.startsWith('RCPT'))).toEqual(['RCPT TO:<a@b.cl>', 'RCPT TO:<c@d.cl>'])
  })

  it('AUTH PLAIN manda el base64 de \\0user\\0pass; AUTH LOGIN cumple la secuencia 334/334/235', async () => {
    const plain = await startFake()
    try {
      await sendSmtp(
        { host: '127.0.0.1', port: plain.port, tls: 'none', auth: { user: 'u1', pass: 's3cr3t' } },
        { from: 'v@x.cl', to: ['a@b.cl'], subject: 'x', text: 'y' },
      )
    } finally {
      await plain.close()
    }
    const authLine = plain.cmds.find((c) => c.startsWith('AUTH PLAIN'))!
    expect(Buffer.from(authLine.slice('AUTH PLAIN '.length), 'base64').toString('utf8')).toBe('\0u1\0s3cr3t')

    const login = await startFake()
    try {
      await sendSmtp(
        { host: '127.0.0.1', port: login.port, tls: 'none', auth: { user: 'u1', pass: 's3cr3t', method: 'login' } },
        { from: 'v@x.cl', to: ['a@b.cl'], subject: 'x', text: 'y' },
      )
    } finally {
      await login.close()
    }
    expect(login.cmds[1]).toBe('AUTH LOGIN')
    expect(Buffer.from(login.cmds[2]!, 'base64').toString('utf8')).toBe('u1')
    expect(Buffer.from(login.cmds[3]!, 'base64').toString('utf8')).toBe('s3cr3t')
  })

  it('un 535 lanza SmtpError con fase auth y código, y su mensaje JAMÁS incluye usuario ni contraseña', async () => {
    const fake = await startFake({ authFail: true })
    let err: unknown
    try {
      await sendSmtp(
        { host: '127.0.0.1', port: fake.port, tls: 'none', auth: { user: 'usuario-secreto', pass: 'clave-secreta' } },
        { from: 'v@x.cl', to: ['a@b.cl'], subject: 'x', text: 'y' },
      )
    } catch (e) {
      err = e
    } finally {
      await fake.close()
    }
    expect(err).toBeInstanceOf(SmtpError)
    const se = err as SmtpError
    expect(se.phase).toBe('auth')
    expect(se.code).toBe(535)
    expect(se.message).not.toContain('usuario-secreto')
    expect(se.message).not.toContain('clave-secreta')
  })

  it('el EHLO multilínea (250-…/250 …) se parsea entero antes de seguir', async () => {
    const fake = await startFake()
    try {
      await sendSmtp({ host: '127.0.0.1', port: fake.port, tls: 'none' }, { from: 'v@x.cl', to: ['a@b.cl'], subject: 'x', text: 'y' })
    } finally {
      await fake.close()
    }
    // Si el parser cortara en la primera línea `250-PIPELINING`, el MAIL FROM habría leído la
    // continuación como su propia respuesta y el diálogo se habría desalineado.
    expect(fake.cmds).toContain('MAIL FROM:<v@x.cl>')
    expect(fake.message).not.toBeNull()
  })

  it('servidor mudo tras EHLO ⇒ SmtpError de timeout que NOMBRA la fase (no un cuelgue)', async () => {
    const fake = await startFake({ muteAfterEhlo: true })
    let err: unknown
    try {
      await sendSmtp(
        { host: '127.0.0.1', port: fake.port, tls: 'none', commandTimeoutMs: 200 },
        { from: 'v@x.cl', to: ['a@b.cl'], subject: 'x', text: 'y' },
      )
    } catch (e) {
      err = e
    } finally {
      await fake.close()
    }
    expect(err).toBeInstanceOf(SmtpError)
    expect((err as SmtpError).phase).toBe('ehlo')
    expect((err as SmtpError).message).toMatch(/timeout esperando respuesta/)
  })

  it('socket cerrado a mitad del DATA ⇒ error, JAMÁS una resolución exitosa', async () => {
    const fake = await startFake({ dropDuringData: true })
    let ok = false
    let err: unknown
    try {
      await sendSmtp(
        { host: '127.0.0.1', port: fake.port, tls: 'none', commandTimeoutMs: 500 },
        { from: 'v@x.cl', to: ['a@b.cl'], subject: 'x', text: 'y' },
      )
      ok = true
    } catch (e) {
      err = e
    } finally {
      await fake.close()
    }
    expect(ok).toBe(false)
    expect(err).toBeInstanceOf(SmtpError)
    expect((err as SmtpError).phase).toBe('data')
  })
})

describe('smtp · TLS', () => {
  it('implicit: TLS desde el byte cero contra la CA fixture', async () => {
    const fake = await startFake({ mode: 'implicit' })
    try {
      await sendSmtp(
        { host: 'localhost', port: fake.port, tls: 'implicit', ca: [CERT] },
        { from: 'v@x.cl', to: ['a@b.cl'], subject: SUBJECT, text: TEXTO },
      )
    } finally {
      await fake.close()
    }
    expect(fake.cmds.map((c) => c.split(' ')[0])).toEqual(['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT'])
    expect(leerMensaje(fake.message!).body).toBe(TEXTO)
  })

  it('starttls: upgrade tras el 220 y EHLO RE-EMITIDO sobre el canal cifrado', async () => {
    const fake = await startFake({ mode: 'starttls' })
    try {
      await sendSmtp(
        { host: 'localhost', port: fake.port, tls: 'starttls', ca: [CERT] },
        { from: 'v@x.cl', to: ['a@b.cl'], subject: SUBJECT, text: TEXTO },
      )
    } finally {
      await fake.close()
    }
    expect(fake.cmds.map((c) => c.split(' ')[0])).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT'])
    expect(leerMensaje(fake.message!).body).toBe(TEXTO)
  })
})
