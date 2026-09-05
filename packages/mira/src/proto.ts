/**
 * Mira como PROTO-BOTLET — la primera familia de Lets que el nodo sabe hospedar (doc 013 del cluster
 * «Botler genérico», hito H0).
 *
 * Es EXTRACCIÓN LITERAL de lo que `server/discovery.ts` hacía en línea: mismo parser (`parseSpec`),
 * mismas lecturas (`spec.data[*].capability`, `params.sql`, `params.database_ref`,
 * `identity.code ?? identity.id ?? 'pi'`, `identity.display_name`). El nodo deja de conocer estas
 * claves; las conoce Mira.
 */
import type { LetInvocation, LetResponse, ProtoBotlet } from '@vergis/botler'
import { parseSpec } from './dsl/parse'

/** La forma MÍNIMA de una spec que el descubrimiento necesita — no es el DSL completo (`MiraSpec`):
 *  el nodo solo mira identidad, capabilities y fuentes de dato. */
export interface MiraSpecLike {
  identity?: { code?: string; id?: string; display_name?: string }
  data?: Record<string, { capability?: string; params?: { sql?: string; database_ref?: string } }>
}

/** Lo que el NODO le presta a Mira para que pueda atender su ruta. Hoy es uno solo: el render
 *  por-consumidor de un PI (`renderReport` de `serve-rls.ts`), que cierra sobre capabilities, notas,
 *  as-of y config. El proto no lo conoce ni lo construye: lo recibe. */
export interface MiraProtoDeps {
  /** Render por-consumidor del PI cuya spec vive en `specPath`, bajo la invocación dada. */
  render(specPath: string, inv: LetInvocation): Promise<string>
}

/**
 * Mira como proto-Botlet. `createMiraProto` en vez de una constante porque `invoke` necesita el render
 * del nodo (D-72): el dominio no puede fabricarlo. Su `invoke` atiende EXACTAMENTE la ruta que el
 * router ya atendía —`GET /<slug>`— y devuelve `null` para cualquier otra, así que la conducta
 * observable de una instancia Mira no cambia: las rutas Mira-específicas (`/pdf`, `/config`, notas)
 * las sigue sirviendo el router antes de llegar acá.
 */
export function createMiraProto(deps: MiraProtoDeps): ProtoBotlet<MiraSpecLike> {
  return { ...miraProtoBase, invoke: miraInvoke(deps) }
}

const miraInvoke =
  (deps: MiraProtoDeps) =>
  async (_spec: MiraSpecLike, specPath: string, inv: LetInvocation): Promise<LetResponse | null> => {
    if (inv.path !== '' || inv.method !== 'GET') return null
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: await deps.render(specPath, inv) }
  }

/** Todo lo de H0 (descubrimiento), sin `invoke`: lo comparte `createMiraProto`. */
const miraProtoBase = {
  type: 'mira',
  discriminator: 'mira_version',
  consumesData: true,
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
} satisfies Omit<ProtoBotlet<MiraSpecLike>, 'invoke'>
