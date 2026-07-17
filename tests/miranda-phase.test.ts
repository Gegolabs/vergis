import { describe, it, expect } from 'vitest'
import { turnPhaseOf, thinkingBubble } from '../server/miranda'
import { SqliteGovernanceStore } from '@vergis/capabilities'

// Plan 100 · addendum 4 (encargo de César): feedback ocasional mientras el server piensa — «no es
// suficiente con "..."». La burbuja «pensando» muestra la FASE actual del turno en voz de negocio;
// el meta-refresh del turno asíncrono (plan 098) la re-lee en cada ciclo, sin JS ni SSE. La fase se
// proyecta desde los tool_use del loop (jamás nombres de tools) y vive en `miranda_session.turn_phase`
// (los mensajes se persisten al FINAL del turno, así que no sirven de canal en vivo).

describe('plan 100 addendum 4 · proyección tool → fase (voz de negocio)', () => {
  it('mapea los tools del loop a las cuatro fases', () => {
    expect(turnPhaseOf('catalog_tables')).toBe('Revisando la información disponible…')
    expect(turnPhaseOf('describe_table')).toBe('Revisando la información disponible…')
    expect(turnPhaseOf('profile_column')).toBe('Revisando la información disponible…')
    expect(turnPhaseOf('run_probe')).toBe('Revisando la información disponible…')
    expect(turnPhaseOf('update_intent_summary')).toBe('Armando el reporte…')
    expect(turnPhaseOf('save_draft')).toBe('Armando el reporte…')
    expect(turnPhaseOf('run_self_check')).toBe('Cuadrando las cifras…')
    expect(turnPhaseOf('render_preview')).toBe('Preparando la vista previa…')
  })

  it('un tool fuera del mapa NO proyecta fase (se conserva la previa; no inventar)', () => {
    expect(turnPhaseOf('create_data_request')).toBeUndefined()
    expect(turnPhaseOf('emit_qc_report')).toBeUndefined()
    expect(turnPhaseOf('tool_desconocida')).toBeUndefined()
    expect(turnPhaseOf('')).toBeUndefined()
  })

  it('ninguna frase filtra nombres de tools ni jerga interna (reglas VOZ)', () => {
    const frases = new Set(
      ['catalog_tables', 'describe_table', 'profile_column', 'run_probe', 'update_intent_summary', 'save_draft', 'run_self_check', 'render_preview']
        .map((t) => turnPhaseOf(t))
        .filter((f): f is string => f !== undefined),
    )
    for (const f of frases) {
      expect(f).not.toMatch(/catalog_tables|describe_table|profile_column|run_probe|update_intent_summary|save_draft|run_self_check|render_preview/)
      expect(f).not.toMatch(/self.?check|draft|spec|probe|catálogo|_/i)
    }
  })
})

describe('plan 100 addendum 4 · burbuja «pensando» con fase', () => {
  it('sin fase → default «Pensando…», con puntos animados y aria-label', () => {
    const html = thinkingBubble()
    expect(html).toContain('Pensando…')
    expect(html).toContain('aria-label="Miranda: Pensando…"')
    expect(html).toContain('mir-dots') // los puntitos se conservan
  })

  it('con fase → la frase acompaña a los puntos y va también en el aria-label', () => {
    const html = thinkingBubble('Armando el reporte…')
    expect(html).toContain('<span class="mir-phase">Armando el reporte…</span>')
    expect(html).toContain('aria-label="Miranda: Armando el reporte…"')
    expect(html).toContain('mir-dots')
    expect(html).not.toContain('Pensando…')
  })

  it('una fase vacía o de espacios cae al default', () => {
    expect(thinkingBubble('   ')).toContain('Pensando…')
  })
})

describe('plan 100 addendum 4 · marcador turn_phase en el store', () => {
  it('set → visible en la sesión; endMirandaTurn lo limpia; un turno nuevo arranca sin fase', async () => {
    const s = await SqliteGovernanceStore.open(null)
    await s.createSession('p', 'Fase', 'ana@x.com')
    expect((await s.getMirandaSession('p'))?.turnPhase).toBeUndefined()

    await s.beginMirandaTurn('p')
    await s.setMirandaTurnPhase('p', 'Armando el reporte…')
    expect((await s.getMirandaSession('p'))?.turnPhase).toBe('Armando el reporte…')

    // La limpieza va por el MISMO camino que turn_state (finally del turno — incluida la rama max_tokens).
    await s.endMirandaTurn('p')
    const done = await s.getMirandaSession('p')
    expect(done?.turnState).toBeUndefined()
    expect(done?.turnPhase).toBeUndefined()

    // Un residuo de fase no sobrevive al arranque de un turno nuevo (reset en beginMirandaTurn).
    await s.setMirandaTurnPhase('p', 'Residuo…')
    await s.beginMirandaTurn('p')
    expect((await s.getMirandaSession('p'))?.turnPhase).toBeUndefined()
  })
})
