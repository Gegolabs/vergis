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
  seriesLabelIndices,
  seriesLanes,
} from './render-chart'
export type { TopNRank, LabelMode } from './render-chart'
export { TABLE_SSR_MAX_ROWS, TABLE_PRINT_MAX_ROWS } from './render-table'
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
  vtDownloadName,
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
export { parseIntakeConfig, matchSlot, slotsQueAceptan, validateUpload, validateMeta, validateRut, buildSidecar, sidecarName, isSidecarName, globToRegExp, slotMaxBytes, slotLogPath, DEFAULT_INGEST_LOG, deriveMetaFromFilename, tokenFromFilename, filenamePatternToRegExp, metaEsDerivada, slotRunLogsDir } from './intake'
export { RUN_LOG_DIR_DEFAULT, RUN_LOG_RETENTION, runLogFileName, parseRunLogTimestamp, resolveRunLog, contarCorridasSinLog, redactSecrets, parseRunFileOutcomes } from './run-logs'
export type { RunLogResolution, FileOutcome } from './run-logs'
export { expectedInLanding, classifySlot, intakeAlerts, parseIntakeWatchState, INTAKE_WATCH_STATE_KEY, DEFAULT_MAX_AGE_MINUTES, DEFAULT_MAX_RUN_MINUTES, DEFAULT_INTAKE_WATCH_MS, SIN_MEDIDA_TICKS } from './intake-observability'
export type { SlotObservation, MedidaCalidad, SlotAlertReason, SlotWatchState, SlotAlert, SlotClassification, SlotWatchConfig, SlotProjection, SlotWatchInput, ArchivoVarado, CargaRegistrada, RetiroRegistrado } from './intake-observability'
export type { IntakeSlot, IntakeMetaField, IntakeMetaOption, IntakeCatalog, IntakeMetaType, IntakeFromFilename, IntakeTarget, IntakeTrigger, ValidateResult, ValidateMetaResult, DeriveResult } from './intake'
export { credentialProviderFor, resolveAuthMode, SCOPE_ONELAKE, SCOPE_FABRIC } from './aad-token'
export type { CredentialProvider, TokenSource, AccessToken, AuthMode, CredentialSource, SqlAuth, CredentialProviderOpts } from './aad-token'
export { createOneLakeIntake, createOneLakeReader, createFabricJobs, createFabricJobStatus } from './intake-onelake'
export type { OneLakeIntake, OneLakeReader, OneLakeListingReader, OneLakeListing, OneLakeEntry, FabricJobs, FabricJobStatus } from './intake-onelake'
export { deriveRevertPlan, executeRevertPlan, revertManifestName, buildRevertManifest } from './intake-revert'
export type { RevertPlan, RevertDeps, RevertRef, RevertResult, ClaveAccion } from './intake-revert'
export { createFabricScheduler, createFabricEngineClient } from './fabric-engine'
export type { FabricScheduler, EngineResolver } from './fabric-engine'
export { createFabricItemAuthoring, AuthoringError, AuthoringDenied, AuthoringConflict, AuthoringUnknown } from './fabric-authoring'
export type { ItemAuthoringClient, ItemDeclaration, ItemDefinition, DefinitionPart } from './fabric-authoring'
export { SqliteAdminStore, AdminLockout } from './admin-roles'
export type { AdminStore, AdminEntry } from './admin-roles'
export { SqliteGovernanceStore, GovernanceConflict, INGESTION_RUN_RETENTION, INTAKE_WATCH_RUN_RETENTION } from './governance-store'
export type {
  GovernanceStore,
  GroupStore,
  PiGovStore,
  PlatformSettingStore,
  MiraGroup,
  GroupMember,
  GroupSeed,
  GovernanceSeed,
  ReseedSeed,
  PiGovernance,
  PiDemanda,
} from './governance-store'
export { effectiveRole, canOpen, canCollaborate, canGovern, rankOf, higher } from './pi-authz'
export type { PiRole, PiVisibility, PrincipalType, PiGrant, EffectiveRoleArgs } from './pi-authz'
export type { SourceRow, ProcessRow, EngineRef, ProcessLogsRef, SourceRegistryStore } from './governance-store'
export type { MirandaStore, MirandaSession, MirandaMessage, MirandaArtifact } from './governance-store'
export type { IntakeUploadStore, IntakeUploadRow } from './governance-store'
export type { IntakeDesenlaceStore, CargaDesenlace, CargaDesenlaceInput } from './governance-store'
export type { IntakeWatchStore, SlotWatchSnapshot } from './governance-store'
export type { IntakeRevertStore, IntakeRevertRow } from './governance-store'
export type { IngestionRunStore, IngestionRunSnapshot, ProcessObservation } from './governance-store'
export type { JobPublicationStore } from './governance-store'
// #159 · el mapa identidad→claims como estado de gobierno (con procedencia) + su import desde el
// archivo desplegado. El server lo consume por el barrel: el trust-base es capacidad del Producto.
export type {
  IdentityClaimStore,
  IdentityClaimEntry,
  IdentityClaimInput,
  IdentityOrigin,
  IdentityReconcileEntry,
  IdentityReconcileResult,
} from './governance-store'
export { parseIdentityMapFile, importIdentityMap, importIdentityMapFile } from './identity-map-import'
export type { IdentityMapFile, IdentityMapImportResult } from './identity-map-import'
// #107 fase 2 · H3 — ledger de publicaciones de jobs y derivación del plan (puro sobre shas).
export {
  ensureJobPublicationTable,
  recordPublication,
  lastOkPublication,
  listPublications,
  pendingUnknownPublications,
  resolveUnknownPublication,
  derivePublishPlan,
  assertParamsSinSecretos,
  resolucionMarca,
  JOB_PUBLICATION_DDL,
  RESOLUCION_PREFIJO,
} from './job-publication'
export type { PublishAction, PublishOutcome, PublishParams, PublicationRow, PublicationInput, PublishPlanInput, PublishPlan } from './job-publication'
export { parseGroupsConfig, parsePiOwnersConfig, parseSourcesConfig } from './governance-config'
export type { SourcesConfig } from './governance-config'
export { requireRootKey } from './config-root'
export { canonicalDefinitionSha256, definitionsEquivalent, canonicalPayload } from './definition-canonical'
export type { CanonicalizablePart } from './definition-canonical'
export { parseJobTemplatesConfig, parseTemplateParts, renderTemplate } from './job-templates'
export type { JobTemplate, JobTemplateParam, JobTemplatePart, JobTemplatesConfig, RenderedPart, RenderedDefinition } from './job-templates'
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
export { classifyProcess, alertReason, reconcilePlan, freshnessAlerts, diffAlertState, parseAlertState, FRESHNESS_ALERT_STATE_KEY, deriveAsOfIngesta, createAsOfProvider, SIN_DOMINIO_LABEL } from './ingestion-observability'
export type { RunStatus, RunRecord, ProcessHealth, ReconcilePlan, ProcessAlert, IngestionEngineClient, AsOfDetail, PiAsOf } from './ingestion-observability'
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
