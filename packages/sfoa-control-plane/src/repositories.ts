import type {
  AuditEventCategory,
  AuditEventRecord,
  AuditEventStatus,
  AuditIntegrityStatus,
  AuditKind,
  AuditPayloadEvidenceRecord,
  AuditPayloadEvidenceSummaryRecord,
  AuditPayloadType,
  AuditRecord,
  AuditResult,
  AuditOutcome,
  AuditedHttpMethod,
  DiagnosticConfigRecord,
  DiagnosticVerificationStatus,
  DmlPolicyRecord,
  IdentityCredentialRecord,
  IdentityRouteRecord,
  ManagedDmlFieldRuleRecord,
  ManagedDmlFieldStrategy,
  Page,
  RuntimeSettingKey,
  RuntimeSettingRecord,
  SalesforceApiCallRecord,
  SalesforceApiCategory,
  SalesforceApiResult,
  SalesforceApiTransportKind,
  SalesforceApiVisibility,
  ToolControlRecord,
  TotalPage,
} from './contracts.js';

export type ListOptions = Readonly<{ limit: number; offset: number }>;
export type IdentityRouteListOptions = ListOptions & Readonly<{ keyword?: string }>;

export type IdentityRouteCreateInput = Readonly<{
  platformUserId: string;
  userName: string;
  salesforceUsername: string;
  enabled: boolean;
  remark: string | null;
}>;
export type IdentityRouteUpdateInput = IdentityRouteCreateInput & Readonly<{ rowVersion: string }>;

export interface IdentityRouteRepository {
  list(options: IdentityRouteListOptions): Promise<TotalPage<IdentityRouteRecord>>;
  countActive(): Promise<number>;
  getById(id: string): Promise<IdentityRouteRecord | undefined>;
  getByPlatformUserId(platformUserId: string): Promise<IdentityRouteRecord | undefined>;
  findActiveByPlatformUserId(platformUserId: string): Promise<IdentityRouteRecord | undefined>;
  listActiveSalesforceUsernames(): Promise<readonly string[]>;
  create(input: IdentityRouteCreateInput): Promise<IdentityRouteRecord>;
  update(id: string, input: IdentityRouteUpdateInput): Promise<IdentityRouteRecord>;
  disable(id: string, rowVersion: string): Promise<IdentityRouteRecord>;
  delete(id: string, rowVersion: string): Promise<void>;
}

export type IdentityCredentialCreateInput = Readonly<{
  identityRouteId: string;
  credentialType: 'USER_BOUND';
  tokenHash: string;
  tokenCiphertext: string;
  tokenLast4: string;
  generatedAt: Date;
}>;

export interface IdentityCredentialRepository {
  getById(id: string): Promise<IdentityCredentialRecord | undefined>;
  getByTokenHash(tokenHash: string): Promise<IdentityCredentialRecord | undefined>;
  getActiveByRouteId(identityRouteId: string): Promise<IdentityCredentialRecord | undefined>;
  listActiveByRouteIds(identityRouteIds: readonly string[]): Promise<readonly IdentityCredentialRecord[]>;
  listByRouteId(identityRouteId: string): Promise<readonly IdentityCredentialRecord[]>;
  create(input: IdentityCredentialCreateInput): Promise<IdentityCredentialRecord>;
  revoke(id: string, rowVersion: string, revokedAt: Date): Promise<IdentityCredentialRecord>;
  markLastUsed(id: string, usedAt: Date): Promise<void>;
  deleteByRouteId(identityRouteId: string): Promise<void>;
}

export type ToolControlWriteInput = Readonly<{
  enabled: boolean;
  remark: string | null;
  rowVersion?: string;
}>;

export interface ToolControlRepository {
  list(options: ListOptions): Promise<Page<ToolControlRecord>>;
  countEnabled(): Promise<number>;
  getByName(toolName: string): Promise<ToolControlRecord | undefined>;
  listEnabledNames(): Promise<readonly string[]>;
  createIfAbsent(toolName: string, enabled: boolean, remark: string | null): Promise<ToolControlRecord>;
  update(toolName: string, input: ToolControlWriteInput): Promise<ToolControlRecord>;
}

export type DmlPolicyCreateInput = Readonly<{
  objectApiName: string;
  allowCreate: boolean;
  allowUpdate: boolean;
  enabled: boolean;
  remark: string | null;
}>;
export type DmlPolicyUpdateInput = DmlPolicyCreateInput & Readonly<{ rowVersion: string }>;

export interface DmlPolicyRepository {
  list(options: ListOptions): Promise<Page<DmlPolicyRecord>>;
  countEnabled(): Promise<number>;
  getById(id: string): Promise<DmlPolicyRecord | undefined>;
  getByObjectApiName(objectApiName: string): Promise<DmlPolicyRecord | undefined>;
  listEnabled(): Promise<readonly DmlPolicyRecord[]>;
  create(input: DmlPolicyCreateInput): Promise<DmlPolicyRecord>;
  update(id: string, input: DmlPolicyUpdateInput): Promise<DmlPolicyRecord>;
  disable(id: string, rowVersion: string): Promise<DmlPolicyRecord>;
}

export type ManagedDmlFieldRuleCreateInput = Readonly<{
  dmlPolicyId: string;
  targetFieldApiName: string;
  strategy: ManagedDmlFieldStrategy;
  applyOnCreate: boolean;
  applyOnUpdate: boolean;
  lookupObjectApiName: string | null;
  lookupMatchFieldApiName: string | null;
  enabled: boolean;
  remark: string | null;
}>;
export type ManagedDmlFieldRuleUpdateInput = Omit<ManagedDmlFieldRuleCreateInput, 'dmlPolicyId'>
  & Readonly<{ rowVersion: string }>;

export interface ManagedDmlFieldRuleRepository {
  listByDmlPolicyId(dmlPolicyId: string, options: ListOptions): Promise<Page<ManagedDmlFieldRuleRecord>>;
  getById(id: string): Promise<ManagedDmlFieldRuleRecord | undefined>;
  listEnabledByDmlPolicyIds(dmlPolicyIds: readonly string[]): Promise<readonly ManagedDmlFieldRuleRecord[]>;
  create(input: ManagedDmlFieldRuleCreateInput): Promise<ManagedDmlFieldRuleRecord>;
  update(id: string, input: ManagedDmlFieldRuleUpdateInput): Promise<ManagedDmlFieldRuleRecord>;
  disable(id: string, rowVersion: string): Promise<ManagedDmlFieldRuleRecord>;
  delete(id: string, rowVersion: string): Promise<void>;
}

export type DiagnosticConfigWriteInput = Readonly<{
  salesforceUsername: string;
  enabled: boolean;
  testMetadataType: string | null;
  testMetadataFullName: string | null;
  rowVersion?: string;
}>;

export interface DiagnosticConfigRepository {
  get(): Promise<DiagnosticConfigRecord | undefined>;
  upsert(input: DiagnosticConfigWriteInput): Promise<DiagnosticConfigRecord>;
  recordVerification(input: Readonly<{
    rowVersion: string;
    status: DiagnosticVerificationStatus;
    errorCode: string | null;
    errorMessageSafe: string | null;
  }>): Promise<DiagnosticConfigRecord>;
}

export interface RuntimeSettingRepository {
  list(): Promise<readonly RuntimeSettingRecord[]>;
  get(key: RuntimeSettingKey): Promise<RuntimeSettingRecord | undefined>;
  upsert(key: RuntimeSettingKey, value: unknown, rowVersion?: string): Promise<RuntimeSettingRecord>;
}

export type AuditWrite = Readonly<{
  occurredAt: Date;
  publicAuditId?: string;
  auditKind?: AuditKind;
  startedAt?: Date;
  completedAt?: Date;
  correlationId: string;
  channel: 'MCP' | 'ADMIN';
  clientId?: string;
  actorAdmin?: string;
  platformUserId?: string;
  salesforceUsername?: string;
  executionRole?: 'USER' | 'DIAGNOSTIC';
  identitySource?: 'INTERNAL_SERVICE_HEADER' | 'USER_BOUND_TOKEN' | 'BUNTU_TOKEN';
  identityCredentialId?: string;
  toolName?: string;
  operation?: string;
  objectApiName?: string;
  recordId?: string;
  result: AuditResult;
  outcome?: 'SUCCESS' | 'FAILED' | 'DENIED' | 'UNKNOWN';
  errorCode?: string;
  errorMessageSafe?: string;
  auditIntegrityStatus?: AuditIntegrityStatus;
  durationMs?: number;
  requestSummary?: unknown;
  responseSummary?: unknown;
  /** 显式 opt-in 的 Buntu 原始 Token；仅允许 BUNTU_TOKEN_VALIDATE durable audit 使用。 */
  buntuRawTokenEvidence?: string;
}>;

export type AuditFilter = Readonly<{
  occurredFrom?: Date;
  occurredTo?: Date;
  auditId?: string;
  correlationId?: string;
  platformUserId?: string;
  salesforceUsername?: string;
  toolName?: string;
  result?: AuditResult;
  outcome?: AuditOutcome;
  errorCode?: string;
  objectApiName?: string;
  recordId?: string;
  auditKind?: AuditKind;
  auditIntegrityStatus?: AuditIntegrityStatus;
  limit: number;
  offset: number;
}>;

export interface AuditRepository {
  append(event: AuditWrite): Promise<AuditRecord>;
  getById(id: string): Promise<AuditRecord | undefined>;
  search(filter: AuditFilter): Promise<Page<AuditRecord>>;
  countSince(since: Date): Promise<Readonly<{ total: number; pass: number; blocked: number; error: number; unknown: number }>>;
}

export type AuditCallCreateInput = Omit<AuditWrite, 'auditKind' | 'channel' | 'toolName'> & Readonly<{
  toolName: string;
}>;

export type AuditEventCreateInput = Readonly<{
  auditId: string;
  sequence: number;
  parentEventId?: string;
  eventCategory: AuditEventCategory;
  eventType: string;
  eventName: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  status: AuditEventStatus;
  errorCode?: string;
  safeSummary?: unknown;
}>;

export type SalesforceApiCallCreateInput = Readonly<{
  publicApiCallId?: string;
  auditId: string;
  auditEventId?: string;
  sequence: number;
  salesforceUsername?: string;
  transportKind: SalesforceApiTransportKind;
  visibility: SalesforceApiVisibility;
  apiCategory: SalesforceApiCategory;
  httpMethod?: AuditedHttpMethod;
  endpoint?: string;
  requestUrl?: string;
  host?: string;
  endpointPath?: string;
  operationName?: string;
  apiVersion?: string;
  purpose: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  httpStatus?: number;
  result: SalesforceApiResult;
  salesforceErrorCode?: string;
  salesforceErrorMessageSafe?: string;
  requestSizeBytes?: number;
  responseSizeBytes?: number;
  contentType?: string;
  queryType?: string;
  soqlStatementSafe?: string;
  totalSize?: number;
  returnedRecords?: number;
  done?: boolean;
  hasNextRecords?: boolean;
  dmlOperation?: 'CREATE' | 'UPDATE';
  objectApiName?: string;
  recordId?: string;
  requestedFields?: unknown;
  managedFields?: unknown;
  submittedFields?: unknown;
}>;

export type AuditPayloadEvidenceCreateInput = Readonly<{
  auditId: string;
  salesforceApiCallId?: string;
  auditEventId?: string;
  payloadType: AuditPayloadType;
  contentType: string;
  originalSizeBytes?: number | null;
  truncated?: boolean;
  contentSha256?: string;
  safePayload?: unknown;
}>;

/**
 * P7 明细能力与兼容 AuditRepository 分离，避免旧 Runtime Logger 为新增能力实现无意义 mock。
 * 生产 MySQL repository 同时实现两个接口，但旧配置事务仍只依赖 AuditRepository。
 */
export interface AuditTraceRepository {
  createCall(input: AuditCallCreateInput): Promise<AuditRecord>;
  getByPublicAuditId(publicAuditId: string): Promise<AuditRecord | undefined>;
  createEvent(input: AuditEventCreateInput): Promise<AuditEventRecord>;
  listEvents(auditId: string, options: ListOptions): Promise<Page<AuditEventRecord>>;
  createSalesforceApiCall(input: SalesforceApiCallCreateInput): Promise<SalesforceApiCallRecord>;
  listSalesforceApiCalls(auditId: string, options: ListOptions): Promise<Page<SalesforceApiCallRecord>>;
  createPayloadEvidence(input: AuditPayloadEvidenceCreateInput): Promise<AuditPayloadEvidenceRecord>;
  listPayloadEvidenceMetadata(auditId: string, options: ListOptions): Promise<Page<AuditPayloadEvidenceSummaryRecord>>;
  listPayloadEvidence(auditId: string, options: ListOptions): Promise<Page<AuditPayloadEvidenceRecord>>;
  getPayloadEvidenceById(id: string): Promise<AuditPayloadEvidenceRecord | undefined>;
}

export type ControlPlaneRepositories = Readonly<{
  identityRoutes: IdentityRouteRepository;
  identityCredentials: IdentityCredentialRepository;
  tools: ToolControlRepository;
  dmlPolicies: DmlPolicyRepository;
  managedDmlFieldRules: ManagedDmlFieldRuleRepository;
  diagnostic: DiagnosticConfigRepository;
  runtimeSettings: RuntimeSettingRepository;
  audits: AuditRepository;
}>;

export type ControlPlaneRepositoriesWithAuditTrace = ControlPlaneRepositories & Readonly<{
  auditTraces: AuditTraceRepository;
}>;
