/**
 * LOCKSTEP DE LOS PLUGINS `vergis`, `custos` y `mira` (diseño lab/work/285, D11 · #366; tres plugins desde
 * el diseño lab/work/288 · #387) — cada plugin tiene la versión del Producto, y el marketplace lo fija al
 * TAG de esa versión.
 *
 * Por qué es un invariante y no una costumbre: un operador que instalara un plugin desde `main`
 * consumiría operación sin versión — lo mismo que D-28 existe para impedir con la imagen. Con el
 * lockstep, el plugin de la versión v conoce el contrato hasta v y lo posterior lo lee del nodo
 * (`/contrato`). El commit de corte sube `package.json`, el `plugin.json` de CADA plugin y el `ref` de
 * CADA entrada de `.claude-plugin/marketplace.json` JUNTOS; si no, esto sale rojo (en la suite y en
 * `npm run corte:cotejo`).
 *
 * El `ref` no lleva `sha`: el `sha` no puede apuntar al commit de corte que lo contiene, y apuntar al
 * anterior dejaría de coincidir con el tag (medido por el juez del diseño, C27).
 *
 * `custos` y `mira` dependen de `vergis`: es el plugin que trae el CLI `vergis-ops` (su `bin/` entra al
 * PATH de la herramienta Bash) y la declaración de la instalación. Sin la dependencia, sus skills
 * invocarían un comando que no existe.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Los plugins publicados, en el orden del marketplace, con las dependencias que cada uno exige. */
export const PLUGINS: readonly { name: string; dependsOn: readonly string[] }[] = [
  { name: 'vergis', dependsOn: [] },
  { name: 'custos', dependsOn: ['vergis'] },
  { name: 'mira', dependsOn: ['vergis'] },
]

export function pluginLockstep(raiz: string): string[] {
  const errores: string[] = []
  const leer = (p: string) => JSON.parse(readFileSync(join(raiz, p), 'utf8'))
  const version = leer('package.json').version as string
  const mk = leer('.claude-plugin/marketplace.json')
  if (mk.name !== 'vergis') errores.push(`marketplace.json: name es «${mk.name}» y el marketplace se llama «vergis» (<plugin>@vergis)`)
  const entradas: { name: string; source: unknown }[] = mk.plugins ?? []
  const conocidos = new Set(PLUGINS.map((p) => p.name))
  for (const e of entradas) {
    if (!conocidos.has(e.name)) errores.push(`marketplace.json: lista «${e.name}», que no está en el lockstep (scripts/plugin-lockstep.ts): nadie cotejaría su versión`)
  }

  for (const { name, dependsOn } of PLUGINS) {
    let plugin: { name?: string; version?: string; dependencies?: unknown }
    try {
      plugin = leer(`plugins/${name}/.claude-plugin/plugin.json`)
    } catch {
      errores.push(`plugins/${name}/.claude-plugin/plugin.json: no existe o no es JSON`)
      continue
    }
    if (plugin.name !== name) errores.push(`${name}/plugin.json: name es «${plugin.name}» y el nombre publicado es inmutable: «${name}»`)
    if (plugin.version !== version) errores.push(`${name}/plugin.json: version ${plugin.version} ≠ package.json ${version} (lockstep)`)
    const deps = Array.isArray(plugin.dependencies) ? plugin.dependencies : []
    for (const d of dependsOn) {
      if (!deps.includes(d)) errores.push(`${name}/plugin.json: no declara la dependencia «${d}» (sus skills invocan el CLI que trae ${d})`)
    }

    const entrada = entradas.find((p) => p.name === name)
    if (!entrada) {
      errores.push(`marketplace.json: no lista el plugin «${name}»`)
      continue
    }
    if (typeof entrada.source !== 'object' || entrada.source === null) {
      errores.push(`marketplace.json (${name}): la fuente es «${entrada.source}» y tiene que ser git-subdir (una ruta relativa instalaría lo que haya en main)`)
      continue
    }
    const s = entrada.source as Record<string, unknown>
    if (s.source !== 'git-subdir') errores.push(`marketplace.json (${name}): la fuente es «${s.source}» y tiene que ser git-subdir (una ruta relativa instalaría lo que haya en main)`)
    if (s.url !== 'https://github.com/Gegolabs/vergis.git') errores.push(`marketplace.json (${name}): url «${s.url}»`)
    if (s.path !== `plugins/${name}`) errores.push(`marketplace.json (${name}): path «${s.path}» ≠ «plugins/${name}»`)
    if (s.ref !== `v${version}`) errores.push(`marketplace.json (${name}): ref «${s.ref}» ≠ «v${version}» (el tag de la versión de package.json)`)
    if ('sha' in s) errores.push(`marketplace.json (${name}): la fuente no lleva sha (no puede apuntar al commit de corte que lo contiene)`)
  }
  return errores
}
