// Hot-reload de specs y gobierno SIN restart del proceso.
//
// Contexto (work/045 del lab): el server ya re-lee las specs por request (`discover()` + `runSpec`
// hacen `readFileSync` fresco), así que editar/añadir una spec es live. Lo que este módulo aporta:
//   1. createCachedScanner — memoiza el `discover()` (que hoy re-parsea TODAS las specs por request)
//      y lo invalida on-change, con VALIDATE-BEFORE-SWAP (si el re-scan lanza, conserva el valor previo).
//   2. watchPaths — observa el dir de specs y los archivos de política, con debounce, y dispara el rebuild.
// El reload del policy store (su gap real) lo orquesta el server llamando `rebuild()` del scanner tras
// re-poblar el store; este módulo provee las piezas genéricas y testeables.

import { watch, statSync, type FSWatcher } from 'node:fs'
import { dirname, basename } from 'node:path'

/** Coalescer simple: agrupa ráfagas de `trigger()` en una sola ejecución de `fn` tras `ms` de quietud. */
export function debounce(fn: () => void, ms: number): { trigger: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    trigger: () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        fn()
      }, ms)
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

/**
 * ¿Este evento del directorio corresponde a un cambio del archivo vigilado?
 *
 * Los tres casos, y por qué:
 *  - **`fn === base`** — el propio archivo, con nombre. Dispara. Es el caso normal.
 *  - **`fn` con otro nombre** — cambió un vecino identificado. No dispara; nunca lo hizo.
 *  - **`fn` ausente (`null`/`''`)** — macOS entrega esto cuando sabe que ALGO cambió en el
 *    directorio pero no QUÉ. Disparar siempre acá hacía que las escrituras del store —cuando
 *    `VERGIS_OUT` comparte directorio con los yaml vigilados— gatillaran recargas y ensuciaran
 *    el ring de `/contrato` con eventos sin cambio detrás. Ignorarlo tampoco sirve: se perderían
 *    cambios reales. Se **desambigua por mtime**: dispara solo si el vigilado cambió de veras.
 *
 * Un archivo que desaparece o se vuelve ilegible (`mtime → null`) cuenta como cambio: fail-loud,
 * que el consumidor vea el error en vez de silenciarlo acá.
 *
 * Pura y exportada a propósito: el caso interesante —`filename` ausente— NO se puede producir a
 * voluntad con el `fs.watch` real, así que un test de integración sobre él sería un instrumento
 * que no sabe reprobar. Acá la decisión se mide de forma determinista.
 */
export function decideWatchEvent(
  fn: string | null | undefined,
  base: string,
  lastMtime: number | null,
  mtimeOf: () => number | null,
): { trigger: boolean; mtime: number | null } {
  if (fn === base) return { trigger: true, mtime: mtimeOf() }
  if (fn) return { trigger: false, mtime: lastMtime }
  const now = mtimeOf()
  return now === lastMtime ? { trigger: false, mtime: lastMtime } : { trigger: true, mtime: now }
}

/**
 * Observa `paths` (archivos o directorios) y llama `onChange` (debounced) ante cualquier evento.
 * Tolerante: un path que no se puede observar se loguea y se omite (no tumba el arranque). Devuelve
 * un `unwatch()` que cierra los watchers y cancela el debounce pendiente.
 */
export function watchPaths(
  paths: string[],
  onChange: () => void,
  opts: { debounceMs?: number; log?: (msg: string) => void } = {},
): () => void {
  const log = opts.log ?? ((m: string) => console.warn(m))
  const d = debounce(onChange, opts.debounceMs ?? 200)
  const watchers: FSWatcher[] = []
  for (const p of paths) {
    try {
      const isDir = (() => {
        try {
          return statSync(p).isDirectory()
        } catch {
          return false
        }
      })()
      if (isDir) {
        watchers.push(watch(p, { persistent: false }, () => d.trigger()))
      } else {
        // Archivo: observar el DIRECTORIO filtrando por basename. Un save atómico (rename de vim/VSCode)
        // cambia el inode del archivo → un `watch` DIRECTO sobre él quedaría mirando el inode viejo y
        // dejaría de disparar en silencio. El watch del directorio sobrevive el rename.
        const base = basename(p)
        // El veredicto por evento vive en `decideWatchEvent` (ver su doc: el caso `filename`
        // ausente de macOS se desambigua por mtime para no recargar por escrituras vecinas).
        const mtimeOf = (): number | null => {
          try {
            return statSync(p).mtimeMs
          } catch {
            return null
          }
        }
        let lastMtime = mtimeOf()
        watchers.push(
          watch(dirname(p), { persistent: false }, (_ev, fn) => {
            const verdict = decideWatchEvent(fn, base, lastMtime, mtimeOf)
            lastMtime = verdict.mtime
            if (verdict.trigger) d.trigger()
          }),
        )
      }
    } catch (e) {
      log(`[hot-reload] no se pudo observar ${p}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return () => {
    d.cancel()
    for (const w of watchers) {
      try {
        w.close()
      } catch {
        /* noop */
      }
    }
  }
}

/**
 * Cachea el resultado de un `scan()` costoso (p.ej. leer+parsear todas las specs y correr el gate de
 * gobernanza). `rebuild()` re-ejecuta `scan()` con VALIDATE-BEFORE-SWAP: si `scan()` lanza, conserva el
 * valor vigente y devuelve `{ ok:false, error }` — una spec a medio editar nunca deja el server sin datos.
 * La primera carga (en la construcción) sí propaga el error: equivale al fallo de arranque actual.
 */
export function createCachedScanner<T>(scan: () => T): {
  get: () => T
  rebuild: () => { ok: boolean; error?: string }
} {
  let value: T = scan()
  return {
    get: () => value,
    rebuild: () => {
      try {
        value = scan()
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

/**
 * Validate-before-swap de una LISTA VIVA (dominios, slots de ingesta — issue #50, endurecido en #117).
 *
 * `load()` corre primero y solo si devuelve sin lanzar se toca `live`: un archivo roto (o decapitado,
 * que desde #117 también lanza) deja la lista vigente INTACTA y reporta por `err`. El swap es un
 * splice in-place porque los consumidores capturaron esa misma referencia y la leen a request-time.
 *
 * @returns `true` si `load()` no lanzó (haya cambiado o no), `false` si se conservó lo vigente.
 */
export function reloadLiveList<T>(
  live: T[],
  load: () => T[],
  label: string,
  reason: string,
  log: (m: string) => void = console.log,
  err: (m: string) => void = console.error,
  /** Cómo se nombra lo conservado en el mensaje de error (default: `label`). */
  keptLabel: string = label,
): boolean {
  let next: T[]
  try {
    next = load()
  } catch (e) {
    err(`[hot-reload] recarga de ${label} falló (${reason}); ${keptLabel} vigentes conservados: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
  if (next.length !== live.length || JSON.stringify(next) !== JSON.stringify(live)) {
    live.splice(0, live.length, ...next)
    log(`[hot-reload] ${label} (${reason}): ${live.length} declarado(s)`)
  }
  return true
}

/**
 * Swap IN-PLACE de un registro vivo `{ clave: valor }` (issue #50: perfiles de conexión). Todos los
 * consumidores capturaron la MISMA referencia y resuelven por clave a call-time — mutarla in-place
 * equivale a un hot-reload sin re-cablear nada. Devuelve el diff en CONTEOS + claves (jamás valores:
 * los perfiles llevan secretos y este resultado se loguea).
 */
export function swapRecordInPlace<T>(current: Record<string, T>, next: Record<string, T>): { added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  for (const k of Object.keys(current)) {
    if (!(k in next)) {
      removed.push(k)
      delete current[k]
    }
  }
  for (const [k, v] of Object.entries(next)) {
    if (!(k in current)) added.push(k)
    else if (JSON.stringify(current[k]) !== JSON.stringify(v)) changed.push(k)
    current[k] = v
  }
  return { added, changed, removed }
}
