/**
 * El catálogo de INSTRUMENTOS: archivos en `VERGIS_INSTRUMENTOS_DIR`, releídos en caliente (D-75).
 *
 *     <dir>/guides/*.json        las guías (id = nombre sin .json)
 *     <dir>/recursos/preu/**     los PNG que las guías referencian como /preu/…
 *     <dir>/reports/*.json       las devoluciones
 *
 * **Publicar un instrumento es copiar el archivo.** No hay API de alta: la mecánica es la misma que
 * la de las specs de Mira, que la instancia ya sabe operar. El caché es por `mtime` (como el
 * `_guide_cache` de `server.py`), así que un archivo nuevo o cambiado se ve en el request siguiente
 * SIN reiniciar; el `contract.watch` que el nodo instala solo adelanta la invalidación.
 *
 * La INMUTABILIDAD se hace cumplir por AVISO, no por rechazo: un id que reaparece con otro sha se
 * sirve igual (rechazarlo dejaría al estudiante sin la guía que alguien corrigió a mano en el disco)
 * y se loguea **una vez por id**.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, extname, normalize, isAbsolute } from 'node:path'
import type { Guia } from './tipos'

/** Metadatos de catálogo: la misma forma que `_list_guides` de `server.py`. */
export interface GuiaMeta {
  id: string
  title: string
  subtitle: string
  subject: string
  group: string
  sprint: string
  sprintOrder: unknown
  variant: string
  sectionCount: number
  mode: string
  new: boolean
  code: string
  institution: string
  student: string
  invalidated: boolean
}

export interface GuiaCargada {
  meta: GuiaMeta
  guia: Guia
  sha256: string
}

export interface InstrumentosDeps {
  dir: string
  log?: (msg: string) => void
}

export interface Instrumentos {
  /** Metadatos de TODAS las guías del directorio (el filtro por estudiante es del Let). */
  listar(): GuiaMeta[]
  /** Una guía completa, o `null` si no existe. */
  guia(id: string): GuiaCargada | null
  /** Los reportes de devolución (metadatos, sin `content_html`), como `_list_reports`. */
  reportes(): Record<string, unknown>[]
  /** Un reporte completo, o `null`. */
  reporte(id: string): Record<string, unknown> | null
  /** Bytes de un recurso bajo `<dir>/recursos/`, o `null` si no existe o la ruta escapa. */
  recurso(rel: string): { bytes: Uint8Array; contentType: string } | null
  /** Invalida el caché (lo llama el watch del nodo). */
  invalidar(): void
}

const TIPOS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

const txt = (v: unknown, def = ''): string => (typeof v === 'string' ? v : def)

export function crearInstrumentos(deps: InstrumentosDeps): Instrumentos {
  const log = deps.log ?? ((m: string) => console.warn(m))
  const guidesDir = join(deps.dir, 'guides')
  const reportsDir = join(deps.dir, 'reports')
  const recursosDir = join(deps.dir, 'recursos')
  /** id → (mtime, contenido). Igual que `_guide_cache`: la clave de frescura es el mtime. */
  const cache = new Map<string, { mtime: number; cargada: GuiaCargada }>()
  /** ids por los que ya se avisó el cambio de sha — el aviso es UNA vez por id y por proceso. */
  const avisados = new Set<string>()

  const jsonsDe = (dir: string): string[] => {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    } catch {
      return []
    }
  }

  function cargar(id: string): GuiaCargada | null {
    const file = join(guidesDir, `${id}.json`)
    let mtime: number
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      return null
    }
    const hit = cache.get(id)
    if (hit && hit.mtime === mtime) return hit.cargada
    let texto: string
    try {
      texto = readFileSync(file, 'utf8')
    } catch {
      return null
    }
    let guia: Guia
    try {
      guia = JSON.parse(texto) as Guia
    } catch (e) {
      log(`[daftar] instrumento '${id}' ilegible (JSON inválido): ${e instanceof Error ? e.message : String(e)} — omitido`)
      return null
    }
    const sha256 = createHash('sha256').update(texto).digest('hex')
    if (hit && hit.cargada.sha256 !== sha256 && !avisados.has(id)) {
      avisados.add(id)
      log(
        `[daftar] el instrumento '${id}' cambió de sha (${hit.cargada.sha256.slice(0, 12)} → ${sha256.slice(0, 12)}): se sirve el nuevo, ` +
          `pero una guía publicada es INMUTABLE — los intentos ya rendidos quedan contra otro contenido. Publicar con id nuevo.`,
      )
    }
    const meta: GuiaMeta = {
      id,
      title: txt(guia.title, id),
      subtitle: txt(guia.subtitle),
      subject: txt(guia.subject),
      group: txt(guia.group, id),
      sprint: txt(guia.sprint),
      sprintOrder: guia.sprintOrder ?? null,
      variant: txt(guia.variant, 'Guía'),
      sectionCount: (guia.sections ?? []).length,
      mode: txt(guia.mode, 'practice'),
      new: guia.new === true,
      code: txt(guia.code),
      institution: txt(guia.institution),
      student: txt(guia.student),
      invalidated: guia.invalidated === true,
    }
    const cargada = { meta, guia, sha256 }
    cache.set(id, { mtime, cargada })
    return cargada
  }

  return {
    listar(): GuiaMeta[] {
      const out: GuiaMeta[] = []
      for (const f of jsonsDe(guidesDir)) {
        const c = cargar(f.slice(0, -'.json'.length))
        if (c) out.push(c.meta)
      }
      return out
    },
    guia: (id: string) => (idSeguro(id) ? cargar(id) : null),
    reportes(): Record<string, unknown>[] {
      const out: Record<string, unknown>[] = []
      for (const f of jsonsDe(reportsDir)) {
        try {
          const data = JSON.parse(readFileSync(join(reportsDir, f), 'utf8')) as Record<string, unknown>
          const meta: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(data)) if (k !== 'content_html') meta[k] = v
          meta['id'] = f.slice(0, -'.json'.length)
          out.push(meta)
        } catch {
          /* un reporte ilegible no tumba el catálogo */
        }
      }
      return out
    },
    reporte(id: string): Record<string, unknown> | null {
      if (!idSeguro(id)) return null
      try {
        return JSON.parse(readFileSync(join(reportsDir, `${id}.json`), 'utf8')) as Record<string, unknown>
      } catch {
        return null
      }
    },
    recurso(rel: string): { bytes: Uint8Array; contentType: string } | null {
      // TRAVERSAL: se normaliza y se exige que el resultado siga colgando del directorio de recursos.
      // Rechaza `..`, rutas absolutas y cualquier composición que escape — el nodo sirve bytes de
      // disco acá, así que el control es de contención, no de higiene.
      if (!rel || isAbsolute(rel) || rel.includes('\0')) return null
      const destino = normalize(join(recursosDir, rel))
      const raiz = normalize(recursosDir + '/')
      if (!destino.startsWith(raiz)) return null
      try {
        if (!statSync(destino).isFile()) return null
        return { bytes: readFileSync(destino), contentType: TIPOS[extname(destino).toLowerCase()] ?? 'application/octet-stream' }
      } catch {
        return null
      }
    },
    invalidar: () => cache.clear(),
  }
}

/** Un id de instrumento es un nombre de archivo, jamás una ruta. */
export function idSeguro(id: string): boolean {
  return !!id && !id.includes('/') && !id.includes('\\') && !id.includes('\0') && id !== '.' && id !== '..'
}
