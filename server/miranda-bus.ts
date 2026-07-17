// Bus de eventos en memoria por sesión de Miranda (plan 103 etapa 1): la fundación del canal EN VIVO.
// El loop del turno PUBLICA eventos (fase, mensaje nuevo, draft actualizado, fin, error); el endpoint SSE
// los TRANSMITE a los clientes suscritos. La STORE es la fuente de verdad (persistencia incremental); el
// bus es solo transporte — si el proceso reinicia, el cliente re-suscribe y cae al estado persistido.
//
// LIMITACIÓN CONOCIDA (documentada, no resuelta acá): el bus vive en la MEMORIA DEL PROCESO. En la VM hoy
// es single-process, así que el turno (que corre en este proceso) y el SSE comparten el bus. Con múltiples
// réplicas habría que externalizar el bus (Redis pub/sub o similar) — fuera del alcance de esta etapa.

/** Un evento del bus con id incremental (para replay tras reconexión, vía Last-Event-ID). */
export interface BusEvent {
  id: number
  type: string
  data: unknown
}

/** Emisor de una sesión: publica a los suscriptores y guarda un buffer corto para el replay. */
export class SessionBus {
  private seq = 0
  private readonly subs = new Set<(e: BusEvent) => void>()
  private readonly ring: BusEvent[] = []
  private readonly ringMax: number

  constructor(ringMax = 64) {
    this.ringMax = ringMax
  }

  /** Publica un evento a todos los suscriptores (y lo guarda en el buffer de replay). */
  publish(type: string, data: unknown): BusEvent {
    const e: BusEvent = { id: ++this.seq, type, data }
    this.ring.push(e)
    if (this.ring.length > this.ringMax) this.ring.shift()
    for (const fn of this.subs) {
      try {
        fn(e)
      } catch {
        /* un suscriptor roto no debe romper la publicación al resto */
      }
    }
    return e
  }

  /** Suscribe un listener. Replaya primero los eventos del buffer con id > `afterId` (reconexión), luego
   *  entrega los nuevos en vivo. Devuelve la función de baja. */
  subscribe(fn: (e: BusEvent) => void, afterId = 0): () => void {
    for (const e of this.ring) if (e.id > afterId) fn(e)
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }

  /** ¿Hay suscriptores vivos? (para poder podar el bus cuando nadie escucha y el turno terminó). */
  get subscriberCount(): number {
    return this.subs.size
  }

  /** Último id publicado (para diagnóstico/tests). */
  get lastId(): number {
    return this.seq
  }
}

/** Registro de buses por sessionId. Una instancia por handler de Miranda (no global) para no filtrar
 *  estado entre despliegues/tests. Se poda un bus cuando el turno terminó y no queda nadie escuchando. */
export class BusRegistry {
  private readonly map = new Map<string, SessionBus>()

  /** Obtiene (o crea) el bus de una sesión. */
  for(sessionId: string): SessionBus {
    let b = this.map.get(sessionId)
    if (!b) {
      b = new SessionBus()
      this.map.set(sessionId, b)
    }
    return b
  }

  /** El bus de una sesión SIN crearlo (para el endpoint SSE, que no debe materializar buses fantasma). */
  peek(sessionId: string): SessionBus | undefined {
    return this.map.get(sessionId)
  }

  /** Poda el bus de una sesión si nadie lo escucha (llamar al cerrar el turno y al desuscribir). */
  pruneIfIdle(sessionId: string): void {
    const b = this.map.get(sessionId)
    if (b && b.subscriberCount === 0) this.map.delete(sessionId)
  }

  /** Cantidad de buses vivos (diagnóstico/tests). */
  get size(): number {
    return this.map.size
  }
}
