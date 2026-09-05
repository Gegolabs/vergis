/**
 * Empaqueta el frontend de Daftar (`packages/daftar/assets/{index.html,app.js,style.css}`) en el
 * módulo JSON que el paquete importa (`packages/daftar/src/assets.json`).
 *
 * Por qué un JSON generado y no un `readFileSync` ni el loader `text` de esbuild: el nodo NO sirve
 * estáticos, así que los tres archivos tienen que quedar DENTRO del bundle (`dist/serve-rls.mjs`), y
 * el mismo import tiene que resolver igual en `npm run build` (esbuild) y en `npm test` (vitest).
 *  - `readFileSync` en tiempo de módulo no sobrevive al bundle (no hay archivo al lado del .mjs).
 *  - el loader `text` de esbuild es POR EXTENSIÓN y global: `--loader:.js=text` rompería el bundle
 *    entero, y una extensión inventada (`.txt`) que esbuild leería como texto, Vite la resolvería
 *    como URL de asset — el mismo import daría cosas distintas en los dos gates.
 *  - JSON lo entienden los tres de fábrica (tsc con `resolveJsonModule`, ya encendido; esbuild; vite).
 *
 * `npm run daftar:assets` lo regenera; `tests/daftar-frontend.test.ts` falla si el JSON quedó atrás.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ASSETS_DIR = join(RAIZ, 'packages/daftar/assets')
export const ASSETS_JSON = join(RAIZ, 'packages/daftar/src/assets.json')

/** Los tres assets, leídos del disco. La misma función que usa el test de deriva. */
export function leerAssets(): { indexHtml: string; appJs: string; styleCss: string } {
  return {
    indexHtml: readFileSync(join(ASSETS_DIR, 'index.html'), 'utf8'),
    appJs: readFileSync(join(ASSETS_DIR, 'app.js'), 'utf8'),
    styleCss: readFileSync(join(ASSETS_DIR, 'style.css'), 'utf8'),
  }
}

export function jsonDeAssets(): string {
  return `${JSON.stringify(leerAssets(), null, 2)}\n`
}

if (process.argv[1] && process.argv[1].endsWith('daftar-assets.ts')) {
  writeFileSync(ASSETS_JSON, jsonDeAssets())
  console.log(`[daftar] assets empaquetados → ${ASSETS_JSON}`)
}
