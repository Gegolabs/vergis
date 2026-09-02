/**
 * CONTRATO OPERATIVO CONSULTABLE (issue #139) — el nodo responde por sí mismo «¿este cambio exige
 * reiniciar?» y «¿tomaste mi archivo?».
 *
 * Principio rector: DERIVADO, NO DECLARADO. Un dato entra al contrato solo si la MISMA llamada que lo
 * produce lo registra — `registry.watch()` instala el watch Y lo registra (imposible que driften),
 * `registry.env()` lee la variable Y la marca como consumida. No hay arreglo estático que alguien deba
 * mantener a mano. La única excepción son los `caveats`: limitaciones emergentes no derivables, que se
 * registran COLOCADAS en el sitio del código que las posee.
 *
 * Fail-safe absoluto: el contrato JAMÁS afecta el serving. Todo error interno del registro se traga con
 * `console.error` y nunca propaga a `reloadGovernance`, al watcher ni al boot.
 *
 * Nunca expone VALORES de env ni secretos: solo NOMBRES de variables, rutas de archivo y hashes sha256
 * (que no revelan contenido).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { watchPaths } from './hot-reload'
import type { ContractJournal } from './contract-delta'
import { VERGIS_VERSION } from '../packages/capabilities/src/version'

/** Un watch instalado: qué envs lo configuran, qué rutas vigila y qué recarga cuando dispara. */
export interface WatchEntry {
  envs: string[]
  paths: string[]
  reloads: string
}

/** Un manejador de señal instalado (registrado junto a su `process.on`). */
export interface SignalEntry {
  signal: string
  action: string
}

/** Un artefacto EFECTIVAMENTE cargado por el proceso, con el hash de lo que se cargó. */
export interface ArtifactState {
  source: string
  path: string
  sha256: string
  loadedAt: string
}

/** Una recarga (o el boot, `reason: 'boot'`): cuándo, qué la disparó, con qué resultado. */
export interface ReloadEvent {
  at: string
  reason: string
  ok: boolean
  error?: string
  policies?: number
  servablePis?: number
}

/**
 * El PLANO DE CONTROL tal como el nodo lo vive (issue #210 · I6) — la sección que un conmutador de
 * anillos consulta para decidir si puede promover a este nodo sin adivinar.
 *
 * Derivado, no declarado, igual que el resto del contrato: cada sub-bloque sale de la MISMA pieza que
 * lo produce —el lease del plano de control, el registro de lazos, el guard de cada store embebido—,
 * así que no hay arreglo que alguien deba mantener al día.
 */
export interface ControlContract {
  /** `lease` (default de la caja) o `single` (un solo nodo, sin lease). */
  mode: string
  lease: {
    /** Identidad de ESTE nodo como aspirante. */
    holder: string
    /** Época con la que controla (0 = nunca controló). */
    epoch: number
    /** Última renovación propia; `null` si nunca controló. */
    renewedAt: string | null
    /** `true` = este nodo tiene el control ahora mismo. */
    held: boolean
    /** Titular leído del archivo de lease (vacío = marca de release). */
    observedHolder?: string
    observedEpoch?: number
    /** Por qué no controla (vocabulario cerrado del lease), si aplica. */
    reason?: string
    reasonDetail?: string
    file: string
  }
  /** El ANILLO que este proceso ejecuta. `digest` queda `null` mientras la instalación no lo declare. */
  ring: { version: string | null; digest: string | null; name: string | null }
  /** Los lazos de fondo: declarados siempre, armados solo con el control. */
  loops: { armed: boolean; detail: { name: string; everyMs: number; armed: boolean; ticks: number; lastTickAt?: string; lastError?: string }[] }
  /**
   * Los stores embebidos y su plano de escritura. En PLURAL a propósito: un nodo tiene más de uno
   * (gobierno y notas en producción; data maestra en el camino local), y el pre-flight de una promoción
   * compara **el más nuevo** — un solo par de números escondería al store que sí bloquea el rollback.
   */
  store: {
    name: string
    file: string
    mode: string
    schemaSupported: number
    fileVersion: number
    epoch: number
    fileEpoch: number
    degraded: boolean
    degradedReason?: string
  }[]
}

/**
 * Estado de MIRANDA tal como el nodo lo vive (issue #266). Existe porque una superficie opcional ahora
 * puede quedar APAGADA sin tumbar el proceso: si el contrato no lo dijera, la degradación sería
 * silenciosa — exactamente lo que #266 no quiere. Derivado del estado vivo, no declarado.
 */
export interface MirandaContract {
  /** ¿Está sirviendo? */
  enabled: boolean
  /** ¿La instancia la pidió (`MIRANDA_ENABLED`)? `false` + `enabled:false` = nadie la pidió: sano. */
  requested: boolean
  /** Por qué está apagada PESE a haberla pedido. Ausente si nadie la pidió o si está viva. */
  disabledReason?: string
  /** Modelo configurado. */
  model?: string
  /** Destino de la API (host). No es secreto; la key jamás aparece acá ni en ningún log. */
  baseUrl?: string
}

export interface ContractSnapshot {
  /** Versión del producto (`VERGIS_VERSION`, build-time). `null` = ausencia honesta. */
  version: string | null
  engine: string
  startedAt: string
  hotReload: boolean
  watches: WatchEntry[]
  signals: SignalEntry[]
  reloads: { last: ReloadEvent | null; recent: ReloadEvent[] }
  /** Cada artefacto cargado + el sha256 del archivo EN DISCO AHORA: distintos ⇒ `pending`. */
  artifacts: (ArtifactState & { diskSha256: string | null; pending: boolean })[]
  env: {
    /** Consumidas y sin vía de recarga: cambiarlas exige restart. */
    bootOnly: string[]
    /** La RUTA es de arranque, el CONTENIDO se recarga (envs de los watches instalados). */
    reloadableContent: string[]
    /** Presentes en el entorno con prefijo VERGIS_/MIRANDA_ y JAMÁS consumidas (typos, deprecados). */
    unknown: string[]
  }
  caveats: string[]
  /** Plano de control del nodo (#210 · I6). `null`/ausente = el proceso no cableó uno (tests, utilitarios). */
  control?: ControlContract | null
  /** Miranda (#266 · #265). `null`/ausente = el proceso no cableó el proveedor (tests, utilitarios). */
  miranda?: MirandaContract | null
}

export interface ContractRegistry {
  /** ÚNICO camino para instalar un watch registrado: instala (watchPaths) Y registra, en una llamada.
   *  Devuelve el `unwatch()` de watchPaths. */
  watch(meta: { envs: string[]; reloads: string }, paths: string[], onChange: () => void): () => void
  /** Registra un manejador de señal (se coloca junto a su `process.on`). */
  signal(entry: SignalEntry): void
  /** Lectura de env QUE REGISTRA la clave como consumida-de-arranque. Mismo valor, misma semántica que
   *  `process.env['X']` — solo queda registrada. */
  env(key: string): string | undefined
  /** Declara claves consumidas por `configFromEnv` (ver `configEnvKeys` en ./config). */
  envKeys(keys: string[]): void
  /** Limitación emergente no derivable, colocada en el sitio que la posee. Idempotente. */
  caveat(text: string): void
  /** Registra una recarga (o el boot) + hashea los artefactos recién cargados. Los artefactos
   *  REEMPLAZAN a los previos de su mismo `source` (un reload de policies no borra el de specs). */
  record(event: Omit<ReloadEvent, 'at'>, artifacts?: { source: string; path: string }[]): void
  /** Snapshot para el endpoint (calcula `pending` leyendo disco). El reloj se inyecta al construir. */
  snapshot(): ContractSnapshot
  /**
   * Aviso de que el contrato GANÓ una declaración (`watch`/`signal`/`caveat`) — issue #139.
   *
   * Existe porque el orden del arranque no puede ser la garantía de que la proyección persistida esté
   * completa: **medido** que observar el journal antes de registrar los watches persiste
   * `watches: []` y, peor, clasifica las claves recargables como `bootOnly` — el contrato afirmando
   * «esto exige reiniciar» cuando ya no, que es el error de costo asimétrico que #139 existe para
   * matar (`tests/contract-boot-projection.test.ts`).
   *
   * Con este aviso, quien persiste vuelve a observar cuando algo se declara tarde, así que el orden
   * deja de importar. El registry NO conoce al journal: sigue siendo capa de composición.
   * Se instala UNA vez, después de la observación del arranque; el segundo llamado reemplaza.
   */
  onRegister(cb: () => void): void
}

/** Tamaño del ring de recargas recientes que el contrato conserva. */
export const RELOAD_RING_SIZE = 20

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** sha256 hex del CONTENIDO del archivo. `null` si no se puede leer (borrado, permisos). */
export function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

const UNKNOWN_PREFIX = /^(VERGIS_|MIRANDA_)/

export function createContractRegistry(opts: {
  engine: string
  hotReload: boolean
  envSource?: Record<string, string | undefined>
  now?: () => Date
  /**
   * Proveedor del bloque `control` (#210 · I6). Es un CLOSURE sobre las piezas vivas (lease, registro de
   * lazos, guards de los stores), no un arreglo copiado: se llama en cada `snapshot()`, así que no puede
   * driftear. Ausente ⇒ `control: null` — un proceso sin plano de control cableado lo dice, no lo finge.
   */
  control?: () => ControlContract
  /**
   * Proveedor del bloque `miranda` (#266). CLOSURE sobre el estado vivo del proceso —igual que
   * `control`—, para que «apagada por configuración» no pueda driftear de lo que el nodo realmente
   * montó. Ausente ⇒ `miranda: null`: un proceso que no la cableó lo dice, no lo finge.
   */
  miranda?: () => MirandaContract
}): ContractRegistry {
  const envSource = opts.envSource ?? process.env
  const clock = opts.now ?? ((): Date => new Date())
  const startedAt = clock().toISOString()
  const watches: WatchEntry[] = []
  const signals: SignalEntry[] = []
  const caveats: string[] = []
  const consumed = new Set<string>()
  const artifacts = new Map<string, ArtifactState>() // clave: `${source}\u0000${path}`
  const recent: ReloadEvent[] = []
  /** El bloque `control`, siempre por el proveedor vivo. Un fallo suyo NO rompe el contrato: esto es
   *  observabilidad, y quedarse sin la sección es infinitamente mejor que un 500 en `/contrato`. */
  const control = (): ControlContract | null => {
    if (!opts.control) return null
    try {
      return opts.control()
    } catch (e) {
      console.error(`[contrato] no se pudo derivar el plano de control: ${errMsg(e)}`)
      return null
    }
  }

  /** Igual que `control`: observabilidad, jamás un 500 en `/contrato`. */
  const miranda = (): MirandaContract | null => {
    if (!opts.miranda) return null
    try {
      return opts.miranda()
    } catch (e) {
      console.error(`[contrato] no se pudo derivar el estado de Miranda: ${errMsg(e)}`)
      return null
    }
  }

  const key = (source: string, path: string): string => `${source}\u0000${path}`

  // #139 · aviso de declaración TARDÍA. Nulo hasta que quien persiste lo instale (después de observar
  // el arranque), así que las N declaraciones del boot NO producen N escrituras del journal.
  let registered: (() => void) | null = null
  const notifyRegistered = (): void => {
    try {
      registered?.()
    } catch (e) {
      // El aviso jamás rompe la declaración que lo disparó: el contrato es observabilidad, no serving.
      console.error(`[contrato] fallo al re-observar tras una declaración tardía: ${errMsg(e)}`)
    }
  }

  return {
    onRegister(cb) {
      registered = cb
    },
    watch(meta, paths, onChange) {
      // Registrar ANTES de instalar: el contrato dice qué se pretendía vigilar aunque un path no sea
      // observable (watchPaths ya es tolerante: loguea y omite ese path).
      watches.push({ envs: [...meta.envs], paths: [...paths], reloads: meta.reloads })
      const un = watchPaths(paths, onChange)
      notifyRegistered()
      return un
    },
    signal(entry) {
      signals.push(entry)
      notifyRegistered()
    },
    env(k) {
      consumed.add(k)
      return envSource[k]
    },
    envKeys(keys) {
      for (const k of keys) consumed.add(k)
    },
    caveat(text) {
      if (caveats.includes(text)) return
      caveats.push(text)
      notifyRegistered()
    },
    record(event, arts) {
      try {
        const at = clock().toISOString()
        const full: ReloadEvent = { at, ...event }
        recent.unshift(full)
        if (recent.length > RELOAD_RING_SIZE) recent.length = RELOAD_RING_SIZE
        if (!arts || arts.length === 0) return
        // Reemplazo POR SOURCE: los sources tocados en esta recarga se limpian y se repueblan; los
        // demás sobreviven intactos (una recarga de policies no borra el registro de specs).
        const touched = new Set(arts.map((a) => a.source))
        for (const [k, a] of [...artifacts]) if (touched.has(a.source)) artifacts.delete(k)
        for (const a of arts) {
          const sha = hashFile(a.path)
          if (sha == null) {
            console.error(`[contrato] no se pudo hashear ${a.path} (${a.source}) — el artefacto queda sin registrar.`)
            continue
          }
          artifacts.set(key(a.source, a.path), { source: a.source, path: a.path, sha256: sha, loadedAt: at })
        }
      } catch (e) {
        // El contrato jamás rompe el serving ni la recarga que lo invocó.
        console.error(`[contrato] fallo al registrar la recarga: ${errMsg(e)}`)
      }
    },
    snapshot() {
      const reloadableContent = [...new Set(watches.flatMap((w) => w.envs))].sort()
      const reloadableSet = new Set(reloadableContent)
      const bootOnly = [...consumed].filter((k) => !reloadableSet.has(k)).sort()
      const known = new Set([...consumed, ...reloadableContent])
      const unknown = Object.keys(envSource)
        .filter((k) => UNKNOWN_PREFIX.test(k) && !known.has(k))
        .sort()
      return {
        version: VERGIS_VERSION,
        engine: opts.engine,
        startedAt,
        hotReload: opts.hotReload,
        watches: watches.map((w) => ({ ...w })),
        signals: signals.map((s) => ({ ...s })),
        reloads: { last: recent[0] ?? null, recent: [...recent] },
        artifacts: [...artifacts.values()].map((a) => {
          const diskSha256 = hashFile(a.path)
          return { ...a, diskSha256, pending: diskSha256 !== a.sha256 }
        }),
        env: { bootOnly, reloadableContent, unknown },
        caveats: [...caveats],
        control: control(),
        miranda: miranda(),
      }
    },
  }
}

/**
 * Handler de `GET /contrato` — SOLO ADMINS (D2): el contrato expone rutas del contenedor y nombres de
 * env, superficie de operación y no de consumo. Sin store de gobierno (`isAdmin: null`) responde 403
 * con mensaje claro. Devuelve `true` si atendió la request.
 *
 * Nivel 2 (delta entre versiones): la respuesta gana una sección `delta` y admite `?desde=<version>`.
 * El `observe` del journal va DESPUÉS del gate de rol — un 403 no escribe disco.
 */
export function createContractHandler(deps: {
  registry: ContractRegistry
  /** Journal del delta entre versiones (issue #139 N2). Capa de composición: el registry no cambia. */
  journal: ContractJournal
  isAdmin: ((email: string | undefined) => Promise<boolean>) | null
  /** Identidad de la request (el mismo `identityFor` del server; admin.ts usa este mismo patrón). */
  identityOf: (headers: IncomingMessage['headers']) => { user?: string }
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const deny = (res: ServerResponse, code: number, msg: string): boolean => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: msg }))
    return true
  }
  return async (req, res) => {
    if ((req.method ?? 'GET') !== 'GET') {
      return deny(res, 405, 'El contrato operativo solo se consulta con GET.')
    }
    if (!deps.isAdmin) {
      return deny(res, 403, 'El contrato operativo requiere la Administración habilitada (no hay store de gobierno).')
    }
    const email = (deps.identityOf(req.headers).user ?? '').toLowerCase() || undefined
    let allowed = false
    try {
      allowed = await deps.isAdmin(email)
    } catch (e) {
      console.error(`[contrato] fallo al resolver el rol: ${errMsg(e)}`)
      allowed = false
    }
    if (!allowed) {
      return deny(res, 403, 'El contrato operativo es superficie de administración: se requiere rol de administrador.')
    }
    // Del gate para acá se puede tocar disco: un 403 JAMÁS escribe el journal.
    const snap = deps.registry.snapshot()
    deps.journal.observe(snap)
    // El router pela el query del match de ruta, así que `?desde=` llega intacto acá (routes.ts).
    const desde = new URL(req.url ?? '/', 'http://contrato.local').searchParams.get('desde') ?? undefined
    const delta = deps.journal.delta(snap, desde)
    if (delta === null) {
      // Solo ocurre con `?desde=` de una versión que esta instancia nunca corrió.
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        JSON.stringify({
          error: `La versión '${desde}' no está en el registro de esta instancia.`,
          disponibles: deps.journal.versions(),
        }),
      )
      return true
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ...snap, delta }))
    return true
  }
}
