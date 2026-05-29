import {
  VergisError,
  type Botlet,
  type BotletHost,
  type InvocationContext,
} from '@vergis/botler'
import { composePiece, type DatasetResult, type ResolvedNode } from './compose'
import { parseSpec } from './dsl/parse'
import { validateSpec, type MiraDataset, type MiraSpec } from './dsl/validate'
import { checkFreshness } from './freshness'

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

    // 3 · Recuperación de datos (vía Botler.capability_call, nunca acceso directo)
    const results: Record<string, DatasetResult> = {}
    for (const [name, ds] of Object.entries(spec.data)) {
      host.log({ type: 'mira-retrieve', botletId: this.id, dataset: name, capability: ds.capability })
      const out = (await host.capabilityCall(ds.capability, ds.params, identity)) as { rows?: Record<string, unknown>[] }
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
    const composed = composePiece(spec.piece, results, spec)
    const resolved: ResolvedNode = banner ? { layout: 'rows', elements: [banner, composed] } : composed

    // 5a · Interacción declarada acotada (doc 2 §10): si hay filtro, se materializan
    // los datasets para que la Faceta filtre client-side, sin nuevas queries.
    let interactive: { datasets: Record<string, Record<string, unknown>[]>; filters: NonNullable<NonNullable<MiraSpec['interactions']>['filters']> } | undefined
    const filters = spec.interactions?.filters
    if (filters && filters.length > 0) {
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
      const rendered = (await host.capabilityCall(
        'render-html-piece',
        {
          piece: resolved,
          title: spec.identity.display_name,
          theme: r.theme,
          meta: {
            date: freshness.watermark,
            generatedAt: new Date(),
            org: spec.identity['org'] as string | undefined,
            classification: spec.identity.classification,
            code: spec.identity.code,
          },
          interactive,
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
