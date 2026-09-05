import { describe, it, expect } from 'vitest'
import { SqliteEvaluacionesStore, confianzaDe, type PublicarInstrumentoInput } from '@vergis/capabilities'
import { VergisError } from '@vergis/botler'

/**
 * EL STORE `evaluaciones` (doc 013 · H2). Todo en memoria (`file: null`), como `notas-store.test.ts`.
 *
 * Lo que estas pruebas defienden, y por qué:
 *  · un instrumento es INMUTABLE por id — cambiarle el contenido debajo vuelve incomparables los
 *    intentos ya rendidos contra él, y el daño no se ve hasta que alguien compara dos cohortes;
 *  · `guardarIntento` REEMPLAZA — Daftar manda el estado entero en cada POST, y mezclar dejaría vivas
 *    respuestas que el estudiante ya borró;
 *  · la confianza se DERIVA solo de `{choice, conf}` — inventarla para un string sería fabricar un
 *    dato que nadie declaró.
 */

const base = (over: Partial<PublicarInstrumentoInput> = {}): PublicarInstrumentoInput => ({
  id: 'g1',
  titulo: 'Guía 1',
  confianza: false,
  totalSecciones: 2,
  totalItems: 5,
  sha256: 'aaa',
  publicadoAt: '2026-01-01T00:00:00.000Z',
  invalidado: false,
  estudiante: 'ana',
  ...over,
})

const abrir = (): Promise<SqliteEvaluacionesStore> => SqliteEvaluacionesStore.open(null)

describe('instrumentos', () => {
  it('publica, lee, lista por estudiante y por vigencia; retirar NO borra', async () => {
    const s = await abrir()
    expect(s.publicarInstrumento(base())).toBe(true)
    expect(s.publicarInstrumento(base({ id: 'g2', sha256: 'bbb', estudiante: 'beto' }))).toBe(true)

    const g1 = s.instrumento('g1')
    expect(g1?.titulo).toBe('Guía 1')
    expect(g1?.totalItems).toBe(5)
    expect(g1?.retiradoAt).toBeUndefined()

    expect(s.instrumentos({ estudiante: 'ana' }).map((i) => i.id)).toEqual(['g1'])
    expect(s.instrumentos({ vigentes: true }).map((i) => i.id)).toEqual(['g1', 'g2'])

    expect(s.retirarInstrumento('g1', '2026-02-01T00:00:00.000Z')).toBe(true)
    expect(s.instrumento('g1')?.retiradoAt).toBe('2026-02-01T00:00:00.000Z')
    expect(s.instrumentos({ vigentes: true }).map((i) => i.id)).toEqual(['g2'])
    // El retirado sigue estando: los intentos rendidos contra él lo siguen citando.
    expect(s.instrumentos().map((i) => i.id)).toEqual(['g1', 'g2'])
    expect(s.retirarInstrumento('no-existe', '2026-02-01T00:00:00.000Z')).toBe(false)
  })

  it('re-publicar el mismo id con OTRO sha lanza evaluaciones/instrumento-inmutable; con el mismo es no-op', async () => {
    const s = await abrir()
    s.publicarInstrumento(base())
    expect(s.publicarInstrumento(base({ titulo: 'da igual el título' }))).toBe(false)
    expect(s.instrumento('g1')?.titulo).toBe('Guía 1')

    let capturado: VergisError | null = null
    try {
      s.publicarInstrumento(base({ sha256: 'zzz' }))
    } catch (e) {
      capturado = e as VergisError
    }
    expect(capturado).toBeInstanceOf(VergisError)
    expect(capturado?.structured.code).toBe('evaluaciones/instrumento-inmutable')
    expect(capturado?.message).toContain('aaa')
    expect(capturado?.message).toContain('zzz')
    // El instrumento vigente quedó intacto.
    expect(s.instrumento('g1')?.sha256).toBe('aaa')
  })
})

describe('intentos', () => {
  it('guardarIntento REEMPLAZA atómicamente: el segundo guardado con menos respuestas deja solo las nuevas', async () => {
    const s = await abrir()
    s.publicarInstrumento(base())
    s.guardarIntento({
      instrumentoId: 'g1',
      estudiante: 'ana',
      seccionActual: 1,
      totalSecciones: 2,
      secciones: [
        { seccion: 0, respuestas: [{ indice: 0, valor: 'a' }, { indice: 1, valor: 'b' }, { indice: 2, valor: 'c' }] },
        { seccion: 1, respuestas: [{ indice: 0, valor: 'x' }] },
      ],
    })
    const primero = s.intento('g1', 'ana')!
    expect(primero.secciones.map((x) => x.respuestas.length)).toEqual([3, 1])

    s.guardarIntento({
      instrumentoId: 'g1',
      estudiante: 'ana',
      seccionActual: 0,
      totalSecciones: 2,
      secciones: [{ seccion: 0, respuestas: [{ indice: 0, valor: 'a' }] }],
    })
    const segundo = s.intento('g1', 'ana')!
    expect(segundo.id).toBe(primero.id) // el mismo intento, no uno nuevo
    expect(segundo.secciones.length).toBe(1)
    expect(segundo.secciones[0]!.respuestas.map((r) => r.valorJson)).toEqual(['"a"'])
    expect(s.intentosDe('ana').length).toBe(1)
  })

  it('la confianza se deriva SOLO de {choice, conf}', async () => {
    expect(confianzaDe({ choice: '2', conf: 'S' })).toBe('S')
    expect(confianzaDe({ choice: '2', conf: 'C' })).toBe('C')
    expect(confianzaDe({ choice: '2', conf: 'A' })).toBe('A')
    expect(confianzaDe('2')).toBeUndefined()
    expect(confianzaDe(null)).toBeUndefined()
    expect(confianzaDe({ lentamente: 'adverbio' })).toBeUndefined() // mapa palabra→categoría
    expect(confianzaDe({ choice: '2', conf: 'X' })).toBeUndefined() // valor fuera del dominio S·C·A

    const s = await abrir()
    s.publicarInstrumento(base({ confianza: true }))
    s.guardarIntento({
      instrumentoId: 'g1',
      estudiante: 'ana',
      seccionActual: 0,
      totalSecciones: 1,
      secciones: [
        {
          seccion: 0,
          respuestas: [
            { indice: 0, valor: { choice: '2', conf: 'S' } },
            { indice: 1, valor: 'texto libre' },
            { indice: 2, valor: null },
            { indice: 3, valor: { lentamente: 'adverbio' } },
          ],
        },
      ],
    })
    expect(s.intento('g1', 'ana')!.secciones[0]!.respuestas.map((r) => r.confianza)).toEqual([
      'S',
      undefined,
      undefined,
      undefined,
    ])
    // Y el valor se guardó verbatim, canónico: nada se interpretó.
    expect(s.intento('g1', 'ana')!.secciones[0]!.respuestas.map((r) => r.valorJson)).toEqual([
      '{"choice":"2","conf":"S"}',
      '"texto libre"',
      'null',
      '{"lentamente":"adverbio"}',
    ])
  })

  it('`checked` y `score` ausentes quedan NULL, no 0 — la ausencia es información', async () => {
    const s = await abrir()
    s.publicarInstrumento(base())
    s.guardarIntento({
      instrumentoId: 'g1',
      estudiante: 'ana',
      seccionActual: 0,
      totalSecciones: 2,
      secciones: [
        { seccion: 0, respuestas: [], revisada: false, correctas: 0, total: 3 },
        { seccion: 1, respuestas: [] },
      ],
    })
    const secs = s.intento('g1', 'ana')!.secciones
    expect(secs[0]).toMatchObject({ revisada: false, correctas: 0, total: 3 })
    expect(secs[1]!.revisada).toBeUndefined()
    expect(secs[1]!.correctas).toBeUndefined()
    expect(secs[1]!.total).toBeUndefined()
  })

  it('bloquear y guardarRevision persisten y se leen', async () => {
    const s = await abrir()
    s.publicarInstrumento(base())
    const it = s.guardarIntento({
      instrumentoId: 'g1',
      estudiante: 'ana',
      seccionActual: 0,
      totalSecciones: 1,
      secciones: [{ seccion: 0, respuestas: [{ indice: 0, valor: 'a' }] }],
    })
    expect(it.bloqueado).toBe(false)

    expect(s.bloquear(it.id)).toBe(true)
    expect(s.intento('g1', 'ana')!.bloqueado).toBe(true)
    expect(s.bloquear('intento-que-no-existe')).toBe(false)

    const rev = { score: '6/10', form: 'F', comments: [{ fondo: 'ok', forma: 'tildes', comment: 'revisa' }] }
    expect(s.guardarRevision(it.id, 0, rev, '2026-03-01T00:00:00.000Z')).toBe(true)
    expect(s.guardarRevision(it.id, 9, rev)).toBe(false) // sección inexistente
    const leido = s.intento('g1', 'ana')!
    expect(JSON.parse(leido.secciones[0]!.revisionJson!)).toEqual(rev)
    expect(leido.revisadoAt).toBe('2026-03-01T00:00:00.000Z')
  })
})

describe('reportes', () => {
  it('se guardan, se leen por id y se listan por estudiante', async () => {
    const s = await abrir()
    s.guardarReporte({ id: 'r1', estudiante: 'ana', titulo: 'Uno', relacionados: ['g1'], sprintOrden: 3 })
    s.guardarReporte({ id: 'r2', estudiante: 'beto', titulo: 'Dos' })
    expect(s.reporte('r1')).toMatchObject({ titulo: 'Uno', relacionados: ['g1'], sprintOrden: 3 })
    expect(s.reportes('ana').map((r) => r.id)).toEqual(['r1'])
    expect(s.reportes().map((r) => r.id)).toEqual(['r1', 'r2'])
    // Un segundo guardado del mismo id reemplaza (el reporte es un artefacto regenerable).
    s.guardarReporte({ id: 'r1', estudiante: 'ana', titulo: 'Uno bis', relacionados: [] })
    expect(s.reporte('r1')?.titulo).toBe('Uno bis')
  })
})

describe('plano de control', () => {
  it('reopen con OTRA época conserva los datos y actualiza el estado del guard', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'vergis-eval-'))
    const file = join(dir, 'evaluaciones.sqlite')
    try {
      const s = await SqliteEvaluacionesStore.open(file, { epoch: 1, writer: 'nodo-a' })
      s.publicarInstrumento(base())
      s.guardarIntento({
        instrumentoId: 'g1',
        estudiante: 'ana',
        seccionActual: 0,
        totalSecciones: 1,
        secciones: [{ seccion: 0, respuestas: [{ indice: 0, valor: 'a' }] }],
      })
      expect(s.controlStatus()?.epoch).toBe(1)
      expect(s.controlStatus()?.schemaSupported).toBe(1)

      await s.reopen({ epoch: 2, writer: 'nodo-b' })
      expect(s.controlStatus()?.epoch).toBe(2)
      expect(s.controlStatus()?.writer).toBe('nodo-b')
      // Lo que había en disco sigue ahí tras el swap.
      expect(s.instrumento('g1')?.sha256).toBe('aaa')
      expect(s.intento('g1', 'ana')!.secciones[0]!.respuestas.length).toBe(1)
      await s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
