/**
 * Resumen de intención — el artefacto que el USUARIO valida (nunca YAML). JSON estructurado, renderizado
 * como ficha legible. Regla de oro: cada campo es verificable por el usuario sin saber del DSL, y cada
 * campo mapea a una parte del draft (el self-check cruza ambos). Formato de `2-plan-fase-1-v1.1.md`.
 */
export interface IntentSummary {
  titulo: string
  pregunta_de_negocio: string
  audiencia: string
  fuentes: { vista: string; rol: string }[]
  grano: string
  medidas: { nombre: string; definicion: string; reconciliacion: string }[]
  dimensiones: string[]
  controles: { nombre: string; tipo: string; default?: string }[]
  reglas: string[]
  estados_o_casos_borde: string[]
  criterios_de_aceptacion: string[]
  fuera_de_alcance: string[]
  pendientes_de_datos: string[]
}

/** Campos obligatorios mínimos de un resumen de intención (los demás pueden ir vacíos en exploración). */
const REQUIRED_KEYS: (keyof IntentSummary)[] = ['titulo', 'pregunta_de_negocio', 'audiencia', 'grano']

/** Valida la forma de un resumen de intención candidato (viene del modelo como JSON). */
export function validateIntentSummary(v: unknown): { ok: true; summary: IntentSummary } | { ok: false; error: string } {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'El resumen de intención debe ser un objeto JSON.' }
  const o = v as Record<string, unknown>
  for (const k of REQUIRED_KEYS) {
    if (typeof o[k] !== 'string' || !(o[k] as string).trim()) return { ok: false, error: `Falta el campo obligatorio '${k}' (texto no vacío).` }
  }
  return { ok: true, summary: normalizeIntent(o) }
}

/** Completa los campos ausentes con vacíos (tolerante: el resumen se refina turno a turno). */
export function normalizeIntent(o: Record<string, unknown>): IntentSummary {
  const arr = (k: string): unknown[] => (Array.isArray(o[k]) ? (o[k] as unknown[]) : [])
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    titulo: str(o['titulo']),
    pregunta_de_negocio: str(o['pregunta_de_negocio']),
    audiencia: str(o['audiencia']),
    fuentes: arr('fuentes').map((f) => ({ vista: str((f as Record<string, unknown>)?.['vista']), rol: str((f as Record<string, unknown>)?.['rol']) })),
    grano: str(o['grano']),
    medidas: arr('medidas').map((m) => ({
      nombre: str((m as Record<string, unknown>)?.['nombre']),
      definicion: str((m as Record<string, unknown>)?.['definicion']),
      reconciliacion: str((m as Record<string, unknown>)?.['reconciliacion']),
    })),
    dimensiones: arr('dimensiones').map(str),
    controles: arr('controles').map((c) => ({
      nombre: str((c as Record<string, unknown>)?.['nombre']),
      tipo: str((c as Record<string, unknown>)?.['tipo']),
      default: (c as Record<string, unknown>)?.['default'] != null ? str((c as Record<string, unknown>)['default']) : undefined,
    })),
    reglas: arr('reglas').map(str),
    estados_o_casos_borde: arr('estados_o_casos_borde').map(str),
    criterios_de_aceptacion: arr('criterios_de_aceptacion').map(str),
    fuera_de_alcance: arr('fuera_de_alcance').map(str),
    pendientes_de_datos: arr('pendientes_de_datos').map(str),
  }
}
