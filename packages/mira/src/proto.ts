/**
 * Mira como PROTO-BOTLET — la primera familia de Lets que el nodo sabe hospedar (doc 013 del cluster
 * «Botler genérico», hito H0).
 *
 * Es EXTRACCIÓN LITERAL de lo que `server/discovery.ts` hacía en línea: mismo parser (`parseSpec`),
 * mismas lecturas (`spec.data[*].capability`, `params.sql`, `params.database_ref`,
 * `identity.code ?? identity.id ?? 'pi'`, `identity.display_name`). El nodo deja de conocer estas
 * claves; las conoce Mira.
 */
import type { ProtoBotlet } from '@vergis/botler'
import { parseSpec } from './dsl/parse'

/** La forma MÍNIMA de una spec que el descubrimiento necesita — no es el DSL completo (`MiraSpec`):
 *  el nodo solo mira identidad, capabilities y fuentes de dato. */
export interface MiraSpecLike {
  identity?: { code?: string; id?: string; display_name?: string }
  data?: Record<string, { capability?: string; params?: { sql?: string; database_ref?: string } }>
}

export const miraProtoBotlet: ProtoBotlet<MiraSpecLike> = {
  type: 'mira',
  discriminator: 'mira_version',
  parse(text: string): MiraSpecLike {
    const spec = parseSpec(text)
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      throw new Error('la spec de Mira no es un objeto YAML')
    }
    return spec as MiraSpecLike
  },
  capabilitiesOf(spec: MiraSpecLike): string[] {
    return Object.values(spec.data ?? {}).map((d) => d.capability ?? '')
  },
  dataOf(spec: MiraSpecLike): { sql?: string; databaseRef?: string }[] {
    return Object.values(spec.data ?? {}).map((d) => ({ sql: d.params?.sql, databaseRef: d.params?.database_ref }))
  },
  identityOf(spec: MiraSpecLike): { code: string; displayName?: string } {
    return { code: spec.identity?.code ?? spec.identity?.id ?? 'pi', displayName: spec.identity?.display_name }
  },
}
