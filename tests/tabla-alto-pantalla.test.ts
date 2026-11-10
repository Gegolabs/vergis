// #462 · La caja de la tabla mide hasta el borde inferior de la pantalla, descontando lo que tiene encima.
//
// Lo reportó la certificación interna de los PI de una instalación (10-11-2026): «no ves el final». La
// caja era `max-height:70vh` fijo; con cabecera, navegación, controles, chips y aviso de frescura encima,
// su fondo —la barra horizontal de una tabla ancha y las últimas filas— quedaba bajo el pliegue.
//
// Lo que se prueba acá es el cálculo (función pura) y que el documento servido lo cablee. El efecto en
// pantalla se midió además en Chromium headless (sonda del PR): 1280×800, 1366×768 y 1920×1080 con
// `main` dejan el fondo de la caja fuera (889 > 800, 867 > 768, 1085 > 1080) y con la rama dentro.
import { describe, expect, it } from 'vitest'
import { vtFitHeight, VT_FIT_MIN, VT_FIT_GAP, TABLE_RUNTIME_SOURCE, renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

describe('#462 · vtFitHeight', () => {
  it('con espacio de sobra, la caja llega hasta el borde inferior menos el aire', () => {
    // ventana 800, la caja empieza a 347 px del tope del documento
    expect(vtFitHeight(800, 347, 40, VT_FIT_MIN, VT_FIT_GAP)).toBe(800 - 347 - VT_FIT_GAP)
  })

  it('cuenta lo que hay ENCIMA: más cosas arriba ⇒ caja más baja, y el fondo cae siempre dentro', () => {
    for (const top of [120, 250, 347, 500]) {
      const h = vtFitHeight(800, top, 40, VT_FIT_MIN, VT_FIT_GAP)
      expect(top + h).toBeLessThanOrEqual(800 - VT_FIT_GAP)
    }
    expect(vtFitHeight(800, 500, 40, VT_FIT_MIN, VT_FIT_GAP)).toBeLessThan(vtFitHeight(800, 120, 40, VT_FIT_MIN, VT_FIT_GAP))
  })

  it('el aire incluye lo que la tabla trae debajo de la caja (el pie con el conteo)', () => {
    expect(vtFitHeight(800, 347, 40, VT_FIT_MIN, VT_FIT_GAP + 37)).toBe(800 - 347 - VT_FIT_GAP - 37)
  })

  it('una tabla que empieza muy abajo no queda en una ranura: cabe entera bajo la banda pegajosa al llegar a ella', () => {
    const h = vtFitHeight(800, 1400, 40, VT_FIT_MIN, VT_FIT_GAP)
    expect(h).toBe(800 - 40 - VT_FIT_GAP)
    expect(40 + h).toBeLessThanOrEqual(800 - VT_FIT_GAP)
  })

  it('nunca baja del mínimo legible, ni en una ventana diminuta', () => {
    expect(vtFitHeight(200, 150, 40, VT_FIT_MIN, VT_FIT_GAP)).toBe(VT_FIT_MIN)
  })

  it('no depende de cuánto se haya desplazado la página: recibe la posición en el documento', () => {
    expect(vtFitHeight.length).toBe(5)
    expect(TABLE_RUNTIME_SOURCE).toContain('r.top + window.scrollY')
  })
})

describe('#462 · el documento servido lo cablea', () => {
  const piece: ResolvedNode = { type: 'table', title: 'T', interactive: true, columnsSpec: [{ field: 'id', label: 'ID' }], rows: [{ id: 1 }] }

  it('el runtime viaja con vtFitHeight y lo aplica al cargar, al cambiar el tamaño y al abrir la bandeja', async () => {
    const { html } = (await renderHtmlPiece.execute({ theme: 'roble', title: 'X', piece }, { agent: 'test' })) as { html: string }
    expect(html).toContain('function vtFitHeight(')
    expect(TABLE_RUNTIME_SOURCE).toContain("sb.style.maxHeight = vtFitHeight(window.innerHeight")
    expect(TABLE_RUNTIME_SOURCE).toContain("window.addEventListener('resize', fitBox)")
    expect(TABLE_RUNTIME_SOURCE).toContain("trayTg.addEventListener('change'")
    expect(TABLE_RUNTIME_SOURCE).toMatch(/fitBox\(\);\s*\/\* La fila visible arriba/)
  })
})
