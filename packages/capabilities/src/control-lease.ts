import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * El lease de control — el plano de control único del nodo.
 *
 * Los stores embebidos del nodo se vuelcan COMPLETOS en cada persist, y los lazos de fondo
 * (frescura, intake, purga, reporte, re-ingesta) escriben y reconcilian **sin depender del tráfico**:
 * dos nodos vivos sobre el mismo volumen serían dos controladores. Este módulo produce la garantía
 * de que hay **exactamente uno**, por protocolo y no por motor: quien tiene el lease controla; quien
 * no lo tiene sirve lecturas y no arma un solo lazo.
 *
 * ── El contrato ────────────────────────────────────────────────────────────────────────────────
 * Un archivo JSON en el volumen de gobierno (`${VERGIS_OUT}/control.lease.json`) con la forma
 * `{ holder, ring, epoch, renewedAt, pid }`:
 *
 * - **Adquisición**: se intenta crear con `wx` (exclusivo — la exclusión la da el FS, no un chequeo
 *   nuestro). Si ya existe, se lee: un titular que renovó hace menos de `staleMs` está vivo y no se
 *   le quita nada; uno más viejo se **releva** con `epoch+1` (write a tmp propio + rename), se espera
 *   un período de renovación y se **relee para confirmar** que el titular es uno mismo. Si no lo es,
 *   se perdió la carrera: back-off y reintento, sin creerse dueño ni un instante.
 * - **Renovación**: rewrite atómico cada `renewMs`. Cada renovación **relee antes de escribir**: si
 *   el titular ya no es uno mismo, el control se perdió y se avisa (`onLost`) en vez de seguir
 *   creyéndose dueño.
 * - **Release ordenado**: se deja una **marca de release** (titular vacío, la época se conserva) para
 *   que el sucesor adquiera de inmediato, sin pagar el stale window. El release tiene además una
 *   variante **síncrona** (`releaseSync`) para el único llamador que no puede esperar una promesa: el
 *   handler de salida del proceso, que es lo que impide que un arranque muerto por excepción retenga
 *   el control (#228). Un nodo que nunca llegó a servir no se queda con el plano de control.
 * - **La época es monótona y creciente**: cada cambio de titular la incrementa. Es la misma época que
 *   los stores estampan en `control_meta` (ver `sqlite.ts`), así que un handle de un titular anterior
 *   se topa con el gate de época al abrir en escritura: el lease previene, el gate delata.
 *
 * ── La ley que manda sobre cualquier optimización ──────────────────────────────────────────────
 * Ante duda —carrera perdida, reloj que va al revés, archivo ilegible— se falla hacia **CERO**
 * controladores, jamás hacia dos, y se grita en el log. Un relevo agresivo no es una mejora: es el
 * bug que este módulo existe para no tener. Consecuencia aceptada: un archivo de lease corrupto deja
 * al nodo en standby hasta que una persona lo mire; el precio de la alternativa es que dos nodos se
 * pisen las escrituras en silencio.
 *
 * ── Limitación declarada ───────────────────────────────────────────────────────────────────────
 * El lease asume **un host con FS local**: la atomicidad del `rename` y la comparabilidad de los
 * relojes son del mismo kernel. Un volumen de red (NFS/SMB) compartido entre hosts con relojes
 * desfasados queda **fuera de contrato** — ahí el stale window deja de ser medible y la exclusión no
 * se sostiene. El modo `single` es la salida para quien corre un solo nodo a la antigua.
 *
 * Borrar el archivo de lease a mano también queda fuera de contrato: rompe la monotonía de la época
 * (un aspirante nuevo empezaría en 1 con stores estampados en N). No hay pérdida silenciosa — el gate
 * de época del store se niega a abrir en escritura y lo nombra —, pero el nodo queda sin control
 * hasta que alguien lo resuelva.
 */

// ─── Modo del plano de control ─────────────────────────────────────────────────────────────────

/** `lease` = plano de control único por lease (default de la caja). `single` = un solo nodo, sin lease. */
export type ControlMode = 'lease' | 'single'

export const CONTROL_LEASE_FILENAME = 'control.lease.json'
export const DEFAULT_RENEW_MS = 2_000
export const DEFAULT_STALE_MS = 10_000

/** Ruta del archivo de lease en el volumen de gobierno. */
export function controlLeaseFile(outDir: string): string {
  return `${outDir.replace(/\/$/, '')}/${CONTROL_LEASE_FILENAME}`
}

// ─── El INTENT de handover: quién es el sucesor de este relevo ─────────────────────────────────

/**
 * EL INTENT DE HANDOVER — `${VERGIS_OUT}/control.handover.json`, hermano del archivo de lease.
 *
 * Lo escribe **el operador del acto** (la herramienta de anillos, antes de pedirle al activo que
 * suelte) y lo consumen los aspirantes al entrar al relevo:
 *
 *   `{ "successor": "<anillo>", "expiresAt": "<ISO-8601>" }`
 *
 * Qué produce, y qué NO:
 *
 * - **Ordena la fila**: un aspirante que el intent NO nombra se abstiene de aspirar mientras el
 *   intent esté vigente; el nombrado aspira **ya**, sin esperar la ventana de gracia que se impone a
 *   sí mismo el nodo que acaba de soltar.
 * - **JAMÁS otorga el control.** Adquirir sigue siendo `acquire()` con sus reglas enteras (marca de
 *   release, stale window, época monótona, confirmación por relectura). El fencing no se toca. El
 *   modo de falla sigue siendo hacia **cero** controladores, nunca hacia dos.
 *
 * **Alcance de lo que garantiza (cierre PARCIAL de #232, por diseño).** `releaseSync()` deja
 * `{holder:'', epoch}` y `#attempt()` concede ese archivo al PRIMERO que llegue sin mirar quién: el
 * intent ordena la fila SOLO entre quienes pasan por `intentarRelevo`; la marca de release sigue
 * siendo subasta abierta para cualquier camino que no pase por ahí. Es una decisión de diseño —el
 * intent no es autoridad—, no un hueco por tapar: convertirlo en autoridad exigiría meterlo dentro
 * de `acquire()`, que es exactamente lo que este frente no hace.
 *
 * **Vencimiento**: un intent con `expiresAt` pasado es **inexistente**. Sin eso, un intent huérfano
 * —la herramienta murió tras escribirlo, o el sucesor nombrado nunca llegó— congelaría los relevos
 * para siempre: los demás aspirantes se abstendrían de un turno que nadie va a tomar. Pasado el
 * plazo rige el protocolo de siempre (marca de release y stale window).
 *
 * **Ilegible = inexistente, y ruidoso**: un archivo a medio escribir o con otra forma no manda. Se
 * prefiere el protocolo de siempre antes que congelar el relevo por un archivo que nadie entiende.
 */
export const CONTROL_HANDOVER_FILENAME = 'control.handover.json'

/** Ruta del intent de handover en el volumen de gobierno. */
export function controlHandoverFile(outDir: string): string {
  return `${outDir.replace(/\/$/, '')}/${CONTROL_HANDOVER_FILENAME}`
}

/** El intent tal como vive en el archivo. */
export interface HandoverIntent {
  /** Identidad del anillo sucesor: el mismo valor que el nodo lleva en `VERGIS_RING`. */
  successor: string
  /** Instante (ISO-8601) tras el cual el intent deja de mandar. */
  expiresAt: string
}

/** Qué dice el intent respecto de ESTE nodo. Vocabulario cerrado, reportable en el log. */
export type HandoverVerdict = 'sin-intent' | 'nombrado' | 'ajeno' | 'vencido' | 'ilegible'

export interface HandoverReading {
  verdict: HandoverVerdict
  /** El intent leído, cuando se pudo parsear (también si está vencido o nombra a otro). */
  intent?: HandoverIntent
  detail?: string
}

function parseIntent(raw: string): HandoverIntent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const { successor, expiresAt } = parsed
  if (typeof successor !== 'string' || successor === '') return null
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) return null
  return { successor, expiresAt }
}

/**
 * Lee el intent y lo juzga respecto de `self` (la identidad de anillo de este nodo, `VERGIS_RING`).
 * Un nodo SIN identidad de anillo (`self` nulo o vacío) no puede ser nombrado jamás: ante un intent
 * vigente queda `ajeno`, que es la lectura correcta —no es el sucesor— y no un caso especial.
 */
export function readHandoverIntent(file: string, self: string | null, now: number = Date.now()): HandoverReading {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return { verdict: 'sin-intent' }
    return { verdict: 'ilegible', detail: `el intent de handover no se pudo leer: ${(e as Error).message}` }
  }
  const intent = parseIntent(raw)
  if (!intent) return { verdict: 'ilegible', detail: 'el intent de handover no tiene la forma esperada; no manda' }
  if (Date.parse(intent.expiresAt) <= now) {
    return { verdict: 'vencido', intent, detail: `el intent nombraba a '${intent.successor}' y venció el ${intent.expiresAt}` }
  }
  if (self && intent.successor === self) return { verdict: 'nombrado', intent }
  return { verdict: 'ajeno', intent, detail: `el intent vigente nombra a '${intent.successor}', no a '${self ?? '(nodo sin identidad de anillo)'}'` }
}

export interface RelevoDecision {
  /** ¿Corresponde intentar `acquire()` ahora mismo? */
  aspirar: boolean
  verdict: HandoverVerdict
  /** `true` cuando el intent nombra a este nodo y por eso se ignora la ventana de gracia propia. */
  saltaGracia: boolean
  detail?: string
}

/**
 * La decisión de entrada al relevo: intent primero, ventana de gracia después. Pura respecto del
 * lease —no lo toca ni lo consulta—: quien la llama decide si invoca `acquire()`, y `acquire()` sigue
 * siendo el único que otorga el control.
 */
export function evaluarRelevo(args: { file: string; self: string | null; noAspirarHasta: number; now?: number }): RelevoDecision {
  const now = args.now ?? Date.now()
  const r = readHandoverIntent(args.file, args.self, now)
  if (r.verdict === 'nombrado') {
    return { aspirar: true, verdict: r.verdict, saltaGracia: true, detail: `el intent de handover nombra a este nodo ('${args.self}')` }
  }
  if (r.verdict === 'ajeno') {
    return { aspirar: false, verdict: r.verdict, saltaGracia: false, detail: r.detail }
  }
  // `sin-intent`, `vencido` e `ilegible` caen todos al protocolo de siempre.
  return { aspirar: now >= args.noAspirarHasta, verdict: r.verdict, saltaGracia: false, detail: r.detail }
}

type Env = Record<string, string | undefined>

/** Config del plano de control resuelta UNA vez desde el entorno; quien la consuma no re-parsea envs. */
export interface ControlPlaneConfig {
  mode: ControlMode
  /** Archivo de lease (siempre resuelto, aunque el modo sea `single`, para poder reportarlo). */
  file: string
  renewMs: number
  staleMs: number
}

function envNum(env: Env, key: string, def: number): number {
  const raw = env[key]
  if (raw == null || raw === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Config inválida: ${key}='${raw}' no es un número de milisegundos válido.`)
  }
  return Math.trunc(n)
}

/**
 * Resuelve el modo y los tiempos del plano de control desde el entorno. El default de la caja es
 * `lease`; un valor desconocido en `VERGIS_CONTROL` **no** se interpreta con buena voluntad — se
 * rechaza nombrando los válidos, porque adivinar acá es adivinar cuántos controladores hay.
 */
export function resolveControlPlaneConfig(env: Env, outDir: string): ControlPlaneConfig {
  const raw = (env['VERGIS_CONTROL'] ?? '').trim().toLowerCase()
  const mode: ControlMode = raw === '' ? 'lease' : raw === 'lease' || raw === 'single' ? raw : unknownMode(raw)
  const renewMs = envNum(env, 'VERGIS_LEASE_RENEW_MS', DEFAULT_RENEW_MS)
  const staleMs = envNum(env, 'VERGIS_LEASE_STALE_MS', DEFAULT_STALE_MS)
  return { mode, file: controlLeaseFile(outDir), renewMs, staleMs }
}

function unknownMode(raw: string): never {
  throw new Error(`Config inválida: VERGIS_CONTROL='${raw}' no existe. Válidos: 'lease' (default) o 'single'.`)
}

// ─── Contrato del plano de control ─────────────────────────────────────────────────────────────

/** El registro tal como vive en el archivo. `holder` vacío = marca de release. */
export interface ControlLeaseRecord {
  holder: string
  ring: string | null
  epoch: number
  renewedAt: string
  pid: number
}

/** Por qué este nodo no tiene (o dejó de tener) el control. Vocabulario cerrado, reportable. */
export type ControlLeaseReason =
  | 'held-by-other'
  | 'lost-race'
  | 'taken-over'
  | 'file-unreadable'
  | 'clock-skew'
  | 'file-vanished'
  | 'released'

export interface ControlLeaseStatus {
  mode: ControlMode
  file: string
  /** Identidad de ESTE aspirante (no la del titular vigente). */
  holder: string
  ring: string | null
  /** `true` si este nodo tiene el control ahora mismo. */
  held: boolean
  /** Época con la que este nodo controla (0 = nunca controló). */
  epoch: number
  /** Titular leído del archivo en la última operación (vacío = marca de release, `undefined` = sin leer). */
  observedHolder?: string
  /** Época leída del archivo en la última operación. */
  observedEpoch?: number
  observedRenewedAt?: string
  acquiredAt?: string
  lastRenewAt?: string
  acquireAttempts: number
  renews: number
  takeovers: number
  /** Motivo del último «no tengo el control»; se conserva para que un reporte de salud lo diga. */
  reason?: ControlLeaseReason
  reasonDetail?: string
}

/**
 * Lo que el server consume. `epoch` es un `EpochProvider` de `sqlite.ts`: se pasa tal cual al
 * `control` de cada store, y así la época del lease llega al archivo sin que nadie la copie a mano.
 */
export interface ControlPlane {
  readonly mode: ControlMode
  /** Intenta tomar el control. `true` = lo tiene. Nunca lanza por una carrera perdida. */
  acquire(): Promise<boolean>
  /** Renueva el heartbeat. `false` = se perdió el control (y `status().reason` dice por qué). */
  renew(): Promise<boolean>
  /** Suelta el control de forma ordenada, dejando la marca de release. Idempotente. */
  release(): Promise<void>
  /**
   * Lo mismo que `release()`, SÍNCRONO. Existe para el único sitio donde no hay await posible: un
   * handler de `process.on('exit')` — el camino por el que un arranque que muere por excepción deja
   * de retener el plano de control (#228). Idempotente, y no pisa a un sucesor.
   */
  releaseSync(): void
  status(): ControlLeaseStatus
  /** El predicado que gatea lazos y mutaciones. */
  hasControl(): boolean
  /** Época vigente, como proveedor: `control: { epoch: plane.epoch }` en cada store. */
  readonly epoch: () => number
}

export interface ControlLeaseOptions {
  /** Archivo de lease. */
  file: string
  /** Identidad de este aspirante (algo estable y legible: `vergis@<host>/<pid>`). */
  holder: string
  /** Anillo que este nodo ejecuta (versión+digest). Informativo, viaja en el registro. */
  ring?: string | null
  renewMs?: number
  staleMs?: number
  /** Intentos de adquisición antes de devolver `false`. Default 3. */
  maxAttempts?: number
  /** Arrancar el heartbeat solo al adquirir. Default `true`. `false` = el llamador renueva a mano. */
  autoRenew?: boolean
  /** Reloj inyectable (tests). Default `Date.now`. */
  now?: () => number
  /** Espera inyectable (tests). Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
  /** Fuente de jitter del back-off. Default `Math.random`. */
  random?: () => number
  /** Se invoca cuando este nodo DEJA de tener el control sin haberlo soltado él. */
  onLost?: (reason: ControlLeaseReason, detail: string) => void
  /** Log inyectable; default `console`. Lo ruidoso es parte del contrato, no un detalle. */
  log?: (level: 'warn' | 'error', message: string) => void
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Parsea el registro con desconfianza: cualquier forma inesperada es «ilegible», no un default. */
function parseRecord(raw: string): ControlLeaseRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const { holder, ring, epoch, renewedAt, pid } = parsed
  if (typeof holder !== 'string') return null
  if (!Number.isInteger(epoch) || (epoch as number) < 0) return null
  if (typeof renewedAt !== 'string' || !Number.isFinite(Date.parse(renewedAt))) return null
  return {
    holder,
    ring: typeof ring === 'string' ? ring : null,
    epoch: epoch as number,
    renewedAt,
    pid: typeof pid === 'number' ? pid : 0,
  }
}

/** El lease de control sobre un archivo. Ver la cabecera del módulo para el protocolo completo. */
export class ControlLease implements ControlPlane {
  readonly mode: ControlMode = 'lease'
  readonly #file: string
  readonly #holder: string
  readonly #ring: string | null
  readonly #renewMs: number
  readonly #staleMs: number
  readonly #maxAttempts: number
  readonly #autoRenew: boolean
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #random: () => number
  readonly #onLost?: (reason: ControlLeaseReason, detail: string) => void
  readonly #log: (level: 'warn' | 'error', message: string) => void

  #held = false
  #epoch = 0
  #timer: NodeJS.Timeout | undefined
  #status: ControlLeaseStatus

  constructor(opts: ControlLeaseOptions) {
    this.#file = opts.file
    this.#holder = opts.holder
    this.#ring = opts.ring ?? null
    this.#renewMs = opts.renewMs ?? DEFAULT_RENEW_MS
    this.#staleMs = opts.staleMs ?? DEFAULT_STALE_MS
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
    this.#autoRenew = opts.autoRenew ?? true
    this.#now = opts.now ?? Date.now
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.#random = opts.random ?? Math.random
    this.#onLost = opts.onLost
    this.#log =
      opts.log ??
      ((level, message) => {
        if (level === 'error') console.error(message)
        else console.warn(message)
      })
    this.#status = {
      mode: 'lease',
      file: this.#file,
      holder: this.#holder,
      ring: this.#ring,
      held: false,
      epoch: 0,
      acquireAttempts: 0,
      renews: 0,
      takeovers: 0,
    }
  }

  // La época como proveedor: se pasa al `control` de cada store y se lee en cada persist.
  readonly epoch = (): number => this.#epoch

  hasControl(): boolean {
    return this.#held
  }

  status(): ControlLeaseStatus {
    return { ...this.#status, held: this.#held, epoch: this.#epoch }
  }

  async acquire(): Promise<boolean> {
    if (this.#held) return true
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      this.#status.acquireAttempts += 1
      const outcome = await this.#attempt()
      if (outcome === 'won') return true
      if (outcome === 'refuse') return false // ilegible o reloj raro: cero controladores, y ya se gritó
      // 'busy' | 'lost': el titular está vivo o ganó la carrera. Back-off con jitter para no
      // sincronizar a dos aspirantes en un ciclo de relevos mutuos.
      if (attempt < this.#maxAttempts) await this.#sleep(this.#renewMs + Math.floor(this.#random() * this.#renewMs))
    }
    return false
  }

  async #attempt(): Promise<'won' | 'busy' | 'lost' | 'refuse'> {
    // 1) Camino limpio: el archivo no existe. La exclusión la da `wx`, no un chequeo nuestro.
    const creado = this.#tryCreateExclusive()
    if (creado === 'created') {
      // Relectura de confirmación: barata, y evita cualquier suposición sobre el FS.
      const leido = this.#read()
      if (leido !== 'ok') return this.#refuse(leido)
      if (!this.#observedIsMine()) return this.#lostRace('otro aspirante escribió el archivo que acabábamos de crear')
      this.#epoch = this.#observed!.epoch
      this.#takeHold()
      return 'won'
    }
    if (creado === 'error') return 'refuse'

    // 2) El archivo existe: se lee y se juzga.
    const leido = this.#read()
    if (leido !== 'ok') return this.#refuse(leido)
    const actual = this.#observed!

    if (actual.holder === this.#holder && actual.pid === process.pid) {
      // Reencuentro con nuestro propio registro (reinicio del mismo proceso no es posible, pero un
      // acquire re-entrante sí): se adopta sin relevo ni bump.
      this.#epoch = actual.epoch
      this.#takeHold()
      return 'won'
    }

    if (actual.holder === '') {
      // Marca de release: el titular soltó de forma ordenada. Se adquiere sin esperar el stale window.
      return (await this.#claim(actual.epoch + 1, false)) ? 'won' : 'lost'
    }

    const edad = this.#now() - Date.parse(actual.renewedAt)
    if (edad < -this.#staleMs) {
      // El titular renovó «en el futuro»: relojes incomparables. No se releva a ciegas.
      return this.#refuse('clock-skew', `el titular '${actual.holder}' renovó ${-edad} ms en el futuro`)
    }
    if (edad <= this.#staleMs) {
      this.#status.reason = 'held-by-other'
      this.#status.reasonDetail = `'${actual.holder}' (época ${actual.epoch}) renovó hace ${edad} ms`
      return 'busy'
    }

    // 3) Relevo: el titular dejó de renovar. Época+1, y confirmación tras un período de renovación.
    return (await this.#claim(actual.epoch + 1, true)) ? 'won' : 'lost'
  }

  /**
   * Escribe el registro reclamando el control y **confirma releyendo**. Con `esperar` se aguarda un
   * período de renovación antes de confirmar: si otro aspirante también reclamó, el último rename
   * gana y el que no quedó escrito se retira. Nadie se cree dueño por haber escrito.
   */
  async #claim(epoch: number, esperar: boolean): Promise<boolean> {
    const record: ControlLeaseRecord = {
      holder: this.#holder,
      ring: this.#ring,
      epoch,
      renewedAt: new Date(this.#now()).toISOString(),
      pid: process.pid,
    }
    if (!this.#writeAtomic(record)) return false
    if (esperar) {
      this.#status.takeovers += 1
      await this.#sleep(this.#renewMs)
    }
    const leido = this.#read()
    if (leido !== 'ok') {
      this.#refuse(leido)
      return false
    }
    if (!this.#observedIsMine() || this.#observed!.epoch !== epoch) {
      this.#lostRace(
        `tras reclamar la época ${epoch}, el archivo declara a '${this.#observed!.holder}' con la época ${this.#observed!.epoch}`,
      )
      return false
    }
    this.#epoch = epoch
    this.#takeHold()
    return true
  }

  async renew(): Promise<boolean> {
    if (!this.#held) return false
    const leido = this.#read()
    if (leido === 'file-vanished') {
      // Alguien borró el archivo bajo nuestros pies. No se recrea a ciegas: un aspirante pudo haberlo
      // tomado con `wx` en el intervalo, y recrear sería el segundo controlador.
      return this.#loseHold('file-vanished', 'el archivo de lease desapareció')
    }
    if (leido !== 'ok') return this.#loseHold(leido, this.#status.reasonDetail ?? 'archivo de lease ilegible')
    const actual = this.#observed!
    if (actual.holder !== this.#holder || actual.epoch !== this.#epoch) {
      return this.#loseHold(
        'taken-over',
        `el control pasó a '${actual.holder}' con la época ${actual.epoch} (esta era la ${this.#epoch})`,
      )
    }
    const escrito = this.#writeAtomic({
      holder: this.#holder,
      ring: this.#ring,
      epoch: this.#epoch,
      renewedAt: new Date(this.#now()).toISOString(),
      pid: process.pid,
    })
    if (!escrito) return this.#loseHold('file-unreadable', 'no se pudo escribir la renovación del lease')
    this.#status.renews += 1
    this.#status.lastRenewAt = new Date(this.#now()).toISOString()
    return true
  }

  async release(): Promise<void> {
    this.releaseSync()
  }

  /**
   * El release, síncrono. TODO el trabajo del release ordenado ya era síncrono (`readFileSync` +
   * `renameSync`); esta variante existe porque hay un llamador que **no puede** esperar una promesa:
   * el handler de `process.on('exit')` que suelta el control cuando el arranque muere por excepción
   * (#228). Node corre los handlers de `exit` de forma síncrona y no le da al proceso otro turno de
   * event loop, así que un `await` ahí no se completa nunca.
   */
  releaseSync(): void {
    this.stopRenewals()
    if (!this.#held) return
    this.#held = false
    this.#status.reason = 'released'
    this.#status.reasonDetail = 'este nodo soltó el control de forma ordenada'
    const leido = this.#read()
    if (leido === 'ok' && !this.#observedIsMine()) {
      // El control ya no era nuestro: no se pisa al sucesor con una marca de release.
      return
    }
    // Marca de release: titular vacío, la ÉPOCA SE CONSERVA — el sucesor la incrementa y adquiere de
    // inmediato, sin pagar el stale window.
    this.#writeAtomic({
      holder: '',
      ring: null,
      epoch: this.#epoch,
      renewedAt: new Date(this.#now()).toISOString(),
      pid: 0,
    })
  }

  /** Arranca el heartbeat. Idempotente; el timer va `unref` para no sostener el proceso. */
  startRenewals(): void {
    if (this.#timer || this.#renewMs <= 0) return
    const t = setInterval(() => {
      void this.renew()
    }, this.#renewMs)
    t.unref?.()
    this.#timer = t
  }

  /** Detiene el heartbeat. Idempotente. */
  stopRenewals(): void {
    if (!this.#timer) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  // ─── Interno ─────────────────────────────────────────────────────────────────────────────────

  #observed: ControlLeaseRecord | undefined

  #takeHold(): void {
    this.#held = true
    this.#status.acquiredAt = new Date(this.#now()).toISOString()
    this.#status.lastRenewAt = this.#status.acquiredAt
    this.#status.reason = undefined
    this.#status.reasonDetail = undefined
    if (this.#autoRenew) this.startRenewals()
  }

  #loseHold(reason: ControlLeaseReason, detail: string): false {
    this.#held = false
    this.stopRenewals()
    this.#status.reason = reason
    this.#status.reasonDetail = detail
    this.#log('error', `[control] LEASE PERDIDO en '${this.#file}': ${detail}. Este nodo queda sin control.`)
    this.#onLost?.(reason, detail)
    return false
  }

  #observedIsMine(): boolean {
    return this.#observed?.holder === this.#holder && this.#observed?.pid === process.pid
  }

  #refuse(reason: ControlLeaseReason, detail?: string): 'refuse' {
    this.#status.reason = reason
    this.#status.reasonDetail = detail ?? this.#status.reasonDetail
    this.#log(
      'error',
      `[control] NO SE TOMA EL CONTROL sobre '${this.#file}': ${this.#status.reasonDetail ?? reason}. ` +
        `Ante duda se falla hacia CERO controladores; este nodo queda en standby.`,
    )
    return 'refuse'
  }

  #lostRace(detail: string): 'lost' {
    this.#status.reason = 'lost-race'
    this.#status.reasonDetail = detail
    this.#log('warn', `[control] carrera perdida sobre '${this.#file}': ${detail}. No se toma el control.`)
    return 'lost'
  }

  /** `created` | `exists` | `error`. `wx` es la exclusión: si dos crean, uno recibe EEXIST. */
  #tryCreateExclusive(): 'created' | 'exists' | 'error' {
    const record: ControlLeaseRecord = {
      holder: this.#holder,
      ring: this.#ring,
      epoch: 1,
      renewedAt: new Date(this.#now()).toISOString(),
      pid: process.pid,
    }
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileSync(this.#file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
      return 'created'
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') return 'exists'
      this.#status.reason = 'file-unreadable'
      this.#status.reasonDetail = `no se pudo crear el archivo de lease: ${(e as Error).message}`
      this.#log('error', `[control] ${this.#status.reasonDetail}`)
      return 'error'
    }
  }

  /** `ok` | `file-vanished` | `file-unreadable`. Deja lo leído en `#observed` cuando es `ok`. */
  #read(): 'ok' | 'file-vanished' | 'file-unreadable' {
    let raw: string
    try {
      raw = readFileSync(this.#file, 'utf8')
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') {
        this.#observed = undefined
        this.#status.observedHolder = undefined
        this.#status.observedEpoch = undefined
        this.#status.reasonDetail = 'el archivo de lease no existe'
        return 'file-vanished'
      }
      this.#status.reasonDetail = `el archivo de lease no se pudo leer: ${(e as Error).message}`
      return 'file-unreadable'
    }
    const record = parseRecord(raw)
    if (!record) {
      this.#observed = undefined
      this.#status.reasonDetail =
        'el archivo de lease no tiene la forma esperada; no se puede juzgar si hay un titular vivo'
      return 'file-unreadable'
    }
    this.#observed = record
    this.#status.observedHolder = record.holder
    this.#status.observedEpoch = record.epoch
    this.#status.observedRenewedAt = record.renewedAt
    return 'ok'
  }

  /**
   * Escritura atómica: tmp **propio de este proceso e irrepetible** + rename. Dos escritores que
   * compartieran el tmp se mezclarían el volcado antes del rename y el rename entregaría un archivo
   * íntegro con contenido de los dos.
   */
  #writeAtomic(record: ControlLeaseRecord): boolean {
    const tmp = `${this.#file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
      renameSync(tmp, this.#file)
      return true
    } catch (e) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* el tmp huérfano no justifica enmascarar el error real */
      }
      this.#status.reasonDetail = `no se pudo escribir el archivo de lease: ${(e as Error).message}`
      this.#log('error', `[control] ${this.#status.reasonDetail}`)
      return false
    }
  }
}

/**
 * El plano de control del nodo único: sin lease, sin archivo, sin heartbeat — comportamiento idéntico
 * al de un Vergis que siempre controla. Es lo que produce `VERGIS_CONTROL=single`.
 */
export class SingleControlPlane implements ControlPlane {
  readonly mode: ControlMode = 'single'
  readonly #file: string
  readonly #holder: string
  readonly #ring: string | null
  #held = true

  constructor(opts: { file: string; holder: string; ring?: string | null }) {
    this.#file = opts.file
    this.#holder = opts.holder
    this.#ring = opts.ring ?? null
  }

  // Época 0: el nodo único no tiene relevo posible, así que no hay época que comparar.
  readonly epoch = (): number => 0

  hasControl(): boolean {
    return this.#held
  }

  async acquire(): Promise<boolean> {
    this.#held = true
    return true
  }

  async renew(): Promise<boolean> {
    return this.#held
  }

  async release(): Promise<void> {
    this.releaseSync()
  }

  releaseSync(): void {
    this.#held = false
  }

  status(): ControlLeaseStatus {
    return {
      mode: 'single',
      file: this.#file,
      holder: this.#holder,
      ring: this.#ring,
      held: this.#held,
      epoch: 0,
      acquireAttempts: 0,
      renews: 0,
      takeovers: 0,
    }
  }
}

/**
 * Construye el plano de control según la config resuelta del entorno. Es el único punto que el server
 * necesita: `createControlPlane(resolveControlPlaneConfig(process.env, outDir), { holder, ring })`.
 */
export function createControlPlane(
  config: ControlPlaneConfig,
  opts: Omit<ControlLeaseOptions, 'file' | 'renewMs' | 'staleMs'>,
): ControlPlane {
  if (config.mode === 'single') {
    return new SingleControlPlane({ file: config.file, holder: opts.holder, ring: opts.ring })
  }
  return new ControlLease({ ...opts, file: config.file, renewMs: config.renewMs, staleMs: config.staleMs })
}
