// #210 · El color de magnitud es del USUARIO, y su rampa no es roja.
//
// El antecedente: `colorscaleBg` pintaba `hsl(8, 75%, L%)` —hue 8 es rojo— y oscurecía a medida que
// el valor crecía. O sea: la cifra más grande era la más roja. En un informe de negocio el rojo
// significa «malo», no «mucho»; el cliente lo leyó así y pidió quitarlo, y la instancia retiró los
// 44 `colorscale` de sus 7 specs.
//
// Lo que se mide acá: (1) que ninguna celda salga roja, (2) que el color nazca APAGADO —la celda
// trae su posición en la rampa, no un color— y (3) que el interruptor viva en la bandeja.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, magnitudeColumns, MAGNITUDE_CSS, type ResolvedNode, type TableColumn } from '@vergis/capabilities'

const ROWS = [
  { local: 'Norte', ventas: 100, margen: 5 },
  { local: 'Sur', ventas: 500, margen: 9 },
  { local: 'Este', ventas: 300, margen: 7 },
]

async function render(node: Partial<ResolvedNode>): Promise<string> {
  const { html } = (await renderHtmlPiece.execute(
    { piece: { type: 'table', rows: ROWS, interactive: false, ...node } as ResolvedNode, title: 'T', theme: 'arbol' },
    { agent: 't' },
  )) as { html: string }
  return html
}

const COLS = (extra: Partial<TableColumn> = {}): TableColumn[] =>
  [
    { field: 'local', label: 'Local' },
    { field: 'ventas', label: 'Ventas', ...extra },
    { field: 'margen', label: 'Margen' },
  ] as TableColumn[]

/** Los valores de `--mag` emitidos por las celdas, en orden de aparición. */
function mags(html: string): number[] {
  return [...html.matchAll(/--mag:([\d.]+)/g)].map((m) => Number(m[1]))
}

describe('#210 · la rampa no es roja', () => {
  it('ninguna celda emite el rojo cableado que el cliente pidió quitar', async () => {
    const html = await render({ columnsSpec: COLS({ colorscale: true }) })
    // El control exacto del defecto original: `hsl(8, 75%, L%)`.
    expect(html).not.toMatch(/background:\s*hsl\(8[,\s]/)
    expect(html).not.toMatch(/hsl\(8,\s*75%/)
  })

  it('la rampa la fija el THEME por variable, no el render por literal', async () => {
    const html = await render({ columnsSpec: COLS({ colorscale: true }) })
    // El hue viaja como variable CSS; el render no decide el color.
    expect(html).toMatch(/--mag-h/)
    expect(html).toMatch(/hsl\(var\(--mag-h\)/)
  })
})

describe('#210 · nace apagado y lo enciende el lector', () => {
  it('la celda trae su POSICIÓN en la rampa, no un color resuelto', async () => {
    const html = await render({ columnsSpec: COLS({ colorscale: true }) })
    const vs = mags(html)
    // 100 → 0 (mínimo), 500 → 1 (máximo), 300 → 0.5. Si emitiera un color, no habría nada que leer.
    expect(vs).toEqual([0, 1, 0.5])
  })

  it('el color solo se pinta con el interruptor puesto: TODA regla que pinta está condicionada', async () => {
    const html = await render({ columnsSpec: COLS({ colorscale: true }) })
    expect(html).toContain(':root[data-magnitude="on"]')
    // El control que importa, y que hay que escribir con cuidado: no basta que EXISTA una regla
    // condicionada — hace falta que no exista NINGUNA sin condicionar. Se recorren todas las reglas
    // de la hoja de magnitud que pintan un `background` y se exige el atributo en cada selector.
    // (Dos versiones anteriores de este test no refutaban: un lookbehind que siempre pasaba, y un
    // regex sobre el HTML entero que ni matcheaba y tardaba 39 s. Se mide la hoja, no la página.)
    // Cada selector de la lista se evalúa POR SEPARADO: una regla `a, b { background }` donde solo
    // `b` lleva el atributo pinta igual a través de `a`. (Fue el tercer intento de este control: los
    // dos anteriores pasaban con el gate quitado — mirar la lista entera es no mirar.)
    const selectoresQuePintan = [...MAGNITUDE_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, , cuerpo]) => /background\s*:/.test(cuerpo!))
      .flatMap(([, sel]) => sel!.split(',').map((x) => x.trim()))
      .filter((x) => x.includes('--mag'))
    expect(selectoresQuePintan.length).toBeGreaterThan(0)
    expect(selectoresQuePintan.filter((sel) => !sel.includes('data-magnitude="on"'))).toEqual([])
  })

  it('el interruptor vive en la bandeja, apagado, y persiste por reporte', async () => {
    const html = await render({ columnsSpec: COLS({ colorscale: true }) })
    expect(html).toContain('id="vergis-magnitude"')
    expect(html).not.toMatch(/id="vergis-magnitude"[^>]*\schecked/)
    expect(html).toContain("vergis:magnitude:'+location.pathname")
  })

  it('sin tabla no hay interruptor: uno que no enciende nada es peor que su ausencia', async () => {
    const { html } = (await renderHtmlPiece.execute(
      { piece: { type: 'kpi', label: 'X', value: 1 } as unknown as ResolvedNode, title: 'T', theme: 'arbol' },
      { agent: 't' },
    )) as { html: string }
    expect(html).not.toContain('id="vergis-magnitude"')
  })
})

describe('#210 · qué columnas son candidatas', () => {
  it('sin declaración en el spec, candidatas son todas las numéricas — y solo las numéricas', () => {
    const set = magnitudeColumns(COLS(), ROWS)
    expect([...set].sort()).toEqual(['margen', 'ventas'])
  })

  it('`colorscale` en el spec ACOTA a las declaradas: la intención del autor no se pierde', () => {
    const set = magnitudeColumns(COLS({ colorscale: true }), ROWS)
    expect([...set]).toEqual(['ventas'])
  })

  it('una columna con un valor no numérico queda fuera: no hay magnitud que rampear', () => {
    const filas = [...ROWS, { local: 'Oeste', ventas: 'N/D', margen: 3 }]
    expect(magnitudeColumns(COLS(), filas).has('ventas')).toBe(false)
    expect(magnitudeColumns(COLS(), filas).has('margen')).toBe(true)
  })

  it('una columna vacía no es candidata: sin valores no hay rango', () => {
    const cols = [{ field: 'vacia', label: 'V' }] as TableColumn[]
    expect(magnitudeColumns(cols, [{ vacia: null }, { vacia: '' }]).size).toBe(0)
  })

  it('la columna de texto nunca recibe `--mag`', async () => {
    const html = await render({ columnsSpec: COLS() })
    expect(html).not.toMatch(/<td[^>]*--mag[^>]*>Norte/)
  })
})
