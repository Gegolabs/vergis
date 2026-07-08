// resolveActiveView (work/052 R3-7): la resolución de la vista activa se extrajo de MiraBotlet.invoke
// como paso PURO testeable — página activa por param (default: la 1ª), nav sin páginas-destino de
// drill (salvo la activa), datasets solo de la página activa, y pieza-guía si falta el contexto.
import { describe, expect, it } from 'vitest'
import { resolveActiveView, type MiraSpec } from '@vergis/mira'

const spec = {
  mira_version: '1.0',
  identity: { id: 'x', display_name: 'x', classification: 'internal' },
  pages: [
    { id: 'resumen', title: 'Resumen', piece: { table: { data: 'data.saldos', columns: [] } } },
    { id: 'detalle', title: 'Detalle', context: ['socio'], piece: { table: { data: 'data.docs', columns: [] } } },
  ],
  data: { saldos: { capability: 'c' }, docs: { capability: 'c' } },
  quality: {},
  delivery: {},
} as unknown as MiraSpec

describe('resolveActiveView · multi-vista', () => {
  it('sin page → la primera página; la nav omite las vistas de detalle (declaran context)', () => {
    const v = resolveActiveView(spec, undefined, {})
    expect(v.pagesNav?.active).toBe('resumen')
    expect(v.pagesNav?.items.map((i) => i.id)).toEqual(['resumen'])
    expect(v.datasetNames).toEqual(['saldos'])
    expect(v.activePiece).toBe(spec.pages![0].piece)
  })

  it('page=detalle CON contexto → la vista de detalle con sus datasets y presente en la nav', () => {
    const v = resolveActiveView(spec, 'detalle', { socio: 'A' })
    expect(v.pagesNav?.active).toBe('detalle')
    expect(v.pagesNav?.items.map((i) => i.id)).toEqual(['resumen', 'detalle'])
    expect(v.datasetNames).toEqual(['docs'])
  })

  it('page=detalle SIN contexto → pieza-guía sin datasets (no se vuelca todo)', () => {
    const v = resolveActiveView(spec, 'detalle', {})
    expect(v.datasetNames).toEqual([])
    expect(JSON.stringify(v.activePiece)).toContain('Selecciona un registro')
  })

  it('page desconocida → cae a la primera', () => {
    const v = resolveActiveView(spec, 'nope', {})
    expect(v.pagesNav?.active).toBe('resumen')
  })

  it('una vista (piece) → sin nav y con TODOS los datasets de data', () => {
    const single = { ...spec, pages: undefined, piece: { table: { data: 'data.saldos', columns: [] } } } as unknown as MiraSpec
    const v = resolveActiveView(single, undefined, {})
    expect(v.pagesNav).toBeUndefined()
    expect(v.datasetNames.sort()).toEqual(['docs', 'saldos'])
  })
})
