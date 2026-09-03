// `singleFlight` (#282): el cerrojo de `soltarControl` reproducido y cerrado.
//
// El caso medido en el banco V-16: un nodo en standby recibe SIGUSR2, la rama «nada que soltar» retorna
// sin `await`, y la variable de «en vuelo» queda pegada con una promesa ya resuelta. Desde ahí el nodo
// nunca vuelve a soltar el control. El primer test falla contra el patrón a mano; el helper lo pasa.
import { describe, expect, it } from 'vitest'
import { singleFlight } from '@vergis/capabilities'

/** El patrón que tenía `soltarControl`, tal cual: la rama corta retorna SIN await (es el caso medido). */
function patronAMano(tieneControl: () => boolean, fn: () => Promise<void>): () => Promise<void> {
  let enVuelo: Promise<void> | null = null
  return () => {
    if (enVuelo) return enVuelo
    enVuelo = (async () => {
      try {
        if (!tieneControl()) return // «nada que soltar»: sin await, la IIFE termina de forma síncrona
        await fn()
      } finally {
        enVuelo = null
      }
    })()
    return enVuelo
  }
}

describe('singleFlight · una sola en vuelo, sin cerrojo', () => {
  it('CONTROL (el defecto): el patrón a mano se queda pegado tras un retorno sin await', async () => {
    let control = false
    let corridas = 0
    const soltar = patronAMano(
      () => control,
      async () => {
        corridas++
      },
    )
    await soltar() // en standby: «nada que soltar», retorna sin await → el finally corre ANTES de la asignación
    control = true // ahora el nodo tiene el control…
    await soltar()
    await soltar()
    // …pero la promesa resuelta quedó pegada: el release nunca corre. Este es el cerrojo de #282.
    expect(corridas).toBe(0)
  })

  it('con singleFlight, tras un retorno sin await la llamada siguiente vuelve a correr la función', async () => {
    let corridas = 0
    const f = singleFlight(async () => {
      corridas++
    })
    await f()
    await f()
    await f()
    expect(corridas).toBe(3)
    expect(f.inFlight()).toBe(false)
  })

  it('mientras una llamada está pendiente, las siguientes reciben la MISMA promesa', async () => {
    let corridas = 0
    let abrir: () => void = () => {}
    const compuerta = new Promise<void>((r) => {
      abrir = r
    })
    const f = singleFlight(async (x: number) => {
      corridas++
      await compuerta
      return x
    })
    const p1 = f(1)
    const p2 = f(2)
    expect(p2).toBe(p1)
    expect(f.inFlight()).toBe(true)
    abrir()
    expect(await p1).toBe(1)
    expect(await p2).toBe(1) // la segunda llamada NO corrió: recibió el resultado de la primera
    expect(corridas).toBe(1)
    expect(f.inFlight()).toBe(false)
    expect(await f(3)).toBe(3)
    expect(corridas).toBe(2)
  })

  it('una función que rechaza también libera el vuelo: la siguiente llamada vuelve a intentar', async () => {
    let corridas = 0
    const f = singleFlight(async () => {
      corridas++
      throw new Error(`fallo ${corridas}`)
    })
    await expect(f()).rejects.toThrow('fallo 1')
    await expect(f()).rejects.toThrow('fallo 2')
    expect(f.inFlight()).toBe(false)
  })
})
