// Cliente del sidecar HTML→PDF y las piezas puras del endpoint (issue #65 · D1/D8/D10).
//
// El contrato de RED se prueba de verdad: un sidecar FAKE en `node:http` sobre un puerto efímero, no
// un mock de `fetch`. Lo que se quiere saber es si el cliente sabe distinguir «convirtió» de «no pude
// convertir» frente a un socket real — un mock nunca podría refutarlo.
import { describe, expect, it, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createPdfClient, PdfUnavailableError, pdfFilename, contentDisposition } from '../server/pdf'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

/** Levanta un sidecar fake en puerto efímero y devuelve su URL base. */
async function fakeSidecar(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (typeof addr === 'string' || addr === null) throw new Error('sin puerto')
  return `http://127.0.0.1:${addr.port}`
}

describe('createPdfClient · contrato de red con el sidecar', () => {
  it('200 con bytes de PDF → los devuelve tal cual', async () => {
    const body = Buffer.from('%PDF-1.7\n%fake\n')
    let recibido = ''
    let contentType = ''
    const url = await fakeSidecar((req, res) => {
      contentType = String(req.headers['content-type'] ?? '')
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        recibido = data
        res.writeHead(200, { 'content-type': 'application/pdf' })
        res.end(body)
      })
    })
    const pdf = await createPdfClient({ serviceUrl: url, timeoutMs: 5000 })('<html>hola</html>')
    expect(Buffer.from(pdf).equals(body)).toBe(true)
    expect(recibido).toBe('<html>hola</html>')
    expect(contentType).toContain('text/html')
  })

  it('la URL del sidecar tolera el `/` final (se pega `/convert` una sola vez)', async () => {
    let path = ''
    const url = await fakeSidecar((req, res) => {
      path = req.url ?? ''
      res.writeHead(200, { 'content-type': 'application/pdf' })
      res.end(Buffer.from('%PDF-'))
    })
    await createPdfClient({ serviceUrl: url + '/', timeoutMs: 5000 })('<html></html>')
    expect(path).toBe('/convert')
  })

  it('500 del sidecar → PdfUnavailableError con el detalle para el log', async () => {
    const url = await fakeSidecar((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('weasyprint: algo explotó')
    })
    const client = createPdfClient({ serviceUrl: url, timeoutMs: 5000 })
    await expect(client('<html></html>')).rejects.toBeInstanceOf(PdfUnavailableError)
    await client('<html></html>').catch((e: PdfUnavailableError) => {
      expect(e.detail).toContain('500')
      expect(e.detail).toContain('weasyprint: algo explotó')
    })
  })

  it('servidor caído (puerto cerrado) → PdfUnavailableError, no una excepción cruda de fetch', async () => {
    // Se levanta y se cierra: el puerto queda libre y garantizadamente sin nadie escuchando.
    const url = await fakeSidecar((_req, res) => res.end())
    await new Promise<void>((r) => servers.pop()!.close(() => r()))
    const client = createPdfClient({ serviceUrl: url, timeoutMs: 5000 })
    await expect(client('<html></html>')).rejects.toBeInstanceOf(PdfUnavailableError)
  })

  it('sidecar que nunca responde → PdfUnavailableError por timeout, rápido', async () => {
    const url = await fakeSidecar(() => {
      /* silencio deliberado: el request queda colgado */
    })
    const client = createPdfClient({ serviceUrl: url, timeoutMs: 100 })
    const t0 = Date.now()
    await expect(client('<html></html>')).rejects.toBeInstanceOf(PdfUnavailableError)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('pdfFilename · gramática de nombres (D10, la de #61)', () => {
  it('documento de una vista', () => {
    expect(pdfFilename('Reporte Facturas', undefined, '2026-08-06', false)).toBe('reporte-facturas--2026-08-06.pdf')
  })
  it('multi-vista → segmento de página', () => {
    expect(pdfFilename('Reporte Facturas', 'detalle', '2026-08-06', false)).toBe('reporte-facturas--detalle--2026-08-06.pdf')
  })
  it('con filtros activos → sufijo --filtrado', () => {
    expect(pdfFilename('Reporte Facturas', 'detalle', '2026-08-06', true)).toBe('reporte-facturas--detalle--2026-08-06--filtrado.pdf')
  })
  it('la página igual al documento no se repite', () => {
    expect(pdfFilename('Resumen', 'Resumen', '2026-08-06', false)).toBe('resumen--2026-08-06.pdf')
  })
  it('conserva tildes y ñ; descarta la puntuación', () => {
    expect(pdfFilename('Gestión de Compras (2026)', undefined, '2026-08-06', false)).toBe('gestión-de-compras-2026--2026-08-06.pdf')
  })
  it('título vacío → base genérica, jamás un nombre que empiece por el separador', () => {
    expect(pdfFilename('', undefined, '2026-08-06', false)).toBe('documento--2026-08-06.pdf')
  })
})

describe('contentDisposition · fallback ASCII + RFC 5987', () => {
  it('nombre ASCII → ambos campos coinciden', () => {
    expect(contentDisposition('reporte--2026-08-06.pdf')).toBe(
      `attachment; filename="reporte--2026-08-06.pdf"; filename*=UTF-8''reporte--2026-08-06.pdf`,
    )
  })
  it('nombre con tildes → el fallback las descarta, el filename* las conserva', () => {
    const cd = contentDisposition('gestión--2026-08-06.pdf')
    expect(cd).toContain('filename="gestin--2026-08-06.pdf"')
    expect(cd).toContain(`filename*=UTF-8''gesti%C3%B3n--2026-08-06.pdf`)
  })
})
