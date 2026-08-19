import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequestHandler, type RouteDeps } from '../server/routes'
import { createContractRegistry } from '../server/contract'
import type { Report } from '../server/discovery'

/**
 * La FASE `standby` y el rechazo de mutaciones sin control (#210 · I5), más el bloque `control` del
 * contrato operativo (#210 · I6).
 *
 * La invariante que estos tests protegen: `serving` sigue significando exactamente lo que significaba.
 * El predicado del conmutador de anillos y del poller de cortes es `HTTP 200 ∧ phase=serving ∧
 * pis.serving=N`, y un nodo en espera **no debe** satisfacerlo — rutearle tráfico sería mandar
 * escrituras a un nodo que responde 409. `standby` es un estado NUEVO, no un aflojamiento del viejo.
 *
 * ⚠️ **Qué mide hoy el control negativo de este frente, y por qué NO mide lo que medía ayer.** La
 * medición que motivó todo esto observaba dos nodos sin tráfico pisándose el archivo de gobierno **en
 * silencio**: el archivo alternaba entre el mundo de uno y el del otro, sin un error ni un log. Ese
 * síntoma **ya no se reproduce**, ni siquiera desactivando el plano de control (`VERGIS_CONTROL=single`)
 * — porque el fencing de escritura concurrente que llegó antes lo convirtió en un **fallo ruidoso**:
 * el escritor atrasado aborta y queda `degraded`. El mérito se reparte, y conviene decirlo para que
 * nadie se lo cobre al frente equivocado: **el fencing evita que el pisotón pase inadvertido; el
 * gating de lazos evita que se intente**.
 *
 * Consecuencia práctica para quien vuelva a correr el arnés de dos nodos: el discriminador ya no es
 * «¿alterna el archivo en silencio?» sino **«¿cuántos nodos declaran `serving`, y cuántos abortos por
 * escritura concurrente aparecen en los logs?»**. Con el plano de control apagado: dos nodos en
 * `serving` —un conmutador con el predicado de arriba rutearía a cualquiera— y abortos en el que se
 * quedó atrás. Con el plano encendido: uno `serving`, uno `standby`, cero abortos, y el mundo del
 * standby **nunca aterriza** en el archivo. Un control negativo que se juzgue por el síntoma viejo
 * daría un falso verde y nadie sabría por qué.
 */

const REPORT: Report = { code: 'QW-04', slug: 'qw-04', name: 'Asistencia', specName: 'Asistencia', specPath: '/a.yaml', tables: ['t'], databaseRefs: [] }

function mkReq(url: string, method = 'GET'): IncomingMessage {
  return { url, method, headers: {} } as unknown as IncomingMessage
}

function mkRes() {
  const calls: { status: number; body: string } = { status: 0, body: '' }
  const res = {
    headersSent: false,
    writeHead: (code: number) => {
      calls.status = code
    },
    end: (b?: string) => {
      calls.body = b ?? ''
    },
    destroy: () => {},
  } as unknown as ServerResponse
  return { res, calls }
}

const handlerQueAtiende = { tryHandle: async () => true }

function deps(over: Partial<RouteDeps> = {}): RouteDeps {
  return {
    engine: 'fabric',
    gateSecret: '',
    isReady: () => true,
    getAdmin: () => handlerQueAtiende as never,
    getPiConfig: () => handlerQueAtiende as never,
    getMiranda: () => handlerQueAtiende as never,
    getNotas: () => handlerQueAtiende as never,
    discover: () => [REPORT],
    identityFor: () => ({ agent: 'test', user: 'ana@x.com' }),
    renderReport: async () => '<html>PI</html>',
    indexReports: async (all) => all,
    renderIndexPage: async () => '<html>INDEX</html>',
    canOpenPi: async () => true,
    ...over,
  }
}

const enEspera = { hasControl: () => false, activeHolder: () => `'vergis@host/41' (época 7)` }
const conControl = { hasControl: () => true, activeHolder: () => 'este mismo nodo' }

describe('healthz · la fase standby no relaja serving (#210 · I5)', () => {
  it('sin control → 200 con phase:standby (NO serving) y ok:true', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ control: enEspera, healthSummary: () => ({ total: 2, serving: 2 }) }))(mkReq('/healthz'), res)
    expect(calls.status).toBe(200)
    expect(JSON.parse(calls.body)).toEqual({ ok: true, engine: 'fabric', phase: 'standby', pis: { total: 2, serving: 2 } })
  })

  it('el mismo nodo CON control vuelve a phase:serving', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ control: conControl, healthSummary: () => ({ total: 2, serving: 2 }) }))(mkReq('/healthz'), res)
    expect(JSON.parse(calls.body).phase).toBe('serving')
  })

  it('sin la dep de control, la superficie es la de antes: serving (nodo suelto, regresión cero)', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ healthSummary: () => ({ total: 1, serving: 1 }) }))(mkReq('/healthz'), res)
    expect(JSON.parse(calls.body).phase).toBe('serving')
  })

  it('arrancando gana a standby: `starting` sigue siendo 503', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ isReady: () => false, control: enEspera }))(mkReq('/healthz'), res)
    expect(calls.status).toBe(503)
    expect(JSON.parse(calls.body).phase).toBe('starting')
  })

  it('un standby con PIs degradados sigue delatando la degradación en ok y en los conteos', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ control: enEspera, healthSummary: () => ({ total: 3, serving: 1 }) }))(mkReq('/healthz'), res)
    expect(JSON.parse(calls.body)).toEqual({ ok: false, engine: 'fabric', phase: 'standby', pis: { total: 3, serving: 1 } })
  })
})

describe('mutaciones sin control → 409 nombrando al activo (#210 · I5)', () => {
  const rutas = ['/admin/usuarios', '/qw-04/config', '/impresiones/abc', '/qw-04/notas', '/miranda/sesion']

  for (const url of rutas) {
    it(`POST ${url} sin control → 409 con el activo nombrado`, () => {
      const { res, calls } = mkRes()
      createRequestHandler(deps({ control: enEspera }))(mkReq(url, 'POST'), res)
      expect(calls.status).toBe(409)
      expect(calls.body).toContain('standby')
      expect(calls.body).toContain('vergis@host/41')
      expect(calls.body).toContain('7')
    })

    it(`GET ${url} sin control SÍ se atiende: un standby sirve lecturas`, () => {
      const { res, calls } = mkRes()
      createRequestHandler(deps({ control: enEspera }))(mkReq(url, 'GET'), res)
      expect(calls.status).not.toBe(409)
    })
  }

  it('con control, la misma mutación pasa al handler', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ control: conControl }))(mkReq('/admin/usuarios', 'POST'), res)
    expect(calls.status).not.toBe(409)
  })

  it('sin la dep de control (nodo suelto) la mutación pasa: regresión cero', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps())(mkReq('/admin/usuarios', 'POST'), res)
    expect(calls.status).not.toBe(409)
  })

  it('healthz nunca responde 409, aunque el nodo esté en espera (el conmutador tiene que poder preguntar)', () => {
    const { res, calls } = mkRes()
    createRequestHandler(deps({ control: enEspera }))(mkReq('/healthz', 'POST'), res)
    expect(calls.status).toBe(200)
  })
})

describe('contrato · bloque control derivado del plano vivo (#210 · I6)', () => {
  it('el proveedor se consulta en CADA snapshot: no es una copia del arranque', () => {
    let held = false
    const reg = createContractRegistry({
      engine: 'fabric',
      hotReload: true,
      envSource: {},
      control: () => ({
        mode: 'lease',
        lease: { holder: 'vergis@a/1', epoch: held ? 3 : 0, renewedAt: null, held, file: '/out/control.lease.json' },
        ring: { version: '0.18.0', digest: null, name: null },
        loops: { armed: held, detail: [{ name: 'frescura', everyMs: 1000, armed: held, ticks: 0 }] },
        store: [],
      }),
    })
    expect(reg.snapshot().control?.lease.held).toBe(false)
    expect(reg.snapshot().control?.loops.armed).toBe(false)
    held = true
    expect(reg.snapshot().control?.lease.held).toBe(true)
    expect(reg.snapshot().control?.lease.epoch).toBe(3)
    expect(reg.snapshot().control?.loops.armed).toBe(true)
  })

  it('sin proveedor cableado, `control` es null — se dice, no se finge', () => {
    const reg = createContractRegistry({ engine: 'fabric', hotReload: true, envSource: {} })
    expect(reg.snapshot().control).toBeNull()
  })

  it('un proveedor que lanza NO rompe el contrato: la sección queda null y el resto responde', () => {
    const reg = createContractRegistry({
      engine: 'fabric',
      hotReload: true,
      envSource: {},
      control: () => {
        throw new Error('el lease no se pudo leer')
      },
    })
    const snap = reg.snapshot()
    expect(snap.control).toBeNull()
    expect(snap.engine).toBe('fabric')
  })
})
