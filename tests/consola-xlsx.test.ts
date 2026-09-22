/**
 * I8 · el escritor XLSX propio (despacho P-3 de César: opción B, client-side y sin dependencia).
 *
 * Lo que se afirma acá es lo que el formato promete: el archivo es un ZIP legible, sus partes son XML
 * bien formado, los números viajan como números y **nunca se emite una fórmula** — un `=1+1` es texto.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { xlsxUnaHoja } from '@vergis/capabilities'

const escribir = (b: Uint8Array): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'xlsx-')), 'salida.xlsx')
  writeFileSync(p, b)
  return p
}
const parte = (p: string, nombre: string): string => execFileSync('unzip', ['-p', p, nombre], { encoding: 'utf8' })

describe('xlsxUnaHoja', () => {
  const bytes = xlsxUnaHoja(
    ['area', 'monto', 'nota'],
    [['Finanzas', 1500, '=1+1'], ['Producción', 900.5, null], ['Comercial', 1200, 'con "comillas" y ; punto y coma']],
  )
  const archivo = escribir(bytes)

  it('el archivo es un ZIP íntegro que `unzip -t` acepta', () => {
    const salida = execFileSync('unzip', ['-t', archivo], { encoding: 'utf8' })
    expect(salida).toContain('No errors detected')
  })

  it('trae las cinco partes que un .xlsx mínimo necesita', () => {
    const lista = execFileSync('unzip', ['-l', archivo], { encoding: 'utf8' })
    for (const p of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
      expect(lista).toContain(p)
    }
  })

  it('la hoja es XML bien formado y los números son números', () => {
    const sheet = parte(archivo, 'xl/worksheets/sheet1.xml')
    expect(sheet.startsWith('<?xml')).toBe(true)
    expect(sheet).toContain('<c r="B2"><v>1500</v></c>') // número SIN t="inlineStr"
    expect(sheet).toContain('<c r="B3"><v>900.5</v></c>')
  })

  it('un `=1+1` sale como TEXTO: jamás se emite una fórmula', () => {
    const sheet = parte(archivo, 'xl/worksheets/sheet1.xml')
    expect(sheet).not.toContain('<f>')
    expect(sheet).toContain('<c r="C2" t="inlineStr"><is><t xml:space="preserve">=1+1</t></is></c>')
  })

  it('NULL es celda ausente, y el XML escapa lo que hay que escapar', () => {
    const sheet = parte(archivo, 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<row r="3"><c r="A3"')
    expect(sheet).not.toContain('<c r="C3"') // la celda NULL no se emite
    expect(sheet).toContain('&quot;comillas&quot;')
  })

  it('un resultset vacío sigue produciendo un archivo válido (solo la cabecera)', () => {
    const p = escribir(xlsxUnaHoja(['a'], []))
    expect(execFileSync('unzip', ['-t', p], { encoding: 'utf8' })).toContain('No errors detected')
  })
})
