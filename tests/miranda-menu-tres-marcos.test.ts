// EL ÍTEM «MIRANDA» DEL MENÚ DEL AVATAR ESTÁ EN LAS TRES SUPERFICIES QUE PINTAN ESE MENÚ (#307).
//
// El defecto: el menú de identidad se armaba N veces —una por marco: el catálogo en
// `renderIndexPage`, `/admin` en `buildAvatar`, `/impresiones` en el `avatarFor` que `notas.ts`
// recibe— y cada sitio pasaba a `avatarMenu(...)` los props que tenía a mano. `hasMiranda` nació en
// el catálogo y no llegó a los otros dos, así que la entrada DESAPARECÍA al entrar a `/admin` o a
// `/impresiones` teniendo el scope. La causa no es el prop olvidado: es que no había una sola
// definición de «¿ve Miranda?» que las tres compartieran, y por eso el test de abajo no mira solo el
// ítem — mira que ninguna llamada a `avatarMenu` de un marco pueda volver a omitirlo.
//
// Alcance de cada prueba: `mirandaMenuScope` y el marco de `/admin` se miden EJECUTANDO las piezas
// reales (`createAdmin`). El catálogo y `/impresiones` viven en `server/serve-rls.ts`, que tiene
// top-level `await` y no se puede importar desde un test, así que —igual que
// `tests/menu-hot-reload.test.ts` (7-bis)— se anclan a su TEXTO. Si un ancla no se encuentra, el
// test falla nombrándola en vez de aprobar por omisión.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mirandaMenuScope } from '../server/miranda'
import { avatarMenu } from '../server/ui'
import { createAdmin } from '../server/admin'
import { parseMasterDataConfig, SqliteMasterDataStore, SqliteAdminStore } from '@vergis/capabilities'

const RAIZ = resolve(__dirname, '..')
const SERVE = readFileSync(join(RAIZ, 'server/serve-rls.ts'), 'utf8')
const ADMIN_SRC = readFileSync(join(RAIZ, 'server/admin.ts'), 'utf8')

// ── (1) La decisión, una sola vez y fail-closed ──────────────────────────────────────────────────

describe('mirandaMenuScope · una sola definición de «¿esta identidad ve Miranda?»', () => {
  const gov = (grupo: string, miembros: string[]) => ({
    isMember: async (g: string, e: string) => g === grupo && miembros.includes(e),
  })
  const ON = { enabled: true, scopeGroup: 'miranda' }

  it('(1) admin sí, miembro del grupo sí, ajeno no', async () => {
    const g = gov('miranda', ['claudio@ratio.cl'])
    expect(await mirandaMenuScope(ON, g, 'ana@gh.cl', true)).toBe(true)
    expect(await mirandaMenuScope(ON, g, 'claudio@ratio.cl', false)).toBe(true)
    expect(await mirandaMenuScope(ON, g, 'ajeno@gh.cl', false)).toBe(false)
  })

  it('(1-bis) fail-closed: con el flag apagado o sin gobierno no la ve NADIE, ni el admin', async () => {
    const g = gov('miranda', ['claudio@ratio.cl'])
    expect(await mirandaMenuScope({ enabled: false, scopeGroup: 'miranda' }, g, 'claudio@ratio.cl', true)).toBe(false)
    expect(await mirandaMenuScope(ON, null, 'ana@gh.cl', true)).toBe(false)
  })

  it('(1-ter) el grupo consultado es el CONFIGURADO, no el literal «miranda»', async () => {
    const pedidos: string[] = []
    const g = { isMember: async (grp: string) => (pedidos.push(grp), false) }
    await mirandaMenuScope({ enabled: true, scopeGroup: 'autores-pi' }, g, 'ana@gh.cl', false)
    expect(pedidos).toEqual(['autores-pi'])
  })
})

// ── (2) El componente compartido pinta el ítem donde va ──────────────────────────────────────────

describe('avatarMenu · el ítem «Miranda»', () => {
  const base = { email: 'ana@gh.cl', isAdmin: true, hasDomains: true, signoutRd: '/' }
  it('(2) con scope aparece entre «Mis impresiones» y «Gestión»; sin scope no está', () => {
    const con = avatarMenu({ ...base, hasMiranda: true })
    expect(con).toContain('<a href="/miranda">Miranda</a>')
    expect(con.indexOf('/miranda')).toBeGreaterThan(con.indexOf('/impresiones'))
    expect(con.indexOf('/miranda')).toBeLessThan(con.indexOf('>Gestión</a>'))
    expect(avatarMenu(base)).not.toContain('/miranda')
  })
})

// ── (3) El marco de `/admin`, ejecutando el handler real ─────────────────────────────────────────

describe('/admin · el menú del avatar trae Miranda cuando la identidad tiene el scope (#307)', () => {
  const YAML = { entities: [{ id: 'e1', label: 'Entidad', columns: [{ name: 'k', label: 'K', type: 'string', pk: true }] }] }
  const req = (user: string): IncomingMessage => {
    const r = Readable.from(['']) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
    r.url = '/admin'
    r.method = 'GET'
    r.headers = { 'x-test-user': user }
    return r
  }
  const res = () => ({ statusCode: 0, body: '', writeHead(c: number) { this.statusCode = c; return this }, end(ch?: string) { if (ch) this.body += ch } })

  const montar = async (hasMiranda?: (email: string, isAdmin: boolean) => Promise<boolean>) => {
    const entities = parseMasterDataConfig(YAML)
    return createAdmin({
      entities,
      mdStore: await SqliteMasterDataStore.open(null, entities),
      adminStore: await SqliteAdminStore.open(null, ['ana@gh.cl']),
      identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
      audit: () => {},
      secret: 'test',
      ...(hasMiranda ? { hasMiranda } : {}),
    })
  }
  const pintar = async (admin: Awaited<ReturnType<typeof montar>>, user: string) => {
    const r = res()
    await admin.tryHandle(req(user), r as unknown as ServerResponse)
    return r
  }

  it('(3) con la dep cableada el ítem está — REFUTARÍA: el HTML de /admin sin `/miranda`, que es el #307', async () => {
    const r = await pintar(await montar(async () => true), 'ana@gh.cl')
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('<a href="/miranda">Miranda</a>')
  })

  it('(3-bis) la dep se consulta con la identidad del REQUEST y su rol, no con una capturada', async () => {
    const vistos: [string, boolean][] = []
    const admin = await montar(async (email, isAdmin) => (vistos.push([email, isAdmin]), email === 'ana@gh.cl'))
    const deLaAdmin = await pintar(admin, 'ANA@gh.cl') // el handler normaliza a minúsculas
    const delAjeno = await pintar(admin, 'ajeno@gh.cl')
    expect(vistos).toContainEqual(['ana@gh.cl', true])
    expect(vistos).toContainEqual(['ajeno@gh.cl', false])
    expect(deLaAdmin.body).toContain('/miranda')
    // El ajeno cae al 403 de acceso restringido — que TAMBIÉN pinta avatar, y sin scope no lo trae.
    expect(delAjeno.statusCode).toBe(403)
    expect(delAjeno.body).not.toContain('/miranda')
  })

  it('(3-ter) sin la dep (instancia sin Miranda) el menú es el de siempre: fail-closed', async () => {
    const r = await pintar(await montar(), 'ana@gh.cl')
    expect(r.body).not.toContain('/miranda')
  })
})

// ── (4) La causa raíz: ningún marco puede volver a armar el menú sin la decisión ─────────────────

/** Los argumentos de cada llamada `avatarMenu({...})` del archivo (balanceando llaves). */
function llamadasAvatarMenu(src: string): string[] {
  const out: string[] = []
  const re = /avatarMenu\(\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length - 1
    let depth = 0
    const ini = i
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) break
    }
    out.push(src.slice(ini, i + 1))
  }
  return out
}

describe('#307 · la causa raíz: el menú se arma en varios marcos y ninguno puede omitir el scope', () => {
  it('(4) TODA llamada a `avatarMenu` de un marco pasa `hasMiranda`', () => {
    const marcos: [string, string][] = [['server/serve-rls.ts', SERVE], ['server/admin.ts', ADMIN_SRC]]
    for (const [nombre, src] of marcos) {
      const calls = llamadasAvatarMenu(src)
      expect(calls.length, `no se encontró ninguna llamada a avatarMenu en ${nombre}`).toBeGreaterThan(0)
      for (const c of calls) {
        // REFUTARÍA: una llamada sin el prop — el estado de `main`, donde `/admin` y `/impresiones`
        // lo omitían y el ítem desaparecía sin que nada lo notara.
        expect(c, `una llamada a avatarMenu en ${nombre} arma el menú sin hasMiranda:\n${c}`).toMatch(/hasMiranda/)
      }
    }
  })

  it('(4-bis) las tres superficies resuelven el scope con la MISMA función, cerrada sobre el estado vivo', () => {
    // La definición única, cerrada sobre `config.miranda` y `governance` (no capturados en un booleano).
    expect(SERVE, 'no se encontró el helper único `hasMirandaFor` en serve-rls.ts').toMatch(
      /const hasMirandaFor = \(emailLc: string, isAdmin: boolean\): Promise<boolean> =>\s*\n\s*mirandaMenuScope\(config\.miranda, governance, emailLc, isAdmin\)/,
    )
    // …y `/admin` la recibe por dep, junto a `menuSections` y por el mismo motivo (el marco es uno solo).
    const i = SERVE.indexOf('menuSections: INSTANCE_CFG.menuSections,')
    expect(i, 'no se encontró el cableado de createAdmin en serve-rls.ts').toBeGreaterThan(-1)
    expect(SERVE.slice(i, i + 600)).toMatch(/hasMiranda: hasMirandaFor,/)
    // …y `/impresiones` (el `avatarFor` que recibe `createNotas`) la usa también.
    const j = SERVE.indexOf('avatarFor: async (email) => {')
    expect(j, 'no se encontró `avatarFor` en serve-rls.ts').toBeGreaterThan(-1)
    const cuerpo = SERVE.slice(j, SERVE.indexOf('},', j))
    expect(cuerpo, '/impresiones arma su avatar sin resolver el scope de Miranda').toMatch(/hasMirandaFor\(email, isAdmin\)/)
    // Y el catálogo tampoco re-deriva el predicado a mano: lo pide a la misma función.
    const k = SERVE.indexOf('const renderIndexPage =')
    expect(k, 'no se encontró `renderIndexPage` en serve-rls.ts').toBeGreaterThan(-1)
    const catalogo = SERVE.slice(k, SERVE.indexOf('const canOpenPi =', k))
    expect(catalogo).toMatch(/const hasMiranda = await hasMirandaFor\(emailLc, isAdmin\)/)
    expect(catalogo, 'el catálogo re-deriva el scope en vez de usar la función única').not.toMatch(/isMember\(config\.miranda\.scopeGroup/)
  })

  it('(4-ter) `admin.ts` resuelve el ítem por identidad a render-time, no con un booleano capturado', () => {
    expect(ADMIN_SRC).toMatch(/hasMiranda\?: \(email: string, isAdmin: boolean\) => Promise<boolean>/)
    expect(ADMIN_SRC).toMatch(/deps\.hasMiranda \? await deps\.hasMiranda\(email, isAdmin\) : false/)
  })
})
