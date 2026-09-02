/**
 * Configuración del servidor RLS desde el entorno — parseo y VALIDACIÓN en un solo lugar.
 *
 * Primer módulo del refactor `createApp()` (work/001, A14): hoy `serve-rls.ts` lee ~35 `process.env`
 * dispersos y a nivel de módulo (intesteable). `configFromEnv(env)` es puro e inyectable — se le pasa
 * un env fake en tests — y valida los numéricos (cierra el hallazgo NaN: `PORT=abc` → `listen(NaN)`,
 * `VERGIS_INTERACTIVE_MAX_ROWS` NaN pasado a Mira sin chequeo).
 *
 * `VERGIS_ANNOTATION_SECRET` está DEPRECADO (la capa de notas no usa tokens por fila): si viene en el
 * entorno se ignora con aviso — el secreto CSRF se fija con `VERGIS_CSRF_SECRET`. Ver
 * `deprecatedEnvWarnings`.
 *
 * Alcance de este módulo: los valores ESCALARES y de RUTA/nombre. La CARGA de los archivos de config
 * (YAML/JSON de policies, specs, master-data, etc.) la hacen sus consumidores a partir de las rutas
 * que este config expone — así el parseo de entorno queda separado de la lectura de disco.
 */

import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

export type Engine = 'clickhouse' | 'fabric'

export interface ServerConfig {
  engine: Engine
  port: number
  /**
   * Interfaz de escucha (`HOST`). `undefined` = comportamiento por defecto de Node: escucha en TODAS
   * las interfaces — lo que necesita el contenedor para que el proxy lo alcance. Seteado (p. ej.
   * `127.0.0.1`), el arnés de dev queda localhost-only y no expone el puerto a la red local.
   */
  host: string | undefined
  refreshMs: number
  dataCacheTtlMs: number
  /** Tope de filas materializables por `interactions.filters`; undefined → default de Mira. */
  interactiveMaxRows: number | undefined
  hotReload: boolean
  piAclEnabled: boolean
  indexTitle: string
  signoutRd: string
  /** Directorio de salida/estado (stores SQLite, artefactos). Normalizado sin `/` final. */
  outDir: string
  /** Rutas de policy stores (coma-separadas en el env). */
  policyPaths: string[]
  /** Descubrimiento de specs: directorio y/o lista explícita. */
  specsDir: string | undefined
  specsList: string[]
  adminSeed: string[]
  defaultCollaboratorGroups: string[]
  defaultStewardGroups: string[]
  /** Mapeo claim→cabecera del gate (VERGIS_GATE_CLAIMS). */
  gateClaims: Record<string, string>
  /** Secreto HMAC de los tokens CSRF de las superficies SSR de gestión. `ephemeral` indica que se
   *  generó por arranque (no persistente): los formularios abiertos no sobreviven un restart ni se
   *  comparten entre réplicas. `VERGIS_CSRF_SECRET` lo fija. */
  csrfSecret: { value: string; ephemeral: boolean }
  /** Miranda — el agente conversacional de especificación de PIs (cluster 077). Todo detrás del flag. */
  miranda: MirandaConfig
  /** «Descargar PDF» server-side (issue #65). Ver `PdfConfig`. */
  pdf: PdfConfig
  /**
   * Identidad de DESARROLLO inyectable (`VERGIS_DEV_IDENTITY`). `null` salvo en un despliegue de dev
   * SIN gate real. Es fail-safe por construcción: `decideDevIdentity` solo la deja activa cuando el env
   * está seteado Y NO hay señal de gate real — jamás en producción. Ver `decideDevIdentity`.
   */
  devIdentity: DevIdentity | null
  /** Rutas/valores crudos que los consumidores cargan (archivos de config, conexiones, CH, etc.). */
  paths: {
    connections: string | undefined
    datasets: string | undefined
    identityMap: string | undefined
    masterData: string | undefined
    masterDataDb: string | undefined
    governanceDb: string | undefined
    groups: string | undefined
    domains: string | undefined
    intake: string | undefined
    intakeSp: string | undefined
    sources: string | undefined
    piOwners: string | undefined
  }
}

/**
 * «Descargar PDF» server-side (issue #65). FAIL-CLOSED por construcción: `serviceUrl` vacío ⇒ la
 * feature no existe — ni el endpoint `/<slug>/pdf` (la URL vuelve a caer en el 404 de siempre) ni el
 * botón de la bandeja. No hay flag adicional: el binario es UNO, así que un botón que apunte a un
 * endpoint inexistente es estructuralmente imposible.
 */
export interface PdfConfig {
  /** URL interna del sidecar HTML→PDF (p.ej. `http://vergis-pdf:9090`). Vacío = feature apagada. */
  serviceUrl: string
  /** Tope de espera de la conversión; agotado, el endpoint responde 503 con mensaje claro. */
  timeoutMs: number
}

/**
 * Config de Miranda. Con `enabled=false` (default) NADA se activa: ni rutas, ni nav, ni la dependencia
 * de la API.
 *
 * Miranda es una superficie OPCIONAL, así que su configuración incompleta la deshabilita a ella y
 * JAMÁS aborta el arranque del nodo (issue #266): con el flag encendido y la key ausente/vacía —o con
 * un `MIRANDA_API_BASE_URL` que no es una URL absoluta— el resultado es `enabled=false` +
 * `disabledReason`, que el log de arranque, `/contrato` y la propia ruta `/miranda` (503) declaran.
 * La distinción fatal vs degradable está declarada en `FATAL_ENVS`/`DEGRADABLE_ENVS`.
 */
export interface MirandaConfig {
  enabled: boolean
  model: string
  apiKey: string
  /**
   * Por qué la capacidad quedó apagada PESE a que la instancia la pidió (`MIRANDA_ENABLED` encendido).
   * `undefined` en los dos casos sanos: flag apagado (nadie la pidió) o flag encendido y bien
   * configurada. Presente ⇒ hubo intención y falta configuración: es lo que se muestra al operador.
   */
  disabledReason?: string
  /**
   * Destino de la API de Anthropic (`MIRANDA_API_BASE_URL`, issue #265) — un gateway compatible
   * (Foundry, un proxy corporativo, un endpoint regional). `undefined` ⇒ el default del transporte
   * (`https://api.anthropic.com`). No es secreto: se loguea y se expone en `/contrato`.
   */
  baseUrl?: string
  /** Directorio con el DSL (`dsl.md`) y la rúbrica QC① (`qc1/…`) que se montan al system prompt. */
  rubricDir: string | undefined
  /** Turnos internos (tool-use) máximos por mensaje del usuario. */
  maxTurns: number
  /** Presupuesto de tokens por sesión (corta con mensaje claro al excederse). */
  tokenBudget: number
  /** Ruta/JSON del allowlist de catálogo (tablas/vistas que las probes pueden tocar). */
  catalogPath: string | undefined
  /** Grupo de Mira que concede el scope `miranda` (además de los admins). */
  scopeGroup: string
  /** Webhook opcional para anunciar la publicación de un PI (patrón espejo Slack; no-fatal). */
  announceWebhook: string | undefined
  /**
   * Ruta a un JSON con el ROSTER de identidades inspeccionables en preview
   * (`MIRANDA_PREVIEW_IDENTITIES`). Vacío/ausente = la feature NO existe: ni `?as=`, ni links, ni
   * campos nuevos en la tool (superficie cero, patrón `PdfConfig`). Con Miranda apagada la env se
   * ignora: el campo queda `undefined` aunque la variable esté definida.
   */
  previewIdentitiesPath: string | undefined
}

/**
 * Una identidad del roster de preview: la instancia declara EXPLÍCITAMENTE qué vistas son
 * inspeccionables. Los claims son inline (auditable de un vistazo qué ve cada etiqueta) y el server
 * los usa TAL CUAL como `IdentityContext` — sin enriquecer desde `IdentityMap`: el roster es la única
 * fuente de verdad de lo suplantado. Jamás hay `?as=<email arbitrario>`.
 */
export interface PreviewIdentity {
  label: string
  user: string
  claims: Record<string, string[]>
}

/**
 * Identidad de desarrollo: un `user` (email) y claims fijos (hoy solo `groups`, la llave que puebla
 * el header `x-forwarded-groups` en producción). Se inyecta a una request que NO trae header de gate,
 * para manejar Mira/PIs desde el navegador local sin oauth2-proxy ni forjar headers por curl.
 */
export interface DevIdentity {
  user: string
  claims: Record<string, string[]>
}

/**
 * Decisión de activación de `VERGIS_DEV_IDENTITY` — **el núcleo fail-safe**. Puro y testeable.
 *
 * - `off`          — el env no está seteado → comportamiento idéntico a hoy (sin cambio alguno).
 * - `active`       — seteado **∧ NO hay gate real** → se inyecta la identidad en requests sin header.
 * - `ignored-gate` — seteado **∧ hay gate real** (`VERGIS_GATE_SECRET` presente) → se IGNORA. Config
 *                    contradictoria: prioriza seguridad, NUNCA inyecta en producción.
 * - `invalid`      — seteado pero sin un email parseable → se ignora (con aviso).
 *
 * La señal de gate real es la presencia (no vacía) de `VERGIS_GATE_SECRET`: el secreto que oauth2-proxy
 * comparte con vergis para el gate en profundidad (A10). Su sola presencia marca un despliegue con gate.
 */
export type DevIdentityDecision =
  | { mode: 'off' }
  | { mode: 'active'; identity: DevIdentity }
  | { mode: 'ignored-gate' }
  | { mode: 'invalid'; raw: string }

/** Parsea `"email"` o `"email:grupo1,grupo2"` → DevIdentity. `null` si no hay email. */
export function parseDevIdentity(raw: string): DevIdentity | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const sep = trimmed.indexOf(':')
  const user = (sep === -1 ? trimmed : trimmed.slice(0, sep)).trim()
  if (!user) return null
  const groups = (sep === -1 ? '' : trimmed.slice(sep + 1))
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
  const claims: Record<string, string[]> = {}
  if (groups.length > 0) claims['groups'] = groups
  return { user, claims }
}

/** Decide si `VERGIS_DEV_IDENTITY` se activa. Fail-safe: gate real presente ⇒ jamás activa. */
export function decideDevIdentity(env: Env): DevIdentityDecision {
  const raw = (env['VERGIS_DEV_IDENTITY'] ?? '').trim()
  if (!raw) return { mode: 'off' }
  // Señal inequívoca de despliegue con gate real → el env de dev se ignora (seguridad primero).
  if ((env['VERGIS_GATE_SECRET'] ?? '').trim() !== '') return { mode: 'ignored-gate' }
  const identity = parseDevIdentity(raw)
  if (!identity) return { mode: 'invalid', raw }
  return { mode: 'active', identity }
}

/**
 * Decisión de `--fresh` — **el arnés de desarrollo arranca con el store limpio**.
 *
 * El store SQLite de gobierno persiste entre corridas del arnés y arrastra sesiones de prueba de
 * Miranda. `--fresh` lo borra y lo deja recrear al arranque. El default se conserva intacto (sin la
 * bandera, el store se preserva — «`--keep` implícito»).
 *
 * **Imposible por construcción sobre un store de producción:** el borrado exige que el proceso sea
 * un despliegue de DESARROLLO, y la señal es la MISMA que ya gobierna `VERGIS_DEV_IDENTITY`:
 *
 * - `off`            — la bandera no vino → jamás se toca nada.
 * - `refused-gate`   — hay gate real (`VERGIS_GATE_SECRET` presente) → se REHÚSA (nunca borra).
 * - `refused-no-dev` — sin identidad de dev activa (`VERGIS_DEV_IDENTITY`) → se REHÚSA: un despliegue
 *                      sin ese env no es el arnés, y un store que no es de dev no se borra.
 * - `fresh`          — bandera ∧ dev-identity activa ∧ sin gate real → se borra el store de dev.
 *
 * Ambas negativas son fail-safe: ante duda, se conserva el store.
 */
export type FreshStoreDecision =
  | { mode: 'off' }
  | { mode: 'fresh' }
  | { mode: 'refused-gate' }
  | { mode: 'refused-no-dev' }

/** ¿Vino `--fresh` en los argumentos del proceso? (`--keep` es el default, se acepta y no hace nada.) */
export function hasFreshFlag(argv: readonly string[]): boolean {
  return argv.includes('--fresh')
}

/** Decide si el store de gobierno se recrea. Fail-safe: solo el arnés de dev puede borrar. */
export function decideFreshStore(argv: readonly string[], env: Env): FreshStoreDecision {
  if (!hasFreshFlag(argv)) return { mode: 'off' }
  const dev = decideDevIdentity(env)
  if (dev.mode === 'ignored-gate') return { mode: 'refused-gate' }
  if (dev.mode !== 'active') return { mode: 'refused-no-dev' }
  return { mode: 'fresh' }
}

type Env = Record<string, string | undefined>

const TRUTHY = new Set(['1', 'true', 'on'])

/** Entero desde env con default; lanza si el valor presente no es numérico (cierra el hallazgo NaN). */
function num(env: Env, key: string, def: number): number {
  const raw = env[key]
  if (raw == null || raw === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`Config inválida: ${key}='${raw}' no es un número.`)
  return n
}

/** Entero opcional (sin default): undefined si ausente; lanza si presente y no numérico. */
function numOpt(env: Env, key: string): number | undefined {
  const raw = env[key]
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`Config inválida: ${key}='${raw}' no es un número.`)
  return n
}

/** Lista coma-separada, sin vacíos; `lower` para normalizar a minúscula. */
function list(env: Env, key: string, lower = false): string[] {
  return (env[key] ?? '')
    .split(',')
    .map((s) => (lower ? s.trim().toLowerCase() : s.trim()))
    .filter(Boolean)
}

/** Parsea `VERGIS_GATE_CLAIMS="claim:header,..."` → { claim: header-en-minúscula }. */
function parseGateClaims(raw: string): Record<string, string> {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, pair) => {
      const [claim, header] = pair.split(':').map((s) => s.trim())
      if (claim && header) acc[claim] = header.toLowerCase()
      return acc
    }, {})
}

/**
 * Normaliza el destino de una API: URL absoluta `http(s)` sin `/` final. `undefined` = inválida.
 * Deliberadamente estricta — un valor relativo o con otro esquema no se «arregla», se rechaza, y el
 * rechazo es DEGRADABLE (apaga la superficie, no el nodo).
 */
function normalizeBaseUrl(raw: string): string | undefined {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return undefined
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
  return u.toString().replace(/\/$/, '')
}

/** Una clase de env, con dónde se valida y qué pasa si está mal. */
export interface EnvClass {
  envs: string[]
  /** Qué se pierde si falta o está mal. */
  why: string
  /** Dónde se hace efectiva la validación. */
  where: string
}

/**
 * ═══ FATAL vs DEGRADABLE — la distinción, EXPLÍCITA (issue #266) ══════════════════════════════════
 *
 * Antes era implícita en el ORDEN en que se validaban las cosas, y por eso una superficie opcional mal
 * configurada (Miranda sin key) abortaba el proceso ANTES que todo lo demás: `restart: unless-stopped`
 * lo dejaba en crashloop y **todos los PIs de la instancia dejaban de servir**. Asimetría de radio:
 * falla lo que casi nadie usa, cae todo lo que todos usan.
 *
 * La regla, y la única pregunta que decide de qué lado cae un env nuevo:
 *
 *   **FATAL** — sin esto NO HAY NADA QUE SERVIR, o servir sería incorrecto. Lanza: el nodo no arranca.
 *   **DEGRADABLE** — esto apaga UNA superficie opcional. Jamás lanza: la superficie queda apagada con
 *   su razón, y lo dicen el log de arranque, `/contrato` y la propia ruta (503).
 *
 * Degradar NO es callar: una superficie apagada por configuración lo declara por tres canales. Y lo
 * fatal sigue fatal — degradar de más escondería un nodo que sirve mal.
 */
export const FATAL_ENVS: EnvClass[] = [
  {
    envs: ['VERGIS_SPECS_DIR', 'VERGIS_SPECS', 'VERGIS_SPEC'],
    why: 'Sin specs no hay ningún PI que servir: el nodo no tendría razón de estar arriba.',
    where: 'serve-rls.ts (arranque), tras `configFromEnv`',
  },
  {
    envs: ['VERGIS_ENGINE'],
    why: 'Un motor desconocido no puede ejecutar ninguna consulta: todo PI fallaría en runtime.',
    where: 'configFromEnv',
  },
  {
    envs: ['PORT', 'VERGIS_REFRESH_MS', 'VERGIS_DATA_CACHE_TTL_MS', 'VERGIS_INTERACTIVE_MAX_ROWS', 'VERGIS_PDF_TIMEOUT_MS'],
    why: 'Un numérico inválido se propaga como NaN al núcleo (listen(NaN), topes de materialización).',
    where: 'configFromEnv (`num`/`numOpt`)',
  },
]

export const DEGRADABLE_ENVS: EnvClass[] = [
  {
    envs: ['MIRANDA_PREVIEW_IDENTITIES'],
    why:
      'Un roster ilegible o inválido apaga MIRANDA ENTERA con la razón (#266, segunda mitad). Lo que ' +
      '#110·1 prohibía era una impersonación A MEDIAS sobre una ficción; apagarla toda no es a medias, ' +
      'y tumbar los PIs de la instancia por un roster tampoco era lo que esa decisión protegía. Vale ' +
      'para cualquier fallo del arranque de Miranda: catálogo, roster, store, schema.',
    where: 'serve-rls.ts (catch del arranque de Miranda → degradeMiranda), `parsePreviewIdentities`',
  },
  {
    envs: ['MIRANDA_ENABLED', 'ANTHROPIC_API_KEY', 'MIRANDA_API_BASE_URL'],
    why: 'Miranda es opcional y de alcance restringido (un grupo). Mal configurada se apaga a sí misma con su razón; los PIs siguen sirviendo.',
    where: 'mirandaConfig → `MirandaConfig.disabledReason`',
  },
  {
    envs: ['VERGIS_PDF_SERVICE_URL'],
    why: 'Sin sidecar de PDF no hay botón «Descargar PDF»; el resto del PI sirve igual (fail-closed por valor vacío).',
    where: 'configFromEnv (`pdf.serviceUrl` vacío = feature inexistente)',
  },
  {
    envs: ['VERGIS_DEV_IDENTITY'],
    why: 'Identidad de desarrollo: inválida o con gate real presente se ignora, jamás aborta (fail-safe).',
    where: 'decideDevIdentity',
  },
]

/**
 * Construye la config desde un env (default `process.env`). Puro y validado.
 * `randomSecret` inyecta el generador del secreto efímero (por defecto crypto) — inyectable en tests.
 */
export function configFromEnv(env: Env = process.env, randomSecret: () => string = defaultRandomSecret): ServerConfig {
  const engine = (env['VERGIS_ENGINE'] ?? 'clickhouse').toLowerCase()
  if (engine !== 'clickhouse' && engine !== 'fabric') {
    throw new Error(`VERGIS_ENGINE inválido: '${engine}' (clickhouse | fabric).`)
  }
  const envSecret = env['VERGIS_CSRF_SECRET']
  const devDecision = decideDevIdentity(env)
  return {
    engine,
    miranda: mirandaConfig(env),
    pdf: {
      serviceUrl: (env['VERGIS_PDF_SERVICE_URL'] ?? '').trim(),
      timeoutMs: num(env, 'VERGIS_PDF_TIMEOUT_MS', 30_000),
    },
    devIdentity: devDecision.mode === 'active' ? devDecision.identity : null,
    port: num(env, 'PORT', 8080),
    host: (env['HOST'] ?? '').trim() || undefined,
    refreshMs: num(env, 'VERGIS_REFRESH_MS', 0),
    dataCacheTtlMs: num(env, 'VERGIS_DATA_CACHE_TTL_MS', 0),
    interactiveMaxRows: numOpt(env, 'VERGIS_INTERACTIVE_MAX_ROWS'),
    hotReload: (env['VERGIS_HOT_RELOAD'] ?? '1') !== '0',
    piAclEnabled: TRUTHY.has((env['VERGIS_PI_ACL'] ?? '').toLowerCase()),
    indexTitle: env['VERGIS_INDEX_TITLE'] ?? 'Productos de Información',
    signoutRd: env['VERGIS_SIGNOUT_RD'] ?? '',
    outDir: (env['VERGIS_OUT'] ?? tmpdirSafe()).replace(/\/$/, ''),
    policyPaths: list(env, 'VERGIS_POLICIES'),
    specsDir: env['VERGIS_SPECS_DIR'],
    specsList: list(env, 'VERGIS_SPECS').length ? list(env, 'VERGIS_SPECS') : list(env, 'VERGIS_SPEC'),
    adminSeed: list(env, 'VERGIS_ADMIN_SEED'),
    defaultCollaboratorGroups: list(env, 'VERGIS_DEFAULT_COLLABORATOR_GROUPS', true),
    defaultStewardGroups: list(env, 'VERGIS_DEFAULT_STEWARD_GROUPS', true),
    gateClaims: parseGateClaims(env['VERGIS_GATE_CLAIMS'] ?? 'groups:x-forwarded-groups'),
    csrfSecret: envSecret ? { value: envSecret, ephemeral: false } : { value: randomSecret(), ephemeral: true },
    paths: {
      connections: env['VERGIS_CONNECTIONS'],
      datasets: env['VERGIS_DATASETS'],
      identityMap: env['VERGIS_IDENTITY_MAP'],
      masterData: env['VERGIS_MASTER_DATA'],
      masterDataDb: env['VERGIS_MASTER_DATA_DB'],
      governanceDb: env['VERGIS_GOVERNANCE_DB'],
      groups: env['VERGIS_GROUPS'],
      domains: env['VERGIS_DOMAINS'],
      intake: env['VERGIS_INTAKE'],
      intakeSp: env['VERGIS_INTAKE_SP'],
      sources: env['VERGIS_SOURCES'],
      piOwners: env['VERGIS_PI_OWNERS'],
    },
  }
}

/**
 * Claves de env que `configFromEnv` consume DE VERDAD — **derivado, no declarado** (issue #139): se
 * corre la MISMA función sobre un `Proxy` que registra cada acceso, así que la lista no puede driftear
 * del código (una clave nueva aparece sin que nadie mantenga un arreglo).
 *
 * Branch-dependiente POR DISEÑO: si Miranda está apagada, sus claves no aparecen — y es verdad, no se
 * consumieron. Una config inválida no rompe la enumeración: se devuelven las claves registradas hasta
 * el fallo (el contrato jamás afecta al proceso que lo consulta).
 */
export function configEnvKeys(env: Env = process.env): string[] {
  const seen = new Set<string>()
  const proxied = new Proxy(env, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') seen.add(prop)
      return Reflect.get(target, prop, receiver)
    },
    has(target, prop) {
      if (typeof prop === 'string') seen.add(prop)
      return Reflect.has(target, prop)
    },
  })
  try {
    configFromEnv(proxied, () => 'x')
  } catch {
    /* config inválida: se devuelve lo registrado hasta el fallo */
  }
  return [...seen].sort()
}

/**
 * Parsea y VALIDA la config de Miranda — **degradable, nunca fatal** (issue #266).
 *
 * Con el flag encendido y la configuración incompleta NO lanza: devuelve la capacidad apagada con la
 * razón puesta (`disabledReason`). El núcleo arranca y sirve los PIs; el único afectado es quien entra
 * a `/miranda`, que recibe un 503 con esa misma razón. El texto de la razón conserva el del error que
 * antes abortaba el proceso — es accionable y ya estaba probado en terreno.
 */
function mirandaConfig(env: Env): MirandaConfig {
  const wanted = TRUTHY.has((env['MIRANDA_ENABLED'] ?? '').toLowerCase())
  const apiKey = (env['ANTHROPIC_API_KEY'] ?? '').trim()
  const rawBase = (env['MIRANDA_API_BASE_URL'] ?? '').trim()
  const baseUrl = rawBase ? normalizeBaseUrl(rawBase) : undefined

  // Razones de degradación, en orden de descubrimiento. La primera manda (es la que el operador arregla
  // primero); las demás aparecerán en el arranque siguiente si siguen ahí.
  let disabledReason: string | undefined
  if (wanted && !apiKey) {
    disabledReason =
      'MIRANDA_ENABLED está encendido pero falta ANTHROPIC_API_KEY. Define la key (env/KV) o apaga MIRANDA_ENABLED.'
  } else if (wanted && rawBase && !baseUrl) {
    disabledReason = `MIRANDA_API_BASE_URL no es una URL absoluta http(s): '${rawBase}'. Corrígela o quítala para hablar con https://api.anthropic.com.`
  }
  const enabled = wanted && !disabledReason

  return {
    enabled,
    ...(disabledReason ? { disabledReason } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    model: env['MIRANDA_MODEL'] ?? 'claude-sonnet-5',
    apiKey,
    rubricDir: env['MIRANDA_RUBRIC_DIR'],
    maxTurns: num(env, 'MIRANDA_MAX_TURNS', 40),
    tokenBudget: num(env, 'MIRANDA_TOKEN_BUDGET', 500_000),
    catalogPath: env['MIRANDA_CATALOG'],
    scopeGroup: (env['MIRANDA_SCOPE_GROUP'] ?? 'miranda').trim().toLowerCase(),
    announceWebhook: env['MIRANDA_ANNOUNCE_WEBHOOK'],
    previewIdentitiesPath: enabled ? (env['MIRANDA_PREVIEW_IDENTITIES'] ?? '').trim() || undefined : undefined,
  }
}

/**
 * Parsea y VALIDA el roster de preview (contenido del archivo `MIRANDA_PREVIEW_IDENTITIES`). Puro:
 * la LECTURA del archivo la hace el consumidor (`serve-rls.ts`), como todo archivo de config de este
 * módulo. Lanza con mensaje accionable ante roster inválido — con Miranda ON eso APAGA Miranda entera
 * con la razón (#266), nunca una feature a medias ni un nodo caído.
 */
export function parsePreviewIdentities(raw: string, source = 'MIRANDA_PREVIEW_IDENTITIES'): PreviewIdentity[] {
  const fail = (msg: string): never => {
    throw new Error(`${source}: ${msg}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return fail(`el roster no es JSON válido (${e instanceof Error ? e.message : String(e)}).`)
  }
  if (!Array.isArray(parsed)) return fail('el roster debe ser un arreglo de identidades `[{label,user,claims}]`.')
  const out: PreviewIdentity[] = []
  const seen = new Set<string>()
  parsed.forEach((entry, i) => {
    const at = `identidad #${i + 1}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail(`${at} no es un objeto.`)
    const e = entry as Record<string, unknown>
    const label = typeof e['label'] === 'string' ? e['label'].trim() : ''
    if (!label) return fail(`${at} no declara \`label\` (etiqueta no vacía).`)
    if (!/^[A-Za-z0-9._-]+$/.test(label)) return fail(`${at}: label '${label}' inválido (solo letras, dígitos, '.', '_' y '-').`)
    if (seen.has(label.toLowerCase())) return fail(`label duplicado: '${label}'. Las etiquetas del roster deben ser únicas.`)
    seen.add(label.toLowerCase())
    const user = typeof e['user'] === 'string' ? e['user'].trim() : ''
    if (!user) return fail(`identidad '${label}' no declara \`user\` (email de la identidad suplantada).`)
    const rawClaims = e['claims']
    if (!rawClaims || typeof rawClaims !== 'object' || Array.isArray(rawClaims)) {
      return fail(`identidad '${label}' no declara \`claims\` (objeto claim → valor(es); \`{}\` es válido y significa sin claims).`)
    }
    const claims: Record<string, string[]> = {}
    for (const [c, v] of Object.entries(rawClaims as Record<string, unknown>)) {
      if (v == null) continue
      if (Array.isArray(v)) claims[c] = v.map(String)
      else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') claims[c] = [String(v)]
      else return fail(`identidad '${label}': claim '${c}' debe ser string o arreglo de strings.`)
    }
    out.push({ label, user, claims })
  })
  return out
}

/** Envs retirados que siguen apareciendo en despliegues vivos: se avisan y se ignoran (jamás se
 *  imprime su VALOR). `VERGIS_ANNOTATION_SECRET` firmaba los tokens por-fila del esquema de
 *  anotaciones, retirado junto con él (vergis#84). */
export function deprecatedEnvWarnings(env: Env = process.env): string[] {
  const out: string[] = []
  if ((env['VERGIS_ANNOTATION_SECRET'] ?? '') !== '') {
    out.push(
      'VERGIS_ANNOTATION_SECRET está DEPRECADO y se ignora: el esquema de tokens por fila fue retirado ' +
        'con la capa de notas. El secreto CSRF de las superficies de gestión se fija con VERGIS_CSRF_SECRET.',
    )
  }
  for (const k of ['VERGIS_ANNOTATIONS_DB', 'VERGIS_ANNOTATIONS_URL']) {
    if ((env[k] ?? '') !== '') {
      out.push(`${k} está DEPRECADO y se ignora: el store de anotaciones fue reemplazado por la capa de notas (VERGIS_NOTES_DB).`)
    }
  }
  return out
}

function tmpdirSafe(): string {
  return tmpdir()
}
function defaultRandomSecret(): string {
  return randomBytes(32).toString('hex')
}
