/**
 * I5 · el handler: scope, CSRF, concurrencia, ruteo y el ACTOR del log.
 *
 * El caso que más importa es el último: el actor de la auditoría sale del GATE, no del body. Un log
 * de auditoría en el que el auditado elige su propio nombre no es una auditoría.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createConsola, type ConsolaHandler, type ConsolaLog, type HistorialEntrada } from '../server/consola'
import { csrfFactory } from '../server/ui'
import type { ConsolaConectorEstado } from '../server/engines/fabric'
import type { ConsolaResultado } from '@vergis/capabilities'

const SECRET = 'secreto-de-prueba'
const TOKEN = csrfFactory(SECRET)('ana@gh.cl')
const CFG = { enabled: true, scopeGroup: 'consola-sql', timeoutMs: 1000, maxRows: 5, maxConcurrentes: 1 }

function req(method: string, url: string, user: string, body = ''): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user }
  return r
}
interface MockRes {
  statusCode: number
  body: string
  writeHead(c: number, h?: Record<string, string>): MockRes
  end(chunk?: string): void
}
const res = (): MockRes => ({
  statusCode: 0,
  body: '',
  writeHead(c) {
    this.statusCode = c
    return this
  },
  end(chunk) {
    if (chunk) this.body += chunk
  },
})
const j = (r: MockRes): Record<string, unknown> => JSON.parse(r.body) as Record<string, unknown>

const OFRECIBLE: ConsolaConectorEstado = { ofrecible: true, verificadoEn: 'T', medido: {} }
const VACIO: ConsolaResultado = { recordsets: [], filas: 0, truncado: false, duracionMs: 1 }

describe('consola · handler', () => {
  let anotado: Record<string, unknown>[]
  let log: ConsolaLog
  let soltar: (() => void) | null
  let consola: ConsolaHandler
  let estado: Map<string, ConsolaConectorEstado>

  beforeEach(() => {
    anotado = []
    soltar = null
    estado = new Map([['fin', OFRECIBLE]])
    log = {
      inicio: (e) => anotado.push({ tipo: 'inicio', ...e }),
      fin: (e) => anotado.push({ tipo: 'fin', ...e }),
      historial: (): HistorialEntrada[] => [],
    }
    consola = createConsola({
      config: CFG,
      identityOf: (h) => ({ agent: 'x', user: String((h as Record<string, string>)['x-test-user'] ?? ''), claims: { groups: ['Finanzas'] } }),
      hasScope: async (email) => email !== 'nadie@gh.cl',
      isAdmin: async (email) => email === 'jefe@gh.cl',
      secret: SECRET,
      estado: () => estado,
      databaseDe: () => 'wh_fin',
      // Queda «en vuelo» hasta que el test la suelte: así se observan los 409/503 de concurrencia.
      ejecutar: () => new Promise<ConsolaResultado>((ok) => { soltar = () => ok(VACIO) }),
      esquema: async () => [
        { tabla: 'dbo.areas', columnas: [{ nombre: 'area', tipo: 'nvarchar' }] },
        { tabla: 'dbo._migrations', columnas: [{ nombre: 'id', tipo: 'int' }] },
      ],
      log,
    })
  })

  const ejecutar = (user: string, body: Record<string, unknown> = { _csrf: csrfFactory(SECRET)(user), ref: 'fin', sql: 'SELECT 1' }) => {
    const r = res()
    const p = consola.tryHandle(req('POST', '/consola/ejecutar', user, JSON.stringify(body)), r as unknown as ServerResponse)
    return { r, p }
  }

  it('sin scope: 403 en TODAS las rutas, y sin revelar si la capacidad está encendida', async () => {
    for (const [m, u] of [['GET', '/consola'], ['GET', '/consola/conectores'], ['GET', '/consola/fin/esquema'], ['POST', '/consola/ejecutar'], ['POST', '/consola/cancelar'], ['GET', '/consola/historial']] as const) {
      const r = res()
      await consola.tryHandle(req(m, u, 'nadie@gh.cl'), r as unknown as ServerResponse)
      expect(r.statusCode).toBe(403)
      expect(r.body).not.toContain('enabled')
      expect(r.body).not.toContain('wh_fin')
    }
  })

  /**
   * #342 · una tabla cubierta por `DENY SELECT` —no por política— no se ofrece en el árbol. El
   * principal de consola no puede leerla: listarla sería prometer lo que la ejecución va a rechazar.
   */
  it('el esquema NO lista las tablas excluidas por permiso, y SÍ las demás', async () => {
    estado.set('fin', { ofrecible: true, verificadoEn: 'T', medido: { tablasExcluidasPorPermiso: ['dbo._migrations'] } })
    const r = res()
    await consola.tryHandle(req('GET', '/consola/fin/esquema', 'ana@gh.cl'), r as unknown as ServerResponse)
    expect(r.statusCode).toBe(200)
    expect(j(r)['tablas']).toEqual([{ tabla: 'dbo.areas', columnas: [{ nombre: 'area', tipo: 'nvarchar' }] }])
  })

  it('CONTROL · sin exclusiones el esquema las lista TODAS (el filtro no es un borrado ciego)', async () => {
    const r = res()
    await consola.tryHandle(req('GET', '/consola/fin/esquema', 'ana@gh.cl'), r as unknown as ServerResponse)
    expect((j(r)['tablas'] as unknown[]).length).toBe(2)
  })

  it('una ruta ajena no se intercepta', async () => {
    const r = res()
    expect(await consola.tryHandle(req('GET', '/otra', 'ana@gh.cl'), r as unknown as ServerResponse)).toBe(false)
  })

  it('CSRF inválido ⇒ 403', async () => {
    const { r, p } = ejecutar('ana@gh.cl', { _csrf: 'x'.repeat(24), ref: 'fin', sql: 'SELECT 1' })
    await p
    expect(r.statusCode).toBe(403)
  })

  it('un ref NO ofrecible responde 404, indistinguible de uno inexistente', async () => {
    estado.set('otro', { ofrecible: false, motivo: 'sin sub-perfil `consola`', verificadoEn: 'T', medido: {} })
    const { r, p } = ejecutar('ana@gh.cl', { _csrf: TOKEN, ref: 'otro', sql: 'SELECT 1' })
    await p
    expect(r.statusCode).toBe(404)
    const r2 = res()
    await consola.tryHandle(req('GET', '/consola/otro/esquema', 'ana@gh.cl'), r2 as unknown as ServerResponse)
    expect(r2.statusCode).toBe(404)
    const r3 = res()
    await consola.tryHandle(req('GET', '/consola/inexistente/esquema', 'ana@gh.cl'), r3 as unknown as ServerResponse)
    expect(r3.statusCode).toBe(404)
    expect(r3.body).toBe(r2.body)
  })

  it('segunda ejecución de la MISMA identidad ⇒ 409, y la primera sigue viva', async () => {
    const uno = ejecutar('ana@gh.cl')
    await new Promise((ok) => setTimeout(ok, 5))
    const dos = ejecutar('ana@gh.cl')
    await dos.p
    expect(dos.r.statusCode).toBe(409)
    soltar!()
    await uno.p
    expect(uno.r.statusCode).toBe(200)
  })

  it('con maxConcurrentes=1, la segunda identidad ⇒ 503 · y entra cuando la primera termina', async () => {
    const uno = ejecutar('ana@gh.cl')
    await new Promise((ok) => setTimeout(ok, 5))
    const dos = ejecutar('beto@gh.cl')
    await dos.p
    expect(dos.r.statusCode).toBe(503)
    expect(String(j(dos.r)['error'])).not.toContain('ana@gh.cl') // sin decir de quién
    soltar!()
    await uno.p
    const tres = ejecutar('beto@gh.cl')
    await new Promise((ok) => setTimeout(ok, 5))
    soltar!()
    await tres.p
    expect(tres.r.statusCode).toBe(200)
  })

  it('cancelar aborta la consulta en vuelo de esa identidad', async () => {
    let abortada = false
    consola = createConsola({
      config: CFG,
      identityOf: (h) => ({ agent: 'x', user: String((h as Record<string, string>)['x-test-user'] ?? ''), claims: {} }),
      hasScope: async () => true,
      isAdmin: async () => false,
      secret: SECRET,
      estado: () => estado,
      databaseDe: () => 'wh_fin',
      ejecutar: (_i, _id, signal) =>
        new Promise<ConsolaResultado>((_ok, no) => {
          signal.addEventListener('abort', () => {
            abortada = true
            no(Object.assign(new Error('Consulta cancelada.'), { motivo: 'consola/cancelado' }))
          })
        }),
      esquema: async () => [],
      log,
    })
    const uno = ejecutar('ana@gh.cl')
    await new Promise((ok) => setTimeout(ok, 5))
    const r = res()
    await consola.tryHandle(req('POST', '/consola/cancelar', 'ana@gh.cl', JSON.stringify({ _csrf: TOKEN })), r as unknown as ServerResponse)
    expect(j(r)['cancelada']).toBe(true)
    await uno.p
    expect(abortada).toBe(true)
    expect(anotado.find((a) => a['tipo'] === 'fin')!['estado']).toBe('cancelado')
  })

  it('el ACTOR del log es el email del gate, aunque el body traiga otro', async () => {
    const { p } = ejecutar('ana@gh.cl', { _csrf: TOKEN, ref: 'fin', sql: 'SELECT 1', actor: 'jefe@gh.cl' })
    await new Promise((ok) => setTimeout(ok, 5))
    soltar!()
    await p
    expect(anotado.every((a) => a['actor'] === 'ana@gh.cl')).toBe(true)
    // Y se registran los NOMBRES de los claims, jamás sus valores.
    expect(anotado[0]!['claims']).toEqual(['groups'])
    expect(JSON.stringify(anotado)).not.toContain('Finanzas')
  })

  it('la ejecución deja UNA entrada de inicio y UNA de fin, también en error', async () => {
    consola = createConsola({
      config: CFG,
      identityOf: () => ({ agent: 'x', user: 'ana@gh.cl', claims: {} }),
      hasScope: async () => true,
      isAdmin: async () => false,
      secret: SECRET,
      estado: () => estado,
      databaseDe: () => 'wh_fin',
      ejecutar: async () => {
        throw Object.assign(new Error("Invalid object name 'x'."), { motivo: 'consola/motor' })
      },
      esquema: async () => [],
      log,
    })
    const { r, p } = ejecutar('ana@gh.cl')
    await p
    // El error del MOTOR es un resultado, no una falla del nodo: 200 con su estado adentro.
    expect(r.statusCode).toBe(200)
    expect(j(r)['estado']).toBe('error')
    expect(anotado.filter((a) => a['tipo'] === 'fin')).toHaveLength(1)
    expect(anotado.find((a) => a['tipo'] === 'fin')!['estado']).toBe('error')
  })

  it('con la capacidad apagada, quien tiene scope ve 503 con la razón', async () => {
    consola = createConsola({
      config: { ...CFG, enabled: false },
      identityOf: () => ({ agent: 'x', user: 'ana@gh.cl', claims: {} }),
      hasScope: async () => true,
      isAdmin: async () => false,
      secret: SECRET,
      estado: () => estado,
      databaseDe: () => 'wh_fin',
      ejecutar: async () => VACIO,
      esquema: async () => [],
      log,
    })
    const r = res()
    await consola.tryHandle(req('GET', '/consola', 'ana@gh.cl'), r as unknown as ServerResponse)
    expect(r.statusCode).toBe(503)
    expect(r.body).toContain('VERGIS_CONSOLA_ENABLED')
  })

  it('sin ningún Conector ofrecible, la página es 503 y publica el motivo por Conector', async () => {
    estado = new Map([['fin', { ofrecible: false, motivo: '2 tabla(s) sin SECURITY POLICY: `dbo.stg_oc`', verificadoEn: 'T', medido: {} }]])
    const r = res()
    await consola.tryHandle(req('GET', '/consola', 'ana@gh.cl'), r as unknown as ServerResponse)
    expect(r.statusCode).toBe(503)
    expect(r.body).toContain('dbo.stg_oc')
  })
})
