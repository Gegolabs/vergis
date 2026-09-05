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
  /** El proto de esta familia, o `undefined`. Lo usa el despacho: `Report.proto` → quién lo atiende. */
  byType(type: string): ProtoBotlet | undefined
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

  const porTipo = new Map(registrados.map((p) => [p.type, p]))

  return {
    list: () => [...registrados],
    byType: (type: string) => porTipo.get(type),
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

/**
 * ¿Este catálogo puede servirse SIN motor de datos? (H3 · §3.2). Un nodo cuyas specs son todas de
 * familias que no consumen datos gobernados —la instancia «estudios», que hospeda un Let de Daftar y
 * nada más— no tiene DWH: ni datasets que sembrar, ni conexiones que verificar, ni bootstrap de
 * esquema que esperar.
 *
 * CONSERVADOR a propósito: exige al menos una spec Y que ninguna consuma datos. Un catálogo VACÍO
 * —el volumen no montado, la ruta mal escrita— NO cuenta: un nodo de Mira con su directorio vacío por
 * accidente tiene que seguir fallando como siempre, no arrancar mudo sirviendo nada.
 */
export function catalogoSinDatosGobernados(reports: { proto: string }[], protos: ProtoRegistry): boolean {
  return reports.length > 0 && reports.every((r) => protos.byType(r.proto)?.consumesData === false)
}
