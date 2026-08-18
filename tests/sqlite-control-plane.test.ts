import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  SqliteGovernanceStore,
  SCHEMA_VERSION,
  openSqliteDb,
  persistSqliteDb,
  selectAll,
  sqliteControlStatus,
  sqliteDegradedStores,
  SqliteConcurrentWriteError,
  SqliteEpochFencedError,
  SqliteSchemaTooNewError,
} from '@vergis/capabilities'

/**
 * El plano de escritura único de los stores embebidos (`packages/capabilities/src/sqlite.ts`).
 *
 * Un store embebido se vuelca COMPLETO en cada persist, así que su modelo de operación admite
 * exactamente UN escritor por archivo. Este archivo mide las dos garantías que lo hacen verificable
 * en vez de confiado:
 *
 * 1. **Fencing**: dos handles de escritura sobre el mismo archivo con escritura alternada — el handle
 *    cuya vista del archivo quedó atrás **falla ruidoso** y no vuelca encima de lo del otro.
 * 2. **Gate de esquema**: un archivo escrito por una versión de esquema más nueva no se abre para
 *    escribir, y un archivo anterior al esquema declarado se **adopta** con respaldo.
 *
 * **Control negativo obligatorio** (`fencing: false`): la misma secuencia sin protección tiene que
 * mostrar el volcado que se sobrepone sin error. Si el control negativo NO reprodujera ese resultado,
 * el test de arriba no estaría midiendo nada — de ahí que su expectativa sea afirmativa (`toBe(true)`
 * sobre la pérdida observada) y no la ausencia de un fallo, que es indistinguible de un instrumento
 * ciego.
 */

const tmpStore = (slug: string): string => join(mkdtempSync(join(tmpdir(), `vergis-${slug}-`)), 'governance.sqlite')

/** Lee los admins del ARCHIVO con un handle de inspección (nunca escribe). */
const adminsEnArchivo = async (file: string): Promise<string[]> => {
  const g = await SqliteGovernanceStore.open(file, {}, { mode: 'read' })
  const emails = (await g.list()).map((a) => a.email).sort()
  await g.close()
  return emails
}

describe('plano de escritura único · fencing de escritura concurrente', () => {
  it('dos escritores alternados: el que quedó atrás falla RUIDOSO y la escritura del otro sobrevive', async () => {
    const file = tmpStore('fencing')
    const semilla = await SqliteGovernanceStore.open(file, { admins: ['cesar@ratio.cl'] })
    await semilla.close()
    expect(await adminsEnArchivo(file)).toEqual(['cesar@ratio.cl'])

    // Dos handles de ESCRITURA vivos sobre el mismo archivo — la condición prohibida por el modelo.
    const viejo = await SqliteGovernanceStore.open(file, {}, { writer: 'viejo' })
    const nuevo = await SqliteGovernanceStore.open(file, {}, { writer: 'nuevo' })

    // `nuevo` escribe último y su vista del archivo es la vigente: su volcado procede.
    expect(await nuevo.add('nuevo-admin@gh.com')).toBe(true)
    expect(await adminsEnArchivo(file)).toEqual(['cesar@ratio.cl', 'nuevo-admin@gh.com'])

    // `viejo` mira un archivo que ya no es el que dejó: su volcado se ABORTA, con error tipado.
    await expect(viejo.add('otro@gh.com')).rejects.toBeInstanceOf(SqliteConcurrentWriteError)

    // Y lo que importa: la escritura de `nuevo` está intacta en el archivo.
    expect(await adminsEnArchivo(file)).toEqual(['cesar@ratio.cl', 'nuevo-admin@gh.com'])

    // El handle afectado queda en condición reportable (`degraded`), no aparentando salud.
    const estado = viejo.controlStatus()!
    expect(estado.degraded).toBe(true)
    expect(estado.degradedReason).toMatch(/no es el que dejó este handle/)
    expect(sqliteDegradedStores().some((s) => s.file === file)).toBe(true)
    expect(nuevo.controlStatus()!.degraded).toBe(false)

    await nuevo.close()
  })

  it('CONTROL NEGATIVO · sin fencing la misma secuencia se sobrepone SIN error (si no, el test de arriba es ciego)', async () => {
    const file = tmpStore('fencing-off')
    const semilla = await SqliteGovernanceStore.open(file, { admins: ['cesar@ratio.cl'] })
    await semilla.close()

    const viejo = await SqliteGovernanceStore.open(file, {}, { writer: 'viejo', fencing: false })
    const nuevo = await SqliteGovernanceStore.open(file, {}, { writer: 'nuevo', fencing: false })

    await nuevo.add('nuevo-admin@gh.com')
    expect(await adminsEnArchivo(file)).toEqual(['cesar@ratio.cl', 'nuevo-admin@gh.com'])

    let abortó = false
    try {
      await viejo.add('otro@gh.com')
    } catch {
      abortó = true
    }

    const final = await adminsEnArchivo(file)
    // Las dos mitades del control negativo, afirmadas (no «no falló»): el volcado procedió sin aviso,
    // y el archivo final NO contiene la escritura de `nuevo`. Ese resultado es el que la protección
    // del test anterior evita; verlo acá es lo que demuestra que ese test mide algo.
    expect(abortó).toBe(false)
    expect(final).toEqual(['cesar@ratio.cl', 'otro@gh.com'])
    expect(final.includes('nuevo-admin@gh.com')).toBe(false)
    expect(viejo.controlStatus()!.degraded).toBe(false) // sin protección no hay nada que reportar

    await nuevo.close()
    await viejo.close()
  })

  it('un escritor solo persiste cuantas veces quiera: el guard es idempotente y no se auto-delata', async () => {
    const file = tmpStore('fencing-solo')
    const g = await SqliteGovernanceStore.open(file, { admins: ['cesar@ratio.cl'] })
    for (const email of ['a@gh.com', 'b@gh.com', 'c@gh.com']) expect(await g.add(email)).toBe(true)
    await g.remove('a@gh.com')
    await g.close()
    expect(g.controlStatus()!.degraded).toBe(false)
    expect(g.controlStatus()!.persists).toBeGreaterThanOrEqual(5)
    expect(await adminsEnArchivo(file)).toEqual(['b@gh.com', 'c@gh.com', 'cesar@ratio.cl'])
    // La escritura sigue siendo atómica: ningún tmp sobrevive al volcado.
    expect(readdirSync(dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('reabrir el mismo archivo en secuencia (cerrar → abrir) no dispara nada', async () => {
    const file = tmpStore('fencing-secuencial')
    for (const email of ['a@gh.com', 'b@gh.com']) {
      const g = await SqliteGovernanceStore.open(file, { admins: ['cesar@ratio.cl'] })
      expect(await g.add(email)).toBe(true)
      expect(g.controlStatus()!.degraded).toBe(false)
      await g.close()
    }
    expect(await adminsEnArchivo(file)).toEqual(['a@gh.com', 'b@gh.com', 'cesar@ratio.cl'])
  })

  it('un store en memoria no tiene plano de escritura que proteger', async () => {
    const g = await SqliteGovernanceStore.open(null, {})
    expect(g.controlStatus()).toBeUndefined()
    await g.close()
  })
})

describe('plano de escritura único · gate de versión de esquema', () => {
  it('estampa la versión soportada como `PRAGMA user_version` en cada apertura de escritura', async () => {
    const file = tmpStore('esquema-estampa')
    const g = await SqliteGovernanceStore.open(file, {})
    expect(g.controlStatus()).toMatchObject({ schemaSupported: SCHEMA_VERSION, fileVersion: 0, mode: 'write' })
    await g.close()

    const leer = await openSqliteDb(file)
    expect(leer.exec('PRAGMA user_version')[0]!.values[0]![0]).toBe(SCHEMA_VERSION)
    // La época del plano de control queda registrada en el archivo (default 0 = nodo único).
    expect(selectAll(leer, 'SELECT epoch, writer FROM control_meta')).toHaveLength(1)
    leer.close()

    // Idempotencia: reabrir no cambia la versión ni rompe.
    const g2 = await SqliteGovernanceStore.open(file, {})
    expect(g2.controlStatus()).toMatchObject({ fileVersion: SCHEMA_VERSION })
    await g2.close()
  })

  it('un archivo de una versión de esquema MÁS NUEVA no se abre para escribir, y el error nombra ambas', async () => {
    const file = tmpStore('esquema-futuro')
    const g = await SqliteGovernanceStore.open(file, { admins: ['cesar@ratio.cl'] })
    await g.close()

    // Un archivo dejado por una versión futura del Producto.
    const futuro = await openSqliteDb(file)
    futuro.run('PRAGMA user_version = 99')
    persistSqliteDb(futuro, file)
    futuro.close()

    const fallo = await SqliteGovernanceStore.open(file, {}).catch((e: unknown) => e)
    expect(fallo).toBeInstanceOf(SqliteSchemaTooNewError)
    expect((fallo as SqliteSchemaTooNewError).code).toBe('SQLITE_SCHEMA_TOO_NEW')
    expect((fallo as SqliteSchemaTooNewError).fileVersion).toBe(99)
    expect((fallo as SqliteSchemaTooNewError).schemaSupported).toBe(SCHEMA_VERSION)
    expect(String(fallo)).toMatch(new RegExp(`99.*${SCHEMA_VERSION}`))

    // El archivo quedó intacto: negarse no es tocar.
    const inspección = await openSqliteDb(file)
    expect(inspección.exec('PRAGMA user_version')[0]!.values[0]![0]).toBe(99)
    inspección.close()

    // Y un handle de INSPECCIÓN sí abre: la herramienta que compara versiones no necesita escribir.
    const mirón = await SqliteGovernanceStore.open(file, {}, { mode: 'read' })
    expect(mirón.controlStatus()).toMatchObject({ fileVersion: 99, schemaSupported: SCHEMA_VERSION, mode: 'read' })
    await mirón.close()
  })

  it('un archivo anterior al esquema declarado (`user_version = 0`) se ADOPTA, con respaldo y sin pérdida', async () => {
    const file = tmpStore('esquema-legado')
    // Archivo legado: creado por un handle crudo, sin versión estampada.
    const legado = await openSqliteDb(file)
    legado.run(`CREATE TABLE admin (email TEXT PRIMARY KEY, added_by TEXT, added_at TEXT, seed INTEGER NOT NULL DEFAULT 0)`)
    legado.run(`INSERT INTO admin (email, seed) VALUES ('historico@gh.com', 0)`)
    persistSqliteDb(legado, file)
    expect(legado.exec('PRAGMA user_version')[0]!.values[0]![0]).toBe(0)
    legado.close()

    const g = await SqliteGovernanceStore.open(file, {})
    const estado = g.controlStatus()!
    expect(estado.fileVersion).toBe(0) // lo que traía
    expect(estado.backupCreated).toBe(`${file}.pre-${SCHEMA_VERSION}.bak`)
    expect(existsSync(estado.backupCreated!)).toBe(true)
    expect((await g.list()).map((a) => a.email)).toContain('historico@gh.com')
    await g.close()

    // Segunda apertura: ya está adoptado, no se vuelve a respaldar (el respaldo no se pisa).
    const g2 = await SqliteGovernanceStore.open(file, {})
    expect(g2.controlStatus()!.fileVersion).toBe(SCHEMA_VERSION)
    expect(g2.controlStatus()!.backupCreated).toBeUndefined()
    await g2.close()
  })
})

describe('plano de escritura único · época del plano de control', () => {
  it('abrir para escribir con una época MENOR que la del archivo se niega, nombrando ambas', async () => {
    const file = tmpStore('epoca')
    const g5 = await SqliteGovernanceStore.open(file, {}, { epoch: 5, writer: 'nodo-b' })
    expect(await g5.add('a@gh.com')).toBe(true)
    await g5.close()

    const fallo = await SqliteGovernanceStore.open(file, {}, { epoch: 4 }).catch((e: unknown) => e)
    expect(fallo).toBeInstanceOf(SqliteEpochFencedError)
    expect((fallo as SqliteEpochFencedError).code).toBe('SQLITE_EPOCH_FENCED')
    expect(String(fallo)).toMatch(/época 4 .*época 5/)

    // La misma época y una posterior sí abren; el proveedor puede ser una función (la del lease).
    const igual = await SqliteGovernanceStore.open(file, {}, { epoch: 5 })
    await igual.close()
    let época = 6
    const posterior = await SqliteGovernanceStore.open(file, {}, { epoch: () => época })
    expect(posterior.controlStatus()).toMatchObject({ epoch: 6, fileEpoch: 5 })
    época = 7 // el relevo bumpea la época: el siguiente volcado la estampa
    expect(await posterior.add('b@gh.com')).toBe(true)
    expect(posterior.controlStatus()!.epoch).toBe(7)
    await posterior.close()

    const leer = await openSqliteDb(file)
    expect(selectAll(leer, 'SELECT epoch FROM control_meta')[0]!['epoch']).toBe(7)
    leer.close()
  })

  it('un handle de inspección no escribe, lo cuenta y lo deja ver', async () => {
    const file = tmpStore('inspeccion')
    const g = await SqliteGovernanceStore.open(file, { admins: ['cesar@ratio.cl'] })
    await g.close()
    const antes = (await openSqliteDb(file)) as { export: () => Uint8Array; close: () => void }
    const bytesAntes = Buffer.from(antes.export()).length
    antes.close()

    const mirón = await SqliteGovernanceStore.open(file, {}, { mode: 'read' })
    await mirón.add('no-deberia-quedar@gh.com') // el volcado se ignora
    expect(mirón.controlStatus()!.readOnlyPersistsIgnored).toBeGreaterThan(0)
    expect(mirón.controlStatus()!.persists).toBe(0)
    await mirón.close()

    expect(await adminsEnArchivo(file)).toEqual(['cesar@ratio.cl'])
    const después = (await openSqliteDb(file)) as { export: () => Uint8Array; close: () => void }
    expect(Buffer.from(después.export()).length).toBe(bytesAntes)
    después.close()
  })

  it('`sqliteControlStatus` sobre un handle crudo no reporta plano de control', async () => {
    const file = tmpStore('crudo')
    const db = await openSqliteDb(file)
    expect(sqliteControlStatus(db)).toBeUndefined()
    db.close()
  })
})
