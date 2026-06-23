/**
 * Frescura — la matemática de OFERTA y DEMANDA (frente B). Dos conceptos DISTINTOS, a propósito:
 *  · OFERTA  = cada cuánto se actualiza una FUENTE (la declara quien la conecta).
 *  · DEMANDA = cada cuánto el NEGOCIO necesita el dato fresco en un PI (max_age, editable por
 *              colaboradores).
 *
 * Ambos se expresan como duración ISO-8601 (PT1H, P1D, P1W…). Reglas:
 *  · TECHO de la demanda: un PI no puede exigir más fresco que su fuente MÁS LENTA → la demanda
 *    (en segundos de max_age) debe ser ≥ la oferta más lenta de sus insumos. El ejemplo "demanda
 *    horaria, oferta diaria" es justo lo que el techo impide: el máximo exigible es diario.
 *  · CADENCIA REQUERIDA de un proceso de ingestión = el PI más exigente que depende de sus tablas
 *    marca el paso (mín de las demandas), con PISO en la oferta (no se corre más seguido que la
 *    fuente se actualiza): requerida = max( mín(demandas), oferta ).
 */

const UNIT_SECONDS: Record<string, number> = { Y: 365 * 86400, W: 7 * 86400, D: 86400, H: 3600, S: 1 }
// 'M' es ambiguo (mes en fecha, minuto en tiempo) → se resuelve por posición (antes/después de 'T').

/** Parsea una duración ISO-8601 a segundos (aprox: Y=365d, mes=30d). Lanza si es inválida. */
export function durationToSeconds(iso: string): number {
  const s = (iso ?? '').trim().toUpperCase()
  const m = s.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m || s === 'P' || s === 'PT') throw new Error(`Duración ISO-8601 inválida: '${iso}'.`)
  const [, y, mo, w, d, h, mi, sec] = m.map((x) => (x ? Number(x) : 0)) as unknown as number[]
  return (
    y * UNIT_SECONDS.Y +
    mo * 30 * 86400 +
    w * UNIT_SECONDS.W +
    d * UNIT_SECONDS.D +
    h * UNIT_SECONDS.H +
    mi * 60 +
    sec * UNIT_SECONDS.S
  )
}

/** Representación legible aproximada de una cantidad de segundos como duración (para mostrar). */
export function secondsToDuration(total: number): string {
  if (total <= 0) return 'PT0S'
  const w = Math.floor(total / UNIT_SECONDS.W)
  if (w >= 1 && total % UNIT_SECONDS.W === 0) return `P${w}W`
  const d = Math.floor(total / UNIT_SECONDS.D)
  if (d >= 1 && total % UNIT_SECONDS.D === 0) return `P${d}D`
  const h = Math.floor(total / UNIT_SECONDS.H)
  if (h >= 1 && total % UNIT_SECONDS.H === 0) return `PT${h}H`
  const mi = Math.floor(total / 60)
  if (mi >= 1 && total % 60 === 0) return `PT${mi}M`
  return `PT${total}S`
}

/** Techo de la demanda (en segundos de max_age) = la oferta MÁS LENTA de los insumos. 0 si no hay insumos. */
export function demandaCeilingSeconds(ofertaDurations: string[]): number {
  return ofertaDurations.reduce((mx, o) => Math.max(mx, durationToSeconds(o)), 0)
}

/** ¿La demanda respeta el techo? (su max_age ≥ la oferta más lenta). Sin insumos conocidos → permitida. */
export function isDemandaWithinCeiling(demanda: string, ofertaDurations: string[]): boolean {
  if (ofertaDurations.length === 0) return true
  return durationToSeconds(demanda) >= demandaCeilingSeconds(ofertaDurations)
}

/**
 * Cadencia requerida de un proceso = el PI más exigente marca el paso (mín de demandas), con piso en
 * la oferta de la fuente. Devuelve segundos. Sin demandas → no hay exigencia (devuelve la oferta).
 */
export function requiredCadenceSeconds(demandaDurations: string[], ofertaDuration: string): number {
  const oferta = durationToSeconds(ofertaDuration)
  if (demandaDurations.length === 0) return oferta
  const tightest = demandaDurations.reduce((mn, d) => Math.min(mn, durationToSeconds(d)), Infinity)
  return Math.max(tightest, oferta)
}

// ─── Derivación del MAPA de ingestión (B2 de César) ──────────────────────────
export interface SourceInfo {
  id: string
  oferta: string
}
export interface ProcessInfo {
  id: string
  label: string
  sourceId: string
}
export interface IngestionMapRow {
  processId: string
  label: string
  /** Oferta de la fuente que ingesta (duración ISO). */
  oferta: string
  /** Cadencia que el proceso DEBE correr para satisfacer a sus PIs (derivada). */
  requiredCadence: string
  requiredCadenceSeconds: number
  /** PIs que dependen de las tablas que produce el proceso. */
  dependentPis: string[]
  /** true si algún PI dependiente exige más fresco que la oferta (demanda bajo el piso) → insatisfacible. */
  unsatisfiable: boolean
}

export interface DeriveMapInput {
  sources: SourceInfo[]
  processes: ProcessInfo[]
  /** proceso → tablas que produce. */
  processOutputs: { processId: string; tableRef: string }[]
  /** PI → tablas que lee (derivado del spec). */
  piTables: { piCode: string; tables: string[] }[]
  /** PI → demanda (max_age ISO). PIs sin demanda no exigen nada. */
  piDemandas: { piCode: string; maxAge: string }[]
}

/**
 * Deriva, por proceso de ingestión, la cadencia requerida = el PI más exigente que depende de sus
 * tablas marca el paso, con piso en la oferta de su fuente. PURA (sin store), para test y para el mapa
 * del área de gestión.
 */
export function deriveIngestionMap(input: DeriveMapInput): IngestionMapRow[] {
  const ofertaOf = new Map(input.sources.map((s) => [s.id, s.oferta]))
  const demandaOf = new Map(input.piDemandas.map((d) => [d.piCode, d.maxAge]))
  const outputsOf = new Map<string, Set<string>>()
  for (const po of input.processOutputs) {
    if (!outputsOf.has(po.processId)) outputsOf.set(po.processId, new Set())
    outputsOf.get(po.processId)!.add(po.tableRef)
  }
  return input.processes.map((proc) => {
    const oferta = ofertaOf.get(proc.sourceId) ?? 'P1Y' // sin oferta declarada → muy lenta (no fuerza nada)
    const outs = outputsOf.get(proc.id) ?? new Set<string>()
    const dependentPis = input.piTables.filter((pt) => pt.tables.some((t) => outs.has(t))).map((pt) => pt.piCode)
    const demandas = dependentPis.map((pi) => demandaOf.get(pi)).filter((d): d is string => !!d)
    const reqSec = requiredCadenceSeconds(demandas, oferta)
    const ofertaSec = durationToSeconds(oferta)
    const unsatisfiable = demandas.some((d) => durationToSeconds(d) < ofertaSec)
    return {
      processId: proc.id,
      label: proc.label,
      oferta,
      requiredCadence: secondsToDuration(reqSec),
      requiredCadenceSeconds: reqSec,
      dependentPis,
      unsatisfiable,
    }
  })
}
