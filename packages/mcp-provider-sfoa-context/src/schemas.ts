import { z } from 'zod';
import { DEBUG_LEVEL_TIER_NAMES, DEBUG_LEVEL_VALUES } from './debug-levels.js';
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

/** `DebugLevel` tiers `set_trace_flag` resolves or creates, by name only — the catalog is in `debug-levels.ts`. */
export const debugLevelTierSchema = z.enum(DEBUG_LEVEL_TIER_NAMES);
const debugLevelValueSchema = z.enum(DEBUG_LEVEL_VALUES);

/**
 * The ten levels of a `DebugLevel`, written out in full.
 *
 * Generated from `DEBUG_LEVEL_FIELDS` this would be a `Record<string, …>`, which loses the only
 * guarantee worth having: that all ten are present. Written out, dropping one is a compile error, and a
 * unit test pins the key set to the field list so the two cannot drift.
 */
const debugLevelLevelsSchema = z
  .object({
    ApexCode: debugLevelValueSchema,
    ApexProfiling: debugLevelValueSchema,
    Callout: debugLevelValueSchema,
    Database: debugLevelValueSchema,
    NBA: debugLevelValueSchema,
    System: debugLevelValueSchema,
    Validation: debugLevelValueSchema,
    Visualforce: debugLevelValueSchema,
    Wave: debugLevelValueSchema,
    Workflow: debugLevelValueSchema,
  })
  .strict();

/**
 * What a caller may trace, in this Tool's own words.
 *
 * The org's `TraceFlag.TracedEntityId` is one polymorphic field and `LogType` carries the kind, so the
 * mapping below is not a relabelling — it is the derivation. `CLASS_TRACING` and `DEVELOPER_LOG` are
 * the two values the T1 probe created successfully (one on an `ApexClass`, one on **another user**),
 * which is why they are the only two this Tool offers.
 */
export const TRACED_ENTITY_KINDS = Object.freeze(['USER', 'APEX_CLASS'] as const);
export const TRACE_FLAG_LOG_TYPES = Object.freeze(['DEVELOPER_LOG', 'CLASS_TRACING'] as const);
export const TRACED_ENTITY_LOG_TYPES: Readonly<Record<(typeof TRACED_ENTITY_KINDS)[number],
  (typeof TRACE_FLAG_LOG_TYPES)[number]>> = Object.freeze({
    USER: 'DEVELOPER_LOG',
    APEX_CLASS: 'CLASS_TRACING',
  });

export const TRACE_FLAG_MIN_DURATION_MINUTES = 1;
export const TRACE_FLAG_DEFAULT_DURATION_MINUTES = 30;
/** Hard cap, deliberately short: a trace flag is a write with an operational cost on a live org. */
export const TRACE_FLAG_MAX_DURATION_MINUTES = 60;

export const traceFlagInputSchema = z
  .object({
    tracedEntityKind: z
      .enum(TRACED_ENTITY_KINDS)
      .describe('What to trace: a USER (a developer-log flag) or an APEX_CLASS (a class-tracing flag).'),
    tracedEntityId: salesforceIdSchema.describe(
      'The 15- or 18-character Salesforce Id of the user or ApexClass to trace. Never a username or a class name.',
    ),
    durationMinutes: z
      .number()
      .int()
      .min(TRACE_FLAG_MIN_DURATION_MINUTES)
      .max(TRACE_FLAG_MAX_DURATION_MINUTES)
      .optional()
      .describe(
        `How long the trace should stay active, from now. Defaults to ${TRACE_FLAG_DEFAULT_DURATION_MINUTES} and `
        + `may not exceed ${TRACE_FLAG_MAX_DURATION_MINUTES}. A trace already active for this entity is never `
        + 'shortened, so asking for less than its remaining time leaves it as it is.',
      ),
    logLevel: debugLevelTierSchema
      .optional()
      .describe(
        `Which prebuilt DebugLevel to attach: ${DEBUG_LEVEL_TIER_NAMES.join(', ')}. Defaults to `
        + 'DEBUG. MINIMAL writes the smallest log and is the tier to use when a full log would be too large '
        + 'to read; PROFILING adds the Apex profiling counters that this org\'s only stored level samples at '
        + 'INFO instead.',
      ),
  })
  .strict();

const debugLogFailureFields = {
  salesforceErrorCode: z.string().max(128).optional(),
  suggestion: z.string().max(2_000).optional(),
  /** ADR-0029 §3: the deployment prerequisite behind a refusal, by identifier. */
  prerequisite: z.string().max(128).optional(),
};

export const traceFlagOutputSchema = z
  .object({
    ...contextFailureFields,
    ...debugLogFailureFields,
    executionRole: z.literal('DIAGNOSTIC').optional(),
    api: z.literal('TOOLING').optional(),
    traceFlagId: z.string().optional(),
    tracedEntityKind: z.enum(TRACED_ENTITY_KINDS).optional(),
    tracedEntityId: z.string().optional(),
    logType: z.enum(TRACE_FLAG_LOG_TYPES).optional(),
    debugLevelId: z.string().optional(),
    debugLevelDeveloperName: z.string().optional(),
    debugLevelTier: debugLevelTierSchema.optional(),
    /** True when this call created the level; false when an existing one was reused. */
    debugLevelCreated: z.boolean().optional(),
    /** The level's ten fields as the org reports them — for a reused level, as stored, not as intended. */
    debugLevelLevels: debugLevelLevelsSchema.optional(),
    startDate: z.string().optional(),
    expirationDate: z.string().optional(),
    /** What the flag expired at before this call, or null when there was no flag to replace. */
    previousExpirationDate: z.string().nullable().optional(),
    /** True when an existing flag for this entity was reused and extended rather than a new one created. */
    replacedExisting: z.boolean().optional(),
    requestedDurationMinutes: z.number().int().positive().optional(),
    /**
     * Whether a re-read of the row confirmed the reported expiration. The T1 probe's own cleanup once
     * reported success on a row that survived, so a write's answer is verified rather than trusted.
     */
    verified: z.boolean().optional(),
    hint: z.string().max(1_000).optional(),
  })
  .strict();

export const APEX_LOG_DEFAULT_TIME_WINDOW_MINUTES = 60;
export const APEX_LOG_MAX_TIME_WINDOW_MINUTES = 1_440;
export const APEX_LOG_DEFAULT_LIMIT = 20;
export const APEX_LOG_MAX_LIMIT = 100;

export const apexLogsInputSchema = z
  .object({
    timeWindowMinutes: z
      .number()
      .int()
      .min(1)
      .max(APEX_LOG_MAX_TIME_WINDOW_MINUTES)
      .optional()
      .describe(
        `How far back to look, from now. Defaults to ${APEX_LOG_DEFAULT_TIME_WINDOW_MINUTES} and may not exceed `
        + `${APEX_LOG_MAX_TIME_WINDOW_MINUTES} (24 hours).`,
      ),
    userId: salesforceIdSchema
      .optional()
      .describe('Only logs written by this Salesforce user. The user Id, never a username.'),
    /**
     * Deliberately **not** an enum, and the reason is measured rather than stylistic.
     *
     * `ApexLog.Status` is translated on this org: of 9 retained rows, `Status = 'Success'` matched 1 and
     * the localized literal matched 8 (`docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md` §1). A closed enum of
     * English values would therefore be a filter that silently drops most of its rows — the exact defect
     * the T2 section's revision note forbids. So the value is matched against what the org actually
     * stores, the answer reports the values it saw, and a mismatch is visible instead of quiet.
     */
    status: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Only logs whose Status equals this value exactly. Matched against the value this org stores, which '
        + 'may be localized — check structuredContent.observedStatuses for the values actually present. The '
        + 'filter narrows the rows this call already fetched; it does not widen the fetch.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(APEX_LOG_MAX_LIMIT)
      .optional()
      .describe(
        `How many of the most recent logs to return. Defaults to ${APEX_LOG_DEFAULT_LIMIT} and may not exceed `
        + `${APEX_LOG_MAX_LIMIT}.`,
      ),
  })
  .strict();

const apexLogEntrySchema = z
  .object({
    id: z.string(),
    logUserId: z.string().nullable(),
    /** `LogUser.Name` — the person whose transaction was logged, not the identity that read the row. */
    logUserName: z.string().nullable(),
    logUserUsername: z.string().nullable(),
    application: z.string().nullable(),
    operation: z.string().nullable(),
    /** As the org stores it, verbatim and untranslated by this Tool. */
    status: z.string().nullable(),
    durationMilliseconds: z.number().nonnegative().nullable(),
    logLength: z.number().nonnegative().nullable(),
    startTime: z.string().nullable(),
    lastModifiedDate: z.string().nullable(),
  })
  .strict();

const observedStatusSchema = z
  .object({
    status: z.string(),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const apexLogsOutputSchema = z
  .object({
    ...contextFailureFields,
    ...debugLogFailureFields,
    executionRole: z.literal('DIAGNOSTIC').optional(),
    api: z.literal('TOOLING').optional(),
    logs: z.array(apexLogEntrySchema).optional(),
    /** Every log in the window, not only the returned ones — null when the count could not be read. */
    totalCount: z.number().int().nonnegative().nullable().optional(),
    returnedCount: z.number().int().nonnegative().optional(),
    /** How many rows this call actually examined; the reach of the `status` filter. */
    scannedCount: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    timeWindowMinutes: z.number().int().positive().optional(),
    /** The oldest `LastModifiedDate` the query accepted, so the window is checkable rather than implied. */
    windowStartedAt: z.string().optional(),
    statusFilter: z.string().optional(),
    observedStatuses: z.array(observedStatusSchema).optional(),
    /**
     * A deployment prerequisite that bounds how this answer should be read, on a successful call.
     *
     * This is where ADR-0029 §2's `A-1` surfaces: cross-user `ApexLog` visibility was never established,
     * so a filtered query that returns nothing may be a permission boundary rather than a quiet org, and
     * the caller is told which. An empty list here is a result — §3 keeps the failure case for a source
     * that could not be read at all — but an *ambiguous* empty list still has to say so.
     */
    caveat: z.string().max(2_000).optional(),
    hint: z.string().max(1_000).optional(),
  })
  .strict();

export const DEBUG_LOG_BODY_DEFAULT_MAX_CHARACTERS = 60_000;
/**
 * A schema-level sanity bound, not the effective ceiling.
 *
 * The host applies the deployment's response-byte budget on top of this, so the body a caller actually
 * receives is the smaller of the two. The cap exists so a request cannot ask for an unbounded string;
 * the budget exists because the answer has to fit alongside everything else in one response.
 */
export const DEBUG_LOG_BODY_MAX_CHARACTERS = 120_000;

export const debugLogBodyInputSchema = z
  .object({
    logId: salesforceIdSchema.describe('The 15- or 18-character ApexLog Id, as returned by get_apex_logs.'),
    maxCharacters: z
      .number()
      .int()
      .min(1_000)
      .max(DEBUG_LOG_BODY_MAX_CHARACTERS)
      .optional()
      .describe(
        `Maximum characters of log text to return. Defaults to ${DEBUG_LOG_BODY_DEFAULT_MAX_CHARACTERS}; the `
        + 'server may return fewer to stay inside its response budget, and says so in truncated.',
      ),
  })
  .strict();

const apexLogStackFrameSchema = z
  .object({
    apexClass: z.string(),
    method: z.string().nullable(),
    lineNumber: z.number().int().nonnegative().nullable(),
    columnNumber: z.number().int().nonnegative().nullable(),
    raw: z.string(),
  })
  .strict();

const apexLogCategorySchema = z
  .object({
    token: z.string(),
    level: z.string(),
    /** The `DebugLevel` field this token configures, or null for a token this parser does not know. */
    field: z.string().nullable(),
  })
  .strict();

const apexLogHeaderSummarySchema = z
  .object({
    parseStatus: z.enum(['PARSED', 'NOT_A_LOG']),
    /** The version the log itself declares, which is not the org's. Null when nothing was parsed. */
    logApiVersion: z.string().nullable(),
    logApiVersionMajor: z.number().int().nonnegative().nullable(),
    /** False when the log's version is outside the measured set: parsed, but by an unmeasured format. */
    validated: z.boolean(),
    categories: z.array(apexLogCategorySchema),
    fatalError: z.string().nullable(),
    exceptionType: z.string().nullable(),
    exceptionMessage: z.string().nullable(),
    apexClass: z.string().nullable(),
    lineNumber: z.number().int().nonnegative().nullable(),
    columnNumber: z.number().int().nonnegative().nullable(),
    stackSummary: z.array(apexLogStackFrameSchema),
    thrownExceptions: z.array(z.string()),
    userDebugLineCount: z.number().int().nonnegative(),
    executionFinished: z.boolean(),
  })
  .strict();

export const debugLogBodyOutputSchema = z
  .object({
    ...contextFailureFields,
    ...debugLogFailureFields,
    executionRole: z.literal('DIAGNOSTIC').optional(),
    api: z.literal('TOOLING').optional(),
    logId: z.string().optional(),
    headerSummary: apexLogHeaderSummarySchema.optional(),
    /** The log text, from its start, cut to the returned length. Never reordered or rewritten. */
    body: z.string().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    returnedBytes: z.number().int().nonnegative().optional(),
    totalCharacters: z.number().int().nonnegative().optional(),
    returnedCharacters: z.number().int().nonnegative().optional(),
    maxCharacters: z.number().int().positive().optional(),
    truncated: z.boolean().optional(),
    logLength: z.number().nonnegative().nullable().optional(),
    lastModifiedDate: z.string().nullable().optional(),
    hint: z.string().max(1_000).optional(),
  })
  .strict();

export type TracedEntityKind = z.infer<typeof traceFlagInputSchema>['tracedEntityKind'];
export type TraceFlagInput = z.infer<typeof traceFlagInputSchema>;
export type TraceFlagOutput = z.infer<typeof traceFlagOutputSchema>;
export type ApexLogsInput = z.infer<typeof apexLogsInputSchema>;
export type ApexLogsOutput = z.infer<typeof apexLogsOutputSchema>;
export type ApexLogEntry = z.infer<typeof apexLogEntrySchema>;
export type DebugLogBodyInput = z.infer<typeof debugLogBodyInputSchema>;
export type DebugLogBodyOutput = z.infer<typeof debugLogBodyOutputSchema>;
export type DebugLogHeaderSummary = z.infer<typeof apexLogHeaderSummarySchema>;

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
