import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AuditPage from '../pages/AuditPage.js';
import DiagnosticPage from '../pages/DiagnosticPage.js';
import DmlPoliciesPage from '../pages/DmlPoliciesPage.js';
import IdentityRoutesPage from '../pages/IdentityRoutesPage.js';
import SystemPage from '../pages/SystemPage.js';
import ToolGovernancePage from '../pages/ToolGovernancePage.js';
import { apiError, asFetchMock, jsonResponse, renderAdmin } from './helpers.js';

const NOW = '2026-08-23T12:00:00.000Z';

describe('Admin governance pages', () => {
  it('creates an identity route through the shared API client', async () => {
    const clipboardWrite = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/system/settings')) return jsonResponse([]);
      if (url.pathname.endsWith('/routes') && init.method === 'POST') return jsonResponse(credentialResponse());
      if (url.pathname.endsWith('/credential/regenerate') && init.method === 'POST') return jsonResponse(credentialResponse('b'));
      if (url.pathname.endsWith('/routes/1/credential')) return jsonResponse(credentialResponse());
      return jsonResponse(page([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboardWrite } });
    renderAdmin(<IdentityRoutesPage />);

    await user.click(await screen.findByRole('button', { name: '新建身份路由' }));
    await user.type(screen.getByLabelText('用户名称'), '用户 A');
    await user.type(screen.getByLabelText('平台用户 ID'), 'platform-a');
    await user.type(screen.getByLabelText('Salesforce Username'), 'sf-user@example.com');
    await user.type(screen.getByLabelText('备注'), 'production route');
    await user.click(screen.getByRole('button', { name: '保存路由' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/routes') && init?.method === 'POST')).toBe(true));
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/routes') && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({ platformUserId: 'platform-a', userName: '用户 A', salesforceUsername: 'sf-user@example.com', enabled: true });
    expect(await screen.findByText('MCP 接入配置')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /复制 Token/u }));
    await user.click(screen.getByRole('button', { name: /复制 Authorization/u }));
    await user.click(screen.getByRole('button', { name: /复制 WorkBuddy MCP JSON/u }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(3));
    expect(clipboardWrite.mock.calls[2]?.[0]).not.toContain('X-Platform-User-Id');
    await user.click(screen.getByRole('button', { name: /重新生成 Token/u }));
    await user.click(await screen.findByRole('button', { name: '确定重新生成' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/credential/regenerate') && init?.method === 'POST')).toBe(true));
  });

  it('uses the runtime page size, true total, and resets to page one for explicit keyword search', async () => {
    const fetchMock = asFetchMock((url) => {
      if (url.pathname.endsWith('/system/settings')) return jsonResponse([{ settingKey: 'adminDefaultPageSize', settingValue: 20, rowVersion: '1', updatedAt: NOW }]);
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '25');
      return jsonResponse({ ...page([routeRecord()]), limit, offset, total: 45, hasMore: offset + 1 < 45, nextOffset: offset + 1 < 45 ? offset + 1 : null });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<IdentityRoutesPage />);

    await screen.findByText('platform-a');
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => new URL(String(url), 'http://test').searchParams.get('limit') === '20')).toBe(true));
    expect(screen.getByText(/共 45 条/u)).toBeInTheDocument();
    await user.click(screen.getByTitle('下一页'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => new URL(String(url), 'http://test').searchParams.get('offset') === '20')).toBe(true));
    await user.type(screen.getByLabelText('搜索用户名称 / 平台用户 / Salesforce Username / 备注'), '  sf-user@example.com  ');
    await user.click(screen.getByRole('button', { name: /搜索$/u }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => {
      const parsed = new URL(String(url), 'http://test');
      return parsed.searchParams.get('keyword') === 'sf-user@example.com' && parsed.searchParams.get('offset') === '0';
    })).toBe(true));
  });

  it('keeps stop and permanent delete behind explicit confirmations and exposes delete only for disabled routes', async () => {
    const enabled = routeRecord();
    const disabled = routeRecord({ id: '2', platformUserId: 'platform-b', enabled: false });
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/system/settings')) return jsonResponse([]);
      if (url.pathname.endsWith('/routes/2') && init.method === 'DELETE') return jsonResponse({ status: 'DELETED', routeId: '2' });
      return jsonResponse(page([enabled, disabled]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<IdentityRoutesPage />);

    await screen.findByText('platform-a');
    await user.click(screen.getByRole('button', { name: '更多操作 platform-a' }));
    expect(await screen.findByText('停用路由')).toBeInTheDocument();
    expect(screen.queryByText('删除路由')).not.toBeInTheDocument();
    await user.click(screen.getByText('停用路由'));
    expect(await screen.findByText('USER_BOUND Token 将立即不可使用。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /取\s*消/u }));

    await user.click(screen.getByRole('button', { name: '更多操作 platform-b' }));
    await user.click(await screen.findByText('删除路由'));
    expect(await screen.findByText('此操作不可撤销。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '永久删除' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/routes/2') && init?.method === 'DELETE')).toBe(true));
  });

  it('renders an unknown executable control as impossible to enable', async () => {
    vi.stubGlobal('fetch', asFetchMock(() => jsonResponse({
      items: [{
        toolName: 'future_unknown_tool', classification: 'UNKNOWN', executionRole: 'USER', remoteCompatible: false,
        releaseState: 'UNKNOWN', enabled: false, rowVersion: '1', remark: null, dependencies: [], status: 'UNKNOWN',
        enableAllowed: false, disabledReason: 'Unknown executable catalog entry.',
      }],
      controlsTruncated: false,
    })));
    renderAdmin(<ToolGovernancePage />);

    const toggle = await screen.findByRole('switch', { name: '启用 future_unknown_tool' });
    expect(toggle).toBeDisabled();
    expect(screen.getByText('未知的可执行目录项。')).toBeInTheDocument();
  });

  it('saves independent CREATE and UPDATE policy toggles', async () => {
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/dml-policies') && init.method === 'POST') return jsonResponse(policyRecord());
      return jsonResponse(page([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<DmlPoliciesPage />);

    await user.click(await screen.findByRole('button', { name: '添加对象策略' }));
    await user.type(screen.getByLabelText('对象 API 名称'), 'Lead');
    const dialog = screen.getByRole('dialog');
    const toggles = within(dialog).getAllByRole('switch');
    expect(toggles).toHaveLength(3);
    await user.click(toggles[0]!);
    await user.click(screen.getByRole('button', { name: '保存策略' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/dml-policies') && init?.method === 'POST')).toBe(true));
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/dml-policies') && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ objectApiName: 'Lead', allowCreate: true, allowUpdate: false, enabled: true, remark: null });
  });

  it('manages trusted fields in the policy drawer with duplicate validation and disable/delete semantics', async () => {
    const enabledRule = managedFieldRecord();
    const disabledRule = managedFieldRecord({ id: '8', targetFieldApiName: 'Created_By_AI__c', strategy: 'AI_CREATED_MARKER', enabled: false });
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/managed-fields') && init.method === 'POST') {
        return jsonResponse(managedFieldRecord({ id: '9', targetFieldApiName: 'Owner_Contact__c' }));
      }
      if (url.pathname.endsWith('/managed-fields')) return jsonResponse(page([enabledRule, disabledRule]));
      return jsonResponse(page([policyRecord()]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<DmlPoliciesPage />);

    await user.click(await screen.findByRole('button', { name: '管理 Lead 的托管字段' }));
    expect(await screen.findByText('值由 MCP 管理')).toBeInTheDocument();
    const enabledRuleRow = screen.getByText('Requested_By__c').closest('tr');
    const disabledRuleRow = screen.getByText('Created_By_AI__c').closest('tr');
    expect(enabledRuleRow).not.toBeNull();
    expect(disabledRuleRow).not.toBeNull();
    expect(within(enabledRuleRow!).getByRole('button', { name: /停用/ })).toBeInTheDocument();
    expect(within(disabledRuleRow!).getByRole('button', { name: /删除/ })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /添加规则/ })[0]!);
    const target = screen.getByLabelText('目标字段 API 名称');
    await user.type(target, 'requested_by__c');
    fireEvent.blur(target);
    expect(await screen.findByText('该对象已存在同名托管字段规则。')).toBeInTheDocument();
    await user.clear(target);
    await user.type(target, 'Owner_Contact__c');
    await user.type(screen.getByLabelText('Lookup 对象 API 名称'), 'Contact');
    await user.type(screen.getByLabelText('身份匹配字段 API 名称'), 'Platform_User_Id__c');
    await user.click(screen.getByRole('button', { name: '保存规则' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/dml-policies/1/managed-fields') && init?.method === 'POST')).toBe(true));
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/dml-policies/1/managed-fields') && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      targetFieldApiName: 'Owner_Contact__c',
      strategy: 'PLATFORM_USER_LOOKUP',
      applyOnCreate: true,
      applyOnUpdate: false,
      lookupObjectApiName: 'Contact',
      lookupMatchFieldApiName: 'Platform_User_Id__c',
      enabled: true,
    });
  });

  it('shows the real diagnostic verification state and bounded evidence', async () => {
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/diagnostic/verify') && init.method === 'POST') return jsonResponse({ config: diagnosticConfig(), verification: diagnosticVerification() });
      return jsonResponse({ config: diagnosticConfig(), configured: { connectedApp: true, jwtPrivateKey: true } });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<DiagnosticPage />);

    fireEvent.click(await screen.findByRole('button', { name: '验证 Diagnostic Connection' }));
    expect(await screen.findByText('最新验证证据')).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByText('1/1 已清理；0 个活动')).toBeInTheDocument();
  });

  it('requests the next bounded audit page from the server', async () => {
    const fetchMock = asFetchMock((url) => {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const rows = Array.from({ length: 25 }, (_value, index) => auditRecord(String(offset + index + 1)));
      return jsonResponse({ ...page(rows), offset, hasMore: offset === 0, nextOffset: offset === 0 ? 25 : null });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<AuditPage />);

    await screen.findByText('correlation-1');
    fireEvent.click(screen.getByTitle('下一页'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('offset=25'))).toBe(true));
    expect(await screen.findByText('correlation-26')).toBeInTheDocument();
  });

  it('turns HTTP 409 into actionable version-conflict feedback', async () => {
    const fetchMock = asFetchMock((url, init) => {
      if (/\/routes\/1$/u.test(url.pathname) && init.method === 'PUT') return apiError(409, 'MCP_ADMIN_CONCURRENT_MODIFICATION', 'Conflict.');
      if (url.pathname.endsWith('/system/settings')) return jsonResponse([]);
      return jsonResponse(page([routeRecord()]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<IdentityRoutesPage />);

    await user.click(await screen.findByRole('button', { name: /编辑 platform-a/u }));
    await user.click(screen.getByRole('button', { name: '保存路由' }));
    expect(await screen.findByText('配置已变更')).toBeInTheDocument();
    expect(screen.getByText('其他管理员已修改该配置，请刷新最新版本后重新确认。')).toBeInTheDocument();
  });

  it('shows the conflict reason instead of a version-conflict message when route creation returns 409 MCP_CONTROL_PLANE_CONFLICT', async () => {
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/routes') && init.method === 'POST') return apiError(409, 'MCP_CONTROL_PLANE_CONFLICT', 'An identity route already exists for this platform user.');
      if (url.pathname.endsWith('/system/settings')) return jsonResponse([]);
      return jsonResponse(page([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<IdentityRoutesPage />);

    await user.click(await screen.findByRole('button', { name: '新建身份路由' }));
    await user.type(screen.getByLabelText('用户名称'), '用户 A');
    await user.type(screen.getByLabelText('平台用户 ID'), 'platform-a');
    await user.type(screen.getByLabelText('Salesforce Username'), 'sf-user@example.com');
    await user.click(screen.getByRole('button', { name: '保存路由' }));

    expect(await screen.findByText(/该配置与现有数据冲突/u)).toBeInTheDocument();
    expect(screen.queryByText('其他管理员已修改该配置，请刷新最新版本后重新确认。')).not.toBeInTheDocument();
  });

  it('renders the Buntu identity source label and the BUNTU_TOKEN_VALIDATE detail drawer', async () => {
    const rawToken = 'buntu-raw-token-opt-in';
    const record = auditRecord('77', {
      identitySource: 'BUNTU_TOKEN',
      auditKind: 'IDENTITY_VALIDATION',
      clientId: 'xiaoben-buntu-token',
      operation: 'BUNTU_TOKEN_VALIDATE',
      result: 'PASS',
      outcome: 'SUCCESS',
      errorCode: null,
      platformUserId: 'platform-buntu',
      requestSummary: {
        provider: 'BUNTU',
        tokenFingerprint: `sha256:${'a'.repeat(64)}`,
        tokenLast4: 'wxyz',
        validationUrl: 'https://buntu.example.test/validate',
        rawToken,
      },
      responseSummary: { valid: true, httpStatus: 200, userId: 'platform-buntu' },
    });
    const fetchMock = asFetchMock((url) => {
      if (/\/audits\/77\/trace$/u.test(url.pathname)) return jsonResponse({
        audit: record,
        summary: { eventCount: 0, apiCount: 0, soqlCount: 0, dmlCount: 0, errorCount: 0, payloadCount: 0, detailsTruncated: false },
        firstFailure: null,
        events: [],
        salesforceApiCalls: [],
        payloadMetadata: [],
      });
      return jsonResponse(page([record]));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<AuditPage />);

    expect(await screen.findByText('小犇 Token')).toBeInTheDocument();
    expect(await screen.findByText('小犇 Token 校验详情')).toBeInTheDocument();
    expect(screen.getByText('原始 Token 已记录')).toBeInTheDocument();
    expect(screen.getByText(`sha256:${'a'.repeat(64)}`)).toBeInTheDocument();
    expect(screen.getByText('wxyz')).toBeInTheDocument();
    expect(screen.getAllByText('platform-buntu', { selector: 'code' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: '安全请求摘要' }).textContent).toContain(rawToken);
  });

  it('renders only configured state even when an unexpected secret-shaped field exists', async () => {
    const secret = 'SHOULD_NEVER_RENDER_PRIVATE_KEY';
    const fetchMock = asFetchMock((url) => url.pathname.endsWith('/system/settings')
      ? jsonResponse([])
      : jsonResponse({ ...systemStatus(), unexpectedSecret: secret, configured: { connectedApp: true, jwtPrivateKey: true, mcpClientToken: true, identityCredentialEncryptionKey: true, raw: secret } }));
    vi.stubGlobal('fetch', fetchMock);
    const rendered = renderAdmin(<SystemPage />);

    await screen.findByText('数据库与凭据就绪状态');
    expect(rendered.container).not.toHaveTextContent(secret);
    expect(screen.getAllByText('已配置')).toHaveLength(4);
  });
});

function page<T>(items: readonly T[]) {
  return { items, total: items.length, limit: 25, offset: 0, count: items.length, hasMore: false, nextOffset: null };
}

function routeRecord(overrides: Readonly<Partial<{ id: string; platformUserId: string; userName: string; enabled: boolean }>> = {}) {
  return {
    id: overrides.id ?? '1', platformUserId: overrides.platformUserId ?? 'platform-a', userName: overrides.userName ?? '用户 A', salesforceUsername: 'sf-user@example.com', enabled: overrides.enabled ?? true,
    remark: 'production route', rowVersion: '1', createdAt: NOW, updatedAt: NOW,
    credential: { id: '10', status: 'ACTIVE', tokenLast4: 'aaaa', generatedAt: NOW, lastUsedAt: null, rowVersion: '1' },
  };
}

function credentialResponse(tokenMarker = 'a') {
  const route = routeRecord();
  const token = `sfoa_ub1_${tokenMarker.repeat(43)}`;
  const workBuddyJson = JSON.stringify({ mcpServers: { 'enterprise-salesforce': {
    type: 'http', url: 'http://127.0.0.1:8080/mcp', headers: { Authorization: `Bearer ${token}` }, disabled: false,
  } } }, null, 2);
  return {
    route,
    credential: { ...route.credential, token, authorization: `Bearer ${token}`, workBuddyJson },
    mcpEndpoint: { url: 'http://127.0.0.1:8080/mcp', source: 'LOOPBACK_FALLBACK', warning: '当前地址仅适用于本机 MCP Client。' },
  };
}

function policyRecord() {
  return { id: '1', objectApiName: 'Lead', allowCreate: true, allowUpdate: false, enabled: true, remark: null, rowVersion: '1', createdAt: NOW, updatedAt: NOW };
}

function managedFieldRecord(overrides: Readonly<Partial<{
  id: string;
  targetFieldApiName: string;
  strategy: 'PLATFORM_USER_LOOKUP' | 'AI_CREATED_MARKER';
  enabled: boolean;
}>> = {}) {
  const strategy = overrides.strategy ?? 'PLATFORM_USER_LOOKUP';
  return {
    id: overrides.id ?? '7', dmlPolicyId: '1', targetFieldApiName: overrides.targetFieldApiName ?? 'Requested_By__c',
    strategy, applyOnCreate: true, applyOnUpdate: false,
    lookupObjectApiName: strategy === 'PLATFORM_USER_LOOKUP' ? 'Contact' : null,
    lookupMatchFieldApiName: strategy === 'PLATFORM_USER_LOOKUP' ? 'Platform_User_Id__c' : null,
    enabled: overrides.enabled ?? true, remark: null, rowVersion: '1', createdAt: NOW, updatedAt: NOW,
  };
}

function diagnosticConfig() {
  return { id: '1', salesforceUsername: 'diagnostic@example.com', enabled: true, verificationStatus: 'NOT_VERIFIED', lastVerifiedAt: null, lastErrorCode: null, lastErrorMessageSafe: null, testMetadataType: 'CustomObject', testMetadataFullName: 'Account', rowVersion: '1', createdAt: NOW, updatedAt: NOW };
}

function diagnosticVerification() {
  return {
    status: 'PASS', identityMatched: true, salesforceUsername: 'diagnostic@example.com', apiVersion: '65.0', durationMs: 120,
    tooling: { totalSize: 2, returnedRecords: 2, truncated: false },
    metadata: { status: 'PASS', metadataType: 'CustomObject', fullName: 'Account', totalFiles: 1, returnedFiles: 1, returnedBytes: 128, truncated: false },
    cleanup: { created: 1, cleaned: 1, active: 0, pass: true }, error: null,
  };
}

function auditRecord(id: string, overrides: Readonly<Partial<Record<string, unknown>>> = {}) {
  return {
    id, publicAuditId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`, auditKind: 'MCP_TOOL_CALL',
    occurredAt: NOW, startedAt: NOW, completedAt: NOW, correlationId: `correlation-${id}`, channel: 'MCP', clientId: 'client-a', actorAdmin: null,
    platformUserId: 'platform-a', salesforceUsername: 'sf-user@example.com', executionRole: 'USER', toolName: 'run_soql_query',
    operation: 'READ', objectApiName: null, recordId: null, result: 'PASS', outcome: 'SUCCESS', errorCode: null, durationMs: 5,
    errorMessageSafe: null, auditIntegrityStatus: 'COMPLETE', identitySource: 'USER_BOUND_TOKEN', identityCredentialId: '1',
    requestSummary: { querySha256: 'abcd', queryLength: 42 }, responseSummary: { returnedRecords: 1 }, createdAt: NOW,
    ...overrides,
  };
}

function systemStatus() {
  return {
    adminVersion: '0.1.0-p5', mcpServerVersion: '0.1.0-p5', salesforceApiVersion: '65.0', providerVersions: [{ name: 'salesforce', version: '1.2.3' }],
    upstreamDrift: { status: 'PASS', count: 0 }, database: { status: 'UP', version: '8.0.44', schemaVersions: ['001', '002'] },
    runtimeMode: 'mysql', salesforceInstanceHost: 'example.my.salesforce.com', configured: { connectedApp: true, jwtPrivateKey: true, mcpClientToken: true, identityCredentialEncryptionKey: true },
    diagnostic: diagnosticConfig(), mcpHealth: 'UP', auditPersistence: { status: 'UP', failureCount: 0 }, mcpEndpoint: 'http://127.0.0.1:8080/mcp',
    phases: { P0: 'FINAL ACCEPTED', P1: 'FINAL ACCEPTED', P2: 'FINAL ACCEPTED', P3: 'FINAL ACCEPTED', P4: 'FINAL ACCEPTED', P5: 'FINAL ACCEPTED' },
    readOnlyRuntimeSettings: { MCP_BIND_HOST: '127.0.0.1', MCP_PATH: '/mcp', MCP_AUTH_MODE: 'internal_bearer' },
  };
}
