import { z } from 'zod';

/** Kept contract-identical to the context Provider selector; no context-to-DML dependency. */
export const dmlFormContextSchema = z.object({
  entry: z.enum(['STANDARD', 'QUICK_ACTION']).default('STANDARD'),
  appDeveloperName: z.string().min(1).max(255).regex(/^[A-Za-z][A-Za-z0-9_]*$/u).optional(),
  quickActionName: z.string().min(1).max(255).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?$/u).optional(),
  sourceRecordId: z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u).optional(),
  phase: z.enum(['START', 'REFINE', 'SUBMIT']).default('SUBMIT'),
  structuralContextRef: z.string().uuid().optional().describe('Optional refinement reference; always ignored for the fresh submission check. Not authorization.'),
  recommendationFields: z.array(z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_]*$/u)).max(25).optional(),
}).strict().superRefine((value, context) => {
  if (value.entry === 'QUICK_ACTION' && !value.quickActionName) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['quickActionName'], message: 'An explicit Quick Action API name is required.' });
  if (value.entry === 'STANDARD' && (value.quickActionName || value.sourceRecordId)) context.addIssue({
    code: z.ZodIssueCode.custom, message: 'Quick Action fields require the QUICK_ACTION entry.' });
  if (value.recommendationFields?.length) context.addIssue({ code: z.ZodIssueCode.custom,
    message: 'Optional recommendations cannot delay submission.' });
});
