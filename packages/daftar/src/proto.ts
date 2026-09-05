/**
 * Daftar como PROTO-BOTLET — la SEGUNDA familia de Lets que el nodo sabe hospedar, y la prueba
 * ejecutable de que el Botler no tiene subtipos por familia (doc 013, hito H3 · #295).
 *
 * `consumesData: false` (D-73): este Let no toca el DWH. El descubrimiento no le exige capabilities
 * ni le analiza tablas, no entra al gate de gobernanza ni a la verificación por-PI de fabric, y es
 * visible para toda identidad en el índice. Quién puede ver qué lo decide ÉL, adentro de `invoke`,
 * con el claim `student` que el nodo le entrega.
 */
import type { LetInvocation, LetResponse, ProtoBotlet } from '@vergis/botler'
import { parseDaftarSpec, type DaftarSpec } from './spec'
import { atenderDaftar, type DaftarDeps } from './let'

export type DaftarProtoDeps = DaftarDeps

export function createDaftarProto(deps: DaftarProtoDeps): ProtoBotlet<DaftarSpec> {
  return {
    type: 'daftar',
    discriminator: 'daftar_version',
    consumesData: false,
    parse: parseDaftarSpec,
    // Sin datos gobernados no hay capabilities que declarar ni fuentes que analizar. El
    // descubrimiento ni siquiera las consulta con `consumesData: false`; están por contrato.
    capabilitiesOf: () => [],
    dataOf: () => [],
    identityOf: (spec: DaftarSpec) => ({ code: spec.identity.code, ...(spec.identity.display_name ? { displayName: spec.identity.display_name } : {}) }),
    invoke: (spec: DaftarSpec, _specPath: string, inv: LetInvocation): Promise<LetResponse | null> => atenderDaftar(spec, deps, inv),
  }
}
