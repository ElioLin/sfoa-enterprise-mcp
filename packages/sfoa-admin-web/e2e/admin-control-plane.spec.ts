import { expect, test, type Route } from '@playwright/test';

const NOW = '2026-08-23T12:00:00.000Z';

test('admin can manage the bounded control plane and logout', async ({ page }) => {
  const api = new StatefulAdminApi();
  await page.route('**/admin/api/**', (route) => api.handle(route));

  await page.goto('/login');
  await page.getByLabel('Admin username').fill('bootstrap-admin');
  await page.getByLabel('Password').fill('test-only-password');
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page.getByRole('heading', { name: 'Operational overview' })).toBeVisible();

  await page.getByRole('link', { name: 'Identity routes' }).click();
  await page.getByRole('button', { name: 'Create route' }).click();
  await page.getByLabel('Platform user ID').fill('platform-e2e');
  await page.getByLabel('Salesforce username').fill('user-e2e@example.com');
  await page.getByLabel('Remark').fill('created by browser test');
  await page.getByRole('button', { name: 'Save route' }).click();
  await expect(page.getByText('platform-e2e')).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Remark').fill('updated by browser test');
  await page.getByRole('button', { name: 'Save route' }).click();
  await expect(page.getByText('updated by browser test')).toBeVisible();

  await page.getByRole('link', { name: 'Tool governance' }).click();
  await page.getByRole('switch', { name: 'Enable get_record_context' }).click();
  await expect(page.getByRole('switch', { name: 'Disable get_record_context' })).toBeChecked();

  await page.getByRole('link', { name: 'DML policies' }).click();
  await page.getByRole('button', { name: 'Add object policy' }).click();
  await page.getByLabel('Object API name').fill('Lead');
  const policyDialog = page.getByRole('dialog');
  await policyDialog.getByRole('switch').nth(0).click();
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByText('Lead')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'ALLOWED' }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Diagnostic' }).click();
  await page.getByRole('button', { name: 'Verify Diagnostic Connection' }).click();
  await expect(page.getByText('Latest verification evidence')).toBeVisible();
  await expect(page.getByText('1/1 cleaned; 0 active')).toBeVisible();

  await page.getByRole('link', { name: 'Audit' }).click();
  await page.getByRole('textbox', { name: 'Tool', exact: true }).fill('run_soql_query');
  await page.getByRole('button', { name: 'Search audit' }).click();
  await expect(page.getByText('correlation-e2e')).toBeVisible();
  await expect.poll(() => api.lastAuditToolFilter).toBe('run_soql_query');

  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
});

class StatefulAdminApi {
  private loggedIn = false;
  private route: Record<string, unknown> | null = null;
  private policy: Record<string, unknown> | null = null;
  private toolEnabled = false;
  public lastAuditToolFilter: string | null = null;

  public async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/admin/api', '');
    const method = request.method();

    if (path === '/auth/login' && method === 'POST') {
      this.loggedIn = true;
      await respond(route, session());
      return;
    }
    if (path === '/auth/me') {
      if (this.loggedIn) await respond(route, session());
      else await respond(route, errorBody('MCP_ADMIN_UNAUTHORIZED'), 401);
      return;
    }
    if (path === '/auth/logout' && method === 'POST') {
      this.loggedIn = false;
      await respond(route, undefined, 204);
      return;
    }
    if (!this.loggedIn) {
      await respond(route, errorBody('MCP_ADMIN_UNAUTHORIZED'), 401);
      return;
    }
    if (path === '/dashboard') {
      await respond(route, dashboard());
      return;
    }
    if (path === '/routes' && method === 'GET') {
      await respond(route, pageOf(this.route ? [this.route] : []));
      return;
    }
    if (path === '/routes' && method === 'POST') {
      this.route = { id: '1', ...request.postDataJSON(), rowVersion: '1', createdAt: NOW, updatedAt: NOW };
      await respond(route, this.route, 201);
      return;
    }
    if (path === '/routes/1' && method === 'PUT') {
      const input = request.postDataJSON() as Record<string, unknown>;
      this.route = { id: '1', ...input, rowVersion: '2', createdAt: NOW, updatedAt: NOW };
      await respond(route, this.route);
      return;
    }
    if (path === '/tools' && method === 'GET') {
      await respond(route, { items: [toolRecord(this.toolEnabled)], controlsTruncated: false });
      return;
    }
    if (path === '/tools/get_record_context' && method === 'PUT') {
      this.toolEnabled = Boolean((request.postDataJSON() as Record<string, unknown>).enabled);
      await respond(route, { id: '1', toolName: 'get_record_context', enabled: this.toolEnabled, remark: null, rowVersion: '2', createdAt: NOW, updatedAt: NOW });
      return;
    }
    if (path === '/dml-policies' && method === 'GET') {
      await respond(route, pageOf(this.policy ? [this.policy] : []));
      return;
    }
    if (path === '/dml-policies' && method === 'POST') {
      this.policy = { id: '1', ...request.postDataJSON(), rowVersion: '1', createdAt: NOW, updatedAt: NOW };
      await respond(route, this.policy, 201);
      return;
    }
    if (path === '/diagnostic' && method === 'GET') {
      await respond(route, { config: diagnosticConfig(), configured: { connectedApp: true, jwtPrivateKey: true } });
      return;
    }
    if (path === '/diagnostic/verify' && method === 'POST') {
      await respond(route, { config: diagnosticConfig(), verification: diagnosticVerification() });
      return;
    }
    if (path === '/audits' && method === 'GET') {
      this.lastAuditToolFilter = url.searchParams.get('toolName');
      await respond(route, pageOf([auditRecord()]));
      return;
    }
    await respond(route, errorBody('MCP_ADMIN_NOT_FOUND'), 404);
  }
}

async function respond(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: body === undefined ? '' : JSON.stringify(body),
    headers: { 'Cache-Control': 'no-store' },
  });
}

function session() {
  return { username: 'bootstrap-admin', csrfToken: 'csrf-e2e', expiresAt: Date.now() + 300_000 };
}

function pageOf(items: readonly unknown[]) {
  return { items, limit: 25, offset: 0, count: items.length, hasMore: false, nextOffset: null };
}

function dashboard() {
  return {
    runtimeHealth: 'UP', databaseHealth: 'UP', upstreamDrift: 'PASS', routeCount: 0, enabledToolCount: 0, dmlPolicyObjectCount: 0,
    diagnostic: diagnosticConfig(), calls24h: { total: 1, pass: 1, blocked: 0, error: 0, unknown: 0 }, latestErrors: [],
    providerVersions: [{ name: 'salesforce', version: '1.0.0' }],
  };
}

function toolRecord(enabled: boolean) {
  return {
    toolName: 'get_record_context', classification: 'READ', executionRole: 'USER', remoteCompatible: true, releaseState: 'GA',
    enabled, rowVersion: '1', remark: null, dependencies: [], status: enabled ? 'AVAILABLE' : 'DISABLED', enableAllowed: true, disabledReason: null,
  };
}

function diagnosticConfig() {
  return {
    id: '1', salesforceUsername: 'diagnostic@example.com', enabled: true, verificationStatus: 'NOT_VERIFIED', lastVerifiedAt: null,
    lastErrorCode: null, lastErrorMessageSafe: null, testMetadataType: 'CustomObject', testMetadataFullName: 'Account', rowVersion: '1', createdAt: NOW, updatedAt: NOW,
  };
}

function diagnosticVerification() {
  return {
    status: 'PASS', identityMatched: true, salesforceUsername: 'diagnostic@example.com', apiVersion: '65.0', durationMs: 80,
    tooling: { totalSize: 1, returnedRecords: 1, truncated: false },
    metadata: { status: 'PASS', metadataType: 'CustomObject', fullName: 'Account', totalFiles: 1, returnedFiles: 1, returnedBytes: 64, truncated: false },
    cleanup: { created: 1, cleaned: 1, active: 0, pass: true }, error: null,
  };
}

function auditRecord() {
  return {
    id: '1', occurredAt: NOW, correlationId: 'correlation-e2e', channel: 'MCP', clientId: 'client-e2e', actorAdmin: null,
    platformUserId: 'platform-e2e', salesforceUsername: 'user-e2e@example.com', executionRole: 'USER', toolName: 'run_soql_query', operation: 'READ',
    objectApiName: null, recordId: null, result: 'PASS', outcome: 'SUCCESS', errorCode: null, durationMs: 4,
    requestSummary: { querySha256: 'abcd', queryLength: 24 }, responseSummary: { returnedRecords: 1 }, createdAt: NOW,
  };
}

function errorBody(code: string) {
  return { error: { code, message: 'Request denied safely.' }, correlationId: 'correlation-e2e-error' };
}
