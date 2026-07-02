import { createHash } from 'node:crypto'
import { canonical } from './log'
import type { Capability, ClaimSet, IdentityContext } from './types'

/**
 * `withResultCache` — capability-wrapper GENÉRICO de caché de resultados por consumidor
 * (work/052 §2.3). Vive en el Botler (no en Mira: Mira es genérica y no sabe de caché); envuelve
 * una Capability de DATOS y memoiza su salida por TTL corto.
 *
 * SEGURIDAD (RLS): la clave de caché incluye SIEMPRE el nombre de la capability, los params
 * (serializados canónicamente) y la IDENTIDAD NORMALIZADA (user + claims con valores ordenados).
 * Dos consumidores distintos JAMÁS comparten entrada — un hit solo puede devolver filas que esa
 * misma identidad ya obtuvo del motor enforcing. Sin claims ≠ con claims (clave distinta).
 *
 * OPT-IN por instancia: el server envuelve su conector solo si la instancia lo pide (TTL > 0);
 * por defecto no hay caché y cada render dispara las queries reales (comportamiento actual).
 */
export interface ResultCacheOptions {
  /** Vigencia de cada entrada, en ms. */
  ttlMs: number
  /** Tope de entradas (LRU simple: al superarlo se expulsa la menos usada). Default 500. */
  maxEntries?: number
  /** Reloj inyectable (ms epoch) para reproducibilidad en tests. */
  clock?: () => number
}

/** La Capability envuelta expone además la "última salida válida" por clave (base de
 *  `show_last_valid`: retenida SIN expirar, con el mismo tope LRU). */
export interface CachedCapability extends Capability {
  /** Última salida válida conocida para (params, identity), aunque el TTL haya vencido.
   *  `undefined` si esa identidad nunca obtuvo un resultado para esos params. */
  getLastValid(params: unknown, identity: IdentityContext): unknown | undefined
  /** Contadores observables (tests/diagnóstico). */
  stats(): { hits: number; misses: number; size: number }
}

/** Claims normalizados: valores SIEMPRE como arreglo ordenado, claves sin valor omitidas.
 *  Así `{g: 'a'}` y `{g: ['a']}` (o distinto orden de grupos) producen la MISMA clave. */
function normalizeClaims(claims: ClaimSet | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(claims ?? {})) {
    if (v == null) continue
    out[k] = (Array.isArray(v) ? v.map(String) : [String(v)]).sort()
  }
  return out
}

/** Clave estable: sha256 de la serialización canónica (claves ordenadas) de capability+params+identidad. */
function cacheKey(capName: string, params: unknown, identity: IdentityContext): string {
  const material = canonical({
    capability: capName,
    params: params ?? null,
    user: identity.user ?? '',
    agent: identity.agent,
    claims: normalizeClaims(identity.claims),
  })
  return createHash('sha256').update(material).digest('hex')
}

/** Envuelve una Capability de datos con caché por-consumidor (TTL + LRU + last-valid). */
export function withResultCache(cap: Capability, opts: ResultCacheOptions): CachedCapability {
  const max = opts.maxEntries ?? 500
  const now = opts.clock ?? (() => Date.now())
  // Map preserva orden de inserción → LRU barato: re-insertar al usar, expulsar el primero al desbordar.
  const entries = new Map<string, { value: unknown; expiresAt: number }>()
  const lastValid = new Map<string, unknown>()
  const counters = { hits: 0, misses: 0 }

  function touch<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key)
    map.set(key, value)
    if (map.size > max) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
  }

  return {
    name: cap.name, // mismo nombre: sustituye a la envuelta en el catálogo, transparente para el Botlet
    async execute(params: unknown, identity: IdentityContext, signal?: AbortSignal): Promise<unknown> {
      const key = cacheKey(cap.name, params, identity)
      const hit = entries.get(key)
      const t = now()
      if (hit && hit.expiresAt > t) {
        counters.hits += 1
        touch(entries, key, hit) // refresca recencia LRU (no extiende el TTL)
        return hit.value
      }
      if (hit) entries.delete(key) // expirada: purga al pasar (sin timer de fondo)
      counters.misses += 1
      const value = await cap.execute(params, identity, signal)
      touch(entries, key, { value, expiresAt: t + opts.ttlMs })
      touch(lastValid, key, value) // last-valid: sin expirar; mismo tope LRU
      return value
    },
    getLastValid(params: unknown, identity: IdentityContext): unknown | undefined {
      return lastValid.get(cacheKey(cap.name, params, identity))
    },
    stats() {
      return { ...counters, size: entries.size }
    },
  }
}
