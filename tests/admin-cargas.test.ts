import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminHandler } from '../server/admin'
import { timeline, esResiduo, lastCompletedStart, type CargasOps, type IntakeUploadEvent } from '../server/admin-cargas'
import { parseMasterDataConfig, parseDomainsConfig, parseIntakeConfig, SqliteMasterDataStore, SqliteAdminStore, type RunRecord, type OneLakeEntry } from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'

const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const STEWARD = 'steward@gh.cl'

const ENTITIES = parseMasterDataConfig({ entities: [{ id: 'rel', label: 'Relacionadas', domain: 'cartera', columns: [{ name: 'rut', label: 'RUT', type: 'string', pk: true }] }] })
const DOMAINS = parseDomainsConfig({ domains: [{ id: 'cartera', label: 'Cartera / Finanzas', stewards: [STEWARD] }] })
const SLOTS = parseIntakeConfig({
  slots: [{
    id: 'saldos', label: 'Antigüedad de saldos', domain: 'cartera', maxBytes: 1024,
    target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' },
    trigger: { processRef: 'PIPE' },
  }],
})

const RUNS: RunRecord[] = [
  { startedAt: '2026-07-13T16:17:47Z', endedAt: '2026-07-13T16:20:06Z', status: 'Completed' },
  { startedAt: '2026-07-10T13:30:17Z', endedAt: '2026-07-10T13:32:08Z', status: 'Failed', error: 'Job failed during run time with state=[dead].' },
]
const HISTORY: IntakeUploadEvent[] = [
  { ts: '2026-07-13T16:17:42Z', filename: 'saldos VH WK28.xlsx', bytes: 110760, by: 'claudio@x.cl', ok: true, triggered: true },
]
const LANDING: OneLakeEntry[] = [
  { path: 'Files/intake/saldos/nuevo WK29.xlsx', isDirectory: false, size: 2048, lastModified: '2026-07-13T17:00:00Z' }, // posterior a la última completada
  { path: 'Files/intake/saldos/viejo-residuo.xlsx', isDirectory: false, size: 1024, lastModified: '2026-07-01T10:00:00Z' }, // RESIDUO
]
const ARCHIVED: OneLakeEntry[] = [
  { path: 'Files/intake/_processed/W28/saldos VH WK28.xlsx', isDirectory: false, size: 110760, lastModified: '2026-07-13T16:19:00Z' },
]

function ops(over: Partial<CargasOps> = {}): CargasOps {
  return {
    history: async () => HISTORY,
    runs: async () => RUNS,
    log: async () => '[ingest] ✔ DONE commit W28: 7626 filas',
    landing: async () => LANDING,
    archived: async () => ARCHIVED,
    rerun: vi.fn(async () => {}),
    retire: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    ...over,
  }
}

function mkAdmin(cargas: CargasOps, audit: LogEventInput[] = []): Promise<AdminHandler> {
  return (async () =>
    createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      intakeSlots: SLOTS,
      intake: { put: async () => {} },
      cargas,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: (e) => audit.push(e),
      secret: SECRET,
    }))()
}

function mockReq(method: string, url: string, user: string, body = '', ct?: string): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url; r.method = method; r.headers = { 'x-test-user': user }
  if (ct) r.headers['content-type'] = ct
  return r
}
interface MockRes { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(c?: string): void }
const mockRes = (): MockRes => ({ statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(c) { if (c) this.body += c } })
const go = async (admin: AdminHandler, req: IncomingMessage) => {
  const res = mockRes()
  await admin.tryHandle(req, res as unknown as ServerResponse)
  return res
}
const tokenFrom = (html: string): string => html.match(/name="_csrf" value="([0-9a-f]+)"/)![1]

describe('admin-cargas · lógica pura', () => {
  it('timeline fusiona cargas y corridas, más reciente primero, con motivo de falla', () => {
    const t = timeline(HISTORY, RUNS)
    expect(t).toHaveLength(3)
    expect(t[0].html).toContain('Conversión') // 16:17:47 corrida
    expect(t[1].html).toContain('Carga') // 16:17:42 upload
    expect(t[2].html).toContain('state=[dead]') // la fallida trae su motivo
  })
  it('esResiduo: anterior a la última corrida COMPLETADA; sin corridas no acusa', () => {
    const last = lastCompletedStart(RUNS)
    expect(esResiduo(LANDING[1], last)).toBe(true)
    expect(esResiduo(LANDING[0], last)).toBe(false)
    expect(esResiduo(LANDING[1], lastCompletedStart('error'))).toBe(false)
  })
})

describe('admin-cargas · consola por dominio (issue #58)', () => {
  it('GET /cargas: historial, estado con motivo, log, residuo marcado y archivo histórico', async () => {
    const admin = await mkAdmin(ops())
    const res = await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('✓ Listo') // estado última conversión
    expect(res.body).toContain('state=[dead]') // motivo de la fallida en la actividad
    expect(res.body).toContain('7626 filas') // log (#55)
    expect(res.body).toContain('⚠ residuo') // #57
    expect(res.body).toContain('viejo-residuo.xlsx')
    expect(res.body).toContain('Reactivar') // archivo histórico accionable
    expect(res.body).toContain('Correr conversión de nuevo')
    expect(res.body).toContain('claudio@x.cl') // quién cargó
  })

  it('#56: slot con trigger sin proceso registrado → aviso de coherencia (con sourceRegistry)', async () => {
    const audit: LogEventInput[] = []
    const admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      intakeSlots: SLOTS,
      intake: { put: async () => {} },
      cargas: ops(),
      sourceRegistry: async () => ({ sources: [], processes: [{ id: 'p1', label: 'Otro', sourceId: 's1', engine: { workspaceId: 'W', itemId: 'OTRO-ITEM', jobType: 'sparkjob' } }], outputs: [] }),
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: (e) => audit.push(e),
      secret: SECRET,
    })
    const res = await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    expect(res.body).toContain('no está registrado como proceso')
    expect(res.body).toContain('PIPE')
  })

  it('POST rerun: dispara la conversión, audita y redirige con mensaje', async () => {
    const audit: LogEventInput[] = []
    const o = ops()
    const admin = await mkAdmin(o, audit)
    const page = await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    const token = tokenFrom(page.body)
    const res = await go(admin, mockReq('POST', '/admin/dominio/cartera/cargas', STEWARD, `_csrf=${token}&slot=saldos&accion=rerun`, 'application/x-www-form-urlencoded'))
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toContain('/cargas?msg=')
    expect(o.rerun).toHaveBeenCalled()
    expect(audit.some((e) => (e as { type?: string }).type === 'intake-rerun')).toBe(true)
  })

  it('POST retire: valida el nombre (sin rutas), ejecuta y audita', async () => {
    const audit: LogEventInput[] = []
    const o = ops()
    const admin = await mkAdmin(o, audit)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const ok = await go(admin, mockReq('POST', '/admin/dominio/cartera/cargas', STEWARD, `_csrf=${token}&slot=saldos&accion=retire&archivo=viejo-residuo.xlsx`, 'application/x-www-form-urlencoded'))
    expect(ok.headers['location']).toContain('retirado')
    expect(o.retire).toHaveBeenCalledWith(SLOTS[0], 'viejo-residuo.xlsx', STEWARD)
    const mal = await go(admin, mockReq('POST', '/admin/dominio/cartera/cargas', STEWARD, `_csrf=${token}&slot=saldos&accion=retire&archivo=../otra/cosa`, 'application/x-www-form-urlencoded'))
    expect(decodeURIComponent(mal.headers['location'] ?? '')).toContain('Error')
    expect(o.retire).toHaveBeenCalledTimes(1) // el traversal NO llegó a ops
  })

  it('POST restore: solo rutas de _processed/; el traversal se rechaza', async () => {
    const o = ops()
    const admin = await mkAdmin(o)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const ok = await go(admin, mockReq('POST', '/admin/dominio/cartera/cargas', STEWARD, `_csrf=${token}&slot=saldos&accion=restore&archivo=${encodeURIComponent('Files/intake/_processed/W28/saldos VH WK28.xlsx')}`, 'application/x-www-form-urlencoded'))
    expect(decodeURIComponent(ok.headers['location'] ?? '')).toContain('reactivado')
    const mal = await go(admin, mockReq('POST', '/admin/dominio/cartera/cargas', STEWARD, `_csrf=${token}&slot=saldos&accion=restore&archivo=${encodeURIComponent('Files/otra/cosa.xlsx')}`, 'application/x-www-form-urlencoded'))
    expect(decodeURIComponent(mal.headers['location'] ?? '')).toContain('Error')
    expect(o.restore).toHaveBeenCalledTimes(1)
  })

  it('fallos de OneLake/motor no rompen la página (secciones degradadas, 200 igual)', async () => {
    const admin = await mkAdmin(ops({
      runs: async () => { throw new Error('motor caído') },
      landing: async () => { throw new Error('onelake caído') },
      archived: async () => { throw new Error('onelake caído') },
      log: async () => { throw new Error('onelake caído') },
      history: async () => { throw new Error('audit ilegible') },
    }))
    const res = await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('No se pudo listar el landing')
  })

  it('un no-steward no accede a la consola del dominio', async () => {
    const admin = await mkAdmin(ops())
    const res = await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', 'intruso@x.cl'))
    expect(res.statusCode).toBe(403)
  })
})

// ─── Dedup por contenido (issue #62) + badge «sin cambios en el dato» ───────
const mpOne = (fields: Record<string, string>, filename: string, bytes: Buffer): { body: Buffer; ct: string } => {
  const B = 'testboundary62'
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from('\r\n'))
  parts.push(Buffer.from(`--${B}--\r\n`))
  return { body: Buffer.concat(parts), ct: `multipart/form-data; boundary=${B}` }
}
const mockReqBuf = (method: string, url: string, user: string, body: Buffer, ct: string): IncomingMessage => {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url; r.method = method; r.headers = { 'x-test-user': user, 'content-type': ct }
  return r
}

describe('admin-cargas · dedup por contenido (issue #62)', () => {
  it('carga idéntica a una previa → audit con sha256 + dupOf y aviso en el redirect (sin bloquear)', async () => {
    const bytes = Buffer.from('mismo-contenido-exacto')
    const { createHash } = await import('node:crypto')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const audit: LogEventInput[] = []
    const o = ops({ history: async () => [{ ...HISTORY[0], sha256: sha }] })
    const admin = await mkAdmin(o, audit)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const mp = mpOne({ _csrf: token }, 'copia (1) (1).xlsx', bytes)
    const res = await go(admin, mockReqBuf('POST', '/admin/dominio/cartera/intake/saldos', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303) // avisa, NO bloquea: la carga entra igual
    expect(decodeURIComponent(res.headers['location'] ?? '')).toContain('idéntico a saldos VH WK28.xlsx')
    const ev = audit.find((e) => (e as { type?: string }).type === 'intake') as { sha256?: string; dupOf?: string }
    expect(ev.sha256).toBe(sha)
    expect(ev.dupOf).toContain('saldos VH WK28.xlsx')
  })

  it('carga con contenido NUEVO → sha256 registrado, sin dupOf ni aviso', async () => {
    const audit: LogEventInput[] = []
    const o = ops({ history: async () => [{ ...HISTORY[0], sha256: 'otra-cosa' }] })
    const admin = await mkAdmin(o, audit)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const mp = mpOne({ _csrf: token }, 'nuevo.xlsx', Buffer.from('contenido-distinto'))
    const res = await go(admin, mockReqBuf('POST', '/admin/dominio/cartera/intake/saldos', STEWARD, mp.body, mp.ct))
    expect(decodeURIComponent(res.headers['location'] ?? '')).not.toContain('idéntico')
    const ev = audit.find((e) => (e as { type?: string }).type === 'intake') as { sha256?: string; dupOf?: string }
    expect(ev.sha256).toHaveLength(64)
    expect(ev.dupOf).toBeUndefined()
  })

  it('timeline marca la carga duplicada con el aviso', () => {
    const t = timeline([{ ...HISTORY[0], dupOf: 'original.xlsx · 2026-07-13 16:17 UTC' }], [])
    expect(t[0].html).toContain('contenido idéntico a original.xlsx')
    expect(t[0].html).toContain('re-procesarlo no cambia el dato')
  })

  it('badge «sin cambios en el dato» cuando el log de la corrida Completed trae el marcador [delta]', async () => {
    const admin = await mkAdmin(ops({ log: async () => '[ingest] DONE commit\n[delta] sin cambios en el dato' }))
    const res = await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    expect(res.body).toContain('sin cambios en el dato')
  })
})

// ─── «Revertir esta carga» (issue #63) ──────────────────────────────────────
describe('admin-cargas · revertir esta carga (issue #63)', () => {
  const RUTA = 'Files/intake/_processed/W28/saldos VH WK28.xlsx'

  it('revert compensada: ejecuta ops.revert, audita intake-revert y anuncia la re-materialización', async () => {
    const audit: LogEventInput[] = []
    const o = ops({ revert: vi.fn(async () => ({ clave: 'W28', compensada: true, reactivado: 'saldos-v1.xlsx' })) })
    const admin = await mkAdmin(o, audit)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const res = await go(admin, mockReq('POST', '/admin/dominio/cartera/cargas', STEWARD, `_csrf=${token}&slot=saldos&accion=revert&archivo=${encodeURIComponent(RUTA)}`, 'application/x-www-form-urlencoded'))
    const msg = decodeURIComponent(res.headers['location'] ?? '')
    expect(msg).toContain('Carga revertida')
    expect(msg).toContain('estado anterior')
    expect(o.revert).toHaveBeenCalledWith(SLOTS[0], RUTA, STEWARD)
    const ev = audit.find((e) => (e as { type?: string }).type === 'intake-revert') as { clave?: string; compensada?: boolean }
    expect(ev.clave).toBe('W28')
    expect(ev.compensada).toBe(true)
  })

  it('revert sin versión previa → aviso honesto de dato sin origen', async () => {
    const o = ops({ revert: vi.fn(async () => ({ clave: 'W28', compensada: false })) })
    const admin = await mkAdmin(o)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const res = await go(admin, mockReq('POST', '/admin/dominio/cartera/cargas', STEWARD, `_csrf=${token}&slot=saldos&accion=revert&archivo=${encodeURIComponent(RUTA)}`, 'application/x-www-form-urlencoded'))
    const msg = decodeURIComponent(res.headers['location'] ?? '')
    expect(msg).toContain('sin origen')
    expect(msg).toContain('compensación del pipeline')
  })

  it('revert con traversal o fuera de _processed/ → rechazado sin llegar a ops', async () => {
    const o = ops({ revert: vi.fn(async () => ({ clave: '', compensada: false })) })
    const admin = await mkAdmin(o)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const res = await go(admin, mockReq('POST', '/admin/dominio/cartera/cargas', STEWARD, `_csrf=${token}&slot=saldos&accion=revert&archivo=${encodeURIComponent('Files/otra/cosa.xlsx')}`, 'application/x-www-form-urlencoded'))
    expect(decodeURIComponent(res.headers['location'] ?? '')).toContain('Error')
    expect(o.revert).not.toHaveBeenCalled()
  })

  it('la consola ofrece el botón Revertir en el histórico de procesados', async () => {
    const admin = await mkAdmin(ops({ revert: async () => ({ clave: '', compensada: false }) }))
    const res = await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    expect(res.body).toContain('>Revertir</button>')
  })
})
