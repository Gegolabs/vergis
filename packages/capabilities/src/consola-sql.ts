/**
 * `consola-sql` — ejecución de T-SQL LIBRE para la Consola SQL de Mira (issue #306).
 *
 * NO es `execute-sql-dwh` con otro nombre, y las tres diferencias son toda la seguridad de esto:
 *
 *  1. **Otro principal.** Se conecta con el sub-perfil `consola` del Conector, nunca con el del
 *     serving: el SP de serving es Admin de los workspaces de la instancia, así que bajo él un
 *     `SELECT` ad-hoc es bypass completo (apagar la `SECURITY POLICY`, leer sin máscara, escribir).
 *  2. **Conexión dedicada, `@read_only`, y se cierra.** El prelude marca las claves del claim como
 *     read_only, así que un `sp_set_session_context` DENTRO del batch del usuario falla en el motor
 *     en vez de reescribir su propia identidad. Eso clava la clave para toda la sesión ⇒ la conexión
 *     no puede volver a un pool: se abre por ejecución y se cierra en `finally`, pase lo que pase.
 *  3. **Tope por streaming.** El corte de filas se hace en el cliente del motor (`request.cancel()`
 *     al pasarse), jamás envolviendo el SQL del usuario (`SELECT TOP N * FROM (…)`): envolver rompe
 *     con multi-sentencia, CTEs y `ORDER BY`, y sería el parser que este diseño rechaza.
 *
 * Lo que este módulo **no** hace, a propósito: decidir si un texto «es un SELECT». Ninguna garantía
 * vive en un parser (lista negra, regex de tablas, detector de `sp_set_session_context`): son
 * coladores (`EXEC('DR'+'OP …')`, `sp_executesql`, `OPENROWSET`, vistas). Lo que garantiza que no se
 * escriba son los PERMISOS del principal, y el nodo los MIDE antes de ofrecer el Conector
 * (`server/engines/fabric.ts`, gate de ofrecibilidad).
 */
import sql from 'mssql'
import type { IdentityContext } from '@vergis/botler'
import { sessionContextPrelude } from '@vergis/policy'
import { credentialProviderFor } from './aad-token'
import type { SqlConnectionProfile } from './execute-sql-dwh'

/** Una columna del resultset, como la reporta el motor. */
export interface ConsolaColumna {
  nombre: string
  tipo: string
}

/** Un recordset del batch (un batch T-SQL con `;` devuelve varios). */
export interface ConsolaRecordset {
  columnas: ConsolaColumna[]
  /** Filas como ARREGLOS posicionales (no objetos): un batch puede repetir el nombre de columna. */
  filas: unknown[][]
}

export interface ConsolaResultado {
  recordsets: ConsolaRecordset[]
  /** Filas devueltas en total (todos los recordsets). */
  filas: number
  /** ¿Se cortó por `maxRows`? El export del cliente exporta lo que se vio, truncado incluido. */
  truncado: boolean
  duracionMs: number
}

/** Motivos estructurados: el handler los mapea a HTTP, el log los registra tal cual. */
export type ConsolaMotivo = 'consola/sin-principal' | 'consola/timeout' | 'consola/cancelado' | 'consola/motor'

export class ConsolaError extends Error {
  constructor(
    readonly motivo: ConsolaMotivo,
    message: string,
  ) {
    super(message)
    this.name = 'ConsolaError'
  }
}

/** Lo mínimo que la ejecución necesita de un pool — el SEAM de los tests herméticos. */
export interface ConsolaRequestLike {
  stream: boolean
  input(name: string, type: unknown, value: unknown): unknown
  query(text: string): unknown
  cancel(): void
  on(event: string, cb: (arg: never) => void): unknown
}
export interface ConsolaPoolLike {
  request(): ConsolaRequestLike
  close(): Promise<unknown> | unknown
}

export interface ConsolaSqlOptions {
  /** Inyecciones del nodo (setting↔claim) — las MISMAS que el serving: la RLS es la misma. */
  injections: { setting: string; claim: string }[]
  maxRows: number
  timeoutMs: number
  /** Seam de conexión (tests herméticos). Default: un `ConnectionPool` de mssql con `max: 1`. */
  connect?: (cfg: sql.config) => Promise<ConsolaPoolLike>
}

export interface ConsolaSql {
  execute(input: { ref: string; sql: string }, identity: IdentityContext, signal?: AbortSignal): Promise<ConsolaResultado>
}

/**
 * Construye el ejecutor. `profiles` es la referencia VIVA de `VERGIS_CONNECTIONS` (el hot-reload la
 * muta in-place), así que el perfil se resuelve en cada ejecución y no al construir.
 */
export function createConsolaSql(profiles: Record<string, SqlConnectionProfile>, opts: ConsolaSqlOptions): ConsolaSql {
  const connect =
    opts.connect ??
    (async (cfg: sql.config): Promise<ConsolaPoolLike> => (await new sql.ConnectionPool(cfg).connect()) as unknown as ConsolaPoolLike)

  return {
    async execute(input, identity, signal): Promise<ConsolaResultado> {
      const perfil = profiles[input.ref]
      if (!perfil) throw new ConsolaError('consola/sin-principal', `Conector '${input.ref}' no está configurado.`)
      if (!perfil.consola) {
        throw new ConsolaError(
          'consola/sin-principal',
          `Conector '${input.ref}' no declara el sub-perfil 'consola': no hay principal de solo lectura con el que ejecutar.`,
        )
      }
      // Fail-closed antes de tocar la red, igual que `execute-sql-dwh` (#66).
      const provider = credentialProviderFor(perfil.consola, { label: `database_ref '${input.ref}' (consola)` })
      const cfg: sql.config = {
        server: perfil.server,
        database: perfil.database,
        port: perfil.port ?? 1433,
        authentication: provider.sqlAuth(),
        options: { encrypt: true, trustServerCertificate: false },
        connectionTimeout: 30_000,
        requestTimeout: opts.timeoutMs,
        pool: { max: 1, min: 0, idleTimeoutMillis: 1_000 },
      }
      const inicio = Date.now()
      const pool = await connect(cfg)
      try {
        return await ejecutarEnPool(pool, input.sql, identity, opts, signal, inicio)
      } finally {
        // SIEMPRE. La conexión lleva claves `read_only` clavadas: dejarla viva sería una sesión que
        // nadie puede reutilizar y que el motor conserva hasta que se caiga sola.
        try {
          await pool.close()
        } catch {
          /* cerrar una conexión ya muerta no es un fallo de la ejecución */
        }
      }
    },
  }
}

function ejecutarEnPool(
  pool: ConsolaPoolLike,
  texto: string,
  identity: IdentityContext,
  opts: ConsolaSqlOptions,
  signal: AbortSignal | undefined,
  inicio: number,
): Promise<ConsolaResultado> {
  return new Promise<ConsolaResultado>((resolver, rechazar) => {
    const request = pool.request()
    const recordsets: ConsolaRecordset[] = []
    let actual: ConsolaRecordset | null = null
    let filas = 0
    let truncado = false
    let terminado = false
    let cancelado = false

    const cancelar = (): void => {
      try {
        request.cancel()
      } catch {
        /* la query pudo terminar justo antes */
      }
    }
    const cerrar = (fn: () => void): void => {
      if (terminado) return
      terminado = true
      clearTimeout(temporizador)
      if (signal) signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      cancelado = true
      cancelar()
      // No se resuelve acá: se espera al `done`/`error` del motor, que es lo que confirma que la
      // consulta soltó la conexión. Si el motor no contesta, el temporizador cierra igual.
      setTimeout(() => cerrar(() => rechazar(new ConsolaError('consola/cancelado', 'Consulta cancelada.'))), 0)
    }
    const temporizador = setTimeout(() => {
      cancelar()
      cerrar(() => rechazar(new ConsolaError('consola/timeout', `La consulta superó el tope de ${opts.timeoutMs} ms y se canceló.`)))
    }, opts.timeoutMs)

    if (signal) {
      if (signal.aborted) {
        cerrar(() => rechazar(new ConsolaError('consola/cancelado', 'Consulta cancelada antes de ejecutar.')))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    request.stream = true
    // El prelude con `@read_only = 1`: de acá en adelante, un `sp_set_session_context` sobre la misma
    // clave FALLA. Los VALORES van bindeados — el claim jamás se concatena al texto.
    const prelude = sessionContextPrelude(opts.injections, identity?.claims ?? {}, { readOnly: true })
    for (const p of prelude.params) request.input(p.name, sql.NVarChar, p.value)

    request.on('recordset', (columnas: Record<string, { name?: string; type?: { name?: string } }>) => {
      actual = {
        columnas: Object.entries(columnas ?? {}).map(([clave, meta]) => ({
          nombre: meta?.name ?? clave,
          tipo: meta?.type?.name ?? 'desconocido',
        })),
        filas: [],
      }
      recordsets.push(actual)
    })
    request.on('row', (fila: Record<string, unknown>) => {
      if (truncado || terminado) return
      if (filas >= opts.maxRows) {
        truncado = true
        cancelar()
        return
      }
      const destino = actual ?? (() => {
        // Defensa: un driver que emita `row` sin `recordset` previo no puede perder la fila.
        const r: ConsolaRecordset = { columnas: Object.keys(fila ?? {}).map((n) => ({ nombre: n, tipo: 'desconocido' })), filas: [] }
        recordsets.push(r)
        actual = r
        return r
      })()
      destino.filas.push(destino.columnas.map((c) => (fila as Record<string, unknown>)[c.nombre]))
      filas += 1
    })
    request.on('error', (e: Error) => {
      // Un error DESPUÉS de haber cortado por tope es la cancelación que nosotros pedimos: el
      // resultado es válido y va truncado. Distinguirlo importa — devolver «error del motor» acá
      // convertiría un tope que funcionó en un fallo inventado.
      if (truncado) return
      if (cancelado) {
        cerrar(() => rechazar(new ConsolaError('consola/cancelado', 'Consulta cancelada.')))
        return
      }
      cerrar(() => rechazar(new ConsolaError('consola/motor', e instanceof Error ? e.message : String(e))))
    })
    request.on('done', () => {
      if (cancelado && !truncado) {
        cerrar(() => rechazar(new ConsolaError('consola/cancelado', 'Consulta cancelada.')))
        return
      }
      cerrar(() => resolver({ recordsets, filas, truncado, duracionMs: Date.now() - inicio }))
    })

    try {
      const r = request.query(`${prelude.sql}\n${texto}`)
      // En modo streaming el valor de retorno no lleva las filas; se captura su rechazo para que un
      // fallo de red no salga como `unhandledRejection` (el evento `error` ya decide el desenlace).
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => {})
    } catch (e) {
      cerrar(() => rechazar(new ConsolaError('consola/motor', e instanceof Error ? e.message : String(e))))
    }
  })
}

// ═══ Sesión de VERIFICACIÓN (el gate de ofrecibilidad, #306 · I3) ════════════════════════════════
//
// El gate corre al arrancar y tras cada hot-reload de conexiones, JAMÁS en el request. Abre UNA
// conexión bajo el principal de consola para las consultas de sistema, y otra —descartable— para la
// sonda de `@read_only`: una clave marcada read_only queda clavada por toda la sesión, así que
// sondear en la conexión de trabajo la dejaría inservible para las consultas siguientes.

export interface SesionConsola {
  /** Consulta de sistema bajo el principal de consola (sin `read_only`: no ejecuta texto ajeno). */
  ejecutar(sqlText: string): Promise<Record<string, unknown>[]>
  /** Sonda (d): ¿el motor honra `@read_only`, con la clave REAL y en el MISMO batch que un SELECT? */
  sondaReadOnly(): Promise<'honra' | 'no-honra' | 'indeterminado'>
  cerrar(): Promise<void>
}

/** Clave de respaldo para la sonda cuando el nodo no inyecta ningún claim (store sin políticas de fila). */
export const CLAVE_SONDA_CONSOLA = 'vergis_consola_probe'

/**
 * Abre la sesión de verificación de un Conector. Lanza si el perfil no declara `consola` — el
 * llamador lo trata como «no ofrecible: sin sub-perfil», que es lo que es.
 */
export async function abrirSesionConsola(
  perfil: SqlConnectionProfile,
  ref: string,
  injections: { setting: string; claim: string }[],
): Promise<SesionConsola> {
  if (!perfil.consola) throw new Error(`database_ref '${ref}': el perfil no declara el sub-perfil 'consola'.`)
  const provider = credentialProviderFor(perfil.consola, { label: `database_ref '${ref}' (consola)` })
  const cfg = (): sql.config => ({
    server: perfil.server,
    database: perfil.database,
    port: perfil.port ?? 1433,
    authentication: provider.sqlAuth(),
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 30_000,
    requestTimeout: 60_000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1_000 },
  })
  const pool = await new sql.ConnectionPool(cfg()).connect()

  return {
    async ejecutar(sqlText: string): Promise<Record<string, unknown>[]> {
      const r = await pool.request().query(sqlText)
      return (r.recordset ?? []) as unknown as Record<string, unknown>[]
    },
    async sondaReadOnly(): Promise<'honra' | 'no-honra' | 'indeterminado'> {
      // Conexión propia y descartable: la clave queda clavada y la sesión no sirve para nada más.
      const sonda = await new sql.ConnectionPool(cfg()).connect()
      try {
        const clave = injections[0]?.setting ?? CLAVE_SONDA_CONSOLA
        const prelude = injections.length
          ? sessionContextPrelude(injections, {}, { readOnly: true })
          : { sql: `EXEC sys.sp_set_session_context @key = N'${CLAVE_SONDA_CONSOLA}', @value = @vergis_sc_0, @read_only = 1;`, params: [{ name: 'vergis_sc_0', value: '' }] }
        // CONTROL POSITIVO, primero: el MISMO batch SIN el re-set tiene que funcionar. Sin él, un
        // fallo del batch de abajo no distingue «el motor honró read_only» de «acá no anda nada» —
        // y un instrumento que confunde eso produce datos con cara de verdad.
        const control = sonda.request()
        for (const p of prelude.params) control.input(p.name, sql.NVarChar, p.value)
        try {
          await control.batch(`${prelude.sql}\nSELECT 1 AS uno;`)
        } catch {
          return 'indeterminado'
        }
        // El ATAQUE, en una sesión nueva: re-set de la clave REAL en el MISMO batch que el SELECT.
        const ataque = await new sql.ConnectionPool(cfg()).connect()
        try {
          const req = ataque.request()
          for (const p of prelude.params) req.input(p.name, sql.NVarChar, p.value)
          req.input('vergis_sonda_v', sql.NVarChar, 'VERGIS-SONDA')
          await req.batch(
            `${prelude.sql}\nEXEC sys.sp_set_session_context @key = N'${clave}', @value = @vergis_sonda_v;\nSELECT 1 AS uno;`,
          )
          // No lanzó ⇒ el re-set pasó ⇒ el motor NO honra `@read_only`.
          return 'no-honra'
        } catch {
          return 'honra'
        } finally {
          await ataque.close().catch(() => {})
        }
      } finally {
        await sonda.close().catch(() => {})
      }
    },
    async cerrar(): Promise<void> {
      await pool.close().catch(() => {})
    },
  }
}
