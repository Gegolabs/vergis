import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createMiranda, type MirandaServerDeps } from '../server/miranda'
import { csrfFactory } from '../server/ui'
import { SqliteGovernanceStore } from '@vergis/capabilities'
import type { AnthropicTransport, AnthropicResponse } from '@vergis/miranda'

const SECRET = 'test-secret'
const EMAIL = 'ana@x.com'
const token = csrfFactory(SECRET)(EMAIL)

function mkReq(url: string, method = 'GET', body?: Record<string, string>): IncomingMessage {
  const payload = body ? new URLSearchParams(body).toString() : ''
  const req = Readable.from([payload]) as unknown as IncomingMessage
  req.url = url
  req.method = method
  req.headers = {}
  return req
}
function mkRes() {
  const calls: { status: number; body: string; headers: Record<string, string> } = { status: 0, body: '', headers: {} }
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))
  const res = {
    writeHead: (code: number, headers?: Record<string, string>) => {
      calls.status = code
      if (headers) calls.headers = headers
    },
    end: (b?: string) => {
      calls.body = b ?? ''
      resolveDone()
    },
  } as unknown as ServerResponse
  return { res, calls, done }
}

const textResp = (t: string): AnthropicResponse => ({ id: 'm', role: 'assistant', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } })

async function build(over: Partial<MirandaServerDeps> = {}, transport?: AnthropicTransport) {
  const gov = await SqliteGovernanceStore.open(null)
  const tp: AnthropicTransport = transport ?? { async createMessage() { return textResp('¿Qué PI quieres crear?') } }
  const deps: MirandaServerDeps = {
    gov,
    transport: tp,
    model: 'm',
    systemPrompt: 'sys',
    maxTurns: 5,
    tokenBudget: 100000,
    catalog: [{ name: 'dbo.v_saldos' }],
    configuredRefs: [],
    identityOf: () => ({ user: EMAIL }),
    hasScope: async () => true,
    probe: async () => ({ rows: [] }),
    columnsOf: async () => [],
    validateDraft: () => ({ ok: true }),
    listSpecs: () => [],
    readSpec: () => null,
    writeSpec: async () => {},
    renderPreviewHtml: async () => '<html>PREVIEW</html>',
    secret: SECRET,
    ...over,
  }
  return { gov, handler: createMiranda(deps), deps }
}

describe('WP4 · scope gate', () => {
  it('sin scope → 403 en cualquier ruta /miranda', async () => {
    const { handler } = await build({ hasScope: async () => false })
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda'), res)
    await done
    expect(calls.status).toBe(403)
    expect(calls.body).toContain('scope')
  })
  it('ruta ajena → tryHandle devuelve false', async () => {
    const { handler } = await build()
    const { res } = mkRes()
    expect(await handler.tryHandle(mkReq('/otra'), res)).toBe(false)
  })
})

describe('WP4 · ciclo básico', () => {
  it('GET /miranda lista (vacía) para el usuario con scope', async () => {
    const { handler } = await build()
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toContain('Nueva sesión')
  })
  it('POST /miranda/api/new crea sesión y redirige', async () => {
    const { gov, handler } = await build()
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/new', 'POST', { _csrf: token, title: 'Saldos' }), res)
    await done
    expect(calls.status).toBe(303)
    expect(calls.headers.location).toMatch(/^\/miranda\/s\//)
    const sessions = await gov.listMirandaSessions(EMAIL)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('Saldos')
  })
  it('CSRF inválido → 403', async () => {
    const { handler } = await build()
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/new', 'POST', { _csrf: 'malo', title: 'x' }), res)
    await done
    expect(calls.status).toBe(403)
  })
  it('POST message retorna 303 inmediato con el marcador puesto; el turno corre en background', async () => {
    // Barrera: el background queda bloqueado hasta soltarla → el marcador es observable «procesando».
    let release!: () => void
    const barrier = new Promise<void>((r) => (release = r))
    const tp: AnthropicTransport = { async createMessage() { await barrier; return textResp('Empecemos por la fuente.') } }
    const { gov, handler } = await build(undefined, tp)
    await gov.createSession('s1', 'Saldos', EMAIL)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: token, text: 'quiero saldos por empresa' }), res)
    await done
    expect(calls.status).toBe(303)
    // El POST redirige de inmediato: el mensaje del usuario ya está persistido + marcador de turno puesto.
    expect((await gov.getMirandaSession('s1'))?.turnState).toBe('procesando')
    const early = await gov.listMirandaMessages('s1')
    expect(early.map((m) => m.role)).toEqual(['user']) // el asistente aún no llega
    release()
    await handler.whenIdle()
    // Terminado el background: user + assistant persistidos, marcador limpio, tokens del turno anclados.
    const msgs = await gov.listMirandaMessages('s1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(await gov.mirandaSessionTokens('s1')).toBe(10)
    expect((await gov.getMirandaSession('s1'))?.turnState).toBeUndefined()
  })

  it('POST con turno vivo ENCOLA (no arranca 2º concurrente) y al cerrar se atiende en orden FIFO (etapa D)', async () => {
    // Transporte que se resuelve a mano: el 1er turno queda «vivo» hasta que soltamos la barrera.
    let release!: () => void
    const barrier = new Promise<void>((r) => (release = r))
    const tp: AnthropicTransport = { async createMessage() { await barrier; return textResp('ok') } }
    const { gov, handler } = await build(undefined, tp)
    await gov.createSession('s1', 'x', EMAIL)
    // 1er POST → arranca el turno (marcador puesto), pero el background está bloqueado en la barrera.
    let r = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: token, text: 'primero' }), r.res)
    await r.done
    expect((await gov.getMirandaSession('s1'))?.turnState).toBe('procesando')
    // 2º y 3º POST mientras el 1º sigue vivo → se ENCOLAN (FIFO), no arrancan turnos concurrentes.
    for (const t of ['segundo', 'tercero']) {
      r = mkRes()
      await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: token, text: t }), r.res)
      await r.done
      expect(r.calls.status).toBe(303)
    }
    // Aún NO son mensajes del hilo (están en cola); el hilo tiene solo el 1er user; UN turno vivo.
    expect((await gov.listMirandaMessages('s1')).map((m) => m.role)).toEqual(['user'])
    expect(await gov.listMirandaQueue('s1')).toEqual(['segundo', 'tercero'])
    // Soltar la barrera: el turno cierra y ENCADENA la cola FIFO hasta vaciarla (un turno a la vez).
    release()
    await handler.whenIdle()
    const msgs = await gov.listMirandaMessages('s1')
    // Tres turnos en orden: (primero→assistant)(segundo→assistant)(tercero→assistant).
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(msgs[0].content).toContain('primero')
    expect(msgs[2].content).toContain('segundo')
    expect(msgs[4].content).toContain('tercero')
    expect(await gov.listMirandaQueue('s1')).toEqual([]) // cola vaciada
    expect((await gov.getMirandaSession('s1'))?.turnState).toBeUndefined() // sin turno vivo al final
  })

  it('error del turno (background) → burbuja en voz de negocio (sin el crudo) y limpia el marcador', async () => {
    const tp: AnthropicTransport = { async createMessage() { throw new Error('boom API') } }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gov, handler } = await build(undefined, tp)
    await gov.createSession('s1', 'x', EMAIL)
    const { res, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: token, text: 'hola' }), res)
    await done
    await handler.whenIdle()
    const msgs = await gov.listMirandaMessages('s1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toContain('Tuve un problema técnico') // voz de negocio
    expect(msgs[1].content).not.toContain('boom API') // el crudo NO llega a la burbuja
    expect((await gov.getMirandaSession('s1'))?.turnState).toBeUndefined()
    expect(errSpy.mock.calls.flat().join(' ')).toContain('boom API') // …se registró server-side
    errSpy.mockRestore()
  })
})

describe('async turn · página pendiente y watchdog', () => {
  it('página en estado pendiente trae meta-refresh + burbuja pensando, con el composer HABILITADO (etapa D)', async () => {
    // Barrera para mantener el turno vivo mientras pintamos la página pendiente.
    let release!: () => void
    const barrier = new Promise<void>((r) => (release = r))
    const tp: AnthropicTransport = { async createMessage() { await barrier; return textResp('ok') } }
    const { gov, handler } = await build(undefined, tp)
    await gov.createSession('s1', 'x', EMAIL)
    let r = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: token, text: 'hola' }), r.res)
    await r.done
    r = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), r.res)
    await r.done
    expect(r.calls.status).toBe(200)
    expect(r.calls.body).toContain('http-equiv="refresh"')
    expect(r.calls.body).toContain('mir-thinking')
    // Espera NO bloqueante: el composer sigue disponible mientras Miranda responde (no `disabled`).
    expect(r.calls.body).toContain('name="text"')
    expect(r.calls.body).not.toContain('disabled')
    release()
    await handler.whenIdle()
  })

  it('página SIN turno pendiente NO trae meta-refresh y muestra el composer', async () => {
    const { gov, handler } = await build()
    await gov.createSession('s1', 'x', EMAIL)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).not.toContain('http-equiv="refresh"')
    expect(calls.body).toContain('name="text"')
  })

  it('watchdog: marcador huérfano (viejo, sin turno vivo) se limpia y muestra error de sistema', async () => {
    // orphanTurnMs:0 → cualquier marcador sin turno vivo en este proceso se considera huérfano.
    const { gov, handler } = await build({ orphanTurnMs: 0 })
    await gov.createSession('s1', 'x', EMAIL)
    await gov.beginMirandaTurn('s1') // simula un turno que quedó colgado (proceso reiniciado)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).not.toContain('http-equiv="refresh"') // marcador reapado → sin refresh
    expect(calls.body).toContain('Error del sistema')
    expect((await gov.getMirandaSession('s1'))?.turnState).toBeUndefined()
  })

  it('la gaveta muestra la línea de presupuesto; con warn sobre 80%', async () => {
    const { gov, handler } = await build({ tokenBudget: 1000 })
    await gov.createSession('s1', 'x', EMAIL)
    await gov.appendMirandaMessage('s1', 'assistant', JSON.stringify([{ type: 'text', text: 'hola' }]), 850)
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), res)
    await done
    expect(calls.body).toContain('Uso de la sesión')
    expect(calls.body).toContain('mir-budget--warn')
  })
})

// Plan 101 · Etapa D: espera NO bloqueante + cola FIFO. Revierte el «un-turno-por-sesión» del 098: el
// composer nunca se bloquea por `procesando`; un POST durante el turno vivo se encola y se atiende en
// orden; la cola persiste y es visible; `reapOrphan` la deja intacta; el presupuesto corta la cadena.
describe('async turn · cola FIFO no-bloqueante (plan 101 etapa D)', () => {
  it('la cola es visible «en cola» en el hilo y SOBREVIVE un re-render', async () => {
    let release!: () => void
    const barrier = new Promise<void>((r) => (release = r))
    const tp: AnthropicTransport = { async createMessage() { await barrier; return textResp('ok') } }
    const { gov, handler } = await build(undefined, tp)
    await gov.createSession('s1', 'x', EMAIL)
    // 1er POST arranca el turno; 2º se encola.
    let r = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: token, text: 'primero' }), r.res)
    await r.done
    r = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: token, text: 'en espera' }), r.res)
    await r.done
    // Render 1: el encolado aparece «en cola».
    r = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), r.res)
    await r.done
    expect(r.calls.body).toContain('en cola')
    expect(r.calls.body).toContain('en espera')
    // Render 2 (otro GET): la cola sigue ahí (persistida, no efímera).
    r = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), r.res)
    await r.done
    expect(r.calls.body).toContain('en espera')
    expect(await gov.listMirandaQueue('s1')).toEqual(['en espera'])
    release()
    await handler.whenIdle()
  })

  it('reapOrphan deja la cola INTACTA; el backlog se drena FIFO en el próximo POST', async () => {
    // orphanTurnMs:0 → el marcador colgado se reapa; simulamos un backlog encolado antes del «reinicio».
    const { gov, handler } = await build({ orphanTurnMs: 0 })
    await gov.createSession('s1', 'x', EMAIL)
    await gov.beginMirandaTurn('s1') // turno colgado (proceso reiniciado)
    await gov.enqueueMirandaMessage('s1', 'quedó en cola') // backlog previo al reinicio
    // Un GET reapa el huérfano; la cola NO se toca.
    let r = mkRes()
    await handler.tryHandle(mkReq('/miranda/s/s1'), r.res)
    await r.done
    expect((await gov.getMirandaSession('s1'))?.turnState).toBeUndefined() // reapado
    expect(await gov.listMirandaQueue('s1')).toEqual(['quedó en cola']) // cola intacta
    // Próximo POST: se respeta FIFO — el backlog arranca primero, el nuevo va detrás.
    r = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: token, text: 'nuevo' }), r.res)
    await r.done
    await handler.whenIdle()
    const msgs = (await gov.listMirandaMessages('s1')).filter((m) => m.role === 'user').map((m) => m.content)
    // El reaper dejó su aviso; luego «quedó en cola» (FIFO) antes que «nuevo».
    const qIdx = msgs.findIndex((c) => c.includes('quedó en cola'))
    const nIdx = msgs.findIndex((c) => c.includes('nuevo'))
    expect(qIdx).toBeGreaterThanOrEqual(0)
    expect(nIdx).toBeGreaterThan(qIdx) // FIFO: backlog antes que el nuevo
    expect(await gov.listMirandaQueue('s1')).toEqual([])
  })

  it('presupuesto agregado: un turno encolado que ya no cabe recibe el mensaje de presupuesto, no un turno fantasma', async () => {
    // Presupuesto muy chico: el 1er turno gasta y el 2º (encolado) ya no cabe → TokenBudgetExceeded.
    let release!: () => void
    const barrier = new Promise<void>((r) => (release = r))
    const tp: AnthropicTransport = { async createMessage() { await barrier; return textResp('ok') } } // 10 tokens/turno
    const { gov, handler } = await build({ tokenBudget: 10 }, tp)
    await gov.createSession('s1', 'x', EMAIL)
    let r = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: token, text: 'primero' }), r.res)
    await r.done
    r = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/message', 'POST', { _csrf: token, text: 'segundo' }), r.res)
    await r.done
    release()
    await handler.whenIdle()
    const msgs = await gov.listMirandaMessages('s1')
    // 1er turno: user+assistant (gasta 10 → llega al tope). 2º: user(segundo)+assistant con el mensaje
    // de presupuesto agotado (no un turno normal), porque el agregado ya no cabe.
    const budgetMsg = msgs.find((m) => m.role === 'assistant' && m.content.includes('presupuesto'))
    expect(budgetMsg).toBeTruthy()
    expect(msgs.some((m) => m.content.includes('segundo'))).toBe(true) // el encolado SÍ entró al hilo
    expect(await gov.listMirandaQueue('s1')).toEqual([]) // cola drenada, sin turno fantasma pendiente
    expect((await gov.getMirandaSession('s1'))?.turnState).toBeUndefined()
  })
})

describe('WP4 · validate-intent y preview', () => {
  it('validate-intent sin resumen → 400; con resumen y borrador → validado', async () => {
    const { gov, handler } = await build()
    await gov.createSession('s1', 'x', EMAIL)
    await gov.setMirandaState('s1', 'borrador')
    // sin resumen aún
    let r = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/validate-intent', 'POST', { _csrf: token }), r.res)
    await r.done
    expect(r.calls.status).toBe(400)
    // con resumen
    await gov.appendMirandaArtifact('s1', 'intent_summary', JSON.stringify({ titulo: 'x', pregunta_de_negocio: 'y', audiencia: 'z', grano: 'g' }))
    r = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/validate-intent', 'POST', { _csrf: token }), r.res)
    await r.done
    expect(r.calls.status).toBe(303)
    expect((await gov.getMirandaSession('s1'))?.state).toBe('validado')
  })
  it('GET preview sirve el draft por el riel de render (RLS real)', async () => {
    const renderPreviewHtml = vi.fn(async () => '<html>PREVIEW-RLS</html>')
    const { gov, handler } = await build({ renderPreviewHtml })
    await gov.createSession('s1', 'x', EMAIL)
    await gov.appendMirandaArtifact('s1', 'spec_draft', 'mira_version: "1.0"')
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/preview/s1'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toBe('<html>PREVIEW-RLS</html>')
    expect(renderPreviewHtml).toHaveBeenCalled()
  })
})

describe('WP4 · publish desde el handler', () => {
  it('autochequeado + qc sin B/M → publica y escribe la spec', async () => {
    const writeSpec = vi.fn(async () => {})
    const { gov, handler } = await build({ writeSpec })
    await gov.createSession('s1', 'Saldos empresa', EMAIL)
    await gov.setMirandaState('s1', 'borrador')
    await gov.setMirandaState('s1', 'validado')
    await gov.setMirandaState('s1', 'autochequeado')
    await gov.appendMirandaArtifact('s1', 'spec_draft', 'mira_version: "1.0"')
    await gov.appendMirandaArtifact('s1', 'qc_report', JSON.stringify({ veredicto: 'APROBADA', brechas: [] }))
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/publish', 'POST', { _csrf: token }), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).toContain('PI-101')
    expect(writeSpec).toHaveBeenCalled()
  })
  it('publish con qc M abierta → 409', async () => {
    const { gov, handler } = await build()
    await gov.createSession('s1', 'x', EMAIL)
    await gov.setMirandaState('s1', 'borrador')
    await gov.setMirandaState('s1', 'validado')
    await gov.setMirandaState('s1', 'autochequeado')
    await gov.appendMirandaArtifact('s1', 'spec_draft', 'mira_version: "1.0"')
    await gov.appendMirandaArtifact('s1', 'qc_report', JSON.stringify({ veredicto: 'NO_APROBABLE', brechas: [{ id: 'M1', sev: 'M', brecha: 'x', donde: 'y', recomendacion: 'z' }] }))
    const { res, calls, done } = mkRes()
    await handler.tryHandle(mkReq('/miranda/api/s/s1/publish', 'POST', { _csrf: token }), res)
    await done
    expect(calls.status).toBe(409)
  })
})
