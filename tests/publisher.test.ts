import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin } from '../server/admin'
import {
  parseMasterDataConfig,
  replicaTable,
  SqliteMasterDataStore,
  SqliteGovernanceStore,
  type MasterDataEntity,
} from '@vergis/capabilities'

const YAML = {
  entities: [
    {
      id: 'empresas_relacionadas',
      label: 'Empresas Relacionadas',
      database_ref: 'mira',
      table: 'dbo.md_empresas_relacionadas',
      targets: [{ database_ref: 'cartera' }, { database_ref: 'otro' }],
      columns: [
        { name: 'codigo_socio', label: 'RUT', type: 'string', pk: true },
        { name: 'nombre', label: 'Nombre', type: 'string', required: true },
        { name: 'activo', label: 'Activo', type: 'bool' },
      ],
    },
  ],
}

describe('master-data · contrato de publicación', () => {
  it('parsea targets', () => {
    const [e] = parseMasterDataConfig(YAML)
    expect(e.targets).toEqual([{ database_ref: 'cartera' }, { database_ref: 'otro' }])
  })
  it('target sin database_ref → error', () => {
    expect(() => parseMasterDataConfig({ entities: [{ id: 'x', columns: [{ name: 'a', pk: true }], targets: [{}] }] })).toThrow(/target sin database_ref/)
  })
  it('replicaTable usa la convención __replica', () => {
    const [e] = parseMasterDataConfig(YAML)
    expect(replicaTable(e)).toBe('dbo.md_empresas_relacionadas__replica')
  })
})

// ── publish-on-write: el handler dispara onWrite tras una edición de data maestra ──
function mockReq(method: string, url: string, user: string, body = ''): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user }
  return r
}
function mockRes() {
  return { statusCode: 0, headers: {} as Record<string, string>, body: '', writeHead(c: number, h?: Record<string, string>) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(ch?: string) { if (ch) this.body += ch } }
}

describe('publish-on-write', () => {
  it('tras un insert válido, el handler invoca onWrite con la entidad', async () => {
    const entities = parseMasterDataConfig(YAML)
    const mdStore = await SqliteMasterDataStore.open(null, entities)
    const gov = await SqliteGovernanceStore.open(null, { admins: ['admin@x.com'] })
    const published: string[] = []
    const admin = createAdmin({
      entities,
      mdStore,
      adminStore: gov,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: 'pw',
      onWrite: async (e: MasterDataEntity) => {
        published.push(e.id)
      },
    })
    const go = async (req: IncomingMessage) => {
      const res = mockRes()
      await admin.tryHandle(req, res as unknown as ServerResponse)
      return res
    }
    const token = (await go(mockReq('GET', '/admin/e/empresas_relacionadas', 'admin@x.com'))).body.match(/name="_csrf" value="([0-9a-f]+)"/)![1]
    const r = await go(mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'admin@x.com', `_csrf=${token}&codigo_socio=99&nombre=X&activo=1`))
    expect(r.statusCode).toBe(303)
    expect(published).toEqual(['empresas_relacionadas']) // publish-on-write disparado
    await mdStore.close()
    await gov.close()
  })
})
