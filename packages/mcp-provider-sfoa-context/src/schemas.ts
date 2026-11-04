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
    fieldApiNames: z.array(objectApiNameSchema).min(1).max(50).optional()
      .describe('Optional task field projection to recover oversized client context. Keeps required/conditional fields and known controlling dependencies; coverage reports omitted and unresolved fields. Metadata only, never permission or mutation scope.'),
    picklistValueOffsets: z.record(objectApiNameSchema, z.number().int().min(0).max(100_000))
      .refine((value) => Object.keys(value).length <= 25, 'at most 25 Picklist pages per context')
      .optional().describe('Continue truncated Picklist candidates for the same object/action/Record Type. Field API name to exact nextValueOffset returned by context; no identity or value inference. Requested fields are prioritized within the existing response budget.'),
    draftFields: z.record(objectApiNameSchema, z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]))
      .refine((value) => Object.keys(value).length <= 200 && JSON.stringify(value).length <= 32768, 'draftFields exceeds its bound')
      .optional().describe('CREATE only: task draft values for conditional visibility, including faithful extraction and verified related values; USER_EXPLICIT is a draft-source tag, not proof of authorship or verification; missing differs from null, false, zero and empty string. Never persisted as UI metadata.'),
    refinement: z.number().int().min(0).max(3).optional().describe('CREATE only: Dynamic Context refinement number, 0 initially, at most 3. Stop asking for refinements at 3.'),
    includeRequiredness: z.boolean().optional().describe('Opt in to the additive coverage.requirednessSource and requiredChecklist projection. Default false preserves the legacy response. The projection never changes visibility, permissions or DML scope.'),
    includeValueAssessment: z.boolean().optional().describe('CREATE only, default false: assess the bounded draft against already loaded requiredness and raw Salesforce defaults, without additional Salesforce reads. Also includes requiredness facts. PROVIDED is not validation, ABSENT is not proof the user omitted a fact, and defaults/managed values are not writes. Keep final long DML values outside the bounded draft when necessary.'),
  }).strict();

export const recordActionContextInputSchema = recordActionContextInputObjectSchema.superRefine((input, context) => {
    if (input.action === 'UPDATE' && (input.draftFields !== undefined || input.refinement !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'draftFields and refinement are CREATE-only' });
    }
    if (input.action === 'UPDATE' && input.includeValueAssessment === true) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['includeValueAssessment'], message: 'includeValueAssessment is CREATE-only' });
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

/**
 * The Metadata API types both metadata Tools are allowed to name.
 *
 * This is the §0.3 red line as data, not as prose: the allowlist is hardcoded here and asserted by unit
 * test, so a type outside it is refused before a manifest is generated or a `listMetadata` call is made.
 * It is also why the two Tools can be DIAGNOSTIC without becoming a route into business data — Metadata
 * API payloads are component definitions, and a component definition never carries a record row.
 *
 * **P10-T4 widened this from 8 to 21 types, and the widening is per-type evidence rather than a guess.**
 * T0's probe measured three of them (`ValidationRule`, `NamedCredential`, `Profile`); the remaining 18 were
 * each measured on this deployment before being added, because "listMetadata works" is a per-type
 * authorization fact and not a property of the API. `ADR-0032` records what each type returned, and
 * `P10_T4_LIVE_EVIDENCE.md` holds the raw measurements. A type that this org does not serve is not in the
 * list: an allowlist entry that always fails would advertise a capability the deployment does not have.
 *
 * Two names from the prompt's list did not survive that measurement, and both are corrections rather than
 * omissions (ADR-0032 §8). `SharingRule` is `SharingRules` in the Metadata API: the singular name answers
 * `INVALID_TYPE: Unknown type` on this org, while `SharingRules` lists 210 components. `CustomSetting` is not
 * a Metadata API type at all — this org declares 204 types and that name is not among them — and the
 * capability it was meant to serve is already covered by `CustomObject`, which carries all 8 of this org's
 * custom settings.
 *
 * The order is grouped rather than alphabetical — code, configuration, rules, security, automation — so a
 * reader can see which family a type belongs to and which family a new entry would join.
 */
export const METADATA_CONTEXT_TYPES = [
  // Code and UI: the original eight, plus EmailTemplate.
  'CustomObject',
  'CustomField',
  'ValidationRule',
  'Flow',
  'ApexClass',
  'ApexTrigger',
  'Layout',
  'FlexiPage',
  'EmailTemplate',
  // Named configuration and secrets: what the org calls out to, and what it stores as data.
  'NamedCredential',
  'CustomMetadata',
  'QuickAction',
  'RecordType',
  // Rules that fire without a user pressing anything.
  'DuplicateRule',
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
  // Access shape and automation definitions.
  'SharingRules',
  'Workflow',
  'PermissionSet',
  'Profile',
] as const;

export const metadataTypeSchema = z.enum(METADATA_CONTEXT_TYPES);
/**
 * The exact component name, validated for safety rather than for shape.
 *
 * This was an ASCII-only whitelist until P10-T4, and that whitelist broke the pair it exists to serve:
 * `list_metadata_components` returns this org's component names verbatim, and T0 measured them to be
 * localized and URL-escaped (`风控负责`, `WRN业务员%2F业务主管%2F市场开发`), so the names the listing hands
 * back were exactly the names this schema refused — the hint's "pass it back verbatim" step could not run.
 *
 * The constraints the task actually names are kept: no traversal sequence, no filesystem separator, no
 * control character. **The name never becomes a path** — it is XML-escaped into a manifest written at a
 * fixed relative path, and every file read back is separately re-checked against the workspace root by
 * `assertWithin` — so the shape whitelist was never the security boundary and removing it relaxes no
 * safety property. `%2F` is deliberately *not* decoded to `/`: the separator refusal stays, so a decoded
 * name is refused rather than silently addressing a different component.
 *
 * `.trim()` is retained from the original contract. No real component name carries leading or trailing
 * whitespace, and trimming an argument cannot change which component is addressed.
 */
export const metadataFullNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !value.includes('..'), 'must not contain a path traversal sequence')
  .refine((value) => !/[\\/]/u.test(value), 'must not contain a filesystem separator')
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    'must not contain control characters',
  )
  .describe(
    'Exact Metadata API full name, byte-for-byte as a listing returned it. Component names in this org are '
    + 'localized and may be URL-escaped (`%2F` where the name contains a separator), and a decoded form '
    + 'addresses a different component, so pass the name back verbatim rather than retyping or decoding it. '
    + 'This is a component name, never a filesystem path.',
  );

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

/**
 * The extra fields a DIAGNOSTIC Tool's *error* result may carry. Declared beside `contextFailureFields`
 * rather than further down because every output schema that spreads them is `.strict()`, so a schema
 * missing one rejects the very error result the raiser was built to produce — `prerequisite` names the
 * ADR-0029 §3 prerequisite and only the diagnostic Tools raise it.
 */
const diagnosticFailureFields = {
  salesforceErrorCode: z.string().max(128).optional(),
  suggestion: z.string().max(2_000).optional(),
  /** ADR-0029 §3: the deployment prerequisite behind a refusal, by identifier. */
  prerequisite: z.string().max(128).optional(),
};

const requiredSourceSchema = z.enum(['API', 'PAGE_LAYOUT', 'DYNAMIC_FORM']);
const requirednessSourceSchema = z.enum([
  'EFFECTIVE_REQUIRED', 'PAGE_LAYOUT_REQUIRED', 'PAGE_LAYOUT_FALLBACK', 'UNRESOLVED',
]);
const requiredChecklistItemSchema = z
  .object({
    apiName: z.string(),
    label: z.string(),
    source: z.array(requiredSourceSchema),
    visibilityState: visibilityStateSchema.optional(),
    effectiveRequired: z.boolean(),
    layoutRequired: z.boolean(),
    writable: z.boolean(),
  })
  .strict();

export const createValueAssessmentSchema = z.object({
  coverage: z.enum(['COMPLETE', 'PARTIAL']),
  requirednessSource: requirednessSourceSchema,
  fields: z.array(z.object({
    apiName: z.string(),
    required: z.boolean().nullable(),
    status: z.enum(['PROVIDED', 'EMPTY', 'ABSENT', 'DEFAULT_AVAILABLE', 'MANAGED_ON_WRITE', 'UNKNOWN']),
    source: z.enum(['DRAFT', 'SALESFORCE_CREATE_DEFAULT', 'MANAGED_POLICY', 'NONE', 'UNKNOWN']),
    draftState: z.enum(['PROVIDED', 'EMPTY', 'ABSENT']),
    defaultPresent: z.boolean().nullable(),
    defaultState: z.enum(['VALUE', 'EMPTY', 'ABSENT', 'UNKNOWN']),
    managedStrategy: z.enum(['PLATFORM_IDENTITY', 'PLATFORM_IDENTITY_FALLBACK', 'AI_CREATED_MARKER']).optional(),
  }).strict()).max(400),
  warnings: z.array(z.string()),
}).strict();
export type CreateValueAssessment = z.infer<typeof createValueAssessmentSchema>;

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
    valueOffset: z.number().int().nonnegative().optional(),
    nextValueOffset: z.number().int().nonnegative().nullable().optional(),
    dependenciesTruncated: z.boolean().optional(),
  })
  .strict();

const recordFieldContextSchema = z
  .object({
    apiName: z.string(),
    label: z.string(),
    dataType: z.string(),
    inlineHelpText: z.string().nullable().optional(),
    length: z.number().int().nonnegative().nullable().optional(),
    precision: z.number().int().nonnegative().nullable().optional(),
    scale: z.number().int().nonnegative().nullable().optional(),
    inlineHelpTextTruncated: z.boolean().optional(),
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
    requiredSource: z.array(requiredSourceSchema).optional(),
    effectiveRequired: z.boolean().optional(),
    effectiveEditable: z.boolean().optional(),
    optionalCandidate: z.boolean().optional(),
    conditionalRequired: z.boolean().optional(),
    dependsOn: z.array(z.string()).optional(),
    sectionOrder: z.number().int().nonnegative().optional(),
    column: z.number().int().nonnegative().optional(),
  })
  .strict();

const fieldCatalogItemSchema = z
  .object({
    apiName: z.string(),
    label: z.string(),
    dataType: z.string(),
    section: z.string().nullable(),
    apiRequired: z.boolean(),
    layoutRequired: z.boolean(),
    effectiveRequired: z.boolean().optional(),
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
    objectLabel: z.string().optional(),
    action: z.enum(['CREATE', 'UPDATE']).optional(),
    recordId: z.string().optional(),
    recordType: recordTypeDescriptorSchema.optional(),
    availableRecordTypes: z.array(recordTypeDescriptorSchema).optional(),
    recordTypeSelectionRequired: z.boolean().optional(),
    uiContext: uiContextSchema.optional(),
    uiContextResolutionId: z.string().uuid().optional(),
    fields: z.array(recordFieldContextSchema).optional(),
    requiredChecklist: z.array(requiredChecklistItemSchema).optional(),
    valueAssessment: createValueAssessmentSchema.optional(),
    coverage: z
      .object({
        sources: z.array(z.enum(['UI_API_OBJECT_INFO', 'UI_API_LAYOUT', 'UI_API_CREATE_DEFAULTS', 'UI_API_RECORD', 'UI_API_PICKLIST_VALUES_BY_RECORD_TYPE'])),
        apiCallCount: z.number().int().nonnegative(),
        durationMs: z.number().int().nonnegative(),
        responseBytes: z.number().int().nonnegative(),
        totalVisibleFields: z.number().int().nonnegative(),
        returnedFields: z.number().int().nonnegative(),
        fieldProjection: z.object({
          requestedFieldApiNames: z.array(z.string()),
          omittedFields: z.number().int().nonnegative(),
          omittedFieldCatalog: z.array(fieldCatalogItemSchema).max(100).optional(),
          unresolvedFieldApiNames: z.array(z.string()),
        }).strict().optional(),
        totalPicklistValues: z.number().int().nonnegative(),
        returnedPicklistValues: z.number().int().nonnegative(),
        truncated: z.boolean(),
        dynamicFormsEvaluated: z.boolean(),
        requirednessSource: requirednessSourceSchema.optional(),
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

/**
 * The listing half of the metadata pair: `list_metadata_components` answers "which components of this type
 * exist", and `get_metadata_component_context` answers "what does this one contain". The split is the same
 * one P9 established for `list_sobjects` / `describe_sobject`, and it is deliberate — a listing whose every
 * entry also carried the component's definition would be a listing no budget could bound.
 *
 * The component entry is **per-type optional by measurement, not by defensiveness**. T0's probe found
 * `ValidationRule` and `NamedCredential` entries carrying `lastModifiedByName`, `fileName` and
 * `manageableState` while `Profile` entries carried no `manageableState` — so a schema declaring
 * `manageableState` required would fail on a type the allowlist is required to serve. `ADR-0032` records
 * which types carry which fields on this deployment; the schema stays permissive because that measurement
 * is a property of this org at this API version, and a stricter schema would turn a future org's extra
 * field into a contract violation rather than a fact to report.
 */
export const METADATA_LIST_DEFAULT_LIMIT = 50;
export const METADATA_LIST_MAX_LIMIT = 200;

/**
 * The filter is matched against component names that are **localized and URL-escaped** (`风控负责`,
 * `WRN业务员%2F业务主管%2F市场开发`), so it cannot reuse `metadataFullNameSchema`'s ASCII-only pattern: that
 * pattern would refuse every prefix a Chinese-language org's profile names would need.
 *
 * It is therefore validated for safety rather than for shape — no control characters, no traversal
 * sequence — and never for the characters a legitimate component name may contain. The value is also only
 * ever a local filter: it is never interpolated into a manifest, a path, or a query.
 */
export const metadataNamePrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !value.includes('..'), 'must not contain a path traversal sequence')
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    'must not contain control characters',
  )
  .describe(
    'Case-sensitive prefix matched against component full names. Component names are localized and may be '
    + 'URL-escaped in this org, so match the exact text a previous listing returned rather than a decoded form.',
  );

export const metadataListInputSchema = z
  .object({
    metadataType: metadataTypeSchema.describe('Allowlisted diagnostic Metadata API type to enumerate.'),
    developerNamePrefix: metadataNamePrefixSchema.optional(),
    includeInactive: z
      .boolean()
      .optional()
      .describe(
        'Set true to keep components the listing marks as not active. Defaults to false, and the effective '
        + 'value is echoed in the response, because a listing narrowed by a default the caller did not choose '
        + 'is the silent-short-list failure this Toolset exists to avoid.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(METADATA_LIST_MAX_LIMIT)
      .optional()
      .describe(`Maximum components to return. Defaults to ${METADATA_LIST_DEFAULT_LIMIT}, maximum ${METADATA_LIST_MAX_LIMIT}.`),
  })
  .strict();

const metadataListComponentSchema = z
  .object({
    // Returned byte-for-byte as the listing produced it. A caller that passes a decoded form back to
    // `get_metadata_component_context` addresses a different component, so nothing here normalizes it.
    fullName: z.string(),
    manageableState: z.string().optional(),
    lastModifiedBy: z.string().optional(),
    lastModifiedDate: z.string().optional(),
    fileName: z.string().optional(),
  })
  .strict();

export const metadataListOutputSchema = z
  .object({
    ...contextFailureFields,
    ...diagnosticFailureFields,
    executionRole: z.literal('DIAGNOSTIC').optional(),
    metadataType: metadataTypeSchema.optional(),
    components: z.array(metadataListComponentSchema).optional(),
    totalCount: z.number().int().nonnegative().optional(),
    returnedCount: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    hint: z.string().max(1_000).optional(),
    // Echoed so the counts above are interpretable: `totalCount` is the count *after* these two filters,
    // and a caller who reads it without them would take a narrowed listing for the whole org.
    includeInactive: z.boolean().optional(),
    developerNamePrefix: z.string().optional(),
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

export const traceFlagOutputSchema = z
  .object({
    ...contextFailureFields,
    ...diagnosticFailureFields,
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
    ...diagnosticFailureFields,
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
    ...diagnosticFailureFields,
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

/**
 * The field-name grammar, shared by every input that names a field rather than an object.
 *
 * A field API name is the same shape as an object API name and carries the same prohibition: a
 * relationship path (`Owner.Name`) is a different thing from a field and would address a different
 * column in `FieldPermissions`, so it is refused at the schema boundary rather than quietly returning
 * nothing.
 */
const fieldApiNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(apiNamePattern, 'must be a Salesforce field API name without a relationship path');

/** The tool's hard input bound. `fields × grants` grows as the product, and the budget is per response. */
export const EXPLAIN_FIELD_ACCESS_MAX_FIELDS = 10;

/**
 * The third state of `conclusion.visible` / `conclusion.editable`.
 *
 * A string rather than a sentinel boolean, because "the layer that would have decided this could not
 * be read" is not a value of the same type as an answer — and ADR-0029 §3 forbids collapsing it into
 * `false`. Consumers must compare with `=== true` / `=== false`: the string is truthy, which is the one
 * trap this shape carries and the reason the text renderer and the conclusion builder are both asserted
 * against it.
 */
export const FIELD_ACCESS_INDETERMINATE = 'INDETERMINATE';

/**
 * The two kinds of owner a field-level grant can have.
 *
 * `Profile` is not a third kind: a profile's field permissions are stored on the permission set
 * Salesforce creates for it, so a profile grant is a `PERMISSION_SET` grant with
 * `isOwnedByProfile: true` and a profile name attached. The distinction is kept in the output because
 * an administrator changes the two in different places in Setup.
 */
export const FIELD_ACCESS_PARENT_TYPES = Object.freeze(['PERMISSION_SET', 'PROFILE'] as const);

export const EXPLAIN_FIELD_ACCESS_DEFAULT_RECORD_TYPE_CONTEXT = true;

export const explainFieldAccessInputSchema = z
  .object({
    objectApiName: objectApiNameSchema,
    fieldApiNames: z
      .array(fieldApiNameSchema)
      .min(1)
      .max(EXPLAIN_FIELD_ACCESS_MAX_FIELDS)
      .describe(
        `One to ${EXPLAIN_FIELD_ACCESS_MAX_FIELDS} field API names on that object, for example Name or `
        + 'SomeField__c. Never a relationship path and never a field value: the names are used as keys into the '
        + 'org\'s permission configuration and nothing is read from the fields themselves. Repeating a name is '
        + 'harmless — the set is deduplicated — but the bound applies to the list as sent.',
      )
      .transform((values) => [...new Set(values)]),
    targetUserId: salesforceIdSchema.optional().describe(
      'Whose access to explain, as a 15- or 18-character Salesforce User Id. Omit it to explain the requesting '
      + 'user\'s own access. Only users this deployment has configured as identity routes may be named; any other '
      + 'Id is refused, because a diagnostic Tool that accepted an arbitrary user Id would be an account-access '
      + 'reconnaissance surface.',
    ),
    includeRecordTypeContext: z.boolean().optional().describe(
      `Whether to report the object's record types alongside the field grants. Defaults to `
      + `${EXPLAIN_FIELD_ACCESS_DEFAULT_RECORD_TYPE_CONTEXT}.`,
    ),
  })
  .strict();

const fieldAccessGrantSchema = z
  .object({
    parentType: z.enum(FIELD_ACCESS_PARENT_TYPES),
    parentId: z.string(),
    /** The permission set's API name — the stable key, and the one to quote back for a follow-up. */
    parentName: z.string().nullable(),
    /** The label as this org stores it, which may be translated. Reported, never matched on. */
    parentLabel: z.string().nullable(),
    permissionsRead: z.boolean(),
    permissionsEdit: z.boolean(),
  })
  .strict();

const fieldAccessDescribeFactsSchema = z
  .object({
    type: z.string().nullable(),
    label: z.string().nullable(),
    createable: z.boolean().nullable(),
    updateable: z.boolean().nullable(),
    accessible: z.boolean().nullable(),
    /**
     * Always true, and the flag exists so it cannot be forgotten.
     *
     * `describe` answers for the identity that called it, and the identity that calls this Tool is the
     * deployment's fixed DIAGNOSTIC account. These facts are therefore that account's own field-level
     * security and can never stand in for `targetUserId`'s — the probe measured this on a real org
     * (`docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md` §6) and named it the specific correctness trap this Tool
     * has to avoid. They are returned because the caller asked about the field, never because they decide
     * the conclusion.
     */
    executionIdentityView: z.literal(true),
  })
  .strict();

const fieldAccessPermissionSetSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    label: z.string().nullable(),
    isOwnedByProfile: z.boolean(),
    profileName: z.string().nullable(),
  })
  .strict();

const fieldAccessObjectAccessSchema = z
  .object({
    read: z.boolean().nullable(),
    edit: z.boolean().nullable(),
    viewAllRecords: z.boolean().nullable(),
    /**
     * The subject's permission sets that had no readable `ObjectPermissions` row.
     *
     * An object-level denial is only a denial if the row was read; a parent listed here is a gap, and
     * the conclusion that depends on it is `INDETERMINATE` rather than `false` (ADR-0029 §3).
     */
    unreadableParentIds: z.array(z.string()),
  })
  .strict();

const fieldAccessUserContextSchema = z
  .object({
    userId: z.string(),
    username: z.string().nullable(),
    userName: z.string().nullable(),
    isActive: z.boolean().nullable(),
    /** True when the subject is the requesting user rather than a named `targetUserId`. */
    isRequestingUser: z.boolean(),
    permissionSets: z.array(fieldAccessPermissionSetSchema),
    permissionSetsTruncated: z.boolean(),
    objectAccess: fieldAccessObjectAccessSchema.nullable(),
  })
  .strict();

const fieldAccessRecordTypeContextSchema = z
  .object({
    recordTypes: z
      .array(
        z
          .object({
            id: z.string(),
            developerName: z.string().nullable(),
            name: z.string().nullable(),
            isActive: z.boolean().nullable(),
          })
          .strict(),
      ),
    truncated: z.boolean(),
    /** The record type Ids the executing identity's own describe reports as available to it. */
    availableToExecutionIdentity: z.array(z.string()),
    /**
     * Always `INDETERMINATE`, never `false`.
     *
     * Per-user record-type availability is a Profile/Layout metadata fact, and the diagnostic whitelist
     * carries the `RecordType` object rather than the profile metadata that decides availability. So the
     * object's record types are reported as facts and their availability to the subject is reported as a
     * gap; answering `false` would read a layer that was never read as a denial, which is the failure
     * ADR-0029 §3 exists to prevent.
     */
    availableToSubject: z.literal(FIELD_ACCESS_INDETERMINATE),
    caveat: z.string(),
  })
  .strict();

const fieldAccessConclusionSchema = z
  .object({
    visible: z.union([z.boolean(), z.literal(FIELD_ACCESS_INDETERMINATE)]),
    editable: z.union([z.boolean(), z.literal(FIELD_ACCESS_INDETERMINATE)]),
    /** The ordered facts the conclusion was derived from, each naming its layer. */
    sourceChain: z.array(z.string()),
    /** Where two layers disagree about the same field. */
    conflicts: z.array(z.string()),
    /** What this conclusion does not establish. */
    caveats: z.array(z.string()),
  })
  .strict();

const fieldAccessExplanationSchema = z
  .object({
    fieldApiName: z.string(),
    describeFacts: fieldAccessDescribeFactsSchema.nullable(),
    grants: z.array(fieldAccessGrantSchema),
    /** True when this field's grants were cut to fit the response budget. */
    grantsTruncated: z.boolean(),
    conclusion: fieldAccessConclusionSchema,
  })
  .strict();

export const explainFieldAccessOutputSchema = z
  .object({
    ...contextFailureFields,
    ...diagnosticFailureFields,
    executionRole: z.literal('DIAGNOSTIC').optional(),
    /** The standard API, not Tooling: every permission table read here is a standard-API query. */
    api: z.literal('STANDARD').optional(),
    objectApiName: z.string().optional(),
    objectLabel: z.string().nullable().optional(),
    requestedFieldCount: z.number().int().nonnegative().optional(),
    returnedFieldCount: z.number().int().nonnegative().optional(),
    /**
     * The subject of the whole call — one user for every field by construction.
     *
     * Carried once at the top level rather than inside each field entry, because it is a property of the
     * request (one object, one subject) and not of a field: repeating a permission-set list ten times
     * would spend the response budget restating the same facts, which is exactly the shape the
     * truncation contract exists to avoid.
     */
    userContext: fieldAccessUserContextSchema.optional(),
    recordTypeContext: fieldAccessRecordTypeContextSchema.optional(),
    fields: z.array(fieldAccessExplanationSchema).optional(),
    truncated: z.boolean().optional(),
    hint: z.string().max(1_000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// get_platform_diagnostics (T5): three platform sources, one window, one merged timeline.
// ---------------------------------------------------------------------------------------------

/**
 * The three sections, in the order the Tool reads and reports them.
 *
 * The order is fixed rather than the caller's: two readouts of the same incident have to be comparable,
 * and a caller that asks for `['SCHEDULED_JOBS','SETUP_CHANGES']` must not get a differently-ordered
 * payload from one that asks for the reverse. The input schema below normalizes the caller's order and
 * repetitions away, and the output's `sections` object always carries this order.
 */
export const PLATFORM_DIAGNOSTIC_SECTIONS = Object.freeze([
  'SETUP_CHANGES',
  'ASYNC_FAILURES',
  'SCHEDULED_JOBS',
] as const);

export type PlatformDiagnosticSection = (typeof PLATFORM_DIAGNOSTIC_SECTIONS)[number];

/** The window default, and the hard bounds. 168 hours is the prompt's hard maximum (one week). */
export const PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS = 24;
export const PLATFORM_DIAGNOSTICS_MIN_WINDOW_HOURS = 1;
export const PLATFORM_DIAGNOSTICS_MAX_WINDOW_HOURS = 168;

/** Per-section entry default and hard maximum. The bound is per section; three sections share one budget. */
export const PLATFORM_DIAGNOSTICS_DEFAULT_LIMIT_PER_SECTION = 25;
export const PLATFORM_DIAGNOSTICS_MAX_LIMIT_PER_SECTION = 100;

/**
 * The character budget for the rendered text, this Tool's own copy of the P9 Data Tools' budget.
 *
 * The dual budget is the same idea as everywhere else in this runtime: the structured payload is bounded
 * in bytes (`DATA_MAX_RESPONSE_BYTES`, applied by the host executor) and the text an Agent actually reads
 * is bounded in characters. The number is 60 000 for the same reason `DATA_MAX_QUERY_TEXT_CHARACTERS` is:
 * it is a context budget, not a transport one.
 */
export const PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS = 60_000;

/**
 * The per-section state ADR-0029 §3 requires of an aggregating Tool.
 *
 * `UNAVAILABLE` is not a synonym for "no rows": it means the source could not be read, and the section
 * then carries the prerequisite identifier and the reason instead of a count. A genuinely empty source is
 * `READ` with `totalCount: 0` — the distinction the `CronTrigger` measurement (`P10_T0_LIVE_PROBE_FINDINGS`
 * §5: 0 rows on this org) made the reason for this shape.
 */
export const PLATFORM_DIAGNOSTIC_SECTION_STATES = Object.freeze(['READ', 'UNAVAILABLE'] as const);

/**
 * The three states of the conservative stall assessment — never a boolean.
 *
 * A scheduled job is *suspected* stalled when the platform's own state and clock say so under the
 * documented rule (ADR-0033), *not* suspected when the platform reports it as running or complete, and
 * `INDETERMINATE` when the rule cannot be applied at all — an unrecognized `State` literal (the
 * vocabulary was not measurable on the reference org, which holds no `CronTrigger` rows), a missing
 * `NextFireTime`, or an unparseable timestamp. The third state is not a hedge: it is what keeps a
 * vocabulary this Tool does not recognize from being read as "healthy".
 */
export const SCHEDULED_JOB_STALL_ASSESSMENTS = Object.freeze([
  'SUSPECTED',
  'NOT_SUSPECTED',
  'INDETERMINATE',
] as const);

export const platformDiagnosticsInputSchema = z
  .object({
    windowHours: z
      .number()
      .int()
      .min(PLATFORM_DIAGNOSTICS_MIN_WINDOW_HOURS)
      .max(PLATFORM_DIAGNOSTICS_MAX_WINDOW_HOURS)
      .optional()
      .describe(
        `How far back the change and failure sections are read, in hours. Defaults to `
        + `${PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS}; the hard bounds are `
        + `${PLATFORM_DIAGNOSTICS_MIN_WINDOW_HOURS} to ${PLATFORM_DIAGNOSTICS_MAX_WINDOW_HOURS} (one week). `
        + 'The window ends at the moment of the call. It bounds SETUP_CHANGES and ASYNC_FAILURES by their '
        + 'creation time; SCHEDULED_JOBS is the org\'s current scheduling state rather than a history, and enters '
        + 'the timeline at each job\'s last fire time, so a window cannot make it report a *past* stall.',
      ),
    sections: z
      .array(z.enum(PLATFORM_DIAGNOSTIC_SECTIONS))
      .min(1)
      // No `.max()`: the bound is enforced by the transform below rather than by the array's length, because
      // a caller that repeats a section has asked for three sections or fewer and should be normalized
      // rather than refused. A `.max()` here would count the *repeats*, so `['A','A','B']` would be refused
      // for asking for three sections while `['A','B']` was accepted — a refusal that teaches nothing.
      .optional()
      .describe(
        'Which evidence sections to read. Defaults to all three. SETUP_CHANGES is the setup audit trail (who '
        + 'changed what), ASYNC_FAILURES the failed and aborted asynchronous jobs, SCHEDULED_JOBS the scheduled '
        + 'jobs with a conservative suspected-stall assessment. Repeats are dropped and the reported order is '
        + 'fixed, so the same set of sections always produces the same payload shape.',
      )
      .transform((values) => values === undefined
        ? undefined
        : PLATFORM_DIAGNOSTIC_SECTIONS.filter((section) => values.includes(section))),
    limitPerSection: z
      .number()
      .int()
      .min(1)
      .max(PLATFORM_DIAGNOSTICS_MAX_LIMIT_PER_SECTION)
      .optional()
      .describe(
        `The most entries one section may return. Defaults to ${PLATFORM_DIAGNOSTICS_DEFAULT_LIMIT_PER_SECTION}, `
        + `hard maximum ${PLATFORM_DIAGNOSTICS_MAX_LIMIT_PER_SECTION}. Each section reports its own total count and `
        + 'whether it was cut, and the three sections together share one response budget, so entries can be '
        + 'trimmed below this number when the payload would otherwise not fit.',
      ),
  })
  .strict();

const platformDiagnosticWindowSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    hours: z.number().int().positive(),
  })
  .strict();

/**
 * The shared status header of every section.
 *
 * `totalCount` is nullable and `null` on `UNAVAILABLE`, never 0: this is the one place where a wrong type
 * would defeat the whole contract, because a consumer that reads `totalCount === 0` as "there were none"
 * would turn an unreadable source back into a silent empty result.
 */
const platformDiagnosticSectionStatusFields = {
  status: z.enum(PLATFORM_DIAGNOSTIC_SECTION_STATES),
  totalCount: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  /** Present only on `UNAVAILABLE`: the prerequisite identifier ADR-0029 §3 requires. */
  prerequisite: z.string().max(128).optional(),
  errorCode: z.string().max(128).optional(),
  /** Present only on `UNAVAILABLE`: the human-readable reason, safe to show an operator. */
  unavailableReason: z.string().max(2_000).optional(),
  /** Facts a reader needs and must not infer — dropped fields, vocabulary findings, an unreadable bound. */
  caveats: z.array(z.string()),
};

const setupChangeEntrySchema = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    /**
     * The `SetupAuditTrail.Action` API enum — a stable English literal such as `changedApexClass`.
     *
     * Returned as a fact and matched only inside the query. `section` and `display` below are the org's
     * localized labels; they are reported because a reader wants them and are never compared against
     * anything, because `Section` is not even filterable on this object (measured: `INVALID_FIELD`).
     */
    action: z.string().nullable(),
    section: z.string().nullable(),
    display: z.string().nullable(),
    createdBy: z.string().nullable(),
    delegateUser: z.string().nullable(),
  })
  .strict();

const setupChangesSectionSchema = z
  .object({
    ...platformDiagnosticSectionStatusFields,
    section: z.literal('SETUP_CHANGES'),
    entries: z.array(setupChangeEntrySchema),
    /**
     * The oldest row this org still retains, read with a bounded query.
     *
     * Salesforce does not expose `SetupAuditTrail` retention to SOQL, so this is the only honest bound on
     * how far back the trail reaches. `null` when the bound itself could not be read — the section still
     * answers, the bound is missing, and the caveat says so.
     */
    oldestRetainedAt: z.string().nullable(),
  })
  .strict();

const asyncFailureEntrySchema = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    status: z.string().nullable(),
    jobType: z.string().nullable(),
    apexClass: z.string().nullable(),
    numberOfErrors: z.number().int().nonnegative().nullable(),
    extendedStatus: z.string().nullable(),
  })
  .strict();

const asyncFailuresSectionSchema = z
  .object({
    ...platformDiagnosticSectionStatusFields,
    section: z.literal('ASYNC_FAILURES'),
    entries: z.array(asyncFailureEntrySchema),
    /**
     * The status literals this org's `AsyncApexJob` table actually holds, with their counts.
     *
     * Present so a zero-entry answer is *evidenced* rather than silent: the section filters on the API
     * literals `Failed` and `Aborted`, and this is the readout that shows the filter ran against a real,
     * readable table. `null` when the vocabulary read failed — and a failed vocabulary read next to zero
     * entries is exactly the combination that makes the section `UNAVAILABLE` instead, because then
     * nothing establishes that the zero is a fact.
     */
    observedStatusCounts: z.record(z.number().int().nonnegative()).nullable(),
  })
  .strict();

const scheduledJobEntrySchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    jobType: z.string().nullable(),
    state: z.string().nullable(),
    nextFireTime: z.string().nullable(),
    previousFireTime: z.string().nullable(),
    timesTriggered: z.number().int().nonnegative().nullable(),
    /** ADR-0033's conservative rule. `SUSPECTED` is a flag to investigate, never a diagnosis. */
    stallAssessment: z.enum(SCHEDULED_JOB_STALL_ASSESSMENTS),
    stallReasons: z.array(z.string()),
  })
  .strict();

const scheduledJobsSectionSchema = z
  .object({
    ...platformDiagnosticSectionStatusFields,
    section: z.literal('SCHEDULED_JOBS'),
    entries: z.array(scheduledJobEntrySchema),
    suspectedStallCount: z.number().int().nonnegative().nullable(),
  })
  .strict();

const platformDiagnosticTimelineEntrySchema = z
  .object({
    occurredAt: z.string(),
    section: z.enum(PLATFORM_DIAGNOSTIC_SECTIONS),
    entryId: z.string(),
    /** One line: what happened, in the section's own vocabulary. Deliberately short — see the budget note. */
    summary: z.string(),
  })
  .strict();

const platformDiagnosticAlignmentSchema = z
  .object({
    timeline: z.array(platformDiagnosticTimelineEntrySchema),
    /** What the merge does and does not establish — including whether a section is missing from it. */
    note: z.string(),
  })
  .strict();

export const platformDiagnosticsOutputSchema = z
  .object({
    ...contextFailureFields,
    ...diagnosticFailureFields,
    executionRole: z.literal('DIAGNOSTIC').optional(),
    /** The standard API: all three sources are standard-API reads. */
    api: z.literal('STANDARD').optional(),
    window: platformDiagnosticWindowSchema.optional(),
    sections: z
      .object({
        setupChanges: setupChangesSectionSchema.optional(),
        asyncFailures: asyncFailuresSectionSchema.optional(),
        scheduledJobs: scheduledJobsSectionSchema.optional(),
      })
      .strict()
      .optional(),
    alignment: platformDiagnosticAlignmentSchema.optional(),
    /** How many of the requested sections were read — the count a reader must not have to recompute. */
    readSectionCount: z.number().int().nonnegative().optional(),
    unavailableSectionCount: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
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
export type ExplainFieldAccessInput = z.infer<typeof explainFieldAccessInputSchema>;
export type ExplainFieldAccessOutput = z.infer<typeof explainFieldAccessOutputSchema>;
export type FieldAccessExplanation = z.infer<typeof fieldAccessExplanationSchema>;
export type FieldAccessGrant = z.infer<typeof fieldAccessGrantSchema>;
export type FieldAccessConclusion = z.infer<typeof fieldAccessConclusionSchema>;
export type FieldAccessUserContext = z.infer<typeof fieldAccessUserContextSchema>;
export type FieldAccessRecordTypeContext = z.infer<typeof fieldAccessRecordTypeContextSchema>;
export type FieldAccessParentType = (typeof FIELD_ACCESS_PARENT_TYPES)[number];

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
export type MetadataListInput = z.infer<typeof metadataListInputSchema>;
export type MetadataListOutput = z.infer<typeof metadataListOutputSchema>;
export type MetadataListComponent = z.infer<typeof metadataListComponentSchema>;
export type PlatformDiagnosticsInput = z.infer<typeof platformDiagnosticsInputSchema>;
export type PlatformDiagnosticsOutput = z.infer<typeof platformDiagnosticsOutputSchema>;
export type PlatformDiagnosticSectionState = (typeof PLATFORM_DIAGNOSTIC_SECTION_STATES)[number];
export type ScheduledJobStallAssessment = (typeof SCHEDULED_JOB_STALL_ASSESSMENTS)[number];
export type SetupChangesSection = z.infer<typeof setupChangesSectionSchema>;
export type AsyncFailuresSection = z.infer<typeof asyncFailuresSectionSchema>;
export type ScheduledJobsSection = z.infer<typeof scheduledJobsSectionSchema>;
export type SetupChangeEntry = z.infer<typeof setupChangeEntrySchema>;
export type AsyncFailureEntry = z.infer<typeof asyncFailureEntrySchema>;
export type ScheduledJobEntry = z.infer<typeof scheduledJobEntrySchema>;
export type PlatformDiagnosticTimelineEntry = z.infer<typeof platformDiagnosticTimelineEntrySchema>;
