import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LogEntry, LogEventInput } from './types'

const GENESIS = '0'.repeat(64)

/**
 * Append-only log encadenado criptográficamente (doc 1 §4.5, Pilar Auditoría).
 * Cada entrada contiene el hash de la anterior. Determinista vía serialización canónica.
 */
export class AppendOnlyLog {
  private seq = 0
  private prevHash = GENESIS
  private readonly entries: LogEntry[] = []

  constructor(
    private readonly path?: string,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    if (path) mkdirSync(dirname(path), { recursive: true })
  }

  append(event: LogEventInput): LogEntry {
    const base = { ...event, seq: this.seq, ts: this.clock(), prevHash: this.prevHash }
    const hash = createHash('sha256').update(this.prevHash + canonical(base)).digest('hex')
    const entry: LogEntry = { ...base, hash }
    this.entries.push(entry)
    this.prevHash = hash
    this.seq += 1
    if (this.path) appendFileSync(this.path, JSON.stringify(entry) + '\n')
    return entry
  }

  all(): LogEntry[] {
    return [...this.entries]
  }

  query(filter: (e: LogEntry) => boolean): LogEntry[] {
    return this.entries.filter(filter)
  }

  /** Recalcula la cadena de hashes; true si está intacta. */
  verifyChain(): boolean {
    let prev = GENESIS
    for (const entry of this.entries) {
      const { hash, ...base } = entry
      const recomputed = createHash('sha256').update(prev + canonical(base)).digest('hex')
      if (recomputed !== hash || entry.prevHash !== prev) return false
      prev = hash
    }
    return true
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys(obj[key])
        return acc
      }, {})
  }
  return value
}
