import type { DatasetResult } from './compose'
import { resolvePath } from './compose'
import type { MiraSpec } from './dsl/validate'

export interface FreshnessVerdict {
  checked: boolean
  stale: boolean
  watermark?: Date
  /**
   * El STRING ORIGINAL del watermark (`YYYY-MM-DD` o ISO completo). Preserva el GRANO, que el `Date`
   * pierde: «2026-08-04» y «2026-08-04T00:00:00Z» son el mismo instante pero no el mismo corte —
   * uno es un día, el otro una medianoche. El header lo usa para elegir formato (issue #108 · D2).
   */
  watermarkRaw?: string
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
  /** Duración ISO 8601 del SLA, o `''` si la declaración no trae `max_age`: entonces la marca de agua
   *  DECLARA EL CORTE (as-of del header, #108) y nunca se evalúa atraso (#411). */
  maxAgeRaw: string
  timezone: string
}

/**
 * Evalúa la frescura de los datos contra las declaraciones del spec (doc 2 §5.3):
 *  - GLOBAL: `quality.freshness` con `watermark_field: <dataset>.<campo>` (comportamiento clásico).
 *  - POR-DATASET: `data.<ds>.freshness: { watermark_field: <campo>, max_age?: P#D }` — el
 *    `watermark_field` acá es un CAMPO DEL PROPIO dataset (cadencias distintas por dataset);
 *    `max_age` es opcional (#411).
 * Se evalúa cada declaración cuyo dataset esté RECUPERADO en `results`. Si alguna está atrasada, el
 * veredicto agregado es el MÁS STALE (mayor exceso sobre su SLA) y `staleDatasets` nombra a todos los
 * atrasados; si todas están frescas, el representante es la marca de agua MÁS ANTIGUA.
 * `source_watermark: ignore` (global) apaga solo el check global; los por-dataset son independientes.
 * Sin `max_age` (global o por-dataset) la declaración no tiene SLA: la marca de agua se resuelve y
 * declara el corte, pero el veredicto es siempre fresco y no hay banner (#411).
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
  // Atrasado: gana el MÁS stale, el de mayor exceso sobre su SLA (ageMs − maxAgeMs). Fresco: gana la
  // marca de agua MÁS ANTIGUA (mayor ageMs), que es el corte garantizado que el header declara —
  // la misma regla que el corte por ingesta de #108 («la ingesta más antigua»). Medir el fresco por
  // exceso hacía que una declaración sin SLA (#411, maxAgeMs ausente) dominara siempre: con una global
  // P30D de hace 9 días y una sin SLA de hace 1 h, el header decía «hace 1 h».
  const pool = stale.length > 0 ? stale : verdicts
  const excess = (v: FreshnessVerdict) => (v.ageMs ?? 0) - (v.maxAgeMs ?? 0)
  const worst = stale.length > 0
    ? pool.reduce((a, b) => (excess(a) >= excess(b) ? a : b))
    : pool.reduce((a, b) => ((a.ageMs ?? 0) >= (b.ageMs ?? 0) ? a : b))
  return {
    checked: true,
    stale: stale.length > 0,
    watermark: worst.watermark,
    watermarkRaw: worst.watermarkRaw,
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
    if (path) {
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
    if (!field) continue
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
  // El grano lo trae el DATO: si el valor original era string, ese string es el corte tal cual.
  const watermarkRaw = typeof watermarkValue === 'string' ? watermarkValue : watermark.toISOString()

  // SIN SLA (#411): la marca de agua declara el corte y jamás se evalúa atraso. `maxAgeMs` queda
  // INDEFINIDO, no 0: `parseIsoDuration('')` da 0 y con 0 toda marca de agua saldría atrasada.
  if (!decl.maxAgeRaw) {
    const ageMs = Math.max(0, now - watermark.getTime())
    return { checked: true, stale: false, watermark, watermarkRaw, ageMs, ageHuman: humanizeMs(ageMs) }
  }

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
      watermarkRaw,
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
    watermarkRaw,
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
