/**
 * H3 de #346 · lo que ve el usuario: la guía en la celda Desenlace, «Errores frecuentes», el correo y
 * la señal de cobertura del operador.
 *
 * El motivo del maestro de tiendas es el REAL (fixture de `_logs/` de la instancia A.R.B.O.L., 508
 * caracteres): el recorte a 300 de la celda de siempre se come justo lo accionable, «Pedir el maestro
 * actualizado». Es el caso que abrió el issue.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, it, expect, beforeEach } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  escapeHtml,
  redactSecrets,
  parseRunFileOutcomes,
  parseIntakeConfig,
  parseIntakeGuiasConfig,
  parseMasterDataConfig,
  parseDomainsConfig,
  resolverGuia,
  SqliteMasterDataStore,
  SqliteAdminStore,
  type RunRecord,
  type IntakeSlot,
  type GuiaDecl,
  type DesenlaceCodigoConteo,
} from '@vergis/capabilities'
import {
  desenlaceCelda,
  guiaDeCarga,
  coberturaGuias,
  erroresFrecuentesBody,
  erroresHref,
  type IntakeUploadEvent,
  type CargasOps,
} from '../server/admin-cargas'
import { composeCargaUserNotice, type CargaUserNoticeContext } from '../server/notify'
import { createAdmin, type AdminHandler } from '../server/admin'

const FIXTURE = readFileSync(join(__dirname, 'fixtures/run-logs/run-20260922T171554Z.txt'), 'utf8')
const [MAESTRO_REAL, OC_REAL] = parseRunFileOutcomes(FIXTURE)
const MOTIVO_508 = MAESTRO_REAL!.motivo!

const YAML = `
slots:
  - id: oc_crossdocking_maestro
    label: Maestro de tiendas
    domain: comercial
    target: { workspaceId: W, lakehouseId: L, path: Files/intake/maestro }
  - id: oc_crossdocking_distribuciones
    label: Distribuciones de OC
    domain: comercial
    target: { workspaceId: W, lakehouseId: L, path: Files/intake/dist }
guias:
  entradas:
    - codigo: catalogo-incompleto/maestro-tiendas
      slots: [oc_crossdocking_maestro]
      titulo: "El maestro de tiendas tiene que venir completo"
      que_paso: "Este archivo reemplaza la lista entera de tiendas. El que subiste trae {tiendas_archivo} tiendas y dejaría fuera {n} que ya tienen despachos cargados, así que no se aplicó nada."
      que_hacer:
        - "Parte del maestro completo, no de una planilla nueva."
        - "Agrega las tiendas nuevas con su zona, sin borrar ninguna."
        - "Súbelo completo y después vuelve a subir la distribución que había fallado."
    - codigo: referencia-ausente/tienda-sin-zona
      titulo: "La OC trae tiendas que todavía no están en el maestro"
      que_paso: "La distribución de la OC {oc} manda producto a tiendas que el maestro no conoce: {faltan}."
      que_hacer: ["Agrega {faltan} al maestro de tiendas, con nombre y zona.", "Vuelve a subir esta distribución."]
`
const DOC = parseYaml(YAML)
const SLOTS: IntakeSlot[] = parseIntakeConfig(DOC)
const CATALOGO: GuiaDecl[] = parseIntakeGuiasConfig(DOC)
const SLOT_MAESTRO = SLOTS[0]!
const SLOT_DIST = SLOTS[1]!
const RUNS: RunRecord[] = [{ startedAt: '2026-09-22T17:15:54Z', endedAt: '2026-09-22T17:17:00Z', status: 'Failed' }]
const href = (r: RunRecord): string => `/admin/dominio/comercial/corrida?started=${r.startedAt}`

const cargaMaestro = (over: Partial<IntakeUploadEvent> = {}): IntakeUploadEvent => ({
  id: 7,
  ts: '2026-09-22T17:15:00Z',
  filename: MAESTRO_REAL!.file,
  bytes: 9000,
  by: 'claudio@ratio.cl',
  ok: true,
  triggered: true,
  desenlace: 'fallida',
  desenlaceMotivo: MOTIVO_508,
  desenlaceRunStartedAt: '2026-09-22T17:15:54Z',
  ...over,
})

/**
 * La celda Desenlace TAL COMO ERA antes de #346 (`admin-cargas.ts` en f219bc6), copiada literal: la
 * referencia del control negativo.
 */
function celdaPre346(h: IntakeUploadEvent, runs: RunRecord[] | 'error', hrefDeRun?: (r: RunRecord) => string | null): string {
  // #269 · la celda SIN guía con el vocabulario de 0.35.0 (chip + frase del estado, §4.2 de work/269):
  // el control negativo de #346 sigue siendo el mismo —sin código la celda no cambia por las guías—,
  // contra la referencia vigente.
  // #269·P2 · el chip es el componente compartido (`ui.chip`, tokens de estado).
  const BADGE: Record<string, string> = {
    procesada: '<span class="chip t-ok">✓ Cargado</span>',
    saltada: '<span class="chip t-atencion">⏸ No se cargó</span>',
    fallida: '<span class="chip t-error">✕ No se pudo cargar</span>',
    'sin-informe': '<span class="chip t-atencion">⚠ Sin informe</span>',
    varada: '<span class="chip t-atencion">⚠ En espera</span>',
  }
  const FRASE: Record<string, string> = {
    fallida: 'El proceso de carga lo rechazó con este mensaje:',
    saltada: 'El proceso de carga no lo cargó y no dijo por qué.',
    'sin-informe': 'No sabemos qué pasó con este archivo: el proceso de carga no lo informó.',
    varada: 'Lleva mucho tiempo esperando a que el proceso de carga lo tome.',
  }
  if (!h.desenlace) return ''
  const badge = BADGE[h.desenlace] ?? escapeHtml(String(h.desenlace))
  const frase = FRASE[h.desenlace] ? `<div class="sub">${FRASE[h.desenlace]}</div>` : ''
  const crudo = h.desenlaceMotivo ?? ''
  const recortado = crudo.length > 300 ? crudo.slice(0, 300) + '…' : crudo
  const motivo = recortado ? `<div class="sub">${escapeHtml(redactSecrets(recortado))}</div>` : ''
  const corrida = h.desenlaceRunStartedAt && runs !== 'error' ? runs.find((r) => r.startedAt === h.desenlaceRunStartedAt) : undefined
  const link = corrida && hrefDeRun?.(corrida) ? `<div><a class="sub" href="${escapeHtml(hrefDeRun(corrida)!)}">Ver corrida</a></div>` : ''
  return `${badge}${frase}${motivo}${link}`
}

describe('#346·H3 · celda Desenlace CON guía', () => {
  const h = cargaMaestro({ desenlaceCodigo: 'catalogo-incompleto/maestro-tiendas', desenlaceParams: { n: '50', tiendas_archivo: '2', faltan: ['11', '12'] } })
  const guia = guiaDeCarga(SLOT_MAESTRO, h, CATALOGO)
  const html = desenlaceCelda(h, RUNS, href, guia)

  it('muestra actor, título, qué pasó y qué hacer numerado', () => {
    expect(guia).toMatchObject({ actor: 'usuario', nivel: 'entrada-slot' })
    expect(html).toContain('Hay que corregir el archivo')
    expect(html).toContain('<b>El maestro de tiendas tiene que venir completo</b>')
    expect(html).toContain('trae 2 tiendas y dejaría fuera 50 que ya tienen despachos cargados')
    expect(html).toMatch(/<ol[^>]*><li>Parte del maestro completo, no de una planilla nueva\.<\/li><li>Agrega las tiendas nuevas/)
    expect(html).toContain('Ver corrida')
  })

  it('el motivo real de 508 caracteres va COMPLETO en «Detalle técnico», con el código', () => {
    expect(MOTIVO_508.length).toBe(508)
    expect(html).toContain('<summary class="sub">Detalle técnico</summary>')
    expect(html).toContain('Pedir el maestro actualizado')
    expect(html).toContain(escapeHtml(MOTIVO_508))
    expect(html).toContain('código: <code>catalogo-incompleto/maestro-tiendas</code>')
    // El detalle va DESPUÉS de la guía: la guía primero, lo técnico plegado debajo.
    expect(html.indexOf('Detalle técnico')).toBeGreaterThan(html.indexOf('venir completo'))
  })

  it('la guía y los datos del job van escapados (texto no confiable)', () => {
    const g = resolverGuia(SLOT_DIST, 'referencia-ausente/tienda-sin-zona', { oc: '<script>x</script>', faltan: ['58'] }, CATALOGO)
    const out = desenlaceCelda(cargaMaestro({ desenlaceCodigo: 'referencia-ausente/tienda-sin-zona' }), RUNS, href, g)
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('con actor operador la línea dice que no es su archivo', () => {
    const g = guiaDeCarga(SLOT_MAESTRO, cargaMaestro({ desenlaceCodigo: 'falla-plataforma' }), CATALOGO)
    expect(g!.actor).toBe('operador')
    const celda = desenlaceCelda(cargaMaestro(), RUNS, href, g)
    expect(celda).toContain('No es por tu archivo: el proceso de carga tuvo un problema propio')
    // #269·V12 · sin destino del operador ni contacto, la celda NO afirma que alguien fue avisado.
    expect(celda).not.toMatch(/avisad|avisamos/i)
    expect(desenlaceCelda(cargaMaestro(), RUNS, href, g, { aviso: 'Avísale a arbol@ejemplo.cl.' })).toContain('Avísale a arbol@ejemplo.cl.')
  })
})

describe('#346·H3 · CONTROL NEGATIVO: sin código, la celda es la de siempre (+ el plegado si hubo recorte)', () => {
  it('motivo corto sin código: HTML IDÉNTICO al render previo a #346', () => {
    const h = cargaMaestro({ filename: OC_REAL!.file, desenlaceMotivo: OC_REAL!.motivo! })
    expect(OC_REAL!.motivo!.length).toBeLessThanOrEqual(300)
    expect(desenlaceCelda(h, RUNS, href, guiaDeCarga(SLOT_DIST, h, CATALOGO))).toBe(celdaPre346(h, RUNS, href))
  })

  it('motivo de 508 sin código: el render previo MÁS el plegado con el motivo completo, y nada más', () => {
    const h = cargaMaestro()
    const antes = celdaPre346(h, RUNS, href)
    const ahora = desenlaceCelda(h, RUNS, href, guiaDeCarga(SLOT_MAESTRO, h, CATALOGO))
    const plegado = `<details class="guia"><summary class="sub">Detalle técnico</summary><div class="sub" style="white-space:pre-wrap">${escapeHtml(MOTIVO_508)}</div></details>`
    const link = '<div><a class="sub"'
    expect(ahora).toBe(antes.replace(link, plegado + link))
    // El render previo NO traía lo accionable; el nuevo sí, plegado.
    expect(antes).not.toContain('Pedir el maestro actualizado')
    expect(ahora).toContain('Pedir el maestro actualizado')
  })

  it('código de familia desconocida: igual que sin código', () => {
    const h = cargaMaestro({ filename: OC_REAL!.file, desenlaceMotivo: OC_REAL!.motivo!, desenlaceCodigo: 'inventada/x' })
    expect(guiaDeCarga(SLOT_DIST, h, CATALOGO)).toBeNull()
    expect(desenlaceCelda(h, RUNS, href, null)).toBe(celdaPre346(h, RUNS, href))
  })

  it('sin-informe y varada: sin cambio (no hay código que resolver)', () => {
    for (const desenlace of ['sin-informe', 'varada'] as const) {
      const h = cargaMaestro({ desenlace, desenlaceMotivo: undefined, desenlaceCodigo: 'formato' })
      expect(guiaDeCarga(SLOT_MAESTRO, h, CATALOGO)).toBeNull()
      expect(desenlaceCelda(h, RUNS, href, null)).toBe(celdaPre346(h, RUNS, href))
    }
  })

  it('sin catálogo cableado no hay guía aunque haya código', () => {
    expect(guiaDeCarga(SLOT_MAESTRO, cargaMaestro({ desenlaceCodigo: 'formato' }), undefined)).toBeNull()
  })
})

describe('#346·H3 · correo a quien subió', () => {
  const base: CargaUserNoticeContext = {
    filename: MAESTRO_REAL!.file,
    desenlace: 'fallida',
    motivo: MOTIVO_508,
    uploadedBy: 'claudio@ratio.cl',
    uploadedAt: '2026-09-22T17:15:00Z',
    slotId: 'oc_crossdocking_maestro',
    slotLabel: 'Maestro de tiendas',
    domainId: 'comercial',
    baseUrl: 'https://mira.example.com',
  }
  const con = (codigo: string, params?: Record<string, string | string[]>): CargaUserNoticeContext => ({
    ...base,
    codigo,
    guia: resolverGuia(SLOT_MAESTRO, codigo, params, CATALOGO, base.filename)!,
  })

  it('actor usuario: título de la guía, qué hacer numerado, detalle técnico al final', () => {
    const n = composeCargaUserNotice(con('catalogo-incompleto/maestro-tiendas', { n: '50', tiendas_archivo: '2' }))
    expect(n.title).toBe(`El maestro de tiendas tiene que venir completo — «${base.filename}»`)
    expect(n.lines[0]).toBe('Hay que corregir el archivo.')
    expect(n.lines).toContain('1. Parte del maestro completo, no de una planilla nueva.')
    const iDetalle = n.lines.findIndex((l) => l.startsWith('Detalle técnico: '))
    expect(iDetalle).toBeGreaterThan(n.lines.indexOf('Qué hacer:'))
    expect(n.lines[iDetalle]).toContain('Pedir el maestro actualizado')
    // #269·§5.1 · los problemas frecuentes viven en la página del archivo.
    expect(n.links.map((l) => l.url)).toContain('https://mira.example.com/cargar/oc_crossdocking_maestro#problemas')
    expect(n.data).toMatchObject({ codigo: 'catalogo-incompleto/maestro-tiendas', actor: 'usuario' })
  })

  it('actor operador: NO le pide corregir nada', () => {
    const n = composeCargaUserNotice(con('falla-plataforma'))
    const texto = [n.title, ...n.lines].join('\n')
    expect(n.lines[0]).toBe('No es por tu archivo: el proceso de carga tuvo un problema propio.')
    expect(texto).not.toMatch(/Cuando lo corrijas|Hay que corregir|vuelve a subir/i)
    // #269·V12 · la línea de aviso sale solo si es cierta: sin destino ni contacto, ninguna.
    expect(texto).not.toMatch(/avisad|avisamos|Avísale/i)
    expect(composeCargaUserNotice({ ...con('falla-plataforma'), equipoAvisado: true }).lines).toContain('Le avisamos al equipo de la plataforma.')
    expect(composeCargaUserNotice({ ...con('falla-plataforma'), contacto: 'arbol@ejemplo.cl' }).lines).toContain('Avísale a arbol@ejemplo.cl.')
    expect(n.data).toMatchObject({ actor: 'operador' })
  })

  it('actor nadie: le dice que no tiene que hacer nada', () => {
    const n = composeCargaUserNotice({ ...con('en-espera'), desenlace: 'saltada' })
    expect(n.lines[0]).toBe('No tienes que hacer nada.')
    expect([n.title, ...n.lines].join('\n')).not.toMatch(/Hay que corregir|Cuando lo corrijas/)
  })

  it('sin guía: el aviso es EXACTAMENTE el de siempre (salvo el campo `codigo: null` en data)', () => {
    const n = composeCargaUserNotice(base)
    expect(n.title).toBe(`Tu archivo «${base.filename}» no pudo procesarse`)
    expect(n.lines[0]).toBe(`Motivo: ${MOTIVO_508}`)
    expect(n.links).toHaveLength(1)
  })
})

describe('#346·H3 · señal de cobertura del operador', () => {
  const conteos: DesenlaceCodigoConteo[] = [
    { codigo: null, n: 4 },
    { codigo: 'catalogo-incompleto/maestro-tiendas', n: 14 },
    { codigo: 'formato/columnas', n: 2 },
    { codigo: 'inventada/x', n: 1 },
  ]
  it('cuenta sin código, con código sin guía de instancia, y de familia desconocida, nombrando los códigos', () => {
    const html = coberturaGuias(SLOT_MAESTRO, conteos, CATALOGO)
    expect(html).toContain('4 sin código')
    expect(html).toContain('2 con código sin guía de la instancia — usaron la genérica: <code>formato/columnas</code>')
    expect(html).toContain('1 con código de familia desconocida — se mostraron sin guía: <code>inventada/x</code>')
    expect(html).not.toContain('maestro-tiendas') // tiene guía de instancia: no es hueco
  })
  it('silenciosa sin nada que reportar, o sin conteo cableado', () => {
    expect(coberturaGuias(SLOT_MAESTRO, [{ codigo: 'catalogo-incompleto/maestro-tiendas', n: 3 }], CATALOGO)).toBe('')
    expect(coberturaGuias(SLOT_MAESTRO, undefined, CATALOGO)).toBe('')
  })
})

describe('#346·H3 · «Errores frecuentes» (render)', () => {
  it('lista las guías del slot ordenadas por frecuencia, sumando códigos que caen en la misma guía', () => {
    const html = erroresFrecuentesBody('comercial', 'Comercial', SLOT_DIST, CATALOGO, [
      { codigo: 'formato/columnas', n: 2 },
      { codigo: 'formato/hoja', n: 1 },
      { codigo: 'referencia-ausente/tienda-sin-zona', n: 60 },
      { codigo: null, n: 9 },
    ])
    const iRef = html.indexOf('La OC trae tiendas')
    const iFormato = html.indexOf('El archivo no tiene la forma que se espera')
    expect(iRef).toBeGreaterThan(0)
    expect(iFormato).toBeGreaterThan(iRef)
    expect(html).toContain('ocurrió 60 veces en 90 días')
    expect(html).toContain('ocurrió 3 veces en 90 días') // formato/columnas + formato/hoja → la misma genérica
    // La guía del maestro NO aplica a la casilla de distribuciones.
    expect(html).not.toContain('El maestro de tiendas tiene que venir completo')
    // Sin un caso concreto, los marcadores se ven como «…», no como «(dato no informado)».
    expect(html).toContain('que el maestro no conoce: ….')
  })
  it('sin conteo, lo dice y lista en orden declarado', () => {
    const html = erroresFrecuentesBody('comercial', 'Comercial', SLOT_MAESTRO, CATALOGO, 'error')
    expect(html).toContain('No se pudo contar')
    expect(html.indexOf('El maestro de tiendas')).toBeLessThan(html.indexOf('La OC trae tiendas'))
  })
})

// ── Ruta y autorización: la página vive bajo el MISMO gate de dominio que Cargas ─────────────────
const ADMIN = 'cesar@ultrabase.com'
const STEWARD = 'rosario@ratio.cl'
const EXTRANO = 'nadie@ratio.cl'
function mockReq(url: string, user: string): IncomingMessage {
  const r = Readable.from(['']) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url; r.method = 'GET'; r.headers = { 'x-test-user': user }
  return r
}
interface MockRes { statusCode: number; headers: Record<string, string>; body: string; writeHead(c: number, h?: Record<string, string>): MockRes; end(chunk?: string): void }
const mockRes = (): MockRes => ({ statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(chunk) { if (chunk) this.body += chunk } })

describe('#346·H3 · ruta /admin/dominio/<id>/errores/<slot>', () => {
  let conGuias: AdminHandler
  let sinGuias: AdminHandler
  const ENTITIES = parseMasterDataConfig({ entities: [{ id: 't', label: 'T', domain: 'comercial', columns: [{ name: 'c', label: 'C', type: 'string', pk: true }] }] })
  const DOMAINS = parseDomainsConfig({ domains: [{ id: 'comercial', label: 'Comercial', stewards: [STEWARD] }] })
  const ops: CargasOps = {
    history: async () => [], runs: async () => [], log: async () => null, landing: async () => [], archived: async () => [],
    rerun: async () => {}, retire: async () => {}, restore: async () => {},
    codigos: async () => [{ codigo: 'catalogo-incompleto/maestro-tiendas', n: 14 }],
  }
  beforeEach(async () => {
    const base = async (): Promise<Parameters<typeof createAdmin>[0]> => ({
      entities: ENTITIES,
      mdStore: await SqliteMasterDataStore.open(null, ENTITIES),
      adminStore: await SqliteAdminStore.open(null, [ADMIN]),
      domains: DOMAINS,
      intakeSlots: SLOTS,
      cargas: ops,
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: 'test-secret',
    })
    conGuias = createAdmin({ ...(await base()), intakeGuias: CATALOGO })
    sinGuias = createAdmin(await base())
  })
  const go = async (a: AdminHandler, url: string, user: string): Promise<MockRes> => {
    const res = mockRes()
    await a.tryHandle(mockReq(url, user), res as unknown as ServerResponse)
    return res
  }

  it('la ruta de siempre redirige a «Problemas frecuentes» de la página del archivo, que lista la guía', async () => {
    const r = await go(conGuias, erroresHref('comercial', 'oc_crossdocking_maestro'), STEWARD)
    expect(r.statusCode).toBe(303)
    expect(r.headers['location']).toBe('/cargar/oc_crossdocking_maestro#problemas')
    const p = await go(conGuias, '/cargar/oc_crossdocking_maestro', STEWARD)
    expect(p.statusCode).toBe(200)
    expect(p.body).toContain('Problemas frecuentes y cómo resolverlos')
    expect(p.body).toContain('El maestro de tiendas tiene que venir completo')
  })

  it('quien no gestiona el dominio recibe el MISMO 403 que en Cargas', async () => {
    const errores = await go(conGuias, erroresHref('comercial', 'oc_crossdocking_maestro'), EXTRANO)
    const cargas = await go(conGuias, '/admin/dominio/comercial/cargas', EXTRANO)
    expect(cargas.statusCode).toBe(403)
    expect(errores.statusCode).toBe(403)
  })

  it('una casilla de otro dominio o inexistente ⇒ 404', async () => {
    expect((await go(conGuias, '/admin/dominio/comercial/errores/no_existe', STEWARD)).statusCode).toBe(404)
  })

  it('la consola de Cargas enlaza la página y muestra la señal; sin catálogo cableado, ni enlace ni ruta', async () => {
    const con = await go(conGuias, '/admin/dominio/comercial/cargas?slot=oc_crossdocking_maestro', STEWARD)
    expect(con.body).toContain(`href="${escapeHtml(erroresHref('comercial', 'oc_crossdocking_maestro'))}"`)
    const sin = await go(sinGuias, '/admin/dominio/comercial/cargas?slot=oc_crossdocking_maestro', STEWARD)
    expect(sin.body).not.toContain('Errores frecuentes')
    const ruta = await go(sinGuias, erroresHref('comercial', 'oc_crossdocking_maestro'), STEWARD)
    expect(ruta.statusCode).not.toBe(200)
  })
})
