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
  globToRegExp,
  type IntakeSlot,
  type OneLakeEntry,
  type OneLakeListing,
  type RunRecord,
} from '@vergis/capabilities'
import { describirPatron, parseFicha } from '../packages/capabilities/src/intake'
import { createAdmin, type AdminHandler, type IntakeRunner } from '../server/admin'
import { decidirDestino, enrutarPorNombre } from '../server/cargar'
import type { CargasOps } from '../server/admin-cargas'
import { createIntakeLoop, ACELERAR_VENTANA_MS, type IntakeLoopDeps } from '../server/intake-loop'
import { PAGE_CSS, TOKENS_CSS, avatarMenu } from '../server/ui'
import { indexHtml } from '../server/catalog'
import { createContractRegistry } from '../server/contract'
import { createRequestHandler } from '../server/routes'

/**
 * #269·P2 · La puerta única `/cargar` (work/269 §4, §6.1, §6.2.2). Datos SINTÉTICOS, sin personas: los
 * nombres imitan la FORMA de los reales (patrones y convenciones), no los reales.
 */

const T0 = Date.parse('2026-09-23T12:00:00Z')
const iso = (min: number): string => new Date(T0 + min * 60_000).toISOString()
const USUARIO = 'claudio.cornejo@teams.ratio.cl' // la identidad forjada del recorrido (§6.2.2)

// ─── Las palabras que la vista de usuario no dice (§4.3, §6.2.3) y el voseo (P10) ──────────────
const JERGA = [/landing/i, /slot/i, /\bSJD\b/i, /corrida/i, /conversi[oó]n/i, /materializ/i, /dbo\./i, /instancia/i, /state=\[dead\]/i, /residuo/i, /varado/i, /(?<!\p{L})log(?!\p{L})/iu]
const VOSEO = /(?<!\p{L})(tenés|podés|querés|sabés|subí|elegí|mirá|revisá|fijate|probá|hacé|reintentá|revertí|corré|conectá|asignales|registrá|respetá|borrá|escribí|esperá|subís|retiralo|seguila|buscá|observá|revisalo|omití|incluí|vos)(?!\p{L})/iu
function sinJerga(html: string): string[] {
  // Se mira lo que una persona LEE: el texto y los atributos visibles, no los identificadores del CSS.
  const visible = html.replace(/<style>[\s\S]*?<\/style>/g, '')
  return JERGA.filter((r) => r.test(visible)).map((r) => String(r))
}

// ─── Configuración sintética con la forma de la instancia ──────────────────────────────────────
const ts = { workspaceId: 'W', lakehouseId: 'L' }
const SLOTS_DISJUNTOS = {
  contacto: 'mesa@ejemplo.cl',
  slots: [
    { id: 'productos', label: 'OC · detalle de productos', domain: 'comercial', description: 'Detalle de productos de una orden de compra.', accept: '*products-details*.xlsx', target: { ...ts, path: 'Files/intake/oc' }, trigger: { processRef: 'P_OC' },
      ficha: { origen: 'Portal B2B del cliente', ejemplo: 'oc-1-products-details-01-01-2026.xlsx', regimen: 'acumula', clave: 'la OC' } },
    { id: 'distribucion', label: 'OC · distribución por local', domain: 'comercial', description: 'Distribución de una orden de compra por local.', accept: '*distributions-details*.xlsx', target: { ...ts, path: 'Files/intake/oc/dist' }, trigger: { processRef: 'P_OC' },
      ficha: { regimen: 'acumula', clave: 'la OC', requiere: [{ slot: 'productos', motivo: 'el detalle de productos de la misma OC' }, { slot: 'maestro', motivo: 'el maestro con todas sus tiendas' }] } },
    { id: 'maestro', label: 'Maestro de tiendas', domain: 'comercial', description: 'Lista de tiendas con su zona.', accept: '*Tiendas por zona*.xlsx', target: { ...ts, path: 'Files/intake/oc/maestro', processed: false }, trigger: { processRef: 'P_OC' },
      ficha: { regimen: 'reemplaza', juego: 'Todas las tiendas, no solo las nuevas' } },
    { id: 'presupuesto', label: 'Presupuesto comercial', domain: 'presupuesto', description: 'Compromisos de venta.', accept: 'Presupuesto*.xlsx', target: { ...ts, path: 'Files/intake/pres' }, trigger: { processRef: 'P_PRES' },
      meta: [{ id: 'version', label: 'Versión del presupuesto', type: 'number', required: true, ayuda: '0 es la línea base del año; 1, 2, 3… son las revisiones mensuales, en orden.' }],
      ficha: { regimen: 'version' } },
  ],
}
// La forma de HOY en producción: patrones que se pisan (cinco `*.xlsx`), sin ficha.
const SLOTS_HOY = {
  slots: [
    { id: 'productos', label: 'Productos', domain: 'comercial', accept: '*products-details*.xlsx', target: { ...ts, path: 'Files/intake/oc' } },
    { id: 'distribucion', label: 'Distribución', domain: 'comercial', accept: '*distributions-details*.xlsx', target: { ...ts, path: 'Files/intake/oc/dist' } },
    { id: 'facturas', label: 'Facturas', domain: 'facturas', accept: '*.xlsx', target: { ...ts, path: 'Files/intake/fact' } },
    { id: 'inventario', label: 'Inventario', domain: 'plantacion', accept: '*.xlsx', target: { ...ts, path: 'Files/intake/inv' } },
    { id: 'despachos', label: 'Despachos', domain: 'plantacion', accept: '*.xlsx', target: { ...ts, path: 'Files/intake/desp' } },
    { id: 'clasificacion', label: 'Clasificación', domain: 'plantacion', accept: '*.xlsx', target: { ...ts, path: 'Files/intake/clas' } },
    { id: 'presupuesto', label: 'Presupuesto', domain: 'presupuesto', accept: '*.xlsx', target: { ...ts, path: 'Files/intake/pres' } },
  ],
}
const DOMINIOS = parseDomainsConfig({ domains: ['comercial', 'presupuesto', 'facturas', 'plantacion'].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), stewards: [USUARIO] })) })
const ENTITIES = parseMasterDataConfig({ entities: [] })

// ─── El arnés: admin real + store real + un almacenamiento en memoria ──────────────────────────
interface Arnes {
  admin: AdminHandler
  store: SqliteGovernanceStore
  slots: IntakeSlot[]
  landing: Map<string, Set<string>>
  retirados: { slotId: string; filename: string; at: string }[]
  puts: { slot: string; filename: string; sidecar?: string }[]
  disparos: string[]
  acelerados: string[]
  runs: Map<string, RunRecord[]>
  audit: Record<string, unknown>[]
}
async function arnes(doc: unknown, opts: { guias?: boolean; proyeccion?: boolean } = {}): Promise<Arnes> {
  const slots = parseIntakeConfig(doc)
  const store = await SqliteGovernanceStore.open(null, {})
  const landing = new Map<string, Set<string>>()
  const retirados: Arnes['retirados'] = []
  const puts: Arnes['puts'] = []
  const disparos: string[] = []
  const acelerados: string[] = []
  const audit: Record<string, unknown>[] = []
  const runs = new Map<string, RunRecord[]>()
  const slotDe = (t: { path: string }): IntakeSlot => slots.find((s) => s.target.path === t.path)!
  const intake: IntakeRunner = {
    put: async (target, filename, _bytes, sidecar) => {
      const s = slotDe(target)
      puts.push({ slot: s.id, filename, ...(sidecar ? { sidecar } : {}) })
      if (!landing.has(s.id)) landing.set(s.id, new Set())
      landing.get(s.id)!.add(filename)
    },
    runNow: async (trigger) => { disparos.push(trigger.processRef) },
  }
  const cargas: CargasOps = {
    history: async (slot, limit) => Promise.all((await store.listUploads(slot.id, limit)).filter((r) => r.origen === 'upload').map(async (r) => ({
      intentos: r.ok && r.desenlace != null ? await store.listIntentos(r.id) : [],
      id: r.id, ts: r.uploadedAt, filename: r.filename, bytes: r.bytes, by: r.uploadedBy ?? '', ok: r.ok, triggered: r.triggered, sha256: r.sha256,
      ...(r.error != null && !r.ok ? { error: r.error } : {}), ...(r.desenlace != null ? { desenlace: r.desenlace } : {}), ...(r.desenlaceFinal != null ? { desenlaceFinal: r.desenlaceFinal } : {}),
      ...(r.desenlaceMotivo != null ? { desenlaceMotivo: r.desenlaceMotivo } : {}), ...(r.desenlaceRunStartedAt != null ? { desenlaceRunStartedAt: r.desenlaceRunStartedAt } : {}),
      ...(r.desenlaceCodigo != null ? { desenlaceCodigo: r.desenlaceCodigo } : {}), ...(r.desenlaceAt != null ? { desenlaceAt: r.desenlaceAt } : {}), ...(r.actoAt != null ? { actoAt: r.actoAt } : {}),
    }))),
    runs: async () => [], log: async () => null,
    landing: async (slot) => [...(landing.get(slot.id) ?? [])].map((f) => ({ path: `${slot.target.path}/${f}`, isDirectory: false, size: 1, lastModified: iso(0) })),
    archived: async () => [],
    rerun: async () => {},
    retire: async (slot, filename) => {
      landing.get(slot.id)?.delete(filename)
      retirados.push({ slotId: slot.id, filename, at: new Date().toISOString() })
    },
    restore: async () => {},
    codigos: async () => [],
  }
  const admin = createAdmin({
    entities: ENTITIES,
    mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
    adminStore: await SqliteAdminStore.open(null, ['admin@ejemplo.cl']),
    domains: DOMINIOS,
    intakeSlots: slots,
    intake,
    cargas,
    intakeUploads: store,
    ...(opts.guias ? { intakeGuias: [] } : {}),
    acelerarCarga: (id) => { acelerados.push(id) },
    ...(opts.proyeccion ? { intakeProyeccion: async (slot: IntakeSlot) => ({ landing: [...(landing.get(slot.id) ?? [])], runs: runs.get(slot.id) ?? [], observedAt: iso(0) }) } : {}),
    identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
    audit: (e) => audit.push(e as Record<string, unknown>),
    secret: 'secreto-de-prueba',
  })
  return { admin, store, slots, landing, retirados, puts, disparos, acelerados, runs, audit }
}

interface Res { statusCode: number; headers: Record<string, string>; body: string }
async function go(a: AdminHandler, method: string, url: string, body: Buffer | string = '', ct?: string): Promise<Res> {
  const req = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  req.url = url; req.method = method; req.headers = { 'x-test-user': USUARIO }
  if (ct) req.headers['content-type'] = ct
  const res = { statusCode: 0, headers: {} as Record<string, string>, body: '', writeHead(c: number, h?: Record<string, string>) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(c?: string) { if (c) this.body += c } }
  await a.tryHandle(req, res as unknown as ServerResponse)
  return res
}
const token = async (a: AdminHandler): Promise<string> => (await go(a, 'GET', '/cargar')).body.match(/name="_csrf" value="([0-9a-f]+)"/)![1]!
async function subir(a: AdminHandler, url: string, archivos: { nombre: string; bytes?: string }[], campos: Record<string, string> = {}): Promise<Res> {
  const B = 'b269p2'
  const partes: Buffer[] = [Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${await token(a)}\r\n`)]
  for (const [k, v] of Object.entries(campos)) partes.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  for (const f of archivos) partes.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="${f.nombre}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(f.bytes ?? `contenido de ${f.nombre}`), Buffer.from('\r\n'))
  partes.push(Buffer.from(`--${B}--\r\n`))
  return go(a, 'POST', url, Buffer.concat(partes), `multipart/form-data; boundary=${B}`)
}
async function revisar(a: AdminHandler, pagina: string, archivos: { nombre: string; bytes?: number; sha?: string }[]): Promise<Record<string, unknown>[]> {
  const body = new URLSearchParams({ _csrf: await token(a), pagina, archivos: JSON.stringify(archivos.map((x) => ({ bytes: 10, ...x }))) }).toString()
  return (JSON.parse((await go(a, 'POST', '/cargar/revisar', body, 'application/x-www-form-urlencoded')).body) as { archivos: Record<string, unknown>[] }).archivos
}
const loc = (r: Res): string => decodeURIComponent(r.headers['location'] ?? '')

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('#269·§4.4 · la ficha y el nombre esperado', () => {
  it('describirPatron dice el patrón en palabras (contiene / empieza / extensión)', () => {
    expect(describirPatron('*products-details*.xlsx')).toBe('El nombre tiene que contener «products-details» y ser un Excel (.xlsx). No importan las mayúsculas.')
    expect(describirPatron('Presupuesto*.xlsx')).toBe('El nombre tiene que empezar con «Presupuesto» y ser un Excel (.xlsx). No importan las mayúsculas.')
    expect(describirPatron('*.xlsx')).toBe('Tiene que ser un Excel (.xlsx). No importan las mayúsculas.')
    expect(describirPatron('Antig?edad de saldos *.xlsx')).toContain('(«?» es una letra cualquiera)')
    expect(describirPatron(undefined)).toBe('Puede llamarse como sea.')
  })
  it('parseFicha es estricta: clave desconocida, régimen inválido, `acumula` sin clave y `requiere` roto se acusan', () => {
    expect(parseFicha({ origen: 'X', regimen: 'reemplaza' }, 's')).toEqual({ origen: 'X', regimen: 'reemplaza' })
    expect(() => parseFicha({ origne: 'X' }, 's')).toThrow(/clave desconocida 'origne'/)
    expect(() => parseFicha({ regimen: 'suma' }, 's')).toThrow(/regimen inválido/)
    expect(() => parseFicha({ regimen: 'acumula' }, 's')).toThrow(/requiere 'clave'/)
    expect(() => parseFicha({ requiere: [{ slot: 's', motivo: 'x' }] }, 's')).toThrow(/a sí mismo/)
    expect(() => parseIntakeConfig({ slots: [{ id: 'a', target: { ...ts, path: 'Files/a' }, ficha: { requiere: [{ slot: 'fantasma', motivo: 'x' }] } }] })).toThrow(/'fantasma' no existe/)
  })
  it('`meta[].ayuda` se lee; un slot sin `ficha` sigue parseando igual (lo tolera también 0.35.1)', () => {
    const s = parseIntakeConfig(SLOTS_DISJUNTOS)
    expect(s.find((x) => x.id === 'presupuesto')!.meta![0]!.ayuda).toContain('0 es la línea base')
    expect(parseIntakeConfig(SLOTS_HOY).every((x) => x.ficha === undefined)).toBe(true)
  })
})

describe('#269·§4.1 · la decisión de la puerta (D-222: nunca más estricta que la subida con tipo)', () => {
  it('PROPIEDAD: todo nombre que algún tipo aceptaría por su patrón termina en aqui/va/elegir, nunca en `ninguno`', () => {
    const PATRONES = ['*.xlsx', '*Listado*.xlsx', '*VH*.xlsx', 'Presupuesto*.xlsx', '*products-details*.xlsx', '*distributions-details*.xlsx', '*Tiendas por zona*.xlsx', '*', 'Antig?edad de saldos *.xlsx']
    const NOMBRES = ['Listado EasyDoc VH.xlsx', 'oc-1-products-details-01-01-2026.xlsx', 'oc-1-distributions-details.xlsx', 'Presupuesto 2026.xlsx', 'Tiendas por zona X.xlsx', 'Libro1.xlsx', 'x.csv', 'Antigüedad de saldos X.xlsx']
    let n = 0
    for (const a of PATRONES) for (const b of PATRONES) {
      const tipos = parseIntakeConfig({ slots: [{ id: 'a', accept: a, target: { ...ts, path: 'Files/a' } }, { id: 'b', accept: b, target: { ...ts, path: 'Files/b' } }] })
      for (const nombre of NOMBRES) for (const pagina of [undefined, ...tipos]) {
        const alguno = tipos.some((t) => globToRegExp(t.accept!).test(nombre))
        const d = decidirDestino(tipos, nombre, pagina)
        if (alguno) expect(d.kind).not.toBe('ninguno')
        else expect(d.kind).toBe('ninguno')
        // En la página de un tipo cuyo patrón calza, el archivo va ahí aunque calce con otros (D-222).
        if (pagina && globToRegExp(pagina.accept!).test(nombre)) expect(d).toMatchObject({ kind: 'aqui', slot: pagina })
        n++
      }
    }
    expect(n).toBe(PATRONES.length ** 2 * NOMBRES.length * 3)
  })
  it('con la configuración de HOY (cinco `*.xlsx`): lo inequívoco se enruta, lo ambiguo se manda a elegir', () => {
    const tipos = parseIntakeConfig(SLOTS_HOY)
    expect(decidirDestino(tipos, 'oc-1-products-details-01-01-2026.xlsx')).toMatchObject({ kind: 'elegir' }) // también calza con los `*.xlsx`
    expect(decidirDestino(tipos, 'x.csv')).toEqual({ kind: 'ninguno' })
    const d = decidirDestino(tipos, 'Listado EasyDoc VH.xlsx')
    expect(d.kind === 'elegir' && d.candidatos.map((s) => s.id)).toEqual(['facturas', 'inventario', 'despachos', 'clasificacion', 'presupuesto'])
  })
  it('juez 0.35.1 · m2: solo cuentan los tipos del usuario (un tipo de otro dominio no vuelve ambiguo un nombre)', () => {
    const tipos = parseIntakeConfig(SLOTS_HOY)
    const comercial = tipos.filter((s) => s.domain === 'comercial')
    expect(enrutarPorNombre(comercial, 'oc-1-products-details.xlsx')).toMatchObject({ kind: 'uno', slot: { id: 'productos' } })
    expect(enrutarPorNombre(tipos, 'oc-1-products-details.xlsx')).toMatchObject({ kind: 'ambiguo' })
  })
})

describe('#269·§6.2.2 · recorrido local de `/cargar` (identidad forjada, sin datos de personas)', () => {
  it('subir por la zona general ENRUTA cada archivo a su tipo: un disparo por proceso y vuelta a la página del archivo', async () => {
    const h = await arnes(SLOTS_DISJUNTOS)
    const r = await subir(h.admin, '/cargar', [{ nombre: 'oc-9-distributions-details-01-09-2026.xlsx' }])
    expect(r.statusCode).toBe(303)
    expect(loc(r)).toContain('/cargar/distribucion?msg=Recibimos 1 archivo(s). Ya empezó la carga: esta página se actualiza sola y verás el resultado abajo.')
    expect(h.puts).toEqual([{ slot: 'distribucion', filename: 'oc-9-distributions-details-01-09-2026.xlsx' }])
    expect(h.disparos).toEqual(['P_OC'])
    expect(h.acelerados).toEqual(['distribucion'])
  })

  it('en la página de productos, un archivo de distribución va a distribución (§4.2 «va a …»)', async () => {
    const h = await arnes(SLOTS_DISJUNTOS)
    const [a] = await revisar(h.admin, 'productos', [{ nombre: 'oc-9-distributions-details-01-09-2026.xlsx' }])
    expect(a).toMatchObject({ clase: 'va', tipo: 'distribucion', texto: '✓ «oc-9-distributions-details-01-09-2026.xlsx» va a «OC · distribución por local».' })
    const [b] = await revisar(h.admin, 'productos', [{ nombre: 'oc-9-products-details-01-09-2026.xlsx', bytes: 2048 }])
    expect(b).toMatchObject({ clase: 'aqui', texto: '✓ «oc-9-products-details-01-09-2026.xlsx» · 2 KB' })
  })

  it('nombre sin tipo: rechazo con los nombres esperados, y no aterriza nada', async () => {
    const h = await arnes(SLOTS_DISJUNTOS)
    const [a] = await revisar(h.admin, '', [{ nombre: 'Libro1.xlsx' }])
    expect(a!['clase']).toBe('ninguno')
    expect(String(a!['texto'])).toMatch(/^Este nombre no corresponde a ningún archivo que puedas subir\. Los nombres esperados son: «OC · detalle de productos»: El nombre tiene que contener «products-details»/)
    const r = await subir(h.admin, '/cargar', [{ nombre: 'Libro1.xlsx' }])
    expect(loc(r)).toContain('&t=error')
    expect(loc(r)).toContain('Este nombre no corresponde a ningún archivo que puedas subir.')
    expect(h.puts).toEqual([])
  })

  it('con la configuración de HOY: lo ambiguo se manda a ELEGIR (no se rechaza), y con el tipo elegido entra', async () => {
    const h = await arnes(SLOTS_HOY)
    const [a] = await revisar(h.admin, '', [{ nombre: 'Listado EasyDoc VH.xlsx' }])
    expect(a).toMatchObject({ clase: 'elegir', texto: '«Listado EasyDoc VH.xlsx» corresponde a más de un tipo de archivo: elige a cuál va.' })
    expect((a!['candidatos'] as { id: string }[]).map((c) => c.id)).toEqual(['facturas', 'inventario', 'despachos', 'clasificacion', 'presupuesto'])
    // Sin elegir: el servidor tampoco adivina — pide elegir, sin aterrizar nada.
    const sin = await subir(h.admin, '/cargar', [{ nombre: 'Listado EasyDoc VH.xlsx' }])
    expect(loc(sin)).toContain('Elige a qué tipo de archivo va «Listado EasyDoc VH.xlsx»')
    expect(h.puts).toEqual([])
    // Con el tipo elegido: la validación es la de la subida con casilla (0.35.1) y entra.
    const con = await subir(h.admin, '/cargar', [{ nombre: 'Listado EasyDoc VH.xlsx' }], { destino_0: 'facturas' })
    expect(loc(con)).toContain('/cargar/facturas?msg=Recibimos 1 archivo(s).')
    expect(h.puts).toEqual([{ slot: 'facturas', filename: 'Listado EasyDoc VH.xlsx' }])
    // Y en la página de un tipo, lo que calza con él entra ahí directo (D-222), como la subida con casilla.
    const pag = await subir(h.admin, '/cargar/inventario', [{ nombre: '20260101 - Recepción Vivero.xlsx' }])
    expect(loc(pag)).toContain('/cargar/inventario?msg=Recibimos 1 archivo(s).')
  })

  it('nombre que ya se recibió y hoy no calza: el mensaje de la carga 27', async () => {
    const h = await arnes(SLOTS_DISJUNTOS)
    await h.store.recordUpload({ slotId: 'maestro', filename: 'Tiendas Sodimac viejo.xlsx', sha256: 'a'.repeat(64), bytes: 1, uploadedBy: 'x@ejemplo.cl', uploadedAt: iso(-100), ok: true, triggered: false, origen: 'upload' })
    const [a] = await revisar(h.admin, '', [{ nombre: 'Tiendas Sodimac viejo.xlsx' }])
    expect(a!['texto']).toBe('Este archivo se recibió antes como «Maestro de tiendas», pero ese archivo ahora tiene que llamarse así: El nombre tiene que contener «Tiendas por zona» y ser un Excel (.xlsx). No importan las mayúsculas. Si es la planilla nueva, cámbiale el nombre; si es la antigua, ya no se carga.')
  })

  it('NFD: un nombre descompuesto se normaliza a NFC y se enruta', async () => {
    const h = await arnes({ slots: [{ id: 'saldos', label: 'Saldos', domain: 'comercial', accept: 'Antig?edad de saldos *.xlsx', target: { ...ts, path: 'Files/s' } }] })
    const nfd = 'Antigüedad de saldos W1.xlsx'
    const r = await subir(h.admin, '/cargar', [{ nombre: nfd }])
    expect(loc(r)).toContain('/cargar/saldos?msg=Recibimos 1 archivo(s).')
    expect(h.puts[0]!.filename).toBe(nfd.normalize('NFC'))
  })

  it('Presupuesto pide su dato con la ayuda; sin el dato se rechaza con el mensaje de la validación', async () => {
    const h = await arnes(SLOTS_DISJUNTOS)
    const page = (await go(h.admin, 'GET', '/cargar/presupuesto')).body
    expect(page).toContain('Versión del presupuesto')
    expect(page).toContain('0 es la línea base del año; 1, 2, 3… son las revisiones mensuales, en orden.')
    const sin = await subir(h.admin, '/cargar/presupuesto', [{ nombre: 'Presupuesto 2026.xlsx' }])
    expect(loc(sin)).toContain('Falta el campo requerido «Versión del presupuesto».')
    const con = await subir(h.admin, '/cargar/presupuesto', [{ nombre: 'Presupuesto 2026.xlsx' }], { 'meta.presupuesto.version': '2' })
    expect(loc(con)).toContain('Recibimos 1 archivo(s).')
    expect(JSON.parse(h.puts[0]!.sidecar!)).toMatchObject({ slot: 'presupuesto', version: '2' })
  })

  it('duplicados (V4): vigente, en espera y cargándose — cada uno con su texto de §4.2', async () => {
    const h = await arnes(SLOTS_DISJUNTOS, { proyeccion: true })
    const sha = (c: string): string => c.repeat(64)
    const base = { slotId: 'productos', bytes: 1, uploadedBy: 'x@ejemplo.cl', triggered: true, origen: 'upload' as const, ok: true }
    const vig = await h.store.recordUpload({ ...base, filename: 'oc-1-products-details.xlsx', sha256: sha('a'), uploadedAt: iso(-600) })
    await h.store.avanzarEstado(vig, { estado: 'procesada', final: true, runStartedAt: iso(-590) })
    const esp = await h.store.recordUpload({ ...base, filename: 'oc-2-products-details.xlsx', sha256: sha('b'), uploadedAt: iso(-600) })
    await h.store.avanzarEstado(esp, { estado: 'fallida', final: false, runStartedAt: iso(-590), motivo: 'x' })
    h.landing.set('productos', new Set(['oc-2-products-details.xlsx']))
    await h.store.recordUpload({ ...base, filename: 'oc-3-products-details.xlsx', sha256: sha('c'), uploadedAt: new Date(Date.now() - 4 * 60_000).toISOString() })
    const [v, e, c] = await revisar(h.admin, 'productos', [
      { nombre: 'copia-oc-1-products-details.xlsx', sha: sha('a') },
      { nombre: 'copia-oc-2-products-details.xlsx', sha: sha('b') },
      { nombre: 'copia-oc-3-products-details.xlsx', sha: sha('c') },
    ])
    expect((v!['dup'] as { texto: string }).texto).toMatch(/^Ya se cargó este mismo archivo el .* \(x@ejemplo\.cl\)\. Subirlo de nuevo no cambia nada\.$/)
    expect((e!['dup'] as { texto: string }).texto).toMatch(/y todavía está en espera: se vuelve a intentar solo\. No hace falta subirlo de nuevo\.$/)
    expect((c!['dup'] as { texto: string }).texto).toBe('Subiste este mismo archivo hace 4 minutos y todavía se está cargando.')
  })

  it('las 14 filas de estado de §4.2, desde un store sembrado con los mecanismos A–G', async () => {
    const h = await arnes(SLOTS_DISJUNTOS, { guias: true, proyeccion: true })
    const s = h.store
    const base = (filename: string, min: number, slotId = 'productos') => ({ slotId, filename, sha256: `${filename}`.padEnd(64, '0').slice(0, 64), bytes: 1, uploadedBy: 'x@ejemplo.cl', uploadedAt: iso(min), triggered: true, origen: 'upload' as const, ok: true })
    const alta = async (n: string, min: number, estado?: Parameters<typeof s.avanzarEstado>[1], slotId?: string): Promise<number> => {
      const id = await s.recordUpload(base(n, min, slotId))
      if (estado) await s.avanzarEstado(id, estado)
      return id
    }
    await alta('recibido.xlsx', -5)
    await alta('cargado.xlsx', -600, { estado: 'procesada', final: true, runStartedAt: iso(-590), intentos: [{ runStartedAt: iso(-800), resultado: 'fallida', motivo: 'faltaba el maestro' }] })
    await alta('corregir.xlsx', -500, { estado: 'fallida', final: false, runStartedAt: iso(-490), codigo: 'formato/columnas' })
    await alta('nopudo.xlsx', -480, { estado: 'fallida', final: false, runStartedAt: iso(-470), motivo: 'ancho inesperado: 28 columnas' })
    await alta('espera.xlsx', -460, { estado: 'saltada', final: false, runStartedAt: iso(-450), codigo: 'en-espera/otro' })
    await alta('precaucion.xlsx', -440, { estado: 'saltada', final: false, runStartedAt: iso(-430), codigo: 'volumen-anomalo/semana-encogida' })
    await alta('nocargo.xlsx', -420, { estado: 'saltada', final: false, runStartedAt: iso(-410) })
    await alta('plataforma.xlsx', -400, { estado: 'fallida', final: false, runStartedAt: iso(-390), codigo: 'falla-plataforma/x' })
    await alta('sininforme.xlsx', -380, { estado: 'sin-informe', final: false })
    await alta('retirado.xlsx', -360, { estado: 'retirada', final: true, actoAt: iso(-350) })
    await alta('reemplazado.xlsx', -340, { estado: 'reemplazada', final: true, actoAt: iso(-330) })
    await alta('deshecho.xlsx', -320, { estado: 'deshecha', final: true, runStartedAt: iso(-315), actoAt: iso(-310) })
    await s.recordUpload({ ...base('rechazado.csv', -300), ok: false, error: "El nombre 'rechazado.csv' no coincide con el patrón esperado «*products-details*.xlsx»." })
    // «Cargando»: otro tipo con una corrida en curso en la proyección.
    await alta('encurso.xlsx', -3, undefined, 'distribucion')
    h.runs.set('distribucion', [{ startedAt: new Date(Date.now() - 60_000).toISOString(), status: 'InProgress' } as RunRecord])
    for (const n of ['corregir.xlsx', 'nopudo.xlsx', 'precaucion.xlsx', 'recibido.xlsx']) h.landing.get('productos')?.add(n) ?? h.landing.set('productos', new Set([n]))

    const p = (await go(h.admin, 'GET', '/cargar/productos')).body
    const d = (await go(h.admin, 'GET', '/cargar/distribucion')).body
    const chips = ['Recibido', '✓ Cargado', '✕ Hay que corregir algo', '✕ No se pudo cargar', '⏸ En espera', '⚠ Detenido por precaución', '⏸ No se cargó', '⚠ Problema de la plataforma', '⚠ Sin informe', 'Retirado', 'Reemplazado', 'Deshecho', '✕ No se recibió']
    for (const c of chips) expect(p, c).toContain(`">${c}</span>`)
    expect(d).toContain('">⏳ Cargando</span>')
    // Frases clave de §4.2
    expect(p).toContain('Lo recibimos. Empieza a cargarse en unos minutos.')
    expect(p).toContain('Los datos quedaron en la plataforma el <time')
    expect(p).toContain('En el primer intento: faltaba el maestro.')
    expect(p).toContain('Mientras tanto, este archivo sigue en espera y se vuelve a intentar solo.')
    expect(p).toContain('El proceso de carga lo rechazó con este mensaje:')
    expect(p).toContain('ancho inesperado: 28 columnas')
    expect(p).toContain('El proceso de carga no lo cargó y no dijo por qué.')
    expect(p).toContain('No es por tu archivo: el proceso de carga tuvo un problema propio. No lo corrijas ni lo vuelvas a subir. Avísale a mesa@ejemplo.cl.')
    expect(p).toContain('No sabemos qué pasó con este archivo: el proceso de carga no lo informó. Avísale a mesa@ejemplo.cl.')
    expect(p).toContain('; no se cargó.')
    expect(p).toContain('con el mismo nombre; esta versión no se cargó.')
    expect(p).toContain('Este nombre no corresponde a ningún archivo que puedas subir.')
    expect(d).toContain('Se está cargando.')
    // «Retirar este archivo» solo donde §4.2 lo ofrece: Recibido, Hay que corregir (en espera), No se pudo (en espera), Detenido.
    expect(p.match(/>Retirar este archivo</g)?.length).toBe(4)
    // Vista de usuario: sin jerga, sin voseo, sin botones técnicos.
    for (const html of [p, d]) {
      expect(sinJerga(html)).toEqual([])
      expect(html).not.toMatch(VOSEO)
      for (const b of ['Deshacer esta carga', 'Reactivar', 'Correr conversión de nuevo']) expect(html).not.toContain(b)
    }
  })

  it('el fragmento vivo trae `x-hay-no-finales` y la página lo pide cada 10 s mientras haya algo que cambie', async () => {
    const h = await arnes(SLOTS_DISJUNTOS)
    const id = await h.store.recordUpload({ slotId: 'productos', filename: 'oc-1-products-details.xlsx', sha256: 'e'.repeat(64), bytes: 1, uploadedBy: 'x@ejemplo.cl', uploadedAt: iso(-5), triggered: true, origen: 'upload', ok: true })
    const vivo = await go(h.admin, 'GET', '/cargar/productos/cargas')
    expect(vivo.headers['x-hay-no-finales']).toBe('1')
    expect(vivo.body).toContain('Recibido')
    expect(vivo.body).not.toContain('<html')
    await h.store.avanzarEstado(id, { estado: 'procesada', final: true, runStartedAt: iso(-1) })
    const quieto = await go(h.admin, 'GET', '/cargar/productos/cargas')
    expect(quieto.headers['x-hay-no-finales']).toBe('0')
    const page = (await go(h.admin, 'GET', '/cargar/productos')).body
    expect(page).toContain('data-fuente="/cargar/productos/cargas" data-vivo="0"')
    expect(page).toContain('setInterval(ve,10000)')
    expect(page).toContain('document.hidden')
  })

  it('«Retirar»: confirmación con el texto de §4.2, retiro a `_retirado/`, y el vigilante deja la carga `retirada`', async () => {
    const h = await arnes(SLOTS_DISJUNTOS)
    await subir(h.admin, '/cargar/productos', [{ nombre: 'oc-7-products-details.xlsx' }])
    const [carga] = await h.store.listUploads('productos', 1)
    const confirma = await go(h.admin, 'GET', `/cargar/productos/retirar?carga=${carga!.id}`)
    expect(confirma.body).toContain('¿Retirar «oc-7-products-details.xlsx»? No se va a cargar. Si después lo necesitas, súbelo de nuevo.')
    expect(confirma.body).toContain('>Cancelar</a>')
    const body = new URLSearchParams({ _csrf: await token(h.admin), carga: String(carga!.id) }).toString()
    const r = await go(h.admin, 'POST', '/cargar/productos/retirar', body, 'application/x-www-form-urlencoded')
    expect(loc(r)).toContain('Retiraste «oc-7-products-details.xlsx»; no se va a cargar.')
    expect(h.retirados.map((x) => x.filename)).toEqual(['oc-7-products-details.xlsx'])
    expect(h.acelerados).toContain('productos')
    // El vigilante (el único escritor del estado) lo lee de `_retirado/` en su vuelta focalizada.
    const deps: IntakeLoopDeps = {
      slots: () => h.slots,
      landing: async (slot): Promise<OneLakeListing> => ({ kind: 'ok', entries: [...(h.landing.get(slot.id) ?? [])].map((f): OneLakeEntry => ({ path: `${slot.target.path}/${f}`, isDirectory: false, size: 1, lastModified: iso(0) })) }),
      retiros: async (slot) => h.retirados.filter((x) => x.slotId === slot.id).map((x) => ({ filename: x.filename, at: x.at, via: 'retirar' as const })),
      store: h.store,
      domains: [{ id: 'comercial', label: 'Comercial' }],
      log: () => {},
    }
    const loop = createIntakeLoop(deps, { publicUrl: 'https://x', pollMs: 600_000 })
    await loop.tickFocalizado('productos')
    const [despues] = await h.store.listUploads('productos', 1)
    expect(despues).toMatchObject({ desenlace: 'retirada', desenlaceFinal: true })
    expect((await go(h.admin, 'GET', '/cargar/productos')).body).toContain('">Retirado</span>')
  })

  it('/cargar: tarjetas por área con su estado; entradas desde el avatar, el catálogo y el home del dominio', async () => {
    const h = await arnes(SLOTS_DISJUNTOS)
    await h.store.recordUpload({ slotId: 'productos', filename: 'oc-1-products-details.xlsx', sha256: 'f'.repeat(64), bytes: 1, uploadedBy: 'x@ejemplo.cl', uploadedAt: iso(-5), triggered: true, origen: 'upload', ok: true })
    const g = (await go(h.admin, 'GET', '/cargar')).body
    expect(g).toContain('<h1>Cargar archivos</h1>')
    expect(g).toContain('Arrastra aquí tus archivos: cada uno va solo al lugar que le corresponde según su nombre.')
    expect(g).toContain('⏳ 1 archivo(s) cargándose')
    expect(g).toContain('Todavía no se ha subido ninguno')
    expect(g).toContain('>Ver cómo va este archivo</a>')
    expect(g).toContain('<h2>Comercial</h2>')
    expect(g).toContain('<h2>Presupuesto</h2>')
    expect(g).toContain('Puedes subir varios a la vez (máximo 25 MB cada uno).')
    expect(g).toContain('href="/cargar">Cargar archivos</a>') // avatar
    expect(sinJerga(g)).toEqual([])
    expect(g).not.toMatch(VOSEO)
    const home = (await go(h.admin, 'GET', '/admin/dominio/comercial')).body
    expect(home.indexOf('Cargar archivos de Comercial')).toBeGreaterThan(-1)
    expect(avatarMenu({ email: USUARIO, isAdmin: false, hasDomains: true, hasCargas: true })).toContain('<a href="/cargar">Cargar archivos</a>')
    expect(avatarMenu({ email: USUARIO, isAdmin: false, hasDomains: true })).not.toContain('/cargar')
    expect(indexHtml([], 'Mira', { cargar: true })).toContain('<a class="cargar" href="/cargar">Cargar archivos</a>')
    expect(indexHtml([], 'Mira')).not.toContain('/cargar')
  })

  it('la ficha dice lo que declara la instancia, y cada bloque sin dato no se dibuja', async () => {
    const h = await arnes(SLOTS_DISJUNTOS)
    const dist = (await go(h.admin, 'GET', '/cargar/distribucion')).body
    expect(dist).toContain('<dt>¿Qué archivo es?</dt><dd>Distribución de una orden de compra por local.</dd>')
    expect(dist).toContain('<dt>¿Cómo tiene que llamarse?</dt><dd>El nombre tiene que contener «distributions-details» y ser un Excel (.xlsx). No importan las mayúsculas.</dd>')
    expect(dist).toContain('Cada archivo carga la OC. Si subes otro de la OC que ya está cargada, reemplaza lo de la OC; lo demás no se toca.')
    expect(dist).toContain('<dt>¿Hay que subir algo antes?</dt>')
    expect(dist).toContain('OC · detalle de productos: el detalle de productos de la misma OC')
    expect(dist).toContain('Maestro de tiendas: el maestro con todas sus tiendas')
    expect(dist).toContain('se vuelve a intentar solo cada vez que se sube cualquiera de estos archivos: «OC · detalle de productos», «Maestro de tiendas».')
    expect(dist).not.toContain('¿De dónde se saca?') // sin `origen` declarado, el bloque no se dibuja
    const prod = (await go(h.admin, 'GET', '/cargar/productos')).body
    expect(prod).toContain('<dt>¿De dónde se saca?</dt><dd>Portal B2B del cliente</dd>')
    expect(prod).toContain('Por ejemplo: <code>oc-1-products-details-01-01-2026.xlsx</code>')
    const maestro = (await go(h.admin, 'GET', '/cargar/maestro')).body
    expect(maestro).toContain('Este archivo reemplaza la lista completa que está cargada. Tiene que venir completo')
    expect(maestro).toContain('<dt>¿Qué tiene que venir junto?</dt><dd>Todas las tiendas, no solo las nuevas</dd>')
    expect(maestro).toContain('Problemas frecuentes y cómo resolverlos')
    expect(maestro).toContain('Todavía no hay problemas frecuentes registrados para este archivo.')
    for (const html of [dist, prod, maestro]) expect(sinJerga(html)).toEqual([])
  })

  it('la ruta de un tipo de otro dominio, o inexistente, es 404; quien no gestiona dominios, 403', async () => {
    const h = await arnes(SLOTS_DISJUNTOS)
    expect((await go(h.admin, 'GET', '/cargar/fantasma')).statusCode).toBe(404)
    const req = Readable.from(['']) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
    req.url = '/cargar'; req.method = 'GET'; req.headers = { 'x-test-user': 'nadie@ejemplo.cl' }
    const res = { statusCode: 0, headers: {}, body: '', writeHead(c: number) { this.statusCode = c; return this }, end() {} }
    await h.admin.tryHandle(req, res as unknown as ServerResponse)
    expect(res.statusCode).toBe(403)
  })
})

describe('#269·P2 · estado vivo: `acelerar` (tick focalizado, D3)', () => {
  const doc = { slots: [{ id: 'p', label: 'P', domain: 'd', accept: '*.xlsx', target: { ...ts, path: 'Files/p' }, trigger: { processRef: 'X' } }, { id: 'q', label: 'Q', domain: 'd', accept: '*.csv', target: { ...ts, path: 'Files/q' }, trigger: { processRef: 'Y' } }] }
  async function lazo(now: number) {
    const slots = parseIntakeConfig(doc)
    const store = await SqliteGovernanceStore.open(null, {})
    const observados: string[] = []
    let tic: (() => void) | null = null
    let parado = false
    const deps: IntakeLoopDeps = {
      slots: () => slots,
      landing: async (slot) => { observados.push(slot.id); return { kind: 'ok', entries: [] } },
      runs: async () => [],
      store,
      domains: [{ id: 'd', label: 'D' }],
      log: () => {},
      now: () => now,
      timer: { every: (_ms, fn) => { tic = fn; return { stop: () => { parado = true } } } },
    }
    return { loop: createIntakeLoop(deps, { publicUrl: 'https://x', pollMs: 600_000 }), store, observados, tic: () => tic, parado: () => parado }
  }

  it('observa y resuelve SOLO el tipo acelerado, y sigue mientras tenga cargas no finales de menos de 45 min', async () => {
    const x = await lazo(T0)
    await x.store.recordUpload({ slotId: 'p', filename: 'a.xlsx', sha256: '1'.repeat(64), bytes: 1, uploadedAt: iso(-10), ok: true, triggered: true, origen: 'upload' })
    expect(await x.loop.tickFocalizado('p')).toBe(true)
    expect(x.observados).toEqual(['p']) // el otro tipo no se toca
    // Pasada la ventana, deja de acelerar.
    const y = await lazo(T0 + ACELERAR_VENTANA_MS + 11 * 60_000)
    await y.store.recordUpload({ slotId: 'p', filename: 'a.xlsx', sha256: '1'.repeat(64), bytes: 1, uploadedAt: iso(-10), ok: true, triggered: true, origen: 'upload' })
    expect(await y.loop.tickFocalizado('p')).toBe(false)
  })

  it('acelerar programa UN reloj; al quedar sin pendientes se detiene solo', async () => {
    const x = await lazo(T0)
    x.loop.acelerar('p')
    x.loop.acelerar('p')
    expect(x.tic()).not.toBeNull()
    x.tic()!()
    await new Promise((r) => setTimeout(r, 20))
    expect(x.parado()).toBe(true) // sin cargas no finales: nada que acelerar
    expect(x.observados).toEqual(['p'])
  })

  it('un nodo sin el plano de control no acelera (un standby no escribe)', async () => {
    const x = await lazo(T0)
    const slots = parseIntakeConfig(doc)
    const loop = createIntakeLoop({ slots: () => slots, landing: async () => { throw new Error('no debería observar') }, store: x.store, domains: [], log: () => {}, hasControl: () => false }, { publicUrl: 'https://x' })
    expect(await loop.tickFocalizado('p')).toBe(false)
  })
})

describe('#269·§5 · tokens y componentes compartidos · /contrato con los flujos de aviso', () => {
  it('los tokens nuevos viven en `:root` y en el tema blanco; el catálogo los importa (un solo origen)', () => {
    for (const t of ['--ok', '--warn', '--info', '--wait', '--ok-bg', '--warn-bg', '--err-bg', '--info-bg']) {
      expect(TOKENS_CSS.split('\n')[0]).toContain(`${t}:`)
      expect(TOKENS_CSS.split('\n')[1]).toContain(`${t}:`)
    }
    expect(PAGE_CSS).toContain(TOKENS_CSS)
    expect(indexHtml([], 'Mira')).toContain(TOKENS_CSS)
    expect(PAGE_CSS).not.toContain('--yellow')
  })
  it('/contrato lista los flujos de aviso con su CANTIDAD de destinos, sin direcciones (juez P1 · m1)', () => {
    const reg = createContractRegistry({ engine: 't', hotReload: true, envSource: {}, avisos: () => [{ flujo: 'cargas-usuario', destinos: 1 }, { flujo: 'cargas-operador', destinos: 0 }] })
    expect(reg.snapshot().avisos).toEqual([{ flujo: 'cargas-usuario', destinos: 1 }, { flujo: 'cargas-operador', destinos: 0 }])
    expect(createContractRegistry({ engine: 't', hotReload: true, envSource: {} }).snapshot().avisos).toEqual([])
  })
})

describe('#269·P2 · el router despacha `/cargar` al handler de gestión, con el gate de mutación', () => {
  const fake = () => {
    const vistos: string[] = []
    return { vistos, admin: { tryHandle: async (req: IncomingMessage, res: ServerResponse) => { vistos.push(`${req.method} ${req.url}`); res.writeHead(200); res.end('ok'); return true } } }
  }
  const deps = (admin: unknown, control?: unknown) => ({
    engine: 'x', gateSecret: '', isReady: () => false, getAdmin: () => admin as never, getPiConfig: () => null, discover: () => [],
    identityFor: () => ({ agent: 't', user: 'a@x.cl' }), renderReport: async () => '', indexReports: async (a: never[]) => a, renderIndexPage: async () => '', canOpenPi: async () => true,
    ...(control ? { control } : {}),
  }) as never
  const correr = (h: ReturnType<typeof createRequestHandler>, url: string, method = 'GET') => new Promise<number>((resolve) => {
    let code = 0
    const res = { writeHead: (c: number) => { code = c }, end: () => resolve(code), setHeader: () => {}, headersSent: false } as unknown as ServerResponse
    h({ url, method, headers: {} } as unknown as IncomingMessage, res)
  })
  it('GET /cargar y /cargar/<tipo>/cargas llegan al handler aunque el motor no esté listo (no sirve dato gobernado)', async () => {
    const f = fake()
    const h = createRequestHandler(deps(f.admin))
    expect(await correr(h, '/cargar')).toBe(200)
    expect(await correr(h, '/cargar/productos/cargas?x=1')).toBe(200)
    expect(f.vistos).toEqual(['GET /cargar', 'GET /cargar/productos/cargas?x=1'])
  })
  it('un nodo en espera (standby) no acepta la subida: 409 antes de tocar el handler', async () => {
    const f = fake()
    const h = createRequestHandler(deps(f.admin, { hasControl: () => false, activeHolder: () => 'nodo-a' }))
    expect(await correr(h, '/cargar', 'POST')).toBe(409)
    expect(f.vistos).toEqual([])
  })
})
