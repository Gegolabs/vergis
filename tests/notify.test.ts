import { describe, it, expect } from 'vitest'
import {
  parseNotifyConfig,
  createSinks,
  renderSlackText,
  fanout,
  composeFreshnessAlert,
  composeFreshnessRecovery,
  fmtDur,
  type FetchLike,
  type Notification,
  type NotificationSink,
} from '../server/notify'
import { classifyProcess, type ProcessHealth } from '@vergis/capabilities'

const BASE = 'https://mira.example.com'

/** Salud sintética: el compositor solo lee `lastSuccessAt` y `ageSeconds`. */
function salud(lastSuccessAt: string | null, ageSeconds: number | null): ProcessHealth {
  return { lastStatus: lastSuccessAt ? 'Completed' : 'NoRuns', lastSuccessAt, ageSeconds, failed: false, missed: true }
}

describe('notify · config declarativa (VERGIS_NOTIFY)', () => {
  it('doc vacío ⇒ sin destinos; un destino válido toma el id por defecto ⟨type⟩-⟨i+1⟩', () => {
    expect(parseNotifyConfig({})).toEqual({ destinations: [] })
    expect(parseNotifyConfig(null)).toEqual({ destinations: [] })
    expect(parseNotifyConfig({ destinations: [{ type: 'slack-webhook', url: 'https://hooks.slack.com/x' }] })).toEqual({
      destinations: [{ id: 'slack-webhook-1', type: 'slack-webhook', url: 'https://hooks.slack.com/x' }],
    })
  })

  it('forma inválida LANZA (fail-closed en el boot): type desconocido, url sin esquema, ids duplicados', () => {
    expect(() => parseNotifyConfig({ destinations: { type: 'webhook' } })).toThrow(/`destinations` debe ser una lista/)
    expect(() => parseNotifyConfig({ destinations: [{ type: 'teams', url: 'https://x' }] })).toThrow(/destino #0 con type inválido 'teams'/)
    expect(() => parseNotifyConfig({ destinations: [{ type: 'webhook' }] })).toThrow(/destino #0 sin url válida/)
    expect(() => parseNotifyConfig({ destinations: [{ type: 'webhook', url: 'ftp://x/y' }] })).toThrow(/destino #0 sin url válida/)
    expect(() =>
      parseNotifyConfig({
        destinations: [
          { id: 'ops', type: 'webhook', url: 'https://a' },
          { id: 'ops', type: 'slack-webhook', url: 'https://b' },
        ],
      }),
    ).toThrow(/id de destino duplicado 'ops'/)
  })
})

describe('notify · render y sinks', () => {
  const n: Notification = {
    severity: 'warning',
    title: 'Frescura — Cartera · Cargas diarias: la corrida falló',
    lines: ['motivo: boom', 'última corrida exitosa: hace 1 d (2026-08-05T00:00:00Z)'],
    links: [
      { label: 'Ver corrida', url: 'https://x/corrida' },
      { label: 'Frescura del dominio', url: 'https://x/frescura' },
    ],
    data: { event: 'freshness-alert' },
  }

  it('renderSlackText: icono + título en negrita + líneas + enlaces mrkdwn separados por ` · `', () => {
    expect(renderSlackText(n)).toBe(
      ':warning: *Frescura — Cartera · Cargas diarias: la corrida falló*\n' +
        'motivo: boom\n' +
        'última corrida exitosa: hace 1 d (2026-08-05T00:00:00Z)\n' +
        '<https://x/corrida|Ver corrida> · <https://x/frescura|Frescura del dominio>',
    )
    expect(renderSlackText({ ...n, severity: 'ok', links: [] })).toBe(
      ':white_check_mark: *Frescura — Cartera · Cargas diarias: la corrida falló*\nmotivo: boom\núltima corrida exitosa: hace 1 d (2026-08-05T00:00:00Z)',
    )
    expect(renderSlackText({ ...n, severity: 'info', lines: [], links: [] })).toBe(':information_source: *Frescura — Cartera · Cargas diarias: la corrida falló*')
  })

  it('slack-webhook postea { text }; webhook genérico postea el Notification tal cual (contrato de D6)', async () => {
    const capt: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = []
    const fake: FetchLike = async (url, init) => void capt.push({ url, init })
    const sinks = createSinks(
      parseNotifyConfig({
        destinations: [
          { id: 'ops-slack', type: 'slack-webhook', url: 'https://hooks.slack.com/x' },
          { id: 'puente', type: 'webhook', url: 'https://interno/hook' },
        ],
      }),
      fake,
    )
    for (const s of sinks) await s.send(n)
    expect(sinks.map((s) => s.id)).toEqual(['ops-slack', 'puente'])
    expect(capt[0]!.url).toBe('https://hooks.slack.com/x')
    expect(capt[0]!.init.method).toBe('POST')
    expect(capt[0]!.init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(capt[0]!.init.body)).toEqual({ text: renderSlackText(n) })
    expect(capt[1]!.url).toBe('https://interno/hook')
    expect(JSON.parse(capt[1]!.init.body)).toEqual({ severity: n.severity, title: n.title, lines: n.lines, links: n.links, data: n.data })
  })

  it('fanout aísla: un sink que lanza queda en el log y el siguiente recibe igual; nunca propaga', async () => {
    const vistos: string[] = []
    const logs: string[] = []
    const sinks: NotificationSink[] = [
      { id: 'caido', send: async () => { throw new Error('ECONNREFUSED') } },
      { id: 'vivo', send: async (m) => void vistos.push(m.title) },
    ]
    await expect(fanout(sinks, n, (l) => void logs.push(l))).resolves.toBeUndefined()
    expect(vistos).toEqual([n.title])
    expect(logs).toEqual(['notify[caido]: ECONNREFUSED'])
  })
})

describe('notify · composición de avisos de frescura', () => {
  it('failed con dominio: título con labels, motivo, edad, hora esperada y AMBOS enlaces (query URL-encodeada)', () => {
    const n = composeFreshnessAlert({
      processId: 'proc/cartera',
      processLabel: 'Cargas diarias',
      domainId: 'cartera',
      domainLabel: 'Cartera / Finanzas',
      reason: 'failed',
      lastError: 'boom en el motor',
      health: salud('2026-08-05T00:00:00Z', 129_600),
      requiredCadenceSeconds: 86_400,
      lastRunStartedAt: '2026-08-06T09:30:00Z',
      baseUrl: BASE,
    })
    expect(n.severity).toBe('warning')
    expect(n.title).toBe('Frescura — Cartera / Finanzas · Cargas diarias: la corrida falló')
    expect(n.lines).toEqual([
      'motivo: boom en el motor',
      'última corrida exitosa: hace 36 h (2026-08-05T00:00:00Z)',
      'se esperaba una corrida antes de: 2026-08-06T00:00:00.000Z (cadencia requerida 24 h)',
    ])
    expect(n.links).toEqual([
      { label: 'Ver corrida', url: `${BASE}/admin/dominio/cartera/corrida?proc=proc%2Fcartera&started=2026-08-06T09%3A30%3A00Z` },
      { label: 'Frescura del dominio', url: `${BASE}/admin/dominio/cartera/frescura` },
    ])
    expect(n.data).toEqual({
      event: 'freshness-alert',
      processId: 'proc/cartera',
      reason: 'failed',
      ageSeconds: 129_600,
      lastError: 'boom en el motor',
      expectedAt: '2026-08-06T00:00:00.000Z',
      domainId: 'cartera',
    })
  })

  it('missed que nunca corrió: sin línea de esperada, con cadencia requerida y SOLO el enlace de Frescura', () => {
    const n = composeFreshnessAlert({
      processId: 'p1',
      processLabel: 'Cargas diarias',
      domainId: 'cartera',
      domainLabel: 'Cartera',
      reason: 'missed',
      health: salud(null, null),
      requiredCadenceSeconds: 3_600,
      lastRunStartedAt: '2026-08-06T09:30:00Z',
      baseUrl: BASE,
    })
    expect(n.title).toBe('Frescura — Cartera · Cargas diarias: atrasada (no corre a tiempo)')
    expect(n.lines).toEqual(['nunca ha registrado una corrida exitosa', 'cadencia requerida: 60 min'])
    expect(n.links).toEqual([{ label: 'Frescura del dominio', url: `${BASE}/admin/dominio/cartera/frescura` }])
    expect(n.data['expectedAt']).toBeNull()
  })

  it('cadencia no finita (proceso fuera del mapa): ninguna línea de cadencia ni de hora esperada', () => {
    const n = composeFreshnessAlert({
      processId: 'p1',
      processLabel: 'Suelto',
      domainId: 'cartera',
      domainLabel: 'Cartera',
      reason: 'failed',
      health: salud('2026-08-05T00:00:00Z', 3_600),
      requiredCadenceSeconds: Number.POSITIVE_INFINITY,
      baseUrl: BASE,
    })
    expect(n.lines).toEqual(['última corrida exitosa: hace 60 min (2026-08-05T00:00:00Z)'])
    expect(n.data['expectedAt']).toBeNull()
  })

  it('sin dominio enlazable: título con (sin dominio), cero enlaces y la línea que dice por qué', () => {
    const n = composeFreshnessAlert({
      processId: 'p1',
      processLabel: 'Cargas diarias',
      reason: 'failed',
      lastError: 'boom',
      health: salud('2026-08-05T00:00:00Z', 3_600),
      requiredCadenceSeconds: 3_600,
      lastRunStartedAt: '2026-08-06T09:30:00Z',
      baseUrl: BASE,
    })
    expect(n.title).toBe('Frescura — (sin dominio) · Cargas diarias: la corrida falló')
    expect(n.links).toEqual([])
    expect(n.lines.at(-1)).toBe('enlaces no disponibles: el proceso no pertenece a un dominio declarado')
    expect(n.data['domainId']).toBeNull()
  })

  it('recuperación: severity ok, título «: recuperado» y el enlace de Frescura', () => {
    const n = composeFreshnessRecovery({ processId: 'p1', processLabel: 'Cargas diarias', domainId: 'cartera', domainLabel: 'Cartera', baseUrl: BASE })
    expect(n.severity).toBe('ok')
    expect(n.title).toBe('Frescura — Cartera · Cargas diarias: recuperado')
    expect(n.lines).toEqual([])
    expect(n.links).toEqual([{ label: 'Frescura del dominio', url: `${BASE}/admin/dominio/cartera/frescura` }])
    expect(n.data).toEqual({ event: 'freshness-recovery', processId: 'p1', domainId: 'cartera' })

    const sinDom = composeFreshnessRecovery({ processId: 'p1', processLabel: 'Cargas diarias', baseUrl: BASE })
    expect(sinDom.title).toBe('Frescura — (sin dominio) · Cargas diarias: recuperado')
    expect(sinDom.links).toEqual([])
    expect(sinDom.lines).toEqual(['enlaces no disponibles: el proceso no pertenece a un dominio declarado'])
  })

  it('la edad del aviso es la de classifyProcess: el compositor no re-computa nada', () => {
    const now = Date.parse('2026-08-06T12:00:00.000Z')
    const health = classifyProcess([{ startedAt: '2026-08-06T11:00:00Z', endedAt: '2026-08-06T11:02:00Z', status: 'Completed' }], 3_600, now)
    const n = composeFreshnessAlert({ processId: 'p1', processLabel: 'P', reason: 'missed', health, requiredCadenceSeconds: 3_600, baseUrl: BASE })
    expect(n.lines[0]).toBe('última corrida exitosa: hace 58 min (2026-08-06T11:02:00Z)')
    expect(n.lines[1]).toBe('se esperaba una corrida antes de: 2026-08-06T12:02:00.000Z (cadencia requerida 60 min)')
  })
})

describe('notify · fmtDur', () => {
  it('los cortes son estrictos: 90 s se lee «90 s» y 5400 s «90 min»', () => {
    expect(fmtDur(90)).toBe('90 s')
    expect(fmtDur(5_400)).toBe('90 min')
    expect(fmtDur(93_600)).toBe('26 h')
    expect(fmtDur(259_200)).toBe('3 d')
  })
})
