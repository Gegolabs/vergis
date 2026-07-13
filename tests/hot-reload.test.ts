import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { debounce, createCachedScanner, watchPaths, swapRecordInPlace } from '../server/hot-reload'

describe('swapRecordInPlace (issue #50 · hot-reload de perfiles de conexión)', () => {
  it('muta IN-PLACE la misma referencia: altas, cambios y bajas', () => {
    const live: Record<string, { server: string; secret: string }> = {
      wh_a: { server: 'a', secret: 's1' },
      wh_b: { server: 'b', secret: 's2' },
    }
    const captured = live // un consumidor que capturó la referencia (createExecuteSqlDwh)
    const diff = swapRecordInPlace(live, {
      wh_a: { server: 'a', secret: 's1' }, // intacta
      wh_b: { server: 'b', secret: 'ROTADO' }, // cambiada
      wh_c: { server: 'c', secret: 's3' }, // nueva
      // wh_removida: no está → si existiera, saldría
    })
    expect(diff).toEqual({ added: ['wh_c'], changed: ['wh_b'], removed: [] })
    expect(captured['wh_c']).toEqual({ server: 'c', secret: 's3' }) // el consumidor la ve sin re-cablear
    expect(captured['wh_b'].secret).toBe('ROTADO')
  })

  it('una clave removida del archivo desaparece del registro vivo', () => {
    const live: Record<string, number> = { a: 1, b: 2 }
    const diff = swapRecordInPlace(live, { a: 1 })
    expect(diff.removed).toEqual(['b'])
    expect('b' in live).toBe(false)
  })

  it('el diff reporta CLAVES, jamás valores (los perfiles llevan secretos y esto se loguea)', () => {
    const live: Record<string, { secret: string }> = { wh: { secret: 'viejo' } }
    const diff = swapRecordInPlace(live, { wh: { secret: 'nuevo' } })
    expect(JSON.stringify(diff)).not.toContain('viejo')
    expect(JSON.stringify(diff)).not.toContain('nuevo')
  })
})

describe('debounce', () => {
  it('coalesce una ráfaga de triggers en una sola ejecución tras la quietud', () => {
    vi.useFakeTimers()
    let n = 0
    const d = debounce(() => { n += 1 }, 200)
    d.trigger(); d.trigger(); d.trigger()
    expect(n).toBe(0)
    vi.advanceTimersByTime(199)
    expect(n).toBe(0)
    vi.advanceTimersByTime(1)
    expect(n).toBe(1)
    vi.useRealTimers()
  })

  it('cancel() evita la ejecución pendiente', () => {
    vi.useFakeTimers()
    let n = 0
    const d = debounce(() => { n += 1 }, 100)
    d.trigger()
    d.cancel()
    vi.advanceTimersByTime(1000)
    expect(n).toBe(0)
    vi.useRealTimers()
  })
})

describe('createCachedScanner', () => {
  it('sirve el valor cacheado sin re-ejecutar scan hasta rebuild()', () => {
    let calls = 0
    let src = 1
    const s = createCachedScanner(() => { calls += 1; return src })
    expect(s.get()).toBe(1)
    expect(s.get()).toBe(1)
    expect(calls).toBe(1) // solo la carga inicial
    src = 2
    expect(s.get()).toBe(1) // sigue cacheado
    expect(s.rebuild()).toEqual({ ok: true })
    expect(s.get()).toBe(2)
    expect(calls).toBe(2)
  })

  it('validate-before-swap: si scan() lanza, conserva el valor previo y reporta el error', () => {
    let mode = 'ok'
    const s = createCachedScanner(() => {
      if (mode === 'boom') throw new Error('parse-error')
      return mode
    })
    expect(s.get()).toBe('ok')
    mode = 'boom'
    const r = s.rebuild()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('parse-error')
    expect(s.get()).toBe('ok') // NO se rompió: conserva el previo
    mode = 'nuevo'
    expect(s.rebuild().ok).toBe(true)
    expect(s.get()).toBe('nuevo')
  })

  it('la primera carga propaga el error (equivale al fallo de arranque)', () => {
    expect(() => createCachedScanner(() => { throw new Error('boot-fail') })).toThrow('boot-fail')
  })
})

describe('watchPaths', () => {
  it('tolera un path inexistente: loguea y no lanza; devuelve un unwatch()', () => {
    const logs: string[] = []
    const un = watchPaths(['/no/existe/jamas-xyz-123'], () => {}, { log: (m) => logs.push(m) })
    expect(typeof un).toBe('function')
    expect(logs.some((l) => l.includes('no se pudo observar'))).toBe(true)
    un()
  })

  it('dispara onChange (debounced) cuando cambia un archivo del directorio observado', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-watch-'))
    let fired = 0
    const un = watchPaths([dir], () => { fired += 1 }, { debounceMs: 20 })
    // Settle antes de escribir: en macOS el fs.watch no queda armado de inmediato y un write demasiado
    // pronto pierde el evento (causa real del flake). Luego polling con deadline (sale apenas dispara).
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(join(dir, 'a.yaml'), 'x: 1')
    const deadline = Date.now() + 3000
    while (fired === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    un()
    rmSync(dir, { recursive: true, force: true })
    expect(fired).toBeGreaterThanOrEqual(1)
  })

  it('observa un ARCHIVO y sobrevive un save ATÓMICO (rename-replace, como vim/VSCode)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-fw-'))
    const file = join(dir, 'policy.yaml')
    writeFileSync(file, 'x: 1')
    let fired = 0
    // watch sobre el ARCHIVO: internamente observa su directorio, así el rename no lo deja ciego.
    const un = watchPaths([file], () => { fired += 1 }, { debounceMs: 20 })
    await new Promise((r) => setTimeout(r, 100))
    const tmp = join(dir, 'policy.yaml.tmp')
    writeFileSync(tmp, 'x: 2')
    renameSync(tmp, file) // save atómico: cambia el inode del archivo observado
    const deadline = Date.now() + 3000
    while (fired === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    un()
    rmSync(dir, { recursive: true, force: true })
    expect(fired).toBeGreaterThanOrEqual(1)
  })
})
