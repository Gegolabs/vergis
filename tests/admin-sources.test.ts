/**
 * Gestión in-app del registro de fuentes (#107) — la vista Fuentes deja de ser solo-lectura.
 *
 * Arnés: `createAdmin` con un GovernanceStore REAL como `sourcesAdmin` (la validación del store es
 * parte de lo que se juzga) y el resto mockeado. El síntoma que estos casos observan: un admin da de
 * alta un proceso sin tocar la VM; un no-admin no puede nada; una baja con dependientes no pasa.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminHandler } from '../server/admin'
import { parseMasterDataConfig, parseDomainsConfig, SqliteMasterDataStore, SqliteAdminStore, SqliteGovernanceStore } from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'

const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const STEWARD = 'steward@gh.cl'

const ENTITIES = parseMasterDataConfig({ entities: [{ id: 'rel', label: 'Relacionadas', domain: 'cartera', columns: [{ name: 'rut', label: 'RUT', type: 'string', pk: true }] }] })
const DOMAINS = parseDomainsConfig({ domains: [{ id: 'cartera', label: 'Cartera / Finanzas', stewards: [STEWARD] }] })

function mockReq(method: string, url: string, user: string, body = '', contentType?: string): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url; r.method = method; r.headers = { 'x-test-user': user }
  if (contentType) r.headers['content-type'] = contentType
  return r
}
interface MockRes { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(chunk?: string): void }
function mockRes(): MockRes {
  return { statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(chunk) { if (chunk) this.body += chunk } }
}

describe('admin · Fuentes gestionable in-app (#107)', () => {
  let admin: AdminHandler
  let gov: SqliteGovernanceStore
  let audit: LogEventInput[]

  beforeEach(async () => {
    audit = []
    gov = await SqliteGovernanceStore.open(null, {
      sources: [{ id: 'sap', label: 'SAP B1', oferta: 'PT1H', domain: 'cartera' }],
      processes: [{ id: 'p_sap', label: 'Ingesta SAP', sourceId: 'sap', engine: { workspaceId: 'WS', itemId: 'SJD', jobType: 'sparkjob' } }],
    })
    admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      sourceRegistry: async () => ({ sources: await gov.listSources(), processes: await gov.listProcesses(), outputs: await gov.listProcessOutputs() }),
      sourcesAdmin: gov,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: (e) => audit.push(e),
      secret: SECRET,
    })
  })

  const go = async (req: IncomingMessage): Promise<MockRes> => {
    const res = mockRes()
    await admin.tryHandle(req, res as unknown as ServerResponse)
    return res
  }
  const token = async (): Promise<string> => (await go(mockReq('GET', '/admin/sources', ADMIN))).body.match(/name="_csrf" value="([0-9a-f]+)"/)![1]
  const postAs = async (user: string, path: string, campos: Record<string, string>, tok?: string): Promise<MockRes> => {
    const t = tok ?? (await token())
    const body = new URLSearchParams({ _csrf: t, ...campos }).toString()
    return go(mockReq('POST', path, user, body, 'application/x-www-form-urlencoded'))
  }
  const opsDe = (): string[] => audit.filter((e) => e['type'] === 'sources-write').map((e) => String(e['op']))

  // (a) fail-closed por rol
  it('el registro es de PLATAFORMA: el steward no-admin recibe 403 en el GET y en TODO POST', async () => {
    expect((await go(mockReq('GET', '/admin/sources', STEWARD))).statusCode).toBe(403)
    for (const p of ['source', 'source-delete', 'process', 'process-delete', 'output-add', 'output-remove', 'table-map', 'table-map-remove']) {
      const res = await postAs(STEWARD, `/admin/sources/${p}`, { id: 'x', label: 'X', oferta: 'PT1H' })
      expect(res.statusCode, p).toBe(403)
    }
    expect(await gov.listSources()).toHaveLength(1) // nada se escribió
  })

  it('el GET del admin trae los forms y el badge de procedencia de cada fila', async () => {
    const res = await go(mockReq('GET', '/admin/sources', ADMIN))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('action="/admin/sources/source"')
    expect(res.body).toContain('action="/admin/sources/process"')
    expect(res.body).toContain('semilla (yaml)')
    expect(res.body).toContain('el item del motor y su schedule no se tocan')
  })

  // (h) regresión cero: sin `sourcesAdmin` la vista es la de siempre
  it('sin sourcesAdmin cableado, la página no ofrece un solo form (regresión cero)', async () => {
    const ro = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      sourceRegistry: async () => ({ sources: await gov.listSources(), processes: await gov.listProcesses(), outputs: [] }),
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const res = mockRes()
    await ro.tryHandle(mockReq('GET', '/admin/sources', ADMIN), res as unknown as ServerResponse)
    expect(res.body).toContain('SAP B1')
    expect(res.body).not.toContain('/admin/sources/source')
    expect(res.body).not.toContain('semilla (yaml)')
    // Y el POST tampoco existe: 404 en vez de escribir.
    const w = mockRes()
    await ro.tryHandle(mockReq('POST', '/admin/sources/source', ADMIN, '', 'application/x-www-form-urlencoded'), w as unknown as ServerResponse)
    expect(w.statusCode).toBe(404)
  })

  // (b)(c) alta y validación de fuente
  it('alta de fuente válida: 302, fila en el store con connectedBy y managed, y audit sellado', async () => {
    const res = await postAs(ADMIN, '/admin/sources/source', { id: 'buk', label: 'Buk', oferta: 'P1D', domain: 'cartera' })
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toContain('/admin/sources?msg=')
    const buk = (await gov.listSources()).find((s) => s.id === 'buk')!
    expect(buk).toMatchObject({ label: 'Buk', oferta: 'P1D', domain: 'cartera', connectedBy: ADMIN, managed: true })
    expect(audit.find((e) => e['type'] === 'sources-write')).toMatchObject({ op: 'source-upsert', target: 'buk', by: ADMIN, oferta: 'P1D', domain: 'cartera' })
  })

  it('oferta inválida, dominio no declarado e id no-slug: 400 y NADA se escribe', async () => {
    const t = await token()
    const casos: Record<string, string>[] = [
      { id: 'buk', label: 'Buk', oferta: 'cada rato' },
      { id: 'buk', label: 'Buk', oferta: 'P1D', domain: 'inexistente' },
      { id: 'Buk Mal', label: 'Buk', oferta: 'P1D' },
    ]
    for (const c of casos) {
      const res = await postAs(ADMIN, '/admin/sources/source', c, t)
      expect(res.statusCode, JSON.stringify(c)).toBe(400)
      expect(res.body).toContain('Error:')
    }
    expect((await gov.listSources()).map((s) => s.id)).toEqual(['sap'])
    expect(opsDe()).toEqual([])
  })

  // (d) alta de proceso
  it('proceso: tripleta parcial → 400; fuente inexistente → 400; tripleta completa → 302 con engine', async () => {
    const t = await token()
    const parcial = await postAs(ADMIN, '/admin/sources/process', { id: 'p_new', label: 'Nuevo', source: 'sap', engine_workspace: 'WS' }, t)
    expect(parcial.statusCode).toBe(400)
    expect(parcial.body).toContain('El motor se declara completo')

    const sinFuente = await postAs(ADMIN, '/admin/sources/process', { id: 'p_new', label: 'Nuevo', source: 'fantasma' }, t)
    expect(sinFuente.statusCode).toBe(400)
    expect(sinFuente.body).toContain('Fuente desconocida')

    const ok = await postAs(ADMIN, '/admin/sources/process', { id: 'p_new', label: 'Nuevo', source: 'sap', engine_workspace: 'WS2', engine_item: 'IT2', engine_job_type: 'Pipeline' }, t)
    expect(ok.statusCode).toBe(303)
    const p = (await gov.listProcesses()).find((x) => x.id === 'p_new')!
    expect(p).toMatchObject({ sourceId: 'sap', managed: true, engine: { workspaceId: 'WS2', itemId: 'IT2', jobType: 'Pipeline' } })
    expect(audit.find((e) => e['op'] === 'process-upsert')).toMatchObject({ target: 'p_new', source: 'sap', engine: 'WS2/IT2/Pipeline' })
  })

  // (e) bajas con dependientes
  it('baja de fuente con un proceso que la referencia: 409 nombrándolo; sin dependientes: 302 y fila fuera', async () => {
    const t = await token()
    const conflicto = await postAs(ADMIN, '/admin/sources/source-delete', { id: 'sap' }, t)
    expect(conflicto.statusCode).toBe(409)
    expect(conflicto.body).toContain('p_sap')
    expect(await gov.listSources()).toHaveLength(1)

    await postAs(ADMIN, '/admin/sources/process-delete', { id: 'p_sap' }, t)
    expect(await gov.listProcesses()).toEqual([])
    const ok = await postAs(ADMIN, '/admin/sources/source-delete', { id: 'sap' }, t)
    expect(ok.statusCode).toBe(303)
    expect(await gov.listSources()).toEqual([])
    expect(opsDe()).toEqual(['process-delete', 'source-delete'])
  })

  it('baja de fuente con un mapeo que la referencia: 409 nombrando la tabla', async () => {
    const t = await token()
    await gov.deleteProcess('p_sap')
    await gov.setTableSource('dw.fct_saldos', 'sap')
    const res = await postAs(ADMIN, '/admin/sources/source-delete', { id: 'sap' }, t)
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('dw.fct_saldos')
  })

  // (f) salidas y mapeos
  it('output-add/remove y table-map/table-map-remove se reflejan en el store, con audit', async () => {
    const t = await token()
    await postAs(ADMIN, '/admin/sources/output-add', { process: 'p_sap', table: 'dw.fct_saldos' }, t)
    expect(await gov.listProcessOutputs()).toEqual([{ processId: 'p_sap', tableRef: 'dw.fct_saldos' }])
    await postAs(ADMIN, '/admin/sources/table-map', { table: 'dw.fct_saldos', source: 'sap' }, t)
    expect(await gov.listTableSources()).toEqual([{ tableRef: 'dw.fct_saldos', sourceId: 'sap' }])
    await postAs(ADMIN, '/admin/sources/output-remove', { process: 'p_sap', table: 'dw.fct_saldos' }, t)
    expect(await gov.listProcessOutputs()).toEqual([])
    await postAs(ADMIN, '/admin/sources/table-map-remove', { table: 'dw.fct_saldos' }, t)
    expect(await gov.listTableSources()).toEqual([])
    expect(opsDe()).toEqual(['output-add', 'table-map', 'output-remove', 'table-map-remove'])
  })

  it('una salida sobre un proceso inexistente se rechaza (400), no se registra colgada', async () => {
    const res = await postAs(ADMIN, '/admin/sources/output-add', { process: 'fantasma', table: 'dw.x' })
    expect(res.statusCode).toBe(400)
    expect(await gov.listProcessOutputs()).toEqual([])
  })

  // (g) CSRF
  it('CSRF inválido: 403 en toda escritura, sin tocar el store', async () => {
    for (const p of ['source', 'source-delete', 'process', 'process-delete', 'output-add', 'output-remove', 'table-map', 'table-map-remove']) {
      const res = await postAs(ADMIN, `/admin/sources/${p}`, { id: 'buk', label: 'Buk', oferta: 'P1D' }, 'deadbeef')
      expect(res.statusCode, p).toBe(403)
    }
    expect((await gov.listSources()).map((s) => s.id)).toEqual(['sap'])
    expect(opsDe()).toEqual([])
  })

  it('editar: el form viene pre-poblado con ?edit= y ?editp=, y guardar marca la fila como gestionada', async () => {
    const page = await go(mockReq('GET', '/admin/sources?edit=sap', ADMIN))
    expect(page.body).toContain('Editar la fuente')
    expect(page.body).toContain('value="PT1H"')
    const pageP = await go(mockReq('GET', '/admin/sources?editp=p_sap', ADMIN))
    expect(pageP.body).toContain('Editar el proceso')
    expect(pageP.body).toContain('value="SJD"')

    await postAs(ADMIN, '/admin/sources/source', { id: 'sap', label: 'SAP editado', oferta: 'PT30M', domain: 'cartera' })
    expect((await gov.listSources())[0]).toMatchObject({ label: 'SAP editado', oferta: 'PT30M', managed: true })
    expect((await go(mockReq('GET', '/admin/sources', ADMIN))).body).toContain('gestionada in-app')
  })
})
