import { describe, it, expect } from 'vitest'
import {
  validateIntentSummary,
  normalizeIntent,
  derivePiecesFromDraft,
  formaFromPiezas,
  crossCheckForma,
  mergeFormaCross,
  buildSystemPrompt,
  buildToolRegistry,
  runSelfCheck,
  type IntentSummary,
  type MirandaToolContext,
  type AnthropicTransport,
  type AnthropicResponse,
  type SelfCheckResult,
} from '@vergis/miranda'

// Ajuste post-diseño (hallazgo PI-17 / F-01): `forma` por vista en el resumen de intención — validable
// por el usuario y cruzada contra las piezas del draft por el self-check. Cubre los TRES puntos del
// plan 083 ítem 2: (1) formato del resumen (prompt + tool schema); (2) update_intent_summary;
// (3) el cruce del self-check.

const DRAFT_TABLA = `mira_version: "1.0"
identity: { id: t, display_name: "Saldos", classification: internal }
piece:
  layout: rows
  elements:
    - table: { data: data.s, columns: [{field: e}] }
`
const DRAFT_DASHBOARD = `mira_version: "1.0"
identity: { id: d, display_name: "Tablero", classification: internal }
piece:
  layout: rows
  elements:
    - kpi: { metric: data.s.total, label: Total }
    - chart: { data: data.s }
`
const DRAFT_MIXTA = `mira_version: "1.0"
identity: { id: m, display_name: "Mixto", classification: internal }
piece:
  layout: rows
  elements:
    - kpi: { metric: data.s.total, label: Total }
    - table: { data: data.s, columns: [{field: e}] }
`
const DRAFT_PAGES = `mira_version: "1.0"
identity: { id: p, display_name: "Multi", classification: internal }
pages:
  - { id: resumen, title: Resumen, piece: { elements: [{ kpi: { metric: data.s.t, label: T } }] } }
  - { id: detalle, title: Detalle, piece: { elements: [{ table: { data: data.s, columns: [{field: e}] } }] } }
`
const DRAFT_SOLO_TEXTO = `mira_version: "1.0"
identity: { id: x, display_name: "Texto", classification: internal }
piece:
  layout: rows
  elements:
    - markdown_block: { content: "# hola" }
`

// ── Punto 1 · Formato del resumen (tool schema + prompt) ──
describe('forma por vista · formato del resumen', () => {
  it('el prompt describe la forma por vista y su vocabulario', () => {
    const p = buildSystemPrompt()
    expect(p).toContain('vistas[{nombre,forma,piezas}]')
    expect(p).toMatch(/tabla, dashboard, mixta/)
    expect(p).toMatch(/tarjetas, graficos, tabla/)
  })
  it('la tool update_intent_summary declara el campo vistas con enums cerrados', () => {
    const reg = buildToolRegistry({} as MirandaToolContext)
    const def = reg.definitions.find((d) => d.name === 'update_intent_summary')!
    const vistas = def.input_schema.properties!['vistas'] as { items: { properties: Record<string, { enum?: string[] }> } }
    expect(vistas.items.properties['forma'].enum).toEqual(['tabla', 'dashboard', 'mixta'])
  })
})

// ── Punto 2 · update_intent_summary / validación / normalización ──
describe('forma por vista · validación del resumen', () => {
  it('acepta y conserva vistas bien formadas', () => {
    const v = validateIntentSummary({
      titulo: 'T', pregunta_de_negocio: 'q', audiencia: 'a', grano: 'g',
      vistas: [{ nombre: 'Resumen', forma: 'dashboard', piezas: ['tarjetas', 'graficos'] }],
    })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.summary.vistas).toEqual([{ nombre: 'Resumen', forma: 'dashboard', piezas: ['tarjetas', 'graficos'] }])
  })
  it('es tolerante: forma fuera de vocabulario → dashboard; piezas basura filtradas y deduplicadas', () => {
    const s = normalizeIntent({
      titulo: 'T', pregunta_de_negocio: 'q', audiencia: 'a', grano: 'g',
      vistas: [{ nombre: 'X', forma: 'grafico3d', piezas: ['tabla', 'tabla', 'ninja'] }],
    })
    expect(s.vistas[0].forma).toBe('dashboard')
    expect(s.vistas[0].piezas).toEqual(['tabla'])
  })
  it('sin vistas declaradas → arreglo vacío (tolerante en exploración)', () => {
    const s = normalizeIntent({ titulo: 'T', pregunta_de_negocio: 'q', audiencia: 'a', grano: 'g' })
    expect(s.vistas).toEqual([])
  })
})

// ── Derivación de piezas del draft ──
describe('forma por vista · derivación del draft', () => {
  it('infiere forma desde piezas', () => {
    expect(formaFromPiezas(['tabla'])).toBe('tabla')
    expect(formaFromPiezas(['tarjetas', 'graficos'])).toBe('dashboard')
    expect(formaFromPiezas(['tabla', 'tarjetas'])).toBe('mixta')
    expect(formaFromPiezas([])).toBeNull()
  })
  it('deriva una vista tabla / dashboard / mixta', () => {
    expect(derivePiecesFromDraft(DRAFT_TABLA)).toEqual([{ nombre: 'Saldos', piezas: ['tabla'], forma: 'tabla' }])
    expect(derivePiecesFromDraft(DRAFT_DASHBOARD)[0].forma).toBe('dashboard')
    expect(derivePiecesFromDraft(DRAFT_MIXTA)[0].forma).toBe('mixta')
  })
  it('deriva multi-vista desde pages[]', () => {
    const vs = derivePiecesFromDraft(DRAFT_PAGES)
    expect(vs.map((v) => v.forma)).toEqual(['dashboard', 'tabla'])
    expect(vs.map((v) => v.nombre)).toEqual(['Resumen', 'Detalle'])
  })
  it('draft sin piezas visuales (solo markdown) → vista sin forma', () => {
    expect(derivePiecesFromDraft(DRAFT_SOLO_TEXTO)[0].forma).toBeNull()
  })
  it('YAML ilegible → sin vistas', () => {
    expect(derivePiecesFromDraft(':::basura:::')).toEqual([])
  })
})

// ── Punto 3 · el cruce del self-check ──
describe('forma por vista · cruce del self-check', () => {
  it('forma declarada calza con el draft → sin brecha', () => {
    expect(crossCheckForma([{ nombre: 'Saldos', forma: 'tabla', piezas: ['tabla'] }], DRAFT_TABLA)).toEqual([])
  })
  it('forma declarada NO calza con el draft → brecha M', () => {
    const b = crossCheckForma([{ nombre: 'Saldos', forma: 'dashboard', piezas: ['tarjetas'] }], DRAFT_TABLA)
    expect(b).toHaveLength(1)
    expect(b[0].sev).toBe('M')
    expect(b[0].id).toBe('FORMA-1')
  })
  it('piezas declaradas ≠ piezas reales → brecha M aunque la forma coincida', () => {
    // draft mixta (tabla+tarjetas); declaro mixta pero piezas incompletas
    const b = crossCheckForma([{ nombre: 'Mixto', forma: 'mixta', piezas: ['tabla'] }], DRAFT_MIXTA)
    expect(b.some((x) => x.sev === 'M')).toBe(true)
  })
  it('draft visual pero sin vistas declaradas → M (la intención visual no es validable)', () => {
    const b = crossCheckForma([], DRAFT_DASHBOARD)
    expect(b).toHaveLength(1)
    expect(b[0].sev).toBe('M')
    expect(b[0].brecha).toMatch(/no está declarada/)
  })
  it('draft NO visual (solo texto) → no exige forma', () => {
    expect(crossCheckForma([], DRAFT_SOLO_TEXTO)).toEqual([])
  })
  it('número de vistas declaradas ≠ del draft → M', () => {
    const b = crossCheckForma([{ nombre: 'Resumen', forma: 'dashboard', piezas: ['tarjetas'] }], DRAFT_PAGES)
    expect(b.some((x) => /1 vista.*2/.test(x.brecha))).toBe(true)
  })
})

// ── Integración: runSelfCheck funde el cruce y degrada el veredicto ──
function judge(report: unknown): AnthropicTransport {
  return {
    async createMessage(): Promise<AnthropicResponse> {
      return { id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'emit_qc_report', input: report }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 3 } }
    },
  }
}

describe('forma por vista · runSelfCheck integra el cruce (código, no solo prompt)', () => {
  const okIntent = (v: unknown) => JSON.stringify({ titulo: 'T', pregunta_de_negocio: 'q', audiencia: 'a', grano: 'g', vistas: v })

  it('juez APROBADA + forma que no calza → M inyectada y veredicto degradado a APROBABLE', async () => {
    const r = await runSelfCheck({
      transport: judge({ veredicto: 'APROBADA', brechas: [] }),
      model: 'm',
      draftYaml: DRAFT_TABLA,
      intentSummary: okIntent([{ nombre: 'Saldos', forma: 'dashboard', piezas: ['tarjetas'] }]),
    })
    expect(r.veredicto).toBe('APROBABLE')
    expect(r.brechas.some((b) => b.id.startsWith('FORMA-') && b.sev === 'M')).toBe(true)
  })

  it('juez APROBADA + forma que calza → sin brecha de forma, veredicto intacto', async () => {
    const r = await runSelfCheck({
      transport: judge({ veredicto: 'APROBADA', brechas: [] }),
      model: 'm',
      draftYaml: DRAFT_TABLA,
      intentSummary: okIntent([{ nombre: 'Saldos', forma: 'tabla', piezas: ['tabla'] }]),
    })
    expect(r.veredicto).toBe('APROBADA')
    expect(r.brechas).toEqual([])
  })

  it('mergeFormaCross es idempotente sobre draft no visual', () => {
    const base: SelfCheckResult = { veredicto: 'APROBADA', brechas: [] }
    expect(mergeFormaCross(base, JSON.stringify({ vistas: [] }), DRAFT_SOLO_TEXTO)).toEqual(base)
  })
})

// Guard de tipos: IntentSummary expone vistas.
const _typecheck: Pick<IntentSummary, 'vistas'> = { vistas: [] }
void _typecheck
