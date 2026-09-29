/**
 * PLUGIN `vergis` · #369 — el presupuesto de salida de `az vm run-command`.
 *
 * `az` entrega del stdout solo los ÚLTIMOS ~4 KB. En una instalación real en GA, el resumen del contrato
 * pesaba 4,1 KB (seis watches de 234 · 178 · 526 · 246 · 1.082 · 294 B en base64 y una línea ENV de
 * 1.465 B): `az` se comía la cabeza, con ella el BEGIN, y `contract`/`recon` salían 7 — el transporte
 * decía, con razón, «no pude medir». Acá se reproduce con un `az` falso que recorta IGUAL
 * (`tests/fixtures/plugin/fake-az.sh`: se queda con los últimos FAKE_AZ_CAP bytes, default 4096) y un
 * contrato sintético del mismo tamaño — nombres genéricos: el Producto no trae hechos de instalaciones.
 *
 * Con el código de b1b6ecf el primer caso sale 7 («no llegó el inicio de la salida»): es el control
 * negativo del arreglo. Los demás fijan el contrato del volcado por trozos: reensambla sin perder nada,
 * no deja volcados en el host, y lo que excede el presupuesto o llega cortado sale 7 diciendo por qué.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliAsync, declarar, FIX, lib, minima, tmp } from './plugin-helpers'

const AZ = join(FIX, 'fake-az.sh')
const DOCKER = join(FIX, 'fake-docker.sh')

/** Un nombre de variable genérico de `len` caracteres. */
const nombre = (pre: string, i: number, len: number) => `${pre}_${String(i).padStart(2, '0')}_${'X'.repeat(Math.max(0, len - pre.length - 4))}`

/** Un watch cuyo JSON pesa ~`bytes` B: rutas genéricas hasta alcanzar el tamaño. */
function watch(i: number, bytes: number) {
  const w = { envs: [`VERGIS_WATCH_${i}_DIR`], paths: [] as string[], reloads: `familia-${i}: rebuild` }
  let k = 0
  while (JSON.stringify(w).length < bytes) w.paths.push(`/datos/familia-${i}/ruta-${k++}`)
  return w
}

// El tamaño de la instalación medida (lab/work/287 §Defectos, V-1), con nombres sintéticos.
const WATCHES = [234, 178, 526, 246, 1082, 294].map((b, i) => watch(i + 1, Math.round((b * 3) / 4)))
const ENV = {
  bootOnly: Array.from({ length: 65 }, (_, i) => nombre('VERGIS_ARRANQUE', i, 18)),
  reloadableContent: Array.from({ length: 8 }, (_, i) => nombre('VERGIS_RECARGABLE_DIR', i, 24)),
  unknown: ['VERGIS_SIN_CONSUMIR'],
}
const CONTRATO = {
  version: '9.9.9',
  watches: WATCHES,
  env: ENV,
  artifacts: Array.from({ length: 23 }, (_, i) => ({ source: 'specs', path: `/specs/pi-${i}.yaml`, sha256: 'a'.repeat(64), diskSha256: 'a'.repeat(64), pending: false, loadedAt: '2026-09-29T00:00:00Z' })),
  caveats: ['a', 'b', 'c', 'd', 'e'],
  delta: { unchanged: true },
}

let server: Server
let base = ''
let hostRoot = ''

beforeAll(async () => {
  hostRoot = tmp('vergis-az-host-')
  mkdirSync(join(hostRoot, 'rings'))
  writeFileSync(join(hostRoot, 'rings/active.caddy'), 'reverse_proxy vergis-9-9-9:8080 {\n\timport anillo_activo\n}\n')
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/contrato' && req.headers['x-forwarded-email'] === 'admin@ejemplo.test') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(CONTRATO))
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
})
afterAll(() => server?.close())

function mundo() {
  const w = tmp('vergis-az-mundo-')
  mkdirSync(join(w, 'containers'))
  writeFileSync(join(w, 'containers/vergis-9-9-9'), 'ring=1\n')
  return w
}

function decl() {
  return declarar(
    minima(
      {
        transport: { kind: 'az-run-command', resource_group: 'rg-prueba', vm: 'vm-prueba', expected_account: 'op@ejemplo.test' },
        rings: { env: { RINGS_EDGE: 'borde', RINGS_DIR: './rings', RINGS_EDGE_URL: base, RINGS_ADMIN_EMAIL: 'admin@ejemplo.test' } },
        governance: { gates: { read: 'free' } },
      },
      hostRoot,
    ),
  )
}

/** El entorno: az y docker falsos, y un TMPDIR propio del «host» para ver qué volcados quedan. */
function entorno(extra: Record<string, string> = {}) {
  const hostTmp = tmp('vergis-az-hosttmp-')
  const log = join(tmp(), 'az.log')
  return {
    hostTmp,
    log,
    env: { VERGIS_OPS_AZ: AZ, FAKE_AZ_MODE: 'ok', VERGIS_OPS_DOCKER: DOCKER, FAKE_WORLD: mundo(), VO_NODE_BASE: base, VERGIS_OPS_STATE_DIR: tmp(), TMPDIR: hostTmp, FAKE_LOG: log, ...extra },
  }
}
const invocaciones = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('start')).length : 0)
const volcados = (dir: string) => readdirSync(dir).filter((f) => f.startsWith('vergis-ops-spool.'))

describe('#369 · el contrato de tamaño real por az-run-command', () => {
  it('el fixture tiene el tamaño de la instalación medida: su resumen pasa de los 4 KB que az entrega', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64')
    const resumen = WATCHES.reduce((n, w) => n + `WATCH ${b64(JSON.stringify(w))}\n`.length, 0) + `ENV bootOnly=${ENV.bootOnly.join(',')} reloadableContent=${ENV.reloadableContent.join(',')} unknown=${ENV.unknown.join(',')}\n`.length
    expect(resumen).toBeGreaterThan(4096)
    expect(resumen).toBeLessThan(5000) // del orden del medido (≈ 4,1 KB), no un monstruo que pruebe otra cosa
  })

  it('contract sale 0 y entrega los seis watches y la línea ENV completa (con b1b6ecf: 7, «no llegó el inicio»)', async () => {
    const e = entorno()
    const r = await cliAsync(['contract'], { cwd: decl(), env: e.env })
    expect(r.code, r.all).toBe(0)
    for (let i = 1; i <= 6; i++) expect(r.out).toMatch(new RegExp(`watch VERGIS_WATCH_${i}_DIR · /datos/familia-${i}/ruta-0 `))
    expect(r.out).toContain(`ENV bootOnly=${ENV.bootOnly.join(',')} reloadableContent=`)
    expect(r.out).toMatch(/ARTS total=23 pending=0/)
    expect(r.out).toMatch(/CAVEATS 5/)
    expect(invocaciones(e.log)).toBeGreaterThan(1) // viajó por trozos: en una sola invocación no cabía
    expect(volcados(e.hostTmp)).toEqual([]) // el último trozo borró el volcado del host
  }, 60_000)
})

describe('#369 · el volcado por trozos, para cualquier verbo', () => {
  const eco = (bytes: number) => ['exec', 'run', '--class', 'read', '--', `i=0; while [ $i -lt ${Math.ceil(bytes / 100)} ]; do printf 'linea-%05d-%s\\n' $i ${'y'.repeat(88)}; i=$((i+1)); done`]

  it('una salida de ~20 KB llega entera, línea por línea, en ceil(bytes/trozo)+1 invocaciones', async () => {
    const { AZ_CHUNK } = await lib('transport.mjs')
    const e = entorno()
    const r = await cliAsync(eco(20_000), { cwd: decl(), env: e.env })
    expect(r.code, r.all).toBe(0)
    expect(r.out.match(/linea-\d{5}-y{88}$/gm)?.length).toBe(200)
    expect(r.out).toMatch(/linea-00000-/)
    expect(r.out).toMatch(/linea-00199-/)
    expect(invocaciones(e.log)).toBe(1 + Math.ceil((200 * 100) / AZ_CHUNK))
    expect(volcados(e.hostTmp)).toEqual([])
  }, 60_000)

  it('una salida que cabe viaja en UNA invocación, como antes', async () => {
    const e = entorno()
    const r = await cliAsync(eco(1_500), { cwd: decl(), env: e.env })
    expect(r.code, r.all).toBe(0)
    expect(invocaciones(e.log)).toBe(1)
  }, 30_000)

  it('más allá del presupuesto → 7 diciendo cuántos bytes emitió el host, sin bajar ni dejar nada', async () => {
    const { AZ_CHUNK, AZ_MAX_CHUNKS } = await lib('transport.mjs')
    const e = entorno()
    const r = await cliAsync(eco(AZ_CHUNK * AZ_MAX_CHUNKS + 5_000), { cwd: decl(), env: e.env })
    expect(r.code, r.all).toBe(7)
    expect(r.all).toMatch(/fuera del presupuesto del transporte: el host emitió \d+ B/)
    expect(invocaciones(e.log)).toBe(1)
    expect(volcados(e.hostTmp)).toEqual([])
  }, 30_000)

  it('sabe fallar: si el canal recorta MÁS de lo que el trozo supone, sale 7 — no entrega una salida a medias', async () => {
    const e = entorno({ FAKE_AZ_CAP: '2000' })
    const r = await cliAsync(eco(20_000), { cwd: decl(), env: e.env })
    expect(r.code, r.all).toBe(7)
    expect(r.all).toMatch(/cortada por el transporte en el trozo 1\//)
    expect(r.out).not.toMatch(/linea-00000-/)
  }, 30_000)

  it('un volcado huérfano de más de 60 min lo barre la corrida siguiente; uno reciente no se toca', async () => {
    const e = entorno()
    const viejo = join(e.hostTmp, 'vergis-ops-spool.viejo1')
    const nuevo = join(e.hostTmp, 'vergis-ops-spool.nuevo1')
    mkdirSync(viejo)
    mkdirSync(nuevo)
    const { utimesSync } = await import('node:fs')
    const hace2h = new Date(Date.now() - 2 * 3600_000)
    utimesSync(viejo, hace2h, hace2h)
    const r = await cliAsync(eco(100), { cwd: decl(), env: e.env })
    expect(r.code, r.all).toBe(0)
    expect(volcados(e.hostTmp)).toEqual(['vergis-ops-spool.nuevo1'])
  }, 30_000)
})
