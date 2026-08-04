// Multi-select en controles de cabecera (work/052 R3-3): `single: false` es válido; los valores
// viajan como parámetro repetido (`?ctx.week=a&ctx.week=b` — navFromUrl los acumula con getAll);
// Mira expande `:ctx.<id>` a N binds (CONTRATO: el placeholder vive dentro de paréntesis de IN en el
// spec: `WHERE semana IN (:ctx.semana)`); la bandeja renderiza el control como grupo de checkboxes.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { parseSpec, validateSpec, resolveControlValues } from '@vergis/mira'
import { navFromUrl } from '../server/nav'
import type { Capability } from '@vergis/botler'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece', 'publicar-artefacto']

const YAML = `
mira_version: "1.0"
identity: { id: pi-multi, display_name: "Multi Test", classification: internal }
controls:
  - { id: semana, label: "Semanas", source: data.semanas.semana, default: max, single: false }
piece:
  table:
    data: data.saldos
    columns:
      - { field: empresa, label: "Empresa" }
      - { field: saldo, label: "Saldo", align: right }
data:
  semanas: { capability: mock-sql, params: { sql: "SELECT DISTINCT Semana AS semana FROM dbo.dim_fechas" } }
  saldos: { capability: mock-sql, params: { sql: "SELECT empresa, saldo FROM dbo.saldo WHERE Semana IN (:ctx.semana)" } }
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
      if (/dim_fechas/.test(p.sql)) return { rows: [{ semana: 'W20' }, { semana: 'W21' }, { semana: 'W22' }] }
      const wanted = Object.entries(p.params ?? {})
        .filter(([k]) => k.startsWith('ctx_semana'))
        .map(([, v]) => String(v))
      const all = [
        { empresa: 'E1', saldo: 100, _wk: 'W20' },
        { empresa: 'E2', saldo: 200, _wk: 'W21' },
        { empresa: 'E3', saldo: 300, _wk: 'W22' },
      ]
      return { rows: all.filter((r) => wanted.includes(r._wk)).map(({ _wk, ...r }) => r) }
    },
  }
  return { cap, calls }
}

async function render(ctx?: Record<string, string | string[]>) {
  const { cap, calls } = makeMockSql()
  const dir = mkdtempSync(join(tmpdir(), 'vergis-multi-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, YAML)
  const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [cap], ctx })
  return { out, calls }
}

describe('validación · single: false es válido', () => {
  it('el spec multi-select pasa validateSpec', () => {
    expect(() => validateSpec(parseSpec(YAML), { capabilities: CAPS, schema: SCHEMA })).not.toThrow()
  })
})

describe('navFromUrl · parámetros repetidos', () => {
  it('ctx.week repetido → arreglo; un solo valor → string simple (back-compat)', () => {
    const nav = navFromUrl('/pi?page=p1&ctx.week=W20&ctx.week=W21&ctx.socio=A')
    expect(nav.page).toBe('p1')
    expect(nav.ctx).toEqual({ week: ['W20', 'W21'], socio: 'A' })
  })
  it('sin ctx → undefined', () => {
    expect(navFromUrl('/pi?page=p1').ctx).toBeUndefined()
  })
})

describe('resolveControlValues · valores de URL filtrados contra options + default', () => {
  it('valores válidos pasan (sin duplicar); los que no están en options se descartan', () => {
    expect(resolveControlValues(['W20', 'W21', 'W20', 'hack'], ['W20', 'W21', 'W22'])).toEqual(['W20', 'W21'])
  })
  it('ninguno válido → aplica el default (max)', () => {
    expect(resolveControlValues(['hack'], ['W20', 'W21', 'W22'], 'max')).toEqual(['W22'])
    expect(resolveControlValues(undefined, ['W20', 'W21'], 'min')).toEqual(['W20'])
  })
})

describe('applyCtx · expansión de lista a N binds dentro del IN', () => {
  it('dos valores → IN (@ctx_semana_0, @ctx_semana_1) con ambos bindeados', async () => {
    const { out, calls } = await render({ semana: ['W20', 'W22'] })
    expect(out.ok).toBe(true)
    const q = calls.find((c) => /dbo\.saldo/.test(c.sql))!
    expect(q.sql).toContain('IN (@ctx_semana_0, @ctx_semana_1)')
    expect(q.sql).not.toContain(':ctx.') // nunca queda el placeholder literal
    expect(q.params).toMatchObject({ ctx_semana_0: 'W20', ctx_semana_1: 'W22' })
    // El dato refleja AMBAS semanas.
    expect(out.html).toContain('E1')
    expect(out.html).toContain('E3')
    expect(out.html).not.toContain('E2')
  })
  it('un solo valor → bind clásico @ctx_semana (colapsa a string, back-compat)', async () => {
    const { calls } = await render({ semana: ['W21'] })
    const q = calls.find((c) => /dbo\.saldo/.test(c.sql))!
    expect(q.sql).toContain('IN (@ctx_semana)')
    expect(q.params).toMatchObject({ ctx_semana: 'W21' })
  })
  it('sin ctx en la URL → default max (W22) como única selección', async () => {
    const { out, calls } = await render()
    const q = calls.find((c) => /dbo\.saldo/.test(c.sql))!
    expect(q.params).toMatchObject({ ctx_semana: 'W22' })
    expect(out.html).toContain('E3')
  })
})

describe('render · control multi como sello con popover en la banda de contexto (TX-11)', () => {
  it('sello <details> con checkboxes marcados y onchange que repite ctx.<id>', async () => {
    const { out } = await render({ semana: ['W20', 'W21'] })
    const html = out.html ?? ''
    // El multi vive en la BANDA como sello <details> con checkboxes (WP1), no en la bandeja.
    expect(html).toContain('class="vctxbar"')
    expect(html).toContain('vctx-multi')
    expect(html).toContain('data-ctl="semana"')
    expect(html).not.toContain('vt-ctl-multi') // ya no vive en la bandeja (WP2)
    // Los valores seleccionados vienen marcados.
    expect(html).toMatch(/value="W20" checked/)
    expect(html).toMatch(/value="W21" checked/)
    expect(html).not.toMatch(/value="W22" checked/)
    // El onchange recolecta los marcados y APPENDEA ctx.semana por valor (parámetro repetido).
    expect(html).toContain('ctx.semana')
    expect(html).toContain('searchParams.append')
    // El summary del sello muestra los valores unidos.
    expect(html).toContain('W20, W21')
  })
})
