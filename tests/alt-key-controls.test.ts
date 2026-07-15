// Llaves alternativas del mismo alcance (work/079): un control gana los roles `param` (a qué
// `ctx.<param>` escribe, default id) y `display` (qué campo del MISMO dataset se muestra como etiqueta,
// default el de source). Dos controles con el mismo `param` = llaves alternativas → sellos
// sincronizados en la banda (elegir por cualquiera fija el MISMO ctx.<param>). Cubre: los pares
// {value,label} y su formato (recorte ISO, colisión desambiguada), las validaciones de param
// compartido, la resolución+render end-to-end del fixture PI-07 y la COMPAT total sin param/display.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec, buildControlOptions, trimIsoLabel, labelForValue } from '@vergis/mira'
import type { Capability } from '@vergis/botler'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Pares {value,label}: value de source, label de display, con formato y dedupe.
// ─────────────────────────────────────────────────────────────────────────────
describe('WP1 · buildControlOptions — pares {value,label}', () => {
  const rows = [
    { oc: '17400359', fecha_fin_recepcion: '2026-07-22T00:00:00' },
    { oc: '17400358', fecha_fin_recepcion: '2026-07-20T00:00:00' },
  ]

  it('value del campo de source, label del campo de display (recortado si es ISO)', () => {
    // orden numeric-aware por value (…358 antes que …359).
    expect(buildControlOptions(rows, 'oc', 'fecha_fin_recepcion')).toEqual([
      { value: '17400358', label: '2026-07-20' },
      { value: '17400359', label: '2026-07-22' },
    ])
  })

  it('sin display propio (display = campo de source) → label = value (compat)', () => {
    expect(buildControlOptions(rows, 'oc', 'oc')).toEqual([
      { value: '17400358', label: '17400358' },
      { value: '17400359', label: '17400359' },
    ])
  })

  it('dedupe por value (1ª aparición) y descarta value vacío', () => {
    const dup = [{ oc: 'A', d: 'x' }, { oc: 'A', d: 'y' }, { oc: '', d: 'z' }]
    expect(buildControlOptions(dup, 'oc', 'd')).toEqual([{ value: 'A', label: 'x' }])
  })

  it('display vacío/null cae al value (nunca etiqueta en blanco)', () => {
    const r = [{ oc: 'A', d: null }, { oc: 'B', d: '' }]
    expect(buildControlOptions(r, 'oc', 'd')).toEqual([
      { value: 'A', label: 'A' },
      { value: 'B', label: 'B' },
    ])
  })

  it('colisión de etiqueta entre values distintos → « label (value) » en ambos', () => {
    const same = [
      { oc: '17400358', f: '2026-07-20T00:00:00' },
      { oc: '17400359', f: '2026-07-20T09:30:00' },
    ]
    expect(buildControlOptions(same, 'oc', 'f')).toEqual([
      { value: '17400358', label: '2026-07-20 (17400358)' },
      { value: '17400359', label: '2026-07-20 (17400359)' },
    ])
  })
})

describe('WP1 · trimIsoLabel + labelForValue', () => {
  it('recorta ISO-datetime a YYYY-MM-DD; el resto pasa intacto', () => {
    expect(trimIsoLabel('2026-07-20T00:00:00')).toBe('2026-07-20')
    expect(trimIsoLabel('2026-07-20T13:45')).toBe('2026-07-20')
    expect(trimIsoLabel('2026-07-20')).toBe('2026-07-20') // sin hora: intacto
    expect(trimIsoLabel('17400358')).toBe('17400358')
    expect(trimIsoLabel('Rosas premium')).toBe('Rosas premium')
  })

  it('labelForValue devuelve la etiqueta del value vigente (o el value si no está)', () => {
    const pairs = [{ value: 'A', label: 'Alfa' }, { value: 'B', label: 'Beta' }]
    expect(labelForValue(pairs, 'B')).toBe('Beta')
    expect(labelForValue(pairs, 'Z')).toBe('Z')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Validaciones de param compartido (llaves alternativas).
// ─────────────────────────────────────────────────────────────────────────────
const specWith = (controls: string, extraData = '') => `
mira_version: "1.0"
identity: { id: pi-altkey-val, display_name: "AltKey Val", classification: internal }
controls:
${controls}
piece:
  table: { data: data.lineas, columns: [{ field: sku, label: "SKU" }] }
data:
  ocs: { capability: mock-sql, params: { sql: "SELECT oc, fecha_fin_recepcion FROM dbo.ocs" } }
  lineas: { capability: mock-sql, params: { sql: "SELECT sku FROM dbo.lineas WHERE oc = :ctx.oc" } }${extraData}
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

describe('WP3 · validaciones de param compartido', () => {
  it('alt-key válido (mismo dataset, single) pasa', () => {
    const yaml = specWith(
      `  - { id: oc, label: "OC", source: data.ocs.oc, default: max }
  - { id: fecha, param: oc, display: fecha_fin_recepcion, label: "Fecha", source: data.ocs.oc, single: true }`,
    )
    expect(() => validate(parseSpec(yaml))).not.toThrow()
  })

  it('param compartido con datasets distintos → control-param-dataset-mismatch', () => {
    const yaml = specWith(
      `  - { id: oc, source: data.ocs.oc }
  - { id: fecha, param: oc, source: data.otros.oc }`,
      `
  otros: { capability: mock-sql, params: { sql: "SELECT oc FROM dbo.otros" } }`,
    )
    expect(() => validate(parseSpec(yaml))).toThrow(/mismo dataset|dataset/i)
  })

  it('param compartido con un control multi (single: false) → control-param-multi', () => {
    const yaml = specWith(
      `  - { id: oc, source: data.ocs.oc }
  - { id: fecha, param: oc, source: data.ocs.oc, single: false }`,
    )
    expect(() => validate(parseSpec(yaml))).toThrow(/single: true|multi-select/i)
  })

  it('display con campo colgante (no está en shape.fields) → rechazo', () => {
    const yaml = `
mira_version: "1.0"
identity: { id: pi-altkey-disp, display_name: "Disp", classification: internal }
controls:
  - { id: oc, label: "OC", source: data.ocs.oc, display: no_existe }
piece:
  table: { data: data.ocs, columns: [{ field: oc, label: "OC" }] }
data:
  ocs:
    capability: mock-sql
    params: { sql: "SELECT oc, fecha_fin_recepcion FROM dbo.ocs" }
    shape: { type: rows, fields: { oc: string, fecha_fin_recepcion: string } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`
    expect(() => validate(parseSpec(yaml))).toThrow(/shape\.fields|no está declarado/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Resolución + render end-to-end del fixture PI-07 (dos sellos sincronizados).
// ─────────────────────────────────────────────────────────────────────────────
const OCS = [
  { oc: '17400358', fecha_fin_recepcion: '2026-07-20T00:00:00' },
  { oc: '17400359', fecha_fin_recepcion: '2026-07-22T00:00:00' },
]
const LINEAS = [
  { sku: 'SKU-1', qty: 10, _oc: '17400358' },
  { sku: 'SKU-2', qty: 20, _oc: '17400359' },
]

const ALTKEY_YAML = `
mira_version: "1.0"
identity: { id: pi-altkey, display_name: "AltKey", classification: internal }
controls:
  - { id: oc, label: "OC", source: data.ocs.oc, default: max }
  - { id: fecha, param: oc, display: fecha_fin_recepcion, label: "Fecha Fin Recepción", source: data.ocs.oc, single: true }
piece:
  table:
    data: data.lineas
    columns:
      - { field: sku, label: "SKU" }
      - { field: qty, label: "Qty", align: right }
data:
  ocs: { capability: mock-sql, params: { sql: "SELECT oc, fecha_fin_recepcion FROM dbo.ocs" } }
  lineas: { capability: mock-sql, params: { sql: "SELECT sku, qty FROM dbo.lineas WHERE oc = :ctx.oc" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

function makeMockSql(ocsRows: Record<string, unknown>[] = OCS) {
  const cap: Capability = {
    name: 'mock-sql',
    async execute(params: unknown): Promise<unknown> {
      const p = (params ?? {}) as { sql: string; params?: Record<string, unknown> }
      if (/dbo\.ocs/.test(p.sql)) return { rows: ocsRows }
      const wantOc = String(p.params?.['ctx_oc'] ?? '')
      return { rows: LINEAS.filter((r) => r._oc === wantOc).map(({ _oc, ...r }) => r) }
    },
  }
  return cap
}

async function renderAltKey(ctx?: Record<string, string | string[]>, ocsRows: Record<string, unknown>[] = OCS) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-altkey-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, ALTKEY_YAML)
  const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [makeMockSql(ocsRows)], ctx })
  return out
}

describe('WP1/WP2 · dos sellos sincronizados por llave alternativa', () => {
  it('default max (owner) → ambos sellos en la OC mayor; la fecha muestra su etiqueta ISO recortada', async () => {
    const out = await renderAltKey()
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    // Banda con DOS sellos (dos labels distintas, mismo alcance).
    expect(html).toContain('class="vctxbar"')
    expect(html).toContain('OC')
    expect(html).toContain('Fecha Fin Recepción')
    // Sello OC: value = label = la OC vigente (default max = 17400359).
    expect(html).toContain('<option value="17400359" selected>17400359</option>')
    // Sello Fecha: MISMO value (17400359), label = fecha ISO recortada a YYYY-MM-DD.
    expect(html).toContain('<option value="17400359" selected>2026-07-22</option>')
    // El dato de la tabla es el de esa OC.
    expect(html).toContain('SKU-2')
    expect(html).not.toContain('SKU-1')
  })

  it('ambos sellos ESCRIBEN el MISMO ctx.oc (no ctx.fecha) — llaves alternativas del mismo alcance', async () => {
    const html = (await renderAltKey()).html ?? ''
    // Los dos onchange fijan ctx.oc; jamás ctx.fecha (la URL sigue siendo ctx.oc=…).
    // El onchange va HTML-escapado en el atributo (`'` → `&#39;`).
    const setOc = html.match(/set\(&#39;ctx\.oc&#39;/g) ?? []
    expect(setOc.length).toBe(2)
    expect(html).not.toContain('ctx.fecha')
  })

  it('elegir por la llave-fecha = elegir por OC: ctx.oc fija ambos sellos coherentes', async () => {
    const html = (await renderAltKey({ oc: '17400358' })).html ?? ''
    // Ambos sellos migran a 17400358; la fecha muestra 2026-07-20.
    expect(html).toContain('<option value="17400358" selected>17400358</option>')
    expect(html).toContain('<option value="17400358" selected>2026-07-20</option>')
    expect(html).not.toContain('selected>17400359')
    // El print del sello-fecha es la etiqueta (fecha), no la llave cruda.
    expect(html).toContain('<span class="vctx-v vctx-print">2026-07-20</span>')
    // El dato refleja la OC elegida por la llave alternativa.
    expect(html).toContain('SKU-1')
    expect(html).not.toContain('SKU-2')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3·bis · Objetos `Date` del driver (0.9.1): mssql/tedious devuelve columnas datetime como Date de
// JS, no como string ISO — String(dateObj) produce la forma larga («Tue May 26 2026 00:00:00 GMT…»)
// que esquivaba el recorte (bug visto en PI-07 vivo). El label debe rendir YYYY-MM-DD igual.
// ─────────────────────────────────────────────────────────────────────────────
const OCS_DATES = [
  { oc: '17400358', fecha_fin_recepcion: new Date('2026-05-26T00:00:00Z') },
  { oc: '17400359', fecha_fin_recepcion: new Date('2026-07-22T00:00:00Z') },
]

describe('0.9.1 · display datetime como objeto Date (caso del driver mssql/tedious)', () => {
  it('trimIsoLabel con Date → YYYY-MM-DD (y un Date inválido no revienta)', () => {
    expect(trimIsoLabel(new Date('2026-05-26T00:00:00Z'))).toBe('2026-05-26')
    expect(trimIsoLabel(new Date(NaN))).toBe('Invalid Date') // fail-safe: pasa como texto, no lanza
  })

  it('buildControlOptions con Dates → labels YYYY-MM-DD, jamás la forma larga', () => {
    expect(buildControlOptions(OCS_DATES, 'oc', 'fecha_fin_recepcion')).toEqual([
      { value: '17400358', label: '2026-05-26' },
      { value: '17400359', label: '2026-07-22' },
    ])
  })

  it('colisión de etiqueta también con Dates → « YYYY-MM-DD (value) »', () => {
    const same = [
      { oc: 'A', f: new Date('2026-05-26T00:00:00Z') },
      { oc: 'B', f: new Date('2026-05-26T09:30:00Z') },
    ]
    expect(buildControlOptions(same, 'oc', 'f')).toEqual([
      { value: 'A', label: '2026-05-26 (A)' },
      { value: 'B', label: '2026-05-26 (B)' },
    ])
  })

  it('e2e: opciones del sello-fecha Y el span print rinden YYYY-MM-DD con Dates del driver', async () => {
    const html = (await renderAltKey({ oc: '17400358' }, OCS_DATES)).html ?? ''
    // Label de la opción = la fecha recortada, value = la OC.
    expect(html).toContain('<option value="17400358" selected>2026-05-26</option>')
    expect(html).toContain('<option value="17400359">2026-07-22</option>')
    // El span print del sello-fecha también es la fecha corta.
    expect(html).toContain('<span class="vctx-v vctx-print">2026-05-26</span>')
    // Jamás la forma larga de String(dateObj).
    expect(html).not.toMatch(/GMT\+0000|Coordinated Universal Time|May 26 2026/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Compat total: un control clásico (sin param/display) rinde idéntico a 0.8.0.
// ─────────────────────────────────────────────────────────────────────────────
const CLASSIC_YAML = `
mira_version: "1.0"
identity: { id: pi-classic, display_name: "Classic", classification: internal }
controls:
  - { id: oc, label: "OC", source: data.ocs.oc, default: max }
piece:
  table:
    data: data.lineas
    columns: [{ field: sku, label: "SKU" }, { field: qty, label: "Qty" }]
data:
  ocs: { capability: mock-sql, params: { sql: "SELECT oc FROM dbo.ocs" } }
  lineas: { capability: mock-sql, params: { sql: "SELECT sku, qty FROM dbo.lineas WHERE oc = :ctx.oc" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

describe('WP3 · compat — sin param/display, comportamiento idéntico a 0.8.0', () => {
  it('el sello clásico escribe ctx.<id>, label = value, y no aparece displayLabel distinto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-classic-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, CLASSIC_YAML)
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [makeMockSql()], ctx: undefined })
    const html = out.html ?? ''
    expect(html).toContain('class="vctxbar"')
    // value === label (clásico), un solo sello, ctx.<id> = ctx.oc (onchange HTML-escapado).
    expect(html).toContain('<option value="17400359" selected>17400359</option>')
    expect(html).toContain('set(&#39;ctx.oc&#39;')
    // print = la llave cruda (displayLabel === value).
    expect(html).toContain('<span class="vctx-v vctx-print">17400359</span>')
  })
})
