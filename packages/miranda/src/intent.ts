/**
 * Resumen de intención — el artefacto que el USUARIO valida (nunca YAML). JSON estructurado, renderizado
 * como ficha legible. Regla de oro: cada campo es verificable por el usuario sin saber del DSL, y cada
 * campo mapea a una parte del draft (el self-check cruza ambos). Formato de `2-plan-fase-1-v1.1.md`.
 */
/** Forma visual de una vista del PI: la clase de ambigüedad texto-vs-imagen (hallazgo PI-17/F-01) que
 *  debe ser VALIDABLE por el usuario. `tabla` = solo una tabla · `dashboard` = tarjetas y/o gráficos ·
 *  `mixta` = tabla + tarjetas/gráficos. */
export type Forma = 'tabla' | 'dashboard' | 'mixta'

/** Pieza visual de una vista (vocabulario del usuario, mapea a elementos del DSL). */
export type Pieza = 'tarjetas' | 'graficos' | 'tabla'

export const FORMAS: readonly Forma[] = ['tabla', 'dashboard', 'mixta']
export const PIEZAS: readonly Pieza[] = ['tarjetas', 'graficos', 'tabla']

/** Declaración de forma de UNA vista del PI (el usuario valida su intención visual sin ver el DSL). */
export interface FormaVista {
  /** Nombre legible de la vista (una sola vista = el título; multi-vista = nombre de cada página). */
  nombre: string
  /** La forma visual declarada. */
  forma: Forma
  /** Las piezas que la componen: tarjetas (KPI/dato), gráficos (chart/series/distribution), tabla. */
  piezas: Pieza[]
}

export interface IntentSummary {
  titulo: string
  pregunta_de_negocio: string
  audiencia: string
  fuentes: { vista: string; rol: string }[]
  grano: string
  medidas: { nombre: string; definicion: string; reconciliacion: string }[]
  dimensiones: string[]
  controles: { nombre: string; tipo: string; default?: string }[]
  /** Forma visual por vista — hace validable la intención dashboard-vs-tabla (guard anti-F-01). */
  vistas: FormaVista[]
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
    vistas: arr('vistas').map((v) => normalizeFormaVista(v as Record<string, unknown>)),
    reglas: arr('reglas').map(str),
    estados_o_casos_borde: arr('estados_o_casos_borde').map(str),
    criterios_de_aceptacion: arr('criterios_de_aceptacion').map(str),
    fuera_de_alcance: arr('fuera_de_alcance').map(str),
    pendientes_de_datos: arr('pendientes_de_datos').map(str),
  }
}

/** Normaliza una declaración de forma de vista (tolerante: forma fuera de vocabulario → 'dashboard'
 *  por defecto; piezas se filtran al vocabulario cerrado y se deduplican). */
export function normalizeFormaVista(o: Record<string, unknown>): FormaVista {
  const forma = (FORMAS as readonly string[]).includes(String(o?.['forma'])) ? (o['forma'] as Forma) : 'dashboard'
  const rawPiezas = Array.isArray(o?.['piezas']) ? (o['piezas'] as unknown[]) : []
  const piezas = [...new Set(rawPiezas.map((p) => String(p)).filter((p): p is Pieza => (PIEZAS as readonly string[]).includes(p)))]
  return {
    nombre: typeof o?.['nombre'] === 'string' ? (o['nombre'] as string) : '',
    forma,
    piezas,
  }
}
