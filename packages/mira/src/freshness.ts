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
  /** Datasets atrasados (nombra al/los responsables del veredicto stale, para el banner). */
  staleDatasets?: string[]
}

/** Una declaración de frescura ya normalizada (la global de quality.freshness o la de un dataset). */
interface FreshnessDecl {
  /** Dataset del que cuelga el watermark (para nombrarlo en el banner). */
  dataset: string
  /** Ruta `dataset.campo` resoluble contra `results`. */
  watermarkPath: string
  maxAgeRaw: string
  timezone: string
}

/**
 * Evalúa la frescura de los datos contra las declaraciones del spec (doc 2 §5.3):
 *  - GLOBAL: `quality.freshness` con `watermark_field: <dataset>.<campo>` (comportamiento clásico).
 *  - POR-DATASET: `data.<ds>.freshness: { watermark_field: <campo>, max_age: P#D }` — el
 *    `watermark_field` acá es un CAMPO DEL PROPIO dataset (cadencias distintas por dataset).
 * Se evalúa cada declaración cuyo dataset esté RECUPERADO en `results`; el veredicto agregado es el
 * MÁS STALE (la mayor antigüedad relativa gana) y `staleDatasets` nombra a todos los atrasados.
 * `source_watermark: ignore` (global) apaga solo el check global; los por-dataset son independientes.
 */
export function checkFreshness(
  spec: MiraSpec,
  results: Record<string, DatasetResult>,
  now: number,
): FreshnessVerdict {
  const decls = collectFreshnessDecls(spec)
  const verdicts: (FreshnessVerdict & { dataset: string })[] = []
  for (const d of decls) {
    if (!(d.dataset in results)) continue // en multi-vista solo se evalúa lo recuperado
    const v = checkOne(d, results, spec, now)
    if (v.checked) verdicts.push({ ...v, dataset: d.dataset })
  }
  if (verdicts.length === 0) return { checked: false, stale: false }

  const stale = verdicts.filter((v) => v.stale)
  // El MÁS stale gana: mayor exceso relativo (ageMs − maxAgeMs). Fresco: el de mayor antigüedad
  // (conserva el watermark representativo que el render usa como fecha del dato).
  const pool = stale.length > 0 ? stale : verdicts
  const worst = pool.reduce((a, b) => ((a.ageMs ?? 0) - (a.maxAgeMs ?? 0) >= (b.ageMs ?? 0) - (b.maxAgeMs ?? 0) ? a : b))
  return {
    checked: true,
    stale: stale.length > 0,
    watermark: worst.watermark,
    ageMs: worst.ageMs,
    maxAgeMs: worst.maxAgeMs,
    ageHuman: worst.ageHuman,
    maxAgeRaw: worst.maxAgeRaw,
    staleDatasets: stale.length > 0 ? stale.map((v) => v.dataset) : undefined,
  }
}

/** Normaliza las declaraciones de frescura del spec (global + por-dataset) a una lista evaluable. */
function collectFreshnessDecls(spec: MiraSpec): FreshnessDecl[] {
  const out: FreshnessDecl[] = []
  const global = (spec.quality as { freshness?: Record<string, unknown> } | undefined)?.freshness
  if (global && global['source_watermark'] !== 'ignore') {
    const maxAgeRaw = String(global['max_age'] ?? '')
    const raw = String(global['watermark_field'] ?? '')
    const path = raw.startsWith('data.') ? raw.slice('data.'.length) : raw
    if (maxAgeRaw && path) {
      out.push({
        dataset: path.split('.')[0] ?? '',
        watermarkPath: path,
        maxAgeRaw,
        timezone: typeof global['timezone'] === 'string' ? (global['timezone'] as string) : 'UTC',
      })
    }
  }
  for (const [name, ds] of Object.entries(spec.data ?? {})) {
    const f = (ds as { freshness?: Record<string, unknown> }).freshness
    if (!f) continue
    const maxAgeRaw = String(f['max_age'] ?? '')
    const field = String(f['watermark_field'] ?? '') // un CAMPO del propio dataset
    if (!maxAgeRaw || !field) continue
    out.push({
      dataset: name,
      watermarkPath: `${name}.${field}`,
      maxAgeRaw,
      timezone: typeof f['timezone'] === 'string' ? (f['timezone'] as string) : 'UTC',
    })
  }
  return out
}

/** Evalúa UNA declaración de frescura contra los resultados. */
function checkOne(
  decl: FreshnessDecl,
  results: Record<string, DatasetResult>,
  spec: MiraSpec,
  now: number,
): FreshnessVerdict {
  // Datasets multi-fila: `resolvePath` devuelve la COLUMNA (arreglo) — antes `toDate(arreglo)` daba
  // null → «fresco» en silencio. El watermark de un dataset multi-fila es el MÁXIMO de la columna
  // (high-water mark: el registro más reciente marca la frescura del dataset).
  const watermarkValue = maxWatermark(resolvePath(decl.watermarkPath, results, spec))
  const watermark = toDate(watermarkValue)
  if (!watermark) return { checked: true, stale: false }

  const maxAgeMs = parseIsoDuration(decl.maxAgeRaw)

  // Watermark de GRANO DIARIO (solo fecha "YYYY-MM-DD"): la antigüedad se mide en DÍAS DE CALENDARIO
  // en la zona de negocio (no en milisegundos UTC). Así un snapshot de HOY = 0 días = fresco —
  // evita el falso positivo de la medianoche UTC + huso horario (doc 2 §5.3).
  if (typeof watermarkValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(watermarkValue)) {
    const today = businessDate(now, decl.timezone) // "YYYY-MM-DD" en la zona de negocio
    const ageDays = daysBetween(watermarkValue, today)
    const maxAgeDays = Math.round(maxAgeMs / 86400000)
    return {
      checked: true,
      stale: ageDays > maxAgeDays,
      watermark,
      ageMs: ageDays * 86400000,
      maxAgeMs,
      ageHuman: ageDays <= 0 ? 'hoy' : `${ageDays} día${ageDays > 1 ? 's' : ''}`,
      maxAgeRaw: decl.maxAgeRaw,
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
    maxAgeRaw: decl.maxAgeRaw,
  }
}

/** Escalar del watermark: si la ruta resolvió una COLUMNA (dataset multi-fila), el máximo por fecha. */
function maxWatermark(v: unknown): unknown {
  if (!Array.isArray(v)) return v
  let best: unknown
  let bestMs = -Infinity
  for (const item of v) {
    const d = toDate(item)
    if (d && d.getTime() > bestMs) {
      bestMs = d.getTime()
      best = item
    }
  }
  return best
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
