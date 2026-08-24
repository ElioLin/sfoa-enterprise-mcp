import type {
  AuditRecord,
  AuditResult,
  DiagnosticConfigRecord,
  DiagnosticVerificationStatus,
  DmlPolicyRecord,
  IdentityCredentialRecord,
  IdentityRouteRecord,
  Page,
  RuntimeSettingKey,
  RuntimeSettingRecord,
  ToolControlRecord,
  TotalPage,
} from './contracts.js';

export type ListOptions = Readonly<{ limit: number; offset: number }>;
export type IdentityRouteListOptions = ListOptions & Readonly<{ keyword?: string }>;

export type IdentityRouteCreateInput = Readonly<{
  platformUserId: string;
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
  durationMs?: number;
  requestSummary?: unknown;
  responseSummary?: unknown;
}>;

export type AuditFilter = Readonly<{
  occurredFrom?: Date;
  occurredTo?: Date;
  correlationId?: string;
  platformUserId?: string;
  salesforceUsername?: string;
  toolName?: string;
  result?: AuditResult;
  errorCode?: string;
  limit: number;
  offset: number;
}>;

export interface AuditRepository {
  append(event: AuditWrite): Promise<AuditRecord>;
  getById(id: string): Promise<AuditRecord | undefined>;
  search(filter: AuditFilter): Promise<Page<AuditRecord>>;
  countSince(since: Date): Promise<Readonly<{ total: number; pass: number; blocked: number; error: number; unknown: number }>>;
}

export type ControlPlaneRepositories = Readonly<{
  identityRoutes: IdentityRouteRepository;
  identityCredentials: IdentityCredentialRepository;
  tools: ToolControlRepository;
  dmlPolicies: DmlPolicyRepository;
  diagnostic: DiagnosticConfigRepository;
  runtimeSettings: RuntimeSettingRepository;
  audits: AuditRepository;
}>;
