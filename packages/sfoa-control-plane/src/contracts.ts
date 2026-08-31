import { z } from 'zod';

export const controlPlaneModeSchema = z.enum(['env', 'mysql']);
export type ControlPlaneMode = z.infer<typeof controlPlaneModeSchema>;

export const IDENTITY_SOURCES = ['INTERNAL_SERVICE_HEADER', 'USER_BOUND_TOKEN', 'BUNTU_TOKEN'] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export const IDENTITY_CREDENTIAL_TYPES = ['USER_BOUND'] as const;
export type IdentityCredentialType = (typeof IDENTITY_CREDENTIAL_TYPES)[number];
export const IDENTITY_CREDENTIAL_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type IdentityCredentialStatus = (typeof IDENTITY_CREDENTIAL_STATUSES)[number];

export const platformUserIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value), 'must not contain control characters');
export const salesforceUsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine((value) => !/\s|[\u0000-\u001F\u007F]/u.test(value), 'must not contain whitespace or control characters');
export const toolNameSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
export const salesforceApiIdentifierSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/u);
export const objectApiNameSchema = salesforceApiIdentifierSchema;
export const fieldApiNameSchema = salesforceApiIdentifierSchema;
export const remarkSchema = z.string().trim().max(512).nullable().default(null);
export const rowVersionSchema = z.string().regex(/^[1-9][0-9]{0,19}$/u);
export const idSchema = z.string().regex(/^[1-9][0-9]{0,19}$/u);

export type IdentityRouteRecord = Readonly<{
  id: string;
  platformUserId: string;
  salesforceUsername: string;
  enabled: boolean;
  remark: string | null;
  rowVersion: string;
  createdAt: string;
  updatedAt: string;
}>;

export type IdentityCredentialRecord = Readonly<{
  id: string;
  identityRouteId: string;
  credentialType: IdentityCredentialType;
  tokenHash: string;
  tokenCiphertext: string | null;
  tokenLast4: string;
  status: IdentityCredentialStatus;
  generatedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  rowVersion: string;
  createdAt: string;
  updatedAt: string;
}>;

export type ToolControlRecord = Readonly<{
  id: string;
  toolName: string;
  enabled: boolean;
  remark: string | null;
  rowVersion: string;
  createdAt: string;
  updatedAt: string;
}>;

export type DmlPolicyRecord = Readonly<{
  id: string;
  objectApiName: string;
  allowCreate: boolean;
  allowUpdate: boolean;
  enabled: boolean;
  remark: string | null;
  rowVersion: string;
  createdAt: string;
  updatedAt: string;
}>;

export const MANAGED_DML_FIELD_STRATEGIES = ['PLATFORM_USER_LOOKUP', 'AI_CREATED_MARKER'] as const;
export const managedDmlFieldStrategySchema = z.enum(MANAGED_DML_FIELD_STRATEGIES);
export type ManagedDmlFieldStrategy = z.infer<typeof managedDmlFieldStrategySchema>;

export type ManagedDmlFieldRuleRecord = Readonly<{
  id: string;
  dmlPolicyId: string;
  targetFieldApiName: string;
  strategy: ManagedDmlFieldStrategy;
  applyOnCreate: boolean;
  applyOnUpdate: boolean;
  lookupObjectApiName: string | null;
  lookupMatchFieldApiName: string | null;
  enabled: boolean;
  remark: string | null;
  rowVersion: string;
  createdAt: string;
  updatedAt: string;
}>;

export const diagnosticVerificationStatusSchema = z.enum(['NOT_VERIFIED', 'PASS', 'FAIL', 'NOT_TESTED']);
export type DiagnosticVerificationStatus = z.infer<typeof diagnosticVerificationStatusSchema>;

export type DiagnosticConfigRecord = Readonly<{
  id: '1';
  salesforceUsername: string;
  enabled: boolean;
  verificationStatus: DiagnosticVerificationStatus;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessageSafe: string | null;
  testMetadataType: string | null;
  testMetadataFullName: string | null;
  rowVersion: string;
  createdAt: string;
  updatedAt: string;
}>;

export const RUNTIME_SETTING_KEYS = ['auditRetentionDays', 'adminDefaultPageSize'] as const;
export type RuntimeSettingKey = (typeof RUNTIME_SETTING_KEYS)[number];

export type RuntimeSettingRecord = Readonly<{
  settingKey: RuntimeSettingKey;
  settingValue: unknown;
  rowVersion: string;
  updatedAt: string;
}>;

export type AuditResult = 'PASS' | 'ERROR' | 'BLOCKED';
export type AuditOutcome = 'SUCCESS' | 'FAILED' | 'DENIED' | 'UNKNOWN';
export type AuditChannel = 'MCP' | 'ADMIN';

export const AUDIT_KINDS = ['MCP_TOOL_CALL', 'ADMIN_ACTION', 'IDENTITY_VALIDATION', 'RUNTIME_EVENT'] as const;
export const auditKindSchema = z.enum(AUDIT_KINDS);
export type AuditKind = z.infer<typeof auditKindSchema>;

export const AUDIT_INTEGRITY_STATUSES = ['COMPLETE', 'PARTIAL', 'DEGRADED'] as const;
export const auditIntegrityStatusSchema = z.enum(AUDIT_INTEGRITY_STATUSES);
export type AuditIntegrityStatus = z.infer<typeof auditIntegrityStatusSchema>;

export const AUDIT_EVENT_CATEGORIES = [
  'MCP', 'IDENTITY', 'ROUTING', 'GOVERNANCE', 'TOOL', 'SALESFORCE', 'INTERNAL', 'AUDIT',
] as const;
export const auditEventCategorySchema = z.enum(AUDIT_EVENT_CATEGORIES);
export type AuditEventCategory = z.infer<typeof auditEventCategorySchema>;

export const AUDIT_EVENT_STATUSES = ['STARTED', 'SUCCESS', 'FAILED', 'BLOCKED', 'SKIPPED', 'UNKNOWN'] as const;
export const auditEventStatusSchema = z.enum(AUDIT_EVENT_STATUSES);
export type AuditEventStatus = z.infer<typeof auditEventStatusSchema>;

export const SALESFORCE_API_CATEGORIES = [
  'OAUTH', 'REST_API', 'UI_API', 'TOOLING_API', 'COMPOSITE_API', 'BULK_API',
  'APEX_REST_API', 'METADATA_API', 'SOAP_API', 'SALESFORCE_CLI', 'UNKNOWN',
] as const;
export const salesforceApiCategorySchema = z.enum(SALESFORCE_API_CATEGORIES);
export type SalesforceApiCategory = z.infer<typeof salesforceApiCategorySchema>;

export const SALESFORCE_API_TRANSPORT_KINDS = ['HTTP', 'JSFORCE', 'SALESFORCE_CLI', 'OFFICIAL_PROVIDER', 'OTHER'] as const;
export const salesforceApiTransportKindSchema = z.enum(SALESFORCE_API_TRANSPORT_KINDS);
export type SalesforceApiTransportKind = z.infer<typeof salesforceApiTransportKindSchema>;

export const SALESFORCE_API_VISIBILITIES = ['EXACT_HTTP', 'OPERATION_ONLY'] as const;
export const salesforceApiVisibilitySchema = z.enum(SALESFORCE_API_VISIBILITIES);
export type SalesforceApiVisibility = z.infer<typeof salesforceApiVisibilitySchema>;

export const AUDITED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export const auditedHttpMethodSchema = z.enum(AUDITED_HTTP_METHODS);
export type AuditedHttpMethod = z.infer<typeof auditedHttpMethodSchema>;

export const SALESFORCE_API_RESULTS = ['SUCCESS', 'FAILED', 'UNKNOWN'] as const;
export const salesforceApiResultSchema = z.enum(SALESFORCE_API_RESULTS);
export type SalesforceApiResult = z.infer<typeof salesforceApiResultSchema>;

export const AUDIT_PAYLOAD_TYPES = [
  'MCP_REQUEST', 'MCP_RESPONSE', 'SALESFORCE_REQUEST', 'SALESFORCE_RESPONSE', 'ERROR_RESPONSE',
] as const;
export const auditPayloadTypeSchema = z.enum(AUDIT_PAYLOAD_TYPES);
export type AuditPayloadType = z.infer<typeof auditPayloadTypeSchema>;

export const auditSequenceSchema = z.number().int().min(1).max(4_294_967_295);
export const auditEventTypeSchema = z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,63}$/u);
export const auditEventNameSchema = z.string().trim().min(1).max(128);
export const auditPurposeSchema = z.string().trim().min(1).max(256);
export const auditQueryTypeSchema = z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,63}$/u);
export const auditContentTypeSchema = z.string().trim().min(1).max(128);

export type AuditRecord = Readonly<{
  id: string;
  publicAuditId: string;
  auditKind: AuditKind;
  occurredAt: string;
  startedAt: string | null;
  completedAt: string | null;
  correlationId: string;
  channel: AuditChannel;
  clientId: string | null;
  actorAdmin: string | null;
  platformUserId: string | null;
  salesforceUsername: string | null;
  executionRole: 'USER' | 'DIAGNOSTIC' | null;
  identitySource: IdentitySource | null;
  identityCredentialId: string | null;
  toolName: string | null;
  operation: string | null;
  objectApiName: string | null;
  recordId: string | null;
  result: AuditResult;
  outcome: AuditOutcome | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  auditIntegrityStatus: AuditIntegrityStatus;
  durationMs: number | null;
  requestSummary: unknown;
  responseSummary: unknown;
  createdAt: string;
}>;

export type AuditEventRecord = Readonly<{
  id: string;
  auditId: string;
  sequence: number;
  parentEventId: string | null;
  eventCategory: AuditEventCategory;
  eventType: string;
  eventName: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  status: AuditEventStatus;
  errorCode: string | null;
  safeSummary: unknown;
  createdAt: string;
}>;

export type SalesforceApiCallRecord = Readonly<{
  id: string;
  publicApiCallId: string;
  auditId: string;
  auditEventId: string | null;
  sequence: number;
  salesforceUsername: string | null;
  transportKind: SalesforceApiTransportKind;
  visibility: SalesforceApiVisibility;
  apiCategory: SalesforceApiCategory;
  httpMethod: AuditedHttpMethod | null;
  endpoint: string | null;
  requestUrl: string | null;
  host: string | null;
  endpointPath: string | null;
  operationName: string | null;
  apiVersion: string | null;
  purpose: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  httpStatus: number | null;
  result: SalesforceApiResult;
  salesforceErrorCode: string | null;
  salesforceErrorMessageSafe: string | null;
  requestSizeBytes: string | null;
  responseSizeBytes: string | null;
  contentType: string | null;
  queryType: string | null;
  soqlStatementSafe: string | null;
  totalSize: number | null;
  returnedRecords: number | null;
  done: boolean | null;
  dmlOperation: 'CREATE' | 'UPDATE' | null;
  objectApiName: string | null;
  recordId: string | null;
  requestedFields: unknown;
  managedFields: unknown;
  createdAt: string;
}>;

export type AuditPayloadEvidenceRecord = Readonly<{
  id: string;
  auditId: string;
  salesforceApiCallId: string | null;
  auditEventId: string | null;
  payloadType: AuditPayloadType;
  contentType: string;
  originalSizeBytes: string;
  storedSizeBytes: number;
  truncated: boolean;
  contentSha256: string | null;
  safePayload: string | null;
  createdAt: string;
}>;

export type Page<T> = Readonly<{
  items: readonly T[];
  limit: number;
  offset: number;
  count: number;
  hasMore: boolean;
  nextOffset: number | null;
}>;

export type TotalPage<T> = Page<T> & Readonly<{ total: number }>;

export type RequestPolicySnapshot = Readonly<{
  mode: ControlPlaneMode;
  loadedAt: string;
  identityRoute: IdentityRouteRecord | null;
  enabledTools: readonly string[];
  dmlPolicies: readonly DmlPolicyRecord[];
  managedDmlFieldRules: readonly ManagedDmlFieldRuleRecord[];
  diagnostic: DiagnosticConfigRecord | null;
  runtimeSettings: Readonly<Partial<Record<RuntimeSettingKey, unknown>>>;
}>;

export function normalizeSalesforceUsername(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function freezeSnapshot(snapshot: RequestPolicySnapshot): RequestPolicySnapshot {
  return Object.freeze({
    ...snapshot,
    enabledTools: Object.freeze([...snapshot.enabledTools]),
    dmlPolicies: Object.freeze([...snapshot.dmlPolicies]),
    managedDmlFieldRules: Object.freeze(snapshot.managedDmlFieldRules.map((rule) => Object.freeze({ ...rule }))),
    runtimeSettings: Object.freeze({ ...snapshot.runtimeSettings }),
  });
}
