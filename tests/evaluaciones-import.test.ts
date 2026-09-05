import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SqliteEvaluacionesStore, importarDaftar, exportarProgreso, progresoAIntento } from '@vergis/capabilities'
import { VergisError } from '@vergis/botler'

/**
 * EL IMPORTADOR DE DAFTAR (doc 013 · H2) contra fixtures **sintéticas**.
 *
 * Los progresos reales de Daftar los escriben menores de edad: no entran a este repo. Las fixtures de
 * `tests/fixtures/evaluaciones/` son inventadas y cubren, una por una, las variantes que la medición
 * del 2026-09-05 encontró en los datos reales: respuesta `string`, `null`, `{choice, conf}`, mapa
 * palabra→categoría, sección sin `attempts`/`checked`/`score`, `review` en sus DOS formas, `locked`,
 * `last_reviewed`, `answers` vacío, `_finishedAt: null` y un progreso huérfano.
 *
 * La prueba que importa es el ROUND-TRIP: `exportarProgreso` tiene que reconstruir cada progreso
 * idéntico al original. Una aserción prueba lo que su autor miró; la reconstrucción prueba todo lo
 * que no miró — una clave que nadie modeló hace fallar el test sin que nadie la haya previsto.
 */

const DIR = resolve(__dirname, 'fixtures/evaluaciones')

function cargar(sub: string): { json: Record<string, unknown>; texto: Record<string, string> } {
  const json: Record<string, unknown> = {}
  const texto: Record<string, string> = {}
  for (const f of readdirSync(join(DIR, sub)).sort()) {
    if (!f.endsWith('.json')) continue
    const t = readFileSync(join(DIR, sub, f), 'utf8')
    texto[f.slice(0, -5)] = t
    json[f.slice(0, -5)] = JSON.parse(t) as unknown
  }
  return { json, texto }
}

const guides = cargar('guides')
const progress = cargar('progress')
const reports = cargar('reports')

const importar = async (
  store: SqliteEvaluacionesStore,
  over: Partial<{ guides: Record<string, unknown> }> = {},
): Promise<ReturnType<typeof importarDaftar>> =>
  importarDaftar({
    guides: over.guides ?? guides.json,
    progress: progress.json,
    reports: reports.json,
    store,
    now: '2026-09-05T00:00:00.000Z',
    guideText: guides.texto,
  })

describe('importarDaftar', () => {
  it('importa el material completo y es IDEMPOTENTE: la segunda corrida deja todo en sin-cambios', async () => {
    const store = await SqliteEvaluacionesStore.open(null)
    const uno = await importar(store)
    expect(uno.instrumentos).toEqual({ publicados: 3, sinCambios: 0, conflictos: 0 })
    expect(uno.progresos).toEqual({ importados: 3, sinCambios: 0, huerfanos: 1, conflictos: 0 })
    expect(uno.reportes).toEqual({ guardados: 1, sinCambios: 0 })
    expect(uno.filas.filter((f) => f.estado === 'importado').map((f) => f.id)).toEqual([
      '900-demo-confianza',
      '901-demo-highlight',
      '902-demo-minima',
    ])

    const dos = await importar(store)
    expect(dos.instrumentos).toEqual({ publicados: 0, sinCambios: 3, conflictos: 0 })
    expect(dos.progresos).toEqual({ importados: 0, sinCambios: 3, huerfanos: 1, conflictos: 0 })
    expect(dos.reportes).toEqual({ guardados: 0, sinCambios: 1 })
    expect(dos.filas.filter((f) => f.estado === 'importado')).toEqual([])
  })

  it('ROUND-TRIP: cada progreso importado se reconstruye deep-equal a su JSON original', async () => {
    const store = await SqliteEvaluacionesStore.open(null)
    await importar(store)
    let verificados = 0
    for (const [id, prog] of Object.entries(progress.json)) {
      const guia = guides.json[id] as { student?: string } | undefined
      if (!guia) continue // el huérfano no se importó: no hay nada que reconstruir
      verificados += 1
      expect(exportarProgreso(store, id, guia.student ?? ''), `round-trip de ${id}`).toEqual(prog)
    }
    expect(verificados).toBe(3)
  })

  it('cuenta respuestas, secciones y revisiones por guía', async () => {
    const store = await SqliteEvaluacionesStore.open(null)
    const inf = await importar(store)
    const fila = (id: string): (typeof inf.filas)[number] => inf.filas.find((f) => f.id === id)!
    expect(fila('900-demo-confianza')).toMatchObject({ respuestas: 4, secciones: 2, revisiones: 1 })
    expect(fila('901-demo-highlight')).toMatchObject({ respuestas: 3, secciones: 3, revisiones: 1 })
    expect(fila('902-demo-minima')).toMatchObject({ respuestas: 2, secciones: 1, revisiones: 0 })
  })

  it('deriva la confianza donde el valor la trae y la deja vacía donde no', async () => {
    const store = await SqliteEvaluacionesStore.open(null)
    await importar(store)
    const conf = store.intento('900-demo-confianza', 'pruebita')!.secciones[0]!.respuestas.map((r) => r.confianza)
    expect(conf).toEqual(['S', 'A', undefined])
    const mapa = store.intento('901-demo-highlight', 'pruebita')!.secciones[0]!.respuestas.map((r) => r.confianza)
    expect(mapa).toEqual([undefined, undefined])
  })

  it('el HUÉRFANO se reporta y no se importa', async () => {
    const store = await SqliteEvaluacionesStore.open(null)
    const inf = await importar(store)
    const h = inf.filas.find((f) => f.estado === 'huerfano')!
    expect(h.id).toBe('903-demo-huerfana')
    expect(h.detalle).toContain('no hay guía')
    expect(store.instrumento('903-demo-huerfana')).toBeNull()
    expect(store.intento('903-demo-huerfana', 'pruebita')).toBeNull()
  })

  it('el CONFLICTO de sha se reporta y deja el instrumento intacto', async () => {
    const store = await SqliteEvaluacionesStore.open(null)
    await importar(store)
    const shaAntes = store.instrumento('902-demo-minima')!.sha256
    const tituloAntes = store.instrumento('902-demo-minima')!.titulo

    // La misma guía con el contenido cambiado: mismo id, otro sha.
    const mutada = { ...(guides.json as Record<string, Record<string, unknown>>) }
    mutada['902-demo-minima'] = { ...mutada['902-demo-minima']!, title: 'Otro título' }
    const inf = importarDaftar({
      guides: mutada,
      progress: progress.json,
      reports: reports.json,
      store,
      now: '2026-09-06T00:00:00.000Z',
      // el texto de LA MISMA guía cambió: las demás conservan el suyo y no deben verse afectadas
      guideText: { ...guides.texto, '902-demo-minima': JSON.stringify(mutada['902-demo-minima']) },
    })
    expect(inf.filas.filter((f) => f.estado === 'conflicto').length).toBe(2) // la guía y su progreso
    const c = inf.filas.find((f) => f.estado === 'conflicto')!
    expect(c.id).toBe('902-demo-minima')
    expect(c.detalle).toBe('evaluaciones/instrumento-inmutable')
    expect(store.instrumento('902-demo-minima')!.sha256).toBe(shaAntes)
    expect(store.instrumento('902-demo-minima')!.titulo).toBe(tituloAntes)
  })
})

describe('el traductor progreso → intento', () => {
  it('preserva las claves NO modeladas y recuerda cuáles modeladas faltaban', async () => {
    const it = progresoAIntento(
      { guideId: 'g', currentSection: 0, totalSections: 1, sections: {}, cosa_rara: { a: 1 } },
      'g',
      'ana',
    )
    expect(it.extra?.extra).toEqual({ cosa_rara: { a: 1 } })
    // `_startedAt`, `_finishedAt`, `last_updated`, `last_reviewed` y `locked` no venían.
    expect(it.extra?.ausentes).toEqual(['_startedAt', '_finishedAt', 'last_updated', 'last_reviewed', 'locked'])
  })

  it('una sección con llave NO numérica es fail-closed: se niega en vez de perderla', () => {
    expect(() =>
      progresoAIntento({ guideId: 'g', currentSection: 0, totalSections: 1, sections: { intro: {} } }, 'g', 'ana'),
    ).toThrow(VergisError)
    try {
      progresoAIntento({ guideId: 'g', currentSection: 0, totalSections: 1, sections: { intro: {} } }, 'g', 'ana')
    } catch (e) {
      expect((e as VergisError).structured.code).toBe('evaluaciones/seccion-no-numerica')
    }
  })

  it('distingue «venía en null» de «no venía» — el caso que una columna NULL no puede', () => {
    const conNull = progresoAIntento(
      { guideId: 'g', currentSection: 0, totalSections: 1, _finishedAt: null, sections: {} },
      'g',
      'ana',
    )
    expect(conNull.extra?.ausentes).not.toContain('_finishedAt')
    const sinClave = progresoAIntento({ guideId: 'g', currentSection: 0, totalSections: 1, sections: {} }, 'g', 'ana')
    expect(sinClave.extra?.ausentes).toContain('_finishedAt')
  })
})
