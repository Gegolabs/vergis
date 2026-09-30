/**
 * PLUGIN `vergis` · V6 — la herramienta de anillos viaja en la imagen de su versión (D9), y `ring.args`
 * se DERIVA del compose vivo en vez de mantenerse a mano.
 *
 * 1 · El label `vergis.rollout.sha256` del Dockerfile es lo que verifica quien extrae la herramienta de la
 *     imagen antes de instalarla en un host. Un label que miente le da un «sí» barato justo a esa
 *     verificación: esta prueba compara cada sha contra el archivo del repo, y que el Dockerfile copie los
 *     tres a `/app/deploy/rollout/`. Sabe reprobar: con un sha cambiado en un dígito, sale rojo.
 * 2 · El generador, alimentado con un `compose config --format json`, produce los envs y montajes del
 *     servicio del nodo con rutas del host, y ABORTA ante un secreto inlineado o un VERGIS_OUT sin
 *     montar en escritura — no genera nada a medias.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RAIZ } from './plugin-helpers'

const DOCKERFILE = readFileSync(join(RAIZ, 'Dockerfile'), 'utf8')
const HERRAMIENTAS = ['botler-rollout', 'vergis-rollout', 'ring-args-from-compose.mjs']

function labelRollout(): Record<string, string> {
  const m = DOCKERFILE.match(/vergis\.rollout\.sha256="([^"]*)"/)
  if (!m) throw new Error('el Dockerfile no declara vergis.rollout.sha256')
  return Object.fromEntries(m[1]!.split(',').map((p) => p.split('=') as [string, string]))
}

describe('la herramienta de anillos en la imagen (D9)', () => {
  it('el Dockerfile copia las tres herramientas a /app/deploy/rollout/', () => {
    const copy = DOCKERFILE.split('\n').find((l) => l.startsWith('COPY deploy/rollout/'))
    expect(copy).toBeTruthy()
    for (const h of HERRAMIENTAS) expect(copy).toContain(`deploy/rollout/${h}`)
    expect(copy).toMatch(/\.\/deploy\/rollout\/$/)
  })
  it('el label declara el sha256 EXACTO de cada archivo del repo', () => {
    const lbl = labelRollout()
    expect(Object.keys(lbl).sort()).toEqual([...HERRAMIENTAS].sort())
    for (const h of HERRAMIENTAS) {
      const real = createHash('sha256').update(readFileSync(join(RAIZ, 'deploy/rollout', h))).digest('hex')
      expect(lbl[h], `el label de ${h} no es el sha del archivo: actualiza vergis.rollout.sha256 en el Dockerfile`).toBe(real)
    }
  })
  it('el plugin no viaja en la imagen', () => {
    const di = readFileSync(join(RAIZ, '.dockerignore'), 'utf8').split('\n')
    expect(di).toContain('plugins')
  })
})

const GEN = join(RAIZ, 'deploy/rollout/ring-args-from-compose.mjs')
function gen(doc: unknown, args: string[] = ['--host-root', '/srv/instancia']) {
  const r = spawnSync(process.execPath, [GEN, ...args], { input: JSON.stringify(doc), encoding: 'utf8' })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}
const COMPOSE = {
  name: 'inst',
  services: {
    vergis: {
      profiles: ['plantilla'],
      restart: 'unless-stopped',
      env_file: ['/estacion/deploy/vergis.env'],
      mem_limit: '2g',
      environment: { VERGIS_ENGINE: 'fabric', VERGIS_SPECS_DIR: '/specs', VERGIS_OUT: '/governance', VERGIS_RING: 'no-va' },
      volumes: [
        { type: 'bind', source: '/estacion/deploy/specs', target: '/specs', read_only: true },
        { type: 'bind', source: '/estacion/deploy/governance', target: '/governance' },
      ],
    },
  },
}

describe('el generador de ring.args desde el compose vivo', () => {
  it('rebasa los binds a la raíz del host, pone el env_file por referencia, fuerza lease y no pone la identidad del anillo', () => {
    const r = gen(COMPOSE)
    expect(r.code, r.err).toBe(0)
    const l = r.out.split('\n')
    expect(l).toContain('inst_default')
    expect(l).toContain('/srv/instancia/vergis.env')
    expect(l).toContain('/srv/instancia/specs:/specs:ro')
    expect(l).toContain('/srv/instancia/governance:/governance')
    expect(l).toContain('VERGIS_CONTROL=lease')
    expect(r.out).not.toMatch(/VERGIS_RING/)
    expect(l[l.indexOf('--memory') + 1]).toBe('2g')
  })
  it('#372 · la memoria sale del compose: mem_limit o deploy.resources.limits.memory; sin ella → 2 (b1b6ecf: 0 con 1g)', () => {
    const c = structuredClone(COMPOSE) as any
    c.services.vergis.mem_limit = '3g'
    expect(gen(c).out.split('\n')).toContain('3g')
    delete c.services.vergis.mem_limit
    c.services.vergis.deploy = { resources: { limits: { memory: '4g' } } }
    expect(gen(c).out.split('\n')).toContain('4g')
    delete c.services.vergis.deploy
    const sin = gen(c)
    expect(sin.code).toBe(2)
    expect(sin.out).toBe('')
    expect(sin.err).toMatch(/no declara su memoria/)
  })
  it('#372 · --memory ya no existe → 2', () => {
    const r = gen(COMPOSE, ['--host-root', '/srv/instancia', '--memory', '2g'])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/--memory ya no existe/)
  })
  it('un secreto inlineado (compose config sin --no-env-resolution) aborta → 2, sin generar nada', () => {
    const c = structuredClone(COMPOSE) as any
    c.services.vergis.environment.VERGIS_CONNECTIONS = '{"x":"secreto"}'
    const r = gen(c)
    expect(r.code).toBe(2)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/parece un secreto/)
  })
  it('VERGIS_OUT sin montar en escritura aborta → 2', () => {
    const c = structuredClone(COMPOSE) as any
    c.services.vergis.volumes[1].read_only = true
    expect(gen(c).code).toBe(2)
  })
  it('sin --host-root no adivina → 2', () => {
    expect(gen(COMPOSE, []).code).toBe(2)
  })
})
