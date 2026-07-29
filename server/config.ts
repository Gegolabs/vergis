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
 * Config de Miranda. Con `enabled=false` (default) NADA se activa: ni rutas, ni nav, ni la dependencia
 * de la API. Con `enabled=true` la API key es OBLIGATORIA — su ausencia aborta el arranque con un
 * error claro (no un fallo runtime sorpresa al primer mensaje).
 */
export interface MirandaConfig {
  enabled: boolean
  model: string
  apiKey: string
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

/** Parsea y VALIDA la config de Miranda. Con el flag encendido, la key es obligatoria (aborta si falta). */
function mirandaConfig(env: Env): MirandaConfig {
  const enabled = TRUTHY.has((env['MIRANDA_ENABLED'] ?? '').toLowerCase())
  const apiKey = env['ANTHROPIC_API_KEY'] ?? ''
  if (enabled && !apiKey) {
    throw new Error('MIRANDA_ENABLED está encendido pero falta ANTHROPIC_API_KEY. Define la key (env/KV) o apaga MIRANDA_ENABLED.')
  }
  return {
    enabled,
    model: env['MIRANDA_MODEL'] ?? 'claude-sonnet-5',
    apiKey,
    rubricDir: env['MIRANDA_RUBRIC_DIR'],
    maxTurns: num(env, 'MIRANDA_MAX_TURNS', 40),
    tokenBudget: num(env, 'MIRANDA_TOKEN_BUDGET', 500_000),
    catalogPath: env['MIRANDA_CATALOG'],
    scopeGroup: (env['MIRANDA_SCOPE_GROUP'] ?? 'miranda').trim().toLowerCase(),
    announceWebhook: env['MIRANDA_ANNOUNCE_WEBHOOK'],
  }
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
