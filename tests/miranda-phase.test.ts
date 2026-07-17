import { describe, it, expect } from 'vitest'
import { turnPhaseOf, thinkingBubble, fmtDuration, renderChat } from '../server/miranda'
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

// Plan 100 · addendum 5 (encargo de César): un temporizador que mida cuánto tarda Miranda en procesar
// cada mensaje. En vivo, un reloj en la burbuja «pensando» (avanza en saltos con el meta-refresh); al
// cerrar, la duración medida se persiste CON el mensaje y se pinta discreta bajo la burbuja.
describe('plan 100 addendum 5 · fmtDuration (formato compacto)', () => {
  it('sub-minuto → «Ns»', () => {
    expect(fmtDuration(0)).toBe('0s')
    expect(fmtDuration(999)).toBe('0s')
    expect(fmtDuration(1000)).toBe('1s')
    expect(fmtDuration(47_000)).toBe('47s')
    expect(fmtDuration(59_999)).toBe('59s')
  })
  it('≥60s → «Nm Ss» con segundos a dos dígitos', () => {
    expect(fmtDuration(60_000)).toBe('1m 00s')
    expect(fmtDuration(65_000)).toBe('1m 05s')
    expect(fmtDuration(72_000)).toBe('1m 12s')
    expect(fmtDuration(154_000)).toBe('2m 34s')
    expect(fmtDuration(3_661_000)).toBe('61m 01s')
  })
  it('entrada inválida (NaN, negativa) → «0s», nunca «NaN»', () => {
    expect(fmtDuration(NaN)).toBe('0s')
    expect(fmtDuration(-5)).toBe('0s')
    expect(fmtDuration(Infinity)).toBe('0s')
  })
})

describe('plan 100 addendum 5 · reloj en la burbuja «pensando»', () => {
  it('con elapsedMs → la fase lleva el reloj y va en el aria-label', () => {
    const html = thinkingBubble('Cuadrando las cifras…', 72_000)
    expect(html).toContain('Cuadrando las cifras…')
    expect(html).toContain('1m 12s')
    expect(html).toContain('aria-label="Miranda: Cuadrando las cifras… · 1m 12s"')
    expect(html).toContain('mir-dots')
  })
  it('sin elapsedMs (o NaN) → solo la fase, nunca «NaN»', () => {
    const a = thinkingBubble('Armando el reporte…')
    expect(a).toContain('Armando el reporte…')
    expect(a).not.toContain('NaN')
    expect(a).not.toMatch(/·\s*<\/span>/)
    const b = thinkingBubble('Armando el reporte…', NaN)
    expect(b).not.toContain('NaN')
    expect(b).toContain('aria-label="Miranda: Armando el reporte…"') // sin reloj
  })
  it('sin fase pero con reloj → default «Pensando…» con el tiempo', () => {
    const html = thinkingBubble(undefined, 5000)
    expect(html).toContain('Pensando…')
    expect(html).toContain('5s')
  })
})

describe('plan 100 addendum 5 · renderChat pinta la duración final', () => {
  const asst = (text: string, durationMs?: number) => ({ role: 'assistant', content: JSON.stringify([{ type: 'text', text }]), durationMs })
  it('mensaje del assistant con duración → meta discreto «Respondido en …»', () => {
    const html = renderChat([asst('Aquí lo tienes.', 154_000)])
    expect(html).toContain('Respondido en 2m 34s')
    expect(html).toContain('mir-took')
  })
  it('mensaje sin duración → sin meta (no se inventa)', () => {
    const html = renderChat([asst('Hola.')])
    expect(html).not.toContain('Respondido en')
  })
  it('la duración de un mensaje del USUARIO no se pinta (solo el assistant la lleva)', () => {
    const user = { role: 'user', content: JSON.stringify('hola'), durationMs: 3000 }
    const html = renderChat([user])
    expect(html).not.toContain('Respondido en')
  })
})

describe('plan 100 addendum 5 · duration_ms persiste por mensaje', () => {
  it('appendMirandaMessage guarda la duración solo donde se pasa; listMirandaMessages la devuelve', async () => {
    const s = await SqliteGovernanceStore.open(null)
    await s.createSession('d', 'Dur', 'ana@x.com')
    await s.appendMirandaMessage('d', 'user', JSON.stringify('hola'), 0) // sin duración
    await s.appendMirandaMessage('d', 'assistant', JSON.stringify([{ type: 'text', text: 'ok' }]), 120, 154_000) // el que midió
    const msgs = await s.listMirandaMessages('d')
    expect(msgs[0].durationMs).toBeUndefined()
    expect(msgs[1].durationMs).toBe(154_000)
    expect(msgs[1].tokens).toBe(120) // duración y tokens conviven sin pisarse
  })
})
