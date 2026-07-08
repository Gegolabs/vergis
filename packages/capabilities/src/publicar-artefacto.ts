import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import type { Capability } from '@vergis/botler'

/**
 * Stub de publicación: escribe el artefacto a un archivo local y devuelve la ruta.
 * En producción se reemplaza por almacenar + URL firmada.
 */
interface PublishParams {
  path: string
  content: string
  baseDir?: string
}

export const publicarArtefacto: Capability = {
  name: 'publicar-artefacto',
  async execute(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as PublishParams
    if (!p.path) throw new Error('publicar-artefacto: falta params.path')
    if (typeof p.content !== 'string') throw new Error('publicar-artefacto: falta params.content (string)')
    const base = resolve(p.baseDir ?? process.cwd())
    // Acotar al baseDir: una ruta absoluta o con `..` derivada del spec no debe escribir fuera.
    const full = resolve(base, p.path)
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error(`publicar-artefacto: la ruta '${p.path}' escapa del baseDir`)
    }
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, p.content)
    return { path: full, uri: `file://${full}` }
  },
}
