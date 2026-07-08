import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, readJsonBody, readForm, fail } from '../server/http-util'

/** IncomingMessage fake: emite los chunks y `end` en el próximo tick; `destroy` es espiable. */
function mockReq(chunks: string[]): IncomingMessage & { destroyed: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = new EventEmitter() as any
  req.destroyed = false
  req.destroy = () => {
    req.destroyed = true
  }
  process.nextTick(() => {
    for (const c of chunks) req.emit('data', c)
    req.emit('end')
  })
  return req as IncomingMessage & { destroyed: boolean }
}

function mockRes(headersSent = false) {
  const calls: { writeHead?: [number, unknown]; end?: string; destroyed?: boolean } = {}
  const res = {
    headersSent,
    writeHead: (code: number, headers: unknown) => {
      calls.writeHead = [code, headers]
    },
    end: (body?: string) => {
      calls.end = body
    },
    destroy: () => {
      calls.destroyed = true
    },
  } as unknown as ServerResponse
  return { res, calls }
}

describe('readBody / readJsonBody / readForm', () => {
  it('readBody concatena los chunks', async () => {
    expect(await readBody(mockReq(['ab', 'cd']), 1024)).toBe('abcd')
  })

  it('excede el límite → rechaza Y corta el stream (destroy)', async () => {
    const req = mockReq(['x'.repeat(50), 'y'.repeat(50)])
    await expect(readBody(req, 64)).rejects.toThrow(/demasiado grande/)
    expect(req.destroyed).toBe(true)
  })

  it('readJsonBody: JSON válido / vacío / inválido', async () => {
    expect(await readJsonBody(mockReq(['{"a":1}']))).toEqual({ a: 1 })
    expect(await readJsonBody(mockReq([]))).toEqual({})
    await expect(readJsonBody(mockReq(['{no-json']))).rejects.toThrow(/JSON inválido/)
  })

  it('readForm: parsea urlencoded', async () => {
    expect(await readForm(mockReq(['a=1&b=hola+mundo']))).toEqual({ a: '1', b: 'hola mundo' })
  })
})

describe('fail', () => {
  it('escapa el mensaje (no interpola HTML crudo)', () => {
    const { res, calls } = mockRes(false)
    fail(res, 400, '<script>alert(1)</script>')
    expect(calls.writeHead?.[0]).toBe(400)
    expect(calls.end).toContain('&lt;script&gt;')
    expect(calls.end).not.toContain('<script>')
  })

  it('con headersSent → destroy y NO escribe (evita ERR_HTTP_HEADERS_SENT)', () => {
    const { res, calls } = mockRes(true)
    fail(res, 500, 'x')
    expect(calls.writeHead).toBeUndefined()
    expect(calls.destroyed).toBe(true)
  })
})
