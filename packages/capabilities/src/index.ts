import type { Capability } from '@vergis/botler'
import { publicarArtefacto } from './publicar-artefacto'
import { renderHtmlPiece } from './render-html-piece'
import { staticData } from './static-data'

export { staticData } from './static-data'
export { renderHtmlPiece } from './render-html-piece'
export type { ResolvedNode, TableColumn } from './render-html-piece'
export {
  TABLE_RUNTIME_SOURCE,
  vtNorm,
  vtIsNumericCol,
  vtDistinct,
  vtIsCategorical,
  vtFormat,
  vtApply,
  vtGroup,
  vtGroupTree,
} from './table-runtime'
export type { VtState, VtTreeNode } from './table-runtime'
export { publicarArtefacto } from './publicar-artefacto'
export { renderMarkdown, escapeHtml } from './markdown'
export { createExecuteSqlDwh } from './execute-sql-dwh'
export type { SqlConnectionProfile } from './execute-sql-dwh'
export { createExecuteSqlClickHouse, fetchChTransport } from './execute-sql-ch'
export type { ClickHouseProfile, ChQueryRequest, ChQueryResult, ChTransport } from './execute-sql-ch'
export { bootstrapClickHouse, createIngestClickHouse } from './clickhouse-store'
export type { ChAdminConn, ChColumnType, ChStoreSchema, BootstrapOptions } from './clickhouse-store'
export { getTheme, registerTheme, defaultTheme, arbolTheme } from './themes'
export type { Theme, ThemeTokens, DashboardMeta } from './themes'

/**
 * Conjunto starter genérico (sin acceso a recursos externos): los 3 stubs/render.
 * `execute-sql-dwh` no entra aquí porque requiere perfiles de conexión — se crea
 * con `createExecuteSqlDwh(profiles)` y se registra aparte.
 */
export const starterCapabilities: Capability[] = [staticData, renderHtmlPiece, publicarArtefacto]
