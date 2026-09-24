/**
 * work/274 C3 · `/cargar` dice lo que pasó y deja el dato del caso a un clic:
 *
 *  - DP-19 (D-11) · el motivo que declaró el proceso va PLEGADO bajo la guía, en todo estado que dibuja
 *    guía (`fallida` y `saltada`, actor `usuario` y `nadie`), escapado y redactado.
 *  - DP-17 (D-10) · la familia `desplazado` tiene su propio chip, «Reemplazado por uno más reciente»;
 *    las demás familias de actor `nadie` siguen en «⏸ En espera».
 *  - DP-18 · la tarjeta del tipo cuenta como «necesita que hagas algo» una carga `saltada` cuya guía es
 *    de actor `usuario`.
 *
 * Datos sintéticos, sin personas.
 */
import { describe, it, expect } from 'vitest'
import { parseIntakeConfig, parseIntakeGuias, type IntakeSlot, type GuiaDecl } from '@vergis/capabilities'
import { guiaDeCarga, type IntakeUploadEvent } from '../server/admin-cargas'
import { renderCarga, estadoDeTarjeta } from '../server/cargar'
import type { AdminDeps } from '../server/admin'

const DOC = {
  slots: [
    { id: 'productos', label: 'Productos', domain: 'comercial', accept: '*products-details*.xlsx', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/intake/oc' } },
  ],
  guias: {
    familias: [
      { familia: 'falta-par', actor: 'usuario', titulo: 'Falta el archivo compañero', que_paso: 'Este archivo necesita otro que subes tú.', que_hacer: ['Sube el archivo compañero.'] },
    ],
    entradas: [
      { codigo: 'duplicado/sku', slots: ['productos'], titulo: 'Hay SKU repetidos', que_paso: 'El archivo trae SKU repetidos.', que_hacer: ['Deja una sola fila por SKU.'] },
    ],
  },
}
const SLOTS: IntakeSlot[] = parseIntakeConfig(DOC)
const SLOT = SLOTS[0]!
const CATALOGO: GuiaDecl[] = parseIntakeGuias(DOC, SLOTS)
const DEPS = { intakeGuias: CATALOGO } as unknown as AdminDeps

let n = 0
function carga(desenlace: 'fallida' | 'saltada', codigo: string | undefined, motivo: string | undefined, filename = `oc-${++n}-products-details.xlsx`): IntakeUploadEvent {
  return {
    id: n, ts: '2026-09-23T12:00:00Z', filename, bytes: 1, by: 'x@ejemplo.cl', ok: true, triggered: true, sha256: 'a'.repeat(64),
    desenlace, desenlaceFinal: false,
    ...(codigo ? { desenlaceCodigo: codigo } : {}),
    ...(motivo ? { desenlaceMotivo: motivo } : {}),
  }
}
const render = (h: IntakeUploadEvent): string => renderCarga(SLOT, SLOTS, h, { enLanding: true }, guiaDeCarga(SLOT, h, CATALOGO), '/cargar/productos/retirar?carga=1')
/** El contenido de los `<details>` de una fila (lo que queda a un clic). */
const plegados = (html: string): string[] => [...html.matchAll(/<details class="plegado"><summary>([^<]*)<\/summary>([\s\S]*?)<\/details>/g)].map((m) => `${m[1]}|${m[2]}`)
/** El chip de una fila. */
const chipDe = (html: string): string => /class="chip[^"]*">([^<]*)<\/span>/.exec(html)?.[1] ?? ''

describe('work/274 DP-19 · el motivo va plegado bajo la guía', () => {
  const casos: [string, 'fallida' | 'saltada', string][] = [
    ['fallida · actor usuario (entrada de instancia)', 'fallida', 'duplicado/sku'],
    ['fallida · actor usuario (genérica del Producto)', 'fallida', 'formato/columnas'],
    ['saltada · actor usuario (familia de instancia)', 'saltada', 'falta-par/oc'],
    ['saltada · actor nadie', 'saltada', 'en-espera/otro'],
    ['fallida · actor nadie', 'fallida', 'en-espera/otro'],
    ['saltada · desplazado', 'saltada', 'desplazado/x'],
  ]
  for (const [nombre, desenlace, codigo] of casos) {
    it(nombre, () => {
      const html = render(carga(desenlace, codigo, `MOTIVO-${codigo} con <b>marca</b>`))
      const p = plegados(html)
      expect(p).toHaveLength(1)
      expect(p[0]).toContain('ver el detalle|')
      expect(p[0]).toContain(`MOTIVO-${codigo} con &lt;b&gt;marca&lt;/b&gt;`)
      expect(html).not.toContain('<b>marca</b>')
    })
  }

  it('el motivo sale COMPLETO (sin el recorte a 300 de la rama sin guía)', () => {
    const largo = 'x'.repeat(280) + ' Pedir el maestro actualizado.'
    const p = plegados(render(carga('fallida', 'duplicado/sku', largo)))
    expect(p[0]).toContain('Pedir el maestro actualizado.')
  })

  it('un secreto en el motivo sale redactado (pasa por `redactSecrets`)', () => {
    // `redactSecrets` enmascara pares clave=valor y JWT; un `sk-…` suelto, sin clave, no es de su
    // gramática hoy (fuera del alcance de este cambio).
    const html = render(carga('fallida', 'duplicado/sku', 'conexión falló: token=sk-prueba-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 en el host'))
    expect(html).not.toContain('sk-prueba-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    expect(plegados(html)[0]).toContain('token=«…redactado…» en el host')
  })

  it('sin motivo no se dibuja un plegado vacío', () => {
    expect(plegados(render(carga('fallida', 'duplicado/sku', undefined)))).toEqual([])
  })

  it('actor operador: sin guía y sin plegado (lo dice el chip de la plataforma, como antes)', () => {
    const html = render(carga('fallida', 'falla-plataforma/x', 'MOTIVO-OPERADOR'))
    expect(chipDe(html)).toBe('⚠ Problema de la plataforma')
    expect(html).not.toContain('MOTIVO-OPERADOR')
  })

  it('sin guía, la rama de siempre: el motivo visible sin plegar', () => {
    const html = render(carga('fallida', undefined, 'ancho inesperado: 28 columnas'))
    expect(plegados(html)).toEqual([])
    expect(html).toContain('<div class="sub">ancho inesperado: 28 columnas</div>')
  })
})

describe('work/274 DP-17 · `desplazado` tiene su propio chip', () => {
  it('saltada y fallida de familia `desplazado`: «Reemplazado por uno más reciente», sin «Retirar»', () => {
    for (const d of ['saltada', 'fallida'] as const) {
      const html = render(carga(d, 'desplazado/maestro-reciente', 'otro más reciente'))
      expect(chipDe(html)).toBe('Reemplazado por uno más reciente')
      expect(html).not.toContain('En espera')
      expect(html).not.toContain('Retirar este archivo')
    }
  })

  it('las demás familias de actor `nadie` siguen en «⏸ En espera»', () => {
    expect(chipDe(render(carga('saltada', 'en-espera/otro', 'm')))).toBe('⏸ En espera')
  })
})

describe('work/274 DP-18 · la tarjeta cuenta la `saltada` de actor usuario', () => {
  const tarjeta = (cargas: IntakeUploadEvent[]): string => estadoDeTarjeta(DEPS, SLOT, cargas, { landing: cargas.map((c) => c.filename), runs: [], observedAt: '2026-09-23T12:00:00Z' }, Date.parse('2026-09-23T13:00:00Z'))

  it('una `saltada` con guía de actor usuario pide acción', () => {
    expect(tarjeta([carga('saltada', 'falta-par/oc', 'm')])).toContain('1 archivo(s) necesitan que hagas algo')
  })

  it('una `saltada` de actor nadie, o sin código, no la cuenta', () => {
    expect(tarjeta([carga('saltada', 'en-espera/otro', 'm')])).not.toContain('necesitan que hagas algo')
    expect(tarjeta([carga('saltada', 'desplazado/x', 'm')])).not.toContain('necesitan que hagas algo')
    expect(tarjeta([carga('saltada', undefined, 'm')])).not.toContain('necesitan que hagas algo')
  })

  it('suma con lo que ya contaba (una `fallida` con guía de usuario)', () => {
    expect(tarjeta([carga('saltada', 'falta-par/oc', 'm'), carga('fallida', 'duplicado/sku', 'm')])).toContain('2 archivo(s) necesitan que hagas algo')
  })
})
