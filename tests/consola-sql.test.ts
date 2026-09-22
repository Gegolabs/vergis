/**
 * I2 · la capability `consola-sql`: prelude con `@read_only`, tope por streaming, abort y cierre.
 *
 * Todo hermético por el seam `connect`: un doble emite los eventos del driver (`recordset`/`row`/
 * `done`/`error`) y registra `cancel()`/`close()`. El último test es el CONTROL NEGATIVO del propio
 * seam — un doble que nunca emite `done` tiene que hacer fallar la promesa por timeout con la
 * conexión cerrada, porque un arnés que se cuelga esconde su fallo detrás de un timeout ajeno.
 */
import { describe, it, expect } from 'vitest'
import { createConsolaSql, ConsolaError, type ConsolaPoolLike, type ConsolaRequestLike } from '@vergis/capabilities'
import { sessionContextPrelude } from '@vergis/policy'
import type { SqlConnectionProfile } from '@vergis/capabilities'

const PERFIL: Record<string, SqlConnectionProfile> = {
  fin: {
    server: 'x.datawarehouse.fabric.microsoft.com',
    database: 'wh_fin',
    auth: 'secret',
    tenantId: 't',
    clientId: 'sp-serving',
    clientSecret: 's',
    consola: { auth: 'secret', tenantId: 't', clientId: 'sp-consola', clientSecret: 's' },
  },
  sinConsola: { server: 'x', database: 'y', auth: 'secret', tenantId: 't', clientId: 'c', clientSecret: 's' },
}
const INJ = [{ setting: 'vergis_claim_groups', claim: 'groups' }]
const IDENT = { agent: 'x', user: 'ana@gh.cl', claims: { groups: ['Finanzas'] } }

interface Doble {
  pool: ConsolaPoolLike
  textos: string[]
  inputs: { name: string; value: unknown }[]
  cancelado: number
  cerrado: number
}

/** Doble del driver: `guion` decide qué emite cuando le llega la query. */
function doble(guion: (emitir: (evt: string, arg?: unknown) => void, self: Doble) => void): Doble {
  const escuchas = new Map<string, ((arg: unknown) => void)[]>()
  const self: Doble = { pool: null as unknown as ConsolaPoolLike, textos: [], inputs: [], cancelado: 0, cerrado: 0 }
  const emitir = (evt: string, arg?: unknown): void => {
    for (const cb of escuchas.get(evt) ?? []) cb(arg)
  }
  const request: ConsolaRequestLike = {
    stream: false,
    input(name, _t, value) {
      self.inputs.push({ name, value })
      return this
    },
    query(text) {
      self.textos.push(text)
      setTimeout(() => guion(emitir, self), 0)
      return undefined
    },
    cancel() {
      self.cancelado += 1
    },
    on(evt, cb) {
      escuchas.set(evt, [...(escuchas.get(evt) ?? []), cb as (arg: unknown) => void])
      return this
    },
  }
  self.pool = {
    request: () => request,
    close: () => {
      self.cerrado += 1
      return Promise.resolve()
    },
  }
  return self
}

const filaDe = (v: Record<string, unknown>): unknown => v
const RS = { area: { name: 'area', type: { name: 'NVarChar' } } }

describe('consola-sql · el prelude', () => {
  it('marca CADA inyección como read_only y manda los valores BINDEADOS (nunca en el texto)', async () => {
    const d = doble((emitir) => {
      emitir('recordset', RS)
      emitir('row', filaDe({ area: 'Finanzas' }))
      emitir('done')
    })
    const cap = createConsolaSql(PERFIL, { injections: INJ, maxRows: 10, timeoutMs: 5000, connect: async () => d.pool })
    await cap.execute({ ref: 'fin', sql: 'SELECT area FROM dbo.areas' }, IDENT)
    expect(d.textos[0]).toContain('@read_only = 1')
    expect(d.textos[0]).toContain('SELECT area FROM dbo.areas')
    // El VALOR del claim jamás viaja en el texto: va por el bind.
    expect(d.textos[0]).not.toContain('Finanzas')
    expect(d.inputs.map((i) => i.value)).toContain('Finanzas')
  })

  it('el prelude del SERVING no cambia ni un byte (la opción es aditiva)', () => {
    const claims = { groups: ['Finanzas', 'Comercial'] }
    expect(sessionContextPrelude(INJ, claims).sql).toBe(
      "EXEC sys.sp_set_session_context @key = N'vergis_claim_groups', @value = @vergis_sc_0;",
    )
    expect(sessionContextPrelude(INJ, claims, {}).sql).toBe(sessionContextPrelude(INJ, claims).sql)
    expect(sessionContextPrelude(INJ, claims, { readOnly: false }).sql).toBe(sessionContextPrelude(INJ, claims).sql)
  })
})

describe('consola-sql · topes y desenlaces', () => {
  it('corta en maxRows: cancela, marca truncado y devuelve exactamente el tope', async () => {
    const d = doble((emitir) => {
      emitir('recordset', RS)
      for (let i = 0; i < 10; i += 1) emitir('row', filaDe({ area: `a${i}` }))
      emitir('error', new Error('Canceled.'))
      emitir('done')
    })
    const cap = createConsolaSql(PERFIL, { injections: INJ, maxRows: 3, timeoutMs: 5000, connect: async () => d.pool })
    const r = await cap.execute({ ref: 'fin', sql: 'SELECT 1' }, IDENT)
    expect(r.filas).toBe(3)
    expect(r.truncado).toBe(true)
    expect(r.recordsets[0]!.filas).toHaveLength(3)
    expect(d.cancelado).toBeGreaterThanOrEqual(1)
    expect(d.cerrado).toBe(1)
  })

  it('devuelve un recordset por sentencia del batch', async () => {
    const d = doble((emitir) => {
      emitir('recordset', RS)
      emitir('row', filaDe({ area: 'uno' }))
      emitir('recordset', RS)
      emitir('row', filaDe({ area: 'dos' }))
      emitir('done')
    })
    const cap = createConsolaSql(PERFIL, { injections: INJ, maxRows: 100, timeoutMs: 5000, connect: async () => d.pool })
    const r = await cap.execute({ ref: 'fin', sql: 'SELECT 1; SELECT 2' }, IDENT)
    expect(r.recordsets).toHaveLength(2)
    expect(r.filas).toBe(2)
  })

  it('un error del motor cierra la conexión igual y llega estructurado', async () => {
    const d = doble((emitir) => emitir('error', new Error("Invalid object name 'dbo.noexiste'.")))
    const cap = createConsolaSql(PERFIL, { injections: INJ, maxRows: 10, timeoutMs: 5000, connect: async () => d.pool })
    await expect(cap.execute({ ref: 'fin', sql: 'SELECT 1' }, IDENT)).rejects.toMatchObject({ motivo: 'consola/motor' })
    expect(d.cerrado).toBe(1)
  })

  it('abort cancela la query, cierra la conexión y rechaza como cancelado', async () => {
    const d = doble(() => {
      /* nunca termina sola */
    })
    const cap = createConsolaSql(PERFIL, { injections: INJ, maxRows: 10, timeoutMs: 5000, connect: async () => d.pool })
    const ctl = new AbortController()
    const p = cap.execute({ ref: 'fin', sql: 'WAITFOR DELAY …' }, IDENT, ctl.signal)
    setTimeout(() => ctl.abort(), 5)
    await expect(p).rejects.toMatchObject({ motivo: 'consola/cancelado' })
    expect(d.cancelado).toBeGreaterThanOrEqual(1)
    expect(d.cerrado).toBe(1)
  })

  it('un ref sin sub-perfil `consola` NO cae al perfil padre: error estructurado', async () => {
    const cap = createConsolaSql(PERFIL, { injections: INJ, maxRows: 10, timeoutMs: 5000, connect: async () => doble(() => {}).pool })
    await expect(cap.execute({ ref: 'sinConsola', sql: 'SELECT 1' }, IDENT)).rejects.toBeInstanceOf(ConsolaError)
    await expect(cap.execute({ ref: 'sinConsola', sql: 'SELECT 1' }, IDENT)).rejects.toMatchObject({ motivo: 'consola/sin-principal' })
  })

  it('CONTROL NEGATIVO DEL SEAM · un doble que nunca emite `done` vence por timeout y cierra', async () => {
    const d = doble(() => {
      /* silencio absoluto: el instrumento tiene que delatar que no pudo medir */
    })
    const cap = createConsolaSql(PERFIL, { injections: INJ, maxRows: 10, timeoutMs: 30, connect: async () => d.pool })
    await expect(cap.execute({ ref: 'fin', sql: 'SELECT 1' }, IDENT)).rejects.toMatchObject({ motivo: 'consola/timeout' })
    expect(d.cancelado).toBeGreaterThanOrEqual(1)
    expect(d.cerrado).toBe(1)
  })
})
