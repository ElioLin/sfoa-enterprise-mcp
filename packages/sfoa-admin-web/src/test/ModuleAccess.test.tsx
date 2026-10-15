import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_MODULE_IDS } from '@sfoa/control-plane/admin-contracts';
import { App } from '../App.js';
import { asFetchMock, jsonResponse, renderAdmin } from './helpers.js';

/**
 * ADR-0034: a scoped Console account. The two modules are deliberately listed in an order that
 * differs from the navigation order, so the landing page proves the order comes from
 * `ADMIN_MODULE_IDS` rather than from the account's own list.
 */
const SCOPED_MODULES = ['system', 'audit'] as const;

function scopedSession() {
  return { username: 'btit', csrfToken: 'csrf-test', expiresAt: Date.now() + 60_000, modules: [...SCOPED_MODULES] };
}

function scopedApi(): ReturnType<typeof asFetchMock> {
  return asFetchMock((url) => {
    if (url.pathname.endsWith('/auth/me')) return jsonResponse(scopedSession());
    if (url.pathname.endsWith('/audits')) {
      return jsonResponse({ items: [], limit: 25, offset: 0, count: 0, hasMore: false, nextOffset: null });
    }
    return jsonResponse({});
  });
}

/**
 * The shell renders its navigation in a Sider on wide screens and in a closed drawer below, so a
 * breakpoint stub is what makes the menu observable at all. Only the min-width queries match.
 */
function useDesktopBreakpoint(): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ADR-0034 scoped Console access', () => {
  it('renders only the modules the account holds, in navigation order', async () => {
    useDesktopBreakpoint();
    vi.stubGlobal('fetch', scopedApi());
    renderAdmin(<App />, '/audit');

    expect(await screen.findByRole('heading', { level: 2, name: '全链路审计工作台' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '调用审计' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '系统状态' })).toBeInTheDocument();
    for (const label of ['运行概览', '用户身份路由', '工具治理', 'DML 操作策略', '系统诊断', 'CREATE 页面上下文', '智能体接入']) {
      expect(screen.queryByRole('link', { name: label }), label).not.toBeInTheDocument();
    }
  });

  it('answers a module the account does not hold with a 403 page instead of the page or an API call', async () => {
    useDesktopBreakpoint();
    const fetchMock = scopedApi();
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<App />, '/diagnostic');

    expect(await screen.findByText('无权访问该模块')).toBeInTheDocument();
    expect(screen.getByText(/账号 btit 未启用「系统诊断」/u)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '前往「调用审计」' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: '系统诊断' })).not.toBeInTheDocument();
    // The forbidden page never mounts, so it never asks the Admin API for its data.
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/me'))).toBe(true));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/diagnostic'))).toBe(false);
  });

  it('opens / on the first module of the navigation the account holds', async () => {
    useDesktopBreakpoint();
    vi.stubGlobal('fetch', scopedApi());
    renderAdmin(<App />, '/');

    expect(await screen.findByRole('heading', { level: 2, name: '全链路审计工作台' })).toBeInTheDocument();
  });

  it('keeps every module reachable for a full-access account', async () => {
    useDesktopBreakpoint();
    const fetchMock = asFetchMock((url) => {
      if (url.pathname.endsWith('/auth/me')) {
        return jsonResponse({ username: 'bootstrap-admin', csrfToken: 'csrf-test', expiresAt: Date.now() + 60_000, modules: [...ADMIN_MODULE_IDS] });
      }
      if (url.pathname.endsWith('/audits')) {
        return jsonResponse({ items: [], limit: 25, offset: 0, count: 0, hasMore: false, nextOffset: null });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<App />, '/audit');

    expect(await screen.findByRole('heading', { level: 2, name: '全链路审计工作台' })).toBeInTheDocument();
    for (const label of ['运行概览', '用户身份路由', '工具治理', 'DML 操作策略', '系统诊断', 'CREATE 页面上下文', '调用审计', '系统状态', '智能体接入']) {
      expect(screen.getByRole('link', { name: label }), label).toBeInTheDocument();
    }
  });
});
