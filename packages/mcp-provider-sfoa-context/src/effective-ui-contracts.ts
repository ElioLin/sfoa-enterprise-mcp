import { z } from 'zod';
import type { InitialFact } from './create-initial-state.js';

export const UI_RESOLVER_VERSION = 'P8-07.1';
export const UI_PARSER_VERSION = 'P8-04.1';
export const UI_SNAPSHOT_TTL_MS = 86_400_000;
export const uiNameSchema = z.string().min(1).max(255);
export const uiModeSchema = z.enum(['OFF', 'SHADOW', 'ENFORCE']);
export const formFactorSchema = z.enum(['Large', 'Medium', 'Small']);
export const visibilityStateSchema = z.enum(['VISIBLE', 'HIDDEN', 'PENDING', 'UNKNOWN']);
export const formSourceSchema = z.enum(['PAGE_LAYOUT', 'DYNAMIC_FORMS', 'MIXED', 'CUSTOM_OVERRIDE', 'AMBIGUOUS', 'UNRESOLVED']);
export const visibilityRuleSchema = z.object({
  criteria: z.array(z.object({
    leftValue: z.string().max(512), operator: z.string().max(64),
    rightValue: z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]).optional(),
  }).strict()).max(50),
  booleanFilter: z.string().max(512).optional(),
  unsupported: z.boolean().optional(),
}).strict();
export const fieldInstanceSchema = z.object({
  apiName: uiNameSchema, instanceId: uiNameSchema, section: uiNameSchema.nullable(),
  sectionOrder: z.number().int().nonnegative(), column: z.number().int().nonnegative(),
  order: z.number().int().nonnegative(), ancestry: z.array(uiNameSchema).max(30),
  required: z.boolean(), readOnly: z.boolean(),
  rules: z.array(z.object({
    scope: z.enum(['FIELD', 'CONTAINER']), rule: visibilityRuleSchema,
  }).strict()).max(30),
}).strict();
export const uiPageSchema = z.object({
  fullName: uiNameSchema, objectApiName: uiNameSchema, type: uiNameSchema,
  formSource: formSourceSchema, fields: z.array(fieldInstanceSchema).max(1000),
  unsupported: z.array(z.string().max(128)).max(30),
}).strict();
export const uiAssignmentSchema = z.object({
  app: uiNameSchema.nullable(), profile: uiNameSchema.nullable(), recordType: uiNameSchema.nullable(),
  formFactor: formFactorSchema.nullable(), action: z.enum(['View', 'New']),
  type: uiNameSchema, page: uiNameSchema.nullable(),
  source: z.enum(['ORG_DEFAULT', 'APP_DEFAULT', 'APP_PROFILE_RECORD_TYPE']),
}).strict();
export const uiSnapshotSchema = z.object({
  organizationId: z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u),
  objectApiName: uiNameSchema, parserVersion: z.literal(UI_PARSER_VERSION),
  apps: z.array(z.object({
    appId: uiNameSchema, developerName: uiNameSchema, fullName: uiNameSchema,
  }).strict()).max(100),
  profiles: z.array(z.object({ id: uiNameSchema, name: uiNameSchema, fullName: uiNameSchema }).strict()).max(500),
  recordTypes: z.array(z.object({ id: uiNameSchema, fullName: uiNameSchema }).strict()).max(200),
  assignments: z.array(uiAssignmentSchema).max(5000),
  pages: z.array(uiPageSchema).max(100),
  complete: z.literal(true),
}).strict();

export const uiContextSchema = z.object({
  resolutionId: z.string().uuid(), mode: uiModeSchema, formSource: formSourceSchema,
  resolutionStatus: z.enum(['RESOLVED', 'AMBIGUOUS', 'UNRESOLVED']),
  app: uiNameSchema.nullable(), formFactor: formFactorSchema,
  page: uiNameSchema.nullable(), assignmentSource: z.string().max(128).nullable(),
  fallbackUsed: z.boolean(), fallbackReason: z.string().max(128).nullable(),
  coverage: z.enum(['COMPLETE', 'PARTIAL', 'NONE']), resolverVersion: z.string(),
  maxRefinements: z.literal(3), refinement: z.number().int().min(0).max(3),
  refinementLimitReached: z.boolean(),
}).strict();

export type UiMode = z.infer<typeof uiModeSchema>;
export type FormFactor = z.infer<typeof formFactorSchema>;
export type VisibilityState = z.infer<typeof visibilityStateSchema>;
export type VisibilityRule = z.infer<typeof visibilityRuleSchema>;
export type UiFieldInstance = z.infer<typeof fieldInstanceSchema>;
export type UiPage = z.infer<typeof uiPageSchema>;
export type UiAssignment = z.infer<typeof uiAssignmentSchema>;
export type UiSnapshot = z.infer<typeof uiSnapshotSchema>;
export type UiContext = z.infer<typeof uiContextSchema>;
export type UiSnapshotRecord = Readonly<{
  id: string; organizationId: string; objectApiName: string; snapshot: unknown;
  hash: string | null; lastModified: string | null; refreshedAt: string | null;
  status: 'READY' | 'REFRESHING' | 'FAILED'; lastError: string | null; parserVersion: string;
}>;
export type UiObjectPolicy = Readonly<{ objectApiName: string; mode: UiMode; defaultApp?: string | null }>;
export type EffectiveUiOptions = Readonly<{
  policies: readonly UiObjectPolicy[];
  integrationDefaultApp?: string;
  appDeveloperName?: string;
  formFactor?: FormFactor;
  requestContextError?: string;
  managedFields?: readonly string[];
  resolveRuntimeDefaults?(objectApiName: string, dependencyFields: readonly string[]): Promise<readonly InitialFact[]>;
  loadSnapshot(organizationId: string, objectApiName: string): Promise<UiSnapshotRecord | undefined>;
  audit(evidence: Readonly<Record<string, unknown>>): void;
}>;
