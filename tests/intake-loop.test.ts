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
import { createIntakeLoop, summarizeIntakeWatch, slotVigilanciaDeProyeccion, type IntakeLoopDeps } from '../server/intake-loop'
import { avisoContratoLogs, CORRIDAS_SIN_LOG_AVISO } from '../server/admin-cargas'
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

/**
 * EMPALME capabilities ↔ lazo ↔ aviso del control del DIRECTORIO (diseño 009·§4.2), de punta a punta
 * con fakes: `listOrAbsent` responde `absent` → `observar()` marca `landingAbsent` → el lazo lee el
 * registro de cargas para un slot SIN corridas → `classifySlot` contradice → `composeIntakeAlert`
 * redacta la evidencia → el sink fake la recibe. Es el cableado que en el frente anterior no era de
 * nadie; acá tiene dueño y este bloque es su prueba.
 */
describe('intake-loop · control del DIRECTORIO en slots land-only (009·§4.2)', () => {
  const hace = (min: number): string => new Date(T0 - min * 60_000).toISOString()

  it('land-only + directorio ausente + carga vivida ⇒ UNA alerta con la fecha de la última carga y sin causa afirmada', async () => {
    const a = await armar({ conMotor: false })
    a.registro.cargas = [
      { filename: 'vieja.csv', uploadedAt: hace(600), ok: true },
      { filename: 'ultima.csv', uploadedAt: hace(120), ok: true },
    ]
    a.landing.listing = { kind: 'absent' }
    await a.loop.tick()

    expect(a.alerts).toHaveLength(1)
    expect(a.alerts[0]!.data['reason']).toBe('contradice-registro')
    expect(a.alerts[0]!.data['landingAusente']).toBe(true)
    expect(a.alerts[0]!.data['ultimaCargaAt']).toBe(hace(120))
    const cuerpo = a.alerts[0]!.lines.join('\n')
    expect(cuerpo).toContain('el directorio del landing NO EXISTE')
    expect(cuerpo).toContain(hace(120))
    // La alerta afirma la contradicción, JAMÁS su causa (doctrina del frente).
    expect(cuerpo).not.toMatch(/permiso|borrad|path mal/i)
    // Sin corridas no hay control por-archivo: la alerta no nombra esperados (§4.1, decisión ratificada).
    expect(a.alerts[0]!.data['esperados']).toEqual([])

    // Dedup por transición: el mismo estado en el tick siguiente no vuelve a avisar.
    a.clock.ms = T0 + POLL_MS
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)
  })

  it('CONTROL NEGATIVO — slot virgen (cero cargas) con directorio ausente: cero alertas', async () => {
    const a = await armar({ conMotor: false })
    a.registro.cargas = []
    a.landing.listing = { kind: 'absent' }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(0)
  })

  it('CONTROL NEGATIVO — cargas RECHAZADAS (ok=false) no prueban escritura: directorio ausente no alerta', async () => {
    const a = await armar({ conMotor: false })
    a.registro.cargas = [{ filename: 'rechazada.csv', uploadedAt: hace(30), ok: false }]
    a.landing.listing = { kind: 'absent' }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(0)
  })

  it('CONTROL NEGATIVO QUE FIJA LA DECISIÓN DE §4.3 — land-only con listado ok y VACÍO sobre directorio existente: cero alertas, pérdida aceptada', async () => {
    // El slot land-only cuyo directorio EXISTE y responde 200 con lista vacía queda sin control, a
    // propósito (diseño 009·§4.1/§4.3): ese estado es indistinguible de «el consumidor externo drenó
    // todo» y no hay evento de consumo observable que los separe. Si este test se pone rojo es porque
    // alguien cerró esa laguna: hay que volver al diseño antes de dejar pasar la primera alerta falsa.
    const a = await armar({ conMotor: false })
    a.registro.cargas = [{ filename: 'drenada.csv', uploadedAt: hace(120), ok: true }]
    a.landing.listing = { kind: 'ok', entries: [] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(0)
  })

  it('el retiro que NO se pudo saber apaga el control por-archivo, no el del directorio', async () => {
    const a = await armar({ conMotor: false })
    a.registro.cargas = [{ filename: 'f.csv', uploadedAt: hace(30), ok: true }]
    a.registro.retiros = null
    a.landing.listing = { kind: 'absent' }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)
    expect(a.alerts[0]!.data['landingAusente']).toBe(true)
  })

  it('slot CON corridas: el directorio ausente y los esperados viajan en UNA sola alerta', async () => {
    const a = await armar()
    a.registro.cargas = [{ filename: 'f.xlsx', uploadedAt: hace(10), ok: true }]
    a.runs.records = [{ startedAt: hace(60), endedAt: hace(59), status: 'Completed' }]
    a.landing.listing = { kind: 'absent' }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)
    expect(a.alerts[0]!.data['esperados']).toEqual(['f.xlsx'])
    expect(a.alerts[0]!.data['landingAusente']).toBe(true)
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

// ─── El contrato `_logs/` medido por el lazo (#162·§5 · diseño 009·H1) ──────────────────────────

/**
 * Arnés PROPIO de la medida del contrato `_logs/`: el de arriba no cablea `runLogs`, y cablearlo ahí
 * cambiaría el terreno de los tests que ya existen.
 *
 * Lo que estos tests ponen en riesgo es el EMPALME completo —medición en el tick → columna de la
 * proyección → `SlotVigilancia` → aviso en la página—, que es exactamente el eslabón que faltaba: el
 * aviso estaba implementado y testeado, y nunca aparecía porque nadie le pasaba el dato.
 */
interface ArnesLogs {
  store: SqliteGovernanceStore
  logs: string[]
  runs: { records: RunRecord[] }
  /** `_logs/`: entradas del directorio, contador de LISTADOS (el spy del reuso) y falla inyectable. */
  runLogs: { entries: OneLakeEntry[]; listados: number; error: string | null }
  /** Falla inyectable del listado del landing: vuelve FALLIDA la observación entera del slot. */
  landing: { error: string | null }
  loop: { tick(): Promise<void> }
}

async function armarLogs(opts: { slot?: IntakeSlot; conRunLogs?: boolean; conMotor?: boolean; store?: SqliteGovernanceStore } = {}): Promise<ArnesLogs> {
  const store = opts.store ?? (await SqliteGovernanceStore.open(null, {}))
  const logs: string[] = []
  const runs = { records: [] as RunRecord[] }
  const runLogs: ArnesLogs['runLogs'] = { entries: [], listados: 0, error: null }
  const landing = { error: null as string | null }
  const slot = opts.slot ?? slotDe()
  const deps: IntakeLoopDeps = {
    slots: () => [slot],
    landing: async (): Promise<OneLakeListing> => {
      if (landing.error) throw new Error(landing.error)
      return { kind: 'ok', entries: [] }
    },
    store,
    domains: DOMINIOS,
    log: (l) => void logs.push(l),
    now: () => T0,
  }
  if (opts.conMotor !== false) deps.runs = async () => runs.records
  if (opts.conRunLogs !== false)
    deps.runLogs = {
      list: async () => {
        runLogs.listados++
        if (runLogs.error) throw new Error(runLogs.error)
        return runLogs.entries
      },
      read: async () => null,
    }
  return { store, logs, runs, runLogs, landing, loop: createIntakeLoop(deps, { publicUrl: PUBLIC_URL, pollMs: POLL_MS }) }
}

/** N corridas terminadas, la más reciente primero, ninguna con log en `_logs/`. */
const corridasFallidas = (n: number): RunRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    startedAt: new Date(T0 - (i + 1) * 30 * 60_000).toISOString(),
    endedAt: new Date(T0 - ((i + 1) * 30 - 1) * 60_000).toISOString(),
    status: 'Failed' as const,
  }))

const snapDe = async (a: ArnesLogs, slotId = 'saldos') => (await a.store.listSlotSnapshots()).find((s) => s.slotId === slotId)

describe('intake-loop · contrato `_logs/` (#162·§5): de la medición al aviso', () => {
  it('EMPALME · 3 corridas terminadas sin log ⇒ snapshot, vigilancia y AVISO en la página', async () => {
    const a = await armarLogs()
    a.runs.records = corridasFallidas(CORRIDAS_SIN_LOG_AVISO)
    await a.loop.tick()

    // 1 · la medición llegó a la proyección
    const snap = await snapDe(a)
    expect(snap?.corridasSinLog).toBe(CORRIDAS_SIN_LOG_AVISO)
    // 2 · la proyección llega a la vigilancia que consume la consola
    const v = slotVigilanciaDeProyeccion(slotDe(), snap, POLL_MS, T0)
    expect(v?.corridasSinLog).toBe(CORRIDAS_SIN_LOG_AVISO)
    // 3 · y la vigilancia produce el aviso REAL de la página (no `''`, que es lo que devolvía siempre)
    const html = avisoContratoLogs(slotDe(), v ?? undefined)
    expect(html).toContain('no cumple el contrato')
    expect(html).toContain('Files/code/_logs')
  })

  it('bajo el umbral el aviso NO aparece (el conteo se mide igual: una vez es accidente)', async () => {
    const a = await armarLogs()
    a.runs.records = corridasFallidas(CORRIDAS_SIN_LOG_AVISO - 1)
    await a.loop.tick()
    const v = slotVigilanciaDeProyeccion(slotDe(), await snapDe(a), POLL_MS, T0)
    expect(v?.corridasSinLog).toBe(CORRIDAS_SIN_LOG_AVISO - 1)
    expect(avisoContratoLogs(slotDe(), v ?? undefined)).toBe('')
  })

  it('el RESOLVER reusa el listado del tick: UN solo listado de `_logs/` por slot y vuelta', async () => {
    const a = await armarLogs()
    a.runs.records = corridasFallidas(1)
    // Con una carga pendiente el RESOLVER también necesita `_logs/`; sin caché serían dos listados.
    await a.store.recordUpload({
      slotId: 'saldos',
      filename: 'saldos.xlsx',
      sha256: 'a'.repeat(64),
      bytes: 1024,
      uploadedBy: 'ana@cliente.cl',
      uploadedAt: new Date(T0 - 60 * 60_000).toISOString(),
      ok: true,
      triggered: true,
      origen: 'upload',
    })
    await a.loop.tick()
    expect(a.runLogs.listados).toBe(1)
  })

  it('un slot con `log: false` no se acusa: el conteo queda en null y el aviso no aparece', async () => {
    const a = await armarLogs({ slot: slotDe({ log: false }) })
    a.runs.records = corridasFallidas(5)
    await a.loop.tick()
    expect(a.runLogs.listados).toBe(0) // ni se lista: el slot declaró que no escribe logs por corrida
    const snap = await snapDe(a)
    expect(snap?.corridasSinLog).toBeUndefined()
    expect(avisoContratoLogs(slotDe({ log: false }), slotVigilanciaDeProyeccion(slotDe({ log: false }), snap, POLL_MS, T0) ?? undefined)).toBe('')
  })

  it('sin corridas que medir (land-only o motor no cableado) el conteo es null', async () => {
    const { trigger: _t, ...sinTrigger } = slotDe()
    const a = await armarLogs({ slot: sinTrigger as IntakeSlot })
    await a.loop.tick()
    expect((await snapDe(a))?.corridasSinLog).toBeUndefined()

    const b = await armarLogs({ conMotor: false })
    b.runs.records = corridasFallidas(4)
    await b.loop.tick()
    expect((await snapDe(b))?.corridasSinLog).toBeUndefined()
  })

  it('`null` LIMPIA un conteo previo cuando el slot deja de aplicar (el aviso se apaga)', async () => {
    const a = await armarLogs()
    a.runs.records = corridasFallidas(4)
    await a.loop.tick()
    expect((await snapDe(a))?.corridasSinLog).toBe(4)
    // MISMO store, slot re-declarado con `log: false` (hot-reload): la acusación previa se retira.
    const b = await armarLogs({ slot: slotDe({ log: false }), store: a.store })
    await b.loop.tick()
    expect((await snapDe(b))?.corridasSinLog).toBeUndefined()
  })

  it('si el listado de `_logs/` FALLA no se pisa lo persistido: no medir no es medir cero', async () => {
    const a = await armarLogs()
    a.runs.records = corridasFallidas(4)
    await a.loop.tick()
    expect((await snapDe(a))?.corridasSinLog).toBe(4)

    a.runLogs.error = 'onelake: 403 al listar _logs/'
    await a.loop.tick()
    expect((await snapDe(a))?.corridasSinLog).toBe(4) // lo último conocido, no 0
    expect(a.logs.some((l) => l.includes('no se pudo medir el contrato _logs/'))).toBe(true)
  })

  it('una observación FALLIDA del slot no toca el conteo, y ni siquiera intenta medirlo', async () => {
    const a = await armarLogs()
    a.runs.records = corridasFallidas(3)
    await a.loop.tick()
    const listados = a.runLogs.listados

    a.landing.error = 'onelake: 403 forbidden'
    await a.loop.tick()
    const snap = await snapDe(a)
    expect(snap?.lastError).toBe('onelake: 403 forbidden')
    expect(snap?.corridasSinLog).toBe(3) // intacto: el slot no se midió en absoluto
    expect(a.runLogs.listados).toBe(listados) // no se paga un listado por un slot que no se pudo observar
  })
})

// ─── El bloque `watch:` consumido por el lazo (#161 · diseño 009·H3) ────────────────────────────

/**
 * EMPALME H2 ↔ lazo: el parse de `intake.ts` produce `slot.watch` y NADIE lo consumía. Estos tests
 * cruzan el empalme entero —de la declaración del slot a la conducta del tick y a lo que la consola
 * ve— porque el modo de falla que este frente ya pagó una vez es justamente el cableado que cumple
 * los dos contratos por separado y no se prueba en ninguna parte.
 *
 * La declaración entra por el arreglo VIVO de `slots()` (hot-reload, #50): los tests mutan el arreglo
 * entre ticks, que es exactamente lo que hace un `slots.yaml` recargado en caliente.
 */
const estadoPersistido = async (a: Arnes): Promise<Record<string, string>> =>
  JSON.parse((await a.store.getSetting(INTAKE_WATCH_STATE_KEY)) ?? '{}') as Record<string, string>

describe('intake-loop · `watch:` declarado por slot', () => {
  it('`watch: false` saca al slot del lazo COMPLETO: ni se observa, ni cuenta en el tile, ni tiene banner', async () => {
    const a = await armar({ slots: [slotDe({ watch: false })] })
    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    await a.loop.tick()

    expect(a.landing.llamadas).toBe(0) // no se observa: el listado del landing jamás se pide
    expect(await snap(a)).toBeUndefined() // no hay proyección que refrescar
    expect(a.alerts).toHaveLength(0)
    expect(summarizeIntakeWatch([slotDe({ watch: false })], await a.store.listSlotSnapshots(), POLL_MS, T0)).toEqual({
      vigilados: 0,
      enAlerta: 0,
      sinMedir: 0,
    })
    // La consola vuelve a la página pre-#161 para ese slot: sin banner de vigilancia.
    expect(slotVigilanciaDeProyeccion(slotDe({ watch: false }), undefined, POLL_MS, T0)).toBeNull()
  })

  it('`watch: false` apaga TAMBIÉN el resolver de desenlaces (#162): la misma carga se resuelve al re-optar-in', async () => {
    const slots = [slotDe({ watch: false })]
    const a = await armar({ slots })
    const subidoA = new Date(T0 - 60 * 60_000).toISOString()
    await a.store.recordUpload({
      slotId: 'saldos',
      filename: 'saldos.xlsx',
      sha256: 'b'.repeat(64),
      bytes: 1024,
      uploadedBy: 'ana@cliente.cl',
      uploadedAt: subidoA,
      ok: true,
      triggered: true,
      origen: 'upload',
    })
    // Insumo suficiente para un desenlace: corrida completada DESPUÉS de la carga y archivo ya
    // drenado del landing ⇒ `procesada` (contrato de ingesta #62/#63).
    a.runs.records = [{ startedAt: new Date(T0 - 30 * 60_000).toISOString(), status: 'Completed' }]
    a.landing.listing = { kind: 'ok', entries: [] }

    await a.loop.tick()
    expect(await a.store.listUploadsSinDesenlace('saldos', 10)).toHaveLength(1) // sigue sin desenlace

    // Control positivo del test: el MISMO insumo, sin el opt-out, sí se resuelve. Sin esta mitad, el
    // «no se resolvió» podría ser un insumo insuficiente y no el opt-out.
    slots[0] = slotDe()
    await a.loop.tick()
    expect(await a.store.listUploadsSinDesenlace('saldos', 10)).toHaveLength(0)
  })

  it('el slot land-only gana la señal de varados declarando `max_age_minutes` (y sin declararla no la tiene)', async () => {
    const { trigger: _t, ...landOnly } = slotDe()
    const sinDeclarar = await armar({ slots: [landOnly as IntakeSlot] })
    sinDeclarar.landing.listing = { kind: 'ok', entries: [archivo('viejo.xlsx', 600)] }
    await sinDeclarar.loop.tick()
    expect(sinDeclarar.alerts).toHaveLength(0) // conducta vigente: el ritmo del consumidor no se inventa

    const declarado = await armar({ slots: [{ ...landOnly, watch: { maxAgeMinutes: 240 } } as IntakeSlot] })
    declarado.landing.listing = { kind: 'ok', entries: [archivo('viejo.xlsx', 600)] }
    await declarado.loop.tick()
    expect(declarado.alerts).toHaveLength(1)
    expect(declarado.alerts[0]!.data['reason']).toBe('varados')
  })

  it('el umbral declarado SUSTITUYE al default: con `max_age_minutes: 1440` un archivo de 3 h no alerta', async () => {
    const a = await armar({ slots: [slotDe({ watch: { maxAgeMinutes: 1440 } })] })
    a.landing.listing = { kind: 'ok', entries: [archivo('lento.xlsx', 180)] } // 3 h: pasado el default de 120
    await a.loop.tick()
    expect(a.alerts).toHaveLength(0)

    // Y el umbral declarado SÍ corta donde dice: a las 25 h del aterrizaje, el mismo archivo alerta.
    a.clock.ms = T0 + 25 * 60 * 60_000
    await a.loop.tick()
    expect(a.alerts.map((n) => n.data['reason'])).toEqual(['varados'])
  })

  it('`max_run_minutes` declarado sustituye al default de corrida colgada', async () => {
    const colgada: RunRecord[] = [{ startedAt: new Date(T0 - 90 * 60_000).toISOString(), status: 'InProgress' }]

    const conDefault = await armar()
    conDefault.runs.records = colgada
    await conDefault.loop.tick()
    expect(conDefault.alerts.map((n) => n.data['reason'])).toEqual(['corrida-colgada']) // default de 60 min

    const declarado = await armar({ slots: [slotDe({ watch: { maxRunMinutes: 240 } })] })
    declarado.runs.records = colgada
    await declarado.loop.tick()
    expect(declarado.alerts).toHaveLength(0)
  })

  it('un slot SIN `watch:` conserva exactamente la conducta vigente (default de edad)', async () => {
    const a = await armar()
    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    await a.loop.tick()
    expect(a.alerts.map((n) => n.data['reason'])).toEqual(['varados'])
  })
})

describe('intake-loop · opt-out EN CALIENTE: se retira sin «recuperado» falso', () => {
  it('el slot que alerta y pasa a `watch: false` sale del estado en SILENCIO; el slot BORRADO sí se recupera', async () => {
    // El tercer slot ('testigo') se queda vigilado y en alerta a propósito: mantiene la fase ALERTAR
    // corriendo, para que el silencio de 'saldos' sea una decisión del diff y no el corte temprano
    // por «cero vigilados» (ese caso lo cubre el test siguiente).
    const slots = [slotDe(), slotDe({ id: 'otro', label: 'Otro slot' }), slotDe({ id: 'testigo', label: 'Testigo' })]
    const a = await armar({ slots })
    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(3)
    expect(await estadoPersistido(a)).toEqual({ saldos: 'varados', otro: 'varados', testigo: 'varados' })

    // Hot-reload: 'saldos' opta por salir; 'otro' DESAPARECE de la config. Los dos dejan de alertar,
    // y el lazo tiene que distinguirlos — a uno lo callaron, el otro ya no existe.
    slots[0] = slotDe({ watch: false })
    slots.splice(1, 1)
    await a.loop.tick()

    // UNA sola notificación nueva, y es la recuperación por AUSENCIA de 'otro': 'saldos' no emite nada.
    expect(a.alerts).toHaveLength(4)
    expect(a.alerts[3]!.data['event']).toBe('intake-recovery')
    expect(a.alerts[3]!.data['slotId']).toBe('otro')
    // La clave del opt-out se retiró y se persistió; la del testigo sigue, porque su alerta sigue.
    expect(await estadoPersistido(a)).toEqual({ testigo: 'varados' })
    // Y el opt-out es total: en el segundo tick solo se observó al testigo (3 llamadas en el primero).
    expect(a.landing.llamadas).toBe(4)
  })

  it('re-optar-in con el problema vigente vuelve a alertar (es una transición nueva, no un eco)', async () => {
    const slots = [slotDe()]
    const a = await armar({ slots })
    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)

    slots[0] = slotDe({ watch: false })
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1) // silencio total: ni alerta ni «recuperado»
    expect(await estadoPersistido(a)).toEqual({})

    slots[0] = slotDe()
    await a.loop.tick()
    expect(a.alerts).toHaveLength(2)
    expect(a.alerts[1]!.severity).toBe('warning')
    expect(a.alerts[1]!.data['reason']).toBe('varados')
    expect(await estadoPersistido(a)).toEqual({ saldos: 'varados' })
  })

  it('el opt-out del ÚLTIMO slot vigilado también retira su clave (no queda huérfana para un eco futuro)', async () => {
    const slots = [slotDe()]
    const a = await armar({ slots })
    a.landing.listing = { kind: 'ok', entries: [archivo('atascado.xlsx', 300)] }
    await a.loop.tick()
    expect(await estadoPersistido(a)).toEqual({ saldos: 'varados' })

    // Con cero slots vigilados el tick corta temprano: el retiro tiene que ocurrir ANTES de ese corte.
    slots[0] = slotDe({ watch: false })
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1)
    expect(await estadoPersistido(a)).toEqual({})

    // La prueba de que la clave no quedó huérfana: un slot NUEVO y sano no arrastra el eco del viejo.
    slots.push(slotDe({ id: 'nuevo', label: 'Nuevo slot' }))
    a.landing.listing = { kind: 'ok', entries: [] }
    await a.loop.tick()
    expect(a.alerts).toHaveLength(1) // ningún «recuperado» por 'saldos'
  })

  it('sin canal de aviso el opt-out no toca el estado persistido (la fase 3 está apagada entera)', async () => {
    const slots = [slotDe()]
    const a = await armar({ slots, alertas: false })
    await a.loop.tick()
    slots[0] = slotDe({ watch: false })
    await expect(a.loop.tick()).resolves.toBeUndefined()
    expect(await a.store.getSetting(INTAKE_WATCH_STATE_KEY)).toBeNull()
  })
})
