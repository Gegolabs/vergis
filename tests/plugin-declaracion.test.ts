/**
 * PLUGIN `vergis` · V2 — la declaración de la instalación (D3, D4) y la clasificación de actos (D6, D10).
 *
 * Lo que se afirma, y por qué cada afirmación sabe reprobar:
 *  · `check` sale con 2 y NOMBRA el defecto sobre nueve declaraciones rotas, una por defecto — y con 0
 *    sobre la mínima. Sin la segunda mitad, un `check` que siempre saliera 2 pasaría la primera.
 *  · El validador del CLI y ajv coinciden sobre cada fixture: el esquema publicado es la única fuente,
 *    y un validador propio que se desviara de él lo delata esta prueba.
 *  · La clasificación lee el contrato vivo y, sin él, cae a interrupción.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { cli, declarar, lib, minima, PLUGIN, tmp } from './plugin-helpers'

const SCHEMA = JSON.parse(readFileSync(join(PLUGIN, 'schema/vergis-ops.schema.json'), 'utf8'))

describe('check · nueve declaraciones rotas salen con 2 y nombran el defecto', () => {
  it('1 · JSON inválido', () => {
    const dir = declarar('{ "schema_version": 1, ')
    const r = cli(['check'], { cwd: dir })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/JSON inválido/)
  })

  it('2 · id duplicado', () => {
    const d = minima()
    d.installations.push({ ...d.installations[0] })
    const r = cli(['check'], { cwd: declarar(d) })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/«prueba» está repetido/)
  })

  it('3 · dos instalaciones y un verbo sin --installation (no hay instalación por omisión)', () => {
    const d = minima()
    d.installations.push({ ...d.installations[0], id: 'otra' })
    const dir = declarar(d)
    expect(cli(['check'], { cwd: dir }).code).toBe(0) // la declaración en sí es válida…
    const r = cli(['health'], { cwd: dir }) // …pero ningún verbo elige por el operador
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/nombra una con --installation/)
  })

  it('4 · identity_file versionado en git', () => {
    const dir = tmp()
    execFileSync('git', ['init', '-q', dir])
    writeFileSync(join(dir, 'llave.pem'), 'no es una llave de verdad\n')
    execFileSync('git', ['-C', dir, 'add', 'llave.pem'])
    const d = minima({ transport: { kind: 'ssh', host: 'host.ejemplo', user: 'op', identity_file: 'llave.pem' } })
    writeFileSync(join(dir, 'vergis-ops.json'), JSON.stringify(d))
    const r = cli(['check'], { cwd: dir })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/identity_file.*NO está ignorado/)
  })

  it('5 · governance.source declarado e inexistente', () => {
    const r = cli(['check'], { cwd: declarar(minima({ governance: { source: 'NORMA.md' } })) })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/governance\.source: la norma citada no existe/)
  })

  it('6 · un servicio que no está en el compose del espejo', () => {
    const compose = 'services:\n  borde:\n    image: caddy:2.8.4\n  proxy:\n    image: proxy:1.0.0\n'
    const d = minima({
      host: { root: '/srv/x', compose_file: '/srv/x/compose.yml' },
      mirror: { families: [{ id: 'compose', kind: 'fixed', local: 'deploy/compose.yml', remote: 'compose.yml' }] },
      services: [{ name: 'fantasma', interrupting: true, reload: 'none' }],
    })
    const r = cli(['check'], { cwd: declarar(d, { 'deploy/compose.yml': compose }) })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/services «fantasma»: no está en el compose del espejo/)
  })

  it('7 · una ruta local del espejo que no existe', () => {
    const d = minima({ mirror: { families: [{ id: 'specs', kind: 'sweep', local: 'no/existe', remote: 'specs' }] } })
    const r = cli(['check'], { cwd: declarar(d) })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/la ruta local «no\/existe» no existe/)
  })

  it('8 · --declaration con transporte ssh (la frontera del Producto)', () => {
    const d = minima({ transport: { kind: 'ssh', host: 'host.ejemplo', user: 'op' } })
    const dir = declarar(d)
    const r = cli(['check', '--declaration', join(dir, 'vergis-ops.json')])
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/--declaration solo admite transporte «local»/)
  })

  it('9 · falta host.root', () => {
    const d = minima()
    delete d.installations[0].host.root
    const r = cli(['check'], { cwd: declarar(d) })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/falta la clave obligatoria «installations\[0\]\.host\.root»/)
  })
})

describe('check · la declaración mínima es usable', () => {
  it('sale 0 con solo id, transport, host.root y rings', () => {
    const r = cli(['check'], { cwd: declarar(minima()) })
    expect(r.code, r.all).toBe(0)
    expect(r.all).toMatch(/DECLARACIÓN USABLE/)
  })

  it('sin declaración, los verbos se niegan con el mensaje de la frontera', () => {
    const r = cli(['health'], { cwd: tmp() })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/acá no hay instalación declarada/)
  })

  it('rings.env con un secreto inline se rechaza', () => {
    const r = cli(['check'], { cwd: declarar(minima({ rings: { env: { RINGS_GATE_TOKEN: 'abc' } } })) })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/parece un secreto inline/)
  })

  it('un tag móvil en el compose espejado es advertencia, no defecto', () => {
    const compose = 'services:\n  borde:\n    image: caddy:latest\n'
    const d = minima({
      host: { root: '/srv/x', compose_file: '/srv/x/compose.yml' },
      mirror: { families: [{ id: 'compose', kind: 'fixed', local: 'compose.yml', remote: 'compose.yml' }] },
    })
    const r = cli(['check'], { cwd: declarar(d, { 'compose.yml': compose }) })
    expect(r.code, r.all).toBe(0)
    expect(r.all).toMatch(/usa un tag móvil/)
  })

  it('el transporte que nombra un host ausente de RESOURCES.md es defecto', () => {
    const d = minima({ transport: { kind: 'az-run-command', resource_group: 'rg-x', vm: 'vm-x', expected_account: 'op@x' } })
    const r = cli(['check'], { cwd: declarar(d, { 'RESOURCES.md': '# Accesos\n\n| rg-x | … |\n' }) })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/vm-x: el transporte lo nombra y RESOURCES\.md no/)
  })
})

describe('el validador del CLI y ajv coinciden (el esquema es la única fuente)', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validar = ajv.compile(SCHEMA)
  const casos: [string, unknown, boolean][] = [
    ['mínima', minima(), true],
    ['sin host.root', (() => { const d = minima(); delete d.installations[0].host.root; return d })(), false],
    ['rings con env_file Y env', minima({ rings: { env_file: 'rings/rollout.env', env: { RINGS_EDGE: 'x' } } }), false],
    ['rings vacío', minima({ rings: {} }), false],
    ['transporte desconocido', minima({ transport: { kind: 'command', template: 'x {script}' } }), false],
    ['ssh sin user', minima({ transport: { kind: 'ssh', host: 'h' } }), false],
    ['gate inválido', minima({ governance: { gates: { content: 'maybe' } } }), false],
    ['clase de gate inexistente', minima({ governance: { gates: { publish: 'free' } } }), false],
    ['id no kebab', minima({ id: 'Prueba_1' }), false],
    ['clave extra', minima({ inventada: true }), false],
    ['completa', minima({ mirror: { root: '.', families: [{ id: 'specs', kind: 'sweep', local: 's', remote: 'specs', exclude: [{ path: 'a.yaml', reason: 'legado' }] }], unmirrored: [{ path: 'governance', reason: 'estado' }] }, services: [{ name: 'caddy', interrupting: true, reload: 'exec:caddy reload --config /etc/caddy/Caddyfile' }], governance: { source: 'CLAUDE.md', stage: 'ga', availability: 'horario de oficina', window_approver: 'op', approver: 'pr', gates: { read: 'free', content: 'operator', version: 'operator', boot: 'window', service: 'operator', 'service-interrupting': 'window', destructive: 'approval' } }, probe_identities: [{ id: 'qa', email: 'qa@x.test', groups: ['g'] }], rls_checks: [{ route: 'pi-01', identity: 'qa', present: ['A'], absent: [] }], instrument: { container: 'relay-1', baseline_seconds: 60 }, extensions: { data: 'otra:skill' } }), true],
  ]
  for (const [nombre, doc, valida] of casos) {
    it(`${nombre} → ${valida ? 'válida' : 'inválida'}`, async () => {
      const { validate } = await lib('schema.mjs')
      const nuestro = validate(SCHEMA, doc).length === 0
      expect(validar(doc), JSON.stringify(validar.errors)).toBe(valida)
      expect(nuestro, JSON.stringify(validate(SCHEMA, doc))).toBe(valida)
    })
  }
})

describe('clasificación de actos (D6, D10)', async () => {
  const { classifyPath, gateFor, enforceGate, forbiddenReason } = await lib('classify.mjs')
  const ring = [{ Source: '/srv/x/specs', Destination: '/specs' }, { Source: '/srv/x/governance', Destination: '/governance' }]
  const contrato = { watches: [{ envs: ['VERGIS_SPECS_DIR'], paths: ['/specs'], reloads: 'specs: rebuild' }] }

  it('un archivo bajo un watch del contrato vivo es content', () => {
    const c = classifyPath({ hostPath: '/srv/x/specs/pi-01.yaml', contract: contrato, ringMounts: ring, others: [], services: [] })
    expect(c.cls).toBe('content')
    expect(c.containerPath).toBe('/specs/pi-01.yaml')
  })

  it('montado en el nodo y sin watch es boot (el nodo lo lee al arrancar)', () => {
    expect(classifyPath({ hostPath: '/srv/x/governance/x.json', contract: contrato, ringMounts: ring, others: [], services: [] }).cls).toBe('boot')
  })

  it('sin contrato, lo montado en el nodo es interrupción (ante la duda, corte)', () => {
    const c = classifyPath({ hostPath: '/srv/x/specs/pi-01.yaml', contract: null, ringMounts: ring, others: [], services: [] })
    expect(c.cls).toBe('boot')
    expect(c.why).toMatch(/ante la duda/)
  })

  it('lo que monta un servicio declarado hereda su interrupting; uno no declarado, corte', () => {
    const others = [{ container: 'x-caddy-1', service: 'caddy', Source: '/srv/x/Caddyfile', Destination: '/etc/caddy/Caddyfile' }]
    const svc = [{ name: 'caddy', interrupting: true, reload: 'exec:caddy reload' }]
    expect(classifyPath({ hostPath: '/srv/x/Caddyfile', contract: contrato, ringMounts: ring, others, services: svc }).cls).toBe('service-interrupting')
    expect(classifyPath({ hostPath: '/srv/x/Caddyfile', contract: contrato, ringMounts: ring, others, services: [{ ...svc[0], interrupting: false }] }).cls).toBe('service')
    expect(classifyPath({ hostPath: '/srv/x/Caddyfile', contract: contrato, ringMounts: ring, others, services: [] }).cls).toBe('service-interrupting')
  })

  it('una clase sin gate declarado pide aprobación', () => {
    expect(gateFor({ governance: { gates: { content: 'operator' } } }, 'boot').gate).toBe('approval')
    expect(gateFor({}, 'content').gate).toBe('approval')
  })

  it('GA: sin corte, sin permiso; con corte, la ventana la autoriza el operador de la instalación; lo destructivo, el principal', () => {
    const ga = { governance: { window_approver: 'Operador', approver: 'Principal', gates: { content: 'operator', version: 'operator', service: 'operator', boot: 'window', 'service-interrupting': 'window', destructive: 'approval' } } }
    expect(enforceGate(ga, 'content').evidence).toBeNull()
    expect(enforceGate(ga, 'version').evidence).toBeNull()
    expect(() => enforceGate(ga, 'boot', { window: 'Operador · hoy · «dale»', measured: true })).toThrow(/impacto/)
    expect(() => enforceGate(ga, 'boot', { impact: 'caen 9 Lets ~8 s', measured: true })).toThrow(/La ventana la autoriza Operador/)
    expect(() => enforceGate(ga, 'boot', { impact: 'x', window: 'y' })).toThrow(/Un acto con ventana se MIDE/)
    const ok = enforceGate(ga, 'boot', { impact: 'caen 9 Lets ~8 s', window: 'Operador · 21:00 · «dale»', measured: true })
    expect(ok.evidence).toMatchObject({ kind: 'window', authority: 'Operador' })
    expect(() => enforceGate(ga, 'destructive', { window: 'x', impact: 'y' })).toThrow(/Lo aprueba Principal/)
    expect(enforceGate(ga, 'destructive', { approval: 'Principal · hoy · «sí»', impact: 'borra el anillo 0.1.0' }).evidence).toMatchObject({ kind: 'approval', authority: 'Principal' })
  })

  it('los invariantes del Producto no se ejecutan aunque un gate lo permita', () => {
    expect(forbiddenReason('docker compose -p x down -v')).toMatch(/volúmenes/)
    expect(forbiddenReason('rm -f governance/control.lease.json')).toMatch(/lease/)
    expect(forbiddenReason("sed -i 's/a/b/' rings/ring.args")).toMatch(/ring\.args/)
    expect(forbiddenReason('echo x > rings/active.caddy')).toMatch(/active\.caddy/)
    // leer no es escribir
    expect(forbiddenReason('cat rings/ring.args')).toBeNull()
    expect(forbiddenReason('diff rings/ring.args rings/ring.args.new')).toBeNull()
    expect(forbiddenReason('cat governance/control.lease.json')).toBeNull()
  })
})
