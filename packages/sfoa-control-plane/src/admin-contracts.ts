import { z } from 'zod';
import {
  idSchema,
  objectApiNameSchema,
  platformUserIdSchema,
  remarkSchema,
  rowVersionSchema,
  salesforceUsernameSchema,
  toolNameSchema,
  type AuditRecord,
  type DiagnosticConfigRecord,
  type DmlPolicyRecord,
  type IdentityRouteRecord,
  type Page,
  type RuntimeSettingRecord,
} from './contracts.js';

export const ADMIN_API_PREFIX = '/admin/api';
export const ADMIN_CSRF_HEADER = 'x-sfoa-csrf-token';

export const adminLoginInputSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
}).strict();

export const adminIdPathSchema = idSchema;
export const adminToolNamePathSchema = toolNameSchema;

export const adminPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict();

const optionalRemarkSchema = remarkSchema.optional().transform((value) => value ?? null);

export const adminIdentityRouteCreateSchema = z.object({
  platformUserId: platformUserIdSchema,
  salesforceUsername: salesforceUsernameSchema,
  enabled: z.boolean(),
  remark: optionalRemarkSchema,
}).strict();

export const adminIdentityRouteUpdateSchema = z.object({
  platformUserId: platformUserIdSchema,
  salesforceUsername: salesforceUsernameSchema,
  enabled: z.boolean(),
  remark: optionalRemarkSchema,
  rowVersion: rowVersionSchema,
}).strict();

export const adminSoftDisableSchema = z.object({
  rowVersion: rowVersionSchema,
}).strict();

export const adminToolControlUpdateSchema = z.object({
  enabled: z.boolean(),
  remark: optionalRemarkSchema,
  rowVersion: rowVersionSchema.nullable().optional(),
}).strict();

const dmlFields = {
  objectApiName: objectApiNameSchema,
  allowCreate: z.boolean(),
  allowUpdate: z.boolean(),
  enabled: z.boolean(),
  remark: optionalRemarkSchema,
} as const;

export const adminDmlPolicyCreateSchema = z.object(dmlFields).strict().superRefine((value, context) => {
  if (value.enabled && !value.allowCreate && !value.allowUpdate) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'An enabled policy must allow CREATE, UPDATE, or both.' });
  }
});

export const adminDmlPolicyUpdateSchema = z.object({
  ...dmlFields,
  rowVersion: rowVersionSchema,
}).strict().superRefine((value, context) => {
  if (value.enabled && !value.allowCreate && !value.allowUpdate) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'An enabled policy must allow CREATE, UPDATE, or both.' });
  }
});

// This is intentionally the same bounded set enforced by the audited P4 metadata context Tool.
export const ADMIN_DIAGNOSTIC_METADATA_TYPES = [
  'CustomObject',
  'CustomField',
  'ValidationRule',
  'Flow',
  'ApexClass',
  'ApexTrigger',
  'Layout',
  'FlexiPage',
] as const;

export const adminDiagnosticMetadataTypeSchema = z.enum(ADMIN_DIAGNOSTIC_METADATA_TYPES);
export const adminDiagnosticMetadataFullNameSchema = z.string().trim().min(1).max(255)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/u, 'contains characters outside the supported Metadata API full-name set')
  .refine((value) => !value.includes('..'), 'must not contain a path traversal sequence')
  .refine((value) => !/[\\/]/u.test(value), 'must not contain a filesystem separator');

export const adminDiagnosticConfigUpdateSchema = z.object({
  salesforceUsername: salesforceUsernameSchema,
  enabled: z.boolean(),
  testMetadataType: adminDiagnosticMetadataTypeSchema.nullable(),
  testMetadataFullName: adminDiagnosticMetadataFullNameSchema.nullable(),
  rowVersion: rowVersionSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.testMetadataType) !== Boolean(value.testMetadataFullName)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['testMetadataType'],
      message: 'Metadata type and fullName must both be supplied or both be null.',
    });
  }
});

export const adminAuditQuerySchema = z.object({
  occurredFrom: z.string().datetime({ offset: true }).optional(),
  occurredTo: z.string().datetime({ offset: true }).optional(),
  correlationId: z.string().trim().min(1).max(128).optional(),
  platformUserId: platformUserIdSchema.optional(),
  salesforceUsername: salesforceUsernameSchema.optional(),
  toolName: toolNameSchema.optional(),
  result: z.enum(['PASS', 'ERROR', 'BLOCKED']).optional(),
  errorCode: z.string().trim().min(1).max(128).regex(/^[A-Z0-9_]+$/u).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict().superRefine((value, context) => {
  if (value.occurredFrom && value.occurredTo && Date.parse(value.occurredFrom) > Date.parse(value.occurredTo)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['occurredTo'], message: 'must not precede occurredFrom' });
  }
});

export const adminRuntimeSettingKeySchema = z.enum(['auditRetentionDays', 'adminDefaultPageSize']);
export const adminRuntimeSettingUpdateSchemas = Object.freeze({
  auditRetentionDays: z.object({
    value: z.number().int().min(1).max(3650),
    rowVersion: rowVersionSchema.nullable().optional(),
  }).strict(),
  adminDefaultPageSize: z.object({
    value: z.number().int().min(10).max(100),
    rowVersion: rowVersionSchema.nullable().optional(),
  }).strict(),
});

export type AdminLoginInput = z.infer<typeof adminLoginInputSchema>;
export type AdminIdentityRouteCreateInput = z.infer<typeof adminIdentityRouteCreateSchema>;
export type AdminIdentityRouteUpdateInput = z.infer<typeof adminIdentityRouteUpdateSchema>;
export type AdminToolControlUpdateInput = z.infer<typeof adminToolControlUpdateSchema>;
export type AdminDmlPolicyCreateInput = z.infer<typeof adminDmlPolicyCreateSchema>;
export type AdminDmlPolicyUpdateInput = z.infer<typeof adminDmlPolicyUpdateSchema>;
export type AdminDiagnosticConfigUpdateInput = z.infer<typeof adminDiagnosticConfigUpdateSchema>;

export type AdminApiErrorDto = Readonly<{
  error: Readonly<{ code: string; message: string; issues?: readonly Readonly<{ path: string; message: string }>[] }>;
  correlationId: string;
}>;

export type AdminSessionDto = Readonly<{
  username: string;
  csrfToken: string;
  expiresAt: number;
}>;

export type RouteVerificationDto = Readonly<{
  status: 'PASS' | 'FAIL';
  identityMatched: boolean;
  salesforceUsername: string | null;
  durationMs: number;
  error: Readonly<{ code: string; message: string }> | null;
}>;

export type AdminToolRecordDto = Readonly<{
  toolName: string;
  classification: 'READ' | 'METADATA_READ' | 'MUTATION' | 'ADMIN' | 'LOCAL_DEV' | 'UNKNOWN';
  executionRole: 'USER' | 'DIAGNOSTIC';
  remoteCompatible: boolean;
  releaseState: 'GA' | 'NON_GA' | 'UNKNOWN';
  enabled: boolean;
  rowVersion: string | null;
  remark: string | null;
  dependencies: readonly string[];
  status: 'AVAILABLE' | 'DISABLED' | 'UNSUPPORTED' | 'REVIEW_REQUIRED' | 'UNKNOWN';
  enableAllowed: boolean;
  disabledReason: string | null;
}>;

export type DiagnosticVerificationDto = Readonly<{
  config: DiagnosticConfigRecord;
  verification: Readonly<{
    status: 'PASS' | 'FAIL' | 'NOT_TESTED';
    identityMatched: boolean;
    salesforceUsername: string;
    apiVersion: string | null;
    durationMs: number;
    tooling: Readonly<{ totalSize: number; returnedRecords: number; truncated: boolean }> | null;
    metadata: Readonly<{
      status: 'PASS' | 'NOT_TESTED';
      metadataType: string | null;
      fullName: string | null;
      totalFiles: number;
      returnedFiles: number;
      returnedBytes: number;
      truncated: boolean;
    }> | null;
    cleanup: Readonly<{ created: number; cleaned: number; active: number; pass: boolean }> | null;
    error: Readonly<{ code: string; message: string }> | null;
  }>;
}>;

export type DiagnosticPageDto = Readonly<{
  config: DiagnosticConfigRecord | null;
  configured: Readonly<{
    connectedApp: boolean;
    jwtPrivateKey: boolean;
  }>;
}>;

export type ProviderVersionDto = Readonly<{ name: string; version: string }>;

export type DashboardDto = Readonly<{
  runtimeHealth: 'UP' | 'DOWN' | 'UNKNOWN';
  databaseHealth: 'UP' | 'DOWN';
  upstreamDrift: 'PASS' | 'UPSTREAM_REVIEW_REQUIRED';
  routeCount: number;
  enabledToolCount: number;
  dmlPolicyObjectCount: number;
  diagnostic: DiagnosticConfigRecord | null;
  calls24h: Readonly<{ total: number; pass: number; blocked: number; error: number; unknown: number }>;
  latestErrors: readonly AuditRecord[];
  providerVersions: readonly ProviderVersionDto[];
}>;

export type SystemStatusDto = Readonly<{
  adminVersion: string;
  mcpServerVersion: string;
  salesforceApiVersion: string;
  providerVersions: readonly ProviderVersionDto[];
  upstreamDrift: Readonly<{ status: 'PASS' | 'UPSTREAM_REVIEW_REQUIRED'; count: number }>;
  database: Readonly<{ status: 'UP' | 'DOWN'; version: string | null; schemaVersions: readonly string[] }>;
  runtimeMode: 'env' | 'mysql';
  salesforceInstanceHost: string | null;
  configured: Readonly<{
    connectedApp: boolean;
    jwtPrivateKey: boolean;
    mcpClientToken: boolean;
  }>;
  diagnostic: DiagnosticConfigRecord | null;
  mcpHealth: 'UP' | 'DOWN' | 'UNKNOWN';
  auditPersistence: Readonly<{ status: 'UP' | 'DEGRADED'; failureCount: number }>;
  mcpEndpoint: string;
  phases: Readonly<Record<'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5', string>>;
  readOnlyRuntimeSettings: Readonly<Record<string, string | number | boolean | readonly string[] | null>>;
}>;

export type AdminRoutesResponse = Page<IdentityRouteRecord>;
export type AdminToolsResponse = Readonly<{
  items: readonly AdminToolRecordDto[];
  controlsTruncated: boolean;
}>;
export type AdminDmlPoliciesResponse = Page<DmlPolicyRecord>;
export type AdminAuditsResponse = Page<AuditRecord>;
export type AdminRuntimeSettingsResponse = readonly RuntimeSettingRecord[];
