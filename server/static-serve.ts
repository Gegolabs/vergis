/**
 * SERVIR el contenido estático de la instancia (`VERGIS_STATIC`, CAP-195) — la resolución de una URL
 * a un archivo, y nada más.
 *
 * **Puro y testeable sin servidor, a propósito**: `resolveStatic(colecciones, url, método)` devuelve
 * `{ status, headers, file }` o el fallo, y no toca `req`/`res`. Quien lo llama (el router) escribe la
 * respuesta. Así el test de traversal no necesita levantar un servidor para medir un 403 — y un test
 * que necesita servidor es un test que se deja de correr.
 *
 * **Solo lectura y sin sorpresas.** Cuatro reglas, todas verificables:
 *
 *  1. **Solo `GET`/`HEAD`.** Un `POST` a una colección no es un 404: es un 405, porque la ruta existe
 *     y el método no. Confundirlos le miente a quien depura.
 *  2. **Contención, medida dos veces.** La ruta pedida se decodifica (`%2e%2e%2f` es `../` y hay que
 *     verlo) y se resuelve contra la raíz declarada; se verifica que el resultado siga dentro
 *     LÉXICAMENTE —eso ataja `..` en cualquiera de sus escrituras— y otra vez sobre el camino REAL
 *     (`realpath`), que es lo único que ataja un **symlink que apunta afuera**. Las dos son
 *     necesarias: la léxica no ve el symlink, y la real no distingue un escape de un archivo que no
 *     existe. Escapar ⇒ **403**, no 404: no se sirve, y tampoco se finge que la raíz no tiene nada.
 *  3. **`Content-Type` por LISTA BLANCA de extensión, jamás adivinado.** Lo que no está en la lista
 *     sale como `application/octet-stream` y con `X-Content-Type-Options: nosniff`, que es lo que
 *     impide que el navegador ascienda un archivo desconocido a algo ejecutable por su contenido.
 *  4. **Se lee del disco por request, sin caché en memoria.** Actualizar el contenido es copiar el
 *     archivo — esa es justamente la propiedad que la capacidad busca, y cachear la mataría. Por lo
 *     mismo el HTML sale `no-cache`; no hay `immutable` porque no hay fingerprinting.
 *
 * Un directorio se sirve con su `index.html` si existe, y 404 si no: listar el directorio sería
 * publicar el inventario de la instancia sin que nadie lo declarara.
 */

import { realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { StaticCollection } from './static-config'

/** Una resolución exitosa: el archivo a enviar y las cabeceras con que sale. */
export interface StaticHit {
  status: 200
  headers: Record<string, string>
  /** Ruta ABSOLUTA y ya verificada como contenida en la raíz de la colección. */
  file: string
  /** La colección que la atendió (para el log y el contrato). */
  collection: StaticCollection
}

/** Un fallo con su código y el motivo legible. */
export interface StaticMiss {
  status: 400 | 403 | 404 | 405
  error: string
}

export type StaticResult = StaticHit | StaticMiss

/**
 * Tipos por extensión — LISTA BLANCA CERRADA. Fuera de esta lista no se adivina: se manda
 * `application/octet-stream`. Agregar un tipo es una decisión, no un efecto colateral de subir un
 * archivo nuevo.
 */
export const TIPOS_POR_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
}

export const TIPO_DESCONOCIDO = 'application/octet-stream'

/** Métodos admitidos: servir estáticos es de solo lectura. */
const METODOS = new Set(['GET', 'HEAD'])

/** `Content-Type` de un archivo por su extensión, o `octet-stream` si no está en la lista blanca. */
export function tipoDe(file: string): string {
  const m = /\.[a-z0-9]+$/i.exec(file)
  return (m && TIPOS_POR_EXTENSION[m[0].toLowerCase()]) || TIPO_DESCONOCIDO
}

/** ¿`candidato` está DENTRO de `raiz`? La raíz misma cuenta como dentro. Comparación por segmento:
 *  `startsWith(raiz)` a secas dejaría pasar `/static/ayuda-otro` bajo la raíz `/static/ayuda`. */
function contenido(raiz: string, candidato: string): boolean {
  return candidato === raiz || candidato.startsWith(raiz.endsWith(sep) ? raiz : raiz + sep)
}

/**
 * Resuelve una URL contra las colecciones declaradas.
 *
 * Devuelve `null` —y esto es parte del contrato— cuando el primer segmento **no es** de ninguna
 * colección: el router sigue su despacho normal como si esta capacidad no existiera. Un `null` no es
 * un 404: es «no es mío».
 *
 * `url` es la ruta SIN query (el router ya la peló). El `method` por defecto es `GET` para que el uso
 * mínimo del handler sea `resolveStatic(colecciones, url)`.
 */
export function resolveStatic(
  collections: readonly StaticCollection[],
  url: string,
  method: string = 'GET',
): StaticResult | null {
  const sinBarra = url.replace(/^\/+/, '')
  const corte = sinBarra.indexOf('/')
  const prefijo = (corte === -1 ? sinBarra : sinBarra.slice(0, corte)).toLowerCase()
  if (!prefijo) return null
  const collection = collections.find((c) => c.path === prefijo)
  if (!collection) return null

  // La ruta EXISTE (el prefijo es de una colección): de acá para abajo ya no se devuelve `null`.
  if (!METODOS.has((method || 'GET').toUpperCase()))
    return { status: 405, error: 'El contenido estático de la instancia es de solo lectura: solo GET y HEAD.' }

  const crudo = corte === -1 ? '' : sinBarra.slice(corte + 1)
  let rel: string
  try {
    // `%2e%2e%2f` es `../` escrito de otro modo: sin decodificar, la verificación de contención
    // mediría un string que el sistema de archivos nunca va a ver.
    rel = decodeURIComponent(crudo)
  } catch {
    return { status: 400, error: 'Ruta mal codificada.' }
  }
  // Un NUL en la ruta trunca el nombre en las capas nativas: se rechaza antes de tocar disco.
  if (rel.includes('\u0000')) return { status: 403, error: 'Ruta no permitida.' }

  const raiz = collection.dir
  const candidato = resolve(raiz, rel)
  // (a) Contención LÉXICA: ataja `..` en cualquiera de sus escrituras, antes de tocar el disco.
  if (!contenido(raiz, candidato))
    return { status: 403, error: 'Ruta fuera de la colección: no se sirve nada fuera de su directorio declarado.' }

  let file = candidato
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(file)
  } catch {
    return { status: 404, error: 'Archivo no encontrado.' }
  }
  if (st.isDirectory()) {
    // Un directorio se sirve con su `index.html`; listarlo publicaría el inventario de la instancia.
    file = resolve(file, 'index.html')
    try {
      if (!statSync(file).isFile()) return { status: 404, error: 'Archivo no encontrado.' }
    } catch {
      return { status: 404, error: 'Archivo no encontrado.' }
    }
  } else if (!st.isFile()) {
    return { status: 404, error: 'Archivo no encontrado.' }
  }

  // (b) Contención REAL: lo único que ve un symlink que apunta afuera. Se resuelven AMBOS extremos —
  // la raíz también puede ser un symlink (un bind-mount a un directorio enlazado), y compararla sin
  // resolver daría un falso 403 sobre contenido perfectamente legítimo.
  let raizReal: string
  let fileReal: string
  try {
    raizReal = realpathSync(raiz)
    fileReal = realpathSync(file)
  } catch {
    return { status: 404, error: 'Archivo no encontrado.' }
  }
  if (!contenido(raizReal, fileReal))
    return { status: 403, error: 'Ruta fuera de la colección: no se sirve nada fuera de su directorio declarado.' }

  const tipo = tipoDe(fileReal)
  const headers: Record<string, string> = {
    'content-type': tipo,
    // Sin esto, un `octet-stream` desconocido puede ser ascendido por el navegador según su
    // contenido — el sniffing es exactamente lo que la lista blanca existe para no delegar.
    'x-content-type-options': 'nosniff',
    'content-length': String(statSync(fileReal).size),
  }
  // El HTML es la puerta de entrada de la colección y cambia al copiar un archivo: `no-cache` obliga
  // a revalidar. `immutable` NO se usa: no hay fingerprinting, así que prometería lo que no hay.
  if (tipo.startsWith('text/html')) headers['cache-control'] = 'no-cache'

  return { status: 200, headers, file: fileReal, collection }
}
