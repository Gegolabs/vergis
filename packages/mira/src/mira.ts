import {
  VergisError,
  type Botlet,
  type BotletHost,
  type InvocationContext,
} from '@vergis/botler'
import { composePiece, type DatasetResult, type ResolvedNode } from './compose'
import { parseSpec } from './dsl/parse'
import { collectDataRefs, validateSpec, type MiraDataset, type MiraPage, type MiraSpec } from './dsl/validate'
import { checkFreshness } from './freshness'
import { resolveTheme } from './theme-config'

export interface MiraOptions {
  schema: object
}

export interface MiraOutput {
  id: string
  html: string
  artifacts: { format: string; path?: string }[]
}

/**
 * Mira v0.1 — proto-Botlet platafórmico G1 (subconjunto del doc 2 §5.1).
 * Todo su código es genérico; la especialización vive en la configuración (DSL).
 * Pipeline: validar → recuperar → calidad → componer/render → distribuir → log.
 */
export class MiraBotlet implements Botlet {
  readonly type = 'mira'
  readonly id: string
  private validated: MiraSpec | null = null

  constructor(private readonly spec: MiraSpec, private readonly opts: MiraOptions) {
    this.id = spec?.identity?.id ?? 'mira-unknown'
  }

  validate(ctx: { capabilities: string[] }): void {
    this.validated = validateSpec(this.spec, { capabilities: ctx.capabilities, schema: this.opts.schema })
  }

  async invoke(ctx: InvocationContext, host: BotletHost): Promise<MiraOutput> {
    const spec = this.validated
    if (!spec) {
      throw new VergisError({
        error: 'mira/invoke',
        code: 'not-validated',
        message: `Mira '${this.id}' invocada sin validación previa.`,
        remediation: 'Registrar el Botlet en el Botler (que valida) antes de invocarlo.',
      })
    }
    const identity = ctx.identity

    // 2·bis · VISTA ACTIVA (multi-vista) o pieza única. En multi-vista se elige la página por
    // `params.page` (default: la 1ª) y se recuperan SOLO sus datasets. El drill-through pasa
    // `params.ctx` (campo→valor), que se inyecta como PARÁMETRO BIND (`@ctx_<campo>`, injection-safe)
    // en el `:ctx.<campo>` de la query — un filtro ADICIONAL dentro de las filas que la RLS ya
    // autoriza (acota, nunca amplía: la query lee la misma tabla gobernada).
    const isMulti = Array.isArray(spec.pages) && spec.pages.length > 0
    const pageParam = ctx.params?.['page'] as string | undefined
    const ctxValues = normalizeCtx(ctx.params?.['ctx'])
    let activePiece: Record<string, unknown>
    let pagesNav: { items: { id: string; title: string }[]; active: string } | undefined
    let datasetNames: string[]
    if (isMulti) {
      const pages = spec.pages!
      const active = pages.find((p) => p.id === pageParam) ?? pages[0]
      // Las páginas-destino de drill (declaran `context`) NO van en la nav por defecto: solo tienen
      // sentido alcanzadas por drill. Aparecen "bajo demanda" — únicamente cuando son la vista activa.
      const navPages = pages.filter((p) => !(p.context && p.context.length > 0) || p.id === active.id)
      pagesNav = { items: navPages.map((p) => ({ id: p.id, title: p.title })), active: active.id }
      const missing = (active.context ?? []).filter((c) => !ctxValues[c])
      if (missing.length > 0) {
        // Vista de detalle sin contexto (acceso directo, no por drill) → no se consulta nada
        // (evita volcar todo); se muestra una guía para elegir un registro.
        activePiece = contextPrompt(active, missing)
        datasetNames = []
      } else {
        activePiece = active.piece
        datasetNames = uniqueDatasets(active.piece)
      }
    } else {
      activePiece = spec.piece as Record<string, unknown>
      datasetNames = Object.keys(spec.data)
    }

    // 3 · Recuperación de datos (vía Botler.capability_call, nunca acceso directo)
    const results: Record<string, DatasetResult> = {}
    for (const name of datasetNames) {
      const ds = spec.data[name]
      if (!ds) continue
      const params = isMulti ? applyCtx(ds.params, ctxValues) : ds.params
      host.log({ type: 'mira-retrieve', botletId: this.id, dataset: name, capability: ds.capability })
      const out = (await host.capabilityCall(ds.capability, params, identity)) as { rows?: Record<string, unknown>[] }
      results[name] = { rows: out?.rows ?? [] }
      // 4a · Calidad: chequeo de shape (freshness se evalúa tras recuperar todo)
      this.checkShape(name, ds, results[name], host)
    }

    // 4 · freshness (doc 2 §5.3) — degradación según quality.degradation.on_stale
    const freshness = checkFreshness(spec, results, Date.now())
    let banner: ResolvedNode | null = null
    if (freshness.checked && freshness.stale) {
      const onStale = String(
        (spec.quality as { degradation?: Record<string, unknown> } | undefined)?.degradation?.['on_stale'] ??
          'warn_and_show',
      )
      const watermarkLabel = freshness.watermark?.toISOString().slice(0, 10) ?? '—'
      host.log({ type: 'mira-freshness', botletId: this.id, stale: true, onStale, ageMs: freshness.ageMs, watermark: watermarkLabel })
      if (onStale === 'refuse_render') {
        throw new VergisError({
          error: 'mira/quality',
          code: 'stale-refused',
          message: `Datos stale (al ${watermarkLabel}, antigüedad ${freshness.ageHuman}) y política on_stale=refuse_render.`,
          remediation: 'Refrescar los datos de origen o relajar quality.freshness.max_age.',
        })
      }
      if (onStale === 'agentic_fallback') {
        throw new VergisError({
          error: 'mira/quality',
          code: 'stale-agentic-fallback',
          message: `Datos stale (al ${watermarkLabel}) y política on_stale=agentic_fallback.`,
        })
      }
      // warn_and_show / show_last_valid (sin caché en v0.1) → banner + continuar
      banner = {
        type: 'banner',
        content: `⚠ Datos al ${watermarkLabel} — antigüedad ${freshness.ageHuman}, supera el máximo (${freshness.maxAgeRaw}).`,
      }
    } else if (freshness.checked) {
      host.log({ type: 'mira-freshness', botletId: this.id, stale: false, watermark: freshness.watermark?.toISOString().slice(0, 10) })
    }

    // 5 · Composición + render
    host.log({ type: 'mira-compose', botletId: this.id })
    const composed = composePiece(activePiece, results, spec)
    const resolved: ResolvedNode = banner ? { layout: 'rows', elements: [banner, composed] } : composed

    // 5·bis · Anotaciones (enriquecimiento solo de la capa de viz): si el llamador pasa el
    // contexto, se fusiona la columna de anotación en la primera tabla por su clave de registro.
    const annCtx = ctx.params?.['annotations'] as AnnotationContext | undefined
    if (annCtx) await applyAnnotations(resolved, annCtx)

    // 5a · Interacción declarada acotada (doc 2 §10): si hay filtro, se materializan
    // los datasets para que la Faceta filtre client-side, sin nuevas queries.
    let interactive: { datasets: Record<string, Record<string, unknown>[]>; filters: NonNullable<NonNullable<MiraSpec['interactions']>['filters']> } | undefined
    // En multi-vista, un filtro solo aplica a la página cuyo dataset se recuperó.
    const filters = (spec.interactions?.filters ?? []).filter((f) => !isMulti || f.dataset in results)
    if (filters.length > 0) {
      const datasets: Record<string, Record<string, unknown>[]> = {}
      for (const [name, res] of Object.entries(results)) datasets[name] = res.rows
      interactive = { datasets, filters }
      host.log({ type: 'mira-interaction', botletId: this.id, filters: filters.map((f) => f.field) })
    }
    const renders = spec.delivery?.render ?? [{ format: 'html', target: 'web' }]
    let html = ''
    for (const r of renders) {
      if (r.format !== 'html') {
        host.log({ type: 'mira-render-skip', botletId: this.id, format: r.format, reason: 'no soportado en v0.1' })
        continue
      }
      // Theme/paleta por TIPO de PI (default de plataforma; el theme del spec, si existe, gana).
      const { theme, palette } = resolveTheme(resolved, r.theme)
      const rendered = (await host.capabilityCall(
        'render-html-piece',
        {
          piece: resolved,
          title: spec.identity.display_name,
          theme,
          palette,
          meta: {
            date: freshness.watermark,
            generatedAt: new Date(),
            org: spec.identity['org'] as string | undefined,
            classification: spec.identity.classification,
            code: spec.identity.code,
          },
          interactive,
          pages: pagesNav,
        },
        identity,
      )) as { html: string }
      html = rendered.html
      host.log({ type: 'mira-render', botletId: this.id, format: 'html' })
    }

    // 6 · Distribución
    const artifacts: { format: string; path?: string }[] = []
    for (const ch of spec.delivery?.channels ?? []) {
      const params = { ...(ch.params ?? {}), content: html, baseDir: ctx.params?.['baseDir'] }
      const out = (await host.capabilityCall(ch.capability, params, identity)) as { path?: string }
      host.log({ type: 'mira-publish', botletId: this.id, channel: ch.type, capability: ch.capability, path: out?.path })
      artifacts.push({ format: 'html', path: out?.path })
    }

    return { id: this.id, html, artifacts }
  }

  private checkShape(name: string, ds: MiraDataset, res: DatasetResult, host: BotletHost): void {
    const shape = ds.shape
    if (!shape) return
    if (shape.type === 'single_row' && res.rows.length < 1) {
      throw new VergisError({
        error: 'mira/quality',
        code: 'shape-empty',
        path: `data.${name}`,
        message: `Dataset '${name}' declarado single_row pero no devolvió filas.`,
        remediation: 'Revisar la Capability o relajar la shape.',
      })
    }
    host.log({ type: 'mira-quality-ok', botletId: this.id, dataset: name, rows: res.rows.length })
  }
}

/** Crea un Botlet Mira a partir del texto YAML del DSL. */
export function createMiraBotlet(specText: string, opts: MiraOptions): MiraBotlet {
  const spec = parseSpec(specText) as MiraSpec
  return new MiraBotlet(spec, opts)
}

/**
 * Contexto de anotaciones que el llamador (server) inyecta vía `params.annotations`. Mira solo
 * fusiona la columna en la pieza; el origen del dato y la firma del token los provee `resolve`.
 */
export interface AnnotationContext {
  /** Identificador del PI (clave de partición de las anotaciones). */
  piId: string
  /** Etiqueta de la columna. Default "Anotaciones". */
  label?: string
  /** Endpoint POST para escribir una anotación. */
  endpoint: string
  /** Campo-clave del registro. Default: la primera columna de la tabla. */
  keyField?: string
  /** Dadas las claves visibles, devuelve {clave → {valor compartido, token de escritura firmado}}. */
  resolve(keys: string[]): Promise<Record<string, { value: string; token: string }>>
}

const ANN_VALUE_FIELD = '__ann'
const ANN_TOKEN_FIELD = '__anntok'

/** Encuentra la primera tabla en el árbol de pieza (DFS). */
function findFirstTable(node: ResolvedNode): ResolvedNode | undefined {
  if (node.type === 'table') return node
  for (const c of node.elements ?? []) {
    const f = findFirstTable(c)
    if (f) return f
  }
  return undefined
}

/** Fusiona la columna de anotación en la primera tabla, por clave de registro. */
async function applyAnnotations(piece: ResolvedNode, ann: AnnotationContext): Promise<void> {
  const table = findFirstTable(piece)
  if (!table || !table.columnsSpec || table.columnsSpec.length === 0) return
  const rows = table.rows ?? []
  const keyField = ann.keyField ?? table.columnsSpec[0].field
  const keys = [...new Set(rows.map((r) => String(r[keyField] ?? '')))]
  const map = await ann.resolve(keys)
  for (const r of rows) {
    const k = String(r[keyField] ?? '')
    r[ANN_VALUE_FIELD] = map[k]?.value ?? ''
    r[ANN_TOKEN_FIELD] = map[k]?.token ?? ''
  }
  table.columnsSpec.push({ field: ANN_VALUE_FIELD, label: ann.label ?? 'Anotaciones', annotation: true })
  table.annotation = {
    valueField: ANN_VALUE_FIELD,
    tokenField: ANN_TOKEN_FIELD,
    keyField,
    endpoint: ann.endpoint,
    label: ann.label ?? 'Anotaciones',
  }
}

// --- Multi-vista + drill-through (helpers) ----------------------------------

/** Normaliza el contexto del drill (`params.ctx`) a un mapa campo→string. */
function normalizeCtx(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v != null && v !== '') out[k] = String(v)
  }
  return out
}

/** Datasets (sin repetir) que una pieza referencia vía `data.<dataset>...`. */
function uniqueDatasets(piece: Record<string, unknown>): string[] {
  return [...new Set(collectDataRefs(piece).map((r) => r.split('.')[0]))]
}

/**
 * Sustituye `:ctx.<param>` en `params.sql` por un PARÁMETRO BIND `@ctx_<param>` y adjunta su valor
 * en `params.params` (la Capability lo bindea — nunca concatena → injection-safe). Si no hay `:ctx.`
 * o no hay sql, devuelve los params intactos.
 */
function applyCtx(params: Record<string, unknown> | undefined, ctxValues: Record<string, string>): Record<string, unknown> | undefined {
  if (!params || typeof params['sql'] !== 'string') return params
  const sql = params['sql'] as string
  if (!sql.includes(':ctx.')) return params
  const bound: Record<string, string> = {}
  const rewritten = sql.replace(/:ctx\.([a-zA-Z0-9_]+)/g, (_m, param: string) => {
    bound[`ctx_${param}`] = ctxValues[param] ?? ''
    return `@ctx_${param}`
  })
  return { ...params, sql: rewritten, params: { ...((params['params'] as Record<string, unknown>) ?? {}), ...bound } }
}

/** Pieza-guía cuando se entra a una vista de detalle sin el contexto requerido (no por drill). */
function contextPrompt(page: MiraPage, missing: string[]): Record<string, unknown> {
  return {
    layout: 'rows',
    elements: [
      {
        markdown_block: {
          content: `### ${page.title}\n\nSelecciona un registro en otra vista para ver su detalle (falta: ${missing.join(', ')}).`,
        },
      },
    ],
  }
}
