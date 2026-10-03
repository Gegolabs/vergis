// Carga del policy store desde los archivos de `VERGIS_POLICIES` (#348). Vive fuera de `serve-rls.ts`
// para que el arranque y la recarga en caliente se puedan poner en riesgo con un test: el server no es
// importable (top-level await), y lo que importa medir es la fusión de archivos y el swap.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { mergePolicyStores, parsePolicyStore, type PolicyStoreDoc } from '@vergis/policy'
import type { PolicyDecl } from '@vergis/policy'

/** Lee y funde los archivos de `paths`. Lanza si alguno no parsea o si un dataset está en dos archivos. */
export function loadPolicyStore(paths: readonly string[]): Map<string, PolicyDecl> {
  const files = paths.map((p) => ({ path: p, policies: parsePolicyStore(parseYaml(readFileSync(resolve(p), 'utf8')) as PolicyStoreDoc) }))
  return mergePolicyStores(files)
}

/**
 * Recarga `store` en su lugar con validate-before-swap: se carga TODO en un mapa aparte y solo si no
 * lanzó se reemplaza el contenido (misma referencia, la que las clausuras capturaron). Si lanza, el
 * store vigente queda intacto y se devuelve el motivo.
 */
export function reloadPolicyStoreInPlace(store: Map<string, PolicyDecl>, paths: readonly string[]): { ok: true } | { ok: false; error: string } {
  let next: Map<string, PolicyDecl>
  try {
    next = loadPolicyStore(paths)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  store.clear()
  for (const [k, v] of next) store.set(k, v)
  return { ok: true }
}
