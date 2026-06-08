// El PUERTO de autorización — el protocolo PDP/PEP, en su forma mínima (charter 012 · «Custos»).
//
// Vergis (el PEP) depende de ESTA interfaz, no de las funciones sueltas del compilador. Hoy hay
// una sola implementación: la TRIVIAL — pertenencia (membership) compilada a ClickHouse, que
// envuelve lo ya construido en `@vergis/policy`. Mañana, el Custos completo (vocabulario de
// relaciones, composición, repositorio de políticas, etc. — charter 012) es OTRO `AuthorizationProvider`
// detrás del MISMO puerto, sin tocar a Vergis. Esa es la costura que mantiene a Custos diferido sin
// pintarnos a una esquina.
//
// Dead-simple a propósito: dos métodos, sin estado, sin servicio. La riqueza (relaciones, datos de
// referencia, ciclo de vida) NO entra acá todavía — entra cuando Custos exista.

import type { AudienceDecl } from './frontend'
import { parseAudience } from './frontend'
import { bindPolicy, type BindContext } from './binder'
import { compileClickHouse, requestSettings, type ClickHouseEnforcement, type ClickHouseTarget } from './clickhouse'
import type { ClaimSet } from './ir'

/**
 * Puerto de autorización (PDP). Dos momentos del contrato:
 *  - `compile` (specialize-time, una vez): declaración de policy → enforcement del motor.
 *  - `resolve` (request-time, por consumidor): enforcement + claims del sujeto → params a aplicar.
 *
 * El tipo del enforcement es del motor (hoy ClickHouse). Cuando haya más motores/Custos, se
 * generaliza con genéricos; por ahora se mantiene concreto y honesto (un solo motor).
 */
export interface AuthorizationProvider {
  /** Identifica la implementación (telemetría / selección). */
  readonly name: string
  /** Specialize-time: `audience` del spec → enforcement compilado. `null` = PI público (sin RLS de fila). */
  compile(audience: AudienceDecl | undefined, target: ClickHouseTarget, ctx?: BindContext): ClickHouseEnforcement | null
  /** Request-time: enforcement + claims del consumidor → settings a inyectar (lo aplica el PEP). */
  resolve(enforcement: ClickHouseEnforcement, claims: ClaimSet): Record<string, string>
}

/**
 * Implementación TRIVIAL del puerto: pertenencia (Nivel 1 del charter) compilada a ClickHouse.
 * Es todo lo que QW-04 necesita hoy. Envuelve el compilador existente; no agrega capacidades.
 */
export const trivialClickHouseProvider: AuthorizationProvider = {
  name: 'custos-trivial-clickhouse',
  compile(audience, target, ctx) {
    const policy = parseAudience(audience) // front-end
    if (ctx) bindPolicy(policy, ctx) // binder opcional (valida columna/claim si se conoce el contexto)
    return compileClickHouse(policy, target) // back-end
  },
  resolve(enforcement, claims) {
    return requestSettings(enforcement, claims)
  },
}
