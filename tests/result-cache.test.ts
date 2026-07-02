// `withResultCache` (work/052 §2.3): capability-wrapper genérico de caché de datos POR CONSUMIDOR.
// La clave incluye capability+params+identidad NORMALIZADA (user + claims ordenados) → dos
// consumidores jamás comparten entrada (RLS). TTL + tope LRU + last-valid (base de show_last_valid).
import { describe, expect, it } from 'vitest'
import { withResultCache, type Capability, type IdentityContext } from '@vergis/botler'

/** Capability instrumentada: cuenta ejecuciones y devuelve un payload que identifica la llamada. */
function countingCap(): { cap: Capability; calls: () => number } {
  let n = 0
  return {
    cap: {
      name: 'mock-data',
      async execute(params: unknown, identity: IdentityContext): Promise<unknown> {
        n += 1
        return { rows: [{ call: n, user: identity.user ?? '', params }] }
      },
    },
    calls: () => n,
  }
}

const ANA: IdentityContext = { agent: 'vergis', user: 'ana@x.cl', claims: { groups: ['finanzas'] } }
const BETO: IdentityContext = { agent: 'vergis', user: 'beto@x.cl', claims: { groups: ['finanzas'] } }
const P = { sql: 'SELECT 1 FROM dbo.t' }

describe('withResultCache · caché de datos por consumidor', () => {
  it('misma identidad + mismos params → HIT (la capability subyacente se llama 1 vez)', async () => {
    const { cap, calls } = countingCap()
    const cached = withResultCache(cap, { ttlMs: 60_000 })
    const a = await cached.execute(P, ANA)
    const b = await cached.execute(P, ANA)
    expect(calls()).toBe(1)
    expect(b).toBe(a) // misma salida (referencia): un hit no re-ejecuta
    expect(cached.stats()).toMatchObject({ hits: 1, misses: 1 })
  })

  it('claims/usuario distintos → MISS (dos consumidores JAMÁS comparten entrada)', async () => {
    const { cap, calls } = countingCap()
    const cached = withResultCache(cap, { ttlMs: 60_000 })
    await cached.execute(P, ANA)
    await cached.execute(P, BETO) // otro user
    await cached.execute(P, { ...ANA, claims: { groups: ['personas'] } }) // otros claims
    await cached.execute(P, { ...ANA, claims: {} }) // sin claims ≠ con claims
    expect(calls()).toBe(4)
  })

  it('la clave normaliza claims: orden de valores y string-vs-arreglo NO cambian la identidad', async () => {
    const { cap, calls } = countingCap()
    const cached = withResultCache(cap, { ttlMs: 60_000 })
    await cached.execute(P, { agent: 'v', user: 'ana@x.cl', claims: { groups: ['b', 'a'] } })
    await cached.execute(P, { agent: 'v', user: 'ana@x.cl', claims: { groups: ['a', 'b'] } })
    await cached.execute(P, { agent: 'v', user: 'ana@x.cl', claims: { groups: ['a', 'b'], vacio: undefined } })
    expect(calls()).toBe(1)
  })

  it('params distintos → MISS; la serialización canónica ignora el orden de claves', async () => {
    const { cap, calls } = countingCap()
    const cached = withResultCache(cap, { ttlMs: 60_000 })
    await cached.execute({ sql: 'A', params: { x: 1, y: 2 } }, ANA)
    await cached.execute({ params: { y: 2, x: 1 }, sql: 'A' }, ANA) // mismas claves, otro orden → hit
    await cached.execute({ sql: 'B' }, ANA) // otro sql → miss
    expect(calls()).toBe(2)
  })

  it('TTL vencido → refetch (y el last-valid sigue disponible)', async () => {
    let t = 1_000
    const { cap, calls } = countingCap()
    const cached = withResultCache(cap, { ttlMs: 500, clock: () => t })
    const first = await cached.execute(P, ANA)
    t += 501 // vence el TTL
    expect(cached.getLastValid(P, ANA)).toBe(first) // last-valid NO expira
    await cached.execute(P, ANA)
    expect(calls()).toBe(2) // refetch
  })

  it('respeta el tope de entradas (LRU): al desbordar, expulsa la más antigua', async () => {
    const { cap, calls } = countingCap()
    const cached = withResultCache(cap, { ttlMs: 60_000, maxEntries: 2 })
    await cached.execute({ sql: 'A' }, ANA)
    await cached.execute({ sql: 'B' }, ANA)
    await cached.execute({ sql: 'C' }, ANA) // desborda: 'A' (la más antigua) sale
    expect(cached.stats().size).toBe(2)
    await cached.execute({ sql: 'A' }, ANA) // miss: fue expulsada
    expect(calls()).toBe(4)
    await cached.execute({ sql: 'C' }, ANA) // hit: sigue viva
    expect(calls()).toBe(4)
  })

  it('getLastValid es por-identidad: la de otro consumidor no se filtra', async () => {
    const { cap } = countingCap()
    const cached = withResultCache(cap, { ttlMs: 60_000 })
    await cached.execute(P, ANA)
    expect(cached.getLastValid(P, ANA)).toBeDefined()
    expect(cached.getLastValid(P, BETO)).toBeUndefined()
  })
})
