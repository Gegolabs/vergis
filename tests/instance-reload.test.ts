// Recarga de la CONFIG DE INSTANCIA sin recrear el proceso (issue #138·2, fase 1).
//
// Qué prueba y qué NO: `server/serve-rls.ts` no es importable (es un módulo de arranque con
// top-level await que levanta el servidor), así que estos tests montan el MISMO mecanismo con las
// MISMAS piezas reales que el orquestador usa —`loadSlice`, `createSinks`, `fanout`,
// `swapRecordInPlace`, `createFreshnessLoop`, `createContractRegistry`, `bootstrapPi`— y lo ponen en
// riesgo. Lo que queda fuera de su alcance es el CABLEADO concreto de serve-rls; ese es exactamente
// el hueco que cierra la verificación integrada del hito F1-H5 (arnés vivo, archivo montado).

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SqliteGovernanceStore, type DeriveMapInput, type IngestionEngineClient, type ProcessRow, type RunRecord, type SourceRow } from '@vergis/capabilities'
import { loadSlice, RELOADABLE_SLICES, type EnvLike } from '../server/instance-config'
import { createSinks, fanout, forEvent, type Notification, type NotificationSink } from '../server/notify'
import { swapRecordInPlace } from '../server/hot-reload'
import { createFreshnessLoop } from '../server/freshness-loop'
import { createContractRegistry } from '../server/contract'

const PUBLIC_URL = 'https://mira.example.com'
const T0 = Date.parse('2026-08-06T12:00:00.000Z')

/** Escribe `contenido` en un yaml temporal y devuelve el env que lo declara. */
function yamlEnv(nombre: string, contenido: string): { env: EnvLike; path: string; escribir: (c: string) => void } {
  const path = join(mkdtempSync(join(tmpdir(), 'vergis-slice-')), nombre)
  writeFileSync(path, contenido, 'utf8')
  return { env: {}, path, escribir: (c: string) => writeFileSync(path, c, 'utf8') }
}

// ── (1) El arreglo VIVO de destinos + el fan-out incondicional ───────────────────────────────────

class MotorFake implements IngestionEngineClient {
  runs = new Map<string, RunRecord[]>()
  schedules = new Map<string, number | null>()
  async listRunHistory(id: string): Promise<RunRecord[]> {
    return this.runs.get(id) ?? []
  }
  async getScheduleSeconds(id: string): Promise<number | null> {
    return this.schedules.get(id) ?? null
  }
  async setScheduleSeconds(): Promise<void> {}
  async setScheduleEnabled(): Promise<void> {}
}

function insumos(): () => Promise<{ procs: ProcessRow[]; sources: SourceRow[]; mapInput: DeriveMapInput }> {
  const procs: ProcessRow[] = [{ id: 'p', label: 'Carga diaria', sourceId: 'src', engine: { workspaceId: 'WS', itemId: 'it', jobType: 'sparkjob' } }]
  const sources: SourceRow[] = [{ id: 'src', label: 'SAP', oferta: 'PT1H' }]
  const mapInput: DeriveMapInput = {
    sources: [{ id: 'src', oferta: 'PT1H' }],
    processes: [{ id: 'p', label: 'Carga diaria', sourceId: 'src' }],
    processOutputs: [],
    piTables: [],
    piDemandas: [],
  }
  return async () => ({ procs, sources, mapInput })
}

describe('recarga de instancia · destinos que aparecen en caliente (#138·2, caso 4.1)', () => {
  it('(1) lazo construido con CERO destinos: al splicear un sink, el SIGUIENTE tick entrega por él', async () => {
    const store = await SqliteGovernanceStore.open(null, {})
    const motor = new MotorFake()
    const reloj = { ms: T0 }
    // El arreglo VIVO de sinks, vacío al «boot» — y el closure de fan-out instalado INCONDICIONALMENTE,
    // que es el cambio de cableado que este caso pone en riesgo (el spread condicional lo omitía).
    const alertSinks: NotificationSink[] = []
    const loop = createFreshnessLoop(
      {
        engine: motor,
        store,
        inputs: insumos(),
        notify: (n: Notification) => fanout(alertSinks, n, () => {}),
        domains: [],
        audit: () => {},
        log: () => {},
        now: () => reloj.ms,
      },
      { reconcile: false, reconcileDebounceMs: 21_600_000, publicUrl: PUBLIC_URL },
    )

    motor.schedules.set('p', 3600)
    motor.runs.set('p', [{ startedAt: '2026-08-06T11:50:00Z', status: 'Failed', error: 'boom' }])
    await loop.tick() // con cero destinos: el fan-out corre y no entrega a nadie (no-op, no error)

    // Recarga en caliente: llegan destinos. Splice sobre la MISMA referencia que el lazo capturó.
    const recibidas: Notification[] = []
    alertSinks.splice(0, alertSinks.length, { id: 'nuevo', send: async (n) => void recibidas.push(n) })

    // Transición NUEVA (el dedup vive en el lazo: la anterior ya está en curso y no se repite).
    reloj.ms = T0 + 3 * 3600_000
    motor.runs.set('p', [{ startedAt: '2026-08-06T13:50:00Z', endedAt: '2026-08-06T13:52:00Z', status: 'Completed' }])
    await loop.tick()

    // REFUTARÍA el mecanismo: `recibidas` vacío — el lazo habría quedado sin closure de aviso por
    // haberse construido sin destinos, y añadirlos exigiría reconstruirlo (o sea, restart).
    expect(recibidas.length).toBeGreaterThan(0)
    await store.close()
  })

  it('(1-bis) sin destinos, el fan-out es un no-op: instalar el closure siempre no cuesta ni rompe', async () => {
    await expect(fanout([], { severity: 'info', title: 't', lines: [], links: [], data: {} } as Notification, () => {})).resolves.toBeUndefined()
  })
})

// ── (2)(3) Validate-before-swap: el slice roto conserva lo vigente ───────────────────────────────

/**
 * El orquestador de serve-rls, reducido a su esqueleto verificable: los mismos pasos, en el mismo
 * orden, sobre las mismas piezas. Nunca lanza; devuelve si el swap ocurrió.
 */
function recargarNotify(
  env: EnvLike,
  vivos: { alertSinks: NotificationSink[]; reportSinks: NotificationSink[] },
  publicUrl: string,
  hayGobierno: boolean,
  contract: ReturnType<typeof createContractRegistry>,
  path: string,
): boolean {
  try {
    const next = loadSlice(env, RELOADABLE_SLICES.notify) ?? { destinations: [] }
    if (next.destinations.length > 0 && !publicUrl) throw new Error('falta VERGIS_PUBLIC_URL')
    if (next.report && !hayGobierno) throw new Error('report: sin bloque de gobierno')
    const nextAlerts = createSinks(forEvent(next, 'alerts'))
    const nextReports = createSinks(forEvent(next, 'reports'))
    vivos.alertSinks.splice(0, vivos.alertSinks.length, ...nextAlerts)
    vivos.reportSinks.splice(0, vivos.reportSinks.length, ...nextReports)
    contract.record({ reason: 'watch:instancia', ok: true }, [{ source: 'notify', path }])
    return true
  } catch (e) {
    contract.record({ reason: 'watch:instancia', ok: false, error: `notify: ${e instanceof Error ? e.message : String(e)}` })
    return false
  }
}

const registro = (): ReturnType<typeof createContractRegistry> => createContractRegistry({ engine: 'fabric', hotReload: true })

describe('recarga de instancia · el slice rechazado conserva lo vigente (#138·2, D5 y casos 4.2/4.3/4.8)', () => {
  const VIGENTE = 'destinations:\n  - id: viejo\n    type: slack-webhook\n    url: https://hooks.slack.com/viejo\n'

  it('(2) destinos declarados SIN VERGIS_PUBLIC_URL: swap rechazado, vigente intacto, ok:false en el ring', () => {
    const y = yamlEnv('notify.yaml', VIGENTE)
    const env: EnvLike = { VERGIS_NOTIFY: y.path }
    const c = registro()
    const vivos = { alertSinks: createSinks(forEvent({ destinations: [] }, 'alerts')), reportSinks: [] as NotificationSink[] }
    recargarNotify(env, vivos, PUBLIC_URL, true, c, y.path) // primera recarga sana: entra 'viejo'
    expect(vivos.alertSinks.map((s) => s.id)).toEqual(['viejo'])

    y.escribir('destinations:\n  - id: nuevo\n    type: slack-webhook\n    url: https://hooks.slack.com/nuevo\n')
    const ok = recargarNotify(env, vivos, '' /* sin URL pública */, true, c, y.path)

    expect(ok).toBe(false)
    // REFUTARÍA: los sinks pasarían a ['nuevo'] — el swap habría ocurrido pese al invariante roto.
    expect(vivos.alertSinks.map((s) => s.id)).toEqual(['viejo'])
    const last = c.snapshot().reloads.last
    expect(last?.ok).toBe(false)
    expect(last?.error).toMatch(/VERGIS_PUBLIC_URL/)
  })

  it('(3) destino email cuyo passEnv no existe: createSinks lanza y el vigente sobrevive', () => {
    const y = yamlEnv('notify.yaml', VIGENTE)
    const env: EnvLike = { VERGIS_NOTIFY: y.path }
    const c = registro()
    const vivos = { alertSinks: [] as NotificationSink[], reportSinks: [] as NotificationSink[] }
    recargarNotify(env, vivos, PUBLIC_URL, true, c, y.path)
    expect(vivos.alertSinks.map((s) => s.id)).toEqual(['viejo'])

    y.escribir(
      'destinations:\n  - id: correo\n    type: email-smtp\n    from: a@b.cl\n    to: [c@d.cl]\n' +
        '    smtp:\n      host: smtp.b.cl\n      port: 587\n      user: a@b.cl\n      passEnv: VERGIS_SMTP_PASS_INEXISTENTE\n',
    )
    expect(recargarNotify(env, vivos, PUBLIC_URL, true, c, y.path)).toBe(false)
    expect(vivos.alertSinks.map((s) => s.id)).toEqual(['viejo'])
    expect(c.snapshot().reloads.last?.error).toMatch(/VERGIS_SMTP_PASS_INEXISTENTE/)
  })

  it('(3-bis) archivo DECAPITADO (perdió `destinations`): rechazado, vigente intacto (4.8)', () => {
    const y = yamlEnv('notify.yaml', VIGENTE)
    const env: EnvLike = { VERGIS_NOTIFY: y.path }
    const c = registro()
    const vivos = { alertSinks: [] as NotificationSink[], reportSinks: [] as NotificationSink[] }
    recargarNotify(env, vivos, PUBLIC_URL, true, c, y.path)
    y.escribir('otra_clave: 1\n')
    expect(recargarNotify(env, vivos, PUBLIC_URL, true, c, y.path)).toBe(false)
    expect(vivos.alertSinks.map((s) => s.id)).toEqual(['viejo'])
    expect(c.snapshot().reloads.last?.error).toMatch(/clave raíz 'destinations'/)
  })

  it("(3-ter) `report:` en instancia SIN bloque de gobierno: rechazado (4.4)", () => {
    const y = yamlEnv(
      'notify.yaml',
      'destinations:\n  - id: ops\n    type: slack-webhook\n    url: https://hooks.slack.com/x\n    events: [reports]\n' +
        'report:\n  every: daily\n  at: "08:30"\n',
    )
    const c = registro()
    const vivos = { alertSinks: [] as NotificationSink[], reportSinks: [] as NotificationSink[] }
    expect(recargarNotify({ VERGIS_NOTIFY: y.path }, vivos, PUBLIC_URL, false, c, y.path)).toBe(false)
    expect(c.snapshot().reloads.last?.error).toMatch(/bloque de gobierno/)
  })

  it('(3-quater) el slice ROTO no impide que otro slice SANO entre (D4: granularidad por archivo)', () => {
    const roto = yamlEnv('notify.yaml', 'destinations: [\n')
    const sano = yamlEnv('pi-owners.yaml', 'owners:\n  PI-1: ana@gh.cl\n')
    const c = registro()
    const vivos = { alertSinks: [] as NotificationSink[], reportSinks: [] as NotificationSink[] }
    expect(recargarNotify({ VERGIS_NOTIFY: roto.path }, vivos, PUBLIC_URL, true, c, roto.path)).toBe(false)
    const piOwners: Record<string, string> = {}
    swapRecordInPlace(piOwners, loadSlice({ VERGIS_PI_OWNERS: sano.path }, RELOADABLE_SLICES.piOwners) ?? {})
    expect(piOwners).toEqual({ 'PI-1': 'ana@gh.cl' }) // el sano entró igual
  })
})

// ── (4) La reclasificación del contrato es DERIVADA del watch ────────────────────────────────────

describe('recarga de instancia · el contrato reclasifica solo al registrar el watch (#138·2, §1.2)', () => {
  const ENVS = ['VERGIS_NOTIFY', 'VERGIS_PI_OWNERS', 'VERGIS_SOURCES']

  it('(4) antes del watch los envs son bootOnly; DESPUÉS son reloadableContent, sin tocar el contrato', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-watch-'))
    const paths = ENVS.map((e) => {
      const p = join(dir, `${e}.yaml`)
      writeFileSync(p, 'x: 1\n', 'utf8')
      return p
    })
    const c = createContractRegistry({ engine: 'fabric', hotReload: true })
    for (const e of ENVS) c.env(e) // el proceso las consume al cargar la config de instancia
    expect(c.snapshot().env.bootOnly).toEqual(expect.arrayContaining(ENVS))
    expect(c.snapshot().env.reloadableContent).toEqual([])

    const unwatch = c.watch({ envs: ENVS, reloads: 'config de instancia, por archivo' }, paths, () => {})

    const snap = c.snapshot()
    // REFUTARÍA la promesa de reclasificación automática: seguirían en bootOnly pese al watch.
    expect(snap.env.reloadableContent).toEqual(expect.arrayContaining(ENVS))
    for (const e of ENVS) expect(snap.env.bootOnly).not.toContain(e)
    expect(snap.watches.map((w) => w.reloads)).toContain('config de instancia, por archivo')
    unwatch()
  })

  it('(4-bis) VERGIS_PUBLIC_URL NO se vuelve recargable: es una env escalar, y eso es la verdad', () => {
    const c = createContractRegistry({ engine: 'fabric', hotReload: true })
    c.env('VERGIS_PUBLIC_URL')
    c.env('VERGIS_NOTIFY')
    const dir = mkdtempSync(join(tmpdir(), 'vergis-watch2-'))
    const p = join(dir, 'notify.yaml')
    writeFileSync(p, 'destinations: []\n', 'utf8')
    const unwatch = c.watch({ envs: ['VERGIS_NOTIFY'], reloads: 'avisos' }, [p], () => {})
    const snap = c.snapshot()
    expect(snap.env.bootOnly).toContain('VERGIS_PUBLIC_URL')
    expect(snap.env.reloadableContent).not.toContain('VERGIS_PUBLIC_URL')
    unwatch()
  })
})

// ── (5) piOwners vivo: aplica a PIs sin gobierno, no pisa a los ya bootstrapeados ────────────────

describe('recarga de instancia · dueños de PI en caliente (#138·2, D1 y caso 4.7)', () => {
  it('(5) el swap aplica al PI aún sin gobierno; el ya bootstrapeado conserva su dueño', async () => {
    const store = await SqliteGovernanceStore.open(null, {})
    const y = yamlEnv('pi-owners.yaml', 'owners:\n  pi-viejo: ana@gh.cl\n')
    const env: EnvLike = { VERGIS_PI_OWNERS: y.path }
    // Registro VIVO: `const` poblado por swap, tal como el módulo lo declara.
    const piOwners: Record<string, string> = {}
    swapRecordInPlace(piOwners, loadSlice(env, RELOADABLE_SLICES.piOwners) ?? {})

    await store.bootstrapPi('pi-viejo', piOwners['pi-viejo'] ?? '', [])
    expect((await store.getPiGovernance('pi-viejo'))?.createdBy).toBe('ana@gh.cl')

    // El yaml cambia en caliente: nuevo dueño para el PI viejo + un PI nuevo.
    y.escribir('owners:\n  pi-viejo: beto@gh.cl\n  pi-nuevo: caro@gh.cl\n')
    const diff = swapRecordInPlace(piOwners, loadSlice(env, RELOADABLE_SLICES.piOwners) ?? {})
    expect(diff).toEqual({ added: ['pi-nuevo'], changed: ['pi-viejo'], removed: [] })

    // El PI ya gobernado no se toca: `bootstrapPi` retorna temprano (el traspaso es in-app).
    await store.bootstrapPi('pi-viejo', piOwners['pi-viejo'] ?? '', [])
    expect((await store.getPiGovernance('pi-viejo'))?.createdBy).toBe('ana@gh.cl')

    // El PI que aún no tenía gobierno SÍ estrena el dueño nuevo, sin restart.
    // REFUTARÍA: `undefined` o vacío — el mapa vivo no habría llegado al bootstrap.
    await store.bootstrapPi('pi-nuevo', piOwners['pi-nuevo'] ?? '', [])
    expect((await store.getPiGovernance('pi-nuevo'))?.createdBy).toBe('caro@gh.cl')
    await store.close()
  })
})
