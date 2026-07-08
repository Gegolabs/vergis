/**
 * Gate HMAC de escritura de anotaciones — módulo del refactor createApp() (A14/A15).
 *
 * La escritura de anotación (único surface mutable para consumidores) se gatea con un token firmado
 * POR-RENDER: el token prueba que el server renderizó ESA clave para ESA identidad (= la fila era
 * visible bajo su RLS). Forjar una clave no-visible, o robar el token de otra identidad, no produce
 * un token válido. Puro (recibe el secreto) → testeable adversarialmente sin server.
 */
import { createHmac } from 'node:crypto'

/** Token de anotación: HMAC(secret, `pi|email|key`), truncado a 24 hex. */
export function annSign(secret: string, piId: string, email: string, key: string): string {
  return createHmac('sha256', secret).update(`${piId}|${email}|${key}`).digest('hex').slice(0, 24)
}

/** ¿El token corresponde a (pi, email, key)? Falso si la clave es vacía o el token no coincide. */
export function verifyAnnToken(secret: string, piId: string, email: string, key: string, token: string): boolean {
  return !!key && annSign(secret, piId, email, key) === token
}
