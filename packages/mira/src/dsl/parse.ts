import YAML from 'yaml'

/** Parse del DSL de Mira (YAML canónico). */
export function parseSpec(text: string): unknown {
  return YAML.parse(text)
}
