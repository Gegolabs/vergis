/**
 * Parser mínimo de `multipart/form-data` — binary-safe, sobre `Buffer`. Lo necesita el intake de
 * archivos (subida de un file + campos como el token CSRF); el `readForm` de `./ui` solo lee
 * `application/x-www-form-urlencoded`.
 *
 * CAMINO ROBUSTO, CERO SUPPLY-CHAIN: acotado al form que el Producto controla (un file + campos de
 * texto), sin agregar `busboy`. Opera sobre bytes (nunca strings) para no corromper binarios.
 */
import type { IncomingMessage } from 'node:http'

export interface UploadedFile {
  /** Nombre del campo del form (`name="..."`). */
  field: string
  /** Nombre del archivo declarado por el cliente (`filename="..."`). */
  filename: string
  contentType?: string
  bytes: Buffer
}

export interface MultipartResult {
  /** Campos de texto (no-file). */
  fields: Record<string, string>
  files: UploadedFile[]
}

const CR = 0x0d
const LF = 0x0a
const DASH = 0x2d

/** Parsea un cuerpo multipart (puro). El boundary viene del `content-type`. */
export function parseMultipart(body: Buffer, boundary: string): MultipartResult {
  const fields: Record<string, string> = {}
  const files: UploadedFile[] = []
  const delim = Buffer.from(`--${boundary}`)

  let cursor = body.indexOf(delim)
  if (cursor < 0) return { fields, files }
  cursor += delim.length

  while (true) {
    const next = body.indexOf(delim, cursor)
    if (next < 0) break
    // El contenido del part va entre delimitadores, envuelto en CRLF (uno tras el delim, uno antes
    // del siguiente). Los recortamos para quedarnos con headers+body exactos.
    let partStart = cursor
    if (body[partStart] === CR && body[partStart + 1] === LF) partStart += 2
    let partEnd = next
    if (body[partEnd - 2] === CR && body[partEnd - 1] === LF) partEnd -= 2

    if (partEnd > partStart) parsePart(body.subarray(partStart, partEnd), fields, files)

    cursor = next + delim.length
    // Delimitador de cierre: `--boundary--`.
    if (body[cursor] === DASH && body[cursor + 1] === DASH) break
  }
  return { fields, files }
}

function parsePart(part: Buffer, fields: Record<string, string>, files: UploadedFile[]): void {
  const sep = part.indexOf('\r\n\r\n')
  if (sep < 0) return
  const headerText = part.subarray(0, sep).toString('utf8')
  const bodyBuf = part.subarray(sep + 4)

  const disp = /content-disposition:[^\r\n]*/i.exec(headerText)?.[0] ?? ''
  const name = /\bname="([^"]*)"/i.exec(disp)?.[1]
  if (name == null) return
  const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1]
  if (filename != null) {
    const ct = /content-type:\s*([^\r\n]*)/i.exec(headerText)?.[1]?.trim()
    const file: UploadedFile = { field: name, filename, bytes: Buffer.from(bodyBuf) }
    if (ct) file.contentType = ct
    files.push(file)
  } else {
    fields[name] = bodyBuf.toString('utf8')
  }
}

/** Extrae el boundary del `content-type: multipart/form-data; boundary=...`. */
export function boundaryOf(contentType: string | undefined): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  const b = (m?.[1] ?? m?.[2] ?? '').trim()
  return b || null
}

/** Lee el stream del request a Buffer y lo parsea como multipart. */
export function readMultipart(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<MultipartResult> {
  return new Promise((resolveResult, reject) => {
    const boundary = boundaryOf(req.headers['content-type'])
    if (!boundary) {
      reject(new Error('multipart: falta boundary en content-type'))
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > limit) {
        reject(new Error('multipart: cuerpo demasiado grande'))
        return
      }
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    })
    req.on('end', () => resolveResult(parseMultipart(Buffer.concat(chunks), boundary)))
    req.on('error', reject)
  })
}
