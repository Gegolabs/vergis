import type { Capability } from '@vergis/botler'
import { publicarArtefacto } from './publicar-artefacto'
import { renderCsvPiece } from './render-csv-piece'
import { renderHtmlPiece } from './render-html-piece'
import { staticData } from './static-data'

export { staticData } from './static-data'
export { renderHtmlPiece } from './render-html-piece'
export {
  CHART_MAX_BARS,
  chartCacheStats,
  groupedTopN,
  labelledDomain,
  themeChartSvg,
  labelMode,
  labelWidthPx,
  barStepPx,
  lanesPadFraction,
  assignLanes,
  markTopPx,
  seriesLabelStride,
} from './render-chart'
export type { TopNRank, LabelMode } from './render-chart'
export { TABLE_SSR_MAX_ROWS } from './render-table'
export { renderCsvPiece } from './render-csv-piece'
export type { ResolvedNode, TableColumn, ChartSort, FilterResolved } from './piece-types'
export { renderNotasTraySection, llaveCanonicaDeFila, NOTAS_CSS, NOTAS_RUNTIME_SOURCE } from './notas-render'
export type { NotasRenderContext, TablaAncla } from './notas-render'
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
  vtCsvCell,
  vtCsv,
  vtCsvName,
} from './table-runtime'
export type { VtState, VtTreeNode } from './table-runtime'
export {
  openNotasStore,
  SqliteNotasStore,
  NotasConflict,
  SESSION_WINDOW_MS,
  canonicalJson,
  canonicalKey,
  normalizeEntityRef,
  substrateHash,
  llaveDeFila,
} from './notas-store'
export type {
  NotasStore,
  Impresion,
  Nota,
  Comparticion,
  Entrega,
  NotaEspecie,
  NotaContenidoTipo,
  NotaObjetivoTipo,
  EntregaCanal,
  AbrirImpresionInput,
  CrearNotaInput,
  ComentarioResumen,
} from './notas-store'
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
export { createDwhPublisher, replicaTable, replicaStagingTable, masterDataPublishPlan } from './master-data-publish'
export type { Publisher, PublisherTarget } from './master-data-publish'
export { parseDomainsConfig, canManageDomain, manageableDomains } from './domain'
export type { DomainDecl } from './domain'
export { parseIntakeConfig, matchSlot, validateUpload, validateMeta, validateRut, buildSidecar, sidecarName, isSidecarName, globToRegExp, slotMaxBytes, slotLogPath, DEFAULT_INGEST_LOG, deriveMetaFromFilename, tokenFromFilename, filenamePatternToRegExp, metaEsDerivada, slotRunLogsDir } from './intake'
export { RUN_LOG_DIR_DEFAULT, RUN_LOG_RETENTION, runLogFileName, parseRunLogTimestamp, resolveRunLog, redactSecrets } from './run-logs'
export type { RunLogResolution } from './run-logs'
export type { IntakeSlot, IntakeMetaField, IntakeMetaType, IntakeFromFilename, IntakeTarget, IntakeTrigger, ValidateResult, ValidateMetaResult, DeriveResult } from './intake'
export { credentialProviderFor, resolveAuthMode, SCOPE_ONELAKE, SCOPE_FABRIC } from './aad-token'
export type { CredentialProvider, TokenSource, AccessToken, AuthMode, CredentialSource, SqlAuth, CredentialProviderOpts } from './aad-token'
export { createOneLakeIntake, createOneLakeReader, createFabricJobs, createFabricJobStatus } from './intake-onelake'
export type { OneLakeIntake, OneLakeReader, OneLakeEntry, FabricJobs, FabricJobStatus } from './intake-onelake'
export { createFabricScheduler, createFabricEngineClient } from './fabric-engine'
export type { FabricScheduler, EngineResolver } from './fabric-engine'
export { SqliteAdminStore, AdminLockout } from './admin-roles'
export type { AdminStore, AdminEntry } from './admin-roles'
export { SqliteGovernanceStore, GovernanceConflict, INGESTION_RUN_RETENTION } from './governance-store'
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
export type { SourceRow, ProcessRow, EngineRef, ProcessLogsRef, SourceRegistryStore } from './governance-store'
export type { MirandaStore, MirandaSession, MirandaMessage, MirandaArtifact } from './governance-store'
export type { IntakeUploadStore, IntakeUploadRow } from './governance-store'
export type { IngestionRunStore, IngestionRunSnapshot, ProcessObservation } from './governance-store'
export { parseGroupsConfig, parsePiOwnersConfig, parseSourcesConfig } from './governance-config'
export type { SourcesConfig } from './governance-config'
export { requireRootKey } from './config-root'
export { canTransition, isMirandaState, MIRANDA_STATES } from './miranda-session'
export type { MirandaSessionState, MirandaMessageRole, MirandaArtifactKind } from './miranda-session'
export {
  durationToSeconds,
  secondsToDuration,
  demandaCeilingSeconds,
  isDemandaWithinCeiling,
  requiredCadenceSeconds,
  deriveIngestionMap,
  deriveEntityFreshness,
  OFERTA_EVENTO,
  isEventDriven,
  validateOferta,
} from './freshness'
export type { SourceInfo, ProcessInfo, IngestionMapRow, EntityFreshnessRow, DeriveMapInput } from './freshness'
export { classifyProcess, alertReason, reconcilePlan, freshnessAlerts, diffAlertState, parseAlertState, FRESHNESS_ALERT_STATE_KEY } from './ingestion-observability'
export type { RunStatus, RunRecord, ProcessHealth, ReconcilePlan, ProcessAlert, IngestionEngineClient } from './ingestion-observability'
export { publicarArtefacto } from './publicar-artefacto'
export { renderMarkdown, escapeHtml } from './markdown'
export { createExecuteSqlDwh } from './execute-sql-dwh'
export type { SqlConnectionProfile } from './execute-sql-dwh'
export { createExecuteSqlClickHouse, fetchChTransport } from './execute-sql-ch'
export type { ClickHouseProfile, ChQueryRequest, ChQueryResult, ChTransport } from './execute-sql-ch'
export { bootstrapClickHouse, createIngestClickHouse } from './clickhouse-store'
export type { ChAdminConn, ChColumnType, ChStoreSchema, BootstrapOptions } from './clickhouse-store'
export {
  getTheme,
  registerTheme,
  defaultTheme,
  arbolTheme,
  resolveChartTokens,
  chartVarMap,
  chartVarDeclarations,
} from './themes'
export type { Theme, ThemeTokens, DashboardMeta } from './themes'

/**
 * Conjunto starter genérico (sin acceso a recursos externos): stubs + renders (html y csv).
 * `execute-sql-dwh` no entra aquí porque requiere perfiles de conexión — se crea
 * con `createExecuteSqlDwh(profiles)` y se registra aparte.
 */
export const starterCapabilities: Capability[] = [staticData, renderHtmlPiece, renderCsvPiece, publicarArtefacto]
