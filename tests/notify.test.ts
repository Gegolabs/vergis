import { describe, it, expect } from 'vitest'
import {
  parseNotifyConfig,
  createSinks,
  renderSlackText,
  fanout,
  forEvent,
  renderEmailSubject,
  renderEmailText,
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
  it('clave raíz ausente LANZA (#117: archivo declarado sin `destinations` = roto); `destinations: []` es el cero legítimo', () => {
    expect(() => parseNotifyConfig({})).toThrow(/falta la clave raíz 'destinations'/)
    expect(() => parseNotifyConfig(null)).toThrow(/falta la clave raíz 'destinations'/)
    expect(() => parseNotifyConfig({ destinations: null })).toThrow(/`destinations` debe ser una lista/)
    expect(parseNotifyConfig({ destinations: [] })).toEqual({ destinations: [] })
  })

  it('un destino válido toma el id por defecto ⟨type⟩-⟨i+1⟩', () => {
    expect(parseNotifyConfig({ destinations: [{ type: 'slack-webhook', url: 'https://hooks.slack.com/x' }] })).toEqual({
      // `events` ausente ⇒ ['alerts'] (issue #102): la suscripción por defecto es EXACTA la
      // semántica de #100 — un destino jamás recibe el digest sin haberlo pedido.
      destinations: [{ id: 'slack-webhook-1', type: 'slack-webhook', url: 'https://hooks.slack.com/x', events: ['alerts'] }],
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

// ── Deltas del issue #102: routing por flujo, destino email y bloque report ──────────────────────

describe('notify · routing por flujo (events) y bloque report', () => {
  const slack = { id: 'ops-slack', type: 'slack-webhook', url: 'https://hooks.slack.com/x' }

  it('`events` ausente ⇒ [alerts]; lista vacía o valor desconocido LANZAN', () => {
    expect(parseNotifyConfig({ destinations: [slack] }).destinations[0]!.events).toEqual(['alerts'])
    expect(() => parseNotifyConfig({ destinations: [{ ...slack, events: [] }] })).toThrow(/destino #0 con events inválido/)
    expect(() => parseNotifyConfig({ destinations: [{ ...slack, events: ['digest'] }] })).toThrow(/destino #0 con events inválido 'digest'/)
    expect(() => parseNotifyConfig({ destinations: [{ ...slack, events: 'reports' }] })).toThrow(/destino #0 con events inválido/)
  })

  it('forEvent filtra los destinos por flujo y CONSERVA el bloque report', () => {
    const cfg = parseNotifyConfig({
      destinations: [
        { ...slack, events: ['alerts', 'reports'] },
        { id: 'puente', type: 'webhook', url: 'https://interno/hook' },
      ],
      report: { at: '07:30', timezone: 'America/Santiago' },
    })
    expect(forEvent(cfg, 'alerts').destinations.map((d) => d.id)).toEqual(['ops-slack', 'puente'])
    expect(forEvent(cfg, 'reports').destinations.map((d) => d.id)).toEqual(['ops-slack'])
    expect(forEvent(cfg, 'reports').report).toEqual({ at: '07:30', every: 'daily', timezone: 'America/Santiago' })
  })

  it('el bloque report toma sus defaults y valida hora, cadencia, weekday y timezone', () => {
    const cfg = parseNotifyConfig({ destinations: [{ ...slack, events: ['reports'] }], report: {} })
    expect(cfg.report).toEqual({ at: '07:00', every: 'daily' })
    expect(parseNotifyConfig({ destinations: [{ ...slack, events: ['reports'] }], report: { every: 'weekly' } }).report).toEqual({
      at: '07:00',
      every: 'weekly',
      weekday: 'monday',
    })
    const conReport = (report: unknown): unknown => parseNotifyConfig({ destinations: [{ ...slack, events: ['reports'] }], report })
    expect(() => conReport({ at: '25:00' })).toThrow(/report\.at inválido '25:00'/)
    expect(() => conReport({ at: '7:00' })).toThrow(/report\.at inválido/)
    expect(() => conReport({ every: 'hourly' })).toThrow(/report\.every inválido 'hourly'/)
    expect(() => conReport({ weekday: 'monday' })).toThrow(/report\.weekday solo aplica a weekly/)
    expect(() => conReport({ timezone: 'America/Nowhere' })).toThrow(/report\.timezone inválida 'America\/Nowhere'/)
  })

  it('config contradictoria LANZA en el boot: report sin receptor, y receptor sin report', () => {
    expect(() => parseNotifyConfig({ destinations: [slack], report: { at: '07:30' } })).toThrow(/ningún destino se suscribe a 'reports'/)
    expect(() => parseNotifyConfig({ destinations: [{ ...slack, events: ['reports'] }] })).toThrow(/el destino 'ops-slack' se suscribe a 'reports' pero no hay bloque report/)
  })
})

describe('notify · destino email-smtp', () => {
  const emailOk = {
    type: 'email-smtp',
    events: ['reports'],
    smtp: { host: 'smtp.relay.cl', port: 587, user: 'u1', passEnv: 'VERGIS_TEST_SMTP_PASS' },
    from: 'Vergis <v@x.cl>',
    to: ['ops@x.cl'],
  }
  const conEmail = (email: Record<string, unknown>): unknown => parseNotifyConfig({ destinations: [email], report: { at: '07:30' } })

  it('parsea con sus defaults (tls starttls, authMethod plain, id email-smtp-1)', () => {
    const cfg = parseNotifyConfig({ destinations: [emailOk], report: { at: '07:30' } })
    expect(cfg.destinations[0]).toEqual({
      id: 'email-smtp-1',
      type: 'email-smtp',
      events: ['reports'],
      smtp: { host: 'smtp.relay.cl', port: 587, tls: 'starttls', authMethod: 'plain', user: 'u1', passEnv: 'VERGIS_TEST_SMTP_PASS' },
      from: 'Vergis <v@x.cl>',
      to: ['ops@x.cl'],
    })
  })

  it('forma inválida LANZA nombrando el destino: puerto, to, from, user sin passEnv, auth en claro', () => {
    expect(() => conEmail({ ...emailOk, smtp: { ...emailOk.smtp, host: '' } })).toThrow(/destino 'email-smtp-1' sin smtp\.host/)
    expect(() => conEmail({ ...emailOk, smtp: { ...emailOk.smtp, port: 0 } })).toThrow(/con smtp\.port inválido/)
    expect(() => conEmail({ ...emailOk, smtp: { ...emailOk.smtp, port: 'quinientos' } })).toThrow(/con smtp\.port inválido/)
    expect(() => conEmail({ ...emailOk, to: [] })).toThrow(/con to inválido/)
    expect(() => conEmail({ ...emailOk, to: ['no-es-una-direccion'] })).toThrow(/con to inválido/)
    expect(() => conEmail({ ...emailOk, from: '  ' })).toThrow(/sin from/)
    expect(() => conEmail({ ...emailOk, smtp: { host: 'h', port: 587, user: 'u1' } })).toThrow(/declara smtp\.user sin smtp\.passEnv/)
    expect(() => conEmail({ ...emailOk, smtp: { ...emailOk.smtp, tls: 'none' } })).toThrow(/declara auth sobre tls 'none' \(credenciales en claro\)/)
    expect(() => conEmail({ ...emailOk, smtp: { ...emailOk.smtp, tls: 'ssl' } })).toThrow(/con smtp\.tls inválido 'ssl'/)
  })

  it('createSinks resuelve la contraseña del ENTORNO al crear el sink y envía por el cliente SMTP inyectado', async () => {
    process.env['VERGIS_TEST_SMTP_PASS'] = 'clave-del-entorno'
    try {
      const cfg = parseNotifyConfig({ destinations: [emailOk], report: { at: '07:30' } })
      const capt: { cfg: unknown; mail: unknown }[] = []
      const sinks = createSinks(cfg, undefined, async (c, m) => void capt.push({ cfg: c, mail: m }))
      const aviso: Notification = {
        severity: 'warning',
        title: 'Reporte de ingestión — 2026-08-06',
        lines: ['a', 'b'],
        links: [{ label: 'Fuentes e ingestas', url: 'https://x/admin/sources' }],
        data: {},
      }
      await sinks[0]!.send(aviso)
      expect(capt).toHaveLength(1)
      expect(capt[0]!.cfg).toEqual({ host: 'smtp.relay.cl', port: 587, tls: 'starttls', auth: { user: 'u1', pass: 'clave-del-entorno', method: 'plain' } })
      expect(capt[0]!.mail).toEqual({ from: 'Vergis <v@x.cl>', to: ['ops@x.cl'], subject: renderEmailSubject(aviso), text: renderEmailText(aviso) })
    } finally {
      delete process.env['VERGIS_TEST_SMTP_PASS']
    }
  })

  it('la env de passEnv ausente TUMBA la creación del sink nombrando la variable (boot fail-closed)', () => {
    delete process.env['VERGIS_TEST_SMTP_PASS']
    const cfg = parseNotifyConfig({ destinations: [emailOk], report: { at: '07:30' } })
    expect(() => createSinks(cfg, undefined, async () => {})).toThrow(/destino 'email-smtp-1': la variable VERGIS_TEST_SMTP_PASS no está definida/)
  })

  it('renderEmailSubject marca el warning con ⚠; renderEmailText es texto plano con los enlaces al pie', () => {
    const base: Notification = {
      severity: 'info',
      title: 'Reporte de ingestión — 2026-08-06 — 3 corrieron · 0 con fallo · 0 no corrieron debiendo',
      lines: ['período: x → y', 'Corrieron bien (3):'],
      links: [],
      data: {},
    }
    expect(renderEmailSubject(base)).toBe(base.title)
    expect(renderEmailSubject({ ...base, severity: 'warning' })).toBe(`⚠ ${base.title}`)
    expect(renderEmailText(base)).toBe(`${base.title}\n\nperíodo: x → y\nCorrieron bien (3):`)
    expect(
      renderEmailText({
        ...base,
        links: [
          { label: 'Fuentes e ingestas', url: 'https://x/admin/sources' },
          { label: 'Log — Cargas', url: 'https://x/log' },
        ],
      }),
    ).toBe(`${base.title}\n\nperíodo: x → y\nCorrieron bien (3):\n\nFuentes e ingestas: https://x/admin/sources\nLog — Cargas: https://x/log\n`)
  })
})

describe("notify · flujo 'cargas-usuario' y el token $uploader (#162·§6.3)", () => {
  const emailCargas = {
    id: 'aviso-usuario',
    type: 'email-smtp',
    events: ['cargas-usuario'],
    smtp: { host: 'smtp.relay.cl', port: 587 },
    from: 'Mira <mira@x.cl>',
    to: ['$uploader'],
  }

  it('el destino email con $uploader parsea, y el token convive con copias operativas', () => {
    const cfg = parseNotifyConfig({ destinations: [emailCargas] })
    expect((cfg.destinations[0] as { to: string[] }).to).toEqual(['$uploader'])
    expect((parseNotifyConfig({ destinations: [{ ...emailCargas, to: ['$uploader', 'ops@x.cl'] }] }).destinations[0] as { to: string[] }).to).toEqual(['$uploader', 'ops@x.cl'])
  })

  it('suscripción a cargas-usuario SIN $uploader rompe el boot nombrando el destino', () => {
    expect(() => parseNotifyConfig({ destinations: [{ ...emailCargas, to: ['ops@x.cl'] }] })).toThrow(
      /destino 'aviso-usuario' se suscribe a 'cargas-usuario' pero su to no incluye \$uploader/,
    )
  })

  it('$uploader declarado por un destino que NO se suscribe al flujo también rompe el boot', () => {
    expect(() => parseNotifyConfig({ destinations: [{ ...emailCargas, events: ['alerts'] }] })).toThrow(
      /destino 'aviso-usuario' declara \$uploader en su to pero no se suscribe a 'cargas-usuario'/,
    )
  })

  it('un slack-webhook suscrito a cargas-usuario rompe el boot: un canal compartido no es una persona', () => {
    expect(() => parseNotifyConfig({ destinations: [{ id: 'ops-slack', type: 'slack-webhook', url: 'https://hooks.slack.com/x', events: ['cargas-usuario'] }] })).toThrow(
      /destino 'ops-slack' se suscribe a 'cargas-usuario', que va dirigido a UNA persona/,
    )
  })

  it('un webhook genérico SÍ puede suscribirse: el JSON lleva uploadedBy y el puente externo decide', () => {
    const cfg = parseNotifyConfig({ destinations: [{ id: 'puente', type: 'webhook', url: 'https://interno/hook', events: ['cargas-usuario'] }] })
    expect(forEvent(cfg, 'cargas-usuario').destinations.map((d) => d.id)).toEqual(['puente'])
    expect(forEvent(cfg, 'alerts').destinations).toEqual([])
  })

  it('el sink de email sustituye $uploader por el uploadedBy DEL AVISO, conservando las copias', async () => {
    const cfg = parseNotifyConfig({ destinations: [{ ...emailCargas, to: ['$uploader', 'ops@x.cl'] }] })
    const capt: { to: string[] }[] = []
    const sinks = createSinks(cfg, undefined, async (_c, m) => void capt.push({ to: m.to }))
    const aviso: Notification = { severity: 'warning', title: 'Tu archivo «x.xlsx» no pudo procesarse', lines: [], links: [], data: { uploadedBy: 'ana@cliente.cl' } }
    await sinks[0]!.send(aviso)
    expect(capt[0]!.to).toEqual(['ana@cliente.cl', 'ops@x.cl'])
  })

  it('un aviso sin uploadedBy no se manda a las copias: LANZA, y el fan-out lo loguea sin tumbar el tick', async () => {
    const cfg = parseNotifyConfig({ destinations: [{ ...emailCargas, to: ['$uploader', 'ops@x.cl'] }] })
    const capt: unknown[] = []
    const sinks = createSinks(cfg, undefined, async (_c, m) => void capt.push(m))
    const aviso: Notification = { severity: 'warning', title: 'x', lines: [], links: [], data: {} }
    await expect(sinks[0]!.send(aviso)).rejects.toThrow(/no trae uploadedBy con forma de dirección/)
    const logs: string[] = []
    await fanout(sinks, aviso, (l) => void logs.push(l))
    expect(capt).toEqual([])
    expect(logs[0]).toContain('uploadedBy')
  })
})
