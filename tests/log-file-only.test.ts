// AppendOnlyLog en modo FILE-ONLY (work/052 §2.7): para logs LONGEVOS (el audit log del server)
// `retain:false` evita acumular cada entrada en RAM — la cadena sigue encadenando (seq/prevHash) y
// el ARCHIVO es la fuente de verdad, verificable offline recomputando los hashes de sus líneas.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppendOnlyLog, canonical, type LogEntry } from '@vergis/botler'

const GENESIS = '0'.repeat(64)

/** Verifica offline la cadena de hashes de las líneas de un archivo JSONL del log. */
function verifyFileChain(path: string): boolean {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
  let prev = GENESIS
  for (const line of lines) {
    const entry = JSON.parse(line) as LogEntry
    const { hash, ...base } = entry
    const recomputed = createHash('sha256').update(prev + canonical(base)).digest('hex')
    if (recomputed !== hash || entry.prevHash !== prev) return false
    prev = hash
  }
  return true
}

describe('AppendOnlyLog · modo file-only (retain:false)', () => {
  it('append() no acumula en memoria; el archivo recibe las líneas y su cadena es válida', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-log-'))
    const path = join(dir, 'audit.log')
    const log = new AppendOnlyLog(path, () => '2026-07-01T00:00:00.000Z', { retain: false })
    log.append({ type: 'a', x: 1 })
    log.append({ type: 'b', x: 2 })
    log.append({ type: 'c', anidado: { z: [1, 2] } })

    // memoria: nada retenido (all/query/verifyChain operan solo sobre lo retenido)
    expect(log.all()).toEqual([])
    expect(log.query(() => true)).toEqual([])
    expect(log.verifyChain()).toBe(true) // cadena vacía = intacta

    // archivo: 3 líneas, seq consecutivo, cadena de hashes VÁLIDA (la fuente es el archivo)
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => (JSON.parse(l) as LogEntry).seq)).toEqual([0, 1, 2])
    expect(verifyFileChain(path)).toBe(true)
  })

  it('default (retain implícito): comportamiento actual intacto — entradas en memoria + cadena verificable', () => {
    const log = new AppendOnlyLog(undefined, () => '2026-07-01T00:00:00.000Z')
    log.append({ type: 'a' })
    log.append({ type: 'b' })
    expect(log.all()).toHaveLength(2)
    expect(log.verifyChain()).toBe(true)
  })

  it('verifyChain DETECTA adulteración: cambiar el hash de una entrada → false', () => {
    const log = new AppendOnlyLog(undefined, () => '2026-07-01T00:00:00.000Z')
    log.append({ type: 'a', x: 1 })
    log.append({ type: 'b', x: 2 })
    expect(log.verifyChain()).toBe(true)
    // all() comparte las referencias de entrada con el interno → adulterar aquí lo ve verifyChain.
    ;(log.all()[0] as { hash: string }).hash = 'f'.repeat(64)
    expect(log.verifyChain()).toBe(false)
  })

  it('verifyChain DETECTA adulteración: mutar un campo del payload → false', () => {
    const log = new AppendOnlyLog(undefined, () => '2026-07-01T00:00:00.000Z')
    log.append({ type: 'a', x: 1 })
    log.append({ type: 'b', x: 2 })
    ;(log.all()[1] as Record<string, unknown>)['x'] = 999
    expect(log.verifyChain()).toBe(false)
  })

  it('offline: borrar una entrada intermedia del archivo rompe la cadena (prevHash desalineado)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-log-'))
    const path = join(dir, 'audit.log')
    const log = new AppendOnlyLog(path, () => '2026-07-01T00:00:00.000Z', { retain: false })
    log.append({ type: 'a' })
    log.append({ type: 'b' })
    log.append({ type: 'c' })
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
    const tampered = join(dir, 'tampered.log')
    writeFileSync(tampered, [lines[0], lines[2]].join('\n') + '\n') // sin la del medio
    expect(verifyFileChain(tampered)).toBe(false)
  })
})
