// #97 · Anti-colisión de los rótulos de valor en barras VERTICALES angostas.
//
// Dos niveles de verificación: (1) el helper puro `labelMode()` con sus bordes exactos, y (2) la
// geometría del SVG emitido — se miden las posiciones reales de los `<text>` de la capa de rótulos y
// se exige que ningún par de vecinos se solape, usando la misma métrica de ancho calibrada que decide
// el modo. El modo `single` (rótulos que caben) debe seguir produciendo UNA sola capa de texto.
import { describe, expect, it } from 'vitest'
import {
  renderHtmlPiece,
  labelMode,
  labelWidthPx,
  barStepPx,
  lanesPadFraction,
  assignLanes,
  markTopPx,
  type ResolvedNode,
} from '@vergis/capabilities'

/** Altura de tinta de un rótulo a 11 px (calibrada en Chrome); el motor usa la misma cota. */
const INK_H = 10.5

/** Alzada de la tinta sobre la línea base (máximo medido: 8,02 px) — lo que sube el texto. */
const ASCENT = 8.1

/**
 * Capas de rótulos de datos con sus `<text>` en coordenadas ABSOLUTAS del lienzo (el `dy` del carril
 * ya viene aplicado por Vega en el `translate` del texto). Los grupos de marcas pueden estar anidados
 * bajo facetas con su propio `translate`, así que se acumulan los desplazamientos por la pila de `<g>`.
 */
function labelLayers(html: string): { x: number; y: number; txt: string }[][] {
  const stack: { cls: string; x: number; y: number }[] = [{ cls: '', x: 0, y: 0 }]
  const offsets: { x: number; y: number }[] = []
  for (const m of html.matchAll(/<\/?g\b[^>]*>/g)) {
    const tag = m[0]
    const top = stack[stack.length - 1]
    if (tag.startsWith('</')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const t = tag.match(/transform="translate\((-?[\d.]+),(-?[\d.]+)\)"/)
    const c = tag.match(/class="([^"]*)"/)
    const cls = c ? c[1] : ''
    const node = { cls, x: top.x + (t ? Number(t[1]) : 0), y: top.y + (t ? Number(t[2]) : 0) }
    stack.push(node)
    if (/mark-text role-mark/.test(cls)) offsets.push({ x: node.x, y: node.y })
  }
  const out: { x: number; y: number; txt: string }[][] = []
  let i = 0
  for (const g of html.matchAll(/<g class="mark-text role-mark[^"]*"[^>]*>([\s\S]*?)<\/g>/g)) {
    const off = offsets[i++] ?? { x: 0, y: 0 }
    const capa = [...g[1].matchAll(/<text[^>]*transform="translate\((-?[\d.]+),(-?[\d.]+)\)"[^>]*>([^<]*)<\/text>/g)].map(
      (m) => ({ x: off.x + Number(m[1]), y: off.y + Number(m[2]), txt: m[3] }),
    )
    if (capa.length) out.push(capa)
  }
  return out
}

/**
 * Pares de rótulos que se leen como uno solo: TODOS los pares (no solo los vecinos en el orden de
 * dibujo) cuyas cajas se cruzan en x y cuyas líneas base distan menos que la mancha de tinta. Se mide
 * contra la geometría real del SVG, con la misma métrica de ancho con la que el motor decidió.
 */
function solapes(rot: { x: number; y: number; txt: string }[]): string[] {
  const b = rot.map((r) => ({ ...r, x0: r.x - labelWidthPx(r.txt) / 2, x1: r.x + labelWidthPx(r.txt) / 2 }))
  const malos: string[] = []
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const cruzanX = b[i].x0 < b[j].x1 && b[j].x0 < b[i].x1
      if (cruzanX && Math.abs(b[i].y - b[j].y) < INK_H) {
        malos.push(`${b[i].txt}@${b[i].x.toFixed(0)},${b[i].y.toFixed(0)} | ${b[j].txt}@${b[j].x.toFixed(0)},${b[j].y.toFixed(0)}`)
      }
    }
  }
  return malos
}

async function render(piece: ResolvedNode): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol' }, { agent: 't' })) as {
    html: string
  }
  return html
}

/** `distribution` mono vertical con N categorías del mismo orden de magnitud. */
function mono(n: number, valor: (i: number) => number, format?: string): ResolvedNode {
  return {
    type: 'distribution',
    dimensionField: 'p',
    metricField: 'v',
    orientation: 'vertical',
    sortSpec: { kind: 'chrono' },
    ...(format ? { format } : {}),
    rows: Array.from({ length: n }, (_, i) => ({ p: `c${i}`, v: valor(i) })),
  } as ResolvedNode
}

describe('#97 · helper puro: modo de rótulos', () => {
  it('sin rótulos no hay colisión posible', () => {
    expect(labelMode([], 5)).toBe('single')
  })
  it('cabe en un carril ⇒ single', () => {
    // '204K' = 4 × 6,5 = 26 px + 2 de aire = 28 ⇒ cabe en un paso de 30.
    expect(labelMode(['204K', '99'], 30)).toBe('single')
  })
  it('borde exacto de single: ancho + aire == paso', () => {
    expect(labelMode(['204K'], 28)).toBe('single')
    expect(labelMode(['204K'], 27.99)).toBe('lanes')
  })
  it('no cabe en uno pero sí alternando dos ⇒ lanes', () => {
    expect(labelMode(['88,9K', '204K'], 20)).toBe('lanes')
  })
  it('borde exacto de lanes: ancho + aire == 2 pasos', () => {
    // '88,9K' = 5 × 6,5 = 32,5 + 2 = 34,5 ⇒ con paso 17,25 son exactamente dos carriles.
    expect(labelMode(['88,9K'], 17.25)).toBe('lanes')
    expect(labelMode(['88,9K'], 17.24)).toBe('none')
  })
  it('no cabe ni alternando ⇒ none (la legibilidad manda)', () => {
    expect(labelMode(['1.234.567'], 20)).toBe('none')
  })
  it('manda el rótulo MÁS ANCHO, no el promedio', () => {
    expect(labelMode(['3', '4', '1.234.567'], 20)).toBe('none')
  })
})

describe('#97 · paso entre marcas vecinas', () => {
  it('mono: el paso es el reparto uniforme del ancho (medido idéntico en el SVG)', () => {
    expect(barStepPx(320, 12, 1)).toBeCloseTo(26.67, 1)
    expect(barStepPx(320, 3, 1)).toBeCloseTo(106.67, 1)
  })
  it('agrupado: las sub-barras de una categoría van más juntas que el reparto uniforme', () => {
    expect(barStepPx(468, 9, 2)).toBeLessThan(468 / 18)
    expect(barStepPx(468, 9, 2)).toBeCloseTo(18.72, 2)
  })
  it('degenerado (cero barras) no divide por cero', () => {
    expect(Number.isFinite(barStepPx(320, 0, 1))).toBe(true)
  })
})

describe('#97 · holgura del carril alto', () => {
  it('en el alto del agrupado vertical (260 px) pide ~16%', () => {
    // Separación (4) + alzada (21) + tinta (10,5) = 35,5 px de techo ⇒ f = 35,5 / (260 − 35,5).
    expect(lanesPadFraction(260)).toBeCloseTo(0.158, 3)
  })
  it('en un lienzo bajo pide más holgura', () => {
    expect(lanesPadFraction(120)).toBeGreaterThan(lanesPadFraction(400))
  })
  it('nunca baja del 10% histórico', () => {
    expect(lanesPadFraction(10000)).toBeCloseTo(0.1, 5)
  })
})

describe('#97 · reparto de carriles', () => {
  it('barras a distinta altura no gastan el carril de repuesto', () => {
    expect(assignLanes([100, 60, 20])).toEqual([0, 0, 0])
  })
  it('barras casi iguales alternan: la segunda sube', () => {
    expect(assignLanes([100, 100, 100, 100])).toEqual([0, 1, 0, 1])
  })
  it('el desnivel que CANCELA la alzada no vuelve a colisionar (el modo de falla de la paridad ciega)', () => {
    // Con paridad ciega, un techo 21 px más bajo cancela exactamente la alzada del carril alto y los
    // dos rótulos quedan a 0 px: acá el segundo se queda en el carril bajo, a 21 px del primero.
    expect(assignLanes([100, 121])).toEqual([0, 0])
  })
  it('ningún par de vecinos queda a menos de una mancha de tinta, para cualquier serie de techos', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 260
    for (let caso = 0; caso < 400; caso++) {
      const tops = Array.from({ length: 20 }, rnd)
      const lanes = assignLanes(tops)
      const base = tops.map((t, i) => t - lanes[i] * 21)
      for (let i = 1; i < base.length; i++) expect(Math.abs(base[i] - base[i - 1])).toBeGreaterThanOrEqual(INK_H)
    }
  })
})

describe('#97 · predicción del techo de la marca', () => {
  it('el máximo del dominio queda en el techo del plot y el mínimo en el piso', () => {
    expect(markTopPx(100, [0, 100], 260)).toBe(0)
    expect(markTopPx(0, [0, 100], 260)).toBe(260)
    expect(markTopPx(50, [0, 100], 260)).toBe(130)
  })
  it('dominio degenerado no divide por cero', () => {
    expect(markTopPx(5, [5, 5], 260)).toBe(260)
  })
})

describe('#97 · render: mono vertical', () => {
  it('pocas categorías ⇒ UNA capa de rótulos (comportamiento histórico)', async () => {
    const capas = labelLayers(await render(mono(3, (i) => 100000 + i * 1000)))
    expect(capas.length).toBe(1)
    expect(capas[0].length).toBe(3)
    expect(solapes(capas[0])).toEqual([])
  })

  it('12 categorías con rótulos que se cruzan en x: cero solapes y ningún rótulo perdido', async () => {
    // Rótulos de 5 caracteres (32,5 px) sobre un paso de 26,7: las cajas se cruzan, así que el motor
    // entra en modo `lanes`. Los valores alternados ya separan las líneas base, y el reparto lo
    // aprovecha: nadie sube al carril alto y aun así no hay un solo par ilegible.
    const capas = labelLayers(await render(mono(12, (i) => (i % 2 === 0 ? 88900 : 204000))))
    expect(capas.length).toBe(1)
    expect(capas.flat().length).toBe(12)
    expect(solapes(capas.flat())).toEqual([])
  })

  it('con todas las barras iguales sí hacen falta los dos carriles, a la alzada declarada (21 px)', async () => {
    const capas = labelLayers(await render(mono(12, () => 100000)))
    expect(capas.length).toBe(2)
    expect(capas.flat().length).toBe(12)
    expect(Math.abs(capas[0][0].y - capas[1][0].y)).toBeCloseTo(21, 5)
    expect(solapes(capas.flat())).toEqual([])
  })

  it('desnivel de barras del tamaño de la alzada (el caso que cancelaba el carril): cero solapes', async () => {
    // 408 px de plot y dominio ~0..1,14M ⇒ 21 px de rótulo son ~59K de dato: la escalera de 59K por
    // barra es exactamente el desnivel que anulaba una alzada fija repartida por paridad.
    const capas = labelLayers(await render(mono(12, (i) => 300000 + i * 59000)))
    expect(capas.flat().length).toBe(12)
    expect(solapes(capas.flat())).toEqual([])
  })

  it('el rótulo del carril alto no se corta contra el techo del lienzo', async () => {
    // Todas las barras al máximo ⇒ el carril alto se usa justo donde menos techo hay.
    const capas = labelLayers(await render(mono(12, () => 999000)))
    expect(capas.length).toBe(2)
    // `y` es la línea base del texto en coordenadas del lienzo, y el techo del plot está en y=5 (el
    // padding del lienzo): sobre él, el rótulo saldría mochado. Lo que sobresale de la línea base es
    // la alzada de la tinta.
    for (const c of capas.flat()) expect(c.y - ASCENT).toBeGreaterThanOrEqual(5)
  })

  it('rótulos larguísimos en un chart angosto ⇒ el chart NO rotula', async () => {
    const html = await render(mono(12, (i) => 1234567 + i, 'int_0'))
    expect(labelLayers(html).length).toBe(0)
    // Las barras siguen dibujándose: lo que se omite es el rótulo, no el dato.
    expect(html).toContain('aria-roledescription="bar"')
  })

  it('horizontal no se toca: una sola capa aunque haya muchas categorías', async () => {
    const html = await render({ ...mono(12, () => 88900), orientation: 'horizontal' } as ResolvedNode)
    const capas = labelLayers(html)
    expect(capas.length).toBe(1)
    expect(capas[0].length).toBe(12)
  })
})

describe('#97 · render: agrupado vertical', () => {
  const grouped = (n: number, valor: (i: number, s: number) => number): ResolvedNode =>
    ({
      type: 'distribution',
      dimensionField: 'pais',
      orientation: 'vertical',
      sortSpec: { kind: 'chrono' },
      metricsSpec: [
        { field: 'a', label: 'Kilos 2025' },
        { field: 'b', label: 'Kilos 2024' },
      ],
      rows: Array.from({ length: n }, (_, i) => ({ pais: `p${i}`, a: valor(i, 0), b: valor(i, 1) })),
    }) as ResolvedNode

  it('9 países × 2 series (el caso de la foto) ⇒ dos carriles y cero solapes', async () => {
    const html = await render(grouped(9, (i, s) => (s === 0 ? 684000 - i * 60000 : 605000 - i * 55000)))
    const capas = labelLayers(html)
    expect(capas.length).toBe(2)
    expect(capas.flat().length).toBe(18)
    expect(solapes(capas.flat())).toEqual([])
  })

  it('2 categorías × 2 series ⇒ sigue en una sola capa (sin regresión)', async () => {
    const capas = labelLayers(await render(grouped(2, (i, s) => 1200000 + i + s)))
    expect(capas.length).toBe(1)
    expect(capas[0].length).toBe(4)
  })

  it('el caso que la paridad ciega NO resolvía: series casi empatadas por categoría, cero solapes', async () => {
    // 9 categorías donde las dos series difieren ~20 px de plot: con carriles alternados por paridad
    // la alzada se cancelaba contra ese desnivel y los rótulos quedaban fundidos de a pares.
    const html = await render(grouped(9, (i, s) => (s === 0 ? 684000 - i * 60000 : 605000 - i * 55000)))
    const capas = labelLayers(html)
    expect(capas.flat().length).toBe(18)
    expect(solapes(capas.flat())).toEqual([])
  })
})
