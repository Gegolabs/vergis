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
import { durationToSeconds } from './freshness'

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
export interface ProcessRow {
  id: string
  label: string
  /** Fuente que ingesta este proceso. */
  sourceId: string
  /** Item del motor que lo corre. Ausente = aún no observable (sin run-history ni schedule). */
  engine?: EngineRef
}

/** Registro de fuentes y procesos de ingestión (frente B): oferta + mapeos tabla↔fuente, proceso↔tablas. */
export interface SourceRegistryStore {
  upsertSource(id: string, label: string, oferta: string, opts?: { domain?: string; connectedBy?: string }): Promise<void>
  listSources(): Promise<SourceRow[]>
  deleteSource(id: string): Promise<void>
  setTableSource(tableRef: string, sourceId: string): Promise<void>
  listTableSources(): Promise<{ tableRef: string; sourceId: string }[]>
  /** Ofertas de las fuentes que producen estas tablas (para el techo de demanda de un PI). */
  ofertasForTables(tableRefs: string[]): Promise<string[]>
  upsertProcess(id: string, label: string, sourceId: string, engine?: EngineRef): Promise<void>
  listProcesses(): Promise<ProcessRow[]>
  deleteProcess(id: string): Promise<void>
  setProcessOutput(processId: string, tableRef: string): Promise<void>
  removeProcessOutput(processId: string, tableRef: string): Promise<void>
  listProcessOutputs(): Promise<{ processId: string; tableRef: string }[]>
}

/** Settings de plataforma (clave→valor): branding del catálogo, etc. Editables in-app. */
export interface PlatformSettingStore {
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string, updatedBy?: string): Promise<void>
}

export interface GovernanceStore extends AdminStore, GroupStore, PiGovStore, SourceRegistryStore, PlatformSettingStore {
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
const PROCESS_DDL = `CREATE TABLE IF NOT EXISTS ingestion_process (
  process_id TEXT PRIMARY KEY, label TEXT NOT NULL, source_id TEXT NOT NULL,
  engine_workspace TEXT, engine_item TEXT, engine_job_type TEXT
);`

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

export interface GovernanceSeed {
  admins?: string[]
  groups?: GroupSeed[]
  /** Registro de fuentes de la instancia (frente B): fuentes, mapeos tabla→fuente, procesos. */
  sources?: { id: string; label: string; oferta: string; domain?: string; connectedBy?: string }[]
  tableSources?: { tableRef: string; sourceId: string }[]
  processes?: { id: string; label: string; sourceId: string; engine?: EngineRef }[]
  processOutputs?: { processId: string; tableRef: string }[]
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
    db.run(PI_GOV_DDL)
    db.run(PI_GRANT_DDL)
    db.run(PI_DEMANDA_DDL)
    db.run(SETTING_DDL)
    db.run(SOURCE_DDL)
    ensureColumns(db, 'source', ['domain TEXT'])
    db.run(TABLE_SOURCE_DDL)
    db.run(PROCESS_DDL)
    ensureColumns(db, 'ingestion_process', ['engine_workspace TEXT', 'engine_item TEXT', 'engine_job_type TEXT'])
    db.run(PROCESS_OUTPUT_DDL)
    for (const g of seed.groups ?? []) {
      const id = g.id.trim().toLowerCase()
      if (!SLUG_RE.test(id)) throw new Error(`governance: id de grupo semilla inválido '${g.id}'.`)
      db.run(`INSERT INTO mira_group (group_id, label, seed) VALUES (?,?,1) ON CONFLICT(group_id) DO UPDATE SET seed=1, label=excluded.label`, [id, g.label])
      for (const m of g.members ?? []) {
        const email = normEmail(m)
        if (!email) continue
        db.run(
          `INSERT INTO mira_group_member (group_id, email, added_by, added_at) VALUES (?,?,?,?)
           ON CONFLICT(group_id, email) DO NOTHING`,
          [id, email, 'config:VERGIS_GROUPS', now()],
        )
      }
    }
    // Semilla del registro de fuentes (instancia)
    for (const s of seed.sources ?? []) {
      durationToSeconds(s.oferta) // valida
      db.run(
        `INSERT INTO source (source_id, label, oferta, domain, connected_by) VALUES (?,?,?,?,?)
         ON CONFLICT(source_id) DO UPDATE SET label=excluded.label, oferta=excluded.oferta,
           domain=COALESCE(excluded.domain, source.domain), connected_by=excluded.connected_by`,
        [s.id.trim().toLowerCase(), s.label, s.oferta.trim().toUpperCase(), s.domain?.trim().toLowerCase() ?? null, s.connectedBy ?? 'config:VERGIS_SOURCES'],
      )
    }
    for (const ts of seed.tableSources ?? [])
      db.run(`INSERT INTO table_source (table_ref, source_id) VALUES (?,?) ON CONFLICT(table_ref) DO UPDATE SET source_id=excluded.source_id`, [ts.tableRef.trim(), ts.sourceId.trim().toLowerCase()])
    for (const p of seed.processes ?? [])
      db.run(
        `INSERT INTO ingestion_process (process_id, label, source_id, engine_workspace, engine_item, engine_job_type) VALUES (?,?,?,?,?,?)
         ON CONFLICT(process_id) DO UPDATE SET label=excluded.label, source_id=excluded.source_id,
           engine_workspace=COALESCE(excluded.engine_workspace, ingestion_process.engine_workspace),
           engine_item=COALESCE(excluded.engine_item, ingestion_process.engine_item),
           engine_job_type=COALESCE(excluded.engine_job_type, ingestion_process.engine_job_type)`,
        [p.id.trim().toLowerCase(), p.label, p.sourceId.trim().toLowerCase(), p.engine?.workspaceId ?? null, p.engine?.itemId ?? null, p.engine?.jobType ?? null],
      )
    for (const po of seed.processOutputs ?? [])
      db.run(`INSERT INTO process_output (process_id, table_ref) VALUES (?,?) ON CONFLICT(process_id, table_ref) DO NOTHING`, [po.processId.trim().toLowerCase(), po.tableRef.trim()])
    persistSqliteDb(db, file)
    return new SqliteGovernanceStore(db, file)
  }

  private persist(): void {
    persistSqliteDb(this.db, this.file)
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
    this.persist()
    return true
  }
  async removeMember(groupId: string, email: string): Promise<void> {
    this.db.run(`DELETE FROM mira_group_member WHERE group_id = ? AND email = ?`, [groupId.trim().toLowerCase(), normEmail(email)])
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
    this.db.run(`INSERT INTO pi_governance (pi_code, visibility, created_by, created_at) VALUES (?,?,?,?)`, [pi, 'privado', owner || null, now()])
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
    if (!/^P(?:\d+W|(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/.test(age) || age === 'P') {
      throw new Error(`Demanda inválida: '${maxAge}' (use duración ISO-8601, p.ej. PT1H, P1D, P1W).`)
    }
    this.db.run(
      `INSERT INTO pi_demanda (pi_code, max_age, updated_by, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(pi_code) DO UPDATE SET max_age=excluded.max_age, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      [piCode.trim(), age, normEmail(updatedBy) || null, now()],
    )
    this.persist()
  }

  // ── SourceRegistryStore (oferta + mapeos, frente B) ──
  async upsertSource(id: string, label: string, oferta: string, opts: { domain?: string; connectedBy?: string } = {}): Promise<void> {
    const sid = id.trim().toLowerCase()
    if (!SLUG_RE.test(sid)) throw new Error(`Id de fuente inválido '${id}'.`)
    durationToSeconds(oferta) // valida la oferta como duración ISO
    // COALESCE en domain: un upsert sin domain no borra el tag ya registrado.
    this.db.run(
      `INSERT INTO source (source_id, label, oferta, domain, connected_by) VALUES (?,?,?,?,?)
       ON CONFLICT(source_id) DO UPDATE SET label=excluded.label, oferta=excluded.oferta,
         domain=COALESCE(excluded.domain, source.domain), connected_by=excluded.connected_by`,
      [sid, label.trim() || sid, oferta.trim().toUpperCase(), opts.domain?.trim().toLowerCase() || null, normEmail(opts.connectedBy) || null],
    )
    this.persist()
  }
  async listSources(): Promise<SourceRow[]> {
    return selectAll(this.db, `SELECT source_id, label, oferta, domain, connected_by FROM source ORDER BY source_id ASC`).map((r) => ({
      id: String(r['source_id']),
      label: String(r['label']),
      oferta: String(r['oferta']),
      domain: r['domain'] == null ? undefined : String(r['domain']),
      connectedBy: r['connected_by'] == null ? undefined : String(r['connected_by']),
    }))
  }
  async deleteSource(id: string): Promise<void> {
    this.db.run(`DELETE FROM source WHERE source_id = ?`, [id.trim().toLowerCase()])
    this.persist()
  }
  async setTableSource(tableRef: string, sourceId: string): Promise<void> {
    this.db.run(
      `INSERT INTO table_source (table_ref, source_id) VALUES (?,?) ON CONFLICT(table_ref) DO UPDATE SET source_id=excluded.source_id`,
      [tableRef.trim(), sourceId.trim().toLowerCase()],
    )
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
  async upsertProcess(id: string, label: string, sourceId: string, engine?: EngineRef): Promise<void> {
    const pid = id.trim().toLowerCase()
    if (!SLUG_RE.test(pid)) throw new Error(`Id de proceso inválido '${id}'.`)
    if (engine && (!engine.workspaceId?.trim() || !engine.itemId?.trim())) {
      throw new Error(`engine_ref del proceso '${id}' requiere workspaceId e itemId.`)
    }
    // COALESCE: un upsert sin engine NO borra el engine ya registrado (preserva el ref existente).
    this.db.run(
      `INSERT INTO ingestion_process (process_id, label, source_id, engine_workspace, engine_item, engine_job_type) VALUES (?,?,?,?,?,?)
       ON CONFLICT(process_id) DO UPDATE SET label=excluded.label, source_id=excluded.source_id,
         engine_workspace=COALESCE(excluded.engine_workspace, ingestion_process.engine_workspace),
         engine_item=COALESCE(excluded.engine_item, ingestion_process.engine_item),
         engine_job_type=COALESCE(excluded.engine_job_type, ingestion_process.engine_job_type)`,
      [pid, label.trim() || pid, sourceId.trim().toLowerCase(), engine?.workspaceId?.trim() ?? null, engine?.itemId?.trim() ?? null, engine?.jobType?.trim() || (engine ? 'Pipeline' : null)],
    )
    this.persist()
  }
  async listProcesses(): Promise<ProcessRow[]> {
    return selectAll(this.db, `SELECT process_id, label, source_id, engine_workspace, engine_item, engine_job_type FROM ingestion_process ORDER BY process_id ASC`).map((r) => {
      const row: ProcessRow = { id: String(r['process_id']), label: String(r['label']), sourceId: String(r['source_id']) }
      if (r['engine_workspace'] != null && r['engine_item'] != null) {
        row.engine = {
          workspaceId: String(r['engine_workspace']),
          itemId: String(r['engine_item']),
          jobType: r['engine_job_type'] != null ? String(r['engine_job_type']) : 'Pipeline',
        }
      }
      return row
    })
  }
  async deleteProcess(id: string): Promise<void> {
    const pid = id.trim().toLowerCase()
    this.db.run(`DELETE FROM process_output WHERE process_id = ?`, [pid])
    this.db.run(`DELETE FROM ingestion_process WHERE process_id = ?`, [pid])
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

  async close(): Promise<void> {
    this.persist()
    this.db.close()
  }
}
