/**
 * Motor C (Fabric push-down) — LÓGICA PURA de la verificación de servibilidad POR PI (issue #52).
 *
 * La unidad de fail-closed es EL PI, no el proceso: cada PI verifica que TODAS sus tablas gobernadas
 * tengan artefacto `SECURITY POLICY` nativo en la fuente; el que no verifica no se sirve (con motivo
 * accionable) y los demás siguen. Solo se consultan las conexiones EN USO por algún PI descubierto —
 * una conexión declarada que nadie usa no puede tumbar nada.
 *
 * HERENCIA DE GOBIERNO VÍA VISTAS (issue #54): una tabla servida SIN entrada en el policy store puede
 * ser una VISTA-CONTRATO (`v_<entidad>`) sobre una base gobernada — la RLS sustantiva es data-anchored
 * en la base y filtra a través de la vista, así que exigirle a la vista política + secpol propias solo
 * duplicaba artefactos. El gate resuelve el linaje vista→base en la fuente (sys.sql_expression_
 * dependencies, SOLO vistas `WITH SCHEMABINDING` y dependencias intra-database — certeza o nada) y
 * acepta la vista si TODAS sus bases (transitivo) están gobernadas y verificadas. Linaje no derivable
 * → se exige la declaración explícita, como siempre (fail-closed).
 *
 * INDETERMINACIÓN ≠ VEREDICTO: si la consulta a una conexión falla (credencial vencida, warehouse
 * pausado), no sabemos si el artefacto está o no. Un PI que YA verificaba conserva su veredicto sano
 * (validate-before-swap: un fallo transitorio no degrada lo que servía); uno nuevo o ya degradado
 * queda no-servible (fail-closed en frío). Un veredicto DEFINITIVO (la conexión respondió y el
 * artefacto NO está) siempre gana: ningún camino afloja el fail-closed.
 */
import type { PolicyDecl } from '@vergis/policy'

/** SQL de verificación: tablas con SECURITY POLICY habilitada en la fuente. */
export const SYS_SECURITY_POLICIES_SQL =
  `SELECT OBJECT_SCHEMA_NAME(pr.target_object_id) AS sch, OBJECT_NAME(pr.target_object_id) AS tbl ` +
  `FROM sys.security_policies p JOIN sys.security_predicates pr ON pr.object_id = p.object_id WHERE p.is_enabled = 1`

/** SQL de linaje vista→base: SOLO vistas schemabound (el linaje no puede cambiar bajo los pies sin
 * DDL) y dependencias resueltas intra-database (`referenced_id IS NOT NULL`; cross-db queda fuera →
 * sin certeza no hay herencia). Puede repetir pares (una fila por columna referenciada) — se dedupe. */
export const SYS_VIEW_LINEAGE_SQL =
  `SELECT OBJECT_SCHEMA_NAME(d.referencing_id) AS vsch, OBJECT_NAME(d.referencing_id) AS vname, ` +
  `OBJECT_SCHEMA_NAME(d.referenced_id) AS bsch, OBJECT_NAME(d.referenced_id) AS bname ` +
  `FROM sys.sql_expression_dependencies d ` +
  `JOIN sys.views v ON v.object_id = d.referencing_id ` +
  `JOIN sys.sql_modules m ON m.object_id = v.object_id ` +
  `WHERE m.is_schema_bound = 1 AND d.referenced_id IS NOT NULL`

/** Lo que la verificación necesita saber de un PI (proyección de `Report`). */
export interface VerifiablePi {
  slug: string
  tables: string[]
  databaseRefs: string[]
}

/** Estado de gobierno observable en UNA conexión: tablas con secpol + linaje de vistas schemabound. */
export interface SourceState {
  protectedTables: Set<string>
  /** vista (`schema.vista`) → tablas/vistas base directas (`schema.objeto`). */
  viewLineage: Map<string, string[]>
}

/** Veredicto de UN PI: servible, o no-servible con motivo accionable. */
export type PiVerdict = { ok: true } | { ok: false; reason: string }

/** Una herencia aplicada (para el log del gate): la vista sirvió por el gobierno de sus bases. */
export interface InheritedGovernance {
  slug: string
  view: string
  bases: string[]
}

export interface FabricVerifyResult {
  /** Veredicto por slug — el swap al estado vivo lo hace el llamador (tras evaluar TODO). */
  state: Map<string, PiVerdict>
  /** Conexiones consultadas (solo las EN USO por algún PI). */
  usedRefs: string[]
  /** Fallos de consulta por conexión (indeterminación, no veredicto). */
  refErrors: Map<string, string>
  /** Herencias vista→base aplicadas (issue #54) — el llamador las loguea. */
  inherited: InheritedGovernance[]
  /** Linaje agregado de las conexiones que respondieron (para la visibilidad del índice). */
  viewLineage: Map<string, string[]>
}

export async function verifyFabricServability(opts: {
  pis: VerifiablePi[]
  store: Map<string, PolicyDecl>
  /** Estado de gobierno (secpol + linaje) de esa conexión. */
  sourceStateOf: (databaseRef: string) => Promise<SourceState>
  /** Estado previo (para conservar veredictos sanos ante indeterminación). */
  previous?: Map<string, PiVerdict>
}): Promise<FabricVerifyResult> {
  const { pis, store, sourceStateOf, previous } = opts

  // Solo las conexiones EN USO: la unión de los database_ref de los PI descubiertos.
  const usedRefs = [...new Set(pis.flatMap((p) => p.databaseRefs))]
  const stateByRef = new Map<string, SourceState>()
  const refErrors = new Map<string, string>()
  await Promise.all(
    usedRefs.map(async (ref) => {
      try {
        stateByRef.set(ref, await sourceStateOf(ref))
      } catch (e) {
        refErrors.set(ref, e instanceof Error ? e.message : String(e))
      }
    }),
  )
  // Linaje agregado (solo refs que respondieron): también alimenta la visibilidad del índice.
  const viewLineage = new Map<string, string[]>()
  for (const s of stateByRef.values()) for (const [v, bases] of s.viewLineage) viewLineage.set(v, [...new Set([...(viewLineage.get(v) ?? []), ...bases])])

  const state = new Map<string, PiVerdict>()
  const inherited: InheritedGovernance[] = []
  for (const pi of pis) {
    const okRefs = pi.databaseRefs.filter((r) => stateByRef.has(r))
    const errRefs = pi.databaseRefs.filter((r) => refErrors.has(r))
    const protectedTables = new Set(okRefs.flatMap((r) => [...stateByRef.get(r)!.protectedTables]))
    const lineage = new Map<string, string[]>()
    for (const r of okRefs) for (const [v, bases] of stateByRef.get(r)!.viewLineage) lineage.set(v, [...new Set([...(lineage.get(v) ?? []), ...bases])])

    // Resolver cada tabla del PI a sus HOJAS GOBERNADAS (BFS con guard de ciclos): una entrada del
    // store es hoja; una vista con linaje expande a sus bases; sin política NI linaje = no-gobernable.
    // INVARIANTE (sin cambios): toda hoja gobernada debe tener artefacto nativo. Una pública se
    // manifiesta con su SECURITY POLICY allow-all (doc 018) → "sin artefacto" = fuga.
    const needed = new Set<string>() // hojas gobernadas a verificar contra la secpol
    const unresolved: string[] = [] // sin política ni linaje derivable
    const piInherited: InheritedGovernance[] = []
    for (const t of pi.tables) {
      if (store.has(t)) {
        needed.add(t)
        continue
      }
      const seen = new Set<string>([t])
      const queue = [...(lineage.get(t) ?? [])]
      const bases: string[] = []
      let dead = queue.length === 0
      while (queue.length) {
        const b = queue.shift()!
        if (seen.has(b)) continue // ciclo defensivo: sys no debería producirlo
        seen.add(b)
        if (store.has(b)) {
          bases.push(b)
          continue
        }
        const deeper = lineage.get(b)
        if (!deeper?.length) {
          dead = true // una base sin política ni linaje corta la herencia (certeza o nada)
          break
        }
        queue.push(...deeper)
      }
      // Una herencia válida resuelve a AL MENOS una hoja gobernada: un ciclo de vistas sin base real
      // dejaría `bases` vacío y pasaría en silencio — certeza o nada.
      if (dead || bases.length === 0) {
        unresolved.push(t)
        continue
      }
      for (const b of bases) needed.add(b)
      piInherited.push({ slug: pi.slug, view: t, bases })
    }

    if (needed.size > 0 && pi.databaseRefs.length === 0) {
      state.set(pi.slug, { ok: false, reason: `sus data-entries no declaran database_ref: no se puede verificar la RLS nativa de ${[...needed].join(', ')}.` })
      continue
    }
    const missing = [...needed].filter((t) => !protectedTables.has(t))
    if (unresolved.length === 0 && missing.length === 0) {
      state.set(pi.slug, { ok: true }) // veredicto definitivo: todo gobierno presente
      inherited.push(...piInherited)
      continue
    }
    if (errRefs.length > 0) {
      // INDETERMINADO: lo que falta (secpol o linaje) podría vivir en la conexión que no respondió.
      // Conservar el veredicto sano previo; en frío o ya degradado → fail-closed con el motivo.
      const prev = previous?.get(pi.slug)
      if (prev?.ok) {
        state.set(pi.slug, prev)
        continue
      }
      state.set(pi.slug, {
        ok: false,
        reason: `no se pudo verificar la RLS nativa: conexión ${errRefs.map((r) => `'${r}'`).join(', ')} no respondió (${errRefs.map((r) => refErrors.get(r)).join(' · ')}).`,
      })
      continue
    }
    // DEFINITIVO: las conexiones respondieron y el gobierno NO está. Fail-closed aunque antes sirviera.
    const reasons: string[] = []
    if (unresolved.length) {
      reasons.push(
        `tabla(s) sin política en el store y sin linaje de vista derivable: ${unresolved.join(', ')}. ` +
          `Declara la entidad en el policy store, o sírvela como vista WITH SCHEMABINDING sobre una base gobernada (herencia).`,
      )
    }
    if (missing.length) {
      reasons.push(
        `tabla(s) sin artefacto SECURITY POLICY en la fuente (gobernada → predicado-filtro; pública → allow-all): ` +
          `${missing.join(', ')}. Aplica la SECURITY POLICY (deploy/fabric-pushdown/, regenerada desde la política) antes de servir.`,
      )
    }
    state.set(pi.slug, { ok: false, reason: reasons.join(' Además: ') })
  }
  return { state, usedRefs, refErrors, inherited, viewLineage }
}
