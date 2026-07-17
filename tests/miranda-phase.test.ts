import { describe, it, expect } from 'vitest'
import { turnPhaseOf, thinkingBubble, fmtDuration, renderChat, PHASE_STEPS, phaseIndex, renderStepper } from '../server/miranda'
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

// Plan 101 · Etapa A: durante el turno, un stepper visible «Explorando → Armando → Cuadrando → Vista
// previa» ilumina el paso actual y deja ver los cumplidos. Fuente única = PHASE_STEPS (orden canónico);
// la fase actual mapea a su índice. El pipeline NO es monotónico (el modelo rebota), así que el
// marcador avanza en ALTO-AGUA y el stepper no retrocede visualmente. CSS-only, sin JS.
describe('plan 101 etapa A · orden canónico de fases', () => {
  it('PHASE_STEPS es la fuente única: 4 pasos en orden, cada frase = un valor de TOOL_PHASE', () => {
    expect(PHASE_STEPS.map((s) => s.label)).toEqual(['Explorando', 'Armando', 'Cuadrando', 'Vista previa'])
    // Cada frase del stepper es exactamente la que proyecta un tool del loop (mapeo directo fase→índice).
    expect(turnPhaseOf('catalog_tables')).toBe(PHASE_STEPS[0].phrase)
    expect(turnPhaseOf('save_draft')).toBe(PHASE_STEPS[1].phrase)
    expect(turnPhaseOf('run_self_check')).toBe(PHASE_STEPS[2].phrase)
    expect(turnPhaseOf('render_preview')).toBe(PHASE_STEPS[3].phrase)
  })

  it('phaseIndex mapea la fase actual a su índice; desconocida/ausente → -1', () => {
    expect(phaseIndex(PHASE_STEPS[0].phrase)).toBe(0)
    expect(phaseIndex(PHASE_STEPS[1].phrase)).toBe(1)
    expect(phaseIndex(PHASE_STEPS[2].phrase)).toBe(2)
    expect(phaseIndex(PHASE_STEPS[3].phrase)).toBe(3)
    expect(phaseIndex(undefined)).toBe(-1)
    expect(phaseIndex('Frase que no existe')).toBe(-1)
  })
})

describe('plan 101 etapa A · render del stepper (CSS-only)', () => {
  it('con cada fase activa: previos cumplidos, actual activo, siguientes pendientes', () => {
    // Activo en «Cuadrando» (idx 2): 0 y 1 done, 2 active, 3 pending.
    const html = renderStepper(2)
    expect(html).toContain('<span class="mir-step is-done">Explorando</span>')
    expect(html).toContain('<span class="mir-step is-done">Armando</span>')
    expect(html).toContain('<span class="mir-step is-active">Cuadrando</span>')
    expect(html).toContain('<span class="mir-step is-pending">Vista previa</span>')
    // Separadores → entre los cuatro pasos (tres flechas).
    expect(html.match(/mir-sep/g)).toHaveLength(3)
    // Decorativo: el stepper no aporta semántica de estado (va aria-hidden).
    expect(html).toContain('class="mir-stepper" aria-hidden="true"')
  })

  it('idx 0 → solo el primero activo, el resto pendiente', () => {
    const html = renderStepper(0)
    expect(html).toContain('<span class="mir-step is-active">Explorando</span>')
    expect(html).not.toContain('is-done')
    expect(html.match(/is-pending/g)).toHaveLength(3)
  })

  it('idx -1 (aún sin fase, «Pensando…») → todos pendientes, ninguno activo', () => {
    const html = renderStepper(-1)
    expect(html).not.toContain('is-active')
    expect(html).not.toContain('is-done')
    expect(html.match(/is-pending/g)).toHaveLength(4)
  })

  it('sin JS: el stepper no emite <script> ni handlers on*', () => {
    const html = renderStepper(2)
    expect(html).not.toMatch(/<script|on\w+=/i)
  })
})

describe('plan 101 etapa A · thinkingBubble integra el stepper conservando reloj y puntos', () => {
  it('la burbuja lleva el stepper + la frase + el reloj + los puntos', () => {
    const html = thinkingBubble('Cuadrando las cifras…', 72_000)
    expect(html).toContain('mir-stepper')
    expect(html).toContain('<span class="mir-step is-active">Cuadrando</span>')
    expect(html).toContain('1m 12s') // reloj del addendum 5 conservado
    expect(html).toContain('mir-dots') // puntos del addendum 4 conservados
    expect(html).toContain('aria-label="Miranda: Cuadrando las cifras… · 1m 12s"')
  })
  it('sin fase → stepper con todo pendiente y frase «Pensando…»', () => {
    const html = thinkingBubble(undefined, 3000)
    expect(html).toContain('mir-stepper')
    expect(html).not.toContain('is-active')
    expect(html).toContain('Pensando…')
  })
})

describe('plan 101 etapa A · no-retroceso: el marcador de fase avanza en alto-agua (store monotónico)', () => {
  it('un rebote a una fase anterior NO retrocede turn_phase; una fase igual o mayor sí avanza', async () => {
    const s = await SqliteGovernanceStore.open(null)
    await s.createSession('hw', 'Alto-agua', 'ana@x.com')
    await s.beginMirandaTurn('hw')

    await s.setMirandaTurnPhase('hw', PHASE_STEPS[0].phrase, 0) // Explorando
    await s.setMirandaTurnPhase('hw', PHASE_STEPS[2].phrase, 2) // Cuadrando (avanza)
    expect((await s.getMirandaSession('hw'))?.turnPhase).toBe(PHASE_STEPS[2].phrase)

    // Rebote: el modelo vuelve a explorar (idx 0 < 2) → el marcador NO retrocede.
    await s.setMirandaTurnPhase('hw', PHASE_STEPS[0].phrase, 0)
    expect((await s.getMirandaSession('hw'))?.turnPhase).toBe(PHASE_STEPS[2].phrase)
    expect(phaseIndex((await s.getMirandaSession('hw'))?.turnPhase)).toBe(2) // el stepper sigue en Cuadrando

    // Avance real a Vista previa (idx 3 ≥ 2) → sí actualiza.
    await s.setMirandaTurnPhase('hw', PHASE_STEPS[3].phrase, 3)
    expect((await s.getMirandaSession('hw'))?.turnPhase).toBe(PHASE_STEPS[3].phrase)

    // Un turno nuevo resetea el alto-agua (el stepper es por-turno).
    await s.endMirandaTurn('hw')
    await s.beginMirandaTurn('hw')
    await s.setMirandaTurnPhase('hw', PHASE_STEPS[0].phrase, 0)
    expect((await s.getMirandaSession('hw'))?.turnPhase).toBe(PHASE_STEPS[0].phrase)
  })

  it('sin índice (compat) → set best-effort, sin gate monotónico', async () => {
    const s = await SqliteGovernanceStore.open(null)
    await s.createSession('cc', 'Compat', 'ana@x.com')
    await s.beginMirandaTurn('cc')
    await s.setMirandaTurnPhase('cc', PHASE_STEPS[3].phrase, 3)
    await s.setMirandaTurnPhase('cc', 'Fase libre sin índice') // compat: pisa
    expect((await s.getMirandaSession('cc'))?.turnPhase).toBe('Fase libre sin índice')
  })
})
