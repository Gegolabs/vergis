import { describe, it, expect } from 'vitest'
import {
  durationToSeconds,
  secondsToDuration,
  demandaCeilingSeconds,
  isDemandaWithinCeiling,
  requiredCadenceSeconds,
  deriveIngestionMap,
  deriveEntityFreshness,
  validateOferta,
  SqliteGovernanceStore,
} from '@vergis/capabilities'

describe('freshness · duraciones ISO-8601', () => {
  it('parsea horas/días/semanas y minutos vs meses por posición', () => {
    expect(durationToSeconds('PT1H')).toBe(3600)
    expect(durationToSeconds('P1D')).toBe(86400)
    expect(durationToSeconds('P1W')).toBe(7 * 86400)
    expect(durationToSeconds('PT30M')).toBe(1800) // minutos (tras T)
    expect(durationToSeconds('P1M')).toBe(30 * 86400) // mes (antes de T)
    expect(() => durationToSeconds('1 hora')).toThrow()
    expect(() => durationToSeconds('P')).toThrow()
  })
  it('round-trip aproximado a duración legible', () => {
    expect(secondsToDuration(3600)).toBe('PT1H')
    expect(secondsToDuration(86400)).toBe('P1D')
    expect(secondsToDuration(7 * 86400)).toBe('P1W')
  })
})

describe('freshness · techo de demanda (no exigir más fresco que la fuente más lenta)', () => {
  it('el ejemplo de César: PI quiere PT1H, fuente da P1D → NO permitido', () => {
    expect(isDemandaWithinCeiling('PT1H', ['P1D'])).toBe(false)
    expect(isDemandaWithinCeiling('P1D', ['P1D'])).toBe(true)
    expect(isDemandaWithinCeiling('P1W', ['P1D'])).toBe(true) // menos exigente, OK
  })
  it('el techo lo marca la fuente MÁS LENTA entre varios insumos', () => {
    expect(demandaCeilingSeconds(['PT1H', 'P1D', 'PT6H'])).toBe(86400) // la diaria manda
    expect(isDemandaWithinCeiling('PT6H', ['PT1H', 'P1D'])).toBe(false) // < diaria → no
    expect(isDemandaWithinCeiling('P1D', ['PT1H', 'P1D'])).toBe(true)
  })
  it('sin insumos conocidos → permitida (no se puede acotar)', () => {
    expect(isDemandaWithinCeiling('PT1H', [])).toBe(true)
  })
})

describe('freshness · cadencia requerida de un proceso', () => {
  it('el PI más exigente marca el paso, con piso en la oferta', () => {
    expect(requiredCadenceSeconds(['PT1H', 'P1D'], 'PT15M')).toBe(3600) // mín demanda = 1h > oferta 15m
    expect(requiredCadenceSeconds(['PT5M'], 'PT15M')).toBe(900) // demanda 5m < oferta 15m → piso oferta
    expect(requiredCadenceSeconds([], 'P1D')).toBe(86400) // sin demandas → la oferta
  })
})

describe('freshness · deriveIngestionMap', () => {
  it('deriva cadencia por proceso y marca insatisfacibles', () => {
    const map = deriveIngestionMap({
      sources: [
        { id: 'buk', oferta: 'P1D' },
        { id: 'sap', oferta: 'PT1H' },
      ],
      processes: [
        { id: 'pipe_personas', label: 'Personas', sourceId: 'buk' },
        { id: 'pipe_finanzas', label: 'Finanzas', sourceId: 'sap' },
      ],
      processOutputs: [
        { processId: 'pipe_personas', tableRef: 'dbo.fct_asistencia' },
        { processId: 'pipe_finanzas', tableRef: 'dbo.fact_saldos' },
      ],
      piTables: [
        { piCode: 'PI-04', tables: ['dbo.fct_asistencia'] },
        { piCode: 'PI-01', tables: ['dbo.fact_saldos'] },
      ],
      piDemandas: [
        { piCode: 'PI-04', maxAge: 'PT1H' }, // exige más que la oferta diaria de buk → insatisfacible
        { piCode: 'PI-01', maxAge: 'PT6H' }, // sap ofrece horaria → satisfacible, corre cada 6h
      ],
    })
    const personas = map.find((r) => r.processId === 'pipe_personas')!
    expect(personas.dependentPis).toEqual(['PI-04'])
    expect(personas.requiredCadence).toBe('P1D') // piso en la oferta diaria
    expect(personas.unsatisfiable).toBe(true) // PI-04 quería PT1H pero la fuente da P1D
    const finanzas = map.find((r) => r.processId === 'pipe_finanzas')!
    expect(finanzas.requiredCadence).toBe('PT6H')
    expect(finanzas.unsatisfiable).toBe(false)
  })
})

describe('SourceRegistryStore · fuentes, mapeos y ofertas-por-tabla', () => {
  it('registra fuentes/procesos y resuelve ofertas de las tablas de un PI', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    await g.upsertSource('buk', 'Buk RRHH', 'P1D', { connectedBy: 'cesar@x.com' })
    await g.upsertSource('sap', 'SAP B1', 'PT1H')
    await g.setTableSource('dbo.fct_asistencia', 'buk')
    await g.setTableSource('dbo.fact_saldos', 'sap')
    expect((await g.listSources()).map((s) => s.id)).toEqual(['buk', 'sap'])
    const ofertas = await g.ofertasForTables(['dbo.fct_asistencia', 'dbo.fact_saldos'])
    expect(ofertas.sort()).toEqual(['P1D', 'PT1H'])
    expect(isDemandaWithinCeiling('PT2H', ofertas)).toBe(false) // < diaria
    await g.upsertProcess('pipe_saldos', 'Pipeline saldos', 'sap')
    await g.setProcessOutput('pipe_saldos', 'dbo.fact_saldos')
    expect((await g.listProcessOutputs()).length).toBe(1)
    await expect(g.upsertSource('Mal Id', 'x', 'P1D')).rejects.toThrow(/inválido/)
    await expect(g.upsertSource('s', 'x', 'cada día')).rejects.toThrow(/ISO/)
    await g.close()
  })
})

// oferta: evento — fuentes EVENT-DRIVEN (cada llegada es un evento, sin cadencia; caso B2B Sodimac).
describe('oferta: evento (fuentes event-driven)', () => {
  const SRC = [{ id: 'b2b', oferta: 'evento' }, { id: 'sap', oferta: 'P1W' }]
  const PROCS = [
    { id: 'p_oc', label: 'OC crossdocking', sourceId: 'b2b' },
    { id: 'p_saldos', label: 'Saldos', sourceId: 'sap' },
  ]
  const OUTS = [
    { processId: 'p_oc', tableRef: 'dbo.fct_despacho' },
    { processId: 'p_saldos', tableRef: 'dbo.fact_saldos' },
  ]
  const PI_TABLES = [
    { piCode: 'PI-07', tables: ['dbo.fct_despacho'] },
    { piCode: 'PI-01', tables: ['dbo.fact_saldos'] },
  ]

  it('validateOferta: acepta ISO y `evento`; rechaza lo demás', () => {
    expect(() => validateOferta('P1W')).not.toThrow()
    expect(() => validateOferta('evento')).not.toThrow()
    expect(() => validateOferta('EVENTO')).not.toThrow()
    expect(() => validateOferta('cuando llegue')).toThrow()
  })

  it('deriveIngestionMap: el proceso event-driven NO entra al mapa del reconciliador (nada que agendar)', () => {
    const map = deriveIngestionMap({ sources: SRC, processes: PROCS, processOutputs: OUTS, piTables: PI_TABLES, piDemandas: [] })
    expect(map.map((m) => m.processId)).toEqual(['p_saldos'])
  })

  it('deriveEntityFreshness: la entidad event-driven aparece con oferta `evento`, sin cadencia ni insatisfacible', () => {
    const rows = deriveEntityFreshness({ sources: SRC, processes: PROCS, processOutputs: OUTS, piTables: PI_TABLES, piDemandas: [] })
    const oc = rows.find((r) => r.entity === 'dbo.fct_despacho')!
    expect(oc.oferta).toBe('evento')
    expect(oc.requiredCadence).toBeNull()
    expect(oc.unsatisfiable).toBe(false)
    expect(oc.dependentPis).toEqual(['PI-07'])
  })

  it('deriveEntityFreshness: con demanda declarada, la cadencia requerida ES la demanda (sin piso de oferta)', () => {
    const rows = deriveEntityFreshness({ sources: SRC, processes: PROCS, processOutputs: OUTS, piTables: PI_TABLES, piDemandas: [{ piCode: 'PI-07', maxAge: 'P1D' }] })
    const oc = rows.find((r) => r.entity === 'dbo.fct_despacho')!
    expect(oc.requiredCadenceSeconds).toBe(86400)
    expect(oc.unsatisfiable).toBe(false) // evento jamás pone piso
  })

  it('demandaCeilingSeconds ignora las ofertas evento (no imponen techo a la demanda)', () => {
    expect(demandaCeilingSeconds(['evento', 'P1W'])).toBe(7 * 86400)
    expect(demandaCeilingSeconds(['evento'])).toBe(0)
    expect(isDemandaWithinCeiling('PT1H', ['evento'])).toBe(true)
  })
})
