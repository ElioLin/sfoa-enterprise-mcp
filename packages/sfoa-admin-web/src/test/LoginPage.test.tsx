import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { adminApi } from '../api/client.js';
import { LoginPage } from '../pages/LoginPage.js';
import { apiError, asFetchMock, jsonResponse, renderAdmin } from './helpers.js';

describe('Admin login', () => {
  it('submits credentials without browser storage and enters the protected route', async () => {
    const fetchMock = asFetchMock((_url, init) => jsonResponse({ username: 'bootstrap-admin', csrfToken: 'csrf-test', expiresAt: Date.now() + 60_000 }));
    vi.stubGlobal('fetch', fetchMock);
    const browserStorageSpy = vi.spyOn(Storage.prototype, 'setItem');
    renderAdmin(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<h1>受保护的运行概览</h1>} />
      </Routes>,
      '/login',
    );

    fireEvent.change(screen.getByLabelText('管理员用户名'), { target: { value: 'bootstrap-admin' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct horse battery staple' } });
    fireEvent.click(screen.getByRole('button', { name: '安全登录' }));

    expect(await screen.findByRole('heading', { name: '受保护的运行概览' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0];
    expect(String(request?.[0])).toContain('/admin/api/auth/login');
    expect(request?.[1]?.credentials).toBe('include');
    await adminApi.createRoute({
      platformUserId: 'platform-test',
      userName: '测试用户',
      salesforceUsername: 'user@example.invalid',
      enabled: true,
      remark: null,
    });
    const mutation = fetchMock.mock.calls[1];
    expect(mutation?.[1]?.headers).toMatchObject({ 'X-SFoA-CSRF-Token': 'csrf-test' });
    await adminApi.logout();
    expect(browserStorageSpy).not.toHaveBeenCalled();
  });

  it('shows the safe structured authentication error returned by the real API contract', async () => {
    vi.stubGlobal('fetch', asFetchMock(() => apiError(401, 'MCP_ADMIN_AUTH_INVALID', 'The Admin username or password is invalid.')));
    renderAdmin(<LoginPage />, '/login');

    fireEvent.change(screen.getByLabelText('管理员用户名'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'incorrect-password' } });
    fireEvent.click(screen.getByRole('button', { name: '安全登录' }));

    expect(await screen.findByText('管理员用户名或密码不正确。')).toBeInTheDocument();
    fireEvent.click(screen.getByText('查看技术详情'));
    expect(screen.getByText('The Admin username or password is invalid.')).toBeInTheDocument();
    expect(screen.getByText('MCP_ADMIN_AUTH_INVALID')).toBeInTheDocument();
  });

  it('turns an empty development-proxy failure into an actionable readiness message', async () => {
    vi.stubGlobal('fetch', asFetchMock(() => new Response(null, { status: 502 })));
    renderAdmin(<LoginPage />, '/login');

    fireEvent.change(screen.getByLabelText('管理员用户名'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct-password-shape' } });
    fireEvent.click(screen.getByRole('button', { name: '安全登录' }));

    expect(await screen.findByText('管理端请求未获得结构化响应，请检查 Admin API 就绪状态。')).toBeInTheDocument();
    fireEvent.click(screen.getByText('查看技术详情'));
    expect(screen.getByText(/Verify \/admin\/api\/ready and restart the P5 services/u)).toBeInTheDocument();
  });
});
