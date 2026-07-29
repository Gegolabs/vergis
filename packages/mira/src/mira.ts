import {
  VergisError,
  type Botlet,
  type BotletHost,
  type IdentityContext,
  type InvocationContext,
} from '@vergis/botler'
import { composePiece, type DatasetResult, type ResolvedNode } from './compose'
import { expectString, expectRows } from './contract'
import type { CtxValues, PagesNav, ControlResolved } from './mira-types'
import { applyCtx, stripCtrlSource, resolveControlValue, resolveControlValues, buildControlOptions, labelForValue } from './controls'
import { resolveActiveView, normalizeCtx, watermarkDatasetOf, isMultiControl, asSingle } from './views'
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
  /** El ÁRBOL RESUELTO que produjo el HTML — lo que una impresión congela (vergis#84 · D1). Mira lo
   *  expone; congelarlo o ignorarlo es decisión del llamador (cambio aditivo). */
  resolved?: ResolvedNode
  /** Veredicto de frescura de esta corrida: el `watermark` es la procedencia del dato congelado. */
  freshness?: { watermark?: string; stale?: boolean }
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
    // server-side: se cubre con el print-to-PDF del navegador (acción de la bandeja).
    const artifacts: MiraOutput['artifacts'] = []
    const renders = spec.delivery?.render ?? [{ format: 'html', target: 'web' }]
    let html = ''
    for (const r of renders) {
      if (r.format === 'csv') {
        const rendered = await host.capabilityCall(
          'render-csv-piece',
          { piece: resolved, title: spec.identity.display_name, bom: r.bom },
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

    return {
      id: this.id,
      html,
      artifacts,
      resolved,
      freshness: { watermark: freshness.watermark?.toISOString(), stale: freshness.stale },
    }
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
    // Params ya "poseídos": el PRIMER control que declara un `param` es su DUEÑO (aplica su default);
    // los siguientes con el mismo `param` (llaves alternativas) solo renderizan el valor vigente.
    const paramOwned = new Set<string>()
    for (const c of spec.controls ?? []) {
      const [dsName, field] = stripCtrlSource(c.source)
      // `param` (default = id): a qué `ctx.<param>` escribe. `display` (default = campo de source): qué
      // campo del MISMO dataset se muestra como etiqueta. Separar ambos roles habilita llaves alternativas.
      const param = c.param ?? c.id
      const displayField = c.display ?? field
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
      // Opciones como pares {value,label}: value del campo de source, label del campo de display.
      const options = buildControlOptions(results[dsName]?.rows ?? [], field, displayField)
      const optionValues = options.map((o) => o.value)
      const isOwner = !paramOwned.has(param)
      paramOwned.add(param)
      // El valor vigente es el de `ctx.<param>` (compartido por todas las llaves alternativas); el
      // default lo aplica SOLO el dueño (los demás heredan el valor que el dueño ya fijó).
      const def = isOwner ? c.default : undefined
      if (isMultiControl(c)) {
        // Multi-select: los valores de la URL se filtran contra las opciones; sin ninguno válido,
        // aplica el default (un solo valor, como en single). Se colapsa a string cuando queda uno
        // (los binds y la URL no distinguen un multi de un single de un valor).
        const values = resolveControlValues(ctxValues[param], optionValues, def)
        if (values.length > 0) {
          const v = values.length === 1 ? values[0] : values
          ctxValues[param] = v
          carryCtx[param] = v
        }
        const displayLabel = values.map((v) => labelForValue(options, v)).join(', ')
        controlsResolved.push({ id: c.id, param, label: c.label ?? c.id, options, value: values.join(', '), values, multi: true, displayLabel })
      } else {
        const value = resolveControlValue(asSingle(ctxValues[param]), optionValues, def)
        if (value !== '') {
          ctxValues[param] = value
          carryCtx[param] = value
        }
        controlsResolved.push({ id: c.id, param, label: c.label ?? c.id, options, value, displayLabel: labelForValue(options, value) })
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

