/**
 * Utilidades HTTP compartidas del servidor — módulo del refactor createApp() (A14).
 *
 * `readBody` unifica la lectura de cuerpo (hoy duplicada en `serve-rls#readJsonBody` y `ui#readForm`)
 * y CORTA el stream al exceder el límite (los originales rechazaban la promesa pero el listener
 * `data` seguía acumulando hasta que el cliente terminara — el "límite" no acotaba memoria).
 * `fail` gana el guard `headersSent` (evita ERR_HTTP_HEADERS_SENT → rechazo no manejado que tumba
 * el proceso en Node 22) y escapa el mensaje (era interpolado crudo).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { escapeHtml } from '@vergis/capabilities'

/** Comparación de tiempo constante para tokens/firmas: no delata cuántos caracteres coinciden.
 *  La longitud del token esperado es fija y pública (24 hex), así que comparar longitudes primero no
 *  filtra nada útil; solo evita el requisito de buffers de igual tamaño de `timingSafeEqual`. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Lee el cuerpo como string con límite DURO: al excederlo, corta el stream y rechaza. */
export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > limit) {
        req.removeAllListeners('data')
        req.destroy()
        reject(new Error('cuerpo demasiado grande'))
      }
    })
    req.on('end', () => resolveBody(data))
    req.on('error', reject)
  })
}

/** Cuerpo JSON de un POST (límite defensivo). */
export async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const data = await readBody(req, limit)
  try {
    return data ? JSON.parse(data) : {}
  } catch {
    throw new Error('JSON inválido')
  }
}

/** Cuerpo `application/x-www-form-urlencoded` → mapa campo→valor. */
export async function readForm(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, string>> {
  const data = await readBody(req, limit)
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(data)) out[k] = v
  return out
}

/** Página de error mínima. Escapa el mensaje y NO escribe si ya se enviaron headers. */
export function fail(res: ServerResponse, code: number, msg: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h1>${code}</h1><p>${escapeHtml(msg)}</p></body>`)
}
