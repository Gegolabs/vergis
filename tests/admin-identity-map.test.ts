/**
 * Administración del mapa identidad→claims (#159, hito 3) — la superficie deja de ser un archivo del host.
 *
 * Arnés: `createAdmin` con un `SqliteGovernanceStore` REAL como `identityClaims` (la normalización y la
 * preservación de overrides son parte de lo que se juzga) y el resto mockeado — el mismo molde de
 * `admin-sources.test.ts`. Lo que estos casos observan: un admin ve el mapa CON su procedencia,
 * inscribe un override para su cuenta de operación, corrige y da de baja; un no-admin no puede nada; y
 * la entrada `autoritativa-ambigua` se lee distinto de «sin entrada» (§4 de #165, que aterrizó acá).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdmin, type AdminHandler } from '../server/admin'
import { csrfFactory } from '../server/ui'
import { parseMasterDataConfig, parseDomainsConfig, SqliteMasterDataStore, SqliteAdminStore, SqliteGovernanceStore } from '@vergis/capabilities'
import type { LogEventInput } from '@vergis/botler'

const SECRET = 'test-secret'
const ADMIN = 'cesar@ultrabase.com'
const OTRO = 'steward@gh.cl' // STEWARD de un dominio: entra a /admin, y aun así no toca el mapa
const OPERACION = 'ops@gh.cl' // la cuenta de operación que hoy se cae del mapa en cada regeneración

const ENTITIES = parseMasterDataConfig({ entities: [{ id: 'rel', label: 'Relacionadas', domain: 'cartera', columns: [{ name: 'rut', label: 'RUT', type: 'string', pk: true }] }] })
const DOMAINS = parseDomainsConfig({ domains: [{ id: 'cartera', label: 'Cartera / Finanzas', stewards: [OTRO] }] })

function mockReq(method: string, url: string, user: string, body = '', contentType?: string): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url; r.method = method; r.headers = { 'x-test-user': user }
  if (contentType) r.headers['content-type'] = contentType
  return r
}
interface MockRes { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(chunk?: string): void }
function mockRes(): MockRes {
  return { statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(chunk) { if (chunk) this.body += chunk } }
}

describe('admin · mapa identidad→claims (#159)', () => {
  let admin: AdminHandler
  let gov: SqliteGovernanceStore
  let audit: LogEventInput[]

  beforeEach(async () => {
    audit = []
    gov = await SqliteGovernanceStore.open(null, {})
    // La fuente autoritativa ya reconcilió: una entrada que resolvió y otra que NO resolvió a un
    // valor único (la persona con dos fichas activas legítimas). Ninguna de las dos es un override.
    await gov.reconcileIdentityClaims(
      [
        { email: 'ana@gh.cl', claims: { area: 'finanzas' } },
        { email: 'bruno@gh.cl', claims: { area: ['finanzas', 'operaciones'] }, origin: 'autoritativa-ambigua' },
      ],
      { updatedBy: 'reconciliador' },
    )
    admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      identityClaims: gov,
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
  const token = async (): Promise<string> => (await go(mockReq('GET', '/admin/identidades', ADMIN))).body.match(/name="_csrf" value="([0-9a-f]+)"/)![1]
  const postAs = async (user: string, path: string, campos: Record<string, string>, tok?: string): Promise<MockRes> => {
    const t = tok ?? (await token())
    const body = new URLSearchParams({ _csrf: t, ...campos }).toString()
    return go(mockReq('POST', path, user, body, 'application/x-www-form-urlencoded'))
  }
  const opsDe = (): string[] => audit.filter((e) => e['type'] === 'identity-map-write').map((e) => String(e['op']))
  const claimsDe = async (email: string): Promise<Record<string, string[]> | null> => (await gov.getIdentityClaims(email))?.claims ?? null

  // (1) Ver el mapa con procedencia por entrada
  it('el GET lista las entradas con sus claims y la procedencia de cada una', async () => {
    const res = await go(mockReq('GET', '/admin/identidades', ADMIN))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('ana@gh.cl')
    expect(res.body).toContain('finanzas')
    expect(res.body).toContain('autoritativa')
    expect(res.body).toContain('action="/admin/identidades/entry"')
    // La restricción dura, escrita en la propia pantalla: no se adivina a nadie.
    expect(res.body).toContain('fail-closed')
  })

  // (4) `autoritativa-ambigua` es un ESTADO visible, distinto de «sin entrada»
  it('la entrada ambigua se muestra como estado propio, y una identidad sin entrada NO aparece', async () => {
    const body = (await go(mockReq('GET', '/admin/identidades', ADMIN))).body
    // Se mide DENTRO de la fila, no en la página: la leyenda del pie también dice «ambigua», y
    // aceptarla como evidencia haría verde un badge que no distingue nada.
    const fila = (email: string): string => {
      const i = body.indexOf(email)
      expect(i, email).toBeGreaterThan(-1)
      return body.slice(i, body.indexOf('</tr>', i))
    }
    expect(fila('bruno@gh.cl')).toContain('ambigua') // se ve, y se ve DISTINTO de la que resolvió
    expect(fila('ana@gh.cl')).toContain('autoritativa')
    expect(fila('ana@gh.cl')).not.toContain('ambigua')
    // «Sin entrada» es otra cosa: no está en la tabla, y el store lo confirma.
    expect(body).not.toContain('fantasma@gh.cl')
    expect(await gov.getIdentityClaims('fantasma@gh.cl')).toBeNull()
    // Y una entrada presente con CERO claims tampoco es «sin entrada»: se dice con todas sus letras.
    await gov.upsertIdentityClaims('vacia@gh.cl', { claims: {}, origin: 'autoritativa' })
    const b2 = (await go(mockReq('GET', '/admin/identidades', ADMIN))).body
    expect(b2).toContain('vacia@gh.cl')
    expect(b2).toContain('presente en el mapa, no resolvió')
  })

  // (3) Overrides declarados — la capacidad que arregla el defecto reportado
  it('alta de override: 303, entrada con origin=override, y sobrevive a la regeneración del mapa', async () => {
    const res = await postAs(ADMIN, '/admin/identidades/entry', { email: OPERACION, claims: 'area: operaciones, finanzas' })
    expect(res.statusCode).toBe(303)
    expect(res.headers['location']).toContain('/admin/identidades?msg=')
    const e = (await gov.getIdentityClaims(OPERACION))!
    expect(e).toMatchObject({ email: OPERACION, origin: 'override', updatedBy: ADMIN })
    expect(e.claims).toEqual({ area: ['operaciones', 'finanzas'] })
    expect(audit.find((a) => a['type'] === 'identity-map-write')).toMatchObject({ op: 'entry-upsert', target: OPERACION, by: ADMIN, origin: 'override', previo: null })

    // El defecto del issue, medido: la fuente regenera el mapa SIN la cuenta de operación y ésta sigue.
    const r = await gov.reconcileIdentityClaims([{ email: 'ana@gh.cl', claims: { area: 'finanzas' } }])
    expect(r.conservadas + r.escritas).toBeGreaterThan(0)
    expect(await gov.getIdentityClaims(OPERACION)).not.toBeNull()
    expect(await gov.getIdentityClaims('bruno@gh.cl')).toBeNull() // la autoritativa que la fuente ya no trae, sí se retira
  })

  // (2) Corrección de claims
  it('corregir una entrada autoritativa la reescribe con los claims nuevos y la marca override', async () => {
    const page = await go(mockReq('GET', '/admin/identidades?edit=ana%40gh.cl', ADMIN))
    expect(page.body).toContain('Corregir la entrada')
    expect(page.body).toContain('area: finanzas') // el textarea viene pre-poblado con lo vigente

    const res = await postAs(ADMIN, '/admin/identidades/entry', { email: 'ana@gh.cl', claims: 'area: operaciones' })
    expect(res.statusCode).toBe(303)
    const e = (await gov.getIdentityClaims('ana@gh.cl'))!
    expect(e.claims).toEqual({ area: ['operaciones'] })
    expect(e.origin).toBe('override') // lo escribió un humano: decir «autoritativa» sería mentir sobre el origen
    expect(audit.find((a) => a['op'] === 'entry-upsert')).toMatchObject({ target: 'ana@gh.cl', previo: 'autoritativa' })
  })

  it('el correo se normaliza a minúscula (una entrada en mayúsculas sería invisible para el resolver)', async () => {
    await postAs(ADMIN, '/admin/identidades/entry', { email: 'Ops@GH.cl', claims: 'area: operaciones' })
    expect(await gov.getIdentityClaims(OPERACION)).not.toBeNull()
  })

  // (2) Baja
  it('baja: la entrada sale del mapa y la identidad queda SIN claims (fail-closed)', async () => {
    const res = await postAs(ADMIN, '/admin/identidades/entry-delete', { email: 'ana@gh.cl' })
    expect(res.statusCode).toBe(303)
    expect(await gov.getIdentityClaims('ana@gh.cl')).toBeNull()
    expect(opsDe()).toEqual(['entry-delete'])
  })

  // (5) Fail-closed por rol: es la pantalla más sensible del producto
  it('un no-admin no puede NADA: 403 en el GET y en toda escritura, y el mapa no se mueve', async () => {
    // El steward SÍ entra a /admin (gestiona su dominio): el 403 de abajo mide el gate DE LA SECCIÓN,
    // no el portón de entrada. Sin esta línea, un usuario sin ningún dominio haría verde el caso por
    // la razón equivocada — el mapa es transversal y solo lo toca un admin de plataforma.
    expect((await go(mockReq('GET', '/admin', OTRO))).statusCode).toBe(200)
    expect((await go(mockReq('GET', '/admin/identidades', OTRO))).statusCode).toBe(403)
    // El POST va con el token PROPIO del steward (el CSRF es por-identidad): si se le pasara el del
    // admin, el 403 lo daría el CSRF y el caso no mediría el gate de rol, que es lo que se juzga acá.
    const suyo = csrfFactory(SECRET)(OTRO)
    for (const p of ['entry', 'entry-delete']) {
      const res = await postAs(OTRO, `/admin/identidades/${p}`, { email: OPERACION, claims: 'area: todo' }, suyo)
      expect(res.statusCode, p).toBe(403)
    }
    expect(await gov.getIdentityClaims(OPERACION)).toBeNull()
    expect(await claimsDe('ana@gh.cl')).toEqual({ area: ['finanzas'] })
    expect(opsDe()).toEqual([])
  })

  it('CSRF inválido: 403 en toda escritura, sin tocar el mapa', async () => {
    for (const p of ['entry', 'entry-delete']) {
      const res = await postAs(ADMIN, `/admin/identidades/${p}`, { email: 'ana@gh.cl', claims: 'area: todo' }, 'deadbeef')
      expect(res.statusCode, p).toBe(403)
    }
    expect(await claimsDe('ana@gh.cl')).toEqual({ area: ['finanzas'] })
    expect(opsDe()).toEqual([])
  })

  it('entrada inválida (correo o claim): 400 y NADA se escribe — no se adivina qué quiso decir', async () => {
    const t = await token()
    const casos: Record<string, string>[] = [
      { email: 'no-es-correo', claims: 'area: finanzas' },
      { email: '', claims: 'area: finanzas' },
      { email: 'nuevo@gh.cl', claims: 'area' }, // sin `:` → no se infiere un claim sin valores
      { email: 'nuevo@gh.cl', claims: 'area: finanzas\narea: operaciones' }, // repetido → no se pisa en silencio
    ]
    for (const c of casos) {
      const res = await postAs(ADMIN, '/admin/identidades/entry', c, t)
      expect(res.statusCode, JSON.stringify(c)).toBe(400)
      expect(res.body).toContain('Error:')
    }
    expect(await gov.getIdentityClaims('nuevo@gh.cl')).toBeNull()
    expect(opsDe()).toEqual([])
    // Y una operación que no existe tampoco escribe nada.
    expect((await postAs(ADMIN, '/admin/identidades/inventada', { email: 'nuevo@gh.cl' }, t)).statusCode).toBe(400)
  })

  it('el correo es dato de terceros: llega escapado al HTML', async () => {
    await gov.upsertIdentityClaims('a"><script>x</script>@gh.cl', { claims: { area: '<b>ops</b>' }, origin: 'override' })
    const body = (await go(mockReq('GET', '/admin/identidades', ADMIN))).body
    expect(body).not.toContain('<script>x</script>')
    expect(body).toContain('&lt;script&gt;')
    expect(body).not.toContain('<b>ops</b>')
  })

  // Regresión cero: sin el store cableado la sección NO existe (fail-closed, como Fuentes)
  it('sin identityClaims cableado, la ruta no existe: 404 en GET y en POST, y no hay entrada en el menú', async () => {
    const ro = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const g = mockRes()
    await ro.tryHandle(mockReq('GET', '/admin/identidades', ADMIN), g as unknown as ServerResponse)
    expect(g.statusCode).toBe(404)
    const w = mockRes()
    await ro.tryHandle(mockReq('POST', '/admin/identidades/entry', ADMIN, '', 'application/x-www-form-urlencoded'), w as unknown as ServerResponse)
    expect(w.statusCode).toBe(404)
    const plat = mockRes()
    await ro.tryHandle(mockReq('GET', '/admin/plataforma', ADMIN), plat as unknown as ServerResponse)
    expect(plat.body).not.toContain('/admin/identidades')
  })

  // Capacidad 1: «cuántas autenticadas no resuelven» — solo con universo observado aportado
  it('con observedIdentities cableado, lista las autenticadas sin entrada; sin él, el bloque no se pinta', async () => {
    const conObs = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      identityClaims: gov,
      observedIdentities: async () => ['ana@gh.cl', 'nadie@gh.cl'],
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
    const res = mockRes()
    await conObs.tryHandle(mockReq('GET', '/admin/identidades', ADMIN), res as unknown as ServerResponse)
    expect(res.body).toContain('Identidades autenticadas sin entrada (1)')
    expect(res.body).toContain('nadie@gh.cl')
    // Sin la dep, no se fabrica un número sobre un universo que nadie midió.
    expect((await go(mockReq('GET', '/admin/identidades', ADMIN))).body).not.toContain('Identidades autenticadas sin entrada')
  })
})

// === EL CABLEADO (integración, orquestador) =================================
// La pantalla escribe en el store; el resolver vive en `serve-rls.ts` con su propia proyección. Si
// nadie avisa, la corrección persiste y el nodo sigue sirviendo con el mapa viejo hasta un SIGHUP —
// o sea la capacidad 4 del issue («corregir sin reiniciar») quedaría cumplida a medias, que es la
// forma más cara de no cumplirla: parece que funcionó.
describe('admin · mapa identidad: la escritura DISPARA la recarga (#159 capacidad 4)', () => {
  let admin: AdminHandler
  let gov: SqliteGovernanceStore
  let avisos: string[]

  beforeEach(async () => {
    avisos = []
    gov = await SqliteGovernanceStore.open(null, {})
    admin = createAdmin({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      identityClaims: gov,
      onIdentityChange: (reason) => avisos.push(reason),
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: SECRET,
    })
  })

  const go = async (req: IncomingMessage): Promise<MockRes> => {
    const res = mockRes()
    await admin.tryHandle(req, res as unknown as ServerResponse)
    return res
  }
  const tok = async (): Promise<string> => (await go(mockReq('GET', '/admin/identidades', ADMIN))).body.match(/name="_csrf" value="([0-9a-f]+)"/)![1]
  const post = async (user: string, path: string, campos: Record<string, string>, t?: string): Promise<MockRes> =>
    go(mockReq('POST', path, user, new URLSearchParams({ _csrf: t ?? (await tok()), ...campos }).toString(), 'application/x-www-form-urlencoded'))

  it('un alta avisa una vez, con el motivo que identifica la fuente del cambio', async () => {
    await post(ADMIN, '/admin/identidades/entry', { email: OPERACION, claims: 'area: operaciones' })
    expect(avisos).toEqual(['admin:identidades'])
    expect(await gov.getIdentityClaims(OPERACION)).toMatchObject({ origin: 'override' })
  })

  it('una baja también avisa: retirar claims cambia el alcance tanto como agregarlos', async () => {
    await post(ADMIN, '/admin/identidades/entry', { email: OPERACION, claims: 'area: operaciones' })
    avisos.length = 0
    await post(ADMIN, '/admin/identidades/entry-delete', { email: OPERACION })
    expect(avisos).toEqual(['admin:identidades'])
  })

  // Los dos controles negativos: sin ellos, un `onIdentityChange` llamado SIEMPRE —antes de escribir,
  // o en el camino de error— pasaría los dos tests de arriba sin haber sido puesto en riesgo nunca.
  it('CONTROL: una escritura RECHAZADA por CSRF no avisa', async () => {
    const res = await post(ADMIN, '/admin/identidades/entry', { email: OPERACION, claims: 'area: operaciones' }, 'token-falso')
    expect(res.statusCode).toBe(403)
    expect(avisos).toEqual([])
  })

  it('CONTROL: una escritura RECHAZADA por inválida no avisa', async () => {
    const res = await post(ADMIN, '/admin/identidades/entry', { email: OPERACION, claims: 'sin-dos-puntos' })
    expect(res.statusCode).toBe(400)
    expect(avisos).toEqual([])
  })

  it('CONTROL: un no-admin no escribe y no avisa', async () => {
    await post(OTRO, '/admin/identidades/entry', { email: OPERACION, claims: 'area: operaciones' })
    expect(avisos).toEqual([])
    expect(await gov.getIdentityClaims(OPERACION)).toBeNull()
  })
})
