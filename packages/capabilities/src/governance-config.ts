/**
 * Config declarativa de GOBIERNO de la instancia — parsers de primera clase para los tres YAML que
 * hasta ahora se casteaban sin validar: grupos semilla (`VERGIS_GROUPS`), dueños de PI
 * (`VERGIS_PI_OWNERS`) y el registro de fuentes (`VERGIS_SOURCES`).
 *
 * Reparto de responsabilidades con el seed (`governance-store.ts`): aquí se valida la FORMA (claves
 * raíz, tipos, campos obligatorios, slug de los ids) y el error sale nombrado ANTES de tocar SQL;
 * allá vive la SEMÁNTICA (upserts, tombstones de `mira_group_seed_removed`, `validateOferta`,
 * normalización de correos y de mayúsculas). Este módulo no normaliza ni siembra nada.
 */

import { requireRootKey } from './config-root'
import type { EngineRef, GovernanceSeed, GroupSeed } from './governance-store'

/** Mismo criterio de slug que aplica el seed de grupos y fuentes (`governance-store.ts`). */
const SLUG_RE = /^[a-z][a-z0-9_-]*$/

function asList(raw: unknown, config: string, key: string): unknown[] {
  if (!Array.isArray(raw)) throw new Error(`${config}: \`${key}\` debe ser una lista.`)
  return raw
}

function obj(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>
}

function reqString(o: Record<string, unknown>, field: string, where: string): string {
  const v = o[field]
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${where}: '${field}' debe ser un string no vacío.`)
  return v
}

function optString(o: Record<string, unknown>, field: string, where: string): string | undefined {
  const v = o[field]
  if (v == null) return undefined
  if (typeof v !== 'string') throw new Error(`${where}: '${field}' debe ser un string.`)
  return v
}

/** Valida `{ groups: [...] }` (`VERGIS_GROUPS`). Los correos los normaliza el seed, no este parser. */
export function parseGroupsConfig(doc: unknown): GroupSeed[] {
  const raw = asList(requireRootKey(doc, 'groups', 'groups'), 'groups', 'groups')
  const seen = new Set<string>()
  return raw.map((g, i) => {
    const o = obj(g)
    const where = `groups: grupo #${i}`
    const rawId = o['id']
    if (typeof rawId !== 'string') throw new Error(`${where}: 'id' debe ser un string.`)
    const id = rawId.trim().toLowerCase()
    if (!SLUG_RE.test(id)) throw new Error(`${where}: id inválido '${rawId}' (esperado [a-z][a-z0-9_-]*).`)
    if (seen.has(id)) throw new Error(`groups: id de grupo duplicado '${id}'.`)
    seen.add(id)
    const out: GroupSeed = { id: rawId, label: optString(o, 'label', where) ?? rawId }
    const members = o['members']
    if (members != null) {
      if (!Array.isArray(members)) throw new Error(`groups: '${id}'.members debe ser una lista de correos.`)
      out.members = members.map((m, j) => {
        if (typeof m !== 'string') throw new Error(`groups: '${id}'.members[${j}] debe ser un string.`)
        return m
      })
    }
    return out
  })
}

/** Valida `{ owners: { <pi>: <correo> } }` (`VERGIS_PI_OWNERS`). */
export function parsePiOwnersConfig(doc: unknown): Record<string, string> {
  const raw = requireRootKey(doc, 'pi-owners', 'owners', '{}')
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('pi-owners: `owners` debe ser un mapa.')
  }
  const out: Record<string, string> = {}
  for (const [pi, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`pi-owners: el dueño de '${pi}' debe ser un string no vacío.`)
    }
    out[pi] = value
  }
  return out
}

/** El subconjunto de `GovernanceSeed` que declara el registro de fuentes de la instancia. */
export type SourcesConfig = Pick<GovernanceSeed, 'tableSources' | 'processes' | 'processOutputs'> & {
  /** Siempre presente: es la clave raíz obligatoria del archivo (puede venir vacía). */
  sources: NonNullable<GovernanceSeed['sources']>
}

/**
 * Valida `sources.yaml` (`VERGIS_SOURCES`). Solo `sources` es clave raíz obligatoria: cero mapeos,
 * cero procesos o cero salidas es un estado legítimo (instancia sin frescura declarada), y los cuatro
 * conteos quedan visibles en el log de arranque.
 */
export function parseSourcesConfig(doc: unknown): SourcesConfig {
  const sourcesRaw = asList(requireRootKey(doc, 'sources', 'sources'), 'sources', 'sources')
  const root = obj(doc)

  const seenSource = new Set<string>()
  const sources = sourcesRaw.map((s, i) => {
    const o = obj(s)
    const where = `sources: fuente #${i}`
    const id = reqString(o, 'id', where)
    if (seenSource.has(id.trim().toLowerCase())) throw new Error(`sources: id de fuente duplicado '${id}'.`)
    seenSource.add(id.trim().toLowerCase())
    const out: NonNullable<GovernanceSeed['sources']>[number] = {
      id,
      label: reqString(o, 'label', where),
      oferta: reqString(o, 'oferta', where), // el formato (ISO o `evento`) lo valida el seed
    }
    const domain = optString(o, 'domain', where)
    if (domain !== undefined) out.domain = domain
    const connectedBy = optString(o, 'connectedBy', where)
    if (connectedBy !== undefined) out.connectedBy = connectedBy
    return out
  })

  const out: SourcesConfig = { sources }

  if ('tableSources' in root) {
    out.tableSources = asList(root['tableSources'], 'sources', 'tableSources').map((t, i) => {
      const o = obj(t)
      const where = `sources: tableSources #${i}`
      return { tableRef: reqString(o, 'tableRef', where), sourceId: reqString(o, 'sourceId', where) }
    })
  }

  if ('processes' in root) {
    out.processes = asList(root['processes'], 'sources', 'processes').map((p, i) => {
      const o = obj(p)
      const where = `sources: proceso #${i}`
      const proc: NonNullable<GovernanceSeed['processes']>[number] = {
        id: reqString(o, 'id', where),
        label: reqString(o, 'label', where),
        sourceId: reqString(o, 'sourceId', where),
      }
      if (o['engine'] != null) {
        const e = obj(o['engine'])
        const engine: EngineRef = {
          workspaceId: reqString(e, 'workspaceId', `${where}.engine`),
          itemId: reqString(e, 'itemId', `${where}.engine`),
          jobType: reqString(e, 'jobType', `${where}.engine`),
        }
        proc.engine = engine
      }
      // `logs:` (issue #99): dónde deja el proceso sus logs POR CORRIDA. Ausente = no los ofrece
      // (workspace default = el del engine; dir default RUN_LOG_DIR_DEFAULT).
      if (o['logs'] != null) {
        const l = obj(o['logs'])
        proc.logs = { lakehouseId: reqString(l, 'lakehouseId', `${where}.logs`) }
        const lw = optString(l, 'workspaceId', `${where}.logs`)
        if (lw !== undefined) proc.logs.workspaceId = lw
        const ld = optString(l, 'dir', `${where}.logs`)
        if (ld !== undefined) proc.logs.dir = ld
      }
      return proc
    })
  }

  if ('processOutputs' in root) {
    out.processOutputs = asList(root['processOutputs'], 'sources', 'processOutputs').map((po, i) => {
      const o = obj(po)
      const where = `sources: processOutputs #${i}`
      return { processId: reqString(o, 'processId', where), tableRef: reqString(o, 'tableRef', where) }
    })
  }

  return out
}
