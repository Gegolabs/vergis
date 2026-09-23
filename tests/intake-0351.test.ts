import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  SqliteGovernanceStore,
  SqliteMasterDataStore,
  SqliteAdminStore,
  parseMasterDataConfig,
  parseDomainsConfig,
  parseIntakeConfig,
  expectedInLanding,
  classifySlot,
  type IntakeSlot,
  type OneLakeEntry,
  type OneLakeListing,
  type RunRecord,
} from '@vergis/capabilities'
import { firmaDePatrones, patronesQueSePisan } from '../packages/capabilities/src/intake'
import { createAdmin, validarEnLaPuerta, type AdminHandler } from '../server/admin'
import { createIntakeLoop, garantiaDeDisjuncion, intakeWatchConfig, slotVigilanciaDeProyeccion, type IntakeLoopDeps, type MedidaDisjuncion } from '../server/intake-loop'
import type { CargasOps } from '../server/admin-cargas'

/**
 * 0.35.1 · lo que la producción de 0.35.0 mostró (lab A.R.B.O.L., 2026-09-23 17:33Z), con datos
 * SINTÉTICOS de la misma forma: la puerta que rechazaba TODO con una configuración de instancia que no
 * es disjunta, el «CONTRADICE» de Facturas y el «VARADO» sobre archivos en espera.
 */

// La forma de la configuración de hoy: dos casillas con patrón propio y cinco con `*.xlsx`.
const base = (id: string, accept: string, extra: Record<string, unknown> = {}) => ({ id, label: id.toUpperCase(), domain: 'd', accept, target: { workspaceId: 'W', lakehouseId: 'L', path: `Files/intake/${id}`, ...extra } })
const HOY = parseIntakeConfig({ slots: [
  base('prod', '*products-details*.xlsx'),
  base('dist', '*distributions-details*.xlsx'),
  base('fact', '*.xlsx'),
  base('inv', '*.xlsx'),
  base('desp', '*.xlsx'),
  base('clas', '*.xlsx'),
  base('pres', '*.xlsx'),
] })
const DISJUNTA = parseIntakeConfig({ slots: [base('prod', '*products-details*.xlsx'), base('dist', '*distributions-details*.xlsx'), base('pres', 'Presupuesto*.xlsx')] })

describe('0.35.1 · 1 · la puerta nunca bloquea por una configuración de instancia', () => {
  it('los patrones de hoy se pisan (cinco `*.xlsx`): la garantía se desactiva, aunque haya medida sin ambiguos', () => {
    expect(patronesQueSePisan(HOY).length).toBeGreaterThan(0)
    const medida: MedidaDisjuncion = { medidoAt: 'x', firma: firmaDePatrones(HOY), nombres: 0, ambiguos: [] }
    expect(garantiaDeDisjuncion(HOY, medida)).toBe(false)
  })

  it('con la configuración de hoy, cada subida entra en la casilla elegida (como 0.34.0)', () => {
    const subidas: [string, string][] = [['prod', 'oc-1-products-details-01-01-2026.xlsx'], ['dist', 'oc-1-distributions-details-01-01-2026.xlsx'], ['inv', '20260101 - Recepción Vivero.xlsx'], ['pres', 'Presupuesto comercial 2026.xlsx'], ['fact', 'Listado X VH.xlsx']]
    const garantia = garantiaDeDisjuncion(HOY, null)
    for (const [id, n] of subidas) expect(validarEnLaPuerta(HOY, HOY.find((s) => s.id === id)!, n, 10, garantia)).toEqual({ ok: true })
  })

  it('control negativo: la puerta de 0.35.0 (garantía incondicional) rechazaba esas mismas subidas', () => {
    expect(validarEnLaPuerta(HOY, HOY.find((s) => s.id === 'dist')!, 'oc-1-distributions-details-01-01-2026.xlsx', 10, true)).toMatchObject({ ok: false, reason: 'ambiguo' })
  })

  it('con patrones disjuntos Y medida limpia de esa misma configuración, un nombre ambiguo se rechaza', () => {
    const medida: MedidaDisjuncion = { medidoAt: 'x', firma: firmaDePatrones(DISJUNTA), nombres: 3, ambiguos: [] }
    expect(patronesQueSePisan(DISJUNTA)).toEqual([])
    expect(garantiaDeDisjuncion(DISJUNTA, medida)).toBe(true)
    const v = validarEnLaPuerta(DISJUNTA, DISJUNTA[0]!, 'oc-1-products-details distributions-details.xlsx', 10, true)
    expect(v).toMatchObject({ ok: false, reason: 'ambiguo' })
    // Una medida de OTRA configuración (o ninguna, tras una recarga) no vale: no hay garantía.
    expect(garantiaDeDisjuncion(DISJUNTA, { ...medida, firma: 'otra' })).toBe(false)
    expect(garantiaDeDisjuncion(DISJUNTA, null)).toBe(false)
  })

  it('de punta a punta: con los patrones de hoy la subida real entra (en 0.35.0 se rechazaba)', async () => {
    const h = await adminArnes(HOY)
    const res = await h.subir('dist', 'oc-1-distributions-details-01-01-2026.xlsx')
    expect(decodeURIComponent(res.headers['location'] ?? '')).toContain('Recibimos 1 archivo(s).')
    expect((await h.store.listUploads('dist', 5))[0]).toMatchObject({ ok: true })
  })

  it('el lazo persiste la medida con su firma y los pares que se pisan, y lo dice en el log', async () => {
    const store = await SqliteGovernanceStore.open(null, {})
    const log: string[] = []
    const deps: IntakeLoopDeps = {
      slots: () => HOY, landing: async (): Promise<OneLakeListing> => ({ kind: 'ok', entries: [] }), store,
      domains: [{ id: 'd', label: 'D' }], log: (l) => void log.push(l), now: () => Date.parse('2026-09-23T12:00:00Z'),
    }
    await createIntakeLoop(deps, { publicUrl: 'https://x', pollMs: 600_000 }).tick()
    const m = JSON.parse((await store.getSetting('intake.disjuncion'))!) as MedidaDisjuncion
    expect(m.firma).toBe(firmaDePatrones(HOY))
    expect(m.pisan).toContainEqual(['fact', 'inv'])
    expect(log.some((l) => l.includes('los patrones de estas casillas se pisan') && l.includes('prod / fact'))).toBe(true)
  })
})

describe('0.35.1 · 2 · «sin informe» no se espera en el landing (Facturas)', () => {
  // Los 7 estados de Facturas leídos del store de producción (17:33Z), con nombres sintéticos.
  const c = (filename: string, uploadedAt: string, estado: string, final: boolean) => ({ filename, uploadedAt, ok: true, estado, ...(final ? { final: true } : {}) })
  const FACTURAS = [
    c('A VH.xlsx', '2026-08-13T16:44:58Z', 'procesada', true), c('B VH.xlsx', '2026-08-13T16:44:58Z', 'procesada', true),
    c('A VH.xlsx', '2026-07-28T20:41:18Z', 'reemplazada', true), c('B VH.xlsx', '2026-07-28T20:40:37Z', 'reemplazada', true), c('A VH.xlsx', '2026-07-28T20:40:37Z', 'reemplazada', true),
    c('Reporte.xlsx', '2026-07-21T21:02:20Z', 'sin-informe', false), c('A.xlsx', '2026-07-21T21:02:20Z', 'sin-informe', false),
  ]
  it('con el motor sin corridas: no se espera ningún archivo (antes: los dos «sin informe» ⇒ CONTRADICE)', () => {
    expect(expectedInLanding(FACTURAS, [], [])).toEqual([])
    // Control: sin el estado (lo que 0.35.0 le pasaba), los dos se seguían esperando.
    expect(expectedInLanding(FACTURAS.map(({ estado: _e, ...x }) => x), [], [])).toEqual(['A.xlsx', 'Reporte.xlsx'])
  })
  it('una carga declarada ✖/⚠ o sin estado SÍ se espera (sigue en el landing, reintentándose)', () => {
    expect(expectedInLanding([c('x.xlsx', '2026-09-01T00:00:00Z', 'fallida', false), { filename: 'y.xlsx', uploadedAt: '2026-09-01T00:00:00Z', ok: true }], [], [])).toEqual(['x.xlsx', 'y.xlsx'])
  })
})

describe('0.35.1 · 3 · «VARADO» no es un archivo en espera, ni el vigente de un catálogo', () => {
  const NOW = Date.parse('2026-09-23T17:33:46Z')
  const L = (n: string, t: string): OneLakeEntry => ({ path: `Files/intake/dist/${n}`, isDirectory: false, size: 1, lastModified: t })
  const LANDING = [L('oc-266.xlsx', '2026-09-23T14:03:54Z'), L('oc-267.xlsx', '2026-09-23T14:03:54Z'), L('oc-otro.xlsx', '2026-09-23T14:00:00Z')]
  it('266/267 declarados ✖ (en espera) no son varados; un archivo que ninguna corrida tomó, sí', () => {
    const r = classifySlot({ slotId: 'dist', obs: { slotId: 'dist', observedAt: '', landing: LANDING }, enEspera: ['oc-266.xlsx', 'oc-267.xlsx'] }, { maxAgeMinutes: 120 }, NOW)
    expect(r.alertas.find((a) => a.reason === 'varados')?.varados?.map((v) => v.file)).toEqual(['oc-otro.xlsx'])
    // Control: sin el dato de «en espera» (0.35.0) los tres salían varados.
    const r0 = classifySlot({ slotId: 'dist', obs: { slotId: 'dist', observedAt: '', landing: LANDING } }, { maxAgeMinutes: 120 }, NOW)
    expect(r0.alertas.find((a) => a.reason === 'varados')?.varados).toHaveLength(3)
  })

  it('Clasificación (`processed: false`): ninguna edad la vuelve varada — tampoco en la alerta al operador', () => {
    const [clas] = parseIntakeConfig({ slots: [{ ...base('clas', '*Tipo*.xlsx', { processed: false }), trigger: { processRef: 'P' } }] })
    const cfg = intakeWatchConfig(clas!, 600_000)!
    expect(cfg.maxAgeMinutes).toBeUndefined()
    const r = classifySlot({ slotId: 'clas', obs: { slotId: 'clas', observedAt: '', landing: [L('Tipo.xlsx', '2026-08-01T00:00:00Z')] } }, cfg, NOW)
    expect(r.alertas.map((a) => a.reason)).not.toContain('varados')
    // Control: el mismo slot sin `processed: false` sí alerta.
    const [otro] = parseIntakeConfig({ slots: [{ ...base('clas', '*Tipo*.xlsx'), trigger: { processRef: 'P' } }] })
    expect(classifySlot({ slotId: 'clas', obs: { slotId: 'clas', observedAt: '', landing: [L('Tipo.xlsx', '2026-08-01T00:00:00Z')] } }, intakeWatchConfig(otro!, 600_000)!, NOW).alertas.map((a) => a.reason)).toContain('varados')
  })

  it('la consola (proyección) tampoco marca VARADO lo que está en espera', () => {
    const slot: IntakeSlot = { id: 'dist', label: 'D', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/intake/dist' }, trigger: { processRef: 'P' } }
    const snap = { slotId: 'dist', landing: LANDING, runs: [] as RunRecord[], observedAt: new Date(NOW - 60_000).toISOString(), firstAttemptAt: null, lastError: null, lastErrorAt: null }
    const v = slotVigilanciaDeProyeccion(slot, snap, 600_000, NOW, undefined, ['oc-266.xlsx', 'oc-267.xlsx'])!
    expect(v.varados?.map((x) => x.file)).toEqual(['oc-otro.xlsx'])
  })
})

describe('0.35.1 · 4 · la misma corrida con y sin «Z» es UNA', () => {
  it('el resolvedor no ve dos corridas donde la proyección guardó `…6685436` y `…6685436Z`', async () => {
    const store = await SqliteGovernanceStore.open(null, {})
    const slot: IntakeSlot = { id: 's', label: 'S', domain: 'd', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/intake/s' }, trigger: { processRef: 'P' } }
    // Sembrada tal cual la dejó la versión que no normalizaba a UTC, más la fila nueva.
    await store.recordSlotObservations([{ slotId: 's', observedAt: '2026-08-16T20:00:00Z', landing: [], runs: [
      { startedAt: '2026-08-16T19:33:37.6685436', endedAt: '2026-08-16T19:34:58.6678564', status: 'Completed' },
      { startedAt: '2026-08-16T19:33:37.6685436Z', endedAt: '2026-08-16T19:34:58.6678564Z', status: 'Completed' },
    ] }])
    await store.recordUpload({ slotId: 's', filename: 'x.xlsx', sha256: 'a'.repeat(64), bytes: 1, uploadedBy: 'a@ejemplo.cl', uploadedAt: '2026-08-16T19:30:00Z', ok: true, triggered: true, origen: 'upload' })
    const lecturas: string[] = []
    const deps: IntakeLoopDeps = {
      slots: () => [slot], landing: async (): Promise<OneLakeListing> => ({ kind: 'ok', entries: [] }), runs: async () => [], retiros: async () => [], store,
      runLogs: { list: async () => [{ path: 'Files/code/_logs/run-20260816T193337Z.txt', isDirectory: false, size: 1, lastModified: '' }], read: async (_s, p) => (lecturas.push(p), '[intake] ✔ procesado: x.xlsx\n') },
      domains: [{ id: 'd', label: 'D' }], log: () => {}, now: () => Date.parse('2026-09-23T12:00:00Z'),
    }
    await createIntakeLoop(deps, { publicUrl: 'https://x', pollMs: 600_000 }).tick()
    expect(lecturas).toHaveLength(1)
    expect((await store.listIntentos(1)).map((i) => i.runStartedAt)).toEqual(['2026-08-16T19:33:37.6685436Z'])
    expect((await store.listUploads('s', 5))[0]).toMatchObject({ desenlace: 'procesada', desenlaceRunStartedAt: '2026-08-16T19:33:37.6685436Z' })
  })
})

async function adminArnes(slots: IntakeSlot[]) {
  const STEWARD = 'steward@ejemplo.cl'
  const ENT = parseMasterDataConfig({ entities: [{ id: 'e', label: 'E', domain: 'd', columns: [{ name: 'k', label: 'K', type: 'string', pk: true }] }] })
  const store = await SqliteGovernanceStore.open(null, {})
  const cargas: CargasOps = { history: async () => [], runs: async () => [], log: async () => null, landing: async () => [], archived: async () => [], rerun: async () => {}, retire: async () => {}, restore: async () => {} }
  const admin: AdminHandler = createAdmin({
    cargas,
    entities: ENT,
    mdStore: await SqliteMasterDataStore.open(null, ENT),
    adminStore: await SqliteAdminStore.open(null, ['admin@ejemplo.cl']),
    domains: parseDomainsConfig({ domains: [{ id: 'd', label: 'D', stewards: [STEWARD] }] }),
    intakeSlots: slots,
    intake: { put: async () => {} },
    intakeUploads: store,
    disjuncion: async () => null,
    identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
    audit: () => {},
    secret: 'test-secret',
  })
  const res = () => ({ statusCode: 0, headers: {} as Record<string, string>, body: '', writeHead(c: number, h?: Record<string, string>) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(c?: string) { if (c) this.body += c } })
  const go = async (req: IncomingMessage) => { const r = res(); await admin.tryHandle(req, r as unknown as ServerResponse); return r }
  const req = (method: string, url: string, body: Buffer | string = '', ct?: string): IncomingMessage => {
    const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
    r.url = url; r.method = method; r.headers = { 'x-test-user': STEWARD }
    if (ct) r.headers['content-type'] = ct
    return r
  }
  return {
    store,
    subir: async (slotId: string, filename: string) => {
      const token = (await go(req('GET', '/admin/dominio/d/cargas'))).body.match(/name="_csrf" value="([0-9a-f]+)"/)![1]!
      const B = 'b0351'
      const body = Buffer.concat([
        Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${token}\r\n`),
        Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        Buffer.from('contenido'), Buffer.from(`\r\n--${B}--\r\n`),
      ])
      return go(req('POST', `/admin/dominio/d/intake/${slotId}`, body, `multipart/form-data; boundary=${B}`))
    },
  }
}
