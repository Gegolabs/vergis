/**
 * AUTORÍA DE ITEMS EN EL MOTOR (#107 fase 2, hito H1 — diseño `work/004-…/04-107-f2-publicacion-jobs-v1.0.md` §5).
 *
 * El puerto `ItemAuthoringClient` (crear item · leer su definición · actualizarla) y su implementación
 * sobre la API pública de Fabric. Es la pieza que le faltaba a la costura con el motor: hoy el repo
 * dispara corridas, lee run-history y empuja schedules (`intake-onelake.ts`, `fabric-engine.ts`), pero
 * **nada autora**. Vergis publica la CÁSCARA del job (el item que apunta al código del convertidor en
 * `Files/code/…`), jamás el código (D2). Borrar items no está en el puerto a propósito (D8).
 *
 * **Lo que acá es HECHO MEDIDO y no conjetura.** La semántica de la API se copia de
 * `scripts/probe-item-authoring.ts`, que corrió DOS veces contra el tenant real (crudos sellados en el
 * comentario de #107, 2026-08-08):
 *  · `POST /v1/workspaces/{ws}/items` responde **201 DIRECTO** para `SparkJobDefinition` — no LRO.
 *    El camino 202+LRO se mantiene porque la API lo declara y otros tipos de item pueden tomarlo:
 *    ese camino es CONJETURA no medida (etiquetada acá y probada solo con mock).
 *  · El read-back es `POST …/items/{id}/getDefinition`, 200 directo (medido) o 202+LRO (conjetura).
 *  · El nombre de part `SparkJobDefinitionV1.json` lo confirmó el motor en el read-back.
 *  · El motor NORMALIZA lo que persiste (`""` → `null`, re-serialización pretty-print con CRLF) y
 *    puede AGREGAR parts propias. Por eso este módulo **no compara nada**: devuelve las parts crudas
 *    tal como el motor las entrega, y la equivalencia canónica es de otro módulo (Δ1 del plan 006).
 *
 * Molde de estilo: `fabric-engine.ts` — `TokenSource` + `SCOPE_FABRIC`, `fetch` inyectable, timeout de
 * 30 s por llamada.
 */
import { SCOPE_FABRIC, type TokenSource } from './aad-token'

type FetchLike = typeof fetch
type Clock = () => number
type Sleep = (ms: number) => Promise<void>

const FABRIC_API = 'https://api.fabric.microsoft.com/v1'
const HTTP_TIMEOUT_MS = 30_000
/** Tope del poll de un LRO (§5 del diseño). Agotado ⇒ `AuthoringUnknown`, jamás «publicado» (D7). */
const LRO_BUDGET_MS = 120_000
/** Espera por defecto entre polls cuando el motor no manda `Retry-After` (misma que la sonda). */
const LRO_DEFAULT_RETRY_S = 3

// ── Tipos del puerto ─────────────────────────────────────────────────────────────────────────────

/** Una parte de la definición de un item. `payloadBase64` es el contenido en base64 (`InlineBase64`). */
export interface DefinitionPart {
  path: string
  payloadBase64: string
}

/** La definición de un item del motor: el conjunto de sus partes. */
export interface ItemDefinition {
  parts: DefinitionPart[]
}

/** Lo que se declara al crear un item: identidad + tipo + definición. */
export interface ItemDeclaration {
  displayName: string
  /** Tipo del item del motor, p. ej. `SparkJobDefinition` (el medido) o `DataPipeline`. */
  type: string
  description?: string
  definition: ItemDefinition
}

/**
 * Puerto de autoría de items del motor. Tres operaciones, sin borrado (D8: Vergis no borra items).
 * Los fallos viajan como excepciones de la taxonomía de abajo — nunca como valores de retorno, salvo
 * el `null` de `getDefinition`, que significa exactamente «el item no existe» (404).
 */
export interface ItemAuthoringClient {
  /** 201 directo (medido) o 202+LRO. Lanza `AuthoringDenied` | `AuthoringConflict` | `AuthoringUnknown` | `AuthoringError`. */
  createItem(ws: string, decl: ItemDeclaration): Promise<{ itemId: string }>
  /** `null` = el item no existe (404). Las parts vienen crudas: el motor puede normalizar y agregar las suyas. */
  getDefinition(ws: string, itemId: string): Promise<ItemDefinition | null>
  updateDefinition(ws: string, itemId: string, def: ItemDefinition): Promise<void>
}

// ── Taxonomía de error sellada (§5) ──────────────────────────────────────────────────────────────

/**
 * Raíz de los fallos de autoría. Se lanza TAL CUAL para lo que no cae en ninguna de las tres
 * subclases (5xx, 4xx de contenido, LRO en `Failed`): el outcome `fallida` del ledger (D6).
 * Portar `errorCode` y `status` en la raíz es lo que le permite al flujo admin renderizar el código
 * crudo de Fabric sin ramificar por clase.
 */
export class AuthoringError extends Error {
  readonly status: number | undefined
  readonly errorCode: string | undefined
  constructor(message: string, opts: { status?: number; errorCode?: string } = {}) {
    super(message)
    this.name = 'AuthoringError'
    this.status = opts.status
    this.errorCode = opts.errorCode
  }
}

/** 401/403: el motor denegó la autoría. Porta el `errorCode` CRUDO del cuerpo — es el dato que nombra la pieza que falta. */
export class AuthoringDenied extends AuthoringError {
  constructor(message: string, opts: { status?: number; errorCode?: string } = {}) {
    super(message, opts)
    this.name = 'AuthoringDenied'
  }
}

/** El nombre del item ya está en uso en el workspace. */
export class AuthoringConflict extends AuthoringError {
  constructor(message: string, opts: { status?: number; errorCode?: string } = {}) {
    super(message, opts)
    this.name = 'AuthoringConflict'
  }
}

/**
 * El LRO no culminó dentro de la ventana (o culminó sin decir qué pasó): el resultado es DESCONOCIDO,
 * no fallido. Porta el `operationId` para re-observar después (D7, outcome `desconocida`).
 */
export class AuthoringUnknown extends AuthoringError {
  readonly operationId: string | undefined
  constructor(message: string, opts: { operationId?: string; status?: number; errorCode?: string } = {}) {
    super(message, opts)
    this.name = 'AuthoringUnknown'
    this.operationId = opts.operationId
  }
}

// ── Utilidades de protocolo (copiadas de la sonda medida) ─────────────────────────────────────────

/** Extrae el `errorCode` de un cuerpo de error de Fabric, en sus formas conocidas (`errorCodeOf` de la sonda). */
function errorCodeOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as { errorCode?: unknown; error?: { code?: unknown }; code?: unknown }
  const candidate = b.errorCode ?? b.error?.code ?? b.code
  return typeof candidate === 'string' ? candidate : undefined
}

/** Lectura defensiva de un header: los mocks (y algunos runtimes) pueden no traer `headers`. */
function headerOf(res: { headers?: { get?: (name: string) => string | null } | null }, name: string): string | undefined {
  const raw = res.headers?.get?.(name)
  return raw ?? undefined
}

/** `operationId` de un 202: header dedicado o última pata del `Location` (`operationIdOf` de la sonda). */
function operationIdOf(res: { headers?: { get?: (name: string) => string | null } | null }): string | undefined {
  const direct = headerOf(res, 'x-ms-operation-id')
  if (direct) return direct
  const loc = headerOf(res, 'location')
  if (!loc) return undefined
  return /\/operations\/([^/?]+)/.exec(loc)?.[1]
}

/**
 * ¿Este fallo es «el nombre ya está en uso»?
 *
 * **CONJETURA — no medida contra el tenant.** El hito cero nunca provocó una colisión de nombre (usó
 * `vergis_probe_<epoch>`), así que ni el status ni el `errorCode` exactos de este caso están medidos.
 * Se reconoce por el 409 de la API y por los códigos que la documentación pública de Fabric nombra
 * para el caso. Un conflicto real que llegue con otro código caerá en `AuthoringError` con su
 * `errorCode` crudo visible — degrada a «fallida», no a un diagnóstico inventado.
 */
const CONFLICT_CODES = new Set(['itemdisplaynamealreadyinuse', 'displaynamealreadyinuse', 'itemdisplaynamenotavailable', 'duplicateitemname'])
function isConflict(status: number, errorCode: string | undefined): boolean {
  if (status === 409) return true
  return errorCode !== undefined && CONFLICT_CODES.has(errorCode.toLowerCase())
}

interface Respuesta {
  status: number
  headers: { get?: (name: string) => string | null } | null | undefined
  json: unknown
  text: string
  errorCode: string | undefined
}

/** Parts del motor (`{path, payload, payloadType}`) → parts del puerto. */
function partsFrom(body: unknown): DefinitionPart[] | null {
  const parts = (body as { definition?: { parts?: unknown } } | null)?.definition?.parts
  if (!Array.isArray(parts)) return null
  return parts.map((p) => {
    const q = p as { path?: unknown; payload?: unknown }
    return { path: typeof q.path === 'string' ? q.path : '', payloadBase64: typeof q.payload === 'string' ? q.payload : '' }
  })
}

/** Cuerpo `definition` para el motor: `payloadType: 'InlineBase64'` (la forma que el tenant aceptó con 201). */
const definitionBody = (def: ItemDefinition): unknown => ({
  parts: def.parts.map((p) => ({ path: p.path, payload: p.payloadBase64, payloadType: 'InlineBase64' })),
})

// ── Implementación ───────────────────────────────────────────────────────────────────────────────

/**
 * Cliente de autoría sobre Fabric. Mismo Service Principal que el resto de la costura, o el perfil
 * separado de D9: quien construye decide qué `TokenSource` inyecta.
 */
export function createFabricItemAuthoring(
  tokens: TokenSource,
  opts: { fetch?: FetchLike; now?: Clock; sleep?: Sleep } = {},
): ItemAuthoringClient {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))

  async function call(method: string, url: string, body?: unknown): Promise<Respuesta> {
    const { token } = await tokens.getToken(SCOPE_FABRIC)
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await doFetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const text = await res.text().catch(() => '')
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, headers: res.headers, json, text, errorCode: errorCodeOf(json) }
  }

  /** Traduce un status de fallo a la taxonomía. `op` describe la operación para el mensaje. */
  function fallo(op: string, r: Respuesta): AuthoringError {
    const cola = `${r.errorCode ? ` errorCode=${r.errorCode}` : ''}${r.text ? `: ${r.text.slice(0, 300)}` : ''}`
    const opts = { status: r.status, ...(r.errorCode ? { errorCode: r.errorCode } : {}) }
    if (r.status === 401 || r.status === 403) return new AuthoringDenied(`fabric-authoring: ${op} DENEGADO (${r.status})${cola}`, opts)
    if (isConflict(r.status, r.errorCode)) return new AuthoringConflict(`fabric-authoring: ${op} en conflicto (${r.status})${cola}`, opts)
    return new AuthoringError(`fabric-authoring: ${op} falló (${r.status})${cola}`, opts)
  }

  /**
   * Poll de un LRO: `GET /v1/operations/{id}` respetando `Retry-After`, tope 120 s; al `Succeeded` pide
   * `/result`. Semántica calcada de `pollLro` de la sonda. Un 5xx o un tope agotado NO son fallo: son
   * DESCONOCIDO (`AuthoringUnknown` con el operationId) — el motor pudo haber completado la operación.
   */
  async function pollLro(op: string, operationId: string): Promise<unknown> {
    const deadline = now() + LRO_BUDGET_MS
    const desconocido = (detalle: string): AuthoringUnknown =>
      new AuthoringUnknown(`fabric-authoring: ${op} con desenlace DESCONOCIDO (${detalle}); operationId=${operationId}`, { operationId })
    while (now() < deadline) {
      const st = await call('GET', `${FABRIC_API}/operations/${encodeURIComponent(operationId)}`)
      if (st.status >= 500) throw desconocido(`el poll del LRO respondió ${st.status}`)
      if (st.status >= 400) throw fallo(`${op} (poll del LRO)`, st)
      const estado = (st.json as { status?: string } | null)?.status ?? ''
      if (estado === 'Succeeded') {
        const r = await call('GET', `${FABRIC_API}/operations/${encodeURIComponent(operationId)}/result`)
        if (r.status >= 500) throw desconocido(`el LRO culminó pero /result respondió ${r.status}`)
        if (r.status >= 400) throw fallo(`${op} (result del LRO)`, r)
        return r.json
      }
      if (estado === 'Failed') {
        const err = errorCodeOf((st.json as { error?: unknown } | null)?.error) ?? st.errorCode
        throw new AuthoringError(`fabric-authoring: ${op} terminó en Failed${err ? ` (errorCode=${err})` : ''}`, { ...(err ? { errorCode: err } : {}) })
      }
      const retryAfter = Number(headerOf(st, 'retry-after') ?? '')
      const esperaMs = Math.max(1000, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : LRO_DEFAULT_RETRY_S) * 1000)
      await sleep(esperaMs)
    }
    throw desconocido(`no culminó en ${LRO_BUDGET_MS / 1000}s`)
  }

  /** 2xx directo → el cuerpo; 202 → poll del LRO → el `/result`. Cualquier otra cosa, taxonomía. */
  async function resolve(op: string, r: Respuesta): Promise<unknown> {
    if (r.status === 202) {
      const opId = operationIdOf(r)
      if (!opId) throw new AuthoringUnknown(`fabric-authoring: ${op} devolvió 202 SIN operationId (ni x-ms-operation-id ni Location): desenlace DESCONOCIDO`)
      return pollLro(op, opId)
    }
    if (r.status >= 200 && r.status < 300) return r.json
    throw fallo(op, r)
  }

  const itemsUrl = (ws: string): string => `${FABRIC_API}/workspaces/${encodeURIComponent(ws)}/items`
  const itemUrl = (ws: string, itemId: string): string => `${itemsUrl(ws)}/${encodeURIComponent(itemId)}`

  return {
    async createItem(ws, decl): Promise<{ itemId: string }> {
      const body = {
        displayName: decl.displayName,
        type: decl.type,
        ...(decl.description === undefined ? {} : { description: decl.description }),
        definition: definitionBody(decl.definition),
      }
      const r = await call('POST', itemsUrl(ws), body)
      const result = await resolve(`createItem '${decl.displayName}'`, r)
      const itemId = (result as { id?: unknown } | null)?.id
      if (typeof itemId !== 'string' || !itemId) {
        // El motor aceptó pero no dijo QUÉ creó: puede haber un item vivo sin identidad conocida.
        // Eso es desconocido (re-observable por nombre), jamás un éxito silencioso (D7).
        throw new AuthoringUnknown(
          `fabric-authoring: createItem '${decl.displayName}' respondió éxito (${r.status}) pero sin 'id' del item creado: desenlace DESCONOCIDO`,
          { status: r.status, ...(operationIdOf(r) ? { operationId: operationIdOf(r) } : {}) },
        )
      }
      return { itemId }
    },

    async getDefinition(ws, itemId): Promise<ItemDefinition | null> {
      const r = await call('POST', `${itemUrl(ws, itemId)}/getDefinition`)
      if (r.status === 404) return null // el item no existe — el único fallo que NO es excepción
      const result = await resolve(`getDefinition '${itemId}'`, r)
      const parts = partsFrom(result)
      if (!parts) {
        throw new AuthoringError(`fabric-authoring: getDefinition '${itemId}' respondió ${r.status} sin 'definition.parts' en el cuerpo`, { status: r.status })
      }
      return { parts }
    },

    async updateDefinition(ws, itemId, def): Promise<void> {
      const r = await call('POST', `${itemUrl(ws, itemId)}/updateDefinition`, { definition: definitionBody(def) })
      await resolve(`updateDefinition '${itemId}'`, r)
    },
  }
}
