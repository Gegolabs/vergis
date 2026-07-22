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

/** Tipo de un campo de metadata requerida en la subida (issue #76). */
export type IntakeMetaType = 'string' | 'number' | 'enum' | 'rut'

/**
 * Campo de metadata requerida por un slot (issue #76). El archivo de algunos slots NO se puede convertir
 * sin un dato que no viene en su contenido y que por política JAMÁS se infiere (identidad explícita,
 * fail-closed): a qué empresa se imputa un extracto, qué versión trae un presupuesto. La UI lo solicita
 * en el acto de subir y el valor viaja con el archivo (sidecar) hasta el SJD.
 */
export interface IntakeMetaField {
  /** Slug estable, usado como llave en el sidecar y en el name del control del form. */
  id: string
  /** Nombre legible para la UI. */
  label: string
  type: IntakeMetaType
  /** Sin valor bloquea la subida (validación server-side; la del browser es cortesía). */
  required?: boolean
  /** Opciones inline para type `enum`. */
  options?: string[]
  /** Catálogo externo para type `enum` — declarado en el contrato pero NO soportado aún (no hay
   *  mecanismo de catálogos en la capa admin): un slot que lo use NO arranca (fail-closed). */
  options_ref?: string
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
  /** Ruta (dentro del MISMO lakehouse del target) del log que escribe el proceso de conversión —
   * Frescura lo expone para reconfirmar una carga (filas, semana, commit) sin acceso a Fabric.
   * Default `Files/code/_ingest_log.txt`; `log: false` en el YAML lo deshabilita. */
  log?: string | false
  /** Metadata requerida en la subida (issue #76). Ausente = sin cambio (regresión cero). */
  meta?: IntakeMetaField[]
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
  if (o['log'] === false) out.log = false
  else if (o['log'] != null) {
    const p = String(o['log'])
    if (!/^Files\//.test(p)) throw new Error(`intake: '${id}'.log debe empezar en 'Files/' (vive en el mismo Lakehouse del target).`)
    out.log = p
  }
  if (o['meta'] != null) {
    const meta = parseMeta(o['meta'], id)
    if (meta.length) out.meta = meta
  }
  return out
}

const META_TYPES = new Set<IntakeMetaType>(['string', 'number', 'enum', 'rut'])

/** Valida y normaliza el bloque `meta` de un slot (issue #76). Mal formado = fallo ruidoso. */
function parseMeta(raw: unknown, slotId: string): IntakeMetaField[] {
  if (!Array.isArray(raw)) throw new Error(`intake: '${slotId}'.meta debe ser una lista.`)
  const seen = new Set<string>()
  return raw.map((m, i) => {
    const o = (m ?? {}) as Record<string, unknown>
    const id = String(o['id'] ?? '')
    if (!SLUG_RE.test(id)) throw new Error(`intake: '${slotId}'.meta #${i} con id inválido '${id}' (esperado [a-z][a-z0-9_]*).`)
    if (seen.has(id)) throw new Error(`intake: '${slotId}'.meta con id duplicado '${id}'.`)
    seen.add(id)
    const type = String(o['type'] ?? '') as IntakeMetaType
    if (!META_TYPES.has(type)) throw new Error(`intake: '${slotId}'.meta '${id}' con type inválido '${type}' (string | number | enum | rut).`)
    const field: IntakeMetaField = { id, label: String(o['label'] ?? id), type }
    if (o['required'] != null) {
      if (typeof o['required'] !== 'boolean') throw new Error(`intake: '${slotId}'.meta '${id}'.required debe ser booleano.`)
      field.required = o['required']
    }
    // `options_ref`: en el contrato pero NO soportado aún (no hay mecanismo de catálogos en la capa
    // admin). Fail-closed: un slot que lo declare NO arranca — se exige `options` inline por ahora.
    if (o['options_ref'] != null) {
      throw new Error(`intake: '${slotId}'.meta '${id}'.options_ref no soportado aún — usa 'options' inline (lista de valores).`)
    }
    if (type === 'enum') {
      const opts = o['options']
      if (!Array.isArray(opts) || opts.length === 0) throw new Error(`intake: '${slotId}'.meta '${id}' (enum) requiere 'options' (lista no vacía).`)
      field.options = opts.map((v) => String(v))
    } else if (o['options'] != null) {
      throw new Error(`intake: '${slotId}'.meta '${id}': 'options' solo aplica a type enum.`)
    }
    return field
  })
}

/** Ruta efectiva del log de conversión de un slot (null = deshabilitado). */
export const DEFAULT_INGEST_LOG = 'Files/code/_ingest_log.txt'
export const slotLogPath = (slot: IntakeSlot): string | null =>
  slot.log === false ? null : slot.log ?? DEFAULT_INGEST_LOG

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

// ─── Metadata requerida por slot (issue #76) ────────────────────────────────

/**
 * Valida un RUT chileno con su dígito verificador (módulo 11). Acepta `12345678-9` / `12.345.678-9` /
 * `12345678-K` (puntos y espacios se ignoran; el DV `K`/`k` cuenta). Sin guion, sin cuerpo o con cuerpo
 * de más de 8 dígitos → inválido. No infiere ni corrige: es una compuerta booleana.
 */
export function validateRut(raw: string): boolean {
  const cleaned = (raw ?? '').replace(/[.\s]/g, '').toUpperCase()
  const m = /^(\d{1,8})-([\dK])$/.exec(cleaned)
  if (!m) return false
  const [, body, dv] = m
  let sum = 0
  let mul = 2
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * mul
    mul = mul === 7 ? 2 : mul + 1
  }
  const res = 11 - (sum % 11)
  const expected = res === 11 ? '0' : res === 10 ? 'K' : String(res)
  return expected === dv
}

export type ValidateMetaResult = { ok: true; values: Record<string, string> } | { ok: false; error: string }

/**
 * Valida los valores de metadata enviados contra el bloque `meta` del slot. Devuelve SOLO los campos
 * declarados (normalizados/trim) — lo que viaja al sidecar; ignora extras. Un `required` sin valor o un
 * valor que no calza el tipo rechaza el lote (server-side; la validación del browser es cortesía).
 */
export function validateMeta(slot: IntakeSlot, submitted: Record<string, string>): ValidateMetaResult {
  const values: Record<string, string> = {}
  for (const f of slot.meta ?? []) {
    const raw = (submitted[f.id] ?? '').trim()
    if (!raw) {
      if (f.required) return { ok: false, error: `Falta el campo requerido «${f.label}».` }
      continue // opcional sin valor: no viaja
    }
    switch (f.type) {
      case 'number':
        if (!Number.isFinite(Number(raw))) return { ok: false, error: `«${f.label}» debe ser un número (recibido: '${raw}').` }
        break
      case 'enum':
        // `options` siempre está presente (el parse rechaza enum sin options y options_ref).
        if (!(f.options ?? []).includes(raw)) return { ok: false, error: `«${f.label}»: '${raw}' no es una opción válida.` }
        break
      case 'rut':
        if (!validateRut(raw)) return { ok: false, error: `«${f.label}»: RUT inválido (dígito verificador no cuadra): '${raw}'.` }
        break
      case 'string':
        break
    }
    values[f.id] = raw
  }
  return { ok: true, values }
}

/** Nombre del sidecar de metadata de un archivo: `<archivo>.meta.json`. */
export const sidecarName = (filename: string): string => `${filename}.meta.json`

/** ¿El nombre es un sidecar de metadata (no un archivo de datos)? Para filtrar listados del landing. */
export const isSidecarName = (name: string): boolean => name.endsWith('.meta.json')

/**
 * Construye el JSON del sidecar (issue #76). Orden: `slot` → campos de metadata → auditoría
 * (`uploadedBy`/`uploadedAt`). El SJD lo lee para imputar la metadata sin intervención humana.
 */
export function buildSidecar(slotId: string, values: Record<string, string>, uploadedBy: string, uploadedAt: string): string {
  return JSON.stringify({ slot: slotId, ...values, uploadedBy, uploadedAt }, null, 2)
}
