import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  parseMasterDataConfig,
  parseDomainsConfig,
  parseIntakeConfig,
  SqliteMasterDataStore,
  SqliteAdminStore,
  type OneLakeEntry,
  type RunRecord,
  type SlotWatchSnapshot,
} from '@vergis/capabilities'
import { createAdmin } from '../server/admin'
import type { CargasOps, SlotVigilancia } from '../server/admin-cargas'
import { slotVigilanciaDeProyeccion } from '../server/intake-loop'

/**
 * El CABLEADO de la vigilancia hacia la consola de Cargas (#161 punto 2): H6 sabe dibujar el
 * veredicto y H3/H4 saben producirlo; acá se prueba lo que faltaba — que el veredicto LLEGUE a la
 * página, y que llegue leyendo SOLO la proyección.
 *
 * Dos capas, porque fallan distinto:
 *  1. `slotVigilanciaDeProyeccion` (pura): qué veredicto sale de un snapshot dado.
 *  2. La página completa vía `createAdmin`: que `CargasOps.vigilancia` se consuma y se renderice — y
 *     que SIN esa op la página sea exactamente la de antes (regresión cero).
 */
const T0 = Date.parse('2026-08-13T12:00:00.000Z')
const POLL_MS = 600_000
const SLOT = parseIntakeConfig({
  slots: [{
    id: 'saldos', label: 'Saldos de cartera', domain: 'cartera', maxBytes: 1024,
    target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' },
    trigger: { processRef: 'pipe_saldos' },
  }],
})[0]!

const archivo = (name: string, minutosDeEdad: number): OneLakeEntry => ({
  path: `Files/intake/saldos/${name}`,
  isDirectory: false,
  size: 1024,
  lastModified: new Date(T0 - minutosDeEdad * 60_000).toISOString(),
})

const snap = (over: Partial<SlotWatchSnapshot> = {}): SlotWatchSnapshot => ({
  slotId: SLOT.id,
  landing: [],
  runs: [],
  observedAt: new Date(T0 - 60_000).toISOString(),
  firstAttemptAt: new Date(T0 - 3_600_000).toISOString(),
  lastError: null,
  lastErrorAt: null,
  ...over,
})

const veredicto = (s: SlotWatchSnapshot | undefined, razon?: Parameters<typeof slotVigilanciaDeProyeccion>[4], pollMs = POLL_MS): SlotVigilancia =>
  slotVigilanciaDeProyeccion(SLOT, s, pollMs, T0, razon)!

describe('slotVigilanciaDeProyeccion · el veredicto que la consola dibuja', () => {
  it('proyección fresca y sana ⇒ medida fresca, con la hora de la medida y sin varados', () => {
    const v = veredicto(snap({ landing: [archivo('reciente.xlsx', 5)] }))
    expect(v.medida).toBe('fresca')
    expect(v.observedAt).toBe(new Date(T0 - 60_000).toISOString())
    expect(v.varados).toBeUndefined()
    expect(v.lastError).toBeUndefined()
  })

  it('archivo pasado de edad en la proyección ⇒ varado CON su edad (la que midió la clasificación)', () => {
    const v = veredicto(snap({ landing: [archivo('atascado.xlsx', 300), archivo('reciente.xlsx', 5)] }))
    expect(v.medida).toBe('fresca')
    expect(v.varados).toEqual([{ file: 'atascado.xlsx', ageMinutes: 300 }])
  })

  it('último intento FALLIDO ⇒ ultima-conocida, con el error real del lazo y los varados de lo último conocido', () => {
    const v = veredicto(snap({
      landing: [archivo('atascado.xlsx', 300)],
      lastError: 'onelake: 500',
      lastErrorAt: new Date(T0 - 30_000).toISOString(),
    }))
    expect(v.medida).toBe('ultima-conocida')
    expect(v.lastError).toBe('onelake: 500')
    expect(v.lastErrorAt).toBe(new Date(T0 - 30_000).toISOString())
    expect(v.varados).toEqual([{ file: 'atascado.xlsx', ageMinutes: 300 }])
  })

  it('sin proyección alguna ⇒ ninguna: no se afirma nada de un slot que jamás se midió', () => {
    const v = veredicto(undefined)
    expect(v.medida).toBe('ninguna')
    expect(v.varados).toBeUndefined()
    expect(v.observedAt).toBeUndefined()
  })

  it('proyección rancia (> 3 × poll) o lazo apagado ⇒ NO se dice «al día» sobre un recuerdo', () => {
    const vieja = snap({ observedAt: new Date(T0 - 4 * POLL_MS).toISOString(), landing: [archivo('atascado.xlsx', 300)] })
    expect(veredicto(vieja).medida).toBe('ultima-conocida')
    // Mismo snapshot, lazo apagado: la proyección que nadie refresca tampoco es una medida.
    expect(veredicto(snap({ landing: [archivo('reciente.xlsx', 5)] }), undefined, 0).medida).toBe('ultima-conocida')
  })

  it('la CONTRADICCIÓN la aporta el veredicto persistido del lazo, y desautoriza los varados', () => {
    const s = snap({ landing: [archivo('atascado.xlsx', 300)] })
    expect(veredicto(s).medida).toBe('fresca') // sin la razón del lazo, el request path no la deduce
    const v = veredicto(s, 'contradice-registro')
    expect(v.medida).toBe('contradice-registro')
    // Sobre un listado desmentido no se concluye «varado» (invariante 2 de la vigilancia).
    expect(v.varados).toBeUndefined()
    // La página nombra los archivos esperados solo si los tiene; acá no se pueden saber sin listar
    // el almacenamiento, así que NO se inventan.
    expect(v.esperados).toBeUndefined()
  })

  it('con la medida ya degradada, la razón vieja del lazo NO pisa lo más reciente', () => {
    const s = snap({ lastError: 'onelake: 500', lastErrorAt: new Date(T0 - 30_000).toISOString() })
    expect(veredicto(s, 'contradice-registro').medida).toBe('ultima-conocida')
  })

  it('`corridasSinLog` queda SIN LLENAR: la proyección no lo guarda y el request path no lista `_logs/`', () => {
    expect(veredicto(snap()).corridasSinLog).toBeUndefined()
  })
})

// ─── La página completa: que el veredicto llegue al render (y que sin él nada cambie) ───
const ADMIN_USER = 'cesar@ultrabase.com'
const ENTITIES = parseMasterDataConfig({ entities: [{ id: 'rel', label: 'Relacionadas', domain: 'cartera', columns: [{ name: 'rut', label: 'RUT', type: 'string', pk: true }] }] })
const DOMAINS = parseDomainsConfig({ domains: [{ id: 'cartera', label: 'Cartera / Finanzas', stewards: [] }] })
const RUNS: RunRecord[] = [{ startedAt: '2026-08-13T09:00:00Z', endedAt: '2026-08-13T09:02:00Z', status: 'Completed' }]

function mockReq(url: string, user: string): IncomingMessage {
  const r = Readable.from(['']) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url; r.method = 'GET'; r.headers = { 'x-test-user': user }
  return r
}
interface MockRes { statusCode: number; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(chunk?: string): void }
const mockRes = (): MockRes => ({ statusCode: 0, body: '', writeHead(c) { this.statusCode = c; return this }, end(chunk) { if (chunk) this.body += chunk } })

const opsBase: CargasOps = {
  history: async () => [],
  runs: async () => RUNS,
  log: async () => null,
  landing: async () => [archivo('atascado.xlsx', 300)],
  archived: async () => [],
  rerun: async () => {},
  retire: async () => {},
  restore: async () => {},
}

async function paginaCargas(ops: CargasOps): Promise<string> {
  const admin = createAdmin({
    entities: ENTITIES,
    mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
    adminStore: await SqliteAdminStore.open(null, [ADMIN_USER]),
    domains: DOMAINS,
    intakeSlots: [SLOT],
    cargas: ops,
    identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
    audit: () => {},
    secret: 'test-secret',
  })
  const res = mockRes()
  await admin.tryHandle(mockReq('/admin/dominio/cartera/cargas', ADMIN_USER), res as unknown as ServerResponse)
  expect(res.statusCode).toBe(200)
  return res.body
}

describe('consola de Cargas · el veredicto llega a la página', () => {
  it('con la op cableada: banner del vigilante y marca de VARADO con su edad', async () => {
    const html = await paginaCargas({
      ...opsBase,
      vigilancia: async () => ({ medida: 'fresca', observedAt: '2026-08-13T11:59:00Z', varados: [{ file: 'atascado.xlsx', ageMinutes: 300 }] }),
    })
    expect(html).toContain('👁 Vigilancia del slot: al día · medido 2026-08-13 11:59 UTC.')
    expect(html).toContain('⚠ VARADO')
    expect(html).toContain('hace 5h 00m en el landing')
  })

  it('sin la op (instancia sin vigilante): la página es la de siempre — ni banner ni varados', async () => {
    const html = await paginaCargas(opsBase)
    expect(html).toContain('atascado.xlsx') // el landing se sigue mostrando igual
    expect(html).not.toContain('Vigilancia del slot')
    expect(html).not.toContain('VARADO')
    expect(html).not.toContain('El vigilante')
  })

  it('la op que falla NO rompe la consola: se pierde el banner, no la página', async () => {
    const html = await paginaCargas({ ...opsBase, vigilancia: async () => { throw new Error('store caído') } })
    expect(html).toContain('atascado.xlsx')
    expect(html).not.toContain('Vigilancia del slot')
  })
})
