import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin } from '../server/admin'
import { masterDataPublishing } from '../server/master-data-publishing'
import {
  parseMasterDataConfig,
  SqliteMasterDataStore,
  SqliteGovernanceStore,
  type MasterDataEntity,
  type MasterDataRow,
  type Publisher,
  type PublisherTarget,
  type PublishTargetResult,
  type ReplicaCountResult,
} from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'

/**
 * #262 — «la publicación falla en silencio». Cada caso de acá FALLA en `main`: allá `onWrite` era
 * `Promise<void>`, el bucle abortaba en el primer target y el redirect del fallo era idéntico al del
 * éxito. Se mide contra un `Publisher` de arnés, sin warehouse.
 */

const YAML = {
  entities: [
    {
      id: 'empresas_relacionadas',
      label: 'Empresas Relacionadas',
      database_ref: 'mira',
      table: 'dbo.md_empresas_relacionadas',
      targets: [{ database_ref: 'cartera' }, { database_ref: 'finanzas' }],
      columns: [
        { name: 'codigo_socio', label: 'RUT', type: 'string', pk: true },
        { name: 'nombre', label: 'Nombre', type: 'string', required: true },
      ],
    },
  ],
}

/** Publicador de arnés: falla en los refs que se le nombren y anota a quién SÍ alcanzó a publicar. */
function fakePublisher(opts: { failPublish?: Record<string, string>; counts?: Record<string, number>; failCount?: Record<string, string> } = {}) {
  const publicados: string[] = []
  const p: Publisher = {
    async publish(_e: MasterDataEntity, _rows: MasterDataRow[], t: PublisherTarget) {
      const err = opts.failPublish?.[t.database_ref]
      if (err) throw new Error(err)
      publicados.push(t.database_ref)
    },
    async count(_e: MasterDataEntity, t: PublisherTarget) {
      const err = opts.failCount?.[t.database_ref]
      if (err) throw new Error(err)
      const n = opts.counts?.[t.database_ref]
      if (n == null) throw new Error(`sin conteo para ${t.database_ref}`)
      return n
    },
    async close() {},
  }
  return { publisher: p, publicados }
}

function mockReq(method: string, url: string, user: string, body = ''): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user }
  return r
}
function mockRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(c: number, h?: Record<string, string>) {
      this.statusCode = c
      Object.assign(this.headers, h ?? {})
      return this
    },
    end(ch?: string) {
      if (ch) this.body += ch
    },
  }
}

/** Arnés de Administración: devuelve `go` (un request) y el log de auditoría capturado. */
async function harness(over: {
  onWrite?: (e: MasterDataEntity) => Promise<PublishTargetResult[]>
  replicaStatus?: (e: MasterDataEntity) => Promise<ReplicaCountResult[]>
}) {
  const entities = parseMasterDataConfig(YAML)
  const mdStore = await SqliteMasterDataStore.open(null, entities)
  const gov = await SqliteGovernanceStore.open(null, { admins: ['admin@x.com'] })
  const audit: LogEventInput[] = []
  const admin = createAdmin({
    entities,
    mdStore,
    adminStore: gov,
    identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
    audit: (e) => audit.push(e),
    secret: 'pw',
    ...over,
  })
  const go = async (req: IncomingMessage) => {
    const res = mockRes()
    await admin.tryHandle(req, res as unknown as ServerResponse)
    return res
  }
  const token = (await go(mockReq('GET', '/admin/e/empresas_relacionadas', 'admin@x.com'))).body.match(/name="_csrf" value="([0-9a-f]+)"/)![1]
  return { go, token, audit, entities, close: async () => { await mdStore.close(); await gov.close() } }
}

describe('#262 · un target que falla no impide a los siguientes', () => {
  it('publica el segundo target aunque el primero lance, y reporta ambos', async () => {
    const entities = parseMasterDataConfig(YAML)
    const mdStore = await SqliteMasterDataStore.open(null, entities)
    const { publisher, publicados } = fakePublisher({ failPublish: { cartera: "publish: database_ref 'cartera' no configurado." } })
    const { onWrite } = masterDataPublishing(publisher, mdStore)

    const res = await onWrite(entities[0])

    expect(publicados).toEqual(['finanzas']) // el segundo SÍ se publicó
    expect(res).toEqual([
      { database_ref: 'cartera', ok: false, error: "publish: database_ref 'cartera' no configurado." },
      { database_ref: 'finanzas', ok: true },
    ])
    await mdStore.close()
  })

  it('una entidad sin targets no publica nada y devuelve lista vacía', async () => {
    const [e] = parseMasterDataConfig({ entities: [{ id: 'sin_targets', columns: [{ name: 'a', pk: true }] }] })
    const { publisher, publicados } = fakePublisher()
    const mdStore = await SqliteMasterDataStore.open(null, [e])
    expect(await masterDataPublishing(publisher, mdStore).onWrite(e)).toEqual([])
    expect(publicados).toEqual([])
    await mdStore.close()
  })
})

describe('#262 · el resultado de la publicación llega a la pantalla', () => {
  it('tras un fallo, el HTML de la entidad trae la causa ESCAPADA', async () => {
    const h = await harness({
      onWrite: async () => [
        { database_ref: 'cartera', ok: false, error: 'boom <b>peligro</b> & cía' },
        { database_ref: 'finanzas', ok: true },
      ],
    })
    const post = await h.go(
      mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'admin@x.com', `_csrf=${h.token}&codigo_socio=99&nombre=X`),
    )
    expect(post.statusCode).toBe(303)
    expect(post.headers['location']).toBe('/admin/e/empresas_relacionadas?pub=err')

    const page = await h.go(mockReq('GET', post.headers['location'], 'admin@x.com'))
    expect(page.body).toContain('&lt;b&gt;peligro&lt;/b&gt;')
    expect(page.body).not.toContain('boom <b>peligro</b>')
    expect(page.body).toContain('cartera')
    expect(page.body).toMatch(/falló/)

    // El audit log SIGUE registrándose, con la causa y el detalle por target.
    const ev = h.audit.filter((e) => e.type === 'master-data-publish')
    expect(ev).toHaveLength(1)
    expect(ev[0].ok).toBe(false)
    expect(String(ev[0].error)).toContain('cartera: boom')
    expect(ev[0].targets).toHaveLength(2)

    // El flash se CONSUME: una segunda visita ya no repite el aviso.
    const otra = await h.go(mockReq('GET', '/admin/e/empresas_relacionadas?pub=err', 'admin@x.com'))
    expect(otra.body).not.toContain('&lt;b&gt;peligro&lt;/b&gt;')
    await h.close()
  })

  it('tras un éxito, el redirect dice ok y la pantalla lo declara', async () => {
    const h = await harness({ onWrite: async () => [{ database_ref: 'cartera', ok: true }] })
    const post = await h.go(
      mockReq('POST', '/admin/e/empresas_relacionadas/insert', 'admin@x.com', `_csrf=${h.token}&codigo_socio=1&nombre=A`),
    )
    expect(post.headers['location']).toBe('/admin/e/empresas_relacionadas?pub=ok')
    const page = await h.go(mockReq('GET', post.headers['location'], 'admin@x.com'))
    expect(page.body).toContain('Publicado en 1 destino')
    expect(h.audit.find((e) => e.type === 'master-data-publish')!.ok).toBe(true)
    await h.close()
  })
})

describe('#262 · el desfase es observable, y lo que no se pudo leer se dice', () => {
  it('conteo legible: muestra autoría y réplica por target', async () => {
    const h = await harness({
      onWrite: async () => [],
      replicaStatus: async () => [{ database_ref: 'cartera', count: 7 }],
    })
    const page = await h.go(mockReq('GET', '/admin/e/empresas_relacionadas', 'admin@x.com'))
    expect(page.body).toContain('réplica 7')
    expect(page.body).toContain('autoría 0')
    await h.close()
  })

  it('conteo NO legible ⇒ «no se pudo leer» con su causa, y jamás «réplica 0»', async () => {
    const { publisher } = fakePublisher({ failCount: { cartera: 'login failed', finanzas: 'login failed' } })
    const entities = parseMasterDataConfig(YAML)
    const mdStore = await SqliteMasterDataStore.open(null, entities)
    const { replicaStatus } = masterDataPublishing(publisher, mdStore)
    expect(await replicaStatus(entities[0])).toEqual([
      { database_ref: 'cartera', error: 'login failed' },
      { database_ref: 'finanzas', error: 'login failed' },
    ])
    await mdStore.close()

    const h = await harness({ onWrite: async () => [], replicaStatus })
    const page = await h.go(mockReq('GET', '/admin/e/empresas_relacionadas', 'admin@x.com'))
    expect(page.body).toContain('no se pudo leer')
    expect(page.body).toContain('login failed')
    expect(page.body).not.toContain('réplica 0')
    await h.close()
  })

  it('sin dep de conteo, la pantalla no fabrica la línea de réplicas', async () => {
    const h = await harness({ onWrite: async () => [] })
    const page = await h.go(mockReq('GET', '/admin/e/empresas_relacionadas', 'admin@x.com'))
    expect(page.body).not.toContain('réplica')
    await h.close()
  })
})

describe('#262 · republicación manual', () => {
  it('sin CSRF válido ⇒ rechazado y NO publica', async () => {
    let veces = 0
    const h = await harness({ onWrite: async () => { veces++; return [{ database_ref: 'cartera', ok: true }] } })
    const r = await h.go(mockReq('POST', '/admin/e/empresas_relacionadas/republicar', 'admin@x.com', '_csrf=nope'))
    expect(r.statusCode).toBe(403)
    expect(veces).toBe(0)
    await h.close()
  })

  it('con CSRF ⇒ invoca onWrite UNA vez, audita manual:true y no escribe autoría', async () => {
    let veces = 0
    const h = await harness({ onWrite: async () => { veces++; return [{ database_ref: 'cartera', ok: true }] } })
    const r = await h.go(mockReq('POST', '/admin/e/empresas_relacionadas/republicar', 'admin@x.com', `_csrf=${h.token}`))
    expect(r.statusCode).toBe(303)
    expect(r.headers['location']).toBe('/admin/e/empresas_relacionadas?pub=ok')
    expect(veces).toBe(1)
    const ev = h.audit.filter((e) => e.type === 'master-data-publish')
    expect(ev).toHaveLength(1)
    expect(ev[0].manual).toBe(true)
    expect(ev[0].by).toBe('admin@x.com')
    // Republicar NO es una escritura de autoría: no hay evento `master-data-write`.
    expect(h.audit.some((e) => e.type === 'master-data-write')).toBe(false)
    await h.close()
  })

  it('el botón de republicar se ofrece donde hay targets y publicador', async () => {
    const h = await harness({ onWrite: async () => [] })
    const page = await h.go(mockReq('GET', '/admin/e/empresas_relacionadas', 'admin@x.com'))
    expect(page.body).toContain('/admin/e/empresas_relacionadas/republicar')
    await h.close()
  })
})
