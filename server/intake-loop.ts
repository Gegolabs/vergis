/**
 * Lazo de vigilancia del INTAKE (issue #161 — detectar que una carga no completó y avisarle al
 * operador). LAZO HERMANO del de frescura, no una fase suya: la unidad observada es el SLOT (no el
 * proceso), las fuentes de la medida son dos con modos de falla independientes (el ALMACENAMIENTO
 * —listado del landing— y el MOTOR —corridas del trigger—), y no hay reconciliación: por requisito
 * de #161 el lazo detecta y avisa; decidir es de las personas.
 *
 * TRES fases por tick:
 *  1 OBSERVAR — por slot: listado del landing + corridas del trigger, y se escribe la proyección
 *               (`IntakeWatchStore`). La observación de un slot es ATÓMICA: si cualquiera de las dos
 *               lecturas falla, se registra el ERROR y lo último conocido queda intacto. Fallar en
 *               medir es un ESTADO, no un vacío.
 *  2 RESOLVER — (#162) por cada carga registrada SIN desenlace: se correlaciona con las corridas
 *               (`resolveRunLog`) y con lo que el job declaró por archivo en su log
 *               (`parseRunFileOutcomes`), se PERSISTE el desenlace (una vez, no se recalcula) y se
 *               avisa a quien subió (`composeCargaUserNotice`) por el flujo `'cargas-usuario'`. Solo
 *               se resuelve sobre observación FRESCA: resolver sobre la proyección sería declarar un
 *               desenlace con datos que este tick no pudo confirmar.
 *  3 ALERTAR  — dedup por transición, calcado del precedente verificado de `freshness-loop.ts`:
 *               hidratación del estado en el PRIMER TICK (no en el boot), persistencia SOLO en
 *               transición, parser fail-safe (`parseIntakeWatchState`). El aviso se COMPONE
 *               (`composeIntakeAlert`, #100) y sale por el puerto: el lazo NO conoce el canal. El slot
 *               que declara `watch: false` sale del estado SIN aviso de recuperación
 *               (`retirarOptOut`): no sanó — lo callaron, y decir lo contrario entrena a desconfiar
 *               de los «recuperado» verdaderos.
 *
 * La regla que este lazo existe para sostener: **un vigilante que confunde «no hay» con «no veo» es
 * peor que ninguno**. Por eso `'sin-medida'` sale por el MISMO canal que las demás alertas —no es un
 * log— y por eso una lectura fallida clasifica sobre lo último conocido y jamás sobre `[]`.
 *
 * El render (consola de Cargas, tile del dashboard) lee SOLO la proyección: el request path jamás
 * lista OneLake.
 */
import {
  DEFAULT_INTAKE_WATCH_MS,
  DEFAULT_MAX_AGE_MINUTES,
  DEFAULT_MAX_RUN_MINUTES,
  INTAKE_WATCH_STATE_KEY,
  classifySlot,
  expectedInLanding,
  intakeAlerts,
  isSidecarName,
  parseIntakeWatchState,
  parseRunFileOutcomes,
  resolveRunLog,
  contarCorridasSinLog,
  slotRunLogsDir,
  diffAlertState,
  type CargaDesenlace,
  type DesenlaceParams,
  type IntakeDesenlaceStore,
  type GuiaDecl,
  resolverGuia,
  type IntakeSlot,
  type IntakeUploadRow,
  type IntakeWatchStore,
  type OneLakeEntry,
  type OneLakeListing,
  type PlatformSettingStore,
  type RetiroRegistrado,
  type RunRecord,
  type SlotAlert,
  type SlotAlertReason,
  type SlotObservation,
  type SlotProjection,
  type SlotWatchConfig,
  type SlotWatchInput,
  type SlotWatchSnapshot,
  type CargaRegistrada,
  type IntakeUploadStore,
  INTAKE_WATCH_RUN_RETENTION,
} from '@vergis/capabilities'
// #269 · capacidades nuevas de este corte, importadas de su módulo (mismo patrón que `version`/
// `table-runtime`): el barril `@vergis/capabilities` no es parte del territorio de este cambio.
import { declaracionDeArchivo } from '../packages/capabilities/src/run-logs'
import { nombresAmbiguos } from '../packages/capabilities/src/intake'
import { nombreSinSello, selloDelNombre } from '../packages/capabilities/src/intake-observability'
import type { CargaEstadoInput, IntakeIntentoInput } from '../packages/capabilities/src/governance-store'
import { diagnosticoDeFalla, type SlotVigilancia } from './admin-cargas'
import { composeCargaOperadorNotice, composeCargaUserNotice, composeIntakeAlert, composeIntakeRecovery, type CargaOperadorContext, type IntakeAlertContext, type Notification } from './notify'

export interface IntakeLoopConfig {
  /** URL pública ya normalizada sin slash final: base de los enlaces profundos del aviso. */
  publicUrl: string
  /** Cadencia del lazo (ms). Es el insumo del umbral de `sin-medida` (3 × poll), no un timer: el
   *  timer lo instala el wiring. */
  pollMs?: number
}

export interface IntakeLoopDeps {
  /** Slots declarados. Función porque el arreglo es VIVO (hot-reload, #50): un slot agregado en
   *  caliente tiene que entrar a la vigilancia sin reconstruir el lazo. */
  slots: () => IntakeSlot[]
  /** Listado del landing del slot, DISTINGUIENDO la ausencia del directorio (`listOrAbsent`). */
  landing: (slot: IntakeSlot) => Promise<OneLakeListing>
  /** Corridas del trigger del slot. AUSENTE = no hay motor cableado: la parte de corridas se omite y
   *  la del landing vigila igual — el listado no necesita motor. */
  runs?: (slot: IntakeSlot) => Promise<RunRecord[]>
  /** Cargas registradas del slot (#62) — insumo del control positivo contra el vacío-con-éxito. */
  uploads?: (slotId: string) => Promise<CargaRegistrada[]>
  /** Retiros manuales del landing. `null` = NO SE PUDO SABER; entonces el control positivo se apaga
   *  para ese slot (una predicción que no descuenta los retiros fabrica contradicciones). */
  retiros?: (slot: IntakeSlot) => Promise<RetiroRegistrado[] | null>
  /** #269·§3.4 · las reversiones registradas del slot (#63): la que retiró el landing cierra SU carga. */
  reverts?: (slotId: string) => Promise<{ filename: string; at: string; landingRetirado: boolean; uploadId?: number }[]>
  /** #269·§3.1 · lo ARCHIVADO del slot (`slotProcessedDir`), recursivo: insumo del puente histórico.
   *  Solo se pide si alguna carga pendiente es anterior a `contrato_desde`. */
  archivados?: (slot: IntakeSlot) => Promise<OneLakeEntry[]>
  store: IntakeWatchStore & PlatformSettingStore & IntakeDesenlaceStore & Pick<IntakeUploadStore, 'listUploads'>
  /**
   * Logs POR CORRIDA del slot (contrato `_logs/`, #99). AUSENTE = el resolver no puede leer lo que el
   * job declaró, y entonces NO concluye nada que dependa del log: un instrumento que no está no
   * produce «no hay motivo», produce «no medí» — y `'sin-informe'` es una afirmación sobre el JOB, no
   * sobre la instrumentación de la plataforma.
   */
  runLogs?: {
    /** Entradas del directorio de logs del slot. Lanza si el almacenamiento no responde. */
    list: (slot: IntakeSlot) => Promise<OneLakeEntry[]>
    /** Contenido del log (cola), null si el archivo no existe. */
    read: (slot: IntakeSlot, path: string) => Promise<string | null>
  }
  /** Envío del aviso compuesto (#100) — el canal lo decide la config de instancia, no el lazo.
   *  undefined = fase 3 apagada: ni computa ni persiste estado (la proyección se escribe igual). */
  notify?: (n: Notification) => Promise<void>
  /** Envío del aviso a QUIEN SUBIÓ (flujo `'cargas-usuario'`, §6.3). undefined = sin destinos
   *  suscritos: el desenlace se persiste y se consulta igual — el registro no depende del canal. */
  notifyUploader?: (n: Notification) => Promise<void>
  /** #269·V12 · aviso al OPERADOR por carga (flujo `'cargas-operador'`). Ausente = sin ese flujo. */
  notifyOperador?: (n: Notification) => Promise<void>
  /** #269·V12 · ¿hay HOY algún destino suscrito a `'cargas-operador'`? Decide si el aviso al usuario
   *  puede decir «le avisamos al equipo»: la frase sale solo si es cierta. Arreglo vivo: se consulta. */
  hayDestinoOperador?: () => boolean
  /** #346 · catálogo vivo de guías de carga. Ausente = el aviso a quien subió es el de siempre. */
  guias?: () => readonly GuiaDecl[]
  /** Dominios DECLARADOS: solo ellos tienen página, y por tanto solo ellos aportan label y enlace. */
  domains: { id: string; label: string }[]
  log: (line: string) => void
  now?: () => number
}

export interface IntakeLoop {
  /** Una vuelta. Re-entrada mientras hay una en vuelo = no-op (guard anti-solape). Nunca lanza. */
  tick(): Promise<void>
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createIntakeLoop(deps: IntakeLoopDeps, cfg: IntakeLoopConfig): IntakeLoop {
  const now = deps.now ?? Date.now
  const pollMs = cfg.pollMs ?? DEFAULT_INTAKE_WATCH_MS
  // El estado de alertas SOBREVIVE al reinicio: vive en el store de gobierno, no en RAM (sin eso,
  // cada restart re-notifica todo lo que siga roto). Se hidrata en el PRIMER TICK, no en el arranque:
  // el lazo no debe demorar el boot ni romperlo si el store todavía no responde.
  let alertState: Record<string, SlotAlertReason> = {}
  let hydrated = false
  // GUARD ANTI-SOLAPE. Además de evitar listados duplicados, es el invariante en el que se apoya el
  // store del desenlace (#162): `setUploadDesenlace` lee-y-escribe sin transacción porque el único
  // escritor es el resolver de ESTE lazo, y este guard garantiza que no hay dos resolviendo a la vez.
  let inFlight = false

  const tick = async (): Promise<void> => {
    if (inFlight) {
      deps.log('intake-loop: tick saltado (vuelta anterior en vuelo)')
      return
    }
    inFlight = true
    try {
      const nowMs = now()
      const nowIso = new Date(nowMs).toISOString()
      const slots = deps.slots()
      const vigilados = slots.filter((s) => watchConfigDe(s) != null)
      // ANTES del corte por «cero vigilados»: el opt-out del ÚLTIMO slot vigilado es justamente el
      // caso que dejaría su clave huérfana en el estado persistido, para emitir el «recuperado» falso
      // más tarde, cuando algún slot vuelva a vigilarse.
      await retirarOptOut(slots)
      if (!vigilados.length) {
        await medirDisjuncion(slots, nowIso)
        return
      }

      // ── Fase 1 · observar ────────────────────────────────────────────────────────────────────
      const lote: SlotObservation[] = await Promise.all(vigilados.map((s) => observar(s)))
      // Medida del contrato `_logs/` (#162·§5) ANTES del persist: así el conteo viaja en el MISMO
      // lote que el resto del snapshot y la consola nunca ve una proyección a medio actualizar.
      // El listado que esto paga se cachea por tick y lo reusa la fase RESOLVER (abajo): sin la
      // caché, un slot con cargas pendientes listaría `_logs/` dos veces por vuelta.
      const logsDelTick = new Map<string, OneLakeEntry[]>()
      for (const slot of vigilados) {
        const obs = lote.find((o) => o.slotId === slot.id)
        if (obs) await medirContratoLogs(slot, obs, logsDelTick)
      }
      await deps.store.recordSlotObservations(lote)
      const fallidas = lote.filter((o) => o.error != null)
      for (const o of fallidas) deps.log(`intake-loop: no se pudo observar '${o.slotId}' — ${o.error}`)

      // ── Fase 2 · resolver el desenlace de cada carga (#162) ──────────────────────────────────
      // DENTRO del mismo tick y bajo el mismo guard: `setUploadDesenlace` lee-y-escribe sin
      // transacción apoyada en que el único escritor de esas columnas es este resolver, serializado
      // acá. Sacarlo del tick (o paralelizarlo) rompe ese supuesto y obliga a arreglar el store.
      for (const slot of vigilados) {
        const obs = lote.find((o) => o.slotId === slot.id)
        if (obs) await resolverSlot(slot, obs, nowMs, logsDelTick)
      }

      // #269·§4.1 · la señal de disjunción (solo cuando cambiaron los patrones): después de observar y
      // resolver, para no demorar la medida del tick.
      await medirDisjuncion(slots, nowIso)

      // ── Fase 3 · alertar ─────────────────────────────────────────────────────────────────────
      let notificadas = 0
      if (deps.notify) {
        if (!hydrated) {
          alertState = parseIntakeWatchState(await deps.store.getSetting(INTAKE_WATCH_STATE_KEY))
          hydrated = true
        }
        // La proyección se lee DESPUÉS de escribir el lote: así `firstAttemptAt` ya está sembrado para
        // un slot ciego desde el primer tick (sin baseline, `sin-medida` no cruzaría el umbral jamás).
        const proyeccion = new Map<string, SlotProjection>()
        if (fallidas.length) {
          for (const s of await deps.store.listSlotSnapshots()) {
            const p: SlotProjection = { landing: s.landing, runs: s.runs }
            if (s.observedAt != null) p.observedAt = s.observedAt
            if (s.firstAttemptAt != null) p.firstAttemptAt = s.firstAttemptAt
            proyeccion.set(s.slotId, p)
          }
        }
        const entradas = await Promise.all(
          lote.map(async (obs) => {
            const slot = vigilados.find((s) => s.id === obs.slotId)!
            const input: SlotWatchInput = { slotId: obs.slotId, obs }
            const proj = proyeccion.get(obs.slotId)
            if (proj) input.projection = proj
            const { expected, registro } = await insumosDelRegistro(slot, obs)
            if (expected.length) input.expected = expected
            if (registro) input.registro = registro
            return { input, config: watchConfigDe(slot)! }
          }),
        )
        const { notify, recovered, next } = diffAlertState(alertState, intakeAlerts(entradas, nowMs), (a: SlotAlert) => a.slotId)
        const cambio = JSON.stringify(next) !== JSON.stringify(alertState)
        alertState = next
        // Se escribe SOLO en transición: el estado casi nunca cambia y persistir cada vuelta sería
        // escritura pura sin información.
        if (cambio) await deps.store.setSetting(INTAKE_WATCH_STATE_KEY, JSON.stringify(next), 'intake-watch')
        for (const a of notify) await deps.notify(composeIntakeAlert({ ...contextoDe(a.slotId), ...evidencia(a) }))
        for (const sid of recovered) await deps.notify(composeIntakeRecovery(contextoDe(sid)))
        notificadas = notify.length + recovered.length
      }

      // El caso sano no loguea por vuelta: el log del lazo es señal, no latido.
      if (fallidas.length || notificadas)
        deps.log(`intake-loop: ${vigilados.length} slot(s) vigilado(s) · ${fallidas.length} sin medida · ${notificadas} alerta(s)`)
    } catch (e) {
      // El timer no debe morir por una vuelta mala.
      deps.log(`intake-loop: vuelta fallida — ${msg(e)}`)
    } finally {
      inFlight = false
    }
  }

  /**
   * #269·§4.1 · La SEÑAL de disjunción posterior a cada recarga: cuántos nombres del registro calzan
   * con dos o más tipos. La garantía vive en la puerta (el nombre ambiguo no aterriza); esto le dice al
   * operador que la configuración recién cargada tiene patrones que se pisan sobre nombres reales.
   * Se mide solo cuando cambian los patrones (su firma), no en cada vuelta.
   */
  let firmaDisjuncion: string | null = null
  async function medirDisjuncion(slots: IntakeSlot[], nowIso: string): Promise<void> {
    const firma = JSON.stringify(slots.map((s) => [s.id, s.accept ?? null]))
    if (firma === firmaDisjuncion) return
    try {
      const nombres: string[] = []
      for (const s of slots) for (const u of await deps.store.listUploads(s.id, RESOLVER_HISTORIA)) if (u.ok && u.origen === 'upload') nombres.push(u.filename)
      const ambiguos = nombresAmbiguos(slots, nombres)
      await deps.store.setSetting(INTAKE_DISJUNCION_KEY, JSON.stringify({ medidoAt: nowIso, nombres: new Set(nombres).size, ambiguos }), 'intake-watch')
      if (ambiguos.length)
        deps.log(`intake-loop: ${ambiguos.length} nombre(s) del registro calzan con 2+ tipos: ${ambiguos.slice(0, 5).map((a) => `«${a.nombre}» (${a.slots.join(', ')})`).join('; ')}${ambiguos.length > 5 ? '; …' : ''}`)
      firmaDisjuncion = firma
    } catch (e) {
      deps.log(`intake-loop: no se pudo medir la disjunción de los tipos de archivo — ${msg(e)}`)
    }
  }

  /** Observación ATÓMICA de un slot: o trae landing (+ corridas si hay motor), o trae error. */
  async function observar(slot: IntakeSlot): Promise<SlotObservation> {
    const observedAt = new Date(now()).toISOString()
    try {
      const [listing, runs] = await Promise.all([
        deps.landing(slot),
        slot.trigger && deps.runs ? deps.runs(slot) : Promise.resolve(undefined),
      ])
      // `absent` (el directorio del landing NO existe) se observa como listado VACÍO, no como error:
      // no hubo fallo de lectura. Pero se MARCA (`landingAbsent`), porque «no existe» y «existe
      // vacío» no son el mismo hecho: con cargas vividas registradas, el 404 contradice lo que la
      // plataforma escribió ella misma, y ese control no necesita corridas (diseño 009·§4.2).
      const obs: SlotObservation = { slotId: slot.id, observedAt, landing: listing.kind === 'ok' ? listing.entries : [] }
      if (listing.kind === 'absent') obs.landingAbsent = true
      if (runs) obs.runs = runs
      return obs
    } catch (e) {
      return { slotId: slot.id, observedAt, error: msg(e) }
    }
  }

  /**
   * Medida del cumplimiento del contrato `_logs/` de UN slot (#162·§5, diseño 009·§2.3.b): cuántas
   * corridas terminadas consecutivas no dejaron log correlacionable.
   *
   * Se mide ACÁ y no en la fase RESOLVER porque el resolver solo lista `_logs/` cuando hay cargas sin
   * desenlace (`if (!pendientes.length) return`), y el slot incumplidor llega rápido al estado sin
   * pendientes —sus cargas caen a `sin-informe` y dejan de estarlo—: un conteo colgado de ahí se
   * congelaría justo en el slot que el aviso existe para delatar. (Verificado en el código, no
   * supuesto: es la hipótesis que el diseño 009·§2.2 desmintió.)
   *
   * Escribe `obs.corridasSinLog` con las tres semánticas de `SlotObservation`: número medido, `null`
   * cuando el conteo NO APLICA (el slot no tiene corridas que medir, o declaró `log: false`, o el
   * motor / `_logs/` no están cableados) y ausente cuando no se pudo medir. El listado leído se deja
   * en `cache` para que el RESOLVER del mismo tick no lo vuelva a pedir.
   */
  async function medirContratoLogs(slot: IntakeSlot, obs: SlotObservation, cache: Map<string, OneLakeEntry[]>): Promise<void> {
    if (obs.error != null) return // no se midió el slot: el conteo previo sigue siendo lo último conocido
    if (!deps.runLogs || obs.runs == null || slotRunLogsDir(slot) == null) {
      obs.corridasSinLog = null
      return
    }
    try {
      const entries = await deps.runLogs.list(slot)
      cache.set(slot.id, entries)
      obs.corridasSinLog = contarCorridasSinLog(obs.runs, entries)
    } catch (e) {
      // No medir NO es medir cero: el campo queda ausente y lo persistido no se toca.
      deps.log(`intake-loop: no se pudo medir el contrato _logs/ de '${slot.id}' — ${msg(e)}`)
    }
  }

  /**
   * Los DOS insumos que el registro de cargas (#62) le da al control positivo, en UNA sola lectura
   * por slot y por tick.
   *
   * `expected` — control POR-ARCHIVO (§3.3): qué archivos debería traer el listado. Solo se computa
   * cuando este tick leyó las corridas del slot (`obs.runs` presente), porque sin ellas no hay CORTE
   * —la última corrida `Completed`, que archivó a `_processed/` lo procesado— y toda carga histórica
   * seguiría «esperándose» para siempre: el primer drenaje legítimo produciría una contradicción
   * falsa. Es la DECISIÓN DE DISEÑO del frente (009·§4.1), no una restricción de la implementación:
   * se evaluaron tres cortes alternativos para land-only —visto-una-vez, ritmo declarado
   * (`max_age_minutes`), evento de consumo— y los tres fabrican alertas falsas o exigen un contrato
   * nuevo con un actor externo. En land-only el drenaje está en manos de un actor invisible para la
   * plataforma: sin evento observable de consumo no hay predicción defendible sobre la PRESENCIA de
   * archivos.
   *
   * `registro` — control del DIRECTORIO (009·§4.2): cuántas cargas ok vivió el slot y cuándo fue la
   * última. Este SÍ se computa para todo slot con observación fresca, con corridas o sin ellas: no
   * predice qué archivos hay (nadie puede), solo que la plataforma escribió en ese directorio — y un
   * consumidor consume archivos, no directorios.
   *
   * CONJETURA C8, acotada desde el código y no saldada: `deps.uploads` trae un TOPE de filas (el
   * wiring de instancia pide 200, `serve-rls.ts:1366`) sobre `listUploads`, que ordena
   * `uploaded_at DESC, id DESC` (verificado, `governance-store.ts:1514–1518`). O sea: el predicado
   * `cargasVividas ≥ 1` solo se equivoca si las 200 filas MÁS RECIENTES del slot fueran todas
   * rechazadas o `retro`, con cargas ok más viejas fuera del tope. El modo de falla es un FALSO
   * NEGATIVO —el control calla— y nunca una alerta falsa. Medirlo exige datos de instancia, no de
   * este repo: queda como gate de despliegue.
   */
  async function insumosDelRegistro(slot: IntakeSlot, obs: SlotObservation): Promise<InsumosRegistro> {
    if (obs.error != null || !deps.uploads) return { expected: [] }
    try {
      const cargas = await deps.uploads(slot.id)
      // `ok = false` es una subida RECHAZADA: nunca aterrizó, así que no prueba escritura alguna en
      // el directorio. (El wiring de instancia ya filtra `origen === 'upload' && ok`; se vuelve a
      // filtrar acá porque el contrato de `deps.uploads` es el tipo, no ese wiring.)
      const vividas = cargas.filter((c) => c?.ok)
      const out: InsumosRegistro = { expected: [] }
      if (vividas.length) {
        const registro: { cargasVividas: number; ultimaCargaAt?: string } = { cargasVividas: vividas.length }
        const ultima = vividas
          .filter((c) => Number.isFinite(Date.parse(c.uploadedAt)))
          .reduce<CargaRegistrada | null>((max, c) => (max == null || Date.parse(c.uploadedAt) > Date.parse(max.uploadedAt) ? c : max), null)
        // La fecha se copia TAL CUAL vino del registro; sin fecha parseable el campo queda ausente
        // (la contradicción se sostiene igual: la evidencia es la carga, no su reloj).
        if (ultima) registro.ultimaCargaAt = ultima.uploadedAt
        out.registro = registro
      }
      if (obs.runs == null || !cargas.length) return out
      // `null` = no se pudo saber qué se retiró. Sin ese descuento la predicción incluiría archivos
      // que un humano sacó a propósito: apagar el control POR-ARCHIVO es preferible a acusar una
      // contradicción que no existe. No apaga el del directorio: retirar un archivo del landing es
      // un `remove` de ESE path (verificado, `intake-onelake.ts:206` — DELETE sobre el archivo), que
      // no borra el directorio.
      const retiros = deps.retiros ? await deps.retiros(slot) : []
      if (retiros == null) return out
      out.expected = expectedInLanding(cargas, obs.runs, retiros)
      return out
    } catch (e) {
      deps.log(`intake-loop: control positivo de '${slot.id}' no disponible — ${msg(e)}`)
      return { expected: [] }
    }
  }

  /**
   * Fase RESOLVER de UN slot (#162·§3.4, reescrita por #269·§3): avanza el estado de las cargas que
   * todavía no llegaron a un estado final y avisa a quien las subió.
   *
   * El estado es SOLO lo que el ingestor declaró de cada archivo más los actos registrados (re-subida,
   * retiro, reversión): `resolverEstadoDeCarga`, pura. Esta fase junta sus insumos —las corridas de la
   * proyección (hasta 60, no solo las 10 que trae el tick), sus logs, el landing, los retiros, las
   * re-subidas y, solo si alguna carga lo necesita, lo archivado para el puente histórico— y escribe.
   *
   * Nunca lanza hacia afuera: un insumo que no se pudo leer deja las cargas como estaban —que es la
   * verdad: no se midió— y no arrastra a los demás slots. En particular, sin retiros legibles no se
   * resuelve nada del slot: un retiro que no se ve se leería como «salió sin declaración».
   */
  async function resolverSlot(slot: IntakeSlot, obs: SlotObservation, _nowMs: number, cache: Map<string, OneLakeEntry[]>): Promise<void> {
    if (obs.error != null || obs.landing == null) return
    try {
      const pendientes = await deps.store.listUploadsNoFinales(slot.id, RESOLVER_LOTE)
      if (!pendientes.length) return // el caso normal: cero I/O de logs cuando no hay nada que resolver
      const retiros = await retirosDelSlot(slot)
      if (retiros == null) {
        deps.log(`intake-loop: '${slot.id}' sin retiros legibles — el estado de sus cargas no se evalúa en esta vuelta`)
        return
      }
      const todas = await deps.store.listUploads(slot.id, RESOLVER_HISTORIA)
      const runs = await corridasDelSlot(slot, obs)
      // Solo se leen los logs que alguna carga pendiente todavía no consideró (cursor `evaluadoHasta`):
      // en régimen, una vuelta lee los logs de las corridas NUEVAS, no los 60 retenidos.
      const corridas = await corridasConLog(slot, runs.filter((r) => pendientes.some((c) => leInteresa(c, r))), cache.get(slot.id))
      const contratoDesde = slot.contratoDesde
      // El puente histórico solo puede aplicar a cargas subidas antes de `contrato_desde`: sin ninguna
      // así, lo archivado no se lista (es la lectura más cara de la vuelta).
      const necesitaPuente = contratoDesde != null && pendientes.some((c) => Date.parse(c.uploadedAt) < Date.parse(contratoDesde))
      let archivados: OneLakeEntry[] | null = []
      if (necesitaPuente && deps.archivados) {
        try {
          archivados = await deps.archivados(slot)
        } catch (e) {
          archivados = null
          deps.log(`intake-loop: no se pudo listar lo archivado de '${slot.id}' — ${msg(e)}; las cargas anteriores a contrato_desde no se evalúan en esta vuelta`)
        }
      } else if (necesitaPuente) archivados = null
      for (const carga of pendientes) {
        const preContrato = contratoDesde != null && Date.parse(carga.uploadedAt) < Date.parse(contratoDesde)
        if (preContrato && archivados == null) continue // no pude medir el puente: no se concluye nada
        const legado = carga.desenlace != null && carga.desenlaceFinal === undefined
        const opts: OpcionesResolver = {}
        if (contratoDesde != null) opts.contratoDesde = contratoDesde
        if (!legado && carga.desenlace != null) {
          const previo: EstadoPrevio = { estado: carga.desenlace }
          if (carga.desenlaceMotivo != null) previo.motivo = carga.desenlaceMotivo
          if (carga.desenlaceCodigo != null) previo.codigo = carga.desenlaceCodigo
          if (carga.desenlaceParams != null) previo.params = carga.desenlaceParams
          if (carga.desenlaceRunStartedAt != null) previo.runStartedAt = carga.desenlaceRunStartedAt
          opts.previo = previo
        }
        if (!legado && carga.evaluadoHasta != null) opts.evaluadoHasta = carga.evaluadoHasta
        const reemplazos = todas
          .filter((o) => o.id !== carga.id && o.ok && o.origen === 'upload' && base(o.filename) === base(carga.filename))
          .map((o) => ({ uploadedAt: o.uploadedAt }))
        opts.nowMs = now()
        const maxRun = watchConfigDe(slot)?.maxRunMinutes
        if (maxRun != null) opts.maxEnCursoMs = maxRun * 60_000
        const r = resolverEstadoDeCarga(carga, corridas, obs.landing, archivados ?? [], retiros, reemplazos, opts)
        const actual = carga.desenlace ?? null
        const intentos = r.intentos.map((i) => {
          const x: IntakeIntentoInput = { runStartedAt: i.runStartedAt, resultado: i.resultado }
          if (i.motivo != null) x.motivo = i.motivo
          if (i.codigo != null) x.codigo = i.codigo
          if (i.params != null) x.params = i.params
          return x
        })
        // Sin cambio de estado (y sin valor legado que confirmar): solo el cursor y lo observado.
        if (r.estado === actual && !legado) {
          if (r.evaluadoHasta !== carga.evaluadoHasta || intentos.length) await deps.store.registrarEvaluacion(carga.id, r.evaluadoHasta, intentos)
          continue
        }
        // Una corrida en curso (o nada nuevo) sobre un valor legado: no se confirma ni se cambia todavía.
        if (r.enCurso && r.estado == null) continue
        const input: CargaEstadoInput = { estado: r.estado, final: r.final, intentos }
        if (r.motivo != null) input.motivo = r.motivo
        if (r.codigo != null) input.codigo = r.codigo
        if (r.params != null) input.params = r.params
        if (r.runStartedAt != null) input.runStartedAt = r.runStartedAt
        if (r.evaluadoHasta != null) input.evaluadoHasta = r.evaluadoHasta
        if (r.actoAt != null) input.actoAt = r.actoAt
        await deps.store.avanzarEstado(carga.id, input)
        deps.log(`intake-loop: '${slot.id}' carga ${carga.id} (${carga.filename}) ${actual ?? '—'} → ${r.estado ?? '—'} (${r.via}${legado ? ', reevaluada' : ''})`)
        // Un valor que escribió la versión anterior se reevalúa en silencio: avisar ahora sería mandar
        // correos por cargas de hace semanas, y lo que cambia es la verdad del registro, no un evento.
        if (legado || r.estado == null || r.estado === actual) continue
        await avisarUploader(slot, carga, r)
        await avisarOperador(slot, carga, r)
      }
    } catch (e) {
      deps.log(`intake-loop: no se pudo resolver el estado de las cargas en '${slot.id}' — ${msg(e)}`)
    }
  }

  /** Retiros del slot (#269·§3.4): `_retirado/` en sus tres formas + las reversiones que retiraron el
   *  landing. `null` = no se pudo saber. */
  async function retirosDelSlot(slot: IntakeSlot): Promise<RetiroDeCarga[] | null> {
    const out: RetiroDeCarga[] = []
    if (deps.retiros) {
      try {
        const rs = await deps.retiros(slot)
        if (rs == null) return null
        for (const r of rs) out.push({ filename: r.filename, at: r.at, via: r.via ?? 'retirar', ...(r.uploadId != null ? { uploadId: r.uploadId } : {}) })
      } catch (e) {
        deps.log(`intake-loop: no se pudieron leer los retiros de '${slot.id}' — ${msg(e)}`)
        return null
      }
    }
    if (deps.reverts) {
      try {
        for (const r of await deps.reverts(slot.id)) {
          if (!r.landingRetirado) continue
          const x: RetiroDeCarga = { filename: r.filename, at: r.at, via: 'revertir' }
          if (r.uploadId != null) x.uploadId = r.uploadId
          out.push(x)
        }
      } catch (e) {
        deps.log(`intake-loop: no se pudieron leer las reversiones de '${slot.id}' — ${msg(e)}`)
        return null
      }
    }
    return out
  }

  /** Las corridas del slot para el resolvedor: la PROYECCIÓN (el lazo retiene hasta 60 por slot) unida
   *  a las que trajo este tick. El tick trae solo las 10 más recientes: una carga cuya corrida quedó
   *  más atrás se quedaría sin su declaración. */
  async function corridasDelSlot(slot: IntakeSlot, obs: SlotObservation): Promise<RunRecord[]> {
    const porInicio = new Map<string, RunRecord>()
    try {
      const snap = (await deps.store.listSlotSnapshots({ runsPerSlot: INTAKE_WATCH_RUN_RETENTION })).find((x) => x.slotId === slot.id)
      for (const r of snap?.runs ?? []) porInicio.set(r.startedAt, r)
    } catch (e) {
      deps.log(`intake-loop: no se pudo leer la proyección de corridas de '${slot.id}' — ${msg(e)}`)
    }
    for (const r of obs.runs ?? []) if (r?.startedAt) porInicio.set(r.startedAt, r) // lo fresco manda
    return [...porInicio.values()]
  }

  /** Aviso al OPERADOR (#269·V12, flujo `cargas-operador`): una notificación por carga que quedó
   *  «sin informe» o con una guía cuyo actor es el operador. Dedup por carga, persistido. */
  async function avisarOperador(slot: IntakeSlot, carga: IntakeUploadRow, r: EstadoResuelto): Promise<void> {
    if (!deps.notifyOperador || carga.operadorAvisadoAt != null) return
    const guia = r.codigo != null && deps.guias ? resolverGuia(slot, r.codigo, r.params, deps.guias(), carga.filename) : null
    if (r.estado !== 'sin-informe' && guia?.actor !== 'operador') return
    const ctx: CargaOperadorContext = {
      filename: carga.filename,
      estado: r.estado as CargaDesenlace,
      uploadedAt: carga.uploadedAt,
      uploadId: carga.id,
      via: r.via,
      ...contextoDe(slot.id),
    }
    if (carga.uploadedBy) ctx.uploadedBy = carga.uploadedBy
    if (r.motivo != null) ctx.motivo = r.motivo
    if (guia) ctx.guia = guia
    await deps.notifyOperador(composeCargaOperadorNotice(ctx))
    await deps.store.marcarOperadorAvisado(carga.id)
  }

  /** Las corridas con la resolución de SU log (#99) y su texto. Sin la dependencia de logs el kind es
   *  `'no-medido'`: la ausencia del instrumento no se reporta como ausencia de log. */
  async function corridasConLog(slot: IntakeSlot, runs: RunRecord[], preListadas?: OneLakeEntry[]): Promise<CorridaConLog[]> {
    if (!deps.runLogs || !runs.length) return runs.map((run) => ({ run, log: 'no-medido' as const, texto: null }))
    // `preListadas`: el listado que la medida del contrato `_logs/` ya pagó en ESTE tick. Es el mismo
    // directorio y el mismo instante — reusarlo evita el segundo listado, no cambia lo que se lee.
    const entries = preListadas ?? (await deps.runLogs.list(slot)) // si lanza, el slot queda sin resolver (arriba)
    const out: CorridaConLog[] = []
    for (const run of runs) {
      const res = resolveRunLog(run, entries)
      if (res.kind !== 'match') {
        out.push({ run, log: res.kind, texto: null })
        continue
      }
      // Un log ilegible NO es un log ausente: se marca no-medido y sus cargas quedan pendientes.
      try {
        const texto = await deps.runLogs.read(slot, res.entry.path)
        out.push(texto == null ? { run, log: 'no-medido', texto: null } : { run, log: 'match', texto })
      } catch (e) {
        deps.log(`intake-loop: no se pudo leer el log de la corrida ${run.startedAt} de '${slot.id}' — ${msg(e)}`)
        out.push({ run, log: 'no-medido', texto: null })
      }
    }
    return out
  }

  /** Aviso a quien subió (§6.2). Solo al ENTRAR a `fallida` o `sin-informe` (anti-ruido del diseño):
   *  `procesada` y `saltada` no notifican, y un estado que se repite no vuelve a avisar. */
  async function avisarUploader(slot: IntakeSlot, carga: IntakeUploadRow, r: EstadoResuelto): Promise<void> {
    if (!deps.notifyUploader || r.estado == null || !DESENLACES_QUE_AVISAN.includes(r.estado)) return
    const quien = (carga.uploadedBy ?? '').trim()
    // Sin dirección válida no se envía y se DICE: el desenlace ya quedó persistido y consultable en la
    // consola, así que la información no se pierde — solo no sale por correo.
    if (!quien.includes('@')) {
      deps.log(`intake-loop: carga ${carga.id} de '${slot.id}' resuelta '${r.estado}' sin aviso — uploadedBy '${quien}' no es una dirección`)
      return
    }
    const ctx: Parameters<typeof composeCargaUserNotice>[0] = {
      filename: carga.filename,
      desenlace: r.estado as Exclude<CargaDesenlace, 'procesada'>,
      uploadedBy: quien,
      uploadedAt: carga.uploadedAt,
      uploadId: carga.id,
      ...contextoDe(slot.id),
    }
    if (r.motivo != null) ctx.motivo = r.motivo
    if (r.titular != null) ctx.titular = r.titular
    // #346 · con código declarado por el job y catálogo cableado, el aviso usa la guía resuelta (el
    // actor sale de la familia). Sin guía resoluble, el aviso es el de siempre con el motivo textual.
    if (r.codigo != null) {
      ctx.codigo = r.codigo
      const guia = deps.guias ? resolverGuia(slot, r.codigo, r.params, deps.guias(), carga.filename) : null
      if (guia) ctx.guia = guia
    }
    // #269·V12 · la línea de aviso dice la verdad: «le avisamos al equipo» solo con un destino suscrito
    // al flujo del operador; si no, a quién avisar (`contacto`); sin ninguno de los dos, nada.
    if (deps.notifyOperador && deps.hayDestinoOperador?.()) ctx.equipoAvisado = true
    else if (slot.contacto) ctx.contacto = slot.contacto
    await deps.notifyUploader(composeCargaUserNotice(ctx))
  }

  /** La evidencia del aviso, tal cual la trae la clasificación (sin re-computar nada). */
  function evidencia(a: SlotAlert): Evidencia {
    const out: Evidencia = { reason: a.reason, medida: a.medida }
    if (a.varados) out.varados = a.varados
    if (a.esperados) out.esperados = a.esperados
    if (a.landingAusente) out.landingAusente = true
    if (a.ultimaCargaAt != null) out.ultimaCargaAt = a.ultimaCargaAt
    if (a.run) out.run = a.run
    if (a.lastError != null) out.lastError = a.lastError
    return out
  }

  /** Contexto humano + enlazable del slot. Un slot que desapareció de la config (se recupera por
   *  ausencia) todavía tiene que poder avisarse: cae al id. */
  function contextoDe(slotId: string): { slotId: string; slotLabel: string; domainId?: string; domainLabel?: string; baseUrl: string } {
    const slot = deps.slots().find((s) => s.id === slotId)
    // Enlace SOLO con dominio DECLARADO: un slot tageado a un dominio que no está en `domains.yaml`
    // no tiene página, y un enlace a una ruta inexistente sería peor que no traer enlace.
    const decl = slot?.domain ? deps.domains.find((d) => d.id === slot.domain) : undefined
    const ctx: { slotId: string; slotLabel: string; domainId?: string; domainLabel?: string; baseUrl: string } = {
      slotId,
      slotLabel: slot?.label ?? slotId,
      baseUrl: cfg.publicUrl,
    }
    if (decl) {
      ctx.domainId = decl.id
      ctx.domainLabel = decl.label
    }
    return ctx
  }

  /**
   * Retiro SILENCIOSO del estado de alertas de los slots que declararon `watch: false` (diseño
   * 009·§3.3), antes de cualquier diff de este tick.
   *
   * Sin esto el opt-out se leería como sanación: el slot sale de `vigilados`, deja de producir
   * alertas, y `diffAlertState` —que decide la recuperación por AUSENCIA de la clave en el conjunto
   * nuevo— emitiría `composeIntakeRecovery` por un problema que nadie resolvió. Un «recuperado» falso
   * enseña a desconfiar de los verdaderos, que es exactamente lo que este frente combate.
   *
   * El slot AUSENTE de la config conserva la recuperación por ausencia (conducta vigente): acá solo
   * se retiran los slots que están declarados Y declararon `watch: false`. La distinción es
   * deliberada — quien borra el slot no dijo nada sobre su vigilancia; quien escribe `watch: false`
   * sí, y dijo «no me vigiles», no «ya está sano».
   *
   * Se persiste solo si algo cambió, con el mismo criterio de transición del resto de la fase.
   */
  async function retirarOptOut(slots: IntakeSlot[]): Promise<void> {
    // Sin `notify` la fase 3 está apagada entera: no se computa ni se persiste estado de alertas
    // (invariante vigente), así que tampoco hay estado que retirar.
    if (!deps.notify) return
    const optOut = slots.filter((s) => s.watch === false)
    if (!optOut.length) return
    try {
      if (!hydrated) {
        alertState = parseIntakeWatchState(await deps.store.getSetting(INTAKE_WATCH_STATE_KEY))
        hydrated = true
      }
      const next = { ...alertState }
      let cambio = false
      for (const s of optOut) {
        if (s.id in next) {
          delete next[s.id]
          cambio = true
        }
      }
      if (!cambio) return
      // En memoria PRIMERO: si la escritura falla, el diff de este mismo tick tiene que ver el estado
      // ya sin la clave —o emitiría el «recuperado» falso que esta función existe para evitar—. Una
      // escritura fallida deja la clave vieja en el store hasta la próxima transición que se persista
      // (o hasta el próximo arranque, donde esta misma función la retira sobre el estado hidratado):
      // en ningún caso vuelve a la memoria del lazo vivo.
      alertState = next
      await deps.store.setSetting(INTAKE_WATCH_STATE_KEY, JSON.stringify(next), 'intake-watch')
      deps.log(`intake-loop: ${optOut.map((s) => `'${s.id}'`).join(', ')} salió(eron) de la vigilancia (watch: false) — estado de alertas retirado sin aviso`)
    } catch (e) {
      // Un store que no responde no debe costar la observación del tick: se dice y se sigue. La fase 3
      // volverá a intentar la hidratación y fallará ahí igual que antes de este frente.
      deps.log(`intake-loop: no se pudo retirar el estado de alertas del opt-out — ${msg(e)}`)
    }
  }

  /** Umbrales del slot (§4.1). `null` = el slot NO se vigila. */
  function watchConfigDe(slot: IntakeSlot): SlotWatchConfig | null {
    return intakeWatchConfig(slot, pollMs)
  }

  return { tick }
}

/** Lo que la alerta clasificada aporta al aviso compuesto. */
type Evidencia = Pick<IntakeAlertContext, 'reason' | 'medida' | 'varados' | 'esperados' | 'landingAusente' | 'ultimaCargaAt' | 'run' | 'lastError'>

/** Los dos insumos que el registro de cargas le da a la clasificación de un slot. */
interface InsumosRegistro {
  /** Control por-archivo (§3.3): vacío = no se computó o el registro no predice nada. */
  expected: string[]
  /** Control del directorio (009·§4.2): ausente = el slot no tiene cargas vividas registradas. */
  registro?: { cargasVividas: number; ultimaCargaAt?: string }
}

/** Cargas no finales que se evalúan por slot y por vuelta. No es una política: es el tope del lote de
 *  una vuelta — lo que no entra, entra en la siguiente. */
const RESOLVER_LOTE = 200

/** Clave de `platform_setting` con la última medida de disjunción de los tipos de archivo (#269·§4.1). */
export const INTAKE_DISJUNCION_KEY = 'intake.disjuncion'

/** La medida persistida de la disjunción: qué nombres del registro calzan con 2+ tipos. */
export interface MedidaDisjuncion {
  medidoAt: string
  nombres: number
  ambiguos: { nombre: string; slots: string[] }[]
}

/** Lee la medida persistida; ilegible = `null` (la consola no afirma nada que no pueda leer). */
export function parseMedidaDisjuncion(raw: string | null): MedidaDisjuncion | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as MedidaDisjuncion
    return v && typeof v.medidoAt === 'string' && Array.isArray(v.ambiguos) ? v : null
  } catch {
    return null
  }
}

/** Los desenlaces que quien subió recibe por correo (§6.2). `procesada` y `saltada` NO: el archivo
 *  que entró bien no genera correo, y el omitido se consulta en la consola. */
const DESENLACES_QUE_AVISAN: CargaDesenlace[] = ['fallida', 'sin-informe']

/**
 * Una corrida con la resolución de SU log (#99) y el texto leído.
 *
 * `'no-medido'` es un kind PROPIO de esta fase, y no uno de `RunLogResolution`: significa que la
 * plataforma no pudo mirar el log (dependencia no cableada, contenido ausente, lectura fallida).
 * Existe separado de `'sin-log'` porque confundirlos convertiría una ceguera de la plataforma en una
 * afirmación sobre el job — exactamente el error que #162 existe para cerrar.
 */
export interface CorridaConLog {
  run: RunRecord
  log: 'match' | 'en-curso' | 'purgado' | 'sin-log' | 'no-medido'
  texto: string | null
}

/** Cargas del registro que la fase lee para detectar re-subidas del mismo nombre (tope de una vuelta). */
const RESOLVER_HISTORIA = 1000

/** Margen hacia atrás al elegir qué logs leer: una corrida que ya estaba en curso cuando se subió el
 *  archivo arrancó ANTES de la subida y puede haberlo tomado (#269·P27). Es solo un recorte de I/O —
 *  la ventana exacta la decide `resolverEstadoDeCarga`—, y 6 h es el doble de la corrida más larga
 *  medida en `work/268` (2,9 min) con holgura de sobra. */
const VENTANA_EN_CURSO_MS = 6 * 3_600_000

/** ¿Esta corrida todavía le puede decir algo a esta carga? Con cursor (`evaluadoHasta`), solo las que
 *  arrancaron DESPUÉS; sin él (nunca evaluada, o un valor legado que se reevalúa entero), las que
 *  arrancaron desde un poco antes de la subida (P27). Es un recorte de I/O, no la ventana del estado. */
function leInteresa(c: IntakeUploadRow, r: RunRecord): boolean {
  const ini = Date.parse(r.startedAt)
  if (!Number.isFinite(ini)) return false
  const legado = c.desenlace != null && c.desenlaceFinal === undefined
  if (!legado && c.evaluadoHasta) return ini > Date.parse(c.evaluadoHasta)
  const subida = Date.parse(c.uploadedAt)
  return !Number.isFinite(subida) || ini >= subida - VENTANA_EN_CURSO_MS
}

/** Un retiro que el resolvedor considera (#269·§3.4). Con `uploadId` (una reversión) cierra SOLO esa
 *  carga; sin él, cierra la carga de ese nombre subida antes del retiro. */
export interface RetiroDeCarga {
  filename: string
  /** ISO del retiro. */
  at: string
  via: 'retirar' | 'revertir' | 'rename'
  uploadId?: number
}

/** El estado que la carga ya tenía, escrito por ESTE resolvedor en una vuelta anterior. */
export interface EstadoPrevio {
  estado: CargaDesenlace
  motivo?: string
  codigo?: string
  params?: DesenlaceParams
  runStartedAt?: string
}

export interface OpcionesResolver {
  /** `contrato_desde` del slot: ancla del puente histórico. Ausente = sin puente (fail-closed). */
  contratoDesde?: string
  /** El estado no final que la carga ya tenía. Con `evaluadoHasta`, es la evidencia de las corridas
   *  que esta vuelta ya no relee (sus logs pueden haberse podado). */
  previo?: EstadoPrevio
  /** Cursor: solo cuentan las corridas que arrancaron DESPUÉS de este instante. */
  evaluadoHasta?: string
  /** «Ahora» (ms): decide si una corrida no terminada todavía puede estar tomando el archivo. Ausente =
   *  toda corrida no terminada cuenta como en curso. */
  nowMs?: number
  /** Edad (ms) desde la que una corrida `InProgress`/`NotStarted` ya no se cree «en curso». Default:
   *  `DEFAULT_MAX_RUN_MINUTES` — el mismo umbral con el que el vigilante la declara colgada. */
  maxEnCursoMs?: number
}

/** Lo que UNA corrida declaró de la carga: la fila que va a `intake_intento`. */
export interface IntentoObservado {
  runStartedAt: string
  resultado: 'procesada' | 'saltada' | 'fallida'
  motivo?: string
  codigo?: string
  params?: DesenlaceParams
}

/** Por qué camino se llegó al estado (la tabla «por vía» del oráculo de #269·§2.2). */
export type ViaEstado = 'declaracion' | 'puente' | 'retiro' | 'reemplazo' | 'corrida' | 'sin-log' | 'fuera-sin-declaracion' | 'previo' | 'pendiente'

/** El estado de UNA carga según `resolverEstadoDeCarga`. */
export interface EstadoResuelto {
  /** `null` = todavía sin estado: el archivo sigue en el landing y nadie lo declaró. */
  estado: CargaDesenlace | null
  final: boolean
  via: ViaEstado
  /** Motivo POR ARCHIVO declarado por el job. Ausente = no lo declaró; jamás se rellena. */
  motivo?: string
  codigo?: string
  params?: DesenlaceParams
  /** La corrida que decidió el estado (o, en un acto, la del último intento). */
  runStartedAt?: string
  /** Titular de la corrida (última `✖` del log) en una `fallida` de legado: contexto, no motivo. */
  titular?: string
  /** Hay una corrida en curso que puede estar tomando el archivo: la página dice «Cargando». */
  enCurso: boolean
  /** Declaraciones observadas en esta evaluación, en orden. */
  intentos: IntentoObservado[]
  /** El último intento no final antes de un acto (retiro, re-subida): «último intento» plegado. */
  ultimoIntento?: IntentoObservado
  /** Instante del acto (retiro o re-subida) que cerró la carga. */
  actoAt?: string
  /** Cursor para la próxima vuelta: la última corrida TERMINADA considerada. */
  evaluadoHasta?: string
  /** La declaración y lo archivado se contradicen (P30): declarado «no cargado» y archivado igual. */
  contradiccion?: true
  /** En el puente: la ruta de la copia archivada que se aceptó como evidencia. */
  copia?: string
}

const RESULTADO_POR_OUTCOME: Record<'procesado' | 'saltado' | 'fallido', IntentoObservado['resultado']> = {
  procesado: 'procesada',
  saltado: 'saltada',
  fallido: 'fallida',
}

/**
 * El ESTADO de UNA carga (#269·§3.2) — PURA, sin I/O. Su prototipo ejecutable es `v21()` del arnés
 * del oráculo (`replay-v2.1.mts`), y el arnés con ESTA función reproduce sus 141 estados.
 *
 * El principio (§3.1): el estado es SOLO lo que el ingestor declaró de ESTE archivo en un log con
 * gramática, más los actos registrados (re-subida del mismo nombre, retiro en `_retirado/`,
 * reversión). La AUSENCIA de declaración nunca se convierte en un resultado: en el landing es «sin
 * estado», fuera del landing es «sin informe». Por construcción quedan imposibles:
 *  · atribuirle a un archivo la falla de una corrida que no lo nombró (A);
 *  · inferir «cargado» de que el archivo salió del landing (F) — `_sin-metadata/` también es salir;
 *  · inferir «varado» de una edad (G) — la edad es un dato que se muestra, no un resultado.
 *
 * Reglas, en orden (el orden ES la regla):
 *  1. VENTANA. Cuentan las corridas que arrancaron después de la subida, o que estaban en curso cuando
 *     se subió (P27: la 190 la tomó una corrida que arrancó 15 s antes). La ventana corta en el primer
 *     retiro o re-subida posterior. Una corrida en curso sin `✔` previo: no se concluye nada todavía.
 *  2. DECLARACIÓN de este archivo, buscada por el NOMBRE CONOCIDO (D14, P26), no por el corte del
 *     lector. `✔` → `procesada` (final; gana la primera). `⚠`/`✖` → no finales; gana la última.
 *  3. PUENTE histórico (§3.1): la copia archivada, SOLO para una carga subida y archivada antes del
 *     ancla = min(`contrato_desde`, primera corrida con gramática). Sin `contrato_desde`, no hay puente.
 *  4. ACTO: retiro → `retirada`; re-subida → `reemplazada` (finales).
 *  5. La última declaración `⚠`/`✖` (o, con cursor, la que ya se tenía).
 *  6. Corrida `Failed` sin log → `sin-informe`; `Failed` con log sin gramática → `fallida` (legado).
 *  7. Fuera del landing sin nada de lo anterior → `sin-informe`. En el landing → sin estado.
 *
 * Un log con gramática que NO nombra el archivo no aporta evidencia: esa corrida no lo vio.
 */
export function resolverEstadoDeCarga(
  carga: { id?: number; filename: string; uploadedAt: string },
  corridas: CorridaConLog[],
  landing: OneLakeEntry[],
  archivados: OneLakeEntry[],
  retiros: RetiroDeCarga[],
  reemplazos: { uploadedAt: string }[],
  opts: OpcionesResolver = {},
): EstadoResuelto {
  const t0 = Date.parse(carga.uploadedAt)
  const nombre = base(carga.filename)
  const intentos: IntentoObservado[] = []

  // ── Actos: el primero posterior a la subida corta la ventana ─────────────────────────────────
  let tEnd = Infinity
  let acto: 'retirada' | 'reemplazada' | null = null
  let actoAt: string | undefined
  for (const r of retiros ?? []) {
    if (r.uploadId != null ? r.uploadId !== carga.id : base(r.filename) !== nombre) continue
    const t = Date.parse(r.at)
    if (Number.isFinite(t) && t > t0 && t < tEnd) {
      tEnd = t
      acto = 'retirada'
      actoAt = r.at
    }
  }
  for (const o of reemplazos ?? []) {
    const t = Date.parse(o.uploadedAt)
    if (Number.isFinite(t) && t > t0 && t < tEnd) {
      tEnd = t
      acto = 'reemplazada'
      actoAt = o.uploadedAt
    }
  }

  // ── Regla 1 · la ventana ─────────────────────────────────────────────────────────────────────
  const cursor = opts.evaluadoHasta ? Date.parse(opts.evaluadoHasta) : NaN
  const ventana = (corridas ?? [])
    .filter((c) => {
      const ini = Date.parse(c.run.startedAt)
      if (!Number.isFinite(ini) || ini >= tEnd) return false
      if (Number.isFinite(cursor) && ini <= cursor) return false
      if (!Number.isFinite(t0) || ini >= t0) return true
      const fin = c.run.endedAt ? Date.parse(c.run.endedAt) : NaN
      return Number.isFinite(fin) && fin >= t0 // en curso cuando se subió (P27)
    })
    .sort((a, b) => Date.parse(a.run.startedAt) - Date.parse(b.run.startedAt))

  let declarado: IntentoObservado | null = null
  let porCorrida: Pick<EstadoResuelto, 'estado' | 'runStartedAt' | 'titular'> | null = null
  let primeraGramatica = Infinity
  let evaluadoHasta = opts.evaluadoHasta
  let enCurso = false
  // Una corrida cuyo log la plataforma NO PUDO MIRAR (dependencia ausente, lectura fallida) puede haber
  // declarado este archivo: mientras exista en la ventana, la ausencia de declaración no concluye nada.
  let ciego = false
  const maxEnCurso = opts.maxEnCursoMs ?? DEFAULT_MAX_RUN_MINUTES * 60_000
  for (const c of ventana) {
    if (c.run.status === 'InProgress' || c.run.status === 'NotStarted') {
      // Una corrida no terminada MÁS VIEJA que el umbral de corrida colgada no está tomando nada: el
      // motor deja `NotStarted` que nunca arrancan (medido en el oráculo: 12 filas, una de hace 19
      // días), y creerles bloquearía para siempre a toda carga posterior. No es evidencia ni espera.
      if (opts.nowMs != null && opts.nowMs - Date.parse(c.run.startedAt) > maxEnCurso) continue
      // Su resultado todavía puede decidir: nada de lo que siga se interpreta antes de que termine.
      enCurso = true
      break
    }
    const texto = c.log === 'match' ? c.texto : null
    if (c.log === 'no-medido') ciego = true
    const hayGramatica = !!texto && parseRunFileOutcomes(texto).length > 0
    if (hayGramatica) primeraGramatica = Math.min(primeraGramatica, Date.parse(c.run.startedAt))
    const d = texto ? declaracionDeArchivo(texto, nombre) : undefined
    // El cursor no pasa por encima de un log que no se pudo mirar: la próxima vuelta lo vuelve a mirar.
    if (!ciego) evaluadoHasta = c.run.startedAt
    if (d) {
      const i: IntentoObservado = { runStartedAt: c.run.startedAt, resultado: RESULTADO_POR_OUTCOME[d.outcome] }
      if (d.motivo != null) i.motivo = d.motivo
      if (d.codigo != null) i.codigo = d.codigo
      if (d.params != null) i.params = d.params
      intentos.push(i)
      if (i.resultado === 'procesada') {
        // ✔ es final y gana la PRIMERA: lo que venga después no puede des-cargar el archivo.
        const out: EstadoResuelto = { estado: 'procesada', final: true, via: 'declaracion', runStartedAt: i.runStartedAt, enCurso: false, intentos }
        if (declarado) out.ultimoIntento = declarado
        return conCursor(out, c.run.startedAt)
      }
      declarado = i
      continue
    }
    if (hayGramatica) continue // log con gramática que no lo nombra: esa corrida no lo vio
    if (c.run.status === 'Failed' && !declarado) {
      if (c.log === 'match' && texto != null) {
        porCorrida = { estado: 'fallida', runStartedAt: c.run.startedAt }
        const titular = diagnosticoDeFalla(texto)
        if (titular) porCorrida.titular = titular
      } else if (c.log === 'sin-log' || c.log === 'purgado') {
        porCorrida = { estado: 'sin-informe', runStartedAt: c.run.startedAt }
      }
      // `'no-medido'`: la plataforma no miró el log. No se concluye nada.
    }
  }

  const enLanding = (landing ?? []).some((e) => e && !e.isDirectory && !isSidecarName(e.path) && base(e.path) === nombre)
  const cierre = (out: EstadoResuelto): EstadoResuelto => conCursor(out, evaluadoHasta)
  // Mientras una corrida en curso puede tomarlo, no se concluye nada (salvo un acto: ese ya ocurrió
  // y cierra la carga aunque la corrida siga — la ventana ya cortó antes de ella).
  if (enCurso && !acto) return cierre({ estado: opts.previo?.estado ?? null, final: false, via: opts.previo ? 'previo' : 'pendiente', enCurso: true, intentos })

  // ── Regla 3 · el puente histórico ─────────────────────────────────────────────────────────────
  const desde = opts.contratoDesde ? Date.parse(opts.contratoDesde) : NaN
  if (Number.isFinite(desde)) {
    const ancla = Math.min(primeraGramatica, desde)
    if (t0 < ancla) {
      const copia = (archivados ?? []).find((e) => {
        if (!e || e.isDirectory || isSidecarName(e.path)) return false
        const b = base(e.path)
        if (nombreSinSello(b) !== nombre) return false
        const mtime = Date.parse(e.lastModified)
        const ta = selloDelNombre(b) ?? mtime
        return mtime >= t0 - MARGEN_ARCHIVADO_MS && ta < tEnd && ta < ancla
      })
      if (copia) return cierre({ estado: 'procesada', final: true, via: 'puente', enCurso: false, intentos, copia: copia.path })
    }
  }

  // ── Regla 4 · el acto ───────────────────────────────────────────────────────────────────────────
  if (acto) {
    const out: EstadoResuelto = { estado: acto, final: true, via: acto === 'retirada' ? 'retiro' : 'reemplazo', enCurso: false, intentos }
    if (actoAt) out.actoAt = actoAt
    const ultimo = declarado ?? previoComoIntento(opts.previo)
    if (ultimo) out.ultimoIntento = ultimo
    return cierre(out)
  }

  // ── Regla 5 · la última declaración ⚠/✖ ────────────────────────────────────────────────────────
  if (declarado) {
    const out: EstadoResuelto = { estado: declarado.resultado, final: false, via: 'declaracion', runStartedAt: declarado.runStartedAt, enCurso, intentos }
    if (declarado.motivo != null) out.motivo = declarado.motivo
    if (declarado.codigo != null) out.codigo = declarado.codigo
    if (declarado.params != null) out.params = declarado.params
    if (enLanding || !archivadoTras(archivados, nombre, t0)) return cierre(out)
    // P30: declarado «no cargado» y archivado igual. Gana la declaración; la consola lo señala.
    out.contradiccion = true
    return cierre(out)
  }
  const previo = opts.previo
  if (previo && (previo.estado === 'fallida' || previo.estado === 'saltada')) return cierre(desdePrevio(previo, enCurso, intentos))
  // «No pude mirar» no es «no hay»: sin declaración legible, nada de lo que sigue se concluye.
  if (ciego) return cierre({ estado: previo?.estado ?? null, final: false, via: previo ? 'previo' : 'pendiente', enCurso, intentos })

  // ── Regla 6 · la corrida sin declaración ─────────────────────────────────────────────────────────
  if (porCorrida?.estado) {
    const out: EstadoResuelto = { estado: porCorrida.estado, final: false, via: porCorrida.estado === 'sin-informe' ? 'sin-log' : 'corrida', enCurso, intentos }
    if (porCorrida.runStartedAt) out.runStartedAt = porCorrida.runStartedAt
    if (porCorrida.titular) out.titular = porCorrida.titular
    return cierre(out)
  }
  if (previo) return cierre(desdePrevio(previo, enCurso, intentos))

  // ── Regla 7 · la ausencia ──────────────────────────────────────────────────────────────────────
  if (!enLanding) return cierre({ estado: 'sin-informe', final: false, via: 'fuera-sin-declaracion', enCurso, intentos })
  return cierre({ estado: null, final: false, via: 'pendiente', enCurso, intentos })
}

/** Margen del puente: la copia archivada no puede ser anterior a la subida (5 s de reloj). */
const MARGEN_ARCHIVADO_MS = 5_000

function conCursor(out: EstadoResuelto, evaluadoHasta: string | undefined): EstadoResuelto {
  if (evaluadoHasta != null) out.evaluadoHasta = evaluadoHasta
  return out
}

function previoComoIntento(p: EstadoPrevio | undefined): IntentoObservado | undefined {
  if (!p || (p.estado !== 'fallida' && p.estado !== 'saltada') || !p.runStartedAt) return undefined
  const i: IntentoObservado = { runStartedAt: p.runStartedAt, resultado: p.estado }
  if (p.motivo != null) i.motivo = p.motivo
  if (p.codigo != null) i.codigo = p.codigo
  if (p.params != null) i.params = p.params
  return i
}

function desdePrevio(p: EstadoPrevio, enCurso: boolean, intentos: IntentoObservado[]): EstadoResuelto {
  const out: EstadoResuelto = { estado: p.estado, final: false, via: 'previo', enCurso, intentos }
  if (p.motivo != null) out.motivo = p.motivo
  if (p.codigo != null) out.codigo = p.codigo
  if (p.params != null) out.params = p.params
  if (p.runStartedAt != null) out.runStartedAt = p.runStartedAt
  return out
}

/** ¿Hay una copia archivada de este nombre escrita después de la subida? (insumo de la señal P30) */
function archivadoTras(archivados: OneLakeEntry[], nombre: string, t0: number): boolean {
  return (archivados ?? []).some((e) => e && !e.isDirectory && nombreSinSello(base(e.path)) === nombre && Date.parse(e.lastModified) >= t0 - MARGEN_ARCHIVADO_MS)
}

/** Basename de una ruta del Lakehouse: el registro guarda el nombre, el listado trae la ruta. */
const base = (p: string): string => String(p ?? '').replace(/^.*[/\\]/, '')

/**
 * Umbrales de vigilancia de un slot (§4.1 del diseño), PURA y exportada para el tile del dashboard y
 * los tests.
 *
 * Sin bloque `watch:` declarado (el caso de todo YAML previo a #161) los umbrales son los defaults
 * del producto, sin cambio alguno:
 *
 * - Slot con `trigger`: vigilado por edad con el default (la carga dispara la conversión, así que
 *   minutos después el landing debe drenar).
 * - Slot land-only: se vigila igual (la medida misma —`sin-medida`— no depende del ritmo de nadie),
 *   pero SIN edad máxima: el consumidor externo tiene su propio ritmo, que el producto no conoce, y
 *   un default inventado fabricaría varados falsos.
 *
 * Con el bloque `watch:` declarado (§3.2 del diseño 009; el parse vive en `intake.ts`):
 *
 * - `watch: false` ⇒ `null`: el slot NO se vigila, y como TODO el tick se construye sobre esta
 *   función (`vigilados`), el opt-out es total — sin observación, sin proyección refrescada, sin
 *   control positivo, sin conteo del contrato `_logs/` y sin resolver de desenlaces (#162). Es la
 *   decisión del diseño 009·§3.3, no un efecto colateral: el slot lento se declara con un
 *   `max_age_minutes` alto, que conserva todo lo demás.
 * - mapa ⇒ lo declarado SUSTITUYE al default, clave por clave; lo no declarado cae al default. Un
 *   slot land-only que declara `max_age_minutes` gana la señal de varados que el default no le da
 *   (el opt-in de edad de §4.1 del diseño 008).
 *
 * `maxRunMinutes` no declarado queda AUSENTE en vez de escrito con su default: quien lo consume
 * (`classifySlot`) ya aplica `?? DEFAULT_MAX_RUN_MINUTES`, así que escribirlo acá sería copiar el
 * default en dos lugares. Verificado en `intake-observability.ts` (`config.maxRunMinutes ??
 * DEFAULT_MAX_RUN_MINUTES`), no supuesto.
 */
export function intakeWatchConfig(slot: IntakeSlot, pollMs: number): SlotWatchConfig | null {
  if (slot.watch === false) return null
  const cfg: SlotWatchConfig = { pollMs }
  const maxAgeMinutes = slot.watch?.maxAgeMinutes ?? (slot.trigger ? DEFAULT_MAX_AGE_MINUTES : undefined)
  if (maxAgeMinutes != null) cfg.maxAgeMinutes = maxAgeMinutes
  if (slot.watch?.maxRunMinutes != null) cfg.maxRunMinutes = slot.watch.maxRunMinutes
  return cfg
}

/** Resumen de la vigilancia para el tile del dashboard (§6.1): `N vigilados · M en alerta · K sin medir`. */
export interface IntakeWatchSummary {
  vigilados: number
  enAlerta: number
  sinMedir: number
}

/**
 * Resume la vigilancia LEYENDO SOLO LA PROYECCIÓN — PURA, sin I/O: el request path del dashboard
 * jamás lista OneLake (invariante de #105 heredada por §3.5).
 *
 * `sinMedir` cuenta al vigilante ciego con el mismo criterio del stale de frescura (`ahora −
 * observedAt > 3 × poll`, verificado `serve-rls.ts:1399`) MÁS los dos casos que no dependen del
 * reloj: nunca medido, y último intento fallido. Con el lazo apagado (`pollMs <= 0`) TODOS cuentan
 * como sin medir: una proyección que nadie refresca no es una medida, es un recuerdo.
 *
 * `enAlerta` excluye `'sin-medida'` a propósito: esa condición ya se cuenta —y se nombra— en
 * `sinMedir`, y sumarla dos veces haría leer «2 problemas» donde hay uno.
 *
 * El control positivo (§3.3) NO participa acá: predecir el landing exige el registro de cargas y las
 * corridas, que son lecturas del lazo. Un slot cuya única alerta es `'contradice-registro'` cuenta
 * en `sinMedir` (su medida no es fresca) pero no en `enAlerta`.
 */
export function summarizeIntakeWatch(
  slots: IntakeSlot[],
  snapshots: { slotId: string; landing: OneLakeEntry[]; runs: RunRecord[]; observedAt: string | null; firstAttemptAt: string | null; lastError: string | null }[],
  pollMs: number,
  nowMs: number,
): IntakeWatchSummary {
  const porSlot = new Map(snapshots.map((s) => [s.slotId, s]))
  let vigilados = 0
  let enAlerta = 0
  let sinMedir = 0
  for (const slot of slots) {
    const config = intakeWatchConfig(slot, pollMs)
    if (!config) continue
    vigilados++
    const s = porSlot.get(slot.id)
    const observedAt = s?.observedAt ?? null
    const stale = pollMs <= 0 || observedAt == null || nowMs - Date.parse(observedAt) > 3 * pollMs
    const ciego = stale || s?.lastError != null
    if (ciego) sinMedir++
    // La observación se RECONSTRUYE desde la proyección: si el último intento falló, se clasifica
    // como fallido (sobre lo último conocido), que es exactamente lo que el lazo hizo.
    const obs: SlotObservation = { slotId: slot.id, observedAt: observedAt ?? '' }
    if (s?.lastError != null || observedAt == null) obs.error = s?.lastError ?? 'sin observación'
    else {
      obs.landing = s?.landing ?? []
      if (s?.runs.length) obs.runs = s.runs
    }
    const input: SlotWatchInput = { slotId: slot.id, obs }
    if (s) {
      const proj: SlotProjection = { landing: s.landing, runs: s.runs }
      if (s.observedAt != null) proj.observedAt = s.observedAt
      if (s.firstAttemptAt != null) proj.firstAttemptAt = s.firstAttemptAt
      input.projection = proj
    }
    if (classifySlot(input, config, nowMs).alertas.some((a) => a.reason !== 'sin-medida')) enAlerta++
  }
  return { vigilados, enAlerta, sinMedir }
}

/**
 * El veredicto del vigilante sobre UN slot para la consola de Cargas (#161·§6.1) — PURA, sin I/O:
 * se clasifica sobre la PROYECCIÓN, igual que el tile del dashboard. El request path no lista
 * OneLake ni consulta el motor (invariante de #105 heredada por §3.5), así que lo que la página
 * afirma es lo que el lazo midió y no una medición propia hecha al vuelo.
 *
 * La observación se RECONSTRUYE desde el snapshot con el mismo criterio de `summarizeIntakeWatch`:
 * último intento fallido, proyección fría o proyección más vieja que `3 × poll` ⇒ se clasifica como
 * observación FALLIDA (sobre lo último conocido), que es lo que el lazo habría hecho. Sin ese corte
 * por antigüedad, un lazo detenido dejaría la página diciendo «al día» sobre un recuerdo. [El texto
 * del banner de `'ultima-conocida'` habla del «último intento»; con la proyección solo añeja —lazo
 * caído, o los primeros segundos tras un reinicio— no hubo tal intento reciente. La afirmación que
 * importa (lo que se ve NO es de ahora) sí es verdadera; la del intento es imprecisa en ese caso.]
 *
 * Lo que NO se puede saber desde acá, y por qué no se inventa:
 *  · `esperados` (§3.3) exige el control positivo, y uno de sus insumos —los retiros— sale de listar
 *    `_retirado/` en el almacenamiento: prohibido en el request path. Por eso la CONTRADICCIÓN se
 *    toma del veredicto que el lazo persistió (`intake.watch_state`, lectura local del store de
 *    gobierno) y se muestra sin nombrar archivos: el banner de #161 ya contempla la lista vacía.
 *    Solo se adopta si esta reconstrucción dio `'fresca'` — con la medida ya degradada manda lo más
 *    reciente, que es la degradación.
 *  · `corridasSinLog` (#162·§5) exige correlacionar las corridas terminadas con el listado de
 *    `_logs/`, otra lectura del almacenamiento — así que NO se computa acá: se COPIA del snapshot,
 *    donde el lazo lo dejó al medirlo en su tick (diseño 009·§2.3). Ausente en el snapshot = el conteo
 *    no aplica al slot o nunca se pudo medir, y con el campo ausente `avisoContratoLogs` no muestra
 *    nada. Se copia también con la medida degradada (`ultima-conocida`): es una métrica de conducta
 *    lenta —tres corridas seguidas— y el banner de la medida ya rotula la añejez de lo que se ve.
 */
export function slotVigilanciaDeProyeccion(
  slot: IntakeSlot,
  snapshot: SlotWatchSnapshot | undefined,
  pollMs: number,
  nowMs: number,
  razonDelLazo?: SlotAlertReason,
): SlotVigilancia | null {
  const config = intakeWatchConfig(slot, pollMs)
  if (!config) return null // el slot no se vigila ⇒ la página no muestra banner
  const observedAt = snapshot?.observedAt ?? null
  const stale = pollMs <= 0 || observedAt == null || nowMs - Date.parse(observedAt) > 3 * pollMs
  const ciego = stale || snapshot?.lastError != null
  const obs: SlotObservation = { slotId: slot.id, observedAt: observedAt ?? '' }
  if (ciego) {
    // Este texto NO se muestra: el `lastError` de la superficie sale del snapshot (el error REAL del
    // lazo) o queda ausente. Acá solo marca la observación como fallida para `classifySlot`.
    obs.error = snapshot?.lastError ?? 'sin observación reciente'
  } else {
    obs.landing = snapshot?.landing ?? []
    if (snapshot?.runs.length) obs.runs = snapshot.runs
  }
  const input: SlotWatchInput = { slotId: slot.id, obs }
  if (snapshot) {
    const proj: SlotProjection = { landing: snapshot.landing, runs: snapshot.runs }
    if (snapshot.observedAt != null) proj.observedAt = snapshot.observedAt
    if (snapshot.firstAttemptAt != null) proj.firstAttemptAt = snapshot.firstAttemptAt
    input.projection = proj
  }
  const { medida, alertas } = classifySlot(input, config, nowMs)
  const v: SlotVigilancia = { medida }
  if (observedAt != null) v.observedAt = observedAt
  if (snapshot?.lastError != null) {
    v.lastError = snapshot.lastError
    if (snapshot.lastErrorAt != null) v.lastErrorAt = snapshot.lastErrorAt
  }
  if (snapshot?.corridasSinLog != null) v.corridasSinLog = snapshot.corridasSinLog
  const varados = alertas.find((a) => a.reason === 'varados')?.varados
  if (varados?.length) v.varados = varados
  // Un listado desmentido no sostiene NINGUNA conclusión derivada de él (invariante 2): con la
  // contradicción vigente `classifySlot` no habría clasificado el landing, así que los varados de
  // esta reconstrucción se descartan en vez de mostrarse bajo el banner que los desautoriza.
  if (razonDelLazo === 'contradice-registro' && medida === 'fresca') {
    v.medida = 'contradice-registro'
    delete v.varados
  }
  return v
}
