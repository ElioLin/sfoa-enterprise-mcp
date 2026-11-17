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
    businessSystem: 'CRM',
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
    expect(within(card).getByText('CRM')).toBeInTheDocument();
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

  it('shows the business system, edits it, and filters the catalogue by keyword and workspace', async () => {
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/dsh/scenarios/sap-order') && init.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Readonly<Record<string, unknown>>;
        return jsonResponse({
          auth: { authenticated: true, platformUserId: null, crmUsername: null, canManageStandardScenario: true },
          scenario: scenario({ scenarioId: 'sap-order', title: 'SAP 订单核对', businessSystem: String(body.businessSystem) }),
        });
      }
      if (url.pathname.endsWith('/dsh/scenarios')) {
        return listResponse([
          scenario(),
          scenario({
            scenarioId: 'sap-order',
            title: 'SAP 订单核对',
            category: '订单',
            businessSystem: 'TAPD',
            description: '核对 SAP 订单状态与交付节点。',
            presetAttachments: [],
          }),
        ]);
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<StandardScenariosPage />);

    const crmCard = (await screen.findByText('客户年度回顾')).closest('article');
    if (!(crmCard instanceof HTMLElement)) throw new Error('the CRM card did not render');
    expect(within(crmCard).getByText('CRM')).toBeInTheDocument();
    const tapdCard = screen.getByText('SAP 订单核对').closest('article');
    if (!(tapdCard instanceof HTMLElement)) throw new Error('the TAPD card did not render');
    expect(within(tapdCard).getByText('TAPD')).toBeInTheDocument();
    expect(screen.getByText('共 2 个场景')).toBeInTheDocument();

    // Keyword search is instant and spans title, id, category, business system and description.
    const search = screen.getByLabelText('搜索标题 / 场景 ID / 分类 / 业务系统 / 介绍');
    await user.type(search, 'TAPD');
    expect(screen.queryByText('客户年度回顾')).not.toBeInTheDocument();
    expect(screen.getByText('SAP 订单核对')).toBeInTheDocument();
    expect(screen.getByText('筛选出 1 / 2 个场景')).toBeInTheDocument();
    await user.clear(search);
    expect(screen.getByText('客户年度回顾')).toBeInTheDocument();

    // The workspace filter is an exact match on the same field the API filters on.
    await user.click(screen.getByRole('combobox', { name: '按业务系统筛选' }));
    await user.click(await screen.findByText('CRM（1）'));
    expect(screen.queryByText('SAP 订单核对')).not.toBeInTheDocument();
    expect(screen.getByText('客户年度回顾')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByText('SAP 订单核对')).toBeInTheDocument();

    // The form edits the field the plugin uses as its workspace directory.
    await user.click(screen.getByRole('button', { name: '编辑 SAP 订单核对' }));
    const businessSystemInput = screen.getByLabelText('业务系统');
    expect(businessSystemInput).toHaveValue('TAPD');
    await user.clear(businessSystemInput);
    await user.type(businessSystemInput, '自研结算');
    await user.click(screen.getByRole('button', { name: '保存（自动升版）' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(
      ([url, init]) => String(url).endsWith('/dsh/scenarios/sap-order') && init?.method === 'PUT',
    )).toBe(true));
    const put = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/dsh/scenarios/sap-order') && init?.method === 'PUT',
    );
    expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({ businessSystem: '自研结算' });
  });

  it('refuses a business system the plugin would refuse', async () => {
    const fetchMock = asFetchMock(() => jsonResponse({}));
    fetchMock.mockImplementation((url) => (String(url).includes('/dsh/scenarios')
      ? Promise.resolve(listResponse([scenario()]))
      : Promise.resolve(jsonResponse({}))));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<StandardScenariosPage />);

    await user.click(await screen.findByRole('button', { name: '编辑 客户年度回顾' }));
    const businessSystemInput = screen.getByLabelText('业务系统');
    await user.clear(businessSystemInput);
    await user.type(businessSystemInput, 'CRM/TAPD');
    await user.click(screen.getByRole('button', { name: '保存（自动升版）' }));

    expect(await screen.findByText('业务系统不能包含 \\ / : * ? " < > | 中的字符。')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });
});
