import { describe, it, expect } from 'vitest'
import { deriveAsOfIngesta, createAsOfProvider, type RunRecord, type IngestionEngineClient } from '../packages/capabilities/src/index'

/**
 * Corte as-of por INGESTA (issue #108 · D1.2 y D6): la derivación pura y el proveedor cacheado.
 * Todo el riesgo del frente (mínimo garantizado, insumo ciego, caché, timeout) vive acá — el server
 * solo llama y pasa.
 */

const TOPOLOGIA = {
  processOutputs: [
    { processId: 'p-personas', tableRef: 'silver.personas' },
    { processId: 'p-cartera', tableRef: 'silver.cartera' },
    { processId: 'p-otro', tableRef: 'silver.otro' },
    { processId: 'p-huerfano', tableRef: 'silver.huerfano' },
  ],
  processes: [
    { id: 'p-personas', sourceId: 's-rrhh' },
    { id: 'p-cartera', sourceId: 's-fin' },
    { id: 'p-otro', sourceId: 's-suelta' },
    { id: 'p-huerfano', sourceId: 's-rrhh' },
  ],
  sources: [
    { id: 's-rrhh', domain: 'personas' },
    { id: 's-fin', domain: 'cartera' },
    { id: 's-suelta' }, // fuente sin dominio declarado
  ],
  domainLabels: { personas: 'Personas', cartera: 'Cartera / Finanzas' },
}

describe('deriveAsOfIngesta', () => {
  it('con tres dominios de cortes distintos, el corte es el MÍNIMO y el detalle trae el label de cada uno', () => {
    const r = deriveAsOfIngesta({
      ...TOPOLOGIA,
      tables: ['silver.personas', 'silver.cartera', 'silver.otro'],
      lastSuccessByProcess: {
        'p-personas': '2026-08-04T11:00:00.000Z',
        'p-cartera': '2026-08-04T01:15:00.000Z',
        'p-otro': '2026-08-05T09:00:00.000Z',
      },
    })
    expect(r.cutoff).toBe('2026-08-04T01:15:00.000Z') // el más atrasado manda: es lo único garantizable
    expect(r.detail).toEqual([
      { domainId: 'cartera', label: 'Cartera / Finanzas', lastSuccessAt: '2026-08-04T01:15:00.000Z' },
      { domainId: 'personas', label: 'Personas', lastSuccessAt: '2026-08-04T11:00:00.000Z' },
      { domainId: null, label: '(sin dominio)', lastSuccessAt: '2026-08-05T09:00:00.000Z' },
    ])
  })

  it('un dominio con varios procesos se resume en el más antiguo de ellos', () => {
    const r = deriveAsOfIngesta({
      ...TOPOLOGIA,
      tables: ['silver.personas', 'silver.huerfano'],
      lastSuccessByProcess: { 'p-personas': '2026-08-04T11:00:00.000Z', 'p-huerfano': '2026-08-02T06:00:00.000Z' },
    })
    expect(r.detail).toEqual([{ domainId: 'personas', label: 'Personas', lastSuccessAt: '2026-08-02T06:00:00.000Z' }])
    expect(r.cutoff).toBe('2026-08-02T06:00:00.000Z')
  })

  it('un dominio no declarado en la config se rotula con su propio id', () => {
    const r = deriveAsOfIngesta({
      ...TOPOLOGIA,
      domainLabels: {},
      tables: ['silver.personas'],
      lastSuccessByProcess: { 'p-personas': '2026-08-04T11:00:00.000Z' },
    })
    expect(r.detail[0]).toMatchObject({ domainId: 'personas', label: 'personas' })
  })

  it('un proceso involucrado SIN corrida exitosa conocida anula el corte, pero el detalle conserva lo sabido', () => {
    const r = deriveAsOfIngesta({
      ...TOPOLOGIA,
      tables: ['silver.personas', 'silver.cartera'],
      lastSuccessByProcess: { 'p-personas': '2026-08-04T11:00:00.000Z', 'p-cartera': null },
    })
    expect(r.cutoff).toBeNull() // un corte garantizado no se afirma con un insumo ciego
    expect(r.detail).toEqual([{ domainId: 'personas', label: 'Personas', lastSuccessAt: '2026-08-04T11:00:00.000Z' }])
  })

  it('un proceso involucrado AUSENTE del mapa cuenta como desconocido (no como inexistente)', () => {
    const r = deriveAsOfIngesta({
      ...TOPOLOGIA,
      tables: ['silver.personas', 'silver.cartera'],
      lastSuccessByProcess: { 'p-personas': '2026-08-04T11:00:00.000Z' },
    })
    expect(r.cutoff).toBeNull()
  })

  it('tablas sin proceso productor registrado → corte vacío', () => {
    const r = deriveAsOfIngesta({
      ...TOPOLOGIA,
      tables: ['silver.desconocida'],
      lastSuccessByProcess: { 'p-personas': '2026-08-04T11:00:00.000Z' },
    })
    expect(r).toEqual({ cutoff: null, detail: [] })
  })
})

/** Engine falso con contador de llamadas y comportamiento por proceso. */
function fakeEngine(behavior: Record<string, RunRecord[] | 'throw' | 'hang'>): IngestionEngineClient & { calls: number } {
  const e = {
    calls: 0,
    async listRunHistory(processRef: string): Promise<RunRecord[]> {
      e.calls++
      const b = behavior[processRef]
      if (b === 'throw') throw new Error('motor caído')
      if (b === 'hang') return new Promise<RunRecord[]>(() => {}) // jamás resuelve
      return b ?? []
    },
    async getScheduleSeconds(): Promise<number | null> { return null },
    async setScheduleSeconds(): Promise<void> {},
    async setScheduleEnabled(): Promise<void> {},
  }
  return e
}

const RUNS_OK: RunRecord[] = [
  { startedAt: '2026-08-04T10:00:00.000Z', endedAt: '2026-08-04T11:00:00.000Z', status: 'Completed' },
  { startedAt: '2026-08-05T10:00:00.000Z', status: 'Failed' },
]

describe('createAsOfProvider', () => {
  it('cachea por TTL: la 2ª llamada dentro de la ventana no vuelve a pegarle al motor; pasado el TTL, sí', async () => {
    const engine = fakeEngine({ 'p-personas': RUNS_OK })
    let t = 1_000
    const asOf = createAsOfProvider({ engine, loadTopology: async () => TOPOLOGIA, now: () => t, ttlMs: 60_000 })

    const a = await asOf(['silver.personas'])
    expect(a.cutoff).toBe('2026-08-04T11:00:00.000Z')
    expect(engine.calls).toBe(1)

    t += 30_000
    const b = await asOf(['silver.personas'])
    expect(b.cutoff).toBe('2026-08-04T11:00:00.000Z')
    expect(engine.calls).toBe(1) // caché caliente

    t += 40_000 // ya fuera del TTL
    await asOf(['silver.personas'])
    expect(engine.calls).toBe(2)
  })

  it('un motor que LANZA deja el corte no disponible, sin propagar la excepción, y no se re-consulta dentro del TTL', async () => {
    const engine = fakeEngine({ 'p-personas': 'throw' })
    const asOf = createAsOfProvider({ engine, loadTopology: async () => TOPOLOGIA, ttlMs: 60_000 })
    const r = await asOf(['silver.personas'])
    expect(r).toEqual({ cutoff: null, detail: [] })
    await asOf(['silver.personas'])
    expect(engine.calls).toBe(1) // el null también se cachea: no se martilla una API caída
  })

  it('un motor COLGADO se corta por timeout y el PI se sirve igual', async () => {
    const engine = fakeEngine({ 'p-personas': 'hang' })
    const asOf = createAsOfProvider({ engine, loadTopology: async () => TOPOLOGIA, timeoutMs: 20 })
    const r = await asOf(['silver.personas'])
    expect(r).toEqual({ cutoff: null, detail: [] })
  })

  it('sin engine no llama a nada y devuelve el corte vacío', async () => {
    let topologias = 0
    const asOf = createAsOfProvider({
      engine: undefined,
      loadTopology: async () => { topologias++; return TOPOLOGIA },
    })
    expect(await asOf(['silver.personas'])).toEqual({ cutoff: null, detail: [] })
    expect(topologias).toBe(0)
  })

  it('con varios procesos involucrados consulta cada uno una vez y devuelve el mínimo', async () => {
    const engine = fakeEngine({
      'p-personas': RUNS_OK,
      'p-cartera': [{ startedAt: '2026-08-03T20:00:00.000Z', endedAt: '2026-08-03T22:15:00.000Z', status: 'Completed' }],
    })
    const asOf = createAsOfProvider({ engine, loadTopology: async () => TOPOLOGIA })
    const r = await asOf(['silver.personas', 'silver.cartera'])
    expect(engine.calls).toBe(2)
    expect(r.cutoff).toBe('2026-08-03T22:15:00.000Z')
    expect(r.detail.map((d) => d.label)).toEqual(['Cartera / Finanzas', 'Personas'])
  })

  it('una topología que revienta no tumba el render: corte vacío', async () => {
    const engine = fakeEngine({})
    const asOf = createAsOfProvider({ engine, loadTopology: async () => { throw new Error('store caído') } })
    expect(await asOf(['silver.personas'])).toEqual({ cutoff: null, detail: [] })
  })
})
