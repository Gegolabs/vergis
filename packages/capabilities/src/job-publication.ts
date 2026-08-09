import { createHash } from 'node:crypto'
import { selectAll, type SqlDb } from './sqlite'

/**
 * Ledger de publicaciones de jobs (#107 fase 2, diseño §4) + derivación del plan de publicación.
 *
 * Dos piezas, ambas puras sobre un `SqlDb` (patrón `admin-roles.ts`) para que las comparta el store
 * consolidado (`GovernanceStore`), que es quien corre el DDL en su `open`:
 *
 *   · **El ledger `job_publication`** — APPEND-ONLY: toda publicación (exitosa, denegada, fallida o
 *     desconocida) deja una fila y ninguna fila se muta jamás. Es la memoria de lo que Vergis
 *     publicó; el estado VIGENTE del item lo dice el motor (`getDefinition`), no esta tabla (D6).
 *   · **`derivePublishPlan`** — PURO SOBRE SHAS (Δ2 del plan del cluster 006): no toca red ni
 *     canonicaliza. Recibe el sha renderizado, el sha del motor y el último sha publicado `ok`, y
 *     decide crear/actualizar, declara el drift y sella el plan con un hash contra carreras
 *     (mismo patrón que `deriveRevertPlan`/`executeRevertPlan` de #63). Quien llama a
 *     `getDefinition` y canonicaliza es el flujo admin.
 *
 * **El drift se declara, jamás se auto-corrige (D6):** el motor es terreno donde también opera la
 * instancia; que la definición vigente no sea la última publicada desde Vergis es información que
 * el humano confirma, no una diferencia que el producto reconcilie por su cuenta.
 */

export type PublishAction = 'create' | 'update'
/** Los cuatro desenlaces de un intento de publicación (D7). `ok` SOLO con read-back del sha. */
export type PublishOutcome = 'ok' | 'denegada' | 'fallida' | 'desconocida'

/** Valores del render que se sellan en el ledger. NUNCA secretos (ver `assertParamsSinSecretos`). */
export type PublishParams = Record<string, string>

export interface PublicationRow {
  id: number
  processId: string
  templateId: string
  templateVersion: string
  workspaceId: string
  /** NULL hasta que el create culmine (un create `desconocida` no tiene item conocido todavía). */
  itemId?: string
  action: PublishAction
  /** Sha canónico de la definición publicada (Δ1: la misma identidad que render y read-back). */
  definitionSha256: string
  params: PublishParams
  outcome: PublishOutcome
  /** errorCode de Fabric / operationId del LRO / mensaje. Texto libre. */
  detail?: string
  byUser?: string
  /** ISO-8601. */
  at: string
}

/** Lo que se registra: la fila sin su `id` (lo asigna SQLite) y con `at` opcional (default: ahora). */
export interface PublicationInput extends Omit<PublicationRow, 'id' | 'at'> {
  at?: string
}

const now = (): string => new Date().toISOString()

/**
 * El DDL del diseño §4, textual. `at` y `action` no son palabras reservadas problemáticas acá
 * (`by_user` sí lo sería como `by` — mismo motivo que en `intake_revert`).
 */
export const JOB_PUBLICATION_DDL = `CREATE TABLE IF NOT EXISTS job_publication (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id        TEXT NOT NULL,
  template_id       TEXT NOT NULL,
  template_version  TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  item_id           TEXT,
  action            TEXT NOT NULL,
  definition_sha256 TEXT NOT NULL,
  params_json       TEXT NOT NULL,
  outcome           TEXT NOT NULL,
  detail            TEXT,
  by_user           TEXT,
  at                TEXT NOT NULL
);`
const JOB_PUBLICATION_IDX_PROCESS = `CREATE INDEX IF NOT EXISTS idx_job_publication_process ON job_publication (process_id, id DESC);`
const JOB_PUBLICATION_IDX_ITEM = `CREATE INDEX IF NOT EXISTS idx_job_publication_item ON job_publication (workspace_id, item_id, id DESC);`

export function ensureJobPublicationTable(db: SqlDb): void {
  db.run(JOB_PUBLICATION_DDL)
  db.run(JOB_PUBLICATION_IDX_PROCESS)
  db.run(JOB_PUBLICATION_IDX_ITEM)
}

/**
 * Cómo una fila `desconocida` queda RESUELTA sin violar el append-only.
 *
 * D7 deja publicaciones en `desconocida` (LRO que no culminó en la ventana), re-observables después.
 * Resolverlas mutando la fila rompería lo único que este ledger promete: que nada se reescribe. La
 * resolución es entonces **una fila nueva** con el desenlace medido, cuyo `detail` abre con la marca
 * `resuelve:#<id>` — la fila resuelta se referencia por su id, y el `operationId` de la desconocida
 * viaja en su propio `detail` (el diseño §5: «porta operationId»). Una desconocida está pendiente
 * mientras no exista una fila posterior con su marca.
 */
export const RESOLUCION_PREFIJO = 'resuelve:#'
export const resolucionMarca = (unknownId: number): string => `${RESOLUCION_PREFIJO}${unknownId}`

/**
 * Guardarraíl del invariante «`params_json` nunca lleva secretos» (diseño §4): los parámetros de una
 * plantilla apuntan a rutas, ids y nombres — un nombre de parámetro que anuncia una credencial es un
 * error de la plantilla, y sellarlo en un ledger append-only lo volvería imborrable. Fail-loud antes
 * de escribir. Es un guardarraíl por NOMBRE: no puede detectar un secreto con nombre inocente.
 */
const SECRETO_RE = /(secret|password|passwd|credential|client_?key|api_?key|token)/i
export function assertParamsSinSecretos(params: PublishParams): void {
  for (const k of Object.keys(params)) {
    if (SECRETO_RE.test(k)) throw new Error(`job_publication: el parámetro '${k}' parece un secreto — el ledger nunca guarda credenciales.`)
  }
}

const OUTCOMES: readonly PublishOutcome[] = ['ok', 'denegada', 'fallida', 'desconocida']

/** Serialización determinista de los params (claves ordenadas): mismo mapa ⇒ mismo texto y mismo hash. */
function paramsJson(params: PublishParams): string {
  const keys = Object.keys(params).sort()
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, params[k]])))
}

function rowOf(r: Record<string, unknown>): PublicationRow {
  return {
    id: Number(r['id']),
    processId: String(r['process_id']),
    templateId: String(r['template_id']),
    templateVersion: String(r['template_version']),
    workspaceId: String(r['workspace_id']),
    itemId: r['item_id'] == null ? undefined : String(r['item_id']),
    action: String(r['action']) as PublishAction,
    definitionSha256: String(r['definition_sha256']),
    params: JSON.parse(String(r['params_json'])) as PublishParams,
    outcome: String(r['outcome']) as PublishOutcome,
    detail: r['detail'] == null ? undefined : String(r['detail']),
    byUser: r['by_user'] == null ? undefined : String(r['by_user']),
    at: String(r['at']),
  }
}

function queryRows(db: SqlDb, sql: string, params: unknown[]): PublicationRow[] {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const out: PublicationRow[] = []
  while (stmt.step()) out.push(rowOf(stmt.getAsObject()))
  stmt.free()
  return out
}

/** Registra UN intento de publicación (cualquiera de los cuatro desenlaces). Devuelve el id asignado. */
export function recordPublication(db: SqlDb, row: PublicationInput): number {
  if (!row.processId.trim()) throw new Error('job_publication: process_id vacío.')
  if (!row.workspaceId.trim()) throw new Error('job_publication: workspace_id vacío.')
  if (row.action !== 'create' && row.action !== 'update') throw new Error(`job_publication: action inválida '${row.action}'.`)
  if (!OUTCOMES.includes(row.outcome)) throw new Error(`job_publication: outcome inválido '${row.outcome}'.`)
  if (!row.definitionSha256.trim()) throw new Error('job_publication: definition_sha256 vacío.')
  assertParamsSinSecretos(row.params)
  db.run(
    `INSERT INTO job_publication (process_id, template_id, template_version, workspace_id, item_id, action,
       definition_sha256, params_json, outcome, detail, by_user, at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.processId.trim(),
      row.templateId.trim(),
      row.templateVersion.trim(),
      row.workspaceId.trim(),
      row.itemId?.trim() || null,
      row.action,
      row.definitionSha256.trim(),
      paramsJson(row.params),
      row.outcome,
      row.detail ?? null,
      row.byUser ?? null,
      row.at ?? now(),
    ],
  )
  const res = db.exec(`SELECT last_insert_rowid() AS id`)
  return Number(res[0].values[0][0])
}

/**
 * La última publicación `ok` de un destino. Dos selectores porque el plan se deriva por PROCESO
 * («qué publicó Vergis para este proceso») pero el drift se mide contra un ITEM concreto del motor
 * (que puede haber cambiado de proceso o venir de otra fuente).
 */
export function lastOkPublication(db: SqlDb, sel: { processId: string } | { workspaceId: string; itemId: string }): PublicationRow | null {
  const rows =
    'processId' in sel
      ? queryRows(db, `SELECT * FROM job_publication WHERE process_id = ? AND outcome = 'ok' ORDER BY id DESC LIMIT 1`, [sel.processId.trim()])
      : queryRows(db, `SELECT * FROM job_publication WHERE workspace_id = ? AND item_id = ? AND outcome = 'ok' ORDER BY id DESC LIMIT 1`, [
          sel.workspaceId.trim(),
          sel.itemId.trim(),
        ])
  return rows[0] ?? null
}

/** Historial para la UI, recientes primero. Sin `processId` devuelve el de todos los procesos. */
export function listPublications(db: SqlDb, opts: { processId?: string; limit?: number } = {}): PublicationRow[] {
  const limit = Math.max(1, Math.trunc(opts.limit ?? 50))
  return opts.processId
    ? queryRows(db, `SELECT * FROM job_publication WHERE process_id = ? ORDER BY id DESC LIMIT ?`, [opts.processId.trim(), limit])
    : queryRows(db, `SELECT * FROM job_publication ORDER BY id DESC LIMIT ?`, [limit])
}

/**
 * Las `desconocida` que siguen esperando el re-verificar de D7: no existe todavía una fila posterior
 * que las marque resueltas. Es la cola de trabajo de la acción «Re-verificar» de la UI.
 */
export function pendingUnknownPublications(db: SqlDb, opts: { processId?: string } = {}): PublicationRow[] {
  const desconocidas = opts.processId
    ? queryRows(db, `SELECT * FROM job_publication WHERE outcome = 'desconocida' AND process_id = ? ORDER BY id DESC`, [opts.processId.trim()])
    : queryRows(db, `SELECT * FROM job_publication WHERE outcome = 'desconocida' ORDER BY id DESC`, [])
  if (desconocidas.length === 0) return []
  const marcas = new Set(
    selectAll(db, `SELECT detail FROM job_publication WHERE detail IS NOT NULL`)
      .map((r) => String(r['detail']))
      .filter((d) => d.startsWith(RESOLUCION_PREFIJO))
      .map((d) => d.slice(RESOLUCION_PREFIJO.length).split(/\D/, 1)[0]),
  )
  return desconocidas.filter((d) => !marcas.has(String(d.id)))
}

/**
 * Resuelve una fila `desconocida` con el desenlace MEDIDO por el re-verificar (D7) — agregando una
 * fila nueva que la referencia, jamás mutando la original (append-only). Devuelve el id de la nueva.
 */
export function resolveUnknownPublication(
  db: SqlDb,
  unknownId: number,
  resolution: { outcome: Exclude<PublishOutcome, 'desconocida'>; detail?: string; itemId?: string; byUser?: string; at?: string },
): number {
  const rows = queryRows(db, `SELECT * FROM job_publication WHERE id = ?`, [unknownId])
  const original = rows[0]
  if (!original) throw new Error(`job_publication: no existe la publicación #${unknownId}.`)
  if (original.outcome !== 'desconocida') throw new Error(`job_publication: la publicación #${unknownId} no está 'desconocida' (está '${original.outcome}').`)
  // El tipo ya lo excluye; la guarda es para el llamador sin tipos (una resolución que vuelve a
  // dejar la fila en 'desconocida' no resuelve nada y dejaría la marca falseando la cola pendiente).
  if ((resolution.outcome as PublishOutcome) === 'desconocida') throw new Error('job_publication: una resolución no puede volver a ser desconocida.')
  const detail = resolution.detail ? `${resolucionMarca(unknownId)} · ${resolution.detail}` : resolucionMarca(unknownId)
  return recordPublication(db, {
    processId: original.processId,
    templateId: original.templateId,
    templateVersion: original.templateVersion,
    workspaceId: original.workspaceId,
    // El re-verificar puede haber descubierto el item que el create dejó sin id.
    itemId: resolution.itemId ?? original.itemId,
    action: original.action,
    definitionSha256: original.definitionSha256,
    params: original.params,
    outcome: resolution.outcome,
    detail,
    byUser: resolution.byUser ?? original.byUser,
    at: resolution.at,
  })
}

// ─── Plan de publicación (Δ2: puro sobre shas — sin red, sin canonicalización) ──

export interface PublishPlanInput {
  processId: string
  templateId: string
  templateVersion: string
  workspaceId: string
  /** Item destino conocido. `null` = todavía no hay item (o el proceso no tiene `engine_ref`). */
  itemId: string | null
  /** Sha canónico de la definición renderizada (lo produce el render de plantillas). */
  renderedSha: string
  /** Sha canónico de lo que el motor tiene HOY. `null` = el item no existe en el motor. */
  engineSha: string | null
  /** Sha de la última publicación `ok` del ledger. `null` = Vergis nunca publicó este destino. */
  lastOkSha: string | null
  params: PublishParams
}

export interface PublishPlan extends PublishPlanInput {
  action: PublishAction
  /**
   * La definición del motor NO es la última publicada desde Vergis — alguien la editó en el motor
   * (o la publicó otro camino). Se DECLARA en el plan y la confirmación exige verlo; jamás se
   * auto-corrige (D6). Solo es medible con ambos shas presentes.
   */
  drift: boolean
  /** El motor ya tiene exactamente esta definición: publicar no cambiaría nada. */
  sinCambios: boolean
  /** Sella el plan contra carreras: si el estado cambió al ejecutar, el hash no calza → 409 (D5). */
  hash: string
}

/** Hash canónico del plan: TODOS los insumos, orden estable de claves ⇒ mismo estado, mismo hash. */
function planHashOf(p: PublishPlanInput & { action: PublishAction; drift: boolean; sinCambios: boolean }): string {
  const canonical = JSON.stringify({
    processId: p.processId,
    templateId: p.templateId,
    templateVersion: p.templateVersion,
    workspaceId: p.workspaceId,
    itemId: p.itemId,
    renderedSha: p.renderedSha,
    engineSha: p.engineSha,
    lastOkSha: p.lastOkSha,
    params: paramsJson(p.params),
    action: p.action,
    drift: p.drift,
    sinCambios: p.sinCambios,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Deriva el plan de publicación. Puro y sin efectos: no toca red ni el ledger — quien resuelve
 * `engineSha` (`getDefinition` + canonicalización) y `lastOkSha` (`lastOkPublication`) es el flujo
 * admin, y se los pasa ya resueltos (Δ2).
 *
 * `create` cuando no hay item destino **o** el motor no lo tiene (`engineSha === null`): un item que
 * el ledger recuerda pero el motor ya no tiene se re-crea, no se actualiza sobre la nada.
 */
export function derivePublishPlan(input: PublishPlanInput): PublishPlan {
  if (!input.renderedSha.trim()) throw new Error('derivePublishPlan: renderedSha vacío.')
  assertParamsSinSecretos(input.params)
  const itemId = input.itemId?.trim() ? input.itemId.trim() : null
  const engineSha = input.engineSha ?? null
  const lastOkSha = input.lastOkSha ?? null
  const action: PublishAction = itemId === null || engineSha === null ? 'create' : 'update'
  const drift = engineSha !== null && lastOkSha !== null && engineSha !== lastOkSha
  const sinCambios = engineSha !== null && engineSha === input.renderedSha
  const base = { ...input, itemId, engineSha, lastOkSha, action, drift, sinCambios }
  return { ...base, hash: planHashOf(base) }
}
