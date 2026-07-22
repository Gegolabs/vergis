// El shell del Inspector (uña + tabs Controles·Vistas·Config + Apariencia + pie de versión) es
// contenido UNIVERSAL a todo PI: no debe gatearse por la presencia de maquinaria (tabla interactiva
// o facetas de dashboard). Regresión del bug cazado en PI-17 (2026-07-22): una vista de dashboard
// puro (KPIs + charts, sin tabla, con la interactividad de gráficos aún no construida) caía en el
// `else` sin rama → renderTrayShell NUNCA se llamaba → sin Inspector, sin Apariencia, sin Config.
import { describe, it, expect } from 'vitest'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'

const render = async (params: Record<string, unknown>): Promise<string> =>
  ((await renderHtmlPiece.execute(params, { agent: 'test' } as never)) as { html: string }).html

// Vista de DASHBOARD PURO: layout con KPI + distribution, SIN tabla y SIN `interactive`.
// (interactividad de gráficos = capacidad #82, aún no construida → el shell igual debe existir).
function dashboardPuro(): ResolvedNode {
  return {
    layout: 'grid',
    columns: 2,
    elements: [
      { type: 'kpi', label: 'Total', value: 1234, format: 'int' },
      {
        type: 'distribution',
        title: 'Distribución',
        dimensionField: 'dim',
        metricField: 'm',
        rows: [
          { dim: 'A', m: 10 },
          { dim: 'B', m: 6 },
          { dim: 'C', m: 3 },
        ],
      },
    ],
  } as ResolvedNode
}

// Tabla interactiva (≥2 filas) — el caso «con maquinaria» que NO debe regresar.
function tabla2(): ResolvedNode {
  return {
    type: 'table',
    columnsSpec: [{ field: 'a', label: 'A' }, { field: 'b', label: 'B' }],
    rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }],
  } as ResolvedNode
}

describe('render · el shell del Inspector se renderiza SIEMPRE (no gateado por maquinaria)', () => {
  it('dashboard puro (sin tabla, sin interactive) → uña + aside.tray + tab Config + TRAY_CSS', async () => {
    const html = await render({ piece: dashboardPuro(), title: 'PI-17 dashboard', theme: 'arbol' })
    // la uña/pestaña que abre el Inspector
    expect(html).toContain('class="tray-tab"')
    expect(html).toContain('for="vergis-tray-toggle"')
    // el panel lateral
    expect(html).toContain('<aside class="tray"')
    // el tab Config (Apariencia + Imprimir viven aquí — universales)
    expect(html).toContain('vergis-tt-config')
    // el CSS del shell debe estar inyectado (el shell existe)
    expect(html).toContain('.tray-tabin{position:absolute') // fragmento distintivo de TRAY_CSS
  })

  it('dashboard puro → Apariencia (Theme) presente cuando el tema trae ≥2 paletas', async () => {
    // arbol expone ≥2 paletas → el faceta de Apariencia debe estar en el tab Config.
    const html = await render({ piece: dashboardPuro(), title: 'X', theme: 'arbol' })
    expect(html).toContain('Apariencia (Theme)')
  })

  it('dashboard puro → Controles sin maquinaria muestra un empty-state, no un panel en blanco', async () => {
    const html = await render({ piece: dashboardPuro(), title: 'X', theme: 'arbol' })
    expect(html).toContain('tray-empty')
    expect(html).toContain('Esta vista no tiene filtros disponibles.')
  })

  it('dashboard puro → abre por defecto en Config (primer tab con contenido)', async () => {
    const html = await render({ piece: dashboardPuro(), title: 'X', theme: 'arbol' })
    // el radio de Config queda `checked` cuando Controles no tiene maquinaria
    expect(html).toMatch(/id="vergis-tt-config"[^>]*\schecked/)
    // y Controles NO queda checked por defecto en este caso
    expect(html).not.toMatch(/id="vergis-tt-controles"[^>]*\schecked/)
  })

  it('NO regresión — vista CON tabla interactiva sigue trayendo el shell y su tab Controles', async () => {
    const html = await render({ piece: tabla2(), title: 'X', theme: 'arbol' })
    expect(html).toContain('<aside class="tray"')
    expect(html).toContain('tray-sections') // Controles alberga la maquinaria de tabla (inyectada por runtime)
    // con maquinaria, Controles es el tab por defecto
    expect(html).toMatch(/id="vergis-tt-controles"[^>]*\schecked/)
  })
})
