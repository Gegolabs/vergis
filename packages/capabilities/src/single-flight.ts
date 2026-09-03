/**
 * «Una sola en vuelo»: envuelve una función async para que, mientras una llamada esté pendiente, las
 * siguientes reciban ESA promesa en vez de arrancar otra; al asentarse, la siguiente llamada vuelve a
 * ejecutar la función.
 *
 * Existe por un cerrojo medido en `soltarControl` (#282): el patrón a mano
 *
 *     if (enVuelo) return enVuelo
 *     enVuelo = (async () => { try { … } finally { enVuelo = null } })()
 *
 * se rompe cuando la función retorna SIN ningún `await` — la IIFE termina de forma síncrona, el
 * `finally` limpia la variable y recién entonces la asignación externa guarda la promesa ya resuelta,
 * que queda pegada para siempre: cada llamada posterior la devuelve y la función no vuelve a correr.
 * Acá la promesa se guarda ANTES de poder asentarse y se limpia desde su propio `finally`, comparando
 * identidad para no borrar una llamada más nueva.
 */
export function singleFlight<A extends unknown[], T>(fn: (...args: A) => Promise<T>): ((...args: A) => Promise<T>) & { inFlight(): boolean } {
  let current: Promise<T> | null = null
  const wrapped = (...args: A): Promise<T> => {
    if (current) return current
    const p = fn(...args).finally(() => {
      if (current === p) current = null
    })
    current = p
    return p
  }
  return Object.assign(wrapped, { inFlight: () => current != null })
}
