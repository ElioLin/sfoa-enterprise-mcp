import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import IdentityRoutesPage from '../pages/IdentityRoutesPage.js';
import { asFetchMock, jsonResponse, renderAdmin } from './helpers.js';

const NOW = '2026-08-23T12:00:00.000Z';
const T = '\t';

describe('IdentityRoutesPage batch import and auto verification', () => {
  it('batch-imports pasted rows, saves them, and reports per-route Salesforce verification', async () => {
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/system/settings')) return jsonResponse([]);
      if (url.pathname.endsWith('/routes/batch') && init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { routes: readonly Record<string, string>[] };
        return jsonResponse({
          committed: true,
          createdCount: body.routes.length,
          rows: body.routes.map((route, index) => ({
            index,
            platformUserId: route.platformUserId,
            salesforceUsername: route.salesforceUsername,
            ok: true,
            route: { ...routeRecord(), id: String(101 + index), platformUserId: route.platformUserId, userName: route.userName, salesforceUsername: route.salesforceUsername, remark: route.remark ?? null },
            credential: { id: `c${101 + index}`, status: 'ACTIVE', tokenLast4: 'bbbb', generatedAt: NOW, lastUsedAt: null, rowVersion: '1' },
          })),
        });
      }
      if (url.pathname.endsWith('/routes/batch-verify') && init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { ids: readonly string[] };
        return jsonResponse({
          rows: body.ids.map((id, index) => ({
            index,
            id,
            ok: true,
            verification: index === 0 ? verification('PASS') : verification('FAIL'),
          })),
        });
      }
      return jsonResponse(page([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<IdentityRoutesPage />);

    await user.click(await screen.findByRole('button', { name: '批量添加身份路由' }));
    fireEvent.change(screen.getByLabelText('批量粘贴数据'), {
      target: { value: ['用户名称', '平台用户', 'Salesforce Username', '备注'].join(T) + '\n' + '张三' + T + 'zhangsan' + T + 'zhang.san@example.com' + T + '运营' + '\n' + '李四' + T + 'lisi' + T + 'li.si@example.com' },
    });
    await user.click(screen.getByRole('button', { name: '识别数据' }));

    expect(await screen.findByDisplayValue('张三')).toBeInTheDocument();
    expect(screen.getByDisplayValue('李四')).toBeInTheDocument();
    expect(screen.getByText(/可导入 2 条，共 2 行/u)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '保存 2 条并生成凭证' }));

    const batchCall = fetchMock.mock.calls.find(([callUrl, init]) => String(callUrl).endsWith('/routes/batch'));
    const batchBody = JSON.parse(String(batchCall?.[1]?.body)) as { routes: readonly Record<string, unknown>[] };
    expect(batchBody.routes).toEqual([
      { platformUserId: 'zhangsan', userName: '张三', salesforceUsername: 'zhang.san@example.com', enabled: true, remark: '运营' },
      { platformUserId: 'lisi', userName: '李四', salesforceUsername: 'li.si@example.com', enabled: true, remark: null },
    ]);

    expect(await screen.findByText('共 2 条')).toBeInTheDocument();
    expect(screen.getByText('通过 1')).toBeInTheDocument();
    expect(screen.getByText('失败 1')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([callUrl, init]) => String(callUrl).endsWith('/routes/batch-verify') && init?.method === 'POST')).toBe(true);

    // The failed row offers a direct edit entry, the passed row does not.
    const failRow = screen.getByText('li.si@example.com').closest('tr');
    expect(within(failRow as HTMLElement).getByRole('button', { name: /编\s*辑/u })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /完\s*成/u }));
  });

  it('stays on the confirm step and surfaces server-side conflicts without committing anything', async () => {
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/system/settings')) return jsonResponse([]);
      if (url.pathname.endsWith('/routes/batch') && init.method === 'POST') {
        return jsonResponse({
          committed: false,
          createdCount: 0,
          rows: [{
            index: 1,
            platformUserId: 'lisi',
            salesforceUsername: 'li.si@example.com',
            ok: false,
            error: { code: 'MCP_CONTROL_PLANE_CONFLICT', message: 'An identity route already exists for this platform user.' },
          }],
        });
      }
      return jsonResponse(page([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<IdentityRoutesPage />);

    await user.click(await screen.findByRole('button', { name: '批量添加身份路由' }));
    fireEvent.change(screen.getByLabelText('批量粘贴数据'), {
      target: { value: '张三' + T + 'zhangsan' + T + 'zhang.san@example.com' + '\n' + '李四' + T + 'lisi' + T + 'li.si@example.com' },
    });
    await user.click(screen.getByRole('button', { name: '识别数据' }));
    expect(await screen.findByDisplayValue('张三')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '保存 2 条并生成凭证' }));
    expect(await screen.findByText(/already exists for this platform user/u)).toBeInTheDocument();
    // Still on the confirm step: no committed summary, and the conflicting row is unchecked.
    expect(screen.queryByText(/已保存 2 条身份路由/u)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([callUrl, init]) => String(callUrl).endsWith('/routes/batch-verify') && init?.method === 'POST')).toBe(false);
    const conflictRow = screen.getByDisplayValue('李四').closest('tr');
    const checkbox = within(conflictRow as HTMLElement).getByRole('checkbox', { name: /勾选导入 lisi/u });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });

  it('auto-verifies when an edit changes the Salesforce Username', async () => {
    let verifyCalls = 0;
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/system/settings')) return jsonResponse([]);
      if (/\/routes\/1$/u.test(url.pathname) && init.method === 'PUT') {
        return jsonResponse({ ...routeRecord(), salesforceUsername: 'changed@example.com' });
      }
      if (/\/routes\/1\/verify$/u.test(url.pathname) && init.method === 'POST') {
        verifyCalls += 1;
        return jsonResponse(verification('PASS'));
      }
      return jsonResponse(page([routeRecord()]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<IdentityRoutesPage />);

    await user.click(await screen.findByRole('button', { name: /编辑 platform-a/u }));
    const salesforce = screen.getByLabelText('Salesforce Username');
    await user.clear(salesforce);
    await user.type(salesforce, 'changed@example.com');
    await user.click(screen.getByRole('button', { name: '保存路由' }));

    expect(await screen.findByText('路由验证结果')).toBeInTheDocument();
    expect(verifyCalls).toBe(1);
    // The auto-verify modal may share the DOM with the still-exiting edit form modal;
    // disambiguate by the correlation-id label only the verification modal renders.
    const verifyDialog = screen.getAllByRole('dialog').find((el) => within(el).queryByText('Correlation ID'));
    expect(verifyDialog).toBeDefined();
    expect(within(verifyDialog as HTMLElement).getByText(/sf-user@example.com/u)).toBeInTheDocument();
  });

  it('does not auto-verify a saved edit that leaves the Salesforce Username unchanged', async () => {
    let verifyCalls = 0;
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/system/settings')) return jsonResponse([]);
      if (/\/routes\/1$/u.test(url.pathname) && init.method === 'PUT') return jsonResponse(routeRecord());
      if (/\/routes\/1\/verify$/u.test(url.pathname) && init.method === 'POST') {
        verifyCalls += 1;
        return jsonResponse(verification('PASS'));
      }
      return jsonResponse(page([routeRecord()]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<IdentityRoutesPage />);

    await user.click(await screen.findByRole('button', { name: /编辑 platform-a/u }));
    await user.click(screen.getByRole('button', { name: '保存路由' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([callUrl, init]) => String(callUrl).endsWith('/routes/1') && init?.method === 'PUT')).toBe(true));
    expect(verifyCalls).toBe(0);
    expect(screen.queryByText('路由验证结果')).not.toBeInTheDocument();
  });
});

function verification(status: 'PASS' | 'FAIL') {
  return status === 'PASS'
    ? { status, identityMatched: true, salesforceUsername: 'sf-user@example.com', durationMs: 12, error: null, correlationId: 'corr-verify-1' }
    : { status, identityMatched: false, salesforceUsername: 'li.si@example.com', durationMs: 9, error: { code: 'MCP_IDENTITY_MISMATCH', message: 'identity mismatch' }, correlationId: 'corr-verify-2' };
}

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
