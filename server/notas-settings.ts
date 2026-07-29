/**
 * Settings de plataforma de la CAPA DE NOTAS (A7) y la purga por retención.
 *
 * La decisión de fondo: retención y límites son CONFIGURABLES, no constantes horneadas. Impresiones
 * × usuarios × semanas crece sin techo, y el techo correcto depende de la instancia — no del código.
 *
 * En esta versión se APLICA la retención (purga al arranque y cada 24 h). El límite de schedules y
 * el anti-cementerio quedan declarados y editables, y se hacen cumplir cuando el schedule exista: se
 * declaran ahora para que el día que se enciendan no haya que migrar la configuración de nadie.
 */
import { durationToSeconds, type NotasStore, type PlatformSettingStore } from '@vergis/capabilities'

/** Clave → default. Un default en CÓDIGO (no una fila sembrada): la instancia solo guarda lo que cambia. */
export const NOTAS_SETTINGS = {
  /** Cuánto vive una impresión desde su última actividad (duración ISO-8601). */
  retencionImpresiones: { key: 'notas_retencion_impresiones', def: 'P12M' },
  /** Cuántos envíos programados puede tener una persona. Declarado; se aplica con los schedules. */
  maxSchedulesUsuario: { key: 'notas_max_schedules_usuario', def: '10' },
  /** Anti-cementerio: un envío que nadie abre se desactiva solo. Declarado; se aplica con los schedules. */
  antiCementerio: { key: 'notas_anti_cementerio', def: 'on' },
} as const

/** Cada 24 h: la cadencia de la purga. La retención se mide en meses; barrer más seguido no aporta. */
export const PURGA_INTERVALO_MS = 24 * 60 * 60 * 1000

export class SettingInvalido extends Error {}

/**
 * Valida una retención con el MISMO parser que la consume (`durationToSeconds`), no con un regex
 * propio: un regex acepta `PT` (que después revienta) y rechaza `P1W1D`. Devuelve los segundos.
 */
export function validarRetencion(raw: string): number {
  const v = (raw ?? '').trim().toUpperCase()
  let segundos: number
  try {
    segundos = durationToSeconds(v)
  } catch {
    throw new SettingInvalido(`Retención inválida: '${raw}' (usa una duración ISO-8601, p.ej. P6M, P12M, P2Y).`)
  }
  if (!(segundos > 0)) throw new SettingInvalido(`Retención inválida: '${raw}' debe ser mayor a cero.`)
  return segundos
}

/** Valida el límite de envíos programados por usuario (entero positivo). */
export function validarMaxSchedules(raw: string): number {
  const n = Number((raw ?? '').trim())
  if (!Number.isInteger(n) || n <= 0) throw new SettingInvalido(`Límite inválido: '${raw}' debe ser un entero mayor a cero.`)
  return n
}

/** `on` / `off`. */
export function validarAntiCementerio(raw: string): 'on' | 'off' {
  const v = (raw ?? '').trim().toLowerCase()
  if (v !== 'on' && v !== 'off') throw new SettingInvalido(`Valor inválido: '${raw}' (usa on u off).`)
  return v
}

/** Lee los tres settings vigentes, cayendo a los defaults de código. */
export async function leerNotasSettings(
  store: PlatformSettingStore,
): Promise<{ retencion: string; maxSchedules: string; antiCementerio: string }> {
  const [r, m, a] = await Promise.all([
    store.getSetting(NOTAS_SETTINGS.retencionImpresiones.key),
    store.getSetting(NOTAS_SETTINGS.maxSchedulesUsuario.key),
    store.getSetting(NOTAS_SETTINGS.antiCementerio.key),
  ])
  return {
    retencion: r || NOTAS_SETTINGS.retencionImpresiones.def,
    maxSchedules: m || NOTAS_SETTINGS.maxSchedulesUsuario.def,
    antiCementerio: a || NOTAS_SETTINGS.antiCementerio.def,
  }
}

/** Fecha de corte de la purga: `ahora - retención`. */
export function corteDeRetencion(retencion: string, ahora = Date.now()): string {
  return new Date(ahora - validarRetencion(retencion) * 1000).toISOString()
}

/**
 * Purga las impresiones cuya última actividad quedó fuera de la retención (cascada: sus notas y
 * comparticiones). Devuelve los ids purgados — se loguean: borrar en silencio es como no borrar.
 */
export async function purgarRetencion(
  notas: NotasStore,
  settings: PlatformSettingStore,
  ahora = Date.now(),
): Promise<{ corte: string; purgados: string[] }> {
  const { retencion } = await leerNotasSettings(settings)
  const corte = corteDeRetencion(retencion, ahora)
  const purgados = await notas.purgarPorRetencion(corte)
  return { corte, purgados }
}
