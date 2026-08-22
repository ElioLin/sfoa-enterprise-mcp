import { z } from 'zod';

export type SalesforceFieldValue = string | number | boolean | null;

const apiNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/u;

export const objectApiNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(apiNamePattern, 'must be a Salesforce object API name without a relationship path')
  .describe('Salesforce object API name, for example Lead or SomeObject__c.');

const fieldApiNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(apiNamePattern, 'must be a Salesforce field API name without a relationship path');

const fieldValueSchema = z.union([
  z.string().max(131_072),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const fieldsSchema = z
  .record(fieldApiNameSchema, fieldValueSchema)
  .superRefine((fields, context) => {
    const names = Object.keys(fields);
    if (names.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'fields must contain at least one field' });
    }
    if (names.length > 200) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'fields must not contain more than 200 fields' });
    }
    if (names.some((name) => name.toLocaleLowerCase('en-US') === 'id')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fields.Id is not accepted; use recordId for UPDATE and omit Id for CREATE',
      });
    }
  })
  .describe('Non-empty Salesforce field-value object. Values must be JSON strings, numbers, booleans, or null.');

export const recordIdSchema = z
  .string()
  .trim()
  .regex(/^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/u, 'must be a 15- or 18-character Salesforce record ID')
  .describe('Salesforce 15- or 18-character record ID.');

export const createRecordInputSchema = z
  .object({
    objectApiName: objectApiNameSchema,
    fields: fieldsSchema,
  })
  .strict();

export const updateRecordInputSchema = z
  .object({
    objectApiName: objectApiNameSchema,
    recordId: recordIdSchema,
    fields: fieldsSchema,
  })
  .strict();

export const safeSalesforceErrorSchema = z
  .object({
    errorCode: z.string().max(128),
    message: z.string().max(2_000),
    fields: z.array(z.string().max(128)).max(200),
  })
  .strict();

export const dmlOutputSchema = z
  .object({
    success: z.boolean(),
    recordId: recordIdSchema.optional(),
    errorCode: z.string().max(128).optional(),
    message: z.string().max(2_000).optional(),
    salesforceErrors: z.array(safeSalesforceErrorSchema).max(25).optional(),
  })
  .strict();

export type CreateRecordInput = z.infer<typeof createRecordInputSchema>;
export type UpdateRecordInput = z.infer<typeof updateRecordInputSchema>;
export type DmlOutput = z.infer<typeof dmlOutputSchema>;
export type SafeSalesforceError = z.infer<typeof safeSalesforceErrorSchema>;
