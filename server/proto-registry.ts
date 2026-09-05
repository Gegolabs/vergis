/**
 * REGISTRO DE PROTO-BOTLETS (doc 013 del cluster «Botler genérico», hito H0).
 *
 * El nodo deja de saber que sus specs son de Mira: recibe una lista de proto-Botlets y decide a qué
 * familia pertenece cada texto de spec por la PRESENCIA de su clave discriminadora en la raíz del
 * YAML. No valida el valor de la clave ni el resto de la spec — eso es del proto.
 *
 * El parseo de discriminación es deliberadamente `YAML.parse` pelado y NO el `parse()` del proto: la
 * discriminación tiene que poder ocurrir ANTES de saber de quién es la spec.
 */
import YAML from 'yaml'
import type { ProtoBotlet } from '@vergis/botler'

export type Discriminacion =
  /** El texto no parsea como YAML, o no es un objeto (lista, escalar, null): no es una spec. */
  | { kind: 'no-spec' }
  /** Exactamente un proto reconoce la spec. */
  | { kind: 'ok'; proto: ProtoBotlet }
  /** Más de un discriminador presente: el llamador la OMITE y lo registra (§7 del diseño rector). */
  | { kind: 'ambigua'; protos: ProtoBotlet[] }
  /** Ningún discriminador presente: el llamador aplica la regla de compatibilidad (§3.3 del brief). */
  | { kind: 'sin-discriminador' }

export interface ProtoRegistry {
  /** Los protos registrados, en orden de registro. */
  list(): ProtoBotlet[]
  /** Decide a qué familia pertenece un texto de spec. */
  discriminate(text: string): Discriminacion
}

export function createProtoRegistry(protos: ProtoBotlet[]): ProtoRegistry {
  // Error de CABLEADO, no de operación: dos protos con el mismo `type` o el mismo `discriminator`
  // vuelven la discriminación indecidible. Se lanza al construir, no al servir.
  const tipos = new Set<string>()
  const claves = new Set<string>()
  for (const p of protos) {
    if (tipos.has(p.type)) throw new Error(`proto-registry: dos proto-Botlets con el mismo type '${p.type}'`)
    if (claves.has(p.discriminator)) throw new Error(`proto-registry: dos proto-Botlets con el mismo discriminator '${p.discriminator}'`)
    tipos.add(p.type)
    claves.add(p.discriminator)
  }
  const registrados = [...protos]

  return {
    list: () => [...registrados],
    discriminate(text: string): Discriminacion {
      let doc: unknown
      try {
        doc = YAML.parse(text)
      } catch {
        return { kind: 'no-spec' }
      }
      if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { kind: 'no-spec' }
      const raiz = doc as Record<string, unknown>
      const hits = registrados.filter((p) => Object.prototype.hasOwnProperty.call(raiz, p.discriminator))
      if (hits.length === 1) return { kind: 'ok', proto: hits[0]! }
      if (hits.length > 1) return { kind: 'ambigua', protos: hits }
      return { kind: 'sin-discriminador' }
    },
  }
}
