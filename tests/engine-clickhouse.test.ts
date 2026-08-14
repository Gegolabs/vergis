import { describe, it, expect } from 'vitest'
import { computeBound, unionInjections, type DatasetCfg } from '../server/engines/clickhouse'
import type { PolicyDecl } from '@vergis/policy'

const DATASETS: DatasetCfg[] = [{ table: 'qw04.areas', columns: {} }]
const PUBLIC: PolicyDecl = { public: true }
const GOVERNED: PolicyDecl = {
  predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
  combine: 'and',
  default: 'deny',
}

describe('engine clickhouse · computeBound', () => {
  it('compila el enforcement de cada dataset desde el store', () => {
    const bound = computeBound(DATASETS, new Map([['qw04.areas', PUBLIC]]), 'consumer_role')
    expect(bound[0].schema.database).toBe('qw04')
    expect(bound[0].schema.table).toBe('areas')
    expect(bound[0].enforcement?.rowPolicySQL).toContain('USING 1') // pública = allow-all
  })

  it('dataset sin política lanza (fail-closed default-deny)', () => {
    expect(() => computeBound(DATASETS, new Map(), 'consumer_role')).toThrow(/Sin política/)
  })

  it('dataset mal formado (no db.tabla) lanza', () => {
    expect(() => computeBound([{ table: 'sinpunto', columns: {} }], new Map([['sinpunto', PUBLIC]]), 'r')).toThrow(/db\.tabla/)
  })

  // Una regla de columna sobre ClickHouse rompe: este back-end no sabe enmascarar y la alternativa
  // NO es servir en claro (issue #163). Lo que se fija acá es que el error llegue con SITIO — sin el
  // nombre del dataset, el operador recibe un mensaje del compilador sin saber a qué tabla culpar.
  it('regla de columna sobre ClickHouse: rompe el arranque, nombrando el dataset y conservando la causa', () => {
    const conColumna: PolicyDecl = { public: true, columnRules: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }
    let capturado: unknown
    try {
      computeBound(DATASETS, new Map([['qw04.areas', conColumna]]), 'consumer_role')
    } catch (e) {
      capturado = e
    }
    expect(capturado).toBeInstanceOf(Error)
    const err = capturado as Error & { cause?: unknown }
    expect(err.message).toContain("Dataset 'qw04.areas'") // el SITIO
    expect(err.message).toMatch(/en claro|enmascar/i) // …y la causa original, no traducida
    expect(err.cause).toBeDefined() // la causa viaja entera, para quien la necesite completa
  })

  // CONTROL: el envoltorio no puede tragarse los errores que ya existían ni cambiar su forma.
  it('CONTROL: el dataset sin política sigue lanzando su error de siempre, sin envolver', () => {
    expect(() => computeBound(DATASETS, new Map(), 'consumer_role')).toThrow(/Sin política/)
  })
})

describe('engine clickhouse · A11 (recompute desde el store cierra la fuga del hot-hardening)', () => {
  it('recomputar desde un store ENDURECIDO da enforcement distinto (no el viejo allow-all)', () => {
    const antes = computeBound(DATASETS, new Map([['qw04.areas', PUBLIC]]), 'consumer_role')
    const despues = computeBound(DATASETS, new Map([['qw04.areas', GOVERNED]]), 'consumer_role')
    // Antes: allow-all sin inyecciones. Después de endurecer: predicado real + inyección de claim.
    expect(antes[0].enforcement?.rowPolicySQL).toContain('USING 1')
    expect(despues[0].enforcement?.rowPolicySQL).not.toContain('USING 1')
    expect(despues[0].enforcement?.rowPolicySQL).toContain('vergis_claim_groups')
    expect(unionInjections(antes)).toEqual([])
    expect(unionInjections(despues)).toEqual([{ setting: 'vergis_claim_groups', claim: 'groups' }])
  })
})
