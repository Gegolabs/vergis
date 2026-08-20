import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ControlLease, controlLeaseFile } from '../packages/capabilities/src/control-lease'

/**
 * Un nodo que NUNCA llegó a servir no retiene el plano de control (issue #228).
 *
 * El fenómeno medido, y por qué este test arranca un proceso de verdad: el lease se adquiere al
 * arranque —tiene que ser antes de abrir un solo store, porque el modo de apertura y el gate de época
 * dependen de él— y la validación de configuración sigue lanzando DESPUÉS. Un `throw` de arranque no
 * pasa por el `release()` ordenado, que cuelga de `SIGTERM`/`SIGUSR2`, así que el archivo quedaba con
 * un titular que ya no existe y SIN la marca de release. Reproducido acá con la misma configuración
 * incompleta del issue (`VERGIS_SPECS_DIR` + `VERGIS_OUT`, sin `VERGIS_DATASETS`).
 *
 * Un test en proceso NO mediría esto: la falla es del camino de excepción de la evaluación del módulo
 * entero, y lo que se afirma es qué queda en el volumen cuando el proceso ya murió.
 */

const RAIZ = resolve(__dirname, '..')
const TSX = join(RAIZ, 'node_modules', '.bin', 'tsx')

describe('#228 · el arranque fallido no deja el lease huérfano', () => {
  it('un arranque que muere por config incompleta deja la MARCA DE RELEASE, no un titular fantasma', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-228-'))
    const out = join(dir, 'out')
    const specs = join(dir, 'specs')
    mkdirSync(out, { recursive: true })
    mkdirSync(specs, { recursive: true })

    const r = spawnSync(TSX, [join(RAIZ, 'server', 'serve-rls.ts')], {
      cwd: RAIZ,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        VERGIS_OUT: out,
        VERGIS_SPECS_DIR: specs,
        // Sin VERGIS_DATASETS: el nodo clickhouse lanza al validar su configuración — el fail-closed
        // correcto y esperado. Lo que se mide es el residuo, no el exit code.
        VERGIS_DATASETS: '',
      },
    })

    const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`
    // El arranque tiene que haber muerto DESPUÉS de tomar el control: sin eso, este test no mide nada.
    expect(r.status, `el proceso no murió como se esperaba:\n${salida}`).toBe(1)
    expect(salida).toMatch(/control ADQUIRIDO/)
    expect(salida).toMatch(/falta VERGIS_DATASETS/)

    const file = controlLeaseFile(out)
    expect(existsSync(file), 'el nodo ni siquiera llegó a crear el archivo de lease').toBe(true)
    const rec = JSON.parse(readFileSync(file, 'utf8')) as { holder: string; epoch: number; pid: number }
    // La propiedad que el issue pide: el archivo NO declara un titular. La época se conserva (el
    // sucesor la incrementa), que es lo mismo que deja un release ordenado.
    expect(rec.holder, `el lease quedó huérfano: ${JSON.stringify(rec)}`).toBe('')
    expect(rec.epoch).toBe(1)
    expect(rec.pid).toBe(0)
  }, 180_000)

  it('el sucesor adquiere de inmediato sobre la marca que dejó el arranque fallido (sin stale window)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-228-suc-'))
    const file = controlLeaseFile(dir)
    // La marca tal como la deja el camino de excepción: titular vacío, época conservada.
    writeFileSync(file, `${JSON.stringify({ holder: '', ring: null, epoch: 1, renewedAt: new Date().toISOString(), pid: 0 }, null, 2)}\n`)

    const sucesor = new ControlLease({ file, holder: 'vergis@host/2', autoRenew: false, maxAttempts: 1 })
    const t0 = Date.now()
    expect(await sucesor.acquire()).toBe(true)
    // Sin marca habría que esperar `staleMs` (10 000 por default) — el punto entero del arreglo.
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(sucesor.status().epoch).toBe(2) // la época se conserva y el sucesor la incrementa
  })
})
