import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminHandler, type IntakeRunner, type DomainEntityFreshness } from '../server/admin'
import {
  parseMasterDataConfig,
  parseDomainsConfig,
  parseIntakeConfig,
  SqliteMasterDataStore,
  SqliteAdminStore,
  SqliteGovernanceStore,
  type IntakeTarget,
  type IntakeTrigger,
} from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'

const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const STEWARD = 'steward@gh.cl'
const BOUNDARY = 'TESTBOUNDARY'

const ENTITIES = parseMasterDataConfig({
  entities: [{ id: 'empresas_relacionadas', label: 'Empresas Relacionadas', domain: 'cartera', columns: [{ name: 'rut', label: 'RUT', type: 'string', pk: true }] }],
})
const DOMAINS = parseDomainsConfig({ domains: [{ id: 'cartera', label: 'Cartera / Finanzas', stewards: [STEWARD] }] })
const SLOTS = parseIntakeConfig({
  // Issue #109: catálogo de la instancia — la fuente de opciones de un campo enum.
  catalogs: [{
    id: 'empresas_gh', label: 'Empresas del grupo',
    options: [{ value: '96835510-4', label: 'Hijuelas S.A.' }, { value: '77130310-2', label: 'Agrícola El Tranque' }],
  }],
  slots: [
    {
      id: 'saldos_cartera', label: 'Antigüedad de saldos', domain: 'cartera',
      accept: 'saldos *.xlsx', maxBytes: 1024,
      target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' },
      trigger: { processRef: 'PIPE' },
    },
    // Issue #76: slot con metadata requerida (empresa por RUT + versión enum).
    {
      id: 'facturas', label: 'Facturas', domain: 'cartera', maxBytes: 4096,
      target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/facturas' },
      trigger: { processRef: 'PIPE2' },
      meta: [
        { id: 'empresa_rut', label: 'Empresa (receptor)', type: 'rut', required: true },
        { id: 'version', label: 'Versión', type: 'enum', options: ['V0', 'V1'], required: true },
      ],
    },
    // Issue #95: la metadata la declara el NOMBRE del archivo (convención + catálogo de la instancia).
    {
      id: 'documentos', label: 'Documentos', domain: 'cartera', maxBytes: 4096,
      target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/documentos' },
      trigger: { processRef: 'PIPE3' },
      meta: [{
        id: 'empresa_rut', label: 'Empresa (receptor)', type: 'rut', required: true,
        from_filename: {
          patterns: ['Listado EasyDoc {codigo}.xlsx', 'Listado SAP {codigo}.xlsx'],
          catalog: { VH: '96835510-4', TSV: '77130310-2' },
          verify_against: 'RUTRECEPTOR',
        },
      }],
    },
    // Issue #109: el campo toma sus opciones del catálogo de la instancia (dropdown, no texto libre).
    {
      id: 'cargos', label: 'Cargos', domain: 'cartera', maxBytes: 4096,
      target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/cargos' },
      meta: [{ id: 'empresa', label: 'Empresa (receptor)', type: 'enum', required: true, options_ref: 'empresas_gh' }],
    },
  ],
})
// Fila de frescura cuya entidad casa con el slot por el item del motor (engineItemId === slot.trigger.processRef).
// Así la carga de archivo (plegada en Frescura) aparece en la fila de la entidad.
const FRESHNESS: DomainEntityFreshness[] = [{
  entity: 'dbo.fact_saldos', processId: 'p_saldos', processLabel: 'Saldos cartera', oferta: 'P1W',
  dependentPis: [], tightestDemand: null, requiredCadence: 'P1W', requiredCadenceSeconds: 604800, unsatisfiable: false,
  engine: true, engineJobType: 'sparkjob', engineItemId: 'PIPE', runs: [], actualScheduleSeconds: null,
}]

function mockReq(method: string, url: string, user: string, body: Buffer | string = '', contentType?: string): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user }
  if (contentType) r.headers['content-type'] = contentType
  return r
}
function multipart(fields: Record<string, string>, file?: { filename: string; bytes: Buffer }): { body: Buffer; ct: string } {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  if (file) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`))
    parts.push(file.bytes, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return { body: Buffer.concat(parts), ct: `multipart/form-data; boundary=${BOUNDARY}` }
}
function multipartFiles(fields: Record<string, string>, files: { filename: string; bytes: Buffer }[]): { body: Buffer; ct: string } {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  for (const f of files) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`))
    parts.push(f.bytes, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return { body: Buffer.concat(parts), ct: `multipart/form-data; boundary=${BOUNDARY}` }
}
interface MockRes { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(chunk?: string): void }
function mockRes(): MockRes {
  return { statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(chunk) { if (chunk) this.body += chunk } }
}

describe('admin · gestión de dominio + ingesta', () => {
  let admin: AdminHandler
  let audit: LogEventInput[]
  let puts: { filename: string; len: number; target: IntakeTarget; sidecar?: string }[]
  let runs: string[]

  beforeEach(async () => {
    audit = []
    puts = []
    runs = []
    const intake: IntakeRunner = {
      put: async (target: IntakeTarget, filename: string, bytes: Buffer, sidecar?: string) => { puts.push({ filename, len: bytes.length, target, sidecar }) },
      runNow: async (trigger: IntakeTrigger) => { runs.push(trigger.processRef) },
    }
    admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      intakeSlots: SLOTS,
      intake,
      domainFreshness: async () => FRESHNESS, // la carga vive en Frescura (casa el slot por engineItemId)
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: (e) => audit.push(e),
      secret: SECRET,
    })
  })

  const go = async (req: IncomingMessage) => {
    const res = mockRes()
    await admin.tryHandle(req, res as unknown as ServerResponse)
    return res
  }
  const tokenFrom = (html: string): string => html.match(/name="_csrf" value="([0-9a-f]+)"/)![1]

  it('dashboard: admin ve el dominio y, en el avatar, Configuración', async () => {
    const res = await go(mockReq('GET', '/admin', ADMIN))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Cartera / Finanzas')
    expect(res.body).toContain('Configuración') // entrada de plataforma en el menú de avatar
  })

  it('steward (no-admin) entra y ve su dominio; NO ve Configuración', async () => {
    const dash = await go(mockReq('GET', '/admin', STEWARD))
    expect(dash.statusCode).toBe(200)
    expect(dash.body).toContain('Cartera / Finanzas')
    expect(dash.body).not.toContain('Configuración')
    // /admin/plataforma y /admin/roles → 403 para el steward
    expect((await go(mockReq('GET', '/admin/plataforma', STEWARD))).statusCode).toBe(403)
    expect((await go(mockReq('GET', '/admin/roles', STEWARD))).statusCode).toBe(403)
  })

  it('ajeno (ni admin ni steward) → 403 en /admin', async () => {
    const res = await go(mockReq('GET', '/admin', 'nadie@x.com'))
    expect(res.statusCode).toBe(403)
    expect(audit.find((e) => e.type === 'admin-access-denied')?.user).toBe('nadie@x.com')
  })

  it('home del dominio = MENÚ de FACETAS (no ítems ni forms)', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Gestión del dominio')
    // facetas (categorías), cada una a su página. La carga de archivos se plegó en Frescura.
    expect(res.body).toContain('Frescura')
    expect(res.body).toContain('href="/admin/dominio/cartera/frescura"')
    expect(res.body).not.toContain('Ingesta de archivos')
    expect(res.body).not.toContain('href="/admin/dominio/cartera/ingesta"')
    expect(res.body).toContain('Data Maestra')
    expect(res.body).toContain('href="/admin/dominio/cartera/maestra"')
    // los ÍTEMS de data maestra NO cuelgan del home (viven dentro de la faceta)
    expect(res.body).not.toContain('Empresas Relacionadas')
    expect(res.body).not.toContain('href="/admin/e/empresas_relacionadas"')
    // el home NO expande el form de carga (eso vive en su propia página)
    expect(res.body).not.toContain('enctype="multipart/form-data"')
  })

  it('sidebar = ÁRBOL: el dominio activo se expande a sus facetas', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera', STEWARD))
    const side = res.body.slice(0, res.body.indexOf('class="main"')) // el sidebar va antes del main
    expect(side).toContain('class="l2"') // facetas indentadas bajo el dominio
    expect(side).toContain('/admin/dominio/cartera/frescura')
    expect(side).toContain('/admin/dominio/cartera/maestra')
    expect(side).not.toContain('/admin/dominio/cartera/ingesta')
  })

  it('sidebar: parado en una entidad → expande dominio → Data Maestra → la entidad activa', async () => {
    const res = await go(mockReq('GET', '/admin/e/empresas_relacionadas', STEWARD))
    const side = res.body.slice(0, res.body.indexOf('class="main"'))
    expect(side).toContain('/admin/dominio/cartera/maestra') // la faceta padre se muestra
    expect(side).toMatch(/<a href="\/admin\/e\/empresas_relacionadas" class="l3 on">/) // hoja activa, nivel 3
  })

  it('faceta Data Maestra = página propia con las entidades adentro', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera/maestra', STEWARD))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Data Maestra')
    expect(res.body).toContain('Empresas Relacionadas')
    expect(res.body).toContain('href="/admin/e/empresas_relacionadas"')
    expect(res.body).toContain('← Cartera / Finanzas') // navegación de regreso al home del dominio
  })

  it('la carga (plegada en Frescura) muestra el form por entidad', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('enctype="multipart/form-data"')
    expect(res.body).toContain('/admin/dominio/cartera/intake/saldos_cartera') // form de carga en la fila de la entidad
    expect(res.body).toContain('dbo.fact_saldos') // la entidad que casa con el slot
    expect(res.body).toContain('← Cartera / Finanzas') // navegación de regreso al home del dominio
  })

  it('redirige /ingesta (legado) a /frescura', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera/ingesta', STEWARD))
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toBe('/admin/dominio/cartera/frescura')
  })

  it('ingesta válida (steward): 303 + put a OneLake + run-now + auditoría', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipart({ _csrf: token }, { filename: 'saldos w24.xlsx', bytes: Buffer.from('contenido ok') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toContain('/admin/dominio/cartera/frescura?msg=')
    expect(puts).toHaveLength(1)
    expect(puts[0].filename).toBe('saldos w24.xlsx')
    expect(puts[0].target.path).toBe('Files/intake/saldos')
    expect(runs).toEqual(['PIPE']) // land-and-trigger
    const ev = audit.find((e) => e.type === 'intake')
    expect(ev?.ok).toBe(true)
    expect(ev?.triggered).toBe(true)
  })

  it('nombre que no matchea el patrón → 400, sin put', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipart({ _csrf: token }, { filename: 'otra-cosa.csv', bytes: Buffer.from('x') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303) // PRG: el error vuelve como msg a Frescura
    expect(puts).toHaveLength(0)
    expect(audit.find((e) => e.type === 'intake')?.ok).toBe(false)
  })

  it('archivo que excede maxBytes → 400, sin put', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipart({ _csrf: token }, { filename: 'saldos big.xlsx', bytes: Buffer.alloc(2048, 7) })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303) // PRG: el error vuelve como msg a Frescura
    expect(puts).toHaveLength(0)
  })

  it('CSRF inválido → 403, sin put', async () => {
    const mp = multipart({ _csrf: 'NOPE' }, { filename: 'saldos w24.xlsx', bytes: Buffer.from('x') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(403)
    expect(puts).toHaveLength(0)
  })

  it('multi-archivo: N archivos → N puts + UN SOLO run-now por lote', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipartFiles({ _csrf: token }, [
      { filename: 'saldos clientes w24.xlsx', bytes: Buffer.from('clientes') },
      { filename: 'saldos proveedores w24.xlsx', bytes: Buffer.from('proveedores') },
    ])
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toContain('/admin/dominio/cartera/frescura?msg=')
    expect(puts).toHaveLength(2)
    expect(runs).toEqual(['PIPE']) // UN trigger, no dos
    expect(audit.filter((e) => e.type === 'intake' && e.ok)).toHaveLength(2)
  })

  it('multi-archivo atómico: si un archivo del lote es inválido → 400 y NINGÚN put', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipartFiles({ _csrf: token }, [
      { filename: 'saldos clientes w24.xlsx', bytes: Buffer.from('ok') },
      { filename: 'otra-cosa.csv', bytes: Buffer.from('mal') }, // no matchea el patrón
    ])
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303) // PRG: el error vuelve como msg a Frescura
    expect(puts).toHaveLength(0) // o entra el lote completo o ninguno
    expect(runs).toHaveLength(0)
  })

  it('input de archivo acepta selección múltiple', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))
    expect(res.body).toMatch(/<input type="file" name="file" multiple required>/)
  })

  // ── Issue #76: metadata requerida por slot ──────────────────────────────────
  it('slot sin meta: put SIN sidecar (regresión cero)', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipart({ _csrf: token }, { filename: 'saldos w24.xlsx', bytes: Buffer.from('ok') })
    await go(mockReq('POST', '/admin/dominio/cartera/intake/saldos_cartera', STEWARD, mp.body, mp.ct))
    expect(puts).toHaveLength(1)
    expect(puts[0].sidecar).toBeUndefined()
  })

  it('slot con meta válida: put CON sidecar (slot → campos → auditoría) + run-now', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipart({ _csrf: token, meta_empresa_rut: '96835510-4', meta_version: 'V1' }, { filename: 'facturas.xlsx', bytes: Buffer.from('datos') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/facturas', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303)
    expect(puts).toHaveLength(1)
    expect(puts[0].sidecar).toBeDefined()
    expect(JSON.parse(puts[0].sidecar!)).toEqual({ slot: 'facturas', empresa_rut: '96835510-4', version: 'V1', uploadedBy: STEWARD, uploadedAt: expect.any(String) })
    expect(runs).toEqual(['PIPE2'])
  })

  it('slot con meta: campo requerido faltante → 400, sin put', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipart({ _csrf: token, meta_version: 'V1' }, { filename: 'facturas.xlsx', bytes: Buffer.from('datos') }) // falta empresa_rut
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/facturas', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303) // PRG: el error vuelve como msg
    expect(res.headers['location']).toContain('Empresa')
    expect(puts).toHaveLength(0)
    expect(runs).toHaveLength(0)
    expect(audit.find((e) => e.type === 'intake')?.ok).toBe(false)
  })

  it('slot con meta: RUT con DV inválido → 400, sin put', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipart({ _csrf: token, meta_empresa_rut: '96835510-3', meta_version: 'V1' }, { filename: 'facturas.xlsx', bytes: Buffer.from('datos') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/facturas', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toContain('RUT')
    expect(puts).toHaveLength(0)
  })

  it('uploadForm del slot con meta: renderiza los controles (select enum + rut) requeridos', async () => {
    // El slot `facturas` no casa con una entidad de FRESHNESS → aparece como slot huérfano con su form.
    const res = await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('name="meta_empresa_rut"')
    expect(res.body).toContain('name="meta_version"')
    expect(res.body).toContain('<option value="V0">V0</option>')
  })

  // ── Issue #109: el catálogo de la instancia es la fuente de opciones del campo ──
  it('#109 · uploadForm del slot con options_ref: dropdown con «etiqueta · value» y placeholder', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<option value="">— elegir —</option>')
    expect(res.body).toContain('<option value="96835510-4">Hijuelas S.A. · 96835510-4</option>')
    expect(res.body).toContain('<option value="77130310-2">Agrícola El Tranque · 77130310-2</option>')
  })

  it('#109 · el POST manda, no el <select>: un value fuera del catálogo → sin put', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipart({ _csrf: token, meta_empresa: '12345678-5' }, { filename: 'cargos.xlsx', bytes: Buffer.from('datos') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/cargos', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303)
    expect(decodeURIComponent(res.headers['location'] as string)).toContain('no está en el catálogo «empresas_gh»')
    expect(puts).toHaveLength(0)
  })

  it('#109 · value del catálogo → sube y el sidecar lleva el value (el label jamás viaja)', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipart({ _csrf: token, meta_empresa: '96835510-4' }, { filename: 'cargos.xlsx', bytes: Buffer.from('datos') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/cargos', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303)
    expect(puts).toHaveLength(1)
    expect(JSON.parse(puts[0].sidecar!)).toEqual({ slot: 'cargos', empresa: '96835510-4', uploadedBy: STEWARD, uploadedAt: expect.any(String) })
    expect(puts[0].sidecar).not.toContain('Hijuelas')
  })

  // ── Issue #95: metadata derivada del nombre del archivo ─────────────────────
  it('#95 · lote con dos empresas distintas: cada archivo lleva SU sidecar derivado + un solo run-now', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipartFiles({ _csrf: token }, [
      { filename: 'Listado EasyDoc VH.xlsx', bytes: Buffer.from('easydoc') },
      { filename: 'Listado SAP TSV.xlsx', bytes: Buffer.from('sap') },
    ])
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/documentos', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303)
    expect(puts).toHaveLength(2)
    expect(JSON.parse(puts[0].sidecar!)).toEqual({ slot: 'documentos', empresa_rut: '96835510-4', verify: { empresa_rut: 'RUTRECEPTOR' }, uploadedBy: STEWARD, uploadedAt: expect.any(String) })
    expect(JSON.parse(puts[1].sidecar!).empresa_rut).toBe('77130310-2')
    expect(runs).toEqual(['PIPE3'])
  })

  it('#95 · nombre fuera de convención → 400 con el patrón esperado, sin put ni trigger', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipart({ _csrf: token }, { filename: 'Factura_VH.xlsx', bytes: Buffer.from('datos') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/documentos', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303)
    expect(decodeURIComponent(res.headers['location'] as string)).toContain('Listado EasyDoc {codigo}.xlsx')
    expect(puts).toHaveLength(0)
    expect(runs).toHaveLength(0)
    expect(audit.find((e) => e.type === 'intake')?.ok).toBe(false)
  })

  it('#95 · código fuera del catálogo → 400 nombrando los códigos válidos, sin put', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipart({ _csrf: token }, { filename: 'Listado EasyDoc ZZZ.xlsx', bytes: Buffer.from('datos') })
    const res = await go(mockReq('POST', '/admin/dominio/cartera/intake/documentos', STEWARD, mp.body, mp.ct))
    expect(decodeURIComponent(res.headers['location'] as string)).toMatch(/catálogo.*VH, TSV/)
    expect(puts).toHaveLength(0)
  })

  it('#95 · lote atómico: un nombre malo entre válidos → NINGÚN put', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))).body)
    const mp = multipartFiles({ _csrf: token }, [
      { filename: 'Listado EasyDoc VH.xlsx', bytes: Buffer.from('ok') },
      { filename: 'Listado SAP ZZZ.xlsx', bytes: Buffer.from('mal') },
    ])
    await go(mockReq('POST', '/admin/dominio/cartera/intake/documentos', STEWARD, mp.body, mp.ct))
    expect(puts).toHaveLength(0)
    expect(runs).toHaveLength(0)
  })

  it('#95 · el formulario NO pide el campo derivado: explica la convención', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/cartera/frescura', STEWARD))
    expect(res.body).toContain('se toma del nombre del archivo')
    expect(res.body).toContain('Listado EasyDoc {codigo}.xlsx')
    // El único `meta_empresa_rut` de la página es el del slot #76 (formulario); el derivado no agrega input.
    expect(res.body.match(/name="meta_empresa_rut"/g)).toHaveLength(1)
  })

  it('steward de cartera NO puede ingestar a un dominio que no gestiona', async () => {
    const res = await go(mockReq('GET', '/admin/dominio/personas', STEWARD))
    expect(res.statusCode).toBe(404) // dominio no declarado → 404 (no se filtra su existencia con 403)
  })

  it('miembro de un default-steward-group gestiona TODOS los dominios (sin ser admin ni steward directo)', async () => {
    const gov = await SqliteGovernanceStore.open(null, { admins: [ADMIN], groups: [{ id: 'ce', label: 'Centro de Excelencia', members: ['consultor@teams.ratio.cl'] }] })
    const a = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: gov,
      groupStore: gov,
      domains: DOMAINS,
      domainStewardGroups: ['ce'],
      intakeSlots: SLOTS,
      intake: { put: async () => {}, runNow: async () => {} },
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const run = async (req: IncomingMessage) => { const res = mockRes(); await a.tryHandle(req, res as unknown as ServerResponse); return res }
    // consultor@teams.ratio.cl: NO admin, NO steward directo de cartera (stewards=[STEWARD]), pero está en 'ce'
    const dash = await run(mockReq('GET', '/admin', 'consultor@teams.ratio.cl'))
    expect(dash.statusCode).toBe(200)
    expect(dash.body).toContain('Cartera / Finanzas')
    const dom = await run(mockReq('GET', '/admin/dominio/cartera', 'consultor@teams.ratio.cl'))
    expect(dom.statusCode).toBe(200)
    expect(dom.body).toContain('Data Maestra') // home = menú de facetas; gestiona el dominio
    // ajeno (ni admin, ni steward, ni en el grupo) → 403
    const ajeno = await run(mockReq('GET', '/admin', 'nadie@x.com'))
    expect(ajeno.statusCode).toBe(403)
  })

  // #183 · un dominio nombra un GRUPO en sus `stewards:` — granularidad por dominio, que es lo que el
  // default-steward-group (todo o nada) no puede expresar. Lo que se mide acá y no en el unitario: que
  // la membresía se consulte POR REQUEST, así que un alta o baja en `/admin/grupos` se siente de una,
  // con el MISMO handler y el MISMO `domains.yaml` parseado una sola vez.
  it('un `group:` en stewards abre SOLO su dominio, y el alta/baja del grupo surte efecto sin reiniciar', async () => {
    const gov = await SqliteGovernanceStore.open(null, {
      admins: [ADMIN],
      groups: [{ id: 'feeders_cartera', label: 'Feeders Cartera', members: [] }],
    })
    const domains = parseDomainsConfig({
      domains: [
        { id: 'cartera', label: 'Cartera / Finanzas', stewards: ['group:feeders_cartera'] },
        { id: 'personas', label: 'Personas', stewards: ['rrhh@gh.cl'] },
      ],
    })
    const a = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: gov,
      groupStore: gov,
      domains,
      intakeSlots: SLOTS,
      intake: { put: async () => {}, runNow: async () => {} },
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const run = async (req: IncomingMessage) => { const res = mockRes(); await a.tryHandle(req, res as unknown as ServerResponse); return res }
    const felipe = 'felipe@gh.cl'
    // Grupo declarado pero VACÍO: fail-closed, la lista no resuelve a nadie y el dominio no se abre.
    expect((await run(mockReq('GET', '/admin', felipe))).statusCode).toBe(403)
    // Alta en el grupo (lo que hace `/admin/grupos`), sin tocar el YAML ni recrear el handler.
    await gov.addMember('feeders_cartera', felipe)
    const dash = await run(mockReq('GET', '/admin', felipe))
    expect(dash.statusCode).toBe(200)
    expect(dash.body).toContain('Cartera / Finanzas')
    expect(dash.body).not.toContain('Personas') // granularidad: NO es la llave maestra
    expect((await run(mockReq('GET', '/admin/dominio/cartera', felipe))).statusCode).toBe(200)
    expect((await run(mockReq('GET', '/admin/dominio/personas', felipe))).statusCode).toBe(403)
    // Baja: se le saca el acceso igual de inmediato.
    await gov.removeMember('feeders_cartera', felipe)
    expect((await run(mockReq('GET', '/admin', felipe))).statusCode).toBe(403)
  })

  // La unión de las dos vías (#183): el default-steward-group NO se sustituye, y un dominio con
  // `group:` en stewards tampoco lo estorba — quien está en el grupo maestro sigue viendo todo.
  it('`group:` en stewards y VERGIS_DEFAULT_STEWARD_GROUPS conviven como unión', async () => {
    const gov = await SqliteGovernanceStore.open(null, {
      admins: [ADMIN],
      groups: [
        { id: 'ce', label: 'Centro de Excelencia', members: ['consultor@teams.ratio.cl'] },
        { id: 'feeders_cartera', label: 'Feeders Cartera', members: ['felipe@gh.cl'] },
      ],
    })
    const domains = parseDomainsConfig({
      domains: [
        { id: 'cartera', label: 'Cartera / Finanzas', stewards: ['group:feeders_cartera'] },
        { id: 'personas', label: 'Personas', stewards: ['rrhh@gh.cl'] },
      ],
    })
    const a = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: gov,
      groupStore: gov,
      domains,
      domainStewardGroups: ['ce'],
      intakeSlots: SLOTS,
      intake: { put: async () => {}, runNow: async () => {} },
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const run = async (req: IncomingMessage) => { const res = mockRes(); await a.tryHandle(req, res as unknown as ServerResponse); return res }
    // El grupo maestro sigue abriendo TODOS los dominios, como hoy.
    const ce = await run(mockReq('GET', '/admin', 'consultor@teams.ratio.cl'))
    expect(ce.statusCode).toBe(200)
    expect(ce.body).toContain('Cartera / Finanzas')
    expect(ce.body).toContain('Personas')
    // El del grupo por-dominio sigue viendo solo el suyo.
    const f = await run(mockReq('GET', '/admin', 'felipe@gh.cl'))
    expect(f.body).toContain('Cartera / Finanzas')
    expect(f.body).not.toContain('Personas')
  })
})
