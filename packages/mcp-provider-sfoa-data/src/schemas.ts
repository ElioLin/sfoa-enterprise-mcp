import { z } from 'zod';
import { inspectSoqlQuery } from './soql.js';

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
    records: z.array(z.record(z.unknown())).readonly().optional(),
    /** The platform's count of matching rows, or null when it did not report one. */
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

export type ListSobjectsInput = z.infer<typeof listSobjectsInputSchema>;
export type ListSobjectsOutput = z.infer<typeof listSobjectsOutputSchema>;
export type DescribeSobjectInput = z.infer<typeof describeSobjectInputSchema>;
export type DescribeSobjectOutput = z.infer<typeof describeSobjectOutputSchema>;
export type QueryRecordsInput = z.infer<typeof queryRecordsInputSchema>;
export type QueryRecordsOutput = z.infer<typeof queryRecordsOutputSchema>;
export type QueryTruncationReason = (typeof QUERY_TRUNCATION_REASONS)[number];
export type SobjectSummary = z.infer<typeof sobjectSummarySchema>;
export type FieldDescriptor = z.infer<typeof fieldDescriptorSchema>;
export type ChildRelationshipDescriptor = z.infer<typeof childRelationshipDescriptorSchema>;
