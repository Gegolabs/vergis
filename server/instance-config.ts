/**
 * Fase de carga de la CONFIG DECLARATIVA DE INSTANCIA — fail-closed y FATAL (issue #117).
 *
 * Los YAML que declaran qué gobierna esta instancia (dominios, slots de ingesta, data maestra,
 * grupos semilla, dueños de PI, registro de fuentes, destinos de aviso, secciones de menú, colecciones estáticas) se cargan aquí, en un solo lugar, ANTES del
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
import { countMenuLinks, parseMenuConfig, type MenuConfig, type MenuSection } from './menu-config'
import { parseStaticConfig, type StaticCollection, type StaticConfig } from './static-config'
import { parseWritersConfig, type WriterDecl, type WritersConfig } from './writers-config'
import { parseSemanticaConfig, type SemanticaConfig } from './semantica-config'

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
  /**
   * Secciones que la instancia agrega al menú de identidad (`VERGIS_MENU`). Sin el env: cero secciones
   * ⇒ el menú queda idéntico. Una sección o un enlace inválidos se OMITEN (queda su aviso en
   * `menuWarnings`) en vez de tumbar el arranque: ver la cabecera de `menu-config.ts`.
   *
   * ARREGLO VIVO (CAP-194): la recarga en caliente lo repuebla POR SPLICE, nunca reasignando la
   * propiedad — el cableado de `/admin` captura ESTA referencia al arranque (`createAdmin({ menuSections })`
   * en `serve-rls.ts`, leída a render-time en `admin.ts`), así que un reemplazo del arreglo dejaría
   * al avatar de administración sirviendo el menú viejo mientras el catálogo sirve el nuevo.
   */
  menuSections: MenuSection[]
  /**
   * Avisos de lo que se omitió de `VERGIS_MENU`. El arranque los imprime uno por línea, y la recarga
   * los re-emite nombrando que vienen de una recarga. Arreglo vivo por el mismo criterio de arriba.
   */
  menuWarnings: string[]
  /**
   * Colecciones de archivos estáticos que el nodo sirve por cuenta de la instancia (`VERGIS_STATIC`,
   * CAP-195). Sin el env: cero colecciones ⇒ la superficie es idéntica a la de antes de la capacidad
   * (ningún prefijo se intercepta). Una entrada inválida se OMITE (queda su aviso en `staticWarnings`)
   * en vez de tumbar el arranque: ver la cabecera de `static-config.ts`.
   *
   * ARREGLO VIVO, por el MISMO criterio que `menuSections` (CAP-194): la recarga en caliente lo
   * repuebla POR SPLICE, nunca reasignando la propiedad. Hoy el único consumidor —el despacho de
   * `routes.ts`— lo lee por request a través de un getter (`getStaticCollections`), así que una
   * reasignación no lo rompería; el splice se mantiene igual porque el día que alguien capture esta
   * referencia al arranque (como hizo `createAdmin` con el menú) la falla sería silenciosa y por
   * pantalla, que es exactamente la que CAP-194 costó descubrir en producción.
   */
  staticCollections: StaticCollection[]
  /**
   * Avisos de lo que se omitió de `VERGIS_STATIC`. El arranque los imprime uno por línea y la recarga
   * los re-emite nombrando que vienen de una recarga. Arreglo vivo por el mismo criterio de arriba.
   */
  staticWarnings: string[]
  /**
   * Escritores del terreno declarados por la instancia (`VERGIS_WRITERS`, CAP-197). Sin el env: cero
   * escritores ⇒ el catálogo dice «escritor no declarado» donde corresponde, que es la respuesta
   * honesta y no un hueco silencioso. Una entrada inválida se OMITE (su aviso queda en
   * `writersWarnings`) en vez de tumbar el arranque: ver la cabecera de `writers-config.ts`.
   *
   * ARREGLO VIVO, por el mismo criterio que `menuSections` y `staticCollections`: la recarga lo
   * repuebla POR SPLICE. Su consumidor —el generador del Datadoc— lo lee en el instante de generar.
   */
  writers: WriterDecl[]
  /** Avisos de lo que se omitió de `VERGIS_WRITERS`. Arreglo vivo, mismo criterio. */
  writersWarnings: string[]
  /**
   * Diccionario semántico declarado por la instancia (`VERGIS_SEMANTICA`, CAP-197). Sin el env: cero
   * conexiones declaradas ⇒ «sin descripción» donde falte. OBJETO VIVO: la recarga lo repuebla
   * in-place con `Object.assign` + splice de su lista, por el mismo contrato que los arreglos.
   */
  semantica: SemanticaConfig
  /** Avisos de lo que se omitió de `VERGIS_SEMANTICA`. Arreglo vivo, mismo criterio. */
  semanticaWarnings: string[]
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
  env: 'VERGIS_NOTIFY' | 'VERGIS_PI_OWNERS' | 'VERGIS_SOURCES' | 'VERGIS_MENU' | 'VERGIS_STATIC' | 'VERGIS_WRITERS' | 'VERGIS_SEMANTICA'
  parse: (doc: unknown) => T
}

/**
 * Los slices que se recargan sin recrear el proceso: avisos, dueños de PI y registro de fuentes
 * (fase 1 de #138·2) y las secciones de menú de la instancia (CAP-194). Fase 3 añade `VERGIS_GROUPS`
 * acá y en el watch; el resto de la config de instancia es irreductiblemente de arranque (arrastra
 * esquema y superficies cableadas).
 *
 * El menú entra por la MISMA puerta que los otros tres, y eso es lo único que lo volvió recargable:
 * su parser ya devolvía un valor puro y sus consumidores ya lo leían del arreglo vivo. Lo que NO
 * cambia es el arranque — la clave raíz `menu:` ausente sigue siendo fatal (contrato de #117).
 */
export const RELOADABLE_SLICES: {
  notify: InstanceSlice<NotifyConfig>
  piOwners: InstanceSlice<Record<string, string>>
  sources: InstanceSlice<SourcesConfig>
  menu: InstanceSlice<MenuConfig>
  static: InstanceSlice<StaticConfig>
  writers: InstanceSlice<WritersConfig>
  semantica: InstanceSlice<SemanticaConfig>
} = {
  notify: { env: 'VERGIS_NOTIFY', parse: parseNotifyConfig },
  piOwners: { env: 'VERGIS_PI_OWNERS', parse: parsePiOwnersConfig },
  sources: { env: 'VERGIS_SOURCES', parse: parseSourcesConfig },
  menu: { env: 'VERGIS_MENU', parse: parseMenuConfig },
  // Los estáticos de instancia (CAP-195) entran por la MISMA puerta que el menú, y por el mismo
  // motivo: su parser devuelve un valor puro y su consumidor lo lee del arreglo vivo. Publicar una
  // página no puede exigir recrear el proceso — ése era justamente el costo que la capacidad retira.
  static: { env: 'VERGIS_STATIC', parse: parseStaticConfig },
  // Las dos declaraciones del Datadoc (CAP-197) entran por la MISMA puerta, y por el mismo motivo:
  // parser puro, valor puro, y un consumidor —el generador, en el instante de generar— que lee el
  // valor vivo. Corregir una descripción o declarar un escritor nuevo no puede exigir recrear el
  // proceso: es texto, y el catálogo se regenera bajo demanda.
  writers: { env: 'VERGIS_WRITERS', parse: parseWritersConfig },
  semantica: { env: 'VERGIS_SEMANTICA', parse: parseSemanticaConfig },
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
  // Los cinco slices recargables se cargan por la MISMA tabla que usa la recarga (arriba): el boot
  // no puede parsearlos distinto de como los parseará el watch.
  const sourceReg = loadSlice(env, RELOADABLE_SLICES.sources, readFile)
  const piOwners = loadSlice(env, RELOADABLE_SLICES.piOwners, readFile)
  const notify = loadSlice(env, RELOADABLE_SLICES.notify, readFile)
  const menu = loadSlice(env, RELOADABLE_SLICES.menu, readFile)
  const estaticos = loadSlice(env, RELOADABLE_SLICES.static, readFile)
  const escritores = loadSlice(env, RELOADABLE_SLICES.writers, readFile)
  const semantica = loadSlice(env, RELOADABLE_SLICES.semantica, readFile)

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
  if (menu) partes.push(`menu ${menu.sections.length} sección(es) · ${countMenuLinks(menu.sections)} enlace(s)`)
  if (estaticos) partes.push(`static ${estaticos.collections.length} colección(es)`)
  if (escritores) partes.push(`writers ${escritores.writers.length} escritor(es)`)
  if (semantica) partes.push(`semantica ${semantica.conexiones.length} conexión(es) declarada(s)`)

  return {
    entities: entities ?? [],
    groupSeeds: groupSeeds ?? [],
    domains: domains ?? [],
    intakeSlots: intakeSlots ?? [],
    sourceReg: sourceReg ?? {},
    jobTemplates: jobTemplates ?? [],
    piOwners: piOwners ?? {},
    notify: notify ?? { destinations: [] },
    menuSections: menu?.sections ?? [],
    menuWarnings: menu?.warnings ?? [],
    staticCollections: estaticos?.collections ?? [],
    staticWarnings: estaticos?.warnings ?? [],
    writers: escritores?.writers ?? [],
    writersWarnings: escritores?.warnings ?? [],
    semantica: semantica ?? { conexiones: [], warnings: [] },
    semanticaWarnings: semantica?.warnings ?? [],
    publicUrl,
    summary: partes.join(' · '),
  }
}
