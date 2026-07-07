/**
 * Intake de archivos — contrato declarativo de los SLOTS de ingestión (genérico, agnóstico de
 * instancia). Es el ESPEJO de la publicación de data maestra: ahí el dato SALE (proyección
 * `__replica`), acá el archivo ENTRA (a una landing zone OneLake).
 *
 * Mira intermedia la ingesta: el usuario sube el archivo a UN solo lugar y Mira lo ubica en el destino
 * correcto (staging `Files/...` de un Lakehouse), SIN que el usuario sepa la ruta. El pipeline de
 * ingestión existente (notebook/CopyJob) lee de ahí — Mira intermedia, NO reemplaza el transform.
 *
 * Este módulo define SOLO el contrato y las funciones puras (parse/match/validate). El write físico a
 * OneLake y el disparo del pipeline viven en `intake-onelake.ts`; los slots concretos los declara la
 * INSTANCIA en `intake/slots.yaml`.
 */

/** Destino OneLake del crudo: carpeta `Files/...` de un Lakehouse (landing zone / staging). */
export interface IntakeTarget {
  workspaceId: string
  lakehouseId: string
  /** Ruta dentro del Lakehouse, p.ej. `Files/intake/saldos`. El pipeline lee de aquí. */
  path: string
}

/** Disparo opcional del pipeline tras aterrizar el archivo (land-and-trigger). */
export interface IntakeTrigger {
  /** Item Fabric a correr (run-now). Omitir el trigger entero = land-only. */
  processRef: string
  /** Workspace del item (si difiere del target). Default: el del target. */
  workspaceId?: string
  /** jobType del item Fabric (default `Pipeline`). */
  jobType?: string
}

export interface IntakeSlot {
  /** Slug estable, usado en rutas y como id lógico (p.ej. `saldos_cartera`). */
  id: string
  /** Nombre legible para la UI. */
  label: string
  description?: string
  /** Dominio al que pertenece el slot (tag; deriva la gestión de dominio). */
  domain?: string
  /** Glob del nombre de archivo aceptado (p.ej. `Antigüedad de saldos *.xlsx`). */
  accept?: string
  /** Tamaño máximo en bytes. Default 25 MB. */
  maxBytes?: number
  target: IntakeTarget
  trigger?: IntakeTrigger
}

const SLUG_RE = /^[a-z][a-z0-9_]*$/
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

/** Valida y normaliza la config declarativa de intake (`{ slots: [...] }`). */
export function parseIntakeConfig(doc: unknown): IntakeSlot[] {
  const root = (doc ?? {}) as { slots?: unknown }
  const raw = root.slots
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('intake: `slots` debe ser una lista.')
  const seen = new Set<string>()
  return raw.map((s, i) => parseSlot(s, i, seen))
}

function parseSlot(s: unknown, i: number, seen: Set<string>): IntakeSlot {
  const o = (s ?? {}) as Record<string, unknown>
  const id = String(o['id'] ?? '')
  if (!SLUG_RE.test(id)) throw new Error(`intake: slot #${i} con id inválido '${id}' (esperado [a-z][a-z0-9_]*).`)
  if (seen.has(id)) throw new Error(`intake: id de slot duplicado '${id}'.`)
  seen.add(id)
  const target = parseTarget(o['target'], id)
  const out: IntakeSlot = { id, label: String(o['label'] ?? id), target }
  if (o['description'] != null) out.description = String(o['description'])
  if (o['domain'] != null) out.domain = String(o['domain'])
  if (o['accept'] != null) out.accept = String(o['accept'])
  if (o['maxBytes'] != null) {
    const n = Number(o['maxBytes'])
    if (!Number.isInteger(n) || n <= 0) throw new Error(`intake: '${id}'.maxBytes debe ser un entero positivo.`)
    out.maxBytes = n
  }
  if (o['trigger'] != null) {
    const t = (o['trigger'] ?? {}) as Record<string, unknown>
    const processRef = String(t['processRef'] ?? '')
    if (!processRef) throw new Error(`intake: '${id}'.trigger sin processRef.`)
    const trig: IntakeTrigger = { processRef }
    if (t['workspaceId'] != null) trig.workspaceId = String(t['workspaceId'])
    if (t['jobType'] != null) trig.jobType = String(t['jobType'])
    out.trigger = trig
  }
  return out
}

function parseTarget(raw: unknown, slotId: string): IntakeTarget {
  const o = (raw ?? {}) as Record<string, unknown>
  const workspaceId = String(o['workspaceId'] ?? '')
  const lakehouseId = String(o['lakehouseId'] ?? '')
  const path = String(o['path'] ?? '')
  if (!workspaceId || !lakehouseId || !path) {
    throw new Error(`intake: '${slotId}'.target requiere workspaceId, lakehouseId y path.`)
  }
  if (!/^Files\//.test(path)) {
    throw new Error(`intake: '${slotId}'.target.path debe empezar en 'Files/' (staging del Lakehouse, no 'Tables/').`)
  }
  return { workspaceId, lakehouseId, path: path.replace(/\/+$/, '') }
}

/** El tope de tamaño efectivo de un slot. */
export const slotMaxBytes = (slot: IntakeSlot): number => slot.maxBytes ?? DEFAULT_MAX_BYTES

/**
 * Compila un glob de nombre de archivo (`*`, `?`) a RegExp anclada, case-insensitive. Solo esos dos
 * comodines; el resto del patrón se escapa (injection-safe).
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/** El primer slot cuyo `accept` matchea el nombre. Un slot sin `accept` acepta cualquier nombre. */
export function matchSlot(slots: IntakeSlot[], filename: string): IntakeSlot | undefined {
  return slots.find((s) => !s.accept || globToRegExp(s.accept).test(filename))
}

export type ValidateResult = { ok: true } | { ok: false; error: string }

/** Valida un upload contra el slot: patrón de nombre y tamaño. Resultado accionable. */
export function validateUpload(slot: IntakeSlot, filename: string, size: number): ValidateResult {
  const name = (filename ?? '').trim()
  if (!name) return { ok: false, error: 'El archivo no tiene nombre.' }
  if (name === '.' || name === '..') return { ok: false, error: `Nombre de archivo inválido: '${name}'.` }
  // Separadores de ruta, traversal y caracteres que rompen el encoding del path DFS (`#`/`?` cortan
  // el path / inyectan query params; `%` habilita doble-encoding; control chars). El nombre va directo
  // a la URL de OneLake — se trata como hoja, nunca como ruta.
  // eslint-disable-next-line no-control-regex
  if (/[/\\?#%\x00-\x1f]/.test(name)) return { ok: false, error: `Nombre de archivo inválido (sin rutas ni caracteres especiales): '${name}'.` }
  if (slot.accept && !globToRegExp(slot.accept).test(name)) {
    return { ok: false, error: `El nombre '${name}' no coincide con el patrón esperado «${slot.accept}».` }
  }
  if (size <= 0) return { ok: false, error: 'El archivo está vacío.' }
  const max = slotMaxBytes(slot)
  if (size > max) {
    return { ok: false, error: `El archivo (${size} bytes) excede el máximo del slot (${max} bytes).` }
  }
  return { ok: true }
}
