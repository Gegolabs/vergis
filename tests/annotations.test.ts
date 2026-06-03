import { describe, it, expect } from 'vitest'
import { SqliteAnnotationStore, renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

describe('AnnotationStore · SQLite embebido', () => {
  it('upsert / get / borrado (value vacío)', async () => {
    const s = await SqliteAnnotationStore.open(null) // en memoria
    await s.upsert('pi-12', '102', 'Capacitación pendiente', 'a@x.com')
    await s.upsert('pi-12', '118', 'OK', 'b@x.com')
    let m = await s.get('pi-12', ['102', '118', '999'])
    expect(m.get('102')?.value).toBe('Capacitación pendiente')
    expect(m.get('118')?.value).toBe('OK')
    expect(m.has('999')).toBe(false)
    expect(m.get('102')?.updatedBy).toBe('a@x.com')
    // value vacío borra
    await s.upsert('pi-12', '102', '', 'a@x.com')
    m = await s.get('pi-12', ['102'])
    expect(m.has('102')).toBe(false)
    // particionado por PI
    await s.upsert('pi-04', '118', 'otra', 'c@x.com')
    expect((await s.get('pi-12', ['118'])).get('118')?.value).toBe('OK')
    expect((await s.get('pi-04', ['118'])).get('118')?.value).toBe('otra')
    s.close()
  })

  it('get([]) vacío sin tocar la DB', async () => {
    const s = await SqliteAnnotationStore.open(null)
    expect((await s.get('pi-12', [])).size).toBe(0)
    s.close()
  })
})

describe('render · columna de anotación', () => {
  const piece: ResolvedNode = {
    type: 'table',
    title: 'Personal',
    columnsSpec: [
      { field: 'id', label: 'ID' },
      { field: 'nombre', label: 'Nombre' },
      { field: '__ann', label: 'Anotaciones', annotation: true },
    ],
    rows: [
      { id: 1, nombre: 'Ana', __ann: 'nota previa', __anntok: 'tok-1' },
      { id: 2, nombre: 'Beto', __ann: '', __anntok: 'tok-2' },
    ],
    annotation: { valueField: '__ann', tokenField: '__anntok', keyField: 'id', endpoint: '/pi-12/annotations', label: 'Anotaciones' },
  }

  // NOTA: 'vt-ann-cell'/'Mostrar anotaciones'/'contenteditable'/'Anotaciones' viven SIEMPRE en el
  // runtime embebido (string del DOM glue). Solo el JSON de datos distingue si la tabla tiene anotación.
  it('embebe la meta de anotación + tokens por fila (datos embebidos)', async () => {
    const { html } = (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol' }, { agent: 'test' })) as { html: string }
    expect(html).toContain('"annotation":{') // meta de la tabla
    expect(html).toContain('"valueField":"__ann"')
    expect(html).toContain('"keyField":"id"')
    expect(html).toContain('"endpoint":"/pi-12/annotations"')
    expect(html).toContain('"__anntok":"tok-1"') // token por fila
    expect(html).toContain('"annotation":true') // flag de la columna en colMeta
  })

  it('sin meta de anotación → el payload no la trae (no intrusivo)', async () => {
    const plain: ResolvedNode = {
      type: 'table',
      columnsSpec: [{ field: 'id', label: 'ID' }, { field: 'nombre', label: 'Nombre' }],
      rows: [{ id: 1, nombre: 'Ana' }],
    }
    const { html } = (await renderHtmlPiece.execute({ piece: plain, title: 'X', theme: 'arbol' }, { agent: 'test' })) as { html: string }
    expect(html).not.toContain('"annotation":{')
    expect(html).not.toContain('"annotation":true')
    expect(html).not.toContain('"__anntok"')
  })
})
