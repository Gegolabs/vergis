// #263 · Realce del rótulo bajo el cursor. Lo que se verifica acá es la PRECONDICIÓN del gesto: que
// punto y rótulo compartan la llave (`aria-label`) y que todos los rótulos existan en el DOM aunque
// el stride solo muestre algunos. El realce en sí lo hace el navegador; lo que viaja se comprueba
// como texto (la hoja y el script emitidos, y su ausencia en papel y sin gráficos).
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

async function render(piece: Partial<ResolvedNode>, extra: Record<string, unknown> = {}): Promise<string> {
  const { html } = (await renderHtmlPiece.execute(
    { piece: piece as ResolvedNode, title: 'X', theme: 'arbol', ...extra },
    { agent: 't' },
  )) as { html: string }
  return html
}

/** `aria-label` de los `<text>` de capas de rótulo (excluye ejes y leyenda, que no lo llevan). */
function labelKeys(html: string): string[] {
  return [...html.matchAll(/<text[^>]*aria-roledescription="text mark"[^>]*>/g)].map(
    (m) => /aria-label="([^"]*)"/.exec(m[0])?.[1] ?? '',
  )
}
/** Los mismos `<text>`, con su atributo `opacity` (los ocultos del stride traen `0`). */
function labelOpacities(html: string): string[] {
  return [...html.matchAll(/<text[^>]*aria-roledescription="text mark"[^>]*>/g)].map(
    (m) => /\sopacity="([^"]*)"/.exec(m[0])?.[1] ?? '',
  )
}
function pointKeys(html: string): string[] {
  return [...html.matchAll(/<path[^>]*aria-roledescription="point"[^>]*>/g)].map(
    (m) => /aria-label="([^"]*)"/.exec(m[0])?.[1] ?? '',
  )
}

const MESES = ['Ene', 'Feb', 'Mar']
const corta: Partial<ResolvedNode> = {
  type: 'series',
  xField: 'mes',
  seriesSpec: [{ field: 'base', label: 'Base' }],
  rows: MESES.map((m, i) => ({ mes: m, base: (i + 1) * 100000 })),
}

describe('#263 · la llave que empareja punto y rótulo', () => {
  it('cada rótulo lleva el MISMO aria-label que un punto (biyección por frase)', async () => {
    const html = await render(corta)
    const rot = labelKeys(html)
    const pts = pointKeys(html)
    expect(rot.length).toBe(3)
    expect(pts.length).toBe(3)
    // La llave es lo que el JS del realce usa para cruzar de un `<g>` al otro: sin igualdad no hay gesto.
    expect([...rot].sort()).toEqual([...pts].sort())
    expect(rot.every((k) => k.length > 0)).toBe(true)
  })

  it('con 60 puntos TODOS los rótulos existen; el stride solo los oculta', async () => {
    const muchos = Array.from({ length: 60 }, (_, i) => ({ mes: `S${i + 1}`, base: 1000000 + i * 25000 }))
    const html = await render({ ...corta, rows: muchos })
    const ops = labelOpacities(html)
    expect(ops.length).toBe(60) // existen los 60 → el hover tiene qué revelar
    const visibles = ops.filter((o) => o !== '0')
    expect(visibles.length).toBeGreaterThan(0)
    expect(visibles.length).toBeLessThan(60) // el adelgazado del stride sigue vigente
  })

  it('los `<title>` de #208 NO se duplican: el espejo sigue acotado a `<path>`', async () => {
    const html = await render(corta)
    // 3 puntos + 1 línea = 4 marcas `<path>` con título; los `<text>` no ganan ninguno.
    const titles = [...html.matchAll(/<title>/g)].length
    expect(titles).toBe(pointKeys(html).length + 1)
  })
})

describe('#263 · qué viaja y qué no', () => {
  it('un documento con gráfico trae la hoja y el runtime del realce', async () => {
    const html = await render(corta)
    expect(html).toContain('.chart text.vrz{')
    expect(html).toContain("closest('section.chart path[aria-label]')")
  })

  it('en papel NO viaja el script (#65 · D4)', async () => {
    const html = await render(corta, { print: true })
    expect(html).not.toContain("closest('section.chart path[aria-label]')")
    expect(html).not.toContain('.chart text.vrz{')
  })

  it('un documento SIN gráficos no paga ni una línea de cromo', async () => {
    const html = await render({ type: 'kpi', title: 'Solo', rows: [{ v: 1 }], metricField: 'v' } as Partial<ResolvedNode>)
    // Se busca la REGLA y el SELECTOR completos, no la subcadena `vrz`: el logo del theme viaja como
    // base64 en el header y contiene esas tres letras por casualidad — una aserción por subcadena
    // corta sobre este HTML mide el azar del encoding, no lo que se quiso medir.
    expect(html).not.toContain('.chart text.vrz{')
    expect(html).not.toContain("closest('section.chart path[aria-label]')")
  })

  it('el runtime es JS sintácticamente válido', async () => {
    const html = await render(corta)
    // El documento emite varios `<script>` (el conmutador de paleta, entre otros): se aísla el del
    // realce por su propio marcador, no por la forma genérica de una IIFE.
    const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .find((s) => s.includes("closest('section.chart path[aria-label]')"))
    expect(src).toBeTruthy()
    expect(() => new Function(src as string)).not.toThrow()
  })
})
