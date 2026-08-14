/**
 * Navegación POR CASILLA de la consola de Cargas (issue #178).
 *
 * El incidente que lo motiva: un dominio con TRES casillas hermanas produjo cinco cargas rechazadas en
 * dos días, todas por subir el archivo de una casilla en otra. No fue error de criterio — fue que la
 * página no ofrecía ni el inventario de casillas, ni una URL para enlazar la correcta, ni un mensaje
 * que dijera dónde SÍ iba el archivo. Los tres huecos se prueban acá, con los slots reales del caso.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminHandler, type IntakeRunner, type DomainEntityFreshness } from '../server/admin'
import type { CargasOps } from '../server/admin-cargas'
import {
  parseMasterDataConfig, parseDomainsConfig, parseIntakeConfig, slotsQueAceptan,
  SqliteMasterDataStore, SqliteAdminStore, type IntakeSlot, type IntakeTarget,
} from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'

const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const BOUNDARY = 'TESTBOUNDARY'

const ENTITIES = parseMasterDataConfig({
  entities: [{ id: 'tiendas', label: 'Tiendas', domain: 'comercial', columns: [{ name: 'cod', label: 'Código', type: 'string', pk: true }] }],
})
const DOMAINS = parseDomainsConfig({
  domains: [
    { id: 'comercial', label: 'Comercial', stewards: [] },
    // El dominio de UNA casilla: la garantía de regresión cero (sin barra de pestañas).
    { id: 'cartera', label: 'Cartera', stewards: [] },
  ],
})
// Las tres casillas hermanas del incidente, con sus `accept` DISJUNTOS y en orden de declaración.
const SLOTS = parseIntakeConfig({
  slots: [
    {
      id: 'oc_crossdocking', label: 'OC Crossdocking · Productos', domain: 'comercial',
      accept: '*products-details*.xlsx', maxBytes: 4096,
      target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/oc' },
      trigger: { processRef: 'PIPE_OC' },
    },
    {
      id: 'oc_crossdocking_distribuciones', label: 'OC Crossdocking · Distribuciones', domain: 'comercial',
      accept: '*distributions-details*.xlsx', maxBytes: 4096,
      target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/oc-dist' },
    },
    {
      id: 'oc_crossdocking_maestro', label: 'OC Crossdocking · Maestro de tiendas', domain: 'comercial',
      accept: 'Tiendas por zona*.xlsx', maxBytes: 4096,
      target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/oc-maestro' },
    },
    {
      id: 'saldos', label: 'Antigüedad de saldos', domain: 'cartera',
      accept: 'saldos *.xlsx', maxBytes: 4096,
      target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' },
    },
  ],
})
const FRESHNESS: DomainEntityFreshness[] = [{
  entity: 'dbo.fact_oc', processId: 'p_oc', processLabel: 'OC Crossdocking', oferta: 'P1D',
  dependentPis: [], tightestDemand: null, requiredCadence: 'P1D', requiredCadenceSeconds: 86400, unsatisfiable: false,
  engine: true, engineJobType: 'sparkjob', engineItemId: 'PIPE_OC', runs: [], actualScheduleSeconds: null,
}]

function mockReq(method: string, url: string, body: Buffer | string = '', contentType?: string): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url; r.method = method; r.headers = { 'x-test-user': ADMIN }
  if (contentType) r.headers['content-type'] = contentType
  return r
}
function multipart(fields: Record<string, string>, filename: string): { body: Buffer; ct: string } {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`))
  parts.push(Buffer.from('datos'), Buffer.from('\r\n'))
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return { body: Buffer.concat(parts), ct: `multipart/form-data; boundary=${BOUNDARY}` }
}
interface MockRes { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(chunk?: string): void }
const mockRes = (): MockRes => ({ statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(chunk) { if (chunk) this.body += chunk } })
const tokenFrom = (html: string): string => html.match(/name="_csrf" value="([0-9a-f]+)"/)![1]!

describe('consola de Cargas · navegación por casilla (#178)', () => {
  let admin: AdminHandler
  let audit: LogEventInput[]
  let pedidos: string[] // slots para los que la página pidió datos caros
  let puts: string[]

  const ops = (): CargasOps => {
    const ver = <T,>(v: T) => async (s: IntakeSlot): Promise<T> => { pedidos.push(s.id); return v }
    return {
      history: ver([]), runs: ver([]), log: ver(null), landing: ver([]), archived: ver([]),
      rerun: async () => {}, retire: async () => {}, restore: async () => {},
    }
  }

  beforeEach(async () => {
    audit = []; pedidos = []; puts = []
    const intake: IntakeRunner = { put: async (_t: IntakeTarget, filename: string) => { puts.push(filename) } }
    admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      intakeSlots: SLOTS,
      intake,
      cargas: ops(),
      domainFreshness: async () => FRESHNESS,
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
  const get = (url: string): Promise<MockRes> => go(mockReq('GET', url))

  // ─── (1) La barra de pestañas ES el inventario de casillas ─────────────────
  it('N>1: dibuja una pestaña por casilla, en orden de declaración, y el bloque de UNA sola', async () => {
    const res = await get('/admin/dominio/comercial/cargas')
    expect(res.statusCode).toBe(200)
    // Las tres casillas están nombradas: «no existe la otra casilla» deja de ser una lectura posible.
    expect(res.body).toContain('OC Crossdocking · Productos')
    expect(res.body).toContain('OC Crossdocking · Distribuciones')
    expect(res.body).toContain('OC Crossdocking · Maestro de tiendas')
    // …y cada una es enlazable (el hueco que obligaba a describir por escrito dónde scrollear).
    expect(res.body).toContain('/admin/dominio/comercial/cargas?slot=oc_crossdocking_distribuciones')
    expect(res.body).toContain('/admin/dominio/comercial/cargas?slot=oc_crossdocking_maestro')
    // El orden es el de `slots.yaml`: la página no reordena.
    const orden = ['Productos', 'Distribuciones', 'Maestro de tiendas'].map((l) => res.body.indexOf(`>OC Crossdocking · ${l}<`))
    expect(orden).toEqual([...orden].sort((a, b) => a - b))
    // Sin el parámetro, la activa es la primera — y es la ÚNICA cuyo bloque se armó.
    expect(res.body).toContain('<b class="on"')
    expect(new Set(pedidos)).toEqual(new Set(['oc_crossdocking']))
  })

  it('?slot=<id> abre esa casilla; un id inexistente o ausente cae en la primera sin error', async () => {
    const dist = await get('/admin/dominio/comercial/cargas?slot=oc_crossdocking_distribuciones')
    expect(dist.statusCode).toBe(200)
    expect(new Set(pedidos)).toEqual(new Set(['oc_crossdocking_distribuciones']))
    expect(dist.body).toContain('<b class="on" title="oc_crossdocking_distribuciones">')

    pedidos = []
    const inventado = await get('/admin/dominio/comercial/cargas?slot=no_existe')
    expect(inventado.statusCode).toBe(200) // cae en la primera, sin error
    expect(inventado.body).not.toContain('msg err')
    expect(new Set(pedidos)).toEqual(new Set(['oc_crossdocking']))
  })

  it('N=1: la consola se ve como siempre — sin barra de pestañas', async () => {
    const res = await get('/admin/dominio/cartera/cargas')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Antigüedad de saldos')
    expect(res.body).not.toContain('class="tabs"')
    expect(new Set(pedidos)).toEqual(new Set(['saldos']))
  })

  it('la Actividad, el Landing y los Procesados siguen pegados a SU casilla', async () => {
    await get('/admin/dominio/comercial/cargas?slot=oc_crossdocking_maestro')
    // Un solo slot consultado, y es el activo: ninguna casilla muestra datos de otra.
    expect(new Set(pedidos)).toEqual(new Set(['oc_crossdocking_maestro']))
    expect(pedidos.length).toBeGreaterThanOrEqual(5) // history + runs + log + landing + archived
  })

  // ─── (2) El rechazo vuelve a su casilla, no a Frescura ─────────────────────
  it('el rechazo por patrón deja al usuario en SU casilla (ya no navega a Frescura)', async () => {
    const page = await get('/admin/dominio/comercial/cargas')
    const { body, ct } = multipart(
      { _csrf: tokenFrom(page.body), origen: 'cargas' },
      'oc-17473580-distributions-details-11-08-2026.xlsx',
    )
    const res = await go(mockReq('POST', '/admin/dominio/comercial/intake/oc_crossdocking', body, ct))
    expect(res.statusCode).toBe(303)
    const loc = res.headers['location']!
    expect(loc).toContain('/admin/dominio/comercial/cargas?slot=oc_crossdocking&')
    expect(loc).not.toContain('frescura')
    expect(puts).toEqual([]) // rechazada: no aterrizó nada
  })

  it('la carga ACEPTADA nacida en la consola también vuelve a su casilla', async () => {
    const page = await get('/admin/dominio/comercial/cargas')
    const { body, ct } = multipart({ _csrf: tokenFrom(page.body), origen: 'cargas' }, 'oc-1747-products-details-11-08-2026.xlsx')
    const res = await go(mockReq('POST', '/admin/dominio/comercial/intake/oc_crossdocking', body, ct))
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toContain('/cargas?slot=oc_crossdocking&msg=')
    expect(puts).toEqual(['oc-1747-products-details-11-08-2026.xlsx'])
  })

  it('lo que nace en Frescura sigue muriendo en Frescura', async () => {
    const page = await get('/admin/dominio/comercial/frescura')
    // El form de Frescura no declara origen: su rechazo vuelve ahí, como siempre.
    const { body, ct } = multipart({ _csrf: tokenFrom(page.body) }, 'Tiendas por zona Sodimac.xlsx')
    const res = await go(mockReq('POST', '/admin/dominio/comercial/intake/oc_crossdocking', body, ct))
    expect(res.statusCode).toBe(303)
    const loc = res.headers['location']!
    expect(loc).toContain('/admin/dominio/comercial/frescura?')
    // …y el destino viaja con él: el aviso se pinta también acá.
    expect(loc).toContain('destino=oc_crossdocking_maestro')
    const pintada = await get(loc)
    expect(pintada.body).toContain('Este archivo va en')
    expect(pintada.body).toContain('OC Crossdocking · Maestro de tiendas')
  })

  // ─── (3) El mensaje nombra la casilla correcta ─────────────────────────────
  it('rechazo en A con archivo de B: el mensaje nombra B y enlaza su pestaña', async () => {
    const page = await get('/admin/dominio/comercial/cargas')
    const { body, ct } = multipart(
      { _csrf: tokenFrom(page.body), origen: 'cargas' },
      'oc-17473580-distributions-details-11-08-2026.xlsx',
    )
    const res = await go(mockReq('POST', '/admin/dominio/comercial/intake/oc_crossdocking', body, ct))
    const loc = res.headers['location']!
    expect(loc).toContain('destino=oc_crossdocking_distribuciones')

    const pintada = await get(loc)
    expect(pintada.body).toContain('msg err')
    expect(pintada.body).toContain('no coincide con el patrón esperado') // el error de siempre, intacto
    expect(pintada.body).toContain('Este archivo va en <a href="/admin/dominio/comercial/cargas?slot=oc_crossdocking_distribuciones"><b>OC Crossdocking · Distribuciones</b></a>.')
  })

  it('si NINGÚN otro slot acepta el archivo, el mensaje no menciona ningún destino', async () => {
    const page = await get('/admin/dominio/comercial/cargas')
    const { body, ct } = multipart({ _csrf: tokenFrom(page.body), origen: 'cargas' }, 'cualquier-cosa.csv')
    const res = await go(mockReq('POST', '/admin/dominio/comercial/intake/oc_crossdocking', body, ct))
    const loc = res.headers['location']!
    expect(loc).not.toContain('destino=')
    const pintada = await get(loc)
    expect(pintada.body).toContain('msg err')
    expect(pintada.body).not.toContain('Este archivo va en')
  })

  it('un `destino` inventado en la barra de direcciones no produce aviso', async () => {
    const res = await get('/admin/dominio/comercial/cargas?msg=Error:%20x&destino=slot_fantasma')
    expect(res.body).toContain('msg err')
    expect(res.body).not.toContain('Este archivo va en')
  })
})

// ─── El candidato se computa, no se adivina (regla de honestidad de #178) ────
describe('slotsQueAceptan · solo patrones DECLARADOS que matchean', () => {
  const comercial = SLOTS.filter((s) => s.domain === 'comercial')

  it('nombra el hermano cuyo accept matchea, y nunca el slot que ya rechazó', () => {
    const c = slotsQueAceptan(comercial, 'oc-1-distributions-details-11-08-2026.xlsx', 'oc_crossdocking')
    expect(c.map((s) => s.id)).toEqual(['oc_crossdocking_distribuciones'])
  })

  it('sin candidato no inventa destino', () => {
    expect(slotsQueAceptan(comercial, 'balance.pdf', 'oc_crossdocking')).toEqual([])
  })

  it('con varios candidatos los devuelve TODOS (se listan, no se elige)', () => {
    const dos = parseIntakeConfig({
      slots: [
        { id: 'a', label: 'A', domain: 'd', accept: '*.xlsx', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/p' } },
        { id: 'b', label: 'B', domain: 'd', accept: 'informe*.xlsx', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/p' } },
        { id: 'c', label: 'C', domain: 'd', accept: '*informe*.xlsx', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/p' } },
      ],
    })
    expect(slotsQueAceptan(dos, 'informe.xlsx', 'a').map((s) => s.id)).toEqual(['b', 'c'])
  })

  it('un slot SIN accept nunca se ofrece como destino: aceptaría cualquier cosa (sería adivinar)', () => {
    const libre = parseIntakeConfig({
      slots: [
        { id: 'estricto', label: 'Estricto', domain: 'd', accept: 'x*.xlsx', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/p' } },
        { id: 'libre', label: 'Libre', domain: 'd', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/p' } },
      ],
    })
    expect(slotsQueAceptan(libre, 'lo-que-sea.bin', 'estricto')).toEqual([])
  })
})
