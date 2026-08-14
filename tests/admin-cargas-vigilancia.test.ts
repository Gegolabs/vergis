/**
 * Superficies de la vigilancia del intake (#161/#162) en la consola de Cargas — RENDER PURO.
 *
 * `admin-cargas.ts` es datos → HTML, así que estos tests llaman a `cargasBody` directo: sin handler,
 * sin store, sin reloj. Lo que se prueba es lo que el operador LEE, incluido el caso que da miedo —
 * la instancia sin vigilante tiene que renderizar la página de siempre.
 */
import { describe, it, expect } from 'vitest'
import { cargasBody, timeline, vigilanciaBanner, avisoContratoLogs, desenlaceCelda, hayDesenlace, CORRIDAS_SIN_LOG_AVISO, type SlotCargas, type SlotVigilancia, type IntakeUploadEvent } from '../server/admin-cargas'
import { parseIntakeConfig, type RunRecord, type OneLakeEntry } from '@vergis/capabilities'

const SLOT = parseIntakeConfig({
  slots: [{
    id: 'saldos', label: 'Antigüedad de saldos', domain: 'cartera', maxBytes: 1024,
    target: { workspaceId: 'WS', lakehouseId: 'LH', path: 'Files/intake/saldos' },
    trigger: { processRef: 'PIPE' },
  }],
})[0]!

const RUNS: RunRecord[] = [
  { startedAt: '2026-07-13T16:17:47Z', endedAt: '2026-07-13T16:20:06Z', status: 'Completed' },
]
const HISTORY: IntakeUploadEvent[] = [
  { ts: '2026-07-13T16:17:42Z', filename: 'saldos WK28.xlsx', bytes: 110760, by: 'claudio@x.cl', ok: true, triggered: true },
]
const LANDING: OneLakeEntry[] = [
  { path: 'Files/intake/saldos/viejo.xlsx', isDirectory: false, size: 2048, lastModified: '2026-07-13T17:00:00Z' },
]

function slotCargas(over: Partial<SlotCargas> = {}): SlotCargas {
  return { slot: SLOT, runs: RUNS, history: HISTORY, log: null, landing: LANDING, archived: [], procesoRegistrado: true, ...over }
}
const render = (over: Partial<SlotCargas> = {}): string =>
  cargasBody('cartera', 'Cartera', [SLOT], slotCargas(over), 'TOK', () => '<form id="up"></form>')

// ─── El banner del vigilante: los cuatro estados de la medida (#161·§6.1) ───
describe('banner del vigilante · los 4 estados de MedidaCalidad', () => {
  it('fresca: línea sobria, con la hora de la medida y SIN banner rojo', () => {
    const html = render({ vigilancia: { medida: 'fresca', observedAt: '2026-07-13T18:04:00Z' } })
    expect(html).toContain('👁 Vigilancia del slot: al día · medido 2026-07-13 18:04 UTC.')
    expect(html).not.toContain('msg err') // el estado sano no grita: es la mitad del requisito
  })

  it('ultima-conocida: dice que NO pudo medir, con su error, y que lo de abajo es la medida vieja', () => {
    const html = render({ vigilancia: { medida: 'ultima-conocida', observedAt: '2026-07-13T18:04:00Z', lastError: 'ETIMEDOUT contra OneLake', lastErrorAt: '2026-07-13T20:00:00Z' } })
    expect(html).toContain('⚠ El vigilante no pudo medir este slot en su último intento (2026-07-13 20:00 UTC): ETIMEDOUT contra OneLake.')
    expect(html).toContain('su última medida buena (2026-07-13 18:04 UTC), no de ahora')
  })

  it('contradice-registro: banner rojo que nombra los esperados y NO afirma ninguna causa', () => {
    const html = render({ vigilancia: { medida: 'contradice-registro', observedAt: '2026-07-13T18:04:00Z', esperados: ['a.xlsx', 'b.xlsx'] } })
    expect(html).toContain('msg err')
    expect(html).toContain('CONTRADICE el registro de cargas')
    expect(html).toContain('<b>a.xlsx</b>, <b>b.xlsx</b>')
    expect(html).toContain('No se concluye que el landing esté vacío')
    // La plataforma no sabe POR QUÉ: nombrar una causa sería fabricarla (requisito duro 4).
    for (const causa of ['permiso', 'borrad', 'token', 'configurado mal']) expect(html.toLowerCase()).not.toContain(causa)
  })

  it('ninguna: declara que no hay medida, sin fingir que el slot está sano', () => {
    const html = render({ vigilancia: { medida: 'ninguna', lastError: 'AuthorizationPermissionMismatch' } })
    expect(html).toContain('⚠ El vigilante todavía no ha logrado observar este slot')
    expect(html).toContain('AuthorizationPermissionMismatch')
    expect(html).not.toContain('al día')
  })

  it('el error del vigilante va escapado y redactado (lo escribe un motor, no la página)', () => {
    const v: SlotVigilancia = { medida: 'ultima-conocida', lastError: '<b>fallo</b> AccountKey=abc123def' }
    const html = vigilanciaBanner(v)
    expect(html).toContain('&lt;b&gt;fallo&lt;/b&gt;')
    expect(html).not.toContain('abc123def')
  })

  it('sin vigilancia: no hay banner de ninguna clase', () => {
    expect(vigilanciaBanner(undefined)).toBe('')
  })
})

// ─── La marca VARADO en el landing (#161·§6.1) ──────────────────────────────
describe('marca VARADO en el landing', () => {
  it('el archivo varado lleva su marca y su edad, y el que no lo está no', () => {
    const html = render({
      landing: [...LANDING, { path: 'Files/intake/saldos/sano.xlsx', isDirectory: false, size: 10, lastModified: '2026-07-13T17:30:00Z' }],
      vigilancia: { medida: 'fresca', varados: [{ file: 'viejo.xlsx', ageMinutes: 195 }] },
    })
    const filaVarada = html.split('viejo.xlsx')[1]!.split('</tr>')[0]!
    expect(filaVarada).toContain('⚠ VARADO')
    expect(filaVarada).toContain('hace 3h 15m en el landing')
    const filaSana = html.split('sano.xlsx')[1]!.split('</tr>')[0]!
    expect(filaSana).not.toContain('VARADO')
  })

  it('con medida vieja la marca dice de cuándo es (no se presenta como medida de ahora)', () => {
    const html = render({ vigilancia: { medida: 'ultima-conocida', observedAt: '2026-07-13T18:04:00Z', varados: [{ file: 'viejo.xlsx', ageMinutes: 30 }] } })
    expect(html).toContain('hace 30 min en el landing sin que ninguna corrida lo tomara (según la última medida buena del vigilante)')
  })

  it('la edad se lee de la clasificación: la página NO la deriva del listado', () => {
    // El archivo del landing es de las 17:00 y jamás se compara contra ningún reloj: sin varados
    // declarados no hay marca, por viejo que sea el `lastModified`.
    expect(render({ vigilancia: { medida: 'fresca' } })).not.toContain('VARADO')
  })
})

// ─── El aviso de incumplimiento del contrato `_logs/` (#162·§5) ─────────────
describe('aviso de coherencia · contrato _logs/', () => {
  it('con N corridas terminadas sin log correlacionable, avisa y nombra el directorio', () => {
    const html = render({ vigilancia: { medida: 'fresca', corridasSinLog: CORRIDAS_SIN_LOG_AVISO } })
    expect(html).toContain('no cumple el contrato <code>_logs/</code>')
    expect(html).toContain('<code>Files/code/_logs</code>')
    expect(html).toContain('msg err')
  })

  it('bajo el umbral no avisa: una corrida sin log es un accidente, no una conducta', () => {
    expect(avisoContratoLogs(SLOT, { medida: 'fresca', corridasSinLog: CORRIDAS_SIN_LOG_AVISO - 1 })).toBe('')
    expect(avisoContratoLogs(SLOT, { medida: 'fresca' })).toBe('')
    expect(avisoContratoLogs(SLOT, undefined)).toBe('')
  })
})

// ─── La columna Desenlace de Actividad (#162·§6.2) ──────────────────────────
const CON_DESENLACE: IntakeUploadEvent[] = [
  { ...HISTORY[0]!, desenlace: 'fallida', desenlaceMotivo: 'ancho inesperado: 28 columnas (se esperaban 48)', desenlaceRunStartedAt: RUNS[0]!.startedAt },
]

describe('columna Desenlace en Actividad', () => {
  it('la carga con desenlace muestra badge, motivo y enlace a SU corrida', () => {
    const html = cargasBody('cartera', 'Cartera', [SLOT], slotCargas({ history: CON_DESENLACE }), 'TOK', () => '',
      (s, r) => `/admin/dominio/cartera/corrida?slot=${s.id}&started=${r.startedAt}`)
    expect(html).toContain('<th>Desenlace</th>')
    expect(html).toContain('✕ Falló')
    expect(html).toContain('ancho inesperado: 28 columnas (se esperaban 48)')
    expect(html).toContain('/admin/dominio/cartera/corrida?slot=saldos&amp;started=2026-07-13T16:17:47Z')
  })

  it('el motivo va ESCAPADO: lo escribe un job de terreno y termina en HTML', () => {
    const h: IntakeUploadEvent = { ...HISTORY[0]!, desenlace: 'fallida', desenlaceMotivo: '<img src=x onerror="alert(1)"> & «raro»' }
    const celda = desenlaceCelda(h, RUNS)
    expect(celda).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; «raro»')
    expect(celda).not.toContain('<img')
    expect(celda).not.toContain('onerror="alert(1)"')
  })

  it('el motivo pasa por redactSecrets: un log puede traer una cadena de conexión', () => {
    const h: IntakeUploadEvent = { ...HISTORY[0]!, desenlace: 'fallida', desenlaceMotivo: 'falló abrir DefaultEndpointsProtocol=https;AccountKey=Zm9vYmFy123==;' }
    const celda = desenlaceCelda(h, RUNS)
    expect(celda).not.toContain('Zm9vYmFy123')
    expect(celda).toContain('«…redactado…»')
  })

  it('sin-informe SIN motivo dice que nadie reportó la causa — no se fabrica ninguna', () => {
    const celda = desenlaceCelda({ ...HISTORY[0]!, desenlace: 'sin-informe' }, RUNS)
    expect(celda).toContain('✕ Sin informe')
    expect(celda).toContain('el proceso terminó sin reportar la causa')
  })

  it('sin corrida correlacionable en el historial mostrado, no se enlaza nada', () => {
    const celda = desenlaceCelda({ ...HISTORY[0]!, desenlace: 'varada', desenlaceRunStartedAt: '2020-01-01T00:00:00Z' }, RUNS, () => '/x')
    expect(celda).toContain('⚠ Varada')
    expect(celda).not.toContain('Ver corrida')
  })

  it('hayDesenlace decide la columna, y con historial en error no la pide', () => {
    expect(hayDesenlace(CON_DESENLACE)).toBe(true)
    expect(hayDesenlace(HISTORY)).toBe(false)
    expect(hayDesenlace('error')).toBe(false)
  })
})

// ─── Regresión cero: instancia sin vigilante (criterio 4 del hito) ──────────
describe('instancia SIN vigilante: la página es la de siempre', () => {
  it('cero rastro de las superficies nuevas', () => {
    const html = render()
    for (const rastro of ['Vigilancia del slot', 'VARADO', 'Desenlace', 'contrato <code>_logs/</code>', 'msg err']) {
      expect(html).not.toContain(rastro)
    }
  })

  it('la tabla de Actividad conserva sus 4 columnas exactas y su colspan', () => {
    const html = render()
    expect(html).toContain('<tr><th>Cuándo</th><th>Evento</th><th>Detalle</th><th></th></tr>')
    expect(render({ history: [], runs: [] })).toContain('<tr><td colspan="4" class="sub">Sin actividad registrada.</td></tr>')
  })

  it('timeline sin la columna produce EXACTAMENTE las mismas filas que antes de #162', () => {
    // El default de `conDesenlace` es el comportamiento viejo: mismas filas, misma cantidad de <td>.
    for (const fila of timeline(CON_DESENLACE, RUNS)) expect(fila.html.match(/<td/g)!).toHaveLength(4)
    for (const fila of timeline(CON_DESENLACE, RUNS, 30, null, false, undefined, undefined, undefined, true)) {
      expect(fila.html.match(/<td/g)!).toHaveLength(5)
    }
  })
})
