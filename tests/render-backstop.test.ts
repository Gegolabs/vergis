// Backstop de render (work/052 F7b): si tras el loop de renders NINGUNO produjo HTML, Mira lanza en vez
// de dejar que el server responda 200 con cuerpo vacío (página en blanco). La validación ya exige ≥1
// render html; este es el cinturón de seguridad del pipeline. Se ejercita con un host cuya capability
// render-html-piece devuelve '' (imposible por el camino normal, de ahí el fake host).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MiraBotlet, type MiraSpec } from '@vergis/mira'
import type { BotletHost, InvocationContext } from '@vergis/botler'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object

const SPEC = {
  mira_version: '1.0',
  identity: { id: 'pi-backstop', display_name: 'Backstop', classification: 'internal' },
  piece: { markdown_block: { content: 'hola' } },
  data: { d: { capability: 'mock-sql', params: { sql: 'SELECT 1 AS x FROM dbo.t' } } },
  quality: {},
  delivery: { render: [{ format: 'html', target: 'web' }] },
} as unknown as MiraSpec

// Host falso: los datos devuelven filas, pero render-html-piece devuelve HTML vacío.
const emptyRenderHost: BotletHost = {
  identity: { agent: 'test' },
  async capabilityCall(ref: string): Promise<unknown> {
    if (ref === 'render-html-piece') return { html: '' }
    return { rows: [] }
  },
  log() {},
}

const ctx: InvocationContext = { identity: { agent: 'test' }, trigger: 'on-demand', params: {} }

describe('render backstop · ningún HTML producido → error, no página en blanco', () => {
  it('render html que devuelve "" lanza VergisError no-html-output', async () => {
    const mira = new MiraBotlet(SPEC, { schema: SCHEMA })
    mira.validate({ capabilities: ['mock-sql', 'render-html-piece'] })
    await expect(mira.invoke(ctx, emptyRenderHost)).rejects.toThrow(/no-html-output|Ningún render/)
  })
})
