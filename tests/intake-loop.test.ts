import { describe, it, expect } from 'vitest'
import {
  SqliteGovernanceStore,
  INTAKE_WATCH_STATE_KEY,
  type CargaRegistrada,
  type IntakeSlot,
  type OneLakeEntry,
  type OneLakeListing,
  type RetiroRegistrado,
  type RunRecord,
} from '@vergis/capabilities'
import { createIntakeLoop, summarizeIntakeWatch, type IntakeLoopDeps } from '../server/intake-loop'
import type { Notification } from '../server/notify'

/**
 * Arnés del lazo de vigilancia del intake (#161·H4). Todo lo externo es FAKE e inyectado: el listado
 * del landing (que puede LANZAR — fallar en medir es un estado propio), las corridas del trigger, el
 * registro de cargas y los retiros. El store es el real (SQLite en memoria): la proyección y el
 * estado persistido son la mitad de lo que estos tests ponen en riesgo.
 */
const T0 = Date.parse('2026-08-13T12:00:00.000Z')
const PUBLIC_URL = 'https://mira.example.com'
const DOMINIOS = [{ id: 'cartera', label: 'Cartera / Finanzas' }]
const POLL_MS = 600_000

const slotDe = (over: Partial<IntakeSlot> = {}): IntakeSlot => ({
  id: 'saldos',
  label: 'Saldos de cartera',
  domain: 'cartera',
  target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' },
  trigger: { processRef: 'pipe_saldos' },
  ...over,
})

const archivo = (name: string, minutosDeEdad: number, nowMs = T0): OneLakeEntry => ({
  path: `Files/intake/saldos/${name}`,
  isDirectory: false,
  size: 1024,
  lastModified: new Date(nowMs - minutosDeEdad * 60_000).toISOString(),
})

interface Arnes {
  store: SqliteGovernanceStore
  alerts: Notification[]
  logs: string[]
  clock: { ms: number }
  landing: { listing: OneLakeListing | null; error: string | null; llamadas: number }
  runs: { records: RunRecord[] }
  registro: { cargas: CargaRegistrada[]; retiros: RetiroRegistrado[] | null }
  loop: { tick(): Promise<void> }
  /** Un lazo NUEVO sobre el MISMO store: simula el reinicio del server. */
  reiniciar: () => { tick(): Promise<void> }
}

async function armar(opts: { slots?: IntakeSlot[]; alertas?: boolean; conMotor?: boolean; store?: SqliteGovernanceStore } = {}): Promise<Arnes> {
  const store = opts.store ?? (await SqliteGovernanceStore.open(null, {}))
  const alerts: Notification[] = []
  const logs: string[] = []
  const clock = { ms: T0 }
  const landing: Arnes['landing'] = { listing: { kind: 'ok', entries: [] }, error: null, llamadas: 0 }
  const runs = { records: [] as RunRecord[] }
  const registro: Arnes['registro'] = { cargas: [], retiros: [] }
  const slots = opts.slots ?? [slotDe()]

  const armarDeps = (): IntakeLoopDeps => {
    const deps: IntakeLoopDeps = {
      slots: () => slots,
      landing: async () => {
        landing.llamadas++
        if (landing.error) throw new Error(landing.error)
        return landing.listing ?? { kind: 'absent' }
      },
      uploads: async () => registro.cargas,
      retiros: async () => registro.retiros,
      store,
      domains: DOMINIOS,
      log: (l) => void logs.push(l),
      now: () => clock.ms,
    }
    if (opts.conMotor !== false) deps.runs = async () => runs.records
    if (opts.alertas !== false) deps.notify = async (n) => void alerts.push(n)
    return deps
  }

  const nuevo = (): { tick(): Promise<void> } => createIntakeLoop(armarDeps(), { publicUrl: PUBLIC_URL, pollMs: POLL_MS })
  return { store, alerts, logs, clock, landing, runs, registro, loop: nuevo(), reiniciar: nuevo }
}

const snap = async (a: Arnes, slotId = 'saldos') => (await a.store.listSlotSnapshots()).find((s) => s.slotId === slotId)

describe('intake-loop · fase OBSERVAR', () => {
  it('proyecta el landing y las corridas leídas; el listado ES la verdad (lo que drenó desaparece)', async () => {
    const a = await armar()
    a.landing.listing = { kind: 'ok', entries: [archivo('x.xlsx', 5)] }
    a.runs.records = [{ startedAt: new Date(T0 - 60_000).toISOString(), status: 'Completed' }]
    await a.loop.tick()
    expect((await snap(a))?.landing.map((e) => e.path)).toEqual(['Files/intake/saldos/x.xlsx'])
    expect((await snap(a))?.runs).toHaveLength(1)
    expect((await snap(a))?.lastError).toBeNull()

    a.landing.listing = { kind: 'ok', entries: [] }
    await a.loop.tick()
    expect((await snap(a))?.landing).toEqual([])
  })

  it('una lectura que LANZA no mata el tick y deja el snapshot previo intacto', async () => {
    const a = await armar()
    a.landing.listing = { kind: 'ok', entries: [archivo('x.xlsx', 5)] }
    await a.loop.tick()
    const antes = await snap(a)

    a.landing.error = 'onelake: 403 forbidden'
    await expect(a.loop.tick()).resolves.toBeUndefined()
    const despues = await snap(a)
    expect(despues?.landing).toEqual(antes?.landing)
    expect(despues?.observedAt).toBe(antes?.observedAt) // una fallida NO mueve la última medida buena
    expect(despues?.lastError).toBe('onelake: 403 forbidden')
    expect(a.logs.some((l) => l.includes("no se pudo observar 'saldos'"))).toBe(true)
  })

  it('guard anti-solape: una re-entrada mientras hay vuelta en vuelo es no-op', async () => {
    const a = await armar()
    let soltar = (): void => {}
    const enVuelo = new Promise<void>((r) => (soltar = r))
    const deps: IntakeLoopDeps = {
      slots: () => [slotDe()],
      landing: async () => {
        a.landing.llamadas++
        await enVuelo
        return { kind: 'ok', entries: [] }
      },
      store: a.store,
      domains: DOMINIOS,
      log: (l) => void a.logs.push(l),
      now: () => a.clock.ms,
    }
    const loop = createIntakeLoop(deps, { publicUrl: PUBLIC_URL, pollMs: POLL_MS })
    const primera = loop.tick()
    await loop.tick() // re-entrada: debe salir sin observar
    expect(a.landing.llamadas).toBe(1)
    expect(a.logs.some((l) => l.includes('tick saltado'))).toBe(true)
    soltar()
    await primera
  })

  it('sin motor cableado el slot se vigila igual por el landing (el listado no necesita motor)', async () => {
    const a = await armar({ conMotor: false })
    a.landing.listing = { kind: 'ok', entries: [archivo('viejo.xlsx', 500)] }
    await a.loop.tick()
    expect(a.alerts.map((n) => n.data['reason'])).toEqual(['varados'])
    expect((await snap(a))?.runs).toEqual([])
  })
})

describe('intake-loop · fase ALERTAR (dedup por transición)', () => {
  it('sano → varados emite UNA alerta; el tick siguiente sin cambio emite CERO; la recuperación emite ok', async () => {
    const a = await armar()
    await a.loop.tick()
    expect(a.alerts).toHaveLength(0)

    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)
    expect(a.alerts[0]!.data['reason']).toBe('varados')

    await a.loop.tick()
    expect(a.alerts).toHaveLength(1) // dedup por transición: ya estaba avisado

    a.landing.listing = { kind: 'ok', entries: [] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(2)
    expect(a.alerts[1]!.severity).toBe('ok')
    expect(a.alerts[1]!.data['event']).toBe('intake-recovery')
  })

  it('el aviso lleva dominio, slot, el archivo con su edad y los enlaces profundos con publicUrl', async () => {
    const a = await armar()
    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    a.runs.records = [{ startedAt: new Date(T0 - 200 * 60_000).toISOString(), status: 'Completed' }]
    await a.loop.tick()
    const n = a.alerts[0]!
    expect(n.severity).toBe('warning')
    expect(n.title).toBe('Cargas — Cartera / Finanzas · Saldos de cartera: hay archivos sin procesar en la zona de aterrizaje')
    expect(n.lines.some((l) => l.includes('atascado.xlsx') && l.includes('5 h'))).toBe(true)
    expect(n.links).toEqual([{ label: 'Cargas del dominio', url: `${PUBLIC_URL}/admin/dominio/cartera/cargas` }])
    expect(n.data['slotId']).toBe('saldos')
    expect(n.data['medida']).toBe('fresca')
  })

  it('un slot cuyo dominio no está declarado avisa igual, sin enlaces y diciéndolo', async () => {
    const a = await armar({ slots: [slotDe({ id: 'huerfano', domain: 'no_declarado' })] })
    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    await a.loop.tick()
    expect(a.alerts[0]!.links).toEqual([])
    expect(a.alerts[0]!.lines.some((l) => l.includes('enlaces no disponibles'))).toBe(true)
  })

  it('el estado se persiste SOLO en transición y sobrevive al reinicio (no re-notifica lo ya avisado)', async () => {
    const a = await armar()
    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    await a.loop.tick()
    expect(JSON.parse((await a.store.getSetting(INTAKE_WATCH_STATE_KEY)) ?? '{}')).toEqual({ saldos: 'varados' })

    // Reinicio: lazo nuevo, MISMO store. El estado se hidrata en el primer tick.
    const otro = a.reiniciar()
    await otro.tick()
    expect(a.alerts).toHaveLength(1)
  })

  it('cada slot dedupea por SU id: dos slots en alerta producen dos avisos y dos entradas de estado', async () => {
    const a = await armar({ slots: [slotDe(), slotDe({ id: 'otro', label: 'Otro slot' })] })
    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(2)
    expect(JSON.parse((await a.store.getSetting(INTAKE_WATCH_STATE_KEY)) ?? '{}')).toEqual({ saldos: 'varados', otro: 'varados' })
  })

  it('sin destinos de aviso la proyección se escribe igual y NO se persiste estado de alertas', async () => {
    const a = await armar({ alertas: false })
    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    await a.loop.tick()
    expect((await snap(a))?.landing).toHaveLength(1)
    expect(await a.store.getSetting(INTAKE_WATCH_STATE_KEY)).toBeNull()
  })
})

describe("intake-loop · 'sin-medida' es una alerta de primera clase", () => {
  it('a la 3.ª lectura fallida consecutiva emite sin-medida UNA sola vez, por el mismo canal', async () => {
    const a = await armar()
    await a.loop.tick() // medida buena: siembra el baseline
    a.landing.error = 'onelake: ETIMEDOUT'
    for (let i = 1; i <= 4; i++) {
      a.clock.ms = T0 + i * POLL_MS
      await a.loop.tick()
    }
    const sinMedida = a.alerts.filter((n) => n.data['reason'] === 'sin-medida')
    expect(sinMedida).toHaveLength(1)
    expect(sinMedida[0]!.severity).toBe('warning')
    expect(sinMedida[0]!.data['medida']).toBe('ultima-conocida')
    expect(sinMedida[0]!.lines.some((l) => l.includes('ETIMEDOUT'))).toBe(true)
  })

  it('un slot ciego desde el primer tick TAMBIÉN cruza el umbral (baseline = primer intento)', async () => {
    const a = await armar()
    a.landing.error = 'onelake: 403 forbidden'
    for (let i = 0; i <= 3; i++) {
      a.clock.ms = T0 + i * POLL_MS
      await a.loop.tick()
    }
    const sinMedida = a.alerts.filter((n) => n.data['reason'] === 'sin-medida')
    expect(sinMedida).toHaveLength(1)
    expect(sinMedida[0]!.data['medida']).toBe('ninguna')
  })

  it('con la lectura caída y proyección previa, el varado REAL sigue alertando sobre lo último conocido', async () => {
    const a = await armar()
    a.landing.listing = { kind: 'ok', entries: [archivo('lento.xlsx', 100)] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(0)

    // El almacenamiento se cae y el archivo cruza su umbral: la edad se computa contra el RELOJ sobre
    // lo PROYECTADO (25 min de ceguera: todavía no se cumple el umbral de `sin-medida`).
    a.landing.error = 'onelake: 500'
    a.clock.ms = T0 + 25 * 60_000
    await a.loop.tick()
    const varados = a.alerts.filter((n) => n.data['reason'] === 'varados')
    expect(varados).toHaveLength(1)
    expect(varados[0]!.data['medida']).toBe('ultima-conocida')
    expect(varados[0]!.data['lastError']).toBe('onelake: 500')
  })

  it('la ceguera pesa MÁS que lo que se dedujo de la proyección: sin-medida desplaza a varados', async () => {
    const a = await armar()
    a.landing.listing = { kind: 'ok', entries: [archivo('lento.xlsx', 100)] }
    await a.loop.tick()
    a.landing.error = 'onelake: 500'
    a.clock.ms = T0 + 40 * 60_000 // > 3 × poll: el vigilante lleva rato sin ver
    await a.loop.tick()
    expect(a.alerts.map((n) => n.data['reason'])).toEqual(['sin-medida'])
  })
})

describe('intake-loop · control positivo contra el vacío-con-éxito', () => {
  it('registro que predice un archivo + listado ok y VACÍO ⇒ contradice-registro nombrando el archivo', async () => {
    const a = await armar()
    a.registro.cargas = [{ filename: 'f.xlsx', uploadedAt: new Date(T0 - 10 * 60_000).toISOString(), ok: true }]
    a.landing.listing = { kind: 'ok', entries: [] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)
    expect(a.alerts[0]!.data['reason']).toBe('contradice-registro')
    expect(a.alerts[0]!.data['esperados']).toEqual(['f.xlsx'])
    expect(a.alerts[0]!.lines.some((l) => l.includes('NO se concluye «landing vacío»'))).toBe(true)
  })

  it('el mismo insumo con un retiro posterior a la carga NO contradice a nadie', async () => {
    const a = await armar()
    a.registro.cargas = [{ filename: 'f.xlsx', uploadedAt: new Date(T0 - 10 * 60_000).toISOString(), ok: true }]
    a.registro.retiros = [{ filename: 'f.xlsx', at: new Date(T0 - 5 * 60_000).toISOString() }]
    a.landing.listing = { kind: 'ok', entries: [] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(0)
  })

  it('sin poder saber los retiros el control se APAGA (no se acusa una contradicción indefendible)', async () => {
    const a = await armar()
    a.registro.cargas = [{ filename: 'f.xlsx', uploadedAt: new Date(T0 - 10 * 60_000).toISOString(), ok: true }]
    a.registro.retiros = null
    a.landing.listing = { kind: 'ok', entries: [] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(0)
  })

  it('sin corridas leídas (slot land-only / instancia sin motor) el control NO corre', async () => {
    const a = await armar({ conMotor: false })
    a.registro.cargas = [{ filename: 'f.xlsx', uploadedAt: new Date(T0 - 10 * 60_000).toISOString(), ok: true }]
    a.landing.listing = { kind: 'ok', entries: [] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(0)
  })

  it('landing ABSENTE con cargas registradas es contradicción, no «landing vacío»', async () => {
    const a = await armar()
    a.registro.cargas = [{ filename: 'f.xlsx', uploadedAt: new Date(T0 - 10 * 60_000).toISOString(), ok: true }]
    a.landing.listing = { kind: 'absent' }
    await a.loop.tick()
    expect(a.alerts[0]!.data['reason']).toBe('contradice-registro')
  })
})

describe('summarizeIntakeWatch · el tile del dashboard', () => {
  const snaps = async (a: Arnes) => await a.store.listSlotSnapshots()

  it('slot sano: 1 vigilado, 0 en alerta, 0 sin medir', async () => {
    const a = await armar({ alertas: false })
    a.landing.listing = { kind: 'ok', entries: [archivo('reciente.xlsx', 5)] }
    await a.loop.tick()
    expect(summarizeIntakeWatch([slotDe()], await snaps(a), POLL_MS, T0)).toEqual({ vigilados: 1, enAlerta: 0, sinMedir: 0 })
  })

  it('slot con varado cuenta en alerta; slot con lectura caída cuenta en sin medir, no en alerta', async () => {
    const a = await armar({ alertas: false })
    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    await a.loop.tick()
    expect(summarizeIntakeWatch([slotDe()], await snaps(a), POLL_MS, T0)).toEqual({ vigilados: 1, enAlerta: 1, sinMedir: 0 })

    a.landing.error = 'onelake: 500'
    a.clock.ms = T0 + POLL_MS
    await a.loop.tick()
    const s = summarizeIntakeWatch([slotDe()], await snaps(a), POLL_MS, T0 + POLL_MS)
    expect(s.sinMedir).toBe(1)
  })

  it('la proyección que nadie refresca NO es una medida: con el lazo apagado todo cuenta sin medir', async () => {
    const a = await armar({ alertas: false })
    a.landing.listing = { kind: 'ok', entries: [archivo('reciente.xlsx', 5)] }
    await a.loop.tick()
    expect(summarizeIntakeWatch([slotDe()], await snaps(a), 0, T0).sinMedir).toBe(1)
    // Y con el lazo vivo pero la proyección rancia (> 3 × poll sin observación) también.
    expect(summarizeIntakeWatch([slotDe()], await snaps(a), POLL_MS, T0 + 4 * POLL_MS).sinMedir).toBe(1)
  })

  it('un slot sin proyección alguna cuenta vigilado y sin medir', () => {
    expect(summarizeIntakeWatch([slotDe()], [], POLL_MS, T0)).toEqual({ vigilados: 1, enAlerta: 0, sinMedir: 1 })
  })
})

describe('intake-loop · el criterio del issue #161', () => {
  /**
   * EL criterio del issue: un job roto + un archivo subido y, ANTES de que intervenga una persona,
   * el operador ya tiene la notificación y la plataforma ya tiene el estado en su proyección. El
   * arnés no llama a ninguna acción manual: solo corre el tick que el timer correría solo.
   */
  it('slot con job roto + archivo subido ⇒ notificación en el sink fake y estado en la proyección', async () => {
    const a = await armar()
    const subidoA = new Date(T0 - 30 * 60_000).toISOString()
    a.registro.cargas = [{ filename: 'saldos.xlsx', uploadedAt: subidoA, ok: true }]
    a.landing.listing = { kind: 'ok', entries: [archivo('saldos.xlsx', 30)] }
    a.runs.records = [{ startedAt: subidoA, status: 'Failed', error: 'state=[dead]: el notebook no arrancó' }]

    await a.loop.tick()

    // 1) el aviso llegó al canal, con la corrida y el enlace profundo para ir a verla
    expect(a.alerts).toHaveLength(1)
    const n = a.alerts[0]!
    expect(n.data['reason']).toBe('corrida-fallida')
    expect(n.title).toContain('la conversión falló')
    expect(n.lines.some((l) => l.includes('state=[dead]'))).toBe(true)
    expect(n.links.map((l) => l.url)).toContain(`${PUBLIC_URL}/admin/dominio/cartera/corrida?slot=saldos&started=${encodeURIComponent(subidoA)}`)
    // 2) el estado quedó en la proyección y en el estado persistido — sin que nadie abriera una página
    const s = await snap(a)
    expect(s?.runs[0]?.status).toBe('Failed')
    expect(s?.landing.map((e) => e.path)).toEqual(['Files/intake/saldos/saldos.xlsx'])
    expect(JSON.parse((await a.store.getSetting(INTAKE_WATCH_STATE_KEY)) ?? '{}')).toEqual({ saldos: 'corrida-fallida' })
  })
})
