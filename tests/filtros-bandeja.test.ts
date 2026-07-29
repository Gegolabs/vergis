// #82 · Filtros de bandeja server-side + cascada.
//
// La distinción que se está probando: un CONTROL es alcance (siempre acota, sello en la banda); un
// FILTRO es sustracción OPCIONAL (default = documento completo, control en la bandeja, chip en la
// cara). El re-anclaje es por NAVEGACIÓN + re-render server-side — es lo único que puede re-anclar un
// chart, porque el SVG está horneado.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec, applyFlt, resolveFilters, normalizeFlt, filterCarry, FILTER_MAX_VALUES } from '@vergis/mira'
import { VergisError, type Capability } from '@vergis/botler'
import { navFromUrl } from '../server/nav'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })
/** Valida SIN el schema (schema permisivo): aísla la capa semántica de `validateFilters`. */
const validateFilters = (yaml: string) => validateSpec(parseSpec(yaml), { capabilities: CAPS, schema: {} })

// ── Fixture: dominio NEUTRO (el Producto es genérico; ninguna instancia se asoma a sus tests) ──
// El catálogo cruza dos niveles (familia → tipo) para ejercitar la cascada.
const CATALOGO = [
  { familia: 'Norte', tipo: 'A1' },
  { familia: 'Norte', tipo: 'A2' },
  { familia: 'Sur', tipo: 'B1' },
  { familia: 'Sur', tipo: 'B2' },
]

const HECHOS = [
  { familia: 'Norte', tipo: 'A1', monto: 10 },
  { familia: 'Norte', tipo: 'A2', monto: 20 },
  { familia: 'Sur', tipo: 'B1', monto: 30 },
  { familia: 'Sur', tipo: 'B2', monto: 40 },
]

const YAML = `
mira_version: "1.0"
identity: { id: pi-flt, display_name: "Filtros", classification: internal }
filters:
  - { id: familia, label: Familia, source: data.catalogo.familia }
  - { id: tipo, label: Tipo, source: data.catalogo.tipo, multi: true, depends_on: familia }
piece:
  layout: rows
  elements:
    - kpi: { label: "Total", agg: { op: sum, field: monto, dataset: hechos } }
    - distribution: { dimension: data.hechos.tipo, metric: data.hechos.monto, title: "Por tipo" }
    - table: { data: data.hechos, columns: [{ field: tipo }, { field: monto }] }
data:
  catalogo:
    capability: mock-sql
    params: { sql: "SELECT DISTINCT familia, tipo FROM dbo.cat" }
    shape: { type: rows, fields: { familia: string, tipo: string } }
  hechos:
    capability: mock-sql
    params: { sql: "SELECT familia, tipo, monto FROM dbo.h WHERE 1=1 AND :flt.familia AND :flt.tipo" }
    shape: { type: rows, fields: { familia: string, tipo: string, monto: number } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

/**
 * Capability mock que EMULA el motor: aplica de verdad el `IN (@binds)` reescrito, para que el test
 * mida el re-anclaje del documento y no solo la forma del SQL. `rlsScope` recorta las filas ANTES
 * que el filtro — así se puede probar que el filtro jamás amplía lo que la RLS autorizó.
 */
function mockSql(opts: { rlsScope?: (r: Record<string, unknown>) => boolean } = {}): Capability & {
  lastSql: Record<string, string>
  lastBinds: Record<string, Record<string, unknown>>
} {
  const cap = {
    name: 'mock-sql',
    lastSql: {} as Record<string, string>,
    lastBinds: {} as Record<string, Record<string, unknown>>,
    async execute(params: unknown) {
      const p = (params ?? {}) as { sql?: string; params?: Record<string, unknown> }
      const sql = p.sql ?? ''
      const binds = p.params ?? {}
      const key = sql.includes('dbo.cat') ? 'catalogo' : 'hechos'
      cap.lastSql[key] = sql
      cap.lastBinds[key] = binds
      if (key === 'catalogo') return { rows: CATALOGO }
      let rows = HECHOS.filter((r) => (opts.rlsScope ? opts.rlsScope(r) : true))
      // Emula el predicado: por cada `col IN (@flt_<id>_i)` del SQL, exige pertenencia.
      for (const m of sql.matchAll(/(\w+) IN \(([^)]+)\)/g)) {
        const col = m[1]
        const vals = m[2]
          .split(',')
          .map((b) => String(binds[b.trim().slice(1)] ?? ''))
          .filter((v) => v !== '')
        rows = rows.filter((r) => vals.includes(String(r[col as keyof typeof r])))
      }
      return { rows }
    },
  }
  return cap
}

async function render(flt?: Record<string, string | string[]>, cap = mockSql()) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-flt-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, YAML)
  const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [cap], flt })
  return { out, cap }
}

/** Filas del `<tbody>` de la tabla renderizada (el documento re-anclado, no el SQL). */
function tableRowCount(html: string): number {
  const i = html.indexOf('<tbody>')
  if (i < 0) return 0
  return (html.slice(i, html.indexOf('</tbody>', i)).match(/<tr/g) ?? []).length
}

describe('#82 · validación del bloque `filters`', () => {
  it('un spec bien formado pasa', () => {
    expect(() => validate(parseSpec(YAML))).not.toThrow()
  })

  it('`:flt.` huérfano en el SQL → error estructurado, no silencio', () => {
    const bad = YAML.replace('AND :flt.tipo', 'AND :flt.tipo AND :flt.inexistente')
    expect(() => validate(parseSpec(bad))).toThrow(/no hay un filtro 'inexistente' declarado/)
    try {
      validate(parseSpec(bad))
    } catch (e) {
      expect((e as VergisError).structured.code).toBe('filter-placeholder-dangling')
    }
  })

  it('filtro declarado que ningún SQL usa → error (sería un control que no mueve nada)', () => {
    const bad = YAML.replace(' AND :flt.tipo', '')
    expect(() => validate(parseSpec(bad))).toThrow(/no se usa en ninguna query/)
  })

  it('`source` colgante → rechazo', () => {
    const bad = YAML.replace('source: data.catalogo.familia', 'source: data.no_existe.familia')
    expect(() => validate(parseSpec(bad))).toThrow(/no resuelve a un data/)
  })

  it('campo de `source` no declarado en shape → rechazo', () => {
    const bad = YAML.replace('source: data.catalogo.familia', 'source: data.catalogo.no_existe')
    expect(() => validate(parseSpec(bad))).toThrow(/no está declarado en data\.catalogo\.shape\.fields/)
  })

  it('`depends_on` hacia un filtro NO declarado antes → rechazo (cadena simple, sin ciclos)', () => {
    const bad = YAML.replace(
      '  - { id: familia, label: Familia, source: data.catalogo.familia }\n  - { id: tipo, label: Tipo, source: data.catalogo.tipo, multi: true, depends_on: familia }',
      '  - { id: tipo, label: Tipo, source: data.catalogo.tipo, multi: true, depends_on: familia }\n  - { id: familia, label: Familia, source: data.catalogo.familia }',
    )
    expect(() => validate(parseSpec(bad))).toThrow(/no es un filtro declarado ANTES/)
  })

  it('autorreferencia en `depends_on` → rechazo', () => {
    const bad = YAML.replace('depends_on: familia', 'depends_on: tipo')
    expect(() => validate(parseSpec(bad))).toThrow(/no es un filtro declarado ANTES/)
  })

  it('`column` con algo que no es identificador SQL → rechazo (se INTERPOLA en el predicado)', () => {
    const bad = YAML.replace(
      '{ id: familia, label: Familia, source: data.catalogo.familia }',
      `{ id: familia, label: Familia, source: data.catalogo.familia, column: "1=1 OR 1=1--" }`,
    )
    // Doble muralla: el patrón del schema lo ataja primero; `validateFilters` repite el chequeo para
    // el caso en que la spec no pase por el schema (compose invocado suelto, otra versión del DSL).
    expect(() => validate(parseSpec(bad))).toThrow(/column must match pattern/)
    expect(() => validateFilters(bad)).toThrow(/no es un identificador SQL admisible/)
  })

  it('id de filtro que colisiona con el `param` de un control → rechazo', () => {
    const bad = YAML.replace(
      'filters:',
      'controls:\n  - { id: familia, source: data.catalogo.familia }\nfilters:',
    )
    expect(() => validate(parseSpec(bad))).toThrow(/misma llave que un control/)
  })
})

describe('#82 · applyFlt: predicado y binds', () => {
  const cols = { familia: 'familia', tipo: 'dbo.h.[tipo]' }
  const sel = (id: string, selected: string[], multi = false) => ({ id, label: id, multi, options: selected, selected })

  it('sin selección ⇒ `1=1` (ausencia = sin efecto)', () => {
    const out = applyFlt({ sql: 'SELECT 1 WHERE :flt.familia' }, [sel('familia', [])], cols)
    expect(out?.['sql']).toBe('SELECT 1 WHERE 1=1')
    expect(out?.['params']).toEqual({})
  })

  it('con selección ⇒ `col IN (@binds)`, con los valores como PARÁMETROS', () => {
    const out = applyFlt({ sql: 'SELECT 1 WHERE :flt.tipo' }, [sel('tipo', ['A1', 'A2'], true)], cols)
    expect(out?.['sql']).toBe('SELECT 1 WHERE dbo.h.[tipo] IN (@flt_tipo_0, @flt_tipo_1)')
    expect(out?.['params']).toEqual({ flt_tipo_0: 'A1', flt_tipo_1: 'A2' })
  })

  it('INYECCIÓN: el valor jamás se interpola — viaja como bind, intacto', () => {
    const evil = `'; DROP TABLE dbo.h; --`
    const out = applyFlt({ sql: 'SELECT 1 WHERE :flt.familia' }, [sel('familia', [evil])], cols)
    expect(out?.['sql']).toBe('SELECT 1 WHERE familia IN (@flt_familia_0)')
    expect(out?.['sql']).not.toContain('DROP')
    expect((out?.['params'] as Record<string, unknown>)['flt_familia_0']).toBe(evil)
  })

  it('sin `:flt.` en el SQL es no-op (no toca los params)', () => {
    const params = { sql: 'SELECT 1' }
    expect(applyFlt(params, [sel('familia', ['Norte'])], cols)).toBe(params)
  })

  it('`:flt.` sin filtro declarado degrada a `1=1` y se reporta en `missing`', () => {
    const missing: string[] = []
    const out = applyFlt({ sql: 'SELECT 1 WHERE :flt.fantasma' }, [], cols, missing)
    expect(out?.['sql']).toBe('SELECT 1 WHERE 1=1')
    expect(missing).toEqual(['fantasma'])
  })

  it('preserva los binds que ya traía la query (p.ej. los de `:ctx.`)', () => {
    const out = applyFlt({ sql: 'WHERE x=@ctx_a AND :flt.familia', params: { ctx_a: 'v' } }, [sel('familia', ['Norte'])], cols)
    expect(out?.['params']).toEqual({ ctx_a: 'v', flt_familia_0: 'Norte' })
  })
})

describe('#82 · resolveFilters: cascada y saneo', () => {
  const FILTERS = [
    { id: 'familia', label: 'Familia', source: 'data.catalogo.familia' },
    { id: 'tipo', label: 'Tipo', source: 'data.catalogo.tipo', multi: true, depends_on: 'familia' },
  ]
  const catalogs = { catalogo: CATALOGO }

  it('sin selección: todas las opciones, nada seleccionado', () => {
    const r = resolveFilters(FILTERS, catalogs, {})
    expect(r[0].options).toEqual(['Norte', 'Sur'])
    expect(r[1].options).toEqual(['A1', 'A2', 'B1', 'B2'])
    expect(r.every((f) => f.selected.length === 0)).toBe(true)
  })

  it('CASCADA: elegir el padre reduce las opciones del hijo', () => {
    const r = resolveFilters(FILTERS, catalogs, { familia: ['Norte'] })
    expect(r[1].options).toEqual(['A1', 'A2'])
  })

  it('selección HUÉRFANA del hijo se limpia sola al cambiar el padre', () => {
    const r = resolveFilters(FILTERS, catalogs, { familia: ['Norte'], tipo: ['B1'] })
    expect(r[0].selected).toEqual(['Norte'])
    // 'B1' pertenece a Sur: ya no es opción bajo Norte, así que se descarta.
    expect(r[1].selected).toEqual([])
  })

  it('un valor fuera del catálogo se DESCARTA (typo o intento de inyección)', () => {
    const r = resolveFilters(FILTERS, catalogs, { familia: [`'; DROP TABLE x; --`] })
    expect(r[0].selected).toEqual([])
  })

  it('un filtro single no se convierte en multi por una URL con varios valores', () => {
    const r = resolveFilters(FILTERS, catalogs, { familia: ['Norte', 'Sur'] })
    expect(r[0].selected).toEqual(['Norte'])
  })

  it('un filtro multi conserva todos los valores válidos', () => {
    const r = resolveFilters(FILTERS, catalogs, { tipo: ['A1', 'B2'] })
    expect(r[1].selected).toEqual(['A1', 'B2'])
  })

  it('guard defensivo: más de FILTER_MAX_VALUES valores → error estructurado', () => {
    const many = Array.from({ length: FILTER_MAX_VALUES + 1 }, (_, i) => `v${i}`)
    const wide = [{ id: 'x', source: 'data.c.v', multi: true }]
    const cat = { c: many.map((v) => ({ v })) }
    expect(() => resolveFilters(wide, cat, { x: many })).toThrow(/el tope es 100/)
  })

  it('filterCarry expone solo lo seleccionado', () => {
    expect(filterCarry(resolveFilters(FILTERS, catalogs, { familia: ['Sur'] }))).toEqual({ familia: ['Sur'] })
  })

  it('normalizeFlt acepta valor único o repetido y descarta vacíos', () => {
    expect(normalizeFlt({ a: 'x', b: ['y', '', 'z'], c: '' })).toEqual({ a: ['x'], b: ['y', 'z'] })
  })
})

describe('#82 · transporte por URL', () => {
  it('navFromUrl separa `ctx.` de `flt.` y acumula los repetidos', () => {
    const nav = navFromUrl('/pi?page=p1&ctx.semana=W1&flt.tipo=A1&flt.tipo=A2&flt.familia=Norte')
    expect(nav.page).toBe('p1')
    expect(nav.ctx).toEqual({ semana: 'W1' })
    expect(nav.flt).toEqual({ tipo: ['A1', 'A2'], familia: 'Norte' })
  })
  it('sin `flt.` en la URL, `flt` queda undefined', () => {
    expect(navFromUrl('/pi?ctx.a=1').flt).toBeUndefined()
  })
})

describe('#82 · el documento se re-ancla de verdad', () => {
  it('default sin selección = documento completo (4 filas, total 100)', async () => {
    const { out } = await render()
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(tableRowCount(html)).toBe(4)
    expect(html).toContain('100')
    // Sin selección no hay franja de chips (ausencia = sin ruido en la cara).
    expect(html).not.toContain('vfltbar')
  })

  it('seleccionar re-ancla KPI, chart Y tabla de una vez (re-render server-side)', async () => {
    const { out, cap } = await render({ familia: 'Norte' })
    const html = out.html ?? ''
    expect(tableRowCount(html)).toBe(2)
    // El KPI se recalculó sobre el dato re-anclado: 10 + 20 = 30.
    expect(html).toContain('>30<')
    // El chart es SVG horneado: si no se re-anclara, seguiría dibujando 4 barras.
    const chart = html.slice(html.indexOf('<section class="chart">'))
    expect((chart.match(/aria-roledescription="bar"/g) ?? []).length).toBe(2)
    // Y el SQL llevó el predicado con binds.
    expect(cap.lastSql['hechos']).toContain('familia IN (@flt_familia_0)')
    expect(cap.lastBinds['hechos']).toEqual({ flt_familia_0: 'Norte' })
  })

  it('el filtro multi compone con el padre (cascada aplicada al dato)', async () => {
    const { out } = await render({ familia: 'Norte', tipo: 'A1' })
    expect(tableRowCount(out.html ?? '')).toBe(1)
  })

  it('valores fuera del catálogo se descartan: el documento queda completo', async () => {
    const { out, cap } = await render({ familia: 'Marte' })
    expect(tableRowCount(out.html ?? '')).toBe(4)
    expect(cap.lastSql['hechos']).not.toContain('IN (')
  })

  it('NO-AMPLIFICACIÓN post-RLS: un filtro jamás devuelve filas que la RLS no autorizó', async () => {
    // La RLS mock solo autoriza «Norte». Pedir «Sur» —una opción legítima del catálogo— no puede
    // traer filas de Sur: el filtro compone DENTRO de la query recortada, es sustractivo.
    const cap = mockSql({ rlsScope: (r) => r['familia'] === 'Norte' })
    const { out } = await render({ familia: 'Sur' }, cap)
    expect(out.ok).toBe(true)
    expect(tableRowCount(out.html ?? '')).toBe(0)
    const sinFiltro = await render(undefined, mockSql({ rlsScope: (r) => r['familia'] === 'Norte' }))
    // Y el universo sin filtro sigue siendo el que la RLS autorizó, no más.
    expect(tableRowCount(sinFiltro.out.html ?? '')).toBe(2)
  })
})

describe('#82 · superficie', () => {
  it('control en la BANDEJA: una sección por filtro, con sus opciones como links de navegación', async () => {
    const { out } = await render()
    const html = out.html ?? ''
    expect(html).toContain('data-flt="familia"')
    expect(html).toContain('data-flt="tipo"')
    expect(html).toMatch(/href="[^"]*flt\.familia=Norte/)
  })

  it('la bandeja abre en «Controles» cuando hay filtros (no en el empty-state)', async () => {
    const { out } = await render()
    expect(out.html ?? '').not.toContain('Esta vista no tiene filtros disponibles.')
  })

  it('CHIP removible en la cara por cada valor activo, y el × navega quitándolo', async () => {
    const { out } = await render({ familia: 'Norte' })
    const html = out.html ?? ''
    const start = html.indexOf('<div class="vfltbar">')
    const bar = html.slice(start, html.indexOf('</div>', start) + 6)
    expect(bar).toContain('Familia:')
    expect(bar).toContain('Norte')
    // El href del × NO lleva el valor que remueve.
    const x = /class="vflt-x" href="([^"]*)"/.exec(html)
    expect(x).not.toBeNull()
    expect(x![1]).not.toContain('flt.familia=Norte')
  })

  it('las opciones del hijo que se muestran YA vienen cascadeadas', async () => {
    const { out } = await render({ familia: 'Norte' })
    const html = out.html ?? ''
    const seccion = html.slice(html.indexOf('data-flt="tipo"'))
    const opciones = seccion.slice(0, seccion.indexOf('</div></div>'))
    expect(opciones).toContain('A1')
    expect(opciones).not.toContain('B1')
  })

  it('en print los chips se ocultan y queda el resumen en letra chica', async () => {
    const { out } = await render({ familia: 'Norte' })
    const html = out.html ?? ''
    expect(html).toContain('class="vflt-print"')
    expect(html).toMatch(/@media print\{[^}]*\.vflt-screen\{display:none!important\}/)
  })

  it('los `flt.` viajan en el carry de la navegación de páginas y de los drills', async () => {
    const { out } = await render({ familia: 'Norte' })
    const html = out.html ?? ''
    // El payload del runtime de tabla lleva el sufijo ya serializado (un solo lugar que lo arma).
    expect(html).toContain('"fltQ":"&flt.familia=Norte"')
  })
})

describe('#82 · `interactions.filters` (client-side) queda intacto', () => {
  it('un spec sin bloque `filters` no emite ninguna superficie de #82', async () => {
    const yaml = YAML.replace(
      /filters:\n  - \{ id: familia[^\n]*\n  - \{ id: tipo[^\n]*\n/,
      '',
    ).replace(' AND :flt.familia AND :flt.tipo', '')
    const dir = mkdtempSync(join(tmpdir(), 'vergis-flt0-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, yaml)
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql()] })
    expect(out.ok).toBe(true)
    expect(out.html ?? '').not.toContain('vfltbar')
    expect(out.html ?? '').not.toContain('data-flt=')
  })
})
