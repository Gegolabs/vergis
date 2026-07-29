import { describe, it, expect } from 'vitest'
import { TABLE_RUNTIME_SOURCE } from '../packages/capabilities/src/table-runtime'
import { TABLE_INTERACTIVE_CSS } from '../packages/capabilities/src/piece-css'

/**
 * Export CSV de la vista actual (issue #61 / TX-01): el runtime de tabla ofrece «Descargar CSV»
 * en la gaveta común. El handler exporta la VISTA (vtApply: filtros + búsqueda aplicados), con
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
})
