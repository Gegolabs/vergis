import { describe, it, expect } from 'vitest'
import { parseMultipart, boundaryOf } from '../server/multipart'

const B = 'X-BOUNDARY-123'

function build(fields: Record<string, string>, file?: { field: string; filename: string; contentType: string; bytes: Buffer }): Buffer {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  if (file) {
    parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`))
    parts.push(file.bytes)
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${B}--\r\n`))
  return Buffer.concat(parts)
}

describe('multipart · parser binary-safe', () => {
  it('boundaryOf extrae el boundary (con y sin comillas)', () => {
    expect(boundaryOf('multipart/form-data; boundary=abc')).toBe('abc')
    expect(boundaryOf('multipart/form-data; boundary="a b c"')).toBe('a b c')
    expect(boundaryOf('text/plain')).toBeNull()
  })

  it('separa campos de texto y un archivo, preservando bytes exactos', () => {
    // bytes binarios que incluyen CR/LF y un null — no deben corromperse
    const bin = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x0d, 0x0a, 0xff, 0xfe])
    const body = build({ _csrf: 'tok123', nota: 'hola' }, { field: 'file', filename: 'saldos w24.xlsx', contentType: 'application/octet-stream', bytes: bin })
    const { fields, files } = parseMultipart(body, B)
    expect(fields['_csrf']).toBe('tok123')
    expect(fields['nota']).toBe('hola')
    expect(files).toHaveLength(1)
    expect(files[0].field).toBe('file')
    expect(files[0].filename).toBe('saldos w24.xlsx')
    expect(files[0].contentType).toBe('application/octet-stream')
    expect(Buffer.compare(files[0].bytes, bin)).toBe(0)
  })

  it('solo campos (sin archivo)', () => {
    const { fields, files } = parseMultipart(build({ a: '1', b: '2' }), B)
    expect(fields).toEqual({ a: '1', b: '2' })
    expect(files).toHaveLength(0)
  })

  it('cuerpo sin el boundary → vacío', () => {
    expect(parseMultipart(Buffer.from('basura'), B)).toEqual({ fields: {}, files: [] })
  })
})
