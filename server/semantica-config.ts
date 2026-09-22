/**
 * QUÉ SIGNIFICA cada cosa (`VERGIS_SEMANTICA`, CAP-197) — el diccionario de instancia que el catálogo
 * del esquema no puede medir.
 *
 * El catálogo SQL trae el nombre, el tipo y la nulabilidad de una columna; no trae qué es. Esa es la
 * única parte del Datadoc curada a mano, y por eso es DECLARACIÓN de instancia y no estado del nodo:
 * la escribe quien conoce el negocio, se versiona con el resto de su config y se recarga en caliente
 * como cualquier otro slice — editar una descripción y regenerar no exige restart.
 *
 * **TEXTO PLANO, sin excepciones, y esto es seguridad y no estilo.** Todo lo que entra por acá se
 * escapa al renderizar (`escapeHtml`); la única marca admitida es el acento grave `` `x` ``, que sale
 * como `<code>x</code>`. Un YAML de instancia NO es un canal para inyectar marcado en una página que
 * sirve el nodo bajo su propio gate: quien pueda editar el archivo podría poner un `<script>` en una
 * descripción y ejecutarlo en el navegador de cualquiera que entre al catálogo. El control positivo
 * de ese escape es un test, no una intención.
 *
 * **Semántica de fallas — dos niveles**, igual que el resto de la config de instancia: la clave raíz
 * `semantica:` ausente es FATAL, y dentro de ella `conexiones` ausente también (es LA lista: sin
 * ella el archivo no declara nada y colapsar a cero escondería el truncado). Una ENTRADA inválida se
 * omite con aviso nombrado y el nodo levanta igual.
 *
 * **Nunca se inventa.** Una entidad sin entrada sale «sin descripción»; una columna sin texto sale
 * vacía. El hueco es visible a propósito: es el mapa de lo que falta documentar.
 */

import { requireRootKey } from '@vergis/capabilities'
import { escapeHtml } from '@vergis/capabilities'
import { normalizarTabla } from './writers-config'

/** Clases que la instancia puede FORZAR sobre una entidad cuando el hecho medido no alcanza. */
export const CLASES_ENTIDAD = ['publicado', 'interno', 'deuda'] as const
export type ClaseEntidad = (typeof CLASES_ENTIDAD)[number]

/** Lo que la instancia declara sobre UNA entidad. */
export interface SemanticaEntidad {
  descripcion?: string
  /** Mapa columna (en minúsculas) → texto. La búsqueda es case-insensitive. */
  columnas?: Record<string, string>
  /**
   * Sobreescribe la clase derivada de los hechos medidos. Existe porque las convenciones de nombre
   * (`_bak_*`, `raw_*`, un prefijo de plataforma) son de la INSTANCIA y no del motor: el Producto
   * clasifica por lector/escritor/política, y donde eso no baste, la instancia lo dice por entidad
   * en vez de meter su alfabeto adentro del nodo.
   */
  clase?: ClaseEntidad
}

/** Lo que la instancia declara sobre UNA conexión. */
export interface SemanticaConexion {
  conexion: string
  intro?: string
  joins?: string[]
  /** `schema.tabla` (normalizado) → su semántica. */
  entidades?: Record<string, SemanticaEntidad>
}

export interface SemanticaConfig {
  /** Texto de instancia para la portada. Ausente ⇒ solo el texto genérico del nodo. */
  portada?: string
  /** Texto de instancia para la página de seguridad. Ausente ⇒ solo el genérico y lo medido. */
  seguridad?: string
  conexiones: SemanticaConexion[]
  warnings: string[]
}

const REF_RE = /^[A-Za-z0-9_-]+$/

/**
 * Texto de instancia → HTML seguro: se escapa TODO y después se re-admite el acento grave como
 * `<code>`. El orden importa — escapar primero significa que un `<code>` que el autor escribió a mano
 * sale como texto, que es exactamente lo que se quiere.
 *
 * El acento grave se toma de a pares y sin anidar; uno impar queda como texto escapado, no abre nada.
 */
export function textoInline(s: string | undefined): string {
  if (!s) return ''
  const escapado = escapeHtml(String(s))
  return escapado.replace(/`([^`]+)`/g, (_m, dentro: string) => `<code>${dentro}</code>`)
}

function optTexto(o: Record<string, unknown>, campo: string): string | undefined {
  const v = o[campo]
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

/** Valida `{ semantica: { … } }` (`VERGIS_SEMANTICA`). Ver la semántica de fallas en la cabecera. */
export function parseSemanticaConfig(doc: unknown): SemanticaConfig {
  const raiz = requireRootKey(doc, 'semantica', 'semantica', '{}')
  if (raiz == null || typeof raiz !== 'object' || Array.isArray(raiz))
    throw new Error('semantica: `semantica` debe ser un mapa — para declarar «no hay», usa `semantica:` con `conexiones: []`.')
  const root = raiz as Record<string, unknown>
  const rawConex = requireRootKey(root, 'semantica', 'conexiones')
  if (!Array.isArray(rawConex))
    throw new Error('semantica: `conexiones` debe ser una lista — para declarar «no hay», usa `conexiones: []`.')

  const warnings: string[] = []
  const conexiones: SemanticaConexion[] = []
  const vistas = new Set<string>()

  rawConex.forEach((entry, i) => {
    const o = (entry ?? {}) as Record<string, unknown>
    const ref = typeof o['conexion'] === 'string' ? o['conexion'].trim() : ''
    const nombre = ref ? `'${ref}'` : `#${i}`
    const omit = (razon: string): void => void warnings.push(`semántica de conexión ${nombre} omitida: ${razon}`)
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return omit('no es un mapa.')
    if (!ref) return omit("'conexion' debe ser un string no vacío (el database_ref).")
    if (!REF_RE.test(ref)) return omit(`'conexion' inválida '${ref}' (esperado [A-Za-z0-9_-]+).`)
    if (vistas.has(ref)) return omit(`la conexión '${ref}' ya fue declarada.`)
    vistas.add(ref)

    const out: SemanticaConexion = { conexion: ref }
    const intro = optTexto(o, 'intro')
    if (intro) out.intro = intro
    const joins = o['joins']
    if (joins != null) {
      if (!Array.isArray(joins)) warnings.push(`semántica de conexión ${nombre}: 'joins' debe ser una lista — se ignora.`)
      else {
        const lista = joins.map((j) => String(j ?? '').trim()).filter(Boolean)
        if (lista.length) out.joins = lista
      }
    }
    const entidades = o['entidades']
    if (entidades != null) {
      if (entidades == null || typeof entidades !== 'object' || Array.isArray(entidades)) {
        warnings.push(`semántica de conexión ${nombre}: 'entidades' debe ser un mapa 'schema.tabla' → { descripcion, columnas, clase } — se ignora.`)
      } else {
        const mapa: Record<string, SemanticaEntidad> = {}
        for (const [clave, valor] of Object.entries(entidades as Record<string, unknown>)) {
          const t = normalizarTabla(clave)
          if (t == null) {
            warnings.push(`semántica de conexión ${nombre}: la entidad '${clave}' se omite — se exige 'schema.tabla'.`)
            continue
          }
          const v = (valor ?? {}) as Record<string, unknown>
          if (valor == null || typeof valor !== 'object' || Array.isArray(valor)) {
            warnings.push(`semántica de conexión ${nombre}: la entidad '${t}' se omite — su valor no es un mapa.`)
            continue
          }
          const ent: SemanticaEntidad = {}
          const desc = optTexto(v, 'descripcion')
          if (desc) ent.descripcion = desc
          const cols = v['columnas']
          if (cols != null) {
            if (cols == null || typeof cols !== 'object' || Array.isArray(cols)) {
              warnings.push(`semántica de conexión ${nombre}, entidad '${t}': 'columnas' debe ser un mapa columna → texto — se ignora.`)
            } else {
              const cm: Record<string, string> = {}
              for (const [c, texto] of Object.entries(cols as Record<string, unknown>)) {
                const nc = String(c ?? '').trim().toLowerCase()
                const tt = String(texto ?? '').trim()
                if (nc && tt) cm[nc] = tt
              }
              if (Object.keys(cm).length) ent.columnas = cm
            }
          }
          const clase = v['clase']
          if (clase != null) {
            const c = String(clase).trim().toLowerCase()
            if ((CLASES_ENTIDAD as readonly string[]).includes(c)) ent.clase = c as ClaseEntidad
            else warnings.push(`semántica de conexión ${nombre}, entidad '${t}': 'clase' inválida '${c}' (se admite ${CLASES_ENTIDAD.join(' · ')}) — se ignora esa clave.`)
          }
          mapa[t] = ent
        }
        if (Object.keys(mapa).length) out.entidades = mapa
      }
    }
    conexiones.push(out)
  })

  const cfg: SemanticaConfig = { conexiones, warnings }
  const portada = optTexto(root, 'portada')
  if (portada) cfg.portada = portada
  const seguridad = optTexto(root, 'seguridad')
  if (seguridad) cfg.seguridad = seguridad
  return cfg
}

/** La semántica declarada para una conexión, o `undefined`. */
export function semanticaDe(cfg: SemanticaConfig | undefined, ref: string): SemanticaConexion | undefined {
  return cfg?.conexiones.find((c) => c.conexion === ref)
}

/** La semántica declarada para una entidad de una conexión, o `undefined`. */
export function semanticaEntidad(cfg: SemanticaConfig | undefined, ref: string, tabla: string): SemanticaEntidad | undefined {
  const t = normalizarTabla(tabla)
  if (t == null) return undefined
  return semanticaDe(cfg, ref)?.entidades?.[t]
}
