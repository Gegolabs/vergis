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

  const maxAgeMs = parseIsoDuration(maxAgeRaw)
  const tz = typeof freshness['timezone'] === 'string' ? (freshness['timezone'] as string) : 'UTC'

  // Watermark de GRANO DIARIO (solo fecha "YYYY-MM-DD"): la antigüedad se mide en DÍAS DE CALENDARIO
  // en la zona de negocio (no en milisegundos UTC). Así un snapshot de HOY = 0 días = fresco —
  // evita el falso positivo de la medianoche UTC + huso horario (doc 2 §5.3).
  if (typeof watermarkValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(watermarkValue)) {
    const today = businessDate(now, tz) // "YYYY-MM-DD" en la zona de negocio
    const ageDays = daysBetween(watermarkValue, today)
    const maxAgeDays = Math.round(maxAgeMs / 86400000)
    return {
      checked: true,
      stale: ageDays > maxAgeDays,
      watermark,
      ageMs: ageDays * 86400000,
      maxAgeMs,
      ageHuman: ageDays <= 0 ? 'hoy' : `${ageDays} día${ageDays > 1 ? 's' : ''}`,
      maxAgeRaw,
    }
  }

  // Watermark con timestamp (tiene hora): comparación por milisegundos.
  const ageMs = now - watermark.getTime()
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

/** Fecha de calendario (YYYY-MM-DD) de un instante en una zona horaria IANA (DST-correcto vía Intl). */
function businessDate(nowMs: number, tz: string): string {
  try {
    return new Date(nowMs).toLocaleDateString('en-CA', { timeZone: tz }) // en-CA → ISO YYYY-MM-DD
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10) // tz inválida → UTC
  }
}

/** Días de calendario entre dos fechas "YYYY-MM-DD" (b − a), neutral a huso (ambas a medianoche UTC). */
function daysBetween(a: string, b: string): number {
  const toUtc = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  return Math.round((toUtc(b) - toUtc(a)) / 86400000)
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
