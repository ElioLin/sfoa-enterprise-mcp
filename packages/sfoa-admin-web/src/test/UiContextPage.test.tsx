import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import UiContextPage from '../pages/UiContextPage.js';
import { asFetchMock, jsonResponse, renderAdmin } from './helpers.js';

it('edits one object policy with its row version and manually refreshes its current snapshot', async () => {
  const policy = { settingKey: 'dynamicFormsObjectPolicies', settingValue: [{ objectApiName: 'Sample__c', mode: 'OFF', defaultApp: null }], rowVersion: '7' };
  const fetchMock = asFetchMock((url, init) => url.pathname.endsWith('/system/settings') ? jsonResponse([policy])
    : url.pathname.endsWith('/snapshots') ? jsonResponse([]) : jsonResponse({ status: 'READY', method: init.method }));
  vi.stubGlobal('fetch', fetchMock);
  renderAdmin(<UiContextPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /编\s*辑/u }));
  await user.type(screen.getByLabelText('默认 App'), 'App_A');
  await user.click(screen.getByRole('button', { name: '保存对象策略' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/dynamicFormsObjectPolicies') && init?.method === 'PUT')).toBe(true));
  const update = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/dynamicFormsObjectPolicies'));
  expect(JSON.parse(String(update?.[1]?.body))).toEqual({ rowVersion: '7', value: [{ objectApiName: 'Sample__c', mode: 'OFF', defaultApp: 'App_A' }] });
  await user.click(screen.getByRole('button', { name: '刷新快照' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/ui-context/Sample__c/refresh') && init?.method === 'POST')).toBe(true));
});
