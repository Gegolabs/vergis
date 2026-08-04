// #94 · Rótulo del valor sobre cada punto de un `series` (línea) — la contraparte de #80.
// El texto viaja PRE-COMPUTADO server-side (`__label`, Vega solo pinta), adelgazado por
// `seriesLabelStride` cuando los puntos no dan el ancho, y en dos carriles verticales alternados
// por serie (pares arriba, impares abajo) para que dos líneas cercanas no fundan sus rótulos.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, seriesLabelStride, vtFormat, type ResolvedNode } from '@vergis/capabilities'

/** Contenidos de los `<text>` de las capas de rótulos (excluye ejes y leyenda). */
function dataLabels(html: string): string[] {
  const out: string[] = []
  let i = html.indexOf('mark-text role-mark')
  while (i >= 0) {
    const seg = html.slice(i, html.indexOf('</g>', i))
    out.push(...[...seg.matchAll(/>([^<>]*)<\/text>/g)].map((m) => m[1]))
    i = html.indexOf('mark-text role-mark', i + 1)
  }
  return out
}

async function render(piece: ResolvedNode): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol' }, { agent: 't' })) as {
    html: string
  }
  return html
}

const base: Partial<ResolvedNode> = {
  type: 'series',
  xField: 'mes',
  seriesSpec: [
    { field: 'base', label: 'Base' },
    { field: 'actual', label: 'Actual' },
  ],
}

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun']
const rows = MESES.map((m, i) => ({ mes: m, base: (i + 1) * 100000, actual: (i + 1) * 120000 + 5000 }))

describe('#94 · rótulos sobre los puntos de una línea', () => {
  it('cada punto de cada serie lleva su valor formateado (abbr)', async () => {
    const html = await render({ ...base, rows } as ResolvedNode)
    const labels = dataLabels(html)
    // 6 puntos × 2 series = 12 rótulos, todos presentes
    expect(labels).toHaveLength(12)
    expect(labels).toContain(vtFormat(100000, 'abbr')) // '100K'
    expect(labels).toContain(vtFormat(725000, 'abbr')) // '725K' (Actual de Jun)
  })

  it('ANTES de #94 esto daba cero: una línea sin capa de texto no rotula nada', async () => {
    // Control del mecanismo: si alguien retira las capas, este conteo vuelve a 0 y el test cae.
    const html = await render({ ...base, rows } as ResolvedNode)
    expect(dataLabels(html).length).toBeGreaterThan(0)
  })

  it('serie única: un solo carril (arriba), un rótulo por punto', async () => {
    const html = await render({
      ...base,
      seriesSpec: [{ field: 'base', label: 'Base' }],
      rows,
    } as ResolvedNode)
    expect(dataLabels(html)).toHaveLength(6)
  })

  it('respeta el formato declarado del nodo', async () => {
    const html = await render({ ...base, rows, format: 'int_0' } as ResolvedNode)
    expect(dataLabels(html)).toContain('100.000')
  })

  it('valores no numéricos no rotulan (sin «NaN» pintado)', async () => {
    const conHueco = rows.map((r, i) => (i === 2 ? { ...r, actual: 'x' } : r))
    const html = await render({ ...base, rows: conHueco } as ResolvedNode)
    expect(dataLabels(html)).not.toContain('NaN')
  })
})

describe('#94 · seriesLabelStride (adelgazamiento por paso)', () => {
  it('pocos puntos: se rotulan todos (stride 1)', () => {
    expect(seriesLabelStride(6, ['100K', '120K'], 640)).toBe(1)
  })
  it('muchos puntos: el stride crece para que los rotulados no se fundan', () => {
    const k = seriesLabelStride(120, ['1.234.567'], 640)
    expect(k).toBeGreaterThan(1)
    // los rotulados quedan a ≥ un ancho de rótulo: k * paso ≥ ancho
    expect((k * 640) / 120).toBeGreaterThanOrEqual(48) // '1.234.567' ≈ 58,5px de calibración − holgura
  })
  it('un punto solo: stride 1 (no hay vecinos con quienes colisionar)', () => {
    expect(seriesLabelStride(1, ['1,2M'], 640)).toBe(1)
  })
  it('con muchos puntos el render adelgaza pero SIEMPRE rotula el último', async () => {
    const muchos = Array.from({ length: 60 }, (_, i) => ({ mes: `S${i + 1}`, base: 1000000 + i * 25000 }))
    const html = await render({
      ...base,
      seriesSpec: [{ field: 'base', label: 'Base' }],
      rows: muchos,
    } as ResolvedNode)
    const labels = dataLabels(html)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.length).toBeLessThan(60) // adelgazó
    expect(labels).toContain(vtFormat(1000000 + 59 * 25000, 'abbr')) // el último punto SIEMPRE
  })
})
