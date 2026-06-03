import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { VergisError } from '@vergis/botler'

export interface MiraDataset {
  capability: string
  params?: Record<string, unknown>
  shape?: { type?: string; fields?: Record<string, string> }
}

/** Una vista (página) de un PI multi-vista. Cada página es una pieza con su propio contexto. */
export interface MiraPage {
  id: string
  title: string
  piece: Record<string, unknown>
  /** Parámetros de contexto que esta vista recibe del drill-through (`:ctx.<param>` en su data). */
  context?: string[]
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
  /** PI de una sola vista. Exactamente uno de `piece` | `pages`. */
  piece?: Record<string, unknown>
  /** PI multi-vista (páginas navegables + drill-through). Exactamente uno de `piece` | `pages`. */
  pages?: MiraPage[]
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

  // 1·bis · Exactamente uno de `piece` | `pages` (PI de una vista vs multi-vista).
  const hasPiece = s.piece != null
  const hasPages = Array.isArray(s.pages) && s.pages.length > 0
  if (hasPiece === hasPages) {
    throw new VergisError({
      error: 'mira/spec-invalid',
      code: 'piece-pages-xor',
      path: '/',
      message: hasPiece
        ? 'El spec declara `piece` y `pages` a la vez. Un PI es de una vista (`piece`) o multi-vista (`pages`), no ambos.'
        : 'El spec no declara ni `piece` ni `pages`. Declara uno: `piece` (una vista) o `pages` (multi-vista).',
      remediation: 'Dejar solo `piece` (PI simple) o solo `pages` (PI multi-vista con navegación/drill-through).',
    })
  }

  // Páginas (multi-vista): validar ids únicos y aristas de drill-through.
  if (hasPages) validatePages(s.pages!)

  // 2 · Referencias colgantes: cada data.<path> usada en alguna pieza existe en data.
  const pieces = hasPages ? s.pages!.map((p) => p.piece) : [s.piece as Record<string, unknown>]
  const refs = [...new Set(pieces.flatMap((pc) => collectDataRefs(pc)))]
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

/** Arista de drill-through declarada en una tabla: al clickear una fila, ir a la vista `to` pasando `by`. */
export interface Drillthrough {
  to: string
  by: string
}

/** Recolecta las aristas de drill-through (tablas con `drillthrough`) en el subárbol de una pieza. */
export function collectDrills(node: unknown, acc: Drillthrough[] = []): Drillthrough[] {
  if (node == null || typeof node !== 'object') return acc
  if (Array.isArray(node)) {
    for (const c of node) collectDrills(c, acc)
    return acc
  }
  const obj = node as Record<string, unknown>
  const table = obj['table'] as { drillthrough?: { to?: unknown; by?: unknown } } | undefined
  const d = table?.drillthrough
  if (d && typeof d.to === 'string' && typeof d.by === 'string') acc.push({ to: d.to, by: d.by })
  for (const v of Object.values(obj)) collectDrills(v, acc)
  return acc
}

/** Valida páginas: ids únicos + aristas de drill-through (destino existe, recibe el contexto). */
function validatePages(pages: MiraPage[]): void {
  const ids = new Set<string>()
  for (const p of pages) {
    if (ids.has(p.id)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'duplicate-page-id',
        path: `pages[].id`,
        value: p.id,
        message: `Id de página duplicado: '${p.id}'.`,
        remediation: 'Cada página debe tener un id único.',
      })
    }
    ids.add(p.id)
  }
  const byId = new Map(pages.map((p) => [p.id, p]))
  for (const p of pages) {
    for (const d of collectDrills(p.piece)) {
      const target = byId.get(d.to)
      if (!target) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'drill-target-missing',
          path: `pages[${p.id}] -> drillthrough.to`,
          value: d.to,
          message: `La vista '${p.id}' dríllea a '${d.to}', que no es una página declarada.`,
          remediation: `Crear la página '${d.to}' o corregir drillthrough.to.`,
        })
      }
      if (!(target.context ?? []).includes(d.by)) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'drill-context-mismatch',
          path: `pages[${d.to}].context`,
          value: d.by,
          message: `La vista '${p.id}' dríllea a '${d.to}' pasando '${d.by}', pero '${d.to}' no declara '${d.by}' en su context.`,
          remediation: `Agregar '${d.by}' a context de la página '${d.to}' (y usar :ctx.${d.by} en su data).`,
        })
      }
    }
  }
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
