import { expect, test } from '@playwright/test';

test('real Admin browser workflow persists USER_BOUND lifecycle, governance, and audit through MySQL', async ({ page }) => {
  const username = requiredEnvironment('SFOA_P5_E2E_ADMIN_USERNAME');
  const password = requiredEnvironment('SFOA_P5_E2E_ADMIN_PASSWORD');

  await page.goto('/login');
  await page.getByLabel('管理员用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '安全登录' }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: '运行概览' })).toBeVisible();
  await expect(page.getByText('MySQL', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '用户身份路由' }).click();
  await page.getByRole('button', { name: '新建身份路由', exact: true }).click();
  await page.getByLabel('平台用户 ID', { exact: true }).fill('p6-id-fullstack-user');
  await page.getByLabel('Salesforce Username', { exact: true }).fill('p6-id-fullstack@example.invalid');
  await page.getByLabel('备注').fill('created through real browser and API');
  await page.getByRole('button', { name: '保存路由' }).click();

  await expect(page.getByText('MCP 接入配置', { exact: true })).toBeVisible();
  const tokenField = page.getByLabel('Token');
  await expect(tokenField).toHaveValue(/^sfoa_ub1_[A-Za-z0-9_-]{43}$/u);
  const originalToken = await tokenField.inputValue();
  await page.getByRole('button', { name: /复制 Token/u }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(originalToken);
  await page.getByRole('button', { name: /复制 Authorization/u }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`Bearer ${originalToken}`);

  const workBuddyJsonText = await page.locator('pre.credential-json').textContent();
  const workBuddyJson = JSON.parse(workBuddyJsonText ?? '') as {
    mcpServers: Record<string, { type: string; url: string; headers: Record<string, string>; disabled: boolean }>;
  };
  expect(workBuddyJson.mcpServers['enterprise-salesforce']).toEqual({
    type: 'http',
    url: 'http://127.0.0.1:18080/mcp',
    headers: { Authorization: `Bearer ${originalToken}` },
    disabled: false,
  });
  expect(workBuddyJsonText).not.toContain('X-Platform-User-Id');
  await page.getByRole('button', { name: /复制 WorkBuddy MCP JSON/u }).click();
  await expect.poll(async () => normalizeNewlines(await page.evaluate(() => navigator.clipboard.readText())))
    .toBe(normalizeNewlines(workBuddyJsonText ?? ''));
  await page.getByRole('button', { name: '关闭', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('MCP 接入配置', { exact: true })).toBeHidden();

  const searchPanel = page.getByRole('search', { name: '搜索用户身份路由' });
  const search = searchPanel.getByLabel('搜索平台用户或 Salesforce Username');
  const searchButton = searchPanel.getByRole('button', { name: /搜索/u });
  const resetButton = searchPanel.getByRole('button', { name: /重\s*置/u });
  await search.fill('p6-id-fullstack-user');
  await search.press('Enter');
  await expect(page.getByText('p6-id-fullstack-user')).toBeVisible();
  await resetButton.click();
  await search.fill('p6-id-fullstack@example.invalid');
  await searchButton.click();
  await expect(page.getByText('p6-id-fullstack@example.invalid')).toBeVisible();

  const routeRow = page.getByRole('row').filter({ hasText: 'p6-id-fullstack-user' });
  await routeRow.getByRole('button', { name: /编辑/u }).click();
  await page.getByLabel('备注').fill('updated through real browser and API');
  await page.getByRole('button', { name: '保存路由' }).click();
  await routeRow.getByRole('button', { name: /接入配置/u }).click();
  await expect(page.getByLabel('Token')).toHaveValue(originalToken);
  await page.getByRole('button', { name: '关闭', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('MCP 接入配置', { exact: true })).toBeHidden();

  await resetButton.click();
  await page.locator('.ant-pagination-item-2').click();
  await expect(page.getByText('p6-page-025', { exact: true })).toBeVisible();
  await search.fill('p6-id-fullstack-user');
  await searchButton.click();
  await page.getByLabel('更多操作 p6-id-fullstack-user').click();
  await page.getByText('停用路由', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '停用路由', exact: true }).click();
  await expect(page.getByText('路由停用 · 暂不可用')).toBeVisible();
  await page.getByLabel('更多操作 p6-id-fullstack-user').click();
  await page.getByText('删除路由', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page.getByText('没有找到匹配的用户身份路由。')).toBeVisible();

  await page.getByRole('link', { name: '工具治理' }).click();
  await page.getByPlaceholder('搜索 Tool 名称、状态、分类、依赖、备注或不可启用原因')
    .fill('get_record_action_context');
  const toolToggle = page.getByRole('switch', { name: '启用 get_record_action_context' });
  await toolToggle.click();
  await expect(page.getByRole('switch', { name: '停用 get_record_action_context' })).toBeChecked();

  await page.getByRole('link', { name: 'DML 操作策略' }).click();
  await page.getByRole('button', { name: '添加对象策略', exact: true }).click();
  await page.getByLabel('对象 API 名称').fill('Lead');
  let policyDialog = page.getByRole('dialog', { name: '添加对象策略' });
  await policyDialog.getByRole('switch').nth(0).click();
  await page.getByRole('button', { name: '保存策略' }).click();
  await expect(page.getByText('Lead')).toBeVisible();
  await page.getByRole('button', { name: /编辑/u }).click();
  policyDialog = page.getByRole('dialog', { name: '编辑对象策略' });
  await policyDialog.getByRole('switch').nth(1).click();
  await page.getByRole('button', { name: '保存策略' }).click();
  await expect(page.getByRole('cell', { name: '已允许' })).toHaveCount(2);

  await page.getByRole('link', { name: '调用审计' }).click();
  await expect(page.getByText('CREATE_IDENTITY_ROUTE').first()).toBeVisible();
  await expect(page.getByText('DISABLE_IDENTITY_ROUTE')).toBeVisible();
  await expect(page.getByText('DELETE_IDENTITY_ROUTE')).toBeVisible();
  await expect(page.getByText('UPDATE_TOOL_CONTROL')).toBeVisible();
  await expect(page.getByText('UPDATE_DML_POLICY')).toBeVisible();

  await page.getByRole('link', { name: '系统状态' }).click();
  await expect(page.getByText('数据库与凭据就绪状态')).toBeVisible();
  await expect(page.getByText('001_p5_control_plane, 002_p5_indexes, 003_p6_identity_credential')).toBeVisible();
  await expect(page.getByText('MYSQL').first()).toBeVisible();

  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the P5 full-stack E2E orchestrator.`);
  return value;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/gu, '\n');
}
