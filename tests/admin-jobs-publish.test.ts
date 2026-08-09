/**
 * Publicación de jobs desde la Administración (#107 fase 2, hito H4).
 *
 * Arnés calcado de `tests/admin-sources.test.ts`: `createAdmin` con un GovernanceStore REAL como
 * `sourcesAdmin`, un ledger REAL sobre SQLite (las ops de `job-publication.ts` son parte de lo que se
 * juzga) y un motor FALSO — el único doble, porque la API de Fabric ya la midió el hito cero.
 *
 * Lo que estos casos observan: publicar es acto de plataforma (el steward no puede), nada se escribe
 * sin un plan confirmado cuyo sello siga vigente, y una publicación es `ok` SOLO si el motor devuelve
 * lo publicado (D7) — nunca porque la escritura no haya lanzado.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminHandler, type JobPublicationLedger, type JobTemplateBundle } from '../server/admin'
import {
  parseMasterDataConfig,
  parseDomainsConfig,
  SqliteMasterDataStore,
  SqliteAdminStore,
  SqliteGovernanceStore,
  openSqliteDb,
  ensureJobPublicationTable,
  recordPublication,
  lastOkPublication,
  listPublications,
  pendingUnknownPublications,
  resolveUnknownPublication,
  renderTemplate,
  AuthoringDenied,
  AuthoringUnknown,
  type DefinitionPart,
  type ItemAuthoringClient,
  type ItemDefinition,
  type JobTemplate,
  type PublicationRow,
  type SqlDb,
} from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'

const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const STEWARD = 'steward@gh.cl'

const ENTITIES = parseMasterDataConfig({ entities: [{ id: 'rel', label: 'Relacionadas', domain: 'cartera', columns: [{ name: 'rut', label: 'RUT', type: 'string', pk: true }] }] })
const DOMAINS = parseDomainsConfig({ domains: [{ id: 'cartera', label: 'Cartera / Finanzas', stewards: [STEWARD] }] })

const TEMPLATE: JobTemplate = {
  id: 'sjd_ingesta',
  label: 'Ingesta Excel (SJD estándar)',
  version: '1.0',
  itemType: 'SparkJobDefinition',
  params: [
    { name: 'main_file', label: 'Script principal', required: true },
    { name: 'lakehouse_id', label: 'Lakehouse por defecto', required: true },
  ],
  parts: [{ path: 'SparkJobDefinitionV1.json', file: 'parts/sjd.json' }],
}
const PART_JSON = JSON.stringify({
  executableFile: '{{main_file}}',
  defaultLakehouseArtifactId: '{{lakehouse_id}}',
  environmentArtifactId: '',
  lang: 'Python',
})
const BUNDLE: JobTemplateBundle = { template: TEMPLATE, partFiles: { 'SparkJobDefinitionV1.json': PART_JSON } }
const VALORES = { p_main_file: 'abfss://ws@onelake/Files/code/ingesta.py', p_lakehouse_id: 'LH-1' }
/** Las parts que el render produce con `VALORES` — lo que el motor debería tener tras publicar. */
const PARTS_PUBLICADAS = renderTemplate(TEMPLATE, { 'SparkJobDefinitionV1.json': PART_JSON }, { main_file: VALORES.p_main_file, lakehouse_id: VALORES.p_lakehouse_id }).parts

/** La part `.platform` que el motor agrega por su cuenta (Δ6, hecho medido del hito cero). */
const PLATFORM_PART: DefinitionPart = { path: '.platform', payloadBase64: Buffer.from('{"metadata":{"type":"SparkJobDefinition"}}', 'utf8').toString('base64') }

/**
 * Motor falso: guarda definiciones por `ws/item` y deja programar el fallo de cada operación. Persiste
 * lo escrito CON la part propia del motor, que es lo que la comparación de H4 debe ignorar.
 */
function fakeMotor(): {
  client: ItemAuthoringClient
  items: Map<string, DefinitionPart[]>
  fallos: { create?: unknown; update?: unknown }
  /** Lo que el motor persiste realmente (default: lo enviado). Sirve para el read-back no equivalente. */
  persiste: (parts: DefinitionPart[]) => DefinitionPart[]
  nextId: string
} {
  // El estado es EL objeto que se devuelve (no una copia): así reprogramar `persiste` o `nextId` desde
  // un caso afecta de verdad al cliente. Con un spread, esas dos reasignaciones no se verían.
  const estado = {
    items: new Map<string, DefinitionPart[]>(),
    fallos: {} as { create?: unknown; update?: unknown },
    persiste: (parts: DefinitionPart[]): DefinitionPart[] => parts,
    nextId: 'ITEM-1',
  }
  const client: ItemAuthoringClient = {
    async createItem(ws, decl) {
      if (estado.fallos.create) throw estado.fallos.create
      estado.items.set(`${ws}/${estado.nextId}`, [...estado.persiste(decl.definition.parts), PLATFORM_PART])
      return { itemId: estado.nextId }
    },
    async getDefinition(ws, itemId): Promise<ItemDefinition | null> {
      const parts = estado.items.get(`${ws}/${itemId}`)
      return parts ? { parts } : null
    },
    async updateDefinition(ws, itemId, def): Promise<void> {
      if (estado.fallos.update) throw estado.fallos.update
      estado.items.set(`${ws}/${itemId}`, [...estado.persiste(def.parts), PLATFORM_PART])
    },
  }
  return Object.assign(estado, { client })
}

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

describe('admin · Publicación de jobs en el motor (#107 fase 2)', () => {
  let admin: AdminHandler
  let gov: SqliteGovernanceStore
  let audit: LogEventInput[]
  let motor: ReturnType<typeof fakeMotor>
  let db: SqlDb
  let ledger: JobPublicationLedger

  beforeEach(async () => {
    audit = []
    motor = fakeMotor()
    gov = await SqliteGovernanceStore.open(null, {
      sources: [{ id: 'sap', label: 'SAP B1', oferta: 'PT1H', domain: 'cartera' }],
      processes: [
        { id: 'p_sap', label: 'Ingesta SAP', sourceId: 'sap', engine: { workspaceId: 'WS', itemId: 'SJD', jobType: 'sparkjob' } },
        { id: 'p_nuevo', label: 'Proceso sin item', sourceId: 'sap' },
      ],
    })
    db = await openSqliteDb(null)
    ensureJobPublicationTable(db)
    ledger = {
      lastOk: async (sel) => lastOkPublication(db, sel),
      record: async (row) => recordPublication(db, row),
      pendingUnknown: async () => pendingUnknownPublications(db),
      resolveUnknown: async (id, r) => resolveUnknownPublication(db, id, r),
      list: async (o) => listPublications(db, o ?? {}),
    }
    admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      sourceRegistry: async () => ({ sources: await gov.listSources(), processes: await gov.listProcesses(), outputs: await gov.listProcessOutputs() }),
      sourcesAdmin: gov,
      jobsPublish: { templates: [BUNDLE], authoring: motor.client, ledger },
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
  const publicaciones = (): PublicationRow[] => listPublications(db, {})
  const hashDe = (body: string): string => body.match(/name="hash" value="([0-9a-f]+)"/)![1]
  const auditPub = (): LogEventInput[] => audit.filter((e) => e['type'] === 'jobs-publish')

  // (a) fail-closed por rol: publicar es acto de PLATAFORMA (D4)
  it('el steward no-admin recibe 403 en el GET de la sección y en TODO POST de publicación', async () => {
    expect((await go(mockReq('GET', '/admin/sources', STEWARD))).statusCode).toBe(403)
    for (const p of ['publish-plan', 'publish-exec', 'publish-reverify']) {
      const res = await postAs(STEWARD, `/admin/sources/${p}`, { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', ...VALORES })
      expect(res.statusCode, p).toBe(403)
    }
    expect(publicaciones()).toEqual([])
    expect((await gov.listProcesses()).find((p) => p.id === 'p_nuevo')!.engine).toBeUndefined()
  })

  // (b) fail-closed por cableado: sin publisher, la sección no existe (regresión cero)
  it('sin publisher cableado, la página no ofrece un solo form de publicación y las rutas no existen', async () => {
    const ro = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      sourceRegistry: async () => ({ sources: await gov.listSources(), processes: await gov.listProcesses(), outputs: [] }),
      sourcesAdmin: gov,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const res = mockRes()
    await ro.tryHandle(mockReq('GET', '/admin/sources', ADMIN), res as unknown as ServerResponse)
    expect(res.body).toContain('SAP B1') // la vista de fase 1 sigue completa
    expect(res.body).not.toContain('Publicación de jobs')
    expect(res.body).not.toContain('/admin/sources/publish-plan')
    for (const p of ['publish-plan', 'publish-exec', 'publish-reverify']) {
      const w = mockRes()
      await ro.tryHandle(mockReq('POST', `/admin/sources/${p}`, ADMIN, '', 'application/x-www-form-urlencoded'), w as unknown as ServerResponse)
      expect(w.statusCode, p).toBe(404)
    }
    expect(publicaciones()).toEqual([])
  })

  it('con plantillas y publisher, el GET del admin trae el form de publicación', async () => {
    const res = await go(mockReq('GET', '/admin/sources', ADMIN))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('action="/admin/sources/publish-plan"')
    expect(res.body).toContain('sjd_ingesta@1.0')
    expect(res.body).toContain('Sin publicaciones.')
  })

  // (c) el camino feliz: plan → exec, con read-back, ledger, engine_ref y audit
  it('plan → exec feliz: crea el item, lo verifica por read-back, sella el ledger, escribe engine_ref managed y audita', async () => {
    const t = await token()
    const plan = await postAs(ADMIN, '/admin/sources/publish-plan', { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', item_name: 'job_nuevo', ...VALORES }, t)
    expect(plan.statusCode).toBe(200)
    expect(plan.body).toContain('se <b>crea</b> el item «job_nuevo»')
    expect(plan.body).toContain('sjd_ingesta@1.0')
    expect(publicaciones()).toEqual([]) // derivar el plan NO escribe nada

    const exec = await postAs(ADMIN, '/admin/sources/publish-exec', {
      process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', item_name: 'job_nuevo', hash: hashDe(plan.body), ...VALORES,
    }, t)
    expect(exec.statusCode).toBe(303)
    expect(exec.headers['location']).toContain('/admin/sources?msg=')

    const filas = publicaciones()
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ processId: 'p_nuevo', templateId: 'sjd_ingesta', templateVersion: '1.0', workspaceId: 'WS1', itemId: 'ITEM-1', action: 'create', outcome: 'ok', byUser: ADMIN })
    expect(filas[0].params).toEqual({ main_file: VALORES.p_main_file, lakehouse_id: VALORES.p_lakehouse_id })

    // D10: desde acá la cadena de fase 1 (observar/agendar/pausar) funciona sola.
    expect((await gov.listProcesses()).find((p) => p.id === 'p_nuevo')).toMatchObject({
      managed: true, engine: { workspaceId: 'WS1', itemId: 'ITEM-1', jobType: 'sparkjob' },
    })
    expect(auditPub().map((e) => e['op'])).toEqual(['publish-plan', 'publish-exec'])
    expect(auditPub()[1]).toMatchObject({ process: 'p_nuevo', template: 'sjd_ingesta@1.0', sha: filas[0].definitionSha256, outcome: 'ok', by: ADMIN })
  })

  // (d) el sello del plan contra carreras (D5)
  it('un hash viejo no ejecuta: 409 con el plan FRESCO, y el ledger no gana filas', async () => {
    const t = await token()
    const plan = await postAs(ADMIN, '/admin/sources/publish-plan', { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', ...VALORES }, t)
    const viejo = hashDe(plan.body)
    const campos = { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', ...VALORES }
    expect((await postAs(ADMIN, '/admin/sources/publish-exec', { ...campos, hash: viejo }, t)).statusCode).toBe(303)
    expect(publicaciones()).toHaveLength(1)

    // El estado cambió (el item existe y el ledger tiene un `ok`): el mismo hash ya no vale.
    const stale = await postAs(ADMIN, '/admin/sources/publish-exec', { ...campos, hash: viejo }, t)
    expect(stale.statusCode).toBe(409)
    expect(stale.body).toContain('El estado cambió desde que viste este plan')
    expect(stale.body).toContain('se <b>actualiza</b> la definición del item') // el plan fresco, ya como update
    expect(hashDe(stale.body)).not.toBe(viejo)
    expect(publicaciones()).toHaveLength(1) // nada se ejecutó
  })

  // (e) CSRF
  it('CSRF inválido: 403 en toda escritura de publicación, sin tocar el motor ni el ledger', async () => {
    for (const p of ['publish-plan', 'publish-exec', 'publish-reverify']) {
      const res = await postAs(ADMIN, `/admin/sources/${p}`, { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', ...VALORES }, 'deadbeef')
      expect(res.statusCode, p).toBe(403)
    }
    expect(publicaciones()).toEqual([])
    expect(motor.items.size).toBe(0)
    expect(auditPub()).toEqual([])
  })

  // (f) denegada: el errorCode crudo es el dato que nombra la pieza que falta
  it('el motor deniega: outcome `denegada`, el errorCode crudo se muestra y NO se escribe engine_ref', async () => {
    const t = await token()
    motor.fallos.create = new AuthoringDenied('fabric-authoring: createItem DENEGADO (403)', { status: 403, errorCode: 'InsufficientPrivileges' })
    const plan = await postAs(ADMIN, '/admin/sources/publish-plan', { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', ...VALORES }, t)
    const exec = await postAs(ADMIN, '/admin/sources/publish-exec', { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', hash: hashDe(plan.body), ...VALORES }, t)
    expect(exec.statusCode).toBe(200)
    expect(exec.body).toContain('InsufficientPrivileges')
    const fila = publicaciones()[0]
    expect(fila).toMatchObject({ outcome: 'denegada', detail: 'errorCode=InsufficientPrivileges', action: 'create' })
    expect(fila.itemId).toBeUndefined()
    expect((await gov.listProcesses()).find((p) => p.id === 'p_nuevo')!.engine).toBeUndefined()
  })

  // (g) D7: sin read-back equivalente NO hay `ok`, por más que la escritura no haya lanzado
  it('read-back no equivalente: la publicación NO es `ok` (es `fallida`) y el proceso no gana engine_ref', async () => {
    const t = await token()
    // El motor «acepta» pero persiste otra cosa: exactamente el caso que un éxito por ausencia de error ocultaría.
    motor.persiste = (parts) => parts.map((p) => ({ path: p.path, payloadBase64: Buffer.from('{"executableFile":"otra_cosa.py"}', 'utf8').toString('base64') }))
    const plan = await postAs(ADMIN, '/admin/sources/publish-plan', { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', ...VALORES }, t)
    const exec = await postAs(ADMIN, '/admin/sources/publish-exec', { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', hash: hashDe(plan.body), ...VALORES }, t)
    expect(exec.statusCode).toBe(200)
    const fila = publicaciones()[0]
    expect(fila.outcome).toBe('fallida')
    expect(fila.detail).toContain('read-back')
    expect((await gov.listProcesses()).find((p) => p.id === 'p_nuevo')!.engine).toBeUndefined()
  })

  it('el read-back ignora las parts propias del motor (`.platform`): con ellas la publicación sigue siendo `ok`', async () => {
    const t = await token()
    const plan = await postAs(ADMIN, '/admin/sources/publish-plan', { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', ...VALORES }, t)
    await postAs(ADMIN, '/admin/sources/publish-exec', { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', hash: hashDe(plan.body), ...VALORES }, t)
    expect(motor.items.get('WS1/ITEM-1')!.some((p) => p.path === '.platform')).toBe(true)
    expect(publicaciones()[0].outcome).toBe('ok')
  })

  // (h) desconocida + su resolución por «Re-verificar» (D7)
  it('LRO sin culminar: `desconocida` con el operationId; el Re-verificar la resuelve con lo MEDIDO', async () => {
    const t = await token()
    // El item ya existe en el motor con una definición que Vergis nunca publicó (engine_ref de fase 1
    // apuntando a un item pre-existente): el plan lo DECLARA antes de sobrescribirlo (D6).
    motor.items.set('WS/SJD', [{ path: 'SparkJobDefinitionV1.json', payloadBase64: Buffer.from('{"executableFile":"viejo.py"}', 'utf8').toString('base64') }])
    motor.fallos.update = new AuthoringUnknown('fabric-authoring: updateDefinition con desenlace DESCONOCIDO', { operationId: 'OP-9' })

    const plan = await postAs(ADMIN, '/admin/sources/publish-plan', { process: 'p_sap', template: 'sjd_ingesta', ...VALORES }, t)
    expect(plan.body).toContain('Vergis nunca publicó')
    const exec = await postAs(ADMIN, '/admin/sources/publish-exec', { process: 'p_sap', template: 'sjd_ingesta', hash: hashDe(plan.body), ...VALORES }, t)
    expect(exec.statusCode).toBe(200)
    expect(exec.body).toContain('operationId=OP-9')
    const desconocida = publicaciones()[0]
    expect(desconocida).toMatchObject({ outcome: 'desconocida', detail: 'operationId=OP-9', action: 'update', itemId: 'SJD' })
    expect((await go(mockReq('GET', '/admin/sources', ADMIN))).body).toContain(`Re-verificar #${desconocida.id}`)
    // El motor NO cambió: la definición sigue siendo la vieja. Vergis no la dio por publicada.
    expect(motor.items.get('WS/SJD')![0].payloadBase64).toBe(Buffer.from('{"executableFile":"viejo.py"}', 'utf8').toString('base64'))
  })

  it('Re-verificar una `desconocida`: re-observa el motor, resuelve la fila y no muta la original', async () => {
    const t = await token()
    motor.items.set('WS/SJD', [{ path: 'SparkJobDefinitionV1.json', payloadBase64: Buffer.from('{"executableFile":"viejo.py"}', 'utf8').toString('base64') }])
    motor.fallos.update = new AuthoringUnknown('desenlace DESCONOCIDO', { operationId: 'OP-9' })
    const plan = await postAs(ADMIN, '/admin/sources/publish-plan', { process: 'p_sap', template: 'sjd_ingesta', ...VALORES }, t)
    await postAs(ADMIN, '/admin/sources/publish-exec', { process: 'p_sap', template: 'sjd_ingesta', hash: hashDe(plan.body), ...VALORES }, t)
    const desconocida = publicaciones()[0]

    // Resulta que el motor SÍ había persistido lo publicado (con su part propia): el re-verificar lo mide.
    motor.fallos.update = undefined
    motor.items.set('WS/SJD', [...PARTS_PUBLICADAS, PLATFORM_PART])

    const res = await postAs(ADMIN, '/admin/sources/publish-reverify', { id: String(desconocida.id) }, t)
    expect(res.statusCode).toBe(303)
    const filas = publicaciones()
    expect(filas).toHaveLength(2)
    expect(filas[0]).toMatchObject({ outcome: 'ok', processId: 'p_sap', itemId: 'SJD' })
    expect(filas[0].detail).toContain(`resuelve:#${desconocida.id}`)
    expect(filas[1]).toMatchObject({ id: desconocida.id, outcome: 'desconocida' }) // la original, intacta
    expect(await ledger.pendingUnknown()).toEqual([])
    expect(auditPub().map((e) => e['op'])).toContain('publish-reverify')
  })

  it('el plan de un proceso sin cambios lo declara, y una plantilla desconocida es 400 sin tocar nada', async () => {
    const t = await token()
    const campos = { process: 'p_nuevo', template: 'sjd_ingesta', workspace: 'WS1', ...VALORES }
    const plan = await postAs(ADMIN, '/admin/sources/publish-plan', campos, t)
    await postAs(ADMIN, '/admin/sources/publish-exec', { ...campos, hash: hashDe(plan.body) }, t)
    const otra = await postAs(ADMIN, '/admin/sources/publish-plan', campos, t)
    expect(otra.body).toContain('el motor ya tiene <b>exactamente</b> esta definición')

    const mala = await postAs(ADMIN, '/admin/sources/publish-plan', { ...campos, template: 'fantasma' }, t)
    expect(mala.statusCode).toBe(400)
    expect(mala.body).toContain('Plantilla desconocida')
    expect(publicaciones()).toHaveLength(1)
  })
})
