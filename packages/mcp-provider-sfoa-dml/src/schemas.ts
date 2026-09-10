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

const salesforceIdPattern = /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/u;

export const recordIdSchema = z
  .string()
  .trim()
  .regex(/^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/u, 'must be a 15- or 18-character Salesforce record ID')
  .describe('Salesforce 15- or 18-character record ID.');

export const recordTypeIdSchema = z
  .string()
  .trim()
  .regex(salesforceIdPattern, 'must be a 15- or 18-character Salesforce Record Type ID')
  .describe('Optional Salesforce Record Type ID that must be available to the authenticated request user.');

export const createRecordInputSchema = z
  .object({
    objectApiName: objectApiNameSchema,
    recordTypeId: recordTypeIdSchema.optional(),
    uiContextResolutionId: z.string().uuid().optional().describe('Optional opaque ID returned by the last CREATE action context. Audit provenance only; never changes authorization or Salesforce payload.'),
    fields: fieldsSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.recordTypeId) return;
    const recordTypeFieldKey = Object.keys(input.fields)
      .find((name) => name.toLocaleLowerCase('en-US') === 'recordtypeid');
    if (recordTypeFieldKey === undefined) return;
    const fieldValue = input.fields[recordTypeFieldKey];
    if (typeof fieldValue !== 'string' || !sameSalesforceIdPrefix(input.recordTypeId, fieldValue)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recordTypeId'],
        message: 'recordTypeId conflicts with fields.RecordTypeId. Set the Record Type in exactly one place so the analyzed Record Type and the created record cannot diverge.',
      });
    }
  });

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

const clientReferenceIdSchema = z.string().trim().min(1).max(128).optional()
  .describe('Optional unique correlation key within this batch; never sent to a Salesforce field.');
const createItemSchema = createRecordInputSchema.innerType().omit({ objectApiName: true })
  .extend({ clientReferenceId: clientReferenceIdSchema }).superRefine((item, context) => {
    // Reuse the single-record Record Type check without passing the correlation key.
    const { clientReferenceId: _reference, ...single } = item;
    const result = createRecordInputSchema.safeParse({ objectApiName: 'Object__c', ...single });
    if (!result.success) for (const issue of result.error.issues) context.addIssue(issue);
  });
const updateItemSchema = updateRecordInputSchema.omit({ objectApiName: true })
  .extend({ clientReferenceId: clientReferenceIdSchema });
function uniqueReferences(items: readonly { clientReferenceId?: string }[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (!item.clientReferenceId) return;
    if (seen.has(item.clientReferenceId)) context.addIssue({ code: z.ZodIssueCode.custom,
      path: [index, 'clientReferenceId'], message: 'clientReferenceId must be unique within the batch' });
    seen.add(item.clientReferenceId);
  });
}

export const BATCH_DUPLICATE_RECORD_ID_CODE = 'MCP_DML_BATCH_DUPLICATE_RECORD_ID';

/**
 * Canonical duplicate detection for one `update_records` batch.
 *
 * Salesforce 15- and 18-character IDs for the same record differ only in the trailing
 * 3-character checksum, so the first 15 characters are the durable identity. Comparing raw
 * strings would let `A → Status=X` and `A → Status=Y` reach Salesforce as two collection rows
 * whose commit order decides the final value. Reject that before dispatch.
 *
 * Returns the duplicated canonical 15-character identities, in first-seen order.
 */
export function duplicateBatchRecordIds(records: readonly { recordId?: unknown }[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const record of records) {
    const value = typeof record?.recordId === 'string' ? record.recordId.trim() : '';
    if (!salesforceIdPattern.test(value)) continue;
    const identity = value.slice(0, 15);
    if (seen.has(identity)) { if (!duplicates.includes(identity)) duplicates.push(identity); continue; }
    seen.add(identity);
  }
  return Object.freeze(duplicates);
}

const batchBase = { objectApiName: objectApiNameSchema,
  allOrNone: z.boolean().default(false).describe('Atomicity applies only to this Salesforce request, never across Tool calls.') };
export const createRecordsInputSchema = z.object({ ...batchBase,
  records: z.array(createItemSchema).min(1).max(200).superRefine(uniqueReferences) }).strict();
export const updateRecordsInputSchema = z.object({ ...batchBase,
  records: z.array(updateItemSchema).min(1).max(200).superRefine(uniqueReferences) }).strict();
export const batchDmlOutputSchema = z.object({
  success: z.boolean(), status: z.enum(['SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'OUTCOME_UNKNOWN']),
  total: z.number().int().min(0).max(200), succeeded: z.number().int().min(0).max(200),
  failed: z.number().int().min(0).max(200), unknown: z.number().int().min(0).max(200),
  allOrNone: z.boolean(), errorCode: z.string().max(128).optional(), message: z.string().max(2000).optional(),
  results: z.array(z.object({ index: z.number().int().min(0).max(199),
    clientReferenceId: clientReferenceIdSchema, success: z.boolean(),
    status: z.enum(['SUCCESS', 'FAILED', 'OUTCOME_UNKNOWN']), recordId: recordIdSchema.optional(),
    errorCode: z.string().max(128).optional(), message: z.string().max(2000).optional(),
    salesforceErrors: z.array(safeSalesforceErrorSchema).max(25).optional(),
  }).strict()).max(200),
}).strict();
export type CreateRecordsInput = z.infer<typeof createRecordsInputSchema>;
export type UpdateRecordsInput = z.infer<typeof updateRecordsInputSchema>;
export type BatchDmlOutput = z.infer<typeof batchDmlOutputSchema>;

function sameSalesforceIdPrefix(left: string, right: string): boolean {
  // 18-char IDs differ only in the trailing 3-char checksum; the 15-char prefix is the authority.
  return salesforceIdPattern.test(left) && salesforceIdPattern.test(right)
    && left.slice(0, 15) === right.slice(0, 15);
}
