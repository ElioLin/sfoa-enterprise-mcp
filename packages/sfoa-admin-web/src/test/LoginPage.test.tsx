import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { adminApi } from '../api/client.js';
import { LoginPage } from '../pages/LoginPage.js';
import { asFetchMock, jsonResponse, renderAdmin } from './helpers.js';

describe('Admin login', () => {
  it('submits credentials without browser storage and enters the protected route', async () => {
    const fetchMock = asFetchMock((_url, init) => jsonResponse({ username: 'bootstrap-admin', csrfToken: 'csrf-test', expiresAt: Date.now() + 60_000 }));
    vi.stubGlobal('fetch', fetchMock);
    const browserStorageSpy = vi.spyOn(Storage.prototype, 'setItem');
    renderAdmin(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<h1>Protected dashboard</h1>} />
      </Routes>,
      '/login',
    );

    fireEvent.change(screen.getByLabelText('Admin username'), { target: { value: 'bootstrap-admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery staple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in securely' }));

    expect(await screen.findByRole('heading', { name: 'Protected dashboard' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0];
    expect(String(request?.[0])).toContain('/admin/api/auth/login');
    expect(request?.[1]?.credentials).toBe('include');
    await adminApi.createRoute({
      platformUserId: 'platform-test',
      salesforceUsername: 'user@example.invalid',
      enabled: true,
      remark: null,
    });
    const mutation = fetchMock.mock.calls[1];
    expect(mutation?.[1]?.headers).toMatchObject({ 'X-SFoA-CSRF-Token': 'csrf-test' });
    await adminApi.logout();
    expect(browserStorageSpy).not.toHaveBeenCalled();
  });
});
