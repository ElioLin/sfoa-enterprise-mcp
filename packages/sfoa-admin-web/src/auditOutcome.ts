import type { AuditRecord } from '@sfoa/control-plane';

/**
 * Terminal outcome of the MCP Tool invocation itself, independent of what Salesforce did with
 * the business records. `outcome` is absent on historical rows that only recorded `result`.
 */
export type AuditOutcomeSource = Pick<AuditRecord, 'result' | 'outcome' | 'responseSummary'>;

/**
 * The four Salesforce business outcomes a batch DML audit row records in
 * `responseSummary.businessOutcome`. These describe the *mutation*, not the Tool call:
 * `audit.outcome = SUCCESS` only means the Tool invocation ran to completion, which is why the
 * terminal column alone cannot tell an operator whether every record was committed.
 */
export const BATCH_BUSINESS_OUTCOMES = ['SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'OUTCOME_UNKNOWN'] as const;
export type BatchBusinessOutcome = (typeof BATCH_BUSINESS_OUTCOMES)[number];

/**
 * The batch `responseSummary`, or `null` for every non-batch audit (single-record DML, SOQL,
 * identity, admin, runtime). Historical rows and other audit kinds keep their existing display.
 */
export function batchResponseSummary(record: AuditOutcomeSource): Readonly<Record<string, unknown>> | null {
  const summary = record.responseSummary;
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) return null;
  const value = summary as Record<string, unknown>;
  return value.batch === true ? value : null;
}

/** Business mutation result for a batch DML audit, or `undefined` when this row is not a batch. */
export function auditBusinessOutcome(record: AuditOutcomeSource): BatchBusinessOutcome | undefined {
  const status = batchResponseSummary(record)?.businessOutcome;
  return typeof status === 'string' && (BATCH_BUSINESS_OUTCOMES as readonly string[]).includes(status)
    ? status as BatchBusinessOutcome
    : undefined;
}

/** MCP Tool invocation terminal state, as already persisted. Never rewritten by this module. */
export function toolInvocationOutcome(record: AuditOutcomeSource): string {
  return record.outcome ?? record.result;
}

/**
 * Display status for one Audit row.
 *
 * For a batch DML row the business outcome is the authority: `audit.outcome = SUCCESS` is only
 * the Tool terminal state, so rendering it as the main status made a partially committed batch
 * read as a complete success in the P7 Audit list and detail header. The raw `audit.outcome`
 * column is never modified — only what the operator is shown.
 *
 * `OUTCOME_UNKNOWN` deliberately displays as `UNKNOWN` rather than its own label: the existing
 * "无法确认 Salesforce 最终提交状态，禁止直接重试" guidance is keyed on `UNKNOWN`, and an
 * unprovable commit must never look successful.
 */
export function resolveAuditDisplayOutcome(record: AuditOutcomeSource): string {
  const businessOutcome = auditBusinessOutcome(record);
  switch (businessOutcome) {
    case 'PARTIAL_SUCCESS': return businessOutcome;
    case 'OUTCOME_UNKNOWN': return 'UNKNOWN';
    case 'SUCCESS':
    case 'FAILED': return businessOutcome;
    default: return toolInvocationOutcome(record);
  }
}
