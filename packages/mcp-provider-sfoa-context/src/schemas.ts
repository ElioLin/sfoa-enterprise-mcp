import { z } from 'zod';

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
  }).strict();

export const recordActionContextInputSchema = recordActionContextInputObjectSchema.superRefine((input, context) => {
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
  })
  .strict();

export const recordActionContextOutputSchema = z
  .object({
    ...contextFailureFields,
    executionRole: z.literal('USER').optional(),
    objectApiName: z.string().optional(),
    action: z.enum(['CREATE', 'UPDATE']).optional(),
    recordId: z.string().optional(),
    recordType: z
      .object({
        id: z.string(),
        name: z.string(),
        defaultForUser: z.boolean(),
        available: z.boolean(),
      })
      .strict()
      .optional(),
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

export type RecordActionContextInput = z.infer<typeof recordActionContextInputSchema>;
export type RecordActionContextOutput = z.infer<typeof recordActionContextOutputSchema>;
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
