/**
 * Resolución de IDENTIDAD del servidor RLS — módulo del refactor createApp() (A14).
 *
 * Cabeceras del gate (oauth2-proxy) → identidad + claims, enriquecidos desde un DIRECTORIO cuando el
 * claim del criterio no viaja en la cabecera sino que se deriva de la identidad autenticada (p.ej. el
 * ÁREA del viewer a partir de su email). Fail-closed: email no mapeado → sin claim del directorio →
 * default-deny.
 *
 * El directorio tiene DOS formas, y las dos se resuelven acá (issue #159, hito 2):
 *
 * · `IdentityMap` — el objeto plano del archivo `VERGIS_IDENTITY_MAP`. Es la forma histórica y se
 *   conserva intacta (tests y despliegues que aún no tienen store de gobierno).
 * · `IdentityProjection` — la PROYECCIÓN EN MEMORIA del mapa que vive en el store de gobierno. El
 *   store es asíncrono y `identityFor` es SÍNCRONO (así lo consume `routes.ts`, dentro del request
 *   listener de node): un `await` por request no es una opción — ni de rendimiento ni de forma. La
 *   proyección resuelve eso: se refresca fuera del camino del request (boot, watch, SIGHUP, y la
 *   escritura de la superficie de Administración) y el resolver solo hace un lookup en un Map.
 *
 * Puro e inyectable (se le pasa el directorio ya construido) → testeable sin server.
 */
import { identityFromHeaders, DEFAULT_GATE_MAPPING, type ClaimSet, type GateHeaders, type IdentityContext } from '@vergis/botler'
import type { DevIdentity } from './config'

/** `{ email → { claim: valor(es) } }` — trust-base producido por un proceso admin (reconciliación AAD↔directorio). */
export type IdentityMap = Record<string, Record<string, string | string[]>>

/** Lo MÍNIMO del store de gobierno que la proyección necesita. El resolver no conoce el store entero:
 *  así se prueba con un doble de tres líneas y no arrastra SQLite a un test de identidad. */
export interface IdentityClaimsSource {
  listIdentityClaims(): Promise<{ email: string; claims: Record<string, string[]> }[]>
}

/** Estado de la proyección — lo que el arranque y el contrato operativo necesitan reportar. */
export interface IdentityProjectionState {
  /** ¿Hay una proyección viva? `false` = nunca cargó (ni siquiera vacía). */
  cargada: boolean
  entradas: number
  /** Motivo del ÚLTIMO intento fallido, aunque haya una proyección vigente sirviendo. */
  error: string | null
  /** Cuándo entró la proyección vigente (ISO), o null si nunca entró ninguna. */
  cargadaEn: string | null
}

/** Clave de búsqueda del directorio: la MISMA normalización que aplica el store (`normEmail`). */
const normKey = (email: string): string => email.trim().toLowerCase()

/**
 * Claves de un mapa de archivo que NO están normalizadas (mayúsculas o espacios).
 *
 * LA TRAMPA, y por qué esto existe: el resolver por archivo indexa las claves TAL CUAL vienen y busca
 * con `user.toLowerCase()` — así que una clave escrita `Ana@GH.CL` en el archivo NUNCA aplicó su
 * claim: está en el mapa y está muerta. El store normaliza al escribir, de modo que migrar el archivo
 * al store REVIVE esas entradas. Es una mejora, pero es un CAMBIO DE ALCANCE DE AUTORIZACIÓN
 * observable en producción: alguien puede empezar a ver filas que ayer no veía. Se cuenta acá para
 * poder anunciarlo al arrancar en vez de que aparezca solo.
 */
export function clavesNoNormalizadas(map: IdentityMap): string[] {
  return Object.keys(map).filter((k) => k !== normKey(k) && normKey(k) !== '')
}

/**
 * Proyección EN MEMORIA del mapa identidad→claims del store de gobierno.
 *
 * **Validate-before-swap**: `swapFromEntries` construye el Map COMPLETO y recién entonces reemplaza
 * la referencia viva. Una recarga que falla a mitad no puede dejar el trust-base a medias — un mapa
 * incompleto no falla ruidoso: autoriza mal y en silencio, que es exactamente el modo de falla que no
 * se acepta en la pieza sobre la que se aplica toda política.
 *
 * **Por qué `claimsFor` NO lanza cuando la proyección nunca cargó**: `routes.ts` invoca `identityFor`
 * dentro del request listener de node, sin try/catch alrededor — un throw ahí es una excepción no
 * capturada, no un 503. La respuesta fail-closed correcta a «el store no se pudo leer» no es matar el
 * proceso: es NO SERVIR (el arranque baja `ready`, y el gate global responde 503 con la
 * Administración y `/contrato` todavía en pie para diagnosticar). Quien construye la proyección
 * consulta `state.cargada` y decide; la proyección misma nunca inventa claims ni miente sobre su
 * estado. Ver el bloque de identidad en `server/serve-rls.ts`.
 */
export class IdentityProjection {
  private live: Map<string, Record<string, string[]>> | null = null
  private lastError: string | null = null
  private loadedAt: string | null = null

  get state(): IdentityProjectionState {
    return { cargada: this.live !== null, entradas: this.live?.size ?? 0, error: this.lastError, cargadaEn: this.loadedAt }
  }

  /** Cuántas entradas tiene la proyección vigente (0 si nunca cargó). */
  get size(): number {
    return this.live?.size ?? 0
  }

  /** Claims de un email, o `undefined` si NO hay entrada — que es lo que deja a la política decidir. */
  claimsFor(email: string): Record<string, string[]> | undefined {
    return this.live?.get(normKey(email))
  }

  /** Reemplaza la proyección viva. Construye TODO antes de asignar (validate-before-swap). */
  swapFromEntries(entries: { email: string; claims: Record<string, string[]> }[]): number {
    const next = new Map<string, Record<string, string[]>>()
    for (const e of entries) {
      const key = normKey(e.email)
      if (!key) continue // una fila sin email sería una entrada muda: no se proyecta
      next.set(key, e.claims)
    }
    this.live = next
    this.lastError = null
    this.loadedAt = new Date().toISOString()
    return next.size
  }

  /** Siembra desde el mapa plano del archivo. NORMALIZA las claves — ver `clavesNoNormalizadas`. */
  seedFromMap(map: IdentityMap): number {
    return this.swapFromEntries(
      Object.entries(map)
        .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
        .map(([email, claims]) => ({
          email,
          // El claim es un CONJUNTO, posiblemente unitario (#165): siempre lista, aunque traiga un valor.
          claims: Object.fromEntries(Object.entries(claims).map(([c, v]) => [c, Array.isArray(v) ? v.map(String) : [String(v)]])),
        })),
    )
  }

  /**
   * Re-lee el store y hace el swap. NUNCA lanza: una recarga fallida CONSERVA la proyección vigente
   * (el mismo criterio que el resto del hot-reload — lo que ya sirve no se degrada por un archivo o
   * una consulta rota) y deja el motivo en `state.error` para que el llamador lo grite.
   */
  async refresh(source: IdentityClaimsSource): Promise<{ ok: boolean; entradas: number; error?: string }> {
    try {
      const entries = await source.listIdentityClaims()
      const n = this.swapFromEntries(entries)
      return { ok: true, entradas: n }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.lastError = msg
      return { ok: false, entradas: this.size, error: msg }
    }
  }

  /** Registra un fallo de carga sin tocar la proyección vigente (p.ej. el store ni siquiera abrió). */
  markFailed(error: string): void {
    this.lastError = error
  }
}

export interface IdentityResolver {
  identityFor(headers: GateHeaders): IdentityContext
}

/** El directorio contra el que se enriquece: el objeto plano del archivo, la proyección del store, o nada. */
export type IdentityDirectory = IdentityMap | IdentityProjection

export function createIdentity(
  gateClaims: Record<string, string>,
  directory: IdentityDirectory | null,
  devIdentity: DevIdentity | null = null,
): IdentityResolver {
  // Las cabeceras del gate vienen latin1 → re-decodificar para acentos ("Producción").
  const mapping = { ...DEFAULT_GATE_MAPPING, claims: gateClaims, decodeUtf8: true }

  function identityFor(headers: GateHeaders): IdentityContext {
    const identity = identityFromHeaders(headers, mapping)
    // DEV IDENTITY (fail-safe — `decideDevIdentity` en ./config garantiza que `devIdentity` es null
    // ante gate real): si NO llegó ningún header de gate (browser local sin oauth2-proxy → sin user
    // ni claims) y hay identidad de dev, se inyecta. Con CUALQUIER header de gate presente, el header
    // MANDA — permite probar 403/otras identidades por curl exactamente como hoy.
    if (devIdentity && !identity.user && !identity.claims) {
      const claims = Object.keys(devIdentity.claims).length ? { ...devIdentity.claims } : undefined
      const injected: IdentityContext = { agent: identity.agent, user: devIdentity.user }
      if (claims) injected.claims = claims
      return enrichFromDirectory(injected, directory)
    }
    return enrichFromDirectory(identity, directory)
  }

  return { identityFor }
}

/** Lookup en el directorio, en la forma que sea. `undefined` = no hay entrada (≠ entrada sin claims). */
function lookup(directory: IdentityDirectory, email: string): Record<string, string[]> | undefined {
  if (directory instanceof IdentityProjection) return directory.claimsFor(email)
  // Camino histórico del archivo: se indexa TAL CUAL y se busca en minúscula — una clave con
  // mayúsculas no aplica nunca. Se conserva a propósito (es el comportamiento vivo de los despliegues
  // que aún leen el archivo); la migración al store es la que lo corrige, y lo anuncia.
  const extra = directory[email.toLowerCase()]
  if (!extra) return undefined
  return Object.fromEntries(Object.entries(extra).map(([c, v]) => [c, Array.isArray(v) ? v.map(String) : [String(v)]]))
}

/** Enriquece la identidad con los claims del directorio por email. Fail-closed. */
function enrichFromDirectory(identity: IdentityContext, directory: IdentityDirectory | null): IdentityContext {
  if (!directory || !identity.user) return identity
  const extra = lookup(directory, identity.user)
  if (!extra) return identity // no mapeado → sin claim del directorio → default-deny
  // Entrada PRESENTE pero sin claims: es un estado real («se reconcilió y no resolvió», #165 §4) y no
  // aporta nada al ClaimSet. No se fabrica un `claims: {}` donde había `undefined`: aguas abajo la
  // ausencia de claims es la señal de fail-closed y un objeto vacío la disfrazaría de «tiene claims».
  if (!Object.keys(extra).length) return identity
  const claims: ClaimSet = { ...(identity.claims ?? {}) }
  for (const [c, v] of Object.entries(extra)) claims[c] = v
  return { ...identity, claims }
}
