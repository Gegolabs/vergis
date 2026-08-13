import { describe, it, expect } from 'vitest'
import { SqliteGovernanceStore, runLogFileName, type IntakeSlot, type OneLakeEntry, type OneLakeListing, type RunRecord } from '@vergis/capabilities'
import { createIntakeLoop, resolveDesenlaceDeCarga, type CorridaConLog, type IntakeLoopDeps } from '../server/intake-loop'
import { composeCargaUserNotice } from '../server/notify'
import type { Notification } from '../server/notify'

/**
 * Arnés del RESOLVER (#162·H5): la fase que convierte lo observado en el DESENLACE de cada carga y
 * en el aviso a quien la subió.
 *
 * Todo lo externo es fake e inyectado —landing, corridas, `_logs/`— y el store es el real (SQLite en
 * memoria): la columna del desenlace y su regla de «se escribe una vez» son la mitad de lo que estos
 * tests ponen en riesgo. El reloj también es inyectado: la edad de un varado es una resta.
 */
const T0 = Date.parse('2026-08-13T12:00:00.000Z')
const PUBLIC_URL = 'https://mira.example.com'
const DOMINIOS = [{ id: 'cartera', label: 'Cartera / Finanzas' }]
const POLL_MS = 600_000
const UPLOADER = 'ana.perez@cliente.cl'

const slotDe = (over: Partial<IntakeSlot> = {}): IntakeSlot => ({
  id: 'saldos',
  label: 'Saldos de cartera',
  domain: 'cartera',
  target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' },
  trigger: { processRef: 'pipe_saldos' },
  ...over,
})

const archivo = (name: string, minutosDeEdad: number): OneLakeEntry => ({
  path: `Files/intake/saldos/${name}`,
  isDirectory: false,
  size: 1024,
  lastModified: new Date(T0 - minutosDeEdad * 60_000).toISOString(),
})

/** Una entrada de `_logs/` con el nombre canónico del contrato (#99) para la corrida dada. */
const logDe = (startedAt: string): OneLakeEntry => ({
  path: `Files/code/_logs/${runLogFileName(startedAt)}`,
  isDirectory: false,
  size: 2048,
  lastModified: startedAt,
})

interface Arnes {
  store: SqliteGovernanceStore
  alerts: Notification[]
  avisos: Notification[]
  logs: string[]
  clock: { ms: number }
  landing: { entries: OneLakeEntry[]; error: string | null }
  runs: { records: RunRecord[] }
  /** `_logs/`: entradas del directorio y el texto de cada una. `error` hace fallar el listado. */
  runLogs: { entries: OneLakeEntry[]; textos: Record<string, string>; error: string | null; lecturas: number }
  loop: { tick(): Promise<void> }
}

async function armar(opts: { slots?: IntakeSlot[]; conRunLogs?: boolean; conAviso?: boolean } = {}): Promise<Arnes> {
  const store = await SqliteGovernanceStore.open(null, {})
  const alerts: Notification[] = []
  const avisos: Notification[] = []
  const logs: string[] = []
  const clock = { ms: T0 }
  const landing = { entries: [] as OneLakeEntry[], error: null as string | null }
  const runs = { records: [] as RunRecord[] }
  const runLogs: Arnes['runLogs'] = { entries: [], textos: {}, error: null, lecturas: 0 }
  const slots = opts.slots ?? [slotDe()]

  const deps: IntakeLoopDeps = {
    slots: () => slots,
    landing: async (): Promise<OneLakeListing> => {
      if (landing.error) throw new Error(landing.error)
      return { kind: 'ok', entries: landing.entries }
    },
    runs: async () => runs.records,
    store,
    domains: DOMINIOS,
    log: (l) => void logs.push(l),
    now: () => clock.ms,
    notify: async (n) => void alerts.push(n),
  }
  if (opts.conRunLogs !== false)
    deps.runLogs = {
      list: async () => {
        if (runLogs.error) throw new Error(runLogs.error)
        return runLogs.entries
      },
      read: async (_s, path) => {
        runLogs.lecturas++
        return runLogs.textos[path] ?? null
      },
    }
  if (opts.conAviso !== false) deps.notifyUploader = async (n) => void avisos.push(n)

  return { store, alerts, avisos, logs, clock, landing, runs, runLogs, loop: createIntakeLoop(deps, { publicUrl: PUBLIC_URL, pollMs: POLL_MS }) }
}

/** Registra una carga vivida y aceptada (las únicas que el resolver mira, decisión de H3). */
async function subir(a: Arnes, filename: string, minutosAtras: number, over: { by?: string; ok?: boolean; origen?: 'upload' | 'retro' } = {}): Promise<number> {
  return a.store.recordUpload({
    slotId: 'saldos',
    filename,
    sha256: filename.padEnd(64, '0').slice(0, 64),
    bytes: 1024,
    uploadedBy: over.by ?? UPLOADER,
    uploadedAt: new Date(T0 - minutosAtras * 60_000).toISOString(),
    ok: over.ok ?? true,
    triggered: true,
    origen: over.origen ?? 'upload',
  })
}

const filaDe = async (a: Arnes, id: number) => (await a.store.listUploads('saldos', 50)).find((r) => r.id === id)

describe('intake-resolver · criterio 1 · el caso real que originó #162', () => {
  /**
   * El incidente: el archivo aterrizó, el job lo rechazó por su forma y el usuario nunca supo por
   * qué. Con el contrato `_logs/` cumplido, el motivo del job llega TEXTUAL a quien subió.
   */
  it('un `[intake] ✖ fallido: … — ancho inesperado…` produce desenlace fallida con ESE motivo, y el email lo lleva sin jerga', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 30)
    const started = new Date(T0 - 25 * 60_000).toISOString()
    a.runs.records = [{ startedAt: started, status: 'Failed', endedAt: new Date(T0 - 24 * 60_000).toISOString(), error: 'state=[dead]: el notebook no arrancó' }]
    a.runLogs.entries = [logDe(started)]
    a.runLogs.textos[logDe(started).path] =
      '[intake] leyendo Files/intake/saldos/saldos.xlsx\n' +
      '[intake] ✖ fallido: saldos.xlsx — ancho inesperado: 28 columnas (se esperaban 48)\n' +
      '[job] ✖ ABORTADO: 1 archivo con error\n'

    await a.loop.tick()

    const fila = await filaDe(a, id)
    expect(fila?.desenlace).toBe('fallida')
    expect(fila?.desenlaceMotivo).toBe('ancho inesperado: 28 columnas (se esperaban 48)')
    expect(fila?.desenlaceRunStartedAt).toBe(started)

    expect(a.avisos).toHaveLength(1)
    const n = a.avisos[0]!
    const texto = [n.title, ...n.lines].join('\n')
    expect(n.title).toBe('Tu archivo «saldos.xlsx» no pudo procesarse')
    expect(texto).toContain('Motivo: ancho inesperado: 28 columnas (se esperaban 48)')
    // Lo que el usuario NO debe recibir: el estado del motor, y ninguna ruta de almacenamiento.
    expect(texto).not.toContain('state=[dead]')
    expect(texto).not.toContain('Files/')
    expect(texto).not.toContain('_logs')
    expect(n.data['uploadedBy']).toBe(UPLOADER)
    expect(n.links).toEqual([{ label: 'Ver mis cargas', url: `${PUBLIC_URL}/admin/dominio/cartera/cargas` }])
  })
})

describe('intake-resolver · criterio 2 · la distinción honesta (control)', () => {
  /**
   * EL control del frente: la corrida falló y NO dejó log. La plataforma tiene a mano el motivo del
   * MOTOR (`run.error`) y podría rellenar con él — y el mensaje quedaría «más completo». No lo hace:
   * si el job no declaró la causa, decirla es inventarla. El test falla si el motivo aparece.
   */
  it("corrida Failed con resolveRunLog='sin-log' ⇒ sin-informe, y el motivo NO sale de run.error", async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 30)
    const started = new Date(T0 - 25 * 60_000).toISOString()
    a.runs.records = [{ startedAt: started, status: 'Failed', endedAt: new Date(T0 - 24 * 60_000).toISOString(), error: 'state=[dead]: el notebook no arrancó' }]
    a.runLogs.entries = [] // el job murió sin escribir: `_logs/` vacío ⇒ 'sin-log'

    await a.loop.tick()

    const fila = await filaDe(a, id)
    expect(fila?.desenlace).toBe('sin-informe')
    // La columna del motivo queda NULA: no hay motivo, y la ausencia se preserva.
    expect(fila?.desenlaceMotivo).toBeUndefined()

    expect(a.avisos).toHaveLength(1)
    const texto = [a.avisos[0]!.title, ...a.avisos[0]!.lines].join('\n')
    expect(a.avisos[0]!.title).toBe('Tu archivo «saldos.xlsx» no se procesó y el proceso no reportó la causa')
    expect(texto).toContain('La conversión terminó sin informar qué pasó con tu archivo')
    expect(texto).not.toContain('state=[dead]')
    expect(texto).not.toContain('dead')
    expect(a.avisos[0]!.data['motivo']).toBeNull()
  })

  it('el log que existe pero no nombra el archivo degrada a fallida SIN motivo por archivo, con el titular rotulado', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 30)
    const started = new Date(T0 - 25 * 60_000).toISOString()
    a.runs.records = [{ startedAt: started, status: 'Failed', endedAt: new Date(T0 - 24 * 60_000).toISOString(), error: 'state=[dead]' }]
    a.runLogs.entries = [logDe(started)]
    a.runLogs.textos[logDe(started).path] = '[job] arrancando\n[job] ✖ ABORTADO: no se pudo abrir el lakehouse\n'

    await a.loop.tick()

    const fila = await filaDe(a, id)
    expect(fila?.desenlace).toBe('fallida')
    // El titular es de la CORRIDA, no del archivo: no se persiste como motivo de la carga.
    expect(fila?.desenlaceMotivo).toBeUndefined()
    const texto = a.avisos[0]!.lines.join('\n')
    expect(texto).toContain('La conversión falló y no declaró un motivo para este archivo en particular.')
    expect(texto).toContain('Lo que informó la conversión: ✖ ABORTADO: no se pudo abrir el lakehouse')
    expect(texto).not.toContain('state=[dead]')
  })

  it('sin poder MIRAR el log (dependencia ausente) no se concluye sin-informe: la carga queda pendiente', async () => {
    const a = await armar({ conRunLogs: false })
    const id = await subir(a, 'saldos.xlsx', 30)
    a.runs.records = [{ startedAt: new Date(T0 - 25 * 60_000).toISOString(), status: 'Failed', error: 'state=[dead]' }]

    await a.loop.tick()

    expect((await filaDe(a, id))?.desenlace).toBeUndefined()
    expect(a.avisos).toHaveLength(0)
  })

  it('el listado de `_logs/` que LANZA deja el slot sin resolver y no mata el tick', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 30)
    a.runs.records = [{ startedAt: new Date(T0 - 25 * 60_000).toISOString(), status: 'Failed' }]
    a.runLogs.error = 'onelake: 403 forbidden'

    await expect(a.loop.tick()).resolves.toBeUndefined()
    expect((await filaDe(a, id))?.desenlace).toBeUndefined()
    expect(a.logs.some((l) => l.includes('no se pudo resolver el desenlace') && l.includes('403'))).toBe(true)
  })
})

describe('intake-resolver · criterio 3 · procesada sin gramática, y sin correo', () => {
  it('carga que una corrida Completed archivó (ya no está en el landing) ⇒ procesada, sin email', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 30)
    a.runs.records = [{ startedAt: new Date(T0 - 25 * 60_000).toISOString(), status: 'Completed', endedAt: new Date(T0 - 24 * 60_000).toISOString() }]
    a.landing.entries = [] // drenó: el contrato de ingesta archiva lo procesado en `_processed/`

    await a.loop.tick()

    expect((await filaDe(a, id))?.desenlace).toBe('procesada')
    expect(a.avisos).toHaveLength(0)
  })

  it('`✔ procesado` declarado por el job también resuelve procesada y tampoco avisa', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 30)
    const started = new Date(T0 - 25 * 60_000).toISOString()
    a.runs.records = [{ startedAt: started, status: 'Completed', endedAt: new Date(T0 - 24 * 60_000).toISOString() }]
    a.runLogs.entries = [logDe(started)]
    a.runLogs.textos[logDe(started).path] = '[intake] ✔ procesado: saldos.xlsx\n'
    a.landing.entries = [archivo('saldos.xlsx', 30)] // aún sin archivar: el JOB ya declaró que lo procesó

    await a.loop.tick()

    expect((await filaDe(a, id))?.desenlace).toBe('procesada')
    expect(a.avisos).toHaveLength(0)
  })
})

describe('intake-resolver · criterio 4 · un desenlace se resuelve UNA vez', () => {
  it('el tick siguiente no re-notifica ni re-escribe (dedup natural por la columna)', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 30)
    const started = new Date(T0 - 25 * 60_000).toISOString()
    a.runs.records = [{ startedAt: started, status: 'Failed', endedAt: new Date(T0 - 24 * 60_000).toISOString() }]
    a.runLogs.entries = [logDe(started)]
    a.runLogs.textos[logDe(started).path] = '[intake] ✖ fallido: saldos.xlsx — faltan las columnas de fecha\n'

    await a.loop.tick()
    expect(a.avisos).toHaveLength(1)
    const lecturasPrimerTick = a.runLogs.lecturas

    a.clock.ms = T0 + POLL_MS
    await a.loop.tick()
    expect(a.avisos).toHaveLength(1)
    expect((await filaDe(a, id))?.desenlaceMotivo).toBe('faltan las columnas de fecha')
    // Y no vuelve a abrir el log: sin cargas pendientes el resolver no paga I/O.
    expect(a.runLogs.lecturas).toBe(lecturasPrimerTick)
  })

  it('una carga rechazada (ok=0) y una fila retro jamás se resuelven ni avisan', async () => {
    const a = await armar()
    const rechazada = await subir(a, 'malo.xlsx', 30, { ok: false })
    const retro = await subir(a, 'viejo.xlsx', 30, { origen: 'retro' })
    a.runs.records = [{ startedAt: new Date(T0 - 25 * 60_000).toISOString(), status: 'Failed', endedAt: new Date(T0 - 24 * 60_000).toISOString() }]

    await a.loop.tick()

    expect((await filaDe(a, rechazada))?.desenlace).toBeUndefined()
    expect((await filaDe(a, retro))?.desenlace).toBeUndefined()
    expect(a.avisos).toHaveLength(0)
  })
})

describe('intake-resolver · varada y correlación', () => {
  it('archivo que excede la edad máxima sin corrida que lo tome ⇒ varada, con su edad en el aviso', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 300)
    a.landing.entries = [archivo('saldos.xlsx', 300)]

    await a.loop.tick()

    expect((await filaDe(a, id))?.desenlace).toBe('varada')
    expect(a.avisos[0]!.title).toBe('Tu archivo «saldos.xlsx» sigue sin procesarse')
    expect(a.avisos[0]!.lines.some((l) => l.includes('Lo recibimos hace 5 h'))).toBe(true)
  })

  it('una corrida ANTERIOR a la carga no la cubre: no pudo verla, así que no le atribuye su falla', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 10)
    const started = new Date(T0 - 60 * 60_000).toISOString() // arrancó 50 min ANTES de la carga
    a.runs.records = [{ startedAt: started, status: 'Failed', endedAt: new Date(T0 - 59 * 60_000).toISOString() }]
    a.landing.entries = [archivo('saldos.xlsx', 10)]

    await a.loop.tick()

    expect((await filaDe(a, id))?.desenlace).toBeUndefined()
  })

  it('una corrida EN CURSO detiene la resolución: su resultado todavía puede decidir el desenlace', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 300)
    a.runs.records = [{ startedAt: new Date(T0 - 5 * 60_000).toISOString(), status: 'InProgress' }]
    a.landing.entries = [archivo('saldos.xlsx', 300)]

    await a.loop.tick()

    expect((await filaDe(a, id))?.desenlace).toBeUndefined()
  })

  it('gana la ÚLTIMA evidencia: una corrida posterior que lo procesa desplaza a la que falló', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 60)
    const falla = new Date(T0 - 50 * 60_000).toISOString()
    const buena = new Date(T0 - 20 * 60_000).toISOString()
    a.runs.records = [
      { startedAt: buena, status: 'Completed', endedAt: new Date(T0 - 19 * 60_000).toISOString() },
      { startedAt: falla, status: 'Failed', endedAt: new Date(T0 - 49 * 60_000).toISOString() },
    ]
    a.runLogs.entries = [logDe(falla), logDe(buena)]
    a.runLogs.textos[logDe(falla).path] = '[intake] ✖ fallido: saldos.xlsx — archivo bloqueado\n'
    a.runLogs.textos[logDe(buena).path] = '[intake] ✔ procesado: saldos.xlsx\n'

    await a.loop.tick()

    expect((await filaDe(a, id))?.desenlace).toBe('procesada')
    expect(a.avisos).toHaveLength(0)
  })

  it('`⚠ saltado` se persiste con su motivo y NO genera correo (anti-ruido del diseño §6.2)', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 30)
    const started = new Date(T0 - 25 * 60_000).toISOString()
    a.runs.records = [{ startedAt: started, status: 'Completed', endedAt: new Date(T0 - 24 * 60_000).toISOString() }]
    a.runLogs.entries = [logDe(started)]
    a.runLogs.textos[logDe(started).path] = '[intake] ⚠ saltado: saldos.xlsx — ya se había cargado el mismo corte\n'

    await a.loop.tick()

    const fila = await filaDe(a, id)
    expect(fila?.desenlace).toBe('saltada')
    expect(fila?.desenlaceMotivo).toBe('ya se había cargado el mismo corte')
    expect(a.avisos).toHaveLength(0)
  })
})

describe('intake-resolver · el aviso no sale si no hay a quién', () => {
  it('uploadedBy sin `@` ⇒ no se envía, se loguea, y el desenlace queda persistido igual', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 300, { by: '(retro: _processed)' })
    a.landing.entries = [archivo('saldos.xlsx', 300)]

    await a.loop.tick()

    expect((await filaDe(a, id))?.desenlace).toBe('varada')
    expect(a.avisos).toHaveLength(0)
    expect(a.logs.some((l) => l.includes('sin aviso') && l.includes('no es una dirección'))).toBe(true)
  })

  it('con la observación CAÍDA no se resuelve nada: un desenlace no se escribe sobre lo último conocido', async () => {
    const a = await armar()
    const id = await subir(a, 'saldos.xlsx', 300)
    a.landing.entries = [archivo('saldos.xlsx', 300)]
    await a.loop.tick()
    expect((await filaDe(a, id))?.desenlace).toBe('varada')

    // Segunda carga con el almacenamiento CAÍDO y una corrida completada que la cubre: si la lectura
    // fallida se tratara como «landing vacío», el archivo se vería como archivado y esta carga se
    // resolvería `procesada` — un desenlace inventado a partir de no ver.
    //
    // [Este test fija el COMPORTAMIENTO, no aísla el guard: la observación es atómica (una lectura
    // fallida no trae landing NI corridas), así que quitar el `obs.error != null` del resolver deja
    // el resultado idéntico — medido por mutación, mutante equivalente. El guard se conserva como
    // afirmación explícita de la regla, no como la única cosa que la sostiene.]
    const id2 = await subir(a, 'otro.xlsx', 300)
    a.landing.error = 'onelake: 500'
    a.runs.records = [{ startedAt: new Date(T0 - 200 * 60_000).toISOString(), status: 'Completed', endedAt: new Date(T0 - 199 * 60_000).toISOString() }]
    a.clock.ms = T0 + POLL_MS
    await a.loop.tick()
    expect((await filaDe(a, id2))?.desenlace).toBeUndefined()
  })

  it('sin destinos suscritos al flujo el desenlace se resuelve y se persiste igual', async () => {
    const a = await armar({ conAviso: false })
    const id = await subir(a, 'saldos.xlsx', 300)
    a.landing.entries = [archivo('saldos.xlsx', 300)]

    await a.loop.tick()

    expect((await filaDe(a, id))?.desenlace).toBe('varada')
  })
})

describe('resolveDesenlaceDeCarga · la lógica pura', () => {
  const carga = { filename: 'saldos.xlsx', uploadedAt: new Date(T0 - 30 * 60_000).toISOString() }
  const corrida = (status: RunRecord['status'], log: CorridaConLog['log'], texto: string | null = null): CorridaConLog => ({
    run: { startedAt: new Date(T0 - 25 * 60_000).toISOString(), status, endedAt: new Date(T0 - 24 * 60_000).toISOString(), error: 'state=[dead]' },
    log,
    texto,
  })

  it('sin corridas y sin umbral de edad no concluye nada (el land-only no fabrica varados)', () => {
    expect(resolveDesenlaceDeCarga(carga, [], [archivo('saldos.xlsx', 300)], T0)).toBeNull()
  })

  it('el motivo del MOTOR nunca entra en la resolución', () => {
    const r = resolveDesenlaceDeCarga(carga, [corrida('Failed', 'sin-log')], [], T0, 120)
    expect(r).toEqual({ desenlace: 'sin-informe', runStartedAt: new Date(T0 - 25 * 60_000).toISOString() })
    expect(JSON.stringify(r)).not.toContain('dead')
  })

  it('el log purgado por retención también es sin-informe: el motivo ya no existe', () => {
    expect(resolveDesenlaceDeCarga(carga, [corrida('Failed', 'purgado')], [], T0, 120)?.desenlace).toBe('sin-informe')
  })

  it('el archivo del landing se reconoce por BASENAME (el registro guarda el nombre; el listado, la ruta)', () => {
    // Mismo archivo, con la ruta completa del Lakehouse: si se comparara la cadena entera, esta carga
    // se vería como «ya no está» y se resolvería `procesada` por una corrida que no la tocó.
    const conRuta = [archivo('saldos.xlsx', 300)]
    expect(resolveDesenlaceDeCarga(carga, [corrida('Completed', 'no-medido')], conRuta, T0, 120)?.desenlace).toBe('varada')
    expect(resolveDesenlaceDeCarga(carga, [corrida('Completed', 'no-medido')], [], T0, 120)?.desenlace).toBe('procesada')
  })
})

describe('composeCargaUserNotice · lo que lee una persona', () => {
  const base = {
    filename: 'saldos.xlsx',
    uploadedBy: UPLOADER,
    uploadedAt: new Date(T0 - 30 * 60_000).toISOString(),
    slotId: 'saldos',
    slotLabel: 'Saldos de cartera',
    domainId: 'cartera',
    domainLabel: 'Cartera / Finanzas',
    baseUrl: PUBLIC_URL,
  }

  it('el motivo del job pasa por redactSecrets antes de salir por correo', () => {
    const n = composeCargaUserNotice({ ...base, desenlace: 'fallida', motivo: 'no se pudo abrir: password=hunter2 en la cadena' })
    expect(n.lines[0]).toBe('Motivo: no se pudo abrir: password=«…redactado…» en la cadena')
  })

  it('la fecha se muestra legible y el slot acompaña, en todos los desenlaces', () => {
    for (const desenlace of ['fallida', 'saltada', 'sin-informe', 'varada'] as const) {
      const n = composeCargaUserNotice({ ...base, desenlace })
      expect(n.lines.at(-1)).toBe('Archivo recibido el 2026-08-13 11:30 UTC · Saldos de cartera')
      expect(n.severity).toBe('warning')
    }
  })

  it('un slot sin dominio declarado avisa igual, sin enlace (no se enlaza una página inexistente)', () => {
    const { domainId: _omitido, ...sinDominio } = base
    const n = composeCargaUserNotice({ ...sinDominio, desenlace: 'varada', ageMinutes: 300 })
    expect(n.links).toEqual([])
  })
})
