// #78 · Tema claro — criterios de aceptación.
// Tres movimientos: (1) tokens de chart POR PALETA (los colores se hornean server-side), (2) los
// dashboards nacen con fondo blanco como los reportes, (3) los colores horneados quedan abiertos al
// selector de Apariencia vía CSS vars (el spike vive en tests/chart-theme-vars.test.ts).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { renderHtmlPiece, arbolTheme, resolveChartTokens, chartVarDeclarations, type ResolvedNode } from '@vergis/capabilities'
import { platformThemeDefault } from '@vergis/mira'

const DASH_YAML = `
mira_version: "1.0"
identity: { id: pi-tema, display_name: "Tema", classification: internal }
piece:
  layout: rows
  elements:
    - kpi: { metric: data.d.v, label: "Total", format: int_0 }
    - distribution: { dimension: data.rows.p, metric: data.rows.v, title: "Barras" }
data:
  d:
    capability: static-data
    params: { rows: [{ v: 42 }] }
    shape: { type: single_row, fields: { v: number } }
  rows:
    capability: static-data
    params: { rows: [{ p: "a", v: 5 }, { p: "b", v: 3 }] }
    shape: { type: rows, fields: { p: string, v: number } }
quality: {}
delivery: { render: [{ format: html, target: web, theme: arbol }] }
`

const TABLE_YAML = DASH_YAML.replace(
  `    - kpi: { metric: data.d.v, label: "Total", format: int_0 }
    - distribution: { dimension: data.rows.p, metric: data.rows.v, title: "Barras" }`,
  `    - table: { data: data.rows, columns: [{ field: p }, { field: v }] }`,
)

async function renderYaml(yaml: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-tema-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, yaml)
  const out = await runSpec({ specPath, baseDir: dir })
  expect(out.ok).toBe(true)
  return out.html ?? ''
}

function activePalette(html: string): string | undefined {
  return html.match(/<html[^>]*data-palette="([^"]+)"/)?.[1]
}

describe('#78 · (2) el dashboard nace con fondo blanco', () => {
  it('un dashboard sin theme explícito arranca en la paleta blanco', async () => {
    expect(activePalette(await renderYaml(DASH_YAML))).toBe('blanco')
  })

  it('un reporte sigue naciendo blanco (sin cambio)', async () => {
    expect(activePalette(await renderYaml(TABLE_YAML))).toBe('blanco')
  })

  it('la paleta blanco pinta el fondo de blanco', async () => {
    const html = await renderYaml(DASH_YAML)
    expect(html).toMatch(/html\[data-palette="blanco"\][^}]*--bg: #ffffff/)
  })

  it('VERGIS_THEME_DASHBOARD sigue pudiendo fijar otra combinación', () => {
    const prev = process.env['VERGIS_THEME_DASHBOARD']
    process.env['VERGIS_THEME_DASHBOARD'] = 'arbol@gruvbox'
    try {
      expect(platformThemeDefault('dashboard')).toEqual({ theme: 'arbol', palette: 'gruvbox' })
    } finally {
      if (prev === undefined) delete process.env['VERGIS_THEME_DASHBOARD']
      else process.env['VERGIS_THEME_DASHBOARD'] = prev
    }
  })
})

describe('#78 · (1) tokens de chart por paleta', () => {
  const piece: ResolvedNode = {
    type: 'distribution',
    dimensionField: 'p',
    metricField: 'v',
    rows: [
      { p: 'a', v: 5 },
      { p: 'b', v: 3 },
    ],
  }
  const render = async (palette?: string): Promise<string> =>
    (
      (await renderHtmlPiece.execute({ piece, title: 'X', theme: 'arbol', palette }, { agent: 't' })) as {
        html: string
      }
    ).html

  it('cada paleta declara su propio juego, con contraste calibrado para su fondo', () => {
    const dark = resolveChartTokens(arbolTheme, 'gruvbox')
    const white = resolveChartTokens(arbolTheme, 'blanco')
    const light = resolveChartTokens(arbolTheme, 'claro')
    expect(white.chartText).not.toBe(dark.chartText)
    expect(light.chartText).not.toBe(dark.chartText)
    // El texto claro de Gruvbox dark sería ilegible sobre blanco: la paleta blanca usa gris oscuro.
    expect(white.chartText).toBe('#334155')
  })

  it('INVARIANTE: en los tres juegos, chartBar es el color de la primera serie', () => {
    for (const p of ['gruvbox', 'claro', 'blanco']) {
      const t = resolveChartTokens(arbolTheme, p)
      expect(t.chartSeries?.[0], p).toBe(t.chartBar)
    }
  })

  it('el SVG se hornea con los tokens de la paleta ACTIVA', async () => {
    expect(await render('blanco')).toContain('#2563eb')
    expect(await render('gruvbox')).toContain('#b8bb26')
  })
})

describe('#78 · (3) el selector de Apariencia re-colorea los charts', () => {
  it('cada paleta del theme declara sus --chart-*', async () => {
    const html = await renderYaml(DASH_YAML)
    for (const p of ['gruvbox', 'claro', 'blanco']) {
      const i = html.indexOf(`html[data-palette="${p}"] {`)
      expect(i, p).toBeGreaterThan(-1)
      const block = html.slice(i, html.indexOf('\n  }', i))
      expect((block.match(/--chart-[\w-]+: #[0-9a-fA-F]{3,8};/g) ?? []).length, p).toBeGreaterThanOrEqual(11)
    }
  })

  it('las vars que usa el SVG están declaradas en LAS TRES paletas (si no, conmutar dejaría el hex)', async () => {
    const html = await renderYaml(DASH_YAML)
    const i = html.indexOf('<svg xmlns')
    const svg = html.slice(i, html.indexOf('</svg>', i))
    const used = [...new Set([...svg.matchAll(/var\((--chart-[\w-]+),/g)].map((m) => m[1]))]
    expect(used.length).toBeGreaterThan(0)
    for (const p of ['gruvbox', 'claro', 'blanco']) {
      const decls = chartVarDeclarations(resolveChartTokens(arbolTheme, p))
      for (const v of used) expect(decls, `${p} · ${v}`).toContain(`${v}:`)
    }
  })

  it('el selector de Apariencia sigue ofreciendo las tres paletas', async () => {
    const html = await renderYaml(DASH_YAML)
    for (const label of ['Oscuro', 'Claro', 'Blanco']) expect(html).toContain(label)
  })
})

describe('#78 · el fixture del banco de charts nace claro y con charts themeables', () => {
  it('examples/charts-lab.yaml', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-tema-lab-'))
    const out = await runSpec({ specPath: 'examples/charts-lab.yaml', baseDir: dir })
    expect(out.ok).toBe(true)
    const html = out.html ?? ''
    expect(activePalette(html)).toBe('blanco')
    expect(html).toContain('var(--chart-bar,')
    // El artefacto publicado es el mismo HTML.
    expect(readFileSync(join(dir, 'charts-lab.html'), 'utf8')).toContain('var(--chart-')
  })
})
