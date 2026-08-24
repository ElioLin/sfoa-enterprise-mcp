import { expect, test, type Route } from '@playwright/test';

const NOW = '2026-08-23T12:00:00.000Z';

test('admin can manage the bounded control plane and logout', async ({ page }) => {
  const api = new StatefulAdminApi();
  await page.route('**/admin/api/**', (route) => api.handle(route));

  await page.goto('/login');
  await page.getByLabel('管理员用户名').fill('bootstrap-admin');
  await page.getByLabel('密码').fill('test-only-password');
  await page.getByRole('button', { name: '安全登录' }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();

  await page.getByRole('link', { name: '用户身份路由' }).click();
  await page.getByRole('button', { name: '新建路由' }).click();
  await page.getByLabel('平台用户 ID').fill('platform-e2e');
  await page.getByLabel('Salesforce Username').fill('user-e2e@example.com');
  await page.getByLabel('备注').fill('created by browser test');
  await page.getByRole('button', { name: '保存路由' }).click();
  await expect(page.getByText('platform-e2e')).toBeVisible();
  await page.getByRole('button', { name: '编辑' }).click();
  await page.getByLabel('备注').fill('updated by browser test');
  await page.getByRole('button', { name: '保存路由' }).click();
  await expect(page.getByText('updated by browser test')).toBeVisible();

  await page.getByRole('link', { name: '工具治理' }).click();
  await page.getByRole('switch', { name: '启用 get_record_action_context' }).click();
  await expect(page.getByRole('switch', { name: '停用 get_record_action_context' })).toBeChecked();

  await page.getByRole('link', { name: 'DML 操作策略' }).click();
  await page.getByRole('button', { name: '添加对象策略' }).click();
  await page.getByLabel('对象 API 名称').fill('Lead');
  const policyDialog = page.getByRole('dialog');
  await policyDialog.getByRole('switch').nth(0).click();
  await page.getByRole('button', { name: '保存策略' }).click();
  await expect(page.getByText('Lead')).toBeVisible();
  await expect(page.getByRole('cell', { name: '已允许' }).first()).toBeVisible();

  await page.getByRole('link', { name: '系统诊断' }).click();
  await page.getByRole('button', { name: '验证 Diagnostic Connection' }).click();
  await expect(page.getByText('最新验证证据')).toBeVisible();
  await expect(page.getByText('1/1 已清理；0 个活动')).toBeVisible();

  await page.getByRole('link', { name: '调用审计' }).click();
  await page.getByRole('textbox', { name: 'Tool', exact: true }).fill('run_soql_query');
  await page.getByRole('button', { name: '搜索审计' }).click();
  await expect(page.getByText('correlation-e2e')).toBeVisible();
  await expect.poll(() => api.lastAuditToolFilter).toBe('run_soql_query');

  await page.getByRole('link', { name: '智能体接入' }).click();
  await expect(page.getByRole('heading', { level: 2, name: '智能体接入' })).toBeVisible();
  await expect(page.getByText('MCP_BIND_HOST', { exact: true })).toBeVisible();
  await page.getByLabel('外部 MCP 地址').fill('https://mcp.company.com/mcp');
  await expect(page.locator('pre').filter({ hasText: 'URL:\nhttps://mcp.company.com/mcp' })).toBeVisible();
  await page.getByRole('tab', { name: 'Dify 指令' }).click();
  await expect(page.locator('pre').filter({ hasText: '你是企业 Salesforce 助手。' })).toBeVisible();
  await page.getByRole('tab', { name: 'Skill' }).click();
  await expect(page.getByText('.codebuddy/skills/sfoa-salesforce-assistant/', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
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
    if (path === '/system/status') {
      await respond(route, systemStatus());
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
    if (path === '/tools/get_record_action_context' && method === 'PUT') {
      this.toolEnabled = Boolean((request.postDataJSON() as Record<string, unknown>).enabled);
      await respond(route, { id: '1', toolName: 'get_record_action_context', enabled: this.toolEnabled, remark: null, rowVersion: '2', createdAt: NOW, updatedAt: NOW });
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

function systemStatus() {
  return {
    adminVersion: '0.1.0-p5', mcpServerVersion: '0.1.0-p5', salesforceApiVersion: '65.0',
    providerVersions: [{ name: 'salesforce', version: '1.0.0' }], upstreamDrift: { status: 'PASS', count: 0 },
    database: { status: 'UP', version: '8.0', schemaVersions: ['001_p5_control_plane', '002_p5_indexes'] },
    runtimeMode: 'mysql', salesforceInstanceHost: 'example.my.salesforce.com',
    configured: { connectedApp: true, jwtPrivateKey: true, mcpClientToken: true }, diagnostic: diagnosticConfig(),
    mcpHealth: 'UP', auditPersistence: { status: 'UP', failureCount: 0 }, mcpEndpoint: 'http://127.0.0.1:8080/mcp',
    phases: { P0: 'FINAL ACCEPTED', P1: 'FINAL ACCEPTED', P2: 'FINAL ACCEPTED', P3: 'FINAL ACCEPTED', P4: 'FINAL ACCEPTED', P5: 'FINAL ACCEPTED' },
    readOnlyRuntimeSettings: {
      MCP_BIND_HOST: '127.0.0.1', MCP_PORT: 8080, MCP_PATH: '/mcp', MCP_AUTH_MODE: 'internal_bearer',
      MCP_ALLOWED_HOSTS: ['127.0.0.1:8080'], MCP_ALLOWED_ORIGINS: ['http://127.0.0.1:5173'],
    },
  };
}

function toolRecord(enabled: boolean) {
  return {
    toolName: 'get_record_action_context', classification: 'READ', executionRole: 'USER', remoteCompatible: true, releaseState: 'GA',
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
