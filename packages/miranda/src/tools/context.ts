/**
 * Contexto que el server inyecta al cinturón de herramientas de Miranda. Cada método es un seam
 * testeable (los tests lo mockean; el server lo cablea con la conexión de plataforma + el store +
 * el validador del DSL). Los tools NO tocan el mundo directamente: pasan por acá.
 */
import type { IntentSummary } from '../intent'
import type { SelfCheckResult } from '../qc'
import type { AccionDeCierre, NivelAcceso } from '../catalog'

// `CatalogEntry` y el modelo de niveles viven en `../catalog` (fuente única). Se re-exporta acá por
// compat de imports (`@vergis/miranda` y el server lo tomaban de `context`).
export type { CatalogEntry, NivelAcceso, AccionDeCierre } from '../catalog'
import type { CatalogEntry } from '../catalog'

/** Una spec existente, como ejemplar read-only. */
export interface SpecRef {
  code: string
  name: string
}

export interface MirandaToolContext {
  /** Censo de fuentes multi-nivel. Solo las `gestionado` son probeables (ver `probeableNames`/`nivelForName`). */
  catalog: CatalogEntry[]
  /** Ejecuta una probe (ya guardada + `TOP` forzado). `why` se registra para auditoría. */
  runProbe(sql: string, why: string): Promise<{ rows: Record<string, unknown>[] } | { error: string }>
  /** Columnas + tipos de un objeto del catálogo (metadata acotada al objeto allowlisteado). */
  columnsOf(table: string): Promise<{ name: string; type: string }[]>
  /** N filas de muestra de un objeto del catálogo (`SELECT TOP n *`). */
  sampleRows(table: string, n: number): Promise<Record<string, unknown>[]>
  /** Top-N valores distintos de una columna con su conteo. */
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
  /** Registra un requerimiento de datos (handoff a César+Claude): artifact `data_request`. El `nivel`
   *  (naturaleza de la brecha) y la `accionDeCierre` (conectar/curar/intake/levantar/descubrir) hacen el
   *  handoff accionable; el request es interno (el usuario no lo ve nombrado). */
  createDataRequest(
    descripcion: string,
    tablasFaltantes: string[],
    opts?: { nivel?: NivelAcceso; accionDeCierre?: AccionDeCierre },
  ): Promise<{ ok: true }>
  /** Registra el último draft como preview efímera y devuelve su URL. */
  renderPreview(): Promise<{ url: string }>
  /** Corre el self-check QC① (llamada separada al modelo) sobre el estado vigente. */
  runSelfCheck(): Promise<SelfCheckResult>
}
