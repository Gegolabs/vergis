import { describe, it, expect, vi } from 'vitest'
import { verifyFabricServability, maskViewCandidates, type PiVerdict, type VerifiablePi, type SourceState } from '../server/engines/fabric'
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

/** Estado fake de una conexión: tablas protegidas + linaje (default sin vistas). El 4º argumento es
 *  el linaje de vistas NO-schemabound (H8): observado, pero sin poder de herencia por sí mismo. */
const src = (
  tables: string[],
  lineage: Record<string, string[]> = {},
  unbound: Record<string, string[]> = {},
): SourceState => ({
  protectedTables: new Set(tables),
  viewLineage: new Map(Object.entries(lineage)),
  unboundViewLineage: new Map(Object.entries(unbound)),
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

// --- Vista de máscara servible (issue #163 H8) --------------------------------
//
// La vista de máscara NO es schemabound a propósito (serlo tomaría rehén la proyección — #164), así
// que el gate la rechazaba: capacidad inalcanzable. Se reconoce por DECLARACIÓN del emisor +
// CORROBORACIÓN en la fuente + COHERENCIA con el store, jamás por el nombre. Estos tests fijan las
// dos mitades: que la declarada sirva, y —el control que traza la línea— que cualquier OTRA vista
// no-schemabound siga sin heredar nada.
describe('fabric · vista de máscara servible (issue #163 H8)', () => {
  /** Base con reglas de COLUMNA: es la condición bajo la que el emisor emite la vista de máscara. */
  const CON_COLUMNAS: PolicyDecl = { ...GOVERNED, columnRules: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }
  const STORE_MASK = new Map<string, PolicyDecl>([
    ['dbo.saldos', CON_COLUMNAS],
    ['dbo.ventas', GOVERNED], // gobernada pero SIN reglas de columna
  ])
  const DECL = [{ view: '[dbo].[vw_mask_saldos]', base: '[dbo].[saldos]' }] // como lo declara el emisor
  const PI_MASK: VerifiablePi = { slug: 'pi-mask', tables: ['dbo.vw_mask_saldos'], databaseRefs: ['wh'] }
  /** La fuente ve la vista de máscara como NO-schemabound sobre su base. */
  const fuente = (protegidas: string[], unbound: Record<string, string[]> = { 'dbo.vw_mask_saldos': ['dbo.saldos'] }) =>
    executor({ wh: src(protegidas, {}, unbound) })

  it('criterio de aceptación: un PI que nombra la vista de máscara ES servible y hereda el gobierno de su base', async () => {
    const { state, inherited, viewLineage } = await verifyFabricServability({
      pis: [PI_MASK],
      store: STORE_MASK,
      sourceStateOf: fuente(['dbo.saldos']),
      maskViews: DECL,
    })
    expect(verdictOf(state, 'pi-mask').ok).toBe(true)
    expect(inherited).toEqual([{ slug: 'pi-mask', view: 'dbo.vw_mask_saldos', bases: ['dbo.saldos'], via: 'mask-view' }])
    // El linaje devuelto alimenta la visibilidad del índice: servible pero invisible no sirve.
    expect(viewLineage.get('dbo.vw_mask_saldos')).toEqual(['dbo.saldos'])
  })

  it('EL CONTROL: una vista no-schemabound cualquiera (no declarada) sigue SIN heredar — la línea no se movió', async () => {
    const { state } = await verifyFabricServability({
      pis: [{ slug: 'pi-colada', tables: ['dbo.v_colada'], databaseRefs: ['wh'] }],
      store: STORE_MASK,
      // La fuente la ve leyendo una base gobernada Y protegida; le falta lo único que importa: nadie
      // la declaró. Sin esta negativa el hito sería un agujero con forma de capacidad.
      sourceStateOf: fuente(['dbo.saldos'], { 'dbo.v_colada': ['dbo.saldos'] }),
      maskViews: DECL,
    })
    const v = verdictOf(state, 'pi-colada')
    expect(v.ok).toBe(false)
    expect((v as { reason: string }).reason).toContain('sin linaje')
  })

  it('el nombre NO es el reconocedor: una vista LLAMADA vw_mask_* sin declaración no pasa', async () => {
    const { state } = await verifyFabricServability({
      pis: [{ slug: 'pi-falsa', tables: ['dbo.vw_mask_ventas'], databaseRefs: ['wh'] }],
      store: STORE_MASK,
      sourceStateOf: fuente(['dbo.saldos', 'dbo.ventas'], { 'dbo.vw_mask_ventas': ['dbo.ventas'] }),
      maskViews: DECL, // declara vw_mask_saldos, NO vw_mask_ventas
    })
    expect(verdictOf(state, 'pi-falsa').ok).toBe(false)
  })

  it('la RLS de la BASE manda: base sin SECURITY POLICY ⇒ la vista de máscara no se sirve', async () => {
    const { state } = await verifyFabricServability({
      pis: [PI_MASK],
      store: STORE_MASK,
      sourceStateOf: fuente([]), // linaje corroborado, pero la base no tiene secpol
      maskViews: DECL,
    })
    const v = verdictOf(state, 'pi-mask')
    expect(v.ok).toBe(false)
    expect((v as { reason: string }).reason).toContain('dbo.saldos') // el faltante es la BASE
    expect((v as { reason: string }).reason).toContain('SECURITY POLICY')
  })

  it('la vista de máscara NO filtra filas: el gobierno exigido es el de la base, no uno propio de la vista', async () => {
    // La vista protegida y la base NO: sigue no-servible. Una secpol sobre la vista jamás sustituye
    // a la de la tabla (la vista no lleva WHERE; el filtro de fila vive en la security policy base).
    const { state } = await verifyFabricServability({
      pis: [PI_MASK],
      store: STORE_MASK,
      sourceStateOf: fuente(['dbo.vw_mask_saldos']),
      maskViews: DECL,
    })
    expect(verdictOf(state, 'pi-mask').ok).toBe(false)
  })

  it('declaración que MIENTE sobre su base (o sobre una vista que la fuente no ve) → fail-closed con el motivo', async () => {
    const miente = await verifyFabricServability({
      pis: [PI_MASK],
      store: STORE_MASK,
      // la fuente la ve leyendo OTRA cosa que la declarada
      sourceStateOf: fuente(['dbo.saldos', 'dbo.ventas'], { 'dbo.vw_mask_saldos': ['dbo.ventas'] }),
      maskViews: DECL,
    })
    const m = verdictOf(miente.state, 'pi-mask')
    expect(m.ok).toBe(false)
    expect((m as { reason: string }).reason).toContain('dbo.ventas') // dice qué vio la fuente
    const ausente = await verifyFabricServability({
      pis: [PI_MASK],
      store: STORE_MASK,
      sourceStateOf: fuente(['dbo.saldos'], {}), // la fuente no reporta la vista
      maskViews: DECL,
    })
    const a = verdictOf(ausente.state, 'pi-mask')
    expect(a.ok).toBe(false)
    expect((a as { reason: string }).reason).toContain('la fuente no reporta esa vista')
  })

  it('vista de máscara sobre una base SIN reglas de columna: declaración rancia → no se admite', async () => {
    const { state } = await verifyFabricServability({
      pis: [{ slug: 'pi-v2', tables: ['dbo.vw_mask_ventas'], databaseRefs: ['wh'] }],
      store: STORE_MASK, // dbo.ventas no declara columnRules → el emisor no habría emitido vista
      sourceStateOf: fuente(['dbo.ventas'], { 'dbo.vw_mask_ventas': ['dbo.ventas'] }),
      maskViews: [{ view: 'dbo.vw_mask_ventas', base: 'dbo.ventas' }],
    })
    const v = verdictOf(state, 'pi-v2')
    expect(v.ok).toBe(false)
    expect((v as { reason: string }).reason).toContain('reglas de columna')
  })

  it('una vista declarada dos veces con bases distintas se rechaza entera (no hay last-wins de gobierno)', async () => {
    const { state } = await verifyFabricServability({
      pis: [PI_MASK],
      store: STORE_MASK,
      sourceStateOf: fuente(['dbo.saldos']),
      maskViews: [...DECL, { view: 'dbo.vw_mask_saldos', base: 'dbo.ventas' }],
    })
    expect(verdictOf(state, 'pi-mask').ok).toBe(false)
  })

  it('SIN declaraciones el gate se comporta igual que antes de H8 (la capacidad es opt-in)', async () => {
    const { state } = await verifyFabricServability({
      pis: [PI_MASK],
      store: STORE_MASK,
      sourceStateOf: fuente(['dbo.saldos']),
    })
    expect(verdictOf(state, 'pi-mask').ok).toBe(false)
  })

  it('REGRESIÓN: la vista-contrato SCHEMABINDING de hoy se comporta idéntica, con o sin declaraciones', async () => {
    const bound = { 'dbo.v_saldos': ['dbo.saldos'] }
    const pis = [{ slug: 'pi-v', tables: ['dbo.v_saldos'], databaseRefs: ['wh'] }]
    for (const maskViews of [undefined, DECL]) {
      const { state, inherited, viewLineage } = await verifyFabricServability({
        pis,
        store: STORE_MASK,
        sourceStateOf: executor({ wh: src(['dbo.saldos'], bound, { 'dbo.vw_mask_saldos': ['dbo.saldos'] }) }),
        maskViews,
      })
      expect(verdictOf(state, 'pi-v').ok).toBe(true)
      // Forma LITERAL de siempre: sin campo `via` en la herencia clásica.
      expect(inherited).toEqual([{ slug: 'pi-v', view: 'dbo.v_saldos', bases: ['dbo.saldos'] }])
      expect(viewLineage.get('dbo.v_saldos')).toEqual(['dbo.saldos'])
    }
  })
})

// === LA DERIVACIÓN DE CANDIDATAS (el cable, #163·H8) =========================
// El gate no se entera solo de qué vistas de máscara existen: alguien tiene que declararlas. Acá se
// fija que la derivación produce CANDIDATAS —no admisiones— y que no inventa ninguna donde no hay
// reglas de columna.
describe('fabric · maskViewCandidates', () => {
  const REGLA: PolicyDecl = { public: true, columnRules: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }
  const SIN_REGLA: PolicyDecl = { public: true }
  const GOBERNADA: PolicyDecl = {
    predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
    combine: 'and',
    default: 'deny',
  }

  it('una tabla con reglas de columna produce su candidata en el MISMO schema', () => {
    expect(maskViewCandidates(new Map([['dbo.empleado', REGLA]]))).toEqual([
      { view: 'dbo.vw_mask_empleado', base: 'dbo.empleado' },
    ])
    expect(maskViewCandidates(new Map([['pi04.empleado', REGLA]]))).toEqual([
      { view: 'pi04.vw_mask_empleado', base: 'pi04.empleado' },
    ])
  })

  // CONTROL: sin este caso, una derivación que devolviera candidata para TODA tabla pasaría el test
  // de arriba y le daría al gate un montón de declaraciones falsas que corroborar.
  it('CONTROL: una tabla SIN reglas de columna no produce candidata — ni pública ni gobernada', () => {
    expect(maskViewCandidates(new Map<string, PolicyDecl>([['dbo.areas', SIN_REGLA], ['dbo.saldos', GOBERNADA]]))).toEqual([])
  })

  it('store vacío ⇒ ninguna candidata (el gate se comporta como antes de H8)', () => {
    expect(maskViewCandidates(new Map())).toEqual([])
  })

  it('mezcla: solo las que declaran reglas', () => {
    const cands = maskViewCandidates(new Map<string, PolicyDecl>([['dbo.a', REGLA], ['dbo.b', SIN_REGLA], ['dbo.c', REGLA]]))
    expect(cands.map((c) => c.base)).toEqual(['dbo.a', 'dbo.c'])
  })
})

describe('fabric · #238 · la precondición de desenmascarado', () => {
  const CON_COLUMNA: PolicyDecl = {
    predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
    combine: 'and',
    default: 'deny',
    columnRules: [{ column: 'rut', claim: 've_pii', action: 'mask' }],
  }
  const STORE_COL = new Map<string, PolicyDecl>([['dbo.saldos', CON_COLUMNA], ['dbo.ventas', GOVERNED]])
  const conUnmask = (tables: string[], unmask?: 'capable' | 'incapable' | 'uninstrumented'): SourceState => ({
    protectedTables: new Set(tables),
    viewLineage: new Map(),
    unboundViewLineage: new Map(),
    ...(unmask ? { unmask } : {}),
  })
  const correr = (unmask: 'capable' | 'incapable' | 'uninstrumented' | undefined, previous?: Map<string, PiVerdict>) =>
    verifyFabricServability({
      pis: [PI_A, PI_B],
      store: STORE_COL,
      sourceStateOf: executor({
        wh_finanzas: conUnmask(['dbo.saldos'], unmask),
        wh_comercial: conUnmask(['dbo.ventas'], unmask),
      }),
      previous,
    })

  it('capacidad PRESENTE → el PI con reglas de columna sirve', async () => {
    const { state } = await correr('capable')
    expect(verdictOf(state, 'pi-a').ok).toBe(true)
  })

  it('capacidad MEDIDA AUSENTE → veredicto DEFINITIVO de no-servible, con la causa y la remediación', async () => {
    const { state } = await correr('incapable')
    const v = verdictOf(state, 'pi-a')
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reason).toContain('NO puede desenmascarar')
    expect(v.reason).toContain('#238')
    expect(v.reason).toContain('contrato de instancia')
  })

  it('capacidad medida ausente GANA sobre un veredicto sano previo — ningún camino afloja el fail-closed', async () => {
    const previo = new Map<string, PiVerdict>([['pi-a', { ok: true }]])
    const { state } = await correr('incapable', previo)
    expect(verdictOf(state, 'pi-a').ok).toBe(false)
  })

  it('SIN INSTRUMENTO ≠ ausente: es indeterminación, y el PI que YA servía conserva su veredicto', async () => {
    const previo = new Map<string, PiVerdict>([['pi-a', { ok: true }]])
    const { state } = await correr('uninstrumented', previo)
    expect(verdictOf(state, 'pi-a').ok).toBe(true) // validate-before-swap: no se castiga una migración pendiente
    const frio = await correr('uninstrumented') // en frío, fail-closed con la remediación
    const v = verdictOf(frio.state, 'pi-a')
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reason).toContain('no está instalado')
    expect(v.reason).toContain('Regenera y re-aplica')
  })

  it('un PI SIN reglas de columna no se ve afectado por la capacidad, ni siquiera medida ausente', async () => {
    const { state } = await correr('incapable')
    expect(verdictOf(state, 'pi-b').ok).toBe(true) // dbo.ventas no declara plano de columna
  })

  it('si el llamador NO produce la capacidad, el gate se comporta EXACTAMENTE como antes de #238', async () => {
    const { state } = await correr(undefined)
    expect(verdictOf(state, 'pi-a').ok).toBe(true)
    expect(verdictOf(state, 'pi-b').ok).toBe(true)
  })
})
