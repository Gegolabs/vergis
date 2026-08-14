// El plano de COLUMNA del oráculo — issue #163 H1 (diseño §4.1, §4.5, §4.6).
//
// Lo que estas pruebas fijan NO es «la máscara funciona»: es que la extensión sea CONSERVADORA.
// El property test diferencial de `policy.test.ts` sostiene todo el aseguramiento del compilador y
// pasa SIN CAMBIOS — esa es la prueba de arriba. Acá abajo se fija lo que ese property test no
// puede ver porque no declara reglas de columna:
//   · la ausencia del claim ENMASCARA (default-deny de la celda), no abre;
//   · la FORMA del resultado no depende del sujeto (§4.1: mentimos el valor, jamás el esquema);
//   · una política sin reglas devuelve la MISMA fila, no una copia con pérdida (control negativo).
//
// Lo que NO se prueba acá, deliberadamente: nada sobre agregados ni cardinalidad (§4.3). Un `SUM`
// sobre una columna enmascarada no es asunto del IR, y una prueba acá lo volvería contrato.

import { describe, expect, it } from 'vitest'
import { VergisError } from '@vergis/botler'
import {
  applyPolicy,
  columnRules,
  maskedColumns,
  MASK_VALUE,
  type ColumnRule,
  type Policy,
  type PolicyDecl,
} from '@vergis/policy'

type Fila = Record<string, unknown>

const STORE: Fila[] = [
  { area: 'Producción', rut: '11.111.111-1', sueldo: 900, region: 'Norte' },
  { area: 'Finanzas', rut: '22.222.222-2', sueldo: 1500, region: 'Centro' },
]

/** Política de fila corriente: se ve el área propia. El plano de columna se le monta encima. */
function policyArea(columnRules?: ColumnRule[]): Policy {
  return {
    predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
    combine: 'and',
    default: 'deny',
    columnRules,
  }
}

const REGLA_RUT: ColumnRule = { column: 'rut', claim: 've_pii', action: 'mask' }

describe('#163 H1 · plano de columna del oráculo', () => {
  const pol = policyArea([REGLA_RUT])

  it('sujeto SIN el claim de la regla → la columna va enmascarada (la ausencia no abre)', () => {
    const r = applyPolicy(pol, { groups: ['Producción'] }, STORE)
    expect(r).toHaveLength(1)
    expect(r[0].rut).toBe(MASK_VALUE)
    // el resto de la fila queda intacto: la máscara es de la CELDA, no de la fila
    expect(r[0].area).toBe('Producción')
    expect(r[0].sueldo).toBe(900)
  })

  it('claim presente pero vacío / con cadenas vacías → también enmascara (mismo default-deny)', () => {
    for (const ve_pii of [[], [''], '' as string]) {
      const r = applyPolicy(pol, { groups: ['Producción'], ve_pii }, STORE)
      expect(r[0].rut).toBe(MASK_VALUE)
    }
  })

  it('sujeto CON el claim que la regla permite → valor en claro', () => {
    const r = applyPolicy(pol, { groups: ['Producción'], ve_pii: ['si'] }, STORE)
    expect(r[0].rut).toBe('11.111.111-1')
  })

  it('la FORMA del resultado es la misma con y sin el claim: mismas claves, mismo orden', () => {
    const sin = applyPolicy(pol, { groups: ['Producción'] }, STORE)
    const con = applyPolicy(pol, { groups: ['Producción'], ve_pii: ['si'] }, STORE)
    expect(Object.keys(sin[0])).toEqual(Object.keys(con[0]))
    expect(Object.keys(sin[0])).toEqual(Object.keys(STORE[0])) // y es la forma ORIGINAL
    expect(sin).toHaveLength(con.length)
  })

  it('reglas sobre VARIAS columnas: cada una responde a su propio claim, independiente', () => {
    const multi = policyArea([REGLA_RUT, { column: 'sueldo', claim: 've_remuneracion', action: 'mask' }])
    const soloPii = applyPolicy(multi, { groups: ['Producción'], ve_pii: ['si'] }, STORE)
    expect(soloPii[0].rut).toBe('11.111.111-1')
    expect(soloPii[0].sueldo).toBe(MASK_VALUE)

    const ninguno = applyPolicy(multi, { groups: ['Producción'] }, STORE)
    expect(ninguno[0].rut).toBe(MASK_VALUE)
    expect(ninguno[0].sueldo).toBe(MASK_VALUE)
    expect(Object.keys(ninguno[0])).toEqual(Object.keys(STORE[0])) // la forma no se mueve

    const ambos = applyPolicy(multi, { groups: ['Producción'], ve_pii: ['si'], ve_remuneracion: ['si'] }, STORE)
    expect(ambos[0]).toEqual(STORE[0])
  })

  it('regla sobre una columna que la fila NO trae: no inventa la clave (no mentimos el esquema)', () => {
    const p = policyArea([{ column: 'fantasma', claim: 've_pii', action: 'mask' }])
    const r = applyPolicy(p, { groups: ['Producción'] }, STORE)
    expect(Object.keys(r[0])).toEqual(Object.keys(STORE[0]))
    expect('fantasma' in r[0]).toBe(false)
  })

  it('el plano de columna NO toca la semántica de fila: enmascara lo que la policy ya dejó pasar', () => {
    const conRegla = applyPolicy(pol, { groups: ['Finanzas'] }, STORE)
    const sinRegla = applyPolicy(policyArea(), { groups: ['Finanzas'] }, STORE)
    expect(conRegla).toHaveLength(sinRegla.length)
    expect(conRegla.map((r) => r.area)).toEqual(sinRegla.map((r) => r.area))
    // y una política que niega toda fila sigue negándolas: la máscara no resucita nada
    expect(applyPolicy(pol, {}, STORE)).toHaveLength(0)
  })

  it('también sobre una policy PÚBLICA: los planos son ortogonales', () => {
    const publica: PolicyDecl = { public: true, columnRules: [REGLA_RUT] }
    const r = applyPolicy(publica, {}, STORE)
    expect(r).toHaveLength(STORE.length) // pública: todas las filas
    expect(r.every((x) => x.rut === MASK_VALUE)).toBe(true)
    expect(applyPolicy(publica, { ve_pii: ['si'] }, STORE)).toEqual(STORE)
  })
})

describe('#163 H1 · fail-closed ante regla malformada (rompe, no degrada a "sin máscara")', () => {
  const malas: unknown[] = [
    { column: 'rut', claim: 've_pii' }, // sin action
    { column: 'rut', claim: 've_pii', action: 'hide' }, // acción fuera del vocabulario
    { column: 'rut', claim: 've_pii', action: 'MASK' }, // ni siquiera por mayúsculas
    { claim: 've_pii', action: 'mask' }, // sin column
    { column: '', claim: 've_pii', action: 'mask' }, // column vacía
    { column: 'rut', action: 'mask' }, // sin claim
    { column: 'rut', claim: '', action: 'mask' }, // claim vacío
    'rut', // ni siquiera es un objeto
    null,
  ]

  it('cada forma malformada lanza VergisError al evaluar', () => {
    for (const mala of malas) {
      const p = policyArea([mala as ColumnRule])
      expect(() => applyPolicy(p, { groups: ['Producción'] }, STORE)).toThrow(VergisError)
      expect(() => maskedColumns(p, { groups: ['Producción'] })).toThrow(VergisError)
    }
  })

  it('lanza incluso cuando el sujeto TRAE el claim: una regla ilegible nunca se salta', () => {
    const p = policyArea([{ column: 'rut', claim: 've_pii', action: 'borrar' } as unknown as ColumnRule])
    expect(() => applyPolicy(p, { groups: ['Producción'], ve_pii: ['si'] }, STORE)).toThrow(/mask/)
  })
})

describe('#163 H1 · control negativo: sin reglas de columna no cambia NADA', () => {
  it('una política sin reglas devuelve las MISMAS referencias de fila (no una copia con pérdida)', () => {
    const pol = policyArea() // sin `columnRules`
    const r = applyPolicy(pol, { groups: ['Producción', 'Finanzas'] }, STORE)
    expect(r).toHaveLength(2)
    expect(r[0]).toBe(STORE[0]) // identidad, no equivalencia: nadie copió nada
    expect(r[1]).toBe(STORE[1])
  })

  it('`columnRules: []` es idéntico a no declararlas', () => {
    const claims = { groups: ['Producción'] }
    expect(applyPolicy(policyArea([]), claims, STORE)).toEqual(applyPolicy(policyArea(), claims, STORE))
    expect(applyPolicy(policyArea([]), claims, STORE)[0]).toBe(STORE[0])
  })

  it('con TODOS los claims presentes tampoco copia: no hay celda que sustituir', () => {
    const r = applyPolicy(policyArea([REGLA_RUT]), { groups: ['Producción'], ve_pii: ['si'] }, STORE)
    expect(r[0]).toBe(STORE[0])
  })

  it('`columnRules` / `maskedColumns` sobre una policy sin declaración: vacíos, sin lanzar', () => {
    expect(columnRules(policyArea())).toEqual([])
    expect(columnRules({ public: true })).toEqual([])
    expect(maskedColumns(policyArea(), {}).size).toBe(0)
  })

  it('`maskedColumns` no mira filas: es función de (policy, claims) — sirve antes de tocar el motor', () => {
    const p = policyArea([REGLA_RUT, { column: 'sueldo', claim: 've_remuneracion', action: 'mask' }])
    expect([...maskedColumns(p, { ve_pii: ['si'] })]).toEqual(['sueldo'])
    expect([...maskedColumns(p, {})].sort()).toEqual(['rut', 'sueldo'])
  })
})
