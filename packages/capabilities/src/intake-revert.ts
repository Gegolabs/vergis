/**
 * «Revertir esta carga» (issue #63): el MOTOR de compensación de una carga, derivado del ledger que el
 * contrato de ingesta ya mantiene — el layout `_processed/<clave>/<archivo>`.
 *
 * Vergis no duplica el mapeo carga→claves en un store propio: el convertidor (SJD de la instancia,
 * fuera de este repo) lo escribe atómicamente con la conversión y es su único dueño. Acá se LEE.
 *
 * Dos fases, sin sorpresas:
 *   · `deriveRevertPlan` — no muta NADA: dice, clave por clave, qué pasaría y qué no se puede.
 *   · `executeRevertPlan` — re-deriva, compara el hash del plan confirmado y solo entonces ejecuta.
 *
 * La identidad de la carga es su **sha256**, jamás el nombre: los mismos bytes llegan como
 * «saldos (1) (1).xlsx» y una copia posterior del mismo nombre puede traer otro contenido.
 *
 * Vergis JAMÁS hace DML sobre las tablas del slot (no conoce tabla ni columna). Cuando la clave debe
 * quedar VACÍA, escribe un **manifiesto de reversión** en el landing y el convertidor lo ejecuta —
 * misma separación que `verify` (#95): Vergis declara y propaga, el convertidor ejecuta. El mecanismo
 * está gated por la capacidad declarada `revert_delete` del slot: sin ella, fail-closed.
 */
import { createHash } from 'node:crypto'
import { isSidecarName, sidecarName, type IntakeSlot } from './intake'
import type { OneLakeEntry, OneLakeIntake, OneLakeReader, FabricJobs } from './intake-onelake'
import type { IntakeUploadStore } from './governance-store'

/** Qué le pasa a UNA clave que la carga tocó (o por qué no se la toca). */
export type ClaveAccion =
  /** D3.i — la clave vuelve a su versión anterior: se reactiva `previa` y se re-corre la conversión. */
  | { clave: string; accion: 'rematerializar'; revertido: string; previa: string }
  /** D3.ii — la carga INTRODUJO la clave: queda vacía (DELETE sin INSERT, vía manifiesto). */
  | { clave: string; accion: 'vaciar'; revertido: string }
  /** D3.ii sin `revert_delete` (o sin write-path): no se puede vaciar → no se toca nada. */
  | { clave: string; accion: 'no-compensable'; revertido: string }
  /** D3.iii — el dato vigente de la clave NO proviene de esta carga: sin efecto. */
  | { clave: string; accion: 'pisada'; revertido: string; vigente: string; vigenteAt: string }
  /** Archivado directamente bajo `_processed/`, sin directorio de clave: no hay compensación derivable. */
  | { clave: string; accion: 'sin-clave'; revertido: string }

/** El plan de reversión de UNA carga: derivado, sellado por hash, ejecutable o no. */
export interface RevertPlan {
  slotId: string
  /** Ancla a `intake_upload.id` (#62). Ausente si la carga no está en el registro. */
  uploadId?: number
  filename: string
  sha256: string
  claves: ClaveAccion[]
  /** Rutas en el landing (archivo de datos) que la ejecución retira (D3.iv). */
  landing: string[]
  /** ¿Hay al menos una acción con efecto (rematerializar | vaciar | landing)? */
  ejecutable: boolean
  /** SHA-256 hex del JSON canónico del plan: sella lo confirmado contra lo que se ejecuta. */
  hash: string
}

export interface RevertDeps {
  reader: OneLakeReader
  /** Write-path del landing: SOLO para el manifiesto de reversión (D8). Sin él, `vaciar` degrada a
   *  `no-compensable` — el mismo fail-closed que la ausencia de `revert_delete`. */
  intake?: OneLakeIntake
  jobs?: FabricJobs
  /** Registro de cargas (#62): resuelve `uploadId` ↔ (filename, sha256). */
  uploads?: IntakeUploadStore
}

/** Ancla de la reversión: la CARGA (fila 📤 del timeline) o UN archivo archivado (Procesados). */
export type RevertRef = { uploadId: number } | { archivedPath: string }

export interface RevertResult {
  resumen: ClaveAccion[]
  landingRetirado: boolean
  /** Se disparó la conversión compensatoria (hubo rematerializar o vaciar y el slot tiene trigger). */
  convirtiendo: boolean
  /** Identidad de la carga revertida — la registra el store y la nombra el mensaje al operador. */
  filename: string
  uploadId?: number
}

const parentDir = (p: string): string => (p.includes('/') ? p.replace(/\/[^/]*$/, '') : p)
const baseName = (p: string): string => p.split('/').pop() ?? p
const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const esDato = (e: OneLakeEntry): boolean => !e.isDirectory && !isSidecarName(e.path)

/** Nombre determinístico del manifiesto de reversión de una clave (D8): re-escribirlo es overwrite. */
export const revertManifestName = (clave: string): string => `_revert_${clave}.meta.json`

/** El JSON del manifiesto que el convertidor ejecuta como DELETE de la clave (D8). */
export const buildRevertManifest = (slotId: string, clave: string, filename: string, by: string, at: string): string =>
  JSON.stringify({ revert: { clave }, slot: slotId, filename, by, at }, null, 2)

/** Hash canónico del plan: mismo estado del slot ⇒ mismo hash, en cualquier orden de listado. */
function planHashOf(p: Omit<RevertPlan, 'hash' | 'ejecutable'>): string {
  const claves = [...p.claves].sort((a, b) => (a.clave === b.clave ? a.revertido.localeCompare(b.revertido) : a.clave.localeCompare(b.clave)))
  const landing = [...p.landing].sort()
  return shaOf(new TextEncoder().encode(JSON.stringify({ slotId: p.slotId, filename: p.filename, sha256: p.sha256, claves, landing })))
}

/** Identidad de la carga a revertir: nombre + sha (+ el id del registro cuando existe). */
async function resolverCarga(deps: RevertDeps, slot: IntakeSlot, ref: RevertRef): Promise<{ filename: string; sha256: string; uploadId?: number }> {
  if ('uploadId' in ref) {
    if (!deps.uploads) throw new Error('revert: el registro de cargas no está disponible en esta instancia.')
    // El store no indexa por id: la carga se busca en las recientes del slot (el botón solo aparece
    // en las filas del timeline, que salen de esa misma ventana).
    const row = (await deps.uploads.listUploads(slot.id, 1000)).find((r) => r.id === ref.uploadId)
    if (!row) throw new Error(`revert: la carga #${ref.uploadId} no está en el registro del slot '${slot.id}'.`)
    if (!row.sha256) throw new Error(`revert: la carga #${ref.uploadId} no tiene sha256 registrado — su identidad no es verificable.`)
    return { filename: row.filename, sha256: row.sha256, uploadId: row.id }
  }
  const bytes = await deps.reader.readBytes(slot.target, ref.archivedPath)
  if (!bytes) throw new Error(`revert: el archivo '${ref.archivedPath}' ya no está en el histórico.`)
  const sha256 = shaOf(bytes)
  const out: { filename: string; sha256: string; uploadId?: number } = { filename: baseName(ref.archivedPath), sha256 }
  // La carga puede no estar registrada (procesada antes de #62): el plan funciona igual sin ancla.
  const orig = await deps.uploads?.findUploadBySha(slot.id, sha256).catch(() => null)
  if (orig) out.uploadId = orig.id
  return out
}

/**
 * Deriva el plan de reversión SIN mutar nada.
 *
 * El costo de leer bytes está acotado a los candidatos POR NOMBRE (unidades, no el histórico entero):
 * el nombre estrecha, el sha decide.
 */
export async function deriveRevertPlan(deps: RevertDeps, slot: IntakeSlot, ref: RevertRef): Promise<RevertPlan> {
  const { filename, sha256, uploadId } = await resolverCarga(deps, slot, ref)
  const processed = `${parentDir(slot.target.path)}/_processed`

  const prefix = `${processed}/`
  const entries = (await deps.reader.list(slot.target, processed, { recursive: true }).catch(() => [] as OneLakeEntry[]))
    .filter((e) => esDato(e) && e.path.startsWith(prefix))
  const claves: ClaveAccion[] = []
  for (const cand of entries.filter((e) => baseName(e.path) === filename)) {
    const rel = cand.path.slice(prefix.length)
    const clave = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : ''
    const bytes = await deps.reader.readBytes(slot.target, cand.path).catch(() => null)
    const mismo = bytes != null && shaOf(bytes) === sha256
    if (!clave) {
      // Sin directorio de clave no hay compensación derivable: se reporta y no se toca (fail-closed).
      if (mismo) claves.push({ clave: '', accion: 'sin-clave', revertido: cand.path })
      continue
    }
    const hermanos = entries.filter((e) => e.path.startsWith(`${processed}/${clave}/`) && !e.path.slice(`${processed}/${clave}/`.length).includes('/'))
    const otros = hermanos.filter((e) => e.path !== cand.path)
    const masReciente = (list: OneLakeEntry[]): OneLakeEntry | null =>
      list.reduce<OneLakeEntry | null>((best, e) => (best && Date.parse(best.lastModified) >= Date.parse(e.lastModified) ? best : e), null)
    if (!mismo) {
      // Un archivo del MISMO nombre pisó la copia de esta carga: el dato de la clave ya no es suyo.
      const vig = masReciente(hermanos) ?? cand
      claves.push({ clave, accion: 'pisada', revertido: cand.path, vigente: vig.path, vigenteAt: vig.lastModified })
      continue
    }
    const posterior = otros.find((e) => Date.parse(e.lastModified) > Date.parse(cand.lastModified))
    if (posterior) {
      const vig = masReciente(otros) ?? posterior
      claves.push({ clave, accion: 'pisada', revertido: cand.path, vigente: vig.path, vigenteAt: vig.lastModified })
      continue
    }
    const previa = masReciente(otros)
    if (previa) claves.push({ clave, accion: 'rematerializar', revertido: cand.path, previa: previa.path })
    else if (slot.revertDelete && deps.intake) claves.push({ clave, accion: 'vaciar', revertido: cand.path })
    else claves.push({ clave, accion: 'no-compensable', revertido: cand.path })
  }

  // Copias en el LANDING (aún no procesadas, o residuo): revertir la carga es retirarlas.
  const landing: string[] = []
  for (const e of (await deps.reader.list(slot.target, slot.target.path).catch(() => [] as OneLakeEntry[])).filter(esDato)) {
    if (baseName(e.path) !== filename) continue
    const bytes = await deps.reader.readBytes(slot.target, e.path).catch(() => null)
    if (bytes && shaOf(bytes) === sha256) landing.push(e.path)
  }

  const base = { slotId: slot.id, filename, sha256, claves, landing, ...(uploadId != null ? { uploadId } : {}) }
  const ejecutable = claves.some((c) => c.accion === 'rematerializar' || c.accion === 'vaciar') || landing.length > 0
  return { ...base, ejecutable, hash: planHashOf(base) }
}

/**
 * Ejecuta el plan CONFIRMADO, tras re-derivarlo y verificar que el estado del slot no cambió.
 *
 * Orden por clave — **convergencia primero**: (1) asegurar el insumo de compensación (reactivar la
 * versión previa al landing, o escribir el manifiesto), (2) respaldar la copia de la carga en
 * `_retirado/`, (3) recién ahí removerla de `_processed/`. Un crash a mitad deja el plan re-derivable:
 * mientras la copia siga en `_processed/`, la re-entrada la reencuentra y converge. Cada paso es
 * overwrite-idempotente (`copy`) o tolerante a la ausencia (`remove` 404 = no-op).
 *
 * Los sidecars viajan best-effort: que el convertidor archive el `<archivo>.meta.json` junto al dato es
 * conjetura de layout, no un hecho verificable desde este repo — su ausencia jamás aborta la reversión.
 */
export async function executeRevertPlan(
  deps: RevertDeps,
  slot: IntakeSlot,
  planHash: string,
  ref: RevertRef,
  by: string,
): Promise<{ ok: true; result: RevertResult } | { ok: false; plan: RevertPlan }> {
  const plan = await deriveRevertPlan(deps, slot, ref)
  if (plan.hash !== planHash) return { ok: false, plan }
  const ident = { filename: plan.filename, ...(plan.uploadId != null ? { uploadId: plan.uploadId } : {}) }
  if (!plan.ejecutable) return { ok: true, result: { resumen: plan.claves, landingRetirado: false, convirtiendo: false, ...ident } }

  const parent = parentDir(slot.target.path)
  const at = new Date().toISOString()
  const retirado = (p: string): string => `${parent}/_retirado/${Date.now()}-revertido-${baseName(p)}`
  const copiarSidecar = async (from: string, to: string): Promise<void> => {
    await deps.reader.copy(slot.target, sidecarName(from), sidecarName(to)).catch(() => {})
  }
  /** Respalda en `_retirado/` y saca del histórico la copia de la carga (con su sidecar, best-effort). */
  const retirarDelHistorico = async (path: string): Promise<void> => {
    const dst = retirado(path)
    await copiarSidecar(path, dst)
    await deps.reader.copy(slot.target, path, dst)
    await deps.reader.remove(slot.target, sidecarName(path)).catch(() => {})
    await deps.reader.remove(slot.target, path)
  }

  let compensó = false
  for (const c of plan.claves) {
    if (c.accion === 'rematerializar') {
      // 1 · el insumo de la compensación PRIMERO: la versión previa vuelve al landing (sidecar antes
      // que el dato, como manda el contrato: el SJD nunca ve un archivo sin su sidecar).
      const destino = `${slot.target.path}/${baseName(c.previa)}`
      await copiarSidecar(c.previa, destino)
      await deps.reader.copy(slot.target, c.previa, destino)
      await retirarDelHistorico(c.revertido)
      compensó = true
    } else if (c.accion === 'vaciar') {
      // 1 · la directiva de DELETE, que el convertidor ejecuta al inicio de su corrida.
      const manifiesto = buildRevertManifest(slot.id, c.clave, plan.filename, by, at)
      await deps.intake!.put(slot.target, revertManifestName(c.clave), new TextEncoder().encode(manifiesto))
      await retirarDelHistorico(c.revertido)
      compensó = true
    }
    // `pisada`, `no-compensable` y `sin-clave` NO tocan nada: se reportan tal cual.
  }

  for (const p of plan.landing) {
    const dst = retirado(p)
    await copiarSidecar(p, dst)
    await deps.reader.copy(slot.target, p, dst)
    await deps.reader.remove(slot.target, sidecarName(p)).catch(() => {})
    await deps.reader.remove(slot.target, p)
  }

  // Un SOLO run al final: la conversión compensatoria es una, no una por clave.
  const convirtiendo = compensó && !!slot.trigger && !!deps.jobs
  if (convirtiendo) await deps.jobs!.runNow(slot.trigger!, slot.target)
  return { ok: true, result: { resumen: plan.claves, landingRetirado: plan.landing.length > 0, convirtiendo, ...ident } }
}
