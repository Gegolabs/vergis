// LA SUPERFICIE DE ADMINISTRACIÓN del Datadoc (CAP-197).
//
// Lo que se mide: que la sección NO exista sin la dep (una instancia que no encendió la capacidad no
// gana una pantalla), que sea de PLATAFORMA (no de dominio), que toda escritura exija CSRF, y que el
// disparo llame al generador con el alcance que el formulario dice — ni «all» cuando se pidió una
// conexión, ni al revés.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { createAdmin, type AdminHandler, type DatadocOps } from '../server/admin'
import { parseMasterDataConfig, SqliteAdminStore, SqliteMasterDataStore, type MasterDataEntity } from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'
import { csrfFactory } from '../server/ui'

const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const NADIE = 'nadie@x.cl'
const YAML = { entities: [{ id: 'e', label: 'E', columns: [{ name: 'pk', label: 'PK', type: 'string', pk: true }] }] }

function mockReq(method: string, url: string, user: string, body = ''): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user }
  return r
}
function mockRes(): { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): unknown; end(c?: string): void } {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, h) {
      this.statusCode = code
      Object.assign(this.headers, h ?? {})
      return this
    },
    end(chunk) {
      if (chunk) this.body += chunk
    },
  }
}

type EstadoDatadocFalso = Awaited<ReturnType<DatadocOps['estado']>>

const ESTADO_BASE: EstadoDatadocFalso = {
  build: { dir: 'build-2026-09-21T12-00-00-000Z', generadoEn: '2026-09-21T12:00:00.000Z' },
  conexiones: [
    { ref: 'finanzas', database: 'wh_finanzas', server: 'ep', ok: true, medidoEn: '2026-09-21T12:00:00.000Z', ms: 120, objetos: 42 },
    { ref: 'ventas', database: null, server: null, ok: false, medidoEn: null, ms: null, objetos: null, error: 'ETIMEDOUT' },
  ],
  rancio: null,
  enCurso: false,
  schedule: 'daily@06:00',
  timezone: 'UTC',
  conteos: 'abiertas',
  avisos: ['el escritor «w» declara la conexión «fantasma», desconocida para el nodo'],
}

describe('/admin/datadoc', () => {
  let entities: MasterDataEntity[]
  let mdStore: SqliteMasterDataStore
  let adminStore: SqliteAdminStore
  let audit: LogEventInput[]
  let llamadas: { generar: (string | undefined)[]; ajustes: unknown[] }
  let estado: EstadoDatadocFalso
  let datadoc: DatadocOps
  let token: string

  const montar = (con: DatadocOps | undefined): AdminHandler =>
    createAdmin({
      entities,
      mdStore,
      adminStore,
      datadoc: con,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: (e) => audit.push(e),
      secret: SECRET,
    })

  beforeEach(async () => {
    entities = parseMasterDataConfig(YAML)
    mdStore = await SqliteMasterDataStore.open(null, entities)
    adminStore = await SqliteAdminStore.open(null, [ADMIN])
    audit = []
    llamadas = { generar: [], ajustes: [] }
    estado = { ...ESTADO_BASE }
    datadoc = {
      estado: async () => estado,
      generar: async (alcance) => {
        llamadas.generar.push(alcance)
        return { ok: true, build: 'build-x', fallidas: [], ms: 10 }
      },
      ajustes: async (input) => {
        llamadas.ajustes.push(input)
        return { schedule: 'off', timezone: 'UTC', conteos: 'abiertas' }
      },
    }
    token = csrfFactory(SECRET)(ADMIN)
  })

  it('SIN la dep la ruta no existe: es la superficie de siempre', async () => {
    const admin = montar(undefined)
    const res = mockRes()
    // REFUTARÍA: cualquier cosa distinta del 404 en una instancia que no encendió la capacidad.
    const atendido = await admin.tryHandle(mockReq('GET', '/admin/datadoc', ADMIN), res as never)
    expect(atendido && res.statusCode === 200).toBe(false)
  })

  it('el GET renderiza el build servido y el sello POR CONEXIÓN, con su motivo de fallo', async () => {
    const admin = montar(datadoc)
    const res = mockRes()
    await admin.tryHandle(mockReq('GET', '/admin/datadoc', ADMIN), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('build-2026-09-21T12-00-00-000Z')
    expect(res.body).toContain('finanzas')
    expect(res.body).toContain('ETIMEDOUT')
    expect(res.body).toContain('daily@06:00')
    // Los avisos de la corrida son visibles, no un log que nadie lee.
    expect(res.body).toContain('desconocida para el nodo')
  })

  it('sin build todavía, lo dice en vez de mostrar un hueco', async () => {
    estado = { ...ESTADO_BASE, build: null }
    const res = mockRes()
    await montar(datadoc).tryHandle(mockReq('GET', '/admin/datadoc', ADMIN), res as never)
    expect(res.body).toContain('Todavía no se ha generado')
  })

  it('un catálogo rancio se declara en la pantalla', async () => {
    estado = { ...ESTADO_BASE, rancio: { razon: 'watch:policies', desde: '2026-09-21T13:00:00.000Z' } }
    const res = mockRes()
    await montar(datadoc).tryHandle(mockReq('GET', '/admin/datadoc', ADMIN), res as never)
    expect(res.body).toContain('Catálogo marcado rancio')
    expect(res.body).toContain('watch:policies')
  })

  it('es gestión de PLATAFORMA: quien no es admin no entra', async () => {
    const res = mockRes()
    await montar(datadoc).tryHandle(mockReq('GET', '/admin/datadoc', NADIE), res as never)
    expect(res.statusCode).toBe(403)
  })

  it('⚠ el POST sin CSRF válido ⇒ 403, y `generar` NO se llama', async () => {
    const res = mockRes()
    await montar(datadoc).tryHandle(mockReq('POST', '/admin/datadoc/generar', ADMIN, '_csrf=falso'), res as never)
    expect(res.statusCode).toBe(403)
    expect(llamadas.generar).toEqual([])
  })

  it('el POST válido dispara con alcance `all` y redirige', async () => {
    const res = mockRes()
    await montar(datadoc).tryHandle(mockReq('POST', '/admin/datadoc/generar', ADMIN, `_csrf=${encodeURIComponent(token)}`), res as never)
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toMatch(/^\/admin\/datadoc\?msg=/)
    expect(llamadas.generar).toEqual(['all'])
    expect(audit.some((e) => (e as Record<string, unknown>)['type'] === 'datadoc-generate' && (e as Record<string, unknown>)['scope'] === 'all')).toBe(true)
  })

  it('con `conexion=<ref>` dispara SOLO esa — ni «all» por descuido', async () => {
    const res = mockRes()
    await montar(datadoc).tryHandle(
      mockReq('POST', '/admin/datadoc/generar', ADMIN, `_csrf=${encodeURIComponent(token)}&conexion=finanzas`),
      res as never,
    )
    expect(llamadas.generar).toEqual(['finanzas'])
    expect(audit.some((e) => (e as Record<string, unknown>)['scope'] === 'finanzas')).toBe(true)
  })

  it('si ya hay una en curso, lo dice y no promete una corrida nueva', async () => {
    estado = { ...ESTADO_BASE, enCurso: true }
    const res = mockRes()
    await montar(datadoc).tryHandle(mockReq('POST', '/admin/datadoc/generar', ADMIN, `_csrf=${encodeURIComponent(token)}`), res as never)
    expect(decodeURIComponent(res.headers['location'])).toMatch(/Ya había una generación en curso/)
  })

  it('los ajustes exigen CSRF y llegan al generador tal como se escribieron', async () => {
    const sinToken = mockRes()
    await montar(datadoc).tryHandle(mockReq('POST', '/admin/datadoc/ajustes', ADMIN, 'schedule=daily@06:00'), sinToken as never)
    expect(sinToken.statusCode).toBe(403)
    expect(llamadas.ajustes).toEqual([])

    const res = mockRes()
    await montar(datadoc).tryHandle(
      mockReq('POST', '/admin/datadoc/ajustes', ADMIN, `_csrf=${encodeURIComponent(token)}&schedule=daily%4006%3A00&conteos=off&timezone=America%2FSantiago`),
      res as never,
    )
    expect(res.statusCode).toBe(303)
    expect(llamadas.ajustes).toEqual([{ schedule: 'daily@06:00', timezone: 'America/Santiago', conteos: 'off' }])
  })

  it('la entrada del menú lateral aparece SOLO con la dep', async () => {
    const con = mockRes()
    await montar(datadoc).tryHandle(mockReq('GET', '/admin/plataforma', ADMIN), con as never)
    expect(con.body).toContain('/admin/datadoc')
    const sin = mockRes()
    await montar(undefined).tryHandle(mockReq('GET', '/admin/plataforma', ADMIN), sin as never)
    expect(sin.body).not.toContain('/admin/datadoc')
  })
})
