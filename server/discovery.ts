/**
 * Descubrimiento de Productos de Información (specs authz-blind, ruteados por slug) — módulo del
 * refactor createApp() (A14).
 *
 * Escanea las specs SERVIBLES (todas sus data-capabilities en el catálogo de serving del motor
 * activo) y aplica el GATE DE GOBERNANZA fail-closed (charter §2b): en push-down (fabric) un PI que
 * lea una tabla sin política FUGA (el motor no niega por omisión), así que no se sirve a menos que
 * CADA tabla que toca tenga política. La salida se memoiza (validate-before-swap) y `rebuild()` la
 * fuerza tras un hot-reload de gobierno.
 *
 * Puro e inyectable: recibe el `store`, el motor, el catálogo de serving y seams de FS (specPaths /
 * readSpec) → testeable sin server ni disco. La LÓGICA DEL GATE es idéntica a la del monolito.
 */
import { readFileSync } from 'node:fs'
import { parseSpec } from '@vergis/mira'
import { claimValues, diagnoseClaims, isPublic, type ClaimDenial, type ClaimSet, type PolicyDecl } from '@vergis/policy'
import { analyzeSqlTables } from './sql-tables'
import { createCachedScanner } from './hot-reload'
import type { Engine } from './config'

export interface Report {
  code: string
  slug: string
  name: string
  specPath: string
  tables: string[]
  /** Conexiones (`database_ref`) que las data-entries del PI referencian — la verificación de
   * servibilidad por PI (engine=fabric) consulta SOLO estas, no todas las declaradas (issue #52). */
  databaseRefs: string[]
}

export interface DiscoveryDeps {
  /** Referencia VIVA del policy store: `reloadGovernance` la vacía y re-puebla in-place. */
  store: Map<string, PolicyDecl>
  engine: Engine
  /** Capabilities enforcing del motor activo (hardening del catálogo de serving). */
  servingCaps: Set<string>
  /** Rutas de las specs a escanear (inyectable → testeable sin disco). */
  specPaths: () => string[]
  /** Lee el contenido de una spec (default: FS). */
  readSpec?: (path: string) => string
  /** Linaje vista→bases directo (referencia VIVA, poblado por la verificación del bootstrap): permite
   * que `canAccess` herede la política de las bases para una vista-contrato sin entrada propia
   * (issue #54). Ausente o sin entrada → sin herencia (deny, como siempre). */
  resolveBases?: (table: string) => string[] | undefined
  log?: (msg: string) => void
}

export interface Discovery {
  /** Reports servibles (memoizado). */
  discover(): Report[]
  /** Fuerza el re-escaneo (tras hot-reload de gobierno); validate-before-swap. */
  rebuild(): { ok: boolean; error?: string }
  /** ¿El consumidor accede a algún dato de esta tabla? (para el índice per-consumidor). */
  canAccess(table: string, claims: ClaimSet): boolean
  /** Filtra los reports visibles para una identidad (sin datos gobernados → visible). */
  visibleFor(reports: Report[], claims: ClaimSet): Report[]
  /**
   * Por qué estos claims no pueden ver NINGUNA fila de las tablas de estos PIs (issue #165 §3).
   *
   * Observabilidad pura: NO decide nada. En particular NO se usa para esconder el PI del índice, y
   * es deliberado — esconderlo cambiaría una falla muda por otra (el sujeto pasaría de «lo abro y
   * está vacío» a «ya no está», igual de indistinguible de «no tengo permiso»). Lo que faltaba no
   * era ocultar mejor: era que alguien pudiera DECIR cuál de las tres cosas pasó.
   */
  diagnoseFor(reports: Report[], claims: ClaimSet): { table: string; denials: ClaimDenial[] }[]
}

/** slug estable desde un código de PI (minúscula, sin acentos, no-alfanum → `-`). */
export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function createDiscovery(deps: DiscoveryDeps): Discovery {
  const readSpec = deps.readSpec ?? ((p: string) => readFileSync(p, 'utf8'))
  const log = deps.log ?? ((m: string) => console.warn(m))
  const { store, engine, servingCaps } = deps

  function discoverRaw(): Report[] {
    const out: Report[] = []
    for (const p of deps.specPaths()) {
      let spec: { identity?: { code?: string; id?: string; display_name?: string }; data?: Record<string, { capability?: string; params?: { sql?: string; database_ref?: string } }> }
      try {
        spec = parseSpec(readSpec(p)) as typeof spec
      } catch {
        continue
      }
      const data = spec.data ?? {}
      const caps = Object.values(data).map((d) => d.capability ?? '')
      if (caps.length === 0 || !caps.every((c) => servingCaps.has(c))) {
        log(`[vergis-rls] '${p}' no servible bajo engine=${engine} (capability fuera del catálogo: ${caps.join(',')}) — omitido`)
        continue
      }
      const analyses = Object.values(data).map((d) => analyzeSqlTables(d.params?.sql ?? ''))
      const tables = [...new Set(analyses.flatMap((a) => a.tables))]
      const unqualified = [...new Set(analyses.flatMap((a) => a.unqualified))]
      // GATE DE GOBERNANZA (fail-closed) — crítico en push-down: en fabric una tabla SIN política
      // devuelve TODAS sus filas → un PI que la lea FUGA. En clickhouse la seguridad la da el bootstrap.
      if (engine === 'fabric') {
        // Referencias de UNA parte (`FROM dim_area`): no verificables contra el store (indexado por
        // schema.tabla) → no-gobernables, se omite el PI (fail-closed).
        if (unqualified.length > 0) {
          log(`[vergis-rls] '${p}' no servible: referencia tabla(s) sin esquema (no verificables contra el policy store): ${unqualified.join(', ')} — omitido. Calificarlas como schema.tabla.`)
          continue
        }
        // Una tabla sin política ya NO omite el PI acá: puede ser una vista-contrato que HEREDA el
        // gobierno de su base (issue #54), y el linaje solo es observable en la fuente. El veredicto
        // lo da la verificación por-PI del bootstrap (engines/fabric): sin política NI herencia
        // derivable, el PI queda bloqueado con motivo (503) — el fail-closed no se mueve, se muda.
      }
      const code = spec.identity?.code ?? spec.identity?.id ?? 'pi'
      const slug = slugify(code)
      if (out.some((r) => r.slug === slug)) {
        // Dos specs con el mismo slug: la 2ª es inalcanzable (el router hace `all.find` → la 1ª gana).
        // Antes pasaba en silencio; ahora se avisa. Usar un identity.code distinto.
        log(`[vergis-rls] '${p}' colisiona en slug '${slug}' con un PI ya descubierto — el segundo queda inalcanzable. Diferenciar identity.code.`)
      }
      const databaseRefs = [...new Set(Object.values(data).map((d) => d.params?.database_ref ?? '').filter(Boolean))]
      out.push({ code, slug, name: spec.identity?.display_name ?? code, specPath: p, tables, databaseRefs })
    }
    return out
  }

  const specReg = createCachedScanner(discoverRaw)

  function canAccess(table: string, claims: ClaimSet, seen?: Set<string>): boolean {
    const policy = store.get(table)
    if (!policy) {
      // Sin política propia: ¿vista-contrato con herencia (issue #54)? Accesible solo si TODAS sus
      // bases lo son (la vista compone sus bases: la RLS más restrictiva manda). Sin linaje → deny.
      const bases = deps.resolveBases?.(table)
      if (!bases?.length) return false
      const s = seen ?? new Set<string>()
      if (s.has(table)) return false // ciclo defensivo
      s.add(table)
      return bases.every((b) => canAccess(b, claims, s))
    }
    if (isPublic(policy)) return true // grant: all
    return policy.predicates.some((pred) => claimValues(claims, pred.claim).length > 0)
  }

  function visibleFor(reports: Report[], claims: ClaimSet): Report[] {
    return reports.filter((r) => r.tables.length === 0 || r.tables.some((t) => canAccess(t, claims)))
  }

  function diagnoseFor(reports: Report[], claims: ClaimSet): { table: string; denials: ClaimDenial[] }[] {
    // Una tabla puede servir a varios PIs; el hallazgo es de la TABLA y su política, no del PI.
    const tables = [...new Set(reports.flatMap((r) => r.tables))]
    const out: { table: string; denials: ClaimDenial[] }[] = []
    for (const t of tables) {
      const policy = store.get(t)
      if (!policy) continue // sin política propia (o herencia de vista): no hay nada que explicar acá
      const denials = diagnoseClaims(policy, claims)
      if (denials.length) out.push({ table: t, denials })
    }
    return out
  }

  return { discover: () => specReg.get(), rebuild: () => specReg.rebuild(), canAccess, visibleFor, diagnoseFor }
}
