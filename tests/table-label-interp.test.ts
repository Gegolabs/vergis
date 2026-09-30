// Rótulo de columna derivado del dato (#377) — `{{data.<dataset>.<campo>}}` en `table.columns[].label`.
//
// El caso que lo motivó: PI-39 (cartera por semanas de vencimiento) tiene 13 columnas relativas a la
// semana elegida en el control de cabecera, y el especificador pidió que se llamen por la semana real
// (con la 24 elegida: W25 … W36 y +W36). Hasta aquí el rótulo era un literal fijo del spec.
//
// Cada caso de «interpola» falla contra `main`: allí el rótulo viaja con las llaves crudas.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'
import type { ResolvedNode as ComposedNode } from '@vergis/mira'
import { composePiece, parseSpec, validateSpec } from '@vergis/mira'

const TABLA = {
  table: {
    data: 'data.cartera',
    columns: [
      { field: 'cliente', label: 'Cliente' },
      { field: 'w01', label: '{{data.rotulos.l01}}', filterable: true },
      { field: 'w12p', label: '+{{ data.rotulos.l12 }}' },
    ],
  },
}
const CARTERA = { rows: [{ cliente: 'Agrícola Sur', w01: 10, w12p: 3 }] }
const SPEC_ROWS = { data: { cartera: {}, rotulos: {} } } as never
const SPEC_SINGLE = { data: { cartera: {}, rotulos: { shape: { type: 'single_row' } } } } as never

function compose(rotulos: Record<string, unknown>[], spec = SPEC_ROWS, node: Record<string, unknown> = TABLA) {
  return composePiece(node, { cartera: CARTERA, rotulos: { rows: rotulos } } as never, spec)
}
const labels = (n: ComposedNode) => n.columnsSpec?.map((c) => c.label)

describe('compose · el rótulo se interpola por request', () => {
  it('interpola desde la primera fila del dataset (shape rows)', () => {
    expect(labels(compose([{ l01: 'W25', l12: 'W36' }, { l01: 'OTRA', l12: 'OTRA' }]))).toEqual(['Cliente', 'W25', '+W36'])
  })

  it('interpola igual con shape single_row', () => {
    expect(labels(compose([{ l01: 'W25', l12: 'W36' }], SPEC_SINGLE))).toEqual(['Cliente', 'W25', '+W36'])
  })

  it('dos contextos distintos ⇒ dos juegos de rótulos distintos', () => {
    expect(labels(compose([{ l01: 'W25', l12: 'W36' }]))).toEqual(['Cliente', 'W25', '+W36'])
    expect(labels(compose([{ l01: 'W38', l12: 'W49' }]))).toEqual(['Cliente', 'W38', '+W49'])
  })

  it('dataset vacío ⇒ literal sin llaves; si no queda nada, el field — nunca un {{…}} crudo', () => {
    expect(labels(compose([]))).toEqual(['Cliente', 'w01', '+'])
  })

  it('campo nulo o dataset ausente ⇒ misma caída', () => {
    expect(labels(compose([{ l01: null, l12: undefined }]))).toEqual(['Cliente', 'w01', '+'])
    const sinDataset = composePiece(TABLA, { cartera: CARTERA } as never, SPEC_ROWS)
    expect(labels(sinDataset)).toEqual(['Cliente', 'w01', '+'])
  })

  it('no muta el spec (memoizado por mtime)', () => {
    const node = structuredClone(TABLA)
    compose([{ l01: 'W25', l12: 'W36' }], SPEC_ROWS, node)
    expect(node.table.columns[1].label).toBe('{{data.rotulos.l01}}')
  })
})

describe('render · el rótulo interpolado llega a cabecera, payload y filtro', () => {
  it('<th>, vtable-data y aria-label del filtro llevan W25', async () => {
    const nodo = { ...compose([{ l01: 'W25', l12: 'W36' }]), interactive: true } as unknown as ResolvedNode
    const out = (await renderHtmlPiece.execute({ piece: nodo, title: 'X', theme: 'arbol' }, { agent: 'test' })) as {
      html: string
    }
    expect(out.html).not.toContain('{{')
    expect(out.html).toContain('"label":"W25"')
    expect(out.html).toMatch(/<th[^>]*>[\s\S]*?W25/)
    expect(out.html).toContain('aria-label="Filtrar y buscar en W25"')
  })
})

describe('DSL · un rótulo que referencia un dataset no declarado', () => {
  const SCHEMA = JSON.parse(
    readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
  ) as object
  const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
  const BASE = (ds: string) => `
mira_version: "1.0"
identity: { id: pi-rotulo, display_name: "Rótulo", classification: internal }
piece:
  layout: rows
  elements:
    - table:
        data: data.datos
        columns:
          - { field: area }
          - { field: n, label: "{{data.${ds}.l01}}" }
data:
  datos:
    capability: mock-sql
    params: { sql: "SELECT area, n FROM dbo.datos" }
    shape: { type: rows, fields: { area: string, n: integer } }
  rotulos:
    capability: mock-sql
    params: { sql: "SELECT 'W25' AS l01" }
    shape: { type: single_row, fields: { l01: string } }
quality:
  freshness: { source_watermark: required, max_age: P1D, watermark_field: datos.area }
delivery: { render: [{ format: html, target: web }] }
`
  const validar = (ds: string) => validateSpec(parseSpec(BASE(ds)), { capabilities: CAPS, schema: SCHEMA })

  it('dataset declarado ⇒ pasa', () => {
    expect(() => validar('rotulos')).not.toThrow()
  })

  it('dataset no declarado ⇒ dangling-data-reference', () => {
    try {
      validar('rotulo')
      throw new Error('debió lanzar')
    } catch (e) {
      expect((e as { structured?: { code?: string } }).structured?.code).toBe('dangling-data-reference')
    }
  })
})
