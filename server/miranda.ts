/**
 * Superficie HTTP de Miranda — el agente conversacional que autora specs (cluster 077). Server-rendered
 * (patrón de `server/pi-config.ts`) + un puñado de endpoints JSON para el chat. Se monta desde
 * `server/routes.ts` SOLO cuando el flag `MIRANDA_ENABLED` está encendido: con el flag apagado,
 * `getMiranda()` devuelve null y `/miranda*` cae al 404 normal (superficie cero).
 *
 * La factory `createMiranda` se define en WP4; aquí vive el contrato que `routes.ts` consume.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface MirandaHandler {
  /** Intenta atender `/miranda*`. Devuelve true si respondió; false si la ruta no le corresponde. */
  tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}
