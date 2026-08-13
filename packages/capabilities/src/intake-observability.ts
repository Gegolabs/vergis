/**
 * Vigilancia del INTAKE (issue #161 — detección y aviso al operador) — lógica PURA.
 *
 * Observa el ciclo de una carga por SLOT: el listado del landing (¿drenó?) y el historial de
 * corridas del trigger (¿la conversión terminó bien?). Sin I/O: el listado, las corridas, el
 * registro de cargas y los eventos de retiro entran como datos; el lazo (`server/intake-loop.ts`)
 * es el que los va a buscar.
 *
 * DOS INVARIANTES que este módulo existe para sostener — las dos distinguen «no hay» de «no veo»:
 *
 *  1. **Una lectura fallida clasifica sobre lo ÚLTIMO CONOCIDO, jamás sobre `[]`** (precedente
 *     verificado: fase 2 de `server/freshness-loop.ts`). Un almacenamiento caído no puede fabricar
 *     «landing vacío». Sin proyección previa —jamás se midió bien este slot— NO se clasifica el
 *     landing en absoluto: cero alertas de varados, medida `'ninguna'`.
 *  2. **Contra el vacío-con-éxito, un control positivo** (§3.3 del diseño): `OneLakeReader.list`
 *     aplana 404 → `[]` y un 200 con cuerpo vacío también da `[]` (verificado en
 *     `intake-onelake.ts`), así que un listado «exitoso» y vacío NO prueba que el landing esté
 *     vacío. La plataforma tiene la predicción independiente gratis, porque ella misma puso los
 *     archivos ahí: el registro de cargas (#62). Si el registro predice ≥1 archivo y el listado no
 *     trae NINGUNO de los predichos, la medida es `'contradice-registro'` y se alerta la
 *     CONTRADICCIÓN — nunca su causa (permisos, borrado a mano, path mal configurado: eso lo
 *     diagnostica una persona).
 *
 *     El control positivo tiene DOS formas, y la diferencia es qué necesita cada una para no mentir:
 *
 *     · **Por-archivo** (`expected`) — exige un CORTE: la última corrida `Completed`, que archivó a
 *       `_processed/` lo que procesó. Sin corte toda carga histórica se «esperaría» para siempre y
 *       el primer drenaje legítimo fabricaría una contradicción falsa. Por eso solo corre en slots
 *       con corridas observadas.
 *     · **Del DIRECTORIO** (`registro.cargasVividas` + `obs.landingAbsent`) — no necesita corte, y
 *       por eso cubre también al slot land-only: un consumidor consume ARCHIVOS, no directorios, así
 *       que «el directorio no existe» (404) con cargas que esta plataforma escribió ahí contradice
 *       lo que ella sabe de sí misma, con o sin corridas. Es la lente rota del incidente fundante
 *       (`list` aplanaba 404 → `[]` y la lectura «exitosa» concluía que el usuario no subió nada).
 *
 *     **PÉRDIDA ACEPTADA Y DOCUMENTADA (diseño 009·§4.3), para que nadie la redescubra como
 *     sorpresa ni la «arregle» sin volver a pensarla:** en un slot LAND-ONLY, un `200` con lista
 *     vacía sobre un directorio que SÍ existe NO produce contradicción. Ese estado es
 *     indistinguible de «el consumidor externo drenó todo», y distinguirlos exigiría un evento de
 *     consumo observable que hoy no existe (ningún actor lo escribe). Ahí esa clase del incidente de
 *     #161 sigue siendo posible; lo que cubre a esos slots es lo que no depende del ritmo de nadie:
 *     `'sin-medida'`, el control del directorio y el opt-in de edad (`watch.max_age_minutes`). Hay
 *     un test que FIJA esta decisión (`tests/intake-observability.test.ts`).
 *
 * Fuera de alcance por requisito de #161: reintentos y auto-reparación (detectar y avisar; decidir
 * es de las personas) y validación semántica del contenido (es del job de cada dominio — la señal
 * de edad no necesita entender el archivo, y esa es justo la propiedad que la hace universal).
 */
import { isSidecarName } from './intake'
import type { OneLakeEntry } from './intake-onelake'
import type { RunRecord } from './ingestion-observability'

// ─── Umbrales y claves ───────────────────────────────────────────────────────────────────────────

/** Edad máxima default de un archivo en el landing, en minutos (§4.1). Aplica al slot CON trigger:
 *  la carga dispara la conversión, así que minutos después el landing debe drenar. Un slot land-only
 *  solo se vigila por edad si la declara — el consumidor externo tiene su propio ritmo, que el
 *  producto no conoce, y un default inventado fabricaría falsos varados. */
export const DEFAULT_MAX_AGE_MINUTES = 120
/** Minutos tras los cuales una corrida `InProgress`/`NotStarted` se considera colgada (§4.1). */
export const DEFAULT_MAX_RUN_MINUTES = 60
/** Cadencia default del lazo de vigilancia, en ms (§4.1): la unidad de tiempo del fenómeno son
 *  horas — no hay razón para pagar un listado por slot cada pocos minutos. */
export const DEFAULT_INTAKE_WATCH_MS = 600_000
/** Ticks sin poder medir que vuelven `'sin-medida'` una alerta al operador. El 3× es el precedente
 *  del stale de frescura (verificado, `serve-rls.ts:1399`: `ahora − observedAt > 3 × poll`). */
export const SIN_MEDIDA_TICKS = 3

/** Clave de `platform_setting` donde vive el estado de alertas de la vigilancia entre reinicios. */
export const INTAKE_WATCH_STATE_KEY = 'intake.watch_state'

// ─── §3.1 · La observación y la calidad de la medida ─────────────────────────────────────────────

/** Un intento de observación de un slot. Puede PORTAR ERROR: fallar en medir es un estado, no un
 *  vacío (mismo patrón que `ProcessObservation`, verificado en `governance-store.ts`). */
export interface SlotObservation {
  slotId: string
  /** ISO del intento, siempre presente (haya salido bien o mal). */
  observedAt: string
  /** Listado del landing tal cual llegó (sidecars y directorios se filtran acá dentro). Ausente si error. */
  landing?: OneLakeEntry[]
  /** Corridas del trigger. Ausente si el slot es land-only o si la lectura falló. */
  runs?: RunRecord[]
  /** El intento FALLÓ: qué lectura y por qué. Presente ⇒ `landing`/`runs` ausentes o parciales. */
  error?: string
  /**
   * El directorio del landing NO EXISTE (`listOrAbsent` → `absent`, o sea 404), distinguido de
   * «existe y está vacío» desde #161. NO es un error de lectura: la lectura respondió. Se observa
   * junto a `landing: []` —la proyección sigue registrando listado vacío— y el veredicto viaja por
   * la clasificación, no por la proyección.
   *
   * Solo `true` o ausente: «no está ausente» ya lo dice el campo faltante, y un `false` explícito
   * invitaría a confundir «existe» con «no lo pude saber».
   */
  landingAbsent?: true
  /**
   * #162·§5 · corridas TERMINADAS consecutivas sin log correlacionable en `_logs/`, medidas en ESTE
   * tick (`contarCorridasSinLog`). Es medida del lazo, no clasificación: viaja a la proyección para
   * que la consola pueda mostrar el aviso del contrato sin listar almacenamiento en el request path.
   *
   * TRES valores, y la diferencia importa:
   *  · número — se midió: se persiste.
   *  · `null` — NO APLICA a este slot (sin `trigger`, `log: false`, motor o `_logs/` no cableados):
   *    limpia el valor persistido. Un slot que declaró `log: false` optó POR ESCRITO a no escribir
   *    logs por corrida; acusarlo de incumplir sería ruido contra una declaración legítima.
   *  · ausente — no se pudo medir (el listado de `_logs/` falló): NO se toca lo persistido, que pasa
   *    a ser «lo último conocido». No medir no es medir cero.
   */
  corridasSinLog?: number | null
}

/** Calidad de la medida — viaja SIEMPRE junto al estado del slot, en la alerta y en la superficie:
 *  el operador tiene que poder distinguir «está sano» de «no lo pude mirar». */
export type MedidaCalidad =
  | 'fresca'              // este tick leyó bien
  | 'ultima-conocida'     // este tick falló; se clasifica sobre la proyección
  | 'contradice-registro' // el listado llegó "bien" pero contradice lo que la plataforma sabe (§3.3)
  | 'ninguna'             // jamás se midió bien este slot (proyección fría)

// ─── §3.2 · El estado del slot ───────────────────────────────────────────────────────────────────

/**
 * Razones por las que un slot alerta al operador.
 *
 * `'contradice-registro'` NO está en la lista de §3.2 del diseño, que es donde el diseño enumera el
 * tipo; se agrega acá porque §3.3 del mismo diseño exige «se alerta al operador nombrando los
 * archivos que el registro esperaba ver» y ninguna de las otras cuatro razones dice eso
 * (`'sin-medida'` significa, literalmente, «≥3 ticks sin PODER medir» — acá se midió, y lo medido no
 * cuadra). Es una decisión de este hito sobre una tensión interna del diseño, no algo que el diseño
 * resuelva.
 */
export type SlotAlertReason =
  | 'varados'             // ≥1 archivo de datos excede la edad máxima en el landing
  | 'corrida-fallida'     // la última corrida del trigger terminó Failed
  | 'corrida-colgada'     // InProgress/NotStarted hace más de maxRunMinutes
  | 'sin-medida'          // el vigilante lleva ≥ SIN_MEDIDA_TICKS ticks sin poder medir
  | 'contradice-registro' // el listado llegó ok pero no trae NINGUNO de los archivos predichos (§3.3)

/** Lo que se persiste por slot para el dedup por transición y lo que la superficie muestra. */
export interface SlotWatchState {
  reason: SlotAlertReason
  medida: MedidaCalidad
}

/** Un archivo varado con la edad que lo delata (el aviso al operador la nombra). */
export interface ArchivoVarado {
  /** Basename tal como aterrizó. */
  file: string
  ageMinutes: number
}

/** Alerta ACTUAL de un slot. `slotId` es la clave del dedup por transición. */
export interface SlotAlert {
  slotId: string
  reason: SlotAlertReason
  /** Con qué calidad de medida se llegó a esta conclusión. */
  medida: MedidaCalidad
  /** `varados`: los archivos que excedieron la edad, con la suya. */
  varados?: ArchivoVarado[]
  /** `contradice-registro`: los archivos que el registro esperaba y el listado no trae. */
  esperados?: string[]
  /** `contradice-registro` por el DIRECTORIO: el landing no existe y la plataforma escribió ahí. */
  landingAusente?: true
  /** ISO de la última carga vivida registrada del slot — la evidencia de que la plataforma escribió
   *  en ese directorio. Acompaña a `landingAusente`; ausente si el registro no trajo fecha usable. */
  ultimaCargaAt?: string
  /** `corrida-fallida` / `corrida-colgada`: la corrida en cuestión. */
  run?: RunRecord
  /** `sin-medida` (y cualquier alerta emitida sobre lo último conocido): el error de la lectura. */
  lastError?: string
}

/** Resultado de clasificar un slot: qué alerta y con qué calidad se midió. */
export interface SlotClassification {
  medida: MedidaCalidad
  /** Ordenadas por prioridad (ver `PRIORIDAD`): la cabeza es la que va al dedup por transición,
   *  porque el estado persistido por slot es UNA razón (`SlotWatchState`). */
  alertas: SlotAlert[]
}

/** Umbrales del slot. Los defaults de §4.1 los resuelve el parse de `intake/slots.yaml`; acá entran
 *  ya resueltos, y `maxAgeMinutes` ausente significa «este slot no se vigila por edad». */
export interface SlotWatchConfig {
  /** Edad máxima en el landing (min). Ausente ⇒ jamás se emite `varados` (land-only sin `watch:`). */
  maxAgeMinutes?: number
  /** Corrida colgada (min). Default `DEFAULT_MAX_RUN_MINUTES`. */
  maxRunMinutes?: number
  /** Cadencia del lazo (ms), base del umbral de `sin-medida`. Default `DEFAULT_INTAKE_WATCH_MS`. */
  pollMs?: number
}

/** Lo último conocido del slot (§3.5): lo que la proyección sirve cuando este tick no pudo medir. */
export interface SlotProjection {
  /** ISO de la última observación EXITOSA. Un error no lo pisa (§3.5: el error solo escribe
   *  `last_error`/`last_error_at`), así que sirve de baseline para `sin-medida`. Ausente = jamás se
   *  midió bien este slot. */
  observedAt?: string
  landing?: OneLakeEntry[]
  runs?: RunRecord[]
  /** ISO del primer intento del vigilante sobre este slot. Baseline de `sin-medida` cuando NUNCA
   *  hubo medida buena: sin él, un slot roto desde el día uno no cruzaría jamás el umbral (su
   *  `observedAt` no existe) y la ceguera permanente sería la única que no alerta. */
  firstAttemptAt?: string
}

/** Insumos de la clasificación de UN slot. */
export interface SlotWatchInput {
  slotId: string
  /** La observación de este tick. */
  obs: SlotObservation
  /** Lo último conocido; se usa solo si `obs.error` (invariante 1). */
  projection?: SlotProjection
  /** Control positivo (§3.3): basenames que el registro predice en el landing —el resultado de
   *  `expectedInLanding`. Vacío/ausente = el registro no predice nada, y entonces un listado vacío
   *  no contradice a nadie. */
  expected?: string[]
  /**
   * Lo que la plataforma sabe de su propia escritura en el landing, SIN pretender saber qué archivos
   * siguen ahí. Insumo del control del DIRECTORIO (diseño 009·§4.2), el único que no necesita corte.
   *
   * `cargasVividas` = cuántas cargas ok registró el slot (#62). Con 0 no se acusa nada: un slot
   * recién declarado no tiene directorio hasta el primer `put`, y alertarlo sería una acusación
   * gratuita contra el estado normal de un slot virgen.
   */
  registro?: { cargasVividas: number; ultimaCargaAt?: string }
}

/** Orden de severidad. Primero lo que invalida la medida: si no se puede confiar en lo que se ve,
 *  el operador tiene que enterarse de ESO antes que de cualquier conclusión derivada de la vista. */
const PRIORIDAD: SlotAlertReason[] = ['contradice-registro', 'sin-medida', 'corrida-fallida', 'corrida-colgada', 'varados']

// ─── §3.3 · El control positivo contra el vacío-con-éxito ────────────────────────────────────────

/** Una carga registrada, en lo que este módulo necesita de ella (subconjunto de `IntakeUploadRow`). */
export interface CargaRegistrada {
  filename: string
  /** ISO. */
  uploadedAt: string
  /** false = subida rechazada: nunca aterrizó, así que no se espera en el landing. */
  ok: boolean
}

/** Un retiro manual del landing (evento `intake-retire` del audit log, verificado `admin.ts:1927`). */
export interface RetiroRegistrado {
  filename: string
  /** ISO del evento. */
  at: string
}

/**
 * Control positivo de §3.3: qué archivos DEBERÍA ver el listado del landing según lo que la
 * plataforma sabe de sí misma.
 *
 *   esperados = cargas ok con uploadedAt > inicio de la última corrida Completed conocida
 *             − archivos con un retiro posterior a esa carga
 *
 * El corte es la última corrida `Completed` porque esa corrida archiva a `_processed/` lo que
 * procesó [CONJETURA C2 del diseño: «los jobs archivan lo procesado en corridas Completed» está
 * declarado como contrato de ingesta (#62/#63) y usado por el retro-indexado, pero NO está medido en
 * todos los slots. Un slot que no archive produce esperados de más → falsa contradicción; el
 * experimento que la falsa: subir, esperar Completed, listar landing y `_processed/`].
 *
 * Sin ninguna corrida `Completed` conocida no hay corte: toda carga ok sigue esperándose.
 *
 * Devuelve basenames ordenados y sin repetir. PURA: sin reloj (el «ahora» no participa — se compara
 * el registro contra sí mismo).
 */
export function expectedInLanding(
  uploads: CargaRegistrada[],
  runs: RunRecord[],
  retiros: RetiroRegistrado[],
): string[] {
  const corte = (runs ?? [])
    .filter((r) => r?.status === 'Completed')
    .map((r) => Date.parse(r.startedAt))
    .filter((ms) => Number.isFinite(ms))
    .reduce<number | null>((max, ms) => (max == null || ms > max ? ms : max), null)

  // Por nombre queda la carga MÁS RECIENTE: una re-subida del mismo archivo reemplaza a la anterior
  // en el landing (el nombre es la identidad ahí; el sha identifica el contenido, que acá no importa).
  const ultimaPorNombre = new Map<string, number>()
  for (const u of uploads ?? []) {
    if (!u?.ok) continue
    const name = baseName(u.filename)
    if (!name) continue
    const at = Date.parse(u.uploadedAt)
    if (!Number.isFinite(at)) continue
    if (corte != null && at <= corte) continue
    const prev = ultimaPorNombre.get(name)
    if (prev == null || at > prev) ultimaPorNombre.set(name, at)
  }

  for (const r of retiros ?? []) {
    const name = baseName(r?.filename ?? '')
    const at = Date.parse(r?.at ?? '')
    const carga = ultimaPorNombre.get(name)
    // Solo el retiro POSTERIOR a la carga la cancela: uno anterior retiró otra cosa (una carga vieja
    // del mismo nombre), y descontar por él borraría un archivo que sí debería estar.
    if (carga != null && Number.isFinite(at) && at > carga) ultimaPorNombre.delete(name)
  }

  return [...ultimaPorNombre.keys()].sort()
}

// ─── La clasificación ────────────────────────────────────────────────────────────────────────────

/**
 * Clasifica un slot a un instante `nowMs`: con qué calidad se midió y qué alerta.
 *
 * El orden de las decisiones ES la lógica:
 *  1. Si la observación falló, la fuente pasa a ser la proyección — y si no hay proyección, el
 *     landing NO se clasifica (invariante 1: `[]` no es un hecho, es la ausencia de uno).
 *  2. Si la observación salió «bien» pero contradice lo que la plataforma sabe de sí misma —el
 *     registro predice archivos que el listado no trae, O el directorio del landing no existe
 *     teniendo cargas vividas—, la medida es `'contradice-registro'` y el landing TAMPOCO se
 *     clasifica (invariante 2: sobre un listado desmentido no se concluye ni «vacío» ni «varado»).
 *  3. Recién ahí se buscan varados sobre el listado, y corridas fallidas/colgadas sobre el
 *     historial. Las corridas vienen de OTRA fuente (el motor) con modos de falla independientes:
 *     un listado desmentido no las invalida, y por eso se clasifican igual.
 */
export function classifySlot(input: SlotWatchInput, config: SlotWatchConfig, nowMs: number): SlotClassification {
  const { slotId, obs } = input
  const proj = input.projection
  const fallo = obs.error != null
  const pollMs = config.pollMs ?? DEFAULT_INTAKE_WATCH_MS
  const maxRunMs = (config.maxRunMinutes ?? DEFAULT_MAX_RUN_MINUTES) * 60_000
  const alertas: SlotAlert[] = []

  // ── Calidad de la medida y fuente del landing ────────────────────────────────────────────────
  let medida: MedidaCalidad
  let landing: OneLakeEntry[] | null // null = NO clasificable (no es lo mismo que un listado vacío)
  let runs: RunRecord[] | undefined

  if (fallo) {
    const hayProyeccion = proj?.observedAt != null
    medida = hayProyeccion ? 'ultima-conocida' : 'ninguna'
    landing = hayProyeccion ? datos(proj?.landing ?? []) : null
    runs = hayProyeccion ? proj?.runs : undefined
  } else {
    medida = 'fresca'
    landing = datos(obs.landing ?? [])
    runs = obs.runs
    const esperados = (input.expected ?? []).filter((f) => f.length > 0)
    const vistos = new Set(landing.map((e) => baseName(e.path)))
    // (a) Control POR-ARCHIVO. «Sin NINGUNO de los predichos» (§3.3): con alguno presente el listado
    // es creíble y las ausencias tienen explicaciones ordinarias (una corrida en curso archivó parte
    // del lote).
    const faltanTodos = esperados.length > 0 && !esperados.some((f) => vistos.has(f))
    // (b) Control del DIRECTORIO (diseño 009·§4.2): el landing respondió 404 y la plataforma tiene
    // registradas cargas ok en ese mismo directorio. `cargasVividas ≥ 1` es lo que separa el control
    // de una acusación gratuita: el slot virgen (cero cargas) NO tiene directorio todavía.
    //
    // CONJETURA C6, GATE DE DESPLIEGUE, todavía SIN MEDIR contra OneLake real: que drenar TODOS los
    // archivos de un landing deje el directorio EXISTENTE (`listOrAbsent` → `ok` vacío, no `absent`).
    // Se asume por la semántica de ADLS Gen2 con namespace jerárquico —los directorios son objetos
    // explícitos— y está acotado por este lado: NINGÚN camino de Vergis borra el directorio (el
    // retiro y la reversión hacen `remove` del ARCHIVO, verificado en `intake-onelake.ts:206` e
    // `intake-revert.ts:211–240`), así que el riesgo vivo es el job/consumidor externo y la
    // semántica del propio OneLake. Experimento falsador: vaciar por completo el landing de un slot
    // real y consultar `listOrAbsent` — debe dar `ok` con lista vacía. Si diera `absent`, este
    // control fabricaría una contradicción tras cada drenaje total y SE RETIRA (es el mismo ruido
    // que §4.1 evita); el control por-archivo y `sin-medida` quedan intactos.
    const cargasVividas = input.registro?.cargasVividas ?? 0
    const directorioAusente = obs.landingAbsent === true && cargasVividas >= 1
    if (faltanTodos || directorioAusente) {
      medida = 'contradice-registro'
      // Invariante 2: sobre un listado desmentido no se concluye ni «vacío» ni «varado».
      landing = null
      // UNA sola alerta aunque las dos evidencias apliquen: el estado persistido por slot es UNA
      // razón, y partirla en dos avisos contaría dos problemas donde hay uno.
      const a: SlotAlert = { slotId, reason: 'contradice-registro', medida }
      if (faltanTodos) a.esperados = esperados
      if (directorioAusente) {
        a.landingAusente = true
        if (input.registro?.ultimaCargaAt) a.ultimaCargaAt = input.registro.ultimaCargaAt
      }
      alertas.push(a)
    }
  }

  // ── `sin-medida`: el vigilante lleva ≥ SIN_MEDIDA_TICKS sin poder medir ──────────────────────
  if (fallo) {
    const baseline = Date.parse(proj?.observedAt ?? proj?.firstAttemptAt ?? '')
    if (Number.isFinite(baseline) && nowMs - baseline >= SIN_MEDIDA_TICKS * pollMs) {
      const a: SlotAlert = { slotId, reason: 'sin-medida', medida }
      if (obs.error != null) a.lastError = obs.error
      alertas.push(a)
    }
  }

  // ── `varados`: archivos que envejecen en el landing ──────────────────────────────────────────
  if (landing != null && config.maxAgeMinutes != null) {
    const maxAgeMs = config.maxAgeMinutes * 60_000
    const varados: ArchivoVarado[] = []
    for (const e of landing) {
      const t = Date.parse(e.lastModified)
      // Sin fecha parseable no hay edad. `OneLakeEntry.lastModified` es `''` cuando el DFS no la trae
      // (verificado, `intake-onelake.ts`): inventarle una edad sería fabricar un varado.
      if (!Number.isFinite(t)) continue
      const ageMs = nowMs - t
      if (ageMs > maxAgeMs) varados.push({ file: baseName(e.path), ageMinutes: Math.floor(ageMs / 60_000) })
    }
    if (varados.length > 0) {
      const a: SlotAlert = { slotId, reason: 'varados', medida, varados }
      if (fallo && obs.error != null) a.lastError = obs.error
      alertas.push(a)
    }
  }

  // ── Corridas: fallida o colgada ──────────────────────────────────────────────────────────────
  const ultima = ultimaCorrida(runs)
  if (ultima) {
    if (ultima.status === 'Failed') {
      const a: SlotAlert = { slotId, reason: 'corrida-fallida', medida, run: ultima }
      if (fallo && obs.error != null) a.lastError = obs.error
      alertas.push(a)
    } else if (ultima.status === 'InProgress' || ultima.status === 'NotStarted') {
      const iniciada = Date.parse(ultima.startedAt)
      if (Number.isFinite(iniciada) && nowMs - iniciada > maxRunMs) {
        const a: SlotAlert = { slotId, reason: 'corrida-colgada', medida, run: ultima }
        if (fallo && obs.error != null) a.lastError = obs.error
        alertas.push(a)
      }
    }
  }

  alertas.sort((a, b) => PRIORIDAD.indexOf(a.reason) - PRIORIDAD.indexOf(b.reason))
  return { medida, alertas }
}

/** Alertas actuales de un lote de slots — la entrada del dedup por transición del lazo. Una por
 *  slot: la de mayor prioridad, porque el estado persistido por slot es UNA razón (§3.2). */
export function intakeAlerts(
  slots: { input: SlotWatchInput; config: SlotWatchConfig }[],
  nowMs: number,
): SlotAlert[] {
  const out: SlotAlert[] = []
  for (const s of slots) {
    const alerta = classifySlot(s.input, s.config, nowMs).alertas[0]
    if (alerta) out.push(alerta)
  }
  return out
}

// ─── Estado persistido ───────────────────────────────────────────────────────────────────────────

/**
 * Lee el estado de alertas de la vigilancia persistido en `platform_setting`. Mismo contrato que
 * `parseAlertState` (frescura): el dedup por transición solo funciona si el estado SOBREVIVE al
 * reinicio — en RAM, cada restart re-notifica todo lo que siga roto, ruido que entrena a ignorar
 * la alerta.
 *
 * Fail-safe por diseño: valor corrupto o de una forma vieja ⇒ `{}`. El costo de equivocarse es una
 * notificación de más (recuperable); el de reventar el vigilante, quedarse ciego.
 */
export function parseIntakeWatchState(raw: string | null): Record<string, SlotAlertReason> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, SlotAlertReason> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (esRazon(val)) out[k] = val
    }
    return out
  } catch {
    return {}
  }
}

// ─── Ayudas ──────────────────────────────────────────────────────────────────────────────────────

const RAZONES: readonly SlotAlertReason[] = PRIORIDAD

const esRazon = (v: unknown): v is SlotAlertReason => typeof v === 'string' && (RAZONES as readonly string[]).includes(v)

/** Basename de una ruta del Lakehouse (`Files/intake/oc/x.xlsx` → `x.xlsx`). */
const baseName = (p: string): string => String(p ?? '').replace(/^.*\//, '')

/** Archivos de DATOS del listado: sin directorios y sin sidecars (`isSidecarName`, ya compartido). */
const datos = (entries: OneLakeEntry[]): OneLakeEntry[] => entries.filter((e) => e && !e.isDirectory && !isSidecarName(e.path))

/** La corrida más reciente por arranque; undefined si no hay historial (o no se pudo leer). */
function ultimaCorrida(runs: RunRecord[] | undefined): RunRecord | undefined {
  if (!runs || runs.length === 0) return undefined
  return [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
}
