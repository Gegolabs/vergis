/**
 * Clave raíz de un YAML de configuración de instancia — la frontera entre «el archivo declara cero X»
 * y «el archivo no declara X».
 *
 * Un archivo que perdió su clave raíz (un `sed`, un merge, un `yq`, un truncado) sigue siendo YAML
 * válido: parsea sin ruido y colapsa a vacío. Ese vacío mentiroso es indistinguible de un vacío
 * deliberado si el parser usa `?? []`. Aquí se distinguen tres estados:
 *
 *  · AUSENTE — documento nulo, escalar, lista, o mapa sin la clave → error de arranque.
 *  · PRESENTE pero de tipo equivocado (incluye `clave:` con valor nulo) → error de tipo del parser.
 *  · PRESENTE y vacía (`clave: []` / `clave: {}`) → cero elementos, legítimo y silencioso.
 */

/**
 * Devuelve el valor de la clave raíz `key`, o lanza si el documento no la declara.
 * `empty` es la forma vacía legítima que se sugiere como remediación (`[]` para listas, `{}` para mapas).
 */
export function requireRootKey(doc: unknown, config: string, key: string, empty: '[]' | '{}' = '[]'): unknown {
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc) || !(key in doc)) {
    throw new Error(
      `${config}: falta la clave raíz '${key}' — un archivo declarado como config debe contenerla; ` +
        `para declarar «no hay», usa '${key}: ${empty}'.`,
    )
  }
  return (doc as Record<string, unknown>)[key]
}
