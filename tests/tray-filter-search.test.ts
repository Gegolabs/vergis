// #209 · Un filtro de bandeja con catálogo grande: tope de opciones visibles + buscador.
//
// El pedido del cliente: «los filtros ocupan muchas filas en la columna dentro de la bandeja; debe
// existir una forma más optimizada con un límite de opciones a la vez por filtro + search».
//
// La medición previa matizó el síntoma, y conviene que quede en el test: `.faceta-options` YA acota
// su alto a 220px con scroll en los dos themes, así que UN filtro nunca ocupó la columna entera. Lo
// que ocurre es que N filtros suman N franjas, y que dentro de 47 opciones la que se busca se
// encuentra scrolleando a ciegas. De ahí las dos piezas: plegar y buscar.
import { describe, expect, it } from 'vitest'
import { renderHtmlPiece, FILTER_VISIBLE_MAX, type ResolvedNode } from '@vergis/capabilities'

/** Un filtro resuelto con `n` opciones; `selected` por índice. */
function filtro(n: number, selected: number[] = []) {
  const options = Array.from({ length: n }, (_, i) => `Local ${String(i + 1).padStart(2, '0')}`)
  return [{ id: 'local', label: 'Local', multi: true, options, selected: selected.map((i) => options[i]!) }]
}

async function render(n: number, selected: number[] = []): Promise<string> {
  const { html } = (await renderHtmlPiece.execute(
    {
      piece: { type: 'kpi', label: 'X', value: 1 } as unknown as ResolvedNode,
      title: 'T',
      theme: 'arbol',
      filters: filtro(n, selected),
    },
    { agent: 't' },
  )) as { html: string }
  return html
}

const opciones = (html: string): string[] => [...html.matchAll(/<label class="(vflt-opt[^"]*)"/g)].map((m) => m[1]!)

describe('#209 · un catálogo chico no paga nada', () => {
  it(`con ${FILTER_VISIBLE_MAX} opciones o menos: sin buscador, sin plegado, sin botón`, async () => {
    const html = await render(FILTER_VISIBLE_MAX)
    // Se miran los ELEMENTOS, no las cadenas: la hoja de estilos declara estas clases siempre, así
    // que un `toContain('vflt-search')` sobre el documento entero pasaría por el CSS y no mediría nada.
    expect(html).not.toContain('class="vflt-search"')
    expect(html).not.toContain('class="vflt-allbox"')
    expect(html).not.toMatch(/<label class="vflt-showall"/)
    const opts = opciones(html)
    expect(opts).toHaveLength(FILTER_VISIBLE_MAX)
    expect(opts.filter((c) => c.includes('vflt-extra'))).toEqual([])
  })
})

describe('#209 · un catálogo grande se pliega y se busca', () => {
  it('emite el tope visible y pliega el resto, sin perder ninguna opción', async () => {
    const html = await render(47) // el caso real: Local Sodimac de PI-07
    const opts = opciones(html)
    expect(opts).toHaveLength(47) // el criterio duro: NINGUNA opción desaparece del documento
    expect(opts.filter((c) => c.includes('vflt-extra'))).toHaveLength(47 - FILTER_VISIBLE_MAX)
  })

  it('el botón dice cuántas quedan — un «ver más» sin número no deja decidir si vale la pena', async () => {
    const html = await render(47)
    expect(html).toContain(`Ver las ${47 - FILTER_VISIBLE_MAX} restantes`)
  })

  it('el buscador aparece y anuncia el tamaño del catálogo', async () => {
    const html = await render(47)
    expect(html).toContain('class="vflt-search"')
    expect(html).toContain('Buscar entre 47')
  })

  it('el plegado NO depende de JS: es un checkbox y una regla de hermano general', async () => {
    const html = await render(47)
    expect(html).toContain('class="vflt-allbox"')
    expect(html).toContain('.vflt-allbox:checked ~ .faceta-options .vflt-extra{display:block}')
    // El control que importa: el botón es un <label for>, no un onclick. Sin JS sigue funcionando y
    // ninguna de las 35 plegadas queda inalcanzable.
    expect(html).toMatch(/<label class="vflt-showall" for="vflt-all-local">/)
    expect(html).not.toMatch(/class="vflt-showall"[^>]*onclick/)
  })

  it('el checkbox va ANTES del contenedor: `~` no alcanza a un hermano anterior', async () => {
    const html = await render(47)
    expect(html.indexOf('class="vflt-allbox"')).toBeLessThan(html.indexOf('class="faceta-options"'))
  })
})

describe('#209 · lo que el plegado no puede esconder', () => {
  it('una opción SELECCIONADA fuera del tope NO se pliega', async () => {
    // La 40ª está muy por debajo del tope de 12. Si se plegara, el usuario dejaría de ver —y de
    // poder quitar— su propia selección, que es peor que la lista larga.
    const html = await render(47, [39])
    const seleccionada = html.match(/<label class="(vflt-opt[^"]*)"[^>]*data-v="local 40"/)
    expect(seleccionada).not.toBeNull()
    expect(seleccionada![1]).toContain('on')
    expect(seleccionada![1]).not.toContain('vflt-extra')
  })

  it('el buscador alcanza lo plegado: `vflt-hit` gana en especificidad sobre `vflt-extra`', async () => {
    const html = await render(47)
    // Un buscador que solo filtra lo ya visible no resuelve el caso que lo pidió (llegar a la 40 de
    // 47). Se mide la especificidad, que es lo que decide: 1 clase vs 3.
    const esp = (sel: string): number => (sel.match(/\./g) ?? []).length
    expect(esp('.faceta-options .vflt-opt.vflt-hit')).toBeGreaterThan(esp('.vflt-extra'))
    expect(html).toContain('.faceta-options .vflt-opt.vflt-hit{display:block}')
  })

  it('cada opción lleva su texto normalizado para que la búsqueda no dependa de mayúsculas', async () => {
    const html = await render(47)
    expect(html).toContain('data-v="local 01"')
  })
})
