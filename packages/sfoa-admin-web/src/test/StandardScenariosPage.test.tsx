import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import StandardScenariosPage from '../pages/StandardScenariosPage.js';
import { asFetchMock, jsonResponse, renderAdmin } from './helpers.js';

const NOW = '2026-09-01T08:00:00.000Z';

function scenario(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    scenarioId: 'account-review',
    title: '客户年度回顾',
    category: '客户经营',
    description: '按客户汇总年度机会与交付情况。',
    version: '1.0.3',
    revision: 4,
    scenarioPayload: { pinnedSkills: ['crm-account-brief'], welcomeMessage: '你好', sourceType: 'COMPANY_STANDARD' },
    presetAttachments: [{
      attachmentId: `att_${'a'.repeat(32)}`,
      fileName: '季度回顾模板.txt',
      mimeType: 'text/plain',
      fileSize: 2_048,
      sha256: 'b'.repeat(64),
      downloadUrl: '/api/dsh/scenarios/account-review/attachments/att_aaa',
    }],
    status: 'PUBLISHED',
    createdByPlatformUid: 'platform-manager',
    createdByCrmUser: 'manager@example.invalid',
    updatedByPlatformUid: 'platform-manager',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function listResponse(scenarios: readonly unknown[]) {
  return jsonResponse({
    auth: { authenticated: true, platformUserId: null, crmUsername: null, canManageStandardScenario: true },
    scenarios,
    deletedScenarioIds: [],
  });
}

describe('DSH standard-scenario console page', () => {
  it('renders the catalogue with version, skills, attachments and publisher, and archives in one click', async () => {
    let archived = false;
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/dsh/scenarios/account-review') && init.method === 'PUT') {
        archived = true;
        return jsonResponse({
          auth: { authenticated: true, platformUserId: null, crmUsername: null, canManageStandardScenario: true },
          scenario: scenario({ status: 'ARCHIVED', version: '1.0.4', revision: 5 }),
        });
      }
      if (url.pathname.endsWith('/dsh/scenarios')) return listResponse([scenario()]);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<StandardScenariosPage />);

    expect(await screen.findByRole('heading', { level: 2, name: '标准场景管理' })).toBeInTheDocument();
    // The card is the article that owns the scenario heading; `getByRole('article')` cannot be used
    // because jsdom does not compute an accessible name for an `aria-label`ed <article>.
    const card = (await screen.findByText('客户年度回顾')).closest('article');
    if (!(card instanceof HTMLElement)) throw new Error('the scenario card did not render');
    expect(within(card).getByText('account-review')).toBeInTheDocument();
    expect(within(card).getByText('客户经营')).toBeInTheDocument();
    expect(within(card).getByText('v1.0.3（Rev 4）')).toBeInTheDocument();
    expect(within(card).getByText('crm-account-brief')).toBeInTheDocument();
    expect(within(card).getByText('季度回顾模板.txt')).toBeInTheDocument();
    expect(within(card).getByText('platform-manager')).toBeInTheDocument();
    expect(within(card).getByText('已上架')).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: '下架 客户年度回顾' }));

    await waitFor(() => expect(archived).toBe(true));
    const put = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/dsh/scenarios/account-review') && init?.method === 'PUT',
    );
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ status: 'ARCHIVED' });
    expect(await screen.findByText(/版本升至 v1\.0\.4/u)).toBeInTheDocument();
  });

  it('saves an edited title without rewriting the payload and soft-deletes after confirmation', async () => {
    let deleted: string | null = null;
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/dsh/scenarios/account-review') && init.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Readonly<Record<string, unknown>>;
        return jsonResponse({
          auth: { authenticated: true, platformUserId: null, crmUsername: null, canManageStandardScenario: true },
          scenario: scenario({ title: body.title ?? '客户年度回顾', version: '1.0.4', revision: 5 }),
        });
      }
      if (url.pathname.endsWith('/dsh/scenarios/account-review') && init.method === 'DELETE') {
        deleted = 'account-review';
        return jsonResponse({
          auth: { authenticated: true, platformUserId: null, crmUsername: null, canManageStandardScenario: true },
          deleted: true,
          scenarioId: 'account-review',
          revision: 6,
          deletedScenarioIds: ['account-review'],
        });
      }
      if (url.pathname.endsWith('/dsh/scenarios')) return listResponse([scenario()]);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<StandardScenariosPage />);

    await user.click(await screen.findByRole('button', { name: '编辑 客户年度回顾' }));
    const titleInput = screen.getByLabelText('场景标题');
    await user.clear(titleInput);
    await user.type(titleInput, '客户年度回顾（标准版）');
    // The payload textarea is left untouched, so the request must not claim a payload edit.
    expect(screen.getByLabelText('场景配置 Payload（JSON）')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存（自动升版）' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(
      ([url, init]) => String(url).endsWith('/dsh/scenarios/account-review') && init?.method === 'PUT',
    )).toBe(true));
    const put = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/dsh/scenarios/account-review') && init?.method === 'PUT');
    const body = JSON.parse(String(put?.[1]?.body)) as Readonly<Record<string, unknown>>;
    expect(body).toMatchObject({ title: '客户年度回顾（标准版）', status: 'PUBLISHED' });
    expect(body).not.toHaveProperty('scenarioPayload');
    expect(body).not.toHaveProperty('version');
    expect(body).not.toHaveProperty('revision');

    await screen.findByText(/版本升至 v1\.0\.4/u);
    // jsdom keeps a closing Ant modal in the DOM, so the assertions address the card and the
    // confirmation text directly instead of waiting for the previous dialog to disappear.
    const card = (await screen.findByText('客户年度回顾')).closest('article');
    if (!(card instanceof HTMLElement)) throw new Error('the scenario card did not render');
    fireEvent.click(within(card).getByRole('button', { name: '删除 客户年度回顾' }));
    expect(await screen.findByText(/插件端下次同步时会移除本地已安装的副本/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(deleted).toBe('account-review'));
    expect(await screen.findByText(/已软删除/u)).toBeInTheDocument();
  });
});
