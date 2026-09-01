import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdminAuditTraceDto } from '@sfoa/control-plane';
import { useLocation } from 'react-router-dom';
import { AuditTraceWorkbench } from '../pages/audit/AuditTraceWorkbench.js';
import AuditPage from '../pages/AuditPage.js';
import { asFetchMock, jsonResponse, renderAdmin } from './helpers.js';

const NOW = '2026-09-01T00:00:00.000Z';

describe('P7-07 Audit Trace Workbench', () => {
  it('renders SOQL, DML field provenance, and deterministic failure evidence', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    renderAdmin(<AuditTraceWorkbench trace={traceFixture()} />);

    expect(screen.getByText('SOQL 查询证据')).toBeInTheDocument();
    expect(screen.getByText('SELECT Id FROM Contact LIMIT 2')).toBeInTheDocument();
    expect(screen.getByText('DML 变更证据')).toBeInTheDocument();
    expect(screen.getByText('Lead_Owner__c')).toBeInTheDocument();
    expect(screen.getAllByText('003MANAGED')).toHaveLength(2);
    expect(screen.getAllByText('FIELD_CUSTOM_VALIDATION_EXCEPTION').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '跳转到失败节点' }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' }));
  });

  it('does not fetch Payload body until the administrator opens a metadata card', async () => {
    const fetchMock = asFetchMock((url) => {
      if (url.pathname.endsWith('/audit-payloads/30')) {
        return jsonResponse({
          id: '30', auditId: '1', salesforceApiCallId: '21', auditEventId: null,
          payloadType: 'ERROR_RESPONSE', contentType: 'application/json', originalSizeBytes: '34', storedSizeBytes: 34,
          truncated: true, contentSha256: 'a'.repeat(64), safePayload: '{"message":"validation failed"}', createdAt: NOW,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<AuditTraceWorkbench trace={traceFixture(true)} />);

    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /错误响应/u }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText(/validation failed/u)).length).toBeGreaterThan(0);
    expect(screen.getByText('此载荷已截断')).toBeInTheDocument();
    expect(screen.getByText(/以下内容不是完整响应/u)).toBeInTheDocument();
  });

  it('distinguishes SUCCESS, UNKNOWN, and PARTIAL without treating uncertainty as Salesforce failure', () => {
    const success = traceWithTerminal('SUCCESS', 'PASS');
    const { unmount } = renderAdmin(<AuditTraceWorkbench trace={success} />);
    expect(screen.getByText('未发现执行错误')).toBeInTheDocument();
    expect(screen.getByText('成功')).toBeInTheDocument();
    unmount();

    const unknown = traceWithTerminal('UNKNOWN', 'ERROR', 'MCP_DML_OUTCOME_UNKNOWN');
    const unknownRender = renderAdmin(<AuditTraceWorkbench trace={unknown} />);
    expect(screen.getByText('操作结果未知（UNKNOWN）')).toBeInTheDocument();
    expect(screen.getByText(/这不代表 Salesforce 操作失败/u)).toBeInTheDocument();
    expect(screen.getAllByText('未知').length).toBeGreaterThan(0);
    unknownRender.unmount();

    const partial = traceWithTerminal('SUCCESS', 'PASS');
    renderAdmin(<AuditTraceWorkbench trace={{
      ...partial,
      audit: { ...partial.audit, auditIntegrityStatus: 'PARTIAL' },
      summary: { ...partial.summary, detailsTruncated: true },
    }} />);
    expect(screen.getByText('审计证据不完整')).toBeInTheDocument();
  });

  it('keeps Buntu identity validation troubleshooting fields in the simplified audit view', () => {
    const base = traceWithTerminal('SUCCESS', 'PASS');
    const trace: AdminAuditTraceDto = {
      ...base,
      audit: {
        ...base.audit,
        auditKind: 'IDENTITY_VALIDATION', toolName: null, operation: 'BUNTU_TOKEN_VALIDATE', identitySource: 'BUNTU_TOKEN',
        platformUserId: 'platform-buntu', requestSummary: {
          tokenLast4: 'wxyz', tokenFingerprint: `sha256:${'a'.repeat(64)}`,
          validationUrl: 'https://buntu.example.test/validate', rawToken: 'opt-in-token',
        },
        responseSummary: { valid: true, httpStatus: 200, userId: 'platform-buntu' },
      },
    };
    renderAdmin(<AuditTraceWorkbench trace={trace} />);
    expect(screen.getByText('小犇 Token 校验详情')).toBeInTheDocument();
    expect(screen.getByText('wxyz')).toBeInTheDocument();
    expect(screen.getByText(`sha256:${'a'.repeat(64)}`)).toBeInTheDocument();
    expect(screen.getByText('原始 Token 已记录')).toBeInTheDocument();
  });

  it('copies SOQL and Salesforce API URLs with user feedback', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderAdmin(<AuditTraceWorkbench trace={traceFixture()} />);

    fireEvent.click(screen.getByRole('button', { name: '复制SOQL' }));
    fireEvent.click(screen.getAllByRole('button', { name: '复制URL' })[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenCalledWith('SELECT Id FROM Contact LIMIT 2');
    expect(String(writeText.mock.calls[1]?.[0])).toContain('/services/data/');
  });

  it('restores selected Audit and filters from the URL without refetching the list for selection', async () => {
    const trace = traceWithTerminal('SUCCESS', 'PASS');
    const fetchMock = asFetchMock((url) => {
      if (url.pathname.endsWith('/audits/1/trace')) return jsonResponse(trace);
      if (url.pathname.endsWith('/audits')) return jsonResponse(page([trace.audit]));
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<><AuditPage /><LocationProbe /></>, '/audit?toolName=create_record');

    expect(await screen.findByText('未发现执行错误')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('selected=1'));
    const listRequests = fetchMock.mock.calls.filter(([input]) => new URL(String(input), 'http://localhost').pathname.endsWith('/audits'));
    expect(listRequests).toHaveLength(1);
    expect(String(listRequests[0]?.[0])).toContain('toolName=create_record');
  });

  it('writes submitted filters into the URL for refresh/back/share state', async () => {
    const fetchMock = asFetchMock((url) => url.pathname.endsWith('/audits') ? jsonResponse(page([])) : jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<><AuditPage /><LocationProbe /></>, '/audit');

    await screen.findByText('没有匹配当前筛选条件的审计记录。');
    fireEvent.change(screen.getByLabelText('快速搜索（Tool）'), { target: { value: 'update_record' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索审计' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('toolName=update_record'));
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function page<T>(items: readonly T[]) {
  return { items, limit: 25, offset: 0, count: items.length, hasMore: false, nextOffset: null };
}

function traceWithTerminal(
  outcome: 'SUCCESS' | 'UNKNOWN',
  result: 'PASS' | 'ERROR',
  errorCode: string | null = null,
): AdminAuditTraceDto {
  const fixture = traceFixture();
  return {
    ...fixture,
    audit: { ...fixture.audit, outcome, result, errorCode, errorMessageSafe: errorCode ? 'commit state unknown' : null },
    summary: { ...fixture.summary, eventCount: 0, apiCount: 0, soqlCount: 0, dmlCount: 0, errorCount: errorCode ? 1 : 0, payloadCount: 0 },
    firstFailure: errorCode ? {
      source: 'AUDIT_CALL', sequence: null, title: 'create_record', status: outcome,
      errorCode, message: 'commit state unknown', eventId: null, salesforceApiCallId: null,
    } : null,
    events: [],
    salesforceApiCalls: [],
    payloadMetadata: [],
  };
}

function traceFixture(withPayload = false): AdminAuditTraceDto {
  return {
    audit: {
      id: '1', publicAuditId: '11111111-1111-4111-8111-111111111111', auditKind: 'MCP_TOOL_CALL',
      occurredAt: NOW, startedAt: NOW, completedAt: NOW, correlationId: 'corr-1', channel: 'MCP', clientId: 'client-a', actorAdmin: null,
      platformUserId: 'platform-a', salesforceUsername: 'sf-user@example.com', executionRole: 'USER', identitySource: 'USER_BOUND_TOKEN', identityCredentialId: '1',
      toolName: 'create_record', operation: 'CREATE', objectApiName: 'Lead', recordId: null, result: 'ERROR', outcome: 'FAILED',
      errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', errorMessageSafe: 'validation failed', auditIntegrityStatus: 'COMPLETE', durationMs: 420,
      requestSummary: null, responseSummary: null, createdAt: NOW,
    },
    summary: {
      eventCount: 1, apiCount: 2, soqlCount: 1, dmlCount: 1, errorCount: 1, payloadCount: withPayload ? 1 : 0, detailsTruncated: false,
    },
    firstFailure: {
      source: 'SALESFORCE_API', sequence: 5, title: 'CREATE · Lead', status: 'FAILED',
      errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'validation failed', eventId: null, salesforceApiCallId: '21',
    },
    events: [{
      id: '10', auditId: '1', sequence: 1, parentEventId: null, eventCategory: 'MCP', eventType: 'MCP_REQUEST_RECEIVED', eventName: 'MCP 请求已接收',
      startedAt: NOW, completedAt: NOW, durationMs: 1, status: 'SUCCESS', errorCode: null, safeSummary: {}, createdAt: NOW,
    }],
    salesforceApiCalls: [
      {
        id: '20', publicApiCallId: '22222222-2222-4222-8222-222222222220', auditId: '1', auditEventId: null, sequence: 3,
        salesforceUsername: 'sf-user@example.com', transportKind: 'JSFORCE', visibility: 'EXACT_HTTP', apiCategory: 'REST_API', httpMethod: 'GET',
        endpoint: '/query', requestUrl: 'https://example.my.salesforce.com/services/data/v67.0/query?q=...', host: 'example.my.salesforce.com', endpointPath: '/services/data/v67.0/query?q=...',
        operationName: null, apiVersion: '67.0', purpose: 'SERVER_MANAGED_LOOKUP', startedAt: NOW, completedAt: NOW, durationMs: 120, httpStatus: 200,
        result: 'SUCCESS', salesforceErrorCode: null, salesforceErrorMessageSafe: null, requestSizeBytes: null, responseSizeBytes: '64', contentType: 'application/json',
        queryType: 'DATA_SOQL', soqlStatementSafe: 'SELECT Id FROM Contact LIMIT 2', totalSize: 1, returnedRecords: 1, done: true, hasNextRecords: false,
        dmlOperation: null, objectApiName: 'Contact', recordId: null, requestedFields: null, managedFields: null, submittedFields: null, createdAt: NOW,
      },
      {
        id: '21', publicApiCallId: '22222222-2222-4222-8222-222222222221', auditId: '1', auditEventId: null, sequence: 5,
        salesforceUsername: 'sf-user@example.com', transportKind: 'JSFORCE', visibility: 'EXACT_HTTP', apiCategory: 'REST_API', httpMethod: 'POST',
        endpoint: '/sobjects/Lead', requestUrl: 'https://example.my.salesforce.com/services/data/v67.0/sobjects/Lead', host: 'example.my.salesforce.com', endpointPath: '/services/data/v67.0/sobjects/Lead',
        operationName: null, apiVersion: '67.0', purpose: 'DML_CREATE', startedAt: NOW, completedAt: NOW, durationMs: 180, httpStatus: 400,
        result: 'FAILED', salesforceErrorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', salesforceErrorMessageSafe: 'validation failed', requestSizeBytes: '40', responseSizeBytes: '34', contentType: 'application/json',
        queryType: null, soqlStatementSafe: null, totalSize: null, returnedRecords: null, done: null, hasNextRecords: null,
        dmlOperation: 'CREATE', objectApiName: 'Lead', recordId: null,
        requestedFields: { Company: 'ABC' }, managedFields: { Lead_Owner__c: '003MANAGED' }, submittedFields: { Company: 'ABC', Lead_Owner__c: '003MANAGED' }, createdAt: NOW,
      },
    ],
    payloadMetadata: withPayload ? [{
      id: '30', auditId: '1', salesforceApiCallId: '21', auditEventId: null, payloadType: 'ERROR_RESPONSE', contentType: 'application/json',
      originalSizeBytes: '34', storedSizeBytes: 34, truncated: false, contentSha256: 'a'.repeat(64), createdAt: NOW,
    }] : [],
  };
}
