/**
 * Motor C (Fabric push-down) — LÓGICA PURA de la verificación de servibilidad POR PI (issue #52).
 *
 * La unidad de fail-closed es EL PI, no el proceso: cada PI verifica que TODAS sus tablas gobernadas
 * tengan artefacto `SECURITY POLICY` nativo en la fuente; el que no verifica no se sirve (con motivo
 * accionable) y los demás siguen. Solo se consultan las conexiones EN USO por algún PI descubierto —
 * una conexión declarada que nadie usa no puede tumbar nada.
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

/** Lo que la verificación necesita saber de un PI (proyección de `Report`). */
export interface VerifiablePi {
  slug: string
  tables: string[]
  databaseRefs: string[]
}

/** Veredicto de UN PI: servible, o no-servible con motivo accionable. */
export type PiVerdict = { ok: true } | { ok: false; reason: string }

export interface FabricVerifyResult {
  /** Veredicto por slug — el swap al estado vivo lo hace el llamador (tras evaluar TODO). */
  state: Map<string, PiVerdict>
  /** Conexiones consultadas (solo las EN USO por algún PI). */
  usedRefs: string[]
  /** Fallos de consulta por conexión (indeterminación, no veredicto). */
  refErrors: Map<string, string>
}

export async function verifyFabricServability(opts: {
  pis: VerifiablePi[]
  store: Map<string, PolicyDecl>
  /** Tablas `schema.tabla` con SECURITY POLICY habilitada en esa conexión. */
  protectedTablesOf: (databaseRef: string) => Promise<Set<string>>
  /** Estado previo (para conservar veredictos sanos ante indeterminación). */
  previous?: Map<string, PiVerdict>
}): Promise<FabricVerifyResult> {
  const { pis, store, protectedTablesOf, previous } = opts

  // Solo las conexiones EN USO: la unión de los database_ref de los PI descubiertos.
  const usedRefs = [...new Set(pis.flatMap((p) => p.databaseRefs))]
  const protectedByRef = new Map<string, Set<string>>()
  const refErrors = new Map<string, string>()
  await Promise.all(
    usedRefs.map(async (ref) => {
      try {
        protectedByRef.set(ref, await protectedTablesOf(ref))
      } catch (e) {
        refErrors.set(ref, e instanceof Error ? e.message : String(e))
      }
    }),
  )

  const state = new Map<string, PiVerdict>()
  for (const pi of pis) {
    // INVARIANTE (sin cambios): toda tabla SERVIDA con entrada en el store debe tener artefacto nativo.
    // Una pública se manifiesta con su SECURITY POLICY allow-all (doc 018) → "sin artefacto" = fuga.
    const needed = pi.tables.filter((t) => store.has(t))
    if (needed.length === 0) {
      state.set(pi.slug, { ok: true })
      continue
    }
    if (pi.databaseRefs.length === 0) {
      state.set(pi.slug, { ok: false, reason: `sus data-entries no declaran database_ref: no se puede verificar la RLS nativa de ${needed.join(', ')}.` })
      continue
    }
    const okRefs = pi.databaseRefs.filter((r) => protectedByRef.has(r))
    const errRefs = pi.databaseRefs.filter((r) => refErrors.has(r))
    const protectedTables = new Set(okRefs.flatMap((r) => [...protectedByRef.get(r)!]))
    const missing = needed.filter((t) => !protectedTables.has(t))
    if (missing.length === 0) {
      state.set(pi.slug, { ok: true }) // veredicto definitivo: todo artefacto presente
      continue
    }
    if (errRefs.length > 0) {
      // INDETERMINADO: lo que falta podría vivir en la conexión que no respondió. Conservar el
      // veredicto sano previo (no degradar lo que servía por un fallo transitorio); en frío o ya
      // degradado → fail-closed con el motivo de conexión.
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
    // DEFINITIVO: las conexiones respondieron y el artefacto NO está. Fail-closed aunque antes sirviera.
    state.set(pi.slug, {
      ok: false,
      reason:
        `tabla(s) sin artefacto SECURITY POLICY en la fuente (gobernada → predicado-filtro; pública → allow-all): ` +
        `${missing.join(', ')}. Aplica la SECURITY POLICY (deploy/fabric-pushdown/, regenerada desde la política) antes de servir.`,
    })
  }
  return { state, usedRefs, refErrors }
}
