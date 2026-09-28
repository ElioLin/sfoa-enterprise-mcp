import { z } from 'zod';
import { uiContextSchema, visibilityStateSchema } from './effective-ui-contracts.js';

const apiNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/u;
const salesforceIdPattern = /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/u;

export const objectApiNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(apiNamePattern, 'must be a Salesforce object API name without a relationship path')
  .describe('Salesforce object API name, for example Lead or SomeObject__c.');

export const salesforceIdSchema = z
  .string()
  .trim()
  .regex(salesforceIdPattern, 'must be a 15- or 18-character Salesforce ID');

export const recordActionContextInputObjectSchema = z.object({
    objectApiName: objectApiNameSchema,
    action: z.enum(['CREATE', 'UPDATE']).describe('Record action whose current USER context is required.'),
    recordTypeId: salesforceIdSchema.optional().describe('Optional currently available Salesforce Record Type ID.'),
    recordId: salesforceIdSchema.optional().describe('Required for UPDATE; forbidden for CREATE.'),
    draftFields: z.record(objectApiNameSchema, z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]))
      .refine((value) => Object.keys(value).length <= 200 && JSON.stringify(value).length <= 32768, 'draftFields exceeds its bound')
      .optional().describe('CREATE only: known prompt values for conditional visibility; missing differs from null, false, zero and empty string. Never persisted as UI metadata.'),
    refinement: z.number().int().min(0).max(3).optional().describe('CREATE only: Dynamic Context refinement number, 0 initially, at most 3. Stop asking for refinements at 3.'),
  }).strict();

export const recordActionContextInputSchema = recordActionContextInputObjectSchema.superRefine((input, context) => {
    if (input.action === 'UPDATE' && (input.draftFields !== undefined || input.refinement !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'draftFields and refinement are CREATE-only' });
    }
    if (input.action === 'CREATE' && input.recordId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['recordId'], message: 'recordId is forbidden for CREATE' });
    }
    if (input.action === 'UPDATE' && !input.recordId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['recordId'], message: 'recordId is required for UPDATE' });
    }
  });

export const diagnosticQueryInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(12_000)
      .refine((value) => /^SELECT\b/iu.test(value), 'must be a Tooling API SELECT query')
      .refine((value) => !/;/u.test(value), 'must contain exactly one query without a semicolon')
      .refine((value) => !/\bFOR\s+UPDATE\b/iu.test(value), 'must not request record locking')
      .describe('A bounded Tooling API SOQL SELECT query. The server fixes the DIAGNOSTIC identity and Tooling API route.'),
  })
  .strict();

export const METADATA_CONTEXT_TYPES = [
  'CustomObject',
  'CustomField',
  'ValidationRule',
  'Flow',
  'ApexClass',
  'ApexTrigger',
  'Layout',
  'FlexiPage',
] as const;

export const metadataTypeSchema = z.enum(METADATA_CONTEXT_TYPES);
export const metadataFullNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/u, 'contains characters outside the supported Metadata API full-name set')
  .refine((value) => !value.includes('..'), 'must not contain a path traversal sequence')
  .refine((value) => !/[\\/]/u.test(value), 'must not contain a filesystem separator')
  .describe('Exact Metadata API full name. This is a component name, never a filesystem path.');

export const metadataContextInputSchema = z
  .object({
    metadataType: metadataTypeSchema.describe('Allowlisted diagnostic Metadata API type.'),
    fullName: metadataFullNameSchema,
  })
  .strict();

const contextFailureFields = {
  success: z.boolean(),
  errorCode: z.string().max(128).optional(),
  message: z.string().max(2_000).optional(),
};

const picklistValueSchema = z
  .object({
    label: z.string(),
    value: z.string(),
    default: z.boolean(),
    validFor: z.array(z.number().int().nonnegative()),
  })
  .strict();

const picklistContextSchema = z
  .object({
    controllerName: z.string().nullable(),
    controllerValues: z.record(z.number().int().nonnegative()),
    values: z.array(picklistValueSchema),
    totalValues: z.number().int().nonnegative(),
    returnedValues: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

const recordFieldContextSchema = z
  .object({
    apiName: z.string(),
    label: z.string(),
    dataType: z.string(),
    apiRequired: z.boolean(),
    layoutMember: z.boolean(),
    layoutRequired: z.boolean(),
    fieldCreateable: z.boolean(),
    fieldUpdateable: z.boolean(),
    layoutEditableForCreate: z.boolean().nullable(),
    layoutEditableForUpdate: z.boolean().nullable(),
    defaultValue: z.unknown().nullable(),
    defaultValueTruncated: z.boolean(),
    section: z.string().nullable(),
    layoutOrder: z.number().int().nonnegative().nullable(),
    relationshipName: z.string().nullable(),
    referenceTo: z.array(z.string()),
    picklist: picklistContextSchema.optional(),
    visibilityState: visibilityStateSchema.optional(),
    requiredSource: z.array(z.enum(['API', 'PAGE_LAYOUT', 'DYNAMIC_FORM'])).optional(),
    effectiveRequired: z.boolean().optional(),
    effectiveEditable: z.boolean().optional(),
    optionalCandidate: z.boolean().optional(),
    conditionalRequired: z.boolean().optional(),
    dependsOn: z.array(z.string()).optional(),
    sectionOrder: z.number().int().nonnegative().optional(),
    column: z.number().int().nonnegative().optional(),
  })
  .strict();

const recordTypeDescriptorSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    defaultForUser: z.boolean(),
    available: z.boolean(),
  })
  .strict();

export const recordActionContextOutputSchema = z
  .object({
    ...contextFailureFields,
    executionRole: z.literal('USER').optional(),
    objectApiName: z.string().optional(),
    action: z.enum(['CREATE', 'UPDATE']).optional(),
    recordId: z.string().optional(),
    recordType: recordTypeDescriptorSchema.optional(),
    availableRecordTypes: z.array(recordTypeDescriptorSchema).optional(),
    recordTypeSelectionRequired: z.boolean().optional(),
    uiContext: uiContextSchema.optional(),
    uiContextResolutionId: z.string().uuid().optional(),
    fields: z.array(recordFieldContextSchema).optional(),
    coverage: z
      .object({
        sources: z.array(z.enum(['UI_API_OBJECT_INFO', 'UI_API_LAYOUT', 'UI_API_CREATE_DEFAULTS', 'UI_API_RECORD', 'UI_API_PICKLIST_VALUES_BY_RECORD_TYPE'])),
        apiCallCount: z.number().int().nonnegative(),
        durationMs: z.number().int().nonnegative(),
        responseBytes: z.number().int().nonnegative(),
        totalVisibleFields: z.number().int().nonnegative(),
        returnedFields: z.number().int().nonnegative(),
        totalPicklistValues: z.number().int().nonnegative(),
        returnedPicklistValues: z.number().int().nonnegative(),
        truncated: z.boolean(),
        dynamicFormsEvaluated: z.boolean(),
        completeLightningPageEvaluated: z.literal(false),
        warnings: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

export const recordDisplayContextInputSchema = z
  .object({
    objectApiName: objectApiNameSchema,
    recordTypeId: salesforceIdSchema.optional().describe('Optional currently available Salesforce Record Type ID whose View/Compact Layout display facts are requested.'),
  })
  .strict();

const recordDisplayNameFieldSchema = z
  .object({
    apiName: z.string(),
    label: z.string(),
    dataType: z.string(),
  })
  .strict();

const compactLayoutFieldSchema = z
  .object({
    apiName: z.string(),
    label: z.string(),
    dataType: z.string(),
    order: z.number().int().nonnegative(),
    readable: z.boolean(),
  })
  .strict();

const viewLayoutFieldSchema = z
  .object({
    apiName: z.string(),
    label: z.string(),
    dataType: z.string(),
    section: z.string().nullable(),
    layoutOrder: z.number().int().nonnegative(),
    readable: z.boolean(),
    referenceTo: z.array(z.string()),
    relationshipName: z.string().nullable(),
  })
  .strict();

export const recordDisplayContextOutputSchema = z
  .object({
    ...contextFailureFields,
    executionRole: z.literal('USER').optional(),
    objectApiName: z.string().optional(),
    objectLabel: z.string().optional(),
    objectLabelPlural: z.string().optional(),
    nameFields: z.array(recordDisplayNameFieldSchema).optional(),
    compactLayoutFields: z.array(compactLayoutFieldSchema).optional(),
    viewLayoutFields: z.array(viewLayoutFieldSchema).optional(),
    availableRecordTypes: z.array(recordTypeDescriptorSchema).optional(),
    selectedRecordType: recordTypeDescriptorSchema.nullable().optional(),
    coverage: z
      .object({
        sources: z.array(z.enum(['UI_API_OBJECT_INFO', 'UI_API_LAYOUT', 'UI_API_COMPACT_LAYOUT'])),
        apiCallCount: z.number().int().nonnegative(),
        durationMs: z.number().int().nonnegative(),
        responseBytes: z.number().int().nonnegative(),
        nameFieldSource: z.enum(['NAME_FIELD', 'NONE_DECLARED']),
        recordTypeResolved: z.boolean(),
        viewLayoutEvaluated: z.boolean(),
        compactLayoutEvaluated: z.boolean(),
        truncated: z.boolean(),
        dynamicFormsEvaluated: z.literal(false),
        completeLightningPageEvaluated: z.literal(false),
        warnings: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

export const diagnosticQueryOutputSchema = z
  .object({
    ...contextFailureFields,
    executionRole: z.literal('DIAGNOSTIC').optional(),
    api: z.literal('TOOLING').optional(),
    records: z.array(z.record(z.unknown())).optional(),
    totalSize: z.number().int().nonnegative().optional(),
    returnedRecords: z.number().int().nonnegative().optional(),
    done: z.boolean().optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

const metadataFileSchema = z
  .object({
    relativePath: z.string(),
    bytes: z.number().int().nonnegative(),
    returnedBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    content: z.string(),
  })
  .strict();

const metadataFileSummarySchema = z
  .object({
    relativePath: z.string(),
    bytes: z.number().int().nonnegative(),
    reason: z.enum(['FILE_LIMIT', 'TOTAL_BYTE_LIMIT', 'NON_UTF8', 'UNSUPPORTED_FILE_TYPE']),
  })
  .strict();

export const metadataContextOutputSchema = z
  .object({
    ...contextFailureFields,
    executionRole: z.literal('DIAGNOSTIC').optional(),
    metadataType: metadataTypeSchema.optional(),
    fullName: z.string().optional(),
    files: z.array(metadataFileSchema).optional(),
    omittedFiles: z.array(metadataFileSummarySchema).optional(),
    totalFiles: z.number().int().nonnegative().optional(),
    returnedFiles: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    returnedBytes: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    limits: z
      .object({
        maxReturnedFiles: z.number().int().positive(),
        maxFileBytes: z.number().int().positive(),
        maxTotalBytes: z.number().int().positive(),
        maxFileSummaries: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const orgLimitsInputSchema = z
  .object({
    verbose: z
      .boolean()
      .optional()
      .describe(
        'Set true to list every limit this org reports in the text answer; defaults to false, which '
        + 'prints only the five highlights. structuredContent.limits carries the full table either way, '
        + 'so this switch changes how much is readable at a glance and never what is available.',
      ),
  })
  .strict();

/**
 * The governor limits `get_org_limits` always reports, in the order the Tool documents them.
 *
 * These are this Tool's own slot names; each one is filled by looking up the org's key through
 * `ORG_LIMIT_HIGHLIGHT_ALIASES`, and the slot's `key` says which org key actually filled it. The
 * slots exist so that "the org does not meter this resource" is a reportable answer (`present:
 * false`) rather than a silence an Agent would read as "no limit".
 */
export const ORG_LIMIT_HIGHLIGHT_SLOTS = [
  'dailyApiRequests',
  'dailyBulkApiRequests',
  'dailyAsyncApexExecutions',
  'dataStorageMB',
  'fileStorageMB',
] as const;

export type OrgLimitHighlightSlot = (typeof ORG_LIMIT_HIGHLIGHT_SLOTS)[number];

/**
 * Candidate org keys per slot, most specific first.
 *
 * Only `dailyBulkApiRequests` genuinely needs the table: Salesforce renamed the Bulk allowance
 * between Bulk API 1.0 (`DailyBulkApiRequests`) and Bulk API 2.0 (`DailyBulkV2QueryJobs`), and an
 * org may report either. The other slots carry one documented name each and are listed here so the
 * lookup has a single shape instead of a special case.
 *
 * **Not verified against a live org.** When this Tool was written the limits resource had been
 * refused for every business identity this deployment can route (see
 * `docs/sfoa/P9_T3_LIVE_PROBE_FINDINGS.md` §1), so these names come from Salesforce's documentation
 * rather than from an observed payload. A miss is not a failure — the slot reports `present: false`
 * with a null key, which is itself the answer to whether this org meters that resource.
 */
export const ORG_LIMIT_HIGHLIGHT_ALIASES = Object.freeze({
  dailyApiRequests: Object.freeze(['DailyApiRequests']),
  dailyBulkApiRequests: Object.freeze(['DailyBulkApiRequests', 'DailyBulkV2QueryJobs']),
  dailyAsyncApexExecutions: Object.freeze(['DailyAsyncApexExecutions']),
  dataStorageMB: Object.freeze(['DataStorageMB']),
  fileStorageMB: Object.freeze(['FileStorageMB']),
}) satisfies Readonly<Record<OrgLimitHighlightSlot, readonly string[]>>;

/**
 * One governor limit, as this Tool reads it.
 *
 * `measured` is exactly `max !== null || remaining !== null`: it says whether the org reported a
 * number for this resource at all. It is kept as a field because it is what a quota pre-flight
 * branches on — an unmetered resource cannot be budgeted against, and a caller should not have to
 * re-derive that from two nulls.
 */
const orgLimitEntrySchema = z
  .object({
    max: z.number().nonnegative().nullable(),
    remaining: z.number().nonnegative().nullable(),
    used: z.number().nonnegative().nullable(),
    measured: z.boolean(),
  })
  .strict();

const orgLimitHighlightSchema = z
  .object({
    /** The org key that filled this slot, or null when the org does not report it. */
    key: z.string().nullable(),
    present: z.boolean(),
    max: z.number().nonnegative().nullable(),
    remaining: z.number().nonnegative().nullable(),
    used: z.number().nonnegative().nullable(),
  })
  .strict();

/**
 * The five slots are written out in full rather than generated from `ORG_LIMIT_HIGHLIGHT_SLOTS`,
 * because a generated `Record<string, …>` would lose exactly the guarantee that matters: that every
 * slot is present. Written this way, dropping one is a compile error, and a test pins the key set to
 * the slot list so the two cannot drift.
 */
const orgLimitHighlightsSchema = z
  .object({
    dailyApiRequests: orgLimitHighlightSchema,
    dailyBulkApiRequests: orgLimitHighlightSchema,
    dailyAsyncApexExecutions: orgLimitHighlightSchema,
    dataStorageMB: orgLimitHighlightSchema,
    fileStorageMB: orgLimitHighlightSchema,
  })
  .strict();

/**
 * `suggestion` and `salesforceErrorCode` are declared **only here**, not in `contextFailureFields`.
 *
 * Every other context Tool's failure answer is `{success, errorCode, message}` exactly, and its
 * output schema is `.strict()`, so leaving those two keys out of the shared shape keeps the older
 * Tools' error results byte-for-byte what they were. This Tool needs them because the refusal it
 * reports is an org configuration fact whose remedy the caller cannot invent.
 */
export const orgLimitsOutputSchema = z
  .object({
    ...contextFailureFields,
    /** The Salesforce error code behind a refusal, so the caller can tell the causes apart. */
    salesforceErrorCode: z.string().max(128).optional(),
    suggestion: z.string().max(2_000).optional(),
    executionRole: z.literal('DIAGNOSTIC').optional(),
    api: z.literal('REST').optional(),
    verbose: z.boolean().optional(),
    /** Every limit the org reported, keyed by the org's own key. Same content whatever `verbose` says. */
    limits: z.record(orgLimitEntrySchema).optional(),
    highlights: orgLimitHighlightsSchema.optional(),
    totalLimits: z.number().int().nonnegative().optional(),
    returnedLimits: z.number().int().nonnegative().optional(),
    /** Entries the org listed but reported no readable number for. */
    unreadableLimits: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    hint: z.string().max(1_000).optional(),
  })
  .strict();

export type OrgLimitEntry = z.infer<typeof orgLimitEntrySchema>;
export type OrgLimitHighlight = z.infer<typeof orgLimitHighlightSchema>;
export type OrgLimitHighlights = z.infer<typeof orgLimitHighlightsSchema>;
export type OrgLimitsInput = z.infer<typeof orgLimitsInputSchema>;
export type OrgLimitsOutput = z.infer<typeof orgLimitsOutputSchema>;

export type RecordActionContextInput = z.infer<typeof recordActionContextInputSchema>;
export type RecordActionContextOutput = z.infer<typeof recordActionContextOutputSchema>;
export type RecordDisplayContextInput = z.infer<typeof recordDisplayContextInputSchema>;
export type RecordDisplayContextOutput = z.infer<typeof recordDisplayContextOutputSchema>;
export type DiagnosticQueryInput = z.infer<typeof diagnosticQueryInputSchema>;
export type DiagnosticQueryEvidence = Readonly<{
  records: readonly Record<string, unknown>[];
  totalSize: number;
  returnedRecords: number;
  done?: boolean;
  truncated: boolean;
}>;
export type MetadataContextInput = z.infer<typeof metadataContextInputSchema>;
export type MetadataComponentContext = z.infer<typeof metadataContextOutputSchema>;
