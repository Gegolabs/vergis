// Umbral SSR de la tabla interactiva (work/052 §2.4): el tbody server-rendered es solo el primer
// paint — sobre TABLE_SSR_MAX_ROWS se sirven solo las primeras N filas (el JSON del runtime va
// SIEMPRE completo, es la fuente); `ssrComplete` le dice al runtime si puede saltarse el render()
// inicial (que reconstruiría un tbody idéntico al servido).
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, TABLE_SSR_MAX_ROWS, TABLE_RUNTIME_SOURCE, type ResolvedNode } from '@vergis/capabilities'

function makeRows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, nombre: `Fila ${i + 1}` }))
}

function tablePiece(rows: Record<string, unknown>[]): ResolvedNode {
  return {
    type: 'table',
    title: 'Grande',
    columnsSpec: [
      { field: 'id', label: 'ID' },
      { field: 'nombre', label: 'Nombre' },
    ],
    rows,
  }
}

async function render(rows: Record<string, unknown>[]): Promise<string> {
  const { html } = (await renderHtmlPiece.execute({ piece: tablePiece(rows), title: 'X', theme: 'arbol' }, { agent: 'test' })) as { html: string }
  return html
}

/** Filas del tbody servido (cuenta los <tr del primer tbody del documento). */
function ssrRowCount(html: string): number {
  const m = html.match(/<tbody>([\s\S]*?)<\/tbody>/)
  return (m?.[1].match(/<tr/g) ?? []).length
}

describe('tabla interactiva · umbral SSR (payload 2×)', () => {
  it('≤ umbral → tbody completo y ssrComplete:true', async () => {
    const html = await render(makeRows(10))
    expect(ssrRowCount(html)).toBe(10)
    expect(html).toContain('"ssrComplete":true')
    expect(html).toContain('Fila 10')
  })

  it('> umbral → tbody truncado a N, JSON completo, ssrComplete:false', async () => {
    const n = TABLE_SSR_MAX_ROWS + 25
    const html = await render(makeRows(n))
    expect(ssrRowCount(html)).toBe(TABLE_SSR_MAX_ROWS) // primer paint truncado
    expect(html).toContain('"ssrComplete":false')
    // El JSON (fuente del runtime) SÍ trae todas las filas — la última incluida.
    expect(html).toContain(`"nombre":"Fila ${n}"`)
    // ...pero la última fila NO está en el tbody servido (solo en el payload).
    const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1]
    expect(tbody).not.toContain(`Fila ${n}<`)
  })

  it('estática (interactive:false) → tbody SIEMPRE completo (no hay runtime que complete)', async () => {
    const n = TABLE_SSR_MAX_ROWS + 5
    const { html } = (await renderHtmlPiece.execute(
      { piece: { ...tablePiece(makeRows(n)), interactive: false }, title: 'X', theme: 'arbol' },
      { agent: 'test' },
    )) as { html: string }
    expect(ssrRowCount(html)).toBe(n)
  })

  it('el runtime conoce el skip: consulta ssrComplete y solo renderiza si hace falta', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain('payload.ssrComplete')
    expect(TABLE_RUNTIME_SOURCE).toContain('stateEmpty')
    // sigue siendo JS válido tras el cambio
    expect(() => new Function(TABLE_RUNTIME_SOURCE)).not.toThrow()
  })
})
