import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { VergisError } from '@vergis/botler'

export interface MiraDataset {
  capability: string
  params?: Record<string, unknown>
  shape?: { type?: string; fields?: Record<string, string> }
}

export interface MiraSpec {
  mira_version: string
  identity: {
    id: string
    display_name: string
    classification: string
    code?: string
    [k: string]: unknown
  }
  piece: Record<string, unknown>
  interactions?: {
    /** Los filtros disponibles que viven en la bandeja de filtros. */
    filters?: { dataset: string; field: string; label?: string; multi?: boolean }[]
  }
  data: Record<string, MiraDataset>
  quality: Record<string, unknown>
  delivery: {
    render?: { format: string; target?: string; theme?: string }[]
    channels?: { type: string; capability: string; params?: Record<string, unknown>; schedule?: string }[]
    [k: string]: unknown
  }
}

let cached: ValidateFunction | null = null

function getValidator(schema: object): ValidateFunction {
  if (cached) return cached
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  cached = ajv.compile(schema)
  return cached
}

/**
 * Validación en orden (doc 3 §9): schema → referencias → capabilities → shape → policy.
 * Cualquier fallo lanza un VergisError estructurado y accionable.
 */
export function validateSpec(spec: unknown, ctx: { capabilities: string[]; schema: object }): MiraSpec {
  // 1 · Schema
  const validate = getValidator(ctx.schema)
  if (!validate(spec)) {
    const e = validate.errors?.[0]
    throw new VergisError({
      error: 'mira/spec-invalid',
      code: 'schema-violation',
      path: e?.instancePath || '/',
      value: (e as { data?: unknown } | undefined)?.data,
      message: `Spec no conforme al schema: ${e?.instancePath ?? ''} ${e?.message ?? ''}`.trim(),
      remediation: 'Corregir la estructura de la spec según mira-spec.schema.json.',
    })
  }
  const s = spec as MiraSpec

  // 2 · Referencias colgantes: cada data.<path> usada en piece existe en data
  const refs = collectDataRefs(s.piece)
  for (const ref of refs) {
    const dataset = ref.split('.')[0]
    if (!(dataset in s.data)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'dangling-data-reference',
        path: `piece -> data.${ref}`,
        value: ref,
        message: `La pieza referencia 'data.${ref}' pero el dataset '${dataset}' no existe en el bloque data.`,
        remediation: `Declarar el dataset '${dataset}' en data, o corregir la referencia.`,
      })
    }
  }

  // 3 · Capabilities catalogadas
  for (const [name, ds] of Object.entries(s.data)) {
    if (!ctx.capabilities.includes(ds.capability)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'capability-not-catalogued',
        path: `data.${name}.capability`,
        value: ds.capability,
        message: `Capability '${ds.capability}' no existe en el catálogo del AgencyDomain. Catalogadas: ${ctx.capabilities.join(', ')}.`,
        remediation: `Corregir el nombre o catalogar '${ds.capability}' como Capability nueva.`,
      })
    }
  }

  // 4 · Consistencia de shape: los campos referenciados están declarados
  for (const ref of refs) {
    const [dataset, field] = ref.split('.')
    const ds = s.data[dataset]
    if (ds?.shape?.fields && field && !(field in ds.shape.fields)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'shape-mismatch',
        path: `data.${dataset}.shape.fields`,
        value: field,
        message: `La pieza referencia 'data.${ref}' pero el campo '${field}' no está declarado en data.${dataset}.shape.fields.`,
        remediation: `Declarar '${field}' en shape.fields o corregir la referencia.`,
      })
    }
  }

  // 5 · El spec es AUTHZ-BLIND (charter §2a): NO declara autorización. La política de quién ve
  // qué fila vive ATADA AL DATO (policy store), y se hace cumplir en el dato (ClickHouse row
  // policy + consumidor de bajo privilegio + solo tablas con política reciben acceso). El reporte
  // no decide acceso — no hay nada de gobernanza que validar acá.
  return s
}

/** Recolecta toda referencia data.<dataset>[.<field>...] presente en el subárbol de piece. */
export function collectDataRefs(node: unknown, acc: Set<string> = new Set()): string[] {
  if (node == null) return [...acc]
  if (typeof node === 'string') {
    const matches = node.match(/data\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*/g)
    if (matches) for (const m of matches) acc.add(m.slice('data.'.length))
  } else if (Array.isArray(node)) {
    for (const child of node) collectDataRefs(child, acc)
  } else if (typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) collectDataRefs(v, acc)
  }
  return [...acc]
}
