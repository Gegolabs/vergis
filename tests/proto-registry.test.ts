// H0 (#289) · El registro de proto-Botlets: quién reconoce qué spec, y qué pasa cuando nadie o
// cuando dos la reconocen. La discriminación es por PRESENCIA de la clave raíz, sin validar el valor.
import { describe, it, expect } from 'vitest'
import { createProtoRegistry } from '../server/proto-registry'
import { miraProtoBotlet } from '@vergis/mira'
import type { ProtoBotlet } from '@vergis/botler'

/** Proto FICTICIO, solo de test: H0 no crea `packages/daftar`. Sirve para medir los brazos de dos
 *  familias registradas — sin él, «con dos protos» sería una rama que nadie ejecuta. */
const fakeDaftar: ProtoBotlet<Record<string, unknown>> = {
  type: 'daftar',
  discriminator: 'daftar_version',
  parse: (t) => ({ t }),
  capabilitiesOf: () => [],
  dataOf: () => [],
  identityOf: () => ({ code: 'x' }),
}

describe('proto-registry · discriminación', () => {
  it('una spec con `mira_version` se atribuye a Mira', () => {
    const reg = createProtoRegistry([miraProtoBotlet])
    const v = reg.discriminate('mira_version: "1.0"\nidentity: { code: QW-04 }\n')
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') expect(v.proto.type).toBe('mira')
  })

  it('un texto que no parsea como YAML → `no-spec`', () => {
    const reg = createProtoRegistry([miraProtoBotlet])
    expect(reg.discriminate('{ esto: [no cierra\n  ni: es yaml').kind).toBe('no-spec')
  })

  it('un YAML que es una LISTA o un ESCALAR no es una spec → `no-spec`', () => {
    const reg = createProtoRegistry([miraProtoBotlet])
    expect(reg.discriminate('- uno\n- dos\n').kind).toBe('no-spec')
    expect(reg.discriminate('42\n').kind).toBe('no-spec')
    expect(reg.discriminate('').kind).toBe('no-spec') // YAML vacío parsea a null
  })

  it('dos discriminadores presentes → `ambigua`, con los dos protos nombrados', () => {
    const reg = createProtoRegistry([miraProtoBotlet, fakeDaftar])
    const v = reg.discriminate('mira_version: "1.0"\ndaftar_version: "1.0"\n')
    expect(v.kind).toBe('ambigua')
    if (v.kind === 'ambigua') expect(v.protos.map((p) => p.type).sort()).toEqual(['daftar', 'mira'])
  })

  it('ninguna clave discriminadora → `sin-discriminador` (el llamador decide, no el registro)', () => {
    const reg = createProtoRegistry([miraProtoBotlet, fakeDaftar])
    expect(reg.discriminate('identity: { code: QW-04 }\n').kind).toBe('sin-discriminador')
  })

  it('el VALOR del discriminador no se valida: basta la presencia de la clave', () => {
    const reg = createProtoRegistry([miraProtoBotlet])
    expect(reg.discriminate('mira_version: null\n').kind).toBe('ok')
  })

  it('`list()` devuelve los protos en orden de registro', () => {
    expect(createProtoRegistry([miraProtoBotlet, fakeDaftar]).list().map((p) => p.type)).toEqual(['mira', 'daftar'])
  })
})

describe('proto-registry · errores de cableado (lanzan al construir, no al servir)', () => {
  it('dos protos con el mismo `type` lanzan', () => {
    expect(() => createProtoRegistry([miraProtoBotlet, { ...fakeDaftar, type: 'mira' }])).toThrow(/mismo type 'mira'/)
  })

  it('dos protos con el mismo `discriminator` lanzan', () => {
    expect(() => createProtoRegistry([miraProtoBotlet, { ...fakeDaftar, discriminator: 'mira_version' }])).toThrow(
      /mismo discriminator 'mira_version'/,
    )
  })
})

describe('proto-registry · Mira como proto-Botlet (extracción literal de discoverRaw)', () => {
  const SPEC = [
    'mira_version: "1.0"',
    'identity: { code: QW-04, display_name: "Asistencia" }',
    'data:',
    '  d1: { capability: execute-sql-ch, params: { sql: "SELECT 1 FROM qw04.areas", database_ref: ch1 } }',
  ].join('\n')

  it('lee capabilities, fuentes de dato e identidad como las leía el nodo', () => {
    const spec = miraProtoBotlet.parse(SPEC)
    expect(miraProtoBotlet.capabilitiesOf(spec)).toEqual(['execute-sql-ch'])
    expect(miraProtoBotlet.dataOf(spec)).toEqual([{ sql: 'SELECT 1 FROM qw04.areas', databaseRef: 'ch1' }])
    expect(miraProtoBotlet.identityOf(spec)).toEqual({ code: 'QW-04', displayName: 'Asistencia' })
  })

  it('sin `identity.code` cae a `identity.id`, y sin ninguno a `pi` (la cascada de siempre)', () => {
    expect(miraProtoBotlet.identityOf(miraProtoBotlet.parse('identity: { id: PI-9 }')).code).toBe('PI-9')
    expect(miraProtoBotlet.identityOf(miraProtoBotlet.parse('otra: cosa')).code).toBe('pi')
  })

  it('`parse` lanza si el YAML no es un objeto', () => {
    expect(() => miraProtoBotlet.parse('- a\n- b')).toThrow(/no es un objeto/)
  })
})
