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
    expect(p.predicates).toEqual([{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }])
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
      `CREATE ROW POLICY OR REPLACE pol_areas ON vergis.areas\n` +
        `    FOR SELECT\n` +
        `    USING (getSetting('vergis_claim_groups') != '' AND has(splitByChar(',', getSetting('vergis_claim_groups')), area))\n` +
        `    AS permissive\n` +
        `    TO consumer_role;`,
    )
    expect(enf.injections).toEqual([{ setting: 'vergis_claim_groups', claim: 'groups' }])
  })
  it('PI público (grant: all) → ROW POLICY allow-all (USING 1), no null', () => {
    const enf = compilePolicyToClickHouse({ rls: 'public' }, TARGET, BIND)
    expect(enf.rowPolicySQL).toContain('USING 1')
    expect(enf.injections).toEqual([])
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
          kind: 'membership' as const,
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
        `        WHERE (CAST(SESSION_CONTEXT(N'vergis_claim_groups') AS NVARCHAR(MAX)) <> N'' AND @area COLLATE Latin1_General_100_BIN2 IN (SELECT value FROM STRING_SPLIT(CAST(SESSION_CONTEXT(N'vergis_claim_groups') AS NVARCHAR(MAX)), N',')));`,
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
  it('transactional (opt-in, Ola 2·4) → envuelve setupSQL en SET XACT_ABORT ON + BEGIN/COMMIT; el default NO', () => {
    const plain = compileFabric(parseAudience(QW04_AUDIENCE), FAB_TARGET)!
    // Default: sin envoltura — sentencias sueltas (contrato clásico).
    expect(plain.setupSQL[0]).toBe(`DROP SECURITY POLICY IF EXISTS [dbo].[secpol_areas];`)
    expect(plain.setupSQL.join('\n')).not.toContain('BEGIN TRANSACTION')
    // Opt-in: DROP+CREATE atómico (cierra la ventana sin RLS entre el DROP y el CREATE).
    const tx = compileFabric(parseAudience(QW04_AUDIENCE), { ...FAB_TARGET, transactional: true })!
    expect(tx.setupSQL[0]).toBe('SET XACT_ABORT ON;\nBEGIN TRANSACTION;')
    expect(tx.setupSQL[tx.setupSQL.length - 1]).toBe('COMMIT;')
    // El DDL del medio es el mismo, solo desplazado un índice por el BEGIN.
    expect(tx.setupSQL[1]).toBe(`DROP SECURITY POLICY IF EXISTS [dbo].[secpol_areas];`)
    expect(tx.setupSQL[4]).toContain('CREATE SECURITY POLICY [dbo].[secpol_areas]')
    expect(tx.teardownSQL).toEqual(plain.teardownSQL) // teardown NO se envuelve
  })
  it('PI público (grant: all) → SECURITY POLICY allow-all (función sin WHERE), no null', () => {
    const enf = compilePolicyToFabric({ rls: 'public' }, { ...FAB_TARGET, bindColumn: 'area' }, BIND)
    const setup = enf.setupSQL.join('\n')
    expect(setup).toContain('SELECT 1 AS vergis_allowed;') // sin WHERE → allow-all
    expect(setup).not.toMatch(/SELECT 1 AS vergis_allowed\s*\n\s*WHERE/)
    expect(setup).toContain('WITH (STATE = ON)')
    expect(enf.injections).toEqual([])
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
    expect(fn).toContain(`@area COLLATE Latin1_General_100_BIN2 IN (SELECT value FROM STRING_SPLIT(`)
    expect(fn).toContain(`@region COLLATE Latin1_General_100_BIN2 = CAST(SESSION_CONTEXT(N'vergis_claim_regions') AS NVARCHAR(MAX))`)
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

describe('Guard de cardinalidad · op eq con claim multi-valor (no over-grant)', () => {
  const EQ = parseAudience({ rls: [{ column: 'region', claim: 'regions', op: 'eq' }] })
  const chEnf = compileClickHouse(EQ, TARGET)!
  const fabEnf = compileFabric(EQ, { table: 'areas' })!

  it('claim de UN valor: la celda igual pasa, la distinta no (ambos backends)', () => {
    const s = settingsForInjections(chEnf.injections, { regions: ['norte'] })
    expect(emulate(chEnf, s, { region: 'norte' })).toBe(true)
    expect(emulateFabric(fabEnf, s, { region: 'norte' })).toBe(true)
    expect(emulate(chEnf, s, { region: 'sur' })).toBe(false)
    expect(emulateFabric(fabEnf, s, { region: 'sur' })).toBe(false)
  })

  it('claim MULTI-valor: una celda con el valor unido por coma NO pasa (era over-grant)', () => {
    const s = settingsForInjections(chEnf.injections, { regions: ['a', 'b'] })
    expect(s['vergis_claim_regions']).toBe('a,b')
    expect(emulate(chEnf, s, { region: 'a,b' })).toBe(false)
    expect(emulateFabric(fabEnf, s, { region: 'a,b' })).toBe(false)
    // eq exige exactamente un valor permitido: un valor suelto tampoco pasa con claim multi-valor.
    expect(emulate(chEnf, s, { region: 'a' })).toBe(false)
  })

  it('el codegen emite el guard de coma (position / CHARINDEX)', () => {
    expect(chEnf.rowPolicySQL).toContain(`position(getSetting('vergis_claim_regions'), ',') = 0`)
    expect(fabEnf.setupSQL[2]).toContain(`CHARINDEX(N',', CAST(SESSION_CONTEXT(N'vergis_claim_regions') AS NVARCHAR(MAX))) = 0`)
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
          kind: 'membership' as const,
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

describe('Fabric · dependencias de esquema declaradas (#164)', () => {
  // El issue mide el daño: 9 de 10 columnas de un hecho cayeron sin resistencia y `barcode` no,
  // porque la security policy del `grant: all` estaba anclada en ella — una columna elegida por
  // accidente. Esto NO quita la dependencia; la vuelve LEGIBLE antes del ALTER.
  it('`grant: all` declara la columna que toma rehén, y es andamiaje: la función la ignora', () => {
    const enf = compileFabric({ public: true }, { schema: 'dbo', table: 'fct_plantacion', bindColumn: 'barcode' })!
    expect(enf.schemaDependencies).toEqual(['barcode'])
    // El SQL sigue siendo el mismo allow-all: la declaración no cambia el artefacto.
    expect(enf.setupSQL.join('\n')).toContain('SELECT 1 AS vergis_allowed;')
    expect(enf.setupSQL.join('\n')).toContain('ADD FILTER PREDICATE')
  })

  it('la policy gobernada declara sus columnas de criterio (ahí la dependencia SÍ es semántica)', () => {
    const pol: Policy = {
      predicates: [
        { kind: 'membership', column: 'area', claim: 'groups', op: 'in' },
        { kind: 'membership', column: 'region', claim: 'regions', op: 'in' },
      ],
      combine: 'and',
      default: 'deny',
    }
    const enf = compileFabric(pol, { schema: 'dbo', table: 'saldos' })!
    expect(enf.schemaDependencies).toEqual(['area', 'region'])
  })

  it('sin columnas repetidas: dos predicados sobre la MISMA columna declaran una dependencia', () => {
    const pol: Policy = {
      predicates: [
        { kind: 'membership', column: 'area', claim: 'groups', op: 'in' },
        { kind: 'membership', column: 'area', claim: 'areas2', op: 'eq' },
      ],
      combine: 'or',
      default: 'deny',
    }
    expect(compileFabric(pol, { schema: 'dbo', table: 't' })!.schemaDependencies).toEqual(['area'])
  })
})

// ===========================================================================
// === #163 H2 · PLANO DE COLUMNA EN EL BACK-END FABRIC (DDM) ================
// ===========================================================================
//
// Lo que estas pruebas fijan, y el orden importa:
//   1. el DDL de la máscara y su teardown SIMÉTRICO;
//   2. que la AUSENCIA de reglas no mueva un byte del SQL (control negativo del contrato);
//   3. el differential test contra el oráculo, celda a celda, con el CONTROL de que ambas ramas
//      (con máscara y sin máscara) se ejercitaron — sin ese conteo, un emulador que nunca enmascarara
//      pasaría el differential test sin haber sido puesto en riesgo;
//   4. la BRECHA medida: DDM discrimina por principal y Vergis sirve con uno solo, así que el claim
//      queda inerte y el motor SOBRE-enmascara respecto del oráculo. Se asienta como aserción, no
//      como comentario: una brecha que no está en un test se pierde en la primera relectura.
//
// `emulateFabricRows` se importa por ruta directa porque `packages/policy/src/index.ts` tiene lista de
// exports explícita y está fuera del alcance de este hito (hay otros frentes en vuelo sobre ella).
import { emulateFabricRows, fabricMaskedColumns } from '../packages/policy/src/fabric'
import { MASK_VALUE, type ColumnRule } from '../packages/policy/src/ir'

describe('Fabric · #163 H2 · enmascaramiento por columna (DDM nativo)', () => {
  const REGLA_RUT: ColumnRule = { column: 'rut', claim: 've_pii', action: 'mask' }
  const polConRegla = (rules: ColumnRule[] = [REGLA_RUT]): Policy => ({
    predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
    combine: 'and',
    default: 'deny',
    columnRules: rules,
  })

  it('emite el ADD MASKED WITH de la columna declarada, al final del setup', () => {
    const enf = compileFabric(polConRegla(), FAB_TARGET)
    expect(enf.setupSQL[enf.setupSQL.length - 1]).toBe(
      `ALTER TABLE [dbo].[areas] ALTER COLUMN [rut] ADD MASKED WITH (FUNCTION = 'default()');`,
    )
    // el DDL de fila no se movió: la máscara se SUMA, no reemplaza
    expect(enf.setupSQL.join('\n')).toContain('CREATE SECURITY POLICY [dbo].[secpol_areas]')
  })

  it('el teardown revierte la máscara, guardado (DROP MASKED sobre columna sin máscara es error)', () => {
    const enf = compileFabric(polConRegla(), FAB_TARGET)
    expect(enf.teardownSQL).toEqual([
      `IF EXISTS (SELECT 1 FROM sys.masked_columns WHERE object_id = OBJECT_ID(N'[dbo].[areas]') AND name = N'rut')\n` +
        `    EXEC(N'ALTER TABLE [dbo].[areas] ALTER COLUMN [rut] DROP MASKED;');`,
      `DROP SECURITY POLICY IF EXISTS [dbo].[secpol_areas];`,
      `DROP FUNCTION IF EXISTS [dbo].[fn_pol_areas];`,
    ])
    // simetría: todo lo que el setup instala, el teardown lo desinstala…
    expect(enf.setupSQL.filter((s) => s.startsWith('ALTER TABLE'))).toHaveLength(1)
    // …y el setup ARRANCA con el teardown completo (idempotencia por tira-y-recrea)
    expect(enf.setupSQL.slice(0, enf.teardownSQL.length)).toEqual(enf.teardownSQL)
  })

  it('varias reglas → una máscara por columna, sin repetir, en orden de declaración', () => {
    const enf = compileFabric(
      polConRegla([REGLA_RUT, { column: 'sueldo', claim: 've_rem', action: 'mask' }, REGLA_RUT]),
      FAB_TARGET,
    )
    expect(fabricMaskedColumns(enf)).toEqual(['rut', 'sueldo'])
    expect(enf.setupSQL.filter((s) => s.startsWith('ALTER TABLE'))).toEqual([
      `ALTER TABLE [dbo].[areas] ALTER COLUMN [rut] ADD MASKED WITH (FUNCTION = 'default()');`,
      `ALTER TABLE [dbo].[areas] ALTER COLUMN [sueldo] ADD MASKED WITH (FUNCTION = 'default()');`,
    ])
  })

  it('`schemaDependencies` incluye las columnas enmascaradas junto a las de criterio (#164)', () => {
    const gobernada = compileFabric(polConRegla(), FAB_TARGET)
    expect(gobernada.schemaDependencies).toEqual(['area', 'rut'])
    // una regla SOBRE la columna de criterio no la duplica
    expect(compileFabric(polConRegla([{ column: 'area', claim: 've_pii', action: 'mask' }]), FAB_TARGET).schemaDependencies).toEqual(['area'])
    // y el plano de columna es ortogonal al de fila: una policy PÚBLICA también enmascara
    const publica = compileFabric(
      { public: true, columnRules: [REGLA_RUT] },
      { ...FAB_TARGET, bindColumn: 'area' },
    )
    expect(publica.schemaDependencies).toEqual(['area', 'rut'])
    expect(publica.setupSQL.join('\n')).toContain(`ALTER COLUMN [rut] ADD MASKED WITH`)
  })

  it('fail-closed: regla malformada ROMPE el compilado (jamás degrada a «sin máscara»)', () => {
    for (const mala of [
      { column: 'rut', claim: 've_pii' },
      { column: 'rut', claim: 've_pii', action: 'hide' },
      { column: 'rut', action: 'mask' },
      { column: '', claim: 've_pii', action: 'mask' },
      null,
    ]) {
      expect(() => compileFabric(polConRegla([mala as unknown as ColumnRule]), FAB_TARGET)).toThrow(VergisError)
    }
  })

  it('anti-inyección: el nombre de la columna y el del claim se validan como identificadores', () => {
    expect(() =>
      compileFabric(polConRegla([{ column: `rut] DROP TABLE x --`, claim: 've_pii', action: 'mask' }]), FAB_TARGET),
    ).toThrow(/identificador|unsafe/i)
    expect(() =>
      compileFabric(polConRegla([{ column: 'rut', claim: `x'; DROP TABLE y; --`, action: 'mask' }]), FAB_TARGET),
    ).toThrow(/identificador|unsafe/i)
  })

  it('CONTROL NEGATIVO: sin reglas de columna el SQL es el de siempre, byte a byte', () => {
    const sinReglas = compileFabric(parseAudience(QW04_AUDIENCE), FAB_TARGET)
    const conListaVacia = compileFabric({ ...(parseAudience(QW04_AUDIENCE) as Policy), columnRules: [] }, FAB_TARGET)
    expect(sinReglas.setupSQL).toHaveLength(4) // DROP policy, DROP fn, CREATE fn, CREATE policy
    expect(sinReglas.setupSQL.join('\n')).not.toContain('MASKED')
    expect(sinReglas.teardownSQL).toEqual([
      `DROP SECURITY POLICY IF EXISTS [dbo].[secpol_areas];`,
      `DROP FUNCTION IF EXISTS [dbo].[fn_pol_areas];`,
    ])
    expect(conListaVacia.setupSQL).toEqual(sinReglas.setupSQL)
    expect(conListaVacia.teardownSQL).toEqual(sinReglas.teardownSQL)
    expect(sinReglas.schemaDependencies).toEqual(['area'])
    // y el emulador tampoco toca nada: devuelve las MISMAS referencias de fila
    const settings = settingsForInjections(sinReglas.injections, { groups: ['Producción'] })
    const rows = STORE as unknown as Record<string, unknown>[]
    expect(emulateFabricRows(sinReglas, settings, rows)[0]).toBe(rows[0])
  })

  it('BRECHA MEDIDA: DDM no discrimina por claim — el sujeto CON el claim también ve la máscara', () => {
    // No es un bug de este emisor: `execute-sql-dwh` sirve a todos los consumidores con UN Service
    // Principal y los distingue por SESSION_CONTEXT, mientras que DDM discrimina por el permiso
    // UNMASK del principal. La dirección de la divergencia es SEGURA (sobre-enmascara, no filtra) y
    // queda asentada acá para que no se descubra en producción.
    const enf = compileFabric(polConRegla(), FAB_TARGET)
    const rows = [{ area: 'Producción', rut: '11.111.111-1' }]
    const claims = { groups: ['Producción'], ve_pii: ['si'] }
    const settings = settingsForInjections(enf.injections, claims)
    expect(emulateFabricRows(enf, settings, rows)[0].rut).toBe(MASK_VALUE) // motor: enmascarado
    expect(applyPolicy(enf.policy, claims, rows)[0].rut).toBe('11.111.111-1') // oráculo: en claro
  })
})

// === #163 · el plano de columna, corregido contra un MOTOR (no contra la lectura del manual) ====
//
// Los tres defectos que siguen no se dedujeron: los devolvió un motor T-SQL real
// (`scripts/tsql-lab-proof.ts`, SQL Server 2022 en contenedor), cada uno con su control. Se asientan
// acá como aserciones de SQL exacto porque un hallazgo que solo vive en el log de una corrida se
// pierde en la primera relectura.
describe('Fabric · #163 · plano de columna corregido (medido contra motor)', () => {
  const REGLA: ColumnRule = { column: 'rut', claim: 've_pii', action: 'mask' }
  const pol = (rules: ColumnRule[] = [REGLA]): Policy => ({
    predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
    combine: 'and',
    default: 'deny',
    columnRules: rules,
  })

  it('el guard del DROP MASKED difiere la compilación con EXEC — sin esto fallaba TODA instalación nueva', () => {
    // T-SQL compila el batch entero antes de ejecutarlo, y `DROP MASKED` se valida en compilación:
    // colgando el ALTER del `IF`, el batch falla sobre una columna sin máscara ANTES de evaluar el
    // guard. Como este statement encabeza el setup (tira-y-recrea), el plano de columna no instalaba
    // en su primera sentencia. Medido: «The column 'rut' does not have a data masking function».
    const enf = compileFabric(pol(), FAB_TARGET)
    const drop = enf.teardownSQL.find((s) => s.includes('DROP MASKED'))!
    expect(drop).toContain("EXEC(N'ALTER TABLE")
    expect(drop).toMatch(/IF EXISTS \(SELECT 1 FROM sys\.masked_columns/)
    // el ALTER NO puede quedar colgando del IF: es exactamente el modo de falla que se corrigió
    expect(drop).not.toMatch(/\)\n\s+ALTER TABLE/)
  })

  it('el preflight nombra los objetos SCHEMABINDING que atan la columna, y falla ruidoso', () => {
    // El motor rechaza con «one or more objects access this column»: no nombra al culpable ni dice
    // qué hacer. El preflight diagnostica antes, con los objetos y con la remediación MEDIDA — no es
    // incompatibilidad, es orden (la máscara primero, la vista-contrato después).
    const enf = compileFabric(pol(), FAB_TARGET)
    const pre = enf.setupSQL.find((s) => s.includes('sql_expression_dependencies'))
    expect(pre).toBeDefined()
    expect(pre).toContain('is_schema_bound_reference = 1')
    expect(pre).toContain('RAISERROR')
    expect(pre).toContain('ORDEN') // la remediación, no un «revise su esquema»
    // va ANTES del ADD MASKED (diagnosticar tarde no sirve) y DESPUÉS del plano de fila (que sí instala)
    const iPre = enf.setupSQL.findIndex((s) => s.includes('sql_expression_dependencies'))
    const iAdd = enf.setupSQL.findIndex((s) => s.includes('ADD MASKED'))
    const iPol = enf.setupSQL.findIndex((s) => s.startsWith('CREATE SECURITY POLICY'))
    expect(iPol).toBeLessThan(iPre)
    expect(iPre).toBeLessThan(iAdd)
  })

  it('REGRESIÓN · el preflight NO mira la dependencia de OBJETO: la propia security policy es SCHEMABINDING', () => {
    // Lo destapó el arnés, no una relectura: la versión ingenua sumaba `referenced_minor_id = 0`, y
    // como la SECURITY POLICY de fila que el mismo setup acaba de instalar es schema-bound, el
    // preflight se disparaba contra ella. Falso positivo que habría roto TODA instalación con reglas
    // de columna — el defecto que este cambio venía a arreglar, reintroducido por el arreglo.
    // Medido: un objeto schema-bound deja una fila por CADA columna que referencia, así que la
    // dependencia de columna alcanza y la de objeto solo agrega ruido.
    const enf = compileFabric(pol(), FAB_TARGET)
    const pre = enf.setupSQL.find((s) => s.includes('sql_expression_dependencies'))!
    expect(pre).not.toContain('referenced_minor_id = 0')
    expect(pre).toContain("COLUMNPROPERTY(OBJECT_ID(N'[dbo].[areas]'), N'rut', 'ColumnId')")
    // y el nombre que reporta se acota igual: solo quien ata la columna enmascarada
    expect(pre.match(/COLUMNPROPERTY/g)).toHaveLength(2) // el IF y el STRING_AGG, ambos acotados
  })

  it('varias columnas → un solo preflight que las nombra a todas', () => {
    const enf = compileFabric(pol([REGLA, { column: 'sueldo', claim: 've_rem', action: 'mask' }]), FAB_TARGET)
    const pre = enf.setupSQL.filter((s) => s.includes('sql_expression_dependencies'))
    expect(pre).toHaveLength(1)
    expect(pre[0]).toContain("N'rut'")
    expect(pre[0]).toContain("N'sueldo'")
  })

  it('CONTROL NEGATIVO: sin reglas de columna no se emite preflight — el SQL sigue siendo el de siempre', () => {
    const sinReglas = compileFabric(parseAudience(QW04_AUDIENCE), FAB_TARGET)
    expect(sinReglas.setupSQL.join('\n')).not.toContain('sql_expression_dependencies')
    expect(sinReglas.setupSQL).toHaveLength(4)
  })
})

// === PROPERTY TEST: celdas servidas por Fabric vs el oráculo (#163 H2) =======
describe('Fabric · #163 H2 · property test celda a celda (codegen vs oráculo)', () => {
  function lcg(seed: number) {
    let s = seed >>> 0
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000)
  }
  const AREAS = ['Producción', 'Finanzas', 'Comercial', 'RRHH']
  const pick = <T,>(rnd: () => number, xs: T[]) => xs[Math.floor(rnd() * xs.length)]
  const subset = <T,>(rnd: () => number, xs: T[]) => xs.filter(() => rnd() < 0.5)

  it('∀ store, reglas y claims aleatorios: mismas filas, mismas celdas — sin fuga y con ambas ramas', () => {
    const rnd = lcg(20260813)
    let conMascara = 0 // corridas donde el oráculo enmascaró alguna celda servida
    let sinMascara = 0 // corridas donde el oráculo sirvió TODA la fila en claro
    let sobreMascara = 0 // CELDAS donde el motor enmascaró y el oráculo no (la brecha de DDM)

    for (let iter = 0; iter < 600; iter += 1) {
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ({
        area: pick(rnd, AREAS),
        rut: `${Math.floor(rnd() * 1e6)}-K`,
        present: Math.floor(rnd() * 100),
      })) as unknown as Record<string, unknown>[]

      // reglas de columna aleatorias: a veces ninguna (la extensión tiene que ser conservadora)
      const rules: ColumnRule[] = []
      if (rnd() < 0.7) rules.push({ column: 'rut', claim: 've_pii', action: 'mask' })
      if (rnd() < 0.4) rules.push({ column: 'present', claim: 've_rem', action: 'mask' })

      const policy: Policy = {
        predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
        combine: 'and',
        default: 'deny',
        columnRules: rules,
      }

      const claims: ClaimSet = {}
      if (rnd() < 0.9) claims.groups = subset(rnd, AREAS)
      if (rnd() < 0.5) claims.ve_pii = ['si'] // a veces el sujeto SÍ trae el claim
      if (rnd() < 0.5) claims.ve_rem = ['si']

      const enf = compileFabric(policy, FAB_TARGET)
      const settings = settingsForInjections(enf.injections, claims)
      const fromFabric = emulateFabricRows(enf, settings, rows)
      const fromReference = applyPolicy(policy, claims, rows)

      // 1 · el plano de FILA no se movió: mismas filas, misma forma
      expect(fromFabric).toHaveLength(fromReference.length)
      fromFabric.forEach((fab, i) => {
        const ref = fromReference[i]
        expect(Object.keys(fab)).toEqual(Object.keys(ref))
        for (const k of Object.keys(ref)) {
          if (ref[k] === MASK_VALUE) {
            // 2 · NO-FUGA (lo que de verdad sostiene el hito): donde el oráculo enmascara, el motor
            // enmascara. Esta es la desigualdad que jamás puede aflojarse.
            expect(fab[k]).toBe(MASK_VALUE)
          } else if (fab[k] !== ref[k]) {
            // 3 · la única divergencia admitida es en la dirección segura, y SOLO sobre una columna
            // con regla declarada: el motor enmascaró de más porque DDM no ve el claim.
            expect(fab[k]).toBe(MASK_VALUE)
            expect(rules.some((r) => r.column === k)).toBe(true)
            sobreMascara += 1
          }
        }
      })

      if (fromReference.length > 0) {
        const hayMascara = Object.values(fromReference[0]).some((v) => v === MASK_VALUE)
        if (hayMascara) conMascara += 1
        else sinMascara += 1
      }
    }
    // CONTROL DE RAMAS: sin esto, un emulador que nunca enmascarara (o que enmascarara siempre)
    // pasaría el differential test sin haber sido puesto en riesgo ni una vez.
    expect(conMascara).toBeGreaterThan(50)
    expect(sinMascara).toBeGreaterThan(50)
    expect(sobreMascara).toBeGreaterThan(50) // y la brecha de DDM se ejercitó de verdad
  })
})

describe('ClickHouse · el plano de columna es capacidad NO SOPORTADA, fail-closed (#163 H3)', () => {
  // Evidencia de por qué no se implementó la máscara: este back-end emite un PREDICADO de fila
  // (`USING`, booleano) más inyección de settings, y la proyección la escribe el consumidor
  // (`execute-sql-ch` manda `params.sql` verbatim). No hay punto donde sustituir una celda sin
  // mover la authz fuera del motor. Lo que estos tests fijan es que ROMPE, y que romper es lo
  // correcto: la alternativa a la máscara nunca es servir la columna en claro.
  const COL_RULE = { column: 'rut', claim: 'pii', action: 'mask' as const }

  const withRules = (base: PolicyDecl): PolicyDecl =>
    ({ ...(base as object), columnRules: [COL_RULE] }) as PolicyDecl

  const ROW_POLICY: Policy = {
    predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
    combine: 'and',
    default: 'deny',
  }

  it('una policy de fila CON regla de columna no compila (code exacto)', () => {
    let caught: unknown
    try {
      compileClickHouse(withRules(ROW_POLICY), TARGET)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(VergisError)
    const d = (caught as VergisError).structured
    expect(d.error).toBe('policy/compile')
    expect(d.code).toBe('column-masking-unsupported')
    expect(d.path).toBe('audience.columns')
    expect(d.value).toEqual(['rut'])
    // El mensaje dice la verdad completa: qué no soporta, y que la salida NO es servir en claro.
    expect(String(d.message)).toMatch(/no sabe enmascarar/i)
    expect(String(d.message)).toMatch(/en claro/i)
    expect(String(d.remediation)).toMatch(/en claro/i)
  })

  it('un PI PÚBLICO con columna sensible tampoco compila — es el caso que más fugaría en silencio', () => {
    // Sin el chequeo previo a la rama pública, esto habría devuelto `USING 1` y servido el rut entero.
    expect(() => compileClickHouse(withRules({ public: true }), TARGET)).toThrow(VergisError)
    expect(() => compileClickHouse(withRules({ public: true }), TARGET)).toThrow(/no sabe enmascarar/i)
  })

  it('el rechazo es del compilador, no del deploy: nunca llega a existir un enforcement', () => {
    // Si devolviera un enforcement «sin máscara», `bootstrapClickHouse` lo aplicaría verbatim y la
    // columna quedaría servida. La única forma de que eso no pase es no producir el artefacto.
    expect(() => compilePolicyToClickHouse(
      { rls: [{ column: 'area', claim: 'groups', op: 'in' }] },
      TARGET,
      BIND,
    )).not.toThrow()
    const conReglas = withRules(parseAudience({ rls: [{ column: 'area', claim: 'groups', op: 'in' }] }))
    expect(() => compileClickHouse(conReglas, TARGET)).toThrow(/column-masking-unsupported|no sabe enmascarar/i)
  })

  // --- CONTROL NEGATIVO: sin reglas de columna, el back-end es bit a bit el de siempre ----------
  it('CONTROL — una policy SIN reglas de columna emite EXACTAMENTE el SQL de siempre', () => {
    const enf = compileClickHouse(ROW_POLICY, TARGET)
    expect(enf.rowPolicySQL).toBe(
      `CREATE ROW POLICY OR REPLACE pol_areas ON vergis.areas\n` +
        `    FOR SELECT\n` +
        `    USING (getSetting('vergis_claim_groups') != '' AND has(splitByChar(',', getSetting('vergis_claim_groups')), area))\n` +
        `    AS permissive\n` +
        `    TO consumer_role;`,
    )
    expect(enf.injections).toEqual([{ setting: 'vergis_claim_groups', claim: 'groups' }])
  })

  it('CONTROL — `columnRules: []` (declarado y vacío) no es «tiene reglas»: compila igual', () => {
    const vacias = { ...ROW_POLICY, columnRules: [] } as PolicyDecl
    expect(compileClickHouse(vacias, TARGET).rowPolicySQL).toBe(compileClickHouse(ROW_POLICY, TARGET).rowPolicySQL)
  })

  it('CONTROL — el público sin reglas sigue siendo allow-all, y las filas servidas no cambian', () => {
    expect(compileClickHouse({ public: true }, TARGET).rowPolicySQL).toContain('USING 1')
    // Y el plano de fila del back-end sigue coincidiendo con el oráculo (extensión conservadora).
    expect(served(ROW_POLICY, { groups: ['Finanzas'] })).toEqual(
      applyPolicy(ROW_POLICY, { groups: ['Finanzas'] }, STORE as unknown as Record<string, unknown>[]),
    )
  })
})

// === #163 H6 · LA VISTA DE MÁSCARA: la máscara honra el CLAIM DEL SUJETO =====
//
// Lo que separa este hito del H2 en una línea: DDM enmascara IGUAL PARA TODOS (discrimina por el
// permiso UNMASK del principal, y Vergis sirve a todos los consumidores con UN Service Principal),
// así que el claim de la `ColumnRule` quedaba INERTE. La vista evalúa ese claim contra
// SESSION_CONTEXT —el mismo canal por el que ya viaja el sujeto para el FILTER PREDICATE de fila— en
// la PROYECCIÓN, que es el único lugar donde una celda se puede reescribir.
//
// Los tests del H2 (arriba) NO se tocan: asertan el otro mecanismo, que sigue emitiéndose como
// defensa en profundidad. Acá se aserta la vista.
import { emulateFabricMaskView, fabricMaskViewColumns } from '../packages/policy/src/fabric'

describe('Fabric · #163 H6 · vista de máscara evaluada por request (el claim deja de ser inerte)', () => {
  const REGLA_PII: ColumnRule = { column: 'rut', claim: 've_pii', action: 'mask' }
  const REGLA_REM: ColumnRule = { column: 'sueldo', claim: 've_rem', action: 'mask' }
  /** Target con la proyección declarada: sin ella la vista no se puede emitir (no se sabe la forma). */
  const VIEW_TARGET = {
    ...FAB_TARGET,
    tableColumns: ['area', 'rut', 'sueldo'],
    columnTypes: { rut: 'NVARCHAR(20)', sueldo: 'DECIMAL(18,2)' },
  }
  const polCol = (rules: ColumnRule[] = [REGLA_PII]): Policy => ({
    predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
    combine: 'and',
    default: 'deny',
    columnRules: rules,
  })
  const FILAS = [
    { area: 'Producción', rut: '11.111.111-1', sueldo: 900 },
    { area: 'Finanzas', rut: '22.222.222-2', sueldo: 1500 },
  ] as Record<string, unknown>[]

  it('emite el CREATE VIEW exacto: misma forma, centinela TIPADO por columna, guard de SESSION_CONTEXT', () => {
    const enf = compileFabric(polCol([REGLA_PII, REGLA_REM]), VIEW_TARGET)
    expect(enf.maskView?.qualifiedName).toBe('[dbo].[vw_mask_areas]')
    expect(enf.maskView?.columns).toEqual(['area', 'rut', 'sueldo']) // la forma NO cambia
    expect(enf.maskView?.createSQL).toBe(
      `CREATE VIEW [dbo].[vw_mask_areas]\n` +
        `AS\n` +
        `    SELECT\n` +
        `        [vergis_row].[area],\n` +
        `        CASE WHEN [vergis_claims].[ve_pii] <> N'' THEN [vergis_row].[rut] ELSE CAST(N'${MASK_VALUE}' AS NVARCHAR(20)) END AS [rut],\n` +
        `        CASE WHEN [vergis_claims].[ve_rem] <> N'' THEN [vergis_row].[sueldo] ELSE CAST(0 AS DECIMAL(18,2)) END AS [sueldo]\n` +
        `    FROM [dbo].[areas] AS [vergis_row]\n` +
        `    CROSS APPLY (VALUES (\n` +
        `        CAST(SESSION_CONTEXT(N'vergis_claim_ve_pii') AS NVARCHAR(MAX)),\n` +
        `        CAST(SESSION_CONTEXT(N'vergis_claim_ve_rem') AS NVARCHAR(MAX))\n` +
        `    )) AS [vergis_claims] ([ve_pii], [ve_rem]);`,
    )
    // la vista es la ÚLTIMA sentencia del setup (se apoya en la tabla ya gobernada) y viaja SOLA
    expect(enf.setupSQL[enf.setupSQL.length - 1]).toBe(enf.maskView?.createSQL)
    // y el plano de fila no se movió: la vista se SUMA
    expect(enf.setupSQL.join('\n')).toContain('CREATE SECURITY POLICY [dbo].[secpol_areas]')
  })

  it('centinela por FAMILIA de tipos: texto, numérica, fecha, hora, binaria y uniqueidentifier', () => {
    const columnas = ['t_nvarchar', 't_int', 't_date', 't_time', 't_varbinary', 't_guid']
    const tipos = {
      t_nvarchar: 'NVARCHAR(50)', t_int: 'INT', t_date: 'DATE',
      t_time: 'TIME', t_varbinary: 'VARBINARY(16)', t_guid: 'UNIQUEIDENTIFIER',
    }
    const enf = compileFabric(
      polCol(columnas.map((c) => ({ column: c, claim: 've_pii', action: 'mask' as const }))),
      { ...FAB_TARGET, tableColumns: columnas, columnTypes: tipos },
    )
    const sql = enf.maskView!.createSQL
    expect(sql).toContain(`ELSE CAST(N'${MASK_VALUE}' AS NVARCHAR(50)) END AS [t_nvarchar]`)
    expect(sql).toContain(`ELSE CAST(0 AS INT) END AS [t_int]`)
    expect(sql).toContain(`ELSE CAST('1900-01-01' AS DATE) END AS [t_date]`)
    expect(sql).toContain(`ELSE CAST('00:00:00' AS TIME) END AS [t_time]`)
    expect(sql).toContain(`ELSE CAST(0x00 AS VARBINARY(16)) END AS [t_varbinary]`)
    expect(sql).toContain(`ELSE CAST('00000000-0000-0000-0000-000000000000' AS UNIQUEIDENTIFIER) END AS [t_guid]`)
  })

  it('el teardown tira la vista PRIMERO, y el setup arranca con el teardown completo (idempotente)', () => {
    const enf = compileFabric(polCol(), VIEW_TARGET)
    expect(enf.teardownSQL).toEqual([
      `DROP VIEW IF EXISTS [dbo].[vw_mask_areas];`,
      `IF EXISTS (SELECT 1 FROM sys.masked_columns WHERE object_id = OBJECT_ID(N'[dbo].[areas]') AND name = N'rut')\n` +
        `    EXEC(N'ALTER TABLE [dbo].[areas] ALTER COLUMN [rut] DROP MASKED;');`,
      `DROP SECURITY POLICY IF EXISTS [dbo].[secpol_areas];`,
      `DROP FUNCTION IF EXISTS [dbo].[fn_pol_areas];`,
    ])
    expect(enf.setupSQL.slice(0, enf.teardownSQL.length)).toEqual(enf.teardownSQL)
    // simetría: una sola vista instalada, una sola tirada
    expect(enf.setupSQL.filter((s) => s.startsWith('CREATE VIEW'))).toHaveLength(1)
    expect(enf.teardownSQL.filter((s) => s.startsWith('DROP VIEW'))).toHaveLength(1)
    // y correr el setup dos veces produce el MISMO SQL (el compilado no arrastra estado)
    expect(compileFabric(polCol(), VIEW_TARGET).setupSQL).toEqual(enf.setupSQL)
  })

  it('EL HITO: el sujeto CON el claim ve el valor en claro; el sujeto SIN el claim ve el centinela', () => {
    const enf = compileFabric(polCol([REGLA_PII, REGLA_REM]), VIEW_TARGET)
    const base = { groups: ['Producción'] }

    // request 1 — trae ve_pii, no trae ve_rem
    const s1 = settingsForInjections(enf.injections, { ...base, ve_pii: ['si'] })
    const r1 = emulateFabricMaskView(enf, s1, FILAS)
    expect(r1[0].rut).toBe('11.111.111-1') // EN CLARO: el claim está
    expect(r1[0].sueldo).toBe(MASK_VALUE) // enmascarado: el claim falta

    // request 2 — el MISMO enforcement, otro sujeto: nada en claro
    const s2 = settingsForInjections(enf.injections, base)
    const r2 = emulateFabricMaskView(enf, s2, FILAS)
    expect(r2[0].rut).toBe(MASK_VALUE)
    expect(r2[0].sueldo).toBe(MASK_VALUE)

    // la FORMA es la misma para los dos (§4.1: mentimos el valor, jamás el esquema)
    expect(Object.keys(r1[0])).toEqual(Object.keys(r2[0]))
    expect(Object.keys(r1[0])).toEqual(Object.keys(FILAS[0]))
    // y coincide con el oráculo en los dos requests
    expect(r1).toEqual(applyPolicy(enf.policy, { ...base, ve_pii: ['si'] }, FILAS))
    expect(r2).toEqual(applyPolicy(enf.policy, base, FILAS))
  })

  it('claim presente pero VACÍO enmascara igual (el guard `<> N\'\'` es el mismo del plano de fila)', () => {
    const enf = compileFabric(polCol(), VIEW_TARGET)
    for (const ve_pii of [[], [''], '' as string]) {
      const s = settingsForInjections(enf.injections, { groups: ['Producción'], ve_pii })
      expect(emulateFabricMaskView(enf, s, FILAS)[0].rut).toBe(MASK_VALUE)
    }
  })

  it('el claim de la regla SE INYECTA (si no, un residuo del pool desenmascararía a quien no lo trae)', () => {
    const enf = compileFabric(polCol([REGLA_PII]), VIEW_TARGET)
    expect(enf.injections).toEqual([
      { setting: 'vergis_claim_groups', claim: 'groups' },
      { setting: 'vergis_claim_ve_pii', claim: 've_pii' },
    ])
    // el prelude lo reinyecta SIEMPRE, con '' cuando el sujeto no lo trae → default-deny de la celda
    const prelude = sessionContextPrelude(enf.injections, { groups: ['Producción'] })
    expect(prelude.sql).toContain(`@key = N'vergis_claim_ve_pii'`)
    expect(prelude.params.find((p) => p.name === 'vergis_sc_1')?.value).toBe('')
    // y el VALOR del claim viaja parametrizado, jamás interpolado en el SQL
    const conValor = sessionContextPrelude(enf.injections, { groups: ['Producción'], ve_pii: ["x' OR 1=1--"] })
    expect(conValor.sql).not.toContain('OR 1=1')
    expect(conValor.params.find((p) => p.name === 'vergis_sc_1')?.value).toBe("x' OR 1=1--")
    // un PI PÚBLICO con columna sensible también inyecta: los planos son ortogonales
    const publica = compileFabric({ public: true, columnRules: [REGLA_PII] }, { ...VIEW_TARGET, bindColumn: 'area' })
    expect(publica.injections).toEqual([{ setting: 'vergis_claim_ve_pii', claim: 've_pii' }])
    expect(publica.maskView?.createSQL).toContain(`SESSION_CONTEXT(N'vergis_claim_ve_pii')`)
  })

  it('un claim que se llama IGUAL que una columna no vuelve ambigua la vista: todo va calificado', () => {
    // El emisor no elige los nombres de los claims ni los de las columnas: pueden chocar. Si la
    // proyección no fuera calificada, `[area]` sería ambigua entre la tabla y la fuente de claims y
    // el `CREATE VIEW` fallaría en el motor — por un nombre que nadie controla acá.
    const enf = compileFabric(
      polCol([{ column: 'rut', claim: 'area', action: 'mask' }]),
      VIEW_TARGET,
    )
    const sql = enf.maskView!.createSQL
    expect(sql).toContain(`        [vergis_row].[area],`) // la columna, del lado de la tabla
    expect(sql).toContain(`CASE WHEN [vergis_claims].[area] <> N'' THEN [vergis_row].[rut]`) // el claim, del suyo
    // ninguna referencia de columna queda desnuda dentro del SELECT
    expect(sql).not.toMatch(/\n        \[(?!vergis_row\]|vergis_claims\])/)
  })

  it('varias reglas sobre la MISMA columna → AND de los claims (hacen falta todos para verla en claro)', () => {
    const enf = compileFabric(
      polCol([REGLA_PII, { column: 'rut', claim: 've_rut', action: 'mask' }]),
      VIEW_TARGET,
    )
    expect(enf.maskView?.createSQL).toContain(
      `CASE WHEN [vergis_claims].[ve_pii] <> N'' AND [vergis_claims].[ve_rut] <> N'' THEN [vergis_row].[rut]`,
    )
    // y los DOS claims se materializan una sola vez cada uno en la fuente escalar (forma C2, #197)
    expect(enf.maskView?.createSQL).toContain(
      `    CROSS APPLY (VALUES (\n` +
        `        CAST(SESSION_CONTEXT(N'vergis_claim_ve_pii') AS NVARCHAR(MAX)),\n` +
        `        CAST(SESSION_CONTEXT(N'vergis_claim_ve_rut') AS NVARCHAR(MAX))\n` +
        `    )) AS [vergis_claims] ([ve_pii], [ve_rut])`,
    )
    const soloUno = settingsForInjections(enf.injections, { groups: ['Producción'], ve_pii: ['si'] })
    expect(emulateFabricMaskView(enf, soloUno, FILAS)[0].rut).toBe(MASK_VALUE)
    const ambos = settingsForInjections(enf.injections, { groups: ['Producción'], ve_pii: ['si'], ve_rut: ['si'] })
    expect(emulateFabricMaskView(enf, ambos, FILAS)[0].rut).toBe('11.111.111-1')
    // …que es exactamente lo que hace el oráculo con dos reglas sobre la misma columna
    expect([...fabricMaskViewColumns(enf, soloUno)]).toEqual(['rut'])
    expect([...fabricMaskViewColumns(enf, ambos)]).toEqual([])
  })

  it('la vista NO filtra: el plano de fila sigue viniendo de la SECURITY POLICY sobre la tabla', () => {
    const enf = compileFabric(polCol(), VIEW_TARGET)
    expect(enf.maskView?.createSQL).not.toContain('WHERE')
    const s = settingsForInjections(enf.injections, { groups: ['Finanzas'], ve_pii: ['si'] })
    expect(emulateFabricMaskView(enf, s, FILAS).map((r) => r.area)).toEqual(['Finanzas'])
    // sin claim de fila no hay ninguna fila que enmascarar: la máscara no resucita nada
    expect(emulateFabricMaskView(enf, settingsForInjections(enf.injections, {}), FILAS)).toHaveLength(0)
  })

  it('FAIL-CLOSED: tipo desconocido, tipo no declarado o columna fuera de la proyección ROMPEN', () => {
    // tipo que no se sabe mapear a centinela → nunca «se sirve sin CASE»
    let caught: unknown
    try {
      compileFabric(polCol(), { ...VIEW_TARGET, columnTypes: { rut: 'GEOGRAPHY' } })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(VergisError)
    expect((caught as VergisError).structured.code).toBe('mask-sentinel-unknown-type')

    // tipo NO declarado: no se supone NVARCHAR (una columna INT reventaría en cada request)
    try {
      caught = undefined
      compileFabric(polCol(), { ...FAB_TARGET, tableColumns: ['area', 'rut', 'sueldo'] })
    } catch (e) { caught = e }
    expect((caught as VergisError).structured.code).toBe('mask-view-column-type-missing')

    // regla sobre una columna que la proyección declarada no trae (typo o declaración rancia)
    try {
      caught = undefined
      compileFabric(polCol([{ column: 'fantasma', claim: 've_pii', action: 'mask' }]), VIEW_TARGET)
    } catch (e) { caught = e }
    expect((caught as VergisError).structured.code).toBe('mask-view-column-not-projected')
  })

  it('anti-inyección: proyección, nombre de vista, columna y claim se validan como identificadores', () => {
    expect(() => compileFabric(polCol(), { ...VIEW_TARGET, tableColumns: ['area', 'rut', 'x] FROM sys.tables --'] }))
      .toThrow(/identificador|unsafe/i)
    expect(() => compileFabric(polCol(), { ...VIEW_TARGET, maskViewName: 'v]; DROP TABLE x --' }))
      .toThrow(/identificador|unsafe/i)
    expect(() => compileFabric(polCol([{ column: 'rut', claim: `x'; DROP TABLE y; --`, action: 'mask' }]), VIEW_TARGET))
      .toThrow(/identificador|unsafe/i)
    expect(() => compileFabric(polCol(), { ...VIEW_TARGET, columnTypes: { rut: 'NVARCHAR(20)); DROP' } }))
      .toThrow(/tipo|type|unsafe/i)
  })

  it('CONTROL NEGATIVO: sin reglas de columna no hay vista y el SQL es el de hoy, byte a byte', () => {
    const hoy = compileFabric(parseAudience(QW04_AUDIENCE), FAB_TARGET)
    const conProyeccion = compileFabric(parseAudience(QW04_AUDIENCE), VIEW_TARGET)
    const listaVacia = compileFabric({ ...(parseAudience(QW04_AUDIENCE) as Policy), columnRules: [] }, VIEW_TARGET)
    for (const enf of [conProyeccion, listaVacia]) {
      expect(enf.setupSQL).toEqual(hoy.setupSQL) // declarar la proyección NO cambia un byte
      expect(enf.teardownSQL).toEqual(hoy.teardownSQL)
      expect(enf.injections).toEqual(hoy.injections)
      expect(enf.maskView).toBeNull()
      expect(enf.setupSQL.join('\n')).not.toContain('VIEW')
    }
    // y sin vista el emulador no toca las filas: devuelve las MISMAS referencias
    const s = settingsForInjections(hoy.injections, { groups: ['Producción'] })
    expect(emulateFabricMaskView(hoy, s, FILAS)[0]).toBe(FILAS[0])
  })

  it('sin `tableColumns` la vista no se emite, y no emitirla NO abre nada (queda el DDM del H2)', () => {
    // No se puede construir la proyección sin conocerla; la salida segura es no emitir la vista y
    // dejar la tabla con DDM, que enmascara para TODOS (sobre-enmascara, nunca filtra).
    const enf = compileFabric(polCol(), FAB_TARGET)
    expect(enf.maskView).toBeNull()
    expect(enf.setupSQL.join('\n')).toContain(`ALTER COLUMN [rut] ADD MASKED WITH`)
    const conClaim = settingsForInjections(enf.injections, { groups: ['Producción'], ve_pii: ['si'] })
    expect(emulateFabricMaskView(enf, conClaim, FILAS)[0].rut).toBe(MASK_VALUE)
  })

  it('el DDM del H2 SIGUE emitiéndose junto a la vista (defensa en profundidad: cubre el rodeo)', () => {
    const enf = compileFabric(polCol(), VIEW_TARGET)
    expect(enf.setupSQL.join('\n')).toContain(
      `ALTER TABLE [dbo].[areas] ALTER COLUMN [rut] ADD MASKED WITH (FUNCTION = 'default()');`,
    )
    expect(fabricMaskedColumns(enf)).toEqual(['rut']) // el mecanismo del H2, intacto
    expect(enf.schemaDependencies).toEqual(['area', 'rut'])
  })
})

// === #163 H6 · DIFFERENTIAL contra el oráculo, con control de ramas ==========
describe('Fabric · #163 H6 · property test: la vista ≡ applyPolicy (celda a celda)', () => {
  function lcg(seed: number) {
    let s = seed >>> 0
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000)
  }
  const AREAS = ['Producción', 'Finanzas', 'Comercial', 'RRHH']
  const pick = <T,>(rnd: () => number, xs: T[]) => xs[Math.floor(rnd() * xs.length)]
  const subset = <T,>(rnd: () => number, xs: T[]) => xs.filter(() => rnd() < 0.5)

  it('∀ reglas y claims aleatorios: MISMAS celdas que el oráculo, y las dos ramas se ejercitaron', () => {
    const rnd = lcg(20260813)
    let conClaim = 0 // celdas servidas EN CLARO por una columna CON regla (el sujeto traía el claim)
    let sinClaim = 0 // celdas ENMASCARADAS por una columna con regla (el sujeto no lo traía)
    let corridasConRegla = 0

    for (let iter = 0; iter < 600; iter += 1) {
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ({
        area: pick(rnd, AREAS),
        rut: `${Math.floor(rnd() * 1e6)}-K`,
        present: Math.floor(rnd() * 100),
      })) as unknown as Record<string, unknown>[]

      const rules: ColumnRule[] = []
      if (rnd() < 0.7) rules.push({ column: 'rut', claim: 've_pii', action: 'mask' })
      if (rnd() < 0.4) rules.push({ column: 'present', claim: 've_rem', action: 'mask' })
      if (rules.length > 0) corridasConRegla += 1

      const policy: Policy = {
        predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
        combine: 'and',
        default: 'deny',
        columnRules: rules,
      }
      const claims: ClaimSet = {}
      if (rnd() < 0.9) claims.groups = subset(rnd, AREAS)
      if (rnd() < 0.5) claims.ve_pii = ['si']
      if (rnd() < 0.5) claims.ve_rem = ['si']

      const enf = compileFabric(policy, {
        ...FAB_TARGET,
        tableColumns: ['area', 'rut', 'present'],
        columnTypes: { rut: 'NVARCHAR(20)', present: 'INT' },
      })
      const settings = settingsForInjections(enf.injections, claims)
      const fromView = emulateFabricMaskView(enf, settings, rows)
      const fromOracle = applyPolicy(policy, claims, rows)

      // IGUALDAD, no desigualdad: la vista SÍ ve el claim, así que acá no hay brecha que tolerar.
      expect(fromView).toEqual(fromOracle)
      fromView.forEach((fila) => {
        expect(Object.keys(fila)).toEqual(Object.keys(rows[0])) // la forma nunca cambia
        for (const r of rules) {
          if (fila[r.column] === MASK_VALUE) sinClaim += 1
          else conClaim += 1
        }
      })
    }
    // CONTROL DE RAMAS — sin esto, una implementación que enmascarara SIEMPRE (o nunca) pasaría el
    // differential sin haber sido puesta en riesgo ni una vez. Es el hito entero: las DOS ramas.
    // Medido con esta semilla: 533 celdas en claro · 575 enmascaradas · 483 corridas con regla.
    expect(corridasConRegla).toBeGreaterThan(300)
    expect(conClaim).toBeGreaterThan(100)
    expect(sinClaim).toBeGreaterThan(100)
  })
})
