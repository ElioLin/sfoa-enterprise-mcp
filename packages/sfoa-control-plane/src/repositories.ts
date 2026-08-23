import type {
  AuditRecord,
  AuditResult,
  DiagnosticConfigRecord,
  DiagnosticVerificationStatus,
  DmlPolicyRecord,
  IdentityRouteRecord,
  Page,
  RuntimeSettingKey,
  RuntimeSettingRecord,
  ToolControlRecord,
} from './contracts.js';

export type ListOptions = Readonly<{ limit: number; offset: number }>;

export type IdentityRouteCreateInput = Readonly<{
  platformUserId: string;
  salesforceUsername: string;
  enabled: boolean;
  remark: string | null;
}>;
export type IdentityRouteUpdateInput = IdentityRouteCreateInput & Readonly<{ rowVersion: string }>;

export interface IdentityRouteRepository {
  list(options: ListOptions): Promise<Page<IdentityRouteRecord>>;
  countActive(): Promise<number>;
  getById(id: string): Promise<IdentityRouteRecord | undefined>;
  getByPlatformUserId(platformUserId: string): Promise<IdentityRouteRecord | undefined>;
  findActiveByPlatformUserId(platformUserId: string): Promise<IdentityRouteRecord | undefined>;
  listActiveSalesforceUsernames(): Promise<readonly string[]>;
  create(input: IdentityRouteCreateInput): Promise<IdentityRouteRecord>;
  update(id: string, input: IdentityRouteUpdateInput): Promise<IdentityRouteRecord>;
  disable(id: string, rowVersion: string): Promise<IdentityRouteRecord>;
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
  tools: ToolControlRepository;
  dmlPolicies: DmlPolicyRepository;
  diagnostic: DiagnosticConfigRepository;
  runtimeSettings: RuntimeSettingRepository;
  audits: AuditRepository;
}>;
