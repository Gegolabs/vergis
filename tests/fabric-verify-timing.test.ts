/**
 * MEDICIÓN del arranque en frío de Motor C (issue #138·3) — no confirma la lectura del código: la
 * pone en riesgo. Cada experimento tiene una corrida que HABRÍA FALLADO si la hipótesis fuera falsa
 * (Norma 7 de Wingworking).
 *
 * - E1 · H1: el costo NO es lineal en N (PIs). La fuente se consulta POR CONEXIÓN, no por PI; la
 *   evaluación por PI es pura en memoria. Si fuera lineal (aun a 5 ms/PI), 40 PIs pasarían de 200 ms.
 * - E2 · H2: entre conexiones el costo es MAX, no suma (`Promise.all`). Secuencial daría ≥ 4 × L.
 * - E3 · H3: dentro de una conexión las 2 queries de sistema van EN PARALELO tras el fix. La versión
 *   secuencial daría ≥ 2 × L.
 * - E4 · H4 (#238): el sondeo del centinela de desenmascarado viaja en LA MISMA ola que las dos
 *   consultas de sistema. No es teoría: la primera versión de la implementación descubría los
 *   schemas y LUEGO leía —dos olas—, y ningún test funcional lo habría notado. Dos olas darían ≥ 2 × L.
 *
 * El reloj no decide solo: cada experimento asevera además CONTADORES de invocación (una llamada por
 * conexión / por query), de modo que un verde por jitter afortunado no puede pasar.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  verifyFabricServability,
  createFabricSourceStateOf,
  UNMASK_PROBE_SCHEMAS_SQL,
  UNMASK_PROBE_EXPECTED,
  SYS_SECURITY_POLICIES_SQL,
  SYS_VIEW_LINEAGE_SQL,
  type VerifiablePi,
  type SourceState,
} from '../server/engines/fabric'
import type { PolicyDecl } from '@vergis/policy'

/** Latencia simulada de UN round-trip a la fuente. */
const L = 60

const GOVERNED: PolicyDecl = {
  predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
  combine: 'and',
  default: 'deny',
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** `sourceStateOf` fake: duerme L por conexión y devuelve las tablas protegidas de esa conexión. */
function sleepySourceStateOf(byRef: Record<string, string[]>) {
  return vi.fn(async (ref: string): Promise<SourceState> => {
    await sleep(L)
    const tables = byRef[ref]
    if (!tables) throw new Error(`ref inesperada: ${ref}`)
    return { protectedTables: new Set(tables), viewLineage: new Map() }
  })
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now()
  const out = await fn()
  return [out, performance.now() - t0]
}

describe('arranque en frío de Motor C — escalamiento (issue #138·3)', () => {
  it('E1 · el costo NO escala con el número de PIs (1 PI vs 40 PIs, misma conexión)', async () => {
    const TABLES = Array.from({ length: 40 }, (_, i) => `dbo.t${i}`)
    const store = new Map<string, PolicyDecl>(TABLES.map((t) => [t, GOVERNED]))
    const sourceStateOf1 = sleepySourceStateOf({ wh: TABLES })
    const sourceStateOf40 = sleepySourceStateOf({ wh: TABLES })

    const pis1: VerifiablePi[] = [{ slug: 'pi-0', tables: [TABLES[0]!], databaseRefs: ['wh'] }]
    const pis40: VerifiablePi[] = TABLES.map((t, i) => ({ slug: `pi-${i}`, tables: [t], databaseRefs: ['wh'] }))

    const [r1, ms1] = await timed(() => verifyFabricServability({ pis: pis1, store, sourceStateOf: sourceStateOf1 }))
    const [r40, ms40] = await timed(() => verifyFabricServability({ pis: pis40, store, sourceStateOf: sourceStateOf40 }))
    console.log(`[E1] 1 PI: ${ms1.toFixed(1)} ms · 40 PIs: ${ms40.toFixed(1)} ms (L=${L} ms, 1 conexión)`)

    // Todos servibles: el experimento mide el camino feliz completo, no un atajo.
    expect([...r1.state.values()].every((v) => v.ok)).toBe(true)
    expect(r40.state.size).toBe(40)
    expect([...r40.state.values()].every((v) => v.ok)).toBe(true)

    // El reloj: ninguno de los dos pasa de 2,5 × L. Lineal a 5 ms/PI daría > 200 ms con 40 PIs.
    expect(ms1).toBeLessThan(2.5 * L)
    expect(ms40).toBeLessThan(2.5 * L)
    // El contador: una sola consulta a la fuente, con 1 PI y con 40.
    expect(sourceStateOf1).toHaveBeenCalledTimes(1)
    expect(sourceStateOf40).toHaveBeenCalledTimes(1)
  })

  it('E2 · entre conexiones el costo es el máximo, no la suma (4 conexiones, 8 PIs)', async () => {
    const byRef: Record<string, string[]> = {
      wh1: ['dbo.a1', 'dbo.a2'],
      wh2: ['dbo.b1', 'dbo.b2'],
      wh3: ['dbo.c1', 'dbo.c2'],
      wh4: ['dbo.d1', 'dbo.d2'],
    }
    const store = new Map<string, PolicyDecl>(Object.values(byRef).flat().map((t) => [t, GOVERNED]))
    const sourceStateOf = sleepySourceStateOf(byRef)
    const pis: VerifiablePi[] = Object.entries(byRef).flatMap(([ref, tables]) =>
      tables.map((t) => ({ slug: `pi-${t}`, tables: [t], databaseRefs: [ref] })),
    )

    const [res, ms] = await timed(() => verifyFabricServability({ pis, store, sourceStateOf }))
    console.log(`[E2] 4 conexiones · 8 PIs: ${ms.toFixed(1)} ms (L=${L} ms; secuencial daría ≥ ${4 * L} ms)`)

    expect(res.usedRefs.sort()).toEqual(['wh1', 'wh2', 'wh3', 'wh4'])
    expect(res.state.size).toBe(8)
    expect([...res.state.values()].every((v) => v.ok)).toBe(true)
    expect(ms).toBeLessThan(2.5 * L)
    // Una consulta POR CONEXIÓN (no por PI): 4, con 8 PIs en juego.
    expect(sourceStateOf).toHaveBeenCalledTimes(4)
  })

  it('E3 · las 2 queries de sistema de una conexión van en paralelo (createFabricSourceStateOf)', async () => {
    const calls: string[] = []
    const execute = vi.fn(async (input: { database_ref: string; sql: string }) => {
      calls.push(input.sql)
      await sleep(L)
      if (input.sql === SYS_SECURITY_POLICIES_SQL) {
        return { rows: [{ sch: 'dbo', tbl: 'saldos' }] as Record<string, unknown>[] }
      }
      // Linaje con par repetido (una fila por columna referenciada) → debe deduplicarse. Desde H8 la
      // query trae `bound` y las dos poblaciones se separan en el cliente: schemabound hereda solo,
      // no-schemabound queda como evidencia de corroboración (y una fila sin `bound` legible cae al
      // cubo que NO hereda — degradación hacia el lado seguro).
      return {
        rows: [
          { vsch: 'dbo', vname: 'v_saldos', bsch: 'dbo', bname: 'saldos', bound: 1 },
          { vsch: 'dbo', vname: 'v_saldos', bsch: 'dbo', bname: 'saldos', bound: 1 },
          { vsch: 'dbo', vname: 'v_saldos', bsch: 'dbo', bname: 'ventas', bound: 1 },
          { vsch: 'dbo', vname: 'vw_mask_saldos', bsch: 'dbo', bname: 'saldos', bound: 0 },
          { vsch: 'dbo', vname: 'v_rara', bsch: 'dbo', bname: 'saldos' }, // sin bit → no-schemabound
        ] as Record<string, unknown>[],
      }
    })

    const sourceStateOf = createFabricSourceStateOf(execute)
    const [state, ms] = await timed(() => sourceStateOf('wh'))
    console.log(`[E3] 2 queries de sistema en 1 conexión: ${ms.toFixed(1)} ms (L=${L} ms; secuencial daría ≥ ${2 * L} ms)`)

    expect(ms).toBeLessThan(1.6 * L)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(calls.sort()).toEqual([SYS_SECURITY_POLICIES_SQL, SYS_VIEW_LINEAGE_SQL].sort())
    // Shape intacto respecto del closure que reemplaza: tablas protegidas + linaje deduplicado.
    expect([...state.protectedTables]).toEqual(['dbo.saldos'])
    expect([...state.viewLineage]).toEqual([['dbo.v_saldos', ['dbo.saldos', 'dbo.ventas']]])
    expect([...(state.unboundViewLineage ?? [])]).toEqual([
      ['dbo.vw_mask_saldos', ['dbo.saldos']],
      ['dbo.v_rara', ['dbo.saldos']],
    ])
    expect(execute).toHaveBeenCalledWith({ database_ref: 'wh', sql: SYS_SECURITY_POLICIES_SQL })
    expect(execute).toHaveBeenCalledWith({ database_ref: 'wh', sql: SYS_VIEW_LINEAGE_SQL })
  })

  it('E3b · si una de las dos queries falla, el par rechaza (indeterminación por-ref intacta)', async () => {
    const execute = vi.fn(async (input: { database_ref: string; sql: string }) => {
      if (input.sql === SYS_VIEW_LINEAGE_SQL) throw new Error('warehouse pausado')
      return { rows: [] as Record<string, unknown>[] }
    })
    await expect(createFabricSourceStateOf(execute)('wh')).rejects.toThrow('warehouse pausado')
  })

  it('E4 · #238 · el sondeo del centinela viaja en LA MISMA ola — no agrega una vuelta al arranque en frío', async () => {
    // El defecto que este test previene ya ocurrió durante la implementación: una primera versión
    // descubría los schemas con una consulta y LUEGO leía, convirtiendo una ola en dos. El costo no
    // se nota en un test funcional —todo pasa igual— y sí en el arranque en frío de una instancia
    // con muchas conexiones, que es justo lo que #138·3 acotó.
    const execute = vi.fn(async (input: { database_ref: string; sql: string }) => {
      await sleep(L)
      if (input.sql === SYS_SECURITY_POLICIES_SQL) return { rows: [{ sch: 'dbo', tbl: 'saldos' }] as Record<string, unknown>[] }
      if (input.sql === UNMASK_PROBE_SCHEMAS_SQL) return { rows: [{ sch: 'dbo' }] as Record<string, unknown>[] }
      if (input.sql.includes('vergis_unmask_probe')) return { rows: [{ probe: UNMASK_PROBE_EXPECTED }] as Record<string, unknown>[] }
      return { rows: [] as Record<string, unknown>[] }
    })
    const [state, ms] = await timed(() => createFabricSourceStateOf(execute, ['dbo'])('wh'))
    console.log(`[E4] 4 queries (2 de sistema + 2 del centinela) en 1 conexión: ${ms.toFixed(1)} ms (L=${L} ms; dos olas darían ≥ ${2 * L} ms)`)
    expect(state.unmask).toBe('capable')
    expect(ms).toBeLessThan(1.8 * L) // UNA ola, no dos
    expect(execute).toHaveBeenCalledTimes(4)
  })

  it('E4b · #238 · sin schemas declarados no se emite NI UNA consulta de centinela', async () => {
    const execute = vi.fn(async () => ({ rows: [] as Record<string, unknown>[] }))
    const state = await createFabricSourceStateOf(execute)('wh')
    expect(state.unmask).toBeUndefined()
    expect(execute).toHaveBeenCalledTimes(2) // exactamente las dos de siempre
  })
})
