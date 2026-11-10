import { z } from 'zod';

const name = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_]*$/u);
const id = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u);

/** An explicit form choice, never an identity selector or authorization token. */
export const formContextRequestSchema = z.object({
  entry: z.enum(['STANDARD', 'QUICK_ACTION']).default('STANDARD'),
  appDeveloperName: z.string().min(1).max(255).regex(/^[A-Za-z][A-Za-z0-9_]*$/u).optional(),
  quickActionName: z.string().min(1).max(255).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?$/u).optional(),
  sourceRecordId: id.optional(),
  phase: z.enum(['START', 'REFINE', 'SUBMIT']).default('START'),
  structuralContextRef: z.string().uuid().optional().describe('Server-returned structural configuration reference for REFINE only; START/SUBMIT read or freshly verify current component revisions. Not authorization.'),
  recommendationFields: z.array(name).max(25).optional(),
}).strict().superRefine((value, context) => {
  if (value.entry === 'QUICK_ACTION' && !value.quickActionName) context.addIssue({ code: z.ZodIssueCode.custom,
    path: ['quickActionName'], message: 'An explicit Quick Action API name is required.' });
  if (value.entry === 'STANDARD' && (value.quickActionName || value.sourceRecordId)) context.addIssue({
    code: z.ZodIssueCode.custom, message: 'Quick Action fields require the QUICK_ACTION entry.' });
  if (value.phase === 'SUBMIT' && value.recommendationFields?.length) context.addIssue({
    code: z.ZodIssueCode.custom, message: 'Optional recommendations cannot delay submission.' });
});
export type FormContextRequest = z.infer<typeof formContextRequestSchema>;

export const formFieldAssessmentSchema = z.object({
  apiName: z.string(), label: z.string(), required: z.boolean().nullable(), writable: z.boolean(),
  visibility: z.enum(['VISIBLE', 'HIDDEN', 'PENDING', 'UNKNOWN']),
  valueState: z.enum(['PROVIDED', 'EMPTY', 'ABSENT', 'UNKNOWN', 'MANAGED_ON_WRITE', 'DEFAULT_ON_WRITE']),
  valueSource: z.enum(['CLIENT_DRAFT', 'SAVED_RECORD', 'SALESFORCE_DEFAULT', 'SALESFORCE_DEFAULT_ON_WRITE', 'QUICK_ACTION_DEFAULT', 'MANAGED_POLICY', 'RUNTIME_MANAGED', 'NONE', 'UNKNOWN']),
}).strict();

export const formContextResultSchema = z.object({
  version: z.literal('1'), resolutionId: z.string().uuid(),
  entry: z.enum(['STANDARD', 'QUICK_ACTION']), phase: z.enum(['START', 'REFINE', 'SUBMIT']),
  status: z.enum(['READY', 'NEEDS_INPUT', 'UNKNOWN']),
  formSource: z.string(), app: z.string().nullable(), appSource: z.string().nullable(),
  page: z.string().nullable(), pageLayoutId: z.string().nullable(),
  quickActionName: z.string().optional(), verifiedAt: z.string().nullable(),
  structuralContextRef: z.string().uuid().optional(),
  configurationSource: z.enum(['FRESH', 'TASK_REUSE']).optional(),
  missingRequired: z.array(z.string()).max(400), criticalUnknown: z.array(z.string()).max(400),
  fields: z.array(formFieldAssessmentSchema).max(400),
  /**
   * Record-scoped actions Salesforce reports for this record, including the
   * Lightning page's Quick Action buttons. `evaluable` marks the ones this Tool
   * can resolve as their own form via formContext.entry=QUICK_ACTION.
   */
  availableActions: z.array(z.object({
    apiName: z.string().min(1).max(255), label: z.string().min(1).max(255),
    type: z.enum(['QuickAction', 'StandardButton']),
    subtype: z.string().max(64).nullable(), targetObject: z.string().max(255).nullable(),
    section: z.string().max(64).nullable(), evaluable: z.boolean(),
    applicable: z.boolean(), ruleState: z.enum(['VISIBLE', 'HIDDEN', 'UNKNOWN', 'NONE']),
    source: z.enum(['PAGE', 'SALESFORCE']),
  }).strict()).max(30).optional(),
  actionsEvaluated: z.boolean().optional(),
  actionsError: z.string().max(128).optional(),
  apiCallCount: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative(),
  recommendations: z.unknown().optional(),
  warnings: z.array(z.string()).max(30),
}).strict();
export type FormContextResult = z.infer<typeof formContextResultSchema>;
