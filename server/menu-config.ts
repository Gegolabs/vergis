/**
 * SECCIONES DE MENÚ declaradas por la instancia (`VERGIS_MENU`) — lo que la instancia agrega al menú
 * de identidad (el del avatar), bajo sus propios rótulos.
 *
 * Existe porque los artefactos que acompañan a una plataforma (un catálogo de esquema, una guía, un
 * manual, un tablero) **no son del Producto**: los publica y los hospeda quien opera la instancia, en
 * su propio dominio y detrás de su propio gate. Cablear el href —o incluso el rótulo de su sección—
 * convertiría un artefacto de UNA instancia en superficie del motor genérico.
 *
 * **La instancia AGREGA, no reemplaza.** Los ítems propios del Producto (Catálogo de PIs, Perfil,
 * Mis impresiones, Miranda, Gestión, Configuración, tema y salir) no son configurables y no se mueven:
 * lo declarado acá se renderiza *entre* los ítems de identidad y el separador del tema.
 *
 * **Semántica de fallas — dos niveles, a propósito:**
 *
 *  · La CLAVE RAÍZ ausente es FATAL, como en toda la config de instancia (`config-root.ts`): un
 *    archivo declarado que perdió su `menu:` es el modo de falla que ese contrato existe para
 *    atrapar, y colapsar a cero secciones lo escondería.
 *  · Una SECCIÓN o un ENLACE inválidos se OMITEN con aviso nombrado, y el nodo levanta igual. Un
 *    enlace mal escrito no es razón para dejar la plataforma sin servir: el costo de tumbar el nodo
 *    es desproporcionado frente al daño, que es un ítem de menú que falta. El aviso va al log de
 *    arranque nombrando sección, entrada y razón — se omite, pero no en silencio.
 *  · Una sección que se queda **sin enlaces válidos** no se renderiza: un rótulo suelto sin nada
 *    debajo sería peor que su ausencia.
 *
 * **Qué se admite como `href`, y por qué solo eso:** una ruta relativa que empiece por `/` (el
 * artefacto lo sirve el mismo borde, detrás del mismo gate) o una URL `https://`. Todo lo demás se
 * rechaza — en particular `javascript:` y `data:`, que en un `<a>` del marco de identidad serían
 * ejecución de script declarada por configuración.
 */

import { requireRootKey } from '@vergis/capabilities'

/** Un enlace de una sección declarada por la instancia. */
export interface MenuLink {
  /** Texto visible del ítem. Obligatorio. */
  label: string
  /** Ruta relativa que empieza por `/`, o URL `https://`. Obligatorio. */
  href: string
  /** Explicación de una línea; el menú la usa como `title` del ítem. */
  description?: string
  /** ¿Abrir en pestaña nueva? (`target="_blank" rel="noopener"`). */
  newTab?: boolean
}

/** Una sección del menú de identidad declarada por la instancia: un rótulo y sus enlaces. */
export interface MenuSection {
  /** Rótulo de la sección (p. ej. «Ayuda»). Obligatorio. */
  title: string
  /** Enlaces de la sección, en el orden declarado. Al menos uno válido, o la sección no se renderiza. */
  links: MenuLink[]
}

/** Lo que devuelve el parser: las secciones válidas y los avisos de lo que se omitió. */
export interface MenuConfig {
  sections: MenuSection[]
  /** Una línea por sección o entrada omitida, nombrándola y con la razón. Vacío = nada se omitió. */
  warnings: string[]
}

/** ¿`href` es una de las dos formas admitidas? Ruta relativa absoluta, o `https://`. */
function hrefAdmitido(href: string): boolean {
  // `//host` es una URL protocol-relative, no una ruta: se descarta explícitamente.
  if (href.startsWith('//')) return false
  if (href.startsWith('/')) return true
  return /^https:\/\/[^/\s]+/i.test(href)
}

/** Valida `{ menu: [...] }` (`VERGIS_MENU`). Ver la semántica de fallas en la cabecera del módulo. */
export function parseMenuConfig(doc: unknown): MenuConfig {
  const raw = requireRootKey(doc, 'menu', 'menu')
  if (!Array.isArray(raw)) throw new Error('menu: `menu` debe ser una lista — para declarar «no hay», usa `menu: []`.')
  const sections: MenuSection[] = []
  const warnings: string[] = []
  raw.forEach((entry, si) => {
    const s = (entry ?? {}) as Record<string, unknown>
    const rawTitle = typeof s['title'] === 'string' ? s['title'].trim() : ''
    const nombreSec = rawTitle ? `'${rawTitle}'` : `#${si}`
    const omitSec = (razon: string): void => void warnings.push(`sección ${nombreSec} omitida: ${razon}`)
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return omitSec('no es un mapa.')
    if (!rawTitle) return omitSec("'title' debe ser un string no vacío.")
    const rawLinks = s['links']
    if (!Array.isArray(rawLinks)) return omitSec("'links' debe ser una lista de enlaces.")

    const links: MenuLink[] = []
    rawLinks.forEach((l, li) => {
      const o = (l ?? {}) as Record<string, unknown>
      const nombre = typeof o['label'] === 'string' && o['label'].trim() ? `'${o['label']}'` : `#${li}`
      const omit = (razon: string): void => void warnings.push(`sección ${nombreSec}, entrada ${nombre} omitida: ${razon}`)
      if (l == null || typeof l !== 'object' || Array.isArray(l)) return omit('no es un mapa.')
      const label = typeof o['label'] === 'string' ? o['label'].trim() : ''
      if (!label) return omit("'label' debe ser un string no vacío.")
      const href = typeof o['href'] === 'string' ? o['href'].trim() : ''
      if (!href) return omit("'href' debe ser un string no vacío.")
      if (!hrefAdmitido(href)) return omit(`href inválido '${href}' (esperado una ruta que empiece por '/' o una URL https://).`)
      const description = o['description']
      if (description != null && typeof description !== 'string') return omit("'description' debe ser un string.")
      const newTab = o['newTab']
      if (newTab != null && typeof newTab !== 'boolean') return omit("'newTab' debe ser true o false.")
      const link: MenuLink = { label, href }
      if (typeof description === 'string' && description.trim()) link.description = description.trim()
      if (newTab === true) link.newTab = true
      links.push(link)
    })

    if (!links.length) return omitSec('se quedó sin enlaces válidos.')
    sections.push({ title: rawTitle, links })
  })
  return { sections, warnings }
}

/** Total de enlaces de un conjunto de secciones — para la línea de conteos del arranque. */
export function countMenuLinks(sections: MenuSection[]): number {
  return sections.reduce((n, s) => n + s.links.length, 0)
}
