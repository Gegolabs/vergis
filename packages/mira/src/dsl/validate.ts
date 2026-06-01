import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { VergisError } from '@vergis/botler'
import { parseAudience, isPublic, type AudienceDecl } from '@vergis/policy'

/**
 * Capabilities que APLICAN la policy de fila al servir (no-bypass). Un PI gobernado
 * (con `audience.rls`) solo puede recuperar datos por una de estas; las vías crudas
 * (execute-sql-dwh sin OBO, static-data) servirían todas las filas → bypass. El push-down
 * con RLS nativa de la fuente se agrega aquí cuando exista.
 */
const ENFORCING_CAPABILITIES = new Set<string>(['execute-sql-ch'])

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

  // 5 · Gobernanza data-anchored — RLS por construcción (charter 012 §2a/§10).
  // (a) Fail-closed por omisión: el PI DEBE declarar su audiencia explícitamente — una policy
  //     de filas (rls: [...]) o apertura deliberada (rls: public). La omisión NO es público.
  const audience = (s.quality as { audience?: { rls?: unknown } } | undefined)?.audience
  if (!audience || audience.rls == null) {
    throw new VergisError({
      error: 'mira/spec-invalid',
      code: 'audience-undeclared',
      path: 'quality.audience.rls',
      message:
        'El PI no declara su audiencia. Bajo el modelo data-anchored la omisión es fail-closed: no se publica nada abierto por accidente.',
      remediation: "Declarar 'quality.audience.rls' con una policy [{column,claim,op}], o 'rls: public' como apertura deliberada.",
    })
  }
  // (b) No-bypass: si el PI es gobernado, sus datos solo se sirven por capabilities que aplican
  //     la policy. Un dataset gobernado servido por una vía cruda sería una fuga.
  const policy = parseAudience(audience as AudienceDecl)
  if (!isPublic(policy)) {
    for (const [name, ds] of Object.entries(s.data)) {
      if (!ENFORCING_CAPABILITIES.has(ds.capability)) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'governed-data-needs-enforcing-capability',
          path: `data.${name}.capability`,
          value: ds.capability,
          message: `El PI declara RLS pero el dataset '${name}' se sirve por '${ds.capability}', que no aplica la policy (bypass).`,
          remediation: `Servir datos gobernados solo por una capability con enforcement (${[...ENFORCING_CAPABILITIES].join(', ')}) — ClickHouse-RLS o push-down. O marcar el PI 'rls: public' si no hay dato sensible.`,
        })
      }
    }
  }
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
