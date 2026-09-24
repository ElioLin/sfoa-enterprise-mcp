import { z } from 'zod';

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

export type ListSobjectsInput = z.infer<typeof listSobjectsInputSchema>;
export type ListSobjectsOutput = z.infer<typeof listSobjectsOutputSchema>;
export type DescribeSobjectInput = z.infer<typeof describeSobjectInputSchema>;
export type DescribeSobjectOutput = z.infer<typeof describeSobjectOutputSchema>;
export type SobjectSummary = z.infer<typeof sobjectSummarySchema>;
export type FieldDescriptor = z.infer<typeof fieldDescriptorSchema>;
export type ChildRelationshipDescriptor = z.infer<typeof childRelationshipDescriptorSchema>;
