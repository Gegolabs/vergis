import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Botler, type IdentityContext, type LogEntry } from '@vergis/botler'
import { starterCapabilities, createExecuteSqlDwh, type SqlConnectionProfile } from '@vergis/capabilities'
import { createMiraBotlet } from '@vergis/mira'

export interface RunOptions {
  specPath: string
  /** Ruta del append-only log (JSONL). Si se omite, el log vive solo en memoria. */
  logPath?: string
  /** Directorio base de salida para publicar-artefacto. Default: cwd. */
  baseDir?: string
  /** Override de la ruta del schema. Default: vergis/schema/mira-spec.schema.json. */
  schemaPath?: string
  /** Reloj inyectable (reproducibilidad en tests). */
  clock?: () => string
  /** Perfiles de conexión SQL (database_ref → perfil). Si se pasan, se registra execute-sql-dwh. */
  connections?: Record<string, SqlConnectionProfile>
}

export interface RunOutcome {
  ok: boolean
  botletId: string
  artifacts: { format: string; path?: string }[]
  fallback?: { reason: string; recovery: string }
  log: LogEntry[]
  chainValid: boolean
}

function defaultSchemaPath(): string {
  // packages/cli/src/run.ts → ../../../schema/mira-spec.schema.json
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../schema/mira-spec.schema.json')
}

/**
 * Arma Vergis (Botler + catálogo + Mira), instancia el Botlet desde el spec y lo invoca.
 * Es el corte vertical completo del walking skeleton.
 */
export async function runSpec(options: RunOptions): Promise<RunOutcome> {
  const schemaPath = options.schemaPath ?? defaultSchemaPath()
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object
  const specText = readFileSync(options.specPath, 'utf8')

  const identity: IdentityContext = { agent: 'vergis-cli' }
  const botler = new Botler({
    logPath: options.logPath,
    identity,
    agencyDomainId: 'vergis-lab',
    clock: options.clock,
  })
  botler.start()

  // Capa 2 (stub): la cognición que rescata cuando un Botlet falla.
  botler.onBotletFailure((botletId, failure) => {
    console.error(
      `[fallback agéntico] Botlet '${botletId}' falló: ${failure.error}. ` +
        `La cognición ejecutaría manualmente (stub v0.1).`,
    )
    return 'mark-for-regeneration'
  })

  for (const cap of starterCapabilities) botler.registerCapability(cap)
  if (options.connections && Object.keys(options.connections).length > 0) {
    botler.registerCapability(createExecuteSqlDwh(options.connections))
  }

  const mira = createMiraBotlet(specText, { schema })
  botler.register(mira, options.specPath)

  const result = await botler.invoke(mira.id, {
    identity,
    trigger: 'on-demand',
    params: { baseDir: options.baseDir ?? process.cwd() },
  })
  botler.stop()

  const output = (result.output ?? {}) as { artifacts?: { format: string; path?: string }[] }
  return {
    ok: result.ok,
    botletId: result.botletId,
    artifacts: output.artifacts ?? [],
    fallback: result.fallback,
    log: botler.log.all(),
    chainValid: botler.log.verifyChain(),
  }
}
