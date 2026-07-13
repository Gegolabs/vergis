import { describe, it, expect, vi } from 'vitest'
import { verifyFabricServability, type PiVerdict, type VerifiablePi, type SourceState } from '../server/engines/fabric'
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

/** Estado fake de una conexión: tablas protegidas + linaje (default sin vistas). */
const src = (tables: string[], lineage: Record<string, string[]> = {}): SourceState => ({
  protectedTables: new Set(tables),
  viewLineage: new Map(Object.entries(lineage)),
})

/** Ejecutor fake: por conexión, su estado — o un throw (conexión caída). */
function executor(byRef: Record<string, SourceState | Error>) {
  return vi.fn(async (ref: string): Promise<SourceState> => {
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
      sourceStateOf: executor({
        wh_finanzas: src([]), // artefacto AUSENTE (definitivo)
        wh_comercial: src(['dbo.ventas']),
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
      wh_finanzas: src(['dbo.saldos']),
      wh_comercial: src(['dbo.ventas']),
      wh_zombie: new Error('login failed: capacidad expirada'), // declarada, sin PI que la use
    })
    const { state, usedRefs } = await verifyFabricServability({ pis: [PI_A, PI_B], store: STORE, sourceStateOf: exec })
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
      sourceStateOf: executor({
        wh_finanzas: new Error('warehouse pausado'),
        wh_comercial: src(['dbo.ventas']),
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
      sourceStateOf: executor({ wh_finanzas: new Error('login failed') }),
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
      sourceStateOf: executor({ wh_finanzas: src([]) }), // respondió: el artefacto NO está
      previous,
    })
    expect(verdictOf(state, 'pi-a').ok).toBe(false)
  })

  it('un PI ya degradado NO se resucita por indeterminación (solo un veredicto definitivo lo sirve)', async () => {
    const previous = new Map<string, PiVerdict>([['pi-a', { ok: false, reason: 'tabla sin artefacto' }]])
    const { state } = await verifyFabricServability({
      pis: [PI_A],
      store: STORE,
      sourceStateOf: executor({ wh_finanzas: new Error('timeout') }),
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
      sourceStateOf: executor({}),
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
      sourceStateOf: executor({ wh_finanzas: src(['dbo.saldos']), wh_comercial: src(['dbo.ventas']) }),
    })
    expect(verdictOf(ok.state, 'pi-m').ok).toBe(true)
    const parcial = await verifyFabricServability({
      pis: [multi],
      store: STORE,
      // la ref viva NO tiene la tabla faltante, pero la caída podría tenerla → indeterminado (conserva previo sano)
      sourceStateOf: executor({ wh_finanzas: src(['dbo.saldos']), wh_comercial: new Error('caída') }),
      previous: new Map<string, PiVerdict>([['pi-m', { ok: true }]]),
    })
    expect(verdictOf(parcial.state, 'pi-m').ok).toBe(true)
  })
})

describe('fabric · herencia de gobierno vista→base (issue #54)', () => {
  const PI_VISTA: VerifiablePi = { slug: 'pi-v', tables: ['dbo.v_saldos'], databaseRefs: ['wh'] }

  it('criterio de aceptación: la vista sirve SIN entrada propia ni secpol, heredando de la base — y se reporta', async () => {
    const { state, inherited } = await verifyFabricServability({
      pis: [PI_VISTA],
      store: STORE, // v_saldos NO está en el store
      sourceStateOf: executor({ wh: src(['dbo.saldos'], { 'dbo.v_saldos': ['dbo.saldos'] }) }), // secpol solo en la BASE
    })
    expect(verdictOf(state, 'pi-v').ok).toBe(true)
    expect(inherited).toEqual([{ slug: 'pi-v', view: 'dbo.v_saldos', bases: ['dbo.saldos'] }]) // para el log del gate
  })

  it('la base gobernada SIN secpol bloquea la vista (la herencia no salta la verificación)', async () => {
    const { state } = await verifyFabricServability({
      pis: [PI_VISTA],
      store: STORE,
      sourceStateOf: executor({ wh: src([], { 'dbo.v_saldos': ['dbo.saldos'] }) }), // linaje sí, secpol no
    })
    const v = verdictOf(state, 'pi-v')
    expect(v.ok).toBe(false)
    expect((v as { reason: string }).reason).toContain('dbo.saldos') // el faltante es la BASE
  })

  it('sin linaje derivable (vista no schemabound / cross-db / tabla suelta) → fail-closed con motivo accionable', async () => {
    const { state } = await verifyFabricServability({
      pis: [PI_VISTA],
      store: STORE,
      sourceStateOf: executor({ wh: src(['dbo.saldos']) }), // la fuente no reporta linaje para v_saldos
    })
    const v = verdictOf(state, 'pi-v')
    expect(v.ok).toBe(false)
    expect((v as { reason: string }).reason).toContain('dbo.v_saldos')
    expect((v as { reason: string }).reason).toContain('sin linaje')
  })

  it('una base intermedia SIN política ni linaje corta la herencia (certeza o nada)', async () => {
    const { state } = await verifyFabricServability({
      pis: [PI_VISTA],
      store: STORE,
      // v_saldos → staging.raw (sin política, sin linaje) — no se hereda a ciegas
      sourceStateOf: executor({ wh: src(['dbo.saldos'], { 'dbo.v_saldos': ['staging.raw'] }) }),
    })
    expect(verdictOf(state, 'pi-v').ok).toBe(false)
  })

  it('herencia TRANSITIVA (vista sobre vista) resuelve hasta las bases gobernadas; un ciclo no cuelga', async () => {
    const transitiva = await verifyFabricServability({
      pis: [{ slug: 'pi-v2', tables: ['dbo.v2'], databaseRefs: ['wh'] }],
      store: STORE,
      sourceStateOf: executor({ wh: src(['dbo.saldos'], { 'dbo.v2': ['dbo.v1'], 'dbo.v1': ['dbo.saldos'] }) }),
    })
    expect(verdictOf(transitiva.state, 'pi-v2').ok).toBe(true)
    expect(transitiva.inherited[0]?.bases).toEqual(['dbo.saldos'])
    const ciclo = await verifyFabricServability({
      pis: [{ slug: 'pi-c', tables: ['dbo.va'], databaseRefs: ['wh'] }],
      store: STORE,
      sourceStateOf: executor({ wh: src(['dbo.saldos'], { 'dbo.va': ['dbo.vb'], 'dbo.vb': ['dbo.va'] }) }),
    })
    expect(verdictOf(ciclo.state, 'pi-c').ok).toBe(false) // ciclo sin hoja gobernada → fail-closed
  })

  it('vista sobre DOS bases: hereda solo si TODAS están gobernadas y protegidas', async () => {
    const lineage = { 'dbo.v_mix': ['dbo.saldos', 'dbo.ventas'] }
    const ok = await verifyFabricServability({
      pis: [{ slug: 'pi-mix', tables: ['dbo.v_mix'], databaseRefs: ['wh'] }],
      store: STORE,
      sourceStateOf: executor({ wh: src(['dbo.saldos', 'dbo.ventas'], lineage) }),
    })
    expect(verdictOf(ok.state, 'pi-mix').ok).toBe(true)
    const falta = await verifyFabricServability({
      pis: [{ slug: 'pi-mix', tables: ['dbo.v_mix'], databaseRefs: ['wh'] }],
      store: STORE,
      sourceStateOf: executor({ wh: src(['dbo.saldos'], lineage) }), // ventas sin secpol
    })
    expect(verdictOf(falta.state, 'pi-mix').ok).toBe(false)
  })

  it('el linaje agregado se devuelve para la visibilidad del índice (canAccess hereda)', async () => {
    const { viewLineage } = await verifyFabricServability({
      pis: [PI_VISTA],
      store: STORE,
      sourceStateOf: executor({ wh: src(['dbo.saldos'], { 'dbo.v_saldos': ['dbo.saldos'] }) }),
    })
    expect(viewLineage.get('dbo.v_saldos')).toEqual(['dbo.saldos'])
  })
})
