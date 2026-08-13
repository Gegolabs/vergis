/**
 * Vigilancia del intake (issue #161, hito H1) — lógica pura.
 *
 * Los tests 2 y 3 son CONTROLES NEGATIVOS, y son la razón de ser del módulo: separan «no hay» de
 * «no veo». Cada uno se escribió para que FALLE si la lógica confunde los dos casos (clasificar
 * sobre `[]` cuando la lectura falló; creerle a un listado vacío que el registro desmiente).
 */
import { describe, it, expect } from 'vitest'
import {
  expectedInLanding,
  classifySlot,
  intakeAlerts,
  parseIntakeWatchState,
  DEFAULT_INTAKE_WATCH_MS,
  SIN_MEDIDA_TICKS,
  type OneLakeEntry,
  type RunRecord,
  type SlotWatchConfig,
} from '@vergis/capabilities'

const NOW = Date.parse('2026-08-13T12:00:00Z')
const hace = (min: number): string => new Date(NOW - min * 60_000).toISOString()
const file = (path: string, minAgo: number): OneLakeEntry => ({ path, isDirectory: false, size: 10, lastModified: hace(minAgo) })
const CFG: SlotWatchConfig = { maxAgeMinutes: 120, maxRunMinutes: 60 }

describe('#161 · varados por edad en el landing', () => {
  it('archivo más viejo que max_age_minutes ⇒ alerta varados con el archivo y su edad', () => {
    const r = classifySlot(
      { slotId: 'oc', obs: { slotId: 'oc', observedAt: hace(0), landing: [file('Files/intake/oc/viejo.xlsx', 180)] } },
      CFG,
      NOW,
    )
    expect(r.medida).toBe('fresca')
    expect(r.alertas).toHaveLength(1)
    expect(r.alertas[0]!.reason).toBe('varados')
    expect(r.alertas[0]!.varados).toEqual([{ file: 'viejo.xlsx', ageMinutes: 180 }])
  })

  it('archivo más nuevo que el umbral ⇒ sin alerta', () => {
    const r = classifySlot(
      { slotId: 'oc', obs: { slotId: 'oc', observedAt: hace(0), landing: [file('Files/intake/oc/nuevo.xlsx', 30)] } },
      CFG,
      NOW,
    )
    expect(r.alertas).toEqual([])
  })

  it('los sidecars .meta.json jamás cuentan como varados', () => {
    const r = classifySlot(
      {
        slotId: 'oc',
        obs: {
          slotId: 'oc',
          observedAt: hace(0),
          landing: [file('Files/intake/oc/viejo.xlsx.meta.json', 999), { path: 'Files/intake/oc/sub', isDirectory: true, size: 0, lastModified: hace(999) }],
        },
      },
      CFG,
      NOW,
    )
    expect(r.alertas).toEqual([])
  })
})

describe('#161 · control negativo: lectura fallida NO fabrica hechos (requisito 2)', () => {
  const obsRota = { slotId: 'oc', observedAt: hace(0), error: 'onelake-intake: list falló (503)' }

  it('con proyección previa, el varado real sigue alertando con medida ultima-conocida', () => {
    const r = classifySlot(
      {
        slotId: 'oc',
        obs: obsRota,
        projection: { observedAt: hace(10), landing: [file('Files/intake/oc/viejo.xlsx', 300)] },
      },
      CFG,
      NOW,
    )
    expect(r.medida).toBe('ultima-conocida')
    expect(r.alertas.map((a) => a.reason)).toEqual(['varados'])
    expect(r.alertas[0]!.varados?.[0]?.file).toBe('viejo.xlsx')
    expect(r.alertas[0]!.lastError).toContain('503')
  })

  it('con proyección VACÍA (jamás se midió) ⇒ CERO alertas de varados y medida ninguna', () => {
    // El corazón del hito: un almacenamiento caído no puede concluir «landing vacío» NI «landing
    // sano». Si la lógica clasificara sobre `[]`, la medida diría 'fresca'/'ultima-conocida' y este
    // slot pasaría por sano — exactamente la ceguera que el issue #161 existe para cerrar.
    const r = classifySlot({ slotId: 'oc', obs: obsRota }, CFG, NOW)
    expect(r.medida).toBe('ninguna')
    expect(r.alertas.filter((a) => a.reason === 'varados')).toEqual([])
  })

  it('sostenido ≥3 ticks sin poder medir ⇒ alerta sin-medida (y a los 2, todavía no)', () => {
    const poll = DEFAULT_INTAKE_WATCH_MS
    const dosTicks = classifySlot(
      { slotId: 'oc', obs: obsRota, projection: { observedAt: new Date(NOW - 2 * poll).toISOString() } },
      CFG,
      NOW,
    )
    expect(dosTicks.alertas.map((a) => a.reason)).not.toContain('sin-medida')

    const tresTicks = classifySlot(
      { slotId: 'oc', obs: obsRota, projection: { observedAt: new Date(NOW - SIN_MEDIDA_TICKS * poll).toISOString() } },
      CFG,
      NOW,
    )
    expect(tresTicks.alertas.map((a) => a.reason)).toContain('sin-medida')
    expect(tresTicks.alertas[0]!.reason).toBe('sin-medida') // prioriza «no puedo ver» sobre lo derivado de la vista
  })

  it('slot que nunca se midió bien: el primer intento registrado sirve de baseline', () => {
    const r = classifySlot(
      { slotId: 'oc', obs: obsRota, projection: { firstAttemptAt: new Date(NOW - 3 * DEFAULT_INTAKE_WATCH_MS).toISOString() } },
      CFG,
      NOW,
    )
    expect(r.medida).toBe('ninguna')
    expect(r.alertas.map((a) => a.reason)).toEqual(['sin-medida'])
  })
})

describe('#161 · control del vacío-con-éxito: el registro es el control positivo (§3.3)', () => {
  const uploads = [{ filename: 'f.xlsx', uploadedAt: hace(30), ok: true }]

  it('registro predice f.xlsx y el listado llega ok y vacío ⇒ contradice-registro nombrando f.xlsx', () => {
    // Si la lógica creyera al listado vacío («no hay» = «no veo»), la medida sería 'fresca', no
    // habría alerta alguna y el slot pasaría por sano con el archivo del usuario desaparecido.
    const esperados = expectedInLanding(uploads, [], [])
    expect(esperados).toEqual(['f.xlsx'])

    const r = classifySlot({ slotId: 'oc', obs: { slotId: 'oc', observedAt: hace(0), landing: [] }, expected: esperados }, CFG, NOW)
    expect(r.medida).toBe('contradice-registro')
    expect(r.alertas.map((a) => a.reason)).toEqual(['contradice-registro'])
    expect(r.alertas[0]!.esperados).toEqual(['f.xlsx'])
    // «No se concluye landing vacío»: ninguna conclusión derivada del listado desmentido.
    expect(r.alertas.some((a) => a.reason === 'varados')).toBe(false)
  })

  it('mismo insumo con un retiro de f.xlsx posterior a su carga ⇒ medida fresca, sin alerta', () => {
    const esperados = expectedInLanding(uploads, [], [{ filename: 'f.xlsx', at: hace(10) }])
    expect(esperados).toEqual([])

    const r = classifySlot({ slotId: 'oc', obs: { slotId: 'oc', observedAt: hace(0), landing: [] }, expected: esperados }, CFG, NOW)
    expect(r.medida).toBe('fresca')
    expect(r.alertas).toEqual([])
  })

  it('un retiro ANTERIOR a la carga no la cancela (retiró otra cosa del mismo nombre)', () => {
    expect(expectedInLanding(uploads, [], [{ filename: 'f.xlsx', at: hace(90) }])).toEqual(['f.xlsx'])
  })

  it('el corte es la última corrida Completed: lo subido antes ya fue archivado', () => {
    const runs: RunRecord[] = [{ startedAt: hace(20), endedAt: hace(18), status: 'Completed' }]
    expect(expectedInLanding(uploads, runs, [])).toEqual([]) // la carga es de hace 30 min: la corrida la tomó
    expect(expectedInLanding([{ filename: 'g.xlsx', uploadedAt: hace(5), ok: true }], runs, [])).toEqual(['g.xlsx'])
  })

  it('una carga rechazada (ok=false) nunca aterrizó: no se espera', () => {
    expect(expectedInLanding([{ filename: 'malo.xlsx', uploadedAt: hace(5), ok: false }], [], [])).toEqual([])
  })

  it('con ALGUNO de los predichos presente, el listado es creíble: no hay contradicción', () => {
    const esperados = expectedInLanding(
      [...uploads, { filename: 'g.xlsx', uploadedAt: hace(20), ok: true }],
      [],
      [],
    )
    const r = classifySlot(
      { slotId: 'oc', obs: { slotId: 'oc', observedAt: hace(0), landing: [file('Files/intake/oc/f.xlsx', 30)] }, expected: esperados },
      CFG,
      NOW,
    )
    expect(r.medida).toBe('fresca')
  })
})

describe('#161 · corridas del trigger y slots land-only', () => {
  it('última corrida Failed ⇒ corrida-fallida', () => {
    const runs: RunRecord[] = [
      { startedAt: hace(300), endedAt: hace(295), status: 'Completed' },
      { startedAt: hace(20), endedAt: hace(19), status: 'Failed', error: 'boom' },
    ]
    const r = classifySlot({ slotId: 'oc', obs: { slotId: 'oc', observedAt: hace(0), landing: [], runs } }, CFG, NOW)
    expect(r.alertas.map((a) => a.reason)).toEqual(['corrida-fallida'])
    expect(r.alertas[0]!.run?.error).toBe('boom')
  })

  it('InProgress más allá de max_run_minutes ⇒ corrida-colgada (dentro del umbral, no)', () => {
    const colgada: RunRecord[] = [{ startedAt: hace(90), status: 'InProgress' }]
    const enCurso: RunRecord[] = [{ startedAt: hace(10), status: 'InProgress' }]
    expect(
      classifySlot({ slotId: 'oc', obs: { slotId: 'oc', observedAt: hace(0), landing: [], runs: colgada } }, CFG, NOW).alertas.map((a) => a.reason),
    ).toEqual(['corrida-colgada'])
    expect(
      classifySlot({ slotId: 'oc', obs: { slotId: 'oc', observedAt: hace(0), landing: [], runs: enCurso } }, CFG, NOW).alertas,
    ).toEqual([])
  })

  it('land-only sin watch declarado: jamás varados, pero sí sin-medida y contradice-registro', () => {
    const landOnly: SlotWatchConfig = {} // sin maxAgeMinutes: el ritmo del consumidor externo no se conoce
    const viejo = classifySlot(
      { slotId: 'ext', obs: { slotId: 'ext', observedAt: hace(0), landing: [file('Files/intake/ext/x.csv', 5000)] } },
      landOnly,
      NOW,
    )
    expect(viejo.alertas).toEqual([])

    const ciego = classifySlot(
      {
        slotId: 'ext',
        obs: { slotId: 'ext', observedAt: hace(0), error: 'timeout' },
        projection: { observedAt: new Date(NOW - 3 * DEFAULT_INTAKE_WATCH_MS).toISOString() },
      },
      landOnly,
      NOW,
    )
    expect(ciego.alertas.map((a) => a.reason)).toEqual(['sin-medida'])

    const contradice = classifySlot(
      { slotId: 'ext', obs: { slotId: 'ext', observedAt: hace(0), landing: [] }, expected: ['f.csv'] },
      landOnly,
      NOW,
    )
    expect(contradice.alertas.map((a) => a.reason)).toEqual(['contradice-registro'])
  })
})

describe('#161 · lote y estado persistido', () => {
  it('intakeAlerts devuelve una alerta por slot: la de mayor prioridad', () => {
    const runs: RunRecord[] = [{ startedAt: hace(20), endedAt: hace(19), status: 'Failed' }]
    const alertas = intakeAlerts(
      [
        { input: { slotId: 'oc', obs: { slotId: 'oc', observedAt: hace(0), landing: [file('Files/intake/oc/v.xlsx', 300)], runs } }, config: CFG },
        { input: { slotId: 'sano', obs: { slotId: 'sano', observedAt: hace(0), landing: [] } }, config: CFG },
      ],
      NOW,
    )
    expect(alertas).toHaveLength(1)
    expect(alertas[0]).toMatchObject({ slotId: 'oc', reason: 'corrida-fallida' })
  })

  it('parseIntakeWatchState fail-safe: basura ⇒ {}', () => {
    expect(parseIntakeWatchState('basura')).toEqual({})
    expect(parseIntakeWatchState(null)).toEqual({})
    expect(parseIntakeWatchState('[1,2]')).toEqual({})
    expect(parseIntakeWatchState('{"oc":"inventada","ext":"varados"}')).toEqual({ ext: 'varados' })
    expect(parseIntakeWatchState('{"oc":"sin-medida"}')).toEqual({ oc: 'sin-medida' })
  })
})
