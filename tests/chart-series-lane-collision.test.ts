// #94 bis · Anti-colisión de los rótulos de valor de un chart `series` (líneas).
//
// Dos niveles, como en #97: (1) los helpers puros `seriesLanes` y `seriesLabelIndices` con sus bordes,
// y (2) la geometría del SVG emitido — se miden las posiciones reales de los `<text>` de las capas de
// rótulos y se exige cero pares fundidos, con la misma métrica calibrada que usa el motor.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, seriesLanes, seriesLabelIndices, labelWidthPx, type ResolvedNode } from '@vergis/capabilities'

/** Altura de tinta de un rótulo a 11 px (calibración de #97); el motor usa la misma cota. */
const INK_H = 10.5

type Lbl = { x: number; y: number; text: string }

/** `<text>` de las capas de MARCAS (dato) con posición absoluta — acumula los translate anidados. */
function dataLabels(svg: string): Lbl[] {
  const out: Lbl[] = []
  const re = /<g\b([^>]*)>|<\/g>|<text\b([^>]*)>([\s\S]*?)<\/text>/g
  const stack: { x: number; y: number; mark: boolean }[] = [{ x: 0, y: 0, mark: false }]
  let m: RegExpExecArray | null
  while ((m = re.exec(svg))) {
    if (m[0] === '</g>') {
      if (stack.length > 1) stack.pop()
      continue
    }
    if (m[1] !== undefined) {
      const t = /transform="translate\(([-\d.]+)[, ]+([-\d.]+)\)"/.exec(m[1])
      const cls = (/\bclass="([^"]*)"/.exec(m[1]) ?? [, ''])[1] as string
      const cur = stack[stack.length - 1]
      stack.push({
        x: cur.x + (t ? Number(t[1]) : 0),
        y: cur.y + (t ? Number(t[2]) : 0),
        mark: cur.mark || (/\bmark-text\b/.test(cls) && /\brole-mark\b/.test(cls)),
      })
      continue
    }
    const cur = stack[stack.length - 1]
    if (!cur.mark) continue
    const t = /transform="translate\(([-\d.]+)[, ]+([-\d.]+)\)"/.exec(m[2] as string)
    const dy = Number((/\bdy="([-\d.]+)"/.exec(m[2] as string) ?? [, '0'])[1])
    const text = (m[3] as string).replace(/<[^>]*>/g, '').trim()
    if (text) out.push({ x: cur.x + (t ? Number(t[1]) : 0), y: cur.y + (t ? Number(t[2]) : 0) + dy, text })
  }
  return out
}

/** Pares de rótulos que se leen como uno solo: cajas cruzadas en x y líneas base a menos de la tinta. */
function fusionados(labels: Lbl[]): string[] {
  const out: string[] = []
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]
      const b = labels[j]
      const dx = Math.abs(a.x - b.x)
      const dy = Math.abs(a.y - b.y)
      if (dx < (labelWidthPx(a.text) + labelWidthPx(b.text)) / 2 && dy < INK_H)
        out.push(`${a.text}@(${a.x.toFixed(1)},${a.y.toFixed(1)}) vs ${b.text}@(${b.x.toFixed(1)},${b.y.toFixed(1)})`)
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
  format: 'int_0',
  seriesSpec: [
    { field: 'base', label: 'Base' },
    { field: 'actual', label: 'Actual' },
  ],
}

/**
 * Fixture PI-17 «Acumulado Mensual — Base vs Actual»: los 7 pares rotulados son los valores MEDIDOS
 * del informe vivo (2026-08-11); los 5 meses intermedios se interpolan (no llevan rótulo por el paso,
 * y el dominio Y lo fijan el mínimo del mes 0 y el máximo del mes 11, ambos medidos).
 */
const BASE_M: Record<number, number> = { 0: 3398241, 2: 5735660, 4: 7165692, 6: 7927592, 8: 8110592, 10: 16537442, 11: 25227442 }
const ACT_M: Record<number, number> = { 0: 3439074, 2: 7530918, 4: 8470336, 6: 10177258, 8: 13545935, 10: 22682655, 11: 25726250 }
function interp(m: number, o: Record<number, number>): number {
  if (o[m] !== undefined) return o[m]
  const ks = Object.keys(o).map(Number)
  const lo = Math.max(...ks.filter((k) => k < m))
  const hi = Math.min(...ks.filter((k) => k > m))
  return Math.round(o[lo] + ((o[hi] - o[lo]) * (m - lo)) / (hi - lo))
}
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
const filasPi17 = MESES.map((mes, i) => ({ mes, base: interp(i, BASE_M), actual: interp(i, ACT_M) }))

describe('#94 bis · seriesLanes (carril por posición, no por índice de serie)', () => {
  it('el punto MÁS ALTO se lleva el carril de arriba, sin importar qué serie sea', () => {
    // La serie 1 va por encima (y menor) → le toca el carril 0 (arriba de su punto).
    expect(seriesLanes([200, 100])).toEqual([1, 0])
    // Y al revés: si la serie 0 es la de arriba, es ella quien se lo lleva.
    expect(seriesLanes([100, 200])).toEqual([0, 1])
  })

  it('reparte N series en N carriles, de arriba hacia abajo', () => {
    expect(seriesLanes([300, 100, 200])).toEqual([2, 0, 1])
  })

  it('empate: desempata por el orden de las series (determinista)', () => {
    expect(seriesLanes([150, 150, 150])).toEqual([0, 1, 2])
  })

  it('una sola serie: siempre el carril de arriba', () => {
    expect(seriesLanes([42])).toEqual([0])
  })

  it('la asignación NO depende del orden en que vienen las series', () => {
    const [a, b] = seriesLanes([120, 80])
    const [b2, a2] = seriesLanes([80, 120])
    expect([a, b]).toEqual([a2, b2])
  })
})

describe('#94 bis · seriesLabelIndices (qué puntos rotulan)', () => {
  it('pocos puntos y rótulos cortos: rotulan todos', () => {
    expect(seriesLabelIndices(6, ['100', '120'], 640)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('siempre incluye el último punto', () => {
    const idx = seriesLabelIndices(60, ['1.234.567'], 640)
    expect(idx).toContain(59)
  })

  it('retira el vecino que quedaría a menos de un ancho de rótulo del último', () => {
    // 12 puntos, paso 640/12 ≈ 53,3 px; '10.177.258' mide ≈ 65 px ⇒ paso 2. La grilla daría
    // …,8,10 y el forzado agrega 11: 10 y 11 quedan a un solo paso ⇒ el 10 se retira.
    const idx = seriesLabelIndices(12, ['10.177.258'], 640)
    expect(idx).toContain(11)
    expect(idx).not.toContain(10)
    expect(idx).toContain(8)
  })

  it('no retira nada cuando el último ya cae en la grilla del paso', () => {
    // 13 puntos con paso 2: la grilla llega a 12, que ES el último ⇒ nadie se retira.
    const idx = seriesLabelIndices(13, ['10.177.258'], 640)
    expect(idx).toContain(12)
    expect(idx).toContain(10)
  })

  it('cero puntos: ninguna rotulación (y no explota)', () => {
    expect(seriesLabelIndices(0, [], 640)).toEqual([])
  })
})

describe('#94 bis · geometría del SVG: cero rótulos fundidos', () => {
  it('fixture PI-17 (Base vs Actual, curvas cercanas): ningún par fundido', async () => {
    const html = await render({ ...base, rows: filasPi17 } as ResolvedNode)
    const labels = dataLabels(html)
    expect(labels.length).toBeGreaterThan(0) // control: si no hay rótulos, el 0 de abajo es vacuo
    expect(fusionados(labels)).toEqual([])
  })

  it('el resultado NO cambia si se invierte el orden de las series (el carril lo decide el dato)', async () => {
    const directo = dataLabels(await render({ ...base, rows: filasPi17 } as ResolvedNode))
    const invertido = dataLabels(
      await render({
        ...base,
        seriesSpec: [
          { field: 'actual', label: 'Actual' },
          { field: 'base', label: 'Base' },
        ],
        rows: filasPi17,
      } as ResolvedNode),
    )
    const clave = (l: Lbl[]) => l.map((p) => `${p.text}@${p.x.toFixed(1)},${p.y.toFixed(1)}`).sort()
    expect(clave(invertido)).toEqual(clave(directo))
    expect(fusionados(invertido)).toEqual([])
  })

  it('tres series entrelazadas: ningún par fundido', async () => {
    const rows = MESES.map((mes, i) => ({
      mes,
      base: 1000000 + i * 90000,
      actual: 1020000 + i * 88000,
      plan: 990000 + i * 92000,
    }))
    const html = await render({
      ...base,
      seriesSpec: [
        { field: 'base', label: 'Base' },
        { field: 'actual', label: 'Actual' },
        { field: 'plan', label: 'Plan' },
      ],
      rows,
    } as ResolvedNode)
    const labels = dataLabels(html)
    expect(labels.length).toBeGreaterThan(0)
    expect(fusionados(labels)).toEqual([])
  })

  it('dos series IDÉNTICAS (puntos superpuestos): los rótulos siguen separados', async () => {
    const rows = MESES.map((mes, i) => ({ mes, base: 1000000 + i * 500000, actual: 1000000 + i * 500000 }))
    const html = await render({ ...base, rows } as ResolvedNode)
    expect(fusionados(dataLabels(html))).toEqual([])
  })

  it('serie única: ningún par fundido y el último punto rotulado', async () => {
    const html = await render({
      ...base,
      seriesSpec: [{ field: 'base', label: 'Base' }],
      rows: filasPi17,
    } as ResolvedNode)
    const labels = dataLabels(html)
    expect(fusionados(labels)).toEqual([])
    expect(labels.map((l) => l.text)).toContain('25.227.442')
  })
})
