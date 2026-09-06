import { expect, test } from '@playwright/test';

test('P8 object policy and snapshot refresh remain usable on desktop and mobile', async ({ page }, testInfo) => {
  let mode = 'SHADOW'; let refreshed = false;
  await page.route('**/admin/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (pathname.endsWith('/auth/me')) body = { username: 'test-admin', csrfToken: 'test-csrf', expiresAt: Date.now() + 300000 };
    else if (pathname.endsWith('/system/settings')) body = [{ settingKey: 'dynamicFormsObjectPolicies', settingValue: [{ objectApiName: 'Sample__c', mode, defaultApp: 'App_A' }], rowVersion: '1' }];
    else if (pathname.endsWith('/dynamicFormsObjectPolicies')) { mode = route.request().postDataJSON().value[0].mode; body = {}; }
    else if (pathname.endsWith('/refresh')) { refreshed = true; body = { status: 'READY' }; }
    else if (pathname.endsWith('/snapshots')) body = [{ id: '1', organizationId: 'test-org', objectApiName: 'Sample__c', pages: ['Create_Page'], formSources: ['DYNAMIC_FORMS'], apps: ['App_A'],
      profileCount: 2, recordTypeCount: 1, status: 'READY', refreshedAt: refreshed ? new Date().toISOString() : '2026-09-06T00:00:00Z', parserVersion: 'P8-04.1', lastError: null }];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/ui-context');
  await expect(page.getByRole('heading', { level: 2, name: 'CREATE 页面上下文' })).toBeVisible();
  await page.getByRole('button', { name: /编\s*辑/u }).click();
  await page.getByLabel('模式', { exact: true }).click();
  await page.locator('.ant-select-item-option').filter({ hasText: 'ENFORCE' }).click();
  await page.getByRole('button', { name: '保存对象策略' }).click();
  await expect.poll(() => mode).toBe('ENFORCE');
  await page.getByRole('button', { name: '刷新快照' }).click();
  await expect.poll(() => refreshed).toBe(true);
  await expect(page.getByText('Create_Page · DYNAMIC_FORMS')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('p804-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '刷新快照' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('p804-mobile.png'), fullPage: true });
});
