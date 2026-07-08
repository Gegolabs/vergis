import {
  VergisError,
  type Botlet,
  type BotletHost,
  type IdentityContext,
  type InvocationContext,
} from '@vergis/botler'
import { composePiece, type DatasetResult, type ResolvedNode } from './compose'
import { parseSpec } from './dsl/parse'
import { collectDataRefs, collectDatasetKeys, validateSpec, type MiraControl, type MiraDataset, type MiraPage, type MiraSpec } from './dsl/validate'
import { checkFreshness, type FreshnessVerdict } from './freshness'
import { resolveTheme } from './theme-config'

export interface MiraOptions {
  schema: object
  /**
   * Tope de filas que `interactions.filters` puede MATERIALIZAR en el HTML (la suma de todos los
   * datasets embebidos para el filtrado client-side). Superado, el render sale SIN facetas de
   * dashboard (la tabla sigue interactiva por su propio runtime) y se loguea el tamaño — mejor un
   * dashboard sin facetas que un HTML de decenas de MB. Lo inyecta el llamador (Mira no lee env;
   * el server lo toma de VERGIS_INTERACTIVE_MAX_ROWS). Default 5000.
   */
  interactiveMaxRows?: number
}

/** Default del tope de materialización client-side (ver MiraOptions.interactiveMaxRows). */
export const DEFAULT_INTERACTIVE_MAX_ROWS = 5000

export interface MiraOutput {
  id: string
  html: string
  /** Artefactos producidos: los publicados por un canal llevan `path`; los generados en memoria
   *  (p.ej. el CSV de `delivery.render`) llevan `content`. */
  artifacts: { format: string; path?: string; content?: string }[]
}

/** Contexto de navegación (drill/controles): un valor por clave, o VARIOS (control multi-select). */
export type CtxValues = Record<string, string | string[]>

/** Barra de navegación de un PI multi-vista (páginas navegables + la activa). */
export interface PagesNav {
  items: { id: string; title: string }[]
  active: string
}

/** Control de cabecera ya resuelto: opciones + valor(es) seleccionado(s). Viaja al render. */
export interface ControlResolved {
  id: string
  label: string
  options: string[]
  /** Valor para display (multi: los valores unidos por ", "). */
  value: string
  /** Solo multi-select: los valores seleccionados. */
  values?: string[]
  /** `true` si el control es multi-select (`single: false` en el DSL). */
  multi?: boolean
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

    // 2·bis · VISTA ACTIVA (multi-vista) o pieza única — ver resolveActiveView.
    const pageParam = ctx.params?.['page'] as string | undefined
    const ctxValues = normalizeCtx(ctx.params?.['ctx'])
    const view = resolveActiveView(spec, pageParam, ctxValues)
    let { activePiece, datasetNames } = view
    const pagesNav = view.pagesNav
    const isMulti = pagesNav != null
    // Enlace a una página inexistente: se sirvió la 1ª en su lugar. Se audita en vez de fallar en silencio.
    if (view.pageUnknown) host.log({ type: 'mira-page-unknown', botletId: this.id, requested: pageParam, served: pagesNav?.active })

    // 3 · Recuperación de datos (vía Botler.capability_call, nunca acceso directo)
    const results: Record<string, DatasetResult> = {}

    // 2·ter · CONTROLES DE CABECERA — ver resolveHeaderControls (muta results/ctxValues).
    const { controlsResolved, carryCtx } = await this.resolveHeaderControls(spec, ctxValues, results, host, identity)

    // Frescura en multi-vista: `checkFreshness` resuelve el watermark GLOBAL contra `results`. En
    // multi-vista solo se recuperan los datasets de la página activa, así que si el `watermark_field`
    // apunta a un dataset de OTRA página, quedaría sin resolver → veredicto "fresco" en silencio.
    // Lo incluimos en la recuperación para que la garantía de frescura proteja TODA página, no solo la
    // que casualmente carga el dataset del watermark. Es una query pequeña. (Las frescuras POR-DATASET
    // se evalúan sobre lo recuperado: siguen la página que usa su dataset.)
    const wmDataset = watermarkDatasetOf(spec)
    if (wmDataset && spec.data[wmDataset] && !datasetNames.includes(wmDataset)) {
      datasetNames = [...datasetNames, wmDataset]
    }

    // Recuperación de los datasets de página EN PARALELO: no hay dependencias entre ellos (los
    // controles ya resolvieron `ctxValues` arriba, secuencialmente porque un control puede depender del
    // valor del anterior). El `checkShape` se mantiene por-dataset tras su retrieval; los logs pueden
    // intercalarse. Se saltan los ya recuperados (p.ej. fuente de un control).
    const pending = datasetNames.filter((name) => !results[name] && spec.data[name])
    await Promise.all(
      pending.map(async (name) => {
        const ds = spec.data[name]!
        const missing: string[] = []
        // `applyCtx` SIEMPRE: es no-op cuando el sql no contiene `:ctx.` (devuelve los params intactos).
        // Antes solo se aplicaba en multi-vista, y un PI de UNA vista con `controls` dejaba el `:ctx.<id>`
        // literal en el sql (falla en el motor) o hacía del control un no-op silencioso.
        const params = applyCtx(ds.params, ctxValues, missing)
        if (missing.length > 0) host.log({ type: 'mira-ctx-missing', botletId: this.id, dataset: name, params: missing })
        host.log({ type: 'mira-retrieve', botletId: this.id, dataset: name, capability: ds.capability })
        const out = await host.capabilityCall(ds.capability, params, identity)
        results[name] = { rows: expectRows(name, ds.capability, out) }
        // 4a · Calidad: chequeo de shape (freshness se evalúa tras recuperar todo)
        this.checkShape(name, ds, results[name], host)
      }),
    )

    // 4 · freshness (doc 2 §5.3) — declaraciones global + por-dataset; el MÁS stale gana; el banner
    // nombra al/los dataset(s) atrasado(s). Degradación según quality.degradation.on_stale.
    const freshness = checkFreshness(spec, results, Date.now())
    const banner = this.staleBanner(spec, freshness, host)

    // 5 · Composición + render
    host.log({ type: 'mira-compose', botletId: this.id })
    const composed = composePiece(activePiece, results, spec)
    const resolved: ResolvedNode = banner ? { layout: 'rows', elements: [banner, composed] } : composed

    // 5·bis · Anotaciones (enriquecimiento solo de la capa de viz): si el llamador pasa el
    // contexto, se fusiona la columna de anotación en la tabla destino por su clave de registro
    // (la del `dataset` pedido, o la primera tabla del árbol por defecto).
    const annCtx = ctx.params?.['annotations'] as AnnotationContext | undefined
    if (annCtx) await applyAnnotations(resolved, annCtx)

    // 5a · Interacción declarada acotada (doc 2 §10): si hay filtro, se materializan
    // los datasets para que la Faceta filtre client-side, sin nuevas queries.
    let interactive: { datasets: Record<string, Record<string, unknown>[]>; filters: NonNullable<NonNullable<MiraSpec['interactions']>['filters']> } | undefined
    // En multi-vista, un filtro solo aplica a la página cuyo dataset se recuperó.
    const filters = (spec.interactions?.filters ?? []).filter((f) => !isMulti || f.dataset in results)
    if (filters.length > 0) {
      // Tope de materialización: los datasets se embeben COMPLETOS en el HTML para el filtrado
      // client-side. Sin cota, un dataset grande produce un documento de decenas de MB. Superado el
      // tope, NO se materializa (render sin facetas; la tabla sigue interactiva por su runtime).
      const maxRows = this.opts.interactiveMaxRows ?? DEFAULT_INTERACTIVE_MAX_ROWS
      let totalRows = 0
      for (const res of Object.values(results)) totalRows += res.rows.length
      if (totalRows > maxRows) {
        host.log({ type: 'mira-interaction-skipped', botletId: this.id, rows: totalRows, max: maxRows })
      } else {
        const datasets: Record<string, Record<string, unknown>[]> = {}
        for (const [name, res] of Object.entries(results)) datasets[name] = res.rows
        interactive = { datasets, filters }
        host.log({ type: 'mira-interaction', botletId: this.id, filters: filters.map((f) => f.field) })
      }
    }

    // 6 · Renders declarados. Soportados: `html` (el documento servido) y `csv` (artefacto en memoria
    // con las tablas del árbol resuelto — ver render-csv-piece). PDF NO se implementa como render
    // server-side: se cubre con el print-to-PDF del navegador (botón Imprimir de la gaveta).
    const artifacts: MiraOutput['artifacts'] = []
    const renders = spec.delivery?.render ?? [{ format: 'html', target: 'web' }]
    let html = ''
    for (const r of renders) {
      if (r.format === 'csv') {
        const rendered = await host.capabilityCall(
          'render-csv-piece',
          { piece: resolved, title: spec.identity.display_name },
          identity,
        )
        // El contenido queda EN MEMORIA (artifacts[].content); se escribe a disco solo si un canal
        // de distribución lo publica (hoy los channels publican el HTML — ver §6·bis).
        artifacts.push({ format: 'csv', content: expectString('render-csv-piece', 'csv', rendered) })
        host.log({ type: 'mira-render', botletId: this.id, format: 'csv' })
        continue
      }
      if (r.format !== 'html') {
        host.log({ type: 'mira-render-skip', botletId: this.id, format: r.format, reason: 'no soportado en v0.1' })
        continue
      }
      html = await this.renderHtml(resolved, spec, freshness, interactive, pagesNav, controlsResolved, carryCtx, r.theme, host, identity)
      host.log({ type: 'mira-render', botletId: this.id, format: 'html' })
    }

    // Backstop: si se declararon renders pero NINGUNO produjo HTML (p.ej. `render: [{format: pdf}]` o
    // un typo como `htlm`), el server respondería 200 con cuerpo vacío = página en blanco silenciosa.
    // Fallamos ruidoso (la validación ya exige ≥1 render html; esto cubre el resto del pipeline).
    if (html === '' && renders.length > 0) {
      throw new VergisError({
        error: 'mira/render',
        code: 'no-html-output',
        message: `Ningún render de delivery.render produjo HTML (formatos: ${renders.map((r) => r.format).join(', ')}).`,
        remediation: 'Declarar al menos un render con format: html (csv es adicional; PDF = print-to-PDF del navegador).',
      })
    }

    // 6·bis · Distribución
    for (const ch of spec.delivery?.channels ?? []) {
      const params = { ...(ch.params ?? {}), content: html, baseDir: ctx.params?.['baseDir'] }
      const out = (await host.capabilityCall(ch.capability, params, identity)) as { path?: string }
      host.log({ type: 'mira-publish', botletId: this.id, channel: ch.type, capability: ch.capability, path: out?.path })
      artifacts.push({ format: 'html', path: out?.path })
    }

    return { id: this.id, html, artifacts }
  }

  /**
   * 2·ter · Resuelve los CONTROLES DE CABECERA — ANTES de las queries de página: cada control fija
   * su(s) valor(es) (de `ctx.<id>` en la URL, o el default computado sobre las opciones de su dataset
   * fuente) que se inyectan en `ctxValues` → aparecen como `:ctx.<id>` en las queries. El valor viaja
   * en la navegación (carryCtx) para que "pegue" al cambiar de página o drillear.
   * MUTA `results` (recupera los datasets-fuente) y `ctxValues` (fija los valores) — secuencial a
   * propósito: un control puede depender del valor del anterior.
   */
  private async resolveHeaderControls(
    spec: MiraSpec,
    ctxValues: CtxValues,
    results: Record<string, DatasetResult>,
    host: BotletHost,
    identity: IdentityContext,
  ): Promise<{ controlsResolved: ControlResolved[]; carryCtx: CtxValues }> {
    const controlsResolved: ControlResolved[] = []
    const carryCtx: CtxValues = {}
    for (const c of spec.controls ?? []) {
      const [dsName, field] = stripCtrlSource(c.source)
      if (!results[dsName]) {
        const ds = spec.data[dsName]
        if (ds) {
          const missing: string[] = []
          const out = await host.capabilityCall(ds.capability, applyCtx(ds.params, ctxValues, missing), identity)
          if (missing.length > 0) host.log({ type: 'mira-ctx-missing', botletId: this.id, dataset: dsName, params: missing })
          results[dsName] = { rows: expectRows(dsName, ds.capability, out) }
          host.log({ type: 'mira-control-source', botletId: this.id, control: c.id, dataset: dsName, rows: results[dsName].rows.length })
        }
      }
      const options = [...new Set((results[dsName]?.rows ?? []).map((r) => String(r[field] ?? '')).filter((v) => v !== ''))]
      if (isMultiControl(c)) {
        // Multi-select: los valores de la URL se filtran contra las opciones; sin ninguno válido,
        // aplica el default (un solo valor, como en single). Se colapsa a string cuando queda uno
        // (los binds y la URL no distinguen un multi de un single de un valor).
        const values = resolveControlValues(ctxValues[c.id], options, c.default)
        if (values.length > 0) {
          const v = values.length === 1 ? values[0] : values
          ctxValues[c.id] = v
          carryCtx[c.id] = v
        }
        controlsResolved.push({ id: c.id, label: c.label ?? c.id, options, value: values.join(', '), values, multi: true })
      } else {
        const value = resolveControlValue(asSingle(ctxValues[c.id]), options, c.default)
        if (value !== '') {
          ctxValues[c.id] = value
          carryCtx[c.id] = value
        }
        controlsResolved.push({ id: c.id, label: c.label ?? c.id, options, value })
      }
    }
    return { controlsResolved, carryCtx }
  }

  /** 4·bis · Banner de staleness según `quality.degradation.on_stale` (o null si el dato está fresco). */
  private staleBanner(spec: MiraSpec, freshness: FreshnessVerdict, host: BotletHost): ResolvedNode | null {
    if (!freshness.checked) return null
    if (!freshness.stale) {
      host.log({ type: 'mira-freshness', botletId: this.id, stale: false, watermark: freshness.watermark?.toISOString().slice(0, 10) })
      return null
    }
    const onStale = String(
      (spec.quality as { degradation?: Record<string, unknown> } | undefined)?.degradation?.['on_stale'] ?? 'warn_and_show',
    )
    const watermarkLabel = freshness.watermark?.toISOString().slice(0, 10) ?? '—'
    // El banner NOMBRA al/los dataset(s) atrasado(s) — con frescura por-dataset el lector sabe QUÉ
    // parte del PI está vieja, no solo que "algo" lo está.
    const who = freshness.staleDatasets?.length ? ` · dataset(s) atrasado(s): ${freshness.staleDatasets.join(', ')}` : ''
    host.log({ type: 'mira-freshness', botletId: this.id, stale: true, onStale, ageMs: freshness.ageMs, watermark: watermarkLabel, staleDatasets: freshness.staleDatasets })
    if (onStale === 'refuse_render') {
      throw new VergisError({
        error: 'mira/quality',
        code: 'stale-refused',
        message: `Datos stale (al ${watermarkLabel}, antigüedad ${freshness.ageHuman}${who}) y política on_stale=refuse_render.`,
        remediation: 'Refrescar los datos de origen o relajar quality.freshness.max_age.',
      })
    }
    if (onStale === 'agentic_fallback') {
      // PROVISIONAL: `agentic_fallback` promete que la Capa 2 (cognición) regenere el dato stale;
      // esa capa aún no está construida. Lanzar error acá mataba el PI por una promesa no
      // implementada — mientras la Capa 2 no exista, se degrada a warn_and_show con log explícito
      // y un banner que lo dice. Cuando la cognición llegue, este branch vuelve a escalar al Botler.
      host.log({ type: 'mira-agentic-fallback-degraded', botletId: this.id, watermark: watermarkLabel })
      return {
        type: 'banner',
        content:
          `⚠ Datos al ${watermarkLabel} — antigüedad ${freshness.ageHuman}, supera el máximo (${freshness.maxAgeRaw})${who}. ` +
          `La regeneración cognitiva (agentic_fallback) aún no está disponible; se muestran los datos con este aviso.`,
      }
    }
    if (onStale === 'show_last_valid') {
      // `show_last_valid` REAL (servir la última salida VÁLIDA en vez de la stale) requiere el
      // data-cache por-consumidor habilitado en la instancia (withResultCache del Botler,
      // VERGIS_DATA_CACHE_TTL_MS > 0), que retiene la última salida por (params, identidad). Mira
      // NO se acopla al wrapper: como el dato es data-anchored, «lo último válido» que el motor
      // devuelve ES el dato al watermark — se muestra con banner explícito de a qué fecha
      // corresponde lo mostrado.
      return {
        type: 'banner',
        content: `⚠ Mostrando datos al ${watermarkLabel} — antigüedad ${freshness.ageHuman}, supera el máximo (${freshness.maxAgeRaw})${who}.`,
      }
    }
    // warn_and_show (default) → banner + continuar
    return {
      type: 'banner',
      content: `⚠ Datos al ${watermarkLabel} — antigüedad ${freshness.ageHuman}, supera el máximo (${freshness.maxAgeRaw})${who}.`,
    }
  }

  /** 5·ter · Ensambla los params del render HTML e invoca la Capability (theme por tipo de PI). */
  private async renderHtml(
    resolved: ResolvedNode,
    spec: MiraSpec,
    freshness: FreshnessVerdict,
    interactive: unknown,
    pagesNav: PagesNav | undefined,
    controlsResolved: ControlResolved[],
    carryCtx: CtxValues,
    themeOverride: string | undefined,
    host: BotletHost,
    identity: IdentityContext,
  ): Promise<string> {
    // Theme/paleta por TIPO de PI (default de plataforma; el theme del spec, si existe, gana).
    const { theme, palette } = resolveTheme(resolved, themeOverride)
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
          version: spec.identity['version'] as string | undefined,
        },
        interactive,
        pages: pagesNav,
        controls: controlsResolved,
        carryCtx,
      },
      identity,
    ))
    return expectString('render-html-piece', 'html', rendered)
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
  /** Dataset de la tabla destino. Si viene, la anotación se aplica a la primera tabla cuyo
   *  `dataset` coincida; sin él, a la primera tabla del árbol (DFS, comportamiento clásico). */
  dataset?: string
  /** Dadas las claves visibles, devuelve {clave → {valor compartido, token de escritura firmado}}. */
  resolve(keys: string[]): Promise<Record<string, { value: string; token: string }>>
}

const ANN_VALUE_FIELD = '__ann'
const ANN_TOKEN_FIELD = '__anntok'

/** Encuentra la tabla destino en el árbol (DFS): la primera cuyo `dataset` coincida, o la primera. */
function findTargetTable(node: ResolvedNode, dataset?: string): ResolvedNode | undefined {
  if (node.type === 'table' && (!dataset || node.dataset === dataset)) return node
  for (const c of node.elements ?? []) {
    const f = findTargetTable(c, dataset)
    if (f) return f
  }
  return undefined
}

/** Fusiona la columna de anotación en la tabla destino (por dataset o la primera), por clave de registro. */
async function applyAnnotations(piece: ResolvedNode, ann: AnnotationContext): Promise<void> {
  const table = findTargetTable(piece, ann.dataset)
  if (!table || !table.columnsSpec || table.columnsSpec.length === 0) return
  // ANTI-ALIASING: `composePiece` copia los ARREGLOS de filas pero no los OBJETOS-fila — mutarlos acá
  // contaminaría con `__ann`/`__anntok` cualquier otro payload que comparta las filas (p.ej.
  // `interactive.datasets`) y, con el data-cache activo, quedaría escrito DENTRO del valor cacheado.
  // Se reemplazan las filas de la tabla destino por copias superficiales antes de mutar.
  const rows = (table.rows ?? []).map((r) => ({ ...r }))
  table.rows = rows
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

/**
 * Resuelve la VISTA ACTIVA de un spec (paso puro, testeable): en multi-vista se elige la página por
 * `pageParam` (default: la 1ª) y se devuelven SOLO sus datasets; en una vista, la pieza + todo `data`.
 * Las páginas-destino de drill (declaran `context`) NO van en la nav por defecto — aparecen "bajo
 * demanda", únicamente cuando son la vista activa. Una vista de detalle alcanzada SIN su contexto
 * (acceso directo, no por drill) devuelve una pieza-guía sin datasets (evita volcar todo).
 */
export function resolveActiveView(
  spec: MiraSpec,
  pageParam: string | undefined,
  ctxValues: CtxValues,
): { activePiece: Record<string, unknown>; pagesNav?: PagesNav; datasetNames: string[]; pageUnknown?: boolean } {
  const isMulti = Array.isArray(spec.pages) && spec.pages.length > 0
  if (!isMulti) {
    return { activePiece: spec.piece as Record<string, unknown>, datasetNames: Object.keys(spec.data) }
  }
  const pages = spec.pages!
  const requested = pageParam != null ? pages.find((p) => p.id === pageParam) : undefined
  const active = requested ?? pages[0]
  // `?page=<id>` con un id que no existe cae en silencio a la 1ª página. Señalamos el fallback para que
  // el caller lo audite (`mira-page-unknown`) en vez de que un enlace roto se vea como navegación normal.
  const pageUnknown = pageParam != null && requested === undefined
  const navPages = pages.filter((p) => !(p.context && p.context.length > 0) || p.id === active.id)
  const pagesNav: PagesNav = { items: navPages.map((p) => ({ id: p.id, title: p.title })), active: active.id }
  const missing = (active.context ?? []).filter((c) => !ctxValues[c])
  if (missing.length > 0) {
    return { activePiece: contextPrompt(active, missing), pagesNav, datasetNames: [], pageUnknown }
  }
  return { activePiece: active.piece, pagesNav, datasetNames: uniqueDatasets(active.piece), pageUnknown }
}

/** ¿El control es multi-select? (`single: false` en el DSL; default single). */
function isMultiControl(c: MiraControl): boolean {
  return c.single === false
}

/** Normaliza el contexto del drill (`params.ctx`) a un mapa campo→valor(es). Un parámetro repetido en
 *  la URL (control multi-select) llega como arreglo; uno solo, como string (back-compat). */
function normalizeCtx(raw: unknown): CtxValues {
  if (!raw || typeof raw !== 'object') return {}
  // Object.create(null): un param `__proto__` multi-valor (arreglo) asignado a un objeto literal
  // corrompería el prototipo del mapa. Sin prototipo, `__proto__` es una clave normal.
  const out = Object.create(null) as CtxValues
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      const list = v.filter((x) => x != null && x !== '').map(String)
      if (list.length === 1) out[k] = list[0]
      else if (list.length > 1) out[k] = list
    } else if (v != null && v !== '') {
      out[k] = String(v)
    }
  }
  return out
}

/** Primer valor de una entrada de contexto (para consumidores single-value). */
function asSingle(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

/** Datasets (sin repetir) que una pieza referencia vía `data.<dataset>...`. */
function uniqueDatasets(piece: Record<string, unknown>): string[] {
  // Une los dos recolectores: referencias `data.<ds>.<campo>` y datasets pelados de agg.dataset /
  // table.data / semaforo.data — así una página cuyo único uso de un dataset es vía `agg.dataset`
  // igual lo recupera (antes salía KPI en 0 / tabla vacía).
  return [...new Set([...collectDataRefs(piece), ...collectDatasetKeys(piece)].map((r) => r.split('.')[0]))]
}

/**
 * Dataset del que cuelga el `watermark_field` de la frescura GLOBAL (`quality.freshness`), o
 * `undefined` si no hay frescura declarada o está en `ignore`. Se recupera siempre para que
 * `checkFreshness` resuelva el watermark aun cuando el dataset viva en otra página (multi-vista).
 */
function watermarkDatasetOf(spec: MiraSpec): string | undefined {
  const f = (spec.quality as { freshness?: Record<string, unknown> } | undefined)?.freshness
  if (!f || f['source_watermark'] === 'ignore') return undefined
  // `resolvePath` acepta el prefijo `data.` en watermark_field — quitarlo acá también, o un spec
  // con `watermark_field: data.<ds>.<campo>` resolvería 'data' como dataset y el fix no aplicaría.
  const raw = String(f['watermark_field'] ?? '')
  const wf = raw.startsWith('data.') ? raw.slice('data.'.length) : raw
  return wf ? wf.split('.')[0] || undefined : undefined
}

/**
 * Valida el contrato de salida de una Capability de datos: `{ rows: [...] }`. Falla ruidoso y
 * accionable en la frontera (en vez de un cast silencioso que revienta críptico aguas abajo).
 */
/**
 * Valida la frontera de salida de una capability de RENDER: exige `{ <field>: string }`. Sin esto, un
 * cast a ciegas (`as { html }`) dejaba `undefined` cuando la capability devolvía otra forma, y el
 * backstop anti-página-en-blanco (que compara contra `''`) no disparaba → HTTP 200 en blanco. Es la
 * simetría con `expectRows` en la frontera de datos.
 */
function expectString(capability: string, field: string, out: unknown): string {
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

function expectRows(dataset: string, capability: string, out: unknown): Record<string, unknown>[] {
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

/**
 * Sustituye `:ctx.<param>` en `params.sql` por PARÁMETRO(S) BIND y adjunta su(s) valor(es) en
 * `params.params` (la Capability los bindea — nunca concatena → injection-safe).
 *  - Valor único → `@ctx_<param>` (comportamiento clásico).
 *  - Valor MÚLTIPLE (control multi-select) → `@ctx_<param>_0, @ctx_<param>_1, …` — CONTRATO: con
 *    multi-valor el placeholder DEBE vivir dentro de paréntesis de IN en el spec
 *    (`WHERE semana IN (:ctx.semana)`); Mira solo expande la lista de binds, jamás interpola valores.
 * Si no hay `:ctx.` o no hay sql, devuelve los params intactos. Un param sin valor en `ctxValues`
 * se bindea como `''` (acota igual) y se reporta en `missing` para que el llamador lo loguee.
 */
function applyCtx(params: Record<string, unknown> | undefined, ctxValues: CtxValues, missing?: string[]): Record<string, unknown> | undefined {
  if (!params || typeof params['sql'] !== 'string') return params
  const sql = params['sql'] as string
  if (!sql.includes(':ctx.')) return params
  const bound: Record<string, string> = {}
  const rewritten = sql.replace(/:ctx\.([a-zA-Z0-9_]+)/g, (_m, param: string) => {
    const v = ctxValues[param]
    if (v === undefined && missing && !missing.includes(param)) missing.push(param)
    if (Array.isArray(v)) {
      return v
        .map((val, i) => {
          bound[`ctx_${param}_${i}`] = val
          return `@ctx_${param}_${i}`
        })
        .join(', ')
    }
    bound[`ctx_${param}`] = v ?? ''
    return `@ctx_${param}`
  })
  return { ...params, sql: rewritten, params: { ...((params['params'] as Record<string, unknown>) ?? {}), ...bound } }
}

/** `data.<dataset>.<field>` (source de un control) → [dataset, field]. */
function stripCtrlSource(source: string): [string, string] {
  const ref = typeof source === 'string' && source.startsWith('data.') ? source.slice('data.'.length) : String(source ?? '')
  const [ds, field] = ref.split('.')
  return [ds ?? '', field ?? '']
}

/** Compara valores de opción: numérico si ambos parsean, si no orden natural (numeric-aware). */
function cmpVals(a: string, b: string): number {
  const an = Number(a)
  const bn = Number(b)
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn
  return a.localeCompare(b, undefined, { numeric: true })
}

/**
 * Valor de un control: si `current` (de la URL) es una opción válida, gana; si no, el default sobre
 * las opciones (`max` = mayor/más reciente, `min` = menor, `first` = primera de aparición). Sin
 * opciones, respeta lo pedido; sin nada, cadena vacía.
 */
export function resolveControlValue(current: string | undefined, options: string[], def?: 'max' | 'min' | 'first'): string {
  if (current != null && current !== '' && (options.length === 0 || options.includes(current))) return current
  if (options.length === 0) return ''
  if (def === 'first') return options[0]
  const sorted = [...options].sort(cmpVals)
  return def === 'min' ? sorted[0] : sorted[sorted.length - 1]
}

/**
 * Valores de un control MULTI-SELECT: los de la URL se filtran contra las opciones (solo valores del
 * catálogo — injection/typo-safe); si no queda ninguno válido, aplica el default (un solo valor,
 * la misma semántica que el control single).
 */
export function resolveControlValues(
  current: string | string[] | undefined,
  options: string[],
  def?: 'max' | 'min' | 'first',
): string[] {
  const asked = (current == null ? [] : Array.isArray(current) ? current : [current]).filter((v) => v !== '')
  const valid = options.length === 0 ? asked : asked.filter((v) => options.includes(v))
  if (valid.length > 0) return [...new Set(valid)]
  const fallback = resolveControlValue(undefined, options, def)
  return fallback === '' ? [] : [fallback]
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
