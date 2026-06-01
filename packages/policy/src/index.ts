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
import type { PolicyDecl } from './ir'

export * from './ir'
export { parseAudience, type AudienceDecl } from './frontend'
export { bindPolicy, type BindContext } from './binder'
export {
  compileClickHouse,
  requestSettings,
  emulate,
  settingForClaim,
  SETTINGS_PREFIX,
  type ClickHouseEnforcement,
  type ClickHouseTarget,
} from './clickhouse'
export { trivialClickHouseProvider, type AuthorizationProvider } from './provider'

/**
 * Compila la declaración `audience` de un spec a enforcement de ClickHouse.
 * Orquesta el pipeline del doc 10 §2: front-end → binder → back-end.
 * Devuelve `null` si el PI es público (sin RLS de fila).
 *
 * Corre en **specialize-time** (una vez, al nacer el Botlet) — no por request (doc 10 §4).
 */
export function compilePolicyToClickHouse(
  audience: AudienceDecl | undefined,
  target: ClickHouseTarget,
  bindCtx: BindContext,
): ClickHouseEnforcement | null {
  const policy: PolicyDecl = parseAudience(audience) // front-end
  bindPolicy(policy, bindCtx) // binder (valida columna/claim; lanza si no resuelve)
  return compileClickHouse(policy, target) // back-end
}
