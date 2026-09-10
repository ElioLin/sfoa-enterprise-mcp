import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdminAuditTraceDto, AuditRecord } from '@sfoa/control-plane';
import { auditBusinessOutcome, batchResponseSummary, resolveAuditDisplayOutcome } from '../auditOutcome.js';
import { statusTone } from '../components/StatusTag.js';
import { statusLabel } from '../localization.js';
import AuditPage from '../pages/AuditPage.js';
import { AuditTraceWorkbench } from '../pages/audit/AuditTraceWorkbench.js';
import { asFetchMock, jsonResponse, renderAdmin } from './helpers.js';

const NOW = '2026-09-01T00:00:00.000Z';

type OutcomeSource = Pick<AuditRecord, 'result' | 'outcome' | 'responseSummary'>;

const PARTIAL_BATCH = Object.freeze({
  batch: true, businessOutcome: 'PARTIAL_SUCCESS', status: 'PARTIAL_SUCCESS', partial: true,
  totalCount: 10, succeededCount: 9, failedCount: 1, unknownCount: 0,
});

describe('P8-07 HF02 audit display outcome resolver', () => {
  it('Case B: a partially committed batch is never displayed as a complete SUCCESS', () => {
    // The Tool invocation succeeded, so the terminal columns say PASS/SUCCESS — that is exactly
    // the ambiguity this resolver removes from the Audit surface.
    const record: OutcomeSource = { result: 'PASS', outcome: 'SUCCESS', responseSummary: PARTIAL_BATCH };
    expect(record.outcome).toBe('SUCCESS');
    expect(auditBusinessOutcome(record)).toBe('PARTIAL_SUCCESS');
    expect(resolveAuditDisplayOutcome(record)).toBe('PARTIAL_SUCCESS');
    expect(statusLabel('PARTIAL_SUCCESS')).toBe('部分成功');
    expect(statusTone('PARTIAL_SUCCESS')).toBe('warning');
  });

  it('Case A: a fully committed batch still displays SUCCESS', () => {
    expect(resolveAuditDisplayOutcome({ result: 'PASS', outcome: 'SUCCESS',
      responseSummary: { batch: true, businessOutcome: 'SUCCESS', status: 'SUCCESS' } })).toBe('SUCCESS');
    expect(resolveAuditDisplayOutcome({ result: 'PASS', outcome: 'SUCCESS', responseSummary: null })).toBe('SUCCESS');
  });

  it('Case C: a batch where nothing committed displays FAILED', () => {
    const record: OutcomeSource = { result: 'ERROR', outcome: 'FAILED',
      responseSummary: { batch: true, businessOutcome: 'FAILED', status: 'FAILED' } };
    expect(resolveAuditDisplayOutcome(record)).toBe('FAILED');
    expect(statusTone('FAILED')).toBe('error');
  });

  it('Case D: an unprovable batch commit displays UNKNOWN with warning tone, never SUCCESS', () => {
    const record: OutcomeSource = { result: 'ERROR', outcome: 'UNKNOWN',
      responseSummary: { batch: true, businessOutcome: 'OUTCOME_UNKNOWN', status: 'OUTCOME_UNKNOWN' } };
    expect(resolveAuditDisplayOutcome(record)).toBe('UNKNOWN');
    expect(statusTone(resolveAuditDisplayOutcome(record))).toBe('warning');
    // Even if the terminal column ever said SUCCESS, the unprovable commit must not.
    expect(resolveAuditDisplayOutcome({ ...record, outcome: 'SUCCESS' })).toBe('UNKNOWN');
  });

  it('Case E: every non-batch audit keeps its existing outcome/result behaviour', () => {
    const cases: readonly (readonly [OutcomeSource, string])[] = [
      [{ result: 'PASS', outcome: 'SUCCESS', responseSummary: null }, 'SUCCESS'],
      [{ result: 'ERROR', outcome: 'FAILED', responseSummary: null }, 'FAILED'],
      [{ result: 'BLOCKED', outcome: 'DENIED', responseSummary: null }, 'DENIED'],
      [{ result: 'ERROR', outcome: 'UNKNOWN', responseSummary: null }, 'UNKNOWN'],
      // Historical rows recorded no outcome at all.
      [{ result: 'ERROR', outcome: null, responseSummary: null }, 'ERROR'],
      [{ result: 'PASS', outcome: null, responseSummary: undefined }, 'PASS'],
      // A responseSummary without batch:true is not a batch audit, whatever it contains.
      [{ result: 'PASS', outcome: 'SUCCESS', responseSummary: { batch: false, businessOutcome: 'OUTCOME_UNKNOWN' } }, 'SUCCESS'],
      [{ result: 'PASS', outcome: 'SUCCESS', responseSummary: 'not-an-object' }, 'SUCCESS'],
      [{ result: 'PASS', outcome: 'SUCCESS', responseSummary: { batch: true, businessOutcome: 'SOMETHING_NEW' } }, 'SUCCESS'],
    ];
    for (const [record, expected] of cases) expect(resolveAuditDisplayOutcome(record)).toBe(expected);
    expect(batchResponseSummary({ result: 'PASS', outcome: 'SUCCESS', responseSummary: null })).toBeNull();
    expect(batchResponseSummary({ result: 'PASS', outcome: 'SUCCESS', responseSummary: PARTIAL_BATCH })).toBe(PARTIAL_BATCH);
  });
});

describe('P8-07 HF02 Audit list main status', () => {
  it('shows 部分成功 for a 10-record batch with 9 successes and 1 failure', async () => {
    const record = batchAudit({ businessOutcome: 'PARTIAL_SUCCESS', responseSummary: PARTIAL_BATCH });
    vi.stubGlobal('fetch', asFetchMock((url) => url.pathname.endsWith('/audits')
      ? jsonResponse(page([record]))
      : jsonResponse(batchTrace(record))));
    renderAdmin(<AuditPage />, '/audit');

    const list = await screen.findByLabelText('审计记录列表');
    await waitFor(() => expect(within(list).getByText('部分成功')).toBeInTheDocument());
    // The list must not present the row as a complete success.
    expect(within(list).queryByText('成功')).toBeNull();
    expect(within(list).queryByText('失败')).toBeNull();
  });

  it('still shows SUCCESS and FAILED for fully committed and fully rejected batches', async () => {
    const success = batchAudit({ businessOutcome: 'SUCCESS', result: 'PASS', outcome: 'SUCCESS',
      responseSummary: { batch: true, businessOutcome: 'SUCCESS', status: 'SUCCESS', totalCount: 2, succeededCount: 2, failedCount: 0, unknownCount: 0 } });
    vi.stubGlobal('fetch', asFetchMock((url) => url.pathname.endsWith('/audits')
      ? jsonResponse(page([success])) : jsonResponse(batchTrace(success))));
    const { unmount } = renderAdmin(<AuditPage />, '/audit');
    const list = await screen.findByLabelText('审计记录列表');
    await waitFor(() => expect(within(list).getByText('成功')).toBeInTheDocument());
    unmount();

    const failed = batchAudit({ businessOutcome: 'FAILED', result: 'ERROR', outcome: 'FAILED',
      responseSummary: { batch: true, businessOutcome: 'FAILED', status: 'FAILED', totalCount: 2, succeededCount: 0, failedCount: 2, unknownCount: 0 } });
    vi.stubGlobal('fetch', asFetchMock((url) => url.pathname.endsWith('/audits')
      ? jsonResponse(page([failed])) : jsonResponse(batchTrace(failed))));
    renderAdmin(<AuditPage />, '/audit');
    const failedList = await screen.findByLabelText('审计记录列表');
    await waitFor(() => expect(within(failedList).getByText('失败')).toBeInTheDocument());
  });
});

describe('P8-07 HF02 Audit detail header', () => {
  it('makes the business outcome the primary status with the Tool execution as secondary text', () => {
    const record = batchAudit({ businessOutcome: 'PARTIAL_SUCCESS', responseSummary: PARTIAL_BATCH });
    renderAdmin(<AuditTraceWorkbench trace={batchTrace(record)} />);

    expect(screen.getByText('业务结果：')).toBeInTheDocument();
    expect(screen.getByText('部分成功')).toBeInTheDocument();
    // Both layers stay available, but never as a conflicting "SUCCESS above PARTIAL_SUCCESS".
    expect(screen.getByText('工具执行：成功')).toBeInTheDocument();
    expect(screen.queryByText('成功')).toBeNull();
    // The pre-existing batch counts Alert is preserved unchanged (including its allOrNone note);
    // the partial-batch warning below repeats the same counts, so anchor on the original wording.
    expect(screen.getByText('批量操作：部分成功（PARTIAL_SUCCESS）')).toBeInTheDocument();
    expect(screen.getByText(/总数 10 · 成功 9 · 失败 1 · 未知 0。allOrNone 仅覆盖本次 Salesforce 请求。/u)).toBeInTheDocument();
  });

  it('keeps the no-retry warning and UNKNOWN status for an unprovable batch commit', () => {
    const record = batchAudit({ businessOutcome: 'OUTCOME_UNKNOWN', result: 'ERROR', outcome: 'UNKNOWN',
      responseSummary: { batch: true, businessOutcome: 'OUTCOME_UNKNOWN', status: 'OUTCOME_UNKNOWN',
        totalCount: 2, succeededCount: 0, failedCount: 0, unknownCount: 2 } });
    renderAdmin(<AuditTraceWorkbench trace={batchTrace(record)} />);

    expect(screen.getAllByText('未知').length).toBeGreaterThan(0);
    expect(screen.queryByText('成功')).toBeNull();
    expect(screen.getByText('操作结果未知（UNKNOWN）')).toBeInTheDocument();
    expect(screen.getByText(/避免直接重试/u)).toBeInTheDocument();
  });

  it('leaves a fully committed batch as a single SUCCESS status', () => {
    const record = batchAudit({ businessOutcome: 'SUCCESS', result: 'PASS', outcome: 'SUCCESS',
      responseSummary: { batch: true, businessOutcome: 'SUCCESS', status: 'SUCCESS',
        totalCount: 2, succeededCount: 2, failedCount: 0, unknownCount: 0 } });
    renderAdmin(<AuditTraceWorkbench trace={batchTrace(record)} />);
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.queryByText(/工具执行：/u)).toBeNull();
    expect(screen.getByText('未发现执行错误')).toBeInTheDocument();
  });

  it('does not claim 未发现执行错误 for a partial batch whose collection POST succeeded', () => {
    // The collection request returns HTTP 200 and rejects individual items, so the trace has no
    // failing node at all. Reporting success there contradicted the 业务结果 status above it.
    const record = batchAudit({ businessOutcome: 'PARTIAL_SUCCESS', responseSummary: PARTIAL_BATCH });
    renderAdmin(<AuditTraceWorkbench trace={batchTrace(record)} />);

    expect(screen.queryByText('未发现执行错误')).toBeNull();
    expect(screen.getByText('批量业务结果：PARTIAL_SUCCESS')).toBeInTheDocument();
    expect(screen.getByText(/禁止整批重试/u)).toBeInTheDocument();
  });

  it('keeps the plain status tag for every non-batch audit', () => {
    renderAdmin(<AuditTraceWorkbench trace={batchTrace(batchAudit({ responseSummary: null }), {
      toolName: 'create_record', operation: 'CREATE', result: 'PASS', outcome: 'SUCCESS',
    })} />);
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.queryByText('业务结果：')).toBeNull();
  });
});

function batchAudit(overrides: Partial<AuditRecord> & { businessOutcome?: string } = {}): AuditRecord {
  const { businessOutcome: _businessOutcome, ...rest } = overrides;
  return {
    id: '1', publicAuditId: '11111111-1111-4111-8111-111111111111', auditKind: 'MCP_TOOL_CALL',
    occurredAt: NOW, startedAt: NOW, completedAt: NOW, correlationId: 'corr-1', channel: 'MCP',
    clientId: 'client-a', actorAdmin: null, platformUserId: 'platform-a', salesforceUsername: 'sf-user@example.com',
    executionRole: 'USER', identitySource: 'USER_BOUND_TOKEN', identityCredentialId: '1',
    toolName: 'update_records', operation: 'UPDATE', objectApiName: 'Lead', recordId: null,
    result: 'PASS', outcome: 'SUCCESS', errorCode: null, errorMessageSafe: null,
    auditIntegrityStatus: 'COMPLETE', durationMs: 420, requestSummary: null, responseSummary: null, createdAt: NOW,
    ...rest,
  };
}

function batchTrace(audit: AuditRecord, overrides: Partial<AuditRecord> = {}): AdminAuditTraceDto {
  return {
    audit: { ...audit, ...overrides },
    summary: { eventCount: 0, apiCount: 0, soqlCount: 0, dmlCount: 0, errorCount: 0, payloadCount: 0, detailsTruncated: false },
    firstFailure: null,
    events: [],
    salesforceApiCalls: [],
    payloadMetadata: [],
  };
}

function page<T>(items: readonly T[]) {
  return { items, limit: 25, offset: 0, count: items.length, hasMore: false, nextOffset: null };
}
