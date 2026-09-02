// #255 · Las facetas client-side reciben el tope + buscador que #209 le dio a los filtros de bandeja.
//
// Las dos superficies comparten el mismo `.faceta-options` de 220px con scroll interno, así que el
// síntoma que motivó #209 —dentro de 47 opciones la que se busca se encuentra scrolleando a ciegas—
// se daba idéntico acá. Lo que NO se puede copiar del server-side es la marca de «seleccionada»:
// allá viaja en la URL y el HTML nace sabiéndola; acá el estado vive en el DOM y cambia sin
// re-render, así que la pone el runtime (`vflt-keep` en `update()`).
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, FILTER_VISIBLE_MAX, type ResolvedNode } from '@vergis/capabilities'
import { renderInteractiveScript } from '../packages/capabilities/src/interactive-script'
import type { Interactive } from '../packages/capabilities/src/piece-types'

const banner: ResolvedNode = { type: 'banner', content: 'demo' }

/** Un dataset con `n` valores distintos en `local`, para una faceta client-side sobre ese campo. */
function interactivo(n: number): Interactive {
  const rows = Array.from({ length: n }, (_, i) => ({ local: `Local ${String(i + 1).padStart(2, '0')}`, monto: i }))
  return { datasets: { d: rows }, filters: [{ dataset: 'd', field: 'local', label: 'Local' }] }
}

const render = async (params: Record<string, unknown>): Promise<string> =>
  ((await renderHtmlPiece.execute(params, {} as never)) as { html: string }).html

/** Las clases de cada `<label>` de opción emitido (elementos, no cadenas: la hoja declara las clases siempre). */
const opciones = (html: string): string[] => [...html.matchAll(/<label class="(vflt-opt[^"]*)"/g)].map((m) => m[1]!)

describe('#255 · un catálogo grande en una faceta client-side se pliega y se busca', () => {
  it('emite el tope visible, pliega el resto y no pierde ninguna opción', async () => {
    const html = await render({ piece: banner, interactive: interactivo(47) })
    const opts = opciones(html)
    expect(opts).toHaveLength(47) // el criterio duro: ninguna opción desaparece del documento
    expect(opts.filter((c) => c.includes('vflt-extra'))).toHaveLength(47 - FILTER_VISIBLE_MAX)
    expect(opts.filter((c) => !c.includes('vflt-extra'))).toHaveLength(FILTER_VISIBLE_MAX)
  })

  it('el buscador aparece, anuncia el tamaño del catálogo y cada opción lleva su texto normalizado', async () => {
    const html = await render({ piece: banner, interactive: interactivo(47) })
    expect(html).toContain('class="vflt-search"')
    expect(html).toContain('Buscar entre 47')
    expect(html).toContain('data-v="local 01"')
  })

  it('el «ver más» dice cuántas quedan y es un <label for>, no un onclick: sin JS sigue alcanzando lo plegado', async () => {
    const html = await render({ piece: banner, interactive: interactivo(47) })
    expect(html).toContain(`Ver las ${47 - FILTER_VISIBLE_MAX} restantes`)
    expect(html).toContain('id="vflt-all-fct-local"')
    expect(html).toMatch(/<label class="vflt-showall" for="vflt-all-fct-local">/)
    expect(html).not.toMatch(/class="vflt-showall"[^>]*onclick/)
    // El checkbox va ANTES del contenedor: `~` no alcanza a un hermano anterior.
    expect(html.indexOf('class="vflt-allbox"')).toBeLessThan(html.indexOf('class="faceta-options"'))
  })
})

describe('#255 · un catálogo chico no paga nada', () => {
  it(`con ${FILTER_VISIBLE_MAX} opciones o menos: sin buscador, sin plegado, sin botón`, async () => {
    const html = await render({ piece: banner, interactive: interactivo(FILTER_VISIBLE_MAX) })
    expect(html).not.toContain('class="vflt-search"')
    expect(html).not.toContain('class="vflt-allbox"')
    expect(html).not.toMatch(/<label class="vflt-showall"/)
    const opts = opciones(html)
    expect(opts).toHaveLength(FILTER_VISIBLE_MAX)
    expect(opts.filter((c) => c.includes('vflt-extra'))).toEqual([])
  })
})

describe('#255 · el patrón viaja completo aunque no haya filtros server-side', () => {
  it('un dashboard con SOLO facetas recibe la hoja del patrón y el script del buscador', async () => {
    // El defecto que esto cubre: CSS y script se gateaban por `trayFilters`, así que un dashboard
    // sin filtros server-side emitía las marcas de #209 (`vflt-extra`, `vflt-search`) sin la hoja
    // que las pliega ni la función que las busca — el «ver más» quedaba inerte y el tope, invisible.
    const html = await render({ piece: banner, interactive: interactivo(47) })
    expect(html).toContain('.vflt-allbox:checked ~ .faceta-options .vflt-extra{display:block}')
    expect(html).toContain('.faceta-options .vflt-opt.vflt-keep{display:block}')
    expect(html).toContain('function vfltSearch')
  })

  it('en papel no viaja el script (#65 · D4: en un motor de print el JS no corre)', async () => {
    const html = await render({ piece: banner, interactive: interactivo(47), print: true })
    expect(html).not.toContain('function vfltSearch')
  })
})

describe('#255 · la opción marcada la mantiene visible el runtime', () => {
  const src = renderInteractiveScript(interactivo(47))

  it('`update()` marca con `vflt-keep` el contenedor de cada checkbox según su estado', () => {
    expect(src).toContain("closest('.vflt-opt')")
    expect(src).toContain("classList.toggle('vflt-keep', b.checked)")
    // Va DENTRO de update(): es el único punto por el que pasan todas las mutaciones del estado
    // (change, ✕ del chip, «limpiar», y `dashApply` al restaurar una vista guardada).
    const update = src.slice(src.indexOf('function update(){'))
    expect(update.slice(0, update.indexOf('\n  }'))).toContain("classList.toggle('vflt-keep', b.checked)")
  })

  it('el script sigue siendo sintácticamente válido (browser-only, sin jsdom)', () => {
    const code = src.replace(/^<script>/, '').replace(/<\/script>$/, '')
    expect(() => new Function(code)).not.toThrow()
  })
})
