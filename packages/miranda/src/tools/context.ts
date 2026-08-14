/**
 * Contexto que el server inyecta al cinturón de herramientas de Miranda. Cada método es un seam
 * testeable (los tests lo mockean; el server lo cablea con la conexión de plataforma + el store +
 * el validador del DSL). Los tools NO tocan el mundo directamente: pasan por acá.
 */
import type { IntentSummary } from '../intent'
import type { SelfCheckResult } from '../qc'
import type { ColumnShield } from './columns'

/** Una entrada del catálogo (allowlist de instancia). */
export interface CatalogEntry {
  name: string
  schema?: string
  description?: string
  rows_estimate?: number
}

/** Una spec existente, como ejemplar read-only. */
export interface SpecRef {
  code: string
  name: string
}

export interface MirandaToolContext {
  /** Allowlist de catálogo (lo que las probes pueden tocar). */
  catalog: CatalogEntry[]
  /** ¿El objeto está en el allowlist? (por hoja del nombre). */
  isAllowed(table: string): boolean
  /** Ejecuta una probe (ya guardada + `TOP` forzado). `why` se registra para auditoría. */
  runProbe(sql: string, why: string): Promise<{ rows: Record<string, unknown>[] } | { error: string }>
  /** Columnas + tipos de un objeto del catálogo (metadata acotada al objeto allowlisteado). */
  columnsOf(table: string): Promise<{ name: string; type: string }[]>
  /**
   * El plano de columna vigente para un objeto del catálogo (#163 · H9): qué columnas tienen regla
   * declarada y por lo tanto NO se sondean. El cableado lo resuelve contra el policy store; una
   * implementación que no pueda determinarlo devuelve `UNKNOWN_SHIELD` — y entonces el objeto
   * entero queda fuera del sondeo. Nunca lanza: la duda se representa, no se propaga como excepción.
   */
  columnShield(table: string): Promise<ColumnShield>
  /**
   * N filas de muestra de un objeto del catálogo, **con proyección explícita**: `columns` son las
   * columnas sondeables ya filtradas por el escudo. No existe la variante `SELECT *` — la estrella
   * traería la columna protegida al proceso aunque después se recortara, y «no se muestrea» es
   * literal: la celda no se pide.
   */
  sampleRows(table: string, n: number, columns: string[]): Promise<Record<string, unknown>[]>
  /** Top-N valores distintos de una columna con su conteo. Solo se llama sobre columnas sondeables. */
  profileColumn(table: string, column: string, top: number): Promise<{ value: unknown; count: number }[]>
  /** Specs existentes (ejemplares). */
  listSpecs(): SpecRef[]
  /** Contenido YAML de una spec existente (read-only), o null. */
  readSpec(code: string): string | null
  /** Valida un draft con `dsl/parse` + `dsl/validate` (schema + capabilities de instancia). */
  validateDraft(yaml: string): { ok: true } | { ok: false; error: string }
  /** Guarda un draft como artifact `spec_draft` vN (tras validarlo). Devuelve la versión. */
  saveDraft(yaml: string): Promise<{ version: number }>
  /** Actualiza el resumen de intención (artifact `intent_summary` vN) e invalida `validado`. */
  updateIntent(summary: IntentSummary): Promise<{ version: number }>
  /** Registra un requerimiento de datos (handoff a César+Claude): artifact `data_request`. */
  createDataRequest(descripcion: string, tablasFaltantes: string[]): Promise<{ ok: true }>
  /**
   * Registra el último draft como preview efímera y devuelve su URL.
   * Si la instancia declaró un ROSTER de identidades inspeccionables (#110·1), devuelve además una
   * URL por etiqueta (`identities`) y la del comparador (`compare_url`) — así Miranda puede decir
   * «míralo como gerente-zona-norte vs vendedor-sur» con URLs concretas. Sin roster esos campos NO
   * existen (superficie cero): la salida es `{url}` y nada más. Los claims de cada etiqueta jamás
   * viajan acá.
   */
  renderPreview(): Promise<{ url: string; identities?: { label: string; url: string }[]; compare_url?: string }>
  /** Corre el self-check QC① (llamada separada al modelo) sobre el estado vigente. */
  runSelfCheck(): Promise<SelfCheckResult>
}
