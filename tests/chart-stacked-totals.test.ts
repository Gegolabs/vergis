// #359 · El TOTAL de cada barra apilada, rotulado.
//
// Nació de PI-32 (A.R.B.O.L.): el especificador pidió «agregar total mensual al gráfico. Que el total
// sea visible y con valores abreviados», y su spec ya lo decía. En apilado el Producto no rotulaba
// nada (#203 fuerza `mode = 'none'` porque los rótulos de segmento se pisarían).
//
// Lo que se mide: (1) que el total rotulado sea la Σ de los segmentos de SU barra —también con series
// colapsadas en «(otras)»—, (2) el formato (abbr por defecto, `format` respetado), (3) el opt-out,
// (4) que el agrupado no cambie, (5) que las marcas de dato conserven su cardinalidad —el instrumento
// del lab cuenta `aria-roledescription="bar"`—, (6) horizontal, y (7) la anti-colisión de #97 con
// barras angostas.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assignLanesSigned, labelledDomain, markTopPx, renderHtmlPiece, stackTotals, totalsPadFraction, type ResolvedNode } from '@vergis/capabilities'
import { parseSpec, validateSpec, OTHER_SERIES_LABEL } from '@vergis/mira'
import { VergisError, type Capability } from '@vergis/botler'
import { runSpec } from '@vergis/cli'

async function render(piece: unknown): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ piece: piece as ResolvedNode, title: 'T', theme: 'arbol' }, { agent: 't' })) as {
    html: string
  }
  return html
}

/** 3 categorías × 3 series, con totales distintos entre sí y valores que exigen abreviar. */
const BASE = {
  type: 'distribution',
  dimensionField: 'mes',
  orientation: 'vertical',
  stacked: true,
  metricsSpec: [
    { field: 'a', label: 'Venta' },
    { field: 'b', label: 'Traslado' },
    { field: 'c', label: 'Otro' },
  ],
  rows: [
    { mes: 'Enero', a: 1_200_000, b: 500_000, c: 34_000 },
    { mes: 'Febrero', a: 2_000_000, b: 250_000, c: 1_000 },
    { mes: 'Marzo', a: 800_000, b: 900_000, c: 450_000 },
  ],
}

type Rotulo = { cat: string; text: string; x: number; y: number }

/** Los rótulos del TOTAL: el `aria-label` los identifica (`<cat> · Total — <valor>`). */
function totales(html: string): Rotulo[] {
  return [
    ...html.matchAll(/<text aria-label="([^"]*) · Total — ([^"]*)"[^>]*transform="translate\(([-\d.]+),([-\d.]+)\)"[^>]*>([^<]*)<\/text>/g),
  ].map((m) => {
    expect(m[5]).toBe(m[2]) // el texto visible y la llave accesible dicen lo mismo
    return { cat: m[1]!, text: m[2]!, x: Number(m[3]), y: Number(m[4]) }
  })
}

/** Nº de marcas de DATO: lo que cuenta el instrumento del lab. */
function nBarras(html: string): number {
  return (html.match(/<path[^>]*aria-roledescription="bar"/g) ?? []).length
}

/** Geometría de cada segmento: `d="M<x>,<y>h<w>v<h>…"`, junto con su categoría (del aria-label). */
function segmentos(html: string): { cat: string; x: number; y: number; w: number; h: number }[] {
  return [...html.matchAll(/<path aria-label="([^"·]*) · [^"]*"[^>]*aria-roledescription="bar" d="M([-\d.]+),([-\d.]+)h([-\d.]+)v([-\d.]+)/g)].map(
    (m) => ({ cat: m[1]!.trim(), x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) }),
  )
}

describe('#359 · stackTotals (puro)', () => {
  it('Σ por categoría, y las puntas de la pila por signo', () => {
    // 2 categorías × 3 series, en orden (categoría × serie).
    const t = stackTotals([1, 2, 3, 10, -4, 1], 2, 3)
    expect(t.total).toEqual([6, 7])
    expect(t.pos).toEqual([6, 11])
    expect(t.neg).toEqual([0, -4])
    // El rótulo se ancla en la punta del lado del signo del total.
    expect(t.anchor).toEqual([6, 11])
    expect(stackTotals([-5, 1], 1, 2).anchor).toEqual([-5])
  })
})

describe('#359 · total de cada barra apilada', () => {
  it('(1) un rótulo por barra, y su valor es la Σ de los segmentos de ESA barra', async () => {
    const t = totales(await render(BASE))
    expect(t).toHaveLength(3)
    const porCat = Object.fromEntries(t.map((r) => [r.cat, r.text]))
    // 1.734.000 · 2.251.000 · 2.150.000 en abbr.
    expect(porCat).toEqual({ Enero: '1,7M', Febrero: '2,3M', Marzo: '2,2M' })
  })

  it('(1) vertical: el rótulo va SOBRE su barra — centrado en su banda y justo encima del tope', async () => {
    // El apilado vertical dibuja cada pila dentro de un grupo propio (el redondeo de la punta), así
    // que la x del `<path>` es local. Se contrasta contra la geometría que el motor fija: la banda de
    // la categoría (ancho 320 / 3) y el tope de la pila en la escala lineal cuyo dominio fijamos.
    const html = await render(BASE)
    const t = totales(html)
    const orden = ['Febrero', 'Marzo', 'Enero'] // `magnitude`: por la suma, de mayor a menor
    const pos = { Enero: 1_734_000, Febrero: 2_251_000, Marzo: 2_150_000 } as Record<string, number>
    const textos = t.map((r) => r.text)
    const domain = labelledDomain(Object.values(pos), totalsPadFraction(false, 'single', textos, 260))!
    for (const r of t) {
      const i = orden.indexOf(r.cat)
      expect(Math.abs(r.x - (i + 0.5) * (320 / 3))).toBeLessThan(0.5)
      const tope = markTopPx(pos[r.cat]!, domain, 260)
      expect(r.y).toBeLessThan(tope) // encima, no dentro
      expect(tope - r.y).toBeLessThan(12)
      expect(r.y).toBeGreaterThan(10.5) // y no mochado contra el techo del lienzo
    }
    // Control: el tope predicho es el de la pila DIBUJADA — la suma de los altos de los segmentos
    // de Febrero es exactamente lo que va del piso (260) a ese tope. Si el dominio que fijamos no
    // fuera el que Vega usó, esto no cuadraría.
    const altoFebrero = segmentos(html)
      .filter((sg) => sg.cat === 'Febrero')
      .reduce((acc, sg) => acc + Math.abs(sg.h), 0)
    expect(altoFebrero).toBeCloseTo(260 - markTopPx(pos['Febrero']!, domain, 260), 3)
  })

  it('(1) con series colapsadas en «(otras)»: el total incluye el colapso y cuadra con el dato largo', async () => {
    // 10 series > CHART_MAX_SERIES (8): las dos últimas se colapsan. El total de cada mes tiene que
    // ser la suma de las DIEZ, no de las ocho visibles.
    const largo: Record<string, unknown>[] = []
    for (const mes of ['Enero', 'Febrero']) {
      for (let s = 0; s < 10; s++) largo.push({ mes, zona: `Z${s}`, total: mes === 'Enero' ? 100 + s : 1000 * (s + 1) })
    }
    const html = await renderSpec(largo, '        stacked: true')
    expect(html).toContain(OTHER_SERIES_LABEL)
    const porCat = Object.fromEntries(totales(html).map((r) => [r.cat, r.text]))
    // Enero: Σ(100..109) = 1045 → «1K» (abbr). Febrero: 1000·Σ(1..10) = 55.000 → «55K».
    // Sin «(otras)» serían 836 y 36.000: el test distingue los dos.
    expect(porCat).toEqual({ Enero: '1K', Febrero: '55K' })
  })

  it('(2) formato: abbr por defecto; el `format` declarado se respeta', async () => {
    expect(totales(await render(BASE)).map((r) => r.text)).toContain('2,3M')
    const conFormato = totales(await render({ ...BASE, format: 'int_0' }))
    expect(conFormato.map((r) => r.text).sort()).toEqual(['1.734.000', '2.150.000', '2.251.000'])
  })

  it('(2) el total también en el tooltip de cada segmento (`<title>` y `aria-label`)', async () => {
    const html = await render(BASE)
    expect(html).toContain('<title>Enero · Venta — 1,2M (total 1,7M)</title>')
    expect(html).toContain('aria-label="Enero · Venta — 1,2M (total 1,7M)"')
  })

  it('(3) `totals: false` no emite la capa ni toca el tooltip', async () => {
    const html = await render({ ...BASE, totals: false })
    expect(totales(html)).toHaveLength(0)
    expect(html).not.toContain('mark-text role-mark')
    expect(html).not.toContain('(total ')
    expect(html).toContain('<title>Enero · Venta — 1,2M</title>')
  })

  it('(3) `totals: false` llega desde el YAML (compose lo propaga)', async () => {
    const largo = [
      { mes: 'Enero', zona: 'N', total: 10 },
      { mes: 'Enero', zona: 'S', total: 5 },
    ]
    expect(totales(await renderSpec(largo, '        stacked: true'))).toHaveLength(1)
    expect(totales(await renderSpec(largo, '        stacked: true\n        totals: false'))).toHaveLength(0)
  })

  it('(4) agrupado (no apilado): sin rótulo de total y sin cambios en el tooltip — `totals` no le aplica', async () => {
    const agrupado = { ...BASE, stacked: false }
    const html = await render(agrupado)
    expect(totales(html)).toHaveLength(0)
    expect(html).not.toContain('(total ')
    // Los rótulos por sub-barra siguen ahí, y `totals` no altera ni un byte del agrupado.
    expect(html).toContain('mark-text role-mark')
    expect(await render({ ...agrupado, totals: false })).toBe(html)
    expect(await render({ ...agrupado, totals: true })).toBe(html)
  })

  it('(5) la capa del total NO cambia la cardinalidad de las marcas de dato', async () => {
    for (const orientation of ['vertical', 'horizontal']) {
      const con = await render({ ...BASE, orientation })
      const sin = await render({ ...BASE, orientation, totals: false })
      // Control positivo: el contador ve las 9 marcas (3 × 3) — no es un «0 = 0».
      expect(nBarras(sin)).toBe(9)
      expect(nBarras(con)).toBe(9)
      expect(totales(con)).toHaveLength(3)
    }
  })

  it('(6) horizontal: el rótulo va a la DERECHA de su barra, y cabe en el lienzo', async () => {
    const html = await render({ ...BASE, orientation: 'horizontal' })
    const t = totales(html)
    expect(t).toHaveLength(3)
    const segs = segmentos(html)
    for (const r of t) {
      const mios = segs.filter((s) => s.cat === r.cat)
      const fin = Math.max(...mios.map((s) => s.x + s.w))
      expect(r.x).toBeGreaterThan(fin)
      expect(r.x - fin).toBeLessThan(6)
      // Centrado en su banda (alto 120 / 3); `baseline: middle` baja la línea base ~0,3 em.
      const i = ['Febrero', 'Marzo', 'Enero'].indexOf(r.cat)
      expect(Math.abs(r.y - (i + 0.5) * 40)).toBeLessThan(4)
      // El borde derecho del rótulo no pasa el ancho del plot (360 px): no se corta.
      expect(r.x + r.text.length * 6.5).toBeLessThanOrEqual(360)
    }
    // Y en apilado horizontal ya no se rotula cada segmento (se fundían con el vecino): solo el total.
    expect(html.match(/<text[^>]*aria-roledescription="text mark"/g) ?? []).toHaveLength(3)
  })

  it('(8) total NEGATIVO: el rótulo va FUERA de la barra, del lado de su punta — vertical y horizontal', async () => {
    // Caso del juez (H-01): Enero = −500 −300 (total −800) junto a Febrero positivo. Con el anclaje
    // del positivo, el texto caía DENTRO del segmento de la punta negativa.
    const neg = {
      ...BASE,
      metricsSpec: BASE.metricsSpec.slice(0, 2),
      rows: [{ mes: 'Enero', a: -500, b: -300 }, { mes: 'Febrero', a: 400, b: 200 }],
      sortSpec: { kind: 'chrono' },
    }
    // Vertical: la línea base (`baseline: top`) queda BAJO la punta negativa, y el rótulo no se sale
    // del lienzo por abajo.
    const v = await render(neg)
    const tv = totales(v)
    expect(tv.map((r) => r.text).sort()).toEqual(['-800', '600'])
    const domain = labelledDomain([0, 600, -800, 0], totalsPadFraction(false, 'single', ['-800', '600'], 260))!
    const puntaNeg = markTopPx(-800, domain, 260)
    const e = tv.find((r) => r.cat === 'Enero')!
    // Vega emite la LÍNEA BASE alfabética: con `baseline: top` la baja ~0,8 em (≈ 8,8 px) bajo el
    // ancla. La tinta de dígitos (≈ 8 px sobre la línea base) queda entonces entera bajo la punta.
    expect(e.y - 8).toBeGreaterThan(puntaNeg) // fuera: la tinta no toca [cero, punta]
    expect(e.y - puntaNeg).toBeLessThan(16)
    expect(e.y).toBeLessThanOrEqual(260) // y no se sale del lienzo por abajo
    // Control: el positivo sigue SOBRE su punta.
    const f = tv.find((r) => r.cat === 'Febrero')!
    expect(f.y).toBeLessThan(markTopPx(600, domain, 260))
    // Control de la geometría predicha: la pila de Enero dibujada mide lo que va del cero a la punta.
    const altoEnero = segmentos(v).filter((sg) => sg.cat === 'Enero').reduce((acc, sg) => acc + Math.abs(sg.h), 0)
    expect(altoEnero).toBeCloseTo(puntaNeg - markTopPx(0, domain, 260), 3)

    // Horizontal: `align: right`, a la IZQUIERDA de la punta negativa (el ancla es el borde derecho
    // del texto), y el texto entero cabe en el lienzo.
    const h = await render({ ...neg, orientation: 'horizontal' })
    const segs = segmentos(h)
    const eh = totales(h).find((r) => r.cat === 'Enero')!
    const izq = Math.min(...segs.filter((sg) => sg.cat === 'Enero').map((sg) => Math.min(sg.x, sg.x + sg.w)))
    expect(eh.x).toBeLessThan(izq)
    expect(izq - eh.x).toBeLessThan(6)
    expect(eh.x - eh.text.length * 6.5).toBeGreaterThanOrEqual(0)
    expect(h).toMatch(/aria-label="Enero · Total — -800"[^>]*text-anchor="end"/)
    // Control: el positivo sigue a la DERECHA de su punta.
    const fh = totales(h).find((r) => r.cat === 'Febrero')!
    const der = Math.max(...segs.filter((sg) => sg.cat === 'Febrero').map((sg) => Math.max(sg.x, sg.x + sg.w)))
    expect(fh.x).toBeGreaterThan(der)
  })

  it('(8) carriles con negativos: el carril alto de un negativo BAJA, y vecinos de distinto signo no se estorban', () => {
    // Dos negativos con puntas casi iguales: el segundo sube de carril (lane 1). Un positivo en medio
    // corta la vecindad: no hereda la línea base del negativo.
    expect(assignLanesSigned([200, 202], [true, true])).toEqual([0, 1])
    expect(assignLanesSigned([200, 202, 204], [true, false, true])).toEqual([0, 0, 0])
    expect(assignLanesSigned([50, 52], [false, false])).toEqual([0, 1])
  })

  it('(7) barras angostas: los totales van en carriles y ninguno se solapa con su vecino', async () => {
    // 24 barras con `int_0` (rótulos de 9 caracteres ≈ 60 px) no caben en un carril a 26 px/barra.
    const rows = Array.from({ length: 24 }, (_, i) => ({ mes: `M${String(i + 1).padStart(2, '0')}`, a: 1_000_000 + i * 7_919, b: 234_567 }))
    const html = await render({ ...BASE, metricsSpec: BASE.metricsSpec.slice(0, 2), rows, format: 'int_0', sort: undefined, sortSpec: { kind: 'chrono' } })
    const t = totales(html)
    expect(t).toHaveLength(24) // siempre visible: ninguno se oculta
    expect(new Set(t.map((r) => Math.round(r.y))).size).toBeGreaterThan(1) // hay más de un carril
    const ancho = (s: string) => s.length * 6.5
    for (let i = 0; i < t.length; i++) {
      for (let j = i + 1; j < t.length; j++) {
        const a = t[i]!
        const b = t[j]!
        const cruzanX = Math.abs(a.x - b.x) < (ancho(a.text) + ancho(b.text)) / 2
        const cruzanY = Math.abs(a.y - b.y) < 10.5
        expect(cruzanX && cruzanY, `${a.cat} (${a.text}) y ${b.cat} (${b.text}) se solapan`).toBe(false)
      }
    }
    // Ningún rótulo del carril alto se sale por arriba del lienzo: la línea base queda al menos a la
    // altura de tinta de un rótulo de dígitos (7,93 px medidos para «1.234.567», ver LABEL_INK_H_PX).
    for (const r of t) expect(r.y).toBeGreaterThanOrEqual(8)
  })
})

// ── Validación y end-to-end ──────────────────────────────────────────────────────────────────────
const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']

const spec = (extra: string): string => `
mira_version: "1.0"
identity: { id: pi-totales, display_name: "Totales", classification: internal }
piece:
  layout: grid
  columns: 1
  elements:
    - distribution:
        dimension: data.cruce.mes
        metric: data.cruce.total
        series: zona
        orientation: vertical
        title: "Por zona"
${extra}
data:
  cruce:
    capability: mock-sql
    params: { sql: "SELECT mes, zona, total FROM dbo.x" }
    shape: { fields: { mes: string, zona: string, total: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

async function renderSpec(rows: Record<string, unknown>[], extra: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-totales-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, spec(extra))
  const mock: Capability = { name: 'mock-sql', async execute() { return { rows } } }
  const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mock] })
  expect(out.ok).toBe(true)
  return out.html ?? ''
}

describe('#359 · validación de `totals`', () => {
  const codeOf = (extra: string): string => {
    try {
      validateSpec(parseSpec(spec(extra)), { capabilities: CAPS, schema: SCHEMA })
    } catch (e) {
      return e instanceof VergisError ? String(e.structured.code ?? '') : `no-vergis-error: ${String(e)}`
    }
    return 'no-throw'
  }

  it('acepta `totals: false` y `totals: true`', () => {
    expect(codeOf('        stacked: true\n        totals: false')).toBe('no-throw')
    expect(codeOf('        stacked: true\n        totals: true')).toBe('no-throw')
  })

  it('rechaza un `totals` que no es booleano: la cadena "false" dejaría el rótulo prendido en silencio', () => {
    expect(codeOf('        stacked: true\n        totals: "false"')).toBe('distribution-totals-not-boolean')
  })
})
