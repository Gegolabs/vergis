import { openSqliteDb, persistSqliteDb, selectAll, type SqlDb } from './sqlite'
import {
  adminAdd,
  adminIsAdmin,
  adminList,
  adminRemove,
  ensureAdminTable,
  normEmail,
  type AdminEntry,
  type AdminStore,
} from './admin-roles'
import {
  effectiveRole,
  type PiGrant,
  type PiRole,
  type PiVisibility,
  type PrincipalType,
} from './pi-authz'
import { durationToSeconds, validateOferta } from './freshness'
import type { RunRecord, RunStatus } from './ingestion-observability'
import type { ClaveAccion } from './intake-revert'
import {
  canTransition,
  isMirandaState,
  type MirandaSessionState,
  type MirandaMessageRole,
  type MirandaArtifactKind,
} from './miranda-session'

/**
 * `GovernanceStore` — el store ÚNICO del estado de gobierno del runtime (modelo de tres estados):
 * NO es dato de negocio (eso va a Fabric), NO es la definición del PI (eso son los specs authz-blind).
 * Es el "quién / cuándo / cuánto": admins, grupos gestionados por Mira, ACL/ownership de PI, demanda,
 * registro de fuentes y observabilidad de ingestión. Agnóstico del motor; vive embebido (SQLite) en
 * un VOLUMEN persistente; seam para swappear a Postgres sin tocar el resto.
 *
 * Consolida en UN db lo que antes serían stores sueltos. G0: admins (ya construidos) + grupos de Mira.
 * Las siguientes fases agregan tablas (pi_grant, pi_governance, pi_demanda, source…, ingestion_run)
 * a este mismo store y seam.
 */

const SLUG_RE = /^[a-z][a-z0-9_-]*$/
const now = (): string => new Date().toISOString()

export interface MiraGroup {
  id: string
  label: string
  /** Grupo semilla (de config de instancia, p.ej. «Analistas ARBOL»). */
  seed: boolean
}
export interface GroupMember {
  email: string
  addedBy?: string
  addedAt?: string
}
export interface GroupSeed {
  id: string
  label: string
  members?: string[]
}

/** Grupos gestionados por Mira (NO grupos AAD): el dueño comparte un PI con grupos-de-Mira o correos. */
export interface GroupStore {
  listGroups(): Promise<MiraGroup[]>
  createGroup(id: string, label: string): Promise<void>
  deleteGroup(id: string): Promise<void>
  listMembers(groupId: string): Promise<GroupMember[]>
  isMember(groupId: string, email: string | undefined): Promise<boolean>
  addMember(groupId: string, email: string, addedBy?: string): Promise<boolean>
  removeMember(groupId: string, email: string): Promise<void>
  /** Los grupos de Mira a los que pertenece un correo (para chequeos de ACL). */
  groupsOf(email: string | undefined): Promise<string[]>
}

export interface PiGovernance {
  piCode: string
  visibility: PiVisibility
  createdBy?: string
  createdAt?: string
}
export interface PiDemanda {
  piCode: string
  /** Frescura exigida, ISO-8601 duration (p.ej. `PT1H`, `P1D`, `P1W`). */
  maxAge: string
  updatedBy?: string
  updatedAt?: string
}

/** Gobierno de un PI: visibilidad + ACL (owner/collaborator/viewer) + demanda. Editable in-app. */
export interface PiGovStore {
  /** Crea el registro de gobierno si no existe: visibilidad privada, dueño inicial + colaboradores-default. Idempotente. */
  bootstrapPi(piCode: string, ownerEmail: string, defaultCollaboratorGroups?: string[]): Promise<void>
  getPiGovernance(piCode: string): Promise<PiGovernance | null>
  setVisibility(piCode: string, visibility: PiVisibility): Promise<void>
  listGrants(piCode: string): Promise<PiGrant[]>
  setGrant(piCode: string, principalType: PrincipalType, principal: string, role: PiRole, grantedBy?: string): Promise<void>
  removeGrant(piCode: string, principalType: PrincipalType, principal: string): Promise<void>
  /** Rol efectivo de una identidad sobre un PI (compone visibilidad + grants user/grupo). null = sin acceso. */
  roleFor(piCode: string, email: string | undefined): Promise<PiRole | null>
  getDemanda(piCode: string): Promise<PiDemanda | null>
  setDemanda(piCode: string, maxAge: string, updatedBy?: string): Promise<void>
}

export interface SourceRow {
  id: string
  label: string
  /** Oferta: cada cuánto se actualiza (duración ISO-8601). */
  oferta: string
  /** Dominio al que pertenece la fuente (tag) — define el dominio de las entidades que produce. */
  domain?: string
  connectedBy?: string
  /** true = fila gestionada in-app (la semilla `VERGIS_SOURCES` no la pisa). */
  managed?: boolean
}
/** Referencia al item del motor que ejecuta un proceso — habilita leer run-history y empujar schedule. */
export interface EngineRef {
  /** Workspace del motor (Fabric). */
  workspaceId: string
  /** Item que ejecuta el proceso (pipeline / SJD / notebook). */
  itemId: string
  /** Tipo de job del motor (Fabric: 'Pipeline' | 'sparkjob' | 'RunNotebook'…). */
  jobType: string
}
/** Dónde escribe un proceso sus logs POR CORRIDA (issue #99). El workspace default es el del engine. */
export interface ProcessLogsRef {
  lakehouseId: string
  workspaceId?: string
  /** Default `Files/code/_logs` (RUN_LOG_DIR_DEFAULT). */
  dir?: string
}
export interface ProcessRow {
  id: string
  label: string
  /** Fuente que ingesta este proceso. */
  sourceId: string
  /** Item del motor que lo corre. Ausente = aún no observable (sin run-history ni schedule). */
  engine?: EngineRef
  /** Ubicación de sus logs por corrida. Ausente = el proceso no declara logs (issue #99). */
  logs?: ProcessLogsRef
  /** true = fila gestionada in-app (la semilla `VERGIS_SOURCES` no la pisa). */
  managed?: boolean
  /** Pausa explícita (#107): el lazo no alerta ni reconcilia; el schedule del motor está deshabilitado. */
  pausedAt?: string
  pausedBy?: string
}

/**
 * Registro de fuentes y procesos de ingestión (frente B): oferta + mapeos tabla↔fuente, proceso↔tablas.
 *
 * PRECEDENCIA runtime-sobre-semilla (#107, mismo patrón que los grupos de Mira): una escritura in-app
 * (`managed: true`) marca la fila y el re-sembrado de arranque NO la pisa; una baja deja tombstone y el
 * re-sembrado no resucita el id; un alta in-app posterior del mismo id limpia el tombstone.
 */
export interface SourceRegistryStore {
  /** `managed: true` = escritura in-app: marca `managed_at` y limpia el tombstone. La semilla no lo pasa. */
  upsertSource(id: string, label: string, oferta: string, opts?: { domain?: string; connectedBy?: string; managed?: boolean }): Promise<void>
  listSources(): Promise<SourceRow[]>
  /** Deja tombstone: el re-sembrado no resucita el id. */
  deleteSource(id: string): Promise<void>
  setTableSource(tableRef: string, sourceId: string): Promise<void>
  /** Borra el mapeo tabla→fuente (in-app). */
  deleteTableSource(tableRef: string): Promise<void>
  listTableSources(): Promise<{ tableRef: string; sourceId: string }[]>
  /** Ofertas de las fuentes que producen estas tablas (para el techo de demanda de un PI). */
  ofertasForTables(tableRefs: string[]): Promise<string[]>
  upsertProcess(id: string, label: string, sourceId: string, engine?: EngineRef, logs?: ProcessLogsRef, opts?: { managed?: boolean }): Promise<void>
  listProcesses(): Promise<ProcessRow[]>
  /** Cascadea sus salidas y deja tombstone. */
  deleteProcess(id: string): Promise<void>
  /** Marca/limpia la pausa de un proceso (#107). Sobre un id inexistente: lanza. */
  setProcessPaused(processId: string, paused: boolean, by?: string): Promise<void>
  setProcessOutput(processId: string, tableRef: string): Promise<void>
  removeProcessOutput(processId: string, tableRef: string): Promise<void>
  listProcessOutputs(): Promise<{ processId: string; tableRef: string }[]>
}

/** Settings de plataforma (clave→valor): branding del catálogo, etc. Editables in-app. */
export interface PlatformSettingStore {
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string, updatedBy?: string): Promise<void>
}

/** Sesión de Miranda (el agente que autora specs conversando, cluster 077). */
export interface MirandaSession {
  id: string
  title: string
  state: MirandaSessionState
  createdBy?: string
  /** Código PI-NNN asignado al publicar (null hasta entonces). */
  piCode?: string
  createdAt?: string
  updatedAt?: string
}
/** Un turno de la conversación (o resultado de tool). `content` es JSON serializado. */
export interface MirandaMessage {
  seq: number
  role: MirandaMessageRole
  content: string
  tokens: number
  createdAt?: string
}
/** Artefacto de sesión APPEND-ONLY con versión (procedencia del PI): draft vN nunca pisa vN-1. */
export interface MirandaArtifact {
  kind: MirandaArtifactKind
  version: number
  content: string
  createdAt?: string
}

/**
 * Store de las sesiones de Miranda: sesiones + mensajes + artefactos versionados + la secuencia de
 * códigos PI (semilla 101). ES el ledger/procedencia de los PIs nacidos por chat. Los artefactos son
 * append-only con versión (versionado no destructivo). La máquina de estados se hace cumplir acá:
 * una transición ilegal se rechaza (GovernanceConflict).
 */
export interface MirandaStore {
  createSession(id: string, title: string, createdBy?: string): Promise<MirandaSession>
  getMirandaSession(id: string): Promise<MirandaSession | null>
  listMirandaSessions(createdBy?: string): Promise<MirandaSession[]>
  /** Cambia el estado; rechaza transiciones ilegales (ver miranda-session). */
  setMirandaState(id: string, state: MirandaSessionState): Promise<void>
  setMirandaTitle(id: string, title: string): Promise<void>
  setMirandaPiCode(id: string, piCode: string): Promise<void>
  appendMirandaMessage(sessionId: string, role: MirandaMessageRole, content: string, tokens?: number): Promise<number>
  listMirandaMessages(sessionId: string): Promise<MirandaMessage[]>
  /** Tokens acumulados de la sesión (para el presupuesto). */
  mirandaSessionTokens(sessionId: string): Promise<number>
  /** Añade un artefacto (versión auto-incremental por kind). Devuelve la versión asignada. */
  appendMirandaArtifact(sessionId: string, kind: MirandaArtifactKind, content: string): Promise<number>
  latestMirandaArtifact(sessionId: string, kind: MirandaArtifactKind): Promise<MirandaArtifact | null>
  listMirandaArtifacts(sessionId: string, kind?: MirandaArtifactKind): Promise<MirandaArtifact[]>
  /** Asigna el próximo código PI (secuencia semilla 101) e incrementa. Atómico bajo el lock del db. */
  nextMirandaPiCode(): Promise<number>
}

/**
 * Una CARGA registrada del intake (issue #62). El registro de cargas es estado de gobierno
 * («quién / cuándo / qué entró»), no evidencia encadenada: el audit log sigue recibiendo su evento,
 * pero la consulta —y el dedup por contenido— viven acá, indexados.
 */
export interface IntakeUploadRow {
  id: number
  slotId: string
  filename: string
  /** SHA-256 hex (64, minúsculas) de los bytes: identidad del contenido. El NOMBRE no participa. */
  sha256: string
  bytes: number
  uploadedBy?: string
  uploadedAt: string
  /** false = subida rechazada (validación/metadata): el timeline la muestra igual. */
  ok: boolean
  error?: string
  triggered: boolean
  /** `retro` = fila derivada del indexado retroactivo de `_processed/` (no es un evento vivido). */
  origen: 'upload' | 'retro'
  /** Id de la carga ORIGINAL cuando el contenido es idéntico a una previa del slot. */
  dupOfId?: number
}

/** Registro consultable de las cargas del intake + la marca del indexado retroactivo por slot. */
export interface IntakeUploadStore {
  /** Registra una carga (o su rechazo). Devuelve el id asignado. */
  recordUpload(row: Omit<IntakeUploadRow, 'id'>): Promise<number>
  /** La carga ORIGINAL (ok=1) con ese contenido en el slot: la fila más antigua con ese sha. */
  findUploadBySha(slotId: string, sha256: string): Promise<IntakeUploadRow | null>
  /** Cargas del slot, recientes primero. */
  listUploads(slotId: string, limit: number): Promise<IntakeUploadRow[]>
  /** ¿El indexado retroactivo de `_processed/` del slot ya corrió? */
  intakeBackfillDone(slotId: string): Promise<boolean>
  markIntakeBackfillDone(slotId: string, files: number, errores: number): Promise<void>
}

/**
 * Una REVERSIÓN ejecutada (issue #63). Es un hecho de Vergis —quién revirtió qué, cuándo y con qué
 * resultado por clave—, no del convertidor: el mapeo carga→claves sigue viviendo en `_processed/`.
 * Es la fuente consultable que el timeline muestra; el audit log sigue siendo la evidencia.
 */
export interface IntakeRevertRow {
  id: number
  slotId: string
  /** Ancla a `intake_upload.id` (#62). Ausente si la carga no está en el registro (pre-#62). */
  uploadId?: number
  filename: string
  byUser: string
  /** ISO-8601. */
  at: string
  /** El plan EJECUTADO, con lo reportado-sin-tocar incluido (pisada / no-compensable / sin-clave). */
  resumen: ClaveAccion[]
  landingRetirado: boolean
}

/** Registro consultable de las reversiones de un slot (issue #63). */
export interface IntakeRevertStore {
  /** Registra una reversión COMPLETADA. Devuelve el id asignado. */
  recordRevert(row: Omit<IntakeRevertRow, 'id'>): Promise<number>
  /** Reversiones del slot, recientes primero. */
  listReverts(slotId: string, limit: number): Promise<IntakeRevertRow[]>
}

/** Retención de la proyección de corridas (filas por proceso). Poda el propio store al escribir. */
export const INGESTION_RUN_RETENTION = 60

/** Observación de UN proceso en una vuelta del lazo (#105). Atómica: o trae runs+schedule, o trae error. */
export interface ProcessObservation {
  processId: string
  /** ISO del instante de la observación. */
  observedAt: string
  /** Corridas leídas del motor (con `startedAt` no vacío; las vacías se ignoran al escribir). */
  runs?: RunRecord[]
  /** Schedule leído (segundos; null = el item no tiene). Presente si la observación fue exitosa. */
  scheduleSeconds?: number | null
  /** La observación falló: se registra el error y NO se tocan runs/schedule proyectados. */
  error?: string
}

/** Lo último conocido de un proceso (#105) — el contrato de lectura de Frescura y de la vista transversal. */
export interface IngestionRunSnapshot {
  processId: string
  /** Corridas conocidas, más reciente primero (hasta `runsPerProcess`). */
  runs: RunRecord[]
  /** Schedule observado (null = sin schedule). Solo significativo con observedAt != null. */
  scheduleSeconds: number | null
  /** Última observación exitosa (ISO). null = proyección fría (nunca se observó). */
  observedAt: string | null
  /** Error del intento MÁS RECIENTE si falló; null si el último intento fue exitoso. */
  lastError: string | null
  lastErrorAt: string | null
}

/**
 * Proyección local del historial de corridas + schedule por proceso (issue #105). Es la MEMORIA del
 * producto sobre el motor: el render de Frescura lee de acá y jamás pega al motor en el request path.
 */
export interface IngestionRunStore {
  /** Escritura POR LOTE (un persist). Éxito: upsert de runs por (process_id, started_at) + poda a
   *  INGESTION_RUN_RETENTION + estado (schedule, observed_at, last_error=null). Error: solo
   *  last_error/last_error_at (lo último conocido queda intacto). */
  recordObservations(obs: ProcessObservation[]): Promise<void>
  /** Snapshots de TODOS los procesos con estado o corridas proyectadas. runsPerProcess default 10. */
  listRunSnapshots(opts?: { runsPerProcess?: number }): Promise<IngestionRunSnapshot[]>
}

export interface GovernanceStore extends AdminStore, GroupStore, PiGovStore, SourceRegistryStore, PlatformSettingStore, MirandaStore, IntakeUploadStore, IntakeRevertStore, IngestionRunStore {
  close(): Promise<void>
}

export class GovernanceConflict extends Error {}

const GROUP_DDL = `CREATE TABLE IF NOT EXISTS mira_group (
  group_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  seed INTEGER NOT NULL DEFAULT 0
);`
const MEMBER_DDL = `CREATE TABLE IF NOT EXISTS mira_group_member (
  group_id TEXT NOT NULL,
  email TEXT NOT NULL,
  added_by TEXT,
  added_at TEXT,
  PRIMARY KEY (group_id, email)
);`
// Tombstone de miembros SEMILLA removidos en runtime. Sin esto, `open()` re-siembra en cada restart
// (el INSERT ... ON CONFLICT DO NOTHING re-inserta la fila borrada) → un miembro que un admin quitó
// reaparece. PRECEDENCIA: el runtime gana sobre la config — un `removeMember` deja tombstone y el
// re-sembrado lo salta; un `addMember` posterior lo limpia (readmitir = revocar el tombstone).
const SEED_REMOVED_DDL = `CREATE TABLE IF NOT EXISTS mira_group_seed_removed (
  group_id TEXT NOT NULL,
  email TEXT NOT NULL,
  PRIMARY KEY (group_id, email)
);`
const PI_GOV_DDL = `CREATE TABLE IF NOT EXISTS pi_governance (
  pi_code TEXT PRIMARY KEY,
  visibility TEXT NOT NULL DEFAULT 'privado',
  created_by TEXT,
  created_at TEXT
);`
const PI_GRANT_DDL = `CREATE TABLE IF NOT EXISTS pi_grant (
  pi_code TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal TEXT NOT NULL,
  role TEXT NOT NULL,
  granted_by TEXT,
  granted_at TEXT,
  PRIMARY KEY (pi_code, principal_type, principal)
);`
const PI_DEMANDA_DDL = `CREATE TABLE IF NOT EXISTS pi_demanda (
  pi_code TEXT PRIMARY KEY,
  max_age TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);`
const SETTING_DDL = `CREATE TABLE IF NOT EXISTS platform_setting (
  skey TEXT PRIMARY KEY, svalue TEXT, updated_by TEXT, updated_at TEXT
);`
const SOURCE_DDL = `CREATE TABLE IF NOT EXISTS source (
  source_id TEXT PRIMARY KEY, label TEXT NOT NULL, oferta TEXT NOT NULL, domain TEXT, connected_by TEXT
);`
const TABLE_SOURCE_DDL = `CREATE TABLE IF NOT EXISTS table_source (
  table_ref TEXT PRIMARY KEY, source_id TEXT NOT NULL
);`
// Tombstone del registro de fuentes/procesos (#107). Precedencia runtime-sobre-semilla: una baja in-app
// deja la marca y el re-sembrado de `open()` NO resucita el id; un alta in-app posterior la limpia.
// Tabla PROPIA (no se generaliza la de grupos): dos registros distintos, dos ciclos de vida distintos.
const SOURCE_REMOVED_DDL = `CREATE TABLE IF NOT EXISTS source_registry_removed (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);`
const PROCESS_DDL = `CREATE TABLE IF NOT EXISTS ingestion_process (
  process_id TEXT PRIMARY KEY, label TEXT NOT NULL, source_id TEXT NOT NULL,
  engine_workspace TEXT, engine_item TEXT, engine_job_type TEXT,
  logs_workspace TEXT, logs_lakehouse TEXT, logs_dir TEXT
);`

/** Columnas del `logs:` de un proceso (issue #99), validadas. Lanza si el ref viene sin lakehouse. */
function logsCols(logs: ProcessLogsRef | undefined, processId: string): [string | null, string | null, string | null] {
  if (!logs) return [null, null, null]
  const lh = logs.lakehouseId?.trim() ?? ''
  if (!lh) throw new Error(`logs del proceso '${processId}' requiere lakehouseId.`)
  return [logs.workspaceId?.trim() || null, lh, logs.dir?.trim().replace(/\/+$/, '') || null]
}

/** Agrega columnas faltantes a una tabla existente (migración idempotente para DBs ya creadas). */
function ensureColumns(db: SqlDb, table: string, cols: string[]): void {
  const existing = new Set(selectAll(db, `PRAGMA table_info(${table})`).map((r) => String(r['name'])))
  for (const c of cols) {
    const name = c.split(/\s+/)[0]
    if (!existing.has(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${c}`)
  }
}
const PROCESS_OUTPUT_DDL = `CREATE TABLE IF NOT EXISTS process_output (
  process_id TEXT NOT NULL, table_ref TEXT NOT NULL, PRIMARY KEY (process_id, table_ref)
);`
// ── Miranda (cluster 077): sesiones + mensajes + artefactos versionados + secuencia de códigos PI ──
const MIRANDA_SESSION_DDL = `CREATE TABLE IF NOT EXISTS miranda_session (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'explorando',
  created_by TEXT,
  pi_code TEXT,
  created_at TEXT,
  updated_at TEXT
);`
const MIRANDA_MESSAGE_DDL = `CREATE TABLE IF NOT EXISTS miranda_message (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  PRIMARY KEY (session_id, seq)
);`
const MIRANDA_ARTIFACT_DDL = `CREATE TABLE IF NOT EXISTS miranda_artifact (
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (session_id, kind, version)
);`
// Secuencia de códigos PI de Miranda: una sola fila. `next_code` = el próximo código a asignar
// (semilla 101 — decisión de César 2026-07-14; serie separada de los códigos Jira, sin colisión).
const MIRANDA_SEQ_DDL = `CREATE TABLE IF NOT EXISTS miranda_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_code INTEGER NOT NULL
);`
const MIRANDA_SEQ_SEED = 101
// ── Intake (issue #62): el registro de cargas como tabla de primera clase ──
// `sha256` es la identidad del contenido (el nombre NO participa: las copias llegan «… (1) (1).xlsx»).
// `id` es el ancla estable que el ledger carga→claves de #63 referenciará.
const INTAKE_UPLOAD_DDL = `CREATE TABLE IF NOT EXISTS intake_upload (
  id INTEGER PRIMARY KEY,
  slot_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  triggered INTEGER NOT NULL DEFAULT 0,
  origen TEXT NOT NULL DEFAULT 'upload',
  dup_of INTEGER
);`
const INTAKE_UPLOAD_IDX_SHA = `CREATE INDEX IF NOT EXISTS idx_intake_upload_sha ON intake_upload (slot_id, sha256);`
const INTAKE_UPLOAD_IDX_TS = `CREATE INDEX IF NOT EXISTS idx_intake_upload_slot_ts ON intake_upload (slot_id, uploaded_at DESC);`
// #63 · el registro de REVERSIONES. `by_user` (y no `by`) porque BY es palabra reservada del SQL.
// `resumen` guarda el plan ejecutado como JSON: lo que se compensó Y lo que se reportó sin tocar.
const INTAKE_REVERT_DDL = `CREATE TABLE IF NOT EXISTS intake_revert (
  id INTEGER PRIMARY KEY,
  slot_id TEXT NOT NULL,
  upload_id INTEGER,
  filename TEXT NOT NULL,
  by_user TEXT NOT NULL,
  at TEXT NOT NULL,
  resumen TEXT NOT NULL,
  landing_retirado INTEGER NOT NULL DEFAULT 0
);`
const INTAKE_REVERT_IDX = `CREATE INDEX IF NOT EXISTS idx_intake_revert_slot ON intake_revert (slot_id, at DESC);`
const INTAKE_BACKFILL_DDL = `CREATE TABLE IF NOT EXISTS intake_backfill (
  slot_id TEXT PRIMARY KEY, done_at TEXT NOT NULL, files INTEGER NOT NULL, errores INTEGER NOT NULL
);`
// ── Proyección de ingestión (issue #105): lo último conocido del motor, servible sin tocarlo ──
// La identidad de una corrida es (process_id, started_at): el motor no entrega id de instancia, y
// `started_at` se guarda TAL CUAL lo entrega (misma cadena ISO que usa el enlace al log de #99).
// Su PK compuesta ES el índice de la consulta canónica (igualdad por proceso + orden por started_at).
const INGESTION_RUN_DDL = `CREATE TABLE IF NOT EXISTS ingestion_run (
  process_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (process_id, started_at)
);`
const INGESTION_PROCESS_STATE_DDL = `CREATE TABLE IF NOT EXISTS ingestion_process_state (
  process_id TEXT PRIMARY KEY,
  schedule_seconds INTEGER,
  observed_at TEXT,
  last_error TEXT,
  last_error_at TEXT
);`

export interface GovernanceSeed {
  admins?: string[]
  groups?: GroupSeed[]
  /** Registro de fuentes de la instancia (frente B): fuentes, mapeos tabla→fuente, procesos. */
  sources?: { id: string; label: string; oferta: string; domain?: string; connectedBy?: string }[]
  tableSources?: { tableRef: string; sourceId: string }[]
  processes?: { id: string; label: string; sourceId: string; engine?: EngineRef; logs?: ProcessLogsRef }[]
  processOutputs?: { processId: string; tableRef: string }[]
}

/** Lo que la proyección semilla → store sabe sembrar. `admins` NO entra: su siembra es de arranque. */
export type ReseedSeed = Pick<GovernanceSeed, 'groups' | 'sources' | 'tableSources' | 'processes' | 'processOutputs'>

/**
 * Valida TODA la semilla ANTES de tocar la DB (validate-before-write). En el arranque daba igual —un
 * throw mata el proceso—, pero la MISMA proyección corre en caliente (`reseed`, issue #138·2): una
 * semilla con la fila N inválida no puede dejar escritas las filas 1..N−1. Lanza con el mismo mensaje
 * que lanzaba la validación inline.
 */
function validateSeed(seed: ReseedSeed): void {
  for (const g of seed.groups ?? []) {
    if (!SLUG_RE.test(g.id.trim().toLowerCase())) throw new Error(`governance: id de grupo semilla inválido '${g.id}'.`)
  }
  for (const s of seed.sources ?? []) validateOferta(s.oferta) // duración ISO o `evento`
}

/**
 * La proyección semilla → store: LA MISMA función que corre `open()` al arranque y `reseed()` en
 * caliente. Compartirla es lo que hace imposible que boot y recarga driften (issue #138·2).
 *
 * PRECEDENCIA (#101/#105/#107), heredada sin cambios: el re-sembrado SALTA los ids que una baja
 * in-app dejó tombstoneados, NO pisa las filas gestionadas in-app (`managed_at IS NOT NULL`) y jamás
 * toca `managed_at`; los miembros de grupo entran con `DO NOTHING`. La semilla nunca REMUEVE: el yaml
 * es piso declarativo, no espejo.
 */
function applySeed(db: SqlDb, seed: ReseedSeed): void {
  validateSeed(seed) // TODO validado antes del primer write
  for (const g of seed.groups ?? []) {
    const id = g.id.trim().toLowerCase()
    db.run(`INSERT INTO mira_group (group_id, label, seed) VALUES (?,?,1) ON CONFLICT(group_id) DO UPDATE SET seed=1, label=excluded.label`, [id, g.label])
    for (const m of g.members ?? []) {
      const email = normEmail(m)
      if (!email) continue
      // Salta los que un admin removió en runtime (tombstone): el re-sembrado NO los resucita.
      db.run(
        `INSERT INTO mira_group_member (group_id, email, added_by, added_at)
         SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM mira_group_seed_removed WHERE group_id = ? AND email = ?)
         ON CONFLICT(group_id, email) DO NOTHING`,
        [id, email, 'config:VERGIS_GROUPS', now(), id, email],
      )
    }
  }
  for (const s of seed.sources ?? [])
    db.run(
      `INSERT INTO source (source_id, label, oferta, domain, connected_by)
       SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM source_registry_removed WHERE kind = 'source' AND id = ?)
       ON CONFLICT(source_id) DO UPDATE SET label=excluded.label, oferta=excluded.oferta,
         domain=COALESCE(excluded.domain, source.domain), connected_by=excluded.connected_by
       WHERE source.managed_at IS NULL`,
      [s.id.trim().toLowerCase(), s.label, s.oferta.trim().toUpperCase(), s.domain?.trim().toLowerCase() ?? null, s.connectedBy ?? 'config:VERGIS_SOURCES', s.id.trim().toLowerCase()],
    )
  for (const ts of seed.tableSources ?? [])
    db.run(`INSERT INTO table_source (table_ref, source_id) VALUES (?,?) ON CONFLICT(table_ref) DO UPDATE SET source_id=excluded.source_id`, [ts.tableRef.trim(), ts.sourceId.trim().toLowerCase()])
  for (const p of seed.processes ?? [])
    db.run(
      `INSERT INTO ingestion_process (process_id, label, source_id, engine_workspace, engine_item, engine_job_type, logs_workspace, logs_lakehouse, logs_dir)
       SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM source_registry_removed WHERE kind = 'process' AND id = ?)
       ON CONFLICT(process_id) DO UPDATE SET label=excluded.label, source_id=excluded.source_id,
         engine_workspace=COALESCE(excluded.engine_workspace, ingestion_process.engine_workspace),
         engine_item=COALESCE(excluded.engine_item, ingestion_process.engine_item),
         engine_job_type=COALESCE(excluded.engine_job_type, ingestion_process.engine_job_type),
         logs_workspace=COALESCE(excluded.logs_workspace, ingestion_process.logs_workspace),
         logs_lakehouse=COALESCE(excluded.logs_lakehouse, ingestion_process.logs_lakehouse),
         logs_dir=COALESCE(excluded.logs_dir, ingestion_process.logs_dir)
       WHERE ingestion_process.managed_at IS NULL`,
      [p.id.trim().toLowerCase(), p.label, p.sourceId.trim().toLowerCase(), p.engine?.workspaceId ?? null, p.engine?.itemId ?? null, p.engine?.jobType ?? null, ...logsCols(p.logs, p.id), p.id.trim().toLowerCase()],
    )
  for (const po of seed.processOutputs ?? [])
    db.run(`INSERT INTO process_output (process_id, table_ref) VALUES (?,?) ON CONFLICT(process_id, table_ref) DO NOTHING`, [po.processId.trim().toLowerCase(), po.tableRef.trim()])
}

export class SqliteGovernanceStore implements GovernanceStore {
  private constructor(
    private db: SqlDb,
    private file: string | null,
  ) {}

  static async open(file: string | null, seed: GovernanceSeed = {}): Promise<SqliteGovernanceStore> {
    const db = await openSqliteDb(file)
    ensureAdminTable(db, seed.admins ?? [])
    db.run(GROUP_DDL)
    db.run(MEMBER_DDL)
    db.run(SEED_REMOVED_DDL)
    db.run(PI_GOV_DDL)
    db.run(PI_GRANT_DDL)
    db.run(PI_DEMANDA_DDL)
    db.run(SETTING_DDL)
    db.run(SOURCE_DDL)
    ensureColumns(db, 'source', ['domain TEXT'])
    ensureColumns(db, 'source', ['managed_at TEXT'])
    db.run(TABLE_SOURCE_DDL)
    db.run(SOURCE_REMOVED_DDL)
    db.run(PROCESS_DDL)
    ensureColumns(db, 'ingestion_process', ['engine_workspace TEXT', 'engine_item TEXT', 'engine_job_type TEXT'])
    ensureColumns(db, 'ingestion_process', ['logs_workspace TEXT', 'logs_lakehouse TEXT', 'logs_dir TEXT'])
    ensureColumns(db, 'ingestion_process', ['managed_at TEXT', 'paused_at TEXT', 'paused_by TEXT'])
    db.run(PROCESS_OUTPUT_DDL)
    db.run(MIRANDA_SESSION_DDL)
    db.run(MIRANDA_MESSAGE_DDL)
    db.run(MIRANDA_ARTIFACT_DDL)
    db.run(MIRANDA_SEQ_DDL)
    db.run(INTAKE_UPLOAD_DDL)
    db.run(INTAKE_UPLOAD_IDX_SHA)
    db.run(INTAKE_UPLOAD_IDX_TS)
    db.run(INTAKE_REVERT_DDL)
    db.run(INTAKE_REVERT_IDX)
    db.run(INTAKE_BACKFILL_DDL)
    db.run(INGESTION_RUN_DDL)
    db.run(INGESTION_PROCESS_STATE_DDL)
    // Semilla de la secuencia de códigos PI (idempotente: OR IGNORE no re-siembra si ya existe).
    db.run(`INSERT OR IGNORE INTO miranda_seq (id, next_code) VALUES (1, ?)`, [MIRANDA_SEQ_SEED])
    applySeed(db, seed)
    persistSqliteDb(db, file)
    return new SqliteGovernanceStore(db, file)
  }

  private persist(): void {
    persistSqliteDb(this.db, this.file)
  }

  /**
   * Re-corre la proyección semilla → store EN CALIENTE (issue #138·2): exactamente la misma función
   * que `open()` ejecuta al arranque, con las mismas guardas (`managed_at`, tombstones, `DO NOTHING`
   * de miembros). Idempotente — cambia el CUÁNDO llega la siembra, no el QUÉ siembra.
   *
   * Validate-before-write: una semilla inválida lanza SIN haber escrito una sola fila, para que una
   * recarga rechazada jamás deje el store a medio sembrar.
   */
  async reseed(seed: ReseedSeed): Promise<void> {
    applySeed(this.db, seed)
    this.persist()
  }

  // ── AdminStore (rol admin de plataforma) ──
  async isAdmin(email: string | undefined): Promise<boolean> {
    return adminIsAdmin(this.db, email)
  }
  async list(): Promise<AdminEntry[]> {
    return adminList(this.db)
  }
  async add(email: string, addedBy?: string): Promise<boolean> {
    const added = adminAdd(this.db, email, addedBy)
    if (added) this.persist()
    return added
  }
  async remove(email: string): Promise<void> {
    adminRemove(this.db, email)
    this.persist()
  }

  // ── GroupStore (grupos gestionados por Mira) ──
  async listGroups(): Promise<MiraGroup[]> {
    return selectAll(this.db, `SELECT group_id, label, seed FROM mira_group ORDER BY label ASC`).map((r) => ({
      id: String(r['group_id']),
      label: String(r['label']),
      seed: Boolean(r['seed']),
    }))
  }
  async createGroup(id: string, label: string): Promise<void> {
    const gid = id.trim().toLowerCase()
    if (!SLUG_RE.test(gid)) throw new Error(`Id de grupo inválido '${id}' (esperado [a-z][a-z0-9_-]*).`)
    if (!label.trim()) throw new Error('El grupo necesita un nombre.')
    if (this.groupExists(gid)) throw new GovernanceConflict(`Ya existe un grupo '${gid}'.`)
    this.db.run(`INSERT INTO mira_group (group_id, label, seed) VALUES (?,?,0)`, [gid, label.trim()])
    this.persist()
  }
  async deleteGroup(id: string): Promise<void> {
    const gid = id.trim().toLowerCase()
    this.db.run(`DELETE FROM mira_group_member WHERE group_id = ?`, [gid])
    // Limpiar los grants del grupo: si no, quedan latentes y un grupo recreado con el mismo id
    // haría que sus nuevos miembros hereden silenciosamente los accesos del grupo anterior.
    this.db.run(`DELETE FROM pi_grant WHERE principal_type = 'group' AND principal = ?`, [gid])
    // Limpia los tombstones: un grupo recreado (por semilla o a mano) parte de cero, sin exclusiones viejas.
    this.db.run(`DELETE FROM mira_group_seed_removed WHERE group_id = ?`, [gid])
    this.db.run(`DELETE FROM mira_group WHERE group_id = ?`, [gid])
    this.persist()
  }
  async listMembers(groupId: string): Promise<GroupMember[]> {
    const gid = groupId.trim().toLowerCase()
    const stmt = this.db.prepare(`SELECT email, added_by, added_at FROM mira_group_member WHERE group_id = ? ORDER BY email ASC`)
    stmt.bind([gid])
    const out: GroupMember[] = []
    while (stmt.step()) {
      const r = stmt.getAsObject() as { email: string; added_by?: string; added_at?: string }
      out.push({ email: String(r.email), addedBy: r.added_by ?? undefined, addedAt: r.added_at ?? undefined })
    }
    stmt.free()
    return out
  }
  async isMember(groupId: string, email: string | undefined): Promise<boolean> {
    const e = normEmail(email)
    if (!e) return false
    const stmt = this.db.prepare(`SELECT 1 FROM mira_group_member WHERE group_id = ? AND email = ?`)
    stmt.bind([groupId.trim().toLowerCase(), e])
    const found = stmt.step()
    stmt.free()
    return found
  }
  async addMember(groupId: string, email: string, addedBy?: string): Promise<boolean> {
    const gid = groupId.trim().toLowerCase()
    if (!this.groupExists(gid)) throw new Error(`No existe el grupo '${groupId}'.`)
    const e = normEmail(email)
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error(`Correo inválido: '${email}'.`)
    if (await this.isMember(gid, e)) return false
    this.db.run(`INSERT INTO mira_group_member (group_id, email, added_by, added_at) VALUES (?,?,?,?)`, [gid, e, normEmail(addedBy) || null, now()])
    // Readmitir limpia el tombstone: si vuelve a estar en la config semilla, el re-sembrado ya no lo salta.
    this.db.run(`DELETE FROM mira_group_seed_removed WHERE group_id = ? AND email = ?`, [gid, e])
    this.persist()
    return true
  }
  async removeMember(groupId: string, email: string): Promise<void> {
    const gid = groupId.trim().toLowerCase()
    const e = normEmail(email)
    this.db.run(`DELETE FROM mira_group_member WHERE group_id = ? AND email = ?`, [gid, e])
    // Tombstone: el re-sembrado en `open()` NO debe resucitar a un miembro semilla removido a mano.
    this.db.run(`INSERT INTO mira_group_seed_removed (group_id, email) VALUES (?,?) ON CONFLICT(group_id, email) DO NOTHING`, [gid, e])
    this.persist()
  }
  async groupsOf(email: string | undefined): Promise<string[]> {
    const e = normEmail(email)
    if (!e) return []
    const stmt = this.db.prepare(`SELECT group_id FROM mira_group_member WHERE email = ? ORDER BY group_id ASC`)
    stmt.bind([e])
    const out: string[] = []
    while (stmt.step()) out.push(String((stmt.getAsObject() as { group_id: string }).group_id))
    stmt.free()
    return out
  }

  private groupExists(gid: string): boolean {
    const stmt = this.db.prepare(`SELECT 1 FROM mira_group WHERE group_id = ?`)
    stmt.bind([gid])
    const found = stmt.step()
    stmt.free()
    return found
  }

  // ── PiGovStore (gobierno de cada PI: visibilidad + ACL + demanda) ──
  async bootstrapPi(piCode: string, ownerEmail: string, defaultCollaboratorGroups: string[] = []): Promise<void> {
    const pi = piCode.trim()
    if (!pi) throw new Error('bootstrapPi: pi_code vacío.')
    if (await this.getPiGovernance(pi)) return // idempotente
    const owner = normEmail(ownerEmail)
    // OR IGNORE: idempotente aún si dos requests concurrentes pasan el check-then-act de arriba
    // (el INSERT del segundo no viola la PK ni rompe la idempotencia prometida).
    this.db.run(`INSERT OR IGNORE INTO pi_governance (pi_code, visibility, created_by, created_at) VALUES (?,?,?,?)`, [pi, 'privado', owner || null, now()])
    if (owner) this.writeGrant(pi, 'user', owner, 'owner', 'bootstrap')
    for (const g of defaultCollaboratorGroups) {
      const gid = g.trim().toLowerCase()
      if (gid) this.writeGrant(pi, 'group', gid, 'collaborator', 'bootstrap')
    }
    this.persist()
  }

  async getPiGovernance(piCode: string): Promise<PiGovernance | null> {
    const stmt = this.db.prepare(`SELECT pi_code, visibility, created_by, created_at FROM pi_governance WHERE pi_code = ?`)
    stmt.bind([piCode.trim()])
    if (!stmt.step()) {
      stmt.free()
      return null
    }
    const r = stmt.getAsObject() as { pi_code: string; visibility: string; created_by?: string; created_at?: string }
    stmt.free()
    return { piCode: String(r.pi_code), visibility: r.visibility as PiVisibility, createdBy: r.created_by ?? undefined, createdAt: r.created_at ?? undefined }
  }

  async setVisibility(piCode: string, visibility: PiVisibility): Promise<void> {
    if (visibility !== 'publico' && visibility !== 'privado') throw new Error(`Visibilidad inválida: '${visibility}'.`)
    this.db.run(`UPDATE pi_governance SET visibility = ? WHERE pi_code = ?`, [visibility, piCode.trim()])
    this.persist()
  }

  async listGrants(piCode: string): Promise<PiGrant[]> {
    const stmt = this.db.prepare(`SELECT principal_type, principal, role, granted_by, granted_at FROM pi_grant WHERE pi_code = ? ORDER BY role DESC, principal ASC`)
    stmt.bind([piCode.trim()])
    const out: PiGrant[] = []
    while (stmt.step()) {
      const r = stmt.getAsObject() as { principal_type: string; principal: string; role: string; granted_by?: string; granted_at?: string }
      out.push({ principalType: r.principal_type as PrincipalType, principal: String(r.principal), role: r.role as PiRole, grantedBy: r.granted_by ?? undefined, grantedAt: r.granted_at ?? undefined })
    }
    stmt.free()
    return out
  }

  private writeGrant(piCode: string, principalType: PrincipalType, principal: string, role: PiRole, grantedBy?: string): void {
    this.db.run(
      `INSERT INTO pi_grant (pi_code, principal_type, principal, role, granted_by, granted_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(pi_code, principal_type, principal) DO UPDATE SET role=excluded.role, granted_by=excluded.granted_by, granted_at=excluded.granted_at`,
      [piCode.trim(), principalType, principal, role, normEmail(grantedBy) || grantedBy || null, now()],
    )
  }

  async setGrant(piCode: string, principalType: PrincipalType, principal: string, role: PiRole, grantedBy?: string): Promise<void> {
    if (principalType !== 'user' && principalType !== 'group') throw new Error(`principal_type inválido: '${principalType}'.`)
    if (role !== 'owner' && role !== 'collaborator' && role !== 'viewer') throw new Error(`rol inválido: '${role}'.`)
    const p = principalType === 'user' ? normEmail(principal) : principal.trim().toLowerCase()
    if (!p) throw new Error('Principal vacío.')
    if (principalType === 'user' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p)) throw new Error(`Correo inválido: '${principal}'.`)
    // Grant a grupo inexistente = grant inerte y, combinado con la recreación de un grupo con el mismo
    // id, herencia silenciosa de accesos. Fail-loud.
    if (principalType === 'group' && !this.groupExists(p)) throw new Error(`No existe el grupo '${principal}'.`)
    // Anti-lockout, por la otra puerta: degradar al último dueño a un rol menor lo dejaría sin
    // dueño (mismo caso que `removeGrant` ya impide). Solo aplica si el nuevo rol NO es owner.
    if (role !== 'owner') {
      const grants = await this.listGrants(piCode)
      const current = grants.find((g) => g.principalType === principalType && g.principal === p)
      if (current?.role === 'owner' && grants.filter((g) => g.role === 'owner').length <= 1) {
        throw new GovernanceConflict('No se puede degradar al último dueño del PI.')
      }
    }
    this.writeGrant(piCode, principalType, p, role, grantedBy)
    this.persist()
  }

  async removeGrant(piCode: string, principalType: PrincipalType, principal: string): Promise<void> {
    const p = principalType === 'user' ? normEmail(principal) : principal.trim().toLowerCase()
    // Anti-lockout: no quitar al último dueño de un PI.
    const grants = await this.listGrants(piCode)
    const target = grants.find((g) => g.principalType === principalType && g.principal === p)
    if (target?.role === 'owner' && grants.filter((g) => g.role === 'owner').length <= 1) {
      throw new GovernanceConflict('No se puede quitar al último dueño del PI.')
    }
    this.db.run(`DELETE FROM pi_grant WHERE pi_code = ? AND principal_type = ? AND principal = ?`, [piCode.trim(), principalType, p])
    this.persist()
  }

  async roleFor(piCode: string, email: string | undefined): Promise<PiRole | null> {
    const gov = await this.getPiGovernance(piCode)
    if (!gov) return null // PI no bootstrapeado → default-deny (solo admins lo gestionan, override en el server)
    const grants = await this.listGrants(piCode)
    const groups = await this.groupsOf(email)
    return effectiveRole({ visibility: gov.visibility, grants, email, groups })
  }

  async getDemanda(piCode: string): Promise<PiDemanda | null> {
    const stmt = this.db.prepare(`SELECT pi_code, max_age, updated_by, updated_at FROM pi_demanda WHERE pi_code = ?`)
    stmt.bind([piCode.trim()])
    if (!stmt.step()) {
      stmt.free()
      return null
    }
    const r = stmt.getAsObject() as { pi_code: string; max_age: string; updated_by?: string; updated_at?: string }
    stmt.free()
    return { piCode: String(r.pi_code), maxAge: String(r.max_age), updatedBy: r.updated_by ?? undefined, updatedAt: r.updated_at ?? undefined }
  }

  async setDemanda(piCode: string, maxAge: string, updatedBy?: string): Promise<void> {
    const age = maxAge.trim().toUpperCase()
    // Validar con el MISMO parser que consume la demanda (`durationToSeconds`), no un regex propio:
    // el regex aceptaba 'PT' (que luego revienta durationToSeconds) y 'P0D', y rechazaba 'P1W1D'.
    // El `> 0` cubre tanto el throw como un resultado no positivo (P0D, NaN).
    let seconds: number
    try {
      seconds = durationToSeconds(age)
    } catch {
      throw new Error(`Demanda inválida: '${maxAge}' (use duración ISO-8601, p.ej. PT1H, P1D, P1W).`)
    }
    if (!(seconds > 0)) {
      throw new Error(`Demanda inválida: '${maxAge}' debe ser una duración mayor a cero (p.ej. PT1H, P1D, P1W).`)
    }
    this.db.run(
      `INSERT INTO pi_demanda (pi_code, max_age, updated_by, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(pi_code) DO UPDATE SET max_age=excluded.max_age, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      [piCode.trim(), age, normEmail(updatedBy) || null, now()],
    )
    this.persist()
  }

  // ── SourceRegistryStore (oferta + mapeos, frente B) ──
  async upsertSource(id: string, label: string, oferta: string, opts: { domain?: string; connectedBy?: string; managed?: boolean } = {}): Promise<void> {
    const sid = id.trim().toLowerCase()
    if (!SLUG_RE.test(sid)) throw new Error(`Id de fuente inválido '${id}'.`)
    validateOferta(oferta) // valida la oferta (duración ISO o `evento` para fuentes event-driven)
    // COALESCE en domain: un upsert sin domain no borra el tag ya registrado.
    // `managed_at`: se sella en la escritura in-app y NUNCA se limpia acá (la semilla no llama con managed).
    this.db.run(
      `INSERT INTO source (source_id, label, oferta, domain, connected_by, managed_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(source_id) DO UPDATE SET label=excluded.label, oferta=excluded.oferta,
         domain=COALESCE(excluded.domain, source.domain), connected_by=excluded.connected_by,
         managed_at=COALESCE(excluded.managed_at, source.managed_at)`,
      [sid, label.trim() || sid, oferta.trim().toUpperCase(), opts.domain?.trim().toLowerCase() || null, normEmail(opts.connectedBy) || null, opts.managed ? now() : null],
    )
    // Alta in-app de un id tombstoneado: revoca el tombstone (la fila vuelve a ser semillable/gestionable).
    if (opts.managed) this.db.run(`DELETE FROM source_registry_removed WHERE kind = 'source' AND id = ?`, [sid])
    this.persist()
  }
  async listSources(): Promise<SourceRow[]> {
    return selectAll(this.db, `SELECT source_id, label, oferta, domain, connected_by, managed_at FROM source ORDER BY source_id ASC`).map((r) => ({
      id: String(r['source_id']),
      label: String(r['label']),
      oferta: String(r['oferta']),
      domain: r['domain'] == null ? undefined : String(r['domain']),
      connectedBy: r['connected_by'] == null ? undefined : String(r['connected_by']),
      managed: r['managed_at'] != null,
    }))
  }
  async deleteSource(id: string): Promise<void> {
    const sid = id.trim().toLowerCase()
    this.db.run(`DELETE FROM source WHERE source_id = ?`, [sid])
    // Tombstone: el re-sembrado de `open()` NO resucita una fuente que un admin dio de baja in-app.
    this.db.run(`INSERT OR IGNORE INTO source_registry_removed (kind, id) VALUES ('source', ?)`, [sid])
    this.persist()
  }
  async setTableSource(tableRef: string, sourceId: string): Promise<void> {
    this.db.run(
      `INSERT INTO table_source (table_ref, source_id) VALUES (?,?) ON CONFLICT(table_ref) DO UPDATE SET source_id=excluded.source_id`,
      [tableRef.trim(), sourceId.trim().toLowerCase()],
    )
    this.persist()
  }
  async deleteTableSource(tableRef: string): Promise<void> {
    this.db.run(`DELETE FROM table_source WHERE table_ref = ?`, [tableRef.trim()])
    this.persist()
  }
  async listTableSources(): Promise<{ tableRef: string; sourceId: string }[]> {
    return selectAll(this.db, `SELECT table_ref, source_id FROM table_source ORDER BY table_ref ASC`).map((r) => ({
      tableRef: String(r['table_ref']),
      sourceId: String(r['source_id']),
    }))
  }
  async ofertasForTables(tableRefs: string[]): Promise<string[]> {
    const out: string[] = []
    for (const t of tableRefs) {
      const stmt = this.db.prepare(`SELECT s.oferta FROM table_source ts JOIN source s ON s.source_id = ts.source_id WHERE ts.table_ref = ?`)
      stmt.bind([t.trim()])
      if (stmt.step()) out.push(String((stmt.getAsObject() as { oferta: string }).oferta))
      stmt.free()
    }
    return out
  }
  async upsertProcess(id: string, label: string, sourceId: string, engine?: EngineRef, logs?: ProcessLogsRef, opts: { managed?: boolean } = {}): Promise<void> {
    const pid = id.trim().toLowerCase()
    if (!SLUG_RE.test(pid)) throw new Error(`Id de proceso inválido '${id}'.`)
    if (engine && (!engine.workspaceId?.trim() || !engine.itemId?.trim())) {
      throw new Error(`engine_ref del proceso '${id}' requiere workspaceId e itemId.`)
    }
    // COALESCE: un upsert sin engine (o sin logs) NO borra el ref ya registrado. `paused_at`/`paused_by`
    // NO participan del upsert: editar un proceso pausado no lo des-pausa.
    this.db.run(
      `INSERT INTO ingestion_process (process_id, label, source_id, engine_workspace, engine_item, engine_job_type, logs_workspace, logs_lakehouse, logs_dir, managed_at) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(process_id) DO UPDATE SET label=excluded.label, source_id=excluded.source_id,
         managed_at=COALESCE(excluded.managed_at, ingestion_process.managed_at),
         engine_workspace=COALESCE(excluded.engine_workspace, ingestion_process.engine_workspace),
         engine_item=COALESCE(excluded.engine_item, ingestion_process.engine_item),
         engine_job_type=COALESCE(excluded.engine_job_type, ingestion_process.engine_job_type),
         logs_workspace=COALESCE(excluded.logs_workspace, ingestion_process.logs_workspace),
         logs_lakehouse=COALESCE(excluded.logs_lakehouse, ingestion_process.logs_lakehouse),
         logs_dir=COALESCE(excluded.logs_dir, ingestion_process.logs_dir)`,
      [pid, label.trim() || pid, sourceId.trim().toLowerCase(), engine?.workspaceId?.trim() ?? null, engine?.itemId?.trim() ?? null, engine?.jobType?.trim() || (engine ? 'Pipeline' : null), ...logsCols(logs, id), opts.managed ? now() : null],
    )
    if (opts.managed) this.db.run(`DELETE FROM source_registry_removed WHERE kind = 'process' AND id = ?`, [pid])
    this.persist()
  }
  async listProcesses(): Promise<ProcessRow[]> {
    return selectAll(this.db, `SELECT process_id, label, source_id, engine_workspace, engine_item, engine_job_type, logs_workspace, logs_lakehouse, logs_dir, managed_at, paused_at, paused_by FROM ingestion_process ORDER BY process_id ASC`).map((r) => {
      const row: ProcessRow = { id: String(r['process_id']), label: String(r['label']), sourceId: String(r['source_id']) }
      if (r['engine_workspace'] != null && r['engine_item'] != null) {
        row.engine = {
          workspaceId: String(r['engine_workspace']),
          itemId: String(r['engine_item']),
          jobType: r['engine_job_type'] != null ? String(r['engine_job_type']) : 'Pipeline',
        }
      }
      if (r['logs_lakehouse'] != null) {
        // Los defaults (workspace del engine, dir de convención) los resuelve el consumidor, no el store.
        const logsRef: ProcessLogsRef = { lakehouseId: String(r['logs_lakehouse']) }
        if (r['logs_workspace'] != null) logsRef.workspaceId = String(r['logs_workspace'])
        if (r['logs_dir'] != null) logsRef.dir = String(r['logs_dir'])
        row.logs = logsRef
      }
      if (r['managed_at'] != null) row.managed = true
      if (r['paused_at'] != null) {
        row.pausedAt = String(r['paused_at'])
        if (r['paused_by'] != null) row.pausedBy = String(r['paused_by'])
      }
      return row
    })
  }
  async deleteProcess(id: string): Promise<void> {
    const pid = id.trim().toLowerCase()
    this.db.run(`DELETE FROM process_output WHERE process_id = ?`, [pid])
    this.db.run(`DELETE FROM ingestion_process WHERE process_id = ?`, [pid])
    this.db.run(`INSERT OR IGNORE INTO source_registry_removed (kind, id) VALUES ('process', ?)`, [pid])
    this.persist()
  }
  /** Pausa/reanuda un proceso (#107). La VERDAD de la pausa vive acá; el motor la refleja (D5). */
  async setProcessPaused(processId: string, paused: boolean, by?: string): Promise<void> {
    const pid = processId.trim().toLowerCase()
    const stmt = this.db.prepare(`SELECT 1 FROM ingestion_process WHERE process_id = ?`)
    stmt.bind([pid])
    const existe = stmt.step()
    stmt.free()
    if (!existe) throw new Error(`Proceso desconocido: '${processId}'.`)
    this.db.run(`UPDATE ingestion_process SET paused_at = ?, paused_by = ? WHERE process_id = ?`, [
      paused ? now() : null,
      paused ? normEmail(by) || null : null,
      pid,
    ])
    this.persist()
  }
  async setProcessOutput(processId: string, tableRef: string): Promise<void> {
    this.db.run(`INSERT INTO process_output (process_id, table_ref) VALUES (?,?) ON CONFLICT(process_id, table_ref) DO NOTHING`, [processId.trim().toLowerCase(), tableRef.trim()])
    this.persist()
  }
  async removeProcessOutput(processId: string, tableRef: string): Promise<void> {
    this.db.run(`DELETE FROM process_output WHERE process_id = ? AND table_ref = ?`, [processId.trim().toLowerCase(), tableRef.trim()])
    this.persist()
  }
  async listProcessOutputs(): Promise<{ processId: string; tableRef: string }[]> {
    return selectAll(this.db, `SELECT process_id, table_ref FROM process_output ORDER BY process_id ASC`).map((r) => ({
      processId: String(r['process_id']),
      tableRef: String(r['table_ref']),
    }))
  }

  // ── PlatformSettingStore ──
  async getSetting(key: string): Promise<string | null> {
    const stmt = this.db.prepare(`SELECT svalue FROM platform_setting WHERE skey = ?`)
    stmt.bind([key])
    const v = stmt.step() ? String((stmt.getAsObject() as { svalue: string }).svalue) : null
    stmt.free()
    return v
  }
  async setSetting(key: string, value: string, updatedBy?: string): Promise<void> {
    this.db.run(
      `INSERT INTO platform_setting (skey, svalue, updated_by, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(skey) DO UPDATE SET svalue=excluded.svalue, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      [key, value, normEmail(updatedBy) || null, now()],
    )
    this.persist()
  }

  // ── MirandaStore (sesiones del agente que autora specs, cluster 077) ──
  private mirandaSessionRow(r: Record<string, unknown>): MirandaSession {
    return {
      id: String(r['id']),
      title: String(r['title']),
      state: String(r['state']) as MirandaSessionState,
      createdBy: r['created_by'] == null ? undefined : String(r['created_by']),
      piCode: r['pi_code'] == null ? undefined : String(r['pi_code']),
      createdAt: r['created_at'] == null ? undefined : String(r['created_at']),
      updatedAt: r['updated_at'] == null ? undefined : String(r['updated_at']),
    }
  }

  async createSession(id: string, title: string, createdBy?: string): Promise<MirandaSession> {
    const sid = id.trim()
    if (!sid) throw new Error('createSession: id vacío.')
    if (await this.getMirandaSession(sid)) throw new GovernanceConflict(`Ya existe una sesión de Miranda '${sid}'.`)
    const ts = now()
    this.db.run(`INSERT INTO miranda_session (id, title, state, created_by, pi_code, created_at, updated_at) VALUES (?,?,?,?,NULL,?,?)`, [
      sid,
      title.trim() || 'Sesión sin título',
      'explorando',
      normEmail(createdBy) || null,
      ts,
      ts,
    ])
    this.persist()
    return { id: sid, title: title.trim() || 'Sesión sin título', state: 'explorando', createdBy: normEmail(createdBy) || undefined, createdAt: ts, updatedAt: ts }
  }

  async getMirandaSession(id: string): Promise<MirandaSession | null> {
    const stmt = this.db.prepare(`SELECT id, title, state, created_by, pi_code, created_at, updated_at FROM miranda_session WHERE id = ?`)
    stmt.bind([id.trim()])
    if (!stmt.step()) {
      stmt.free()
      return null
    }
    const r = stmt.getAsObject()
    stmt.free()
    return this.mirandaSessionRow(r)
  }

  async listMirandaSessions(createdBy?: string): Promise<MirandaSession[]> {
    const by = normEmail(createdBy)
    const rows = by
      ? (() => {
          const stmt = this.db.prepare(`SELECT id, title, state, created_by, pi_code, created_at, updated_at FROM miranda_session WHERE created_by = ? ORDER BY updated_at DESC`)
          stmt.bind([by])
          const out: Record<string, unknown>[] = []
          while (stmt.step()) out.push(stmt.getAsObject())
          stmt.free()
          return out
        })()
      : selectAll(this.db, `SELECT id, title, state, created_by, pi_code, created_at, updated_at FROM miranda_session ORDER BY updated_at DESC`)
    return rows.map((r) => this.mirandaSessionRow(r))
  }

  async setMirandaState(id: string, state: MirandaSessionState): Promise<void> {
    if (!isMirandaState(state)) throw new Error(`Estado de Miranda inválido: '${state}'.`)
    const s = await this.getMirandaSession(id)
    if (!s) throw new Error(`No existe la sesión de Miranda '${id}'.`)
    if (s.state === state) return // no-op (self-loop trivial)
    if (!canTransition(s.state, state)) {
      throw new GovernanceConflict(`Transición ilegal de sesión Miranda: ${s.state} → ${state}.`)
    }
    this.db.run(`UPDATE miranda_session SET state = ?, updated_at = ? WHERE id = ?`, [state, now(), id.trim()])
    this.persist()
  }

  async setMirandaTitle(id: string, title: string): Promise<void> {
    this.db.run(`UPDATE miranda_session SET title = ?, updated_at = ? WHERE id = ?`, [title.trim() || 'Sesión sin título', now(), id.trim()])
    this.persist()
  }

  async setMirandaPiCode(id: string, piCode: string): Promise<void> {
    this.db.run(`UPDATE miranda_session SET pi_code = ?, updated_at = ? WHERE id = ?`, [piCode.trim(), now(), id.trim()])
    this.persist()
  }

  async appendMirandaMessage(sessionId: string, role: MirandaMessageRole, content: string, tokens = 0): Promise<number> {
    const sid = sessionId.trim()
    const seq = this.nextSeq(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM miranda_message WHERE session_id = ?`, sid)
    this.db.run(`INSERT INTO miranda_message (session_id, seq, role, content, tokens, created_at) VALUES (?,?,?,?,?,?)`, [sid, seq, role, content, Math.max(0, Math.trunc(tokens)), now()])
    this.db.run(`UPDATE miranda_session SET updated_at = ? WHERE id = ?`, [now(), sid])
    this.persist()
    return seq
  }

  async listMirandaMessages(sessionId: string): Promise<MirandaMessage[]> {
    const stmt = this.db.prepare(`SELECT seq, role, content, tokens, created_at FROM miranda_message WHERE session_id = ? ORDER BY seq ASC`)
    stmt.bind([sessionId.trim()])
    const out: MirandaMessage[] = []
    while (stmt.step()) {
      const r = stmt.getAsObject()
      out.push({ seq: Number(r['seq']), role: String(r['role']) as MirandaMessageRole, content: String(r['content']), tokens: Number(r['tokens'] ?? 0), createdAt: r['created_at'] == null ? undefined : String(r['created_at']) })
    }
    stmt.free()
    return out
  }

  async mirandaSessionTokens(sessionId: string): Promise<number> {
    const stmt = this.db.prepare(`SELECT COALESCE(SUM(tokens), 0) AS n FROM miranda_message WHERE session_id = ?`)
    stmt.bind([sessionId.trim()])
    stmt.step()
    const n = Number((stmt.getAsObject() as { n: number }).n ?? 0)
    stmt.free()
    return n
  }

  async appendMirandaArtifact(sessionId: string, kind: MirandaArtifactKind, content: string): Promise<number> {
    const sid = sessionId.trim()
    const stmt = this.db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS n FROM miranda_artifact WHERE session_id = ? AND kind = ?`)
    stmt.bind([sid, kind])
    stmt.step()
    const version = Number((stmt.getAsObject() as { n: number }).n)
    stmt.free()
    this.db.run(`INSERT INTO miranda_artifact (session_id, kind, version, content, created_at) VALUES (?,?,?,?,?)`, [sid, kind, version, content, now()])
    this.db.run(`UPDATE miranda_session SET updated_at = ? WHERE id = ?`, [now(), sid])
    this.persist()
    return version
  }

  async latestMirandaArtifact(sessionId: string, kind: MirandaArtifactKind): Promise<MirandaArtifact | null> {
    const stmt = this.db.prepare(`SELECT kind, version, content, created_at FROM miranda_artifact WHERE session_id = ? AND kind = ? ORDER BY version DESC LIMIT 1`)
    stmt.bind([sessionId.trim(), kind])
    if (!stmt.step()) {
      stmt.free()
      return null
    }
    const r = stmt.getAsObject()
    stmt.free()
    return { kind: String(r['kind']) as MirandaArtifactKind, version: Number(r['version']), content: String(r['content']), createdAt: r['created_at'] == null ? undefined : String(r['created_at']) }
  }

  async listMirandaArtifacts(sessionId: string, kind?: MirandaArtifactKind): Promise<MirandaArtifact[]> {
    const stmt = kind
      ? this.db.prepare(`SELECT kind, version, content, created_at FROM miranda_artifact WHERE session_id = ? AND kind = ? ORDER BY kind ASC, version ASC`)
      : this.db.prepare(`SELECT kind, version, content, created_at FROM miranda_artifact WHERE session_id = ? ORDER BY kind ASC, version ASC`)
    stmt.bind(kind ? [sessionId.trim(), kind] : [sessionId.trim()])
    const out: MirandaArtifact[] = []
    while (stmt.step()) {
      const r = stmt.getAsObject()
      out.push({ kind: String(r['kind']) as MirandaArtifactKind, version: Number(r['version']), content: String(r['content']), createdAt: r['created_at'] == null ? undefined : String(r['created_at']) })
    }
    stmt.free()
    return out
  }

  async nextMirandaPiCode(): Promise<number> {
    const stmt = this.db.prepare(`SELECT next_code FROM miranda_seq WHERE id = 1`)
    stmt.step()
    const assigned = Number((stmt.getAsObject() as { next_code: number }).next_code)
    stmt.free()
    this.db.run(`UPDATE miranda_seq SET next_code = next_code + 1 WHERE id = 1`)
    this.persist()
    return assigned
  }

  // ── IntakeUploadStore (registro de cargas + dedup por contenido, issue #62) ──
  private intakeUploadRow(r: Record<string, unknown>): IntakeUploadRow {
    const row: IntakeUploadRow = {
      id: Number(r['id']),
      slotId: String(r['slot_id']),
      filename: String(r['filename']),
      sha256: String(r['sha256']),
      bytes: Number(r['bytes']),
      uploadedAt: String(r['uploaded_at']),
      ok: Number(r['ok']) !== 0,
      triggered: Number(r['triggered']) !== 0,
      origen: String(r['origen']) === 'retro' ? 'retro' : 'upload',
    }
    if (r['uploaded_by'] != null) row.uploadedBy = String(r['uploaded_by'])
    if (r['error'] != null) row.error = String(r['error'])
    if (r['dup_of'] != null) row.dupOfId = Number(r['dup_of'])
    return row
  }

  private static readonly INTAKE_COLS = `id, slot_id, filename, sha256, bytes, uploaded_by, uploaded_at, ok, error, triggered, origen, dup_of`

  async recordUpload(row: Omit<IntakeUploadRow, 'id'>): Promise<number> {
    this.db.run(
      `INSERT INTO intake_upload (slot_id, filename, sha256, bytes, uploaded_by, uploaded_at, ok, error, triggered, origen, dup_of)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.slotId.trim(),
        row.filename,
        row.sha256.trim().toLowerCase(),
        Math.max(0, Math.trunc(row.bytes)),
        row.uploadedBy ?? null,
        row.uploadedAt || now(),
        row.ok ? 1 : 0,
        row.error ?? null,
        row.triggered ? 1 : 0,
        row.origen === 'retro' ? 'retro' : 'upload',
        row.dupOfId ?? null,
      ],
    )
    const stmt = this.db.prepare(`SELECT MAX(id) AS n FROM intake_upload`)
    stmt.step()
    const id = Number((stmt.getAsObject() as { n: number }).n)
    stmt.free()
    this.persist()
    return id
  }

  async findUploadBySha(slotId: string, sha256: string): Promise<IntakeUploadRow | null> {
    // La ORIGINAL = la más antigua ok=1 con ese contenido: es la que el aviso cita («idéntico a X»).
    const stmt = this.db.prepare(
      `SELECT ${SqliteGovernanceStore.INTAKE_COLS} FROM intake_upload
       WHERE slot_id = ? AND sha256 = ? AND ok = 1 ORDER BY uploaded_at ASC, id ASC LIMIT 1`,
    )
    stmt.bind([slotId.trim(), sha256.trim().toLowerCase()])
    if (!stmt.step()) {
      stmt.free()
      return null
    }
    const r = stmt.getAsObject()
    stmt.free()
    return this.intakeUploadRow(r)
  }

  async listUploads(slotId: string, limit: number): Promise<IntakeUploadRow[]> {
    const stmt = this.db.prepare(
      `SELECT ${SqliteGovernanceStore.INTAKE_COLS} FROM intake_upload
       WHERE slot_id = ? ORDER BY uploaded_at DESC, id DESC LIMIT ?`,
    )
    stmt.bind([slotId.trim(), Math.max(0, Math.trunc(limit))])
    const out: IntakeUploadRow[] = []
    while (stmt.step()) out.push(this.intakeUploadRow(stmt.getAsObject()))
    stmt.free()
    return out
  }

  async intakeBackfillDone(slotId: string): Promise<boolean> {
    const stmt = this.db.prepare(`SELECT 1 FROM intake_backfill WHERE slot_id = ?`)
    stmt.bind([slotId.trim()])
    const found = stmt.step()
    stmt.free()
    return found
  }

  async markIntakeBackfillDone(slotId: string, files: number, errores: number): Promise<void> {
    this.db.run(
      `INSERT INTO intake_backfill (slot_id, done_at, files, errores) VALUES (?,?,?,?)
       ON CONFLICT(slot_id) DO UPDATE SET done_at=excluded.done_at, files=excluded.files, errores=excluded.errores`,
      [slotId.trim(), now(), Math.max(0, Math.trunc(files)), Math.max(0, Math.trunc(errores))],
    )
    this.persist()
  }

  // ── IntakeRevertStore (registro de reversiones, issue #63) ──
  async recordRevert(row: Omit<IntakeRevertRow, 'id'>): Promise<number> {
    this.db.run(
      `INSERT INTO intake_revert (slot_id, upload_id, filename, by_user, at, resumen, landing_retirado)
       VALUES (?,?,?,?,?,?,?)`,
      [
        row.slotId.trim(),
        row.uploadId ?? null,
        row.filename,
        row.byUser,
        row.at || now(),
        JSON.stringify(row.resumen ?? []),
        row.landingRetirado ? 1 : 0,
      ],
    )
    const stmt = this.db.prepare(`SELECT MAX(id) AS n FROM intake_revert`)
    stmt.step()
    const id = Number((stmt.getAsObject() as { n: number }).n)
    stmt.free()
    this.persist()
    return id
  }

  async listReverts(slotId: string, limit: number): Promise<IntakeRevertRow[]> {
    const stmt = this.db.prepare(
      `SELECT id, slot_id, upload_id, filename, by_user, at, resumen, landing_retirado FROM intake_revert
       WHERE slot_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
    )
    stmt.bind([slotId.trim(), Math.max(0, Math.trunc(limit))])
    const out: IntakeRevertRow[] = []
    while (stmt.step()) {
      const r = stmt.getAsObject()
      // Un `resumen` ilegible no puede tumbar la consulta: la fila vale igual por su quién/cuándo.
      let resumen: ClaveAccion[] = []
      try { resumen = JSON.parse(String(r['resumen'])) as ClaveAccion[] } catch { resumen = [] }
      const row: IntakeRevertRow = {
        id: Number(r['id']),
        slotId: String(r['slot_id']),
        filename: String(r['filename']),
        byUser: String(r['by_user']),
        at: String(r['at']),
        resumen: Array.isArray(resumen) ? resumen : [],
        landingRetirado: Number(r['landing_retirado']) !== 0,
      }
      if (r['upload_id'] != null) row.uploadId = Number(r['upload_id'])
      out.push(row)
    }
    stmt.free()
    return out
  }

  // ── IngestionRunStore (proyección de corridas + schedule observado, issue #105) ──
  /** Poda las corridas del proceso a las `INGESTION_RUN_RETENTION` más nuevas. `started_at` es único
   *  por proceso (es parte de la PK), así que el corte por el N-ésimo no puede llevarse empates. */
  private pruneRuns(processId: string): void {
    const stmt = this.db.prepare(
      `SELECT started_at FROM ingestion_run WHERE process_id = ? ORDER BY started_at DESC LIMIT 1 OFFSET ?`,
    )
    stmt.bind([processId, INGESTION_RUN_RETENTION - 1])
    const cutoff = stmt.step() ? String((stmt.getAsObject() as { started_at: string }).started_at) : null
    stmt.free()
    if (cutoff != null) this.db.run(`DELETE FROM ingestion_run WHERE process_id = ? AND started_at < ?`, [processId, cutoff])
  }

  async recordObservations(obs: ProcessObservation[]): Promise<void> {
    if (!obs.length) return
    for (const o of obs) {
      const pid = o.processId.trim()
      if (!pid) continue
      if (o.error != null) {
        // Falló: SOLO se marca el error. Runs y schedule proyectados quedan intactos — la proyección
        // sirve lo último conocido, nunca fabrica un vacío por un motor que no respondió.
        this.db.run(
          `INSERT INTO ingestion_process_state (process_id, schedule_seconds, observed_at, last_error, last_error_at)
           VALUES (?, NULL, NULL, ?, ?)
           ON CONFLICT(process_id) DO UPDATE SET last_error=excluded.last_error, last_error_at=excluded.last_error_at`,
          [pid, o.error, o.observedAt],
        )
        continue
      }
      let escritas = 0
      for (const r of o.runs ?? []) {
        if (!r.startedAt) continue // sin clave posible: el motor no siempre entrega startTimeUtc
        this.db.run(
          `INSERT INTO ingestion_run (process_id, started_at, ended_at, status, error) VALUES (?,?,?,?,?)
           ON CONFLICT(process_id, started_at) DO UPDATE SET ended_at=excluded.ended_at, status=excluded.status, error=excluded.error`,
          [pid, r.startedAt, r.endedAt ?? null, r.status, r.error ?? null],
        )
        escritas++
      }
      if (escritas) this.pruneRuns(pid)
      this.db.run(
        `INSERT INTO ingestion_process_state (process_id, schedule_seconds, observed_at, last_error, last_error_at)
         VALUES (?,?,?,NULL,NULL)
         ON CONFLICT(process_id) DO UPDATE SET schedule_seconds=excluded.schedule_seconds,
           observed_at=excluded.observed_at, last_error=NULL, last_error_at=NULL`,
        [pid, o.scheduleSeconds ?? null, o.observedAt],
      )
    }
    // UN persist por lote: el store vuelca el ARCHIVO COMPLETO en cada persist (sqlite.ts) — persistir
    // por proceso multiplicaría el costo de la vuelta del lazo por la cantidad de procesos.
    this.persist()
  }

  async listRunSnapshots(opts?: { runsPerProcess?: number }): Promise<IngestionRunSnapshot[]> {
    const top = Math.max(0, Math.trunc(opts?.runsPerProcess ?? 10))
    const state = new Map<string, { scheduleSeconds: number | null; observedAt: string | null; lastError: string | null; lastErrorAt: string | null }>()
    for (const r of selectAll(this.db, `SELECT process_id, schedule_seconds, observed_at, last_error, last_error_at FROM ingestion_process_state`)) {
      state.set(String(r['process_id']), {
        scheduleSeconds: r['schedule_seconds'] == null ? null : Number(r['schedule_seconds']),
        observedAt: r['observed_at'] == null ? null : String(r['observed_at']),
        lastError: r['last_error'] == null ? null : String(r['last_error']),
        lastErrorAt: r['last_error_at'] == null ? null : String(r['last_error_at']),
      })
    }
    // Fail-safe: un proceso con corridas pero sin fila de estado no debería existir; si existe, sale
    // como proyección fría en vez de desaparecer del listado.
    const ids = new Set(state.keys())
    for (const r of selectAll(this.db, `SELECT DISTINCT process_id FROM ingestion_run`)) ids.add(String(r['process_id']))
    const out: IngestionRunSnapshot[] = []
    for (const pid of [...ids].sort()) {
      const runs: RunRecord[] = []
      if (top > 0) {
        const stmt = this.db.prepare(
          `SELECT started_at, ended_at, status, error FROM ingestion_run WHERE process_id = ? ORDER BY started_at DESC LIMIT ?`,
        )
        stmt.bind([pid, top])
        while (stmt.step()) {
          const r = stmt.getAsObject() as { started_at: string; ended_at?: string | null; status: string; error?: string | null }
          const run: RunRecord = { startedAt: String(r.started_at), status: String(r.status) as RunStatus }
          if (r.ended_at != null) run.endedAt = String(r.ended_at)
          if (r.error != null) run.error = String(r.error)
          runs.push(run)
        }
        stmt.free()
      }
      const s = state.get(pid)
      out.push({
        processId: pid,
        runs,
        scheduleSeconds: s?.scheduleSeconds ?? null,
        observedAt: s?.observedAt ?? null,
        lastError: s?.lastError ?? null,
        lastErrorAt: s?.lastErrorAt ?? null,
      })
    }
    return out
  }

  /** Próximo entero de una secuencia MAX+1 con parámetro (helper de appendMirandaMessage). */
  private nextSeq(sql: string, param: string): number {
    const stmt = this.db.prepare(sql)
    stmt.bind([param])
    stmt.step()
    const n = Number((stmt.getAsObject() as { n: number }).n)
    stmt.free()
    return n
  }

  async close(): Promise<void> {
    this.persist()
    this.db.close()
  }
}
