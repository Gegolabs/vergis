/**
 * Fase de carga de la CONFIG DECLARATIVA DE INSTANCIA — fail-closed y FATAL (issue #117).
 *
 * Los YAML que declaran qué gobierna esta instancia (dominios, slots de ingesta, data maestra,
 * grupos semilla, dueños de PI, registro de fuentes, destinos de aviso) se cargan aquí, en un solo lugar, ANTES del
 * bloque de administración y FUERA de su `try/catch` de infra. Motivo: ese catch existe para fallas
 * de infraestructura («administración deshabilitada», no-fatal), y al envolver también la carga de
 * config convertía un archivo roto en una degradación silenciosa. Un archivo declarado que no
 * parsea, o que perdió su clave raíz, tumba el arranque nombrando ENV + ruta + clave.
 *
 * Tres estados, dos errores (contrato de #117):
 *  · env no definido        → la config no se usa (ni error ni mención en el resumen).
 *  · clave raíz ausente     → error de arranque (`sed`/merge/truncado que rompió el YAML sin romper
 *                             su sintaxis: el modo de falla que este módulo existe para atrapar).
 *  · clave presente y vacía → cero elementos, legítimo y silencioso (visible en el conteo).
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  parseDomainsConfig,
  parseGroupsConfig,
  parseIntakeConfig,
  parseJobTemplatesConfig,
  parseMasterDataConfig,
  parsePiOwnersConfig,
  parseSourcesConfig,
  parseTemplateParts,
  type DomainDecl,
  type GroupSeed,
  type IntakeSlot,
  type JobTemplate,
  type MasterDataEntity,
  type SourcesConfig,
} from '@vergis/capabilities'
import { parseNotifyConfig, type NotifyConfig } from './notify'

/**
 * Una plantilla de job declarada por la instancia, con el contenido CRUDO de sus partes ya leído del
 * disco e indexado por el `path` de cada parte (issue #107 fase 2). El servidor renderiza desde acá
 * sin volver a disco: lo que el arranque validó es lo que se publica.
 */
export interface LoadedJobTemplate {
  template: JobTemplate
  /** `path` de la parte → contenido crudo del archivo declarado en `file`. */
  partFiles: Record<string, string>
}

/** Lo que declaró la instancia, ya validado. Las configs sin env definido quedan vacías. */
export interface InstanceConfig {
  entities: MasterDataEntity[]
  groupSeeds: GroupSeed[]
  domains: DomainDecl[]
  intakeSlots: IntakeSlot[]
  sourceReg: SourcesConfig | Record<string, never>
  /**
   * Plantillas de publicación de jobs (`VERGIS_JOB_TEMPLATES`, issue #107 fase 2 · D3). SOLO-ARRANQUE
   * a propósito: no entra en `RELOADABLE_SLICES` — recargarla en caliente es decisión pendiente
   * (fases 2-3 de #138·2). Sin el env: cero plantillas ⇒ la sección de publicación no existe.
   */
  jobTemplates: LoadedJobTemplate[]
  piOwners: Record<string, string>
  /** Destinos de aviso saliente (issue #100). Sin `VERGIS_NOTIFY`, cero destinos = avisos apagados. */
  notify: NotifyConfig
  /** URL pública de la instancia, normalizada sin slash final. Exigida si hay destinos de aviso. */
  publicUrl: string
  /** Línea de conteos para el log de arranque; SOLO las configs con env definido. */
  summary: string
}

export type EnvLike = Record<string, string | undefined>
export type ReadFile = (path: string) => string

const defaultReadFile: ReadFile = (p) => readFileSync(p, 'utf8')

/**
 * Carga una config declarada por `env`. Si el env no está definido devuelve `undefined` (la config no
 * se usa). Cualquier error del parser sale envuelto con el ENV y la ruta absoluta.
 */
function loadOne<T>(env: EnvLike, name: string, parse: (doc: unknown) => T, readFile: ReadFile): T | undefined {
  const raw = env[name]
  if (!raw) return undefined
  const path = resolve(raw)
  try {
    return parse(parseYaml(readFile(path)))
  } catch (e) {
    throw new Error(`${name} (${path}): ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Carga `VERGIS_JOB_TEMPLATES`: el manifiesto Y las partes que declara (issue #107 fase 2).
 *
 * No pasa por `loadOne` porque necesita la RUTA del manifiesto: las rutas `file:` de las partes se
 * resuelven relativas AL DIRECTORIO DEL MANIFIESTO —así el repo de la instancia mueve el conjunto
 * completo sin re-escribir rutas— y se leen por el mismo seam `ReadFile` que todo lo demás.
 *
 * Fail-closed, fatal al arranque: manifiesto sin clave raíz, parte inexistente o ilegible, parte que
 * no es JSON, placeholder no declarado o parámetro sin placeholder ⇒ el proceso no levanta, nombrando
 * ENV + ruta + detalle. Un manifiesto incoherente descubierto al publicar sería descubrirlo tarde.
 */
function loadJobTemplates(env: EnvLike, readFile: ReadFile): LoadedJobTemplate[] | undefined {
  const raw = env['VERGIS_JOB_TEMPLATES']
  if (!raw) return undefined
  const manifestPath = resolve(raw)
  const baseDir = dirname(manifestPath)
  try {
    const { templates } = parseJobTemplatesConfig(parseYaml(readFile(manifestPath)))
    return templates.map((template) => {
      const partFiles: Record<string, string> = {}
      for (const part of template.parts) {
        const partPath = resolve(baseDir, part.file)
        try {
          partFiles[part.path] = readFile(partPath)
        } catch (e) {
          throw new Error(
            `plantilla '${template.id}': no se pudo leer la parte '${part.path}' (${partPath}): ` +
              `${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      // Cruce placeholders ↔ params: lo mismo que verificará el render, pero en el arranque.
      parseTemplateParts(template, partFiles)
      return { template, partFiles }
    })
  } catch (e) {
    throw new Error(`VERGIS_JOB_TEMPLATES (${manifestPath}): ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Un slice RECARGABLE de la config de instancia: el env que lo declara y el parser que lo valida
 * (issue #138·2). El boot y la recarga en caliente consumen LA MISMA entrada de esta tabla — divergir
 * es imposible por construcción, que es el riesgo real de tener dos caminos de carga.
 */
export interface InstanceSlice<T> {
  env: 'VERGIS_NOTIFY' | 'VERGIS_PI_OWNERS' | 'VERGIS_SOURCES'
  parse: (doc: unknown) => T
}

/**
 * Los slices que se recargan sin recrear el proceso (fase 1 de #138·2: avisos, dueños de PI y
 * registro de fuentes). Fase 3 añade `VERGIS_GROUPS` acá y en el watch; el resto de la config de
 * instancia es irreductiblemente de arranque (arrastra esquema y superficies cableadas).
 */
export const RELOADABLE_SLICES: {
  notify: InstanceSlice<NotifyConfig>
  piOwners: InstanceSlice<Record<string, string>>
  sources: InstanceSlice<SourcesConfig>
} = {
  notify: { env: 'VERGIS_NOTIFY', parse: parseNotifyConfig },
  piOwners: { env: 'VERGIS_PI_OWNERS', parse: parsePiOwnersConfig },
  sources: { env: 'VERGIS_SOURCES', parse: parseSourcesConfig },
}

/**
 * Re-parsea UN slice desde disco. `undefined` si su env no está declarado (la config no se usa).
 * Cualquier error del parser sale envuelto con el ENV y la ruta absoluta, igual que en el boot.
 *
 * PURA respecto del proceso: no swapea nada, no toca estado vivo. Quien la llama decide qué hacer
 * con el resultado — así el validate-before-swap de la recarga es del orquestador, no de acá.
 */
export function loadSlice<T>(env: EnvLike, slice: InstanceSlice<T>, readFile: ReadFile = defaultReadFile): T | undefined {
  return loadOne(env, slice.env, slice.parse, readFile)
}

/**
 * Valida TODA config declarada por env, incondicionalmente (un `domains.yaml` declarado se valida
 * aunque la instancia no tenga data maestra ni admins). Lanza al primer archivo roto: el throw es
 * top-level en `serve-rls.ts` y tumba el proceso.
 */
export function loadInstanceConfig(env: EnvLike, readFile: ReadFile = defaultReadFile): InstanceConfig {
  const entities = loadOne(env, 'VERGIS_MASTER_DATA', parseMasterDataConfig, readFile)
  const groupSeeds = loadOne(env, 'VERGIS_GROUPS', parseGroupsConfig, readFile)
  const domains = loadOne(env, 'VERGIS_DOMAINS', parseDomainsConfig, readFile)
  const intakeSlots = loadOne(env, 'VERGIS_INTAKE', parseIntakeConfig, readFile)
  const jobTemplates = loadJobTemplates(env, readFile)
  // Los tres slices recargables se cargan por la MISMA tabla que usa la recarga (arriba): el boot no
  // puede parsearlos distinto de como los parseará el watch.
  const sourceReg = loadSlice(env, RELOADABLE_SLICES.sources, readFile)
  const piOwners = loadSlice(env, RELOADABLE_SLICES.piOwners, readFile)
  const notify = loadSlice(env, RELOADABLE_SLICES.notify, readFile)

  // Los avisos llevan enlaces ABSOLUTOS a la vista de detalle (issue #100): sin URL pública, un
  // destino declarado produciría avisos sin dónde mirar. Se rompe el arranque —donde el operador está
  // mirando— en vez de callarlo hasta la primera alerta de las siete de la mañana.
  const publicUrl = (env['VERGIS_PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '')
  if ((notify?.destinations.length ?? 0) > 0 && !publicUrl)
    throw new Error('VERGIS_NOTIFY declara destinos pero falta VERGIS_PUBLIC_URL (los avisos llevan enlaces absolutos a la vista de detalle).')

  const partes: string[] = []
  if (groupSeeds) partes.push(`groups ${groupSeeds.length}`)
  if (domains) partes.push(`domains ${domains.length}`)
  if (piOwners) partes.push(`pi-owners ${Object.keys(piOwners).length}`)
  if (sourceReg) {
    partes.push(
      `sources ${sourceReg.sources?.length ?? 0} (tablas ${sourceReg.tableSources?.length ?? 0} · ` +
        `procesos ${sourceReg.processes?.length ?? 0} · salidas ${sourceReg.processOutputs?.length ?? 0})`,
    )
  }
  if (intakeSlots) partes.push(`intake-slots ${intakeSlots.length}`)
  if (entities) partes.push(`master-data ${entities.length}`)
  if (notify) partes.push(`notify ${notify.destinations.length}`)
  if (jobTemplates) partes.push(`jobs-templates ${jobTemplates.length}`)

  return {
    entities: entities ?? [],
    groupSeeds: groupSeeds ?? [],
    domains: domains ?? [],
    intakeSlots: intakeSlots ?? [],
    sourceReg: sourceReg ?? {},
    jobTemplates: jobTemplates ?? [],
    piOwners: piOwners ?? {},
    notify: notify ?? { destinations: [] },
    publicUrl,
    summary: partes.join(' · '),
  }
}
