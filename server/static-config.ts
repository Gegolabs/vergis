/**
 * COLECCIONES DE ARCHIVOS ESTÁTICOS declaradas por la instancia (`VERGIS_STATIC`) — lo que el nodo
 * sirve bajo su propio gate, sin que publicar una página tenga que tocar el borde.
 *
 * Existe por un caso MEDIDO el 2026-09-21: el portal de ayuda de la instancia GH (`/ayuda/`) se
 * publicó como HTML servido por un contenedor `caddy` aparte, con un bloque nuevo en el Caddyfile del
 * borde, y **dio 404 al usuario**. La causa fue del transporte (el Caddyfile se monta como bind de
 * ARCHIVO y el despliegue lo reemplazó con `mv`, que cambia el inodo: el contenedor siguió sirviendo
 * el anterior y `caddy reload` releyó el viejo sin avisar), pero la lección no es «montar por
 * directorio»: es que **publicar una página no debería tocar el borde**. Cada colección costaba un
 * montaje en el compose, un bloque con su `forward_auth` copiado, una familia en la sonda de paridad
 * y el riesgo de que el borde sirviera algo que nadie declaró. Con esta capacidad, declarar una
 * colección es una entrada en un YAML de instancia y el nodo la sirve tras el MISMO gate que ya
 * protege el catálogo.
 *
 * **Autorización: la del catálogo, ni más ni menos.** Cualquier identidad que el gate ya dejó entrar
 * ve el contenido — que es exactamente lo que daba el `forward_auth` del borde, así que no cambia
 * quién ve qué. La autorización POR GRUPO es una extensión futura declarada en
 * `docs/arquitectura-multi-reporte.md`, y deliberadamente NO se construye a medias: media
 * autorización es peor que ninguna, porque invita a confiar en ella.
 *
 * **Semántica de fallas — dos niveles, igual que `menu-config.ts` y por el mismo motivo:**
 *
 *  · La CLAVE RAÍZ ausente es FATAL, como en toda la config de instancia (`config-root.ts`): un
 *    archivo declarado que perdió su `static:` es el modo de falla que ese contrato existe para
 *    atrapar —un `sed`, un merge o un truncado que rompió el YAML sin romper su sintaxis—, y
 *    colapsar a cero colecciones lo escondería detrás de un nodo que parece sano.
 *  · Una ENTRADA inválida se OMITE con aviso nombrado, y el nodo levanta igual. Una colección mal
 *    escrita no es razón para dejar la plataforma sin servir: el costo de tumbar el nodo es
 *    desproporcionado frente al daño, que es una ruta que responde 404. El aviso va al log de
 *    arranque nombrando la entrada y la razón — se omite, pero no en silencio.
 *
 * **`path` es un PREFIJO RESERVADO y se valida al cargar**, no al servir. Se rechaza si está vacío,
 * si no matchea `^[a-z0-9][a-z0-9-]*$` (un prefijo con mayúsculas, puntos o barras convierte el
 * despacho en una adivinanza) o si choca con una ruta propia del nodo (`healthz`, `contrato`,
 * `admin`, `oauth2`, `config`, `miranda`, `impresiones`). La colisión que importa de verdad es con el
 * **slug de un Let servido**, y ésa no se puede decidir acá porque el catálogo es vivo: se resuelve
 * en `omitirPorLets`, donde **gana el Let** —el dato gobernado manda— y la colección se omite
 * nombrando el choque. Un prefijo que tapa un PI sería una fuga de superficie: el PI deja de
 * responder y nadie lo declaró.
 *
 * **Un `dir` que no existe NO omite la colección**, y esto es una decisión, no un olvido: el
 * directorio suele ser un bind-mount que puede aparecer después del arranque, y omitir la entrada
 * dejaría al contrato del nodo sin nada que nombrar —justo lo que el contrato existe para decir—.
 * La colección queda declarada, el arranque emite su aviso, `GET /contrato` la marca `exists:false`
 * y servir desde ella responde 404. `estadoDeColecciones` es la única lectura de disco de este
 * módulo, y vive separada del parser a propósito: el parser es puro, así que el arranque y la
 * recarga en caliente no pueden diferir en su veredicto sobre el mismo archivo.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { requireRootKey } from '@vergis/capabilities'

/** Una colección de archivos estáticos declarada por la instancia. */
export interface StaticCollection {
  /** Prefijo público SIN barras: `ayuda` se sirve bajo `/ayuda/`. Validado al cargar. */
  path: string
  /** Directorio raíz DENTRO del contenedor, ya resuelto a absoluto. Nada fuera de él se sirve. */
  dir: string
  /** Rótulo opcional, para el log de arranque y el contrato del nodo. */
  label?: string
}

/** Lo que devuelve el parser: las colecciones válidas y los avisos de lo que se omitió. */
export interface StaticConfig {
  collections: StaticCollection[]
  /** Una línea por entrada omitida, nombrándola y con la razón. Vacío = nada se omitió. */
  warnings: string[]
}

/** Una colección con el veredicto de disco de AHORA — lo que `GET /contrato` publica. */
export interface StaticCollectionState extends StaticCollection {
  /** ¿El `dir` existe y es un directorio? */
  exists: boolean
  /** ¿Se puede leer y atravesar? (`exists:false` ⇒ `readable:false`). */
  readable: boolean
}

/**
 * Prefijos que el nodo despacha por su cuenta, y que por eso una colección no puede reclamar. Es la
 * lista de las rutas propias del router (`server/routes.ts`) más `oauth2`, que es del proxy de
 * identidad y nunca llega al nodo: una colección llamada `oauth2` no rompería el login, pero
 * declararla es una confusión que conviene atajar donde se escribe, no donde se depura.
 */
export const RUTAS_DEL_NODO: readonly string[] = ['healthz', 'contrato', 'admin', 'cargar', 'oauth2', 'config', 'miranda', 'impresiones']

/** Un prefijo público admisible: minúsculas, dígitos y guiones, empezando por alfanumérico. */
const PREFIJO_VALIDO = /^[a-z0-9][a-z0-9-]*$/

/** Valida `{ static: [...] }` (`VERGIS_STATIC`). Ver la semántica de fallas en la cabecera del módulo. */
export function parseStaticConfig(doc: unknown): StaticConfig {
  const raw = requireRootKey(doc, 'static', 'static')
  if (!Array.isArray(raw))
    throw new Error('static: `static` debe ser una lista — para declarar «no hay», usa `static: []`.')
  const collections: StaticCollection[] = []
  const warnings: string[] = []
  const vistos = new Set<string>()
  raw.forEach((entry, i) => {
    const o = (entry ?? {}) as Record<string, unknown>
    const rawPath = typeof o['path'] === 'string' ? o['path'].trim() : ''
    const nombre = rawPath ? `'${rawPath}'` : `#${i}`
    const omit = (razon: string): void => void warnings.push(`colección ${nombre} omitida: ${razon}`)
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return omit('no es un mapa.')
    if (!rawPath) return omit("'path' debe ser un string no vacío.")
    if (!PREFIJO_VALIDO.test(rawPath))
      return omit(`'path' inválido '${rawPath}' (se admite minúsculas, dígitos y guiones, sin barras ni puntos: 'ayuda' sirve /ayuda/).`)
    if (RUTAS_DEL_NODO.includes(rawPath))
      return omit(`'${rawPath}' es una ruta propia del nodo — una colección no puede taparla.`)
    if (vistos.has(rawPath)) return omit(`el prefijo '${rawPath}' ya fue declarado por otra colección.`)
    const rawDir = typeof o['dir'] === 'string' ? o['dir'].trim() : ''
    if (!rawDir) return omit("'dir' debe ser un string no vacío (el directorio raíz de la colección).")
    const label = o['label']
    if (label != null && typeof label !== 'string') return omit("'label' debe ser un string.")
    vistos.add(rawPath)
    const col: StaticCollection = { path: rawPath, dir: resolve(rawDir) }
    if (typeof label === 'string' && label.trim()) col.label = label.trim()
    collections.push(col)
  })
  return { collections, warnings }
}

/**
 * Quita las colecciones cuyo prefijo choca con el slug de un Let SERVIDO, y devuelve el aviso que
 * nombra el choque. **Gana el Let, siempre**: el dato gobernado manda, y un PI que deja de responder
 * porque alguien declaró una colección con su nombre es una pérdida de superficie que nadie pidió.
 *
 * Va aparte del parser porque el catálogo de Lets es VIVO —un spec entra y sale en caliente—, así que
 * el veredicto depende del instante y no del archivo. Es la MISMA función que usan el despacho (por
 * request) y el contrato del nodo: tener dos implementaciones de esta regla sería tener dos reglas.
 */
export function omitirPorLets(
  collections: readonly StaticCollection[],
  letSlugs: ReadonlySet<string>,
): { collections: StaticCollection[]; warnings: string[] } {
  const out: StaticCollection[] = []
  const warnings: string[] = []
  for (const c of collections) {
    if (letSlugs.has(c.path)) {
      warnings.push(`colección '${c.path}' omitida: choca con el slug del Let '${c.path}', que gana — el dato gobernado manda.`)
      continue
    }
    out.push(c)
  }
  return { collections: out, warnings }
}

/**
 * Quita las colecciones cuyo prefijo choca con una ruta que **el nodo sirve por sí mismo** cuando una
 * capacidad opt-in está encendida, y devuelve el aviso que la nombra.
 *
 * Va aparte de `RUTAS_DEL_NODO` —que es una constante del parser PURO, y el parser no conoce las
 * envs— por el mismo motivo por el que `omitirPorLets` va aparte: el veredicto depende del instante,
 * no del archivo. Con la capacidad apagada el conjunto llega vacío y esta función es la identidad:
 * la superficie de una instancia que no la enciende es byte a byte la de antes.
 *
 * Gana el NODO, y no es la misma decisión que con un Let: con un Let gana el dato gobernado; acá gana
 * porque la ruta la sirve el propio nodo con contenido que él produce, y una colección de instancia
 * encima la taparía con algo que nadie coordinó.
 */
export function omitirPorNodo(
  collections: readonly StaticCollection[],
  prefijosDelNodo: ReadonlySet<string>,
): { collections: StaticCollection[]; warnings: string[] } {
  if (!prefijosDelNodo.size) return { collections: [...collections], warnings: [] }
  const out: StaticCollection[] = []
  const warnings: string[] = []
  for (const c of collections) {
    if (prefijosDelNodo.has(c.path)) {
      warnings.push(
        `colección '${c.path}' omitida: choca con la ruta '/${c.path}' que el nodo sirve por sí mismo — el contenido del nodo gana.`,
      )
      continue
    }
    out.push(c)
  }
  return { collections: out, warnings }
}

/**
 * El veredicto de DISCO de ahora mismo para cada colección. Única lectura de disco del módulo, y va
 * separada del parser para que éste siga siendo puro (el arranque y la recarga no pueden diferir).
 * Un `dir` ilegible NO es una excepción: es un `readable:false` que el contrato publica.
 */
export function estadoDeColecciones(collections: readonly StaticCollection[]): StaticCollectionState[] {
  return collections.map((c) => {
    let exists = false
    let readable = false
    try {
      exists = statSync(c.dir).isDirectory()
      if (exists) {
        accessSync(c.dir, constants.R_OK | constants.X_OK)
        readable = true
      }
    } catch {
      /* no existe, no es directorio, o no se puede leer: ambos flags quedan en false */
    }
    return { ...c, exists, readable }
  })
}

/** Avisos de arranque/recarga por colección declarada sobre un `dir` que hoy no sirve. */
export function avisosDeDirectorio(collections: readonly StaticCollection[]): string[] {
  return estadoDeColecciones(collections)
    .filter((c) => !c.readable)
    .map((c) => `colección '${c.path}': el directorio '${c.dir}' ${c.exists ? 'no se puede leer' : 'no existe'} — la colección queda declarada y responde 404 hasta que aparezca.`)
}
