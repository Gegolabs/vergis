/**
 * H1 de #107 fase 2 — capability de autoría de items del motor (`fabric-authoring.ts`).
 *
 * El arnés es un `fetch` mock guionado por (método, fragmento de URL): cada caso declara la secuencia
 * exacta de respuestas del motor y el test afirma sobre las llamadas REALES que salieron. El reloj y
 * el `sleep` se inyectan: el caso de tope del LRO se mide sin esperar 120 s de verdad.
 *
 * Las formas de respuesta felices (201 directo del `POST /items`, 200 del `getDefinition`, part
 * `SparkJobDefinitionV1.json`) son las MEDIDAS contra el tenant en el hito cero (crudos en #107).
 * Las de 202+LRO, conflicto de nombre y `Failed` son formas declaradas por la API pero NO medidas —
 * acá se ejercen contra mock, que prueba el manejo del cliente, no el comportamiento del motor.
 */
import { describe, it, expect } from 'vitest'
import {
  createFabricItemAuthoring,
  AuthoringError,
  AuthoringDenied,
  AuthoringConflict,
  AuthoringUnknown,
  type TokenSource,
  type ItemDefinition,
} from '@vergis/capabilities'

const tokens: TokenSource = { getToken: async () => ({ token: 'BEARER123', expiresAt: Number.MAX_SAFE_INTEGER }) }

const WS = '1d331022-097a-4c5b-a1ee-e77493a75073'
const SJD_PART = 'SparkJobDefinitionV1.json'
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

const DEF: ItemDefinition = { parts: [{ path: SJD_PART, payloadBase64: b64('{"language":"Python"}') }] }
const DECL = { displayName: 'ingesta_plantacion', type: 'SparkJobDefinition', description: 'cáscara del job', definition: DEF }

interface Call { url: string; method: string; body?: string }
interface Guion {
  /** Fragmento de URL que esta respuesta atiende (en orden: la primera no consumida que matchea). */
  match: string
  status: number
  body?: unknown
  headers?: Record<string, string>
  /** Si es `false`, la respuesta se reusa indefinidamente (default: se consume una vez). */
  once?: boolean
}

/** Mock de `fetch` guionado. Registra toda llamada en `calls`; sin guion que matchee, explota el test. */
function mockFetch(guion: Guion[], calls: Call[] = []): typeof fetch {
  const pendientes = guion.map((g) => ({ ...g, usado: false }))
  return (async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body })
    const g = pendientes.find((p) => u.includes(p.match) && !(p.once !== false && p.usado))
    if (!g) throw new Error(`el mock no tiene guion para ${init?.method ?? 'GET'} ${u}`)
    g.usado = true
    const text = g.body === undefined ? '' : JSON.stringify(g.body)
    return {
      status: g.status,
      ok: g.status >= 200 && g.status < 300,
      headers: { get: (n: string) => g.headers?.[n.toLowerCase()] ?? null },
      text: async () => text,
    } as unknown as Response
  }) as unknown as typeof fetch
}

/** Reloj y sleep de laboratorio: el `sleep` no espera, adelanta el reloj. Así el tope de 120 s se mide en microsegundos. */
function laboratorio(): { now: () => number; sleep: (ms: number) => Promise<void>; dormido: () => number } {
  let t = Date.parse('2026-08-08T12:00:00Z')
  let dormido = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      dormido += ms
      t += ms
    },
    dormido: () => dormido,
  }
}

describe('createFabricItemAuthoring · createItem', () => {
  it('201 DIRECTO (el camino MEDIDO contra el tenant): devuelve el itemId y manda parts como InlineBase64', async () => {
    const calls: Call[] = []
    const client = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/items', status: 201, body: { id: 'ITEM-1' } }], calls) })

    expect(await client.createItem(WS, DECL)).toEqual({ itemId: 'ITEM-1' })

    expect(calls).toHaveLength(1) // 201 directo ⇒ NI UN poll de LRO
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`https://api.fabric.microsoft.com/v1/workspaces/${WS}/items`)
    const body = JSON.parse(calls[0]!.body!)
    expect(body.displayName).toBe('ingesta_plantacion')
    expect(body.type).toBe('SparkJobDefinition')
    expect(body.description).toBe('cáscara del job')
    expect(body.definition.parts).toEqual([{ path: SJD_PART, payload: DEF.parts[0]!.payloadBase64, payloadType: 'InlineBase64' }])
  })

  it('202 + LRO → Succeeded: poll con Retry-After hasta el /result, del que sale el itemId', async () => {
    const calls: Call[] = []
    const lab = laboratorio()
    const client = createFabricItemAuthoring(tokens, {
      now: lab.now,
      sleep: lab.sleep,
      fetch: mockFetch(
        [
          { match: `/workspaces/${WS}/items`, status: 202, headers: { 'x-ms-operation-id': 'OP-7' } },
          { match: '/operations/OP-7/result', status: 200, body: { id: 'ITEM-9' }, once: false },
          { match: '/operations/OP-7', status: 200, body: { status: 'Running' }, headers: { 'retry-after': '5' } },
          { match: '/operations/OP-7', status: 200, body: { status: 'Succeeded' }, once: false },
        ],
        calls,
      ),
    })

    expect(await client.createItem(WS, DECL)).toEqual({ itemId: 'ITEM-9' })
    expect(calls.map((c) => c.url.split('/v1/')[1])).toEqual([
      `workspaces/${WS}/items`,
      'operations/OP-7',
      'operations/OP-7',
      'operations/OP-7/result',
    ])
    expect(lab.dormido()).toBe(5_000) // respetó el Retry-After: 5 s, no el default de 3
  })

  it('202 con Location en vez de header dedicado: el operationId sale de la última pata de la URL', async () => {
    const calls: Call[] = []
    const lab = laboratorio()
    const client = createFabricItemAuthoring(tokens, {
      now: lab.now,
      sleep: lab.sleep,
      fetch: mockFetch(
        [
          { match: `/workspaces/${WS}/items`, status: 202, headers: { location: 'https://api.fabric.microsoft.com/v1/operations/OP-LOC?x=1' } },
          { match: '/operations/OP-LOC/result', status: 200, body: { id: 'ITEM-LOC' }, once: false },
          { match: '/operations/OP-LOC', status: 200, body: { status: 'Succeeded' }, once: false },
        ],
        calls,
      ),
    })
    expect(await client.createItem(WS, DECL)).toEqual({ itemId: 'ITEM-LOC' })
  })

  it('LRO que nunca culmina → AuthoringUnknown PORTANDO el operationId, y jamás «creado»', async () => {
    const lab = laboratorio()
    const client = createFabricItemAuthoring(tokens, {
      now: lab.now,
      sleep: lab.sleep,
      fetch: mockFetch([
        { match: `/workspaces/${WS}/items`, status: 202, headers: { 'x-ms-operation-id': 'OP-COLGADO' } },
        { match: '/operations/OP-COLGADO', status: 200, body: { status: 'Running' }, once: false },
      ]),
    })

    const err = await client.createItem(WS, DECL).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthoringUnknown)
    expect((err as AuthoringUnknown).operationId).toBe('OP-COLGADO')
    expect((err as Error).message).toContain('DESCONOCIDO')
    expect(lab.dormido()).toBeGreaterThanOrEqual(120_000) // el tope de 120 s se agotó de verdad (reloj de laboratorio)
  })

  it('202 SIN operationId (ni header ni Location) → AuthoringUnknown: no se inventa un éxito', async () => {
    const client = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/items', status: 202 }]) })
    const err = await client.createItem(WS, DECL).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthoringUnknown)
    expect((err as AuthoringUnknown).operationId).toBeUndefined()
  })

  it('éxito 201 pero sin `id` en el cuerpo → AuthoringUnknown (pudo quedar un item vivo sin identidad)', async () => {
    const client = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/items', status: 201, body: { displayName: 'x' } }]) })
    await expect(client.createItem(WS, DECL)).rejects.toBeInstanceOf(AuthoringUnknown)
  })

  it('403 con errorCode → AuthoringDenied PORTANDO el errorCode crudo y el status', async () => {
    const client = createFabricItemAuthoring(tokens, {
      fetch: mockFetch([{ match: '/items', status: 403, body: { errorCode: 'InsufficientPrivileges', message: 'no.' } }]),
    })
    const err = await client.createItem(WS, DECL).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthoringDenied)
    expect((err as AuthoringDenied).errorCode).toBe('InsufficientPrivileges')
    expect((err as AuthoringDenied).status).toBe(403)
    expect((err as Error).message).toContain('InsufficientPrivileges')
  })

  it('401 sin errorCode en el cuerpo → AuthoringDenied igual (el status manda), errorCode undefined', async () => {
    const client = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/items', status: 401 }]) })
    const err = await client.createItem(WS, DECL).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthoringDenied)
    expect((err as AuthoringDenied).errorCode).toBeUndefined()
  })

  it('errorCode del cuerpo anidado (`error.code`) también se extrae', async () => {
    const client = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/items', status: 403, body: { error: { code: 'PrincipalTypeNotSupported' } } }]) })
    const err = await client.createItem(WS, DECL).catch((e: unknown) => e)
    expect((err as AuthoringDenied).errorCode).toBe('PrincipalTypeNotSupported')
  })

  it('nombre en uso → AuthoringConflict, tanto por 409 como por errorCode conocido', async () => {
    const porStatus = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/items', status: 409, body: { errorCode: 'ItemDisplayNameAlreadyInUse' } }]) })
    const e1 = await porStatus.createItem(WS, DECL).catch((e: unknown) => e)
    expect(e1).toBeInstanceOf(AuthoringConflict)
    expect((e1 as AuthoringConflict).errorCode).toBe('ItemDisplayNameAlreadyInUse')

    // CONJETURA (no medida): Fabric puede reportar la colisión con 400 + errorCode en vez de 409.
    const porCodigo = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/items', status: 400, body: { errorCode: 'ItemDisplayNameAlreadyInUse' } }]) })
    await expect(porCodigo.createItem(WS, DECL)).rejects.toBeInstanceOf(AuthoringConflict)
  })

  it('4xx de CONTENIDO (no permisos, no conflicto) → AuthoringError con su errorCode: es «fallida», no «denegada»', async () => {
    const client = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/items', status: 400, body: { errorCode: 'InvalidItemDefinition' } }]) })
    const err = await client.createItem(WS, DECL).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthoringError)
    expect(err).not.toBeInstanceOf(AuthoringDenied)
    expect(err).not.toBeInstanceOf(AuthoringConflict)
    expect((err as AuthoringError).errorCode).toBe('InvalidItemDefinition')
  })

  it('LRO que termina en Failed → AuthoringError con el errorCode del LRO (no es «desconocida»)', async () => {
    const lab = laboratorio()
    const client = createFabricItemAuthoring(tokens, {
      now: lab.now,
      sleep: lab.sleep,
      fetch: mockFetch([
        { match: `/workspaces/${WS}/items`, status: 202, headers: { 'x-ms-operation-id': 'OP-F' } },
        { match: '/operations/OP-F', status: 200, body: { status: 'Failed', error: { code: 'ItemCreationFailed' } }, once: false },
      ]),
    })
    const err = await client.createItem(WS, DECL).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthoringError)
    expect(err).not.toBeInstanceOf(AuthoringUnknown)
    expect((err as AuthoringError).errorCode).toBe('ItemCreationFailed')
  })

  it('5xx durante el poll del LRO → AuthoringUnknown con operationId (el motor pudo haber completado)', async () => {
    const lab = laboratorio()
    const client = createFabricItemAuthoring(tokens, {
      now: lab.now,
      sleep: lab.sleep,
      fetch: mockFetch([
        { match: `/workspaces/${WS}/items`, status: 202, headers: { 'x-ms-operation-id': 'OP-5XX' } },
        { match: '/operations/OP-5XX', status: 503, once: false },
      ]),
    })
    const err = await client.createItem(WS, DECL).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthoringUnknown)
    expect((err as AuthoringUnknown).operationId).toBe('OP-5XX')
  })
})

describe('createFabricItemAuthoring · getDefinition', () => {
  it('200 directo (camino MEDIDO): POST a /getDefinition y las parts vienen CRUDAS, incluidas las que el motor agrega', async () => {
    const calls: Call[] = []
    const client = createFabricItemAuthoring(tokens, {
      fetch: mockFetch(
        [
          {
            match: '/getDefinition',
            status: 200,
            body: {
              definition: {
                parts: [
                  { path: SJD_PART, payload: b64('{"language":"Python"}'), payloadType: 'InlineBase64' },
                  { path: '.platform', payload: b64('{"metadata":{}}'), payloadType: 'InlineBase64' },
                ],
              },
            },
          },
        ],
        calls,
      ),
    })

    const def = await client.getDefinition(WS, 'ITEM-1')
    expect(def).toEqual({
      parts: [
        { path: SJD_PART, payloadBase64: b64('{"language":"Python"}') },
        { path: '.platform', payloadBase64: b64('{"metadata":{}}') }, // el motor agrega parts propias: se devuelven tal cual
      ],
    })
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`https://api.fabric.microsoft.com/v1/workspaces/${WS}/items/ITEM-1/getDefinition`)
  })

  it('404 → null (el item no existe): el único fallo que NO es excepción', async () => {
    const client = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/getDefinition', status: 404, body: { errorCode: 'EntityNotFound' } }]) })
    expect(await client.getDefinition(WS, 'FANTASMA')).toBeNull()
  })

  it('202 + LRO → las parts salen del /result del LRO', async () => {
    const lab = laboratorio()
    const client = createFabricItemAuthoring(tokens, {
      now: lab.now,
      sleep: lab.sleep,
      fetch: mockFetch([
        { match: '/getDefinition', status: 202, headers: { 'x-ms-operation-id': 'OP-G' } },
        { match: '/operations/OP-G/result', status: 200, body: { definition: { parts: [{ path: SJD_PART, payload: 'QUJD' }] } }, once: false },
        { match: '/operations/OP-G', status: 200, body: { status: 'Succeeded' }, once: false },
      ]),
    })
    expect(await client.getDefinition(WS, 'ITEM-1')).toEqual({ parts: [{ path: SJD_PART, payloadBase64: 'QUJD' }] })
  })

  it('403 → AuthoringDenied (denegar la lectura NO se confunde con «no existe»)', async () => {
    const client = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/getDefinition', status: 403, body: { errorCode: 'InsufficientPrivileges' } }]) })
    await expect(client.getDefinition(WS, 'ITEM-1')).rejects.toBeInstanceOf(AuthoringDenied)
  })

  it('200 sin definition.parts → AuthoringError (no se devuelve una definición vacía inventada)', async () => {
    const client = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/getDefinition', status: 200, body: { algo: 'otra cosa' } }]) })
    await expect(client.getDefinition(WS, 'ITEM-1')).rejects.toBeInstanceOf(AuthoringError)
  })
})

describe('createFabricItemAuthoring · updateDefinition', () => {
  it('POST a /updateDefinition con las parts InlineBase64; 200 resuelve sin más llamadas', async () => {
    const calls: Call[] = []
    const client = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/updateDefinition', status: 200, body: {} }], calls) })
    await client.updateDefinition(WS, 'ITEM-1', DEF)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://api.fabric.microsoft.com/v1/workspaces/${WS}/items/ITEM-1/updateDefinition`)
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      definition: { parts: [{ path: SJD_PART, payload: DEF.parts[0]!.payloadBase64, payloadType: 'InlineBase64' }] },
    })
  })

  it('202 + LRO → espera el Succeeded antes de dar por hecho el update', async () => {
    const calls: Call[] = []
    const lab = laboratorio()
    const client = createFabricItemAuthoring(tokens, {
      now: lab.now,
      sleep: lab.sleep,
      fetch: mockFetch(
        [
          { match: '/updateDefinition', status: 202, headers: { 'x-ms-operation-id': 'OP-U' } },
          { match: '/operations/OP-U/result', status: 200, body: {}, once: false },
          { match: '/operations/OP-U', status: 200, body: { status: 'Succeeded' }, once: false },
        ],
        calls,
      ),
    })
    await client.updateDefinition(WS, 'ITEM-1', DEF)
    expect(calls.map((c) => c.url.split('/v1/')[1])).toEqual([
      `workspaces/${WS}/items/ITEM-1/updateDefinition`,
      'operations/OP-U',
      'operations/OP-U/result',
    ])
    expect(lab.dormido()).toBe(0) // Succeeded al primer poll ⇒ no durmió
  })

  it('403 → AuthoringDenied con el errorCode crudo', async () => {
    const client = createFabricItemAuthoring(tokens, { fetch: mockFetch([{ match: '/updateDefinition', status: 403, body: { errorCode: 'InsufficientPrivileges' } }]) })
    const err = await client.updateDefinition(WS, 'ITEM-1', DEF).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthoringDenied)
    expect((err as AuthoringDenied).errorCode).toBe('InsufficientPrivileges')
  })
})
