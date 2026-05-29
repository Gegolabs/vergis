import type { DatasetResult } from './compose'
import { resolvePath } from './compose'
import type { MiraSpec } from './dsl/validate'

export interface FreshnessVerdict {
  checked: boolean
  stale: boolean
  watermark?: Date
  ageMs?: number
  maxAgeMs?: number
  ageHuman?: string
  maxAgeRaw?: string
}

/**
 * Evalúa la frescura de los datos contra quality.freshness (doc 2 §5.3).
 * source_watermark: ignore → no se chequea. required/optional → compara el
 * watermark_field contra max_age (ISO 8601 duration).
 */
export function checkFreshness(
  spec: MiraSpec,
  results: Record<string, DatasetResult>,
  now: number,
): FreshnessVerdict {
  const freshness = (spec.quality as { freshness?: Record<string, unknown> } | undefined)?.freshness
  if (!freshness || freshness['source_watermark'] === 'ignore') return { checked: false, stale: false }

  const maxAgeRaw = String(freshness['max_age'] ?? '')
  const watermarkField = String(freshness['watermark_field'] ?? '')
  if (!maxAgeRaw || !watermarkField) return { checked: false, stale: false }

  const watermarkValue = resolvePath(watermarkField, results, spec)
  const watermark = toDate(watermarkValue)
  if (!watermark) return { checked: true, stale: false }

  const ageMs = now - watermark.getTime()
  const maxAgeMs = parseIsoDuration(maxAgeRaw)
  return {
    checked: true,
    stale: ageMs > maxAgeMs,
    watermark,
    ageMs,
    maxAgeMs,
    ageHuman: humanizeMs(ageMs),
    maxAgeRaw,
  }
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/** Parser mínimo de ISO 8601 duration (P#DT#H#M#S). Suficiente para PT0S, PT15M, PT1H, P1D. */
export function parseIsoDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso)
  if (!m) return 0
  const [, d, h, min, s] = m
  return (
    (Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000
  )
}

function humanizeMs(ms: number): string {
  const days = Math.floor(ms / 86400000)
  if (days >= 1) return `${days} día${days > 1 ? 's' : ''}`
  const hours = Math.floor(ms / 3600000)
  if (hours >= 1) return `${hours} h`
  const mins = Math.floor(ms / 60000)
  return `${mins} min`
}
