/**
 * Un PROTO-BOTLET es la familia de Lets que el nodo sabe hospedar: sabe reconocer su spec, parsearla,
 * decir qué capabilities y qué tablas consume, e invocarla. El Botler (el nodo) NO entiende el dominio:
 * solo conoce esta interfaz. Mira es el primero; Daftar será el segundo (doc 013 del cluster homónimo).
 */
export interface ProtoBotlet<Spec = unknown, Output = unknown> {
  /** Nombre de la familia: `mira`, `daftar`. Es lo que `Report.proto` lleva y lo que el log nombra. */
  readonly type: string
  /**
   * Clave raíz que identifica una spec de esta familia (`mira_version`, `daftar_version`). El registro
   * discrimina por PRESENCIA de la clave en el YAML ya parseado, sin validar su valor.
   */
  readonly discriminator: string
  /** Parsea el texto de una spec. Lanza si no es de esta familia o está rota. */
  parse(text: string): Spec
  /** Capabilities que la spec consume (el catálogo de serving decide si es servible). */
  capabilitiesOf(spec: Spec): string[]
  /** Fuentes de dato de la spec, para el análisis de tablas y el gate de gobernanza. */
  dataOf(spec: Spec): { sql?: string; databaseRef?: string }[]
  /** Identidad de la spec: código estable (del que sale el slug) y nombre visible. */
  identityOf(spec: Spec): { code: string; displayName?: string }
}
