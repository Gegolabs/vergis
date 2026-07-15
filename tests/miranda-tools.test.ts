import { describe, it, expect, vi } from 'vitest'
import { buildToolRegistry, repr, type MirandaToolContext } from '@vergis/miranda'

function mockCtx(over: Partial<MirandaToolContext> = {}): MirandaToolContext {
  // Catálogo multi-nivel: una fuente gestionada (probeable) + una nivel-2 (conocida, NO consultable).
  const catalog = [
    { name: 'dbo.v_saldos', schema: 'dbo', description: 'saldos', rows_estimate: 1000, dominio: 'Finanzas' },
    { name: 'sap.libro_mayor', nivel: 'conectado' as const, sistema: 'SAP Business One', dominio: 'Ventas', description: 'movimientos contables' },
  ]
  return {
    catalog,
    runProbe: async () => ({ rows: [{ empresa: 'ACME', saldo: 10 }] }),
    columnsOf: async () => [{ name: 'empresa', type: 'nvarchar' }, { name: 'saldo', type: 'decimal' }],
    sampleRows: async () => [{ empresa: 'TC ', saldo: 5 }],
    profileColumn: async () => [{ value: 'TC ', count: 3 }, { value: 'TC', count: 7 }],
    listSpecs: () => [{ code: 'PI-101', name: 'Saldos' }],
    readSpec: (c) => (c === 'PI-101' ? 'mira_version: "1.0"' : null),
    validateDraft: (y) => (y.includes('mira_version') ? { ok: true } : { ok: false, error: 'falta mira_version' }),
    saveDraft: async () => ({ version: 1 }),
    updateIntent: async () => ({ version: 1 }),
    createDataRequest: async () => ({ ok: true }),
    renderPreview: async () => ({ url: '/miranda/preview/s1' }),
    runSelfCheck: async () => ({ veredicto: 'APROBADA', brechas: [] }),
    ...over,
  }
}

describe('repr()', () => {
  it('revela espacios y comillas de strings; NULL para nulos', () => {
    expect(repr('TC ')).toBe("'TC '")
    expect(repr('TC')).toBe("'TC'")
    expect(repr(null)).toBe('NULL')
    expect(repr(42)).toBe('42')
  })
})

describe('registry · dispatch y definiciones', () => {
  it('expone las 11 tools del plan', () => {
    const reg = buildToolRegistry(mockCtx())
    expect(reg.names.sort()).toEqual(
      ['catalog_tables', 'create_data_request', 'describe_table', 'list_pis', 'profile_column', 'read_spec', 'render_preview', 'run_probe', 'run_self_check', 'save_draft', 'update_intent_summary'].sort(),
    )
    expect(reg.definitions.every((d) => d.input_schema.type === 'object')).toBe(true)
  })
  it('tool desconocida → error estructurado (no lanza)', async () => {
    const reg = buildToolRegistry(mockCtx())
    expect(await reg.invoke('nope', {})).toEqual({ error: "Tool desconocida: 'nope'." })
  })
})

describe('tools · catálogo, describe, profile (repr)', () => {
  it('catalog_tables devuelve TODAS las fuentes con su nivel + probeable', async () => {
    const reg = buildToolRegistry(mockCtx())
    const r = (await reg.invoke('catalog_tables', {})) as { tables: { name: string; nivel: string; probeable: boolean; sistema?: string }[] }
    expect(r.tables).toHaveLength(2)
    const saldos = r.tables.find((t) => t.name === 'dbo.v_saldos')!
    expect(saldos.nivel).toBe('gestionado')
    expect(saldos.probeable).toBe(true)
    const sap = r.tables.find((t) => t.name === 'sap.libro_mayor')!
    expect(sap.nivel).toBe('conectado')
    expect(sap.probeable).toBe(false)
    expect(sap.sistema).toBe('SAP Business One') // el modelo ve el sistema (para razonar), el usuario NO
  })
  it('describe_table de objeto permitido → columnas + sample en repr()', async () => {
    const reg = buildToolRegistry(mockCtx())
    const r = (await reg.invoke('describe_table', { name: 'dbo.v_saldos' })) as { columns: unknown[]; sample: Record<string, string>[] }
    expect(r.columns).toHaveLength(2)
    expect(r.sample[0].empresa).toBe("'TC '") // el espacio se ve
  })
  it('describe_table de objeto NO en catálogo → error «no está en el catálogo»', async () => {
    const reg = buildToolRegistry(mockCtx())
    const r = (await reg.invoke('describe_table', { name: 'dbo.secreta' })) as { error: string }
    expect(r.error).toMatch(/no está en el catálogo/)
  })
  it('describe_table de fuente conocida NO gestionada (nivel 2) → rechazo claro, sin filtrar el nivel a la voz', async () => {
    const reg = buildToolRegistry(mockCtx())
    const r = (await reg.invoke('describe_table', { name: 'sap.libro_mayor' })) as { error: string }
    expect(r.error).toMatch(/no está en la capa de datos servible/i)
    expect(r.error).toMatch(/create_data_request/) // le indica el camino correcto
    expect(r.error).not.toMatch(/conectado/) // el nombre del nivel NO aparece en el mensaje
  })
  it('profile_column de fuente NO gestionada → mismo rechazo claro', async () => {
    const reg = buildToolRegistry(mockCtx())
    const r = (await reg.invoke('profile_column', { table: 'sap.libro_mayor', column: 'monto' })) as { error: string }
    expect(r.error).toMatch(/no está en la capa de datos servible/i)
  })
  it('profile_column revela \'TC \' vs \'TC\'', async () => {
    const reg = buildToolRegistry(mockCtx())
    const r = (await reg.invoke('profile_column', { table: 'dbo.v_saldos', column: 'clasificacion' })) as { values: { value: string; count: number }[] }
    expect(r.values.map((v) => v.value)).toEqual(["'TC '", "'TC'"])
  })
})

describe('tools · run_probe pasa por la guardia', () => {
  it('SELECT legítimo → ejecuta con TOP forzado', async () => {
    const runProbe = vi.fn(async () => ({ rows: [{ empresa: 'ACME', saldo: 10 }] }))
    const reg = buildToolRegistry(mockCtx({ runProbe }))
    const r = (await reg.invoke('run_probe', { sql: 'SELECT empresa, saldo FROM dbo.v_saldos', why: 'reconciliar total' })) as { executed_sql: string; row_count: number }
    expect(r.executed_sql).toContain('TOP 500')
    expect(runProbe).toHaveBeenCalledWith('SELECT TOP 500 empresa, saldo FROM dbo.v_saldos', 'reconciliar total')
    expect(r.row_count).toBe(1)
  })
  it('probe peligrosa → error de guardia, NO llega al runner', async () => {
    const runProbe = vi.fn(async () => ({ rows: [] }))
    const reg = buildToolRegistry(mockCtx({ runProbe }))
    const r = (await reg.invoke('run_probe', { sql: 'DROP TABLE dbo.v_saldos', why: 'x' })) as { error: string }
    expect(r.error).toMatch(/guardia/)
    expect(runProbe).not.toHaveBeenCalled()
  })
  it('run_probe exige `why` (auditoría)', async () => {
    const reg = buildToolRegistry(mockCtx())
    expect(await reg.invoke('run_probe', { sql: 'SELECT * FROM dbo.v_saldos' })).toHaveProperty('error')
  })
  it('run_probe contra fuente NO gestionada (nivel 2) → la guardia la rechaza (no es allowlist)', async () => {
    const runProbe = vi.fn(async () => ({ rows: [] }))
    const reg = buildToolRegistry(mockCtx({ runProbe }))
    const r = (await reg.invoke('run_probe', { sql: 'SELECT * FROM sap.libro_mayor', why: 'x' })) as { error: string }
    expect(r.error).toMatch(/guardia/)
    expect(r.error).toMatch(/fuera del catálogo permitido/) // solo gestionado está en el allowlist
    expect(runProbe).not.toHaveBeenCalled()
  })
})

describe('tools · save_draft valida antes de guardar', () => {
  it('draft inválido → ok:false, no guarda', async () => {
    const saveDraft = vi.fn(async () => ({ version: 1 }))
    const reg = buildToolRegistry(mockCtx({ saveDraft }))
    const r = (await reg.invoke('save_draft', { yaml: 'algo: mal' })) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(saveDraft).not.toHaveBeenCalled()
  })
  it('draft válido → guarda y devuelve versión', async () => {
    const reg = buildToolRegistry(mockCtx())
    expect(await reg.invoke('save_draft', { yaml: 'mira_version: "1.0"' })).toEqual({ ok: true, version: 1 })
  })
})

describe('tools · update_intent_summary valida forma', () => {
  it('sin campos obligatorios → ok:false', async () => {
    const reg = buildToolRegistry(mockCtx())
    expect(await reg.invoke('update_intent_summary', { titulo: 'x' })).toMatchObject({ ok: false })
  })
  it('con obligatorios → ok:true', async () => {
    const reg = buildToolRegistry(mockCtx())
    const r = (await reg.invoke('update_intent_summary', { titulo: 'Saldos', pregunta_de_negocio: '¿cuánto?', audiencia: 'finanzas', grano: 'empresa' })) as { ok: boolean }
    expect(r.ok).toBe(true)
  })
})

describe('tools · create_data_request y self_check', () => {
  it('create_data_request registra el handoff con nivel + acción de cierre', async () => {
    const createDataRequest = vi.fn(async () => ({ ok: true as const }))
    const reg = buildToolRegistry(mockCtx({ createDataRequest }))
    await reg.invoke('create_data_request', { descripcion: 'falta el libro mayor SAP', tablas_faltantes: ['sap.libro_mayor'], nivel: 'conectado', accion_de_cierre: 'curar' })
    expect(createDataRequest).toHaveBeenCalledWith('falta el libro mayor SAP', ['sap.libro_mayor'], { nivel: 'conectado', accionDeCierre: 'curar' })
  })
  it('create_data_request ignora un nivel/acción inválidos (undefined, no revienta)', async () => {
    const createDataRequest = vi.fn(async () => ({ ok: true as const }))
    const reg = buildToolRegistry(mockCtx({ createDataRequest }))
    await reg.invoke('create_data_request', { descripcion: 'x', nivel: 'inventado', accion_de_cierre: 'volar' })
    expect(createDataRequest).toHaveBeenCalledWith('x', [], { nivel: undefined, accionDeCierre: undefined })
  })
  it('run_self_check devuelve veredicto y brechas', async () => {
    const reg = buildToolRegistry(mockCtx())
    expect(await reg.invoke('run_self_check', {})).toEqual({ veredicto: 'APROBADA', brechas: [] })
  })
})
