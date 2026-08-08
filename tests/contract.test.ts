// CONTRATO OPERATIVO consultable (issue #139) — el nodo responde por sí mismo qué vigila, qué recarga
// cada watch, qué env es de arranque y si tomó o no el archivo que el operador acaba de escribir.
//
// El escenario del issue está al final: se escribe una política real en un tmpdir, se registra la
// recarga, y el GET dice `pending:false`; se reescribe el archivo SIN recargar y el mismo GET dice
// `pending:true` — sin leer código, sin `docker logs` y sin manual externo.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createContractRegistry, createContractHandler, type ContractSnapshot } from '../server/contract'
import { createContractJournal, type ContractDelta } from '../server/contract-delta'
import { createRequestHandler, type RouteDeps } from '../server/routes'
import { configEnvKeys } from '../server/config'
import type { Report } from '../server/discovery'
import { VERGIS_VERSION } from '../packages/capabilities/src/version'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

function work(): string {
  const d = mkdtempSync(join(tmpdir(), 'vergis-contrato-'))
  return d
}

const registry = (over: Partial<Parameters<typeof createContractRegistry>[0]> = {}) =>
  createContractRegistry({ engine: 'fabric', hotReload: true, envSource: {}, ...over })

describe('contrato · registro derivado', () => {
  it('un watch instalado por `contract.watch` aparece en el snapshot (registrar y vigilar es UNA llamada)', () => {
    const dir = work()
    const c = registry()
    const unwatch = c.watch({ envs: ['VERGIS_POLICIES'], reloads: 'gobierno completo' }, [dir], () => {})
    const snap = c.snapshot()
    expect(snap.watches).toEqual([{ envs: ['VERGIS_POLICIES'], paths: [dir], reloads: 'gobierno completo' }])
    // La env del watch es de CONTENIDO recargable, no de arranque: cambiar el archivo no exige restart.
    expect(snap.env.reloadableContent).toEqual(['VERGIS_POLICIES'])
    expect(snap.env.bootOnly).not.toContain('VERGIS_POLICIES')
    unwatch()
    rmSync(dir, { recursive: true, force: true })
  })

  it('`record` hashea el artefacto REALMENTE cargado (sha256 del contenido en disco)', () => {
    const dir = work()
    const p = join(dir, 'policies.yaml')
    writeFileSync(p, 'policies: {}\n')
    const c = registry()
    c.record({ reason: 'boot', ok: true, policies: 3, servablePis: 2 }, [{ source: 'policies', path: p }])
    const snap = c.snapshot()
    expect(snap.artifacts).toHaveLength(1)
    expect(snap.artifacts[0]).toMatchObject({ source: 'policies', path: p, sha256: sha('policies: {}\n'), pending: false })
    expect(snap.reloads.last).toMatchObject({ reason: 'boot', ok: true, policies: 3, servablePis: 2 })
    expect(snap.reloads.recent).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('los artefactos REEMPLAZAN solo a los de su mismo `source` (un reload de policies no borra las specs)', () => {
    const dir = work()
    const pol = join(dir, 'p.yaml')
    const spec = join(dir, 's.yaml')
    writeFileSync(pol, 'a')
    writeFileSync(spec, 'b')
    const c = registry()
    c.record({ reason: 'boot', ok: true }, [
      { source: 'policies', path: pol },
      { source: 'specs', path: spec },
    ])
    writeFileSync(pol, 'a2')
    c.record({ reason: 'watch:policies', ok: true }, [{ source: 'policies', path: pol }])
    const snap = c.snapshot()
    expect(snap.artifacts.map((a) => a.source).sort()).toEqual(['policies', 'specs'])
    expect(snap.artifacts.find((a) => a.source === 'policies')!.sha256).toBe(sha('a2'))
    expect(snap.artifacts.find((a) => a.source === 'specs')!.sha256).toBe(sha('b'))
    rmSync(dir, { recursive: true, force: true })
  })

  it('una recarga FALLIDA se registra sin artefactos: lo vigente se conserva y el cambio queda `pending`', () => {
    const dir = work()
    const p = join(dir, 'p.yaml')
    writeFileSync(p, 'bueno')
    const c = registry()
    c.record({ reason: 'boot', ok: true }, [{ source: 'policies', path: p }])
    writeFileSync(p, 'roto')
    c.record({ reason: 'watch:policies', ok: false, error: 'YAML inválido' })
    const snap = c.snapshot()
    expect(snap.reloads.last).toMatchObject({ ok: false, error: 'YAML inválido' })
    // El hash CARGADO sigue siendo el bueno (el store vigente se conservó) y el disco difiere.
    expect(snap.artifacts[0].sha256).toBe(sha('bueno'))
    expect(snap.artifacts[0].diskSha256).toBe(sha('roto'))
    expect(snap.artifacts[0].pending).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('un artefacto BORRADO del disco → diskSha256 null y pending true (no revienta el snapshot)', () => {
    const dir = work()
    const p = join(dir, 'p.yaml')
    writeFileSync(p, 'x')
    const c = registry()
    c.record({ reason: 'boot', ok: true }, [{ source: 'policies', path: p }])
    unlinkSync(p)
    const snap = c.snapshot()
    expect(snap.artifacts[0].diskSha256).toBeNull()
    expect(snap.artifacts[0].pending).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('el ring conserva las 20 recargas más recientes, la última primero', () => {
    const c = registry()
    for (let i = 0; i < 25; i += 1) c.record({ reason: `r${i}`, ok: true })
    const snap = c.snapshot()
    expect(snap.reloads.recent).toHaveLength(20)
    expect(snap.reloads.recent[0].reason).toBe('r24')
    expect(snap.reloads.last!.reason).toBe('r24')
  })

  it('clasifica las envs: bootOnly · reloadableContent · unknown (un typo NO se pierde en silencio)', () => {
    const c = registry({
      envSource: {
        VERGIS_CH_URL: 'http://ch:8123',
        VERGIS_POLICIES: '/gov/p.yaml',
        VERGIS_TYPO: 'ups',
        MIRANDA_VIEJO: 'deprecado',
        PATH: '/usr/bin', // sin prefijo VERGIS_/MIRANDA_ → jamás es «unknown» del producto
      },
    })
    c.env('VERGIS_CH_URL')
    c.envKeys(['PORT', 'VERGIS_ENGINE'])
    const unwatch = c.watch({ envs: ['VERGIS_POLICIES'], reloads: 'gobierno' }, [], () => {})
    const snap = c.snapshot()
    expect(snap.env.bootOnly).toEqual(['PORT', 'VERGIS_CH_URL', 'VERGIS_ENGINE'])
    expect(snap.env.reloadableContent).toEqual(['VERGIS_POLICIES'])
    expect(snap.env.unknown).toEqual(['MIRANDA_VIEJO', 'VERGIS_TYPO'])
    unwatch()
  })

  it('`env()` devuelve EXACTAMENTE lo que devolvería process.env (misma semántica, solo queda registrada)', () => {
    const c = registry({ envSource: { A: '1', VERGIS_X: '' } })
    expect(c.env('A')).toBe('1')
    expect(c.env('VERGIS_X')).toBe('')
    expect(c.env('NO_EXISTE')).toBeUndefined()
    expect(c.snapshot().env.bootOnly).toEqual(['A', 'NO_EXISTE', 'VERGIS_X'])
  })

  it('los caveats se registran una sola vez aunque su sitio se ejecute muchas veces', () => {
    const c = registry()
    for (let i = 0; i < 3; i += 1) c.caveat('un pool ya abierto conserva sus credenciales')
    c.caveat('otra')
    expect(c.snapshot().caveats).toEqual(['un pool ya abierto conserva sus credenciales', 'otra'])
  })

  it('las señales registradas salen en el snapshot y el snapshot lleva versión/motor/hotReload', () => {
    const c = registry({ engine: 'clickhouse', hotReload: false })
    c.signal({ signal: 'SIGHUP', action: 'recarga completa de gobierno' })
    const snap = c.snapshot()
    expect(snap.signals).toEqual([{ signal: 'SIGHUP', action: 'recarga completa de gobierno' }])
    expect(snap.engine).toBe('clickhouse')
    expect(snap.hotReload).toBe(false)
    expect(snap.version).toBe(VERGIS_VERSION) // build-time (D6), jamás leyendo package.json en runtime
    expect(typeof snap.startedAt).toBe('string')
  })

  it('NUNCA expone VALORES de env: el payload solo trae NOMBRES', () => {
    const c = registry({ envSource: { VERGIS_CH_ADMIN_PASS: 'sup3rs3cr3t0', VERGIS_TYPO: 'otro-secreto' } })
    c.env('VERGIS_CH_ADMIN_PASS')
    const body = JSON.stringify(c.snapshot())
    expect(body).toContain('VERGIS_CH_ADMIN_PASS')
    expect(body).not.toContain('sup3rs3cr3t0')
    expect(body).not.toContain('otro-secreto')
  })
})

describe('config · configEnvKeys (derivado con Proxy, no declarado)', () => {
  it('enumera las claves que configFromEnv consume DE VERDAD', () => {
    const keys = configEnvKeys({})
    expect(keys).toContain('VERGIS_ENGINE')
    expect(keys).toContain('PORT')
    expect(keys).toContain('VERGIS_POLICIES')
    expect(keys).toContain('VERGIS_SPECS_DIR')
    expect(keys).toEqual([...keys].sort())
  })

  it('registra lo ACCEDIDO, no lo declarado: las claves de Miranda salen porque `mirandaConfig` las lee siempre', () => {
    // Verificado contra el código: `mirandaConfig` arma su objeto de retorno con o sin el flag, así que
    // TODAS sus claves se acceden. La lista es fiel al código — que es el punto de derivarla del Proxy.
    expect(configEnvKeys({})).toContain('MIRANDA_MODEL')
    expect(configEnvKeys({})).toContain('MIRANDA_SCOPE_GROUP')
  })

  it('una config INVÁLIDA no rompe la enumeración: devuelve lo registrado HASTA el fallo', () => {
    // MIRANDA_ENABLED sin API key aborta `configFromEnv`: se conservan las claves ya accedidas y se
    // pierden las posteriores — el contrato prefiere una lista parcial a no responder.
    const keys = configEnvKeys({ MIRANDA_ENABLED: '1' })
    expect(keys).toContain('MIRANDA_ENABLED')
    expect(keys).toContain('ANTHROPIC_API_KEY')
    expect(keys).not.toContain('VERGIS_POLICIES')
    // Y un engine inválido corta antes todavía.
    expect(configEnvKeys({ VERGIS_ENGINE: 'no-existe' })).toEqual(['VERGIS_ENGINE'])
  })
})

// ── El endpoint, por el router real ────────────────────────────────────────────────────────────────
const REPORT: Report = { code: 'QW-04', slug: 'qw-04', name: 'Asistencia', specPath: '/a.yaml', tables: ['t'], databaseRefs: [] }

function mkReq(url: string, method = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  return { url, method, headers } as unknown as IncomingMessage
}

function mkRes() {
  const calls: { status: number; body: string; headers: Record<string, string> } = { status: 0, body: '', headers: {} }
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))
  const res = {
    headersSent: false,
    writeHead: (code: number, h?: Record<string, string>) => {
      calls.status = code
      calls.headers = h ?? {}
    },
    end: (b?: string) => {
      calls.body = b ?? ''
      resolveDone()
    },
    destroy: () => resolveDone(),
  } as unknown as ServerResponse
  return { res, calls, done }
}

function deps(over: Partial<RouteDeps> = {}): RouteDeps {
  return {
    engine: 'fabric',
    gateSecret: '',
    isReady: () => true,
    getAdmin: () => null,
    getPiConfig: () => null,
    discover: () => [REPORT],
    identityFor: () => ({ agent: 'test', user: 'ana@x.com' }),
    renderReport: async () => '<html>PI</html>',
    indexReports: async (all) => all,
    renderIndexPage: async () => '<html>INDEX</html>',
    canOpenPi: async () => true,
    ...over,
  }
}

function contractDeps(over: { isAdmin?: ((email: string | undefined) => Promise<boolean>) | null; journalDir?: string } = {}) {
  const dir = work()
  const pol = join(dir, 'politicas.yaml')
  writeFileSync(pol, 'policies:\n  ventas: {}\n')
  const c = createContractRegistry({ engine: 'fabric', hotReload: true, envSource: { VERGIS_POLICIES: pol, VERGIS_TYPO: 'x' } })
  c.envKeys(['PORT', 'VERGIS_ENGINE'])
  const unwatch = c.watch({ envs: ['VERGIS_POLICIES'], reloads: 'gobierno completo' }, [], () => {})
  c.signal({ signal: 'SIGHUP', action: 'fuerza la recarga completa de gobierno' })
  c.caveat('las inyecciones del canal de serving se fijan al arranque: un claim nuevo requiere restart')
  c.record({ reason: 'boot', ok: true, policies: 1, servablePis: 1 }, [{ source: 'policies', path: pol }])
  const journalDir = over.journalDir ?? dir
  const journal = createContractJournal({ dir: journalDir })
  const handler = createContractHandler({
    registry: c,
    journal,
    isAdmin: over.isAdmin === undefined ? async (email) => email === 'ana@x.com' : over.isAdmin,
    identityOf: (h) => ({ user: (h['x-forwarded-email'] as string) ?? 'ana@x.com' }),
  })
  return { dir, pol, journalDir, journal, registry: c, handler, cleanup: () => { unwatch(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('contrato · GET /contrato por el router real', () => {
  it('admin → 200 JSON con watches, signals, reloads.last, artifacts, env y caveats', async () => {
    const k = contractDeps()
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ getContract: () => k.handler }))(mkReq('/contrato'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.headers['content-type']).toContain('application/json')
    expect(calls.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(calls.body) as ContractSnapshot
    expect(body.watches[0]).toMatchObject({ envs: ['VERGIS_POLICIES'], reloads: 'gobierno completo' })
    expect(body.signals[0].signal).toBe('SIGHUP')
    expect(body.reloads.last).toMatchObject({ reason: 'boot', ok: true, policies: 1, servablePis: 1 })
    expect(body.artifacts[0]).toMatchObject({ source: 'policies', path: k.pol, pending: false })
    expect(body.env.bootOnly).toEqual(['PORT', 'VERGIS_ENGINE'])
    expect(body.env.reloadableContent).toEqual(['VERGIS_POLICIES'])
    expect(body.env.unknown).toEqual(['VERGIS_TYPO'])
    expect(body.caveats).toHaveLength(1)
    expect(body.engine).toBe('fabric')
    k.cleanup()
  })

  it('NO admin → 403 (el contrato es superficie de operación, no de consumo)', async () => {
    const k = contractDeps({ isAdmin: async () => false })
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ getContract: () => k.handler }))(mkReq('/contrato'), res)
    await done
    expect(calls.status).toBe(403)
    expect(calls.body).not.toContain('VERGIS_POLICIES')
    k.cleanup()
  })

  it('sin store de gobierno (isAdmin null) → 403 con motivo claro', async () => {
    const k = contractDeps({ isAdmin: null })
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ getContract: () => k.handler }))(mkReq('/contrato'), res)
    await done
    expect(calls.status).toBe(403)
    expect(JSON.parse(calls.body).error).toContain('Administración')
    k.cleanup()
  })

  it('método ≠ GET → 405', async () => {
    const k = contractDeps()
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ getContract: () => k.handler }))(mkReq('/contrato', 'POST'), res)
    await done
    expect(calls.status).toBe(405)
    k.cleanup()
  })

  it('responde AUNQUE el motor no esté listo (va antes del gate `ready`): «¿por qué no arranca?»', async () => {
    const k = contractDeps()
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ getContract: () => k.handler, isReady: () => false }))(mkReq('/contrato'), res)
    await done
    expect(calls.status).toBe(200)
    k.cleanup()
  })

  it('el token del gate manda: sin él, ni el contrato responde', async () => {
    const k = contractDeps()
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ getContract: () => k.handler, gateSecret: 's3creto' }))(mkReq('/contrato'), res)
    await done
    expect(calls.status).toBe(403)
    expect(calls.body).toContain('token del gate')
    k.cleanup()
  })

  it('sin la dep inyectada la ruta NO se intercepta: superficie idéntica a la de antes del issue', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps())(mkReq('/contrato'), res)
    await done
    expect(calls.status).toBe(404)
  })
})

// ── EL ESCENARIO DEL ISSUE ─────────────────────────────────────────────────────────────────────────
describe('contrato · «¿el nodo tomó mi archivo?» (aceptación del issue #139)', () => {
  it('recarga registrada → pending:false; archivo reescrito sin recarga → pending:true', async () => {
    const dir = work()
    const pol = join(dir, 'politicas.yaml')
    writeFileSync(pol, 'policies:\n  ventas: { grant: all }\n')
    const c = createContractRegistry({ engine: 'fabric', hotReload: true, envSource: {} })
    // El watch dispara → el server recarga → registra DONDE OCURRE (acá se simula esa llamada).
    c.record({ reason: 'watch:policies', ok: true, policies: 1, servablePis: 1 }, [{ source: 'policies', path: pol }])
    const handler = createContractHandler({
      registry: c,
      journal: createContractJournal({ dir }),
      isAdmin: async () => true,
      identityOf: () => ({ user: 'ops@x.com' }),
    })
    const ask = async (): Promise<ContractSnapshot> => {
      const { res, calls, done } = mkRes()
      createRequestHandler(deps({ getContract: () => handler }))(mkReq('/contrato'), res)
      await done
      expect(calls.status).toBe(200)
      return JSON.parse(calls.body) as ContractSnapshot
    }

    // 1) El operador pregunta: el nodo TOMÓ su archivo.
    const antes = await ask()
    expect(antes.artifacts[0].sha256).toBe(sha('policies:\n  ventas: { grant: all }\n'))
    expect(antes.artifacts[0].diskSha256).toBe(antes.artifacts[0].sha256)
    expect(antes.artifacts[0].pending).toBe(false)

    // 2) Escribe una política nueva y el nodo AÚN NO la tomó (no hubo recarga registrada).
    writeFileSync(pol, 'policies:\n  ventas: { rls: [{ column: area, claim: groups, op: in }] }\n')
    const despues = await ask()
    expect(despues.artifacts[0].pending).toBe(true)
    expect(despues.artifacts[0].sha256).toBe(antes.artifacts[0].sha256) // lo CARGADO no cambió
    expect(despues.artifacts[0].diskSha256).not.toBe(antes.artifacts[0].sha256)

    // 3) Ocurre la recarga → vuelve a `pending:false` sin reiniciar nada.
    c.record({ reason: 'SIGHUP', ok: true, policies: 1, servablePis: 1 }, [{ source: 'policies', path: pol }])
    const recargado = await ask()
    expect(recargado.artifacts[0].pending).toBe(false)
    expect(recargado.reloads.last!.reason).toBe('SIGHUP')

    rmSync(dir, { recursive: true, force: true })
  })
})

// ── NIVEL 2 · el delta entre versiones, por el router real ─────────────────────────────────────────
// `VERGIS_VERSION` es import build-time: el arnés NO mockea el módulo — inyecta las versiones
// «anteriores» sembrando el journal con `observe` de snapshots fabricados sobre el MISMO dir.
const journalFile = (dir: string): string => join(dir, 'contrato', 'journal.json')

function fakeSnap(over: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return {
    version: '0.0.0-anterior',
    engine: 'fabric',
    startedAt: '2026-08-01T00:00:00.000Z',
    hotReload: true,
    watches: [],
    signals: [],
    reloads: { last: null, recent: [] },
    artifacts: [],
    env: { bootOnly: ['PORT', 'VERGIS_ENGINE', 'VERGIS_POLICIES'], reloadableContent: [], unknown: [] },
    caveats: ['las inyecciones del canal de serving se fijan al arranque: un claim nuevo requiere restart'],
    ...over,
  }
}

async function askContrato(handler: ReturnType<typeof createContractHandler>, url = '/contrato') {
  const { res, calls, done } = mkRes()
  createRequestHandler(deps({ getContract: () => handler }))(mkReq(url), res)
  await done
  return calls
}

describe('contrato · delta entre versiones (issue #139 · Nivel 2)', () => {
  it('dos vidas, un journal: el GET dice contra QUÉ versión se compara y qué watch apareció', async () => {
    expect(VERGIS_VERSION).not.toBeNull() // premisa: el build hornea la versión (si no, sería `version-desconocida`)
    const journalDir = work()
    // Vida 1 — la versión anterior corrió acá sin el watch de políticas y con VERGIS_POLICIES bootOnly.
    createContractJournal({ dir: journalDir }).observe(fakeSnap())
    // Vida 2 — la versión que corre (VERGIS_VERSION) trae el watch: `contractDeps` lo instala.
    const k = contractDeps({ journalDir })
    const calls = await askContrato(k.handler)
    expect(calls.status).toBe(200)
    const body = JSON.parse(calls.body) as ContractSnapshot & { delta: ContractDelta }
    expect(body.watches[0]).toMatchObject({ envs: ['VERGIS_POLICIES'] }) // el snapshot N1, intacto
    expect(body.delta.reason).toBeNull()
    expect(body.delta.reference).toMatchObject({ version: '0.0.0-anterior' })
    expect(body.delta.current.version).toBe(VERGIS_VERSION)
    expect(body.delta.changes!.watches.added).toEqual([{ envs: ['VERGIS_POLICIES'], reloads: 'gobierno completo' }])
    // La invalidación de la regla del operador, nombrada sola:
    expect(body.delta.changes!.env.nowReloadable).toEqual(['VERGIS_POLICIES'])
    expect(body.delta.unchanged).toBe(false)
    // Y jamás el path de la instancia (que sí viaja en el snapshot N1).
    expect(JSON.stringify(body.delta)).not.toContain(k.pol)
    k.cleanup()
    rmSync(journalDir, { recursive: true, force: true })
  })

  it('instancia virgen: `primer-registro` y el journal queda SEMBRADO para el próximo despliegue', async () => {
    const journalDir = work()
    const k = contractDeps({ journalDir })
    const body = JSON.parse((await askContrato(k.handler)).body) as { delta: ContractDelta }
    expect(body.delta).toMatchObject({ reason: 'primer-registro', reference: null, changes: null })
    expect(existsSync(journalFile(journalDir))).toBe(true)
    expect(createContractJournal({ dir: journalDir }).versions()).toEqual([VERGIS_VERSION])
    k.cleanup()
    rmSync(journalDir, { recursive: true, force: true })
  })

  it('`?desde=` diffea contra esa versión; una no registrada → 404 con las disponibles', async () => {
    const journalDir = work()
    createContractJournal({ dir: journalDir }).observe(fakeSnap({ version: '0.0.1-julio', caveats: [] }))
    const k = contractDeps({ journalDir })
    const feliz = await askContrato(k.handler, '/contrato?desde=0.0.1-julio')
    expect(feliz.status).toBe(200)
    const body = JSON.parse(feliz.body) as { delta: ContractDelta }
    expect(body.delta.reference!.version).toBe('0.0.1-julio')
    expect(body.delta.changes!.caveats.added).toHaveLength(1)

    const perdida = await askContrato(k.handler, '/contrato?desde=0.9.0')
    expect(perdida.status).toBe(404)
    const err = JSON.parse(perdida.body) as { error: string; disponibles: string[] }
    expect(err.error).toContain("'0.9.0'")
    expect(err.disponibles).toContain('0.0.1-julio')
    expect(err.disponibles).toContain(VERGIS_VERSION)
    k.cleanup()
    rmSync(journalDir, { recursive: true, force: true })
  })

  it('un 403 NO escribe disco: el `observe` va después del gate de rol', async () => {
    const journalDir = work()
    const k = contractDeps({ journalDir, isAdmin: async () => false })
    const calls = await askContrato(k.handler)
    expect(calls.status).toBe(403)
    expect(existsSync(journalFile(journalDir))).toBe(false)
    k.cleanup()
    rmSync(journalDir, { recursive: true, force: true })
  })

  it('GET repetido sin cambios: el journal no se reescribe (huella igual ⇒ el GET típico no toca disco)', async () => {
    const journalDir = work()
    const k = contractDeps({ journalDir })
    await askContrato(k.handler)
    const mtime = statSync(journalFile(journalDir)).mtimeMs
    await new Promise((r) => setTimeout(r, 10))
    await askContrato(k.handler)
    await askContrato(k.handler)
    expect(statSync(journalFile(journalDir)).mtimeMs).toBe(mtime)
    k.cleanup()
    rmSync(journalDir, { recursive: true, force: true })
  })
})
