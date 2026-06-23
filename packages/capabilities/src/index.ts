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
export { openAnnotationStore, SqliteAnnotationStore } from './annotation-store'
export type { AnnotationStore, AnnotationRecord } from './annotation-store'
export { openSqliteDb, persistSqliteDb, selectAll } from './sqlite'
export type { SqlDb, SqlStmt } from './sqlite'
export {
  parseMasterDataConfig,
  pkColumn,
  coerceValue,
  coerceRow,
} from './master-data'
export type { MasterDataEntity, MasterDataColumn, MasterDataColumnType, CoerceResult, PublicationTargetDecl } from './master-data'
export {
  SqliteMasterDataStore,
  createDwhMasterDataStore,
  MasterDataConflict,
} from './master-data-store'
export type { MasterDataStore, MasterDataRow } from './master-data-store'
export { createDwhPublisher, replicaTable } from './master-data-publish'
export type { Publisher, PublisherTarget } from './master-data-publish'
export { parseDomainsConfig, canManageDomain, manageableDomains } from './domain'
export type { DomainDecl } from './domain'
export { parseIntakeConfig, matchSlot, validateUpload, globToRegExp, slotMaxBytes } from './intake'
export type { IntakeSlot, IntakeTarget, IntakeTrigger, ValidateResult } from './intake'
export { createTokenProvider, SCOPE_ONELAKE, SCOPE_FABRIC } from './aad-token'
export type { TokenProvider, SpCreds } from './aad-token'
export { createOneLakeIntake, createFabricJobs } from './intake-onelake'
export type { OneLakeIntake, FabricJobs } from './intake-onelake'
export { SqliteAdminStore, AdminLockout } from './admin-roles'
export type { AdminStore, AdminEntry } from './admin-roles'
export { SqliteGovernanceStore, GovernanceConflict } from './governance-store'
export type {
  GovernanceStore,
  GroupStore,
  PiGovStore,
  PlatformSettingStore,
  MiraGroup,
  GroupMember,
  GroupSeed,
  GovernanceSeed,
  PiGovernance,
  PiDemanda,
} from './governance-store'
export { effectiveRole, canOpen, canCollaborate, canGovern, rankOf, higher } from './pi-authz'
export type { PiRole, PiVisibility, PrincipalType, PiGrant, EffectiveRoleArgs } from './pi-authz'
export type { SourceRow, ProcessRow, SourceRegistryStore } from './governance-store'
export {
  durationToSeconds,
  secondsToDuration,
  demandaCeilingSeconds,
  isDemandaWithinCeiling,
  requiredCadenceSeconds,
  deriveIngestionMap,
} from './freshness'
export type { SourceInfo, ProcessInfo, IngestionMapRow, DeriveMapInput } from './freshness'
export { classifyProcess, alertReason, reconcilePlan } from './ingestion-observability'
export type { RunStatus, RunRecord, ProcessHealth, ReconcilePlan, IngestionEngineClient } from './ingestion-observability'
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
