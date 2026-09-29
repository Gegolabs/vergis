/**
 * LOCKSTEP DEL PLUGIN `vergis` (diseño lab/work/285, D11 · #366) — el plugin tiene la versión del
 * Producto, y el marketplace lo fija al TAG de esa versión.
 *
 * Por qué es un invariante y no una costumbre: un operador que instalara el plugin desde `main`
 * consumiría operación sin versión — lo mismo que D-28 existe para impedir con la imagen. Con el
 * lockstep, el plugin de la versión v conoce el contrato hasta v y lo posterior lo lee del nodo
 * (`/contrato`). El commit de corte sube `package.json`, `plugins/vergis/.claude-plugin/plugin.json` y el
 * `ref` de `.claude-plugin/marketplace.json` JUNTOS; si no, esto sale rojo (en la suite y en
 * `npm run corte:cotejo`).
 *
 * El `ref` no lleva `sha`: el `sha` no puede apuntar al commit de corte que lo contiene, y apuntar al
 * anterior dejaría de coincidir con el tag (medido por el juez del diseño, C27).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function pluginLockstep(raiz: string): string[] {
  const errores: string[] = []
  const leer = (p: string) => JSON.parse(readFileSync(join(raiz, p), 'utf8'))
  const version = leer('package.json').version as string
  const plugin = leer('plugins/vergis/.claude-plugin/plugin.json')
  const mk = leer('.claude-plugin/marketplace.json')
  if (plugin.name !== 'vergis') errores.push(`plugin.json: name es «${plugin.name}» y el nombre publicado es inmutable: «vergis»`)
  if (plugin.version !== version) errores.push(`plugin.json: version ${plugin.version} ≠ package.json ${version} (lockstep)`)
  if (mk.name !== 'vergis') errores.push(`marketplace.json: name es «${mk.name}» y el marketplace se llama «vergis» (vergis@vergis)`)
  const entrada = (mk.plugins ?? []).find((p: { name: string }) => p.name === 'vergis')
  if (!entrada) errores.push('marketplace.json: no lista el plugin «vergis»')
  else if (typeof entrada.source !== 'object' || entrada.source === null) {
    errores.push(`marketplace.json: la fuente es «${entrada.source}» y tiene que ser git-subdir (una ruta relativa instalaría lo que haya en main)`)
  } else {
    const s = entrada.source
    if (s.source !== 'git-subdir') errores.push(`marketplace.json: la fuente es «${s.source}» y tiene que ser git-subdir (una ruta relativa instalaría lo que haya en main)`)
    if (s.url !== 'https://github.com/Gegolabs/vergis.git') errores.push(`marketplace.json: url «${s.url}»`)
    if (s.path !== 'plugins/vergis') errores.push(`marketplace.json: path «${s.path}»`)
    if (s.ref !== `v${version}`) errores.push(`marketplace.json: ref «${s.ref}» ≠ «v${version}» (el tag de la versión de package.json)`)
    if ('sha' in s) errores.push('marketplace.json: la fuente no lleva sha (no puede apuntar al commit de corte que lo contiene)')
  }
  return errores
}
