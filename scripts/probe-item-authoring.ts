/**
 * SONDA DEL HITO CERO de #107 fase 2 (diseño `work/004-.../04-107-f2-publicacion-jobs-v1.0.md` §3).
 *
 * Pregunta que responde: ¿puede el SP de esta instancia CREAR, LEER, ENCADENAR y BORRAR la definición
 * de un item ejecutable (SparkJobDefinition) en el workspace del tenant, vía la API pública de Fabric?
 *
 * NO es un test ni parte de producción: es un INSTRUMENTO DE MEDICIÓN de un solo uso, que ESCRIBE en el
 * tenant (crea un item `vergis_probe_<epoch>` y lo borra). Por eso:
 *
 *  · SIN FLAGS NO TOCA RED. Invocada en seco imprime el plan completo de lo que haría y sale 0. Escribir
 *    exige `--workspace`, `--known-item` y `--live` explícitos — no hay default que escriba.
 *  · SE CALIBRA ANTES DE MEDIR (Ley de Wingworking, Norma 7 · corolario de instrumentos). El paso A es un
 *    control POSITIVO (un GET que producción ya ejerce con el mismo token) y el A2 un control NEGATIVO
 *    (404 esperado). Si A falla, la sonda declara NO PUDE MEDIR y se detiene sin concluir NADA sobre
 *    autoría; si A2 no da 404, la sonda declara su propio instrumento roto y se detiene.
 *  · IMPRIME CRUDOS POR PASO: método, URL, status HTTP, `errorCode` del cuerpo y veredicto del paso.
 *    Jamás resume sin ellos.
 *  · NO REPITE SOLA. Un 4xx una sola vez no es veredicto (§3): la sonda lo dice y el OPERADOR corre la
 *    sonda una segunda vez para descartar transitorio.
 *
 * Uso:
 *   # en seco — imprime el plan, no toca red, sale 0
 *   npx tsx scripts/probe-item-authoring.ts
 *
 *   # real (exige el OK de César — gate humano, §3)
 *   VERGIS_CONNECTIONS=/ruta/connections.json VERGIS_INTAKE_SP=dwh \
 *     npx tsx scripts/probe-item-authoring.ts --workspace <wsId> --known-item <itemId> --live
 *
 * Flags: --workspace <id> · --known-item <id> · --live · --connections <ruta|JSON> · --sp <database_ref>
 * (los dos últimos son el puerto de credencial de #66: mismo `VERGIS_CONNECTIONS`/`VERGIS_INTAKE_SP` que
 * usa `server/serve-rls.ts`; nada del tenant vive en este archivo).
 *
 * Códigos de salida (legend impresa también al final de cada corrida):
 *   0 · plan en seco, o corrida concluyente POSITIVA (cadena B+C+D medida)
 *   2 · NO PUDE MEDIR (token, red, 5xx, timeout, o control positivo A caído) — cero conclusión
 *   3 · INSTRUMENTO ROTO (el control negativo A2 no reportó el 404 esperado)
 *   4 · RESIDUO SIN LIMPIAR en el tenant (manda sobre cualquier otro código)
 *   5 · NEGATIVO MEDIDO — el motor denegó la autoría (401/403 con errorCode)
 *   6 · PUBLICACIÓN NO CONFIABLE — creó pero el read-back no devolvió lo enviado
 *   7 · NO CONCLUYENTE — la definición mínima fue rechazada por su CONTENIDO (4xx no de permisos)
 *   8 · POSITIVO PARCIAL — crear y leer sí; encadenar el schedule (paso D) no
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
// Import directo al módulo hoja (no al barrel `@vergis/capabilities`): el barrel arrastra `mssql`
// y `sql.js` en tiempo de evaluación, lo que impide bundlear la sonda como .mjs autocontenido para
// correrla dentro del contenedor de la VM (donde vive el secreto, Ley WW Norma 5). `aad-token.ts`
// solo tiene un import type-only de mssql, que se borra al compilar → bundle chico y sin nativos.
import { credentialProviderFor, SCOPE_FABRIC, type CredentialSource, type TokenSource } from '../packages/capabilities/src/aad-token'

const FABRIC_API = 'https://api.fabric.microsoft.com/v1'
const HTTP_TIMEOUT_MS = 30_000
const LRO_BUDGET_MS = 120_000 // tope del poll de LRO (§3, paso B)
const ITEM_TYPE = 'SparkJobDefinition'
const MAIN_PART_PATH = 'SparkJobDefinitionV1.json' // conjetura de §3 (fila 6): la corrida la confirma o la refuta
const JOB_TYPE = 'sparkjob' // el jobType de fase 1 para SJD (`fabric-engine.ts:62` arma la URL con él)

const EXIT = { ok: 0, noPudeMedir: 2, instrumentoRoto: 3, residuo: 4, negativo: 5, noConfiable: 6, noConcluyente: 7, parcial: 8 } as const

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────
interface Flags {
  workspace?: string
  knownItem?: string
  live: boolean
  connections?: string
  sp?: string
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { live: false }
  const known = new Set(['workspace', 'known-item', 'live', 'connections', 'sp'])
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (!raw.startsWith('--')) throw new Error(`argumento suelto '${raw}': esta sonda solo acepta flags --nombre valor.`)
    const eq = raw.indexOf('=')
    const name = (eq === -1 ? raw.slice(2) : raw.slice(2, eq)).trim()
    if (!known.has(name)) throw new Error(`flag desconocido '--${name}' (válidos: ${[...known].map((k) => `--${k}`).join(' ')}).`)
    if (name === 'live') {
      flags.live = eq === -1 ? true : argv[i]!.slice(eq + 1) !== 'false'
      continue
    }
    const value = eq === -1 ? argv[++i] : raw.slice(eq + 1)
    if (!value || value.startsWith('--')) throw new Error(`el flag '--${name}' exige un valor.`)
    if (name === 'workspace') flags.workspace = value
    else if (name === 'known-item') flags.knownItem = value
    else if (name === 'connections') flags.connections = value
    else if (name === 'sp') flags.sp = value
  }
  return flags
}

// ── Crudos ─────────────────────────────────────────────────────────────────────────────────────────
interface Crudo {
  method: string
  url: string
  /** 0 = no hubo respuesta HTTP (red/timeout): eso NO es un negativo, es un «no pude medir». */
  status: number
  errorCode?: string
  detail?: string
}

const crudos: Crudo[] = []
let vio4xx = false

const line = (s = ''): void => console.log(s)
const titulo = (s: string): void => {
  line()
  line(`── ${s} ${'─'.repeat(Math.max(0, 96 - s.length))}`)
}

/** Extrae el `errorCode` de un cuerpo de error de Fabric, en sus formas conocidas. */
function errorCodeOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as { errorCode?: unknown; error?: { code?: unknown }; code?: unknown }
  const candidate = b.errorCode ?? b.error?.code ?? b.code
  return typeof candidate === 'string' ? candidate : undefined
}

interface Respuesta {
  status: number
  headers: Headers | null
  json: unknown
  text: string
  errorCode?: string
  /** Mensaje del fallo de red/timeout: presente ⇒ NO hubo respuesta HTTP. */
  networkError?: string
}

/** Una llamada HTTP con su crudo impreso. NUNCA lanza por status: el status ES el dato. */
async function call(paso: string, method: string, url: string, init: RequestInit = {}): Promise<Respuesta> {
  let res: Response
  try {
    res = await fetch(url, { ...init, method, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  } catch (e) {
    const msg = (e as Error).message
    crudos.push({ method, url, status: 0, detail: msg })
    line(`  [${paso}] ${method} ${url}`)
    line(`  [${paso}] status: (sin respuesta HTTP) · red/timeout: ${msg}`)
    return { status: 0, headers: null, json: null, text: '', networkError: msg }
  }
  const text = await res.text().catch(() => '')
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  const errorCode = errorCodeOf(json)
  if (res.status >= 400 && res.status < 500) vio4xx = true
  crudos.push({ method, url, status: res.status, ...(errorCode ? { errorCode } : {}), ...(text ? { detail: text.slice(0, 300) } : {}) })
  line(`  [${paso}] ${method} ${url}`)
  line(`  [${paso}] status: ${res.status}${errorCode ? ` · errorCode: ${errorCode}` : ''}`)
  if (text) line(`  [${paso}] cuerpo (300 chars): ${text.slice(0, 300).replace(/\s+/g, ' ')}`)
  return { status: res.status, headers: res.headers, json, text, ...(errorCode ? { errorCode } : {}) }
}

// ── LRO ────────────────────────────────────────────────────────────────────────────────────────────
type LroDesenlace =
  | { kind: 'succeeded'; result: unknown }
  | { kind: 'failed'; errorCode?: string }
  | { kind: 'timeout'; operationId: string }
  | { kind: 'nomedir'; detail: string }

/**
 * Poll de un LRO de Fabric: `GET /v1/operations/{id}` respetando `Retry-After`, con tope de 120 s.
 * Al culminar `Succeeded` pide `/result` (donde vive el item creado o la definición leída).
 */
async function pollLro(paso: string, operationId: string, headers: Record<string, string>): Promise<LroDesenlace> {
  const deadline = Date.now() + LRO_BUDGET_MS
  line(`  [${paso}] LRO operationId=${operationId} · tope ${LRO_BUDGET_MS / 1000}s`)
  while (Date.now() < deadline) {
    const op = await call(paso, 'GET', `${FABRIC_API}/operations/${encodeURIComponent(operationId)}`, { headers })
    if (op.networkError) return { kind: 'nomedir', detail: op.networkError }
    if (op.status >= 500) return { kind: 'nomedir', detail: `LRO respondió ${op.status}` }
    if (op.status >= 400) return { kind: 'failed', ...(op.errorCode ? { errorCode: op.errorCode } : {}) }
    const estado = (op.json as { status?: string } | null)?.status ?? ''
    if (estado === 'Succeeded') {
      const r = await call(paso, 'GET', `${FABRIC_API}/operations/${encodeURIComponent(operationId)}/result`, { headers })
      if (r.networkError) return { kind: 'nomedir', detail: r.networkError }
      if (r.status >= 400) return { kind: 'failed', ...(r.errorCode ? { errorCode: r.errorCode } : {}) }
      return { kind: 'succeeded', result: r.json }
    }
    if (estado === 'Failed') {
      const err = errorCodeOf((op.json as { error?: unknown } | null)?.error) ?? op.errorCode
      return { kind: 'failed', ...(err ? { errorCode: err } : {}) }
    }
    const retryAfter = Number(op.headers?.get('retry-after') ?? '')
    const esperaMs = Math.max(1000, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 3) * 1000)
    line(`  [${paso}] LRO status=${estado || '(sin status)'} · reintento en ${esperaMs / 1000}s`)
    await new Promise((r) => setTimeout(r, esperaMs))
  }
  return { kind: 'timeout', operationId }
}

/** operationId de un 202: header dedicado o última pata del `Location`. */
function operationIdOf(headers: Headers | null): string | undefined {
  const direct = headers?.get('x-ms-operation-id')
  if (direct) return direct
  const loc = headers?.get('location')
  if (!loc) return undefined
  const m = /\/operations\/([^/?]+)/.exec(loc)
  return m?.[1]
}

// ── La definición mínima (CONJETURA — la corrida la confirma o la refuta) ───────────────────────────
/**
 * Contenido mínimo plausible de `SparkJobDefinitionV1.json`, tomado de la documentación pública de
 * Fabric: NO verificado contra el tenant (§1 del diseño: todo lo que se afirma de la API de autoría es
 * conjetura hasta esta corrida). Si el motor la rechaza por CONTENIDO, ese `errorCode` es el dato que la
 * sonda imprime crudo — y NO es un negativo de permisos (por eso el veredicto separado, salida 7).
 */
function definicionMinima(): { path: string; payload: string; payloadType: 'InlineBase64' } {
  const sjd = {
    executableFile: null,
    defaultLakehouseArtifactId: '',
    mainClass: '',
    additionalLakehouseIds: [] as string[],
    retryPolicy: null,
    commandLineArguments: '',
    additionalLibraryUris: [] as string[],
    language: 'Python',
    environmentArtifactId: null,
  }
  return { path: MAIN_PART_PATH, payload: Buffer.from(JSON.stringify(sjd), 'utf8').toString('base64'), payloadType: 'InlineBase64' }
}

/** Firma comparable de un conjunto de parts: `path\n<payloadBase64>`, ordenado por path (D5/§4). */
function firmaParts(parts: readonly { path?: string; payload?: string }[]): string {
  return [...parts]
    .map((p) => `${p.path ?? ''}\n${p.payload ?? ''}`)
    .sort()
    .join('\n--\n')
}

// ── Plan (lo que la sonda haría) ───────────────────────────────────────────────────────────────────
function imprimePlan(nombreItem: string, ws: string, known: string, live: boolean): void {
  titulo('PLAN — qué haría esta sonda')
  line(`  workspace     : ${ws}`)
  line(`  item conocido : ${known}   (control positivo del paso A)`)
  line(`  item a crear  : ${nombreItem}  · tipo ${ITEM_TYPE} · part '${MAIN_PART_PATH}' (InlineBase64)`)
  line(`  modo          : ${live ? 'REAL — ESCRIBE EN EL TENANT' : 'EN SECO — no se toca la red'}`)
  line()
  line(`  A  · control positivo  GET    ${FABRIC_API}/workspaces/{ws}/items/{itemConocido}/jobs/instances`)
  line('       espera 2xx. Falla ⇒ NO PUDE MEDIR y la sonda SE DETIENE sin concluir nada de autoría.')
  line(`  A2 · control negativo  GET    ${FABRIC_API}/workspaces/{ws}/items/{uuid-inexistente}/jobs/instances`)
  line('       espera 404. Si no llega 404, el instrumento está roto y la sonda SE DETIENE.')
  line(`  B  · crear             POST   ${FABRIC_API}/workspaces/{ws}/items`)
  line(`       {displayName: '${nombreItem}', type: '${ITEM_TYPE}', definition.parts: ['${MAIN_PART_PATH}']}`)
  line(`       201 directo, o 202 ⇒ poll GET ${FABRIC_API}/operations/{id} con Retry-After (tope 120 s).`)
  line(`  C  · read-back         POST   ${FABRIC_API}/workspaces/{ws}/items/{id}/getDefinition`)
  line('       compara las parts devueltas contra las enviadas (path + payload base64).')
  line(`  D  · encadenar         POST   ${FABRIC_API}/workspaces/{ws}/items/{id}/jobs/${JOB_TYPE}/schedules`)
  line("       cuerpo Cron con {enabled: false} — misma forma de URL/cuerpo que `fabric-engine.ts` (schedule INOCUO: nace apagado).")
  line(`  E  · limpiar           DELETE ${FABRIC_API}/workspaces/{ws}/items/{id}`)
  line(`       + GET de verificación esperando 404. Si falla, la sonda GRITA el nombre del residuo y sale ${EXIT.residuo}.`)
  line()
  line('  Credencial: puerto de #66 (`aad-token.ts`), scope SCOPE_FABRIC, perfil tomado de')
  line('  --connections/VERGIS_CONNECTIONS + --sp/VERGIS_INTAKE_SP. Nada del tenant vive en este archivo.')
}

function imprimeUso(): void {
  titulo('CÓMO SE CORRE DE VERDAD (exige el gate humano de §3)')
  line('  VERGIS_CONNECTIONS=<ruta|JSON> VERGIS_INTAKE_SP=<database_ref> \\')
  line('    npx tsx scripts/probe-item-authoring.ts --workspace <wsId> --known-item <itemId> --live')
  line()
  line('  Sin --workspace, --known-item y --live la sonda NO toca la red: imprime este plan y sale 0.')
  line('  La sonda ESCRIBE en el tenant (crea y borra un item). Correrla exige el OK de César sobre:')
  line('  (i) correrla, (ii) el workspace (D12), (iii) con qué perfil de credencial (D9).')
}

// ── Credencial (puerto de #66) ─────────────────────────────────────────────────────────────────────
function resuelveTokens(flags: Flags): TokenSource {
  const raw = (flags.connections ?? process.env['VERGIS_CONNECTIONS'] ?? '').trim()
  if (!raw) throw new Error('falta el perfil de credencial: define --connections <ruta|JSON> o la env VERGIS_CONNECTIONS.')
  // Mismo contrato que `server/serve-rls.ts`: JSON inline (empieza con '{') o RUTA a un archivo JSON.
  const text = raw.startsWith('{') ? raw : readFileSync(resolvePath(raw), 'utf8')
  const perfiles = JSON.parse(text) as Record<string, CredentialSource>
  if (!perfiles || typeof perfiles !== 'object' || Array.isArray(perfiles)) throw new Error('el JSON de conexiones debe ser un objeto { database_ref: perfil }.')
  const refs = Object.keys(perfiles)
  const ref = flags.sp ?? process.env['VERGIS_INTAKE_SP'] ?? (refs.length === 1 ? refs[0] : undefined)
  if (!ref) throw new Error(`hay ${refs.length} perfiles (${refs.join(', ')}): elige uno con --sp <database_ref> o la env VERGIS_INTAKE_SP.`)
  const perfil = perfiles[ref]
  if (!perfil) throw new Error(`el perfil '${ref}' no existe en las conexiones (hay: ${refs.join(', ') || '(ninguno)'}).`)
  // Valida la forma de la credencial EAGER, sin red ni disco (contrato de `credentialProviderFor`).
  return credentialProviderFor(perfil, { label: `database_ref '${ref}'` })
}

// ── Veredicto ──────────────────────────────────────────────────────────────────────────────────────
const MATRIZ: readonly { fila: string; veredicto: string }[] = [
  { fila: 'A✓ A2✓ · B crea · C devuelve las mismas parts · D agenda', veredicto: '«SE PUEDE PUBLICAR» — positivo medido, cadena completa. Destranca §4–6.' },
  { fila: 'A✓ A2✓ · B responde 401/403 con errorCode de Fabric (repetido en 2ª corrida)', veredicto: '«NO SE PUEDE (HOY)» — negativo medido, con el código que nombra la pieza que falta.' },
  { fila: 'A falla · o B/C con 5xx, timeout, o error de red', veredicto: '«NO PUDE MEDIR» — cero conclusión. Se arregla el instrumento o se reintenta.' },
  { fila: 'B ok pero C no devuelve lo enviado', veredicto: '«PUBLICACIÓN NO CONFIABLE» — no concluir; volver a medir.' },
]

function imprimeVeredicto(fila: number, extra: string[]): void {
  titulo('VEREDICTO — matriz de §3 del diseño')
  MATRIZ.forEach((m, i) => {
    line(`  ${i === fila ? '▶' : ' '} ${i + 1}. ${m.fila}`)
    line(`      ${i === fila ? m.veredicto : '—'}`)
  })
  if (fila < 0) {
    line()
    line('  ▶ NINGUNA FILA DE LA MATRIZ APLICA TAL CUAL — ver la observación de abajo.')
  }
  for (const e of extra) {
    line()
    line(`  ${e}`)
  }
  if (vio4xx) {
    line()
    line('  ⚠ SE OBSERVÓ AL MENOS UN 4xx. Un 4xx UNA SOLA VEZ NO ES VEREDICTO (§3): exige una SEGUNDA')
    line('    CORRIDA con el mismo código para descartar un transitorio. La sonda NO se repite sola —')
    line('    la segunda corrida la lanza el operador, a mano, y se comparan los crudos de ambas.')
  }
  titulo('CRUDOS DE LA CORRIDA (todos los pasos, en orden)')
  crudos.forEach((c, i) => {
    line(`  ${String(i + 1).padStart(2, '0')}. ${c.method} ${c.url}`)
    line(`      status=${c.status === 0 ? '(sin respuesta HTTP)' : c.status}${c.errorCode ? ` errorCode=${c.errorCode}` : ''}`)
    if (c.detail) line(`      detalle: ${c.detail.replace(/\s+/g, ' ')}`)
  })
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  const nombreItem = `vergis_probe_${Math.floor(Date.now() / 1000)}`

  line('SONDA #107 F2 · HITO CERO — ¿puede el SP autorar items en el motor?')

  if (!flags.live || !flags.workspace || !flags.knownItem) {
    imprimePlan(nombreItem, flags.workspace ?? '<sin --workspace>', flags.knownItem ?? '<sin --known-item>', false)
    imprimeUso()
    if (flags.live && (!flags.workspace || !flags.knownItem)) {
      line()
      line('  --live SIN --workspace y --known-item: la sonda NO corre. No hay default que escriba.')
    }
    titulo('FIN — corrida EN SECO: no se abrió una sola conexión de red')
    return EXIT.ok
  }

  const ws = flags.workspace
  const known = flags.knownItem
  imprimePlan(nombreItem, ws, known, true)

  let tokens: TokenSource
  let bearer: string
  try {
    tokens = resuelveTokens(flags)
    bearer = (await tokens.getToken(SCOPE_FABRIC)).token
  } catch (e) {
    titulo('PASO 0 — credencial')
    line(`  NO PUDE MEDIR: la credencial no resolvió — ${(e as Error).message}`)
    imprimeVeredicto(2, ['La sonda no llegó a hacer una sola llamada a la API de autoría: CERO conclusión sobre permisos.'])
    return EXIT.noPudeMedir
  }
  const headers = { authorization: `Bearer ${bearer}` }
  const jsonHeaders = { ...headers, 'content-type': 'application/json' }
  line()
  line('  [0] token AAD obtenido para SCOPE_FABRIC (el valor NO se imprime).')

  // ── Paso A — control positivo ────────────────────────────────────────────────────────────────────
  titulo('PASO A — control positivo (el camino que producción ya ejerce con este mismo token)')
  const a = await call('A', 'GET', `${FABRIC_API}/workspaces/${encodeURIComponent(ws)}/items/${encodeURIComponent(known)}/jobs/instances`, { headers })
  if (a.status < 200 || a.status >= 300) {
    line('  [A] VEREDICTO DEL PASO: FALLA ⇒ NO PUDE MEDIR.')
    line('  [A] El instrumento, el token o la red están rotos: la sonda SE DETIENE y no concluye NADA sobre autoría.')
    imprimeVeredicto(2, ['El control positivo cayó: cualquier resultado posterior sería indistinguible de un instrumento roto.'])
    return EXIT.noPudeMedir
  }
  line('  [A] VEREDICTO DEL PASO: OK — el token sirve y el camino conocido responde.')

  // ── Paso A2 — control negativo ───────────────────────────────────────────────────────────────────
  titulo('PASO A2 — control negativo (¿la sonda sabe reportar un negativo REAL?)')
  const fantasma = randomUUID()
  const a2 = await call('A2', 'GET', `${FABRIC_API}/workspaces/${encodeURIComponent(ws)}/items/${encodeURIComponent(fantasma)}/jobs/instances`, { headers })
  if (a2.status !== 404) {
    line(`  [A2] VEREDICTO DEL PASO: FALLA — se esperaba 404 para el item inexistente '${fantasma}' y llegó ${a2.status || '(sin respuesta)'}.`)
    line('  [A2] LA SONDA DECLARA SU PROPIO INSTRUMENTO ROTO: no sabe distinguir «no existe» de otra cosa. SE DETIENE.')
    imprimeVeredicto(-1, ['INSTRUMENTO ROTO: se arregla la sonda ANTES de volver a medir. Ninguna medición de esta corrida vale.'])
    return EXIT.instrumentoRoto
  }
  line('  [A2] VEREDICTO DEL PASO: OK — la sonda reporta el 404 como tal. Instrumento calibrado.')

  // ── Paso B — crear ───────────────────────────────────────────────────────────────────────────────
  titulo('PASO B — crear el item (ESTO ESCRIBE EN EL TENANT)')
  const part = definicionMinima()
  const cuerpoCrear = { displayName: nombreItem, type: ITEM_TYPE, description: 'Sonda del hito cero de #107 fase 2 — se borra al final de la corrida.', definition: { parts: [part] } }
  line(`  [B] definición enviada (CONJETURA de forma, ver cabecera): part '${part.path}', payload base64 de ${Buffer.from(part.payload, 'base64').byteLength} bytes.`)
  const b = await call('B', 'POST', `${FABRIC_API}/workspaces/${encodeURIComponent(ws)}/items`, { headers: jsonHeaders, body: JSON.stringify(cuerpoCrear) })

  let itemId: string | undefined
  if (b.networkError || b.status >= 500) {
    line('  [B] VEREDICTO DEL PASO: 5xx/red ⇒ NO PUDE MEDIR.')
    imprimeVeredicto(2, ['El create no obtuvo respuesta concluyente del motor: NO se registra como negativo (§3).'])
    return EXIT.noPudeMedir
  }
  if (b.status === 401 || b.status === 403) {
    line(`  [B] VEREDICTO DEL PASO: DENEGADO por el motor (${b.status}${b.errorCode ? `, errorCode=${b.errorCode}` : ', SIN errorCode en el cuerpo'}).`)
    line('  [B] El paso A probó el MISMO token contra el camino conocido: esto NO es fallo del instrumento.')
    imprimeVeredicto(1, [
      `errorCode crudo: ${b.errorCode ?? '(el cuerpo no trajo errorCode — el crudo completo está abajo)'}`,
      'Este código es el que nombra la pieza que falta (tenant switch de SP · rol en el workspace · principal no soportado).',
      'Para que sea VEREDICTO hace falta la SEGUNDA CORRIDA con el mismo código.',
    ])
    return EXIT.negativo
  }
  if (b.status === 202) {
    const opId = operationIdOf(b.headers)
    if (!opId) {
      line('  [B] 202 SIN operationId (ni x-ms-operation-id ni Location) ⇒ NO PUDE MEDIR el desenlace del LRO.')
      imprimeVeredicto(2, ['El motor aceptó el create pero la sonda no puede seguir el LRO: puede haber quedado un item creado — revisar el workspace por el nombre de abajo.'])
      line()
      line(`  POSIBLE RESIDUO SIN CONFIRMAR: ${nombreItem.toUpperCase()}`)
      return EXIT.noPudeMedir
    }
    const desenlace = await pollLro('B', opId, headers)
    if (desenlace.kind === 'nomedir') {
      line(`  [B] VEREDICTO DEL PASO: el poll del LRO no concluyó (${desenlace.detail}) ⇒ NO PUDE MEDIR.`)
      imprimeVeredicto(2, [`operationId para re-observar: ${opId}`, `POSIBLE RESIDUO SIN CONFIRMAR: ${nombreItem.toUpperCase()}`])
      return EXIT.noPudeMedir
    }
    if (desenlace.kind === 'timeout') {
      line(`  [B] VEREDICTO DEL PASO: el LRO no culminó en ${LRO_BUDGET_MS / 1000}s ⇒ DESCONOCIDA (jamás «publicado» sin read-back, D7).`)
      imprimeVeredicto(2, [`operationId para re-observar: ${desenlace.operationId}`, `POSIBLE RESIDUO SIN CONFIRMAR: ${nombreItem.toUpperCase()}`])
      return EXIT.noPudeMedir
    }
    if (desenlace.kind === 'failed') {
      line(`  [B] VEREDICTO DEL PASO: el LRO terminó en Failed${desenlace.errorCode ? ` (errorCode=${desenlace.errorCode})` : ''}.`)
      imprimeVeredicto(-1, [
        'El motor ACEPTÓ la petición y luego falló: no es negativo de permisos ni positivo. El errorCode de arriba es EL DATO.',
        'Si el código apunta al CONTENIDO de la definición mínima (conjetura de esta sonda), se corrige la definición y se re-mide.',
      ])
      return EXIT.noConcluyente
    }
    itemId = (desenlace.result as { id?: string } | null)?.id
  } else if (b.status === 200 || b.status === 201) {
    itemId = (b.json as { id?: string } | null)?.id
  } else {
    line(`  [B] VEREDICTO DEL PASO: 4xx NO de permisos (${b.status}${b.errorCode ? `, errorCode=${b.errorCode}` : ''}) — típicamente rechazo por FORMA o CONTENIDO de la definición.`)
    imprimeVeredicto(-1, [
      'NO CONCLUYENTE sobre autoría: el motor rechazó la petición ANTES de decir si el SP puede o no publicar.',
      'La definición mínima de esta sonda es CONJETURA (ver cabecera): este errorCode es exactamente el dato que la corrige.',
      'Se ajusta la definición con el errorCode de arriba y se vuelve a medir. NO se registra como negativo de permisos.',
    ])
    return EXIT.noConcluyente
  }

  if (!itemId) {
    line('  [B] El motor respondió éxito pero la sonda NO encontró el `id` del item creado ⇒ NO PUDE MEDIR (y hay residuo probable).')
    imprimeVeredicto(2, [`POSIBLE RESIDUO SIN CONFIRMAR: ${nombreItem.toUpperCase()}`])
    return EXIT.noPudeMedir
  }
  line(`  [B] VEREDICTO DEL PASO: ITEM CREADO · id=${itemId} · nombre=${nombreItem}`)

  // A partir de acá SIEMPRE se intenta limpiar (paso E), pase lo que pase en C y D.
  let salida: number = EXIT.ok
  const extras: string[] = []
  let filaMatriz = 0

  // ── Paso C — read-back ───────────────────────────────────────────────────────────────────────────
  titulo('PASO C — read-back (D7: éxito SOLO si el motor devuelve lo que se envió)')
  const c = await call('C', 'POST', `${FABRIC_API}/workspaces/${encodeURIComponent(ws)}/items/${encodeURIComponent(itemId)}/getDefinition`, { headers: jsonHeaders })
  let devueltas: { path?: string; payload?: string }[] | null = null
  if (c.status === 202) {
    const opId = operationIdOf(c.headers)
    const desenlace = opId ? await pollLro('C', opId, headers) : { kind: 'nomedir' as const, detail: '202 sin operationId' }
    if (desenlace.kind === 'succeeded') devueltas = (desenlace.result as { definition?: { parts?: { path?: string; payload?: string }[] } } | null)?.definition?.parts ?? null
    else line(`  [C] el LRO del getDefinition no culminó (${desenlace.kind}).`)
  } else if (c.status >= 200 && c.status < 300) {
    devueltas = (c.json as { definition?: { parts?: { path?: string; payload?: string }[] } } | null)?.definition?.parts ?? null
  }

  if (!devueltas) {
    line('  [C] VEREDICTO DEL PASO: el read-back NO devolvió parts.')
    filaMatriz = 3
    salida = EXIT.noConfiable
    extras.push('B creó pero C no confirmó: la publicación NO se declara `ok` (D7). Volver a medir; si es reproducible, es un hallazgo en sí (la API acepta y no persiste).')
  } else {
    const enviada = firmaParts([part])
    line(`  [C] parts devueltas: ${devueltas.map((p) => p.path ?? '(sin path)').join(', ')}`)
    const principal = devueltas.find((p) => p.path === MAIN_PART_PATH)
    if (!principal) {
      line(`  [C] VEREDICTO DEL PASO: el motor NO devolvió la part principal esperada '${MAIN_PART_PATH}' — la conjetura de §3 (fila 6) queda REFUTADA en ese punto.`)
      filaMatriz = 3
      salida = EXIT.noConfiable
      extras.push(`Nombre real de las parts según el motor: ${devueltas.map((p) => p.path ?? '?').join(', ')} — dato duro para corregir el diseño.`)
    } else if (firmaParts([principal]) !== enviada) {
      line('  [C] VEREDICTO DEL PASO: la part principal volvió con OTRO payload (el motor normalizó o no persistió lo enviado).')
      line(`  [C] enviado(sha-visual)=${enviada.slice(0, 80)}…`)
      line(`  [C] recibido(sha-visual)=${firmaParts([principal]).slice(0, 80)}…`)
      filaMatriz = 3
      salida = EXIT.noConfiable
      extras.push('Que el motor NORMALICE el payload no es lo mismo que no persistirlo: la comparación por igualdad exacta es deliberadamente estricta. El payload devuelto (arriba, crudo) dice cuál de las dos es.')
    } else {
      line('  [C] VEREDICTO DEL PASO: OK — el motor devolvió EXACTAMENTE la part enviada.')
      if (devueltas.length > 1) line(`  [C] (el motor agregó parts propias: ${devueltas.filter((p) => p.path !== MAIN_PART_PATH).map((p) => p.path).join(', ')} — dato para el render de §4)`)
    }
  }

  // ── Paso D — encadenar con fase 1 ────────────────────────────────────────────────────────────────
  titulo('PASO D — encadenar: agendar el item recién creado (crear → agendar, la cadena de la fase 2)')
  // MISMA forma de URL y de cuerpo que `packages/capabilities/src/fabric-engine.ts:62,76-90`, con una
  // sola diferencia deliberada: `enabled: false` — el schedule nace APAGADO (inocuo: no dispara nada).
  const scheduleUrl = `${FABRIC_API}/workspaces/${encodeURIComponent(ws)}/items/${encodeURIComponent(itemId)}/jobs/${encodeURIComponent(JOB_TYPE)}/schedules`
  const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, '') // Fabric espera sin milis ni 'Z'
  const cuerpoSchedule = {
    enabled: false,
    configuration: {
      type: 'Cron',
      interval: 1440, // un día: cadencia inocua, y el schedule además nace deshabilitado
      startDateTime: iso(new Date()),
      endDateTime: iso(new Date(Date.now() + 50 * 365 * 86_400_000)),
      localTimeZoneId: 'UTC',
    },
  }
  const d = await call('D', 'POST', scheduleUrl, { headers: jsonHeaders, body: JSON.stringify(cuerpoSchedule) })
  const dOk = d.status >= 200 && d.status < 300
  if (dOk) {
    line('  [D] VEREDICTO DEL PASO: OK — el item creado ACEPTA schedule: la cadena crear → agendar está medida.')
  } else {
    line(`  [D] VEREDICTO DEL PASO: FALLA (${d.status || 'sin respuesta'}${d.errorCode ? `, errorCode=${d.errorCode}` : ''}).`)
    if (salida === EXIT.ok) {
      filaMatriz = -1
      salida = EXIT.parcial
      extras.push('POSITIVO PARCIAL: crear (B) y leer (C) sí; encadenar el schedule (D) no. La fila 1 de la matriz exige D: NO se declara «se puede publicar» sin la cadena completa.')
      extras.push(`El jobType usado fue '${JOB_TYPE}' (el de fase 1 para SJD). Si el errorCode apunta al jobType, ese es el dato a corregir antes de re-medir.`)
    }
  }

  // ── Paso E — limpiar ─────────────────────────────────────────────────────────────────────────────
  titulo('PASO E — limpiar (la sonda no deja residuo, o lo GRITA)')
  const del = await call('E', 'DELETE', `${FABRIC_API}/workspaces/${encodeURIComponent(ws)}/items/${encodeURIComponent(itemId)}`, { headers })
  const delOk = (del.status >= 200 && del.status < 300) || del.status === 404
  const verif = await call('E', 'GET', `${FABRIC_API}/workspaces/${encodeURIComponent(ws)}/items/${encodeURIComponent(itemId)}/jobs/instances`, { headers })
  const limpio = delOk && verif.status === 404
  if (limpio) {
    line('  [E] VEREDICTO DEL PASO: OK — el item fue borrado y la verificación devuelve 404. CERO residuo.')
  } else {
    line('  [E] VEREDICTO DEL PASO: LA LIMPIEZA FALLÓ.')
    line('')
    line('  ########################################################################')
    line(`  RESIDUO SIN LIMPIAR EN EL TENANT — RETIRAR A MANO:`)
    line(`  NOMBRE: ${nombreItem.toUpperCase()}`)
    line(`  ITEM ID: ${itemId.toUpperCase()}`)
    line(`  WORKSPACE: ${ws.toUpperCase()}`)
    line(`  TIPO: ${ITEM_TYPE.toUpperCase()}`)
    line('  ########################################################################')
    extras.push(`RESIDUO: el item '${nombreItem}' (id ${itemId}) puede seguir vivo en el workspace ${ws}. Retirarlo a mano ANTES de cualquier re-corrida.`)
    salida = EXIT.residuo // manda sobre cualquier otro código
    if (filaMatriz === 0) filaMatriz = -1
  }

  if (salida === EXIT.ok) {
    extras.push('CADENA COMPLETA MEDIDA: crear (B) → read-back exacto (C) → agendar (D) → borrar y verificar 404 (E).')
    extras.push('Ojo con lo que ESTO NO demuestra: mide ESTE workspace, ESTE tipo de item y ESTE perfil de credencial. Los permisos de Fabric son por workspace.')
  }
  imprimeVeredicto(filaMatriz, extras)
  return salida
}

main()
  .then((code) => {
    titulo('FIN')
    line(`  código de salida: ${code}`)
    process.exitCode = code
  })
  .catch((e: unknown) => {
    line()
    line(`ERROR NO CONTROLADO DE LA SONDA: ${(e as Error).message}`)
    line('Esto es un fallo DEL INSTRUMENTO, no una medición: no se concluye nada sobre autoría.')
    line((e as Error).stack ?? '')
    process.exitCode = EXIT.instrumentoRoto
  })
