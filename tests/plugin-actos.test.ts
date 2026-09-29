/**
 * PLUGIN `vergis` — los ACTOS: publish, exec run, exec rollout (sus negativas) y recon, contra el mundo
 * falso de `plugin-instrumentos.test.ts` (docker falso + nodo falso). Lo que se afirma es la parte que
 * ningún gate humano puede recordar por sí solo:
 *
 *  · publish clasifica contra el contrato vivo, respalda, escribe EN SITIO (mismo inodo), verifica el sha
 *    y espera a que el NODO tome el archivo — y si no lo toma, no dice «publicado»;
 *  · un gate `window` sin evidencia, sin impacto declarado o sin poller corriendo NO ejecuta;
 *  · lo que no está en el espejo no se publica; el estado del rollout nunca se publica;
 *  · promote y rollback se niegan sin poller, sin línea base y sin CN-1 (D10: la promoción va
 *    instrumentada por construcción). El camino feliz se mide en el banco real (V10).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cli, cliAsync, declarar, FIX, minima, tmp } from './plugin-helpers'

const DOCKER = join(FIX, 'fake-docker.sh')
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

let server: Server
let base = ''
let host = ''
let stale = false

beforeAll(async () => {
  host = tmp('vergis-actos-host-')
  mkdirSync(join(host, 'specs'))
  mkdirSync(join(host, 'rings'))
  writeFileSync(join(host, 'specs/pi-01.yaml'), 'identity:\n  code: "PI-01"\n')
  writeFileSync(join(host, 'compose.yml'), 'services:\n  caddy:\n    image: caddy:2.8.4\n')
  writeFileSync(join(host, 'rings/active.caddy'), 'reverse_proxy vergis-1-0-0:8080 {\n}\n')
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/healthz') { res.writeHead(200); return res.end(JSON.stringify({ phase: 'serving', lets: { total: 1, serving: 1 } })) }
    if (url.pathname === '/contrato') {
      if (req.headers['x-forwarded-email'] !== 'admin@ejemplo.test') { res.writeHead(403); return res.end('{}') }
      const arts = readdirSync(join(host, 'specs')).filter((f) => !f.includes('.bak-')).map((f) => {
        const s = sha(join(host, 'specs', f))
        const loaded = stale ? 'e'.repeat(64) : s
        return { source: 'specs', path: `/specs/${f}`, sha256: loaded, diskSha256: s, pending: loaded !== s, loadedAt: 'ahora' }
      })
      res.writeHead(200)
      return res.end(JSON.stringify({ version: '1.0.0', watches: [{ envs: ['VERGIS_SPECS_DIR'], paths: ['/specs'], reloads: 'specs' }], env: { bootOnly: [], reloadableContent: [], unknown: [] }, artifacts: arts, caveats: [] }))
    }
    res.writeHead(200)
    res.end('<html>ok</html>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
})
afterAll(() => server?.close())

function mundo() {
  const w = tmp('vergis-actos-mundo-')
  mkdirSync(join(w, 'containers'))
  writeFileSync(join(w, 'containers/vergis-1-0-0'), [`ring=1`, `mount=${host}/specs|/specs`, `env=VERGIS_SPECS_DIR=${host}/specs`].join('\n') + '\n')
  writeFileSync(join(w, 'containers/borde'), ['service=caddy', 'env=PATH=/usr/bin:/bin:/usr/sbin:/sbin'].join('\n') + '\n')
  return w
}

const GA = { read: 'free', content: 'operator', version: 'operator', service: 'operator', boot: 'window', 'service-interrupting': 'window', destructive: 'approval' }

function repo(over: Record<string, unknown> = {}) {
  const d = minima(
    {
      host: { root: host, compose_project: 'x', compose_file: `${host}/compose.yml` },
      rings: { env: { RINGS_EDGE: 'borde', RINGS_EDGE_URL: base, RINGS_ADMIN_EMAIL: 'admin@ejemplo.test' } },
      mirror: { families: [{ id: 'specs', kind: 'sweep', local: 'specs', remote: 'specs' }, { id: 'compose', kind: 'fixed', local: 'compose.yml', remote: 'compose.yml' }] },
      governance: { source: 'NORMA.md', window_approver: 'Operador', approver: 'Principal', gates: GA, pretest: 'render local contra el dato real (NORMA.md §5)' },
      ...over,
    },
    host,
  )
  const dir = declarar(d, { 'NORMA.md': '# norma\n' })
  cpSync(join(host, 'specs'), join(dir, 'specs'), { recursive: true })
  cpSync(join(host, 'compose.yml'), join(dir, 'compose.yml'))
  return dir
}
const env = (x: Record<string, string> = {}) => ({ VERGIS_OPS_DOCKER: DOCKER, FAKE_WORLD: mundo(), VO_NODE_BASE: base, VERGIS_OPS_STATE_DIR: tmp(), ...x })

describe('publish', () => {
  it('sin la evidencia del pre-test que la instalación exige → 2, sin tocar el host', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'specs/pi-01.yaml'), 'identity:\n  code: "PI-01"\n# cambio A\n')
    const antes = readFileSync(join(host, 'specs/pi-01.yaml'), 'utf8')
    const r = await cliAsync(['publish', 'specs/pi-01.yaml'], { cwd: dir, env: env() })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/exige un pre-test/)
    expect(readFileSync(join(host, 'specs/pi-01.yaml'), 'utf8')).toBe(antes)
  })

  it('contenido: respalda, escribe en sitio (mismo inodo), verifica el sha y espera a que el nodo lo tome → 0', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'specs/pi-01.yaml'), 'identity:\n  code: "PI-01"\n# cambio B\n')
    const ino = statSync(join(host, 'specs/pi-01.yaml')).ino
    const r = await cliAsync(['publish', 'specs/pi-01.yaml', '--pretest', 'render local ok, 9 barras'], { cwd: dir, env: env() })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/clase: content/)
    expect(r.out).toMatch(/PUBLICADO Y TOMADO/)
    expect(sha(join(host, 'specs/pi-01.yaml'))).toBe(sha(join(dir, 'specs/pi-01.yaml')))
    expect(statSync(join(host, 'specs/pi-01.yaml')).ino).toBe(ino)
    expect(readdirSync(join(host, 'specs')).some((f) => f.startsWith('pi-01.yaml.bak-'))).toBe(true)
    expect(r.out).toMatch(/rollback: vergis-ops exec run --class content -- 'cat .*pi-01\.yaml\.bak-\d+ > /)
  })

  it('si el nodo no lo toma, no dice «publicado» → 1', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'specs/pi-01.yaml'), 'identity:\n  code: "PI-01"\n# cambio C\n')
    stale = true
    const r = await cliAsync(['publish', 'specs/pi-01.yaml', '--pretest', 'x', '--timeout', '2'], { cwd: dir, env: env() })
    stale = false
    expect(r.code, r.all).toBe(1)
    expect(r.out).toMatch(/NO quedó desplegado/)
  })

  it('un archivo que ningún contenedor monta es clase service (sin corte, sin espera)', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'compose.yml'), 'services:\n  caddy:\n    image: caddy:2.8.5\n')
    const r = await cliAsync(['publish', 'compose.yml'], { cwd: dir, env: env() })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/clase: service/)
    expect(readFileSync(join(host, 'compose.yml'), 'utf8')).toMatch(/2\.8\.5/)
  })

  it('lo que no está en el espejo no se publica; el estado del rollout, nunca', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'suelto.yaml'), 'x: 1\n')
    const a = await cliAsync(['publish', 'suelto.yaml'], { cwd: dir, env: env() })
    expect(a.code, a.all).toBe(2)
    expect(a.all).toMatch(/no pertenece a ninguna familia del espejo/)
    writeFileSync(join(dir, 'specs/active.caddy'), 'x\n')
    const b = await cliAsync(['publish', 'specs/active.caddy'], { cwd: dir, env: env() })
    expect(b.code, b.all).toBe(2)
    expect(b.all).toMatch(/estado del rollout/)
  })

  it('una clase sin gate declarado pide aprobación: sin --approval no se publica', async () => {
    const dir = repo({ governance: { source: 'NORMA.md', approver: 'Principal', gates: { read: 'free' } } })
    writeFileSync(join(dir, 'specs/pi-01.yaml'), 'identity:\n  code: "PI-01"\n# cambio D\n')
    const r = await cliAsync(['publish', 'specs/pi-01.yaml'], { cwd: dir, env: env() })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/Lo aprueba Principal/)
  })
})

describe('exec run y los gates que cortan', () => {
  it('un invariante del Producto no corre aunque el gate lo permita', () => {
    const r = cli(['exec', 'run', '--class', 'destructive', '--approval', 'Principal · hoy · «sí»', '--impact', 'x', '--', 'docker compose down -v'], { cwd: repo(), env: env() })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/invariante del Producto/)
  })
  it('boot en GA: sin impacto, sin ventana o sin poller corriendo → 2 (y dice qué falta)', async () => {
    const dir = repo()
    const a = await cliAsync(['exec', 'run', '--class', 'boot', '--', 'echo recreo'], { cwd: dir, env: env() })
    expect(a.code, a.all).toBe(2)
    expect(a.all).toMatch(/declara el impacto/)
    const b = await cliAsync(['exec', 'run', '--class', 'boot', '--impact', 'caen 1 Let ~8 s', '--', 'echo recreo'], { cwd: dir, env: env() })
    expect(b.code, b.all).toBe(2)
    expect(b.all).toMatch(/La ventana la autoriza Operador/)
    const c = await cliAsync(['exec', 'run', '--class', 'boot', '--impact', 'caen 1 Let ~8 s', '--window', 'Operador · 21:00 · «dale»', '--', 'echo recreo'], { cwd: dir, env: env() })
    expect(c.code, c.all).toBe(2)
    expect(c.all).toMatch(/se MIDE/)
  })
  it('read en GA es libre', async () => {
    const r = await cliAsync(['exec', 'run', '--class', 'read', '--', 'echo mirar'], { cwd: repo(), env: env() })
    expect(r.code, r.all).toBe(0)
  })
})

describe('exec rollout: la promoción va instrumentada por construcción', () => {
  it('promote sin poller corriendo → 2, sin tocar la herramienta', async () => {
    const r = await cliAsync(['exec', 'rollout', 'promote', '1.0.1'], { cwd: repo(), env: env() })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/no hay un poller corriendo/)
  })
  it('una versión que no es exacta se rechaza → 2', () => {
    const r = cli(['exec', 'rollout', 'install', 'latest'], { cwd: repo(), env: env() })
    expect(r.code, r.all).toBe(2)
  })
  it('install coteja la herramienta del host contra el label de la candidata: distinta → 2 sin tocar nada; igual → procede', async () => {
    const w = mundo()
    mkdirSync(join(w, 'images'))
    const hostTool = join(tmp('vergis-actos-tool-'), 'botler-rollout')
    writeFileSync(hostTool, '#!/bin/sh\necho "TOOL $*"\n')
    const dir = repo({ rings: { env: { RINGS_EDGE: 'borde', RINGS_EDGE_URL: base, RINGS_ADMIN_EMAIL: 'admin@ejemplo.test', RINGS_IMAGE: 'reg/vergis' }, tool: hostTool } })
    const log = join(w, 'docker.log')
    writeFileSync(join(w, 'images/reg_vergis_1.0.1'), `sha256label=botler-rollout=${'0'.repeat(64)},vergis-rollout=x\n`)
    const mal = await cliAsync(['exec', 'rollout', 'install', '1.0.1', '--no-pull'], { cwd: dir, env: { ...env(), FAKE_WORLD: w, FAKE_LOG: log } })
    expect(mal.code, mal.all).toBe(2)
    expect(mal.all).toMatch(/la herramienta del host no es la de 1\.0\.1/)
    expect(mal.all).toMatch(/exec rollout tool 1\.0\.1/)
    expect(mal.all).not.toMatch(/TOOL install/)
    expect(mal.all).not.toMatch(/quedó descargada/) // --no-pull: no se descargó nada, y no se dice
    // sin --no-pull el cotejo descarga la candidata: la negativa lo dice, para que un 2 no se lea como «no se tocó nada»
    const conPull = await cliAsync(['exec', 'rollout', 'install', '1.0.1'], { cwd: dir, env: { ...env(), FAKE_WORLD: w, FAKE_LOG: log } })
    expect(conPull.code, conPull.all).toBe(2)
    expect(conPull.all).toMatch(/La imagen 1\.0\.1 quedó descargada en el host para el cotejo \(no se instaló ni se registró nada/)
    expect(conPull.all).not.toMatch(/TOOL install/)
    const guardado = await cliAsync(['exec', 'rollout', 'install', '1.0.1', '--no-pull', '--keep-tool'], { cwd: dir, env: { ...env(), FAKE_WORLD: w } })
    expect(guardado.code, guardado.all).toBe(0)
    expect(guardado.out).toMatch(/se conserva por --keep-tool/)
    writeFileSync(join(w, 'images/reg_vergis_1.0.1'), `sha256label=botler-rollout=${sha(hostTool)},vergis-rollout=x\n`)
    const bien = await cliAsync(['exec', 'rollout', 'install', '1.0.1', '--no-pull'], { cwd: dir, env: { ...env(), FAKE_WORLD: w } })
    expect(bien.code, bien.all).toBe(0)
    expect(bien.out).toMatch(/herramienta: la del host es la de 1\.0\.1/)
    expect(bien.out).toMatch(/TOOL install 1\.0\.1/)
  })
  it('una versión menor que min_version se rechaza → 2', async () => {
    const r = await cliAsync(['exec', 'rollout', 'install', '0.0.1'], { cwd: repo({ min_version: '0.1.0' }), env: env() })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/menor que el piso/)
  })
})

/**
 * El rollback a un anillo RETENIDO (frío) es la maniobra de emergencia, y promote/rollback exigen el CN-1
 * antes de invocar a la herramienta —que es quien arrancaría el retenido—. Contra un contenedor detenido
 * no hay control negativo posible, así que `poller cn1` arranca el retenido, con el gate de la clase
 * `version`, y espera su standby. El camino completo (retenido → CN-1 → rollback medido) se mide en el
 * banco (`deploy/rollout/bench/scripts/plugin-e2e.sh`, caso M1); acá, las dos ramas del gate.
 */
describe('poller cn1 contra un anillo retenido (detenido)', () => {
  function mundoRetenido() {
    const w = mundo()
    const bin = join(w, 'bin')
    mkdirSync(bin)
    // wget falso: el anillo en espera responde standby (lo único que la espera y el control miran).
    writeFileSync(join(bin, 'wget'), '#!/bin/sh\nprintf \'{"ok":true,"phase":"standby","lets":{"total":1,"serving":1}}\'\n', { mode: 0o755 })
    writeFileSync(join(w, 'containers/borde'), ['service=caddy', `env=PATH=${bin}:/usr/bin:/bin:/usr/sbin:/sbin`].join('\n') + '\n')
    writeFileSync(join(w, 'containers/vergis-1-0-1'), ['ring=1', 'running=0'].join('\n') + '\n')
    return w
  }

  it('sin la evidencia del gate de la clase version → 2, y NO arranca nada', async () => {
    const w = mundoRetenido()
    const log = join(w, 'docker.log')
    const dir = repo({ governance: { source: 'NORMA.md', approver: 'Principal', gates: { read: 'free' } } })
    const r = await cliAsync(['poller', 'cn1', '--ring', '1.0.1', '--seconds', '5'], { cwd: dir, env: { ...env(), FAKE_WORLD: w, FAKE_LOG: log } })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/RETENIDO/)
    expect(r.all).toMatch(/Lo aprueba Principal/)
    expect(readFileSync(log, 'utf8')).not.toMatch(/^docker start /m)
    expect(readFileSync(join(w, 'containers/vergis-1-0-1'), 'utf8')).toMatch(/running=0/)
  })

  it('con el gate cumplido lo arranca, espera su standby por la ruta del instrumento y recién mide', async () => {
    const w = mundoRetenido()
    const log = join(w, 'docker.log')
    const r = await cliAsync(['poller', 'cn1', '--ring', '1.0.1', '--seconds', '5'], { cwd: repo(), env: { ...env(), FAKE_WORLD: w, FAKE_LOG: log } })
    const calls = readFileSync(log, 'utf8')
    expect(calls, r.all).toMatch(/^docker start vergis-1-0-1$/m)
    // la espera del standby va ANTES de la medición, y por el contenedor del instrumento
    const iStart = calls.indexOf('docker start vergis-1-0-1')
    const iWait = calls.indexOf('docker exec borde wget -q -T 2 -O- http://vergis-1-0-1:8080/healthz')
    const iPoll = calls.indexOf('vergis-ops-poller.sh http://vergis-1-0-1:8080/healthz')
    expect(iStart).toBeGreaterThanOrEqual(0)
    expect(iWait).toBeGreaterThan(iStart)
    expect(iPoll).toBeGreaterThan(iWait)
    expect(r.out).toMatch(/estaba RETENIDO \(detenido\): lo arranqué y declaró phase=standby/)
    // llegó a standby: queda caliente, NO se detiene, y la salida dice cómo devolverlo a retenido
    expect(calls).not.toMatch(/^docker stop /m)
    expect(readFileSync(join(w, 'containers/vergis-1-0-1'), 'utf8')).not.toMatch(/running=0/)
    expect(r.out).toMatch(/si NO sigues con el acto, devuélvelo a retenido: `vergis-ops exec run --class version -- 'docker stop vergis-1-0-1'`/)
  }, 20_000)

  it('si el retenido que arrancó NO llega a standby, lo vuelve a detener: no deja un tercer anillo compitiendo por el lease', async () => {
    const w = mundoRetenido()
    // el anillo arranca pero nunca declara standby (queda en `booting`)
    writeFileSync(join(w, 'bin', 'wget'), '#!/bin/sh\nprintf \'{"ok":true,"phase":"booting"}\'\n', { mode: 0o755 })
    const log = join(w, 'docker.log')
    const r = await cliAsync(['poller', 'cn1', '--ring', '1.0.1', '--seconds', '5', '--standby-timeout', '2'], { cwd: repo(), env: { ...env(), FAKE_WORLD: w, FAKE_LOG: log } })
    expect(r.code, r.all).toBe(1)
    const calls = readFileSync(log, 'utf8')
    expect(calls, r.all).toMatch(/^docker start vergis-1-0-1$/m)
    expect(calls, r.all).toMatch(/^docker stop vergis-1-0-1$/m)
    expect(calls.indexOf('docker stop vergis-1-0-1')).toBeGreaterThan(calls.indexOf('docker start vergis-1-0-1'))
    expect(readFileSync(join(w, 'containers/vergis-1-0-1'), 'utf8')).toMatch(/running=0/)
    expect(r.out).toMatch(/lo volví a detener/)
    expect(r.out).toMatch(/CN-1 NO CORRIÓ/)
    // y el control no llegó a medir
    expect(calls).not.toMatch(/vergis-ops-poller\.sh http:\/\/vergis-1-0-1/)
  }, 20_000)

  it('un anillo que YA corría y no llega a standby NO se detiene: no lo arrancó este verbo', async () => {
    const w = mundoRetenido()
    writeFileSync(join(w, 'containers/vergis-1-0-1'), 'ring=1\n')
    writeFileSync(join(w, 'bin', 'wget'), '#!/bin/sh\nprintf \'{"ok":true,"phase":"booting"}\'\n', { mode: 0o755 })
    const log = join(w, 'docker.log')
    const r = await cliAsync(['poller', 'cn1', '--ring', '1.0.1', '--seconds', '5', '--standby-timeout', '2'], { cwd: repo(), env: { ...env(), FAKE_WORLD: w, FAKE_LOG: log } })
    expect(r.code, r.all).toBe(1)
    const calls = readFileSync(log, 'utf8')
    expect(calls).not.toMatch(/^docker (start|stop) /m)
  }, 20_000)
})

/**
 * La guardia que impide recrear el contenedor que ALOJA el poller se deriva del HOST, no de una clave de
 * la declaración: por omisión el poller vive en el borde (`RINGS_EDGE`), y recrear el borde con su
 * ventana mataba la medición a mitad de serie. El inyector: un registro de poller «corriendo» (pid vivo)
 * en el contenedor que se pide, contra el mundo falso.
 */
describe('exec service recreate: la guardia del contenedor que aloja el poller', () => {
  const SVC = [{ name: 'caddy', interrupting: true, reload: 'none' }]
  const W = { impact: 'el borde se recrea: caen todos los Lets ~8 s', window: 'Operador · 21:00 · «dale»' }

  async function conPoller(dir: string, stateDir: string, container: string) {
    const { writeRecord } = await (await import('./plugin-helpers')).lib('state.mjs')
    const prev = process.env.VERGIS_OPS_STATE_DIR
    process.env.VERGIS_OPS_STATE_DIR = stateDir
    const t = tmp('vergis-actos-poller-')
    writeFileSync(join(t, 'p.pid'), String(process.pid))
    writeFileSync(join(t, 'p.log'), '')
    writeRecord(join(realpathSync(dir), 'vergis-ops.json'), 'prueba', 'poller', { id: 'p-inyectado', state: 'running', container, target: 'x', pidFile: join(t, 'p.pid'), logFile: join(t, 'p.log'), interval: '0.25', startedAt: 'ahora', instrument: 'inyector' })
    if (prev === undefined) delete process.env.VERGIS_OPS_STATE_DIR
    else process.env.VERGIS_OPS_STATE_DIR = prev
  }

  it('poller corriendo en el borde por omisión (sin instrument.container) → recreate del borde se niega (2) y no toca compose', async () => {
    const dir = repo({ services: SVC })
    const st = tmp()
    await conPoller(dir, st, 'borde')
    const w = mundo()
    const log = join(w, 'docker.log')
    const r = await cliAsync(['exec', 'service', 'caddy', 'recreate', '--impact', W.impact, '--window', W.window], { cwd: dir, env: { ...env(), FAKE_WORLD: w, FAKE_LOG: log, VERGIS_OPS_STATE_DIR: st } })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/aloja el poller que está corriendo \(p-inyectado en «borde»\)/)
    expect(r.all).toMatch(/instrument\.container/)
    expect(readFileSync(log, 'utf8')).not.toMatch(/ up -d /)
  })

  it('control: con el poller en otro contenedor, el mismo recreate pasa la guardia y recrea (0)', async () => {
    const dir = repo({ services: SVC, instrument: { container: 'relay' } })
    const st = tmp()
    await conPoller(dir, st, 'relay')
    const w = mundo()
    writeFileSync(join(w, 'containers/relay'), ['service=relay', 'env=PATH=/usr/bin:/bin'].join('\n') + '\n')
    const log = join(w, 'docker.log')
    const r = await cliAsync(['exec', 'service', 'caddy', 'recreate', '--impact', W.impact, '--window', W.window], { cwd: dir, env: { ...env(), FAKE_WORLD: w, FAKE_LOG: log, VERGIS_OPS_STATE_DIR: st } })
    expect(r.code, r.all).toBe(0)
    expect(readFileSync(log, 'utf8')).toMatch(/compose -p x -f .* up -d --no-deps caddy/)
  })

  it('check dice qué servicio aloja el instrumento, derivado del default', () => {
    const dir = repo({ services: SVC })
    writeFileSync(join(dir, 'compose.yml'), 'services:\n  caddy:\n    image: caddy:2.8.4\n    container_name: borde\n')
    const r = cli(['check'], { cwd: dir })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/instrumento: vive en «borde» \(RINGS_EDGE, por omisión\) = servicio «caddy»/)
    expect(r.out).toMatch(/exec service caddy recreate` se niega mientras el poller corra ahí/)
  })
})

describe('recon', () => {
  it('reporta sin tocar nada; sin herramienta en el host es medición a medias (7), no verde', async () => {
    const r = await cliAsync(['recon'], { cwd: repo({ rings: { env: { RINGS_EDGE: 'borde', RINGS_EDGE_URL: base, RINGS_ADMIN_EMAIL: 'admin@ejemplo.test' }, tool: '/no/existe/botler-rollout' } }), env: env() })
    expect(r.code, r.all).toBe(7)
    expect(r.out).toMatch(/health: borde OK/)
    expect(r.out).toMatch(/watch VERGIS_SPECS_DIR/)
    expect(r.out).toMatch(/NOTOOL/)
    expect(existsSync(join(host, 'specs'))).toBe(true)
  })
})

/**
 * La cuenta del poller: el exit y el texto dicen lo mismo. Un SINMEDIR sale 7 («medí a medias»), y el
 * texto no lo llama corte: con timeout de 2 s es compatible con una retención de la sala de espera > 2 s
 * (#367). El inyector: un registro de poller con un log escrito a mano, contra el mundo falso.
 */
describe('poller count: SINMEDIR no se llama corte', () => {
  async function conLog(dir: string, stateDir: string, log: string) {
    const { writeRecord } = await (await import('./plugin-helpers')).lib('state.mjs')
    const prev = process.env.VERGIS_OPS_STATE_DIR
    process.env.VERGIS_OPS_STATE_DIR = stateDir
    const t = tmp('vergis-actos-count-')
    writeFileSync(join(t, 'p.log'), log)
    writeRecord(join(realpathSync(dir), 'vergis-ops.json'), 'prueba', 'poller', { id: 'p-cuenta', state: 'running', container: 'borde', target: 'x', pidFile: join(t, 'p.pid'), logFile: join(t, 'p.log'), interval: '0.25', startedAt: 'ahora', instrument: 'inyector' })
    if (prev === undefined) delete process.env.VERGIS_OPS_STATE_DIR
    else process.env.VERGIS_OPS_STATE_DIR = prev
  }
  const ok = (t: number) => `${t.toFixed(2)} 12:00:00 OK status=2xx phase=serving lets=1/1`

  it('1 SINMEDIR entre OK → 7, «medí a medias», y los SINMEDIR van como «sin medir»', async () => {
    const dir = repo()
    const st = tmp()
    await conLog(dir, st, [ok(1), ok(1.25), '1.50 12:00:01 SINMEDIR wget:_download_timed_out_', ok(3.75)].join('\n') + '\n')
    const r = await cliAsync(['poller', 'count'], { cwd: dir, env: { ...env(), VERGIS_OPS_STATE_DIR: st } })
    expect(r.code, r.all).toBe(7)
    expect(r.out).toMatch(/MEDÍ A MEDIAS \(exit 7\): 0 muestra\(s\) MAL .* y 1 SINMEDIR, que en la fila van como «sin medir», no como corte/)
    expect(r.out).not.toMatch(/MEDÍ \(exit 1\)/)
  })

  it('1 MAL sin SINMEDIR → 1, y ESE es el corte', async () => {
    const dir = repo()
    const st = tmp()
    await conLog(dir, st, [ok(1), '1.25 12:00:01 MAL status=503 phase=- lets=-', ok(1.5)].join('\n') + '\n')
    const r = await cliAsync(['poller', 'count'], { cwd: dir, env: { ...env(), VERGIS_OPS_STATE_DIR: st } })
    expect(r.code, r.all).toBe(1)
    expect(r.out).toMatch(/MEDÍ \(exit 1\): 1 muestra\(s\) fuera de predicado — ESE es el corte/)
  })
})
