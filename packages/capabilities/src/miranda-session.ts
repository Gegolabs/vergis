/**
 * Máquina de estados de una sesión de Miranda — el agente conversacional que autora specs (cluster
 * 077 del lab). PURA (sin IO): el store la usa para rechazar transiciones ilegales, y el loop del
 * agente la consulta. Vive en @vergis/capabilities porque el governance-store (que persiste las
 * sesiones) no puede depender de @vergis/miranda (la dependencia va al revés).
 *
 * Ciclo: explorando → borrador → validado → autochequeado → publicado (+ descartado desde cualquiera).
 *   · `validado`      = el usuario aprobó el resumen de intención vigente. Si el resumen cambia, la
 *                        sesión regresa a `borrador` (el store invalida `validado`).
 *   · `autochequeado` = el self-check (QC①) corrió sin brechas B/M abiertas.
 *   · Solo desde `autochequeado` se publica. `publicado`/`descartado` son terminales.
 */

export type MirandaSessionState = 'explorando' | 'borrador' | 'validado' | 'autochequeado' | 'publicado' | 'descartado'

export type MirandaMessageRole = 'user' | 'assistant' | 'tool'

export type MirandaArtifactKind = 'intent_summary' | 'spec_draft' | 'qc_report' | 'data_request' | 'handoff'

export const MIRANDA_STATES: readonly MirandaSessionState[] = [
  'explorando',
  'borrador',
  'validado',
  'autochequeado',
  'publicado',
  'descartado',
] as const

/** Transiciones legales por estado (self-loops incluidos: re-draftear, re-validar, re-chequear). */
const TRANSITIONS: Record<MirandaSessionState, readonly MirandaSessionState[]> = {
  explorando: ['explorando', 'borrador', 'descartado'],
  borrador: ['borrador', 'validado', 'explorando', 'descartado'],
  validado: ['validado', 'borrador', 'autochequeado', 'explorando', 'descartado'],
  autochequeado: ['autochequeado', 'validado', 'borrador', 'publicado', 'descartado'],
  publicado: [],
  descartado: [],
}

export function isMirandaState(s: string): s is MirandaSessionState {
  return (MIRANDA_STATES as readonly string[]).includes(s)
}

/** ¿La transición `from → to` es legal? */
export function canTransition(from: MirandaSessionState, to: MirandaSessionState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}
