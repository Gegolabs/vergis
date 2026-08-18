import { describe, it, expect, vi, afterEach } from 'vitest'
import { createBackgroundLoops } from '../server/control-loops'

/**
 * Los lazos de fondo cuelgan del plano de control (#210 · I4). Lo que se prueba acá es lo que hace la
 * diferencia entre «gatear los lazos» y gatearlos BIEN:
 *
 *  · un lazo declarado no corre hasta que se arma — un nodo en standby no observa, no purga, no reporta;
 *  · `disarm()` ESPERA el tick en vuelo: cortar el interval no detiene la vuelta que ya empezó, y esa
 *    vuelta termina en un volcado del store. Soltar el control sin esperarla es la escritura que
 *    aterriza cuando el archivo ya es de otro nodo;
 *  · desarmar de verdad desarma: cero ticks después, por más tiempo que pase.
 */
afterEach(() => {
  vi.useRealTimers()
})

describe('control-loops · un lazo declarado no corre sin armar', () => {
  it('registrar NO arma: cero ticks aunque pase el tiempo', () => {
    vi.useFakeTimers()
    const ticks: number[] = []
    const loops = createBackgroundLoops({ log: () => {} })
    loops.register({ name: 'frescura', everyMs: 1000, firstDelayMs: 10, tick: () => void ticks.push(Date.now()) })
    expect(loops.armed()).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(ticks).toHaveLength(0)
    expect(loops.status()).toEqual([{ name: 'frescura', everyMs: 1000, armed: false, ticks: 0 }])
  })

  it('arm() arma el primer tick y la cadencia; el estado lo dice', async () => {
    vi.useFakeTimers()
    let n = 0
    const loops = createBackgroundLoops({ log: () => {} })
    loops.register({ name: 'purga', everyMs: 1000, firstDelayMs: 100, tick: () => void (n += 1) })
    loops.arm()
    expect(loops.armed()).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(n).toBe(1) // el tick de arranque
    await vi.advanceTimersByTimeAsync(3000)
    expect(n).toBe(4) // + tres vueltas de cadencia
    expect(loops.status()[0].armed).toBe(true)
    expect(loops.status()[0].ticks).toBe(4)
  })

  it('un lazo declarado DESPUÉS de armar se arma solo (el arranque asíncrono los declara tarde)', async () => {
    vi.useFakeTimers()
    let n = 0
    const loops = createBackgroundLoops({ log: () => {} })
    loops.arm()
    loops.register({ name: 'tardío', everyMs: 500, tick: () => void (n += 1) })
    await vi.advanceTimersByTimeAsync(1500)
    expect(n).toBe(3)
  })
})

describe('control-loops · desarmar es soltar de verdad', () => {
  it('disarm() ESPERA el tick en vuelo antes de resolver', async () => {
    let liberar!: () => void
    const enVuelo = new Promise<void>((r) => (liberar = r))
    let terminado = false
    const loops = createBackgroundLoops({ log: () => {} })
    loops.register({
      name: 'frescura',
      everyMs: 10,
      firstDelayMs: 1,
      tick: async () => {
        await enVuelo
        terminado = true
      },
    })
    loops.arm()
    // Esperar a que la vuelta arranque (timers reales: 1 ms del primer tick).
    await new Promise((r) => setTimeout(r, 20))
    let resuelto = false
    const p = loops.disarm().then(() => (resuelto = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(resuelto).toBe(false) // sigue esperando la vuelta viva
    expect(terminado).toBe(false)
    liberar()
    await p
    expect(resuelto).toBe(true)
    expect(terminado).toBe(true) // la escritura de la vuelta terminó ANTES de que el control se suelte
  })

  it('tras disarm() no hay un solo tick más', async () => {
    vi.useFakeTimers()
    let n = 0
    const loops = createBackgroundLoops({ log: () => {} })
    loops.register({ name: 'reporte', everyMs: 100, tick: () => void (n += 1) })
    loops.arm()
    await vi.advanceTimersByTimeAsync(350)
    const alDesarmar = n
    expect(alDesarmar).toBeGreaterThan(0)
    await loops.disarm()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(n).toBe(alDesarmar)
    expect(loops.armed()).toBe(false)
    expect(loops.status()[0].armed).toBe(false)
  })

  it('arm/disarm son idempotentes y no duplican la cadencia', async () => {
    vi.useFakeTimers()
    let n = 0
    const loops = createBackgroundLoops({ log: () => {} })
    loops.register({ name: 'intake', everyMs: 100, tick: () => void (n += 1) })
    loops.arm()
    loops.arm()
    loops.arm()
    await vi.advanceTimersByTimeAsync(500)
    expect(n).toBe(5) // una sola cadencia, no tres
    await loops.disarm()
    await loops.disarm()
    expect(loops.armed()).toBe(false)
  })
})

describe('control-loops · el lazo sobrevive a su propia vuelta mala', () => {
  it('una vuelta que lanza se loguea, queda en el estado y el lazo sigue armado', async () => {
    vi.useFakeTimers()
    const logs: string[] = []
    let n = 0
    const loops = createBackgroundLoops({ log: (m) => void logs.push(m) })
    loops.register({
      name: 'frescura',
      everyMs: 100,
      tick: async () => {
        n += 1
        if (n === 1) throw new Error('el motor no respondió')
      },
    })
    loops.arm()
    await vi.advanceTimersByTimeAsync(100)
    expect(logs.join('\n')).toContain('el motor no respondió')
    expect(loops.status()[0].lastError).toContain('el motor no respondió')
    await vi.advanceTimersByTimeAsync(100)
    expect(n).toBe(2) // sigue armado
    expect(loops.status()[0].lastError).toBeUndefined() // y la vuelta buena limpia el error
  })

  it('no se solapan dos vueltas del mismo lazo', async () => {
    let vivas = 0
    let maxVivas = 0
    let liberar!: () => void
    const bloqueo = new Promise<void>((r) => (liberar = r))
    const loops = createBackgroundLoops({ log: () => {} })
    loops.register({
      name: 'lento',
      everyMs: 5,
      firstDelayMs: 1,
      tick: async () => {
        vivas += 1
        maxVivas = Math.max(maxVivas, vivas)
        await bloqueo
        vivas -= 1
      },
    })
    loops.arm()
    await new Promise((r) => setTimeout(r, 50))
    expect(maxVivas).toBe(1)
    liberar()
    await loops.disarm()
  })
})

describe('control-loops · el registro rechaza lo que no puede reportar', () => {
  const loops = () => createBackgroundLoops({ log: () => {} })
  it('un lazo sin nombre no entra (el nombre es su identidad en el log y en el contrato)', () => {
    expect(() => loops().register({ name: '  ', everyMs: 10, tick: () => {} })).toThrow(/nombre/)
  })
  it('una cadencia no-positiva no entra', () => {
    expect(() => loops().register({ name: 'x', everyMs: 0, tick: () => {} })).toThrow(/cadencia/)
    expect(() => loops().register({ name: 'x', everyMs: Number.NaN, tick: () => {} })).toThrow(/cadencia/)
  })
  it('dos lazos con el mismo nombre no entran: serían indistinguibles', () => {
    const l = loops()
    l.register({ name: 'frescura', everyMs: 10, tick: () => {} })
    expect(() => l.register({ name: 'frescura', everyMs: 20, tick: () => {} })).toThrow(/ya está declarado/)
  })
})
