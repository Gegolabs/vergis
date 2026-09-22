/**
 * I6 · la página: que su JS inline sea JS válido, y que el token CSRF que viaja sea el de QUIEN pide.
 *
 * Lo que este test NO mide, y va dicho: la CONDUCTA en un navegador real. `new Function` valida
 * sintaxis, no comportamiento — una pasada con los ojos sigue siendo parte del cierre del PR.
 */
import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createConsola } from '../server/consola'
import { csrfFactory } from '../server/ui'

const SECRET = 'secreto-de-prueba'
const consola = createConsola({
  config: { enabled: true, scopeGroup: 'consola-sql', timeoutMs: 60_000, maxRows: 5_000, maxConcurrentes: 1 },
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
})

async function pagina(user: string): Promise<string> {
  const req = Readable.from(['']) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  req.url = '/consola'
  req.method = 'GET'
  req.headers = { 'x-test-user': user }
  let body = ''
  const res = { writeHead: () => res, end: (c?: string) => { body += c ?? '' } } as unknown as ServerResponse
  await consola.tryHandle(req, res)
  return body
}

describe('consola · la página', () => {
  it('su JS inline es JS válido (sintaxis), incluidas las puras que viajan por toString()', async () => {
    const html = await pagina('ana@gh.cl')
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
  })

  it('lleva el token CSRF de QUIEN la pide, y jamás el de otra identidad', async () => {
    const deAna = await pagina('ana@gh.cl')
    const token = csrfFactory(SECRET)('ana@gh.cl')
    expect(deAna).toContain(token)
    expect(deAna).not.toContain(csrfFactory(SECRET)('beto@gh.cl'))
  })

  it('dice en la propia superficie lo que la Consola NO es', async () => {
    const html = await pagina('ana@gh.cl')
    expect(html).toContain('lo que Mira mostraría')
    expect(html).toContain('solo lectura')
    expect(html).toContain('una consulta a la vez en el nodo')
  })
})
