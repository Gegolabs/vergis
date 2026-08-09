// Forma canónica de una definición del motor (issue #107 fase 2, Δ1). Lo que se prueba es
// exactamente lo que el hito cero MIDIÓ que el motor hace al persistir —`""` → `null` y
// re-serialización pretty-print con CRLF— más las invariantes de identidad: orden de parts y orden
// de claves irrelevantes, y payload no-JSON comparado byte a byte.

import { describe, it, expect } from 'vitest'
import { canonicalDefinitionSha256, canonicalPayload, definitionsEquivalent } from '@vergis/capabilities'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const part = (path: string, texto: string): { path: string; payloadBase64: string } => ({ path, payloadBase64: b64(texto) })

describe('definition-canonical · las dos normalizaciones MEDIDAS del motor', () => {
  it('`""` y `null` son la misma definición (el motor devuelve null donde se envió "")', () => {
    const enviado = [part('SparkJobDefinitionV1.json', JSON.stringify({ mainClass: '', language: 'Python' }))]
    const leido = [part('SparkJobDefinitionV1.json', JSON.stringify({ mainClass: null, language: 'Python' }))]
    expect(definitionsEquivalent(enviado, leido)).toBe(true)
  })

  it('pretty-print con CRLF ≡ compacto (el motor re-serializa lo que guarda)', () => {
    const compacto = '{"a":1,"b":{"c":[1,2]}}'
    const pretty = JSON.stringify(JSON.parse(compacto), null, 2).replace(/\n/g, '\r\n')
    expect(pretty).toContain('\r\n')
    expect(definitionsEquivalent([part('p.json', compacto)], [part('p.json', pretty)])).toBe(true)
  })

  it('las dos normalizaciones juntas, anidadas en profundidad', () => {
    const enviado = JSON.stringify({ n: { m: [{ x: '' }, { y: 'v' }] }, z: '' })
    const leido = '{\r\n  "n": {\r\n    "m": [\r\n      { "x": null },\r\n      { "y": "v" }\r\n    ]\r\n  },\r\n  "z": null\r\n}'
    expect(definitionsEquivalent([part('p.json', enviado)], [part('p.json', leido)])).toBe(true)
  })
})

describe('definition-canonical · invariantes de identidad', () => {
  it('el sha es estable ante el reorden de las parts', () => {
    const a = [part('a.json', '{"x":1}'), part('b.json', '{"y":2}')]
    const b = [part('b.json', '{"y":2}'), part('a.json', '{"x":1}')]
    expect(canonicalDefinitionSha256(a)).toBe(canonicalDefinitionSha256(b))
  })

  it('el orden de las claves de un objeto es irrelevante; el de un ARREGLO no', () => {
    expect(canonicalDefinitionSha256([part('p.json', '{"a":1,"b":2}')])).toBe(canonicalDefinitionSha256([part('p.json', '{"b":2,"a":1}')]))
    expect(canonicalDefinitionSha256([part('p.json', '[1,2]')])).not.toBe(canonicalDefinitionSha256([part('p.json', '[2,1]')]))
  })

  it('el `path` entra en la identidad: mismo payload en otra parte es otra definición', () => {
    expect(canonicalDefinitionSha256([part('a.json', '{"x":1}')])).not.toBe(canonicalDefinitionSha256([part('b.json', '{"x":1}')]))
  })

  it('la concatenación no se puede confundir: `path\\n<payload>\\n` separa las parts sin ambigüedad', () => {
    // Una part cuyo payload contiene el nombre de la siguiente NO puede colisionar con las dos parts.
    const juntas = [part('a', '"b\\n{}"'), part('b', '{}')]
    const una = [part('a', '"b\\n{}"')]
    expect(canonicalDefinitionSha256(juntas)).not.toBe(canonicalDefinitionSha256(una))
  })

  it('sha256 hex de 64 caracteres, determinista entre llamadas', () => {
    const sha = canonicalDefinitionSha256([part('p.json', '{"x":1}')])
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    expect(canonicalDefinitionSha256([part('p.json', '{"x":1}')])).toBe(sha)
  })

  it('dos parts con el mismo path lanzan: una definición así no tiene identidad única', () => {
    expect(() => canonicalDefinitionSha256([part('p.json', '{"x":1}'), part('p.json', '{"x":2}')])).toThrow(/part duplicada 'p\.json'/)
  })

  it('cero parts es un sha válido y estable (el vacío también tiene identidad)', () => {
    expect(canonicalDefinitionSha256([])).toBe(canonicalDefinitionSha256([]))
    expect(canonicalDefinitionSha256([])).not.toBe(canonicalDefinitionSha256([part('p.json', '{}')]))
  })
})

describe('definition-canonical · payload que NO es JSON: byte a byte', () => {
  it('un payload no-JSON solo es equivalente a sí mismo, sin normalización inventada', () => {
    const texto = 'print("hola")\r\n'
    expect(definitionsEquivalent([part('m.py', texto)], [part('m.py', texto)])).toBe(true)
    // El mismo script con LF en vez de CRLF es OTRA cosa: nadie midió que el motor lo normalice.
    expect(definitionsEquivalent([part('m.py', texto)], [part('m.py', 'print("hola")\n')])).toBe(false)
    // Ni se le aplica normalización de ningún tipo: dos textos distintos son dos payloads distintos.
    expect(definitionsEquivalent([part('m.py', 'x = ""')], [part('m.py', 'x = None')])).toBe(false)
    // (La frontera es `JSON.parse`: un payload que ES un escalar JSON válido —`""`, `null`, `3`— sí
    //  entra por el camino JSON, y ahí `""` ≡ `null` por la normalización MEDIDA.)
    expect(definitionsEquivalent([part('p.json', '""')], [part('p.json', 'null')])).toBe(true)
  })

  it('bytes no-UTF8 sobreviven la canonicalización (no se decodifican con pérdida)', () => {
    const crudo = Buffer.from([0xff, 0xfe, 0x00, 0x41]).toString('base64')
    const otro = Buffer.from([0xff, 0xfe, 0x00, 0x42]).toString('base64')
    expect(canonicalDefinitionSha256([{ path: 'bin', payloadBase64: crudo }])).toBe(canonicalDefinitionSha256([{ path: 'bin', payloadBase64: crudo }]))
    expect(canonicalDefinitionSha256([{ path: 'bin', payloadBase64: crudo }])).not.toBe(canonicalDefinitionSha256([{ path: 'bin', payloadBase64: otro }]))
  })

  it('`canonicalPayload` muestra la forma canónica: JSON compacto, o el crudo intacto', () => {
    expect(canonicalPayload(b64('{\r\n  "b": 2,\r\n  "a": ""\r\n}'))).toBe('{"a":null,"b":2}')
    expect(canonicalPayload(b64('no soy json'))).toBe('no soy json')
  })
})
