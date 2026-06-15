import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { VergisError } from '@vergis/botler'
import { normalizeDrills } from '../compose'

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
  /**
   * Controles de cabecera (server-side): cada uno fija UN valor que se inyecta como `:ctx.<id>` en
   * las queries de las páginas (a diferencia de `interactions.filters`, que son client-side sobre el
   * dato ya recuperado). Pensados para parámetros que CAMBIAN la consulta — p.ej. la semana a analizar.
   */
  controls?: MiraControl[]
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

  // Controles de cabecera: id único, source existente, default conocido, single (no multi).
  validateControls(s)

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

  // 2·bis · Ejes de `distribution`: el gráfico lee su dataset desde dimension/metric (ruta
  // completa data.<dataset>.<campo>, como un kpi) e IGNORA cualquier clave `data:`. Un eje pelado
  // (`dimension: local`) resuelve un dataset inexistente y el gráfico sale VACÍO sin error — el
  // render no falla, solo no dibuja barras. Lo atajamos acá: exigir ruta completa y rechazar la
  // clave `data:` colgante, que delata que la fuente quedó sin cablear. (La existencia del dataset
  // y del campo la cubren los pasos 2 y 4 una vez que el eje es un data.<...> recolectable.)
  for (const d of pieces.flatMap((pc) => collectDistributions(pc))) {
    for (const axis of ['dimension', 'metric'] as const) {
      const v = d[axis]
      if (typeof v !== 'string' || !v.startsWith('data.') || stripDataRef(v).split('.').length < 2) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'distribution-axis-not-qualified',
          path: `piece -> distribution.${axis}`,
          value: (v ?? null) as never,
          message: `El eje '${axis}' de un gráfico distribution debe ser una ruta completa data.<dataset>.<campo> (como un kpi); recibió ${JSON.stringify(v ?? null)}.`,
          remediation: `Escribir '${axis}: data.<dataset>.<campo>'. El gráfico NO lee una clave 'data:' separada; su fuente sale de dimension/metric.`,
        })
      }
    }
    if ('data' in d) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'distribution-stray-data-key',
        path: `piece -> distribution.data`,
        value: (d['data'] ?? null) as never,
        message: `Un gráfico distribution no lee la clave 'data:'; su dataset sale de dimension/metric. Su presencia indica que la fuente no quedó cableada y el gráfico saldría vacío.`,
        remediation: `Quitar 'data:' y dejar dimension/metric como rutas completas data.<dataset>.<campo>.`,
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

/** Arista de drill-through declarada en una tabla: ir a la vista `to` pasando una o más claves `by`. */
export interface Drillthrough {
  to: string
  by: string[]
}

/** Recolecta las aristas de drill-through (tablas con `drillthrough`) en el subárbol de una pieza. */
export function collectDrills(node: unknown, acc: Drillthrough[] = []): Drillthrough[] {
  if (node == null || typeof node !== 'object') return acc
  if (Array.isArray(node)) {
    for (const c of node) collectDrills(c, acc)
    return acc
  }
  const obj = node as Record<string, unknown>
  const table = obj['table'] as { drillthrough?: unknown } | undefined
  if (table?.drillthrough != null) for (const d of normalizeDrills(table.drillthrough)) acc.push({ to: d.to, by: d.by })
  for (const v of Object.values(obj)) collectDrills(v, acc)
  return acc
}

/** Un control de cabecera del PI. `source` provee las opciones; `default` el valor inicial. */
export interface MiraControl {
  /** Clave del contexto que fija: se inyecta como `:ctx.<id>` en las queries. */
  id: string
  label?: string
  /** Origen de las opciones: `data.<dataset>.<field>`. Sus valores distintos pueblan el selector. */
  source: string
  /** Valor inicial cuando no llega `ctx.<id>` en la URL: el mayor / menor / primero de las opciones. */
  default?: 'max' | 'min' | 'first'
  /** Selección única. Por ahora SOLO single (true). Multi-select se reserva para más adelante. */
  single?: boolean
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
      const ctx = target.context ?? []
      const missing = d.by.filter((k) => !ctx.includes(k))
      if (missing.length > 0) {
        throw new VergisError({
          error: 'mira/spec-invalid',
          code: 'drill-context-mismatch',
          path: `pages[${d.to}].context`,
          value: missing.join(', '),
          message: `La vista '${p.id}' dríllea a '${d.to}' pasando [${d.by.join(', ')}], pero '${d.to}' no declara [${missing.join(', ')}] en su context.`,
          remediation: `Agregar [${missing.join(', ')}] a context de la página '${d.to}' (y usar :ctx.<clave> en su data).`,
        })
      }
    }
  }
}

/**
 * Valida los controles de cabecera: id único, `source` apunta a un dataset existente, `default`
 * conocido, y `single` no es false (multi-select aún no soportado — falla explícita, no silencio).
 */
function validateControls(spec: MiraSpec): void {
  const controls = spec.controls ?? []
  const ids = new Set<string>()
  for (const c of controls) {
    if (!c.id || typeof c.id !== 'string') {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-id-missing',
        path: 'controls[].id',
        message: 'Cada control de cabecera requiere un `id` (la clave de contexto que fija).',
        remediation: 'Declarar `id` en cada entrada de `controls`.',
      })
    }
    if (ids.has(c.id)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-id-duplicate',
        path: 'controls[].id',
        value: c.id,
        message: `Control de cabecera duplicado: '${c.id}'.`,
        remediation: 'Cada control debe tener un id único.',
      })
    }
    ids.add(c.id)
    const dataset = stripDataRef(c.source).split('.')[0]
    if (!dataset || !(dataset in spec.data)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-source-dangling',
        path: `controls[${c.id}].source`,
        value: c.source,
        message: `El control '${c.id}' toma opciones de '${c.source}' pero el dataset '${dataset}' no existe en data.`,
        remediation: `Declarar el dataset fuente en data (p.ej. una query de valores distintos), o corregir source.`,
      })
    }
    if (c.default != null && !['max', 'min', 'first'].includes(c.default)) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-default-invalid',
        path: `controls[${c.id}].default`,
        value: c.default,
        message: `default '${c.default}' inválido para el control '${c.id}'. Valores: max | min | first.`,
        remediation: 'Usar max (más reciente), min o first, u omitir default.',
      })
    }
    if (c.single === false) {
      throw new VergisError({
        error: 'mira/spec-invalid',
        code: 'control-multi-unsupported',
        path: `controls[${c.id}].single`,
        value: c.single,
        message: `El control '${c.id}' pide multi-select (single: false), aún no soportado.`,
        remediation: 'Usar single: true (o omitirlo). El multi-select de cabecera se construirá más adelante.',
      })
    }
  }
}

/** `data.<dataset>.<field>` → `<dataset>.<field>` (quita el prefijo data.). */
function stripDataRef(ref: string): string {
  return typeof ref === 'string' && ref.startsWith('data.') ? ref.slice('data.'.length) : String(ref ?? '')
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

/** Recolecta todos los nodos `distribution` (su objeto de config) presentes en el subárbol de piece. */
export function collectDistributions(
  node: unknown,
  acc: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (node == null) return acc
  if (Array.isArray(node)) {
    for (const child of node) collectDistributions(child, acc)
  } else if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (obj['distribution'] && typeof obj['distribution'] === 'object') {
      acc.push(obj['distribution'] as Record<string, unknown>)
    }
    for (const v of Object.values(obj)) collectDistributions(v, acc)
  }
  return acc
}
