/**
 * Vocabulario del QC① interiorizado (self-check de Miranda). MISMO vocabulario cerrado del método
 * humano-era (práctica a/04 del lab): veredictos y severidades idénticos, para que el shadow-test de
 * graduación pueda comparar peras con peras.
 */
export type Veredicto = 'APROBADA' | 'APROBABLE' | 'NO_APROBABLE' | 'NO_REVISABLE'

/** Severidad de una brecha: B bloqueante · M mayor · m menor · i informativo. */
export type Severidad = 'B' | 'M' | 'm' | 'i'

export interface Brecha {
  id: string
  sev: Severidad
  brecha: string
  donde: string
  recomendacion: string
}

export interface SelfCheckResult {
  veredicto: Veredicto
  brechas: Brecha[]
}

export const VEREDICTOS: readonly Veredicto[] = ['APROBADA', 'APROBABLE', 'NO_APROBABLE', 'NO_REVISABLE']
export const SEVERIDADES: readonly Severidad[] = ['B', 'M', 'm', 'i']

/** ¿Hay brechas bloqueantes o mayores abiertas? (el gate de publish las rechaza). */
export function hasBlockingGaps(brechas: Brecha[]): boolean {
  return brechas.some((b) => b.sev === 'B' || b.sev === 'M')
}
