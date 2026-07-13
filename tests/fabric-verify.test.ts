import { describe, it, expect, vi } from 'vitest'
import { verifyFabricServability, type PiVerdict, type VerifiablePi } from '../server/engines/fabric'
import type { PolicyDecl } from '@vergis/policy'

const GOVERNED: PolicyDecl = {
  predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
  combine: 'and',
  default: 'deny',
}

const STORE = new Map<string, PolicyDecl>([
  ['dbo.saldos', GOVERNED],
  ['dbo.ventas', GOVERNED],
])

const PI_A: VerifiablePi = { slug: 'pi-a', tables: ['dbo.saldos'], databaseRefs: ['wh_finanzas'] }
const PI_B: VerifiablePi = { slug: 'pi-b', tables: ['dbo.ventas'], databaseRefs: ['wh_comercial'] }

/** Ejecutor fake: por conexión, el set de tablas protegidas — o un throw (conexión caída). */
function executor(byRef: Record<string, Set<string> | Error>) {
  return vi.fn(async (ref: string): Promise<Set<string>> => {
    const v = byRef[ref]
    if (v === undefined) throw new Error(`ref inesperada: ${ref}`)
    if (v instanceof Error) throw v
    return v
  })
}

const verdictOf = (state: Map<string, PiVerdict>, slug: string): PiVerdict => {
  const v = state.get(slug)
  if (!v) throw new Error(`sin veredicto para ${slug}`)
  return v
}

describe('fabric · verificación de servibilidad POR PI (issue #52)', () => {
  it('romper la RLS de un PI deja el otro sirviendo (radio de daño = el PI, no el proceso)', async () => {
    const { state } = await verifyFabricServability({
      pis: [PI_A, PI_B],
      store: STORE,
      protectedTablesOf: executor({
        wh_finanzas: new Set<string>(), // artefacto AUSENTE (definitivo)
        wh_comercial: new Set(['dbo.ventas']),
      }),
    })
    const a = verdictOf(state, 'pi-a')
    expect(a.ok).toBe(false)
    expect((a as { reason: string }).reason).toContain('dbo.saldos') // motivo accionable
    expect((a as { reason: string }).reason).toContain('SECURITY POLICY')
    expect(verdictOf(state, 'pi-b').ok).toBe(true)
  })

  it('solo consulta las conexiones EN USO: una declarada que nadie usa no puede tumbar nada', async () => {
    const exec = executor({
      wh_finanzas: new Set(['dbo.saldos']),
      wh_comercial: new Set(['dbo.ventas']),
      wh_zombie: new Error('login failed: capacidad expirada'), // declarada, sin PI que la use
    })
    const { state, usedRefs } = await verifyFabricServability({ pis: [PI_A, PI_B], store: STORE, protectedTablesOf: exec })
    expect(usedRefs.sort()).toEqual(['wh_comercial', 'wh_finanzas'])
    expect(exec).not.toHaveBeenCalledWith('wh_zombie')
    expect(verdictOf(state, 'pi-a').ok).toBe(true)
    expect(verdictOf(state, 'pi-b').ok).toBe(true)
  })

  it('INDETERMINACIÓN conserva el veredicto sano previo: una conexión caída no degrada lo que servía', async () => {
    const previous = new Map<string, PiVerdict>([['pi-a', { ok: true }], ['pi-b', { ok: true }]])
    const { state, refErrors } = await verifyFabricServability({
      pis: [PI_A, PI_B],
      store: STORE,
      protectedTablesOf: executor({
        wh_finanzas: new Error('warehouse pausado'),
        wh_comercial: new Set(['dbo.ventas']),
      }),
      previous,
    })
    expect(verdictOf(state, 'pi-a').ok).toBe(true) // conservado: el fallo es transitorio, no un veredicto
    expect(verdictOf(state, 'pi-b').ok).toBe(true)
    expect(refErrors.get('wh_finanzas')).toContain('warehouse pausado')
  })

  it('en FRÍO (sin estado previo) la indeterminación es fail-closed, con el motivo de conexión', async () => {
    const { state } = await verifyFabricServability({
      pis: [PI_A],
      store: STORE,
      protectedTablesOf: executor({ wh_finanzas: new Error('login failed') }),
    })
    const a = verdictOf(state, 'pi-a')
    expect(a.ok).toBe(false)
    expect((a as { reason: string }).reason).toContain('wh_finanzas')
    expect((a as { reason: string }).reason).toContain('login failed')
  })

  it('un veredicto DEFINITIVO gana al estado previo: nada afloja el fail-closed', async () => {
    const previous = new Map<string, PiVerdict>([['pi-a', { ok: true }]])
    const { state } = await verifyFabricServability({
      pis: [PI_A],
      store: STORE,
      protectedTablesOf: executor({ wh_finanzas: new Set<string>() }), // respondió: el artefacto NO está
      previous,
    })
    expect(verdictOf(state, 'pi-a').ok).toBe(false)
  })

  it('un PI ya degradado NO se resucita por indeterminación (solo un veredicto definitivo lo sirve)', async () => {
    const previous = new Map<string, PiVerdict>([['pi-a', { ok: false, reason: 'tabla sin artefacto' }]])
    const { state } = await verifyFabricServability({
      pis: [PI_A],
      store: STORE,
      protectedTablesOf: executor({ wh_finanzas: new Error('timeout') }),
      previous,
    })
    expect(verdictOf(state, 'pi-a').ok).toBe(false)
  })

  it('PI sin tablas gobernadas verifica trivialmente; PI con tablas pero sin database_ref queda fail-closed', async () => {
    const { state } = await verifyFabricServability({
      pis: [
        { slug: 'estatico', tables: [], databaseRefs: [] },
        { slug: 'sin-ref', tables: ['dbo.saldos'], databaseRefs: [] },
      ],
      store: STORE,
      protectedTablesOf: executor({}),
    })
    expect(verdictOf(state, 'estatico').ok).toBe(true)
    const s = verdictOf(state, 'sin-ref')
    expect(s.ok).toBe(false)
    expect((s as { reason: string }).reason).toContain('database_ref')
  })

  it('PI multi-conexión: el artefacto puede vivir en cualquiera de SUS refs; ambas caídas con faltante = indeterminado', async () => {
    const multi: VerifiablePi = { slug: 'pi-m', tables: ['dbo.saldos', 'dbo.ventas'], databaseRefs: ['wh_finanzas', 'wh_comercial'] }
    const ok = await verifyFabricServability({
      pis: [multi],
      store: STORE,
      protectedTablesOf: executor({ wh_finanzas: new Set(['dbo.saldos']), wh_comercial: new Set(['dbo.ventas']) }),
    })
    expect(verdictOf(ok.state, 'pi-m').ok).toBe(true)
    const parcial = await verifyFabricServability({
      pis: [multi],
      store: STORE,
      // la ref viva NO tiene la tabla faltante, pero la caída podría tenerla → indeterminado (conserva previo sano)
      protectedTablesOf: executor({ wh_finanzas: new Set(['dbo.saldos']), wh_comercial: new Error('caída') }),
      previous: new Map<string, PiVerdict>([['pi-m', { ok: true }]]),
    })
    expect(verdictOf(parcial.state, 'pi-m').ok).toBe(true)
  })
})
