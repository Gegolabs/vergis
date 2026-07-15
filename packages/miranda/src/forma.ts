/**
 * Cruce de FORMA por vista — el guard anti-F-01 (hallazgo PI-17, 2026-07-14): la intención VISUAL del
 * usuario (dashboard vs tabla) es un campo validable del resumen de intención (`vistas[].forma`), y aquí
 * se contrasta contra las PIEZAS reales del draft DSL. Una vista cuya forma/piezas declaradas no calzan
 * con lo que el draft dibuja = brecha M (misma severidad que un filtro literal roto). Es enforcement en
 * CÓDIGO (no solo prompt): las brechas que devuelve se funden en el reporte del self-check y el gate de
 * publish las honra.
 */
import YAML from 'yaml'
import { FORMAS, PIEZAS, type Forma, type Pieza, type FormaVista } from './intent'
import type { Brecha } from './qc'

/** Mapa elemento-DSL → pieza del usuario. Los tipos sin superficie visual (markdown) no cuentan. */
const ELEMENT_TO_PIEZA: Record<string, Pieza> = {
  kpi: 'tarjetas',
  dato: 'tarjetas',
  chart: 'graficos',
  series: 'graficos',
  distribution: 'graficos',
  table: 'tabla',
}

/** Vista derivada del draft: su nombre y el conjunto de piezas visuales que realmente contiene. */
export interface DraftView {
  nombre: string
  piezas: Pieza[]
  /** Forma inferida de las piezas (null si la vista no tiene piezas visuales — p.ej. solo markdown). */
  forma: Forma | null
}

/** Infere la forma a partir del conjunto de piezas presentes. */
export function formaFromPiezas(piezas: Pieza[]): Forma | null {
  const set = new Set(piezas)
  const hasTabla = set.has('tabla')
  const hasOtra = set.has('tarjetas') || set.has('graficos')
  if (hasTabla && hasOtra) return 'mixta'
  if (hasTabla) return 'tabla'
  if (hasOtra) return 'dashboard'
  return null
}

/** Extrae las piezas visuales de un objeto `piece` del DSL (layout + elements[]). */
function piezasOfPiece(piece: unknown): Pieza[] {
  const elements = (piece as { elements?: unknown })?.elements
  if (!Array.isArray(elements)) return []
  const found = new Set<Pieza>()
  for (const el of elements) {
    if (el == null || typeof el !== 'object') continue
    for (const key of Object.keys(el as Record<string, unknown>)) {
      const p = ELEMENT_TO_PIEZA[key]
      if (p) found.add(p)
    }
  }
  // Orden estable según el vocabulario canónico.
  return PIEZAS.filter((p) => found.has(p))
}

/**
 * Deriva las vistas visuales del draft: una sola vista (`piece`) o multi-vista (`pages`). Un YAML ilegible
 * o sin vista devuelve `[]` (no hay nada que cruzar; el self-check textual/reconciliación se ocupa aparte).
 */
export function derivePiecesFromDraft(draftYaml: string): DraftView[] {
  let spec: Record<string, unknown>
  try {
    spec = (YAML.parse(draftYaml) ?? {}) as Record<string, unknown>
  } catch {
    return []
  }
  const identity = (spec['identity'] ?? {}) as Record<string, unknown>
  const fallbackName = typeof identity['display_name'] === 'string' ? (identity['display_name'] as string) : 'Vista'
  if (Array.isArray(spec['pages']) && (spec['pages'] as unknown[]).length > 0) {
    return (spec['pages'] as unknown[]).map((pg, i) => {
      const p = (pg ?? {}) as Record<string, unknown>
      const nombre = typeof p['title'] === 'string' ? (p['title'] as string) : typeof p['id'] === 'string' ? (p['id'] as string) : `Vista ${i + 1}`
      const piezas = piezasOfPiece(p['piece'])
      return { nombre, piezas, forma: formaFromPiezas(piezas) }
    })
  }
  if (spec['piece'] != null) {
    const piezas = piezasOfPiece(spec['piece'])
    return [{ nombre: fallbackName, piezas, forma: formaFromPiezas(piezas) }]
  }
  return []
}

const sameSet = (a: Pieza[], b: Pieza[]): boolean => {
  const A = new Set(a)
  const B = new Set(b)
  return A.size === B.size && [...A].every((x) => B.has(x))
}

/**
 * Cruza la forma declarada (resumen de intención) contra la forma real del draft. Devuelve brechas M:
 *  - si el draft tiene piezas visuales pero el resumen no declara `vistas` → la intención visual no es
 *    validable (la ambigüedad F-01 atravesaría el gate);
 *  - por vista: si la forma o el conjunto de piezas declarados no calzan con el draft.
 * IDs estables `FORMA-N` (entre rondas). Si el draft no tiene vistas visuales, no hay nada que cruzar.
 */
export function crossCheckForma(declared: FormaVista[] | undefined, draftYaml: string): Brecha[] {
  const draftViews = derivePiecesFromDraft(draftYaml)
  const visualViews = draftViews.filter((v) => v.forma !== null)
  if (visualViews.length === 0) return []

  const dec = declared ?? []
  if (dec.length === 0) {
    return [
      {
        id: 'FORMA-1',
        sev: 'M',
        brecha:
          'La intención visual (forma por vista) no está declarada en el resumen: no se puede validar si el usuario quiere dashboard, tabla o mixta.',
        donde: 'resumen de intención · vistas[]',
        recomendacion: `Declarar una entrada en 'vistas' por cada vista del PI con su forma (${FORMAS.join(' | ')}) y sus piezas (${PIEZAS.join(', ')}).`,
      },
    ]
  }

  const brechas: Brecha[] = []
  let n = 1

  if (dec.length !== draftViews.length) {
    brechas.push({
      id: `FORMA-${n++}`,
      sev: 'M',
      brecha: `El resumen declara ${dec.length} vista(s) pero el draft tiene ${draftViews.length}.`,
      donde: 'resumen de intención · vistas[] vs draft',
      recomendacion: 'Igualar el número de vistas declaradas al del draft (una entrada por vista/página).',
    })
  }

  const pairs = Math.min(dec.length, draftViews.length)
  for (let i = 0; i < pairs; i += 1) {
    const d = dec[i]
    const real = draftViews[i]
    const realForma = real.forma ?? 'tabla'
    const nombre = d.nombre || real.nombre || `vista ${i + 1}`
    const formaMismatch = d.forma !== realForma
    const piezasMismatch = !sameSet(d.piezas, real.piezas)
    if (formaMismatch || piezasMismatch) {
      const detalles: string[] = []
      if (formaMismatch) detalles.push(`forma declarada '${d.forma}' vs real '${realForma}'`)
      if (piezasMismatch) detalles.push(`piezas declaradas [${d.piezas.join(', ') || '—'}] vs reales [${real.piezas.join(', ') || '—'}]`)
      brechas.push({
        id: `FORMA-${n++}`,
        sev: 'M',
        brecha: `La vista «${nombre}» no calza con lo que dibuja el draft: ${detalles.join('; ')}.`,
        donde: `resumen de intención · vistas[${i}] vs draft`,
        recomendacion: 'Alinear la forma/piezas declaradas con las piezas del draft, o ajustar el draft a la intención visual validada.',
      })
    }
  }
  return brechas
}
