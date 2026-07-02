import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LogEntry, LogEventInput } from './types'

const GENESIS = '0'.repeat(64)

/** Opciones del log. */
export interface AppendOnlyLogOptions {
  /**
   * `false` = modo FILE-ONLY para logs LONGEVOS (p.ej. el audit log del server, que vive todo el
   * proceso): `append()` NO acumula la entrada en memoria — solo conserva `seq`/`prevHash`, que es
   * todo lo que la cadena de hashes necesita para seguir encadenando. En este modo `all()`/`query()`/
   * `verifyChain()` operan SOLO sobre lo retenido (vacío): la fuente de verdad es el ARCHIVO, y la
   * cadena se verifica offline recomputando los hashes de sus líneas. Default `true` (los logs
   * por-request son efímeros y `chainValid` los usa).
   */
  retain?: boolean
}

/**
 * Append-only log encadenado criptográficamente (doc 1 §4.5, Pilar Auditoría).
 * Cada entrada contiene el hash de la anterior. Determinista vía serialización canónica.
 */
export class AppendOnlyLog {
  private seq = 0
  private prevHash = GENESIS
  private readonly entries: LogEntry[] = []
  private readonly retain: boolean

  constructor(
    private readonly path?: string,
    private readonly clock: () => string = () => new Date().toISOString(),
    opts: AppendOnlyLogOptions = {},
  ) {
    this.retain = opts.retain !== false
    if (path) mkdirSync(dirname(path), { recursive: true })
  }

  append(event: LogEventInput): LogEntry {
    const base = { ...event, seq: this.seq, ts: this.clock(), prevHash: this.prevHash }
    const hash = createHash('sha256').update(this.prevHash + canonical(base)).digest('hex')
    const entry: LogEntry = { ...base, hash }
    // Modo no-retain: la memoria no crece sin cota; la cadena sigue intacta (seq/prevHash avanzan).
    if (this.retain) this.entries.push(entry)
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

/** Serialización CANÓNICA (claves ordenadas): la misma entrada siempre produce el mismo string.
 *  Exportada porque otros componentes la usan como base de claves/hashes deterministas
 *  (verificación offline de la cadena, claves de caché de resultados). */
export function canonical(value: unknown): string {
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
