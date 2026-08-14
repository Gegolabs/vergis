// #185 · El CFG de la capa de notas publica el ctx EFECTIVO, no el de la URL.
//
// El defecto: con un control de alcance `default:` resuelto server-side, abrir el PI sin query dejaba
// el bloque `script#vergis-notas` SIN la llave `ctx`. El runtime del cliente propaga fielmente lo que
// le dan, así que el POST del comentario viajaba sin alcance; el gate del servidor re-buscaba la fila
// con el param bindeado en blanco, obtenía 0 filas y respondía 403 «no visible para esta identidad»
// sobre una fila que la identidad SÍ ve. La suite probaba el gate con ctx presente — por eso el
// defecto sobrevivió. Acá se mide el eslabón que faltaba: qué alcance se publica al cliente.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import type { Capability } from '@vergis/botler'

const EMPRESAS = [{ empresa: '76408525-6' }, { empresa: '96835510-4' }]
const FILAS = [
  { folio: 1792, _empresa: '76408525-6' },
  { folio: 1811, _empresa: '96835510-4' },
]

// Un PI con alcance por control y `default: max` — la forma del PI del caso real.
const YAML = `
mira_version: "1.0"
identity: { id: pi-notas-ctx, display_name: "Notas Ctx", classification: internal }
controls:
  - { id: empresa, label: "Empresa", source: data.empresas.empresa, default: max, single: true }
piece:
  table:
    data: data.filas
    columns: [{ field: folio, label: "Folio" }]
data:
  empresas: { capability: mock-sql, params: { sql: "SELECT empresa FROM dbo.empresas" } }
  filas: { capability: mock-sql, params: { sql: "SELECT folio FROM dbo.docs WHERE empresa = :ctx.empresa" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`

const NOTAS_RENDER = {
  imprimirUrl: '/pi-notas-ctx/imprimir',
  notasUrl: '/pi-notas-ctx/notas',
  comentariosUrl: '/pi-notas-ctx/comentarios',
  impresionesUrl: '/impresiones',
  csrf: 'token-de-prueba',
} as const

const mockSql: Capability = {
  name: 'mock-sql',
  async execute(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sql: string; params?: Record<string, unknown> }
    if (/dbo\.empresas/.test(p.sql)) return { rows: EMPRESAS }
    const want = String(p.params?.['ctx_empresa'] ?? '')
    return { rows: FILAS.filter((r) => r._empresa === want).map(({ _empresa, ...r }) => r) }
  },
}

/** El bloque JSON que el runtime de notas hidrata en el cliente — el CFG del que salió el 403. */
function cfgDeNotas(html: string): Record<string, unknown> {
  const m = /<script type="application\/json" id="vergis-notas">([\s\S]*?)<\/script>/.exec(html)
  if (!m) throw new Error('el PI no publicó el contexto de la capa de notas')
  return JSON.parse(m[1].replace(/\\u003c/g, '<')) as Record<string, unknown>
}

/**
 * Sirve el PI emulando **fielmente al llamador**: `notasWiring` (`server/serve-rls.ts`) arma el bloque
 * ANTES de invocar a Mira y solo puede poner ahí la query de navegación (`ctx: nav.ctx`). Si el harness
 * no reprodujera eso, el caso «con la URL explícita» fallaría también sin el arreglo y el test no
 * mediría la regresión que dice medir — sería un instrumento que no sabe reportar su propio negativo.
 */
async function servir(ctx?: Record<string, string | string[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'vergis-notas-ctx-'))
  const specPath = join(dir, 'spec.yaml')
  writeFileSync(specPath, YAML)
  const render = { ...NOTAS_RENDER, ...(ctx ? { ctx } : {}) }
  const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql], ctx, notas: { render } })
  expect(out.ok).toBe(true)
  return out.html ?? ''
}

describe('#185 · el CFG de notas publica el ctx efectivo', () => {
  it('URL PELADA con default server-side: el CFG trae el ctx resuelto (el caso del 403)', async () => {
    const html = await servir()
    // El render usó el default (max = la empresa mayor) y sirvió SUS filas…
    expect(html).toContain('1811')
    expect(html).not.toContain('1792')
    // …y el alcance publicado al cliente es EL MISMO. Antes de #185 la llave `ctx` no existía.
    expect(cfgDeNotas(html).ctx).toEqual({ empresa: '96835510-4' })
  })

  it('con la URL explícita sigue funcionando igual (no se rompe el caso que ya andaba)', async () => {
    const html = await servir({ empresa: '76408525-6' })
    expect(html).toContain('1792')
    expect(cfgDeNotas(html).ctx).toEqual({ empresa: '76408525-6' })
  })

  it('el ctx explícito de la URL GANA sobre el default (es una elección del usuario)', async () => {
    // El default sería 96835510-4; la URL pide la otra y el CFG publica la de la URL, no la del default.
    const html = await servir({ empresa: '76408525-6' })
    expect(cfgDeNotas(html).ctx).not.toEqual({ empresa: '96835510-4' })
  })

  it('un ctx de la URL FUERA del dominio cae al default, y el CFG publica lo que se sirvió', async () => {
    // Fail-safe de `resolveControlValue`: el render no queda vacío. Lo que importa acá es que el CFG
    // no publique el valor inválido — publicaría un alcance con el que nadie sirvió filas.
    const html = await servir({ empresa: 'no-existe' })
    expect(cfgDeNotas(html).ctx).toEqual({ empresa: '96835510-4' })
    expect(html).toContain('1811')
  })

  it('una llave de ctx SIN control (drill-through) sobrevive al sellado', async () => {
    // El sellado reemplaza el bloque `ctx` entero, así que hay que demostrar que no se come las
    // llaves que ningún control gobierna — un drill lleva las suyas en la URL y el gate las necesita.
    const cfg = cfgDeNotas(await servir({ origen: 'drill-1811' }))
    expect(cfg.ctx).toEqual({ origen: 'drill-1811', empresa: '96835510-4' })
  })

  it('el resto del contexto de notas viaja intacto (endpoints y CSRF)', async () => {
    const cfg = cfgDeNotas(await servir())
    expect(cfg).toMatchObject({ comentariosUrl: '/pi-notas-ctx/comentarios', csrf: 'token-de-prueba' })
  })

  it('sin contexto de notas, no se publica nada (el sellado no inventa superficie)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-notas-ctx-'))
    const specPath = join(dir, 'spec.yaml')
    writeFileSync(specPath, YAML)
    const out = await runSpec({ specPath, baseDir: dir, extraCapabilities: [mockSql] })
    expect(out.html ?? '').not.toContain('id="vergis-notas"')
  })
})
