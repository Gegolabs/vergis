/**
 * LA CACHÉ EN DISCO del Datadoc (`CAP-197`) — dónde vive lo medido, cómo se publica un build y cómo
 * se poda lo viejo. Todo lo de I/O del generador está acá y nada más está acá.
 *
 * Layout bajo `$VERGIS_OUT/datadoc/`:
 *
 *     modelo/<ref>.json      la medición de UNA conexión (se sobreescribe por conexión)
 *     sello.json             estado por conexión + el build vigente + rancio + periodKey del schedule
 *     build-<ts>/            un render completo e INMUTABLE
 *     current -> build-<ts>  symlink relativo: la raíz de la colección que el nodo sirve
 *
 * ── POR QUÉ DISCO Y NO MEMORIA ──────────────────────────────────────────────────────────────────
 * El nodo se reinicia con cada promoción de anillo, y medir cuesta una vuelta de red por conexión
 * contra almacenes de terceros. Un catálogo que muere con el proceso obligaría a re-medirlos en cada
 * arranque. `VERGIS_OUT` ya es el volumen persistente del nodo.
 *
 * ── POR QUÉ MEDICIÓN Y RENDER SON FASES SEPARADAS ───────────────────────────────────────────────
 * Porque una conexión que hoy no responde tiene que seguir apareciendo con lo que se midió ayer, y
 * marcada como vieja. Si el render leyera solo lo de esta corrida, una caída de red haría desaparecer
 * medio catálogo — y desaparecer es una afirmación («esto no existe») más fuerte y más falsa que
 * «esto no lo pude mirar hoy».
 *
 * ── EL SWAP ES ATÓMICO, Y ESO SE MIDE ───────────────────────────────────────────────────────────
 * Se escribe un symlink temporal y se hace `rename(2)` sobre `current`. Que `rename` reemplace un
 * symlink existente de forma atómica es garantía POSIX — **se asume**, y por eso el test del store
 * la pone en riesgo: un lector en bucle sobre `realpathSync(current)` durante doscientos swaps no
 * puede ver un solo `ENOENT`. Sin ese experimento sería una cita de manual, no un hecho del FS que
 * corre debajo.
 *
 * ── LO QUE ESTE MÓDULO NO HACE NUNCA ────────────────────────────────────────────────────────────
 * Borrar algo que no matchee `build-*` dentro de su propio directorio. Nada de `rm -rf` sobre una
 * ruta calculada: la poda enumera, filtra por el patrón, verifica que el candidato sea hijo directo
 * del directorio del Datadoc, y recién ahí borra.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { ModeloConexion } from './datadoc-introspect'
import type { Archivo } from './datadoc-render'

/** Lo que el sello guarda de UNA conexión. */
export interface SelloConexion {
  ref: string
  database: string | null
  server: string | null
  ok: boolean
  medidoEn: string | null
  ms: number | null
  objetos: number | null
  error?: string
}

/** El sello completo: estado por conexión + el build vigente + las marcas que sobreviven al proceso. */
export interface Sello {
  conexiones: SelloConexion[]
  /** El build publicado por última vez y cuándo se generó. `null` = todavía ninguno. */
  build: { dir: string; generadoEn: string } | null
  /** El gobierno cambió después de la última medición: los conteos se retiran hasta regenerar. */
  rancio: { razon: string; desde: string } | null
  /** `YYYY-MM-DD` del último período que el schedule ya disparó — la idempotencia del lazo. */
  periodKey?: string
}

const SELLO_VACIO: Sello = { conexiones: [], build: null, rancio: null }

const BUILD_RE = /^build-[0-9TZ:.-]+$/

/** `datadoc/` dentro del `VERGIS_OUT` que se le pase. Se crea si no está. */
export function dirDatadoc(out: string): string {
  const dir = resolve(out, 'datadoc')
  mkdirSync(join(dir, 'modelo'), { recursive: true })
  return dir
}

const jsonSeguro = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Escritura atómica de un archivo regular: tmp + `rename`. Atómico en cualquier FS local. */
function escribirAtomico(path: string, contenido: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, contenido, 'utf8')
  renameSync(tmp, path)
}

/** Nombre de archivo del modelo de una conexión. El `ref` se valida: es parte de una ruta. */
function archivoModelo(dir: string, ref: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(ref)) throw new Error(`datadoc: database_ref inválido '${ref}' — no se puede usar como nombre de archivo.`)
  return join(dir, 'modelo', `${ref}.json`)
}

export function escribirModelo(dir: string, modelo: ModeloConexion): void {
  escribirAtomico(archivoModelo(dir, modelo.ref), JSON.stringify(modelo))
}

/** Todos los modelos presentes, medidos hoy o conservados de antes. Un archivo corrupto se ignora. */
export function leerModelos(dir: string): ModeloConexion[] {
  const carpeta = join(dir, 'modelo')
  if (!existsSync(carpeta)) return []
  const out: ModeloConexion[] = []
  for (const f of readdirSync(carpeta)) {
    if (!f.endsWith('.json')) continue
    const m = jsonSeguro<ModeloConexion | null>(join(carpeta, f), null)
    if (m && typeof m.ref === 'string') out.push(m)
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref))
}

export function leerSello(dir: string): Sello {
  const s = jsonSeguro<Partial<Sello>>(join(dir, 'sello.json'), {})
  return {
    conexiones: Array.isArray(s.conexiones) ? s.conexiones : [],
    build: s.build ?? null,
    rancio: s.rancio ?? null,
    ...(s.periodKey ? { periodKey: s.periodKey } : {}),
  }
}

export function escribirSello(dir: string, sello: Sello): void {
  escribirAtomico(join(dir, 'sello.json'), JSON.stringify(sello, null, 2))
}

/** Escribe un build completo e inmutable y devuelve su directorio. No lo publica. */
export function escribirBuild(dir: string, archivos: readonly Archivo[], ahora: Date = new Date()): string {
  const ts = ahora.toISOString().replace(/[:.]/g, '-')
  const buildDir = join(dir, `build-${ts}`)
  mkdirSync(buildDir, { recursive: true })
  for (const a of archivos) {
    // El `rel` lo produce el render (nunca entrada de usuario), pero se verifica igual: un archivo que
    // escapara del build escribiría fuera del área del Datadoc, y esa es una comprobación que cuesta
    // una línea y que nadie echa de menos hasta que hace falta.
    const destino = resolve(buildDir, a.rel)
    if (destino !== buildDir && !destino.startsWith(buildDir + sep))
      throw new Error(`datadoc: el archivo '${a.rel}' cae fuera del build — no se escribe.`)
    mkdirSync(dirname(destino), { recursive: true })
    writeFileSync(destino, a.contenido, 'utf8')
  }
  return buildDir
}

/**
 * Publica un build: `current` pasa a apuntarlo, atómicamente.
 *
 * El symlink es RELATIVO (`build-<ts>`, no la ruta absoluta) para que el directorio se pueda mover o
 * montar en otro punto sin que el puntero quede colgando. `rename(2)` sobre un symlink existente lo
 * reemplaza sin ventana intermedia — es garantía POSIX, y el test la mide.
 */
export function publicar(dir: string, buildDir: string): void {
  const nombre = basename(buildDir)
  const tmp = join(dir, `current.tmp-${process.pid}`)
  try {
    unlinkSync(tmp)
  } catch {
    /* no estaba: es el caso normal */
  }
  symlinkSync(nombre, tmp)
  renameSync(tmp, join(dir, 'current'))
}

/** La ruta del symlink `current`, exista o no. Es el `dir` de la colección que el nodo sirve. */
export function rutaCurrent(dir: string): string {
  return join(dir, 'current')
}

/** ¿Hay un build publicado ahora mismo? (`current` existe y resuelve a un directorio). */
export function hayBuild(dir: string): boolean {
  try {
    return statSync(rutaCurrent(dir)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Deja los `conservar` builds más recientes y borra el resto.
 *
 * Solo toca hijos DIRECTOS de `dir` cuyo nombre matchee `build-*` y que sean directorios. Nunca
 * sigue un symlink, nunca sube un nivel, y jamás borra el build que `current` está sirviendo aunque
 * la poda lo eligiera —servir desde un directorio recién borrado es exactamente el 404 intermitente
 * que nadie logra reproducir—.
 */
export function podar(dir: string, conservar = 2): string[] {
  if (!existsSync(dir)) return []
  let vigente: string | null = null
  try {
    vigente = basename(realpathSync(rutaCurrent(dir)))
  } catch {
    vigente = null
  }
  const builds = readdirSync(dir)
    .filter((f) => BUILD_RE.test(f))
    .filter((f) => {
      try {
        return statSync(join(dir, f)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
    .reverse()
  const borrados: string[] = []
  for (const f of builds.slice(conservar)) {
    if (f === vigente) continue
    const destino = join(dir, f)
    // Tercera comprobación, después del patrón y del `isDirectory`: el candidato es hijo directo de
    // `dir`. Tres verificaciones para un `rm -r` no es paranoia, es el precio de tener uno.
    if (dirname(destino) !== dir || !BUILD_RE.test(basename(destino))) continue
    rmSync(destino, { recursive: true, force: true })
    borrados.push(f)
  }
  return borrados
}

/** El sello de una conexión a partir de su modelo. */
export function selloDe(modelo: ModeloConexion, error?: string): SelloConexion {
  const s: SelloConexion = {
    ref: modelo.ref,
    database: modelo.database,
    server: modelo.server,
    ok: error == null,
    medidoEn: modelo.medidoEn,
    ms: modelo.ms,
    objetos: modelo.objetos.length,
  }
  if (error != null) s.error = error
  return s
}

export { SELLO_VACIO }
