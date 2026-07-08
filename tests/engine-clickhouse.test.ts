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
