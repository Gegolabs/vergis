/**
 * EL ORQUESTADOR del Datadoc (`CAP-197`) — lo que ata medir, ensamblar, dibujar y publicar, y lo
 * único de este frente que conoce el reloj, el store de settings y el plano de control.
 *
 * ── SOLO GENERA EL NODO QUE TIENE EL CONTROL ────────────────────────────────────────────────────
 * La generación escribe en `VERGIS_OUT`, que es sustrato COMPARTIDO entre los nodos de un anillo. Dos
 * nodos generando a la vez producirían builds cruzados sobre el mismo `current`. La regla es la misma
 * que gobierna todo lazo de fondo: **lo corre quien tiene el control, y nadie más**. El router ya
 * rechaza con 409 toda mutación de `/admin/…` en un nodo standby; acá se vuelve a verificar antes de
 * escribir, porque el disparo también puede llegar por el lazo.
 *
 * ── UNA SOLA EN VUELO ───────────────────────────────────────────────────────────────────────────
 * `generar` va envuelto en `singleFlight`: mientras una corrida esté viva, el segundo clic recibe ESA
 * promesa en vez de arrancar otra medición contra los mismos almacenes.
 *
 * ── EL BUILD RANCIO NO PUBLICA CONTEOS, Y ESTE ES EL ESLABÓN QUE LO CIERRA ───────────────────────
 * La clasificación de gobierno se recalcula en cada generación — y eso **no alcanza solo**. El
 * Producto no aplica las políticas: las aplica la instancia, por su cuenta, cuando quiere. O sea que
 * una tabla puede pasar de abierta a gobernada sin que el nodo se entere, y el build cacheado seguiría
 * publicando el `COUNT` que calculó cuando todavía era legítimo. Por eso `marcarRancio` —que la
 * recarga de gobierno dispara— hace dos cosas: deja la marca en el sello (la página la declara) y
 * **vuelve a dibujar el sitio desde los modelos ya medidos, con los conteos retirados**. Es puro CPU,
 * no toca la red, y cierra la ventana en el acto en vez de esperar a la próxima generación. Sin este
 * eslabón, el default «conteos de tablas abiertas» sería una ventana que se abre sola.
 */

import { singleFlight } from '@vergis/capabilities'
import type { DomainDecl, PlatformSettingStore, SourcesConfig } from '@vergis/capabilities'
import type { Report } from './discovery'
import type { WritersConfig } from './writers-config'
import type { SemanticaConfig } from './semantica-config'
import { medirConexion, type EjecutarSql, type ModeloConexion, type PoliticaConteos } from './datadoc-introspect'
import { ensamblar } from './datadoc-modelo'
import { renderDatadoc } from './datadoc-render'
import {
  dirDatadoc,
  escribirBuild,
  escribirModelo,
  escribirSello,
  hayBuild,
  leerModelos,
  leerSello,
  podar,
  publicar,
  rutaCurrent,
  selloDe,
  type Sello,
  type SelloConexion,
} from './datadoc-store'
import { lastDueAt, periodKeyOf } from './report'
import type { ReportWeekday } from './notify'

/** Las claves de settings de plataforma que este frente posee. */
export const DATADOC_SETTINGS = {
  schedule: 'datadoc_schedule',
  timezone: 'datadoc_timezone',
  conteos: 'datadoc_conteos',
} as const

/** Un schedule declarado: `off`, o una cadencia con hora y (si es semanal) día. */
export type ScheduleDatadoc =
  | { every: 'off' }
  | { every: 'daily'; at: string }
  | { every: 'weekly'; at: string; weekday: ReportWeekday }

const WEEKDAYS: readonly ReportWeekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

/** Una hora del día realmente existente. `25:00` parsea como cadena y no existe como hora. */
function horaValida(at: string): boolean {
  const [hh, mm] = at.split(':').map(Number)
  return Number.isInteger(hh) && Number.isInteger(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59
}

/** Parsea el setting del schedule. Cualquier cosa que no se entienda es `off` — jamás una cadencia adivinada. */
export function parseSchedule(raw: string | null | undefined): ScheduleDatadoc {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s || s === 'off') return { every: 'off' }
  const diario = /^daily@(\d{2}:\d{2})$/.exec(s)
  if (diario && horaValida(diario[1])) return { every: 'daily', at: diario[1] }
  const semanal = /^weekly:([a-z]+)@(\d{2}:\d{2})$/.exec(s)
  if (semanal && (WEEKDAYS as readonly string[]).includes(semanal[1]) && horaValida(semanal[2]))
    return { every: 'weekly', at: semanal[2], weekday: semanal[1] as ReportWeekday }
  return { every: 'off' }
}

/** Serializa un schedule a su setting. Inversa de `parseSchedule`. */
export function formatSchedule(s: ScheduleDatadoc): string {
  if (s.every === 'off') return 'off'
  return s.every === 'daily' ? `daily@${s.at}` : `weekly:${s.weekday}@${s.at}`
}

/** El estado que `/admin/datadoc` y `/contrato` publican. */
export interface EstadoDatadoc {
  habilitado: true
  build: Sello['build']
  conexiones: SelloConexion[]
  rancio: Sello['rancio']
  enCurso: boolean
  schedule: string
  timezone: string
  conteos: PoliticaConteos
  /** Avisos de la última generación (conexión desconocida, entidad sin esquema, etc.). */
  avisos: string[]
  /** El directorio que se estaría sirviendo. Útil en el contrato y para depurar. */
  dir: string
}

export interface DatadocDeps {
  /** `VERGIS_OUT`. El Datadoc vive en su subdirectorio `datadoc/`. */
  out: string
  /** El handle DIRECTO del conector (nunca el envuelto en caché de resultados). */
  execute: EjecutarSql
  /** Los perfiles de `VERGIS_CONNECTIONS`: de acá salen `server` y `database`, no de una consulta. */
  connections: Readonly<Record<string, { server: string; database: string }>>
  discover: () => Report[]
  /** Los arreglos/objetos VIVOS de la config de instancia: se leen en el instante de generar. */
  writers: () => WritersConfig
  semantica: () => SemanticaConfig
  domains: () => readonly DomainDecl[]
  sources: () => SourcesConfig | Record<string, never>
  settings?: PlatformSettingStore
  brandTitle?: () => string | undefined
  audit: (evento: Record<string, unknown>) => void
  hasControl: () => boolean
  log?: (msg: string) => void
  now?: () => Date
  /** Lista blanca de esquemas a catalogar. Default `['dbo']`. */
  esquemas?: readonly string[]
}

export interface Datadoc {
  /** Genera: mide (todo o una conexión) y vuelve a dibujar. Una sola en vuelo. */
  generar(alcance?: 'all' | string): Promise<{ ok: boolean; build?: string; fallidas: string[]; ms: number; motivo?: string }>
  estado(): Promise<EstadoDatadoc>
  /** Guarda schedule y política de conteos. Devuelve lo que quedó. */
  ajustes(input: { schedule?: string; timezone?: string; conteos?: string }, by: string): Promise<{ schedule: string; timezone: string; conteos: PoliticaConteos }>
  /** La vuelta del lazo: dispara la generación si venció un período que todavía no se generó. */
  tickSchedule(): Promise<void>
  /** El gobierno cambió: se marca el build y se le retiran los conteos, sin volver a medir. */
  marcarRancio(razon: string): Promise<void>
  /**
   * El estado para `GET /contrato` — SÍNCRONO, porque `snapshot()` lo es. Lee el sello del disco (un
   * JSON chico) y toma las perillas del operador de la caché que se refresca cada vez que alguien las
   * usa: un contrato que mienta sobre el build servido no sirve para nada, y esperar por el store de
   * settings volvería async a todo el snapshot.
   */
  contrato(): {
    enabled: true
    current: { build: string; generadoEn: string } | null
    conexiones: { ref: string; ok: boolean; medidoEn: string | null; error?: string }[]
    enCurso: boolean
    schedule: string
    conteos: PoliticaConteos
    rancio: { razon: string; desde: string } | null
  }
  /** El `dir` de la colección que el nodo sirve en `/datadoc/`. */
  dirServido(): string
  hayBuild(): boolean
  enCurso(): boolean
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createDatadoc(deps: DatadocDeps): Datadoc {
  const log = deps.log ?? ((m: string) => console.log(m))
  const reloj = deps.now ?? ((): Date => new Date())
  const dir = dirDatadoc(deps.out)
  const esquemas = deps.esquemas?.length ? [...deps.esquemas] : ['dbo']
  let avisos: string[] = []

  const leerSetting = async (clave: string): Promise<string | null> => {
    if (!deps.settings) return null
    try {
      return await deps.settings.getSetting(clave)
    } catch (e) {
      log(`[datadoc] no se pudo leer el setting '${clave}': ${errMsg(e)}`)
      return null
    }
  }

  // Caché de las dos perillas del operador. El store de settings es async y `GET /contrato` es
  // síncrono: se refresca cada vez que alguien las lee o las escribe, y arranca en el default. Es
  // observabilidad —no gobierna nada—, así que un valor de hace unos segundos es aceptable; usarla
  // para DECIDIR si se pide un conteo no lo sería, y por eso ahí siempre se lee el store.
  let cacheConteos: PoliticaConteos = 'abiertas'
  let cacheSchedule = 'off'

  const politicaConteos = async (): Promise<PoliticaConteos> => {
    cacheConteos = (await leerSetting(DATADOC_SETTINGS.conteos))?.trim().toLowerCase() === 'off' ? 'off' : 'abiertas'
    return cacheConteos
  }

  const zona = async (): Promise<string> => {
    const z = (await leerSetting(DATADOC_SETTINGS.timezone))?.trim()
    if (z) return z
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
      return 'UTC'
    }
  }

  /**
   * Dibuja y publica desde los modelos que HAY en disco (los de esta corrida y los conservados), con
   * el sello que se le pase. No mide nada: es puro CPU y por eso `marcarRancio` puede llamarla.
   */
  const renderizar = async (sello: Sello, conteos: PoliticaConteos): Promise<string> => {
    const modelos = leerModelos(dir)
    const fallidas: Record<string, string> = {}
    for (const c of sello.conexiones) if (!c.ok && c.error) fallidas[c.ref] = c.error
    const modelo = ensamblar({
      modelos,
      fallidas,
      refs: Object.keys(deps.connections),
      reports: deps.discover(),
      domains: deps.domains(),
      writers: deps.writers(),
      semantica: deps.semantica(),
      sources: deps.sources(),
      // Un build RANCIO no publica conteos: la clasificación bajo la que se calcularon ya no es la
      // vigente, y un número protegido por una política que cambió no se republica por inercia.
      conteos: sello.rancio ? 'off' : conteos,
      rancio: sello.rancio,
      now: reloj,
    })
    avisos = modelo.avisos
    const archivos = renderDatadoc({ modelo, brandTitle: deps.brandTitle?.(), timezone: await zona() })
    const buildDir = escribirBuild(dir, archivos, reloj())
    publicar(dir, buildDir)
    const borrados = podar(dir, 2)
    if (borrados.length) log(`[datadoc] poda: ${borrados.length} build(s) antiguo(s) retirado(s).`)
    return buildDir
  }

  const generarUnaVez = async (alcance: 'all' | string): Promise<{ ok: boolean; build?: string; fallidas: string[]; ms: number; motivo?: string }> => {
    const t0 = Date.now()
    // Re-verificación del control: el `POST` ya pasó por el gate del router, pero el lazo no, y un
    // traspaso puede haber ocurrido entre el disparo y este instante.
    if (!deps.hasControl()) {
      const motivo = 'este nodo no tiene el plano de control: la generación la corre el activo (VERGIS_OUT es sustrato compartido).'
      log(`[datadoc] generación rechazada: ${motivo}`)
      return { ok: false, fallidas: [], ms: Date.now() - t0, motivo }
    }
    const todas = Object.keys(deps.connections)
    const objetivo = alcance === 'all' ? todas : todas.filter((r) => r === alcance)
    if (!objetivo.length) {
      const motivo = `la conexión '${alcance}' no está declarada en VERGIS_CONNECTIONS.`
      return { ok: false, fallidas: [], ms: Date.now() - t0, motivo }
    }
    const conteos = await politicaConteos()
    const sello = leerSello(dir)
    const porRef = new Map(sello.conexiones.map((c) => [c.ref, c]))

    // Las conexiones se miden EN PARALELO: son I/O de red contra almacenes distintos, y una lenta no
    // tiene por qué retrasar a las demás. Cada una se asienta por su cuenta: `allSettled`, no `all`.
    const resultados = await Promise.allSettled(
      objetivo.map(async (ref) => {
        const perfil = deps.connections[ref]
        const m = await medirConexion(deps.execute, { ref, server: perfil.server, database: perfil.database }, { esquemas, conteos, now: reloj })
        escribirModelo(dir, m)
        return m
      }),
    )
    const fallidas: string[] = []
    objetivo.forEach((ref, i) => {
      const r = resultados[i]
      if (r.status === 'fulfilled') {
        porRef.set(ref, selloDe(r.value as ModeloConexion))
        log(`[datadoc] ✓ ${ref} → ${(r.value as ModeloConexion).database} (${(r.value as ModeloConexion).objetos.length} objetos, ${(r.value as ModeloConexion).ms} ms)`)
      } else {
        fallidas.push(ref)
        const perfil = deps.connections[ref]
        const previo = porRef.get(ref)
        // Se CONSERVA la medición anterior y se la marca: desaparecer la conexión del catálogo sería
        // afirmar que no existe, que es más fuerte y más falso que «hoy no la pude mirar».
        porRef.set(ref, {
          ref,
          database: previo?.database ?? perfil?.database ?? null,
          server: previo?.server ?? perfil?.server ?? null,
          ok: false,
          medidoEn: previo?.medidoEn ?? null,
          ms: null,
          objetos: previo?.objetos ?? null,
          error: errMsg(r.reason),
        })
        log(`[datadoc] ✗ ${ref} NO medida: ${errMsg(r.reason)}`)
      }
    })
    // Las conexiones declaradas que nunca se midieron entran al sello igual: su ausencia se leería
    // como «no existe».
    for (const ref of todas)
      if (!porRef.has(ref))
        porRef.set(ref, { ref, database: deps.connections[ref]?.database ?? null, server: deps.connections[ref]?.server ?? null, ok: false, medidoEn: null, ms: null, objetos: null, error: 'nunca medida' })

    // Una generación exitosa RETIRA la marca de rancio: la clasificación que se acaba de medir es la
    // vigente, que es exactamente lo que la marca decía que faltaba.
    const siguiente: Sello = {
      conexiones: [...porRef.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
      build: null,
      rancio: fallidas.length === objetivo.length && objetivo.length === todas.length ? sello.rancio : null,
      ...(sello.periodKey ? { periodKey: sello.periodKey } : {}),
    }
    const buildDir = await renderizar(siguiente, conteos)
    siguiente.build = { dir: buildDir.split('/').pop() ?? buildDir, generadoEn: reloj().toISOString() }
    escribirSello(dir, siguiente)
    const ms = Date.now() - t0
    const ok = fallidas.length === 0
    deps.audit({ type: 'datadoc-done', ok, conexiones: objetivo.length, fallidas, ms, build: siguiente.build.dir })
    log(`[datadoc] generado: ${objetivo.length - fallidas.length}/${objetivo.length} conexión(es) medidas · build ${siguiente.build.dir} · ${ms} ms`)
    return { ok, build: siguiente.build.dir, fallidas, ms }
  }

  const generar = singleFlight(generarUnaVez)

  return {
    generar: (alcance = 'all') => generar(alcance),
    async estado(): Promise<EstadoDatadoc> {
      const sello = leerSello(dir)
      return {
        habilitado: true,
        build: sello.build,
        conexiones: sello.conexiones.length
          ? sello.conexiones
          : Object.keys(deps.connections)
              .sort()
              .map((ref) => ({
                ref,
                database: deps.connections[ref]?.database ?? null,
                server: deps.connections[ref]?.server ?? null,
                ok: false,
                medidoEn: null,
                ms: null,
                objetos: null,
                error: 'nunca medida',
              })),
        rancio: sello.rancio,
        enCurso: generar.inFlight(),
        schedule: (cacheSchedule = formatSchedule(parseSchedule(await leerSetting(DATADOC_SETTINGS.schedule)))),
        timezone: await zona(),
        conteos: await politicaConteos(),
        avisos,
        dir: rutaCurrent(dir),
      }
    },
    async ajustes(input, by) {
      const schedule = formatSchedule(parseSchedule(input.schedule))
      const conteos: PoliticaConteos = (input.conteos ?? '').trim().toLowerCase() === 'off' ? 'off' : 'abiertas'
      const tz = (input.timezone ?? '').trim()
      if (deps.settings) {
        await deps.settings.setSetting(DATADOC_SETTINGS.schedule, schedule, by)
        await deps.settings.setSetting(DATADOC_SETTINGS.conteos, conteos, by)
        if (tz) await deps.settings.setSetting(DATADOC_SETTINGS.timezone, tz, by)
      }
      cacheSchedule = schedule
      cacheConteos = conteos
      deps.audit({ type: 'platform-setting', key: 'datadoc', value: `${schedule}·${conteos}${tz ? `·${tz}` : ''}`, by })
      return { schedule, timezone: tz || (await zona()), conteos }
    },
    async tickSchedule(): Promise<void> {
      if (!deps.hasControl()) return
      const sched = parseSchedule(await leerSetting(DATADOC_SETTINGS.schedule))
      cacheSchedule = formatSchedule(sched)
      if (sched.every === 'off') return
      const tz = await zona()
      const ahora = reloj().getTime()
      // Se reusa la aritmética del reporte (`lastDueAt` + `periodKeyOf`) en vez de escribir una
      // segunda: dos implementaciones de las zonas horarias son dos respuestas distintas esperando a
      // un cambio de horario de verano.
      const vencido = lastDueAt(ahora, sched.every === 'weekly' ? { at: sched.at, every: 'weekly', weekday: sched.weekday } : { at: sched.at, every: 'daily' }, tz)
      const clave = periodKeyOf(vencido, tz)
      const sello = leerSello(dir)
      if (sello.periodKey === clave) return
      // PRIMERA VUELTA CON ESTE SCHEDULE: se registra la posición y NO se genera. Un nodo que acaba
      // de arrancar —o un schedule que acaba de encenderse— no tiene por qué generar el catálogo de
      // un período que transcurrió antes de que nadie estuviera mirando; el disparo es para los
      // períodos NUEVOS. La recuperación de un período efectivamente perdido sigue funcionando,
      // porque el `periodKey` vive en disco: un nodo que se cayó a las 09:00 y vuelve a las 14:00
      // encuentra la clave de ayer, la compara con la de hoy y sí dispara.
      if (sello.periodKey == null) {
        escribirSello(dir, { ...sello, periodKey: clave })
        log(`[datadoc] schedule ${formatSchedule(sched)} (${tz}): posición inicial en el período ${clave} — el primer disparo será el próximo.`)
        return
      }
      // El `periodKey` se persiste ANTES de generar: si la corrida falla, el período igual queda
      // marcado y el lazo no reintenta cada cinco minutos contra almacenes que no responden. El
      // operador tiene el botón de Generar para eso.
      escribirSello(dir, { ...sello, periodKey: clave })
      deps.audit({ type: 'datadoc-generate', scope: 'all', by: 'schedule', periodKey: clave })
      log(`[datadoc] schedule ${formatSchedule(sched)} (${tz}): venció el período ${clave} — generando.`)
      await generar('all')
    },
    async marcarRancio(razon: string): Promise<void> {
      if (!deps.hasControl()) return
      if (!hayBuild(dir)) return
      const sello = leerSello(dir)
      if (sello.rancio) return // ya marcado: no se re-dibuja por cada recarga de gobierno
      const siguiente: Sello = { ...sello, rancio: { razon, desde: reloj().toISOString() } }
      try {
        const buildDir = await renderizar(siguiente, await politicaConteos())
        siguiente.build = { dir: buildDir.split('/').pop() ?? buildDir, generadoEn: reloj().toISOString() }
        escribirSello(dir, siguiente)
        log(`[datadoc] catálogo marcado RANCIO (${razon}): se re-dibujó sin conteos hasta la próxima generación.`)
      } catch (e) {
        // Un fallo acá no puede tumbar la recarga de gobierno, que es lo importante: se deja la marca
        // en el sello igual, para que la próxima lectura del estado la vea.
        escribirSello(dir, siguiente)
        log(`[datadoc] no se pudo re-dibujar tras marcar rancio (${razon}): ${errMsg(e)} — la marca queda puesta.`)
      }
    },
    contrato() {
      const sello = leerSello(dir)
      return {
        enabled: true as const,
        current: sello.build ? { build: sello.build.dir, generadoEn: sello.build.generadoEn } : null,
        conexiones: sello.conexiones.map((c) => ({ ref: c.ref, ok: c.ok, medidoEn: c.medidoEn, ...(c.error ? { error: c.error } : {}) })),
        enCurso: generar.inFlight(),
        schedule: cacheSchedule,
        conteos: cacheConteos,
        rancio: sello.rancio,
      }
    },
    dirServido: () => rutaCurrent(dir),
    hayBuild: () => hayBuild(dir),
    enCurso: () => generar.inFlight(),
  }
}
