import { describe, it, expect } from 'vitest'
import {
  RUN_LOG_DIR_DEFAULT,
  RUN_LOG_RETENTION,
  runLogFileName,
  parseRunLogTimestamp,
  resolveRunLog,
  redactSecrets,
  type OneLakeEntry,
  type RunRecord,
} from '@vergis/capabilities'

const entry = (path: string, size = 100): OneLakeEntry => ({ path, isDirectory: false, size, lastModified: '2026-08-06T10:00:00.000Z' })

describe('run-logs · convención de nombre', () => {
  it('roundtrip runLogFileName ↔ parseRunLogTimestamp', () => {
    const iso = '2026-08-06T13:45:07.000Z'
    const name = runLogFileName(iso)
    expect(name).toBe('run-20260806T134507Z.txt')
    expect(parseRunLogTimestamp(name)).toBe(Date.parse(iso))
  })

  it('acepta basename con path, extensión .log y mayúsculas', () => {
    expect(parseRunLogTimestamp('Files/code/_logs/run-20260806T134507Z.txt')).toBe(Date.parse('2026-08-06T13:45:07Z'))
    expect(parseRunLogTimestamp('run-20260806T134507Z.log')).toBe(Date.parse('2026-08-06T13:45:07Z'))
    expect(parseRunLogTimestamp('RUN-20260806t134507z.TXT')).toBe(Date.parse('2026-08-06T13:45:07Z'))
  })

  it('null para nombres fuera de la convención y fechas imposibles', () => {
    expect(parseRunLogTimestamp('_ingest_log.txt')).toBeNull()
    expect(parseRunLogTimestamp('run-2026-08-06T134507Z.txt')).toBeNull()
    expect(parseRunLogTimestamp('run-20261306T134507Z.txt')).toBeNull()
  })

  it('runLogFileName lanza con un ISO que no parsea', () => {
    expect(() => runLogFileName('ayer')).toThrow()
  })

  it('las constantes del contrato están declaradas', () => {
    expect(RUN_LOG_DIR_DEFAULT).toBe('Files/code/_logs')
    expect(RUN_LOG_RETENTION).toBe(60)
  })
})

describe('run-logs · correlación corrida ↔ archivo (D3)', () => {
  const run = (startedAt: string, endedAt?: string, status: RunRecord['status'] = 'Completed'): RunRecord =>
    endedAt ? { startedAt, endedAt, status } : { startedAt, status }

  it('match exacto', () => {
    const r = run('2026-08-06T10:00:00Z', '2026-08-06T10:10:00Z')
    const res = resolveRunLog(r, [entry('Files/code/_logs/run-20260806T100005Z.txt')])
    expect(res.kind).toBe('match')
    expect(res.kind === 'match' && res.entry.path).toContain('run-20260806T100005Z')
  })

  it('bordes de la ventana: −120 s dentro, −121 s fuera; +300 s tras el fin dentro, +301 s fuera', () => {
    const r = run('2026-08-06T10:00:00Z', '2026-08-06T10:10:00Z')
    // Un archivo viejo acompaña a cada caso para que el fuera-de-ventana no se lea como `purgado`.
    const viejo = entry('run-20260801T080000Z.txt')
    expect(resolveRunLog(r, [entry('run-20260806T095800Z.txt')]).kind).toBe('match')
    expect(resolveRunLog(r, [viejo, entry('run-20260806T095759Z.txt')]).kind).toBe('sin-log')
    expect(resolveRunLog(r, [entry('run-20260806T101500Z.txt')]).kind).toBe('match')
    expect(resolveRunLog(r, [viejo, entry('run-20260806T101501Z.txt')]).kind).toBe('sin-log')
  })

  it('sin endedAt la ventana se cierra a 24 h del arranque', () => {
    const r = run('2026-08-06T10:00:00Z', undefined, 'Failed')
    const viejo = entry('run-20260801T080000Z.txt')
    expect(resolveRunLog(r, [entry('run-20260807T095900Z.txt')]).kind).toBe('match')
    expect(resolveRunLog(r, [viejo, entry('run-20260807T100100Z.txt')]).kind).toBe('sin-log')
  })

  it('dos candidatos: gana el más cercano al arranque', () => {
    const r = run('2026-08-06T10:00:00Z', '2026-08-06T10:20:00Z')
    const res = resolveRunLog(r, [entry('run-20260806T101000Z.txt'), entry('run-20260806T100030Z.txt')])
    expect(res.kind === 'match' && res.entry.path).toBe('run-20260806T100030Z.txt')
  })

  it('dos corridas contiguas: cada una resuelve su propio archivo (la ambigüedad no cruza)', () => {
    const archivos = [entry('run-20260806T100005Z.txt'), entry('run-20260806T110005Z.txt')]
    const a = resolveRunLog(run('2026-08-06T10:00:00Z', '2026-08-06T10:30:00Z'), archivos)
    const b = resolveRunLog(run('2026-08-06T11:00:00Z', '2026-08-06T11:30:00Z'), archivos)
    expect(a.kind === 'match' && a.entry.path).toBe('run-20260806T100005Z.txt')
    expect(b.kind === 'match' && b.entry.path).toBe('run-20260806T110005Z.txt')
  })

  it('en-curso: corrida InProgress/NotStarted sin archivo aún', () => {
    expect(resolveRunLog(run('2026-08-06T10:00:00Z', undefined, 'InProgress'), []).kind).toBe('en-curso')
    expect(resolveRunLog(run('2026-08-06T10:00:00Z', undefined, 'NotStarted'), []).kind).toBe('en-curso')
  })

  it('en-curso NO gana sobre un match: si hay archivo se muestra', () => {
    const r = run('2026-08-06T10:00:00Z', undefined, 'InProgress')
    expect(resolveRunLog(r, [entry('run-20260806T100002Z.txt')]).kind).toBe('match')
  })

  it('purgado: la corrida es más vieja que el archivo más antiguo presente', () => {
    const r = run('2026-08-01T10:00:00Z', '2026-08-01T10:10:00Z', 'Failed')
    expect(resolveRunLog(r, [entry('run-20260806T100000Z.txt')]).kind).toBe('purgado')
  })

  it('sin-log: directorio vacío o archivos que no siguen la convención', () => {
    const r = run('2026-08-06T10:00:00Z', '2026-08-06T10:10:00Z', 'Failed')
    expect(resolveRunLog(r, []).kind).toBe('sin-log')
    expect(resolveRunLog(r, [entry('_ingest_log.txt')]).kind).toBe('sin-log')
  })

  it('ignora directorios', () => {
    const r = run('2026-08-06T10:00:00Z', '2026-08-06T10:10:00Z', 'Failed')
    const dir: OneLakeEntry = { path: 'run-20260806T100005Z.txt', isDirectory: true, size: 0, lastModified: '' }
    expect(resolveRunLog(r, [dir]).kind).toBe('sin-log')
  })
})

describe('run-logs · redactSecrets (D9)', () => {
  it('enmascara pares clave=valor de secreto', () => {
    const out = redactSecrets('conectando con client_secret=abc123XYZ al servicio')
    expect(out).not.toContain('abc123XYZ')
    expect(out).toContain('redactado')
  })

  it('enmascara `Password: …` (case-insensitive, con dos puntos)', () => {
    const out = redactSecrets('Password: sUpErS3creta')
    expect(out).not.toContain('sUpErS3creta')
  })

  it('enmascara un JWT eyJ…', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const out = redactSecrets(`authorization: Bearer ${jwt}`)
    expect(out).not.toContain('dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')
  })

  it('NO toca conteos ni texto normal del log', () => {
    const log = "DELETE fct_saldos WHERE semana='W28': 7580 filas\nINSERT: 7626 filas\n✖ ABORTADO: archivo sin filas de datos"
    expect(redactSecrets(log)).toBe(log)
  })
})
