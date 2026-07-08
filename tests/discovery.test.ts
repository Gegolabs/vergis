import { describe, it, expect } from 'vitest'
import { createDiscovery, slugify, type DiscoveryDeps } from '../server/discovery'
import type { ClaimSet, PolicyDecl } from '@vergis/policy'

function specYaml(code: string, sql: string, cap = 'execute-sql-ch'): string {
  return [
    `identity: { code: ${code}, display_name: "${code}" }`,
    `data:`,
    `  d1: { capability: ${cap}, params: { sql: "${sql}" } }`,
    `piece: { layout: rows, elements: [] }`,
    `delivery: { render: [{ format: html, target: web }] }`,
  ].join('\n')
}

const PUBLIC: PolicyDecl = { public: true }
const GOVERNED: PolicyDecl = {
  predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
  combine: 'and',
  default: 'deny',
}

function mk(over: Partial<DiscoveryDeps> & { specs: Record<string, string>; engine: 'clickhouse' | 'fabric' }) {
  const { specs, ...rest } = over
  return createDiscovery({
    store: new Map<string, PolicyDecl>([['qw04.areas', PUBLIC], ['dbo.saldos', GOVERNED]]),
    servingCaps: new Set(['execute-sql-ch']),
    specPaths: () => Object.keys(specs),
    readSpec: (p) => specs[p],
    log: () => {},
    ...rest,
  })
}

describe('discovery · slugify', () => {
  it('minúscula, sin acentos, no-alfanum → guiones', () => {
    expect(slugify('QW-04 Producción')).toBe('qw-04-produccion')
  })
})

describe('discovery · descubrimiento y catálogo de serving', () => {
  it('lista los PIs servibles con su slug', () => {
    const d = mk({ engine: 'clickhouse', specs: { '/a.yaml': specYaml('QW-04', 'SELECT * FROM qw04.areas') } })
    const rep = d.discover()
    expect(rep).toHaveLength(1)
    expect(rep[0].slug).toBe('qw-04')
    expect(rep[0].tables).toEqual(['qw04.areas'])
  })

  it('omite un PI con capability fuera del catálogo de serving', () => {
    const d = mk({ engine: 'clickhouse', specs: { '/a.yaml': specYaml('X', 'SELECT 1 FROM qw04.areas', 'mock-sql') } })
    expect(d.discover()).toHaveLength(0)
  })

  it('avisa por log si dos specs colisionan en slug (la 2ª queda inalcanzable)', () => {
    const logs: string[] = []
    const d = mk({
      engine: 'clickhouse',
      specs: {
        '/a.yaml': specYaml('QW-04', 'SELECT * FROM qw04.areas'),
        '/b.yaml': specYaml('QW-04', 'SELECT * FROM qw04.areas'),
      },
      log: (m) => logs.push(m),
    })
    expect(d.discover()).toHaveLength(2)
    expect(logs.some((l) => l.includes('colisiona en slug'))).toBe(true)
  })
})

describe('discovery · gate de gobernanza fail-closed (fabric)', () => {
  it('fabric: omite un PI que lee una tabla SIN política (fuga en push-down)', () => {
    const d = mk({ engine: 'fabric', specs: { '/a.yaml': specYaml('X', 'SELECT * FROM dbo.secreta', 'execute-sql-dwh') }, servingCaps: new Set(['execute-sql-dwh']) })
    expect(d.discover()).toHaveLength(0)
  })

  it('fabric: omite un PI con tabla de UNA sola parte (no verificable contra el store)', () => {
    const d = mk({ engine: 'fabric', specs: { '/a.yaml': specYaml('X', 'SELECT * FROM dim_area', 'execute-sql-dwh') }, servingCaps: new Set(['execute-sql-dwh']) })
    expect(d.discover()).toHaveLength(0)
  })

  it('fabric: SÍ sirve un PI cuyas tablas están todas gobernadas', () => {
    const d = mk({ engine: 'fabric', specs: { '/a.yaml': specYaml('OK', 'SELECT * FROM dbo.saldos', 'execute-sql-dwh') }, servingCaps: new Set(['execute-sql-dwh']) })
    expect(d.discover()).toHaveLength(1)
  })

  it('clickhouse: NO aplica el gate de tabla-sin-política (la seguridad la da el bootstrap)', () => {
    const d = mk({ engine: 'clickhouse', specs: { '/a.yaml': specYaml('X', 'SELECT * FROM dbo.secreta') } })
    expect(d.discover()).toHaveLength(1)
  })
})

describe('discovery · canAccess / visibleFor', () => {
  const d = mk({ engine: 'clickhouse', specs: {} })

  it('canAccess: pública → true; sin política → false (deny)', () => {
    expect(d.canAccess('qw04.areas', {})).toBe(true)
    expect(d.canAccess('inexistente', {})).toBe(false)
  })

  it('canAccess gobernada: true solo si la identidad trae el claim del predicado', () => {
    const conClaim: ClaimSet = { groups: ['ventas'] }
    expect(d.canAccess('dbo.saldos', conClaim)).toBe(true)
    expect(d.canAccess('dbo.saldos', {})).toBe(false)
  })

  it('visibleFor: PI sin datos gobernados es visible; con datos, filtra por acceso', () => {
    const reports = [
      { code: 'A', slug: 'a', name: 'A', specPath: '/a', tables: [] },
      { code: 'B', slug: 'b', name: 'B', specPath: '/b', tables: ['dbo.saldos'] },
    ]
    expect(d.visibleFor(reports, {}).map((r) => r.code)).toEqual(['A'])
    expect(d.visibleFor(reports, { groups: ['ventas'] }).map((r) => r.code)).toEqual(['A', 'B'])
  })
})
