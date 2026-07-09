/**
 * Gate HMAC de escritura de anotaciones — módulo del refactor createApp() (A14/A15).
 *
 * La escritura de anotación (único surface mutable para consumidores) se gatea con un token firmado
 * POR-RENDER: el token prueba que el server renderizó ESA clave para ESA identidad (= la fila era
 * visible bajo su RLS). Forjar una clave no-visible, o robar el token de otra identidad, no produce
 * un token válido. Puro (recibe el secreto) → testeable adversarialmente sin server.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Comparación de tiempo constante para tokens/firmas: no delata cuántos caracteres coinciden.
 *  La longitud del token esperado es fija y pública (24 hex), así que comparar longitudes primero no
 *  filtra nada útil; solo evita el requisito de buffers de igual tamaño de `timingSafeEqual`. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Token de anotación: HMAC(secret, `pi|email|key|epoch`), truncado a 24 hex. `epoch` es un bucket
 * temporal (`''` = sin época, back-compat): al incluirlo, un token deja de validar cuando el bucket
 * cambia, así una identidad cuyo acceso se revocó no puede escribir con tokens de páginas viejas para
 * siempre (la verificación tolera el bucket anterior para no cortar en el borde — ver `verifyAnnToken`).
 */
export function annSign(secret: string, piId: string, email: string, key: string, epoch = ''): string {
  return createHmac('sha256', secret).update(`${piId}|${email}|${key}|${epoch}`).digest('hex').slice(0, 24)
}

/** ¿El token corresponde a (pi, email, key) para ALGUNO de los epochs aceptados (actual + anterior)? */
export function verifyAnnToken(secret: string, piId: string, email: string, key: string, token: string, epochs: string[] = ['']): boolean {
  return !!key && epochs.some((e) => constantTimeEqual(annSign(secret, piId, email, key, e), token))
}
