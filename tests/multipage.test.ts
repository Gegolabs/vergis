import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec } from '@vergis/mira'
import { VergisError, type Capability } from '@vergis/botler'

/**
 * Capacidad multi-vista (pages) + drill-through. La tesis (canon): el drill ACOTA dentro de lo
 * autorizado, nunca AMPLÍA — el `ctx` se bindea como parámetro (injection-safe) y es un filtro
 * ADICIONAL sobre la misma fuente gobernada. Acá: validación del DSL + render por-vista + paso del
 * contexto a la capability (bind) + guardia de contexto faltante.
 */

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object

const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

// --- Spec testigo: cartera multi-vista (Clientes → Detalle por socio) -------
const MULTI_YAML = `
mira_version: "1.0"
identity: { id: pi-cartera-test, display_name: "Cartera Test", classification: internal }
pages:
  - id: clientes
    title: "Clientes"
    piece:
      table:
        data: data.clientes
        columns:
          - { field: socio, label: "Socio" }
          - { field: saldo, label: "Saldo", format: int_0, align: right }
        drillthrough: { to: detalle, by: socio }
  - id: detalle
    title: "Detalle"
    context: [socio]
    piece:
      table:
        data: data.detalle
        columns:
          - { field: doc, label: "Documento" }
          - { field: monto, label: "Monto", format: int_0, align: right }
data:
  clientes: { capability: mock-sql, params: { sql: "SELECT socio, saldo FROM dbo.saldo" } }
  detalle:  { capability: mock-sql, params: { sql: "SELECT doc, monto FROM dbo.documento WHERE socio = :ctx.socio" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

// Capability falsa: devuelve fixtures y RECUERDA los últimos params (para asertar el bind del ctx).
function makeMockSql() {
  const calls: { sql: string; params?: Record<string, unknown> }[] = []
  const cap: Capability = {
    name: 'mock-sql',
    async execute(params: unknown): Promise<unknown> {
      const p = (params ?? {}) as { sql: string; params?: Record<string, unknown> }
      calls.push({ sql: p.sql, params: p.params })
      if (/dbo\.saldo/.test(p.sql)) {
        return { rows: [ { socio: 'A', saldo: 100 }, { socio: 'B', saldo: 200 } ] }
      }
      // Detalle: filtra por el parámetro BIND ctx_socio (injection-safe), nunca por el string.
      const socio = p.params?.['ctx_socio']
      const all = [
        { socio: 'A', doc: 'D1', monto: 60 },
        { socio: 'A', doc: 'D2', monto: 40 },
        { socio: 'B', doc: 'D3', monto: 200 },
      ]
      return { rows: all.filter((r) => r.socio === socio) }
    },
  }
  return { cap, calls }
}

async function render(yaml: string, nav: { page?: string; ctx?: Record<string, string> } = {}) {
  const { cap, calls } = makeMockSql()
  const dir = mkdtempSync(join(tmpdir(), 'vergis-mp-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yaml)
  const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [cap], page: nav.page, ctx: nav.ctx })
  return { out, calls }
}

describe('multi-vista · validación del DSL', () => {
  it('spec multi-vista válido pasa', () => {
    expect(() => validate(parseSpec(MULTI_YAML))).not.toThrow()
  })

  it('piece y pages a la vez → rechazo (xor)', () => {
    const s = parseSpec(MULTI_YAML) as Record<string, unknown>
    s['piece'] = { markdown_block: { content: 'x' } }
    expect(() => validate(s)).toThrow(VergisError)
  })

  it('ni piece ni pages → rechazo', () => {
    const s = parseSpec(MULTI_YAML) as Record<string, unknown>
    delete s['pages']
    expect(() => validate(s)).toThrow(/no declara/)
  })

  it('drill a una vista inexistente → rechazo', () => {
    const s = parseSpec(MULTI_YAML.replace('to: detalle', 'to: fantasma')) as Record<string, unknown>
    expect(() => validate(s)).toThrow(/no es una página declarada/)
  })

  it('drill que pasa un campo no declarado en el context del destino → rechazo', () => {
    // Detalle declara context: [socio]; drilleamos por 'rut' (no está en su context).
    const s = parseSpec(MULTI_YAML.replace('by: socio', 'by: rut')) as Record<string, unknown>
    expect(() => validate(s)).toThrow(/no declara/)
  })

  it('id de página duplicado → rechazo', () => {
    const dup = MULTI_YAML.replace('id: detalle', 'id: clientes')
    expect(() => validate(parseSpec(dup))).toThrow(/duplicado/)
  })
})

describe('multi-vista · render por vista + drill-through', () => {
  it('vista por defecto (sin page) = la 1ª: nav con activa + tabla con filas drilleables', async () => {
    const { out, calls } = await render(MULTI_YAML)
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    // Barra de navegación de vistas, con Clientes activa.
    expect(html).toContain('class="vpages"')
    expect(html).toContain('<a href="?page=clientes" class="active"')
    expect(html).toContain('<a href="?page=detalle"')
    // Drill embebido en el payload de la tabla → cada fila hoja navega a detalle por socio.
    expect(html).toContain('"drill":{"to":"detalle","by":"socio"}')
    // Solo se consultó el dataset de la vista activa (clientes), no el de detalle.
    expect(calls.length).toBe(1)
    expect(calls[0].sql).toContain('dbo.saldo')
  })

  it('page=detalle con ctx.socio=A: el ctx llega BINDEADO y filtra (acota, no amplía)', async () => {
    const { out, calls } = await render(MULTI_YAML, { page: 'detalle', ctx: { socio: 'A' } })
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(html).toContain('<a href="?page=detalle" class="active"')
    // El :ctx.socio del spec se reescribió a un parámetro bind @ctx_socio (injection-safe).
    expect(calls.length).toBe(1)
    expect(calls[0].sql).toContain('@ctx_socio')
    expect(calls[0].sql).not.toContain(':ctx.socio')
    expect(calls[0].params?.['ctx_socio']).toBe('A')
    // Render trae los 2 documentos del socio A (D1, D2) y no el de B (D3).
    expect(html).toContain('D1')
    expect(html).toContain('D2')
    expect(html).not.toContain('D3')
  })

  it('page=detalle SIN ctx (acceso directo, no por drill): guía + cero consultas', async () => {
    const { out, calls } = await render(MULTI_YAML, { page: 'detalle' })
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(html).toContain('Selecciona un registro')
    expect(calls.length).toBe(0) // no se vuelca data sin contexto
  })
})
