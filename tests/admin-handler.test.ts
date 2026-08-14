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
    adminStore = await SqliteAdminStore.open(null, ['admin@ua.test'])
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
    const { handled } = await go(mockReq('GET', '/pi-01', 'admin@ua.test'))
    expect(handled).toBe(false)
  })

  it('no-admin → 403 + auditoría de acceso denegado', async () => {
    const { res } = await go(mockReq('GET', '/admin', 'intruso@x.com'))
    expect(res.statusCode).toBe(403)
    expect(audit.find((e) => e.type === 'admin-access-denied')?.user).toBe('intruso@x.com')
  })

  it('admin ve el landing con la entidad + avatar con Configuración', async () => {
    const { res } = await go(mockReq('GET', '/admin', 'admin@ua.test'))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Empresas Relacionadas')
    expect(res.body).toContain('Configuración') // plataforma vive ahora en el menú de avatar
    // Usuarios y Roles vive en la sección de Configuración (Plataforma), no en el home
    const plat = await go(mockReq('GET', '/admin/plataforma', 'admin@ua.test'))
    expect(plat.res.body).toContain('Usuarios y Roles')
  })

  it('insert válido crea fila y audita; CSRF inválido la rechaza', async () => {
    // token desde la página de la entidad (round-trip real)
    const page = await go(mockReq('GET', '/admin/e/empresas_relacionadas', 'admin@ua.test'))
    const token = tokenFrom(page.res.body)

    // CSRF malo → 403, sin escritura
    const bad = await go(mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'admin@ua.test', `_csrf=NOPE&codigo_socio=1&nombre=X`))
    expect(bad.res.statusCode).toBe(403)
    expect(await mdStore.list(entities[0])).toHaveLength(0)

    // CSRF bueno → 303 redirect + fila + auditoría
    const ok = await go(
      mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'admin@ua.test', `_csrf=${token}&codigo_socio=76717733&nombre=${encodeURIComponent('Cliente Hogar y Jardín')}&activo=1`),
    )
    expect(ok.res.statusCode).toBe(303)
    const rows = await mdStore.list(entities[0])
    expect(rows).toEqual([{ codigo_socio: '76717733', nombre: 'Cliente Hogar y Jardín', activo: true }])
    expect(audit.find((e) => e.type === 'master-data-write' && e.op === 'insert')?.pk).toBe('76717733')
  })

  it('update y delete con auditoría', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/e/empresas_relacionadas', 'admin@ua.test'))).res.body)
    await go(mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'admin@ua.test', `_csrf=${token}&codigo_socio=99&nombre=Antes&activo=1`))
    await go(mockReq('POST', '/admin/e/empresas_relacionadas/update', 'admin@ua.test', `_csrf=${token}&codigo_socio=99&nombre=Despues&activo=0`))
    expect((await mdStore.list(entities[0]))[0]).toEqual({ codigo_socio: '99', nombre: 'Despues', activo: false })
    await go(mockReq('POST', '/admin/e/empresas_relacionadas/delete', 'admin@ua.test', `_csrf=${token}&codigo_socio=99`))
    expect(await mdStore.list(entities[0])).toHaveLength(0)
    expect(audit.filter((e) => e.type === 'master-data-write').map((e) => e.op)).toEqual(['insert', 'update', 'delete'])
  })

  it('insert obligatorio faltante → 400 con error de validación, sin escritura', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/e/empresas_relacionadas', 'admin@ua.test'))).res.body)
    const r = await go(mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'admin@ua.test', `_csrf=${token}&codigo_socio=5&nombre=`))
    expect(r.res.statusCode).toBe(400)
    expect(r.res.body).toContain('obligatorio')
    expect(await mdStore.list(entities[0])).toHaveLength(0)
  })

  it('insert con PK duplicada → 409 (conflicto)', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/e/empresas_relacionadas', 'admin@ua.test'))).res.body)
    await go(mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'admin@ua.test', `_csrf=${token}&codigo_socio=1&nombre=A`))
    const dup = await go(mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'admin@ua.test', `_csrf=${token}&codigo_socio=1&nombre=B`))
    expect(dup.res.statusCode).toBe(409)
  })

  it('Usuarios y Roles: alta y baja auditan; la baja de la semilla pasa (#182) y el último admin → 409', async () => {
    const token = tokenFrom((await go(mockReq('GET', '/admin/roles', 'admin@ua.test'))).res.body)
    await go(mockReq('POST', '/admin/roles/add', 'admin@ua.test', `_csrf=${token}&email=especificador@consultora.test`))
    expect(await adminStore.isAdmin('especificador@consultora.test')).toBe(true)
    expect(audit.find((e) => e.type === 'admin-roles-write' && e.op === 'add')?.target).toBe('especificador@consultora.test')
    // Baja de la SEMILLA por la ruta in-app: ya no 409, y queda auditada con su actor.
    const rm = await go(mockReq('POST', '/admin/roles/remove', 'admin@ua.test', `_csrf=${token}&email=admin@ua.test`))
    expect(rm.res.statusCode).toBe(303)
    expect(await adminStore.isAdmin('admin@ua.test')).toBe(false)
    const rmEvent = audit.find((e) => e.type === 'admin-roles-write' && e.op === 'remove')
    expect(rmEvent).toMatchObject({ target: 'admin@ua.test', by: 'admin@ua.test' })
    // el especificador queda como único admin: quitarlo sí es lockout real.
    const last = await go(mockReq('POST', '/admin/roles/remove', 'especificador@consultora.test', `_csrf=${tokenFrom((await go(mockReq('GET', '/admin/roles', 'especificador@consultora.test'))).res.body)}&email=especificador@consultora.test`))
    expect(last.res.statusCode).toBe(409)
  })

  it('Usuarios y Roles: la fila semilla ofrece el botón de baja y advierte el drift del env (#182)', async () => {
    const body = (await go(mockReq('GET', '/admin/roles', 'admin@ua.test'))).res.body
    expect(body).toContain('VERGIS_ADMIN_SEED') // la confirmación nombra el env que queda diciendo otra cosa
    expect(body.match(/action="\/admin\/roles\/remove"/g) ?? []).toHaveLength(1) // la única fila (semilla) trae su form
  })
})
