import { describe, it, expect, vi } from 'vitest'
import {
  runSelfCheck,
  publishSpec,
  PublishBlocked,
  type AnthropicTransport,
  type AnthropicResponse,
  type PublishStore,
} from '@vergis/miranda'
import { SqliteGovernanceStore } from '@vergis/capabilities'

/** Transporte fake que responde con un tool_use emit_qc_report del contenido dado. */
function judgeTransport(report: unknown): AnthropicTransport {
  return {
    async createMessage(): Promise<AnthropicResponse> {
      return {
        id: 'm', role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'emit_qc_report', input: report }],
        stop_reason: 'tool_use', usage: { input_tokens: 50, output_tokens: 20 },
      }
    },
  }
}

const goodDraft = 'mira_version: "1.0"\nidentity:\n  id: saldos\n  display_name: Saldos\n  classification: internal'
const intent = JSON.stringify({ titulo: 'Saldos', pregunta_de_negocio: '¿cuánto?', audiencia: 'finanzas', grano: 'empresa' })

describe('WP5 · self-check (juez separado)', () => {
  it('draft bueno → APROBADA, sin brechas', async () => {
    const r = await runSelfCheck({ transport: judgeTransport({ veredicto: 'APROBADA', brechas: [] }), model: 'm', draftYaml: goodDraft, intentSummary: intent, probeContext: 'perfil clasificacion: TC(7)' })
    expect(r.veredicto).toBe('APROBADA')
    expect(r.brechas).toEqual([])
  })
  it('filtro literal roto vs perfil → M detectada', async () => {
    const r = await runSelfCheck({
      transport: judgeTransport({ veredicto: 'NO_APROBABLE', brechas: [{ id: 'M1', sev: 'M', brecha: "filtro 'TC' no calza con 'TC ' del perfil", donde: 'data.saldos.sql', recomendacion: 'usar el valor real con espacio' }] }),
      model: 'm', draftYaml: goodDraft, intentSummary: intent, probeContext: "perfil: 'TC ' (con espacio)",
    })
    expect(r.brechas[0].sev).toBe('M')
  })
  it('medida sin reconciliación → M', async () => {
    const r = await runSelfCheck({ transport: judgeTransport({ veredicto: 'APROBABLE', brechas: [{ id: 'M2', sev: 'M', brecha: 'medida sin probe de reconciliación', donde: 'medidas[0]', recomendacion: 'agregar una probe' }] }), model: 'm', draftYaml: goodDraft, intentSummary: intent })
    expect(r.brechas[0].sev).toBe('M')
  })
  it('veredicto/severidad fuera de vocabulario → se normaliza (NO_REVISABLE / i)', async () => {
    const r = await runSelfCheck({ transport: judgeTransport({ veredicto: 'PERFECTO', brechas: [{ id: 'x', sev: 'CRITICA', brecha: 'a', donde: 'b', recomendacion: 'c' }] }), model: 'm', draftYaml: goodDraft, intentSummary: intent })
    expect(r.veredicto).toBe('NO_REVISABLE')
    expect(r.brechas[0].sev).toBe('i')
  })
  it('si el juez no emite reporte estructurado → NO_REVISABLE con brecha B', async () => {
    const transport: AnthropicTransport = { async createMessage() { return { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'no usé la tool' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } } }
    const r = await runSelfCheck({ transport, model: 'm', draftYaml: goodDraft, intentSummary: intent })
    expect(r.veredicto).toBe('NO_REVISABLE')
    expect(r.brechas[0].sev).toBe('B')
  })
})

// Plan 100 · addendum: cruce en CÓDIGO de database_ref contra los perfiles configurados. El bug del
// arnés (2026-07-17): Miranda copió `database_ref: fabric-lh-qw04` de un EJEMPLO del documento DSL, el
// juez-modelo lo dio por bueno (no conoce los perfiles) y la preview reventó con 500 al servir. La
// baranda es este cruce: ref inexistente → brecha BLOQUEANTE accionable (causa + refs válidas), para
// que el autor se auto-corrija en el mismo turno, antes de la preview.
describe('plan 100 addendum · self-check cruza database_ref contra los perfiles configurados', () => {
  const draftConRef = (ref: string) => `mira_version: "1.0"
identity:
  id: saldos
  display_name: Saldos
  classification: internal
data:
  saldos:
    capability: execute-sql-dwh
    params:
      database_ref: ${ref}
      sql: "SELECT empresa, saldo FROM dbo.v_saldos"
`

  it('ref inexistente → brecha B REF-1 con mensaje accionable (causa + refs válidas) y APROBADA se degrada', async () => {
    const r = await runSelfCheck({
      transport: judgeTransport({ veredicto: 'APROBADA', brechas: [] }),
      model: 'm', draftYaml: draftConRef('fabric-lh-qw04'), intentSummary: intent,
      configuredRefs: ['finanzas', 'ventas'],
    })
    expect(r.brechas).toHaveLength(1)
    const b = r.brechas[0]
    expect(b.id).toBe('REF-1')
    expect(b.sev).toBe('B')
    expect(b.brecha).toContain("'fabric-lh-qw04'")
    expect(b.donde).toBe('data.saldos.params.database_ref')
    expect(b.recomendacion).toContain('finanzas, ventas') // le dice las refs válidas
    expect(b.recomendacion).toMatch(/catálogo/) // …y de dónde sale la correcta
    expect(r.veredicto).toBe('APROBABLE') // una B es incompatible con APROBADA
  })

  it('ref válida → pasa limpio (APROBADA sin brechas)', async () => {
    const r = await runSelfCheck({
      transport: judgeTransport({ veredicto: 'APROBADA', brechas: [] }),
      model: 'm', draftYaml: draftConRef('finanzas'), intentSummary: intent,
      configuredRefs: ['finanzas', 'ventas'],
    })
    expect(r.veredicto).toBe('APROBADA')
    expect(r.brechas).toEqual([])
  })

  it('configuredRefs undefined (llamador sin perfiles, compat) → no se cruza', async () => {
    const r = await runSelfCheck({
      transport: judgeTransport({ veredicto: 'APROBADA', brechas: [] }),
      model: 'm', draftYaml: draftConRef('fabric-lh-qw04'), intentSummary: intent,
    })
    expect(r.veredicto).toBe('APROBADA')
    expect(r.brechas).toEqual([])
  })

  it('varios datasets con refs inexistentes → IDs estables REF-1..N en orden del draft', async () => {
    const draft = `mira_version: "1.0"
identity:
  id: x
  display_name: X
  classification: internal
data:
  a:
    capability: execute-sql-dwh
    params: {database_ref: vieja-1, sql: "SELECT 1"}
  b:
    capability: execute-sql-dwh
    params: {database_ref: finanzas, sql: "SELECT 2"}
  c:
    capability: execute-sql-dwh
    params: {database_ref: vieja-2, sql: "SELECT 3"}
`
    const r = await runSelfCheck({
      transport: judgeTransport({ veredicto: 'APROBADA', brechas: [] }),
      model: 'm', draftYaml: draft, intentSummary: intent,
      configuredRefs: ['finanzas'],
    })
    expect(r.brechas.map((b) => [b.id, b.donde])).toEqual([
      ['REF-1', 'data.a.params.database_ref'],
      ['REF-2', 'data.c.params.database_ref'],
    ])
    expect(r.brechas.every((b) => b.sev === 'B')).toBe(true)
  })
})

// Plan 100 · addendum 3: el cruce de refs valida la PERTENENCIA objeto↔database_ref contra el
// catálogo. El caso que el cruce de existencia no cubre (arnés contra 0a0d45f): el modelo asoció
// «estado de resultados» con `finanzas` por semántica y declaró esa ref (que SÍ existe en los
// perfiles), pero el catálogo declara `dbo.v_movimiento → ventas` — el objeto no existe en esa base
// y el serving reventó con `Invalid object name`. La baranda: por cada objeto FROM/JOIN del SQL que
// tenga entrada de catálogo con ref declarada, la ref del dataset debe calzar; objetos fuera del
// catálogo (o catalogados sin ref) no se opinan.
describe('plan 100 addendum 3 · self-check cruza la pertenencia objeto↔ref contra el catálogo', () => {
  const CATALOG = [
    { name: 'dbo.v_movimiento', database_ref: 'ventas' },
    { name: 'dbo.v_saldos' }, // catalogado SIN ref declarada → el cruce no opina
  ]
  const REFS = ['finanzas', 'ventas']
  const draftEEFF = (paramsLine: string) => `mira_version: "1.0"
identity:
  id: eeff
  display_name: Estado de resultados
  classification: internal
data:
  resultado:
    capability: execute-sql-dwh
    params:
      ${paramsLine}
      sql: "SELECT cuenta, monto FROM dbo.v_movimiento JOIN dbo.v_saldos ON 1=1"
`

  it('ref existente pero ≠ catálogo → brecha B con el fix exacto (el caso finanzas/ventas del arnés)', async () => {
    const r = await runSelfCheck({
      transport: judgeTransport({ veredicto: 'APROBADA', brechas: [] }),
      model: 'm', draftYaml: draftEEFF(`database_ref: finanzas`), intentSummary: intent,
      configuredRefs: REFS, catalog: CATALOG,
    })
    expect(r.brechas).toHaveLength(1) // v_movimiento discrepa; v_saldos (sin ref en catálogo) no opina
    const b = r.brechas[0]
    expect(b.sev).toBe('B')
    expect(b.brecha).toMatch(/dbo\.v_movimiento.*pertenece a 'ventas' según el catálogo/)
    expect(b.brecha).toContain(`declara 'finanzas'`)
    expect(b.donde).toBe('data.resultado.params.database_ref')
    expect(b.recomendacion).toContain(`database_ref: 'ventas'`) // el fix exacto
    expect(r.veredicto).toBe('APROBABLE')
  })

  it('ref = catálogo → pasa limpio', async () => {
    const r = await runSelfCheck({
      transport: judgeTransport({ veredicto: 'APROBADA', brechas: [] }),
      model: 'm', draftYaml: draftEEFF(`database_ref: ventas`), intentSummary: intent,
      configuredRefs: REFS, catalog: CATALOG,
    })
    expect(r.veredicto).toBe('APROBADA')
    expect(r.brechas).toEqual([])
  })

  it('objeto fuera del catálogo → el cruce no opina', async () => {
    const draft = `mira_version: "1.0"
identity: {id: x, display_name: X, classification: internal}
data:
  d:
    capability: execute-sql-dwh
    params: {database_ref: finanzas, sql: "SELECT 1 FROM dbo.v_desconocida"}
`
    const r = await runSelfCheck({
      transport: judgeTransport({ veredicto: 'APROBADA', brechas: [] }),
      model: 'm', draftYaml: draft, intentSummary: intent,
      configuredRefs: REFS, catalog: CATALOG,
    })
    expect(r.brechas).toEqual([])
  })

  it('sin database_ref pero el objeto está catalogado con ref → brecha B pidiendo declararla', async () => {
    const draft = `mira_version: "1.0"
identity: {id: x, display_name: X, classification: internal}
data:
  d:
    capability: execute-sql-dwh
    params: {sql: "SELECT cuenta FROM dbo.v_movimiento"}
`
    const r = await runSelfCheck({
      transport: judgeTransport({ veredicto: 'APROBADA', brechas: [] }),
      model: 'm', draftYaml: draft, intentSummary: intent,
      configuredRefs: REFS, catalog: CATALOG,
    })
    expect(r.brechas).toHaveLength(1)
    expect(r.brechas[0].sev).toBe('B')
    expect(r.brechas[0].brecha).toMatch(/no declara database_ref.*vive en 'ventas'/)
    expect(r.brechas[0].recomendacion).toContain(`database_ref: 'ventas'`)
  })

  it('compat: sin catálogo en deps → la pertenencia no se cruza (la existencia sigue operando)', async () => {
    const r = await runSelfCheck({
      transport: judgeTransport({ veredicto: 'APROBADA', brechas: [] }),
      model: 'm', draftYaml: draftEEFF(`database_ref: finanzas`), intentSummary: intent,
      configuredRefs: REFS, // catalog: undefined
    })
    expect(r.brechas).toEqual([]) // 'finanzas' existe en los perfiles; sin catálogo no hay más que decir
  })
})

describe('WP6 · publish y su gate', () => {
  async function seededSession(state: string, opts: { qc?: unknown; draft?: string } = {}) {
    const gov = await SqliteGovernanceStore.open(null)
    await gov.createSession('s1', 'Saldos por empresa', 'ana@x.com')
    // Avanzar por la máquina de estados hasta `state`.
    const path: Record<string, string[]> = {
      borrador: ['borrador'],
      validado: ['borrador', 'validado'],
      autochequeado: ['borrador', 'validado', 'autochequeado'],
    }
    for (const st of path[state] ?? []) await gov.setMirandaState('s1', st as never)
    if (opts.draft) await gov.appendMirandaArtifact('s1', 'spec_draft', opts.draft)
    if (opts.qc !== undefined) await gov.appendMirandaArtifact('s1', 'qc_report', JSON.stringify(opts.qc))
    return gov
  }
  const deps = (gov: SqliteGovernanceStore, over: Partial<Parameters<typeof publishSpec>[1]> = {}) => ({
    store: gov,
    validateDraft: () => ({ ok: true as const }),
    writeSpec: vi.fn(async () => {}),
    now: () => '2026-07-14T00:00:00Z',
    ...over,
  })

  it('sesión autochequeada + qc sin B/M → asigna PI-101 y escribe el archivo', async () => {
    const gov = await seededSession('autochequeado', { draft: goodDraft, qc: { veredicto: 'APROBADA', brechas: [] } })
    const writeSpec = vi.fn(async (_filename: string, _content: string) => {})
    const r = await publishSpec('s1', deps(gov, { writeSpec }))
    expect(r.code).toBe('PI-101')
    expect(r.slug).toBe('pi-101')
    expect(writeSpec).toHaveBeenCalledOnce()
    const [filename, content] = writeSpec.mock.calls[0]
    expect(filename).toBe('pi101-saldos-por-empresa.yaml')
    expect(content).toContain('# PI-101 · Saldos por empresa')
    expect(content).toContain('code: PI-101') // identity.code inyectado
    expect((await gov.getMirandaSession('s1'))?.state).toBe('publicado')
    expect((await gov.getMirandaSession('s1'))?.piCode).toBe('PI-101')
  })

  it('rechaza si la sesión no está autochequeada', async () => {
    const gov = await seededSession('validado', { draft: goodDraft, qc: { veredicto: 'APROBADA', brechas: [] } })
    await expect(publishSpec('s1', deps(gov))).rejects.toBeInstanceOf(PublishBlocked)
  })

  it('rechaza si el último qc_report tiene una M abierta', async () => {
    const gov = await seededSession('autochequeado', { draft: goodDraft, qc: { veredicto: 'NO_APROBABLE', brechas: [{ id: 'M1', sev: 'M', brecha: 'x', donde: 'y', recomendacion: 'z' }] } })
    await expect(publishSpec('s1', deps(gov))).rejects.toThrow(/B\/M/)
  })

  it('rechaza si el draft no valida contra el DSL', async () => {
    const gov = await seededSession('autochequeado', { draft: 'basura', qc: { veredicto: 'APROBADA', brechas: [] } })
    await expect(publishSpec('s1', deps(gov, { validateDraft: () => ({ ok: false, error: 'schema' }) }))).rejects.toThrow(/no valida/)
  })

  it('el anuncio es no-fatal (un fallo no revierte la publicación)', async () => {
    const gov = await seededSession('autochequeado', { draft: goodDraft, qc: { veredicto: 'APROBADA', brechas: [] } })
    const r = await publishSpec('s1', deps(gov, { announce: async () => { throw new Error('slack caído') } }))
    expect(r.code).toBe('PI-101')
    expect((await gov.getMirandaSession('s1'))?.state).toBe('publicado')
  })
})
