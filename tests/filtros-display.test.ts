// #420 · Rótulo declarado para un filtro de bandeja (`filters[].display`).
//
// Lo que se prueba: el rótulo es SOLO presentación. La bandeja, el chip y el buscador leen el
// rótulo; el bind, el saneo y la URL siguen sobre el valor de `source`. Y un spec sin `display`
// rinde byte a byte lo mismo que antes de #420 (golden capturado con el código previo).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, resolveFilters, validateSpec } from '@vergis/mira'
import type { Capability } from '@vergis/botler'

const SCHEMA_PATH = resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url)))
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const GOLDEN = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('./filtros-display-420.golden.json', import.meta.url))), 'utf8'),
) as Record<string, { tray: string; chips: string }>

// ── Dominio NEUTRO: un catálogo de códigos con su nombre al lado ──
const CATALOGO = [
  { cc: 'C10', nombre: 'Bodega Central' },
  { cc: 'C02', nombre: 'Planta Norte' },
  { cc: 'C03', nombre: '' }, // sin rótulo → cae al valor
  { cc: 'C04', nombre: 'Oficina' }, // rótulo repetido → se desambigua
  { cc: 'C05', nombre: 'Oficina' },
]
const HECHOS = [
  { cc: 'C10', monto: 10 },
  { cc: 'C02', monto: 20 },
  { cc: 'C03', monto: 30 },
  { cc: 'C04', monto: 40 },
  { cc: 'C05', monto: 50 },
]

const yamlFor = (display: string | null) => `
mira_version: "1.0"
identity: { id: pi-flt-rot, display_name: "Rótulos", classification: internal }
filters:
  - { id: cc, label: Centro, source: data.catalogo.cc, multi: true${display ? `, display: ${display}` : ''} }
piece:
  layout: rows
  elements:
    - table: { data: data.hechos, columns: [{ field: cc }, { field: monto }] }
data:
  catalogo:
    capability: mock-sql
    params: { sql: "SELECT DISTINCT cc, nombre FROM dbo.cat" }
    shape: { type: rows, fields: { cc: string, nombre: string } }
  hechos:
    capability: mock-sql
    params: { sql: "SELECT cc, monto FROM dbo.h WHERE 1=1 AND :flt.cc" }
    shape: { type: rows, fields: { cc: string, monto: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

/** Mock que EMULA el `IN (@binds)` para medir el documento re-anclado, no solo el SQL. */
function mockSql(): Capability & { lastBinds: Record<string, unknown> } {
  const cap = {
    name: 'mock-sql',
    lastBinds: {} as Record<string, unknown>,
    async execute(params: unknown) {
      const p = (params ?? {}) as { sql?: string; params?: Record<string, unknown> }
      const sql = p.sql ?? ''
      if (sql.includes('dbo.cat')) return { rows: CATALOGO }
      cap.lastBinds = p.params ?? {}
      let rows = HECHOS
      for (const m of sql.matchAll(/(\w+) IN \(([^)]+)\)/g)) {
        const vals = m[2].split(',').map((b) => String((p.params ?? {})[b.trim().slice(1)] ?? ''))
        rows = rows.filter((r) => vals.includes(String(r[m[1] as keyof typeof r])))
      }
      return { rows }
    },
  }
  return cap
}

async function renderYaml(yaml: string, flt?: Record<string, string | string[]>, cap: Capability = mockSql()) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-flt420-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yaml)
  // schemaPath explícito: el schema de ESTE árbol, no el que resuelva el paquete del CLI.
  const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [cap], flt, schemaPath: SCHEMA_PATH })
  expect(out.ok).toBe(true)
  return out.html ?? ''
}

function tbody(html: string): string {
  const i = html.indexOf('<tbody>')
  return i < 0 ? '' : html.slice(i, html.indexOf('</tbody>', i))
}

function trayOf(html: string): string {
  return html.slice(
    html.indexOf('<div class="tray-panel tray-panel-controles">'),
    html.indexOf('<div class="tray-panel tray-panel-guardados">'),
  )
}

function chipsOf(html: string): string {
  const b = html.indexOf('<div class="vfltbar"')
  return b < 0 ? '' : html.slice(b, html.indexOf('</div>', b) + 6)
}

describe('#420 · resolveFilters con `display`', () => {
  const F = [{ id: 'cc', label: 'Centro', source: 'data.catalogo.cc', display: 'data.catalogo.nombre', multi: true }]
  const cat = { catalogo: CATALOGO }

  it('pares {value,label}: orden por valor, rótulo vacío → valor, rótulos repetidos desambiguados', () => {
    const [r] = resolveFilters(F, cat, {})
    expect(r.options).toEqual([
      { value: 'C02', label: 'Planta Norte' },
      { value: 'C03', label: 'C03' },
      { value: 'C04', label: 'Oficina (C04)' },
      { value: 'C05', label: 'Oficina (C05)' },
      { value: 'C10', label: 'Bodega Central' },
    ])
  })

  it('la selección se sanea por VALOR: un rótulo en la URL no es una opción y se descarta', () => {
    const [r] = resolveFilters(F, cat, { cc: ['C10', 'Planta Norte', 'C99'] })
    expect(r.selected).toEqual(['C10'])
  })

  it('sin `display` el rótulo es el valor, sin recorte ISO ni desambiguación', () => {
    const [r] = resolveFilters(
      [{ id: 'f', source: 'data.c.f' }],
      { c: [{ f: '2026-01-01T00:00:00' }, { f: 'x' }] },
      {},
    )
    expect(r.options).toEqual([
      { value: '2026-01-01T00:00:00', label: '2026-01-01T00:00:00' },
      { value: 'x', label: 'x' },
    ])
  })
})

describe('#420 · validación de `display`', () => {
  const ok = (yaml: string) => validateSpec(parseSpec(yaml), { capabilities: CAPS, schema: SCHEMA })
  const sem = (yaml: string) => validateSpec(parseSpec(yaml), { capabilities: CAPS, schema: {} })

  it('un `display` del mismo catálogo y declarado en shape pasa', () => {
    expect(() => ok(yamlFor('data.catalogo.nombre'))).not.toThrow()
  })

  it('campo de `display` no declarado en shape → filter-display-field-dangling', () => {
    expect(() => sem(yamlFor('data.catalogo.nombr'))).toThrow(/filter-display-field-dangling|no está declarado/)
  })

  it('`display` de OTRO dataset → filter-display-dangling (el rótulo se lee de la fila de la opción)', () => {
    expect(() => sem(yamlFor('data.hechos.cc'))).toThrow(/su propio catálogo/)
  })

  it('`display` sin la forma data.<dataset>.<campo> → rechazo (semántica y schema)', () => {
    expect(() => sem(yamlFor('nombre'))).toThrow(/su propio catálogo/)
    expect(() => ok(yamlFor('nombre'))).toThrow()
  })
})

describe('#420 · superficie con `display`', () => {
  it('la bandeja muestra los nombres; el href lleva el código; el buscador busca por el nombre y por el código', async () => {
    const tray = trayOf(await renderYaml(yamlFor('data.catalogo.nombre')))
    expect(tray).toContain('</span> Bodega Central</a>')
    expect(tray).toContain('data-v="bodega central c10"') // quien escribe el código también encuentra el centro
    expect(tray).toMatch(/href="[^"]*flt\.cc=C10"/)
    expect(tray).not.toContain('</span> C10</a>')
    expect(tray).toContain('</span> Oficina (C04)</a>')
    expect(tray).toContain('</span> C03</a>')
  })

  it('el chip activo muestra el nombre, y el × quita el código', async () => {
    const html = await renderYaml(yamlFor('data.catalogo.nombre'), { cc: 'C10' })
    const bar = chipsOf(html)
    expect(bar).toContain('<b>Centro:</b> Bodega Central')
    expect(bar).toContain('aria-label="Quitar Centro: Bodega Central"')
    expect(bar).toContain('Filtros — Centro: Bodega Central')
    expect(bar).not.toContain('> C10<')
  })

  it('seleccionar con `display` filtra el documento IGUAL que sin él (bind por valor)', async () => {
    const con = mockSql()
    const sin = mockSql()
    const a = await renderYaml(yamlFor('data.catalogo.nombre'), { cc: ['C10', 'C04'] }, con)
    const b = await renderYaml(yamlFor(null), { cc: ['C10', 'C04'] }, sin)
    expect(con.lastBinds).toEqual({ flt_cc_0: 'C10', flt_cc_1: 'C04' })
    expect(con.lastBinds).toEqual(sin.lastBinds)
    expect(tbody(a)).toBe(tbody(b))
    expect((tbody(a).match(/<tr/g) ?? []).length).toBe(2)
  })

  it('un valor de URL fuera del catálogo se descarta igual que hoy (documento completo)', async () => {
    const cap = mockSql()
    const html = await renderYaml(yamlFor('data.catalogo.nombre'), { cc: 'Bodega Central' }, cap)
    expect(cap.lastBinds).toEqual({})
    expect((tbody(html).match(/<tr/g) ?? []).length).toBe(5)
    expect(chipsOf(html)).toBe('')
  })
})

// ── Compatibilidad: sin `display`, la bandeja y el chip son byte a byte los de antes de #420 ──
// El golden se capturó con el código previo a #420 sobre este mismo spec; un cambio intencional de la
// bandeja lo rompe, y entonces se re-captura documentando el delta.
const CAT_GOLDEN = Array.from({ length: 30 }, (_, i) => ({
  familia: i < 15 ? 'Norte' : 'Sur',
  tipo: `T${String(i).padStart(2, '0')}`,
  f: '2026-01-0' + ((i % 9) + 1) + 'T00:00:00',
}))
const YAML_GOLDEN = `
mira_version: "1.0"
identity: { id: pi-flt, display_name: "Filtros", classification: internal }
filters:
  - { id: familia, label: Familia, source: data.catalogo.familia }
  - { id: tipo, label: Tipo, source: data.catalogo.tipo, multi: true, depends_on: familia }
  - { id: f, label: Fecha, source: data.catalogo.f }
piece:
  layout: rows
  elements:
    - table: { data: data.hechos, columns: [{ field: tipo }, { field: monto }] }
data:
  catalogo:
    capability: mock-sql
    params: { sql: "SELECT DISTINCT familia, tipo, f FROM dbo.cat" }
    shape: { type: rows, fields: { familia: string, tipo: string, f: string } }
  hechos:
    capability: mock-sql
    params: { sql: "SELECT familia, tipo, monto FROM dbo.h WHERE 1=1 AND :flt.familia AND :flt.tipo AND :flt.f" }
    shape: { type: rows, fields: { familia: string, tipo: string, monto: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`
const goldenCap: Capability = {
  name: 'mock-sql',
  async execute(p: unknown) {
    const sql = String((p as { sql?: string }).sql)
    return { rows: sql.includes('dbo.cat') ? CAT_GOLDEN : CAT_GOLDEN.map((r) => ({ ...r, monto: 1 })) }
  },
}
const CASES: Record<string, Record<string, string | string[]> | undefined> = {
  none: undefined,
  norte: { familia: 'Norte' },
  multi: { familia: 'Norte', tipo: ['T01', 'T03'] },
  fecha: { f: '2026-01-01T00:00:00' },
  bogus: { familia: 'Marte' },
}

describe('#420 · sin `display` el render no cambia (golden previo a #420)', () => {
  for (const [k, flt] of Object.entries(CASES)) {
    it(`caso ${k}: bandeja y chips idénticos byte a byte`, async () => {
      const html = await renderYaml(YAML_GOLDEN, flt, goldenCap)
      expect(trayOf(html)).toBe(GOLDEN[k].tray)
      expect(chipsOf(html)).toBe(GOLDEN[k].chips)
    })
  }
})
