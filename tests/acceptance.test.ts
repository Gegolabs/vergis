import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { VergisError } from '@vergis/botler'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const examples = (name: string) => join(ROOT, 'examples', name)

let work: string
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'vergis-'))
})
afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('Vergis v0.1 · Definition of Done', () => {
  it('1 · runSpec(hello) termina ok y escribe hello.html', async () => {
    const out = await runSpec({ specPath: examples('hello.yaml'), baseDir: work, logPath: join(work, 'vergis.log.jsonl') })
    expect(out.ok).toBe(true)
    expect(existsSync(join(work, 'hello.html'))).toBe(true)
    expect(out.artifacts.some((a) => a.path?.endsWith('hello.html'))).toBe(true)
  })

  it('2 · hello.html muestra el saludo y el KPI', () => {
    const html = readFileSync(join(work, 'hello.html'), 'utf8')
    expect(html).toContain('Hola, Vergis — 2026-05-28')
    expect(html).toContain('Agentes vivos')
    expect(html).toContain('>1<')
  })

  it('3 · el log está encadenado por hash y cubre invoke, capability_call, render y publish', async () => {
    const out = await runSpec({ specPath: examples('hello.yaml'), baseDir: work, logPath: join(work, 'log3.jsonl') })
    expect(out.chainValid).toBe(true)
    const types = out.log.map((e) => e.type)
    expect(types).toContain('invoke')
    expect(types.filter((t) => t === 'capability-call').length).toBeGreaterThanOrEqual(3)
    expect(types).toContain('mira-render')
    expect(types).toContain('mira-publish')

    // El archivo JSONL refleja la misma cadena.
    const lines = readFileSync(join(work, 'log3.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (let i = 1; i < lines.length; i += 1) {
      expect(lines[i].prevHash).toBe(lines[i - 1].hash)
    }
  })

  it('4 · una Capability no catalogada se rechaza con error estructurado', async () => {
    await expect(
      runSpec({ specPath: examples('bad-capability.yaml'), baseDir: work, logPath: join(work, 'log4.jsonl') }),
    ).rejects.toMatchObject({
      structured: { error: 'mira/spec-invalid', code: 'capability-not-catalogued', path: 'data.estado.capability' },
    })
  })

  it('5 · un fallo de Capability dispara el fallback agéntico (log agentic-fallback)', async () => {
    const out = await runSpec({ specPath: examples('force-fail.yaml'), baseDir: work, logPath: join(work, 'log5.jsonl') })
    expect(out.ok).toBe(false)
    expect(out.fallback?.recovery).toBe('mark-for-regeneration')
    expect(out.log.some((e) => e.type === 'agentic-fallback')).toBe(true)
    expect(out.chainValid).toBe(true)
  })

  it('6 · reproducibilidad: mismo spec ⇒ hello.html byte-idéntico', async () => {
    const a = join(work, 'a')
    const b = join(work, 'b')
    await runSpec({ specPath: examples('hello.yaml'), baseDir: a })
    await runSpec({ specPath: examples('hello.yaml'), baseDir: b })
    const ha = readFileSync(join(a, 'hello.html'))
    const hb = readFileSync(join(b, 'hello.html'))
    expect(ha.equals(hb)).toBe(true)
  })
})

describe('Vergis v0.1 · CLI end-to-end', () => {
  it('`vergis run examples/hello.yaml` corre como CLI y termina con código 0', () => {
    const cliWork = mkdtempSync(join(tmpdir(), 'vergis-cli-'))
    // El bin usa tsx; lo invocamos vía el binario tsx del workspace.
    const tsx = join(ROOT, 'node_modules', '.bin', 'tsx')
    const main = join(ROOT, 'packages', 'cli', 'src', 'main.ts')
    const stdout = execFileSync(tsx, [main, 'run', examples('hello.yaml'), '--out', cliWork, '--log', join(cliWork, 'vergis.log.jsonl')], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(stdout).toContain('hello.html')
    expect(existsSync(join(cliWork, 'hello.html'))).toBe(true)
    rmSync(cliWork, { recursive: true, force: true })
  })
})
