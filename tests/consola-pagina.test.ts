/**
 * I6 · la página: que su JS inline sea JS válido, y que el token CSRF que viaja sea el de QUIEN pide.
 *
 * Lo que este test NO mide, y va dicho: la CONDUCTA en un navegador real. `new Function` valida
 * sintaxis, no comportamiento — una pasada con los ojos sigue siendo parte del cierre del PR.
 */
import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createConsola, destinoDatadoc, type ConsolaDeps, type DestinoDatadoc } from '../server/consola'
import { csrfFactory } from '../server/ui'

const SECRET = 'secreto-de-prueba'
const DEPS: ConsolaDeps = {
  config: { enabled: true, scopeGroup: 'consola-sql', timeoutMs: 60_000, maxRows: 5_000, maxConcurrentes: 1, datadocUrl: null },
  identityOf: (h) => ({ agent: 'x', user: String((h as Record<string, string>)['x-test-user'] ?? ''), claims: {} }),
  hasScope: async () => true,
  isAdmin: async () => false,
  secret: SECRET,
  estado: () => new Map([['fin', { ofrecible: true, verificadoEn: 'T', medido: {} }]]),
  databaseDe: () => 'wh_fin',
  ejecutar: async () => ({ recordsets: [], filas: 0, truncado: false, duracionMs: 1 }),
  esquema: async () => [],
  log: { inicio: () => {}, fin: () => {}, historial: () => [] },
  brandTitle: 'Vergis',
}
const consola = createConsola(DEPS)

async function pagina(user: string, c = consola): Promise<string> {
  const req = Readable.from(['']) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  req.url = '/consola'
  req.method = 'GET'
  req.headers = { 'x-test-user': user }
  let body = ''
  const res = { writeHead: () => res, end: (c?: string) => { body += c ?? '' } } as unknown as ServerResponse
  await c.tryHandle(req, res)
  return body
}

describe('consola · la página', () => {
  it('su JS inline es JS válido (sintaxis), incluidas las puras que viajan por toString()', async () => {
    const html = await pagina('ana@ga.test')
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
  })

  it('lleva el token CSRF de QUIEN la pide, y jamás el de otra identidad', async () => {
    const deAna = await pagina('ana@ga.test')
    const token = csrfFactory(SECRET)('ana@ga.test')
    expect(deAna).toContain(token)
    expect(deAna).not.toContain(csrfFactory(SECRET)('beto@ga.test'))
  })

  it('dice en la propia superficie lo que la Consola NO es', async () => {
    const html = await pagina('ana@ga.test')
    expect(html).toContain('lo que Mira mostraría')
    expect(html).toContain('solo lectura')
    expect(html).toContain('una consulta a la vez en el nodo')
  })
})

// ── #405 · el enlace al Datadoc ──────────────────────────────────────────────────────────────────
const conDatadoc = (d: DestinoDatadoc | null) => createConsola({ ...DEPS, datadoc: () => d })
const enlace = (html: string) => html.match(/<p class="cons-datadoc"[^>]*>[\s\S]*?<\/p>/)?.[0] ?? null

describe('consola · el enlace al Datadoc (#405)', () => {
  it('con destino, el enlace va junto al editor y abre en pestaña nueva con noopener', async () => {
    const html = await pagina('ana@ga.test', conDatadoc({ url: '/datadoc/', origen: 'nodo' }))
    const p = enlace(html)
    expect(p).not.toBeNull()
    expect(p).toContain('<a href="/datadoc/" target="_blank" rel="noopener">Abre el Datadoc')
    expect(p).toContain('¿Qué significa cada tabla')
    // junto al editor: inmediatamente antes del <textarea>
    expect(html).toContain(`${p}<textarea id="sql"`)
  })

  it('la dirección se ESCAPA: una comilla no cierra el atributo ni abre una etiqueta', async () => {
    const html = await pagina('ana@ga.test', conDatadoc({ url: '/datadoc/?q="><script>alert(1)</script>', origen: 'env' }))
    const p = enlace(html)!
    expect(p).toContain('href="/datadoc/?q=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
    expect(p).not.toContain('"><script>')
    expect(html).not.toContain('<script>alert(1)')
  })

  it('CONTROL NEGATIVO · sin destino la página es byte a byte la de sin capacidad', async () => {
    const sinDep = await pagina('ana@ga.test') // deps sin `datadoc`: la forma de antes de #405
    const nulo = await pagina('ana@ga.test', conDatadoc(null))
    expect(nulo).toBe(sinDep)
    expect(enlace(sinDep)).toBeNull()
    expect(sinDep).not.toContain('Datadoc')
  })

  it('lo ÚNICO que el destino agrega es el párrafo del enlace: ni CSS, ni script, ni otro nodo', async () => {
    const sinDep = await pagina('ana@ga.test')
    const con = await pagina('ana@ga.test', conDatadoc({ url: '/datadoc/', origen: 'nodo' }))
    const p = enlace(con)
    expect(p).not.toBeNull()
    expect(con.replace(p!, '')).toBe(sinDep)
  })

  it('el JS inline sigue siendo válido con el enlace puesto', async () => {
    const html = await pagina('ana@ga.test', conDatadoc({ url: 'https://docs.ga.test/datadoc/', origen: 'env' }))
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1]!)).not.toThrow()
  })
})

describe('destinoDatadoc · quién decide a dónde apunta (#405)', () => {
  it('lo declarado por la instancia manda, haya o no Datadoc del nodo', () => {
    expect(destinoDatadoc('https://docs.ga.test/', true)).toEqual({ url: 'https://docs.ga.test/', origen: 'env' })
    expect(destinoDatadoc('/datadoc/', false)).toEqual({ url: '/datadoc/', origen: 'env' })
  })
  it('`off` apaga el enlace aunque el nodo sirva su Datadoc', () => {
    expect(destinoDatadoc(false, true)).toBeNull()
  })
  it('sin declaración: el Datadoc del nodo si está encendido; si no, sin enlace', () => {
    expect(destinoDatadoc(null, true)).toEqual({ url: '/datadoc/', origen: 'nodo' })
    expect(destinoDatadoc(null, false)).toBeNull()
  })
})
