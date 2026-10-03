/**
 * PLUGIN `vergis` · el poller de corte donde el acto no lo toca (#376) y midiendo retención (#367).
 *
 *  · #376 · `check` SONDEA el contenedor del instrumento en el host y sale 2 nombrando lo que falta —
 *    antes, la sonda llegaba recién en `poller start`, en medio del acto. Si no pudo sondearlo sale 7,
 *    nunca 0: «no pude medir» no es «medí y puede».
 *  · #376 · el poller tiene un hermano para el contenedor solo-node (`poller-node.mjs`): `poller start`,
 *    `count`, `stop` y `cn1` corren ahí sin una sola herramienta del contenedor fuera de `node` (el
 *    contenedor falso de la prueba tiene en su PATH SOLO `node`: ni `sh`), y da el MISMO veredicto que
 *    `poller.sh` muestra a muestra.
 *  · #367 · timeout de 10 s por omisión y latencia por muestra (`ms=`): un request RETENIDO 2,5 s es OK
 *    con su latencia, no SINMEDIR; con timeout corto, los dos instrumentos dicen SINMEDIR — y la fila
 *    del corte separa «sin medir» de «fuera de predicado».
 *
 * El wget del contenedor `sh` es un FALSO con los mensajes de BusyBox (`server returned error: HTTP/1.1
 * <n>`, `download timed out`), que es lo que `poller.sh` lee. El BusyBox real se mide en el banco
 * (`deploy/rollout/bench`); esta prueba mide los dos instrumentos contra el mismo servidor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cli, cliAsync, declarar, FIX, lib, minima, PLUGIN, tmp } from './plugin-helpers'

const DOCKER = join(FIX, 'fake-docker.sh')
const LINUX_UPTIME = existsSync('/proc/uptime') // el reloj de las muestras; en macOS el sh no mide ms

// ─── El nodo falso: un caso por ruta ───────────────────────────────────────────────────────────────
const SERVING = JSON.stringify({ ok: true, phase: 'serving', lets: { total: 2, serving: 2 } })
const CASOS: Record<string, { status: number; body: string; delay?: number }> = {
  serving: { status: 200, body: SERVING },
  standby: { status: 200, body: JSON.stringify({ ok: true, phase: 'standby', lets: { total: 2, serving: 2 } }) },
  degradado: { status: 200, body: JSON.stringify({ ok: false, phase: 'serving', lets: { total: 2, serving: 1 } }) },
  pis: { status: 200, body: JSON.stringify({ ok: true, phase: 'serving', pis: { total: 3, serving: 3 } }) },
  sueltos: { status: 200, body: JSON.stringify({ phase: 'serving', total: 2, serving: 2 }) },
  sala: { status: 200, body: '<html><!--_"phase":"serving"_--><p>Espere</p></html>' },
  e503: { status: 503, body: 'no' },
  retenido: { status: 200, body: SERVING, delay: 2500 },
}
let server: Server
let base = ''
beforeAll(async () => {
  server = createServer((req, res) => {
    const caso = CASOS[(req.url ?? '').split('/')[2] ?? '']
    if (!caso) { res.writeHead(404); return res.end() }
    setTimeout(() => { res.writeHead(caso.status, { 'content-type': 'application/json' }); res.end(caso.body) }, caso.delay ?? 0)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
})
afterAll(() => server?.close())
const url = (caso: string) => `${base}/caso/${caso}/healthz`

// ─── Los contenedores falsos ───────────────────────────────────────────────────────────────────────
/** Un directorio con SOLO los ejecutables nombrados: es el PATH entero del contenedor falso. */
function binCon(nombres: string[]): string {
  const bin = tmp('vergis-poller-bin-')
  for (const n of nombres) {
    if (n === 'node') symlinkSync(process.execPath, join(bin, 'node'))
    else if (n === 'wget') {
      writeFileSync(join(bin, 'wget.mjs'), WGET_BUSYBOX)
      writeFileSync(join(bin, 'wget'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'wget.mjs')}" "$@"\n`)
      chmodSync(join(bin, 'wget'), 0o755)
    } else {
      const src = ['/bin', '/usr/bin'].map((d) => join(d, n)).find((p) => existsSync(p))
      if (!src) throw new Error(`no encuentro ${n}`)
      symlinkSync(src, join(bin, n))
    }
  }
  return bin
}
// El wget de BusyBox, por sus mensajes: lo que `poller.sh` sabe leer.
const WGET_BUSYBOX = `const a = process.argv.slice(2); let to = 10, u = ''
for (let i = 0; i < a.length; i++) { if (a[i] === '-T') to = Number(a[++i]); else if (!a[i].startsWith('-')) u = a[i] }
try {
  const r = await fetch(u, { signal: AbortSignal.timeout(to * 1000) })
  const b = await r.text()
  if (r.status >= 200 && r.status < 300) { process.stdout.write(b); process.exit(0) }
  process.stderr.write('wget: server returned error: HTTP/1.1 ' + r.status + ' X\\n'); process.exit(1)
} catch (e) {
  process.stderr.write(e && e.name === 'TimeoutError' ? 'wget: download timed out\\n' : "wget: can't connect to remote host\\n"); process.exit(1)
}
`
const SH_TOOLS = ['sh', 'wget', 'sed', 'cut', 'tr', 'grep', 'head', 'date', 'sleep', 'cat', 'rm', 'test', 'kill']

function mundo(contenedores: Record<string, string[]>) {
  const w = tmp('vergis-poller-mundo-')
  mkdirSync(join(w, 'containers'))
  for (const [name, lines] of Object.entries(contenedores)) writeFileSync(join(w, 'containers', name), lines.join('\n') + '\n')
  return w
}
const conPath = (bin: string, extra: string[] = []) => [`env=PATH=${bin}`, ...extra]

function decl(over: Record<string, unknown> = {}) {
  return declarar(minima({ rings: { env: { RINGS_EDGE: 'borde', RINGS_EDGE_URL: base } }, ...over }, tmp('vergis-poller-host-')))
}
const env = (w: string, x: Record<string, string> = {}) => ({ VERGIS_OPS_DOCKER: DOCKER, FAKE_WORLD: w, VERGIS_OPS_STATE_DIR: tmp(), ...x })

// ─── #376 · check sondea el instrumento ────────────────────────────────────────────────────────────
describe('#376 · check sondea el contenedor del instrumento en el host', () => {
  it('contenedor con sh pero sin wget ni node → 2, y nombra lo que falta', () => {
    const w = mundo({ borde: ['service=caddy'], relay: conPath(binCon(['sh'])) })
    const r = cli(['check'], { cwd: decl({ instrument: { container: 'relay' } }), env: env(w) })
    expect(r.code, r.all).toBe(2)
    expect(r.out).toMatch(/instrumento: el contenedor del instrumento «relay» no trae wget sed .*\(y no trae node ≥ 18\)/)
  })

  it('contenedor sin nada (ni sh) → 2', () => {
    const w = mundo({ relay: conPath(binCon([])) })
    const r = cli(['check'], { cwd: decl({ instrument: { container: 'relay' } }), env: env(w) })
    expect(r.code, r.all).toBe(2)
    expect(r.out).toMatch(/«relay» no trae sh/)
  })

  it('contenedor solo-node → 0, y dice que el poller vivirá ahí con poller-node.mjs', () => {
    const w = mundo({ relay: conPath(binCon(['node'])) })
    const r = cli(['check'], { cwd: decl({ instrument: { container: 'relay' } }), env: env(w) })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/instrumento: «relay» puede alojar el poller — con `poller-node\.mjs`/)
  })

  it('control: el borde con las herramientas de poller.sh → 0, con poller.sh', () => {
    const w = mundo({ borde: conPath(binCon(SH_TOOLS)) })
    const r = cli(['check'], { cwd: decl(), env: env(w) })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/instrumento: «borde» puede alojar el poller — con `poller\.sh`/)
  })

  it('NO PUDE sondear — el contenedor no existe, o no hay docker → 7, jamás 0', () => {
    const r1 = cli(['check'], { cwd: decl({ instrument: { container: 'relay' } }), env: env(mundo({})) })
    expect(r1.code, r1.all).toBe(7)
    expect(r1.out).toMatch(/«relay» no existe en el host: no pude sondear/)
    const r2 = cli(['check'], { cwd: decl(), env: env(mundo({}), { VERGIS_OPS_DOCKER: '/no/existe/docker' }) })
    expect(r2.code, r2.all).toBe(7)
    expect(r2.out).toMatch(/no hay docker en el host/)
  })

  it('--offline no toca el host y lo declara', () => {
    const r = cli(['check', '--offline'], { cwd: decl(), env: env(mundo({}), { VERGIS_OPS_DOCKER: '/no/existe/docker' }) })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/NO sondeé sus herramientas en el host \(--offline\)/)
  })
})

// ─── #376 · el poller corre en el contenedor solo-node ─────────────────────────────────────────────
function vivo(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function hastaQue(cond: () => boolean, ms = 8000) {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100))
  return cond()
}

describe('#376 · poller start|count|stop en un contenedor que solo trae node', () => {
  it('corre, mide con el predicado, y stop lo detiene de verdad', async () => {
    const w = mundo({ relay: conPath(binCon(['node'])) })
    const dir = decl({ instrument: { container: 'relay' } })
    const e = env(w)
    const s = await cliAsync(['poller', 'start', '--target', url('serving'), '--interval', '0.1'], { cwd: dir, env: e })
    expect(s.code, s.all).toBe(0)
    expect(s.out).toMatch(/poller-node\.mjs/)
    expect(s.out).toMatch(/primera muestra: [0-9.]+ [0-9:]+ OK status=2xx phase=serving lets=2\/2 ms=[0-9]+/)
    const { readRecord } = await lib('state.mjs')
    const prev = process.env.VERGIS_OPS_STATE_DIR
    process.env.VERGIS_OPS_STATE_DIR = e.VERGIS_OPS_STATE_DIR
    const rec = readRecord(join(realpathSync(dir), 'vergis-ops.json'), 'prueba', 'poller')
    if (prev === undefined) delete process.env.VERGIS_OPS_STATE_DIR
    else process.env.VERGIS_OPS_STATE_DIR = prev
    expect(rec.flavor).toBe('node')
    expect(rec.timeout).toBe('10')
    const pid = Number(readFileSync(rec.pidFile, 'utf8'))
    try {
      await new Promise((r) => setTimeout(r, 600))
      const c = await cliAsync(['poller', 'count'], { cwd: dir, env: e })
      expect(c.code, c.all).toBe(0)
      expect(c.out).toMatch(/OK [1-9][0-9]* · MAL 0/)
      expect(c.out).toMatch(/latencia OK máx [0-9]+ ms/)
      const st = await cliAsync(['poller', 'stop'], { cwd: dir, env: e })
      expect(st.code, st.all).toBe(0)
      expect(await hastaQue(() => !vivo(pid))).toBe(true)
    } finally {
      if (vivo(pid)) process.kill(pid)
    }
  }, 30_000)
})

// ─── #376 · cn1 en el contenedor solo-node ─────────────────────────────────────────────────────────
describe('#376 · poller cn1 en un contenedor que solo trae node', () => {
  it('espera el standby y mide el control negativo con poller-node.mjs: rojo-como-debe → 0', async () => {
    // El anillo `vergis-1-0-1:8080` es el caso «standby» del servidor de la prueba: un --import en el
    // contenedor reescribe esa base (un DNS falso para el fetch de node).
    const hook = join(tmp('vergis-poller-hook-'), 'dns.mjs')
    writeFileSync(hook, `const f = globalThis.fetch; globalThis.fetch = (u, o) => f(String(u).replace(/^http:\\/\\/vergis-[^/]+:8080\\/healthz/, ${JSON.stringify(url('standby'))}), o)\n`)
    const w = mundo({ relay: conPath(binCon(['node']), [`env=NODE_OPTIONS=--import=${hook}`]), 'vergis-1-0-1': ['ring=1'] })
    const r = await cliAsync(['poller', 'cn1', '--ring', '1.0.1', '--seconds', '5'], { cwd: decl({ instrument: { container: 'relay' } }), env: env(w) })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/poller-node\.mjs/)
    expect(r.out).toMatch(/CN-1 ROJO-COMO-DEBE \(exit 0\): ([0-9]+)\/\1 muestras MAL phase=standby/)
  }, 30_000)
})

// ─── #376 + #367 · mismo veredicto, muestra a muestra ──────────────────────────────────────────────
/** Una muestra de un instrumento, corrido directo (sin CLI), contra `u` con timeout `to`. */
async function muestra(sabor: 'sh' | 'node', u: string, to = '10'): Promise<string> {
  let cmd: string
  let args: string[]
  let pathEnv: string
  if (sabor === 'sh') {
    cmd = 'sh'
    args = [join(PLUGIN, 'instruments/poller.sh'), u, '30', to]
    pathEnv = binCon(SH_TOOLS)
  } else {
    const { PREDICATE_JS } = await lib('predicate.mjs')
    const f = join(tmp('vergis-poller-node-'), 'poller.mjs')
    writeFileSync(f, `${PREDICATE_JS}\n${readFileSync(join(PLUGIN, 'instruments/poller-node.mjs'), 'utf8')}`)
    cmd = process.execPath
    args = [f, u, '30', to]
    pathEnv = binCon([])
  }
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { env: { PATH: pathEnv } })
    let o = ''
    c.stdout.on('data', (d) => {
      o += d
      if (o.includes('\n')) { c.kill('SIGTERM'); res(o.split('\n')[0]!) }
    })
    c.on('error', rej)
    setTimeout(() => { c.kill('SIGKILL'); rej(new Error(`${sabor}: sin muestra en 20 s (${o})`)) }, 20_000)
  })
}
/** Lo que se compara: el veredicto y su detalle, sin el reloj, la latencia ni el texto del error. */
const veredicto = (l: string) => l.split(' ').slice(2).filter((t) => !t.startsWith('ms=')).join(' ').replace(/^SINMEDIR .*/, 'SINMEDIR')
const ms = (l: string) => Number(/ ms=([0-9]+)$/.exec(l)?.[1] ?? NaN)

describe('#376 · poller.sh y poller-node.mjs dan el mismo veredicto', () => {
  const ESPERADO: Record<string, string> = {
    serving: 'OK status=2xx phase=serving lets=2/2',
    standby: 'MAL status=2xx phase=standby lets=2/2',
    degradado: 'MAL status=2xx phase=serving lets=1/2',
    pis: 'OK status=2xx phase=serving pis=3/3',
    sueltos: 'MAL status=2xx phase=serving lets=- conteos-fuera-de-bloque',
    sala: 'MAL status=2xx phase=- lets=- cuerpo-no-json=<html><!--_"phase":"serving"_--><p>Espere</p></html>',
    e503: 'MAL status=503 phase=- lets=-',
  }
  for (const [caso, esperado] of Object.entries(ESPERADO)) {
    it(`${caso}: ${esperado}`, async () => {
      const [a, b] = await Promise.all([muestra('sh', url(caso)), muestra('node', url(caso))])
      expect(veredicto(a), a).toBe(esperado)
      expect(veredicto(b), b).toBe(esperado)
      expect(a).toMatch(/ ms=[0-9]+$/)
      expect(b).toMatch(/ ms=[0-9]+$/)
    }, 30_000)
  }
  it('sin nodo que responda: SINMEDIR en los dos', async () => {
    const u = 'http://127.0.0.1:1/healthz'
    const [a, b] = await Promise.all([muestra('sh', u), muestra('node', u)])
    expect(veredicto(a), a).toBe('SINMEDIR')
    expect(veredicto(b), b).toBe('SINMEDIR')
  }, 30_000)
})

// ─── #367 · retención: timeout de 10 s y latencia por muestra ──────────────────────────────────────
describe('#367 · un request retenido 2,5 s es una LATENCIA, no un «no pude medir»', () => {
  for (const sabor of ['sh', 'node'] as const) {
    it.skipIf(sabor === 'sh' && !LINUX_UPTIME)(`${sabor} · timeout por omisión (10 s): OK con ms ≥ 2500`, async () => {
      const l = await muestra(sabor, url('retenido'))
      expect(veredicto(l), l).toBe('OK status=2xx phase=serving lets=2/2')
      expect(ms(l), l).toBeGreaterThanOrEqual(2400) // el reloj del sh tiene resolución de 10 ms
    }, 30_000)
    it(`${sabor} · control: con timeout de 1 s el mismo request sale SINMEDIR`, async () => {
      const l = await muestra(sabor, url('retenido'), '1')
      expect(veredicto(l), l).toBe('SINMEDIR')
    }, 30_000)
  }
})

// ─── #367 · la fila separa «sin medir» de «fuera de predicado» ─────────────────────────────────────
describe('#367 · la fila del corte separa sin-medir de fuera-de-predicado, y lleva la latencia', () => {
  async function conLog(dir: string, stateDir: string, log: string, extra: Record<string, unknown> = {}) {
    const { writeRecord } = await lib('state.mjs')
    const prev = process.env.VERGIS_OPS_STATE_DIR
    process.env.VERGIS_OPS_STATE_DIR = stateDir
    const t = tmp('vergis-poller-count-')
    writeFileSync(join(t, 'p.log'), log)
    writeRecord(join(realpathSync(dir), 'vergis-ops.json'), 'prueba', 'poller', { id: 'p-fila', state: 'running', container: 'borde', target: 'x', pidFile: join(t, 'p.pid'), logFile: join(t, 'p.log'), interval: '0.25', startedAt: 'ahora', instrument: 'inyector', ...extra })
    if (prev === undefined) delete process.env.VERGIS_OPS_STATE_DIR
    else process.env.VERGIS_OPS_STATE_DIR = prev
  }
  const ok = (t: number, m = 12) => `${t.toFixed(2)} 12:00:00 OK status=2xx phase=serving lets=1/1 ms=${m}`

  it('1 MAL + 1 SINMEDIR: la fila dice «1 fuera de predicado · 1 sin medir», no «2 fuera de predicado»', async () => {
    const dir = decl()
    const st = tmp()
    await conLog(dir, st, [ok(1), '1.25 12:00:01 MAL status=503 phase=- lets=- ms=3', '1.50 12:00:01 SINMEDIR node:_sin_respuesta_en_10_s ms=10004', ok(11.6)].join('\n') + '\n', { timeout: '10' })
    const w = mundo({ borde: conPath(binCon(SH_TOOLS)) })
    const r = await cliAsync(['poller', 'count'], { cwd: dir, env: env(w, { VERGIS_OPS_STATE_DIR: st }) })
    expect(r.code, r.all).toBe(7)
    expect(r.out).toMatch(/fila para .*· 4 muestras · 1 fuera de predicado · 1 sin medir · /)
    expect(r.out).not.toMatch(/2 fuera de predicado/)
    // con timeout de 10 s, el SINMEDIR no se atribuye a la retención
    expect(r.out).not.toMatch(/compatible con una retención/)
  })

  it('OK retenidas: la latencia máxima y cuántas pasaron de 2 s quedan en la medición', async () => {
    const dir = decl()
    const st = tmp()
    await conLog(dir, st, [ok(1), ok(1.25, 2011), ok(3.5, 2500), ok(6.1)].join('\n') + '\n', { timeout: '10' })
    const w = mundo({ borde: conPath(binCon(SH_TOOLS)) })
    const r = await cliAsync(['poller', 'count'], { cwd: dir, env: env(w, { VERGIS_OPS_STATE_DIR: st }) })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/latencia OK máx 2500 ms \(2 OK sobre 2 s: retenidas, no cortadas\)/)
    expect(r.out).toMatch(/latencia OK máx 2500 ms · instrumento inyector \(timeout 10 s\)/)
  })
})
