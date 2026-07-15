/**
 * Modelo de NIVELES DE ACCESO al dato (cluster 077 / plan 094). Taxonomía **interna**: el usuario
 * NUNCA oye estos nombres. El nivel taxonomiza la *naturaleza de la brecha* entre una intención y el
 * dato disponible; su proyección a la voz del usuario (expectativa de entrega) vive en el prompt, no acá.
 *
 *   1 gestionado  — en la capa servible (Silver / vistas-contrato): consultable YA. ÚNICO nivel probeable.
 *   2 conectado   — sistema con acceso vivo, dato aún no curado (SAP Business One, Buk).
 *   3 conectable  — sistema del inventario sin conector aún (Transtecnia).
 *   4 alcanzable  — gestionado 100% manual en un artefacto digital (Excel), sin sistema: se puede pedir.
 *   5 elicitable  — manejado manualmente sin instrumento digital compartible; vive en la memoria de gente.
 *   (6 desconocido — NO se cataloga: es la AUSENCIA de match; vive solo en la taxonomía del prompt.)
 *
 * COMPAT: una entrada sin `nivel` es `gestionado` (el catalog.json histórico sigue válido sin cambios).
 * REGLA DE SEGURIDAD: solo `gestionado` es probeable (describe/profile/probe) — el resto se rechaza claro.
 */

/** Los cinco niveles catalogables (el 6·desconocido no se cataloga). */
export type NivelAcceso = 'gestionado' | 'conectado' | 'conectable' | 'alcanzable' | 'elicitable'
export const NIVELES_ACCESO: readonly NivelAcceso[] = ['gestionado', 'conectado', 'conectable', 'alcanzable', 'elicitable']

/** Acción de cierre de cada nivel (el modelo es operable, no solo descriptivo). */
export type AccionDeCierre = 'curar' | 'conectar' | 'intake-recurrente' | 'levantar' | 'descubrir'
export const ACCIONES_DE_CIERRE: readonly AccionDeCierre[] = ['curar', 'conectar', 'intake-recurrente', 'levantar', 'descubrir']

/**
 * Una entrada del catálogo de instancia (censo de fuentes). El nivel 1 apunta a un objeto servible
 * (`dbo.v_*`); los demás niveles describen una fuente todavía no servible.
 */
export interface CatalogEntry {
  /** Identificador de la fuente. Nivel 1: el objeto servible (`dbo.v_saldos`). Otros: un id de la fuente. */
  name: string
  schema?: string
  /** Descripción en lenguaje de NEGOCIO (lo que el usuario entendería: «saldos de cartera por empresa»). */
  description?: string
  rows_estimate?: number
  /** Nivel de acceso. Ausente ⇒ `gestionado` (compat). */
  nivel?: NivelAcceso
  /** Dominio de negocio (Finanzas, Ventas, Personas, Plantación…). */
  dominio?: string
  /** Sistema de origen (niveles 2 y 3): «SAP Business One», «Buk», «Transtecnia». */
  sistema?: string
  /** Dueño del artefacto manual (nivel 4). «por confirmar» si no se sabe (jamás inventar). */
  dueno?: string
  /** Artefacto que lo contiene (nivel 4): «Excel de planificación de laboratorio». */
  artefacto?: string
  /** Quién tiene el conocimiento (nivel 5). «por confirmar» si no se sabe (jamás inventar). */
  quien_sabe?: string
}

/** El nivel efectivo de una entrada (ausente ⇒ gestionado, compat). */
export function nivelOf(e: CatalogEntry): NivelAcceso {
  return e.nivel ?? 'gestionado'
}

/** ¿Es probeable? SOLO el nivel gestionado (regla de seguridad del plan 094 · WP1). */
export function isProbeable(e: CatalogEntry): boolean {
  return nivelOf(e) === 'gestionado'
}

/** Nombres de las entradas probeables (gestionado) — el allowlist REAL de las probes y del sql-guard. */
export function probeableNames(catalog: CatalogEntry[]): string[] {
  return catalog.filter(isProbeable).map((e) => e.name)
}

/** Última hoja de un nombre calificado, en minúsculas: `dbo.v_saldos` → `v_saldos`. */
function leaf(name: string): string {
  return name.split('.').pop()!.trim().toLowerCase()
}

/** El nivel de un objeto por su nombre (por hoja del nombre calificado), o undefined si no está en el catálogo. */
export function nivelForName(catalog: CatalogEntry[], name: string): NivelAcceso | undefined {
  const l = leaf(name)
  const e = catalog.find((c) => leaf(c.name) === l)
  return e ? nivelOf(e) : undefined
}

/** Etiqueta interna de un nivel (para trazas/errores internos; jamás para la voz del usuario). */
const VALID = new Set<string>(NIVELES_ACCESO)

/**
 * Parsea el JSON del catálogo (lista o `{catalog:[…]}`) a `CatalogEntry[]`, tolerante y validante:
 * ignora entradas sin `name`; un `nivel` desconocido se degrada a `gestionado` con la advertencia
 * anotada (no revienta el arranque). Devuelve las entradas + las advertencias para el log del server.
 * COMPAT: el catalog.json histórico (sin `nivel`) parsea idéntico, todo como gestionado.
 */
export function parseCatalog(json: unknown): { catalog: CatalogEntry[]; warnings: string[] } {
  const warnings: string[] = []
  const raw = Array.isArray(json) ? json : (json as { catalog?: unknown })?.catalog
  if (!Array.isArray(raw)) return { catalog: [], warnings: ['El catálogo no es una lista ni un objeto {catalog:[…]}.'] }
  const catalog: CatalogEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = typeof o['name'] === 'string' ? o['name'].trim() : ''
    if (!name) {
      warnings.push('Entrada de catálogo sin `name` ignorada.')
      continue
    }
    const e: CatalogEntry = { name }
    if (o['nivel'] != null) {
      const n = String(o['nivel'])
      if (VALID.has(n)) e.nivel = n as NivelAcceso
      else warnings.push(`Nivel desconocido '${n}' en '${name}' → tratado como 'gestionado'.`)
    }
    if (typeof o['schema'] === 'string') e.schema = o['schema']
    if (typeof o['description'] === 'string') e.description = o['description']
    if (typeof o['rows_estimate'] === 'number') e.rows_estimate = o['rows_estimate']
    if (typeof o['dominio'] === 'string') e.dominio = o['dominio']
    if (typeof o['sistema'] === 'string') e.sistema = o['sistema']
    if (typeof o['dueno'] === 'string') e.dueno = o['dueno']
    if (typeof o['artefacto'] === 'string') e.artefacto = o['artefacto']
    if (typeof o['quien_sabe'] === 'string') e.quien_sabe = o['quien_sabe']
    catalog.push(e)
  }
  return { catalog, warnings }
}
