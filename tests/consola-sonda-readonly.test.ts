/**
 * (d) · la SONDA de `@read_only` del gate de la Consola — el instrumento, no el mecanismo (#344).
 *
 * Que el motor honre `@read_only` se mide contra un motor (`lab:proof` C2/C2b). Lo que se mide acá
 * es que **la sonda sepa reportar su propio fallo**: un control que muere devuelve `indeterminado`
 * CON el error del motor, no un veredicto mudo. El `indeterminado` mudo rechazó los ocho Conectores
 * de producción el 2026-09-22 sin que ningún log dijera por qué.
 *
 * El doble es discriminante a propósito: su `batch()` falla como falla el real —`batch()` no liga
 * parámetros en `node-mssql`, así que el prelude llega con `@vergis_sc_0` sin declarar (15600)— y su
 * `query()` funciona. Una regresión a `batch()` vuelve rojo este archivo.
 */
import { describe, it, expect } from 'vitest'
import mssql from 'mssql'
import { abrirSesionConsola, type SqlConnectionProfile } from '@vergis/capabilities'

const PERFIL: SqlConnectionProfile = {
  server: 'x.datawarehouse.fabric.microsoft.com',
  database: 'wh_fin',
  auth: 'secret',
  tenantId: 't',
  clientId: 'sp-serving',
  clientSecret: 's',
  consola: { auth: 'secret', tenantId: 't', clientId: 'sp-consola', clientSecret: 's' },
}
const INJ = [{ setting: 'vergis_claim_groups', claim: 'groups' }]

/** Error del motor como lo entrega `mssql`: el NÚMERO es el dato. */
function errorDelMotor(number: number, message: string): Error {
  return Object.assign(new Error(message), { number, code: 'EREQUEST' })
}
const E_15600 = (): Error => errorDelMotor(15600, "An invalid parameter or option was specified for procedure 'sp_set_session_context'.")
const E_15664 = (): Error => errorDelMotor(15664, "The key 'vergis_claim_groups' is set as read_only for the current session.")

interface Guion {
  /** Qué hace `query(text)`: devolver, o lanzar. */
  query: (text: string) => void
  /** Cuántas conexiones se abrieron (trabajo + control + ataque). */
  conexiones: number
  textos: string[]
  vias: string[]
}

function dobleDe(query: (text: string, g: Guion) => void): Guion {
  const g: Guion = { query: () => {}, conexiones: 0, textos: [], vias: [] }
  g.query = (t) => query(t, g)
  return g
}

/** Seam: entrega un pool falso con la superficie que la sonda usa (`request`, `close`). */
const abrirCon =
  (g: Guion) =>
  async (): Promise<mssql.ConnectionPool> => {
    g.conexiones += 1
    const request = {
      input() {
        return this
      },
      async query(text: string) {
        g.vias.push('query')
        g.textos.push(text)
        g.query(text)
        return { recordset: [] }
      },
      async batch(text: string) {
        // Fiel al driver: `batch()` NO liga parámetros, así que el prelude parametrizado muere.
        g.vias.push('batch')
        g.textos.push(text)
        throw E_15600()
      },
    }
    return { request: () => request, close: async () => undefined } as unknown as mssql.ConnectionPool
  }

const sondar = async (g: Guion) => {
  const sesion = await abrirSesionConsola(PERFIL, 'fin', INJ, { abrir: abrirCon(g) })
  try {
    return await sesion.sondaReadOnly()
  } finally {
    await sesion.cerrar()
  }
}

describe('sonda (d) · el instrumento sabe reportar su propio fallo', () => {
  it('el CONTROL que lanza ⇒ `indeterminado` CON el error conservado (número y mensaje)', async () => {
    const g = dobleDe((_t) => {
      throw E_15600()
    })
    const r = await sondar(g)
    expect(r.veredicto).toBe('indeterminado')
    expect(r.error).toContain('15600')
    expect(r.error).toContain('sp_set_session_context')
  })

  it('el ATAQUE rechazado por `read_only` (15664) ⇒ `honra`, sin error que reportar', async () => {
    const g = dobleDe((t) => {
      // El ataque es el ÚNICO batch con un segundo `sp_set_session_context` sin `@read_only`.
      if (t.includes('@vergis_sonda_v')) throw E_15664()
    })
    const r = await sondar(g)
    expect(r.veredicto).toBe('honra')
    expect(r.error).toBeUndefined()
  })

  it('el ataque que NO lanza ⇒ `no-honra` (el re-set pasó: el plano de fila es reescribible)', async () => {
    const r = await sondar(dobleDe(() => {}))
    expect(r.veredicto).toBe('no-honra')
  })

  it('el ataque que falla por OTRA razón NO se lee como `honra`: no se midió, y se dice', async () => {
    const g = dobleDe((t) => {
      if (t.includes('@vergis_sonda_v')) throw errorDelMotor(208, "Invalid object name 'dbo.nada'.")
    })
    const r = await sondar(g)
    expect(r.veredicto).toBe('indeterminado')
    expect(r.error).toContain('208')
  })

  it('la sonda emite por `query()` (parametrizada), JAMÁS por `batch()` — #344', async () => {
    const g = dobleDe((t) => {
      if (t.includes('@vergis_sonda_v')) throw E_15664()
    })
    const r = await sondar(g)
    expect(g.vias).not.toContain('batch')
    expect(g.vias.filter((v) => v === 'query').length).toBe(2) // control + ataque
    expect(r.veredicto).toBe('honra')
  })
})
