// Ingesta atómica al store ClickHouse (NEXT · Ola 2·2): el full-replace ya NO es TRUNCATE+INSERT sobre
// la tabla servida (ventana de 0 filas + si el INSERT falla queda vacía servida como verdad), sino
// staging + `EXCHANGE TABLES` (swap atómico). Se verifica el SQL emitido con un stub de fetch.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIngestClickHouse, type ChAdminConn, type ChStoreSchema } from '@vergis/capabilities'

const conn: ChAdminConn = { url: 'http://ch.invalid:8123', user: 'writer' }
const schema: ChStoreSchema = { database: 'qw04', table: 'areas', columns: { id: 'UInt32', nombre: 'String' } }

/** Stub de fetch que registra el SQL (body) de cada request y responde 200 vacío. */
function captureSql(): string[] {
  const sqls: string[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    sqls.push(String(init?.body ?? ''))
    return { ok: true, status: 200, text: async () => '' } as Response
  })
  return sqls
}

afterEach(() => vi.unstubAllGlobals())

describe('ingest-to-clickhouse · staging + EXCHANGE TABLES', () => {
  it('con filas: crea staging, la vacía, inserta en staging y hace EXCHANGE — nunca toca directo la tabla servida', async () => {
    const sqls = captureSql()
    const cap = createIngestClickHouse(conn, schema)
    const out = (await cap.execute({ rows: [{ id: 1, nombre: 'A' }, { id: 2, nombre: 'B' }] }, { agent: 'test' })) as { ingested: number }
    expect(out.ingested).toBe(2)
    expect(sqls[0]).toMatch(/CREATE TABLE IF NOT EXISTS qw04\.areas_staging AS qw04\.areas/)
    expect(sqls[1]).toMatch(/TRUNCATE TABLE IF EXISTS qw04\.areas_staging/)
    expect(sqls[2]).toMatch(/INSERT INTO qw04\.areas_staging/)
    expect(sqls[3]).toMatch(/EXCHANGE TABLES qw04\.areas AND qw04\.areas_staging/)
    // Ninguna sentencia hace TRUNCATE ni INSERT directo sobre la tabla SERVIDA (solo staging + exchange).
    expect(sqls.some((s) => /TRUNCATE TABLE IF EXISTS qw04\.areas\b/.test(s))).toBe(false)
    expect(sqls.some((s) => /INSERT INTO qw04\.areas\b/.test(s))).toBe(false)
  })

  it('con 0 filas: staging queda vacía y el EXCHANGE deja la tabla servida vacía atómicamente (sin INSERT)', async () => {
    const sqls = captureSql()
    const cap = createIngestClickHouse(conn, schema)
    const out = (await cap.execute({ rows: [] }, { agent: 'test' })) as { ingested: number }
    expect(out.ingested).toBe(0)
    expect(sqls.some((s) => /INSERT INTO/.test(s))).toBe(false)
    expect(sqls[sqls.length - 1]).toMatch(/EXCHANGE TABLES qw04\.areas AND qw04\.areas_staging/)
  })
})
