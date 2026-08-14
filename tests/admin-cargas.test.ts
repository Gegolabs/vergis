import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminHandler } from '../server/admin'
import { timeline, esResiduo, lastCompletedStart, diagnosticoDeFalla, LOG_ANEJO_TITULAR, type CargasOps, type IntakeUploadEvent } from '../server/admin-cargas'
import { parseMasterDataConfig, parseDomainsConfig, parseIntakeConfig, SqliteMasterDataStore, SqliteAdminStore, SqliteGovernanceStore, type RunRecord, type OneLakeEntry, type IntakeUploadStore, type RevertPlan } from '@vergis/capabilities'
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

/** El log como lo devuelve el wiring (#86): contenido + mtime opcional del archivo. */
const mkLog = (text: string, lastModified?: string): CargasOps['log'] => async () => ({ text, lastModified })

function ops(over: Partial<CargasOps> = {}): CargasOps {
  return {
    history: async () => HISTORY,
    runs: async () => RUNS,
    log: mkLog('[ingest] ✔ DONE commit W28: 7626 filas'),
    landing: async () => LANDING,
    archived: async () => ARCHIVED,
    rerun: vi.fn(async () => {}),
    retire: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    ...over,
  }
}

/** El arnés: el registro de cargas (#62) es parte del wiring normal, así que va inyectado. */
async function mkAdmin(cargas: CargasOps, audit: LogEventInput[] = [], intakeUploads?: IntakeUploadStore): Promise<AdminHandler> {
  return createAdmin({
    entities: ENTITIES,
    mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
    adminStore: await SqliteAdminStore.open(null, [ADMIN]),
    domains: DOMAINS,
    intakeSlots: SLOTS,
    intake: { put: async () => {} },
    cargas,
    intakeUploads: intakeUploads ?? (await SqliteGovernanceStore.open(null, {})),
    identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
    audit: (e) => audit.push(e),
    secret: SECRET,
  })
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

// ─── El diagnóstico del log como titular de la falla (issue #85) ────────────
const LOG_ABORTADO = [
  '[ingest] ▶ inicio',
  '[ingest] ⚠ hoja «Resumen» ignorada',
  '[ingest] ✖ ABORTADO: archivo sin filas de datos (1 filas)',
].join('\n')

const RUNS_FALLIDA: RunRecord[] = [
  { startedAt: '2026-07-14T09:00:00Z', endedAt: '2026-07-14T09:00:20Z', status: 'Failed', error: 'Job failed during run time with state=[dead].' },
  ...RUNS,
]
/** Lo visible SIN expandir el log (todo lo anterior al `<details>` del log). */
const antesDelLog = (html: string): string => html.split('Log de la última conversión')[0]

describe('admin-cargas · diagnóstico de la falla (issue #85)', () => {
  it('diagnosticoDeFalla: última línea ✖, sin prefijo de canal; ignora ⚠/✔; null sin marcador', () => {
    expect(diagnosticoDeFalla(LOG_ABORTADO)).toBe('✖ ABORTADO: archivo sin filas de datos (1 filas)')
    expect(diagnosticoDeFalla('[ingest] ✖ ERROR no controlado: KeyError: «clave»'))
      .toBe('✖ ERROR no controlado: KeyError: «clave»')
    expect(diagnosticoDeFalla('[ingest] ⚠ aviso\n[ingest] ✔ DONE commit: 10 filas')).toBeNull()
    expect(diagnosticoDeFalla(null)).toBeNull()
    expect(diagnosticoDeFalla('')).toBeNull()
  })

  it('diagnosticoDeFalla: con varias ✖ gana la última, y trunca lo muy largo', () => {
    expect(diagnosticoDeFalla('[ingest] ✖ ABORTADO: primera\n[ingest] ✖ ABORTADO: segunda')).toBe('✖ ABORTADO: segunda')
    const largo = diagnosticoDeFalla(`[ingest] ✖ ABORTADO: ${'x'.repeat(500)}`)!
    expect(largo).toHaveLength(301)
    expect(largo.endsWith('…')).toBe(true)
  })

  it('corrida fallida con ✖ en el log → el motivo es titular visible sin expandir; state=[dead] queda de detalle', async () => {
    const admin = await mkAdmin(ops({ runs: async () => RUNS_FALLIDA, log: mkLog(LOG_ABORTADO) }))
    const res = await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    const visible = antesDelLog(res.body)
    expect(visible).toContain('✖ ABORTADO: archivo sin filas de datos (1 filas)')
    expect(visible).toContain('state=[dead]')
  })

  it('corrida fallida SIN ✖ en el log → comportamiento anterior intacto (solo el estado genérico)', async () => {
    const admin = await mkAdmin(ops({ runs: async () => RUNS_FALLIDA, log: mkLog('[ingest] ▶ inicio') }))
    const visible = antesDelLog((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    expect(visible).toContain('state=[dead]')
    expect(visible).not.toContain('✖ ABORTADO')
  })

  it('corrida Completed con ✖ residual de una corrida vieja → NO hay titular de falla', async () => {
    const admin = await mkAdmin(ops({ log: mkLog(LOG_ABORTADO) })) // RUNS[0] = Completed
    const visible = antesDelLog((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    expect(visible).not.toContain('ABORTADO')
    expect(visible).toContain('✓ Listo')
  })

  it('timeline: solo la corrida Falló MÁS RECIENTE toma el diagnóstico; las históricas no', () => {
    const diag = '✖ ABORTADO: archivo sin filas de datos (1 filas)'
    const t = timeline([], RUNS_FALLIDA, 30, diag)
    expect(t[0].html).toContain(diag) // la más reciente (Failed)
    expect(t[0].html).toContain('state=[dead]') // el genérico degradado a sub
    expect(t[2].html).not.toContain(diag) // la Failed histórica conserva su render
    expect(t[2].html).toContain('state=[dead]')
  })
})

// ─── Degradación honesta con el log añejo (issue #86) ───────────────────────
/** Lo visible SIN expandir el log, cuando el `<details>` avisa que el log es de otra corrida. */
const antesDelLogAñejo = (html: string): string => html.split('Log de una corrida anterior')[0]

describe('admin-cargas · log añejo: el job murió sin escribirlo (issue #86)', () => {
  it('(a) Failed + log con mtime ANTERIOR al inicio → titular honesto, sin el ✖ viejo, log rotulado «corrida anterior»', async () => {
    // La corrida arranca 09:00; el log quedó escrito el día antes ⇒ es de la corrida previa.
    const admin = await mkAdmin(ops({ runs: async () => RUNS_FALLIDA, log: mkLog(LOG_ABORTADO, '2026-07-13T16:19:00Z') }))
    const body = (await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body
    const visible = antesDelLogAñejo(body)
    expect(visible).toContain(LOG_ANEJO_TITULAR)
    expect(visible).not.toContain('ABORTADO') // el ✖ viejo NO se presenta como diagnóstico actual
    expect(visible).toContain('state=[dead]') // el estado genérico sigue de sub
    expect(body).toContain('Log de una corrida anterior') // el log sigue disponible, rotulado
    expect(body).not.toContain('Log de la última conversión')
    expect(body).toContain('ABORTADO') // …y su contenido íntegro dentro del <details>
  })

  it('(a·timeline) la fila Failed más reciente usa la misma regla y el mismo texto', async () => {
    const admin = await mkAdmin(ops({ runs: async () => RUNS_FALLIDA, log: mkLog(LOG_ABORTADO, '2026-07-13T16:19:00Z') }))
    const body = (await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body
    // La tabla de Actividad, aislada (el `<h3>` la abre; «Landing» abre la siguiente sección).
    const actividad = (body.split('<h3 class="sub">Actividad</h3>')[1] ?? '').split('<h3 class="sub">Landing')[0]
    expect(actividad).toContain(LOG_ANEJO_TITULAR)
    expect(actividad).not.toContain('ABORTADO')
  })

  it('(b) Failed + log con mtime POSTERIOR al inicio → comportamiento #85 (el ✖ titula)', async () => {
    const admin = await mkAdmin(ops({ runs: async () => RUNS_FALLIDA, log: mkLog(LOG_ABORTADO, '2026-07-14T09:00:10Z') }))
    const body = (await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body
    const visible = antesDelLog(body)
    expect(visible).toContain('✖ ABORTADO: archivo sin filas de datos (1 filas)')
    expect(visible).not.toContain(LOG_ANEJO_TITULAR)
    expect(body).toContain('Log de la última conversión')
  })

  it('(c) Failed + mtime ausente → fail-safe: comportamiento #85 idéntico', async () => {
    const admin = await mkAdmin(ops({ runs: async () => RUNS_FALLIDA, log: async () => ({ text: LOG_ABORTADO, lastModified: undefined }) }))
    const body = (await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body
    const visible = antesDelLog(body)
    expect(visible).toContain('✖ ABORTADO: archivo sin filas de datos (1 filas)')
    expect(visible).not.toContain(LOG_ANEJO_TITULAR)
    expect(body).toContain('Log de la última conversión')
  })

  it('(d) Completed + log añejo → ninguna marca de añejez (el gate es por Failed)', async () => {
    const admin = await mkAdmin(ops({ log: mkLog(LOG_ABORTADO, '2026-07-01T10:00:00Z') })) // RUNS[0] = Completed
    const body = (await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body
    expect(body).not.toContain(LOG_ANEJO_TITULAR)
    expect(body).toContain('Log de la última conversión')
    expect(antesDelLog(body)).toContain('✓ Listo')
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
    // #178 · la acción vuelve a SU casilla (no al tope de la consola): el slot va en la URL.
    expect(res.headers['location']).toContain('/cargas?slot=saldos&msg=')
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

/** Multipart con VARIOS archivos (lote): el dedup interno del lote se juega acá. */
const mpMany = (fields: Record<string, string>, files: { filename: string; bytes: Buffer }[]): { body: Buffer; ct: string } => {
  const B = 'testboundary62'
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  for (const f of files) {
    parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.bytes, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${B}--\r\n`))
  return { body: Buffer.concat(parts), ct: `multipart/form-data; boundary=${B}` }
}
const shaOf = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const subir = async (admin: AdminHandler, token: string, filename: string, bytes: Buffer) => {
  const mp = mpOne({ _csrf: token }, filename, bytes)
  return go(admin, mockReqBuf('POST', '/admin/dominio/cartera/intake/saldos', STEWARD, mp.body, mp.ct))
}

describe('admin-cargas · dedup por contenido contra el registro de cargas (issue #62)', () => {
  it('(a) mismo byte-a-byte con NOMBRE distinto → dupOf en el audit, dup_of en el store, aviso sin bloquear', async () => {
    const bytes = Buffer.from('mismo-contenido-exacto')
    const audit: LogEventInput[] = []
    const store = await SqliteGovernanceStore.open(null, {})
    const admin = await mkAdmin(ops(), audit, store)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const primera = await subir(admin, token, 'saldos VH WK28.xlsx', bytes)
    expect(decodeURIComponent(primera.headers['location'] ?? '')).not.toContain('idéntico')
    const segunda = await subir(admin, token, 'copia (1) (1).xlsx', bytes)
    expect(segunda.statusCode).toBe(303) // avisa, NO bloquea: la carga entra igual
    expect(decodeURIComponent(segunda.headers['location'] ?? '')).toContain('idéntico a saldos VH WK28.xlsx')
    const evs = audit.filter((e) => (e as { type?: string }).type === 'intake') as { sha256?: string; dupOf?: string }[]
    expect(evs[0].sha256).toBe(shaOf(bytes))
    expect(evs[0].dupOf).toBeUndefined()
    expect(evs[1].dupOf).toContain('saldos VH WK28.xlsx')
    const rows = await store.listUploads('saldos', 10)
    expect(rows).toHaveLength(2)
    const original = rows.find((r) => r.filename === 'saldos VH WK28.xlsx')!
    expect(rows.find((r) => r.filename === 'copia (1) (1).xlsx')!.dupOfId).toBe(original.id)
    await store.close()
  })

  it('(b) contenido distinto → sha256 registrado, sin dupOf ni aviso', async () => {
    const audit: LogEventInput[] = []
    const store = await SqliteGovernanceStore.open(null, {})
    const admin = await mkAdmin(ops(), audit, store)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    await subir(admin, token, 'previo.xlsx', Buffer.from('contenido-previo'))
    const res = await subir(admin, token, 'nuevo.xlsx', Buffer.from('contenido-distinto'))
    expect(decodeURIComponent(res.headers['location'] ?? '')).not.toContain('idéntico')
    const ev = audit.filter((e) => (e as { type?: string }).type === 'intake')[1] as { sha256?: string; dupOf?: string }
    expect(ev.sha256).toHaveLength(64)
    expect(ev.dupOf).toBeUndefined()
    expect((await store.listUploads('saldos', 10)).every((r) => r.dupOfId === undefined)).toBe(true)
    await store.close()
  })

  it('(c) el duplicado contra una fila del indexado retroactivo dice «procesado el»', async () => {
    const bytes = Buffer.from('lo-que-ya-estaba-en-_processed')
    const audit: LogEventInput[] = []
    const store = await SqliteGovernanceStore.open(null, {})
    await store.recordUpload({
      slotId: 'saldos', filename: 'saldos VH WK25.xlsx', sha256: shaOf(bytes), bytes: bytes.length,
      uploadedBy: '(retro: _processed)', uploadedAt: '2026-06-22T11:03:00Z', ok: true, triggered: false, origen: 'retro',
    })
    const admin = await mkAdmin(ops(), audit, store)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const res = await subir(admin, token, 'saldos VH WK25 (1).xlsx', bytes)
    const msg = decodeURIComponent(res.headers['location'] ?? '')
    expect(msg).toContain('idéntico a saldos VH WK25.xlsx · procesado el 2026-06-22 11:03 UTC')
    const ev = audit.find((e) => (e as { type?: string }).type === 'intake') as { dupOf?: string }
    expect(ev.dupOf).toContain('procesado el')
    await store.close()
  })

  it('(d) dos archivos IDÉNTICOS en el mismo lote: el segundo ve al primero ya registrado', async () => {
    const bytes = Buffer.from('mismo-contenido-en-el-lote')
    const audit: LogEventInput[] = []
    const store = await SqliteGovernanceStore.open(null, {})
    const admin = await mkAdmin(ops(), audit, store)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const mp = mpMany({ _csrf: token }, [{ filename: 'a.xlsx', bytes }, { filename: 'a (1).xlsx', bytes }])
    const res = await go(admin, mockReqBuf('POST', '/admin/dominio/cartera/intake/saldos', STEWARD, mp.body, mp.ct))
    expect(res.statusCode).toBe(303)
    expect(decodeURIComponent(res.headers['location'] ?? '')).toContain('«a (1).xlsx» es idéntico a a.xlsx')
    const rows = await store.listUploads('saldos', 10)
    expect(rows.find((r) => r.filename === 'a (1).xlsx')!.dupOfId).toBe(rows.find((r) => r.filename === 'a.xlsx')!.id)
    await store.close()
  })

  it('(e) precheck: JSON con la carga original del sha duplicado; sha desconocido → dups vacío; CSRF inválido → 403', async () => {
    const bytes = Buffer.from('contenido-ya-procesado')
    const store = await SqliteGovernanceStore.open(null, {})
    const admin = await mkAdmin(ops(), [], store)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    await subir(admin, token, 'saldos VH WK28.xlsx', bytes)
    const sha = shaOf(bytes)
    const pc = await go(admin, mockReq('POST', '/admin/dominio/cartera/intake/saldos/precheck', STEWARD, `_csrf=${token}&shas=${sha}`, 'application/x-www-form-urlencoded'))
    expect(pc.statusCode).toBe(200)
    expect(pc.headers['content-type']).toContain('application/json')
    const j = JSON.parse(pc.body) as { dups: { sha256: string; filename: string; uploadedAt: string; origen: string }[] }
    expect(j.dups).toHaveLength(1)
    expect(j.dups[0]).toMatchObject({ sha256: sha, filename: 'saldos VH WK28.xlsx', origen: 'upload' })
    expect(Date.parse(j.dups[0].uploadedAt)).not.toBeNaN()
    // sha desconocido (y basura, que se ignora sin romper) → nada que avisar
    const vacio = await go(admin, mockReq('POST', '/admin/dominio/cartera/intake/saldos/precheck', STEWARD, `_csrf=${token}&shas=${'f'.repeat(64)},basura`, 'application/x-www-form-urlencoded'))
    expect(JSON.parse(vacio.body)).toEqual({ dups: [] })
    const malCsrf = await go(admin, mockReq('POST', '/admin/dominio/cartera/intake/saldos/precheck', STEWARD, `_csrf=nope&shas=${sha}`, 'application/x-www-form-urlencoded'))
    expect(malCsrf.statusCode).toBe(403)
    await store.close()
  })

  it('(f) la subida NUNCA se rechaza por duplicada: 303 siempre, y el archivo aterriza igual', async () => {
    const bytes = Buffer.from('re-materializacion-legitima')
    const puestos: string[] = []
    const store = await SqliteGovernanceStore.open(null, {})
    const admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      intakeSlots: SLOTS,
      intake: { put: async (_t, filename) => { puestos.push(filename) } },
      cargas: ops(),
      intakeUploads: store,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    for (const n of ['uno.xlsx', 'dos.xlsx', 'tres.xlsx']) expect((await subir(admin, token, n, bytes)).statusCode).toBe(303)
    expect(puestos).toEqual(['uno.xlsx', 'dos.xlsx', 'tres.xlsx'])
    await store.close()
  })

  it('sin store inyectado el flujo degrada: sube igual, sin dedup, y el precheck responde dups vacío', async () => {
    const audit: LogEventInput[] = []
    const admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      intakeSlots: SLOTS,
      intake: { put: async () => {} },
      cargas: ops(),
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: (e) => audit.push(e),
      secret: SECRET,
    })
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const bytes = Buffer.from('sin-store')
    await subir(admin, token, 'a.xlsx', bytes)
    const res = await subir(admin, token, 'a (1).xlsx', bytes)
    expect(res.statusCode).toBe(303)
    expect(decodeURIComponent(res.headers['location'] ?? '')).not.toContain('idéntico')
    const pc = await go(admin, mockReq('POST', '/admin/dominio/cartera/intake/saldos/precheck', STEWARD, `_csrf=${token}&shas=${shaOf(bytes)}`, 'application/x-www-form-urlencoded'))
    expect(JSON.parse(pc.body)).toEqual({ dups: [] })
  })

  it('una subida rechazada por validación queda registrada (ok=0, con su motivo)', async () => {
    const store = await SqliteGovernanceStore.open(null, {})
    const admin = await mkAdmin(ops(), [], store)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const res = await subir(admin, token, 'gigante.xlsx', Buffer.alloc(2048)) // maxBytes del slot = 1024
    expect(decodeURIComponent(res.headers['location'] ?? '')).toContain('Error')
    const rows = await store.listUploads('saldos', 10)
    expect(rows).toHaveLength(1)
    expect(rows[0].ok).toBe(false)
    expect(rows[0].error).toBeTruthy()
    // Un rechazo NO es la «original» de nadie: el dedup no lo cita.
    expect(await store.findUploadBySha('saldos', rows[0].sha256)).toBeNull()
    await store.close()
  })

  it('el form trae el pre-check en el cliente (SHA-256 + POST al /precheck del slot)', async () => {
    const admin = await mkAdmin(ops())
    const body = (await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body
    expect(body).toContain("crypto.subtle.digest('SHA-256'")
    expect(body).toContain("f.action+'/precheck'")
    expect(body).toContain('¿Continuar?')
  })

  it('timeline marca la carga duplicada con el aviso', () => {
    const t = timeline([{ ...HISTORY[0], dupOf: 'original.xlsx · 2026-07-13 16:17 UTC' }], [])
    expect(t[0].html).toContain('contenido idéntico a original.xlsx')
    expect(t[0].html).toContain('re-procesarlo no cambia el dato')
  })
})

// ─── «Delta neto cero»: la señal de que la corrida no cambió el dato (issue #62) ──
/** La tabla de Actividad, aislada del resto de la página. */
const actividadDe = (html: string): string => (html.split('<h3 class="sub">Actividad</h3>')[1] ?? '').split('<h3 class="sub">Landing')[0]

describe('admin-cargas · delta neto cero (issue #62)', () => {
  const LOG_DELTA = '[ingest] ✔ DONE commit W28: 7626 filas\n[delta] sin cambios en el dato'

  it('(a) Completed + marcador [delta] → señalado en «Última conversión» Y en la fila de Conversión del timeline', async () => {
    const admin = await mkAdmin(ops({ log: mkLog(LOG_DELTA, '2026-07-13T16:20:00Z') })) // RUNS[0] arranca 16:17:47
    const body = (await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body
    expect(antesDelLog(body)).toContain('sin cambios en el dato')
    expect(actividadDe(body)).toContain('sin cambios en el dato')
  })

  it('(b) log AÑEJO (mtime anterior al inicio de la corrida) → en ninguna: el marcador es de otra corrida', async () => {
    const admin = await mkAdmin(ops({ log: mkLog(LOG_DELTA, '2026-07-01T10:00:00Z') }))
    const body = (await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body
    expect(antesDelLog(body)).not.toContain('sin cambios en el dato')
    expect(actividadDe(body)).not.toContain('sin cambios en el dato')
  })

  it('(c) corrida Failed con el marcador en el log → en ninguna', async () => {
    const admin = await mkAdmin(ops({ runs: async () => RUNS_FALLIDA, log: mkLog(LOG_DELTA, '2026-07-14T09:00:10Z') }))
    const body = (await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body
    expect(antesDelLog(body)).not.toContain('sin cambios en el dato')
    expect(actividadDe(body)).not.toContain('sin cambios en el dato')
  })

  it('(d) sin mtime → fail-safe: el marcador vale (no se afirma añejez)', async () => {
    const admin = await mkAdmin(ops({ log: mkLog(LOG_DELTA) }))
    const body = (await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body
    expect(antesDelLog(body)).toContain('sin cambios en el dato')
    expect(actividadDe(body)).toContain('sin cambios en el dato')
  })

  it('timeline: la señal solo puede ir en runs[0] Completed', () => {
    expect(timeline([], RUNS, 30, null, true)[0].html).toContain('sin cambios en el dato')
    expect(timeline([], RUNS, 30, null, true)[1].html).not.toContain('sin cambios en el dato')
    expect(timeline([], RUNS_FALLIDA, 30, null, true)[0].html).not.toContain('sin cambios en el dato') // Failed
    expect(timeline([], RUNS, 30, null, false)[0].html).not.toContain('sin cambios en el dato')
  })
})

// ─── «Revertir esta carga» (issue #63): plan sellado + compensación por clave ──
const RUTA = 'Files/intake/_processed/W28/saldos VH WK28.xlsx'
const PLAN: RevertPlan = {
  slotId: 'saldos', uploadId: 7, filename: 'saldos VH WK28.xlsx', sha256: 'f'.repeat(64),
  claves: [
    { clave: 'W28', accion: 'rematerializar', revertido: RUTA, previa: 'Files/intake/_processed/W28/v1.xlsx' },
    { clave: 'W29', accion: 'pisada', revertido: 'Files/intake/_processed/W29/saldos VH WK28.xlsx', vigente: 'Files/intake/_processed/W29/otra.xlsx', vigenteAt: '2026-07-20T09:00:00Z' },
    { clave: 'W30', accion: 'vaciar', revertido: 'Files/intake/_processed/W30/saldos VH WK28.xlsx' },
    { clave: 'W31', accion: 'no-compensable', revertido: 'Files/intake/_processed/W31/saldos VH WK28.xlsx' },
  ],
  landing: ['Files/intake/saldos/saldos VH WK28.xlsx'],
  ejecutable: true,
  hash: 'a1b2c3',
}
const opsRevert = (over: Partial<CargasOps> = {}): CargasOps => ops({
  history: async () => [{ ...HISTORY[0], id: 7, sha256: 'f'.repeat(64) }],
  revertPlan: vi.fn(async () => PLAN),
  revertExec: vi.fn(async () => ({
    ok: true as const,
    result: { resumen: PLAN.claves, landingRetirado: true, convirtiendo: true, filename: PLAN.filename, uploadId: 7 },
  })),
  ...over,
})
const postCargas = async (admin: AdminHandler, token: string, body: string) =>
  go(admin, mockReq('POST', '/admin/dominio/cartera/cargas', STEWARD, `_csrf=${token}&slot=saldos&${body}`, 'application/x-www-form-urlencoded'))

describe('admin-cargas · revertir esta carga (issue #63)', () => {
  it('(a) la fila 📤 con id y sha ofrece «Revertir esta carga»; sin id o sin sha, no', async () => {
    const conAncla = await go(await mkAdmin(opsRevert()), mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    expect(conAncla.body).toContain('>Revertir esta carga<')
    expect(conAncla.body).toContain('name="upload" value="7"')
    // Sin sha (carga migrada) o sin id: la identidad no es verificable ⇒ no se ofrece revertir.
    const sinSha = await go(await mkAdmin(opsRevert({ history: async () => [{ ...HISTORY[0], id: 7 }] })), mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    expect(sinSha.body).not.toContain('>Revertir esta carga<')
    const sinId = await go(await mkAdmin(opsRevert({ history: async () => [{ ...HISTORY[0], sha256: 'f'.repeat(64) }] })), mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    expect(sinId.body).not.toContain('>Revertir esta carga<')
  })

  it('(b) revert-plan responde 200 con el plan (no redirect), con el texto sellado de cada clave', async () => {
    const o = opsRevert()
    const admin = await mkAdmin(o)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const res = await postCargas(admin, token, 'accion=revert-plan&upload=7')
    expect(res.statusCode).toBe(200)
    expect(res.headers['location']).toBeUndefined()
    expect(o.revertPlan).toHaveBeenCalledWith(SLOTS[0], { uploadId: 7 })
    expect(res.body).toContain('la clave «W28» vuelve a su versión anterior: se re-materializa «v1.xlsx»')
    expect(res.body).toContain('la clave «W30» queda VACÍA — esta carga la introdujo')
    expect(res.body).toContain('la clave «W31» NO se puede vaciar desde acá')
    expect(res.body).toContain('sin efecto: la clave «W29» fue pisada por una carga posterior («otra.xlsx»')
    expect(res.body).toContain('la copia en el landing se retira')
    // El form de ejecución va sellado por el hash del plan que el operador acaba de leer.
    expect(res.body).toContain('name="hash" value="a1b2c3"')
    expect(res.body).toContain('name="accion" value="revert-exec"')
  })

  it('(b·bis) un plan sin acciones con efecto no ofrece ejecutar nada', async () => {
    const inerte: RevertPlan = { ...PLAN, claves: [PLAN.claves[1]], landing: [], ejecutable: false }
    const admin = await mkAdmin(opsRevert({ revertPlan: async () => inerte }))
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const res = await postCargas(admin, token, 'accion=revert-plan&upload=7')
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('revert-exec')
    expect(res.body).toContain('Nada que revertir')
  })

  it('(c) revert-exec ok → 303 con «Reversión ejecutada» y audit intake-revert con las claves', async () => {
    const audit: LogEventInput[] = []
    const o = opsRevert()
    const admin = await mkAdmin(o, audit)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const res = await postCargas(admin, token, 'accion=revert-exec&upload=7&hash=a1b2c3')
    expect(res.statusCode).toBe(303)
    const msg = decodeURIComponent(res.headers['location'] ?? '')
    expect(msg).toContain('Reversión ejecutada')
    expect(msg).toContain('«W28» vuelve a su versión anterior')
    expect(msg).toContain('«W30» queda vacía')
    expect(o.revertExec).toHaveBeenCalledWith(SLOTS[0], 'a1b2c3', { uploadId: 7 }, STEWARD)
    const ev = audit.find((e) => (e as { type?: string }).type === 'intake-revert') as { claves?: string; uploadId?: number; landingRetirado?: boolean }
    expect(ev.claves).toBe('W28:rematerializar,W29:pisada,W30:vaciar,W31:no-compensable')
    expect(ev.uploadId).toBe(7)
    expect(ev.landingRetirado).toBe(true)
  })

  it('(d) revert-exec con el estado cambiado → 200 con el plan fresco y el aviso, sin ejecutar', async () => {
    const admin = await mkAdmin(opsRevert({ revertExec: async () => ({ ok: false as const, plan: { ...PLAN, hash: 'nuevo' } }) }))
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const res = await postCargas(admin, token, 'accion=revert-exec&upload=7&hash=a1b2c3')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('El estado del slot cambió')
    expect(res.body).toContain('name="hash" value="nuevo"')
  })

  it('(e) traversal o ruta fuera de _processed/ → rechazado sin llegar a ops', async () => {
    const o = opsRevert()
    const admin = await mkAdmin(o)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    for (const ruta of ['Files/otra/cosa.xlsx', 'Files/intake/_processed/../../etc/x.xlsx']) {
      const res = await postCargas(admin, token, `accion=revert-plan&archivo=${encodeURIComponent(ruta)}`)
      expect(decodeURIComponent(res.headers['location'] ?? '')).toContain('Error')
    }
    expect(o.revertPlan).not.toHaveBeenCalled()
  })

  it('(f) un no-steward no puede revertir', async () => {
    const o = opsRevert()
    const admin = await mkAdmin(o)
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const res = await go(admin, mockReq('POST', '/admin/dominio/cartera/cargas', 'intruso@x.cl', `_csrf=${token}&slot=saldos&accion=revert-plan&upload=7`, 'application/x-www-form-urlencoded'))
    expect(res.statusCode).toBe(403)
    expect(o.revertPlan).not.toHaveBeenCalled()
  })

  it('(g) el timeline muestra la fila ↩️ Reversión con su filename y el resumen por clave', () => {
    const filas = timeline([], 'error', 30, null, false, undefined, [{
      id: 1, slotId: 'saldos', uploadId: 7, filename: 'saldos VH WK28.xlsx', byUser: STEWARD,
      at: '2026-08-06T18:00:00Z', resumen: PLAN.claves, landingRetirado: true,
    }])
    expect(filas).toHaveLength(1)
    expect(filas[0].html).toContain('↩️ Reversión')
    expect(filas[0].html).toContain('saldos VH WK28.xlsx')
    expect(filas[0].html).toContain(STEWARD)
    expect(filas[0].html).toContain('la clave «W28» vuelve a su versión anterior')
    expect(filas[0].html).toContain('la copia en el landing se retira')
  })

  it('(h) el botón del histórico de procesados postea revert-plan con la ruta archivada', async () => {
    const res = await go(await mkAdmin(opsRevert()), mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    expect(res.body).toContain('>Revertir</button>')
    expect(res.body).toContain('value="revert-plan"')
    expect(res.body).toContain('name="archivo" value="Files/intake/_processed/W28/saldos VH WK28.xlsx"')
  })

  it('sin la operación cableada, revertir se declara no disponible (no rompe la página)', async () => {
    const admin = await mkAdmin(ops())
    const token = tokenFrom((await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))).body)
    const res = await postCargas(admin, token, 'accion=revert-plan&upload=7')
    expect(decodeURIComponent(res.headers['location'] ?? '')).toContain('no está disponible en esta instancia')
  })

  // Issue #99: desde CADA corrida listada (no solo la última) se llega a su log.
  it('#99 · con runLogs cableado, cada conversión del timeline y la «Última conversión» enlazan «Ver log»', async () => {
    const admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      intakeSlots: SLOTS,
      intake: { put: async () => {} },
      cargas: ops(),
      runLogs: { refOf: async () => null, list: async () => [], read: async () => null, runsOf: async () => [] },
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const res = await go(admin, mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    // Las DOS corridas del historial, cada una con su propio arranque en el enlace.
    expect(res.body).toContain('/admin/dominio/cartera/corrida?slot=saldos&amp;started=2026-07-13T16%3A17%3A47Z')
    expect(res.body).toContain('/admin/dominio/cartera/corrida?slot=saldos&amp;started=2026-07-10T13%3A30%3A17Z')
    // La última conversión también (el enlace vive junto al estado, no solo en la tabla).
    expect(res.body.split('Última conversión')[1]).toContain('Ver log')
  })

  it('#99 · SIN runLogs, la consola no contiene ningún enlace a /corrida (regresión cero)', async () => {
    const res = await go(await mkAdmin(ops()), mockReq('GET', '/admin/dominio/cartera/cargas', STEWARD))
    expect(res.body).not.toContain('/corrida?')
  })
})
