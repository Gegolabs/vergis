// Suite de no-fuga del compilador de policy (doc 10 §9) — reusa el ARNÉS de la Fase 0
// (las 8 propiedades RLS del PoC ClickHouse) como invariantes property-testeadas del
// codegen. El oráculo es el evaluador de referencia del IR; el SUT es el codegen
// ClickHouse + su emulador semántico.

import { describe, expect, it } from 'vitest'
import { VergisError } from '@vergis/botler'
import {
  applyPolicy,
  bindPolicy,
  compileClickHouse,
  compileFabric,
  compilePolicyToClickHouse,
  compilePolicyToFabric,
  emulate,
  emulateFabric,
  evalPolicy,
  isPublic,
  parseAudience,
  requestSettings,
  sessionContextPrelude,
  settingForClaim,
  settingsForInjections,
  type ClaimSet,
  type Policy,
  type PolicyDecl,
} from '@vergis/policy'

// --- store sintético idéntico al PoC de Fase 0 (4 áreas × 3 snapshots) -------
type Row = { area: string; present: number }
const STORE: Row[] = [
  { area: 'Producción', present: 100 }, { area: 'Producción', present: 104 }, { area: 'Producción', present: 110 },
  { area: 'Finanzas', present: 36 }, { area: 'Finanzas', present: 38 }, { area: 'Finanzas', present: 39 },
  { area: 'Comercial', present: 50 }, { area: 'Comercial', present: 55 }, { area: 'Comercial', present: 58 },
  { area: 'RRHH', present: 22 }, { area: 'RRHH', present: 24 }, { area: 'RRHH', present: 25 },
]
const sum = (rows: Row[]) => rows.reduce((a, r) => a + r.present, 0)
const TARGET = { database: 'vergis', table: 'areas', role: 'consumer_role' }
const BIND = { columns: ['area', 'present'], claims: ['groups'] }
const QW04_AUDIENCE = { rls: [{ column: 'area', claim: 'groups', op: 'in' }], default: 'deny' }

/** Filtra el store como lo haría ClickHouse: compila → inyecta claims → emula la policy. */
function served(policy: PolicyDecl, claims: ClaimSet, rows: Row[] = STORE): Row[] {
  const enf = compileClickHouse(policy, TARGET)
  if (!enf) return rows // público
  const settings = requestSettings(enf, claims)
  return rows.filter((r) => emulate(enf, settings, r as unknown as Record<string, unknown>))
}

// --- target Fabric (motor C, push-down) --------------------------------------
const FAB_TARGET = { schema: 'dbo', table: 'areas' }

/** Filtra el store como lo haría Fabric: compila → settings request-scoped → emula la policy T-SQL. */
function servedFabric(policy: PolicyDecl, claims: ClaimSet, rows: Row[] = STORE): Row[] {
  const enf = compileFabric(policy, FAB_TARGET)
  if (!enf) return rows // público
  const settings = settingsForInjections(enf.injections, claims)
  return rows.filter((r) => emulateFabric(enf, settings, r as unknown as Record<string, unknown>))
}

describe('Compilador de policy · front-end (audience → IR)', () => {
  it('parsea la declaración de QW-04 a un IR con default-deny', () => {
    const p = parseAudience(QW04_AUDIENCE) as Policy
    expect(isPublic(p)).toBe(false)
    expect(p.predicates).toEqual([{ column: 'area', claim: 'groups', op: 'in' }])
    expect(p.combine).toBe('and')
    expect(p.default).toBe('deny')
  })
  it('ausencia de audience / rls → public; rls: public → public', () => {
    expect(isPublic(parseAudience(undefined))).toBe(true)
    expect(isPublic(parseAudience({}))).toBe(true)
    expect(isPublic(parseAudience({ rls: 'public' }))).toBe(true)
  })
  it('rechaza malformados con VergisError accionable', () => {
    expect(() => parseAudience({ rls: 'cualquier_cosa' })).toThrow(VergisError)
    expect(() => parseAudience({ rls: [{ claim: 'groups', op: 'in' }] })).toThrow(/column/)
    expect(() => parseAudience({ rls: [{ column: 'area', op: 'in' }] })).toThrow(/claim/)
    expect(() => parseAudience({ rls: [{ column: 'area', claim: 'groups', op: 'between' }] })).toThrow(/op/)
    // default no puede abrir por omisión
    expect(() => parseAudience({ rls: [{ column: 'area', claim: 'groups', op: 'in' }], default: 'allow' })).toThrow(/deny/)
  })
})

describe('Compilador de policy · binder', () => {
  it('rechaza columna inexistente y claim no entregado por el gate', () => {
    const p = parseAudience({ rls: [{ column: 'inexistente', claim: 'groups', op: 'in' }] })
    expect(() => bindPolicy(p, BIND)).toThrow(/unknown|inexistente/i)
    const p2 = parseAudience({ rls: [{ column: 'area', claim: 'fantasma', op: 'in' }] })
    expect(() => bindPolicy(p2, BIND)).toThrow(/claim/i)
  })
})

describe('Compilador de policy · codegen ClickHouse (la receta de Fase 0)', () => {
  it('QW-04 → CREATE ROW POLICY exacto (mecanismo getSetting/splitByChar/has)', () => {
    const enf = compilePolicyToClickHouse(QW04_AUDIENCE, TARGET, BIND)!
    expect(enf.rowPolicySQL).toBe(
      `CREATE ROW POLICY pol_areas ON vergis.areas\n` +
        `    FOR SELECT\n` +
        `    USING (getSetting('vergis_claim_groups') != '' AND has(splitByChar(',', getSetting('vergis_claim_groups')), area))\n` +
        `    AS permissive\n` +
        `    TO consumer_role;`,
    )
    expect(enf.injections).toEqual([{ setting: 'vergis_claim_groups', claim: 'groups' }])
  })
  it('PI público → no genera policy (null)', () => {
    expect(compilePolicyToClickHouse({ rls: 'public' }, TARGET, BIND)).toBeNull()
  })
  it('codegen rechaza identificadores inseguros (anti-inyección por nombre)', () => {
    const evil = parseAudience({ rls: [{ column: 'area; DROP TABLE x', claim: 'groups', op: 'in' }] })
    expect(() => compileClickHouse(evil, TARGET)).toThrow(/identificador|unsafe/i)
  })
})

// === LAS 8 PROPIEDADES (el arnés de Fase 0, sobre el codegen) =================
describe('Compilador de policy · las 8 propiedades RLS (arnés de Fase 0)', () => {
  const pol = parseAudience(QW04_AUDIENCE)

  it('1 · Filtrado — claim=Producción ⟹ solo Producción', () => {
    const r = served(pol, { groups: ['Producción'] })
    expect([...new Set(r.map((x) => x.area))]).toEqual(['Producción'])
    expect(r).toHaveLength(3)
  })
  it('2 · Multi-segmento — {Producción,Finanzas} ⟹ exactamente esas dos', () => {
    const r = served(pol, { groups: ['Producción', 'Finanzas'] })
    expect([...new Set(r.map((x) => x.area))].sort()).toEqual(['Finanzas', 'Producción'])
    expect(r).toHaveLength(6)
  })
  it('3 · Default-deny — sin claim / vacío / desconocido ⟹ 0 filas', () => {
    expect(served(pol, {})).toHaveLength(0)
    expect(served(pol, { groups: [] })).toHaveLength(0)
    expect(served(pol, { groups: [''] })).toHaveLength(0)
    expect(served(pol, { groups: ['Inexistente'] })).toHaveLength(0)
  })
  it('4 · Integridad de agregados — SUM en la vista == subconjunto, no se cuela al total', () => {
    const view = served(pol, { groups: ['Producción', 'Finanzas'] })
    const subset = STORE.filter((r) => ['Producción', 'Finanzas'].includes(r.area))
    expect(sum(view)).toBe(sum(subset))
    expect(sum(view)).not.toBe(sum(STORE)) // 427 ≠ 661
  })
  it('5 · Inyección — cambiar el claim cambia el resultado (canal vivo)', () => {
    expect(served(pol, { groups: ['Comercial'] }).map((x) => x.area)).toEqual(['Comercial', 'Comercial', 'Comercial'])
    expect(served(pol, { groups: ['Producción'] })).not.toEqual(served(pol, { groups: ['Comercial'] }))
  })
  it('6 · Injection-safe — payload SQL como claim ⟹ 0 filas; el SQL no interpola valores', () => {
    expect(served(pol, { groups: [`Producción'; DROP TABLE areas; --`] })).toHaveLength(0)
    const enf = compileClickHouse(pol, TARGET)!
    // el valor del claim NUNCA aparece en el SQL: solo el NOMBRE del setting (getSetting)
    expect(enf.rowPolicySQL).toContain(`getSetting('vergis_claim_groups')`)
    expect(enf.rowPolicySQL).not.toContain('DROP')
  })
  it('7 · Pooling-safe — requestSettings es función pura; A no contamina a B', () => {
    const enf = compileClickHouse(pol, TARGET)!
    const a = requestSettings(enf, { groups: ['Producción'] })
    const b = requestSettings(enf, { groups: ['Finanzas'] })
    expect(a).toEqual({ vergis_claim_groups: 'Producción' })
    expect(b).toEqual({ vergis_claim_groups: 'Finanzas' }) // sin rastro de A
    // un valor con coma se rechaza (rompería el encoding)
    expect(() => requestSettings(enf, { groups: ['a,b'] })).toThrow(/coma|comma/i)
  })
  it('8 · Only-path — la policy es permissive, FOR SELECT y scoped al rol del consumidor', () => {
    const enf = compileClickHouse(pol, TARGET)!
    expect(enf.rowPolicySQL).toContain('AS permissive')
    expect(enf.rowPolicySQL).toContain('FOR SELECT')
    expect(enf.rowPolicySQL).toContain('TO consumer_role')
  })
})

// === PROPERTY TEST: codegen ≡ evaluador de referencia (doc 10 §9 #1–#2) =======
describe('Compilador de policy · property test (codegen ≡ IR de referencia)', () => {
  // PRNG seeded (reproducible): LCG.
  function lcg(seed: number) {
    let s = seed >>> 0
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000)
  }
  const AREAS = ['Producción', 'Finanzas', 'Comercial', 'RRHH', 'Calidad', 'TI']
  const REGIONS = ['Norte', 'Centro', 'Sur']
  const pick = <T,>(rnd: () => number, xs: T[]) => xs[Math.floor(rnd() * xs.length)]
  const subset = <T,>(rnd: () => number, xs: T[]) => xs.filter(() => rnd() < 0.5)

  it('∀ store, policy, claims aleatorios: filas(codegen) == filas(referencia)', () => {
    const rnd = lcg(20260530)
    for (let iter = 0; iter < 800; iter += 1) {
      // store aleatorio (dos columnas para ejercitar AND/OR y eq/in)
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => ({
        area: pick(rnd, AREAS),
        region: pick(rnd, REGIONS),
        present: Math.floor(rnd() * 100),
      })) as unknown as Record<string, unknown>[]

      // policy aleatoria: 1–2 predicados, op in/eq, combine and/or
      const nPred = 1 + (rnd() < 0.5 ? 0 : 1)
      const predicates = Array.from({ length: nPred }, () => {
        const useArea = rnd() < 0.5
        return {
          column: useArea ? 'area' : 'region',
          claim: useArea ? 'groups' : 'regions',
          op: (rnd() < 0.5 ? 'in' : 'eq') as 'in' | 'eq',
        }
      })
      const policy: Policy = { predicates, combine: rnd() < 0.5 ? 'and' : 'or', default: 'deny' }

      // claims aleatorios (a veces ausentes → default-deny)
      const claims: ClaimSet = {}
      if (rnd() < 0.85) claims.groups = subset(rnd, AREAS)
      if (rnd() < 0.85) claims.regions = subset(rnd, REGIONS)

      const enf = compileClickHouse(policy, TARGET)!
      const settings = requestSettings(enf, claims)
      const fromCodegen = rows.filter((r) => emulate(enf, settings, r))
      const fromReference = applyPolicy(policy, claims, rows)
      expect(fromCodegen).toEqual(fromReference)
    }
  })
})

// ===========================================================================
// === BACK-END FABRIC (motor C, push-down) — mismo front-end/IR/binder ======
// ===========================================================================

describe('Compilador de policy · codegen Fabric (predicado TVF + SECURITY POLICY)', () => {
  it('QW-04 → CREATE FUNCTION + CREATE SECURITY POLICY exactos (SESSION_CONTEXT/STRING_SPLIT)', () => {
    const enf = compilePolicyToFabric(QW04_AUDIENCE, FAB_TARGET, BIND)!
    // setupSQL idempotente: DROP policy → DROP function → CREATE function → CREATE policy.
    expect(enf.setupSQL).toEqual([
      `DROP SECURITY POLICY IF EXISTS [dbo].[secpol_areas];`,
      `DROP FUNCTION IF EXISTS [dbo].[fn_pol_areas];`,
      `CREATE FUNCTION [dbo].[fn_pol_areas](@area NVARCHAR(4000))\n` +
        `    RETURNS TABLE\n` +
        `    WITH SCHEMABINDING\n` +
        `    AS RETURN\n` +
        `        SELECT 1 AS vergis_allowed\n` +
        `        WHERE (CAST(SESSION_CONTEXT(N'vergis_claim_groups') AS NVARCHAR(MAX)) <> N'' AND @area IN (SELECT value FROM STRING_SPLIT(CAST(SESSION_CONTEXT(N'vergis_claim_groups') AS NVARCHAR(MAX)), N',')));`,
      `CREATE SECURITY POLICY [dbo].[secpol_areas]\n` +
        `    ADD FILTER PREDICATE [dbo].[fn_pol_areas](area) ON [dbo].[areas]\n` +
        `    WITH (STATE = ON);`,
    ])
    expect(enf.teardownSQL).toEqual([
      `DROP SECURITY POLICY IF EXISTS [dbo].[secpol_areas];`,
      `DROP FUNCTION IF EXISTS [dbo].[fn_pol_areas];`,
    ])
    expect(enf.injections).toEqual([{ setting: 'vergis_claim_groups', claim: 'groups' }])
  })
  it('PI público → no genera policy (null)', () => {
    expect(compilePolicyToFabric({ rls: 'public' }, FAB_TARGET, BIND)).toBeNull()
  })
  it('schema default dbo; override de schema/nombres respetado', () => {
    const enf = compileFabric(parseAudience(QW04_AUDIENCE), {
      schema: 'lh',
      table: 'fct_asistencia_dia',
      functionName: 'fn_rls_asis',
      policyName: 'pol_asis',
    })!
    expect(enf.setupSQL[0]).toBe(`DROP SECURITY POLICY IF EXISTS [lh].[pol_asis];`)
    expect(enf.setupSQL[3]).toContain(`CREATE SECURITY POLICY [lh].[pol_asis]`)
    expect(enf.setupSQL[3]).toContain(`ON [lh].[fct_asistencia_dia]`)
    expect(enf.setupSQL[2]).toContain(`[lh].[fn_rls_asis](@area NVARCHAR(4000))`)
  })
  it('eq → comparación escalar; combine or → OR entre cláusulas', () => {
    const pol = parseAudience({
      rls: [
        { column: 'area', claim: 'groups', op: 'in' },
        { column: 'region', claim: 'regions', op: 'eq' },
      ],
      combine: 'or',
    })
    const fn = compileFabric(pol, FAB_TARGET)!.setupSQL[2]
    expect(fn).toContain(`@area IN (SELECT value FROM STRING_SPLIT(`)
    expect(fn).toContain(`@region = CAST(SESSION_CONTEXT(N'vergis_claim_regions') AS NVARCHAR(MAX))`)
    expect(fn).toContain(`) OR (`) // combine or
    expect(fn).toContain(`(@area NVARCHAR(4000), @region NVARCHAR(4000))`) // ambos params
  })
  it('codegen rechaza identificadores inseguros (anti-inyección por nombre)', () => {
    const evil = parseAudience({ rls: [{ column: 'area; DROP TABLE x', claim: 'groups', op: 'in' }] })
    expect(() => compileFabric(evil, FAB_TARGET)).toThrow(/identificador|unsafe/i)
    expect(() => compileFabric(parseAudience(QW04_AUDIENCE), { table: 'areas', schema: 'dbo;--' })).toThrow(/identificador|unsafe/i)
    expect(() =>
      compileFabric(parseAudience(QW04_AUDIENCE), { table: 'areas', columnTypes: { area: 'NVARCHAR(4000)); DROP' } }),
    ).toThrow(/tipo|type|unsafe/i)
  })
})

// === LAS 8 PROPIEDADES (el arnés de Fase 0, sobre el codegen Fabric) ==========
describe('Compilador de policy · las 8 propiedades RLS (arnés, back-end Fabric)', () => {
  const pol = parseAudience(QW04_AUDIENCE)

  it('1 · Filtrado — claim=Producción ⟹ solo Producción', () => {
    const r = servedFabric(pol, { groups: ['Producción'] })
    expect([...new Set(r.map((x) => x.area))]).toEqual(['Producción'])
    expect(r).toHaveLength(3)
  })
  it('2 · Multi-segmento — {Producción,Finanzas} ⟹ exactamente esas dos', () => {
    const r = servedFabric(pol, { groups: ['Producción', 'Finanzas'] })
    expect([...new Set(r.map((x) => x.area))].sort()).toEqual(['Finanzas', 'Producción'])
    expect(r).toHaveLength(6)
  })
  it('3 · Default-deny — sin claim / vacío / desconocido ⟹ 0 filas', () => {
    expect(servedFabric(pol, {})).toHaveLength(0)
    expect(servedFabric(pol, { groups: [] })).toHaveLength(0)
    expect(servedFabric(pol, { groups: [''] })).toHaveLength(0)
    expect(servedFabric(pol, { groups: ['Inexistente'] })).toHaveLength(0)
  })
  it('4 · Integridad de agregados — SUM en la vista == subconjunto, no se cuela al total', () => {
    const view = servedFabric(pol, { groups: ['Producción', 'Finanzas'] })
    const subset = STORE.filter((r) => ['Producción', 'Finanzas'].includes(r.area))
    expect(sum(view)).toBe(sum(subset))
    expect(sum(view)).not.toBe(sum(STORE))
  })
  it('5 · Inyección — cambiar el claim cambia el resultado', () => {
    expect(servedFabric(pol, { groups: ['Comercial'] }).map((x) => x.area)).toEqual(['Comercial', 'Comercial', 'Comercial'])
    expect(servedFabric(pol, { groups: ['Producción'] })).not.toEqual(servedFabric(pol, { groups: ['Comercial'] }))
  })
  it('6 · Injection-safe — payload SQL como claim ⟹ 0 filas; el SQL no interpola valores', () => {
    expect(servedFabric(pol, { groups: [`Producción'; DROP TABLE areas; --`] })).toHaveLength(0)
    const enf = compileFabric(pol, FAB_TARGET)!
    // el valor del claim NUNCA aparece en el DDL: solo el NOMBRE del setting (SESSION_CONTEXT)
    expect(enf.setupSQL[2]).toContain(`SESSION_CONTEXT(N'vergis_claim_groups')`)
    expect(enf.setupSQL.join('\n')).not.toContain('DROP TABLE')
  })
  it('7 · Pooling-safe — el prelude se REINYECTA completo por request; A no contamina a B', () => {
    const enf = compileFabric(pol, FAB_TARGET)!
    const a = sessionContextPrelude(enf.injections, { groups: ['Producción'] })
    const b = sessionContextPrelude(enf.injections, { groups: ['Finanzas'] })
    expect(a.params).toEqual([{ name: 'vergis_sc_0', value: 'Producción' }])
    expect(b.params).toEqual([{ name: 'vergis_sc_0', value: 'Finanzas' }]) // sin rastro de A
    // un valor con coma se rechaza (rompería el encoding)
    expect(() => sessionContextPrelude(enf.injections, { groups: ['a,b'] })).toThrow(/coma|comma/i)
  })
  it('8 · Only-path — SECURITY POLICY con FILTER PREDICATE, STATE ON, sobre la tabla', () => {
    const enf = compileFabric(pol, FAB_TARGET)!
    const ddl = enf.setupSQL.join('\n')
    expect(ddl).toContain('ADD FILTER PREDICATE')
    expect(ddl).toContain('WITH (STATE = ON)')
    expect(ddl).toContain('ON [dbo].[areas]')
    expect(enf.setupSQL[2]).toContain('WITH SCHEMABINDING') // el predicado no puede esquivarse vía vistas
  })
})

// === SEGURIDAD: la nuance del SESSION_CONTEXT en el pool (doc 10 §5) ==========
describe('Compilador de policy · Fabric · prelude reinyecta TODO (no-fuga en el pool)', () => {
  const pol = parseAudience({
    rls: [
      { column: 'area', claim: 'groups', op: 'in' },
      { column: 'region', claim: 'regions', op: 'eq' },
    ],
  })
  const enf = compileFabric(pol, { schema: 'dbo', table: 'areas', columnTypes: { area: 'NVARCHAR(4000)', region: 'NVARCHAR(50)' } })!

  it('emite UN sp_set_session_context por inyección, incl. la del claim ausente (con \'\')', () => {
    // solo viene `groups`; `regions` ausente debe setearse igual con '' → reset + default-deny
    const prelude = sessionContextPrelude(enf.injections, { groups: ['Finanzas'] })
    expect(prelude.params).toEqual([
      { name: 'vergis_sc_0', value: 'Finanzas' },
      { name: 'vergis_sc_1', value: '' }, // regions ausente → '' (sobreescribe residuo, dispara guard)
    ])
    expect(prelude.sql).toBe(
      `EXEC sys.sp_set_session_context @key = N'vergis_claim_groups', @value = @vergis_sc_0;\n` +
        `EXEC sys.sp_set_session_context @key = N'vergis_claim_regions', @value = @vergis_sc_1;`,
    )
  })
  it('el VALOR del claim va parametrizado, nunca en el texto del prelude (injection-safe)', () => {
    const prelude = sessionContextPrelude(enf.injections, { groups: [`x'; DROP TABLE y; --`] })
    expect(prelude.sql).not.toContain('DROP TABLE')
    expect(prelude.params[0].value).toBe(`x'; DROP TABLE y; --`) // el payload queda en el binding, inerte
  })
})

// === PROPERTY TEST: codegen Fabric ≡ referencia ≡ codegen ClickHouse ==========
describe('Compilador de policy · property test (Fabric ≡ IR de referencia ≡ ClickHouse)', () => {
  function lcg(seed: number) {
    let s = seed >>> 0
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000)
  }
  const AREAS = ['Producción', 'Finanzas', 'Comercial', 'RRHH', 'Calidad', 'TI']
  const REGIONS = ['Norte', 'Centro', 'Sur']
  const pick = <T,>(rnd: () => number, xs: T[]) => xs[Math.floor(rnd() * xs.length)]
  const subset = <T,>(rnd: () => number, xs: T[]) => xs.filter(() => rnd() < 0.5)

  it('∀ store, policy, claims aleatorios: filas(Fabric) == filas(referencia) == filas(ClickHouse)', () => {
    const rnd = lcg(20260601)
    for (let iter = 0; iter < 800; iter += 1) {
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => ({
        area: pick(rnd, AREAS),
        region: pick(rnd, REGIONS),
        present: Math.floor(rnd() * 100),
      })) as unknown as Record<string, unknown>[]

      const nPred = 1 + (rnd() < 0.5 ? 0 : 1)
      const predicates = Array.from({ length: nPred }, () => {
        const useArea = rnd() < 0.5
        return {
          column: useArea ? 'area' : 'region',
          claim: useArea ? 'groups' : 'regions',
          op: (rnd() < 0.5 ? 'in' : 'eq') as 'in' | 'eq',
        }
      })
      const policy: Policy = { predicates, combine: rnd() < 0.5 ? 'and' : 'or', default: 'deny' }

      const claims: ClaimSet = {}
      if (rnd() < 0.85) claims.groups = subset(rnd, AREAS)
      if (rnd() < 0.85) claims.regions = subset(rnd, REGIONS)

      const fabEnf = compileFabric(policy, FAB_TARGET)!
      const fabSettings = settingsForInjections(fabEnf.injections, claims)
      const fromFabric = rows.filter((r) => emulateFabric(fabEnf, fabSettings, r))

      const chEnf = compileClickHouse(policy, TARGET)!
      const fromClickHouse = rows.filter((r) => emulate(chEnf, requestSettings(chEnf, claims), r))

      const fromReference = applyPolicy(policy, claims, rows)
      expect(fromFabric).toEqual(fromReference) // codegen Fabric ≡ oráculo
      expect(fromFabric).toEqual(fromClickHouse) // portabilidad: ambos motores coinciden (doc 9 §7)
    }
  })
})
