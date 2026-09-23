import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  parseRunFileOutcomes,
  extraerSufijoDesenlace,
  SqliteGovernanceStore,
  openSqliteDb,
  persistSqliteDb,
  selectAll,
  type FileOutcome,
  type IntakeUploadRow,
} from '@vergis/capabilities'
import { resolveDesenlaceDeCarga, type CorridaConLog } from '../server/intake-loop'

/**
 * H1 de #346 · el CÓDIGO del desenlace viaja por el contrato `_logs/` y se persiste.
 *
 * La fixture es un log REAL de la instancia A.R.B.O.L. (crossdocking, `Files/code/_logs/` del landing,
 * corrida del 2026-09-22 17:15:54Z): trae las dos líneas `✖ fallido` que dispararon el issue, sin
 * sufijo. Sirve dos veces: como CONTROL NEGATIVO (sin sufijo, el lector devuelve exactamente lo de
 * antes de #346) y como base de las líneas con sufijo (se le agrega el sufijo a la línea real y el
 * motivo resultante tiene que ser IDÉNTICO al de la línea sin él).
 */
const FIXTURE = readFileSync(join(__dirname, 'fixtures/run-logs/run-20260922T171554Z.txt'), 'utf8')
const lineaDe = (archivo: string): string => FIXTURE.split('\n').find((l) => l.startsWith(`[intake] ✖ fallido: ${archivo} — `))!
const MAESTRO = 'Tiendas por zona Sodimac.xlsx'
const OC = 'oc-17525983-distributions-details-22-09-2026.xlsx'

/**
 * El lector TAL COMO ESTABA antes de #346 (`run-logs.ts` en f219bc6), copiado literal: es la
 * referencia del control negativo. Si el lector nuevo cambia en algo el resultado de una línea sin
 * sufijo, la comparación contra esta copia lo acusa.
 */
function lectorPre346(logText: string): FileOutcome[] {
  const OUTCOME_RE = /^(✔|⚠|✖)️?\s+(procesado|saltado|fallido)\s*:\s*(.+)$/
  const MAP: Record<string, string> = { '✔': 'procesado', '⚠': 'saltado', '✖': 'fallido' }
  const corta = (resto: string): { corte: number; largo: number } => {
    const raya = resto.indexOf('—')
    if (raya >= 0) return { corte: raya, largo: 1 }
    const ascii = resto.indexOf(' - ')
    return ascii >= 0 ? { corte: ascii, largo: 3 } : { corte: -1, largo: 0 }
  }
  const orden: string[] = []
  const por = new Map<string, FileOutcome>()
  for (const raw of logText.split('\n')) {
    const linea = raw.replace(/^\s*(?:\[[^\]]*\]\s*)*/, '').trim()
    const m = OUTCOME_RE.exec(linea)
    if (!m) continue
    const [, marcador, palabra, resto] = m as unknown as string[]
    const outcome = MAP[marcador!] as FileOutcome['outcome']
    if (!outcome || outcome !== palabra) continue
    const { corte, largo } = corta(resto!)
    const file = (corte >= 0 ? resto!.slice(0, corte) : resto!).trim().replace(/^.*[/\\]/, '')
    if (!file) continue
    const motivo = corte >= 0 ? resto!.slice(corte + largo).trim() : ''
    const fo: FileOutcome = { file, outcome }
    if (motivo && outcome !== 'procesado') fo.motivo = motivo
    if (!por.has(file)) orden.push(file)
    por.set(file, fo)
  }
  return orden.map((f) => por.get(f)!)
}

describe('#346·H1 · control negativo: sin sufijo, el lector devuelve EXACTAMENTE lo de antes', () => {
  it('la fixture real produce los mismos FileOutcome que el lector pre-#346, sin código', () => {
    const hoy = parseRunFileOutcomes(FIXTURE)
    expect(hoy).toEqual(lectorPre346(FIXTURE))
    expect(hoy.map((o) => o.file)).toEqual([MAESTRO, OC])
    expect(hoy.every((o) => o.codigo === undefined && o.params === undefined)).toBe(true)
    // La premisa P5 del diseño, medida sobre la fixture: el motivo del maestro mide 508 caracteres.
    expect(hoy[0]!.motivo!.length).toBe(508)
  })

  it('un corpus de líneas sin sufijo (formas límite de #162/#194) da lo mismo con ambos lectores', () => {
    const corpus = [
      '[intake] ✔ procesado: a.xlsx',
      '[intake] ⚠ saltado: b.xlsx — ya cargado',
      '[ingest] [intake] ✖ fallido: c.xlsx — ancho inesperado — ver log',
      '✖ fallido: d.xlsx - guion ascii',
      '✖ fallido: e.xlsx',
      '⚠️ saltado: Files/x/f.xlsx — con path',
      '✖ fallido: g.xlsx — texto con ⟦corchetes⟧ en medio y más texto',
      '✖ fallido: h.xlsx — termina en ⟦Mayuscula⟧',
    ].join('\n')
    expect(parseRunFileOutcomes(corpus)).toEqual(lectorPre346(corpus))
  })
})

describe('#346·H1 · el sufijo ⟦…⟧ se extrae y el motivo queda SIN él', () => {
  it('línea real del maestro + sufijo ⇒ código y params, y el motivo IDÉNTICO al de la línea sin sufijo', () => {
    const sin = parseRunFileOutcomes(lineaDe(MAESTRO))[0]!
    const con = parseRunFileOutcomes(`${lineaDe(MAESTRO)} ⟦catalogo-incompleto/maestro-tiendas n=50 tiendas_archivo=2 faltan=11,12,16⟧`)[0]!
    expect(con.file).toBe(MAESTRO)
    expect(con.outcome).toBe('fallido')
    expect(con.codigo).toBe('catalogo-incompleto/maestro-tiendas')
    expect(con.params).toEqual({ n: '50', tiendas_archivo: '2', faltan: ['11', '12', '16'] })
    expect(con.motivo).toBe(sin.motivo)
  })

  it('línea real de la OC + sufijo con lista corta', () => {
    const sin = parseRunFileOutcomes(lineaDe(OC))[0]!
    const con = parseRunFileOutcomes(`${lineaDe(OC)} ⟦referencia-ausente/tienda-sin-zona oc=17525983 faltan=58,88⟧`)[0]!
    expect(con).toEqual({ ...sin, codigo: 'referencia-ausente/tienda-sin-zona', params: { oc: '17525983', faltan: ['58', '88'] } })
  })

  it('valor ENTRECOMILLADO con espacios y con raya ⇒ se extrae completo; el motivo no cambia y el archivo sale bien', () => {
    const sin = parseRunFileOutcomes(lineaDe(MAESTRO))[0]!
    const con = parseRunFileOutcomes(
      `${lineaDe(MAESTRO)} ⟦desplazado/snapshot-reciente vigente="Control de despachos — 2026-09-01.xlsx" tipo=despachos n=3⟧`,
    )[0]!
    expect(con.file).toBe(MAESTRO)
    expect(con.codigo).toBe('desplazado/snapshot-reciente')
    expect(con.params).toEqual({ vigente: 'Control de despachos — 2026-09-01.xlsx', tipo: 'despachos', n: '3' })
    expect(con.motivo).toBe(sin.motivo)
  })

  it('un valor entrecomillado con comas es un escalar, no una lista', () => {
    const con = parseRunFileOutcomes('✖ fallido: x.xlsx — motivo ⟦desplazado vigente="a, b.xlsx"⟧')[0]!
    expect(con.params).toEqual({ vigente: 'a, b.xlsx' })
  })

  it('solo la familia, sin params; y sin motivo: el código viaja igual', () => {
    expect(parseRunFileOutcomes('⚠ saltado: y.xlsx — espera ⟦en-espera⟧')[0]).toEqual({ file: 'y.xlsx', outcome: 'saltado', motivo: 'espera', codigo: 'en-espera' })
    expect(parseRunFileOutcomes('✖ fallido: z.xlsx ⟦falla-plataforma⟧')[0]).toEqual({ file: 'z.xlsx', outcome: 'fallido', codigo: 'falla-plataforma' })
  })

  it('una familia DESCONOCIDA con sintaxis válida se lee igual (el lector no conoce el catálogo)', () => {
    expect(parseRunFileOutcomes('✖ fallido: q.xlsx — m ⟦vigencia-vencida/periodo p=2026-01⟧')[0]!.codigo).toBe('vigencia-vencida/periodo')
  })

  it('en `procesado` el sufijo no es gramática: la línea se lee exactamente como antes', () => {
    const l = '✔ procesado: a.xlsx ⟦formato⟧'
    expect(parseRunFileOutcomes(l)).toEqual(lectorPre346(l))
  })
})

describe('#346·H1 · un sufijo que no calza NO existe: sin código, el texto queda dentro del motivo', () => {
  const casos: [string, string][] = [
    ['comillas sin cerrar', '⟦desplazado vigente="Control de despachos.xlsx⟧'],
    ['⟦ sin cerrar', '⟦catalogo-incompleto/maestro-tiendas n=50'],
    ['familia con mayúscula', '⟦Catalogo-incompleto n=50⟧'],
    ['valor pelado con espacio', '⟦desplazado vigente=Control de despachos.xlsx⟧'],
    ['específico con mayúscula', '⟦formato/Columnas⟧'],
    ['clave inválida', '⟦formato N=3⟧'],
    ['sin espacio antes de ⟦', 'x⟦formato⟧'],
  ]
  for (const [nombre, sufijo] of casos) {
    it(nombre, () => {
      const linea = `✖ fallido: a.xlsx — motivo técnico ${sufijo}`
      const o = parseRunFileOutcomes(linea)[0]!
      expect(o.codigo).toBeUndefined()
      expect(o.params).toBeUndefined()
      expect(o.motivo).toBe(`motivo técnico ${sufijo}`)
      expect(o).toEqual(lectorPre346(linea)[0])
      expect(extraerSufijoDesenlace(`a.xlsx — motivo técnico ${sufijo}`)).toBeNull()
    })
  }
})

describe('#346·H1 · el resolver lleva código y params hasta el desenlace', () => {
  it('resolveDesenlaceDeCarga copia codigo y params de la línea del MISMO archivo', () => {
    const texto = `${lineaDe(OC)} ⟦referencia-ausente/tienda-sin-zona oc=17525983 faltan=58,88⟧\n${lineaDe(MAESTRO)}`
    const corridas: CorridaConLog[] = [{ run: { startedAt: '2026-09-22T17:15:54Z', endedAt: '2026-09-22T17:17:00Z', status: 'Failed' }, log: 'match', texto }]
    const r = resolveDesenlaceDeCarga({ filename: OC, uploadedAt: '2026-09-22T17:15:00Z' }, corridas, [], Date.parse('2026-09-22T18:00:00Z'))
    expect(r).toMatchObject({ desenlace: 'fallida', codigo: 'referencia-ausente/tienda-sin-zona', params: { oc: '17525983', faltan: ['58', '88'] } })
    expect(r!.motivo).not.toContain('⟦')
    // El maestro, sin sufijo, queda sin código: el código de una línea no contamina otra.
    const m = resolveDesenlaceDeCarga({ filename: MAESTRO, uploadedAt: '2026-09-22T17:15:00Z' }, corridas, [], Date.parse('2026-09-22T18:00:00Z'))
    expect(m!.codigo).toBeUndefined()
    expect(m!.motivo!.length).toBe(508)
  })
})

const upload = (over: Partial<Omit<IntakeUploadRow, 'id'>> = {}): Omit<IntakeUploadRow, 'id'> => ({
  slotId: 'oc_crossdocking_maestro',
  filename: MAESTRO,
  sha256: 'a'.repeat(64),
  bytes: 1000,
  uploadedBy: 'claudio@x.cl',
  uploadedAt: '2026-09-22T17:15:00Z',
  ok: true,
  triggered: true,
  origen: 'upload',
  ...over,
})

describe('#346·H1 · persistencia: desenlace_codigo y desenlace_params', () => {
  it('setUploadDesenlace escribe código + params, y sobreviven a reabrir el archivo', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-346-')), 'governance.sqlite')
    const g1 = await SqliteGovernanceStore.open(file, {})
    const id = await g1.recordUpload(upload())
    await g1.setUploadDesenlace(id, {
      desenlace: 'fallida',
      motivo: 'el maestro nuevo NO cubre 50 local(es)',
      codigo: 'catalogo-incompleto/maestro-tiendas',
      params: { n: '50', faltan: ['11', '12'] },
    })
    await g1.close()
    const g2 = await SqliteGovernanceStore.open(file, {})
    expect((await g2.listUploads('oc_crossdocking_maestro', 5))[0]).toMatchObject({
      desenlaceCodigo: 'catalogo-incompleto/maestro-tiendas',
      desenlaceParams: { n: '50', faltan: ['11', '12'] },
      desenlaceMotivo: 'el maestro nuevo NO cubre 50 local(es)',
    })
    await g2.close()
  })

  it('sin código: las columnas quedan NULL y la fila se lee como antes (sin los campos)', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const id = await g.recordUpload(upload())
    await g.setUploadDesenlace(id, { desenlace: 'fallida', motivo: 'x' })
    const r = (await g.listUploads('oc_crossdocking_maestro', 5))[0]!
    expect('desenlaceCodigo' in r).toBe(false)
    expect('desenlaceParams' in r).toBe(false)
    await g.close()
  })

  it('una base SIN las columnas nuevas arranca, las agrega (aditivo) y conserva lo que había', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-346-migra-')), 'governance.sqlite')
    const vieja = await openSqliteDb(file)
    // El esquema de 0.33.3: con las columnas de desenlace de #162, sin las de #346.
    vieja.run(`CREATE TABLE intake_upload (
      id INTEGER PRIMARY KEY, slot_id TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL, uploaded_by TEXT, uploaded_at TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 1,
      error TEXT, triggered INTEGER NOT NULL DEFAULT 0, origen TEXT NOT NULL DEFAULT 'upload', dup_of INTEGER,
      desenlace TEXT, desenlace_motivo TEXT, desenlace_run_started_at TEXT, desenlace_at TEXT
    );`)
    vieja.run(
      `INSERT INTO intake_upload (id, slot_id, filename, sha256, bytes, uploaded_at, desenlace, desenlace_motivo)
       VALUES (1,'oc_crossdocking_maestro','viejo.xlsx',?,10,'2026-09-01T00:00:00Z','fallida','motivo viejo')`,
      ['b'.repeat(64)],
    )
    persistSqliteDb(vieja, file)
    vieja.close()
    const g = await SqliteGovernanceStore.open(file, {})
    const cols = (await openSqliteDb(file).then((db) => selectAll(db, 'PRAGMA table_info(intake_upload)'))).map((c) => String(c['name']))
    expect(cols).toEqual(expect.arrayContaining(['desenlace_codigo', 'desenlace_params']))
    const r = (await g.listUploads('oc_crossdocking_maestro', 5))[0]!
    expect(r).toMatchObject({ id: 1, desenlace: 'fallida', desenlaceMotivo: 'motivo viejo' })
    expect(r.desenlaceCodigo).toBeUndefined()
    await g.close()
    // Idempotente: reabrir no vuelve a alterar ni falla.
    const g2 = await SqliteGovernanceStore.open(file, {})
    expect((await g2.listUploads('oc_crossdocking_maestro', 5))).toHaveLength(1)
    await g2.close()
  })

  it('contarDesenlaceCodigos: solo fallida/saltada del slot, desde la fecha, agrupado por código', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    const mk = async (over: Partial<Omit<IntakeUploadRow, 'id'>>, d: Parameters<SqliteGovernanceStore['setUploadDesenlace']>[1]): Promise<void> => {
      const id = await g.recordUpload(upload(over))
      await g.setUploadDesenlace(id, d)
    }
    await mk({}, { desenlace: 'fallida', codigo: 'formato' })
    await mk({}, { desenlace: 'fallida', codigo: 'formato' })
    await mk({}, { desenlace: 'saltada', codigo: 'en-espera' })
    await mk({}, { desenlace: 'fallida' })
    await mk({}, { desenlace: 'sin-informe' }) // no la declaró el job: no cuenta
    await mk({}, { desenlace: 'procesada' })
    await mk({ uploadedAt: '2026-01-01T00:00:00Z' }, { desenlace: 'fallida', codigo: 'formato' }) // vieja
    await mk({ slotId: 'otro' }, { desenlace: 'fallida', codigo: 'formato' }) // ajena
    expect(await g.contarDesenlaceCodigos('oc_crossdocking_maestro', '2026-09-01T00:00:00Z')).toEqual([
      { codigo: 'formato', n: 2 },
      { codigo: null, n: 1 },
      { codigo: 'en-espera', n: 1 },
    ])
    await g.close()
  })
})
