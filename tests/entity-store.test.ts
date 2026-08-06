// Suite del store entidad-canónico (charter §2c): la política se declara UNA vez por entidad de
// negocio; un mapeo semántico la liga a las columnas físicas de cada dataset. El resolver compila
// al MISMO `Map<dataset → PolicyDecl>` que el store legacy por-tabla — los back-ends no cambian.

import { describe, expect, it } from 'vitest'
import { VergisError } from '@vergis/botler'
import {
  compileClickHouse,
  compileFabric,
  emulate,
  emulateFabric,
  isEntityStore,
  isPublic,
  parsePolicyStore,
  requestSettings,
  resolveEntityStore,
  settingsForInjections,
  type Policy,
} from '@vergis/policy'

// QW-04 entidad-canónica: Empleado gobernado por Área; tres datasets físicos lo realizan, cada
// uno mapeando la dimensión `area` a SU columna (pi04.* → `area`, Fabric → `area_name`).
const ENTITY_STORE = {
  entities: [
    { entity: 'empleado', governed_by: [{ dimension: 'area', claim: 'groups', op: 'in' }] },
  ],
  datasets: [
    { dataset: 'pi04.asistencia', realizes: 'empleado', dimensions: { area: 'area' } },
    { dataset: 'pi04.empleado', realizes: 'empleado', dimensions: { area: 'area' } },
    { dataset: 'pi04.licencia', realizes: 'empleado', dimensions: { area: 'area' } },
    { dataset: 'dbo.fct_asistencia_dia', realizes: 'empleado', dimensions: { area: 'area_name' } },
    { dataset: 'dim_area', grant: 'all' }, // dato de referencia: apertura explícita gobernada
  ],
}

describe('Store entidad-canónico · resolución a Map<dataset → PolicyDecl>', () => {
  it('detecta la forma entidad vs legacy', () => {
    expect(isEntityStore(ENTITY_STORE)).toBe(true)
    expect(isEntityStore({ policies: [] })).toBe(false)
    expect(isEntityStore(undefined)).toBe(false)
  })

  it('una entidad (Empleado/Área) gobierna N datasets, cada uno con SU columna', () => {
    const m = resolveEntityStore(ENTITY_STORE)
    // mismo claim/op para todos; la COLUMNA sale del mapeo de cada dataset
    expect((m.get('pi04.asistencia') as Policy).predicates).toEqual([{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }])
    expect((m.get('pi04.licencia') as Policy).predicates).toEqual([{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }])
    expect((m.get('dbo.fct_asistencia_dia') as Policy).predicates).toEqual([{ kind: 'membership', column: 'area_name', claim: 'groups', op: 'in' }])
    // referencia abierta
    expect(isPublic(m.get('dim_area')!)).toBe(true)
  })

  it('EQUIVALENCIA: la forma entidad produce el MISMO mapa que la legacy por-tabla', () => {
    const fromEntity = resolveEntityStore(ENTITY_STORE)
    const fromLegacy = parsePolicyStore({
      policies: [
        { dataset: 'pi04.asistencia', rls: [{ column: 'area', claim: 'groups', op: 'in' }] },
        { dataset: 'pi04.empleado', rls: [{ column: 'area', claim: 'groups', op: 'in' }] },
        { dataset: 'pi04.licencia', rls: [{ column: 'area', claim: 'groups', op: 'in' }] },
        { dataset: 'dbo.fct_asistencia_dia', rls: [{ column: 'area_name', claim: 'groups', op: 'in' }] },
        { dataset: 'dim_area', grant: 'all' },
      ],
    })
    expect([...fromEntity.entries()].sort()).toEqual([...fromLegacy.entries()].sort())
  })

  it('parsePolicyStore despacha ambas formas al mismo tipo de mapa', () => {
    expect([...parsePolicyStore(ENTITY_STORE).keys()].sort()).toEqual(
      ['dbo.fct_asistencia_dia', 'dim_area', 'pi04.asistencia', 'pi04.empleado', 'pi04.licencia'],
    )
  })

  it('autoría única: cambiar el claim de la entidad re-gobierna TODOS sus datasets', () => {
    const changed = {
      ...ENTITY_STORE,
      entities: [{ entity: 'empleado', governed_by: [{ dimension: 'area', claim: 'departamentos', op: 'in' }] }],
    }
    const m = resolveEntityStore(changed)
    // un solo edit (la entidad) → los 4 datasets cambian de claim
    for (const ds of ['pi04.asistencia', 'pi04.empleado', 'pi04.licencia', 'dbo.fct_asistencia_dia']) {
      expect((m.get(ds) as Policy).predicates[0].claim).toBe('departamentos')
    }
  })
})

describe('Store entidad-canónico · fail-closed', () => {
  it('dataset que realiza una entidad inexistente → lanza', () => {
    expect(() => resolveEntityStore({ entities: [], datasets: [{ dataset: 'x', realizes: 'fantasma', dimensions: {} }] })).toThrow(/unknown-entity|catálogo|fantasma/i)
  })
  it('dimensión gobernante sin mapear en el dataset → lanza', () => {
    expect(() =>
      resolveEntityStore({
        entities: [{ entity: 'empleado', governed_by: [{ dimension: 'area', claim: 'groups', op: 'in' }] }],
        datasets: [{ dataset: 'x', realizes: 'empleado', dimensions: {} }], // falta area
      }),
    ).toThrow(/dimension-unmapped|no mapea|mapea esa dimensión/i)
  })
  it('entidad sin dimensiones de gobierno (y dataset que la realiza) → lanza', () => {
    expect(() =>
      resolveEntityStore({ entities: [{ entity: 'e', governed_by: [] }], datasets: [{ dataset: 'x', realizes: 'e', dimensions: {} }] }),
    ).toThrow(/ungoverned|no declara dimensiones|grant: all/i)
  })
  it('grant + realizes a la vez → lanza; dataset sin grant ni realizes → lanza', () => {
    expect(() => resolveEntityStore({ datasets: [{ dataset: 'x', realizes: 'e', grant: 'all' }] })).toThrow(VergisError)
    expect(() => resolveEntityStore({ datasets: [{ dataset: 'x' }] })).toThrow(/no-realizes|no declara/i)
  })
  it('grant distinto de all, entidad duplicada, op inválido → lanzan', () => {
    expect(() => resolveEntityStore({ datasets: [{ dataset: 'x', grant: 'partial' }] })).toThrow(/grant/i)
    expect(() => resolveEntityStore({ entities: [{ entity: 'e' }, { entity: 'e' }] })).toThrow(/duplicate|más de una vez/i)
    expect(() =>
      resolveEntityStore({
        entities: [{ entity: 'e', governed_by: [{ dimension: 'a', claim: 'c', op: 'between' }] }],
        datasets: [{ dataset: 'x', realizes: 'e', dimensions: { a: 'col' } }],
      }),
    ).toThrow(/op/i)
  })
})

describe('Policy store · clave raíz ausente vs «declara cero» (#117)', () => {
  it('doc sin ninguna clave raíz → root-missing', () => {
    for (const doc of [{}, null, undefined, { otra: 1 }] as never[]) {
      expect(() => parsePolicyStore(doc)).toThrow(/no declara ninguna clave raíz/)
    }
    try {
      parsePolicyStore({})
      expect.unreachable('debió lanzar')
    } catch (e) {
      expect(e).toBeInstanceOf(VergisError)
      expect((e as VergisError & { detail?: { code?: string } }).message).toMatch(/policies/)
    }
  })

  it('policies: [] → mapa vacío deliberado (legítimo)', () => {
    expect(parsePolicyStore({ policies: [] }).size).toBe(0)
    expect(parsePolicyStore({ entities: [], datasets: [] }).size).toBe(0)
  })

  it('clave raíz presente pero nula → error de tipo nombrando la clave', () => {
    expect(() => parsePolicyStore({ policies: null } as never)).toThrow(/'policies' debe ser una lista/)
    expect(() => parsePolicyStore({ entities: null, datasets: [] } as never)).toThrow(/'entities' debe ser una lista/)
    expect(() => parsePolicyStore({ datasets: 'x' } as never)).toThrow(/'datasets' debe ser una lista/)
  })
})

describe('Store entidad-canónico · end-to-end (entidad → resolve → compila → enforce)', () => {
  type Row = Record<string, unknown>
  const ROWS_CH: Row[] = [{ area: 'Finanzas' }, { area: 'Producción' }]
  const ROWS_FAB: Row[] = [{ area_name: 'Finanzas' }, { area_name: 'Producción' }]

  it('la misma entidad enforça correcto en ambos motores, con su columna física', () => {
    const m = resolveEntityStore(ENTITY_STORE)
    // ClickHouse sobre pi04.asistencia (columna `area`)
    const chPol = m.get('pi04.asistencia') as Policy
    const chEnf = compileClickHouse(chPol, { database: 'pi04', table: 'asistencia', role: 'consumer_role' })!
    const chSeen = ROWS_CH.filter((r) => emulate(chEnf, requestSettings(chEnf, { groups: ['Finanzas'] }), r))
    expect(chSeen).toEqual([{ area: 'Finanzas' }])
    // Fabric sobre dbo.fct_asistencia_dia (columna `area_name`)
    const fabPol = m.get('dbo.fct_asistencia_dia') as Policy
    const fabEnf = compileFabric(fabPol, { schema: 'dbo', table: 'fct_asistencia_dia' })!
    const fabSeen = ROWS_FAB.filter((r) => emulateFabric(fabEnf, settingsForInjections(fabEnf.injections, { groups: ['Finanzas'] }), r))
    expect(fabSeen).toEqual([{ area_name: 'Finanzas' }])
    expect(fabEnf.setupSQL.join('\n')).toContain('(area_name) ON [dbo].[fct_asistencia_dia]')
  })
})
