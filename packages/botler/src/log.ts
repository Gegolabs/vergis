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

/**
 * Verificación OFFLINE de la cadena, sobre las LÍNEAS del archivo (issue #306 · I9).
 *
 * `verifyChain()` recorre `this.entries`, que en modo `retain:false` —el de TODO log longevo del
 * server— está vacío: devuelve `true` sin haber verificado nada. Eso no es un bug de aquella función
 * (su contrato dice «lo retenido»), pero sí deja sin verificador al único sitio donde la cadena
 * importa de verdad: el archivo. Esta función es ese verificador, y es pura — se le pasan las líneas.
 *
 * Una línea no-JSON o vacía se SALTA (los lectores de log del server hacen lo mismo: un archivo
 * concatenado por una rotación no es una cadena rota). Lo que rompe es un hash que no recomputa o un
 * `prevHash` que no encadena: ahí devuelve el `seq` donde se cortó, que es lo que un operador
 * necesita para ir a mirar.
 */
export function verifyChainLines(lines: string[]): { ok: boolean; rotoEn?: number; verificadas: number } {
  let prev = GENESIS
  let verificadas = 0
  for (const raw of lines) {
    const linea = raw.trim()
    if (!linea) continue
    let entry: LogEntry
    try {
      entry = JSON.parse(linea) as LogEntry
    } catch {
      continue
    }
    if (typeof entry?.hash !== 'string' || typeof entry?.prevHash !== 'string') continue
    const { hash, ...base } = entry
    const recomputed = createHash('sha256').update(prev + canonical(base)).digest('hex')
    if (recomputed !== hash || entry.prevHash !== prev) return { ok: false, rotoEn: entry.seq, verificadas }
    prev = hash
    verificadas += 1
  }
  return { ok: true, verificadas }
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
