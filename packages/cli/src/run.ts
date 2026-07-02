import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Botler, type Capability, type IdentityContext, type LogEntry } from '@vergis/botler'
import { starterCapabilities, createExecuteSqlDwh, type SqlConnectionProfile } from '@vergis/capabilities'
import { MiraBotlet, parseSpec, type AnnotationContext, type MiraSpec } from '@vergis/mira'

// Caché module-level del camino de serving (work/052 F3): sin ella cada request re-lee+re-parsea el
// schema y el spec desde disco. El schema se parsea UNA vez por ruta → misma IDENTIDAD de objeto ⇒ el
// WeakMap de getValidator reusa el validador AJV compilado. El spec (texto+YAML) se memoiza por
// (ruta, mtime): editar el archivo cambia el mtime e invalida naturalmente (el hot-reload por
// watchPaths sigue funcionando). NADA muta el spec cacheado entre requests: composePiece copia los
// arreglos, y las anotaciones mutan filas de RESULTADOS, no el árbol del spec.
const schemaCache = new Map<string, object>()
const specCache = new Map<string, { mtimeMs: number; spec: MiraSpec }>()
/** Contadores de parseo (solo para pruebas: verifican que el 2º request no re-parsea). */
export const parseCounters = { schema: 0, spec: 0 }

function loadSchema(path: string): object {
  const hit = schemaCache.get(path)
  if (hit) return hit
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as object
  parseCounters.schema++
  schemaCache.set(path, parsed)
  return parsed
}

function loadSpec(path: string): MiraSpec {
  const mtimeMs = statSync(path).mtimeMs
  const hit = specCache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.spec
  const spec = parseSpec(readFileSync(path, 'utf8')) as MiraSpec
  parseCounters.spec++
  specCache.set(path, { mtimeMs, spec })
  return spec
}

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
  /**
   * Identidad del CONSUMIDOR para esta corrida. Sus `claims` (grupos del gate) viajan hasta
   * las Capabilities — es lo que hace el render por-consumidor con RLS (la fuente filtra por claims).
   * Default: el agente runtime sin claims (render no-segmentado, para specs públicos).
   */
  identity?: IdentityContext
  /**
   * Capabilities adicionales a registrar (p.ej. `execute-sql-ch` con su enforcement ya compilado).
   * Mantiene runSpec genérico: el ensamblado de RLS lo arma el llamador.
   */
  extraCapabilities?: Capability[]
  /**
   * Registrar el catálogo starter (incluye `static-data`, que **embebe** datos). Default true.
   * El server RLS lo pone en `false` para HARDENING del catálogo de serving (charter §2b): sobre
   * dato gobernado el catálogo solo debe tener capabilities que aplican la policy + render/publish,
   * nunca una vía de embebido/cruda → bypass estructuralmente imposible. El llamador provee todo
   * vía `extraCapabilities`.
   */
  registerStarters?: boolean
  /** Contexto de anotaciones (enriquecimiento de la capa de viz). Si se pasa, Mira fusiona la
   *  columna editable en la primera tabla. Lo arma el server (store + firma del token). */
  annotations?: AnnotationContext
  /** PI multi-vista: id de la página activa (default: la 1ª). Viene de la query `?page=`. */
  page?: string
  /** Contexto del drill-through (campo→valor). Viene de la query `?ctx.<campo>=`. Filtro adicional
   *  bindeado dentro de las filas que la RLS ya autoriza (acota, nunca amplía). */
  ctx?: Record<string, string>
  /** Tope de filas materializables por `interactions.filters` (ver MiraOptions.interactiveMaxRows).
   *  Mira no lee env: el server lo toma de VERGIS_INTERACTIVE_MAX_ROWS y lo inyecta acá. */
  interactiveMaxRows?: number
}

export interface RunOutcome {
  ok: boolean
  botletId: string
  artifacts: { format: string; path?: string }[]
  /** El HTML renderizado (para servir per-request sin pasar por disco). */
  html?: string
  fallback?: { reason: string; recovery: string }
  log: LogEntry[]
  chainValid: boolean
}

function defaultSchemaPath(): string {
  // Candidatos: relativo al fuente (dev con tsx) → relativo al cwd (dist/ bundleado, imagen Docker).
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../schema/mira-spec.schema.json'),
    resolve(process.cwd(), 'schema/mira-spec.schema.json'),
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

/**
 * Arma Vergis (Botler + catálogo + Mira), instancia el Botlet desde el spec y lo invoca.
 * Es el corte vertical completo del walking skeleton.
 */
export async function runSpec(options: RunOptions): Promise<RunOutcome> {
  const schemaPath = options.schemaPath ?? defaultSchemaPath()
  const schema = loadSchema(schemaPath)
  const spec = loadSpec(options.specPath)

  const identity: IdentityContext = options.identity ?? { agent: 'vergis-cli' }
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

  if (options.registerStarters !== false) {
    for (const cap of starterCapabilities) botler.registerCapability(cap)
    if (options.connections && Object.keys(options.connections).length > 0) {
      botler.registerCapability(createExecuteSqlDwh(options.connections))
    }
  }
  for (const cap of options.extraCapabilities ?? []) botler.registerCapability(cap)

  // Se construye desde el spec YA parseado (cacheado): validate() corre por request (depende del
  // catálogo de capabilities), pero el parseo de texto/YAML y del schema no se repiten.
  const mira = new MiraBotlet(spec, { schema, interactiveMaxRows: options.interactiveMaxRows })
  botler.register(mira, options.specPath)

  const result = await botler.invoke(mira.id, {
    identity,
    trigger: 'on-demand',
    params: {
      baseDir: options.baseDir ?? process.cwd(),
      annotations: options.annotations,
      page: options.page,
      ctx: options.ctx,
    },
  })
  botler.stop()

  const output = (result.output ?? {}) as { artifacts?: { format: string; path?: string }[]; html?: string }
  return {
    ok: result.ok,
    botletId: result.botletId,
    artifacts: output.artifacts ?? [],
    html: output.html,
    fallback: result.fallback,
    log: botler.log.all(),
    chainValid: botler.log.verifyChain(),
  }
}
