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
export const objectApiNameSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/u);
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

export type AuditRecord = Readonly<{
  id: string;
  occurredAt: string;
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
  durationMs: number | null;
  requestSummary: unknown;
  responseSummary: unknown;
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
    runtimeSettings: Object.freeze({ ...snapshot.runtimeSettings }),
  });
}
