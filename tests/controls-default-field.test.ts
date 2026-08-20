// #235 · `controls[].defaultField` — el default de un control puede venir DEL DATO.
// El caso real es un default MÓVIL: «la semana siguiente a hoy», sobre un dominio que se extiende al
// futuro. Ni los keywords ni el literal de #92 lo expresan — el literal CADUCA (`2026-08-24` es «la
// siguiente» durante siete días) y `first` no da acceso al orden del SQL (buildControlOptions ordena
// por value y descarta el orden de las filas). `defaultField` deja que el mismo SQL que conoce el
// calendario designe la opción, marcando una columna.
//
// Semántica cerrada (S1–S7 del diseño):
//  S1 exactamente UNA opción marcada → esa es el default.
//  S2 ninguna o más de una → defaultField NO resuelve; se evalúa `default`, y de ahí al fallback
//     universal, que es `max` (fail-safe, NO fail-closed: el conteo depende del dato).
//  S3 la URL gana siempre.  S4 defaultField y default conviven (gana defaultField cuando resuelve).
//  S5 solo el dueño del `param` lo aplica.  S6 el campo colgante es error de spec, ruidoso.
//  S7 el conteo es sobre OPCIONES (post-dedup, sin el value vacío) y el criterio de verdad es la
//     lista CERRADA de valores verdaderos — jamás truthiness de JS.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import {
  parseSpec,
  validateSpec,
  defaultFromField,
  markedDefaults,
  isDefaultFlag,
  resolveControlValue,
  resolveControlValues,
} from '@vergis/mira'
import type { Capability } from '@vergis/botler'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

// ─────────────────────────────────────────────────────────────────────────────
// 1 · isDefaultFlag — el criterio de verdad es una lista CERRADA (§2.5).
// ─────────────────────────────────────────────────────────────────────────────
describe('#235 · isDefaultFlag — lista cerrada, no truthiness de JS', () => {
  it('verdadero: true, 1, "1", "true", "t", "s", "si", "sí", "y", "yes" (case-insensitive, con trim)', () => {
    for (const v of [true, 1, '1', 'true', 'TRUE', 'T', 's', 'S', 'si', 'SI', 'sí', 'y', 'Y', 'yes', ' 1 ', ' true ']) {
      expect(isDefaultFlag(v), `esperaba verdadero para ${JSON.stringify(v)}`).toBe(true)
    }
  })

  it('LA TRAMPA: false y "false" son FALSOS — String(false) es "false", que en JS es truthy', () => {
    expect(isDefaultFlag(false)).toBe(false)
    expect(isDefaultFlag('false')).toBe(false)
    expect(isDefaultFlag('FALSE')).toBe(false)
    // El control negativo del criterio: con truthiness cruda, ambos habrían dado verdadero.
    expect(Boolean(String(false))).toBe(true)
  })

  it('falso: 0, "0", "N", "no", null, undefined, cadena vacía, y cualquier valor fuera de ambas listas', () => {
    for (const v of [0, '0', 'N', 'n', 'no', null, undefined, '', '  ', 'quizás', 2, -1, {}, []]) {
      expect(isDefaultFlag(v), `esperaba falso para ${JSON.stringify(v)}`).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · defaultFromField — el conteo es sobre OPCIONES resueltas (§2.6).
// ─────────────────────────────────────────────────────────────────────────────
describe('#235 · defaultFromField — cuenta OPCIONES, no filas', () => {
  const SEMANAS = [
    { semana: 'W30', es_default: 0 },
    { semana: 'W31', es_default: 1 },
    { semana: 'W32', es_default: 0 },
  ]

  it('exactamente una marcada → ese value (y NO el max del dominio)', () => {
    expect(defaultFromField(SEMANAS, 'semana', 'es_default')).toBe('W31')
  })

  it('ninguna marcada → undefined (defaultField no resuelve)', () => {
    const rows = SEMANAS.map((r) => ({ ...r, es_default: 0 }))
    expect(defaultFromField(rows, 'semana', 'es_default')).toBeUndefined()
  })

  it('DOS marcadas → undefined, no «la primera gana»: es S2, el dato dejó de designar UNA', () => {
    const rows = [
      { semana: 'W30', es_default: 1 },
      { semana: 'W31', es_default: 1 },
    ]
    expect(defaultFromField(rows, 'semana', 'es_default')).toBeUndefined()
  })

  it('sin filas → undefined', () => {
    expect(defaultFromField([], 'semana', 'es_default')).toBeUndefined()
  })

  it('campo ausente en las filas → undefined (nada marcado), no reventar', () => {
    expect(defaultFromField(SEMANAS, 'semana', 'no_existe')).toBeUndefined()
  })

  it('BIT del driver (true/false) y CASE WHEN ("S"/"N") resuelven igual', () => {
    const bits = [{ semana: 'W30', d: false }, { semana: 'W31', d: true }]
    expect(defaultFromField(bits, 'semana', 'd')).toBe('W31')
    const letras = [{ semana: 'W30', d: 'N' }, { semana: 'W31', d: 'S' }]
    expect(defaultFromField(letras, 'semana', 'd')).toBe('W31')
    // Las filas no marcadas suelen llegar como NULL, no como 0.
    const nulos = [{ semana: 'W30', d: null }, { semana: 'W31', d: 1 }]
    expect(defaultFromField(nulos, 'semana', 'd')).toBe('W31')
  })

  it('value VACÍO con flag verdadero → no cuenta (no es una opción)', () => {
    const rows = [
      { semana: '', es_default: 1 },
      { semana: 'W31', es_default: 1 },
    ]
    // Solo W31 es opción → hay exactamente UNA marcada, no dos.
    expect(defaultFromField(rows, 'semana', 'es_default')).toBe('W31')
    // Y con el vacío como ÚNICA fila marcada, no queda default del dato.
    expect(defaultFromField([{ semana: '', es_default: 1 }, { semana: 'W31', es_default: 0 }], 'semana', 'es_default')).toBeUndefined()
  })

  it('mismo value en dos filas con flags DISTINTOS → una sola opción, gana la 1ª aparición', () => {
    // Contar sobre FILAS diría 2 y el default se perdería por una condición invisible al usuario.
    const marcadaPrimero = [
      { semana: 'W31', es_default: 1 },
      { semana: 'W31', es_default: 0 },
      { semana: 'W32', es_default: 0 },
    ]
    expect(defaultFromField(marcadaPrimero, 'semana', 'es_default')).toBe('W31')
    // Y al revés: la 1ª aparición viene sin flag → la opción W31 NO está marcada.
    const marcadaDespues = [
      { semana: 'W31', es_default: 0 },
      { semana: 'W31', es_default: 1 },
      { semana: 'W32', es_default: 0 },
    ]
    expect(defaultFromField(marcadaDespues, 'semana', 'es_default')).toBeUndefined()
  })

  it('markedDefaults expone el CONTEO (lo que la observabilidad de S2 necesita)', () => {
    expect(markedDefaults(SEMANAS, 'semana', 'es_default')).toEqual(['W31'])
    expect(markedDefaults(SEMANAS.map((r) => ({ ...r, es_default: 0 })), 'semana', 'es_default')).toEqual([])
    expect(markedDefaults([{ semana: 'W30', d: 1 }, { semana: 'W31', d: 1 }], 'semana', 'd')).toEqual(['W30', 'W31'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · La resolución: el value del dato entra por la MISMA puerta que el literal de #92.
//     Por eso S3 (la URL gana) y el fail-safe fuera de dominio se heredan sin escribir nada.
// ─────────────────────────────────────────────────────────────────────────────
const OPCIONES = ['W30', 'W31', 'W32', 'W33']

describe('#235 · resolución — el dato entra por la puerta del literal', () => {
  it('el valor del dato gana sobre `default` cuando resuelve (S4)', () => {
    const delDato = defaultFromField([{ s: 'W31', d: 1 }], 's', 'd')
    expect(resolveControlValue(undefined, OPCIONES, delDato ?? 'max')).toBe('W31')
  })

  it('el dato NO resuelve → cae a `default` declarado (S2)', () => {
    const delDato = defaultFromField([{ s: 'W31', d: 0 }], 's', 'd')
    expect(resolveControlValue(undefined, OPCIONES, delDato ?? 'min')).toBe('W30')
  })

  it('el dato NO resuelve y no hay `default` → fallback universal max (S2)', () => {
    const delDato = defaultFromField([{ s: 'W31', d: 0 }], 's', 'd')
    expect(resolveControlValue(undefined, OPCIONES, delDato ?? undefined)).toBe('W33')
  })

  it('un value marcado que NO está en las opciones → cae a max, no selecciona lo inexistente', () => {
    const delDato = defaultFromField([{ s: 'W99', d: 1 }], 's', 'd')
    expect(delDato).toBe('W99')
    expect(resolveControlValue(undefined, OPCIONES, delDato ?? undefined)).toBe('W33')
  })

  it('la URL gana sobre el default del dato (S3) — medido, no razonado', () => {
    const delDato = defaultFromField([{ s: 'W31', d: 1 }], 's', 'd')
    expect(resolveControlValue('W30', OPCIONES, delDato ?? 'max')).toBe('W30')
  })

  it('multi-select: el default del dato puebla la selección igual que el literal', () => {
    const delDato = defaultFromField([{ s: 'W31', d: 1 }], 's', 'd')
    expect(resolveControlValues(undefined, OPCIONES, delDato ?? 'max')).toEqual(['W31'])
    // Y la URL sigue ganando también en multi.
    expect(resolveControlValues(['W30', 'W32'], OPCIONES, delDato ?? 'max')).toEqual(['W30', 'W32'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Validación estática: el campo colgante es error de SPEC (S6).
//     Sin este check el typo sería MUDO — `controls.items` tiene additionalProperties: true.
// ─────────────────────────────────────────────────────────────────────────────
const specConDefaultField = (control: string) => `
mira_version: "1.0"
identity: { id: pi-deffield-val, display_name: "DefField Val", classification: internal }
controls:
${control}
piece:
  table: { data: data.lineas, columns: [{ field: sku, label: "SKU" }] }
data:
  semanas:
    capability: mock-sql
    params: { sql: "SELECT semana, etiqueta, es_default FROM dbo.dim_semanas" }
    shape: { type: rows, fields: { semana: string, etiqueta: string, es_default: int } }
  lineas: { capability: mock-sql, params: { sql: "SELECT sku FROM dbo.lineas WHERE semana = :ctx.semana" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

describe('#235 · validación de defaultField', () => {
  it('defaultField declarado en shape.fields → el spec pasa', () => {
    const yaml = specConDefaultField(`  - { id: semana, label: "Semana", source: data.semanas.semana, display: etiqueta, defaultField: es_default }`)
    expect(() => validate(parseSpec(yaml))).not.toThrow()
  })

  it('defaultField COLGANTE (no está en shape.fields) → rechazo nombrando campo y dataset', () => {
    const yaml = specConDefaultField(`  - { id: semana, source: data.semanas.semana, defaultField: no_existe }`)
    expect(() => validate(parseSpec(yaml))).toThrow(/no_existe/)
    expect(() => validate(parseSpec(yaml))).toThrow(/semanas/)
    // Y es NUESTRA validación semántica la que lo atrapa, con su código — no un genérico del schema.
    try {
      validate(parseSpec(yaml))
      expect.unreachable('el defaultField colgante debía ser rechazado')
    } catch (e) {
      const s = (e as { structured?: { code?: string; path?: string } }).structured
      expect(s?.code).toBe('control-default-field-dangling')
      expect(s?.path).toBe('controls[semana].defaultField')
    }
  })

  it('defaultField y default CONVIVEN en el mismo control (S4)', () => {
    const yaml = specConDefaultField(`  - { id: semana, source: data.semanas.semana, defaultField: es_default, default: max }`)
    expect(() => validate(parseSpec(yaml))).not.toThrow()
  })

  it('defaultField con un nombre que no es identificador → lo rechaza el SCHEMA (pattern)', () => {
    const yaml = specConDefaultField(`  - { id: semana, source: data.semanas.semana, defaultField: "es default!" }`)
    expect(() => validate(parseSpec(yaml))).toThrow(/defaultField|pattern/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5 · e2e con runSpec + mock-sql: el sello abre en la marcada por el dato y el value viaja BINDEADO.
// ─────────────────────────────────────────────────────────────────────────────
// W33 es el max del dominio; el dato marca W31 → si el render abre en W31, el default vino del DATO.
const SEMANAS_E2E: Record<string, unknown>[] = [
  { semana: 'W30', etiqueta: 'Semana 30', es_default: 0 },
  { semana: 'W31', etiqueta: 'Semana 31', es_default: 1 },
  { semana: 'W32', etiqueta: 'Semana 32', es_default: 0 },
  { semana: 'W33', etiqueta: 'Semana 33', es_default: 0 },
]

const E2E_YAML = `
mira_version: "1.0"
identity: { id: pi-deffield, display_name: "DefField", code: PI-DF, version: "1.0", classification: internal }
controls:
  - { id: semana, label: "Semana", source: data.semanas.semana, display: etiqueta, defaultField: es_default, single: true }
piece:
  table:
    data: data.lineas
    columns: [{ field: sku, label: "SKU" }]
data:
  semanas: { capability: mock-sql, params: { sql: "SELECT semana, etiqueta, es_default FROM dbo.dim_semanas" } }
  lineas: { capability: mock-sql, params: { sql: "SELECT sku FROM dbo.lineas WHERE semana = :ctx.semana" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

function makeMockSql(semanas: Record<string, unknown>[]) {
  const calls: { sql: string; params?: Record<string, unknown> }[] = []
  const cap: Capability = {
    name: 'mock-sql',
    async execute(params: unknown): Promise<unknown> {
      const p = (params ?? {}) as { sql: string; params?: Record<string, unknown> }
      calls.push({ sql: p.sql, params: p.params })
      if (/dim_semanas/.test(p.sql)) return { rows: semanas }
      const wk = String(p.params?.['ctx_semana'] ?? '')
      return { rows: [{ sku: `SKU-${wk}` }] }
    },
  }
  return { cap, calls }
}

async function render(yaml: string, semanas = SEMANAS_E2E, ctx?: Record<string, string | string[]>) {
  const { cap, calls } = makeMockSql(semanas)
  const dir = mkdtempSync(join(tmpdir(), 'vergis-deffield-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yaml)
  const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [cap], ctx })
  return { out, calls }
}

describe('#235 · e2e — el sello abre en la opción que marcó el DATO', () => {
  it('el default del dato (W31) gana sobre el max del dominio (W33) y viaja BINDEADO a la query', async () => {
    const { out, calls } = await render(E2E_YAML)
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(html).toContain('<option value="W31" selected>Semana 31</option>')
    expect(html).not.toContain('selected>Semana 33')
    const lineas = calls.find((c) => /dbo\.lineas/.test(c.sql))!
    expect(lineas.sql).toContain('@ctx_semana')
    expect(lineas.sql).not.toContain(':ctx.semana')
    expect(lineas.params?.['ctx_semana']).toBe('W31')
    // Resuelve → no hay evento (O1: el valor servido ya se observa).
    expect(out.log.filter((e) => e.type === 'mira-control-default-field')).toHaveLength(0)
  })

  it('?ctx.semana=W33: la URL gana sobre el default del dato (S3), medido end-to-end', async () => {
    const { out, calls } = await render(E2E_YAML, SEMANAS_E2E, { semana: 'W33' })
    const html = out.html ?? ''
    expect(html).toContain('<option value="W33" selected>Semana 33</option>')
    expect(html).not.toContain('selected>Semana 31')
    expect(calls.find((c) => /dbo\.lineas/.test(c.sql))!.params?.['ctx_semana']).toBe('W33')
  })

  it('DOS filas marcadas → cae al fallback max (W33) Y EMITE su evento (S2 + O2)', async () => {
    const dos = SEMANAS_E2E.map((r) => (r.semana === 'W30' || r.semana === 'W31' ? { ...r, es_default: 1 } : r))
    const { out, calls } = await render(E2E_YAML, dos)
    expect(out.ok).toBe(true)
    expect(out.html).toContain('<option value="W33" selected>Semana 33</option>')
    expect(calls.find((c) => /dbo\.lineas/.test(c.sql))!.params?.['ctx_semana']).toBe('W33')
    // El fail-safe NO es un silencio: el evento dice qué control, qué dataset, qué campo y CUÁNTAS.
    const ev = out.log.filter((e) => e.type === 'mira-control-default-field')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({
      control: 'semana',
      dataset: 'semanas',
      field: 'es_default',
      marked: 2,
      reason: 'multiple-marked',
      fallback: 'max',
    })
  })

  it('NINGUNA marcada → cae a max y emite el evento distinguiendo el caso (none-marked)', async () => {
    const ninguna = SEMANAS_E2E.map((r) => ({ ...r, es_default: 0 }))
    const { out } = await render(E2E_YAML, ninguna)
    expect(out.html).toContain('<option value="W33" selected>Semana 33</option>')
    const ev = out.log.filter((e) => e.type === 'mira-control-default-field')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ marked: 0, reason: 'none-marked' })
  })

  it('el flag como false/"false" del driver NO marca — la trampa, end-to-end', async () => {
    const falsos = SEMANAS_E2E.map((r) => ({ ...r, es_default: r.semana === 'W31' ? 'false' : false }))
    const { out } = await render(E2E_YAML, falsos)
    // Con truthiness cruda, `String(false)` truthy habría marcado las cuatro (→ evento multiple).
    expect(out.html).toContain('<option value="W33" selected>Semana 33</option>')
    expect(out.log.filter((e) => e.type === 'mira-control-default-field')[0]).toMatchObject({ marked: 0 })
  })

  it('defaultField no resuelve pero hay `default` literal → gana el literal (S2 → S4)', async () => {
    const ninguna = SEMANAS_E2E.map((r) => ({ ...r, es_default: 0 }))
    const yaml = E2E_YAML.replace('defaultField: es_default,', 'defaultField: es_default, default: W30,')
    const { out } = await render(yaml, ninguna)
    expect(out.html).toContain('<option value="W30" selected>Semana 30</option>')
    expect(out.log.filter((e) => e.type === 'mira-control-default-field')[0]).toMatchObject({ fallback: 'W30' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 · S5 · Llaves alternativas: solo el DUEÑO del `param` aplica defaultField.
//     Si no, la segunda llave pisaría el valor que fijó la primera.
// ─────────────────────────────────────────────────────────────────────────────
const ALT_YAML = `
mira_version: "1.0"
identity: { id: pi-deffield-alt, display_name: "DefField Alt", classification: internal }
controls:
  - { id: semana, label: "Semana", source: data.semanas.semana, default: max, single: true }
  - { id: etiq, param: semana, label: "Etiqueta", source: data.semanas.semana, display: etiqueta, defaultField: es_default, single: true }
piece:
  table:
    data: data.lineas
    columns: [{ field: sku, label: "SKU" }]
data:
  semanas: { capability: mock-sql, params: { sql: "SELECT semana, etiqueta, es_default FROM dbo.dim_semanas" } }
  lineas: { capability: mock-sql, params: { sql: "SELECT sku FROM dbo.lineas WHERE semana = :ctx.semana" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

describe('#235 · S5 — solo el dueño del param aplica defaultField', () => {
  it('el dueño (default max → W33) manda; el NO dueño con defaultField no pisa su valor', async () => {
    const { out, calls } = await render(ALT_YAML)
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    // Ambos sellos en W33 (el del dueño), aunque el dato marque W31 en el segundo control.
    expect(html).toContain('<option value="W33" selected>W33</option>')
    expect(html).toContain('<option value="W33" selected>Semana 33</option>')
    expect(html).not.toContain('selected>Semana 31')
    expect(calls.find((c) => /dbo\.lineas/.test(c.sql))!.params?.['ctx_semana']).toBe('W33')
    // Y como el no-dueño no evalúa su defaultField, tampoco emite su evento.
    expect(out.log.filter((e) => e.type === 'mira-control-default-field')).toHaveLength(0)
  })

  it('con el orden invertido, el dueño ES el del defaultField → W31 manda', async () => {
    const invertido = `
mira_version: "1.0"
identity: { id: pi-deffield-alt2, display_name: "DefField Alt2", classification: internal }
controls:
  - { id: etiq, label: "Etiqueta", source: data.semanas.semana, display: etiqueta, defaultField: es_default, single: true }
  - { id: semana, param: etiq, label: "Semana", source: data.semanas.semana, default: max, single: true }
piece:
  table:
    data: data.lineas
    columns: [{ field: sku, label: "SKU" }]
data:
  semanas: { capability: mock-sql, params: { sql: "SELECT semana, etiqueta, es_default FROM dbo.dim_semanas" } }
  lineas: { capability: mock-sql, params: { sql: "SELECT sku FROM dbo.lineas WHERE semana = :ctx.etiq" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`
    const { out, calls } = await render(invertido)
    expect(out.ok).toBe(true)
    expect(out.html).toContain('<option value="W31" selected>Semana 31</option>')
    expect(calls.find((c) => /dbo\.lineas/.test(c.sql))!.params?.['ctx_etiq']).toBe('W31')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7 · #246 · El default LITERAL de #92 era inalcanzable desde un spec.
//     El `enum: [max, min, first]` del schema lo rechazaba ANTES de la validación semántica —que ya lo
//     aceptaba—, así que la capacidad se publicó muerta. Este es el test que faltaba desde agosto: un
//     validateSpec COMPLETO, con schema, sobre un spec con default literal.
// ─────────────────────────────────────────────────────────────────────────────
const LITERAL_YAML = (def: string) => `
mira_version: "1.0"
identity: { id: pi-literal, display_name: "Literal", classification: internal }
controls:
  - { id: semana, label: "Semana", source: data.semanas.semana, default: ${def}, single: true }
piece:
  table: { data: data.lineas, columns: [{ field: sku, label: "SKU" }] }
data:
  semanas: { capability: mock-sql, params: { sql: "SELECT semana FROM dbo.dim_semanas" } }
  lineas: { capability: mock-sql, params: { sql: "SELECT sku FROM dbo.lineas WHERE semana = :ctx.semana" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

describe('#246 · el default literal de #92 pasa el validateSpec COMPLETO (schema incluido)', () => {
  it('default literal (W32) valida — el schema ya no cierra el vocabulario en un enum', () => {
    expect(() => validate(parseSpec(LITERAL_YAML('W32')))).not.toThrow()
  })

  it('los keywords siguen validando (control positivo: no se rompió lo que ya funcionaba)', () => {
    for (const kw of ['max', 'min', 'first']) {
      expect(() => validate(parseSpec(LITERAL_YAML(kw))), kw).not.toThrow()
    }
  })

  it('default vacío sigue siendo rechazo (el string no vacío es el contrato, y ahora lo dicen las dos capas)', () => {
    expect(() => validate(parseSpec(LITERAL_YAML('""')))).toThrow(/default|minLength/i)
  })

  it('e2e: el literal del spec se sirve de verdad (no solo valida)', async () => {
    const yaml = E2E_YAML.replace('defaultField: es_default,', 'default: W32,')
    const { out, calls } = await render(yaml)
    expect(out.ok).toBe(true)
    expect(out.html).toContain('<option value="W32" selected>Semana 32</option>')
    expect(calls.find((c) => /dbo\.lineas/.test(c.sql))!.params?.['ctx_semana']).toBe('W32')
  })
})
