import { describe, it, expect } from 'vitest'
import { parseCatalog, nivelOf, isProbeable, probeableNames, nivelForName, databaseRefForName, resolveProbeRoute, type CatalogEntry } from '@vergis/miranda'

describe('parseCatalog · niveles + compat', () => {
  it('parsea una lista cruda (formato histórico, sin nivel) → todo gestionado', () => {
    const { catalog, warnings } = parseCatalog([{ name: 'dbo.v_saldos', schema: 'dbo', description: 'saldos' }])
    expect(warnings).toEqual([])
    expect(catalog).toHaveLength(1)
    expect(nivelOf(catalog[0])).toBe('gestionado') // ausencia de nivel ⇒ gestionado (compat)
    expect(isProbeable(catalog[0])).toBe(true)
  })

  it('parsea el envoltorio {catalog:[…]} con niveles y campos por nivel', () => {
    const { catalog } = parseCatalog({
      catalog: [
        { name: 'dbo.v_saldos', nivel: 'gestionado', dominio: 'Finanzas' },
        { name: 'SAP-B1', nivel: 'conectado', sistema: 'SAP Business One', dominio: 'Ventas' },
        { name: 'Transtecnia', nivel: 'conectable', sistema: 'Transtecnia' },
        { name: 'lab-plan', nivel: 'alcanzable', artefacto: 'Excel de planificación de laboratorio', dueno: 'por confirmar' },
        { name: 'saber-tácito', nivel: 'elicitable', quien_sabe: 'por confirmar' },
      ],
    })
    expect(catalog).toHaveLength(5)
    expect(catalog[1].sistema).toBe('SAP Business One')
    expect(catalog[3].artefacto).toBe('Excel de planificación de laboratorio')
    expect(catalog[3].dueno).toBe('por confirmar')
    expect(catalog[4].quien_sabe).toBe('por confirmar')
  })

  it('un nivel desconocido se degrada a gestionado con advertencia (no revienta)', () => {
    const { catalog, warnings } = parseCatalog([{ name: 'x', nivel: 'desconocido' }])
    expect(nivelOf(catalog[0])).toBe('gestionado')
    expect(warnings.some((w) => /desconocido/.test(w))).toBe(true)
  })

  it('ignora entradas sin name; catálogo no-lista → vacío con advertencia', () => {
    const { catalog, warnings } = parseCatalog([{ schema: 'dbo' }, { name: '  ' }, { name: 'ok' }])
    expect(catalog.map((c) => c.name)).toEqual(['ok'])
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    expect(parseCatalog(42).catalog).toEqual([])
  })
})

describe('helpers de nivel', () => {
  const catalog: CatalogEntry[] = [
    { name: 'dbo.v_saldos' }, // sin nivel → gestionado
    { name: 'dbo.v_asistencia', nivel: 'gestionado' },
    { name: 'sap.libro_mayor', nivel: 'conectado' },
    { name: 'transtecnia.contab', nivel: 'conectable' },
  ]

  it('probeableNames = solo las gestionadas', () => {
    expect(probeableNames(catalog).sort()).toEqual(['dbo.v_asistencia', 'dbo.v_saldos'])
  })

  it('nivelForName resuelve por hoja del nombre calificado', () => {
    expect(nivelForName(catalog, 'v_saldos')).toBe('gestionado')
    expect(nivelForName(catalog, 'dbo.v_saldos')).toBe('gestionado')
    expect(nivelForName(catalog, 'libro_mayor')).toBe('conectado')
    expect(nivelForName(catalog, 'no_existe')).toBeUndefined()
  })
})

describe('ruteo por database_ref (plan 099)', () => {
  it('parseCatalog captura database_ref', () => {
    const { catalog } = parseCatalog({
      catalog: [
        { name: 'dbo.v_saldos', nivel: 'gestionado', dominio: 'Finanzas', database_ref: 'finanzas' },
        { name: 'dbo.v_movimiento', nivel: 'gestionado', dominio: 'Ventas', database_ref: 'ventas' },
        { name: 'dbo.viejo' }, // compat: sin ref
      ],
    })
    expect(catalog[0].database_ref).toBe('finanzas')
    expect(catalog[1].database_ref).toBe('ventas')
    expect(catalog[2].database_ref).toBeUndefined()
  })

  const catalog: CatalogEntry[] = [
    { name: 'dbo.v_saldos', database_ref: 'finanzas' },
    { name: 'dbo.v_movimiento', database_ref: 'ventas' },
    { name: 'dbo.v_compromiso', database_ref: 'presupuesto' },
    { name: 'dbo.v_viejo' }, // sin ref (compat)
  ]

  it('databaseRefForName resuelve por hoja', () => {
    expect(databaseRefForName(catalog, 'v_movimiento')).toBe('ventas')
    expect(databaseRefForName(catalog, 'dbo.v_saldos')).toBe('finanzas')
    expect(databaseRefForName(catalog, 'v_viejo')).toBeUndefined() // sin ref → fallback aguas arriba
    expect(databaseRefForName(catalog, 'no_existe')).toBeUndefined()
  })

  it('resolveProbeRoute: un solo dominio → rutea a su ref', () => {
    expect(resolveProbeRoute(catalog, ['v_movimiento'])).toEqual({ kind: 'ref', ref: 'ventas' })
    expect(resolveProbeRoute(catalog, ['v_saldos'])).toEqual({ kind: 'ref', ref: 'finanzas' })
  })

  it('resolveProbeRoute: objetos sin ref → fallback (default global)', () => {
    expect(resolveProbeRoute(catalog, ['v_viejo'])).toEqual({ kind: 'fallback' })
    expect(resolveProbeRoute(catalog, [])).toEqual({ kind: 'fallback' })
  })

  it('resolveProbeRoute: dos dominios distintos → multi (cruce imposible)', () => {
    const r = resolveProbeRoute(catalog, ['v_saldos', 'v_movimiento'])
    expect(r.kind).toBe('multi')
    if (r.kind === 'multi') expect(r.refs).toEqual(['finanzas', 'ventas'])
  })

  it('resolveProbeRoute: mismo dominio dos veces → un solo ref (self-join)', () => {
    expect(resolveProbeRoute(catalog, ['v_movimiento', 'v_movimiento'])).toEqual({ kind: 'ref', ref: 'ventas' })
  })
})
