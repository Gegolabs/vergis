// Diagnóstico de la negación (#165 §3) — el fail-closed no cambia; lo que cambia es que ahora se
// puede DECIR por qué negó.
//
// La prueba que sostiene todo el módulo es la última: `deniesAllRows` se afirma como TEOREMA sobre
// el oráculo, no como heurística. Si dijera `true` donde el evaluador de referencia sí deja pasar
// una fila, un operador cerraría una investigación con la respuesta equivocada — que es peor que no
// tener diagnóstico. Por eso se prueba diferencialmente contra `applyPolicy`, con las MISMAS formas
// aleatorias que usa el property test del codegen.
import { describe, it, expect } from 'vitest'
import {
  diagnoseClaims,
  deniesAllRows,
  explainDenial,
  applyPolicy,
  type ClaimSet,
  type Policy,
  type PolicyDecl,
} from '../packages/policy/src/index'

const eqArea: Policy = {
  predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'eq' }],
  combine: 'and',
  default: 'deny',
}
const inArea: Policy = {
  predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
  combine: 'and',
  default: 'deny',
}

describe('diagnoseClaims · separa las tres causas que hoy son un mismo silencio', () => {
  it('sin claim → `sin-claim` (el default-deny de siempre, ahora nombrado)', () => {
    const d = diagnoseClaims(eqArea, {})
    expect(d).toEqual([{ predicate: 0, column: 'area', claim: 'groups', kind: 'sin-claim', values: 0 }])
  })

  it('claim con UN valor y `eq` → no hay diagnóstico: el modelo lo resuelve', () => {
    expect(diagnoseClaims(eqArea, { groups: ['Producción'] })).toEqual([])
  })

  it('claim con DOS valores y `eq` → `cardinalidad-eq`: el caso del gerente con doble pertenencia', () => {
    const d = diagnoseClaims(eqArea, { groups: ['Gerencia General', 'Proyecto'] })
    expect(d).toEqual([{ predicate: 0, column: 'area', claim: 'groups', kind: 'cardinalidad-eq', values: 2 }])
  })

  it('el MISMO sujeto contra `in` no tiene hallazgo — la cardinalidad solo estorba a `eq`', () => {
    expect(diagnoseClaims(inArea, { groups: ['Gerencia General', 'Proyecto'] })).toEqual([])
  })

  it('el claim vacío o de strings vacíos cuenta como AUSENTE, igual que en el evaluador', () => {
    expect(diagnoseClaims(eqArea, { groups: [] })[0].kind).toBe('sin-claim')
    expect(diagnoseClaims(eqArea, { groups: ['', ''] })[0].kind).toBe('sin-claim')
  })

  it('jerárquico con varios nodos NO es hallazgo: toma un conjunto de ancestros por diseño', () => {
    const jer: Policy = {
      predicates: [
        { kind: 'hierarchy', rel: 'descendant_of', column: 'nodo', claim: 'org', via: 'organigrama', ancestor: 'ancestor', descendant: 'descendant' },
      ],
      combine: 'and',
      default: 'deny',
    }
    expect(diagnoseClaims(jer, { org: ['A', 'B'] })).toEqual([])
    expect(diagnoseClaims(jer, {})[0].kind).toBe('sin-claim')
  })

  it('devuelve TODOS los predicados muertos, no solo el primero', () => {
    const dos: Policy = {
      predicates: [
        { kind: 'membership', column: 'area', claim: 'groups', op: 'eq' },
        { kind: 'membership', column: 'region', claim: 'regions', op: 'eq' },
      ],
      combine: 'and',
      default: 'deny',
    }
    const d = diagnoseClaims(dos, { groups: ['A', 'B'], regions: [] })
    expect(d.map((x) => x.kind)).toEqual(['cardinalidad-eq', 'sin-claim'])
  })

  it('`grant: all` no tiene nada que diagnosticar', () => {
    expect(diagnoseClaims({ public: true }, {})).toEqual([])
    expect(deniesAllRows({ public: true }, {})).toBe(false)
  })

  it('la explicación nombra el claim y JAMÁS su valor (los claims son PII: áreas, cargos, personas)', () => {
    const linea = explainDenial(diagnoseClaims(eqArea, { groups: ['Gerencia General', 'Proyecto'] })[0])
    expect(linea).toContain('CARDINALIDAD')
    expect(linea).toContain('groups')
    expect(linea).not.toContain('Gerencia General')
    expect(linea).not.toContain('Proyecto')
  })
})

describe('deniesAllRows · combinación', () => {
  const dos = (combine: 'and' | 'or'): Policy => ({
    predicates: [
      { kind: 'membership', column: 'area', claim: 'groups', op: 'in' },
      { kind: 'membership', column: 'region', claim: 'regions', op: 'in' },
    ],
    combine,
    default: 'deny',
  })

  it('`and`: un predicado muerto mata la conjunción', () => {
    expect(deniesAllRows(dos('and'), { groups: ['A'] })).toBe(true)
    expect(deniesAllRows(dos('and'), { groups: ['A'], regions: ['N'] })).toBe(false)
  })

  it('`or`: hacen falta todos', () => {
    expect(deniesAllRows(dos('or'), { groups: ['A'] })).toBe(false)
    expect(deniesAllRows(dos('or'), {})).toBe(true)
  })

  it('sin predicados: deny-all explícito, y sin claim al que culpar', () => {
    const vacia: Policy = { predicates: [], combine: 'and', default: 'deny' }
    expect(deniesAllRows(vacia, { groups: ['A'] })).toBe(true)
    expect(diagnoseClaims(vacia, { groups: ['A'] })).toEqual([])
  })
})

// === EL TEOREMA ==============================================================
// `deniesAllRows(p, c) === true`  ⇒  `applyPolicy(p, c, filas) === []`  ∀ filas.
// Se prueba diferencialmente contra el evaluador de referencia con las mismas formas aleatorias del
// property test del codegen. Y se prueba también la MITAD QUE PUEDE FALLAR EN SILENCIO: que cuando
// dice `false`, exista de verdad algún dato que pasa — si no, el diagnóstico sería trivialmente
// «correcto» diciendo siempre `false` y no serviría para nada.
describe('deniesAllRows · property test (teorema sobre el evaluador de referencia)', () => {
  function lcg(seed: number) {
    let s = seed >>> 0
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000)
  }
  const AREAS = ['Producción', 'Finanzas', 'Comercial', 'RRHH', 'Calidad', 'TI']
  const REGIONS = ['Norte', 'Centro', 'Sur']
  const pick = <T,>(rnd: () => number, xs: T[]) => xs[Math.floor(rnd() * xs.length)]
  const subset = <T,>(rnd: () => number, xs: T[]) => xs.filter(() => rnd() < 0.5)

  it('∀ policy, claims: si niega todo, el oráculo devuelve CERO filas — y si no, el conteo lo respalda', () => {
    const rnd = lcg(20260813)
    let vistoNiegaTodo = 0
    let vistoDejaPasar = 0
    for (let iter = 0; iter < 2000; iter += 1) {
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => ({
        area: pick(rnd, AREAS),
        region: pick(rnd, REGIONS),
      })) as unknown as Record<string, unknown>[]
      const nPred = 1 + (rnd() < 0.5 ? 0 : 1)
      const predicates = Array.from({ length: nPred }, () => {
        const useArea = rnd() < 0.5
        return {
          kind: 'membership' as const,
          column: useArea ? 'area' : 'region',
          claim: useArea ? 'groups' : 'regions',
          op: (rnd() < 0.5 ? 'in' : 'eq') as 'in' | 'eq',
        }
      })
      const policy: PolicyDecl = { predicates, combine: rnd() < 0.5 ? 'and' : 'or', default: 'deny' }
      const claims: ClaimSet = {}
      if (rnd() < 0.85) claims.groups = subset(rnd, AREAS)
      if (rnd() < 0.85) claims.regions = subset(rnd, REGIONS)

      const visibles = applyPolicy(policy, claims, rows)
      if (deniesAllRows(policy, claims)) {
        expect(visibles).toEqual([]) // el teorema
        vistoNiegaTodo += 1
      } else if (visibles.length > 0) {
        vistoDejaPasar += 1
      }
    }
    // Control de que el experimento EJERCITÓ las dos ramas: sin esto, un `deniesAllRows` que
    // devolviera siempre `false` pasaría el teorema sin haber sido puesto en riesgo jamás.
    expect(vistoNiegaTodo).toBeGreaterThan(100)
    expect(vistoDejaPasar).toBeGreaterThan(100)
  })

  it('control negativo: un diagnóstico que dijera «niega todo» ante `in` con claim válido rompería', () => {
    // Fija la dirección del teorema: `deniesAllRows` NO puede ser conservador «por si acaso».
    expect(deniesAllRows(inArea, { groups: ['Producción'] })).toBe(false)
    expect(applyPolicy(inArea, { groups: ['Producción'] }, [{ area: 'Producción' }])).toHaveLength(1)
  })
})
