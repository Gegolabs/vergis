import { describe, it, expect } from 'vitest'
import { TABLE_RUNTIME_SOURCE, vtCsvCell, vtCsv, vtCsvName } from '../packages/capabilities/src/table-runtime'
import { TABLE_INTERACTIVE_CSS } from '../packages/capabilities/src/piece-css'

/**
 * Export CSV de la vista actual (issue #61 / TX-01): el runtime de tabla ofrece «Descargar CSV»
 * en la bandeja común. El handler exporta la VISTA (vtApply: filtros + búsqueda aplicados), con
 * columnas visibles (las notas nunca viajan), separador ';' (Excel es-CL) y BOM UTF-8.
 */
describe('table-runtime · export CSV (issue #61)', () => {
  it('el bundle del runtime incluye el botón y el handler de export', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('vt-export')
    expect(TABLE_RUNTIME_SOURCE).toContain('Descargar CSV (vista actual)')
    // El export respeta la vista filtrada.
    expect(TABLE_RUNTIME_SOURCE).toContain('var rc = renderCols();')
    expect(TABLE_RUNTIME_SOURCE).toContain('vtApply(rows, state)')
    // BOM UTF-8 + CRLF + window.URL (lección del selector: URL pelado es frágil en scoping raro).
    expect(TABLE_RUNTIME_SOURCE).toContain("'\\ufeff'")
    expect(TABLE_RUNTIME_SOURCE).toContain('window.URL.createObjectURL')
    expect(TABLE_RUNTIME_SOURCE).toContain('window.URL.revokeObjectURL')
  })

  it('el bundle generado es JS válido (el handler no rompe la sintaxis del runtime)', () => {
    expect(() => new Function(TABLE_RUNTIME_SOURCE)).not.toThrow()
  })

  it('el CSS trae el estilo del botón de export', () => {
    expect(TABLE_INTERACTIVE_CSS).toContain('.vt-export')
  })

  it('el handler usa las funciones puras, no una copia inline', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('vtCsv(rc, view)')
    expect(TABLE_RUNTIME_SOURCE).toContain('vtCsvName(')
    // Las puras viajan al browser (están en el bundle, no solo la llamada).
    expect(TABLE_RUNTIME_SOURCE).toContain('function vtCsvCell(')
  })
})

/**
 * Comportamiento de las funciones puras del export — la MISMA fuente que viaja al browser
 * (PURE_FNS → TABLE_RUNTIME_SOURCE), testeada directo en Node como el resto del runtime.
 */
describe('vtCsvCell · la única regla de celda (GH #61 / D4-D5)', () => {
  it('cita según RFC 4180 con el separador dado', () => {
    expect(vtCsvCell('a;b', ';')).toBe('"a;b"')
    expect(vtCsvCell('a;b', ',')).toBe('a;b')
    expect(vtCsvCell('a,b', ',')).toBe('"a,b"')
    expect(vtCsvCell('x"y', ';')).toBe('"x""y"')
    expect(vtCsvCell('linea1\nlinea2', ';')).toBe('"linea1\nlinea2"')
  })

  it('null/undefined → vacío; Date → ISO fecha', () => {
    expect(vtCsvCell(null, ';')).toBe('')
    expect(vtCsvCell(undefined, ';')).toBe('')
    expect(vtCsvCell(new Date('2026-08-06T12:00:00Z'), ';')).toBe('2026-08-06')
  })

  it('valores RAW: el timestamp ISO que viene como string no se recorta ni se formatea', () => {
    expect(vtCsvCell('2026-08-06T12:00:00.000Z', ';')).toBe('2026-08-06T12:00:00.000Z')
    expect(vtCsvCell(1234.5, ';')).toBe('1234.5')
    expect(vtCsvCell(640838, ';')).toBe('640838')
  })

  it('neutraliza la formula injection de strings', () => {
    expect(vtCsvCell('=SUM(A1)', ';')).toBe("'=SUM(A1)")
    expect(vtCsvCell('=HYPERLINK("http://x")', ';')).toBe('"\'=HYPERLINK(""http://x"")"')
    expect(vtCsvCell('@x', ';')).toBe("'@x")
    expect(vtCsvCell('\tx', ';')).toBe("'\tx")
    expect(vtCsvCell('+56 9 8888', ';')).toBe("'+56 9 8888")
  })

  it('un string numérico con signo queda INTACTO (BIGINT de los drivers · bug D5 corregido)', () => {
    expect(vtCsvCell('-2644239500', ';')).toBe('-2644239500')
    expect(vtCsvCell('+123.5', ';')).toBe('+123.5')
    expect(vtCsvCell(-2644239500, ';')).toBe('-2644239500')
  })
})

describe('vtCsv · armado del CSV del cliente (GH #61 / D6)', () => {
  const cols = [{ field: 'a', label: 'Col A' }, { field: 'b' }]
  const rows = [
    { a: 'uno', b: 1, _nota_token: 'SECRETO', drillKey: 'k1' },
    { a: 'do;s', b: 2, _nota_token: 'SECRETO2', drillKey: 'k2' },
  ]

  it('header = label ?? field, líneas unidas con CRLF, celdas RAW', () => {
    const csv = vtCsv(cols, rows)
    expect(csv.split('\r\n')).toEqual(['Col A;b', 'uno;1', '"do;s";2'])
  })

  it('no antepone BOM (eso es del envoltorio)', () => {
    expect(vtCsv(cols, rows).charCodeAt(0)).not.toBe(0xfeff)
  })

  it('un campo ausente de cols NO viaja (notas y claves de drill fuera, por construcción)', () => {
    const csv = vtCsv(cols, rows)
    expect(csv).not.toContain('SECRETO')
    expect(csv).not.toContain('drillKey')
    expect(csv).not.toContain('k1')
  })
})

describe('vtCsvName · nombre del archivo (GH #61 / D7)', () => {
  it('doc + tabla + fecha + sufijo de filtrado', () => {
    expect(vtCsvName('Reporte Facturas', 'Listado', '2026-08-06', true)).toBe(
      'reporte-facturas--listado--2026-08-06--filtrado.csv',
    )
  })

  it('sin filtros no lleva sufijo', () => {
    expect(vtCsvName('Reporte Facturas', 'Listado', '2026-08-06', false)).toBe(
      'reporte-facturas--listado--2026-08-06.csv',
    )
  })

  it('omite el segmento de tabla si es vacío o igual al título', () => {
    expect(vtCsvName('Reporte', '', '2026-08-06', false)).toBe('reporte--2026-08-06.csv')
    expect(vtCsvName('Reporte', 'Reporte', '2026-08-06', false)).toBe('reporte--2026-08-06.csv')
  })

  it('título vacío → base «tabla»', () => {
    expect(vtCsvName('', 'Listado', '2026-08-06', false)).toBe('tabla--listado--2026-08-06.csv')
  })
})
