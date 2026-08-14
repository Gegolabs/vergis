// @vergis/policy — el compilador de policy (doc 10): del spec declarativo (audience.rls)
// al enforcement del motor. Vive en la capa Producto; consume la policy declarada en la
// Instancia (el spec) y emite el enforcement para el motor que la Infraestructura eligió.
//
// Hoy: front-end (audience → Policy IR) + binder + back-end ClickHouse (motor B, doc 9 §4).
// El push-down (C) y otros back-ends se añaden sin tocar front-end ni IR (invariante de
// portabilidad, doc 9 §7).

import type { AudienceDecl } from './frontend'
import { parseAudience } from './frontend'
import { bindPolicy, type BindContext } from './binder'
import { compileClickHouse, type ClickHouseEnforcement, type ClickHouseTarget } from './clickhouse'
import { compileFabric, type FabricEnforcement, type FabricTarget } from './fabric'
import type { PolicyDecl } from './ir'

export * from './ir'
export { parseAudience, type AudienceDecl } from './frontend'
export { bindPolicy, type BindContext } from './binder'
export { settingForClaim, SETTINGS_PREFIX, ident, SAFE_IDENT } from './codegen-common'
export {
  compileClickHouse,
  requestSettings,
  settingsForInjections,
  emulate,
  type ClickHouseEnforcement,
  type ClickHouseTarget,
} from './clickhouse'
export {
  compileFabric,
  sessionContextPrelude,
  emulateFabric,
  type FabricEnforcement,
  type FabricTarget,
  type SessionContextPrelude,
} from './fabric'
export {
  diagnoseClaims,
  deniesAllRows,
  explainDenial,
  type ClaimDenial,
  type ClaimDenialKind,
} from './diagnose'
export { trivialClickHouseProvider, type AuthorizationProvider } from './provider'
export { parsePolicyStore, type DataPolicyDecl, type PolicyStoreDoc } from './store'
export {
  resolveEntityStore,
  isEntityStore,
  type EntityStoreDoc,
  type EntityDecl,
  type DatasetMappingDecl,
  type DimensionGovernance,
} from './entities'

/**
 * Compila la declaración `audience` de un spec a enforcement de ClickHouse.
 * Orquesta el pipeline del doc 10 §2: front-end → binder → back-end.
 * Público (`grant: all`) → ROW POLICY ALLOW-ALL (`USING 1`), no null.
 *
 * Corre en **specialize-time** (una vez, al nacer el Botlet) — no por request (doc 10 §4).
 */
export function compilePolicyToClickHouse(
  audience: AudienceDecl | undefined,
  target: ClickHouseTarget,
  bindCtx: BindContext,
): ClickHouseEnforcement {
  const policy: PolicyDecl = parseAudience(audience) // front-end
  bindPolicy(policy, bindCtx) // binder (valida columna/claim; lanza si no resuelve)
  return compileClickHouse(policy, target) // back-end
}

/**
 * Compila la declaración `audience` de un spec a enforcement de Fabric / Azure SQL (push-down, motor C).
 * Mismo pipeline (front-end → binder → back-end) que ClickHouse; cambia solo el back-end — la portabilidad
 * del compilador (doc 9 §7): misma política declarada, distinto enforcement nativo.
 *
 * Corre en **specialize-time** (una vez). Público (`grant: all`) → artefacto ALLOW-ALL (no null).
 */
export function compilePolicyToFabric(
  audience: AudienceDecl | undefined,
  target: FabricTarget,
  bindCtx: BindContext,
): FabricEnforcement {
  const policy: PolicyDecl = parseAudience(audience) // front-end (compartido)
  bindPolicy(policy, bindCtx) // binder (compartido)
  return compileFabric(policy, target) // back-end Fabric
}
