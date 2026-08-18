/**
 * Los lazos de fondo del nodo, colgados del plano de control.
 *
 * Un nodo Vergis corre lazos por `setInterval` que NO dependen del tráfico: observan el motor,
 * reconcilian cadencias, consumen archivos del landing, purgan y reportan. Está **medido** que un nodo
 * sin recibir una sola petición escribe el store de gobierno en cada vuelta, y que dos nodos vivos
 * sobre el mismo volumen alternan el archivo entre sus dos mundos: la escritura de fondo es el camino
 * caliente, no una excepción. De ahí la regla que este módulo implementa: **los lazos los corre quien
 * tiene el control, y nadie más.**
 *
 * Por eso los lazos ya no se arman al boot: se **declaran** donde antes se armaban (`register`) y se
 * arman en el acto de **adquirir** el control (`arm`), se desarman en el acto de **soltarlo**
 * (`disarm`). Un nodo en standby los tiene declarados y desarmados — que es lo que puede decir de sí
 * mismo en el log y en `/contrato`, en vez de callar.
 *
 * ── Dos garantías que no son detalles ──────────────────────────────────────────────────────────
 * 1. **`disarm()` espera el tick en vuelo.** Cortar el `setInterval` no detiene la vuelta que ya está
 *    corriendo, y esa vuelta termina en un volcado del store. Soltar el control sin esperarla dejaría
 *    una escritura nuestra aterrizando cuando el archivo ya es de otro — exactamente el modo de falla
 *    que el plano de control existe para eliminar. `disarm()` resuelve cuando no queda tick vivo.
 * 2. **Ningún timer sostiene el proceso** (`unref`): un lazo de fondo no es razón para que un nodo no
 *    pueda terminar, y una suite con un timer colgado no termina nunca.
 *
 * El registro es de UN uso por lazo: registrar dos veces el mismo nombre es un error de cableado
 * (dos lazos con la misma identidad harían indistinguible cuál escribió) y se rechaza.
 */

/** Un lazo declarado: su identidad, su cadencia y su vuelta. */
export interface LoopSpec {
  /** Identidad del lazo — la que aparece en el log y en `/contrato`. Única. */
  name: string
  /** Cadencia en ms. Debe ser > 0: un lazo sin cadencia no es un lazo. */
  everyMs: number
  /**
   * Retardo del primer tick tras armar, en ms. Ausente = sin tick de arranque (el primero cae a los
   * `everyMs`). Es el `setTimeout` de arranque que cada lazo ya tenía, declarado en vez de suelto.
   */
  firstDelayMs?: number
  /** La vuelta. Puede lanzar: el error se loguea y el lazo sigue armado (una vuelta mala no lo mata). */
  tick: () => Promise<void> | void
}

/** Estado de un lazo — lo que un reporte de salud o `/contrato` derivan de acá, sin declararlo aparte. */
export interface LoopStatus {
  name: string
  everyMs: number
  armed: boolean
  ticks: number
  lastTickAt?: string
  lastError?: string
}

export interface BackgroundLoops {
  /** Declara un lazo. No lo arma: eso lo hace `arm()` cuando el nodo tiene el control. */
  register(spec: LoopSpec): void
  /** Arma todos los lazos declarados. Idempotente. */
  arm(): void
  /** Desarma todos los lazos y **espera el tick en vuelo**. Idempotente. */
  disarm(): Promise<void>
  armed(): boolean
  names(): string[]
  status(): LoopStatus[]
}

interface LoopState {
  spec: LoopSpec
  timer: NodeJS.Timeout | undefined
  first: NodeJS.Timeout | undefined
  inFlight: Promise<void> | null
  ticks: number
  lastTickAt?: string
  lastError?: string
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createBackgroundLoops(opts: { log?: (msg: string) => void; now?: () => Date } = {}): BackgroundLoops {
  const log = opts.log ?? ((m: string) => console.log(m))
  const clock = opts.now ?? ((): Date => new Date())
  const loops = new Map<string, LoopState>()
  let isArmed = false

  const runTick = (st: LoopState): void => {
    // Solapamiento: los lazos ya son `inFlight`-guarded por dentro, pero acá se necesita la PROMESA de
    // la vuelta viva para poder esperarla al desarmar — un guard booleano ajeno no se puede esperar.
    if (st.inFlight) return
    const p = (async () => {
      try {
        await st.spec.tick()
        st.lastError = undefined
      } catch (e) {
        st.lastError = errMsg(e)
        log(`[control] lazo '${st.spec.name}': la vuelta falló: ${st.lastError}`)
      } finally {
        st.ticks += 1
        st.lastTickAt = clock().toISOString()
      }
    })()
    st.inFlight = p
    void p.finally(() => {
      if (st.inFlight === p) st.inFlight = null
    })
  }

  const armOne = (st: LoopState): void => {
    if (st.timer) return
    const t = setInterval(() => runTick(st), st.spec.everyMs)
    t.unref?.()
    st.timer = t
    if (st.spec.firstDelayMs != null) {
      const f = setTimeout(() => {
        st.first = undefined
        runTick(st)
      }, st.spec.firstDelayMs)
      f.unref?.()
      st.first = f
    }
  }

  const disarmOne = (st: LoopState): void => {
    if (st.timer) clearInterval(st.timer)
    if (st.first) clearTimeout(st.first)
    st.timer = undefined
    st.first = undefined
  }

  return {
    register(spec) {
      if (!spec.name.trim()) throw new Error('Un lazo de fondo necesita nombre: es su identidad en el log y en el contrato.')
      if (!Number.isFinite(spec.everyMs) || spec.everyMs <= 0) {
        throw new Error(`Lazo '${spec.name}': la cadencia debe ser un número de ms > 0 (recibido: ${String(spec.everyMs)}).`)
      }
      if (loops.has(spec.name)) throw new Error(`Lazo '${spec.name}' ya está declarado: dos lazos con el mismo nombre serían indistinguibles.`)
      loops.set(spec.name, { spec, timer: undefined, first: undefined, inFlight: null, ticks: 0 })
      // Un lazo declarado DESPUÉS de armar (el bloque de administración declara los suyos durante un
      // arranque asíncrono) se arma solo: si no, quedaría mudo hasta el próximo relevo.
      if (isArmed) armOne(loops.get(spec.name) as LoopState)
    },
    arm() {
      isArmed = true
      for (const st of loops.values()) armOne(st)
    },
    async disarm() {
      isArmed = false
      for (const st of loops.values()) disarmOne(st)
      // Esperar TODAS las vueltas vivas: cada una termina en un volcado, y el control no se suelta
      // mientras una escritura nuestra siga en el aire.
      await Promise.allSettled([...loops.values()].map((st) => st.inFlight).filter((p): p is Promise<void> => !!p))
    },
    armed() {
      return isArmed
    },
    names() {
      return [...loops.keys()]
    },
    status() {
      return [...loops.values()].map((st) => ({
        name: st.spec.name,
        everyMs: st.spec.everyMs,
        armed: !!st.timer,
        ticks: st.ticks,
        ...(st.lastTickAt ? { lastTickAt: st.lastTickAt } : {}),
        ...(st.lastError ? { lastError: st.lastError } : {}),
      }))
    },
  }
}
