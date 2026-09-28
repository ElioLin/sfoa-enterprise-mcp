import { z } from 'zod';
import { inspectSoqlQuery } from './soql.js';
import {
  SOSL_LIMIT_SOURCES,
  SOSL_MAX_STATEMENT_LENGTH,
  SOSL_MODES,
  SEARCH_RECORDS_DEFAULT_FIELDS,
  planSoslSearch,
} from './sosl.js';

const apiNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/u;

/**
 * Salesforce object API names are always a single identifier: no dots, no relationship
 * paths, no brackets. Rejecting a traversal-shaped value here keeps a bad name from
 * ever reaching a Salesforce route or a query string.
 */
export const objectApiNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(apiNamePattern, 'must be a Salesforce object API name without a relationship path')
  .describe('Salesforce object API name, for example Account or SomeObject__c.');

/**
 * Field API names are held to the object rule and for the same reason, with one addition: a
 * relationship path is not accepted. SOSL returns an object's own fields, so `Account.Name` in a
 * field list is a shape the platform rejects — an Agent that wants a parent's field reads it with
 * `query_records`, which is where relationship traversal belongs.
 */
export const fieldApiNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(apiNamePattern, 'must be a Salesforce field API name without a relationship path')
  .describe('Salesforce field API name of the searched object itself, for example Id or Name.');

export const LIST_SOBJECTS_DEFAULT_LIMIT = 50;
export const LIST_SOBJECTS_MAX_LIMIT = 200;
export const DESCRIBE_SOBJECT_DEFAULT_FIELD_LIMIT = 200;
export const DESCRIBE_SOBJECT_MAX_FIELD_LIMIT = 1_000;
export const DESCRIBE_SOBJECT_MAX_CHILD_RELATIONSHIPS = 50;
export const DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES = 100;
export const QUERY_RECORDS_DEFAULT_MAX_ROWS = 2_000;
export const QUERY_RECORDS_MAX_MAX_ROWS = 50_000;
export const QUERY_RECORDS_MAX_QUERY_LENGTH = 20_000;
/**
 * Wall-clock budget for the *continuation* loop, not for the first batch: the first batch is
 * bound by the host Tool deadline, and re-deciding that here would only duplicate it. Once
 * the Tool is paging, this stops a long tail of small batches from consuming the whole
 * request; reaching it truncates the result in place and says so rather than failing.
 */
export const QUERY_RECORDS_TIME_BUDGET_MS = 60_000;

export const SEARCH_RECORDS_DEFAULT_LIMIT = 20;
export const SEARCH_RECORDS_MAX_LIMIT = 200;
export const SEARCH_RECORDS_MAX_SEARCH_LENGTH = 2_000;
export const SEARCH_RECORDS_MAX_OBJECTS = 20;
export const SEARCH_RECORDS_MAX_FIELDS = 25;

export const listSobjectsInputSchema = z
  .object({
    filter: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(apiNamePattern, 'must be a Salesforce object API name prefix')
      .optional()
      .describe(
        'Optional case-insensitive object API name prefix (for example Acc matches Account and AccountCleanInfo). Omit to list every object in the org.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_SOBJECTS_MAX_LIMIT)
      .optional()
      .describe(
        `Maximum objects to return; defaults to ${LIST_SOBJECTS_DEFAULT_LIMIT} and cannot exceed ${LIST_SOBJECTS_MAX_LIMIT}. The result always states how many objects matched.`,
      ),
  })
  .strict();

export const describeSobjectInputSchema = z
  .object({
    objectApiName: objectApiNameSchema,
    includeFields: z
      .boolean()
      .optional()
      .describe('Set false to read only object-level facts and skip the field list; defaults to true.'),
    fieldLimit: z
      .number()
      .int()
      .min(1)
      .max(DESCRIBE_SOBJECT_MAX_FIELD_LIMIT)
      .optional()
      .describe(
        `Maximum fields to return when includeFields is true; defaults to ${DESCRIBE_SOBJECT_DEFAULT_FIELD_LIMIT} and cannot exceed ${DESCRIBE_SOBJECT_MAX_FIELD_LIMIT}.`,
      ),
  })
  .strict();

const queryRecordsInputObjectSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(QUERY_RECORDS_MAX_QUERY_LENGTH)
      .describe(
        'A single SOQL SELECT statement. It must begin with SELECT, must not contain a semicolon '
        + 'outside a string literal, and must not use FOR UPDATE. OFFSET is not available on large '
        + 'result sets, so page with a WHERE clause on an indexed field instead.',
      ),
    useToolingApi: z
      .boolean()
      .optional()
      .describe(
        'Query the Tooling API instead of the data API; defaults to false. Use it only for Tooling '
        + 'objects such as ApexClass, ApexTrigger or a metadata component, and leave it false for '
        + 'business records — an object of one kind is not visible through the other API.',
      ),
    maxRows: z
      .number()
      .int()
      .min(1)
      .max(QUERY_RECORDS_MAX_MAX_ROWS)
      .optional()
      .describe(
        `Maximum rows to collect; defaults to ${QUERY_RECORDS_DEFAULT_MAX_ROWS} and cannot exceed `
        + `${QUERY_RECORDS_MAX_MAX_ROWS} rows in one call. This is a completeness boundary, not a `
        + 'performance hint: the result states how many rows matched and whether it returned all of them.',
      ),
  })
  .strict();

/**
 * The statement rules are a provider-side refinement, not a wire-level pattern: they need
 * string-literal-aware scanning, which a JSON Schema `pattern` cannot express. Length and
 * integer bounds above do reach the wire, so a caller cannot even put an oversized or
 * non-integer `maxRows` on the wire.
 */
export const queryRecordsInputSchema = queryRecordsInputObjectSchema.superRefine((value, context) => {
  const inspection = inspectSoqlQuery(value.query);
  if (!inspection.usable) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['query'], message: inspection.message });
  }
});

/** The registered wire schema, which must stay a raw shape (see ADR-0024). */
export const queryRecordsInputShape = queryRecordsInputObjectSchema.shape;

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

const searchRecordsInputObjectSchema = z
  .object({
    search: z
      .string()
      .trim()
      .min(1)
      .max(SEARCH_RECORDS_MAX_SEARCH_LENGTH)
      .describe(
        'A search term, or a complete SOSL FIND clause. Two forms. (1) A bare keyword such as acme: '
        + 'this Tool escapes it and composes the SOSL for you, so the term can never be read as syntax. '
        + 'A keyword must not contain { or } or a semicolon. (2) A complete clause beginning with FIND, '
        + 'such as FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name) LIMIT 20: it is sent unchanged, '
        + 'and objects, fields and limit must then be omitted because the clause already carries them. '
        + 'One search per call: statements separated by a semicolon are refused. Unlike SOQL, SOSL matches '
        + 'across objects and reports no total match count and no continuation cursor, so read truncated, '
        + 'limitSource and hint to know whether the answer is complete.',
      ),
    objects: z
      .array(objectApiNameSchema)
      .min(1)
      .max(SEARCH_RECORDS_MAX_OBJECTS)
      .optional()
      .describe(
        `Optional object API names to restrict the search to, at most ${SEARCH_RECORDS_MAX_OBJECTS}. `
        + 'Omit to search every searchable object in the org, which is the way to find out which objects '
        + 'mention a term; with the scope omitted each result carries only the record Id and its object '
        + 'type, so name the objects when you want fields.',
      ),
    fields: z
      .array(fieldApiNameSchema)
      .min(1)
      .max(SEARCH_RECORDS_MAX_FIELDS)
      .optional()
      .describe(
        `Fields to return for each object named in objects, at most ${SEARCH_RECORDS_MAX_FIELDS}; defaults `
        + `to ${SEARCH_RECORDS_DEFAULT_FIELDS.join(' and ')}. Only usable together with objects. A bare SOSL `
        + 'RETURNING returns just the record Id, so an object that has no Name field (Case, Task) needs an '
        + 'explicit list; an unknown field fails with MCP_SEARCH_FIELD_INVALID, and describe_sobject lists '
        + 'the real ones.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SEARCH_RECORDS_MAX_LIMIT)
      .optional()
      .describe(
        `Maximum records to return across all objects; defaults to ${SEARCH_RECORDS_DEFAULT_LIMIT} and cannot `
        + `exceed ${SEARCH_RECORDS_MAX_LIMIT}. This is one cap on the whole result, not a per-object cap — SOSL `
        + 'has a single LIMIT — so results that reach it are truncated rather than evenly spread. Not allowed '
        + 'together with a complete FIND clause, which carries its own LIMIT.',
      ),
  })
  .strict();

/**
 * The search rules are a provider-side refinement for the same reason the SOQL ones are: deciding
 * whether the input is a keyword or a clause needs a string-literal-aware scan that a JSON Schema
 * `pattern` cannot express (see ADR-0024). The plan is computed rather than merely inspected, so
 * the composed statement's own size limit is enforced at the wire too.
 */
export const searchRecordsInputSchema = searchRecordsInputObjectSchema.superRefine((value, context) => {
  const plan = planSoslSearch(value.search, {
    ...(value.objects === undefined ? {} : { objects: value.objects }),
    ...(value.fields === undefined ? {} : { fields: value.fields }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    defaultLimit: SEARCH_RECORDS_DEFAULT_LIMIT,
  });
  if (!plan.usable) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['search'], message: plan.message });
  }
});

/** The registered wire schema, which must stay a raw shape (see ADR-0024). */
export const searchRecordsInputShape = searchRecordsInputObjectSchema.shape;

const dataFailureFields = {
  success: z.boolean(),
  errorCode: z.string().max(128).optional(),
  message: z.string().max(2_000).optional(),
  suggestion: z.string().max(1_000).optional(),
  /** The Salesforce-reported error code, kept separate from the SFoA contract code. */
  salesforceErrorCode: z.string().max(128).optional(),
};

const sobjectSummarySchema = z
  .object({
    name: z.string(),
    label: z.string(),
    labelPlural: z.string(),
    keyPrefix: z.string().nullable(),
    custom: z.boolean(),
    queryable: z.boolean(),
    createable: z.boolean(),
    updateable: z.boolean(),
    searchable: z.boolean(),
  })
  .strict();

const picklistValueSchema = z
  .object({
    value: z.string(),
    label: z.string(),
    active: z.boolean(),
    defaultValue: z.boolean(),
  })
  .strict();

const fieldDescriptorSchema = z
  .object({
    apiName: z.string(),
    label: z.string(),
    type: z.string(),
    nillable: z.boolean(),
    createable: z.boolean(),
    updateable: z.boolean(),
    filterable: z.boolean(),
    sortable: z.boolean(),
    custom: z.boolean(),
    deprecatedAndHidden: z.boolean(),
    referenceTo: z.array(z.string()).readonly(),
    relationshipName: z.string().nullable(),
    picklistValues: z.array(picklistValueSchema).readonly(),
    picklistValuesTruncated: z.boolean(),
  })
  .strict();

const childRelationshipDescriptorSchema = z
  .object({
    childSObject: z.string(),
    field: z.string(),
    relationshipName: z.string().nullable(),
    cascadeDelete: z.boolean(),
    restrictedDelete: z.boolean(),
    deprecatedAndHidden: z.boolean(),
  })
  .strict();

export const listSobjectsOutputSchema = z
  .object({
    ...dataFailureFields,
    executionRole: z.literal('USER').optional(),
    api: z.literal('REST').optional(),
    sobjects: z.array(sobjectSummarySchema).readonly().optional(),
    totalCount: z.number().int().nonnegative().optional(),
    returnedCount: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    hint: z.string().max(1_000).optional(),
  })
  .strict();

export const describeSobjectOutputSchema = z
  .object({
    ...dataFailureFields,
    executionRole: z.literal('USER').optional(),
    api: z.literal('REST').optional(),
    objectApiName: z.string().optional(),
    label: z.string().optional(),
    labelPlural: z.string().optional(),
    keyPrefix: z.string().nullable().optional(),
    custom: z.boolean().optional(),
    queryable: z.boolean().optional(),
    createable: z.boolean().optional(),
    updateable: z.boolean().optional(),
    searchable: z.boolean().optional(),
    fields: z.array(fieldDescriptorSchema).readonly().optional(),
    childRelationships: z.array(childRelationshipDescriptorSchema).readonly().optional(),
    totalFields: z.number().int().nonnegative().optional(),
    returnedFields: z.number().int().nonnegative().optional(),
    totalChildRelationships: z.number().int().nonnegative().optional(),
    returnedChildRelationships: z.number().int().nonnegative().optional(),
    fieldsIncluded: z.boolean().optional(),
    truncated: z.boolean().optional(),
    hint: z.string().max(1_000).optional(),
  })
  .strict();

/**
 * Why a `query_records` result is not the whole answer. The reason names the binding
 * constraint, because the fix differs: a low `maxRows` is raised by the caller, a time or
 * response budget is worked around with an aggregate or a narrower filter, and a platform
 * that stops handing out continuation cursors is not something the caller can fix at all.
 */
export const QUERY_TRUNCATION_REASONS = [
  'MAX_ROWS',
  'TIME_BUDGET',
  'RESPONSE_BUDGET',
  'PAGINATION_UNAVAILABLE',
] as const;

const queryTruncationReasonSchema = z.enum(QUERY_TRUNCATION_REASONS);

export const queryRecordsOutputSchema = z
  .object({
    ...dataFailureFields,
    executionRole: z.literal('USER').optional(),
    api: z.literal('REST').optional(),
    useToolingApi: z.boolean().optional(),
    aggregate: z.boolean().optional(),
    /**
     * The value of a **scalar** aggregate: an aggregate with no `GROUP BY`, whose whole result
     * is one number. Salesforce reports a bare `COUNT()` by putting that number in `totalSize`
     * and returning no records at all, so the two fields cannot both be row counts — the value
     * is reported here, and `totalSize` is `null` because no row set was ever described.
     */
    aggregateValue: z.number().int().nonnegative().nullable().optional(),
    records: z.array(z.record(z.unknown())).readonly().optional(),
    /**
     * The platform's count of matching rows, or null when it did not report one — which
     * includes the scalar-aggregate case, where its `totalSize` carried a value instead.
     */
    totalSize: z.number().int().nonnegative().nullable().optional(),
    /** Rows read from Salesforce, before the response budget was applied. */
    fetched: z.number().int().nonnegative().optional(),
    /** Rows present in `records`; below `fetched` only when the response budget cut them. */
    returnedCount: z.number().int().nonnegative().optional(),
    /** Salesforce round trips this call made, including the first batch. */
    pages: z.number().int().nonnegative().optional(),
    done: z.boolean().optional(),
    complete: z.boolean().optional(),
    truncated: z.boolean().optional(),
    truncatedReason: queryTruncationReasonSchema.nullable().optional(),
    hint: z.string().max(1_000).optional(),
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
 * **Not verified against a live org.** The limits resource was refused org-wide when this Tool was
 * built, at every API version and for four distinct identities (see
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

export const orgLimitsOutputSchema = z
  .object({
    ...dataFailureFields,
    executionRole: z.literal('USER').optional(),
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

/**
 * Why a `search_records` result is not every matching record.
 *
 * SOSL reports no total match count and hands out no continuation cursor — `SearchResult` carries
 * only `searchRecords` (verified live, see `P9_T3_LIVE_PROBE_FINDINGS.md` §2) — so an answer's
 * completeness has to be stated in terms of the explicit cap that bound it, never inferred.
 */
export const SEARCH_TRUNCATION_REASONS = ['LIMIT_REACHED', 'PER_OBJECT_LIMIT', 'RESPONSE_BUDGET'] as const;

const searchTruncationReasonSchema = z.enum(SEARCH_TRUNCATION_REASONS);

/**
 * One object's slice of the result.
 *
 * `count` is what Salesforce returned for this object and `returnedCount` is how much of it is in
 * `records`, which differ only when the response budget cut the payload. `atLimit` is true only
 * when a per-object cap could be read out of the clause **and** the count reached it: a cap this
 * Tool cannot see is never guessed at.
 */
const searchRecordGroupSchema = z
  .object({
    objectApiName: z.string(),
    count: z.number().int().nonnegative(),
    returnedCount: z.number().int().nonnegative(),
    atLimit: z.boolean(),
    records: z.array(z.record(z.unknown())).readonly(),
  })
  .strict();

export const searchRecordsOutputSchema = z
  .object({
    ...dataFailureFields,
    executionRole: z.literal('USER').optional(),
    api: z.literal('REST').optional(),
    /** KEYWORD when this Tool composed the SOSL, STATEMENT when the caller's clause was sent unchanged. */
    mode: z.enum(SOSL_MODES).optional(),
    /** The exact SOSL sent to Salesforce, including anything this Tool added around a bare keyword. */
    statement: z.string().max(SOSL_MAX_STATEMENT_LENGTH).optional(),
    resultsByObject: z.record(searchRecordGroupSchema).optional(),
    /** Records Salesforce returned, including any dropped for an unreadable record type. */
    totalReturned: z.number().int().nonnegative().optional(),
    /** Records present in `resultsByObject`; below `totalReturned` only when the budget cut them. */
    returnedCount: z.number().int().nonnegative().optional(),
    unreadableRecords: z.number().int().nonnegative().optional(),
    objectsReturned: z.number().int().nonnegative().optional(),
    /** The cap the whole result was held to, or null when nothing bounds it. */
    effectiveLimit: z.number().int().nonnegative().nullable().optional(),
    limitSource: z.enum(SOSL_LIMIT_SOURCES).optional(),
    truncated: z.boolean().optional(),
    truncatedReason: searchTruncationReasonSchema.nullable().optional(),
    /**
     * True only when every record Salesforce returned is present here. A result with an unreadable
     * record type is never complete, because those records are counted and dropped, not returned.
     */
    complete: z.boolean().optional(),
    hint: z.string().max(1_000).optional(),
  })
  .strict();

export type ListSobjectsInput = z.infer<typeof listSobjectsInputSchema>;
export type ListSobjectsOutput = z.infer<typeof listSobjectsOutputSchema>;
export type DescribeSobjectInput = z.infer<typeof describeSobjectInputSchema>;
export type DescribeSobjectOutput = z.infer<typeof describeSobjectOutputSchema>;
export type QueryRecordsInput = z.infer<typeof queryRecordsInputSchema>;
export type QueryRecordsOutput = z.infer<typeof queryRecordsOutputSchema>;
export type QueryTruncationReason = (typeof QUERY_TRUNCATION_REASONS)[number];
export type OrgLimitsInput = z.infer<typeof orgLimitsInputSchema>;
export type OrgLimitsOutput = z.infer<typeof orgLimitsOutputSchema>;
export type OrgLimitEntry = z.infer<typeof orgLimitEntrySchema>;
export type OrgLimitHighlight = z.infer<typeof orgLimitHighlightSchema>;
export type OrgLimitHighlights = z.infer<typeof orgLimitHighlightsSchema>;
export type SearchRecordsInput = z.infer<typeof searchRecordsInputSchema>;
export type SearchRecordsOutput = z.infer<typeof searchRecordsOutputSchema>;
export type SearchRecordGroup = z.infer<typeof searchRecordGroupSchema>;
export type SearchTruncationReason = (typeof SEARCH_TRUNCATION_REASONS)[number];
export type SobjectSummary = z.infer<typeof sobjectSummarySchema>;
export type FieldDescriptor = z.infer<typeof fieldDescriptorSchema>;
export type ChildRelationshipDescriptor = z.infer<typeof childRelationshipDescriptorSchema>;
