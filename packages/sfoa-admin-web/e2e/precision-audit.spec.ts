import { expect, test } from '@playwright/test';

test('precise form facts load on demand and remain readable on a narrow audit screen', async ({ page }, testInfo) => {
  const now = '2026-11-06T00:00:00.000Z';
  const audit = {
    id: '1', publicAuditId: '11111111-1111-4111-8111-111111111111', auditKind: 'MCP_TOOL_CALL',
    occurredAt: now, startedAt: now, completedAt: now, correlationId: 'form-context-demo', channel: 'MCP', clientId: 'fixture',
    actorAdmin: null, platformUserId: 'fixture-user', salesforceUsername: 'fixture@example.invalid', executionRole: 'USER',
    identitySource: 'USER_BOUND_TOKEN', identityCredentialId: null, toolName: 'get_record_action_context', operation: 'UPDATE',
    objectApiName: 'Example__c', recordId: 'a00000000000001AAA', result: 'PASS', outcome: 'SUCCESS', errorCode: null,
    errorMessageSafe: null, auditIntegrityStatus: 'COMPLETE', durationMs: 650, requestSummary: null,
    responseSummary: { formReadinessStatus: 'UNKNOWN' }, createdAt: now,
  };
  const metadata = {
    id: '30', auditId: '1', salesforceApiCallId: null, auditEventId: '10', payloadType: 'UI_CONTEXT',
    contentType: 'application/json', originalSizeBytes: '1024', storedSizeBytes: 1024, truncated: false,
    contentSha256: 'a'.repeat(64), createdAt: now,
  };
  const trace = { audit, summary: { eventCount: 1, apiCount: 0, soqlCount: 0, dmlCount: 0, errorCount: 0, payloadCount: 1,
    detailsTruncated: false }, firstFailure: null, salesforceApiCalls: [], payloadMetadata: [metadata],
    events: [{ id: '10', auditId: '1', sequence: 1, parentEventId: null, eventCategory: 'TOOL',
      eventType: 'UI_CONTEXT_RESOLVED', eventName: 'UI Context', startedAt: now, completedAt: now, durationMs: 650,
      status: 'SUCCESS', errorCode: null, createdAt: now, safeSummary: { action: 'UPDATE', entry: 'STANDARD',
        formReadinessStatus: 'UNKNOWN', app: 'Sales', appSource: 'PROFILE_DEFAULT', page: 'Example_Record_Page',
        pageLayoutId: '00h000000000001AAA', missingRequiredCount: 1, criticalUnknownCount: 1 } }],
  };
  let payloadReads = 0;
  await page.route('**/admin/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path.endsWith('/auth/me')) body = { username: 'test-admin', csrfToken: 'test-csrf', expiresAt: Date.now() + 300000, modules: ['audit'] };
    else if (path.endsWith('/audits/1/trace')) body = trace;
    else if (path.endsWith('/audits')) body = { items: [audit], limit: 25, offset: 0, count: 1, hasMore: false, nextOffset: null };
    else if (path.endsWith('/audit-payloads/30')) {
      payloadReads++;
      body = { ...metadata, safePayload: JSON.stringify({ formReadinessStatus: 'UNKNOWN', missingRequired: ['Reason__c'],
        criticalUnknown: ['RELATED_VALUE_UNAVAILABLE'], fields: [{ apiName: 'Reason__c', label: '变更原因', required: true,
          visibility: 'VISIBLE', requiredSource: ['DYNAMIC_FORM'], writable: true, valueState: 'EMPTY', valueSource: 'CLIENT_DRAFT' }],
        initialFacts: [{ path: 'Record.Category__c', value: '已读取的分类样例', source: 'SAVED_RECORD', resolutionStatus: 'RESOLVED' }],
        rules: [{ apiName: 'Reason__c', instanceId: 'field-reason', ruleResult: 'VISIBLE', evaluations: [{ scope: 'FIELD',
          state: 'VISIBLE', criteria: [{ path: 'Record.Category__c', operator: 'EQUAL', expected: '已读取的分类样例', state: 'VISIBLE', reasons: [] }],
          dependencies: [{ path: 'Record.Category__c', value: '已读取的分类样例', source: 'SAVED_RECORD' }] }] }],
      }) };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/audit?selected=1');
  await expect(page.getByText('表单必填判断存在未知项')).toBeVisible();
  await expect(page.getByText('未发现执行错误')).toHaveCount(0);
  expect(payloadReads).toBe(0);
  await expect(page.getByText('已读取的分类样例', { exact: true })).toHaveCount(0);
  await page.getByText('字段依据（按需加载）').click();
  await page.getByRole('button', { name: '查看字段 / Required 来源 / Visibility / Dependency / Section' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '表单判定依据' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('客户端草稿（作者未验证） · CLIENT_DRAFT')).toBeVisible();
  expect(payloadReads).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('form-audit-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog').getByRole('heading', { name: '表单判定依据' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('form-audit-mobile.png'), fullPage: true });
});
