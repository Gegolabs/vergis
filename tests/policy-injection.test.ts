// Paso 4 · "Botler inyecta claims" — prueba del CABLEADO en runtime (doc 10 §5).
//
// El mecanismo SQL (ROW POLICY + getSetting) ya quedó probado contundentemente: PoC Fase 0
// (8 propiedades, 20/20 vivo) + compilador Fase 2 (property test 800 casos + cross-check vivo).
// Acá se prueba la pieza NUEVA del paso 4: que los claims del consumidor fluyan
//   gate (cabecera) → IdentityContext → Botler → Capability → settings `vergis_claim_*` por query.
//
// El transporte es un FAKE que simula ClickHouse aplicando `emulate` (la semántica de la
// expresión generada) sobre los settings que la Capability inyectó. Es un test diferencial:
// si la Capability inyecta bien, el fake filtra como ClickHouse → las filas servidas coinciden
// con la referencia. Sin Docker; hermético. (La corrida viva opcional vive en el README/scripts.)

import { describe, expect, it } from 'vitest'
import {
  Botler,
  claimsFromHeaders,
  identityFromHeaders,
  type IdentityContext,
} from '@vergis/botler'
import {
  createExecuteSqlClickHouse,
  type ChQueryRequest,
  type ChTransport,
} from '@vergis/capabilities'
import { compileClickHouse, emulate, parseAudience, type Policy } from '@vergis/policy'

// --- store sintético idéntico al PoC / a la suite del compilador ------------
type Row = { area: string; present: number }
const STORE: Row[] = [
  { area: 'Producción', present: 100 },
  { area: 'Finanzas', present: 36 },
  { area: 'Comercial', present: 50 },
  { area: 'RRHH', present: 22 },
]
const areas = (rows: Row[]) => rows.map((r) => r.area).sort()

// --- enforcement compilado desde la declaración de QW-04 --------------------
const QW04_AUDIENCE = { rls: [{ column: 'area', claim: 'groups', op: 'in' }], default: 'deny' }
const TARGET = { database: 'vergis', table: 'areas', role: 'consumer_role' }
const ENFORCEMENT = compileClickHouse(parseAudience(QW04_AUDIENCE) as Policy, TARGET)!

// Fake transport: simula ClickHouse aplicando la policy con los settings inyectados.
// Captura cada request para poder aserciones sobre los settings exactos.
function makeFakeTransport(): { transport: ChTransport; calls: ChQueryRequest[] } {
  const calls: ChQueryRequest[] = []
  const transport: ChTransport = async (req) => {
    calls.push(req)
    const rows = STORE.filter((r) => emulate(ENFORCEMENT, req.settings, r as unknown as Record<string, unknown>))
    return { rows: rows as unknown as Record<string, unknown>[] }
  }
  return { transport, calls }
}

const PROFILE = { url: 'http://clickhouse:8123', user: 'botler', database: 'vergis' }
const SQL = 'SELECT area, present FROM vergis.areas'

describe('Paso 4 · gate → claims (parser de cabeceras)', () => {
  it('X-Forwarded-Groups (coma-separado) → claim groups', () => {
    expect(claimsFromHeaders({ 'x-forwarded-groups': 'Producción,Comercial' })).toEqual({
      groups: ['Producción', 'Comercial'],
    })
  })
  it('tolera casing, espacios y valores vacíos', () => {
    expect(claimsFromHeaders({ 'X-Forwarded-Groups': ' Finanzas , , RRHH ' })).toEqual({
      groups: ['Finanzas', 'RRHH'],
    })
  })
  it('cabecera ausente/vacía ⇒ sin claim (default-deny aguas abajo)', () => {
    expect(claimsFromHeaders({})).toEqual({})
    expect(claimsFromHeaders({ 'x-forwarded-groups': '' })).toEqual({})
  })
  it('identityFromHeaders arma agent + user + claims', () => {
    const id = identityFromHeaders({ 'x-forwarded-groups': 'Producción', 'x-forwarded-email': 'jefe@gh.com' })
    expect(id).toEqual({ agent: 'vergis', user: 'jefe@gh.com', claims: { groups: ['Producción'] } })
  })
  it('decodeUtf8 recupera acentos mal codificados por el transporte HTTP (latin1→utf8)', () => {
    // Node entrega las cabeceras como latin1: "Producción" UTF-8 llega como "ProducciÃ³n".
    const mangled = Buffer.from('Producción', 'utf8').toString('latin1')
    expect(mangled).not.toBe('Producción') // confirma que el transporte lo deformó
    const m = { claims: { groups: 'x-forwarded-groups' }, decodeUtf8: true }
    expect(claimsFromHeaders({ 'x-forwarded-groups': mangled }, m)).toEqual({ groups: ['Producción'] })
    // sin decodeUtf8 NO se recupera (default seguro para valores ya correctos in-proc)
    expect(claimsFromHeaders({ 'x-forwarded-groups': 'Producción' })).toEqual({ groups: ['Producción'] })
  })
})

describe('Paso 4 · la Capability inyecta los claims como settings request-scoped', () => {
  it('claim Producción → settings vergis_claim_groups=Producción → solo Producción', async () => {
    const { transport, calls } = makeFakeTransport()
    const cap = createExecuteSqlClickHouse(PROFILE, ENFORCEMENT, { transport })
    const identity: IdentityContext = { agent: 'vergis', claims: { groups: ['Producción'] } }
    const out = (await cap.execute({ sql: SQL }, identity)) as { rows: Row[] }
    expect(calls[0].settings).toEqual({ vergis_claim_groups: 'Producción' })
    expect(areas(out.rows)).toEqual(['Producción'])
  })

  it('multi-grupo → exactamente esas áreas', async () => {
    const { transport } = makeFakeTransport()
    const cap = createExecuteSqlClickHouse(PROFILE, ENFORCEMENT, { transport })
    const out = (await cap.execute({ sql: SQL }, { agent: 'vergis', claims: { groups: ['Finanzas', 'RRHH'] } })) as { rows: Row[] }
    expect(areas(out.rows)).toEqual(['Finanzas', 'RRHH'])
  })

  it('sin claims → setting vacío → 0 filas (default-deny)', async () => {
    const { transport, calls } = makeFakeTransport()
    const cap = createExecuteSqlClickHouse(PROFILE, ENFORCEMENT, { transport })
    const out = (await cap.execute({ sql: SQL }, { agent: 'vergis' })) as { rows: Row[] }
    expect(calls[0].settings).toEqual({ vergis_claim_groups: '' })
    expect(out.rows).toHaveLength(0)
  })

  it('injection-safe: un payload SQL como valor de claim no escapa (0 matches, no ejecuta)', async () => {
    const { transport } = makeFakeTransport()
    const cap = createExecuteSqlClickHouse(PROFILE, ENFORCEMENT, { transport })
    const out = (await cap.execute({ sql: SQL }, { agent: 'vergis', claims: { groups: ["'; DROP POLICY pol_areas--"] } })) as { rows: Row[] }
    expect(out.rows).toHaveLength(0) // es un VALOR comparado contra area, no SQL
  })

  it('rechaza un claim con coma (rompería el encoding) con error claro', async () => {
    const { transport } = makeFakeTransport()
    const cap = createExecuteSqlClickHouse(PROFILE, ENFORCEMENT, { transport })
    await expect(
      cap.execute({ sql: SQL }, { agent: 'vergis', claims: { groups: ['Producción,Finanzas'] } }),
    ).rejects.toMatchObject({ structured: { code: 'claim-value-has-comma' } })
  })

  it('pooling-safe: misma instancia, dos consumidores seguidos → settings distintos, sin fuga', async () => {
    const { transport, calls } = makeFakeTransport()
    const cap = createExecuteSqlClickHouse(PROFILE, ENFORCEMENT, { transport })
    const a = (await cap.execute({ sql: SQL }, { agent: 'vergis', claims: { groups: ['Producción'] } })) as { rows: Row[] }
    const b = (await cap.execute({ sql: SQL }, { agent: 'vergis', claims: { groups: ['Finanzas'] } })) as { rows: Row[] }
    expect(calls[0].settings).toEqual({ vergis_claim_groups: 'Producción' })
    expect(calls[1].settings).toEqual({ vergis_claim_groups: 'Finanzas' })
    expect(areas(a.rows)).toEqual(['Producción'])
    expect(areas(b.rows)).toEqual(['Finanzas']) // B no ve nada de A
  })

  it('el consumidor no controla los settings: params solo trae sql, los settings salen de identity', async () => {
    const { transport, calls } = makeFakeTransport()
    const cap = createExecuteSqlClickHouse(PROFILE, ENFORCEMENT, { transport })
    // Un intento de colar el setting por params es ignorado (no es una clave que la Capability lea).
    await cap.execute(
      { sql: SQL, vergis_claim_groups: 'Producción,Finanzas,Comercial,RRHH' } as unknown,
      { agent: 'vergis', claims: { groups: ['Finanzas'] } },
    )
    expect(calls[0].settings).toEqual({ vergis_claim_groups: 'Finanzas' }) // ganó la identidad, no params
  })
})

describe('Paso 4 · end-to-end por el Botler (gate → identity → capabilityCall → inyección)', () => {
  it('el Botler porta identity.claims hasta la Capability; un gerente de Producción ve solo Producción', async () => {
    const { transport } = makeFakeTransport()
    const cap = createExecuteSqlClickHouse(PROFILE, ENFORCEMENT, { transport })
    const botler = new Botler({ agencyDomainId: 'test' })
    botler.start()
    botler.registerCapability(cap)

    // El driver per-request arma la identidad desde las cabeceras del gate.
    const identity = identityFromHeaders({ 'x-forwarded-groups': 'Producción', 'x-forwarded-email': 'jefe.prod@gh.com' })
    const out = (await botler.capabilityCall('execute-sql-ch', { sql: SQL }, identity)) as { rows: Row[] }
    expect(areas(out.rows)).toEqual(['Producción'])

    // Otro consumidor por el mismo Botler: aislado.
    const idFin = identityFromHeaders({ 'x-forwarded-groups': 'Finanzas' })
    const outFin = (await botler.capabilityCall('execute-sql-ch', { sql: SQL }, idFin)) as { rows: Row[] }
    expect(areas(outFin.rows)).toEqual(['Finanzas'])

    // El log del Botler registra el policy-check + la llamada (gobernanza, nunca bypass).
    const types = botler.log.all().map((e) => e.type)
    expect(types).toContain('policy-check')
    expect(types.filter((t) => t === 'capability-call').length).toBeGreaterThanOrEqual(2)
    botler.stop()
  })
})
