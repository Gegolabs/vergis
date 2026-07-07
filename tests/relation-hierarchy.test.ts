// Suite del VOCABULARIO DE RELACIONES · Nivel-2 jerárquico (charter §4) — `descendant_of` sobre una
// jerarquía de referencia ARBITRARIA. Para subrayar que el criterio NO es organigrama ni área, la
// jerarquía del ejemplo es GEOGRÁFICA (World > LATAM > Chile/Perú · World > EU > España). El motor
// solo "recorre el árbol que la política apunta": el mismo mecanismo sirve productos, cuentas, geo, etc.
//
// Oráculo = evaluador de referencia del IR (con datos de cierre); SUT = codegen ClickHouse/Fabric +
// sus emuladores. La equivalencia cross-engine prueba la portabilidad (doc 9 §7) para Nivel-2.

import { describe, expect, it } from 'vitest'
import { VergisError } from '@vergis/botler'
import {
  applyPolicy,
  bindPolicy,
  compileClickHouse,
  compileFabric,
  emulate,
  emulateFabric,
  isHierarchy,
  parseAudience,
  requestSettings,
  resolveEntityStore,
  settingsForInjections,
  type Policy,
  type ReferenceData,
} from '@vergis/policy'

// --- Jerarquía de referencia GENÉRICA (geográfica): cierre reflexivo-transitivo ----
// World ⊃ {LATAM ⊃ {Chile, Perú}, EU ⊃ {España}}
const GEO_CLOSURE = [
  ['World', 'World'], ['World', 'LATAM'], ['World', 'EU'], ['World', 'Chile'], ['World', 'Perú'], ['World', 'España'],
  ['LATAM', 'LATAM'], ['LATAM', 'Chile'], ['LATAM', 'Perú'],
  ['EU', 'EU'], ['EU', 'España'],
  ['Chile', 'Chile'], ['Perú', 'Perú'], ['España', 'España'],
].map(([ancestor, descendant]) => ({ ancestor, descendant }))
const REFS: ReferenceData = { 'ref.geo_closure': GEO_CLOSURE }

type Row = { region: string; ventas: number }
const STORE: Row[] = [
  { region: 'Chile', ventas: 100 }, { region: 'Perú', ventas: 80 },
  { region: 'España', ventas: 60 }, { region: 'LATAM', ventas: 5 }, { region: 'EU', ventas: 4 },
]

const HIER_AUDIENCE = { rls: [{ relation: 'descendant_of', column: 'region', claim: 'geo', via: 'ref.geo_closure' }] }
const CH_TARGET = { database: 'sales', table: 'ventas', role: 'consumer_role' }
const FAB_TARGET = { schema: 'dbo', table: 'ventas' }

function servedCh(claims: Record<string, string[]>): Row[] {
  const enf = compileClickHouse(parseAudience(HIER_AUDIENCE), CH_TARGET)!
  const settings = requestSettings(enf, claims)
  return STORE.filter((r) => emulate(enf, settings, r as unknown as Record<string, unknown>, REFS))
}
function servedFab(claims: Record<string, string[]>): Row[] {
  const enf = compileFabric(parseAudience(HIER_AUDIENCE), FAB_TARGET)!
  const settings = settingsForInjections(enf.injections, claims)
  return STORE.filter((r) => emulateFabric(enf, settings, r as unknown as Record<string, unknown>, REFS))
}

describe('Vocabulario · front-end (relación jerárquica → IR)', () => {
  it('parsea descendant_of a un HierarchyPredicate con defaults ancestor/descendant', () => {
    const p = parseAudience(HIER_AUDIENCE) as Policy
    expect(p.predicates).toHaveLength(1)
    const pred = p.predicates[0]
    expect(isHierarchy(pred)).toBe(true)
    expect(pred).toEqual({ kind: 'hierarchy', rel: 'descendant_of', column: 'region', claim: 'geo', via: 'ref.geo_closure', ancestor: 'ancestor', descendant: 'descendant' })
  })
  it('subordinate_of es alias de descendant_of (charter §4)', () => {
    const p = parseAudience({ rls: [{ relation: 'subordinate_of', column: 'n', claim: 'c', via: 'h' }] }) as Policy
    expect(isHierarchy(p.predicates[0]) && (p.predicates[0] as { rel: string }).rel).toBe('descendant_of')
  })
  it('rechaza relación fuera del vocabulario y via ausente', () => {
    expect(() => parseAudience({ rls: [{ relation: 'cousin_of', column: 'n', claim: 'c', via: 'h' }] })).toThrow(/vocabulario|relation/i)
    expect(() => parseAudience({ rls: [{ relation: 'descendant_of', column: 'n', claim: 'c' }] })).toThrow(/via/i)
  })
  it('binder rechaza una jerarquía de referencia inexistente', () => {
    const p = parseAudience(HIER_AUDIENCE)
    expect(() => bindPolicy(p, { columns: ['region'], claims: ['geo'], references: ['ref.otra'] })).toThrow(/jerarquía|reference|via/i)
    expect(() => bindPolicy(p, { columns: ['region'], claims: ['geo'], references: ['ref.geo_closure'] })).not.toThrow()
  })
})

describe('Vocabulario · codegen Nivel-2 (subquery al cierre)', () => {
  it('ClickHouse → ROW POLICY con subquery al cierre', () => {
    const enf = compileClickHouse(parseAudience(HIER_AUDIENCE), CH_TARGET)!
    expect(enf.rowPolicySQL).toContain(
      `region IN (SELECT descendant FROM ref.geo_closure WHERE has(splitByChar(',', getSetting('vergis_claim_geo')), ancestor))`,
    )
    expect(enf.injections).toEqual([{ setting: 'vergis_claim_geo', claim: 'geo' }])
  })
  it('Fabric → predicado TVF con subquery al cierre (via schema-calificada)', () => {
    const enf = compileFabric(parseAudience(HIER_AUDIENCE), FAB_TARGET)!
    const fn = enf.setupSQL[2]
    expect(fn).toContain(`@region COLLATE Latin1_General_100_BIN2 IN (SELECT descendant FROM [ref].[geo_closure] WHERE ancestor COLLATE Latin1_General_100_BIN2 IN (SELECT value FROM STRING_SPLIT(`)
    expect(fn).toContain(`WITH SCHEMABINDING`)
  })
})

describe('Vocabulario · comportamiento jerárquico (el viewer ve su subárbol)', () => {
  it('viewer en LATAM ve LATAM + Chile + Perú, NO EU/España', () => {
    const r = servedCh({ geo: ['LATAM'] }).map((x) => x.region).sort()
    expect(r).toEqual(['Chile', 'LATAM', 'Perú'])
  })
  it('viewer en World ve todo; viewer en España ve solo España (hoja)', () => {
    expect(servedCh({ geo: ['World'] })).toHaveLength(5)
    expect(servedCh({ geo: ['España'] }).map((x) => x.region)).toEqual(['España'])
  })
  it('sin nodo del viewer → 0 filas (default-deny); nodo inexistente → 0', () => {
    expect(servedCh({})).toHaveLength(0)
    expect(servedCh({ geo: [] })).toHaveLength(0)
    expect(servedCh({ geo: ['Marte'] })).toHaveLength(0)
  })
  it('multi-nodo {LATAM, EU} ve ambos subárboles', () => {
    expect(servedCh({ geo: ['LATAM', 'EU'] }).map((x) => x.region).sort()).toEqual(['Chile', 'EU', 'España', 'LATAM', 'Perú'])
  })
  it('injection-safe — payload SQL como nodo ⟹ 0 filas; el SQL no interpola el valor', () => {
    expect(servedCh({ geo: [`Chile'; DROP TABLE ventas; --`] })).toHaveLength(0)
    const enf = compileClickHouse(parseAudience(HIER_AUDIENCE), CH_TARGET)!
    expect(enf.rowPolicySQL).not.toContain('DROP TABLE')
  })
  it('Fabric coincide con ClickHouse para los mismos casos', () => {
    const casos: Record<string, string[]>[] = [{ geo: ['LATAM'] }, { geo: ['World'] }, { geo: ['España'] }, {}, { geo: ['LATAM', 'EU'] }]
    for (const claims of casos) {
      expect(servedFab(claims).map((x) => x.region).sort()).toEqual(servedCh(claims).map((x) => x.region).sort())
    }
  })
})

describe('Vocabulario · prueba de aceptación (charter §4) — "ves tu subárbol, no el resto"', () => {
  it('un gerente regional en LATAM ve las ventas de LATAM y debajo, jamás de EU', () => {
    const visto = servedCh({ geo: ['LATAM'] })
    expect(visto.every((r) => ['LATAM', 'Chile', 'Perú'].includes(r.region))).toBe(true)
    expect(visto.some((r) => r.region === 'España' || r.region === 'EU')).toBe(false)
    // y el agregado: suma SOLo su subárbol, no se cuela el total global
    const suma = visto.reduce((a, r) => a + r.ventas, 0)
    expect(suma).toBe(100 + 80 + 5) // Chile + Perú + LATAM
    expect(suma).not.toBe(STORE.reduce((a, r) => a + r.ventas, 0))
  })
})

describe('Vocabulario · property test Nivel-2 (Fabric ≡ referencia ≡ ClickHouse)', () => {
  function lcg(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000) }
  const NODES = ['World', 'LATAM', 'EU', 'Chile', 'Perú', 'España', 'Marte']
  it('∀ rows, viewer aleatorios: filas(Fabric) == referencia == filas(ClickHouse)', () => {
    const rnd = lcg(20260601)
    const pol = parseAudience(HIER_AUDIENCE)
    const chEnf = compileClickHouse(pol, CH_TARGET)!
    const fabEnf = compileFabric(pol, FAB_TARGET)!
    for (let i = 0; i < 500; i += 1) {
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ({ region: NODES[Math.floor(rnd() * NODES.length)] })) as unknown as Record<string, unknown>[]
      const claims: Record<string, string[]> = {}
      if (rnd() < 0.85) claims.geo = NODES.filter(() => rnd() < 0.4)
      const ch = rows.filter((r) => emulate(chEnf, requestSettings(chEnf, claims), r, REFS))
      const fab = rows.filter((r) => emulateFabric(fabEnf, settingsForInjections(fabEnf.injections, claims), r, REFS))
      const ref = applyPolicy(pol, claims, rows, REFS)
      expect(ch).toEqual(ref)
      expect(fab).toEqual(ref)
    }
  })
})

describe('Vocabulario · gobierno relacional por entidad (entity store Nivel-2)', () => {
  it('una entidad gobernada por descendant_of resuelve a HierarchyPredicate por dataset', () => {
    const m = resolveEntityStore({
      entities: [{ entity: 'venta', governed_by: [{ dimension: 'region', claim: 'geo', relation: 'descendant_of', via: 'ref.geo_closure' }] }],
      datasets: [
        { dataset: 'sales.ventas', realizes: 'venta', dimensions: { region: 'region' } },
        { dataset: 'dbo.fct_ventas', realizes: 'venta', dimensions: { region: 'region_code' } }, // otra realización, otra columna
      ],
    })
    const p1 = (m.get('sales.ventas') as Policy).predicates[0]
    expect(p1).toEqual({ kind: 'hierarchy', rel: 'descendant_of', column: 'region', claim: 'geo', via: 'ref.geo_closure', ancestor: 'ancestor', descendant: 'descendant' })
    // misma entidad/criterio, distinta columna física
    expect((m.get('dbo.fct_ventas') as Policy).predicates[0]).toMatchObject({ kind: 'hierarchy', column: 'region_code', via: 'ref.geo_closure' })
  })
  it('relación inválida o via ausente en el gobierno → fail-closed', () => {
    expect(() => resolveEntityStore({ entities: [{ entity: 'e', governed_by: [{ dimension: 'd', claim: 'c', relation: 'descendant_of' }] }], datasets: [{ dataset: 'x', realizes: 'e', dimensions: { d: 'col' } }] })).toThrow(/via/i)
    expect(() => resolveEntityStore({ entities: [{ entity: 'e', governed_by: [{ dimension: 'd', claim: 'c', relation: 'sibling_of', via: 'h' }] }], datasets: [{ dataset: 'x', realizes: 'e', dimensions: { d: 'col' } }] })).toThrow(VergisError)
  })
})
