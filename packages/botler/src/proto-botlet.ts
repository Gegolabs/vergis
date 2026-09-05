/**
 * Un PROTO-BOTLET es la familia de Lets que el nodo sabe hospedar: sabe reconocer su spec, parsearla,
 * decir qué capabilities y qué tablas consume, e invocarla. El Botler (el nodo) NO entiende el dominio:
 * solo conoce esta interfaz. Mira es el primero; Daftar es el segundo (doc 013 del cluster homónimo).
 *
 * H3 (#295 · D-72) le agrega la PUERTA DE SALIDA: `invoke`. La clase `Botler` de `./botler.ts` NO es
 * esa puerta — es el runtime de `runSpec` (CLI), su `invoke` es por Botlet-instancia con capabilities
 * y el servidor no la instancia. La frontera genérica entre el runtime y el dominio es la
 * `LetInvocation` de acá: el router no entiende ni una de sus claves de dominio.
 */
import type { IdentityContext } from './types'

/** Lo que el nodo entrega a un Let al invocarlo. Es la FRONTERA entre el runtime y el dominio. */
export interface LetInvocation {
  /** Método HTTP en mayúscula. */
  method: string
  /** Ruta RELATIVA al Let: '' para `/<slug>`, 'api/guides' para `/<slug>/api/guides`. Sin query. */
  path: string
  /** Query string parseada (valores repetidos → último). */
  query: Record<string, string>
  /**
   * La URL CRUDA del request (`req.url`), con su query sin parsear. Está porque `query` es lossy por
   * contrato —repetidos → último— y la navegación multi-vista de Mira (`?ctx.x=a&ctx.x=b`) depende
   * justamente de los repetidos: sin esto, pasar Mira por `invoke` le habría roto el multi-select.
   * Un Let que solo necesita escalares usa `query` y no mira acá.
   */
  rawUrl: string
  /** Cabeceras del request (las del gate incluidas). */
  headers: Record<string, string | string[] | undefined>
  /** Cuerpo ya leído (solo para métodos con cuerpo; límite lo fija el nodo). */
  body?: string
  /** La identidad resuelta por el nodo (email + claims). El Let NUNCA la deriva por su cuenta. */
  identity: IdentityContext
  /** ¿Este nodo tiene el plano de control? Un Let en standby NO escribe. */
  hasControl: boolean
  /** Quién controla, para el 409. */
  activeHolder: string
  /** Prefijo de URL del Let (`/<slug>`), para que el HTML que emite enlace a sí mismo. */
  base: string
}

export interface LetResponse {
  status: number
  headers?: Record<string, string>
  /** Texto (HTML/JSON) o bytes (imágenes). */
  body: string | Uint8Array
}

export interface ProtoBotlet<Spec = unknown> {
  /** Nombre de la familia: `mira`, `daftar`. Es lo que `Report.proto` lleva y lo que el log nombra. */
  readonly type: string
  /**
   * Clave raíz que identifica una spec de esta familia (`mira_version`, `daftar_version`). El registro
   * discrimina por PRESENCIA de la clave en el YAML ya parseado, sin validar su valor.
   */
  readonly discriminator: string
  /**
   * ¿Esta familia consume datos gobernados del motor (SQL, tablas, RLS)? `true` = Mira: se exige que
   * sus capabilities estén en el catálogo de serving y se aplica el gate de gobernanza por tabla.
   * `false` = el Let no toca el DWH: no hay tablas, no hay gate de gobernanza, es visible para toda
   * identidad y su autorización la decide él mismo en `invoke` (D-73).
   */
  readonly consumesData: boolean
  /** Parsea el texto de una spec. Lanza si no es de esta familia o está rota. */
  parse(text: string): Spec
  /** Capabilities que la spec consume (el catálogo de serving decide si es servible). */
  capabilitiesOf(spec: Spec): string[]
  /** Fuentes de dato de la spec, para el análisis de tablas y el gate de gobernanza. */
  dataOf(spec: Spec): { sql?: string; databaseRef?: string }[]
  /** Identidad de la spec: código estable (del que sale el slug) y nombre visible. */
  identityOf(spec: Spec): { code: string; displayName?: string }
  /**
   * Atiende un request dirigido a un Let de esta familia. Devuelve `null` si la ruta no es suya
   * (el nodo responde 404). Toda escritura que reciba con `hasControl === false` la rechaza con 409
   * nombrando `activeHolder` — el nodo NO lo hace por él, porque solo el Let sabe qué rutas escriben.
   */
  invoke(spec: Spec, specPath: string, inv: LetInvocation): Promise<LetResponse | null>
}
