// #441 · Color de celda por valor categórico: una columna de `table` declara `tones: {<valor>: <tono>}`.
//
// Lo pidió PI-38 de A.R.B.O.L. para su columna Status (Entregado verde, En Proceso azul, Atrasado rojo,
// Eliminado blanco, Sin Información amarillo), sin distinguir mayúsculas ni tildes. La decisión es UNA
// función (`vtToneCls`) que usan el SSR y el runtime del cliente, igual que `vtNegCls` (#421): si
// divergen, la tabla hidratada y la servida se pintan distinto.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  renderHtmlPiece,
  vtFormat,
  vtIsNeg,
  vtNegCls,
  vtToneKey,
  vtToneCls,
  TABLE_TONES,
  TABLE_RUNTIME_SOURCE,
  TABLE_RUNTIME_SOURCE_TONES,
  type ResolvedNode,
} from '@vergis/capabilities'
import { TABLE_TONES_CSS } from '../packages/capabilities/src/piece-css'
import { TABLE_TONE_NAMES } from '../packages/mira/src/dsl/validate'
import { composePiece, parseSpec, validateSpec, type MiraSpec } from '@vergis/mira'

const STATUS_TONES = {
  Entregado: 'green',
  'En Proceso': 'blue',
  Atrasado: 'red',
  Eliminado: 'neutral',
  'Sin Información': 'yellow',
}

// Los valores llegan como los escribe la planilla: mayúsculas, tildes y espacios variados.
const FILAS = [
  { programa: 'P1', status: 'Entregado', monto: 10 },
  { programa: 'P2', status: 'EN PROCESO', monto: -5 },
  { programa: 'P3', status: ' en proceso ', monto: 7 },
  { programa: 'P4', status: 'atrasado', monto: 3 },
  { programa: 'P5', status: 'Eliminado', monto: 1 },
  { programa: 'P6', status: 'SIN INFORMACION', monto: 2 },
  { programa: 'P7', status: 'Pendiente', monto: 4 }, // sin tono declarado → neutro
  { programa: 'P8', status: null, monto: 0 },
]

function tabla(over: Partial<ResolvedNode> = {}): ResolvedNode {
  return {
    type: 'table',
    title: 'Programas',
    columnsSpec: [
      { field: 'programa', label: 'Programa' },
      { field: 'status', label: 'Status', tones: STATUS_TONES },
      { field: 'monto', label: 'Monto', format: 'int_0', align: 'right' },
    ],
    rows: FILAS,
    interactive: true,
    ...over,
  }
}

async function html(piece: ResolvedNode, opts: { print?: boolean; theme?: string } = {}): Promise<string> {
  const out = (await renderHtmlPiece.execute(
    { piece, title: 'X', theme: opts.theme ?? 'roble', print: opts.print ?? false },
    { agent: 'test' },
  )) as { html: string }
  return out.html
}
const cuerpo = (h: string): string => (/<tbody>([\s\S]*?)<\/tbody>/.exec(h) ?? ['', ''])[1]
const tonos = (s: string): string[] => [...s.matchAll(/vt-tone-([a-z]+)/g)].map((m) => m[1])

describe('vtToneKey · la comparación no distingue mayúsculas, tildes ni espacios de borde', () => {
  it.each([
    ['Sin Información', 'sin informacion'],
    ['SIN INFORMACION', 'sin informacion'],
    ['  sin información  ', 'sin informacion'],
    ['En Proceso', 'en proceso'],
    ['ÁÉÍÓÚ ñ Ü', 'aeiou n u'],
    [null, ''],
    [undefined, ''],
    [12, '12'],
  ])('%j → %j', (v, k) => {
    expect(vtToneKey(v)).toBe(k)
  })

  it('no colapsa espacios internos: «En  Proceso» con dos espacios es otro valor', () => {
    expect(vtToneKey('En  Proceso')).not.toBe(vtToneKey('En Proceso'))
  })
})

describe('vtToneCls · color por valor', () => {
  it('cada valor declarado, escrito de cualquier forma, da su tono', () => {
    expect(vtToneCls(STATUS_TONES, 'Entregado')).toBe(' vt-tone vt-tone-green')
    expect(vtToneCls(STATUS_TONES, 'EN PROCESO')).toBe(' vt-tone vt-tone-blue')
    expect(vtToneCls(STATUS_TONES, ' en proceso ')).toBe(' vt-tone vt-tone-blue')
    expect(vtToneCls(STATUS_TONES, 'ATRASADO')).toBe(' vt-tone vt-tone-red')
    expect(vtToneCls(STATUS_TONES, 'sin informacion')).toBe(' vt-tone vt-tone-yellow')
    expect(vtToneCls(STATUS_TONES, 'Eliminado')).toBe(' vt-tone vt-tone-neutral')
  })

  it('un valor sin tono declarado, vacío o nulo queda neutro (sin clase)', () => {
    expect(vtToneCls(STATUS_TONES, 'Pendiente')).toBe('')
    expect(vtToneCls(STATUS_TONES, '')).toBe('')
    expect(vtToneCls(STATUS_TONES, null)).toBe('')
    expect(vtToneCls(undefined, 'Entregado')).toBe('')
  })

  it('la llave declarada también se normaliza: «sin informacion» en el spec pinta «Sin Información» del dato', () => {
    expect(vtToneCls({ 'sin informacion': 'yellow' }, 'Sin Información')).toBe(' vt-tone vt-tone-yellow')
  })

  it('un tono que no es una palabra no se inyecta como clase (render invocado sin validador)', () => {
    expect(vtToneCls({ x: 'red" onclick="y' }, 'x')).toBe('')
    expect(vtToneCls({ x: '#ff0000' }, 'x')).toBe('')
  })
})

describe('SSR · la celda lleva su tono y conserva su texto', () => {
  it('las ocho filas: verde, azul, azul, rojo, neutral, amarillo y dos sin clase', async () => {
    const b = cuerpo(await html(tabla()))
    expect(tonos(b)).toEqual(['green', 'blue', 'blue', 'red', 'neutral', 'yellow'])
  })

  it('el color nunca es la única señal: el texto del valor sigue en la celda tal cual vino', async () => {
    const b = cuerpo(await html(tabla()))
    expect(b).toMatch(/vt-tone-green">Entregado</)
    expect(b).toMatch(/vt-tone-blue">EN PROCESO</)
    expect(b).toMatch(/vt-tone-yellow">SIN INFORMACION</)
  })

  it('el documento trae el CSS de tonos y la variante del runtime que los conoce', async () => {
    const h = await html(tabla())
    expect(h).toContain('.table td.vt-tone-green{')
    expect(h).toContain(`<script>${TABLE_RUNTIME_SOURCE_TONES}</script>`)
    expect(h).not.toContain(`<script>${TABLE_RUNTIME_SOURCE}</script>`)
  })

  it('también en la tabla estática y en papel (sin runtime)', async () => {
    const est = await html(tabla({ interactive: false }))
    expect(tonos(cuerpo(est))).toHaveLength(6)
    expect(est).toContain('.table td.vt-tone-red{')
    const papel = await html(tabla(), { print: true })
    expect(tonos(cuerpo(papel))).toHaveLength(6)
    expect(papel).toContain('.table td.vt-tone-red{')
    expect(papel).not.toContain(TABLE_RUNTIME_SOURCE_TONES)
  })

  it('convive con el rojo de negativos de otra columna (#421)', async () => {
    const b = cuerpo(await html(tabla()))
    expect(b).toMatch(/align-right vt-neg"[^>]*>-5</)
  })

  it('con tono, el fondo de magnitud cede en esa celda', async () => {
    const node = tabla({
      columnsSpec: [{ field: 'monto', label: 'Monto', colorscale: true, tones: { '10': 'green' } }],
    })
    const b = cuerpo(await html(node))
    expect(b).toMatch(/<td class="align-left vt-tone vt-tone-green">10</) // sin style="--mag"
    expect(b).toMatch(/<td class="align-left" style="--mag:[^"]+">7</)
  })
})

describe('runtime del cliente · misma decisión que el SSR', () => {
  const glue = ['vtEsc', 'vtColorBg', 'vtCell']
    .map((n) => {
      const m = new RegExp(`function ${n}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`).exec(TABLE_RUNTIME_SOURCE_TONES)
      if (!m) throw new Error(`el runtime no define ${n}`)
      return m[0]
    })
    .join('\n')
  const armar = (toneKeySrc: string) =>
    new Function(
      `${vtIsNeg.toString()}\n${vtNegCls.toString()}\n${vtFormat.toString()}\n${toneKeySrc}\n${vtToneCls.toString()}\n${glue}\nreturn vtCell;`,
    )() as (col: Record<string, unknown>, r: Record<string, unknown>) => string
  const vtCell = armar(vtToneKey.toString())

  // Las columnas del payload EMITIDO, no las del spec: así se mide lo que de verdad viaja.
  const colsDelPayload = (h: string): Record<string, unknown>[] => {
    const m = /<script type="application\/json" class="vtable-data">([\s\S]*?)<\/script>/.exec(h)
    if (!m) throw new Error('la tabla no emitió su payload')
    return (JSON.parse(m[1]) as { cols: Record<string, unknown>[] }).cols
  }

  it('las celdas del cliente, con las columnas del payload, llevan los mismos tonos que el SSR', async () => {
    const h = await html(tabla())
    const cols = colsDelPayload(h)
    expect(cols.find((c) => c['field'] === 'status')?.['tones']).toEqual(STATUS_TONES)
    const cliente = FILAS.map((r) => cols.map((c) => vtCell(c, r)).join('')).join('')
    expect(tonos(cliente)).toEqual(tonos(cuerpo(h)))
  })

  it('CONTROL NEGATIVO: con una normalización que distingue mayúsculas, el cliente pierde tonos', async () => {
    const sensible = armar('function vtToneKey(v){ return String(v==null?"":v) }')
    const cols = colsDelPayload(await html(tabla()))
    const cliente = FILAS.map((r) => cols.map((c) => sensible(c, r)).join('')).join('')
    expect(tonos(cliente)).toEqual(['green', 'neutral']) // solo los dos que ya venían escritos igual
  })

  it('la variante con tonos difiere del runtime de siempre solo en las dos funciones y la celda', () => {
    expect(TABLE_RUNTIME_SOURCE).not.toContain('vtToneCls')
    expect(TABLE_RUNTIME_SOURCE_TONES).toContain('function vtToneKey(')
    expect(TABLE_RUNTIME_SOURCE_TONES).toContain('function vtToneCls(')
    expect(TABLE_RUNTIME_SOURCE_TONES).toContain('var tone=col.tones ? vtToneCls(col.tones, raw)')
    const sinCelda = (s: string) => s.replace(/function vtCell\(col, r\)\{[\s\S]*?\n\}/, '')
    const base = sinCelda(TABLE_RUNTIME_SOURCE)
    const tonosSrc = sinCelda(TABLE_RUNTIME_SOURCE_TONES)
      .replace(vtToneKey.toString() + '\n', '')
      .replace(vtToneCls.toString() + '\n', '')
    expect(tonosSrc).toBe(base)
  })
})

describe('no-regresión · una tabla sin tones no recibe ni un byte de la capacidad', () => {
  const sinTonos = (): ResolvedNode =>
    tabla({
      columnsSpec: [
        { field: 'programa', label: 'Programa' },
        { field: 'status', label: 'Status' },
        { field: 'monto', label: 'Monto', format: 'int_0', align: 'right', total: 'sum' },
      ],
    })

  it.each([
    ['interactiva · roble', {}, {}],
    ['estática · roble', { interactive: false }, {}],
    ['papel · roble', {}, { print: true }],
    ['interactiva · default', {}, { theme: 'default' }],
  ] as const)('%s', async (_n, over, opts) => {
    const h = await html({ ...sinTonos(), ...over }, opts)
    expect(h).not.toContain('vt-tone')
    expect(h).not.toContain('--tone-')
    expect(h).not.toContain('"tones"')
    expect(h).not.toContain('vtToneCls')
    if (!('print' in opts) && !('interactive' in over)) expect(h).toContain(`<script>${TABLE_RUNTIME_SOURCE}</script>`)
  })

  it('la celda del runtime de siempre es la de antes de #441, letra por letra', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain(
      `function vtCell(col, r){
  var raw=r[col.field]; var text=vtFormat(raw, col.format);
  var bg=col.colorscale ? vtColorBg(Number(raw), col.ranges) : '';
  return '<td class="align-'+(col.align||'left')+vtNegCls(col.negative, text, raw)+'"'+bg+'>'+vtEsc(text)+'</td>';
}`,
    )
  })
})

describe('tema · el texto de cada tono se lee sobre su fondo (AA ≥ 4.5:1) en claro y en oscuro', () => {
  const lum = (hex: string): number => {
    const c = hex.replace('#', '').match(/../g)!.map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const contraste = (a: string, b: string): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
    return (x + 0.05) / (y + 0.05)
  }
  const pintados = TABLE_TONES.filter((t) => t !== 'neutral')
  const oscuro = TABLE_TONES_CSS.slice(TABLE_TONES_CSS.indexOf('html[data-palette="gruvbox"]'))

  it.each(pintados)('%s · claro (fallback del CSS)', (t) => {
    const m = new RegExp(`vt-tone-${t}\\{background:var\\(--tone-${t}-bg,(#[0-9a-f]{6})\\);color:var\\(--tone-${t}-fg,(#[0-9a-f]{6})\\)\\}`).exec(TABLE_TONES_CSS)
    expect(m, `falta la regla de ${t}`).not.toBeNull()
    expect(contraste(m![1], m![2])).toBeGreaterThanOrEqual(4.5)
  })

  it.each(pintados)('%s · oscuro (paleta gruvbox)', (t) => {
    const bg = new RegExp(`--tone-${t}-bg:(#[0-9a-f]{6})`).exec(oscuro)![1]
    const fg = new RegExp(`--tone-${t}-fg:(#[0-9a-f]{6})`).exec(oscuro)![1]
    expect(contraste(bg, fg)).toBeGreaterThanOrEqual(4.5)
  })

  it('neutral no pinta nada: declara «sin color» a propósito', () => {
    expect(TABLE_TONES_CSS).not.toContain('vt-tone-neutral')
  })
})

describe('compose · los tonos viajan del spec a la columna resuelta', () => {
  it('composePiece conserva el mapa tal cual', () => {
    const spec = { data: { v: {} } } as unknown as MiraSpec
    const node = composePiece(
      { table: { data: 'data.v', columns: [{ field: 'status', tones: STATUS_TONES }, { field: 'monto' }] } },
      { v: { rows: FILAS } } as never,
      spec,
    )
    expect(node.columnsSpec?.[0].tones).toEqual(STATUS_TONES)
    expect(node.columnsSpec?.[1]).not.toHaveProperty('tones')
  })
})

describe('validador · tones', () => {
  const spec = (tones: string) => `
mira_version: "1.0"
identity: { id: pi-tones, display_name: "Tonos", classification: internal }
piece:
  layout: rows
  elements:
    - table: { data: data.v, columns: [{ field: status${tones} }] }
data:
  v: { capability: mock-sql, params: { sql: "select 'Entregado' as status" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`
  const SCHEMA = JSON.parse(readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8')) as object
  const validar = (s: string) => validateSpec(parseSpec(s), { capabilities: ['mock-sql', 'render-html-piece'], schema: SCHEMA })
  const codigo = (s: string): string => {
    try {
      validar(s)
    } catch (e) {
      return String((e as { structured?: { code?: string } }).structured?.code ?? (e as Error).message)
    }
    return 'ok'
  }

  it('el vocabulario del validador es el mismo del render', () => {
    expect([...TABLE_TONE_NAMES]).toEqual([...TABLE_TONES])
  })

  it('sin tones, o con tonos del vocabulario, pasa', () => {
    expect(codigo(spec(''))).toBe('ok')
    expect(codigo(spec(', tones: { "Entregado": green, "En Proceso": blue, "Atrasado": red, "Eliminado": neutral, "Sin Información": yellow }'))).toBe('ok')
  })

  it('un tono desconocido rechaza la spec con mensaje que nombra el valor y los tonos válidos', () => {
    expect(codigo(spec(', tones: { "Entregado": verde }'))).toBe('table-column-tone-unknown')
    expect(() => validar(spec(', tones: { "Entregado": verde }'))).toThrow(/'Entregado'.*'verde'/)
  })

  it('un color hex no es un tono', () => {
    expect(codigo(spec(', tones: { "Entregado": "#00ff00" }'))).toBe('table-column-tone-unknown')
  })

  it('tones que no es un mapa se rechaza', () => {
    expect(codigo(spec(', tones: [green]'))).toBe('table-column-tones-invalid')
    expect(codigo(spec(', tones: green'))).toBe('table-column-tones-invalid')
  })

  it('dos llaves que se normalizan igual con tonos distintos son ambiguas', () => {
    expect(codigo(spec(', tones: { "Atrasado": red, "ATRASADO": yellow }'))).toBe('table-column-tones-ambiguous')
    expect(codigo(spec(', tones: { "Atrasado": red, "ATRASADO": red }'))).toBe('ok')
  })
})
