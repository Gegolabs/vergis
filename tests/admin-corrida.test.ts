/**
 * Issue #99 — la página de UNA corrida: el operador LEE el log desde el producto, tanto de la corrida
 * fallida como de la exitosa (`Completed` no garantiza que el dato quedó bien). Los tests observan el
 * SÍNTOMA en el HTML del GET, montando `createAdmin` con `runLogs` mockeado.
 */
import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminHandler, type RunLogsOps } from '../server/admin'
import { parseMasterDataConfig, parseDomainsConfig, parseIntakeConfig, SqliteMasterDataStore, SqliteAdminStore, type RunRecord, type OneLakeEntry } from '@vergis/capabilities'

const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const STEWARD = 'steward@gh.cl'
const AJENO = 'nadie@gh.cl'

const ENTITIES = parseMasterDataConfig({ entities: [{ id: 'rel', label: 'Relacionadas', domain: 'cartera', columns: [{ name: 'rut', label: 'RUT', type: 'string', pk: true }] }] })
const DOMAINS = parseDomainsConfig({ domains: [{ id: 'cartera', label: 'Cartera / Finanzas', stewards: [STEWARD] }] })
const SLOTS = parseIntakeConfig({
  slots: [{
    id: 'saldos', label: 'Antigüedad de saldos', domain: 'cartera', maxBytes: 1024,
    target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' },
    trigger: { processRef: 'PIPE' },
  }],
})

const OK: RunRecord = { startedAt: '2026-07-13T16:17:47Z', endedAt: '2026-07-13T16:20:06Z', status: 'Completed' }
const FAIL: RunRecord = { startedAt: '2026-07-10T13:30:17Z', endedAt: '2026-07-10T13:32:08Z', status: 'Failed', error: 'Job failed during run time with state=[dead].' }
const CURSO: RunRecord = { startedAt: '2026-07-14T10:00:00Z', status: 'InProgress' }

const LOG_OK = `[ingest] leyendo landing…
[dwh] DELETE fct_saldos WHERE semana='W28': 7580 filas
[dwh] INSERT: 7626 filas
[ingest] ✔ DONE commit W28`
const LOG_FAIL = `[ingest] leyendo landing…
[ingest] ✖ ABORTADO: archivo sin filas de datos`

const entry = (name: string, size = 200, lastModified = '2026-07-13T16:20:00Z'): OneLakeEntry =>
  ({ path: `Files/code/_logs/${name}`, isDirectory: false, size, lastModified })

const REF = { workspaceId: 'WS', lakehouseId: 'LH', dir: 'Files/code/_logs' }

function runLogs(over: Partial<RunLogsOps> = {}): RunLogsOps {
  return {
    refOf: async ({ slotId, domainId }) => (slotId === 'saldos' && domainId === 'cartera' ? REF : null),
    list: async () => [entry('run-20260713T161750Z.txt'), entry('run-20260710T133020Z.txt')],
    read: async (_ref, path) => (path.includes('20260713') ? LOG_OK : LOG_FAIL),
    runsOf: async () => [CURSO, OK, FAIL],
    ...over,
  }
}

async function mkAdmin(rl: RunLogsOps | undefined): Promise<AdminHandler> {
  return createAdmin({
    entities: ENTITIES,
    mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
    adminStore: await SqliteAdminStore.open(null, [ADMIN]),
    domains: DOMAINS,
    intakeSlots: SLOTS,
    intake: { put: async () => {} },
    runLogs: rl,
    identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
    audit: () => {},
    secret: SECRET,
  })
}

function mockReq(url: string, user: string): IncomingMessage {
  const r = Readable.from(['']) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url; r.method = 'GET'; r.headers = { 'x-test-user': user }
  return r
}
interface MockRes { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(c?: string): void }
const mockRes = (): MockRes => ({ statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(c) { if (c) this.body += c } })

const get = async (rl: RunLogsOps | undefined, url: string, user = STEWARD): Promise<MockRes> => {
  const admin = await mkAdmin(rl)
  const res = mockRes()
  await admin.tryHandle(mockReq(url, user), res as unknown as ServerResponse)
  return res
}
const slotUrl = (r: RunRecord): string => `/admin/dominio/cartera/corrida?slot=saldos&started=${encodeURIComponent(r.startedAt)}`

describe('admin-corrida · el log de la corrida, en el producto (#99)', () => {
  it('ÉXITO: el operador lee el DELETE/INSERT con conteos de una corrida Completed', async () => {
    const res = await get(runLogs(), slotUrl(OK))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('7580 filas')
    expect(res.body).toContain('INSERT: 7626 filas')
    expect(res.body).toContain('Antigüedad de saldos')
  })

  it('FALLA: la línea ✖ del log es visible en la página', async () => {
    const res = await get(runLogs(), slotUrl(FAIL))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('✖ ABORTADO: archivo sin filas de datos')
  })

  it('redacción: un secreto del log no llega a la página', async () => {
    const res = await get(runLogs({ read: async () => 'conectando con client_secret=abc123XYZ' }), slotUrl(OK))
    expect(res.body).not.toContain('abc123XYZ')
    expect(res.body).toContain('redactado')
  })

  it('truncado: si el archivo pesa más que lo leído, se avisa', async () => {
    const res = await get(runLogs({ list: async () => [entry('run-20260713T161750Z.txt', 999_999)] }), slotUrl(OK))
    expect(res.body).toContain('truncado')
  })

  // ── Los cinco estados de la ausencia (D7): cada uno con sus palabras ───────
  it('sin-convencion: el origen no declara logs por corrida', async () => {
    const res = await get(runLogs({ refOf: async () => null }), slotUrl(OK))
    expect(res.body).toContain('no declara logs por corrida')
  })

  it('motor-fallo (runsOf lanza): dice que no pudo consultar, NUNCA que no hay log', async () => {
    const res = await get(runLogs({ runsOf: async () => { throw new Error('502 del motor') } }), slotUrl(OK))
    expect(res.body).toContain('No se pudo consultar el almacén de logs')
    expect(res.body).toContain('Esto no significa que el log no exista')
    expect(res.body).not.toContain('no alcanzó a escribir el log')
  })

  it('motor-fallo (list lanza): mismo estado propio, distinguible de sin-log', async () => {
    const res = await get(runLogs({ list: async () => { throw new Error('403 al listar') } }), slotUrl(OK))
    expect(res.body).toContain('Esto no significa que el log no exista')
    expect(res.body).not.toContain('no alcanzó a escribir el log')
  })

  it('en-curso: el log se escribe al final', async () => {
    const res = await get(runLogs({ list: async () => [] }), slotUrl(CURSO))
    expect(res.body).toContain('La corrida está en curso')
  })

  it('purgado: la corrida es más vieja que el archivo más antiguo retenido', async () => {
    const viejo: RunRecord = { startedAt: '2026-01-02T03:04:05Z', endedAt: '2026-01-02T03:10:00Z', status: 'Completed' }
    const res = await get(runLogs({ runsOf: async () => [viejo], list: async () => [entry('run-20260713T161750Z.txt')] }), slotUrl(viejo))
    expect(res.body).toContain('ya fue purgado por retención')
  })

  it('sin-log: sin match dentro de la ventana; con el directorio vacío lo matiza', async () => {
    const conOtros = await get(runLogs({ list: async () => [entry('run-20260101T000000Z.txt')] }), slotUrl(FAIL))
    expect(conOtros.body).toContain('no alcanzó a escribir el log de esta corrida')
    expect(conOtros.body).not.toContain('aún no escribe logs por corrida')
    const vacio = await get(runLogs({ list: async () => [] }), slotUrl(FAIL))
    expect(vacio.body).toContain('aún no escribe logs por corrida')
  })

  it('corrida ausente del historial del motor: se dice, y no se resuelve log alguno', async () => {
    const res = await get(runLogs(), '/admin/dominio/cartera/corrida?slot=saldos&started=2020-01-01T00%3A00%3A00Z')
    expect(res.body).toContain('Corrida no encontrada en el historial del motor')
  })

  // ── Authz (D6) ─────────────────────────────────────────────────────────────
  it('usuario sin gestión del dominio → 403 (nunca contenido de log)', async () => {
    const res = await get(runLogs(), slotUrl(OK), AJENO)
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain('7626 filas')
  })

  it('steward del dominio → 200', async () => {
    expect((await get(runLogs(), slotUrl(OK), STEWARD)).statusCode).toBe(200)
  })

  it('cross-dominio: refOf que rechaza por pertenencia jamás sirve el log del otro dominio', async () => {
    const res = await get(runLogs({ refOf: async ({ domainId }) => (domainId === 'otro' ? REF : null) }), slotUrl(OK), ADMIN)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('no declara logs por corrida')
    expect(res.body).not.toContain('7626 filas')
  })

  it('sin `runLogs` cableado la ruta no existe (404, regresión cero)', async () => {
    const res = await get(undefined, slotUrl(OK), ADMIN)
    expect(res.statusCode).toBe(404)
  })

  // ── Retención declarada (D8) y complemento del motor (D10) ─────────────────
  it('la página declara la retención y ofrece la consola del motor', async () => {
    const res = await get(runLogs(), slotUrl(OK))
    expect(res.body).toContain('las últimas 60 corridas')
    expect(res.body).toContain('app.fabric.microsoft.com/groups/WS')
  })
})
