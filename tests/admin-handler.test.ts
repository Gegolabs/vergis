import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminHandler } from '../server/admin'
import {
  parseMasterDataConfig,
  SqliteMasterDataStore,
  SqliteAdminStore,
  type MasterDataEntity,
} from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'

const YAML = {
  entities: [
    {
      id: 'empresas_relacionadas',
      label: 'Empresas Relacionadas',
      columns: [
        { name: 'codigo_socio', label: 'RUT', type: 'string', pk: true },
        { name: 'nombre', label: 'Nombre', type: 'string', required: true },
        { name: 'activo', label: 'Activo', type: 'bool' },
      ],
    },
  ],
}
const SECRET = 'test-secret'

function mockReq(method: string, url: string, user: string, body = ''): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user }
  return r
}
interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  ended: boolean
  writeHead(code: number, h?: Record<string, string>): MockRes
  end(chunk?: string): void
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    writeHead(code, h) {
      this.statusCode = code
      Object.assign(this.headers, h ?? {})
      return this
    },
    end(chunk) {
      if (chunk) this.body += chunk
      this.ended = true
    },
  }
}

describe('admin handler · gobierno de escritura', () => {
  let entities: MasterDataEntity[]
  let mdStore: SqliteMasterDataStore
  let adminStore: SqliteAdminStore
  let audit: LogEventInput[]
  let admin: AdminHandler

  beforeEach(async () => {
    entities = parseMasterDataConfig(YAML)
    mdStore = await SqliteMasterDataStore.open(null, entities)
    adminStore = await SqliteAdminStore.open(null, ['cesar@ultrabase.com'])
    audit = []
    admin = createAdmin({
      entities,
      mdStore,
      adminStore,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: (e) => audit.push(e),
      secret: SECRET,
    })
  })

  const go = async (req: IncomingMessage) => {
    const res = mockRes()
    const handled = await admin.tryHandle(req, res as unknown as ServerResponse)
    return { handled, res }
  }
  const tokenFrom = (html: string): string => html.match(/name="_csrf" value="([0-9a-f]+)"/)![1]

  it('ruta ajena a /admin no se maneja', async () => {
    const { handled } = await go(mockReq('GET', '/pi-01', 'cesar@ultrabase.com'))
    expect(handled).toBe(false)
  })

  it('no-admin → 403 + auditoría de acceso denegado', async () => {
    const { res } = await go(mockReq('GET', '/admin', 'intruso@x.com'))
    expect(res.statusCode).toBe(403)
    expect(audit.find((e) => e.type === 'admin-access-denied')?.user).toBe('intruso@x.com')
  })

  it('admin ve el landing con la entidad + avatar con Configuración', async () => {
    const { res } = await go(mockReq('GET', '/admin', 'cesar@ultrabase.com'))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Empresas Relacionadas')
    expect(res.body).toContain('Configuración') // plataforma vive ahora en el menú de avatar
    // Usuarios y Roles vive en la sección de Configuración (Plataforma), no en el home
    const plat = await go(mockReq('GET', '/admin/plataforma', 'cesar@ultrabase.com'))
    expect(plat.res.body).toContain('Usuarios y Roles')
  })

  it('insert válido crea fila y audita; CSRF inválido la rechaza', async () => {
    // token desde la página de la entidad (round-trip real)
    const page = await go(mockReq('GET', '/admin/e/empresas_relacionadas', 'cesar@ultrabase.com'))
    const token = tokenFrom(page.res.body)

    // CSRF malo → 403, sin escritura
    const bad = await go(mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'cesar@ultrabase.com', `_csrf=NOPE&codigo_socio=1&nombre=X`))
    expect(bad.res.statusCode).toBe(403)
    expect(await mdStore.list(entities[0])).toHaveLength(0)

    // CSRF bueno → 303 redirect + fila + auditoría
    const ok = await go(
      mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'cesar@ultrabase.com', `_csrf=${token}&codigo_socio=76717733&nombre=${encodeURIComponent('Hijuelas Home & Garden')}&activo=1`),
    )
    expect(ok.res.statusCode).toBe(303)
    const rows = await mdStore.list(entities[0])
    expect(rows).toEqual([{ codigo_socio: '76717733', nombre: 'Hijuelas Home & Garden', activo: true }])
    expect(audit.find((e) => e.type === 'master-data-write' && e.op === 'insert')?.pk).toBe('76717733')
  })

  it('update y delete con auditoría', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/e/empresas_relacionadas', 'cesar@ultrabase.com'))).res.body)
    await go(mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'cesar@ultrabase.com', `_csrf=${token}&codigo_socio=99&nombre=Antes&activo=1`))
    await go(mockReq('POST', '/admin/e/empresas_relacionadas/update', 'cesar@ultrabase.com', `_csrf=${token}&codigo_socio=99&nombre=Despues&activo=0`))
    expect((await mdStore.list(entities[0]))[0]).toEqual({ codigo_socio: '99', nombre: 'Despues', activo: false })
    await go(mockReq('POST', '/admin/e/empresas_relacionadas/delete', 'cesar@ultrabase.com', `_csrf=${token}&codigo_socio=99`))
    expect(await mdStore.list(entities[0])).toHaveLength(0)
    expect(audit.filter((e) => e.type === 'master-data-write').map((e) => e.op)).toEqual(['insert', 'update', 'delete'])
  })

  it('insert obligatorio faltante → 400 con error de validación, sin escritura', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/e/empresas_relacionadas', 'cesar@ultrabase.com'))).res.body)
    const r = await go(mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'cesar@ultrabase.com', `_csrf=${token}&codigo_socio=5&nombre=`))
    expect(r.res.statusCode).toBe(400)
    expect(r.res.body).toContain('obligatorio')
    expect(await mdStore.list(entities[0])).toHaveLength(0)
  })

  it('insert con PK duplicada → 409 (conflicto)', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/e/empresas_relacionadas', 'cesar@ultrabase.com'))).res.body)
    await go(mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'cesar@ultrabase.com', `_csrf=${token}&codigo_socio=1&nombre=A`))
    const dup = await go(mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'cesar@ultrabase.com', `_csrf=${token}&codigo_socio=1&nombre=B`))
    expect(dup.res.statusCode).toBe(409)
  })

  it('Usuarios y Roles: alta y baja auditan; la baja de la semilla pasa (#182) y el último admin → 409', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/roles', 'cesar@ultrabase.com'))).res.body)
    await go(mockReq('POST', '/admin/roles/add', 'cesar@ultrabase.com', `_csrf=${token}&email=claudio@ratio.cl`))
    expect(await adminStore.isAdmin('claudio@ratio.cl')).toBe(true)
    expect(audit.find((e) => e.type === 'admin-roles-write' && e.op === 'add')?.target).toBe('claudio@ratio.cl')
    // Baja de la SEMILLA por la ruta in-app: ya no 409, y queda auditada con su actor.
    const rm = await go(mockReq('POST', '/admin/roles/remove', 'cesar@ultrabase.com', `_csrf=${token}&email=cesar@ultrabase.com`))
    expect(rm.res.statusCode).toBe(303)
    expect(await adminStore.isAdmin('cesar@ultrabase.com')).toBe(false)
    const rmEvent = audit.find((e) => e.type === 'admin-roles-write' && e.op === 'remove')
    expect(rmEvent).toMatchObject({ target: 'cesar@ultrabase.com', by: 'cesar@ultrabase.com' })
    // Claudio queda como único admin: quitarlo sí es lockout real.
    const last = await go(mockReq('POST', '/admin/roles/remove', 'claudio@ratio.cl', `_csrf=${tokenFrom((await go(mockReq('GET', '/admin/roles', 'claudio@ratio.cl'))).res.body)}&email=claudio@ratio.cl`))
    expect(last.res.statusCode).toBe(409)
  })

  it('Usuarios y Roles: la fila semilla ofrece el botón de baja y advierte el drift del env (#182)', async () => {
    const body = (await go(mockReq('GET', '/admin/roles', 'cesar@ultrabase.com'))).res.body
    expect(body).toContain('VERGIS_ADMIN_SEED') // la confirmación nombra el env que queda diciendo otra cosa
    expect(body.match(/action="\/admin\/roles\/remove"/g) ?? []).toHaveLength(1) // la única fila (semilla) trae su form
  })
})
