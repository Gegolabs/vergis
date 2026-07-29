// El pie del Inspector muestra la versión del MOTOR. Regresión del bug de producción (P-67,
// verificado en la VM el 2026-07-28): la versión se leía del filesystem en runtime resolviendo
// `../../../package.json` relativo a `import.meta.url`; en el layout del contenedor el bundle vive
// en `dist/serve-rls.mjs` y ese path no alcanza el package.json ⇒ el catch devolvía el fallback
// silencioso `'0.1.0'` y el pie mentía. Ahora la versión se hornea en BUILD-TIME (import del JSON,
// bundleado por esbuild) y no hay fallback: si faltara, se muestra la ausencia, no un número.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'
import { VERGIS_VERSION, VERGIS_VERSION_LABEL } from '../packages/capabilities/src/version'

const rootVersion = (
  JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
  ) as { version: string }
).version

const render = async (params: Record<string, unknown>): Promise<string> =>
  ((await renderHtmlPiece.execute(params, { agent: 'test' } as never)) as { html: string }).html

const piece = (): ResolvedNode =>
  ({ layout: 'grid', columns: 1, elements: [{ type: 'kpi', label: 'Total', value: 1, format: 'int' }] }) as ResolvedNode

describe('render · versión del motor en el pie del Inspector', () => {
  it('la constante resuelve exactamente la versión del package.json raíz', () => {
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(VERGIS_VERSION).toBe(rootVersion)
    expect(VERGIS_VERSION_LABEL).toBe(`Mira v${rootVersion}`)
  })

  it('el HTML renderizado muestra esa misma versión, no el fantasma 0.1.0', async () => {
    const html = await render({ piece: piece(), title: 'PI test', theme: 'arbol' })
    expect(html).toContain(`<div class="tray-version">Mira v${rootVersion}</div>`)
    // salvo que la versión real FUERA 0.1.0, el fallback difunto no debe aparecer
    if (rootVersion !== '0.1.0') expect(html).not.toContain('Mira v0.1.0')
  })

  it('la resolución no depende del filesystem en runtime (cero lectura de package.json)', () => {
    // El módulo de versión no importa `node:fs` — si volviera a hacerlo, el layout del contenedor
    // vuelve a poder romperlo en silencio.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../packages/capabilities/src/version.ts'),
      'utf8',
    )
    expect(src).not.toContain('node:fs')
    expect(src).not.toContain('readFileSync')
  })
})
