import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteGovernanceStore, SqliteConcurrentWriteError } from '@vergis/capabilities'

/**
 * El RELEVO al nivel del store (#210 · I4/I6 · diseño §6.2 paso 2).
 *
 * El nodo en espera abre sus stores en modo LECTURA, y ese snapshot **queda rancio en cuanto el activo
 * escribe** — no es una posibilidad, es la definición de lo que hace el activo. Por eso tomar el control
 * no es solo adquirir el lease: es **reabrir los stores desde disco** antes de escribir. Un relevo que
 * se saltara ese paso volcaría el mundo viejo encima del que el activo dejó, que es exactamente la
 * pérdida silenciosa que el plano de control existe para eliminar.
 *
 * Lo que este test mide, en una corrida que habría salido distinta si el mecanismo no funcionara:
 *  1. el standby en lectura NO ve lo que el activo escribió después de su apertura (la rancidez existe);
 *  2. tras reabrir en escritura con la época nueva, SÍ lo ve (el relevo la cura);
 *  3. el nodo relevado escribe, y el handle del anterior **falla ruidoso** al intentar volcar (fencing);
 *  4. un handle de lectura no escribe: el archivo no cambia por más que se le pida.
 */
describe('relevo · reabrir el store desde disco es parte de tomar el control', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vergis-relevo-'))
    file = join(dir, 'governance.sqlite')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('el snapshot del standby está rancio, y reabrir con la época nueva lo cura', async () => {
    // Nodo A: el activo, época 1.
    const a = await SqliteGovernanceStore.open(file, { admins: ['a@x.com'] }, { epoch: 1, writer: 'nodo-A' })
    // Nodo B: en espera. Época 0 y modo LECTURA — con `write` el gate de época se negaría a abrir, que
    // es precisamente el motivo por el que un standby abre en lectura.
    const b = await SqliteGovernanceStore.open(file, { admins: [] }, { epoch: 0, writer: 'nodo-B', mode: 'read' })
    expect(await b.isAdmin('a@x.com')).toBe(true)

    // El activo escribe DESPUÉS de que B abrió.
    expect(await a.add('nuevo@x.com', 'a@x.com')).toBe(true)

    // (1) B no lo ve: su snapshot es del momento de su apertura.
    expect(await b.isAdmin('nuevo@x.com')).toBe(false)

    // (2) B toma el control (época 2) y REABRE desde disco: ahora sí.
    await b.reopen({ epoch: 2, writer: 'nodo-B' })
    expect(await b.isAdmin('nuevo@x.com')).toBe(true)
    expect(await b.isAdmin('a@x.com')).toBe(true)
    expect(b.controlStatus()?.mode).toBe('write')
    expect(b.controlStatus()?.epoch).toBe(2)

    // (3) B escribe como activo, y el handle de A —que ya no manda— falla RUIDOSO al volcar en vez de
    // pisar lo de B. Sin fencing este `add` habría devuelto true y borrado a `de-b@x.com` en silencio.
    expect(await b.add('de-b@x.com', 'nodo-B')).toBe(true)
    await expect(a.add('tarde@x.com', 'a@x.com')).rejects.toThrow(SqliteConcurrentWriteError)
    expect(a.controlStatus()?.degraded).toBe(true)

    // Y lo de B sobrevive: el archivo en disco es el suyo.
    const testigo = await SqliteGovernanceStore.open(file, {}, { epoch: 3, writer: 'testigo' })
    expect(await testigo.isAdmin('de-b@x.com')).toBe(true)
    expect(await testigo.isAdmin('tarde@x.com')).toBe(false)
  })

  it('reabrir en modo lectura (soltar el control) deja al handle sin poder escribir', async () => {
    const a = await SqliteGovernanceStore.open(file, { admins: ['a@x.com'] }, { epoch: 1, writer: 'nodo-A' })
    // A suelta el control y vuelve a lectura, como hace el handler de SIGUSR2.
    await a.reopen({ epoch: 1, writer: 'nodo-A', mode: 'read' })
    expect(a.controlStatus()?.mode).toBe('read')
    await a.add('no-deberia@x.com', 'a@x.com')
    // El volcado se ignora: el archivo no lo tiene. Lo que quedó en memoria muere con el handle.
    const testigo = await SqliteGovernanceStore.open(file, {}, { epoch: 2, writer: 'testigo', mode: 'read' })
    expect(await testigo.isAdmin('no-deberia@x.com')).toBe(false)
    expect(await testigo.isAdmin('a@x.com')).toBe(true)
  })

  it('reabrir es validate-before-swap: una apertura que se niega deja el handle anterior en pie', async () => {
    const a = await SqliteGovernanceStore.open(file, { admins: ['a@x.com'] }, { epoch: 5, writer: 'nodo-A' })
    // Época menor que la del archivo: el gate se niega (es el fencing de época).
    await expect(a.reopen({ epoch: 1, writer: 'nodo-A' })).rejects.toThrow(/época de control obsoleta/)
    // El handle viejo sigue sirviendo y escribiendo: nada quedó a medias.
    expect(await a.isAdmin('a@x.com')).toBe(true)
    expect(await a.add('sigue-vivo@x.com', 'a@x.com')).toBe(true)
  })
})
