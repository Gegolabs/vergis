// Gobernanza data-anchored · el POLICY STORE (charter §2a). La política vive atada al DATO,
// no en el reporte. La accesibilidad la deciden SOLO estas políticas; no existe `public` como
// flag del reporte — abrir es una decisión explícita y gobernada (`grant: all`). Default-deny:
// un dataset sin entrada queda sin política (el server no le concede acceso).

import { describe, expect, it } from 'vitest'
import { VergisError } from '@vergis/botler'
import { compileClickHouse, emulate, isPublic, parsePolicyStore, requestSettings, type Policy } from '@vergis/policy'

const TARGET = { database: 'vergis', table: 'areas', role: 'consumer_role' }
type Row = { area: string }
const STORE_ROWS: Row[] = [{ area: 'Producción' }, { area: 'Finanzas' }, { area: 'Comercial' }]

describe('Policy store · la política vive atada al dato', () => {
  it('rls: [...] → política de filas (filtra por claim)', () => {
    const m = parsePolicyStore({ policies: [{ dataset: 'vergis.areas', rls: [{ column: 'area', claim: 'groups', op: 'in' }], default: 'deny' }] })
    const policy = m.get('vergis.areas')!
    expect(isPublic(policy)).toBe(false)
    const enf = compileClickHouse(policy as Policy, TARGET)!
    const settings = requestSettings(enf, { groups: ['Finanzas'] })
    const visibles = STORE_ROWS.filter((r) => emulate(enf, settings, r as unknown as Record<string, unknown>))
    expect(visibles.map((r) => r.area)).toEqual(['Finanzas'])
  })

  it('grant: all → apertura explícita gobernada (sin restricción de fila)', () => {
    const m = parsePolicyStore({ policies: [{ dataset: 'vergis.areas', grant: 'all' }] })
    const policy = m.get('vergis.areas')!
    expect(isPublic(policy)).toBe(true)
    expect(compileClickHouse(policy, TARGET)).toBeNull() // sin row policy → el consumidor (con SELECT) ve todo
  })

  it('`public` NO existe como política — se rechaza (abrir es grant: all)', () => {
    expect(() => parsePolicyStore({ policies: [{ dataset: 'vergis.areas', rls: 'public' }] })).toThrow(VergisError)
  })

  it('una entrada sin rls ni grant se rechaza (la omisión es deny: no declares la entrada)', () => {
    expect(() => parsePolicyStore({ policies: [{ dataset: 'vergis.areas' }] })).toThrow(/no declara/)
  })

  it('rls y grant juntos se rechazan (decisión ambigua)', () => {
    expect(() => parsePolicyStore({ policies: [{ dataset: 'x', rls: [], grant: 'all' }] })).toThrow(VergisError)
  })

  it('default-deny: un dataset sin entrada en el store queda sin política', () => {
    const m = parsePolicyStore({ policies: [{ dataset: 'vergis.areas', grant: 'all' }] })
    expect(m.get('otra.tabla')).toBeUndefined() // el server no le concede acceso → deny
  })
})
