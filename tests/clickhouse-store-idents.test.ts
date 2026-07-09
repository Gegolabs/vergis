// Guard de identificadores del store ClickHouse (NEXT · Ola 3·E): el DDL/DML se arma por interpolación
// de string (el HTTP de ClickHouse no parametriza identificadores). db/tabla/columna/tipo/rol/usuario
// pasan por `assertSafeIdent` antes de entrar al SQL, cerrando la inyección por nombre.
import { describe, it, expect } from 'vitest'
import { createIngestClickHouse, type ChStoreSchema, type ChAdminConn } from '@vergis/capabilities'

const conn: ChAdminConn = { url: 'http://ch.invalid:8123', user: 'writer' }
const ok: ChStoreSchema = { database: 'qw04', table: 'areas', columns: { id: 'UInt32', nombre: 'String' } }

describe('clickhouse-store · guard de identificadores', () => {
  it('schema limpio → construye la capability (valida al construir, no en cada ingesta)', () => {
    expect(() => createIngestClickHouse(conn, ok)).not.toThrow()
  })

  it('columna con inyección → lanza al construir', () => {
    const bad = { ...ok, columns: { 'id String) ENGINE=Log; DROP TABLE x --': 'UInt32' } } as unknown as ChStoreSchema
    expect(() => createIngestClickHouse(conn, bad)).toThrow(/identificador seguro/)
  })

  it('tabla con punto/inyección → lanza', () => {
    expect(() => createIngestClickHouse(conn, { ...ok, table: 'areas; DROP' })).toThrow(/identificador seguro/)
  })

  it('tipo de columna forjado → lanza (no solo el nombre)', () => {
    const bad = { ...ok, columns: { id: "String') ; DROP" } } as unknown as ChStoreSchema
    expect(() => createIngestClickHouse(conn, bad)).toThrow(/identificador seguro/)
  })
})
