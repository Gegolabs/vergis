// #422 · En un informe multi-vista con drill-through, la vista de detalle dice qué está filtrando, tiene
// camino de regreso, y la tabla de origen conserva su estado al volver.
//
// Lo reportó la certificación interna de una instalación beta sobre un P&L por empresa → detalle por
// cliente → detalle por documento: en el detalle no se sabía de qué empresa ni de qué línea eran los
// clientes, no había cómo volver salvo la pestaña (que parte de cero) o el «atrás» del navegador (que
// pierde el orden y las facetas de la tabla).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec, parseBackChain, originQuery, BACK_MAX_DEPTH } from '@vergis/mira'
import { vtShouldRestore, vtStateKey, TABLE_RUNTIME_SOURCE } from '@vergis/capabilities'
import type { Capability } from '@vergis/botler'

const SCHEMA = JSON.parse(readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8')) as object
const validate = (yaml: string) => validateSpec(parseSpec(yaml), { capabilities: ['mock-sql', 'render-html-piece', 'publicar-artefacto'], schema: SCHEMA })

const YAML = `
mira_version: "1.0"
identity: { id: pi-drill-422, display_name: "Ventas 422", classification: internal }
controls:
  - { id: periodo, label: "Período", source: data.periodos.periodo, default: max, single: true }
pages:
  - id: pyl
    title: "P&L por Empresa"
    piece:
      table:
        data: data.pyl
        columns: [{ field: empresa, label: "Empresa" }, { field: linea, label: "Línea" }, { field: venta, format: int_0 }]
        drillthrough:
          - { to: detalle-cliente, by: [empresa, linea], label: "Clientes" }
  - id: detalle-cliente
    title: "Detalle por Cliente"
    context:
      - { key: empresa, label: "Empresa", display: empresa_nombre }
      - { key: linea, label: "Línea" }
    piece:
      table:
        data: data.clientes
        columns: [{ field: cliente, label: "Cliente" }, { field: venta, format: int_0 }]
        drillthrough:
          - { to: detalle-doc, by: [empresa, cliente], label: "Documentos" }
  - id: detalle-doc
    title: "Detalle por Documento"
    context: [empresa, cliente]
    piece:
      table:
        data: data.docs
        columns: [{ field: doc, label: "Documento" }]
data:
  periodos: { capability: mock-sql, params: { sql: "SELECT periodo FROM dbo.periodos" } }
  pyl: { capability: mock-sql, params: { sql: "SELECT empresa, linea, venta FROM dbo.pyl WHERE periodo = :ctx.periodo" } }
  clientes: { capability: mock-sql, params: { sql: "SELECT empresa, empresa_nombre, cliente, venta FROM dbo.clientes WHERE empresa = :ctx.empresa AND linea = :ctx.linea AND periodo = :ctx.periodo" } }
  docs: { capability: mock-sql, params: { sql: "SELECT doc FROM dbo.docs WHERE empresa = :ctx.empresa AND cliente = :ctx.cliente" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

const mock = (sinNombre = false): Capability => ({
  name: 'mock-sql',
  async execute(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sql: string; params?: Record<string, unknown> }
    if (/dbo\.periodos/.test(p.sql)) return { rows: [{ periodo: '2026-08' }, { periodo: '2026-09' }] }
    if (/dbo\.pyl/.test(p.sql)) return { rows: [{ empresa: 'VH', linea: 'Frutales', venta: 100 }, { empresa: 'IVL', linea: 'Plantas', venta: 40 }] }
    if (/dbo\.clientes/.test(p.sql))
      return { rows: [{ empresa: p.params?.['ctx_empresa'], empresa_nombre: sinNombre ? '' : 'Viveros Hijuelas', cliente: 'C7', venta: 60 }] }
    return { rows: [{ doc: 'F-1' }] }
  },
})

async function render(nav: { page?: string; ctx?: Record<string, string>; from?: string }, sinNombre = false): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-422-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, YAML)
  const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mock(sinNombre)], page: nav.page, ctx: nav.ctx, from: nav.from })
  return out.html ?? ''
}
const dec = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
/** El `from` que lleva el primer drill de la página (del href servido), ya decodificado. */
function fromDelDrill(html: string): string {
  const m = /class="vt-drill-link"[^>]*href="([^"]*)"|href="([^"]*)"[^>]*class="vt-drill-link"/.exec(html)
  const href = dec((m?.[1] ?? m?.[2]) ?? '')
  return new URLSearchParams(href.replace(/^\?/, '')).get('from') ?? ''
}
const sellos = (html: string) => [...html.matchAll(/vctx-drill" data-ctx="([^"]+)"><span class="vctx-k">([^<]*)<\/span><span class="vctx-v">([^<]*)</g)].map((m) => [m[1], m[2], m[3]])
const migas = (html: string) => [...(/<nav class="vback"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '').matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => [dec(m[1]), m[2]])
const stateKeyDe = (html: string) => (JSON.parse(/class="vtable-data">([\s\S]*?)<\/script>/.exec(html)![1]) as { stateKey?: string }).stateKey

describe('pieza 1 · la vista de detalle dice qué está filtrando', () => {
  it('un sello por clave de context, con el nombre resuelto del dato (display) y el rótulo declarado', async () => {
    const h = await render({ page: 'detalle-cliente', ctx: { empresa: 'VH', linea: 'Frutales' } })
    expect(sellos(h)).toEqual([
      ['empresa', 'Empresa', 'Viveros Hijuelas'],
      ['linea', 'Línea', 'Frutales'],
    ])
  })
  it('context como lista de strings: el sello rotula con la clave y muestra el valor', async () => {
    const h = await render({ page: 'detalle-doc', ctx: { empresa: 'VH', cliente: 'C7' } })
    expect(sellos(h)).toEqual([
      ['empresa', 'empresa', 'VH'],
      ['cliente', 'cliente', 'C7'],
    ])
  })
  it('un display que no viene en el dato cae al valor de la clave (nunca vacío)', async () => {
    const h = await render({ page: 'detalle-cliente', ctx: { empresa: 'VH', linea: 'Frutales' } }, true)
    expect(sellos(h)[0]).toEqual(['empresa', 'Empresa', 'VH'])
  })
  it('el rótulo no se puede forjar desde la URL: un ctx.empresa_nombre no cambia el sello', async () => {
    const h = await render({ page: 'detalle-cliente', ctx: { empresa: 'VH', linea: 'Frutales', empresa_nombre: 'FORJADO' } })
    expect(h).not.toContain('FORJADO')
  })
  it('una clave de context que además es control de cabecera no se pinta dos veces', async () => {
    const h = await render({ page: 'detalle-cliente', ctx: { empresa: 'VH', linea: 'Frutales', periodo: '2026-09' } })
    expect(sellos(h).map((x) => x[0])).not.toContain('periodo')
  })
  it('la vista sin drill no pinta sellos de contexto', async () => {
    expect(sellos(await render({ page: 'pyl' }))).toEqual([])
  })
})

describe('pieza 2 · regreso con su ruta', () => {
  it('el drill lleva como from la query de la vista de origen (página, período efectivo y claves)', async () => {
    const from = fromDelDrill(await render({ page: 'pyl' }))
    const q = new URLSearchParams(from)
    expect(q.get('page')).toBe('pyl')
    expect(q.get('ctx.periodo')).toBe('2026-09') // el default resuelto, aunque la URL no lo traía
  })

  it('dos niveles: la vista final pinta las dos migas, de la más antigua a la más cercana, y cada una vuelve con su ctx', async () => {
    const f1 = fromDelDrill(await render({ page: 'pyl' }))
    const h2 = await render({ page: 'detalle-cliente', ctx: { empresa: 'VH', linea: 'Frutales', periodo: '2026-09' }, from: f1 })
    expect(migas(h2).map((m) => m[1])).toEqual(['P&amp;L por Empresa'])
    const f2 = fromDelDrill(h2)
    const h3 = await render({ page: 'detalle-doc', ctx: { empresa: 'VH', cliente: 'C7' }, from: f2 })
    const m3 = migas(h3)
    expect(m3.map((m) => m[1])).toEqual(['P&amp;L por Empresa', 'Detalle por Cliente'])
    const volverCliente = new URLSearchParams(m3[1][0].replace(/^\?/, ''))
    expect(volverCliente.get('page')).toBe('detalle-cliente')
    expect(volverCliente.get('ctx.empresa')).toBe('VH')
    expect(volverCliente.get('ctx.linea')).toBe('Frutales')
    expect(volverCliente.get('vret')).toBe('1')
  })

  it('entrada directa (sin from): no hay migas', async () => {
    expect(migas(await render({ page: 'detalle-cliente', ctx: { empresa: 'VH', linea: 'Frutales' } }))).toEqual([])
  })

  it('un from hacia una página que no existe no pinta miga (el título sale del spec, no de la URL)', async () => {
    const h = await render({ page: 'detalle-cliente', ctx: { empresa: 'VH', linea: 'Frutales' }, from: 'page=inventada&ctx.x=1' })
    expect(migas(h)).toEqual([])
  })

  it('la cadena se poda a BACK_MAX_DEPTH eslabones', () => {
    const pages = [{ id: 'a', title: 'A', piece: {} }]
    let from: string | undefined
    for (let i = 0; i < 6; i++) from = originQuery('a', { n: String(i) }, {}, from)
    expect(parseBackChain(from, pages, 10)).toHaveLength(BACK_MAX_DEPTH)
  })
})

describe('pieza 3 · el estado de la tabla sobrevive al ir y volver', () => {
  it('se restituye solo al volver: atrás/adelante o miga (vret=1); entrada nueva parte limpia', () => {
    expect(vtShouldRestore('back_forward', '?page=pyl')).toBe(true)
    expect(vtShouldRestore('navigate', '?page=pyl&vret=1')).toBe(true)
    expect(vtShouldRestore('navigate', '?page=pyl')).toBe(false)
    expect(vtShouldRestore('reload', '?page=pyl&vret=10')).toBe(false)
    expect(vtShouldRestore(undefined, '')).toBe(false)
  })

  it('la llave de la vista es la misma entrando sin query (default resuelto) y volviendo por la miga', async () => {
    const directa = stateKeyDe(await render({ page: 'pyl' }))
    const f1 = fromDelDrill(await render({ page: 'pyl' }))
    const q = new URLSearchParams(f1)
    const ctx: Record<string, string> = {}
    for (const [k, v] of q) if (k.startsWith('ctx.')) ctx[k.slice(4)] = v
    const porMiga = stateKeyDe(await render({ page: q.get('page') ?? undefined, ctx }))
    expect(directa).toBeTruthy()
    expect(porMiga).toBe(directa)
    expect(vtStateKey('/pi-02', directa, '?x', 0)).toBe(vtStateKey('/pi-02', porMiga, '?y', 0))
  })

  it('el runtime guarda al salir y restituye con el mismo snapshot/apply de las vistas guardadas', () => {
    expect(TABLE_RUNTIME_SOURCE).toContain("window.addEventListener('pagehide', saveState)")
    expect(TABLE_RUNTIME_SOURCE).toContain('if(!vtShouldRestore(nav.type, location.search)) return;')
    expect(TABLE_RUNTIME_SOURCE).toContain('applySnapshot(saved.s)')
    expect(TABLE_RUNTIME_SOURCE).toContain('window.scrollTo(0, y)')
    expect(TABLE_RUNTIME_SOURCE).toContain('sb.scrollTop = t') // la tabla hace scroll en su contenedor
    expect(TABLE_RUNTIME_SOURCE).toContain("u2.searchParams.delete('vret')") // una recarga parte limpia
  })
})

describe('validador · context como objeto', () => {
  it('el spec con context de objetos y de strings valida', () => {
    expect(() => validate(YAML)).not.toThrow()
  })
  it('un objeto de context sin key se rechaza', () => {
    expect(() => validate(YAML.replace('- { key: linea, label: "Línea" }', '- { label: "Línea" }'))).toThrow()
  })
  it('el drill sigue exigiendo que el destino declare sus claves, con la forma objeto', () => {
    expect(() => validate(YAML.replace('- { key: linea, label: "Línea" }', '- { key: otra, label: "Otra" }'))).toThrow(/drill-context-mismatch|no declara/)
  })
})
