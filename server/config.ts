/**
 * Configuración del servidor RLS desde el entorno — parseo y VALIDACIÓN en un solo lugar.
 *
 * Primer módulo del refactor `createApp()` (work/001, A14): hoy `serve-rls.ts` lee ~35 `process.env`
 * dispersos y a nivel de módulo (intesteable). `configFromEnv(env)` es puro e inyectable — se le pasa
 * un env fake en tests — y valida los numéricos (cierra el hallazgo NaN: `PORT=abc` → `listen(NaN)`,
 * `VERGIS_INTERACTIVE_MAX_ROWS` NaN pasado a Mira sin chequeo).
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
  /** Secreto HMAC de tokens de anotación; `random` indica que se generó por arranque (no persistente). */
  annotationSecret: { value: string; ephemeral: boolean }
  /** Miranda — el agente conversacional de especificación de PIs (cluster 077). Todo detrás del flag. */
  miranda: MirandaConfig
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
  const envSecret = env['VERGIS_ANNOTATION_SECRET']
  return {
    engine,
    miranda: mirandaConfig(env),
    port: num(env, 'PORT', 8080),
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
    annotationSecret: envSecret ? { value: envSecret, ephemeral: false } : { value: randomSecret(), ephemeral: true },
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

function tmpdirSafe(): string {
  return tmpdir()
}
function defaultRandomSecret(): string {
  return randomBytes(32).toString('hex')
}
