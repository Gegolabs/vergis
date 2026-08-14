import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildToolRegistry, UNKNOWN_SHIELD, type MirandaToolContext, type AnthropicTransport, type AnthropicResponse } from '@vergis/miranda'
import { SqliteGovernanceStore } from '@vergis/capabilities'
import { createMiranda, resolvePolicyFor, type MirandaServerDeps } from '../server/miranda'
import { csrfFactory } from '../server/ui'
import type { PolicyDecl } from '@vergis/policy'

/**
 * #163 · H9 — Miranda frente al plano de columna.
 *
 * La decisión de diseño (§4.4) tiene DOS mitades y este archivo mide las dos, porque cumplir una sola
 * es un producto distinto: la columna protegida **se nombra** (con su tipo y su marca) y **no se
 * sondea** (ni un valor suyo sale por ninguna tool).
 *
 * El CONTROL POSITIVO no es decorativo: sin él, una implementación que no sondeara NADA pasaría todas
 * las aserciones negativas sin haber sido puesta en riesgo jamás. Cada bloque que exige silencio tiene
 * al lado uno que exige que el mismo instrumento sí produzca valores cuando no hay regla.
 */

const RUT = '12.345.678-9' // el valor que jamás debe aparecer
const SUELDO = 4321000

const COLS = [
  { name: 'empresa', type: 'nvarchar' },
  { name: 'rut', type: 'nvarchar' },
  { name: 'sueldo', type: 'int' },
]

/** Motor HOSTIL a propósito: devuelve la fila COMPLETA aunque le pidan proyección. Un test cuyo doble
 *  ya viene recortado mediría el doble, no el producto. */
const FILA = { empresa: 'ACME', rut: RUT, sueldo: SUELDO }

function mockCtx(over: Partial<MirandaToolContext> = {}): MirandaToolContext {
  const catalog = [{ name: 'dbo.v_empleado' }]
  const leaves = new Set(catalog.map((c) => c.name.split('.').pop()!))
  return {
    catalog,
    isAllowed: (t) => leaves.has(t.split('.').pop()!.toLowerCase()),
    runProbe: async () => ({ rows: [FILA] }),
    columnsOf: async () => COLS,
    columnShield: async () => ({ known: true, columns: ['rut'] }),
    sampleRows: async () => [FILA],
    profileColumn: async () => [{ value: RUT, count: 1 }],
    listSpecs: () => [],
    readSpec: () => null,
    validateDraft: () => ({ ok: true }),
    saveDraft: async () => ({ version: 1 }),
    updateIntent: async () => ({ version: 1 }),
    createDataRequest: async () => ({ ok: true }),
    renderPreview: async () => ({ url: '/x' }),
    runSelfCheck: async () => ({ veredicto: 'APROBADA', brechas: [] }),
    ...over,
  }
}

const dump = (r: unknown): string => JSON.stringify(r)

describe('#163·H9 · describe_table — la columna se NOMBRA y no se sondea', () => {
  it('la columna con regla aparece con su tipo y marcada `protegida`', async () => {
    const reg = buildToolRegistry(mockCtx())
    const r = (await reg.invoke('describe_table', { name: 'dbo.v_empleado' })) as {
      columns: { name: string; type: string; protegida?: boolean }[]
      columnas_protegidas: string[]
      note: string
    }
    // Se nombra: el lector sabe que EXISTE y que no la puede ver (mentimos el valor, jamás el esquema).
    expect(r.columns.map((c) => c.name)).toEqual(['empresa', 'rut', 'sueldo'])
    expect(r.columns.find((c) => c.name === 'rut')).toEqual({ name: 'rut', type: 'nvarchar', protegida: true })
    expect(r.columnas_protegidas).toEqual(['rut'])
    expect(r.note).toContain('protegida')
  })

  it('ningún valor suyo aparece en la salida — ni pedido al motor, ni colado en la muestra', async () => {
    const sampleRows = vi.fn(async () => [FILA]) // el motor devuelve `rut` igual: no debe salir de acá
    const reg = buildToolRegistry(mockCtx({ sampleRows }))
    const r = (await reg.invoke('describe_table', { name: 'dbo.v_empleado' })) as { sample: Record<string, string>[] }
    // (a) no se PIDIÓ: la proyección excluye la columna protegida.
    expect(sampleRows).toHaveBeenCalledWith('dbo.v_empleado', 3, ['empresa', 'sueldo'])
    // (b) no se FILTRÓ: aserción sobre el contenido completo, no sobre una bandera.
    expect(dump(r)).not.toContain(RUT)
    expect(Object.keys(r.sample[0])).toEqual(['empresa', 'sueldo'])
  })

  it('CONTROL — sin reglas de columna, describe_table sondea como siempre (valores y todo)', async () => {
    const sampleRows = vi.fn(async () => [FILA])
    const reg = buildToolRegistry(mockCtx({ columnShield: async () => ({ known: true, columns: [] }), sampleRows }))
    const r = (await reg.invoke('describe_table', { name: 'dbo.v_empleado' })) as {
      columns: { name: string; protegida?: boolean }[]
      sample: Record<string, string>[]
    }
    expect(sampleRows).toHaveBeenCalledWith('dbo.v_empleado', 3, ['empresa', 'rut', 'sueldo'])
    expect(dump(r)).toContain(RUT) // el instrumento SÍ sabe producir el valor: el silencio de arriba es real
    expect(r.sample[0].rut).toBe(`'${RUT}'`)
    expect(r.columns.some((c) => c.protegida)).toBe(false)
  })
})

describe('#163·H9 · profile_column — el perfil ES un sondeo', () => {
  it('columna con regla → se rechaza sin tocar el motor, y la respuesta la nombra', async () => {
    const profileColumn = vi.fn(async () => [{ value: RUT, count: 1 }])
    const reg = buildToolRegistry(mockCtx({ profileColumn }))
    const r = (await reg.invoke('profile_column', { table: 'dbo.v_empleado', column: 'rut' })) as { protegida?: boolean; error?: string }
    expect(profileColumn).not.toHaveBeenCalled()
    expect(r.protegida).toBe(true)
    expect(r.error).toContain('existe')
    expect(dump(r)).not.toContain(RUT)
  })

  it('el rechazo es insensible a mayúsculas (SQL tampoco distingue)', async () => {
    const profileColumn = vi.fn(async () => [{ value: RUT, count: 1 }])
    const reg = buildToolRegistry(mockCtx({ profileColumn }))
    const r = (await reg.invoke('profile_column', { table: 'dbo.v_empleado', column: 'RUT' })) as { protegida?: boolean }
    expect(profileColumn).not.toHaveBeenCalled()
    expect(r.protegida).toBe(true)
  })

  it('CONTROL — columna sin regla se perfila igual que siempre', async () => {
    const profileColumn = vi.fn(async () => [{ value: 'ACME', count: 7 }])
    const reg = buildToolRegistry(mockCtx({ profileColumn }))
    const r = (await reg.invoke('profile_column', { table: 'dbo.v_empleado', column: 'empresa' })) as { values: { value: string; count: number }[] }
    expect(profileColumn).toHaveBeenCalledWith('dbo.v_empleado', 'empresa', 20)
    expect(r.values).toEqual([{ value: "'ACME'", count: 7 }])
  })
})

describe('#163·H9 · run_probe — la puerta ancha', () => {
  const probeOf = () => vi.fn(async () => ({ rows: [FILA] }))

  it('una probe que menciona la columna protegida se veta ANTES de ejecutarse', async () => {
    const runProbe = probeOf()
    const reg = buildToolRegistry(mockCtx({ runProbe }))
    const r = (await reg.invoke('run_probe', { sql: 'SELECT rut, empresa FROM dbo.v_empleado', why: 'x' })) as { error?: string }
    expect(runProbe).not.toHaveBeenCalled()
    expect(r.error).toContain('rut')
    expect(dump(r)).not.toContain(RUT)
  })

  it('el veto alcanza a lo DERIVADO: agregados, funciones y filtros sobre la columna protegida', async () => {
    const runProbe = probeOf()
    const reg = buildToolRegistry(mockCtx({ runProbe }))
    for (const sql of [
      'SELECT MIN(rut) AS a FROM dbo.v_empleado',
      'SELECT COUNT(DISTINCT rut) AS n FROM dbo.v_empleado',
      'SELECT empresa FROM dbo.v_empleado WHERE rut IS NOT NULL',
      'SELECT LEFT(e.rut, 3) AS pre FROM dbo.v_empleado e',
      'SELECT RUT FROM dbo.v_empleado',
    ]) {
      expect((await reg.invoke('run_probe', { sql, why: 'x' })) as { error?: string }).toHaveProperty('error')
    }
    expect(runProbe).not.toHaveBeenCalled()
  })

  it('`SELECT *` sobre un objeto con columna protegida se veta (la estrella la trae sin nombrarla)', async () => {
    const runProbe = probeOf()
    const reg = buildToolRegistry(mockCtx({ runProbe }))
    const r = (await reg.invoke('run_probe', { sql: 'SELECT * FROM dbo.v_empleado', why: 'x' })) as { error?: string }
    expect(runProbe).not.toHaveBeenCalled()
    expect(r.error).toContain("'*'")
  })

  it('CONTROL — una probe sobre columnas sin regla corre igual que siempre (incluido COUNT(*))', async () => {
    const runProbe = probeOf()
    const reg = buildToolRegistry(mockCtx({ runProbe }))
    const ok = (await reg.invoke('run_probe', { sql: 'SELECT empresa FROM dbo.v_empleado', why: 'x' })) as { row_count?: number }
    expect(runProbe).toHaveBeenCalledTimes(1)
    expect(ok.row_count).toBe(1)
    const cnt = (await reg.invoke('run_probe', { sql: 'SELECT COUNT(*) AS n FROM dbo.v_empleado', why: 'x' })) as { row_count?: number }
    expect(runProbe).toHaveBeenCalledTimes(2)
    expect(cnt.row_count).toBe(1)
  })

  it('CONTROL — sin reglas de columna, `SELECT *` sigue permitido', async () => {
    const runProbe = probeOf()
    const reg = buildToolRegistry(mockCtx({ columnShield: async () => ({ known: true, columns: [] }), runProbe }))
    const r = (await reg.invoke('run_probe', { sql: 'SELECT * FROM dbo.v_empleado', why: 'x' })) as { row_count?: number }
    expect(runProbe).toHaveBeenCalledTimes(1)
    expect(r.row_count).toBe(1)
  })
})

describe('#163·H9 · fail-closed — la duda no habilita el sondeo', () => {
  it('sin política determinable para la tabla no se sondea NADA, pero el esquema se sigue nombrando', async () => {
    const sampleRows = vi.fn(async () => [FILA])
    const profileColumn = vi.fn(async () => [{ value: 'ACME', count: 7 }])
    const runProbe = vi.fn(async () => ({ rows: [FILA] }))
    const reg = buildToolRegistry(mockCtx({ columnShield: async () => UNKNOWN_SHIELD, sampleRows, profileColumn, runProbe }))

    const d = (await reg.invoke('describe_table', { name: 'dbo.v_empleado' })) as {
      columns: { name: string; protegida?: boolean }[]
      sample: unknown[]
      note: string
    }
    expect(sampleRows).not.toHaveBeenCalled()
    expect(d.sample).toEqual([])
    expect(d.columns.map((c) => c.name)).toEqual(['empresa', 'rut', 'sueldo']) // se nombra igual
    expect(d.columns.every((c) => c.protegida)).toBe(true)
    expect(d.note).toContain('fail-closed')

    // Ni siquiera una columna «inocente» se perfila o se prueba: la duda es del objeto entero.
    expect(await reg.invoke('profile_column', { table: 'dbo.v_empleado', column: 'empresa' })).toHaveProperty('protegida', true)
    expect(profileColumn).not.toHaveBeenCalled()
    expect(await reg.invoke('run_probe', { sql: 'SELECT empresa FROM dbo.v_empleado', why: 'x' })).toHaveProperty('error')
    expect(runProbe).not.toHaveBeenCalled()
  })

  it('un seam de escudo que LANZA se trata como duda, no como vía libre', async () => {
    const sampleRows = vi.fn(async () => [FILA])
    const reg = buildToolRegistry(mockCtx({ columnShield: async () => { throw new Error('policy store caído') }, sampleRows }))
    const d = (await reg.invoke('describe_table', { name: 'dbo.v_empleado' })) as { sample: unknown[] }
    expect(sampleRows).not.toHaveBeenCalled()
    expect(d.sample).toEqual([])
  })
})

// --- Cableado del server: de dónde salen las reglas de verdad ------------------------------------

const SECRET = 's'
const EMAIL = 'claudio@ratio.cl'
const token = csrfFactory(SECRET)(EMAIL)

const tu = (name: string, input: unknown): AnthropicResponse => ({ id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }], stop_reason: 'tool_use', usage: { input_tokens: 8, output_tokens: 4 } })
const txt = (t: string): AnthropicResponse => ({ id: 'm', role: 'assistant', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 4 } })
function scriptedTransport(queue: AnthropicResponse[]): AnthropicTransport {
  let i = 0
  return { async createMessage() { const r = queue[i++]; if (!r) throw new Error('script agotado'); return r } }
}
function mkReq(url: string, method = 'GET', body?: Record<string, string>): IncomingMessage {
  const req = Readable.from([body ? new URLSearchParams(body).toString() : '']) as unknown as IncomingMessage
  req.url = url
  req.method = method
  req.headers = {}
  return req
}
function mkRes() {
  const calls = { status: 0, body: '' }
  let done!: () => void
  const p = new Promise<void>((r) => (done = r))
  const res = { writeHead: (c: number) => { calls.status = c }, end: (b?: string) => { calls.body = b ?? ''; done() } } as unknown as ServerResponse
  return { res, calls, p }
}

/** Política PÚBLICA con una regla de columna: es EXACTAMENTE el caso que motiva el issue — el dominio
 *  abierto por decisión del cliente cuya tabla trae PII. */
const POLICY_CON_REGLA: PolicyDecl = { public: true, columnRules: [{ column: 'rut', claim: 'rrhh', action: 'mask' }] }

async function harness(policyFor: MirandaServerDeps['policyFor'], script: AnthropicResponse[]) {
  const gov = await SqliteGovernanceStore.open(null)
  const probe = vi.fn(async (_sql: string, _email: string | undefined) => ({ rows: [FILA] }))
  const deps: MirandaServerDeps = {
    gov,
    transport: scriptedTransport(script),
    model: 'm',
    systemPrompt: 'sys',
    maxTurns: 10,
    tokenBudget: 500000,
    catalog: [{ name: 'dbo.v_empleado' }],
    identityOf: () => ({ user: EMAIL }),
    hasScope: async () => true,
    isAdmin: async () => false,
    probe,
    columnsOf: async () => COLS,
    policyFor,
    validateDraft: () => ({ ok: true }),
    listSpecs: () => [],
    readSpec: () => null,
    writeSpec: async () => {},
    renderPreviewHtml: async () => '<html/>',
    secret: SECRET,
  }
  const h = createMiranda(deps)
  await gov.createSession('h9', 'Empleados', EMAIL)
  const r = mkRes()
  await h.tryHandle(mkReq('/miranda/api/s/h9/message', 'POST', { _csrf: token, text: 'describe la tabla' }), r.res)
  await r.p
  const transcript = (await gov.listMirandaMessages('h9')).map((m) => m.content).join('\n')
  return { probe, transcript }
}

describe('#163·H9 · cableado — las reglas salen del policy store (columnRules)', () => {
  it('con política cableada: el SQL de la muestra NO pide la columna con regla, y el valor no entra al transcript', async () => {
    const { probe, transcript } = await harness(() => POLICY_CON_REGLA, [tu('describe_table', { name: 'dbo.v_empleado' }), txt('listo')])
    const sql = probe.mock.calls.map((c) => String(c[0])).join(' | ')
    expect(sql).toContain('empresa')
    expect(sql).not.toMatch(/\brut\b/i)
    expect(transcript).not.toContain(RUT)
    // Y se NOMBRA: el transcript trae la columna con su marca (la mitad honesta de la decisión §4.4).
    expect(transcript).toContain('rut')
    expect(transcript).toContain('protegida')
    // CONTROL dentro del mismo caso: lo no protegido sí se sondeó de verdad.
    expect(transcript).toContain('ACME')
  })

  it('CONTROL — política SIN reglas de columna: se sondea todo, valores incluidos', async () => {
    const { probe, transcript } = await harness(() => ({ public: true }), [tu('describe_table', { name: 'dbo.v_empleado' }), txt('listo')])
    expect(probe.mock.calls.map((c) => String(c[0])).join(' ')).toMatch(/\brut\b/i)
    expect(transcript).toContain(RUT)
  })

  it('fail-closed — sin fuente de política cableada, el server no sondea nada (y lo dice)', async () => {
    const { probe, transcript } = await harness(undefined, [tu('describe_table', { name: 'dbo.v_empleado' }), txt('listo')])
    expect(probe).not.toHaveBeenCalled()
    expect(transcript).not.toContain(RUT)
    expect(transcript).toContain('fail-closed')
  })

  it('fail-closed — objeto sin política en el store: se describe, no se muestrea', async () => {
    const { probe, transcript } = await harness(() => undefined, [tu('describe_table', { name: 'dbo.v_empleado' }), txt('listo')])
    expect(probe).not.toHaveBeenCalled()
    expect(transcript).not.toContain(RUT)
    expect(transcript).toContain('sueldo') // el esquema se nombra igual
  })
})

// === LA RESOLUCIÓN TABLA↔DATASET (el cable, #163·H9) =========================
// El catálogo de Miranda y el policy store no nombran igual. Resolver mal acá NO produce un error:
// produce un escudo vacío, o sea sondeo en claro de una columna protegida. Por eso la ambigüedad
// tiene que fallar hacia «no sé» y no hacia «la primera que encuentre».
describe('miranda · resolvePolicyFor (la resolución no puede adivinar)', () => {
  const CON_REGLA: PolicyDecl = { public: true, columnRules: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }
  const SIN_REGLA: PolicyDecl = { public: true }

  it('coincidencia exacta', () => {
    const store = new Map<string, PolicyDecl>([['dbo.empleado', CON_REGLA]])
    expect(resolvePolicyFor(store, 'dbo.empleado')).toBe(CON_REGLA)
  })

  it('tabla pelada con UN candidato: se resuelve', () => {
    const store = new Map<string, PolicyDecl>([['dbo.empleado', CON_REGLA], ['dbo.areas', SIN_REGLA]])
    expect(resolvePolicyFor(store, 'empleado')).toBe(CON_REGLA)
  })

  // EL CONTROL QUE IMPORTA: dos schemas con la misma tabla y distinta política es justo el caso
  // donde elegir mal sirve el dato equivocado. No se desempata.
  it('tabla pelada AMBIGUA: devuelve undefined ⇒ escudo desconocido ⇒ no se sondea', () => {
    const store = new Map<string, PolicyDecl>([['dbo.empleado', CON_REGLA], ['rrhh.empleado', SIN_REGLA]])
    expect(resolvePolicyFor(store, 'empleado')).toBeUndefined()
  })

  it('sin candidatos: undefined (fail-closed, no un escudo vacío)', () => {
    expect(resolvePolicyFor(new Map<string, PolicyDecl>([['dbo.areas', SIN_REGLA]]), 'empleado')).toBeUndefined()
  })

  it('una referencia YA calificada que no está en el store no cae al sufijo', () => {
    const store = new Map<string, PolicyDecl>([['dbo.empleado', CON_REGLA]])
    expect(resolvePolicyFor(store, 'otro.empleado')).toBeUndefined()
  })

  it('la comparación de sufijo es case-insensitive (los motores no coinciden en mayúsculas)', () => {
    const store = new Map<string, PolicyDecl>([['DBO.Empleado', CON_REGLA]])
    expect(resolvePolicyFor(store, 'empleado')).toBe(CON_REGLA)
  })
})
