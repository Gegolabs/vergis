/**
 * El frontend de Daftar, EMBEBIDO en el binario. El nodo no sirve estáticos (ni Mira los sirve: su
 * `render-html-piece` inyecta los `<script>` inline), así que el shell del SPA sale de acá con el CSS
 * y el JS en línea, más un `<script>` previo con `window.__DAFTAR__`.
 *
 * Los tres archivos viven editables en `packages/daftar/assets/` y `scripts/daftar-assets.ts` los
 * empaqueta en `assets.json` (el porqué de esa vía está en ese script). `tests/daftar-frontend.test.ts`
 * falla si el JSON quedó atrás del asset.
 */
import assets from './assets.json'
import type { EstudianteSpec } from './spec'

export const INDEX_HTML: string = assets.indexHtml
export const APP_JS: string = assets.appJs
export const STYLE_CSS: string = assets.styleCss

/** Lo que el shell inyecta: el Let se describe a sí mismo al frontend. `?s=` no existe en el cliente. */
export interface DaftarBootstrap {
  base: string
  student: string | null
  admin: boolean
  students: Record<string, EstudianteSpec>
}

const LINK_CSS = '<link rel="stylesheet" href="style.css">'
const SCRIPT_JS = '<script src="app.js"></script>'

/**
 * El shell del SPA. Sustituye las dos etiquetas que apuntaban a estáticos por el contenido inline; si
 * alguna no está, LANZA en vez de emitir una página muda — un `index.html` editado sin actualizar
 * esta costura daría un SPA en blanco, que es la falla más cara de diagnosticar.
 */
export function renderShell(boot: DaftarBootstrap): string {
  let html = INDEX_HTML
  if (!html.includes(LINK_CSS)) throw new Error(`assets/index.html ya no contiene ${LINK_CSS}`)
  if (!html.includes(SCRIPT_JS)) throw new Error(`assets/index.html ya no contiene ${SCRIPT_JS}`)
  // Reemplazo por FUNCIÓN, no por string: en el patrón de reemplazo de `String.replace` las
  // secuencias `$&`, `` $` `` y `$'` son especiales, y el CSS y el JS embebidos las contienen.
  html = html.replace(LINK_CSS, () => `<style>\n${STYLE_CSS}\n</style>`)
  // El bootstrap va ANTES del app.js: `app.js` lee `window.__DAFTAR__` en tiempo de módulo.
  // `</script>` dentro del JSON se escapa: un nombre con esa secuencia cerraría el bloque.
  const json = JSON.stringify(boot).replace(/<\//g, '<\\/')
  html = html.replace(SCRIPT_JS, () => `<script>window.__DAFTAR__ = ${json};</script>\n<script>\n${APP_JS}\n</script>`)
  return html
}
