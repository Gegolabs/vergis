// Validación de la FRONTERA de salida de las capabilities — extraído de mira.ts (NEXT · Ola 3·B).
// Toda capability se valida en su frontera (en vez de un cast a ciegas que revienta críptico aguas
// abajo): las de RENDER deben devolver `{ <field>: string }`; las de DATOS, `{ rows: [...] }`.
import { VergisError } from '@vergis/botler'

/**
 * Valida la frontera de salida de una capability de RENDER: exige `{ <field>: string }`. Sin esto, un
 * cast a ciegas (`as { html }`) dejaba `undefined` cuando la capability devolvía otra forma, y el
 * backstop anti-página-en-blanco (que compara contra `''`) no disparaba → HTTP 200 en blanco. Es la
 * simetría con `expectRows` en la frontera de datos.
 */
export function expectString(capability: string, field: string, out: unknown): string {
  const val = (out as Record<string, unknown> | null | undefined)?.[field]
  if (typeof val !== 'string') {
    throw new VergisError({
      error: 'mira/render',
      code: 'capability-output-invalid',
      path: field,
      message: `La Capability de render '${capability}' no devolvió '{ ${field}: string }'.`,
      remediation: `Toda Capability de render debe devolver un objeto con el campo string '${field}'.`,
    })
  }
  return val
}

export function expectRows(dataset: string, capability: string, out: unknown): Record<string, unknown>[] {
  const rows = (out as { rows?: unknown } | null | undefined)?.rows
  if (!Array.isArray(rows)) {
    throw new VergisError({
      error: 'mira/retrieve',
      code: 'capability-output-invalid',
      path: `data.${dataset}`,
      message: `La Capability '${capability}' no devolvió '{ rows: [...] }' para el dataset '${dataset}'.`,
      remediation: 'Toda Capability de datos debe devolver un objeto con un arreglo `rows`.',
    })
  }
  return rows as Record<string, unknown>[]
}
