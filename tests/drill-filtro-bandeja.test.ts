// #458 · Filtrar en una vista alcanzada por drill no saca al usuario del registro.
//
// Lo reportó la certificación interna de los PI de una instalación (10-11-2026): en una vista de
// detalle (llegada por drill, con sus claves en `ctx.*` y su `from`) el enlace de cada opción de un
// filtro de bandeja solo arrastraba los controles de cabecera. Al elegir una opción se perdían las
// claves del drill y el `from`: la vista caía en la pieza-guía («falta: …») y el regreso desaparecía.
//
// El arnés recorre el camino entero que hace el usuario —drill → elegir filtro → quitarlo— siguiendo
// los `href` servidos, no reconstruyéndolos: lo que se mide es lo que el navegador va a pedir.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import type { Capability } from '@vergis/botler'

const YAML = `
mira_version: "1.0"
identity: { id: pi-drill-458, display_name: "Documentos 458", classification: internal }
controls:
  - { id: periodo, label: "Período", source: data.periodos.periodo, default: max, single: true }
filters:
  - { id: centro, label: "Centro", source: data.centros.centro, multi: true }
pages:
  - id: resumen
    title: "Resumen por Empresa"
    piece:
      table:
        data: data.resumen
        columns: [{ field: empresa_codigo, label: "Empresa" }, { field: cliente, label: "Cliente" }]
        drillthrough:
          - { to: detalle, by: [empresa_codigo, cliente], label: "Documentos" }
  - id: detalle
    title: "Detalle por Documento"
    context:
      - { key: empresa_codigo, label: "Empresa" }
      - { key: cliente, label: "Cliente" }
    piece:
      table:
        data: data.docs
        columns: [{ field: doc, label: "Documento" }, { field: centro, label: "Centro" }]
data:
  periodos: { capability: mock-sql, params: { sql: "SELECT periodo FROM dbo.periodos" } }
  centros: { capability: mock-sql, params: { sql: "SELECT DISTINCT centro FROM dbo.centros" } }
  resumen: { capability: mock-sql, params: { sql: "SELECT empresa_codigo, cliente FROM dbo.resumen WHERE periodo = :ctx.periodo" } }
  docs:
    capability: mock-sql
    params: { sql: "SELECT doc, centro FROM dbo.docs WHERE empresa_codigo = :ctx.empresa_codigo AND cliente = :ctx.cliente AND periodo = :ctx.periodo AND :flt.centro" }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

const mock: Capability = {
  name: 'mock-sql',
  async execute(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sql: string }
    if (/dbo\.periodos/.test(p.sql)) return { rows: [{ periodo: '2026-10' }, { periodo: '2026-11' }] }
    if (/dbo\.centros/.test(p.sql)) return { rows: [{ centro: '100000' }, { centro: '330501' }] }
    if (/dbo\.resumen/.test(p.sql)) return { rows: [{ empresa_codigo: 'E1', cliente: 'C7' }] }
    return { rows: [{ doc: 'F-1', centro: '330501' }] }
  },
}

/** Una navegación tal como la pediría el navegador: la query de un `href` servido. */
async function navegar(query: string): Promise<string> {
  const q = new URLSearchParams(query.replace(/^\?/, ''))
  const ctx: Record<string, string | string[]> = {}
  const flt: Record<string, string | string[]> = {}
  for (const [k, v] of q) {
    const into = k.startsWith('ctx.') ? ctx : k.startsWith('flt.') ? flt : undefined
    if (!into) continue
    const key = k.slice(4)
    const prev = into[key]
    into[key] = prev === undefined ? v : [...(Array.isArray(prev) ? prev : [prev]), v]
  }
  const dir = mkdtempSync(join(tmpdir(), 'vergis-458-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, YAML)
  const out = await runSpec({
    specPath,
    baseDir: dir,
    extraCapabilities: [mock],
    page: q.get('page') ?? undefined,
    ctx,
    flt,
    from: q.get('from') ?? undefined,
  })
  return out.html ?? ''
}

const dec = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
const hrefDrill = (html: string) => dec(/<a[^>]*class="vt-drill-link"[^>]*href="([^"]*)"|<a[^>]*href="([^"]*)"[^>]*class="vt-drill-link"/.exec(html)!.slice(1).find(Boolean)!)
/** El `href` de la opción `valor` del filtro de bandeja `id`. */
function hrefOpcion(html: string, id: string, valor: string): string {
  const faceta = new RegExp(`<div class="faceta" data-flt="${id}">[\\s\\S]*?</div></div>`).exec(html)?.[0] ?? ''
  const m = new RegExp(`<a href="([^"]*)" role="checkbox"[^>]*><span class="vflt-box">[^<]*</span> ${valor}</a>`).exec(faceta)
  return dec(m?.[1] ?? '')
}
const hrefQuitarChip = (html: string) => dec(/<a class="vflt-x" href="([^"]*)"/.exec(html)?.[1] ?? '')
const PIEZA_GUIA = 'Selecciona un registro en otra vista'
const sellos = (html: string) => [...html.matchAll(/vctx-drill" data-ctx="([^"]+)"/g)].map((m) => m[1])
/** El regreso a la vista de origen: todo enlace de regreso lleva `vret=1` (#422). */
const volver = (html: string) => /<a[^>]*href="([^"]*vret=1)"/.exec(html)?.[1]

describe('#458 · drill → filtro de bandeja → la vista sigue en el registro', () => {
  it('elegir una opción conserva las claves del drill, el período y el from', async () => {
    const resumen = await navegar('?page=resumen')
    const drill = hrefDrill(resumen)
    const detalle = await navegar(drill)
    expect(detalle).not.toContain(PIEZA_GUIA)

    const opcion = hrefOpcion(detalle, 'centro', '330501')
    expect(opcion).not.toBe('')
    const q = new URLSearchParams(opcion.replace(/^\?/, ''))
    expect(q.get('page')).toBe('detalle')
    expect(q.get('ctx.empresa_codigo')).toBe('E1')
    expect(q.get('ctx.cliente')).toBe('C7')
    expect(q.get('ctx.periodo')).toBe('2026-11')
    expect(q.get('from')).toBe(new URLSearchParams(drill.replace(/^\?/, '')).get('from'))
    expect(q.getAll('flt.centro')).toEqual(['330501'])

    const filtrada = await navegar(opcion)
    expect(filtrada).not.toContain(PIEZA_GUIA)
    expect(filtrada).toContain('F-1')
    expect(sellos(filtrada)).toEqual(['empresa_codigo', 'cliente'])
    // …y con su regreso a la vista de origen.
    expect(volver(filtrada)).toBeDefined()
    expect(dec(volver(filtrada)!)).toContain('page=resumen')
  })

  it('quitar el filtro (× del chip) también conserva el registro y su regreso', async () => {
    const detalle = await navegar(hrefDrill(await navegar('?page=resumen')))
    const filtrada = await navegar(hrefOpcion(detalle, 'centro', '330501'))
    const quitar = hrefQuitarChip(filtrada)
    expect(quitar).not.toBe('')
    const q = new URLSearchParams(quitar.replace(/^\?/, ''))
    expect(q.get('ctx.empresa_codigo')).toBe('E1')
    expect(q.get('ctx.cliente')).toBe('C7')
    expect(q.get('from')).toContain('page=resumen')
    expect(q.getAll('flt.centro')).toEqual([])
    const sinFiltro = await navegar(quitar)
    expect(sinFiltro).not.toContain(PIEZA_GUIA)
    expect(volver(sinFiltro)).toBeDefined()
  })

  it('la pieza-guía no nombra parámetros técnicos', async () => {
    const huerfana = await navegar('?page=detalle')
    expect(huerfana).toContain(PIEZA_GUIA)
    expect(huerfana).not.toMatch(/falta:/)
    expect(huerfana).not.toContain('empresa_codigo')
  })
})
