/** La spec del Let Daftar: qué se acepta, qué se rechaza y con qué mensaje (H3 · §3.3). */
import { describe, it, expect } from 'vitest'
import { parseDaftarSpec, createDaftarProto, crearInstrumentos } from '@vergis/daftar'

const VALIDA = `daftar_version: "1.0"
identity:
  code: estudios
  display_name: "Daftar · Estudios"
estudiantes:
  sebas:  { name: "Sebastián Obach", grade: "8° Básico" }
  matias: { name: "Matías Obach",    grade: "4° Medio" }
`

const proto = createDaftarProto({ instrumentos: crearInstrumentos({ dir: '/no-existe', log: () => {} }), store: () => null })

describe('daftar · parse de la spec', () => {
  it('una spec válida rinde identidad y padrón', () => {
    const s = parseDaftarSpec(VALIDA)
    expect(s.identity).toEqual({ code: 'estudios', display_name: 'Daftar · Estudios' })
    expect(Object.keys(s.estudiantes)).toEqual(['sebas', 'matias'])
    expect(s.estudiantes['matias']).toEqual({ name: 'Matías Obach', grade: '4° Medio' })
  })

  it('`grade` es opcional y se normaliza a cadena vacía', () => {
    expect(parseDaftarSpec('daftar_version: "1"\nidentity: { code: x }\nestudiantes: { a: { name: A } }').estudiantes['a']).toEqual({ name: 'A', grade: '' })
  })

  it.each([
    ['no es un objeto', '- a\n- b', /no es un objeto/],
    ['sin discriminador', 'identity: { code: x }\nestudiantes: { a: { name: A } }', /falta `daftar_version`/],
    ['sin identity', 'daftar_version: "1"\nestudiantes: { a: { name: A } }', /falta el bloque `identity`/],
    ['code con mayúsculas', 'daftar_version: "1"\nidentity: { code: Estudios }\nestudiantes: { a: { name: A } }', /identity.code/],
    ['sin estudiantes', 'daftar_version: "1"\nidentity: { code: x }', /falta el bloque `estudiantes`/],
    ['estudiantes vacío', 'daftar_version: "1"\nidentity: { code: x }\nestudiantes: {}', /está vacío/],
    ['estudiante sin name', 'daftar_version: "1"\nidentity: { code: x }\nestudiantes: { a: { grade: "1°" } }', /no declara `name`/],
  ])('rechaza: %s', (_caso, texto, patron) => {
    expect(() => parseDaftarSpec(texto)).toThrow(patron as RegExp)
  })
})

describe('daftar · el proto', () => {
  it('declara familia, discriminador y que NO consume datos gobernados', () => {
    expect(proto.type).toBe('daftar')
    expect(proto.discriminator).toBe('daftar_version')
    expect(proto.consumesData).toBe(false)
  })

  it('`identityOf` da el código del que sale el slug, y `capabilitiesOf`/`dataOf` van vacíos por contrato', () => {
    const s = parseDaftarSpec(VALIDA)
    expect(proto.identityOf(s)).toEqual({ code: 'estudios', displayName: 'Daftar · Estudios' })
    expect(proto.capabilitiesOf(s)).toEqual([])
    expect(proto.dataOf(s)).toEqual([])
  })

  it('sin `display_name` el nombre visible lo deriva el descubrimiento del código', () => {
    expect(proto.identityOf(parseDaftarSpec('daftar_version: "1"\nidentity: { code: x }\nestudiantes: { a: { name: A } }'))).toEqual({ code: 'x' })
  })
})
