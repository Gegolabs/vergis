import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec, resolveControlValue, normalizeDrills } from '@vergis/mira'
import { VergisError, type Capability } from '@vergis/botler'

/**
 * Capacidades nuevas del DSL (deber-ser, infraestructura):
 *  - CONTROLES DE CABECERA (server-side): un selector fija `:ctx.<id>` en las queries, con default
 *    computado (max = más reciente). Cambia el DATO, no solo la vista. El valor viaja en la navegación.
 *  - MULTI-DRILL + CLAVE COMPUESTA: una tabla ofrece varias acciones de drill; `by` puede pasar varias
 *    claves (empresa+socio). El ctx se bindea (injection-safe) y ACOTA dentro de lo que la RLS autoriza.
 */

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object

const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']
const validate = (spec: unknown) => validateSpec(spec, { capabilities: CAPS, schema: SCHEMA })

const YAML = `
mira_version: "1.0"
identity: { id: pi-ctrl-test, display_name: "Cartera Ctrl Test", code: PI-CTRL, version: "1.0", classification: internal }
controls:
  - { id: semana, label: "Semana", source: data.semanas.semana, default: max, single: true }
pages:
  - id: clientes
    title: "Clientes"
    piece:
      table:
        data: data.clientes
        columns:
          - { field: empresa, label: "Empresa" }
          - { field: socio, label: "Socio" }
          - { field: saldo, label: "Saldo", format: int_0, align: right }
        drillthrough:
          - { to: detalle-socio, by: socio, label: "Ver socio en el grupo" }
          - { to: detalle-es, by: [empresa, socio], label: "En esta empresa" }
  - id: detalle-socio
    title: "Detalle socio"
    context: [socio]
    piece:
      table:
        data: data.detalle_socio
        columns:
          - { field: empresa, label: "Empresa" }
          - { field: doc, label: "Doc" }
  - id: detalle-es
    title: "Detalle empresa+socio"
    context: [empresa, socio]
    piece:
      table:
        data: data.detalle_es
        columns:
          - { field: doc, label: "Doc" }
data:
  semanas: { capability: mock-sql, params: { sql: "SELECT DISTINCT Semana AS semana FROM dbo.dim_fechas" } }
  clientes: { capability: mock-sql, params: { sql: "SELECT empresa, socio, saldo FROM dbo.saldo WHERE Semana = :ctx.semana" } }
  detalle_socio: { capability: mock-sql, params: { sql: "SELECT empresa, doc FROM dbo.doc WHERE socio = :ctx.socio AND Semana = :ctx.semana" } }
  detalle_es: { capability: mock-sql, params: { sql: "SELECT doc FROM dbo.doc WHERE empresa = :ctx.empresa AND socio = :ctx.socio AND Semana = :ctx.semana" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

function makeMockSql() {
  const calls: { sql: string; params?: Record<string, unknown> }[] = []
  const cap: Capability = {
    name: 'mock-sql',
    async execute(params: unknown): Promise<unknown> {
      const p = (params ?? {}) as { sql: string; params?: Record<string, unknown> }
      calls.push({ sql: p.sql, params: p.params })
      if (/dim_fechas/.test(p.sql)) return { rows: [{ semana: 'W16' }, { semana: 'W20' }, { semana: 'W21' }] }
      if (/dbo\.saldo/.test(p.sql)) {
        const wk = p.params?.['ctx_semana']
        const all = [
          { empresa: 'E1', socio: 'A', saldo: 100, _wk: 'W21' },
          { empresa: 'E2', socio: 'A', saldo: 50, _wk: 'W21' },
          { empresa: 'E1', socio: 'B', saldo: 200, _wk: 'W20' },
        ]
        return { rows: all.filter((r) => r._wk === wk).map(({ _wk, ...r }) => r) }
      }
      // detalle: por empresa+socio si vino ctx_empresa, si no por socio en todo el grupo.
      const socio = p.params?.['ctx_socio']
      const empresa = p.params?.['ctx_empresa']
      const all = [
        { empresa: 'E1', socio: 'A', doc: 'D1' },
        { empresa: 'E2', socio: 'A', doc: 'D2' },
        { empresa: 'E1', socio: 'B', doc: 'D3' },
      ]
      return {
        rows: all.filter((r) => r.socio === socio && (empresa == null || r.empresa === empresa)),
      }
    },
  }
  return { cap, calls }
}

async function render(yaml: string, nav: { page?: string; ctx?: Record<string, string> } = {}) {
  const { cap, calls } = makeMockSql()
  const dir = mkdtempSync(join(tmpdir(), 'vergis-ctrl-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yaml)
  const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [cap], page: nav.page, ctx: nav.ctx })
  return { out, calls }
}

describe('normalizeDrills · objeto|arreglo, by string|string[]', () => {
  it('objeto único con by string → un drill, by normalizado a arreglo', () => {
    expect(normalizeDrills({ to: 'd', by: 'socio' })).toEqual([{ to: 'd', by: ['socio'], label: undefined }])
  })
  it('arreglo con clave compuesta + label', () => {
    expect(normalizeDrills([{ to: 'd', by: ['empresa', 'socio'], label: 'X' }])).toEqual([
      { to: 'd', by: ['empresa', 'socio'], label: 'X' },
    ])
  })
  it('entradas inválidas (sin to o sin by) se filtran', () => {
    expect(normalizeDrills([{ by: 'x' }, { to: 'd' }, null, 'x'])).toEqual([])
  })
})

describe('resolveControlValue · default computado', () => {
  it('default max = el mayor (numeric-aware): W16<W20<W21 → W21', () => {
    expect(resolveControlValue(undefined, ['W16', 'W20', 'W21'], 'max')).toBe('W21')
  })
  it('default min = el menor', () => {
    expect(resolveControlValue(undefined, ['W16', 'W20', 'W21'], 'min')).toBe('W16')
  })
  it('valor de la URL gana si es opción válida', () => {
    expect(resolveControlValue('W20', ['W16', 'W20', 'W21'], 'max')).toBe('W20')
  })
  it('valor de la URL inválido → cae al default', () => {
    expect(resolveControlValue('W99', ['W16', 'W20', 'W21'], 'max')).toBe('W21')
  })
})

describe('validación · controles + drill multi-clave', () => {
  it('spec con controles + multi-drill válido pasa', () => {
    expect(() => validate(parseSpec(YAML))).not.toThrow()
  })
  it('control con source colgante → rechazo', () => {
    const s = parseSpec(YAML.replace('source: data.semanas.semana', 'source: data.fantasma.x')) as Record<string, unknown>
    expect(() => validate(s)).toThrow(/no existe en data/)
  })
  // #246 · Este test decía «default inválido → rechazo» con `default: promedio` y aceptaba cualquier
  // rechazo, comentando que «lo atrapa el schema (enum)» como si eso fuera correcto. NO lo era: el
  // `enum: [max,min,first]` del schema rechazaba TAMBIÉN el valor literal que #92 había hecho válido,
  // y el test lo bendijo — por eso la capacidad estuvo cinco meses inalcanzable desde un spec. Ahora el
  // vocabulario del schema es «string no vacío» (lo mismo que ya exigía la validación semántica) y el
  // test DISTINGUE qué capa rechaza: un no-keyword es un LITERAL válido en el spec, y lo único que
  // rechaza es el string vacío.
  it('un default que no es keyword es un LITERAL válido (#92/#246), no un rechazo del schema', () => {
    const s = parseSpec(YAML.replace('default: max', 'default: promedio')) as Record<string, unknown>
    expect(() => validate(s)).not.toThrow()
    // Y en el render es fail-safe: fuera del dominio cae al comportamiento sin default (max).
    expect(resolveControlValue(undefined, ['W16', 'W20', 'W21'], 'promedio')).toBe('W21')
  })
  it('default vacío → rechazo por AMBAS capas, y se distingue cuál habla', () => {
    const s = parseSpec(YAML.replace('default: max', 'default: ""')) as Record<string, unknown>
    // Capa 1 · el SCHEMA (corre primero y lanza antes de la semántica): minLength.
    const conSchema = (() => {
      try {
        validate(s)
        return null
      } catch (e) {
        return (e as { structured?: { code?: string; message?: string } }).structured ?? null
      }
    })()
    expect(conSchema?.code).toBe('schema-violation')
    // Capa 2 · la validación SEMÁNTICA, aislada bajo un schema PERMISIVO (`{}` acepta todo, así que
    // el único que puede hablar es el validador semántico): su propio veredicto nombrado.
    const sinSchema = (() => {
      try {
        validateSpec(s, { capabilities: CAPS, schema: {} })
        return null
      } catch (e) {
        return (e as { structured?: { code?: string } }).structured ?? null
      }
    })()
    expect(sinSchema?.code).toBe('control-default-invalid')
  })
  it('control multi-select (single: false) → válido (soportado desde work/052 R3)', () => {
    const s = parseSpec(YAML.replace('single: true', 'single: false')) as Record<string, unknown>
    expect(() => validate(s)).not.toThrow()
  })
  it('drill multi-clave a una vista que no declara todas las claves → rechazo', () => {
    // detalle_es declara context: [empresa, socio]; lo dejamos solo en [socio].
    const s = parseSpec(YAML.replace('context: [empresa, socio]', 'context: [socio]')) as Record<string, unknown>
    expect(() => validate(s)).toThrow(/no declara \[empresa\]/)
  })
})

describe('render · control de cabecera default=max', () => {
  it('sin ctx.semana: el control resuelve a W21 (más reciente) y se inyecta BINDEADO en la query', async () => {
    const { out, calls } = await render(YAML)
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    // TX-11: el selector de alcance vive en la BANDA de contexto (el sello ES el control), como
    // <select> estilizado, con W21 seleccionada — YA NO en la bandeja (sin vt-ctl-select).
    expect(html).toContain('class="vctxbar"')
    expect(html).toContain('vctx-sel') // sello clickeable (<select> nativo estilizado)
    expect(html).toContain('<option value="W21" selected>W21</option>')
    expect(html).not.toContain('vt-ctl-select') // el control salió de la bandeja (WP2)
    expect(html).toMatch(/<select class="[^"]*vctx-sel[^"]*"/)
    // La query de clientes se bindeó con @ctx_semana = 'W21' (injection-safe, sin :ctx.).
    const clientes = calls.find((c) => /dbo\.saldo/.test(c.sql))!
    expect(clientes.sql).toContain('@ctx_semana')
    expect(clientes.sql).not.toContain(':ctx.semana')
    expect(clientes.params?.['ctx_semana']).toBe('W21')
    // La nav de páginas preserva la semana (carry) en sus links.
    expect(html).toContain('ctx.semana=W21')
    // Multi-drill: el payload trae las 2 acciones con sus claves (una compuesta).
    expect(html).toContain('"drills":[{"to":"detalle-socio","by":["socio"],"label":"Ver socio en el grupo"},{"to":"detalle-es","by":["empresa","socio"],"label":"En esta empresa"}]')
    expect(html).toContain('"carryCtx":{"semana":"W21"}')
  })

  it('versión del PI (instancia) se muestra DISTINTA de la versión de Mira (motor) en el inspector', async () => {
    const { out } = await render(YAML)
    const html = out.html ?? ''
    // Pie del inspector: la versión del PI (code · v) y la de Mira, por separado.
    expect(html).toContain('PI-CTRL · v1.0')
    expect(html).toMatch(/Vergis v\d+\.\d+\.\d+/)
  })

  it('?ctx.semana=W20 override: el selector muestra W20 y la query usa W20', async () => {
    const { out, calls } = await render(YAML, { ctx: { semana: 'W20' } })
    const html = out.html ?? ''
    expect(html).toContain('<option value="W20" selected>W20</option>')
    const clientes = calls.find((c) => /dbo\.saldo/.test(c.sql))!
    expect(clientes.params?.['ctx_semana']).toBe('W20')
  })

  it('el onchange del selector sobrevive al scoping de handler inline (document.URL sombrea a URL)', async () => {
    // En un handler inline el browser mete a `document` en la cadena de scope: `URL` resuelve a
    // `document.URL` (un STRING), no al constructor global → `new URL(…)` lanza «URL is not a
    // constructor» y el selector del Inspector queda muerto. El handler debe usar `window.URL`.
    // Este test EJECUTA el handler generado bajo ese scoping (with(document)), no solo su sintaxis.
    const { out } = await render(YAML)
    const html = out.html ?? ''
    const m = html.match(/<select class="[^"]*vctx-sel[^"]*"[^>]*onchange="([^"]*)"/)
    expect(m).not.toBeNull()
    const code = m![1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
    const assigned: string[] = []
    const loc = { href: 'https://mira.example/pi-ctrl-test?ctx.semana=W21', assign: (u: string) => assigned.push(u) }
    const documentLike = { URL: loc.href } // como en el browser: document.URL es un string
    const windowLike = { URL: globalThis.URL }
    const select = { value: 'W16' }
    const fn = new Function('document', 'location', 'window', 'event', `with(document){ ${code} }`)
    fn.call(select, documentLike, loc, windowLike, {}) // con `new URL` pelado: TypeError
    expect(assigned).toHaveLength(1)
    expect(assigned[0]).toContain('page=clientes')
    expect(assigned[0]).toContain('ctx.semana=W16')
  })
})

// PI de UNA vista (piece, sin pages) con controles: el `:ctx.<id>` DEBE reescribirse igual que en
// multi-vista. Antes `applyCtx` solo corría con `isMulti` → el placeholder quedaba literal (falla en el
// motor) o el control era un no-op silencioso (work/052 F1).
const SINGLE_YAML = `
mira_version: "1.0"
identity: { id: pi-single-ctrl, display_name: "Single Ctrl", code: PI-SC, version: "1.0", classification: internal }
controls:
  - { id: semana, label: "Semana", source: data.semanas.semana, default: max, single: true }
piece:
  table:
    data: data.clientes
    columns:
      - { field: empresa, label: "Empresa" }
      - { field: saldo, label: "Saldo", format: int_0, align: right }
data:
  semanas: { capability: mock-sql, params: { sql: "SELECT DISTINCT Semana AS semana FROM dbo.dim_fechas" } }
  clientes: { capability: mock-sql, params: { sql: "SELECT empresa, socio, saldo FROM dbo.saldo WHERE Semana = :ctx.semana" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

describe('render · PI de UNA vista + control (F1: applyCtx también sin pages)', () => {
  it('el :ctx.semana del PI de una vista se reescribe a @ctx_semana bindeado (no queda literal)', async () => {
    const { out, calls } = await render(SINGLE_YAML)
    expect(out.ok).toBe(true)
    const clientes = calls.find((c) => /dbo\.saldo/.test(c.sql))!
    expect(clientes.sql).toContain('@ctx_semana')
    expect(clientes.sql).not.toContain(':ctx.semana')
    expect(clientes.params?.['ctx_semana']).toBe('W21') // default max resuelto por el control
  })

  it('?ctx.semana=W20 override en PI de una vista: la query usa W20', async () => {
    const { calls } = await render(SINGLE_YAML, { ctx: { semana: 'W20' } })
    const clientes = calls.find((c) => /dbo\.saldo/.test(c.sql))!
    expect(clientes.params?.['ctx_semana']).toBe('W20')
  })
})

describe('render · drill multi-clave (empresa+socio) bindeado', () => {
  it('page=detalle_es con ctx.empresa+ctx.socio: ambas claves + la semana llegan BINDEADAS', async () => {
    const { out, calls } = await render(YAML, { page: 'detalle-es', ctx: { empresa: 'E1', socio: 'A' } })
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    const det = calls.find((c) => /dbo\.doc/.test(c.sql) && /ctx_empresa/.test(c.sql))!
    expect(det.sql).toContain('@ctx_empresa')
    expect(det.sql).toContain('@ctx_socio')
    expect(det.sql).toContain('@ctx_semana')
    expect(det.sql).not.toContain(':ctx.')
    expect(det.params?.['ctx_empresa']).toBe('E1')
    expect(det.params?.['ctx_socio']).toBe('A')
    expect(det.params?.['ctx_semana']).toBe('W21') // default propagado
    // Solo el documento de E1/A (no D2 de E2, no D3 de B).
    expect(html).toContain('D1')
    expect(html).not.toContain('D2')
    expect(html).not.toContain('D3')
  })

  it('drill por socio (sin empresa): el socio en TODO el grupo (todas sus empresas)', async () => {
    const { out } = await render(YAML, { page: 'detalle-socio', ctx: { socio: 'A' } })
    const html = out.html ?? ''
    // A tiene documentos en E1 (D1) y E2 (D2) → ambos; nada de B.
    expect(html).toContain('D1')
    expect(html).toContain('D2')
    expect(html).not.toContain('D3')
  })
})
