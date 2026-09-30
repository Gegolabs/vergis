/**
 * El CLI sale DESPUÉS de vaciar stdout y stderr.
 *
 * `process.exit()` a secas descarta lo que todavía no se escribió a un pipe. Se vio en el CI del corte
 * de 0.40.0: la prueba de #369 («una salida de ~20 KB llega entera») recibía 171 de 200 líneas, cortadas
 * por la cola, con exit 0. En node:22 sobre Linux falló 7 de 8 veces con `process.exit` y 0 de 8 dejando
 * que el proceso vaciara sus streams. Quien lee por pipe es el caso normal: la herramienta Bash de
 * Claude Code.
 *
 * Esta prueba no depende de la carga de la máquina: el padre empieza a leer TARDE (500 ms después de
 * lanzar al hijo), así que cuando el hijo llega a su salida, todo lo que exceda el buffer del pipe sigue
 * pendiente en él. Con `process.exit` eso se pierde; con `salir`, el hijo espera al lector.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PLUGIN } from './plugin-helpers'

const BYTES = 1_000_000

/** Corre un hijo que escribe BYTES a stdout y termina con `fin`; el padre empieza a leer con retraso. */
function correr(fin: string): Promise<{ code: number; bytes: number }> {
  const util = pathToFileURL(join(PLUGIN, 'lib', 'util.mjs')).href
  const src = `import { salir } from ${JSON.stringify(util)}; process.stdout.write('x'.repeat(${BYTES})); ${fin}`
  return new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'] })
    const trozos: Buffer[] = []
    c.stdout.pause()
    c.on('close', (code) => res({ code: code ?? -1, bytes: Buffer.concat(trozos).length }))
    setTimeout(() => {
      c.stdout.on('data', (d: Buffer) => trozos.push(d))
      c.stdout.resume()
    }, 500)
  })
}

describe('salir · el CLI no trunca su salida al terminar', () => {
  it('con salir(0), llega el MB entero y el código', async () => {
    const r = await correr('salir(0)')
    expect(r.code).toBe(0)
    expect(r.bytes).toBe(BYTES)
  }, 30_000)

  it('conserva el código de salida distinto de cero', async () => {
    const r = await correr('salir(7)')
    expect(r.code).toBe(7)
    expect(r.bytes).toBe(BYTES)
  }, 30_000)

  it('CONTROL: process.exit(0) a secas SÍ trunca en este mismo arnés (si no, la prueba no mide nada)', async () => {
    const r = await correr('process.exit(0)')
    expect(r.code).toBe(0)
    expect(r.bytes).toBeLessThan(BYTES)
  }, 30_000)
})
