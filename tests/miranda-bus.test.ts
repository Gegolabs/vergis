import { describe, it, expect } from 'vitest'
import { SessionBus, BusRegistry } from '../server/miranda-bus'

// Plan 103 · Etapa 1: el bus de eventos en memoria es la fundación del canal EN VIVO (SSE). La store es
// la fuente de verdad; el bus solo transporta. Aquí se prueba la mecánica pura (publish/subscribe/replay).
describe('SessionBus · publish/subscribe (plan 103 etapa 1)', () => {
  it('un evento publicado llega a los suscriptores con id incremental', () => {
    const bus = new SessionBus()
    const got: { id: number; type: string; data: unknown }[] = []
    bus.subscribe((e) => got.push(e))
    bus.publish('phase', { idx: 1 })
    bus.publish('message', { html: '<div>x</div>' })
    expect(got.map((e) => e.type)).toEqual(['phase', 'message'])
    expect(got.map((e) => e.id)).toEqual([1, 2]) // ids incrementales
  })

  it('replay: un suscriptor nuevo recibe los eventos del buffer con id > afterId (reconexión)', () => {
    const bus = new SessionBus()
    bus.publish('phase', { idx: 0 }) // id 1
    bus.publish('phase', { idx: 1 }) // id 2
    bus.publish('message', { html: 'a' }) // id 3
    const got: number[] = []
    bus.subscribe((e) => got.push(e.id), 1) // Last-Event-ID = 1 → replay de 2 y 3
    expect(got).toEqual([2, 3])
  })

  it('un suscriptor que lanza no rompe la publicación al resto', () => {
    const bus = new SessionBus()
    const ok: string[] = []
    bus.subscribe(() => { throw new Error('roto') })
    bus.subscribe((e) => ok.push(e.type))
    expect(() => bus.publish('done', {})).not.toThrow()
    expect(ok).toEqual(['done'])
  })

  it('la baja (unsubscribe) deja de recibir', () => {
    const bus = new SessionBus()
    const got: string[] = []
    const off = bus.subscribe((e) => got.push(e.type))
    bus.publish('a', {})
    off()
    bus.publish('b', {})
    expect(got).toEqual(['a'])
    expect(bus.subscriberCount).toBe(0)
  })
})

describe('BusRegistry · un bus por sesión, podado al quedar ocioso (plan 103 etapa 1)', () => {
  it('for() crea/reusa el bus por sesión; peek() no lo crea', () => {
    const reg = new BusRegistry()
    expect(reg.peek('s1')).toBeUndefined()
    const b = reg.for('s1')
    expect(reg.for('s1')).toBe(b) // reusa
    expect(reg.peek('s1')).toBe(b) // ahora sí existe
    expect(reg.size).toBe(1)
  })

  it('pruneIfIdle elimina el bus solo si nadie lo escucha', () => {
    const reg = new BusRegistry()
    const b = reg.for('s1')
    const off = b.subscribe(() => {})
    reg.pruneIfIdle('s1')
    expect(reg.size).toBe(1) // hay un suscriptor → NO se poda
    off()
    reg.pruneIfIdle('s1')
    expect(reg.size).toBe(0) // sin suscriptores → podado
  })
})
