import { expect, test } from '@playwright/test';

test('WeCom setup separates shared credential, discovery and execution on desktop/mobile', async ({ page }, testInfo) => {
  let enabled = false;
  await page.route('**/admin/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (pathname.endsWith('/auth/me')) body = { username: 'test-admin', csrfToken: 'test-csrf', expiresAt: Date.now() + 300000 };
    else if (pathname.endsWith('/system/status')) body = {
      mcpEndpoint: 'http://127.0.0.1:8080/mcp', diagnostic: null, readOnlyRuntimeSettings: {},
      configured: { mcpClientToken: true, wecomChannelEnabled: enabled, wecomChannelCredentialConfigured: enabled },
    };
    else if (pathname.endsWith('/tools')) body = { items: [], upstream: { status: 'PASS', drift: [] } };
    else if (pathname.endsWith('/dml-policies')) body = { items: [], hasMore: false, nextOffset: null };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/agent-integration');
  await page.getByRole('tab', { name: '企业微信 / WeCom', exact: true }).click();
  await expect(page.getByText('WeCom 通道尚未启用', { exact: true })).toBeVisible();
  enabled = true;
  await page.getByRole('button', { name: '刷新当前状态' }).click();
  await expect(page.getByText('WeCom 通道尚未启用', { exact: true })).toHaveCount(0);
  await expect(page.getByText('工具发现阶段', { exact: true })).toBeVisible();
  await expect(page.getByText('工具执行阶段', { exact: true })).toBeVisible();
  const panel = page.getByRole('tabpanel', { name: '企业微信 / WeCom', exact: true });
  await expect(panel.getByText(/Authorization Header = Bearer <MCP_WECOM_CLIENT_TOKEN>/u)).toBeVisible();
  await expect(panel.getByText('复制角色设定', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('wecom-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('工具发现阶段', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('wecom-mobile.png'), fullPage: true });
});
