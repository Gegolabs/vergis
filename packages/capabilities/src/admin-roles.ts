import { openSqliteDb, persistSqliteDb, selectAll, type SqlDb } from './sqlite'

/**
 * Quién administra la plataforma — el rol de aplicación «admin». Es autorización de ACCIÓN (puede
 * o no entrar al ambiente de Administración y escribir), distinta de la RLS de filas (Custos), que
 * gobierna LECTURA del dato. Se gestiona in-app (sección «Usuarios y Roles»), pero arranca de una
 * SEMILLA en config de instancia (`VERGIS_ADMIN_SEED`) que rompe el huevo-gallina del bootstrap.
 *
 * Vive embebido (SQLite) y NO en Fabric: es config de plataforma, no dato que un PI consuma. Toda
 * mutación es la operación más privilegiada del sistema → el server la audita en el log append-only.
 *
 * Las OPS son funciones puras sobre un `SqlDb` para que las comparta el store consolidado
 * (`GovernanceStore`): admins, grupos, ACL de PI y cadencias viven en UN mismo db de gobierno.
 */

export interface AdminEntry {
  email: string
  addedBy?: string
  addedAt?: string
  /** Admin semilla (de config de instancia): no se puede quitar in-app (anti-lockout). */
  seed: boolean
}

export interface AdminStore {
  isAdmin(email: string | undefined): Promise<boolean>
  list(): Promise<AdminEntry[]>
  /** Alta de un admin. Idempotente (re-alta no duplica). Devuelve true si agregó. */
  add(email: string, addedBy?: string): Promise<boolean>
  /** Baja de un admin. Rechaza quitar una semilla o el último admin (anti-lockout). */
  remove(email: string): Promise<void>
  close(): Promise<void>
}

export class AdminLockout extends Error {}

export const normEmail = (e: string | undefined): string => (e ?? '').trim().toLowerCase()
const now = (): string => new Date().toISOString()

export const ADMIN_DDL = `CREATE TABLE IF NOT EXISTS admin (
  email TEXT PRIMARY KEY,
  added_by TEXT,
  added_at TEXT,
  seed INTEGER NOT NULL DEFAULT 0
);`

// ─── Ops puras sobre SqlDb (compartidas por SqliteAdminStore y GovernanceStore) ──
export function ensureAdminTable(db: SqlDb, seedEmails: string[] = []): void {
  db.run(ADMIN_DDL)
  for (const raw of seedEmails) {
    const email = normEmail(raw)
    if (!email) continue
    db.run(
      `INSERT INTO admin (email, added_by, added_at, seed) VALUES (?,?,?,1)
       ON CONFLICT(email) DO UPDATE SET seed=1`,
      [email, 'config:VERGIS_ADMIN_SEED', now()],
    )
  }
}

export function adminIsAdmin(db: SqlDb, email: string | undefined): boolean {
  const e = normEmail(email)
  if (!e) return false
  const stmt = db.prepare(`SELECT 1 FROM admin WHERE email = ?`)
  stmt.bind([e])
  const found = stmt.step()
  stmt.free()
  return found
}

export function adminList(db: SqlDb): AdminEntry[] {
  return selectAll(db, `SELECT email, added_by, added_at, seed FROM admin ORDER BY email ASC`).map((r) => ({
    email: String(r['email']),
    addedBy: r['added_by'] == null ? undefined : String(r['added_by']),
    addedAt: r['added_at'] == null ? undefined : String(r['added_at']),
    seed: Boolean(r['seed']),
  }))
}

export function adminAdd(db: SqlDb, email: string, addedBy?: string): boolean {
  const e = normEmail(email)
  if (!e) throw new Error('Correo vacío.')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error(`Correo inválido: '${email}'.`)
  if (adminIsAdmin(db, e)) return false
  db.run(`INSERT INTO admin (email, added_by, added_at, seed) VALUES (?,?,?,0)`, [e, normEmail(addedBy) || null, now()])
  return true
}

export function adminRemove(db: SqlDb, email: string): void {
  const e = normEmail(email)
  const entries = adminList(db)
  const target = entries.find((a) => a.email === e)
  if (!target) return
  if (target.seed) throw new AdminLockout(`«${e}» es admin semilla (config) — no se puede quitar in-app.`)
  if (entries.length <= 1) throw new AdminLockout('No se puede quitar el último administrador.')
  db.run(`DELETE FROM admin WHERE email = ?`, [e])
}

// ─── Store embebido enfocado (un db solo de admins). El consolidado vive en GovernanceStore. ──
export class SqliteAdminStore implements AdminStore {
  private constructor(
    private db: SqlDb,
    private file: string | null,
  ) {}

  static async open(file: string | null, seedEmails: string[] = []): Promise<SqliteAdminStore> {
    const db = await openSqliteDb(file)
    ensureAdminTable(db, seedEmails)
    persistSqliteDb(db, file)
    return new SqliteAdminStore(db, file)
  }

  async isAdmin(email: string | undefined): Promise<boolean> {
    return adminIsAdmin(this.db, email)
  }
  async list(): Promise<AdminEntry[]> {
    return adminList(this.db)
  }
  async add(email: string, addedBy?: string): Promise<boolean> {
    const added = adminAdd(this.db, email, addedBy)
    if (added) persistSqliteDb(this.db, this.file)
    return added
  }
  async remove(email: string): Promise<void> {
    adminRemove(this.db, email)
    persistSqliteDb(this.db, this.file)
  }
  async close(): Promise<void> {
    persistSqliteDb(this.db, this.file)
    this.db.close()
  }
}
