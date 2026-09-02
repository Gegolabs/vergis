// UNA SUPERFICIE OPCIONAL NO TUMBA EL NÚCLEO (issue #266) + EL DESTINO DE LA API ES CONFIGURABLE (#265).
//
// Lo medido en el issue: con `MIRANDA_ENABLED` encendido y sin `ANTHROPIC_API_KEY`, `configFromEnv`
// lanzaba, `serve-rls` la llamaba en el top-level del módulo sin try/catch, y `restart: unless-stopped`
// dejaba el contenedor en crashloop — **todos** los PIs de la instancia fuera por una capacidad que usa
// un grupo. Cada test de acá falla en `main`.
//
// El control que impide degradar de más está al final: lo fatal SIGUE siendo fatal.

import { describe, it, expect, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { configFromEnv, configEnvKeys, FATAL_ENVS, DEGRADABLE_ENVS } from '../server/config'
import { createMirandaUnavailable, mirandaTransportFrom, mirandaDestination } from '../server/miranda'
import { createContractRegistry, type MirandaContract } from '../server/contract'

const fixedSecret = () => 'S'

// ── #266 · la config degrada en vez de abortar ─────────────────────────────────────────────────────
describe('config · Miranda degradable (#266)', () => {
  it('flag ON sin key → NO lanza: la capacidad queda apagada con su razón', () => {
    const c = configFromEnv({ MIRANDA_ENABLED: '1' }, fixedSecret)
    expect(c.miranda.enabled).toBe(false)
    expect(c.miranda.disabledReason).toMatch(/ANTHROPIC_API_KEY/)
    // Y el núcleo queda intacto: el resto de la config se construyó igual.
    expect(c.port).toBe(8080)
  })

  it('flag ON con key vacía tras trim → misma degradación (una key en blanco no es una key)', () => {
    const c = configFromEnv({ MIRANDA_ENABLED: '1', ANTHROPIC_API_KEY: '   ' }, fixedSecret)
    expect(c.miranda.enabled).toBe(false)
    expect(c.miranda.disabledReason).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('CONTROL · flag ON con key → enabled, y SIN razón (no se inventa una degradación)', () => {
    const c = configFromEnv({ MIRANDA_ENABLED: '1', ANTHROPIC_API_KEY: 'sk-x' }, fixedSecret)
    expect(c.miranda.enabled).toBe(true)
    expect(c.miranda.disabledReason).toBeUndefined()
  })

  it('CONTROL · flag OFF → apagada y sin razón: nadie la pidió, no hay nada que reportar', () => {
    const c = configFromEnv({}, fixedSecret)
    expect(c.miranda.enabled).toBe(false)
    expect(c.miranda.disabledReason).toBeUndefined()
  })
})

// ── #265 · el destino de la API es configurable ────────────────────────────────────────────────────
describe('config · MIRANDA_API_BASE_URL (#265)', () => {
  const ON = { MIRANDA_ENABLED: '1', ANTHROPIC_API_KEY: 'sk-x' }

  it('URL absoluta → viaja a la config tal cual (sin `/` final)', () => {
    const c = configFromEnv({ ...ON, MIRANDA_API_BASE_URL: 'https://foundry.example/v1' }, fixedSecret)
    expect(c.miranda.enabled).toBe(true)
    expect(c.miranda.baseUrl).toBe('https://foundry.example/v1')
  })

  it('el `/` final se recorta (el transporte concatena `/v1/messages`)', () => {
    const c = configFromEnv({ ...ON, MIRANDA_API_BASE_URL: '  https://gw.example/api/  ' }, fixedSecret)
    expect(c.miranda.baseUrl).toBe('https://gw.example/api')
  })

  it('valor que no es URL → DEGRADABLE: apagada con razón que nombra la env, sin lanzar', () => {
    const c = configFromEnv({ ...ON, MIRANDA_API_BASE_URL: 'no-es-url' }, fixedSecret)
    expect(c.miranda.enabled).toBe(false)
    expect(c.miranda.disabledReason).toMatch(/MIRANDA_API_BASE_URL/)
  })

  it('esquema no http(s) → también degradable (un `file://` no es un gateway)', () => {
    const c = configFromEnv({ ...ON, MIRANDA_API_BASE_URL: 'file:///etc/passwd' }, fixedSecret)
    expect(c.miranda.enabled).toBe(false)
    expect(c.miranda.disabledReason).toMatch(/MIRANDA_API_BASE_URL/)
  })

  it('sin la env → baseUrl undefined (el default vive en el transporte, no duplicado acá)', () => {
    expect(configFromEnv(ON, fixedSecret).miranda.baseUrl).toBeUndefined()
  })

  it('la env aparece en el catálogo derivado de envs conocidas (`configEnvKeys`, #139)', () => {
    expect(configEnvKeys({ ...ON })).toContain('MIRANDA_API_BASE_URL')
  })
})

// El cable que #265 dice que falta: que el destino LLEGUE al transporte. Se prueba sobre la función
// pura extraída de `serve-rls` — cargar el server entero para verificar un argumento sería absurdo.
describe('mirandaTransportFrom · el destino llega al transporte (#265)', () => {
  it('con baseUrl → la fábrica lo recibe junto a la key', () => {
    const make = vi.fn(() => ({ createMessage: async () => ({}) }) as never)
    mirandaTransportFrom({ apiKey: 'sk-x', baseUrl: 'https://foundry.example/v1' }, make)
    expect(make).toHaveBeenCalledWith({ apiKey: 'sk-x', baseUrl: 'https://foundry.example/v1' })
  })

  it('CONTROL · sin baseUrl → la fábrica NO recibe la clave (el default es suyo, no nuestro)', () => {
    const make = vi.fn(() => ({ createMessage: async () => ({}) }) as never)
    mirandaTransportFrom({ apiKey: 'sk-x' }, make)
    expect(make).toHaveBeenCalledWith({ apiKey: 'sk-x' })
  })

  it('`mirandaDestination` publica el HOST, jamás la key', () => {
    expect(mirandaDestination({ baseUrl: 'https://foundry.example/v1' })).toBe('foundry.example')
    expect(mirandaDestination({})).toContain('api.anthropic.com')
  })
})

// ── #266 · el contrato lo declara (degradar no es callar) ──────────────────────────────────────────
describe('contrato · sección Miranda (#266)', () => {
  const snapWith = (m?: () => MirandaContract) =>
    createContractRegistry({ engine: 'fabric', hotReload: true, envSource: {}, miranda: m }).snapshot()

  it('degradada → `enabled:false`, `requested:true` y la razón', () => {
    const cfg = configFromEnv({ MIRANDA_ENABLED: '1' }, fixedSecret).miranda
    const snap = snapWith(() => ({
      enabled: cfg.enabled,
      requested: cfg.enabled || cfg.disabledReason != null,
      ...(cfg.disabledReason ? { disabledReason: cfg.disabledReason } : {}),
    }))
    expect(snap.miranda).toMatchObject({ enabled: false, requested: true })
    expect(snap.miranda?.disabledReason).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('viva → `enabled:true` con modelo y destino (host), sin razón', () => {
    const snap = snapWith(() => ({ enabled: true, requested: true, model: 'claude-sonnet-5', baseUrl: 'foundry.example' }))
    expect(snap.miranda).toEqual({ enabled: true, requested: true, model: 'claude-sonnet-5', baseUrl: 'foundry.example' })
    expect(snap.miranda?.disabledReason).toBeUndefined()
  })

  it('sin proveedor cableado → `null` (el proceso lo dice, no lo finge)', () => {
    expect(snapWith().miranda).toBeNull()
  })

  it('un proveedor que revienta NO rompe `/contrato` (observabilidad, jamás un 500)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const snap = snapWith(() => {
      throw new Error('boom')
    })
    expect(snap.miranda).toBeNull()
    expect(snap.engine).toBe('fabric') // el resto del contrato sobrevive
    err.mockRestore()
  })
})

// ── #266 · la ruta degradada: 503 para quien tiene scope, 403 sin razón para quien no ──────────────
function mkReq(url: string, method = 'GET'): IncomingMessage {
  return { url, method, headers: {} } as unknown as IncomingMessage
}
function mkRes() {
  const calls = { status: 0, body: '' }
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))
  const res = {
    headersSent: false,
    writeHead: (c: number) => {
      calls.status = c
    },
    end: (b?: string) => {
      calls.body = b ?? ''
      resolveDone()
    },
  } as unknown as ServerResponse
  return { res, calls, done }
}

describe('routes · Miranda degradada responde 503 (#266)', () => {
  const RAZON = 'MIRANDA_ENABLED está encendido pero falta ANTHROPIC_API_KEY.'
  const handler = (hasScope: boolean) =>
    createMirandaUnavailable({
      reason: RAZON,
      identityOf: () => ({ user: 'ana@x.com' }),
      hasScope: async () => hasScope,
    })

  it('miembro del grupo → 503 con la razón', async () => {
    const { res, calls, done } = mkRes()
    await handler(true).tryHandle(mkReq('/miranda'), res)
    await done
    expect(calls.status).toBe(503)
    expect(calls.body).toContain('Miranda no disponible')
    expect(calls.body).toContain('ANTHROPIC_API_KEY')
  })

  it('también en las sub-rutas (`/miranda/s/xyz`)', async () => {
    const { res, calls, done } = mkRes()
    await handler(true).tryHandle(mkReq('/miranda/s/xyz'), res)
    await done
    expect(calls.status).toBe(503)
  })

  it('CONTROL · sin scope → el 403 de siempre, y la razón NO se filtra', async () => {
    const { res, calls, done } = mkRes()
    await handler(false).tryHandle(mkReq('/miranda'), res)
    await done
    expect(calls.status).toBe(403)
    expect(calls.body).not.toContain('ANTHROPIC_API_KEY')
    expect(calls.body).toContain('scope')
  })

  it('CONTROL · una ruta ajena no la toca (devuelve false, sigue el router)', async () => {
    const { res, calls } = mkRes()
    expect(await handler(true).tryHandle(mkReq('/pi-1'), res)).toBe(false)
    expect(calls.status).toBe(0)
  })
})

// ── EL CONTROL QUE IMPIDE DEGRADAR DE MÁS ──────────────────────────────────────────────────────────
// Sin esto, «no lanza nunca» pasaría todos los tests de arriba y escondería un nodo que sirve mal.
describe('config · lo FATAL sigue siendo fatal', () => {
  it('VERGIS_ENGINE inválido → lanza (ninguna consulta podría ejecutarse)', () => {
    expect(() => configFromEnv({ VERGIS_ENGINE: 'duckdb' }, fixedSecret)).toThrow(/VERGIS_ENGINE/)
  })
  it('PORT no numérico → lanza (listen(NaN))', () => {
    expect(() => configFromEnv({ PORT: 'abc' }, fixedSecret)).toThrow(/PORT/)
  })
  it('y sigue lanzando aunque Miranda esté degradada en el mismo env (la degradación no absuelve)', () => {
    expect(() => configFromEnv({ MIRANDA_ENABLED: '1', PORT: 'abc' }, fixedSecret)).toThrow(/PORT/)
  })

  it('la clasificación está DECLARADA, no implícita en el orden de validación', () => {
    const fatal = FATAL_ENVS.flatMap((e) => e.envs)
    const degradable = DEGRADABLE_ENVS.flatMap((e) => e.envs)
    // Sin specs no hay nada que servir: fatal, y su validación vive en el arranque de serve-rls.
    expect(fatal).toContain('VERGIS_SPECS_DIR')
    expect(fatal).toContain('VERGIS_SPECS')
    expect(fatal).toContain('VERGIS_ENGINE')
    // Miranda es una superficie opcional: degradable, nunca fatal.
    expect(degradable).toContain('ANTHROPIC_API_KEY')
    expect(degradable).toContain('MIRANDA_API_BASE_URL')
    // Ninguna env puede estar en los dos lados: la distinción sería inútil.
    expect(fatal.filter((e) => degradable.includes(e))).toEqual([])
    // Cada clase declara DÓNDE se hace efectiva (si no, no se puede auditar).
    for (const e of [...FATAL_ENVS, ...DEGRADABLE_ENVS]) {
      expect(e.where.length).toBeGreaterThan(0)
      expect(e.why.length).toBeGreaterThan(0)
    }
  })
})
