// #421 · Los valores negativos van en rojo por convención de plataforma, con salida declarable por
// columna o por elemento (`negative: plain`).
//
// Lo pidió la certificación interna de una instalación beta, para todos los informes: notas de crédito,
// márgenes y costos con signo que no se distinguían. La decisión la toma el valor MOSTRADO (un `-0,4`
// con `int_0` se ve `0` y no se pinta), con UNA sola función para el SSR y el runtime del cliente, porque
// si divergen la tabla hidratada y la SSR se pintan distinto.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  renderHtmlPiece,
  vtFormat,
  vtIsNeg,
  vtNegCls,
  vtGroupHeadCells,
  TABLE_RUNTIME_SOURCE,
  type ResolvedNode,
} from '@vergis/capabilities'
import { parseSpec, validateSpec } from '@vergis/mira'

describe('vtIsNeg · decide el texto mostrado', () => {
  it.each([
    ['-5', true],
    ['-1.234.567', true],
    ['-12,5%', true],
    ['-1,2M', true],
    ['-340K', true],
    ['−7', true], // signo menos tipográfico
    ['0', false],
    ['-0', false],
    ['-0,0', false],
    ['5', false],
    ['—', false],
    ['-', false],
    ['2026-10-21', false],
    ['-abc', false],
    ['', false],
  ])('%s → %s', (txt, esperado) => {
    expect(vtIsNeg(txt)).toBe(esperado)
  })

  it('un -0,4 con int_0 se muestra 0 y no se pinta; con decimales sí', () => {
    expect(vtIsNeg(vtFormat(-0.4, 'int_0'))).toBe(false)
    expect(vtIsNeg(vtFormat(-0.4, 'percent_1'))).toBe(true) // -40.0%
    expect(vtIsNeg(vtFormat('-17', 'int_0'))).toBe(true) // BIGINT como string
  })

  it('la salida plain apaga la clase', () => {
    expect(vtNegCls(undefined, '-5')).toBe(' vt-neg')
    expect(vtNegCls('plain', '-5')).toBe('')
    expect(vtNegCls(undefined, '5')).toBe('')
  })
})

const FILAS = [
  { linea: 'A', monto: 1500, margen: -200, desv: -3 },
  { linea: 'B', monto: -4000, margen: 300, desv: 2 },
  { linea: 'C', monto: 0, margen: -0.4, desv: -1 },
]

function tabla(over: Partial<ResolvedNode> = {}): ResolvedNode {
  return {
    type: 'table',
    title: 'Ventas',
    columnsSpec: [
      { field: 'linea', label: 'Línea' },
      { field: 'monto', label: 'Monto', format: 'int_0', align: 'right', total: 'sum' },
      { field: 'margen', label: 'Margen', format: 'int_0', align: 'right' },
      { field: 'desv', label: 'Desviación', format: 'int_0', align: 'right', negative: 'plain' },
    ],
    rows: FILAS,
    interactive: true,
    ...over,
  }
}

async function html(piece: ResolvedNode, print = false): Promise<string> {
  const out = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'roble', print }, { agent: 'test' })) as { html: string }
  return out.html
}
const cuerpo = (h: string): string => (/<tbody>([\s\S]*?)<\/tbody>/.exec(h) ?? ['', ''])[1]
const pie = (h: string): string => (/<tfoot>([\s\S]*?)<\/tfoot>/.exec(h) ?? ['', ''])[1]
const cuenta = (s: string): number => (s.match(/vt-neg/g) ?? []).length

describe('SSR · tabla', () => {
  it('solo las celdas negativas mostradas llevan vt-neg: -4.000 y -200 (el -0,4 se ve 0; desv es plain)', async () => {
    const h = await html(tabla())
    expect(cuenta(cuerpo(h))).toBe(2)
    expect(cuerpo(h)).toMatch(/align-right vt-neg"[^>]*>-4\.000</)
    expect(cuerpo(h)).toMatch(/align-right vt-neg"[^>]*>-200</)
  })

  it('el total al pie negativo va en rojo (1.500 − 4.000 + 0 = −2.500)', async () => {
    const h = await html(tabla())
    expect(pie(h)).toMatch(/vt-total vt-neg" data-total-field="monto">-2\.500</)
  })

  it('CONTROL: con todas las columnas plain no hay ni una vt-neg en la tabla', async () => {
    const cols = (tabla().columnsSpec ?? []).map((c) => ({ ...c, negative: 'plain' as const }))
    const h = await html(tabla({ columnsSpec: cols }))
    expect(cuenta(cuerpo(h)) + cuenta(pie(h))).toBe(0)
  })
})

describe('runtime del cliente · misma decisión que el SSR', () => {
  // vtCell vive en el pegamento del DOM; se evalúa tal como viaja al navegador, con las funciones puras.
  const glue = ['vtEsc', 'vtColorBg', 'vtCell']
    .map((n) => {
      const m = new RegExp(`function ${n}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`).exec(TABLE_RUNTIME_SOURCE)
      if (!m) throw new Error(`el runtime no define ${n}`)
      return m[0]
    })
    .join('\n')
  const vtCell = new Function(
    `${vtIsNeg.toString()}\n${vtNegCls.toString()}\n${vtFormat.toString()}\n${glue}\nreturn vtCell;`,
  )() as (col: Record<string, unknown>, r: Record<string, unknown>) => string

  it('las celdas del cliente pintan exactamente las mismas que el SSR', async () => {
    const cols = tabla().columnsSpec as unknown as Record<string, unknown>[]
    const cliente = FILAS.map((r) => cols.map((c) => vtCell(c, r)).join('')).join('')
    expect(cuenta(cliente)).toBe(cuenta(cuerpo(await html(tabla()))))
    expect(cuenta(cliente)).toBe(2)
  })

  it('el subtotal de un grupo negativo lleva vt-neg', () => {
    const cols = tabla().columnsSpec as Parameters<typeof vtGroupHeadCells>[0]
    const celdas = vtGroupHeadCells(cols, [FILAS[1]], 0, 'Línea: B (1)', 0)
    expect(celdas).toMatch(/vt-gtotal vt-neg" data-total-field="monto">-4\.000</)
    expect(vtGroupHeadCells(cols, [FILAS[0]], 0, 'Línea: A (1)', 0)).not.toContain('vt-neg')
  })

  it('el total al pie recalculado en el cliente alterna la clase con el valor', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain("tds[ti].classList.toggle('vt-neg'")
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtIsNeg(')
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtNegCls(')
  })
})

describe('SSR · kpi y dato', () => {
  it('el valor negativo de un kpi y de un dato va en rojo; con plain, no', async () => {
    const piece: ResolvedNode = {
      layout: 'rows',
      elements: [
        { type: 'kpi', value: -1200, label: 'Margen', format: 'int_0' },
        { type: 'kpi', value: -1200, label: 'Desviación', format: 'int_0', negative: 'plain' },
        { type: 'kpi', value: 800, label: 'Venta', format: 'int_0' },
        { type: 'dato', value: -3, label: 'Saldo', format: 'int_0' },
      ],
    } as ResolvedNode
    const h = await html(piece)
    expect(h.match(/kpi-value vt-neg/g)?.length).toBe(1)
    expect(h).toContain('dato-v vt-neg')
  })
})

describe('tema · el token --neg se lee sobre el fondo', () => {
  const lum = (hex: string): number => {
    const c = hex.replace('#', '').match(/../g)!.map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const contraste = (a: string, b: string): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
    return (x + 0.05) / (y + 0.05)
  }
  const src = readFileSync(resolve(fileURLToPath(new URL('../packages/capabilities/src/themes/roble.ts', import.meta.url))), 'utf8')
  it.each(['gruvbox', 'claro', 'blanco'])('paleta %s: --neg sobre --bg ≥ 4.5:1', (pal) => {
    const blk = src.slice(src.indexOf(`html[data-palette="${pal}"]`))
    const bg = /--bg: (#[0-9a-f]{6})/i.exec(blk)![1]
    const neg = /--neg: (#[0-9a-f]{6})/i.exec(blk)![1]
    expect(contraste(neg, bg)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('validador · negative solo acepta plain', () => {
  const SCHEMA = JSON.parse(readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8')) as object
  const spec = (col: string, kpi = '') => `
mira_version: "1.0"
identity: { id: pi-neg, display_name: "Neg", classification: internal }
piece:
  layout: rows
  elements:
    - table: { data: data.v, columns: [{ field: monto${col} }] }
${kpi}
data:
  v: { capability: mock-sql, params: { sql: "select 1 as monto" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`
  const validar = (s: string) => validateSpec(parseSpec(s), { capabilities: ['mock-sql', 'render-html-piece'], schema: SCHEMA })
  it('plain u omitido pasan', () => {
    expect(() => validar(spec(''))).not.toThrow()
    expect(() => validar(spec(', negative: plain'))).not.toThrow()
  })
  it('otro valor en la columna se rechaza con su código', () => {
    expect(() => validar(spec(', negative: red'))).toThrow(/negative-invalid|no es un valor conocido/)
  })
  it('otro valor en un kpi se rechaza', () => {
    expect(() => validar(spec('', '    - kpi: { metric: data.v.monto, label: M, negative: false }'))).toThrow(/negative/)
  })
})
