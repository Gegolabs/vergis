/**
 * QUIÉN ESCRIBE cada tabla del terreno (`VERGIS_WRITERS`, CAP-197) — la declaración de instancia que
 * el catálogo del esquema (Datadoc) necesita y que ninguna fuente medible tiene.
 *
 * El nodo sabe, midiendo, qué tablas existen, qué forma tienen y quién las LEE (las specs de los PI
 * lo dicen). Lo que no puede medir es quién las ESCRIBE: un job de Spark, un script a mano, un
 * notebook o la plataforma misma dejan filas iguales, y el catálogo sin esa columna le dice a un
 * consumidor «acá hay datos» sin decirle de dónde vienen ni cada cuánto cambian — que es justamente
 * lo que necesita para decidir si puede construir encima.
 *
 * **Nunca se inventa.** Una tabla sin escritor declarado sale «escritor no declarado», con esas
 * palabras. Un hueco honesto es información; una atribución adivinada es un contrato falso.
 *
 * **Semántica de fallas — dos niveles, igual que `static-config.ts` y `menu-config.ts`:**
 *
 *  · La CLAVE RAÍZ ausente es FATAL (`config-root.ts`): un archivo declarado que perdió su
 *    `writers:` es el modo de falla que ese contrato existe para atrapar, y colapsar a cero
 *    escritores lo escondería detrás de un catálogo que dice «nadie escribe nada».
 *  · Una ENTRADA inválida se OMITE con aviso nombrado y el nodo levanta igual. Un escritor mal
 *    escrito no es razón para dejar la plataforma sin servir: el daño es una línea que falta en una
 *    página, y el aviso la nombra.
 *
 * **Una tabla sin esquema se omite de su entrada, conservando el escritor.** El nodo indexa por
 * `schema.tabla` en todas partes (`server/sql-tables.ts`, el policy store): una referencia de una
 * sola parte no es cruzable contra nada, así que atribuirla sería atribuirla a la nada. El escritor
 * se conserva con sus demás tablas — perder las cinco buenas por una mala sería peor.
 *
 * **Las claves desconocidas se IGNORAN**, deliberadamente: el archivo de una instancia suele llevar
 * campos propios de su tooling (ids del motor, banderas de drift-check), y exigirle un archivo
 * separado para el nodo obligaría a mantener dos copias de la misma declaración — que es como se
 * fabrica el drift que este catálogo existe para no tener.
 *
 * **La existencia de la `conexion` NO se valida acá.** El parser es puro y no ve `VERGIS_CONNECTIONS`;
 * quien genera marca «conexión desconocida» en los avisos de su corrida, donde el operador la ve.
 */

import { requireRootKey } from '@vergis/capabilities'

/** Estados admisibles de un escritor. Vocabulario CERRADO: un estado libre no se puede leer. */
export const ESTADOS_ESCRITOR = ['vigente', 'fallback', 'retirado'] as const
export type EstadoEscritor = (typeof ESTADOS_ESCRITOR)[number]

/** Un escritor declarado por la instancia. */
export interface WriterDecl {
  /** Identidad del escritor, única (case-insensitive). */
  id: string
  /** `database_ref` de `VERGIS_CONNECTIONS` donde escribe. Su existencia la verifica el generador. */
  conexion: string
  /** Clase del escritor, texto corto y libre: `sjd` · `script-manual` · `producto` · `notebook`… */
  tipo: string
  estado: EstadoEscritor
  /** Qué lo dispara, en una línea. Es lo que un consumidor lee para saber cuándo cambia el dato. */
  disparo: string
  /** Las tablas que escribe, normalizadas a `schema.tabla` en minúsculas y sin corchetes. ≥1. */
  tablas: string[]
  /** Id de un `processes[]` del registro de fuentes — enlaza el escritor con su frescura. */
  proceso?: string
  /** Tablas que LEE (contexto, no atribución), mismo formato que `tablas`. */
  lee?: string[]
  notas?: string
}

/** Lo que devuelve el parser: los escritores válidos y los avisos de lo que se omitió. */
export interface WritersConfig {
  writers: WriterDecl[]
  /** Una línea por omisión, nombrándola y con la razón. Vacío = nada se omitió. */
  warnings: string[]
}

/** `schema.tabla` en minúsculas, sin corchetes. `null` si la referencia no trae esquema. */
export function normalizarTabla(raw: unknown): string | null {
  const s = String(raw ?? '')
    .replace(/[[\]]/g, '')
    .trim()
    .toLowerCase()
  if (!s) return null
  const partes = s.split('.')
  // Exactamente dos partes no vacías: `dbo.t` sí, `t` no (no cruzable), `a.b.c` tampoco (el nodo no
  // indexa por base de datos — la conexión ya la dice la entrada).
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null
  if (!/^[a-z0-9_]+$/.test(partes[0]) || !/^[a-z0-9_]+$/.test(partes[1])) return null
  return `${partes[0]}.${partes[1]}`
}

const REF_RE = /^[A-Za-z0-9_-]+$/

/** Valida `{ writers: [...] }` (`VERGIS_WRITERS`). Ver la semántica de fallas en la cabecera. */
export function parseWritersConfig(doc: unknown): WritersConfig {
  const raw = requireRootKey(doc, 'writers', 'writers')
  if (!Array.isArray(raw)) throw new Error('writers: `writers` debe ser una lista — para declarar «no hay», usa `writers: []`.')
  const writers: WriterDecl[] = []
  const warnings: string[] = []
  const vistos = new Set<string>()
  raw.forEach((entry, i) => {
    const o = (entry ?? {}) as Record<string, unknown>
    const rawId = typeof o['id'] === 'string' ? o['id'].trim() : ''
    const nombre = rawId ? `'${rawId}'` : `#${i}`
    const omit = (razon: string): void => void warnings.push(`escritor ${nombre} omitido: ${razon}`)
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return omit('no es un mapa.')
    if (!rawId) return omit("'id' debe ser un string no vacío.")
    if (vistos.has(rawId.toLowerCase())) return omit(`el id '${rawId}' ya fue declarado por otro escritor.`)
    const conexion = typeof o['conexion'] === 'string' ? o['conexion'].trim() : ''
    if (!conexion) return omit("'conexion' debe ser un string no vacío (el database_ref donde escribe).")
    if (!REF_RE.test(conexion)) return omit(`'conexion' inválida '${conexion}' (esperado [A-Za-z0-9_-]+, el database_ref de VERGIS_CONNECTIONS).`)
    const tipo = typeof o['tipo'] === 'string' ? o['tipo'].trim() : ''
    if (!tipo) return omit("'tipo' debe ser un string no vacío (sjd · script-manual · producto · notebook…).")
    const estado = typeof o['estado'] === 'string' ? o['estado'].trim().toLowerCase() : ''
    if (!(ESTADOS_ESCRITOR as readonly string[]).includes(estado))
      return omit(`'estado' inválido '${estado}' (se admite ${ESTADOS_ESCRITOR.join(' · ')}).`)
    const disparo = typeof o['disparo'] === 'string' ? o['disparo'].replace(/\s+/g, ' ').trim() : ''
    if (!disparo) return omit("'disparo' debe ser un string no vacío (qué lo dispara, en una línea).")
    const rawTablas = o['tablas']
    if (!Array.isArray(rawTablas) || rawTablas.length === 0) return omit("'tablas' debe ser una lista con al menos una tabla 'schema.tabla'.")
    const tablas: string[] = []
    for (const t of rawTablas) {
      const n = normalizarTabla(t)
      if (n == null) {
        // La tabla se omite, el escritor se conserva: perder sus demás tablas por una mala referencia
        // sería un daño mayor que el hueco que deja la que se cae.
        warnings.push(`escritor ${nombre}: la tabla '${String(t)}' se omite — se exige 'schema.tabla' (el nodo indexa por esquema y una referencia de una parte no es cruzable).`)
        continue
      }
      if (!tablas.includes(n)) tablas.push(n)
    }
    if (tablas.length === 0) return omit("ninguna de sus 'tablas' trae esquema — no queda nada que atribuir.")
    vistos.add(rawId.toLowerCase())
    const out: WriterDecl = { id: rawId, conexion, tipo, estado: estado as EstadoEscritor, disparo, tablas }
    const proceso = o['proceso']
    if (typeof proceso === 'string' && proceso.trim()) out.proceso = proceso.trim()
    const lee = o['lee']
    if (Array.isArray(lee)) {
      const leidas: string[] = []
      for (const t of lee) {
        const n = normalizarTabla(t)
        if (n == null) {
          warnings.push(`escritor ${nombre}: la tabla leída '${String(t)}' se omite — se exige 'schema.tabla'.`)
          continue
        }
        if (!leidas.includes(n)) leidas.push(n)
      }
      if (leidas.length) out.lee = leidas
    }
    const notas = o['notas']
    if (typeof notas === 'string' && notas.trim()) out.notas = notas.trim()
    writers.push(out)
  })
  return { writers, warnings }
}

/**
 * Los escritores de una tabla EN UNA CONEXIÓN — los vigentes primero, y dentro de cada estado en el
 * orden en que el archivo los declara.
 *
 * La conexión es parte de la llave y no un detalle: dos Datahouses pueden tener `dbo.fact_ventas`, y
 * atribuir el escritor de uno a la tabla del otro sería exactamente la clase de afirmación falsa que
 * este registro existe para no producir.
 */
export function escritoresDe(cfg: WritersConfig | undefined, tabla: string, ref: string): WriterDecl[] {
  const t = normalizarTabla(tabla)
  if (!cfg || t == null) return []
  const suyos = cfg.writers.filter((w) => w.conexion === ref && w.tablas.includes(t))
  const rango = (e: EstadoEscritor): number => (e === 'vigente' ? 0 : e === 'fallback' ? 1 : 2)
  return [...suyos].sort((a, b) => rango(a.estado) - rango(b.estado))
}
