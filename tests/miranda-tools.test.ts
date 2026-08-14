import { describe, it, expect, vi } from 'vitest'
import { buildToolRegistry, repr, type MirandaToolContext } from '@vergis/miranda'

function mockCtx(over: Partial<MirandaToolContext> = {}): MirandaToolContext {
  const catalog = [{ name: 'dbo.v_saldos', schema: 'dbo', description: 'saldos', rows_estimate: 1000 }]
  const leaves = new Set(catalog.map((c) => c.name.split('.').pop()!))
  return {
    catalog,
    isAllowed: (t) => leaves.has(t.split('.').pop()!.toLowerCase()),
    runProbe: async () => ({ rows: [{ empresa: 'ACME', saldo: 10 }] }),
    columnsOf: async () => [{ name: 'empresa', type: 'nvarchar' }, { name: 'saldo', type: 'decimal' }],
    sampleRows: async () => [{ empresa: 'TC ', saldo: 5 }],
    // Escudo de columna (#163 · H9): estos mocks miden OTRA cosa, así que declaran el objeto SIN
    // reglas de columna — el fail-closed y el enmascarado se miden en tests/miranda-columnas.test.ts.
    columnShield: async () => ({ known: true, columns: [] }),
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
  it('catalog_tables devuelve el allowlist', async () => {
    const reg = buildToolRegistry(mockCtx())
    const r = (await reg.invoke('catalog_tables', {})) as { tables: unknown[] }
    expect(r.tables).toHaveLength(1)
  })
  it('describe_table de objeto permitido → columnas + sample en repr()', async () => {
    const reg = buildToolRegistry(mockCtx())
    const r = (await reg.invoke('describe_table', { name: 'dbo.v_saldos' })) as { columns: unknown[]; sample: Record<string, string>[] }
    expect(r.columns).toHaveLength(2)
    expect(r.sample[0].empresa).toBe("'TC '") // el espacio se ve
  })
  it('describe_table de objeto NO permitido → error', async () => {
    const reg = buildToolRegistry(mockCtx())
    expect(await reg.invoke('describe_table', { name: 'dbo.secreta' })).toHaveProperty('error')
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
  it('create_data_request registra el handoff', async () => {
    const createDataRequest = vi.fn(async () => ({ ok: true as const }))
    const reg = buildToolRegistry(mockCtx({ createDataRequest }))
    await reg.invoke('create_data_request', { descripcion: 'falta tabla de OCs', tablas_faltantes: ['dbo.oc'] })
    expect(createDataRequest).toHaveBeenCalledWith('falta tabla de OCs', ['dbo.oc'])
  })
  it('run_self_check devuelve veredicto y brechas', async () => {
    const reg = buildToolRegistry(mockCtx())
    expect(await reg.invoke('run_self_check', {})).toEqual({ veredicto: 'APROBADA', brechas: [] })
  })
})
