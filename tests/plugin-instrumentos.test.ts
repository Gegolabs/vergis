/**
 * PLUGIN `vergis` · V4 — los instrumentos que miden contratos del Producto (D8), con sus controles
 * negativos. Cada instrumento tiene su prueba de «sabe fallar»: el inyector de fallas sale en rojo con
 * el código que el instrumento del primer adoptante daba (paridad: hash→1 · path→1 · mute→5 · dir→7 ·
 * count→7; smoke: mute→5 · nonce→3 · count→7 · page→1; marcas: mismo→3 · sin-aria→5 · motor→4).
 *
 * El mundo: transporte `local`, un `docker` falso (`tests/fixtures/plugin/fake-docker.sh`) y un nodo
 * falso — un servidor HTTP de la prueba que habla `/healthz`, `/contrato` y las vistas. El poller se mide
 * contra el borde REAL del banco en V10 (`scripts/plugin-e2e-banco.sh`): BusyBox wget no se simula.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { runSpec } from '@vergis/cli'
import type { Capability } from '@vergis/botler'
import { cli, cliAsync, declarar, FIX, minima, tmp } from './plugin-helpers'

const DOCKER = join(FIX, 'fake-docker.sh')
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

const SPEC = (code: string, pages = '') => `mira_version: "1.0"
identity:
  id: ${code.toLowerCase()}
  code: "${code}"
  display_name: "${code}"
${pages}`

// ─── El nodo falso ─────────────────────────────────────────────────────────────────────────────────
interface Estado {
  health: () => { status: number; body: string }
  artifactOverride: string | null
}
let server: Server
let base = ''
const estado: Estado = {
  health: () => ({ status: 200, body: JSON.stringify({ ok: true, phase: 'serving', lets: { total: 2, serving: 2 } }) }),
  artifactOverride: null,
}
let hostRoot = ''

function nav(pages: string[], active: string) {
  return `<nav>${pages.map((p) => `<a href="?page=${p}"${p === active ? ' class="active"' : ''}>${p}</a>`).join('')}</nav>`
}

beforeAll(async () => {
  hostRoot = tmp('vergis-host-')
  mkdirSync(join(hostRoot, 'specs'))
  mkdirSync(join(hostRoot, 'rings'))
  writeFileSync(join(hostRoot, 'specs/pi-01.yaml'), SPEC('PI-01'))
  writeFileSync(join(hostRoot, 'specs/pi-02.yaml'), SPEC('PI-02', 'pages:\n  - id: resumen\n  - id: detalle\n  - id: drill\n    context: [x]\n'))
  writeFileSync(join(hostRoot, 'rings/active.caddy'), 'reverse_proxy vergis-1-0-0:8080 {\n\timport anillo_activo\n}\n')
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const email = String(req.headers['x-forwarded-email'] ?? '')
    if (url.pathname === '/healthz') {
      const h = estado.health()
      res.writeHead(h.status, { 'content-type': 'application/json' })
      return res.end(h.body)
    }
    if (url.pathname === '/contrato') {
      if (email !== 'admin@ejemplo.test') { res.writeHead(403); return res.end(JSON.stringify({ error: 'se requiere rol de administrador' })) }
      const arts = readdirSync(join(hostRoot, 'specs')).map((f) => {
        const s = sha(join(hostRoot, 'specs', f))
        const loaded = estado.artifactOverride ?? s
        return { source: 'specs', path: `/specs/${f}`, sha256: loaded, diskSha256: s, pending: loaded !== s, loadedAt: '2026-09-29T00:00:00Z' }
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ version: '1.0.0', watches: [{ envs: ['VERGIS_SPECS_DIR'], paths: ['/specs'], reloads: 'specs: rebuild' }], env: { bootOnly: ['VERGIS_ENGINE'], reloadableContent: ['VERGIS_SPECS_DIR'], unknown: [] }, artifacts: arts, caveats: [], delta: { unchanged: true } }))
    }
    const slug = url.pathname.slice(1)
    const page = url.searchParams.get('page')
    if (slug === 'pi-01') { res.writeHead(200); return res.end('<html>Hola PI-01 · Tipo de Socio · para ' + email + '</html>') }
    if (slug === 'pi-02') {
      const pages = ['resumen', 'detalle']
      const active = page && pages.includes(page) ? page : 'resumen' // un ?page= desconocido cae en silencio a la 1ª
      res.writeHead(200)
      return res.end(`<html>${nav(pages, active)}vista ${active}</html>`)
    }
    res.writeHead(404)
    res.end('no existe')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
})
afterAll(() => server?.close())

function mundo(opts: { conRing?: boolean } = {}) {
  const w = tmp('vergis-mundo-')
  mkdirSync(join(w, 'containers'))
  if (opts.conRing !== false) {
    writeFileSync(join(w, 'containers/vergis-1-0-0'), [`ring=1`, `mount=${hostRoot}/specs|/specs`, `env=VERGIS_SPECS_DIR=${hostRoot}/specs`].join('\n') + '\n')
  }
  // El borde falso NO trae wget (PATH del sistema, sin Homebrew): el poller real se mide en el banco (V10),
  // y acá un poller lanzado de verdad quedaría corriendo en la máquina de la prueba.
  writeFileSync(join(w, 'containers/borde'), ['service=caddy', `mount=${hostRoot}/Caddyfile|/etc/caddy/Caddyfile`, 'env=PATH=/usr/bin:/bin:/usr/sbin:/sbin'].join('\n') + '\n')
  return w
}

function decl(over: Record<string, unknown> = {}) {
  return minima(
    {
      rings: { env: { RINGS_EDGE: 'borde', RINGS_DIR: './rings', RINGS_EDGE_URL: base, RINGS_ADMIN_EMAIL: 'admin@ejemplo.test' } },
      probe_identities: [{ id: 'qa', email: 'qa@ejemplo.test', groups: ['g1'] }],
      rls_checks: [{ route: 'pi-01', identity: 'qa', present: ['Tipo de Socio'], absent: ['Confidencial'] }],
      governance: { gates: { read: 'free', content: 'operator' } },
      ...over,
    },
    hostRoot,
  )
}

const env = (w: string, extra: Record<string, string> = {}) => ({ VERGIS_OPS_DOCKER: DOCKER, FAKE_WORLD: w, VO_NODE_BASE: base, VERGIS_OPS_STATE_DIR: tmp(), ...extra })

// ─── health ────────────────────────────────────────────────────────────────────────────────────────
describe('health: el predicado canónico por el borde', () => {
  it('serving con lets completos → 0', async () => {
    const r = await cliAsync(['health'], { cwd: declarar(decl()), env: env(mundo({ conRing: true })) })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/SANO/)
  })
  it('un nodo en espera responde 200 con ok:true y NO es sano → 1', async () => {
    estado.health = () => ({ status: 200, body: JSON.stringify({ ok: true, phase: 'standby', lets: { total: 2, serving: 2 } }) })
    const r = await cliAsync(['health'], { cwd: declarar(decl()), env: env(mundo()) })
    estado.health = () => ({ status: 200, body: JSON.stringify({ ok: true, phase: 'serving', lets: { total: 2, serving: 2 } }) })
    expect(r.code, r.all).toBe(1)
    expect(r.out).toMatch(/phase=standby/)
  })
  it('la sala de espera (HTML con el literal "phase":"serving" en un comentario) NO es sana → 1', async () => {
    estado.health = () => ({ status: 200, body: '<html><!-- "phase":"serving" --><p>Espere…</p></html>' })
    const r = await cliAsync(['health'], { cwd: declarar(decl()), env: env(mundo()) })
    estado.health = () => ({ status: 200, body: JSON.stringify({ ok: true, phase: 'serving', lets: { total: 2, serving: 2 } }) })
    expect(r.code, r.all).toBe(1)
    expect(r.out).toMatch(/cuerpo NO-JSON/)
  })
  it('lets incompletos (degradado) → 1', async () => {
    estado.health = () => ({ status: 200, body: JSON.stringify({ ok: false, phase: 'serving', lets: { total: 2, serving: 1 } }) })
    const r = await cliAsync(['health'], { cwd: declarar(decl()), env: env(mundo()) })
    estado.health = () => ({ status: 200, body: JSON.stringify({ ok: true, phase: 'serving', lets: { total: 2, serving: 2 } }) })
    expect(r.code, r.all).toBe(1)
  })
  it('la declaración mínima alcanza para health', async () => {
    const d = minima({ rings: { env: { RINGS_EDGE: 'borde', RINGS_EDGE_URL: base } } }, hostRoot)
    const r = await cliAsync(['health'], { cwd: declarar(d), env: env(mundo()) })
    expect(r.code, r.all).toBe(0)
  })
})

// ─── smoke ─────────────────────────────────────────────────────────────────────────────────────────
describe('smoke: todas las vistas de todos los Lets, con sus inyectores', () => {
  it('control positivo → 0, con las vistas derivadas del spec y el drill listado como no medido', async () => {
    const r = await cliAsync(['smoke', '--rls'], { cwd: declarar(decl()), env: env(mundo()) })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/LET pi-02 vistas=2 ok=2 drill-no-medidas=drill/)
    expect(r.out).toMatch(/RLS OK pi-01 qa/)
  })
  it('PROBE_FAULT=mute → 5', async () => {
    const r = await cliAsync(['smoke'], { cwd: declarar(decl()), env: env(mundo(), { PROBE_FAULT: 'mute' }) })
    expect(r.code, r.all).toBe(5)
  })
  it('PROBE_FAULT=nonce → 3', async () => {
    const r = await cliAsync(['smoke'], { cwd: declarar(decl()), env: env(mundo(), { PROBE_FAULT: 'nonce' }) })
    expect(r.code, r.all).toBe(3)
  })
  it('PROBE_FAULT=count → 7 (el inventario no reconcilia con /healthz)', async () => {
    const r = await cliAsync(['smoke'], { cwd: declarar(decl()), env: env(mundo(), { PROBE_FAULT: 'count' }) })
    expect(r.code, r.all).toBe(7)
  })
  it('PROBE_FAULT=page → 1 (el fallback silencioso de ?page= se caza)', async () => {
    const r = await cliAsync(['smoke'], { cwd: declarar(decl()), env: env(mundo(), { PROBE_FAULT: 'page' }) })
    expect(r.code, r.all).toBe(1)
    expect(r.out).toMatch(/SIRVIÓ page=resumen/)
  })
  it('una ruta con needles; una needle ausente es hallazgo', async () => {
    const ok = await cliAsync(['smoke', '/pi-01/', '--needle', 'Tipo de Socio'], { cwd: declarar(decl()), env: env(mundo()) })
    expect(ok.code, ok.all).toBe(0)
    expect(ok.all).toMatch(/ruta normalizada/)
    const mal = await cliAsync(['smoke', 'pi-01', '--needle', 'No Está'], { cwd: declarar(decl()), env: env(mundo()) })
    expect(mal.code, mal.all).toBe(1)
  })
  it('RLS: un absent que aparece es hallazgo', async () => {
    const d = decl({ rls_checks: [{ route: 'pi-01', identity: 'qa', present: [], absent: ['Tipo de Socio'] }] })
    const r = await cliAsync(['smoke', '--rls'], { cwd: declarar(d), env: env(mundo()) })
    expect(r.code, r.all).toBe(1)
    expect(r.out).toMatch(/RLS MAL pi-01 qa .*sobran=\["Tipo de Socio"\]/)
  })
  it('sin probe_identities → 2 nombrando la clave', () => {
    const d = decl()
    delete d.installations[0].probe_identities
    const r = cli(['smoke'], { cwd: declarar(d), env: env(mundo()) })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/no declara «probe_identities»/)
  })
})

// ─── contract ──────────────────────────────────────────────────────────────────────────────────────
describe('contract: lo que el nodo declara, y la clasificación que se deriva', () => {
  function conEspejo() {
    const d = decl({ mirror: { families: [{ id: 'specs', kind: 'sweep', local: 'specs', remote: 'specs' }] } })
    const dir = declarar(d)
    cpSync(join(hostRoot, 'specs'), join(dir, 'specs'), { recursive: true })
    return dir
  }
  it('resumen → 0', async () => {
    const r = await cliAsync(['contract'], { cwd: declarar(decl()), env: env(mundo()) })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/watch VERGIS_SPECS_DIR · \/specs/)
  })
  it('un spec bajo el watch del contrato vivo es content, con su gate', async () => {
    const dir = conEspejo()
    const r = await cliAsync(['contract', 'classify', 'specs/pi-01.yaml'], { cwd: dir, env: env(mundo()) })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/clase: content/)
    expect(r.out).toMatch(/gate: operator/)
  })
  it('sin identidad admin, el contrato no responde y lo montado es interrupción (boot)', async () => {
    const d = decl({ mirror: { families: [{ id: 'specs', kind: 'sweep', local: 'specs', remote: 'specs' }] }, rings: { env: { RINGS_EDGE: 'borde', RINGS_EDGE_URL: base, RINGS_ADMIN_EMAIL: 'nadie@ejemplo.test' } } })
    const dir = declarar(d)
    cpSync(join(hostRoot, 'specs'), join(dir, 'specs'), { recursive: true })
    const r = await cliAsync(['contract', 'classify', 'specs/pi-01.yaml'], { cwd: dir, env: env(mundo()) })
    expect(r.out).toMatch(/clase: boot/)
    expect(r.out).toMatch(/403/)
  })
  it('wait: sha cargado == sha local y pending=false → 0; un sha cargado viejo → 1', async () => {
    const dir = conEspejo()
    const ok = await cliAsync(['contract', 'wait', 'specs/pi-01.yaml', '--timeout', '2'], { cwd: dir, env: env(mundo()) })
    expect(ok.code, ok.all).toBe(0)
    estado.artifactOverride = 'f'.repeat(64)
    const mal = await cliAsync(['contract', 'wait', 'specs/pi-01.yaml', '--timeout', '2'], { cwd: dir, env: env(mundo()) })
    estado.artifactOverride = null
    expect(mal.code, mal.all).toBe(1)
    expect(mal.all).toMatch(/NO lo tomó/)
  })
})

// ─── parity ────────────────────────────────────────────────────────────────────────────────────────
describe('parity: espejo↔host por sha256, con la guardia G1 y sus cinco inyectores', () => {
  function espejo(over: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
    const host = tmp('vergis-par-host-')
    mkdirSync(join(host, 'specs'))
    writeFileSync(join(host, 'specs/a.yaml'), 'a: 1\n')
    writeFileSync(join(host, 'specs/b.yaml'), 'b: 2\n')
    writeFileSync(join(host, 'compose.yml'), 'services:\n  vergis:\n    image: x:1.0.0\n    volumes:\n      - ./specs:/specs:ro\n      - ./governance:/governance\n    env_file: [vergis.env]\n')
    const d = minima(
      {
        host: { root: host, compose_file: `${host}/compose.yml` },
        mirror: {
          families: [
            { id: 'compose', kind: 'fixed', local: 'compose.yml', remote: 'compose.yml' },
            { id: 'specs', kind: 'sweep', local: 'specs', remote: 'specs' },
          ],
          unmirrored: [{ path: 'governance', reason: 'estado de runtime del nodo' }],
        },
        ...over,
      },
      host,
    )
    const dir = declarar(d, extra)
    cpSync(join(host, 'specs'), join(dir, 'specs'), { recursive: true })
    cpSync(join(host, 'compose.yml'), join(dir, 'compose.yml'))
    return { dir, host }
  }
  const e = (x: Record<string, string> = {}) => ({ VERGIS_OPS_STATE_DIR: tmp(), ...x })

  it('control positivo: paridad total → 0', () => {
    const { dir } = espejo()
    const r = cli(['parity'], { cwd: dir, env: e() })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/PARIDAD TOTAL/)
  })
  for (const [fault, code, marca] of [['hash', 1, /DRIFT/], ['path', 1, /AUSENTE/], ['mute', 5, /remoto mudo/], ['dir', 7, /ERR/], ['count', 7, /CUENTAS NO CUADRAN/]] as const) {
    it(`PARIDAD_FAULT=${fault} → ${code}`, () => {
      const { dir } = espejo()
      const r = cli(['parity'], { cwd: dir, env: e({ PARIDAD_FAULT: fault }) })
      expect(r.code, r.all).toBe(code)
      expect(r.all).toMatch(marca)
    })
  }
  it('un archivo solo en el host es SOLO-HOST → 1; uno solo en el espejo, SOLO-REPO → 1', () => {
    const a = espejo()
    writeFileSync(join(a.host, 'specs/huerfano.yaml'), 'x: 1\n')
    const r = cli(['parity'], { cwd: a.dir, env: e() })
    expect(r.code, r.all).toBe(1)
    expect(r.out).toMatch(/SOLO-HOST .*huerfano\.yaml/)
    const b = espejo()
    writeFileSync(join(b.dir, 'specs/nuevo.yaml'), 'n: 1\n')
    const s = cli(['parity'], { cwd: b.dir, env: e() })
    expect(s.code, s.all).toBe(1)
    expect(s.out).toMatch(/SOLO-REPO .*nuevo\.yaml/)
  })
  it('G1: un montaje del compose espejado sin cubrir → 2, sin tocar el host', () => {
    const { dir } = espejo({ mirror: { families: [{ id: 'compose', kind: 'fixed', local: 'compose.yml', remote: 'compose.yml' }, { id: 'specs', kind: 'sweep', local: 'specs', remote: 'specs' }] } })
    const r = cli(['parity'], { cwd: dir, env: e() })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/G1 SIN-MAPEO[\s\S]*governance/)
  })
  it('una exclusión declarada se lista con su motivo y no se reclama', () => {
    const { dir, host } = espejo()
    const doc = JSON.parse(readFileSync(join(dir, 'vergis-ops.json'), 'utf8'))
    doc.installations[0].mirror.families[1].exclude = [{ path: 'legado.yaml', reason: 'legado, jamás desplegado' }]
    writeFileSync(join(dir, 'vergis-ops.json'), JSON.stringify(doc))
    writeFileSync(join(dir, 'specs/legado.yaml'), 'l: 1\n')
    writeFileSync(join(host, 'specs/legado.yaml'), 'otro: 1\n')
    const r = cli(['parity'], { cwd: dir, env: e() })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/EXCL .*legado\.yaml .*jamás desplegado/)
  })
  it('--family acota; --dry-run no toca el host', () => {
    const { dir } = espejo()
    expect(cli(['parity', '--family', 'specs'], { cwd: dir, env: e() }).code).toBe(0)
    const d = cli(['parity', '--dry-run'], { cwd: dir, env: e({ PARIDAD_FAULT: 'mute' }) })
    expect(d.code, d.all).toBe(0)
    expect(d.out).toMatch(/DRY-RUN: no se tocó el host/)
  })
  it('sobre la declaración mínima sale 2 nombrando mirror.families', () => {
    const r = cli(['parity'], { cwd: declarar(minima()), env: e() })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/no declara «mirror\.families»/)
  })
})

// ─── marks ─────────────────────────────────────────────────────────────────────────────────────────
describe('marks: la corrida discriminante y su inyector', () => {
  const dir = tmp('vergis-marcas-')
  const cal = join(dir, 'cal.json')
  const spec = `mira_version: "1.0"
identity: { id: cal-singular, display_name: "Singular", classification: internal }
piece:
  distribution: { dimension: data.d.cat, metric: data.d.v, title: "Singular" }
data:
  d:
    capability: mock-sql
    params: { sql: "SELECT cat, v FROM dbo.x" }
    shape: { type: rows, fields: { cat: string, v: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`
  async function render(n: number, out: string) {
    const rows = Array.from({ length: n }, (_, i) => ({ cat: 'C' + (i + 1), v: (i + 1) * 10 }))
    const mock = { name: 'mock-sql', async execute() { return { rows } } } as unknown as Capability
    writeFileSync(join(dir, 'spec.yaml'), spec)
    const r = await runSpec({ specPath: join(dir, 'spec.yaml'), baseDir: dir, extraCapabilities: [mock] })
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true)
    writeFileSync(out, (r as { html?: string }).html ?? '')
  }
  beforeAll(async () => {
    await render(3, join(dir, 's3.html'))
    await render(7, join(dir, 's7.html'))
  })
  const base = ['--forma', 'singular', '--calibracion', cal]

  it('calibrar con dos cardinalidades conocidas da los dos números correctos → 0', () => {
    const r = cli(['marks', 'calibrar', '--html-a', join(dir, 's3.html'), '--n-a', '3', '--html-b', join(dir, 's7.html'), '--n-b', '7', ...base])
    expect(r.code, r.all).toBe(0)
    expect(r.err).toMatch(/A: esperado 3 · medido 3/)
    expect(r.err).toMatch(/B: esperado 7 · medido 7/)
  })
  it('con dos cardinalidades iguales se niega → 2', () => {
    const r = cli(['marks', 'calibrar', '--html-a', join(dir, 's3.html'), '--n-a', '3', '--html-b', join(dir, 's3.html'), '--n-b', '3', ...base])
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/son iguales/)
  })
  it('MARCAS_FAULT=mismo → 3 (selector muerto) y no escribe calibración', () => {
    const c2 = join(tmp(), 'cal.json')
    const r = cli(['marks', 'calibrar', '--html-a', join(dir, 's3.html'), '--n-a', '3', '--html-b', join(dir, 's7.html'), '--n-b', '7', '--forma', 'singular', '--calibracion', c2], { env: { MARCAS_FAULT: 'mismo' } })
    expect(r.code, r.all).toBe(3)
    expect(cli(['marks', 'vigencia', '--calibracion', c2]).code).toBe(4)
  })
  it('MARCAS_FAULT=sin-aria → 5 (no es «cero marcas»)', () => {
    const r = cli(['marks', 'contar', '--html', join(dir, 's3.html'), ...base], { env: { MARCAS_FAULT: 'sin-aria' } })
    expect(r.code, r.all).toBe(5)
  })
  it('contar con calibración vigente: cuadra → 0; no cuadra → 1; motor falseado → 4', () => {
    cli(['marks', 'calibrar', '--html-a', join(dir, 's3.html'), '--n-a', '3', '--html-b', join(dir, 's7.html'), '--n-b', '7', ...base])
    expect(cli(['marks', 'contar', '--html', join(dir, 's7.html'), '--esperado', '7', ...base]).code).toBe(0)
    expect(cli(['marks', 'contar', '--html', join(dir, 's7.html'), '--esperado', '6', ...base]).code).toBe(1)
    expect(cli(['marks', 'contar', '--html', join(dir, 's7.html'), '--esperado', '7', ...base], { env: { MARCAS_FAULT: 'motor' } }).code).toBe(4)
  })
})

// ─── POSIX ─────────────────────────────────────────────────────────────────────────────────────────
describe('los scripts remotos son sh POSIX (la VM corre dash; BusyBox ash en los contenedores)', () => {
  // Medido al construir V4: un `case … in "$s") …` dentro de `$( … )` revienta con «syntax error near
  // unexpected token ;;» — y el CLI lo leía como «/contrato no respondió». Esta prueba vuelca CADA
  // script que el CLI genera en estas corridas y le pasa `dash -n` al cuerpo; sin dash, no mide y lo dice.
  const DASH = ['/bin/dash', '/usr/bin/dash'].find((p) => existsSync(p))
  it.skipIf(!DASH)('dash -n acepta el cuerpo de cada script generado', async () => {
    const dump = tmp('vergis-dump-')
    const w = mundo()
    const d = decl({ mirror: { families: [{ id: 'specs', kind: 'sweep', local: 'specs', remote: 'specs' }] } })
    const dir = declarar(d)
    cpSync(join(hostRoot, 'specs'), join(dir, 'specs'), { recursive: true })
    const e = env(w, { VERGIS_OPS_DUMP_DIR: dump })
    for (const args of [['health'], ['smoke', '--rls'], ['smoke', 'pi-02?page=detalle', '--needle', 'vista'], ['contract'], ['contract', 'classify', 'specs/pi-01.yaml'], ['contract', 'wait', 'specs/pi-01.yaml', '--timeout', '1'], ['contract', 'env', 'VERGIS_ENGINE'], ['parity'], ['poller', 'start'], ['poller', 'cn1', '--ring', '1.0.0', '--seconds', '5'], ['exec', 'run', '--class', 'read', '--', 'echo hola'], ['marks', 'ruta', 'pi-01']]) {
      await cliAsync(args, { cwd: dir, env: e })
    }
    const scripts = readdirSync(dump)
    expect(scripts.length).toBeGreaterThanOrEqual(12)
    for (const f of scripts) {
      const txt = readFileSync(join(dump, f), 'utf8')
      const m = /cat > "\$VO_T\/body\.sh" <<'(VO_BODY_[0-9a-f]+)'\n([\s\S]*?)\n\1\n/.exec(txt)
      expect(m, `sin cuerpo en ${f}`).toBeTruthy()
      const body = join(dump, f + '.body')
      writeFileSync(body, m![2]!)
      for (const s of [join(dump, f), body]) {
        const r = spawnSync(DASH!, ['-n', s], { encoding: 'utf8' })
        expect(r.status, `${s}\n${r.stderr}`).toBe(0)
      }
    }
  }, 60_000)
})
